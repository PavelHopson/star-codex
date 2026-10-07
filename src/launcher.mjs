import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensure } from './profile.mjs';
import { startGateway } from './gateway.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export function codexArgs(profile, gateway, workspace) {
  const config = {
    model: profile.model,
    model_provider: 'star_local',
    approval_policy: 'on-request',
    sandbox_mode: 'read-only',
    web_search: 'disabled',
    'history.persistence': 'none',
    'shell_environment_policy.inherit': 'core',
    'shell_environment_policy.exclude': ['STAR_CODEX_TOKEN'],
    'model_providers.star_local.name': 'Star Codex local',
    'model_providers.star_local.base_url': gateway.url,
    'model_providers.star_local.wire_api': 'responses',
    'model_providers.star_local.env_key': 'STAR_CODEX_TOKEN',
    'model_providers.star_local.requires_openai_auth': false,
    'model_providers.star_local.request_max_retries': 0,
    'model_providers.star_local.stream_max_retries': 0,
    'model_providers.star_local.stream_idle_timeout_ms': profile.limits.timeoutMs,
    'model_providers.star_local.supports_websockets': false,
  };
  return ['--no-daemon', 'exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
    '--sandbox', 'read-only', '--cd', workspace,
    ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]), '-'];
}
export function childEnvironment(source, home, token) {
  const allow = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'lang', 'term', 'colorterm']);
  const result = Object.fromEntries(Object.entries(source).filter(([key]) => allow.has(key.toLowerCase())));
  return {
    ...result, CODEX_HOME: home, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home,
    TEMP: path.join(home, 'tmp'), TMP: path.join(home, 'tmp'), TMPDIR: path.join(home, 'tmp'),
    STAR_CODEX_TOKEN: token,
  };
}
export async function runCodex(profile, { workspace, executable, prompt, onOutput, timeoutMs } = {}) {
  ensure(typeof workspace === 'string' && path.isAbsolute(workspace), 'absolute_workspace_required');
  ensure(typeof executable === 'string' && path.isAbsolute(executable), 'absolute_codex_binary_required');
  workspace = await realpath(workspace);
  executable = await realpath(executable);
  ensure((await stat(workspace)).isDirectory(), 'workspace_not_directory');
  ensure((await stat(executable)).isFile(), 'codex_not_file');
  ensure(process.platform !== 'win32' || path.basename(executable).toLowerCase() === 'codex.exe', 'native_codex_required');
  ensure(typeof prompt === 'string' && prompt.trim().length > 0 && Buffer.byteLength(prompt) <= 65536, 'invalid_prompt');
  // Never reuse the user's auth/config or any existing session directory.
  const runtime = path.join(root, '.runtime');
  await mkdir(runtime, { recursive: true });
  const home = await mkdtemp(path.join(runtime, 'session-'));
  await mkdir(path.join(home, 'tmp'));
  const gateway = await startGateway(profile);
  let child;
  let timer;
  let stopRequested = false;
  const stop = () => { stopRequested = true; void gateway.close(); child?.kill(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let exitCode = 1;
  try {
    exitCode = await new Promise((resolve, reject) => {
      child = spawn(executable, codexArgs(profile, gateway, workspace), {
        cwd: workspace, env: childEnvironment(process.env, home, gateway.token),
        shell: false, windowsHide: true, stdio: ['pipe', onOutput ? 'pipe' : 'inherit', onOutput ? 'pipe' : 'inherit'],
      });
      child.once('error', reject);
      child.once('close', code => resolve(code ?? 1));
      child.stdin.on('error', () => {});
      if (onOutput) {
        child.stdout.on('data', chunk => onOutput('stdout', chunk));
        child.stderr.on('data', chunk => onOutput('stderr', chunk));
      }
      child.stdin.end(prompt);
      if (timeoutMs) timer = setTimeout(stop, timeoutMs);
    });
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await gateway.close();
    // Gateway audit is metadata-only. Codex's separate own files are not sanitized by us.
    await writeFile(path.join(home, 'metrics.json'), JSON.stringify({ ...gateway.snapshot(), exitCode, stopRequested }, null, 2), { flag: 'wx' });
  }
  return { exitCode: stopRequested ? 1 : exitCode, metrics: gateway.snapshot(), home };
}
