import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadProfiles, ensure, SafeError } from './profile.mjs';
import { runCodex } from './launcher.mjs';
import { gatewayDemo } from './demo.mjs';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true, strict: true,
    options: { config: { type: 'string' }, profile: { type: 'string' }, workspace: { type: 'string' }, codex: { type: 'string' }, help: { type: 'boolean' } },
  });
  const [command] = positionals;
  if (values.help || !command) {
    console.log('Star Codex 0.1 (local Responses only)\nCommands: profiles, check, demo, run\nrun --profile local-code --workspace <absolute directory> --codex <absolute codex binary>\nPrompt is read from stdin. No cloud, fallback, auto-approve or global configuration changes.');
    return;
  }
  ensure(positionals.length === 1, 'unexpected_arguments');
  if (command === 'demo') { console.log(JSON.stringify(await gatewayDemo(), null, 2)); return; }
  const profiles = await loadProfiles(values.config ?? fileURLToPath(new URL('../profiles.json', import.meta.url)));
  if (command === 'check' || command === 'profiles') {
    console.log(JSON.stringify({ ok: true, localConfigurationOnly: true, availabilityChecked: false,
      profiles: [...profiles.values()].map(p => ({ id: p.id, model: p.model, baseUrl: p.baseUrl, vision: p.vision, limits: p.limits })) }, null, 2));
    return;
  }
  ensure(command === 'run', 'unknown_command');
  ensure(profiles.has(values.profile), 'explicit_profile_required');
  ensure(!process.stdin.isTTY, 'pipe_prompt_to_stdin');
  let prompt = '';
  for await (const chunk of process.stdin) { prompt += chunk; ensure(Buffer.byteLength(prompt) <= 65536, 'prompt_too_large'); }
  const result = await runCodex(profiles.get(values.profile), { workspace: values.workspace, executable: values.codex, prompt });
  console.error(JSON.stringify({ exitCode: result.exitCode, metrics: result.metrics }));
  process.exitCode = result.exitCode;
}
main().catch(error => {
  console.error(JSON.stringify({ ok: false, code: error instanceof SafeError ? error.code : 'local_operation_failed' }));
  process.exitCode = 1;
});
