import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { root, runCodex } from '../src/launcher.mjs';
import { startFixture } from '../src/demo.mjs';

// Explicit opt-in: installed native Codex + synthetic local server. No real model.
const executable = process.argv[2];
if (!executable) throw new Error('absolute_codex_binary_required');
await mkdir(path.join(root, '.runtime'), { recursive: true });
const workspace = await mkdtemp(path.join(root, '.runtime', 'fixture-workspace-'));
const fixture = await startFixture();
let stdout = '';
let stderr = '';
try {
  const result = await runCodex(fixture.profile, {
    workspace, executable, prompt: 'Return STAR_CODEX_LOCAL_OK only. Do not use tools or read files.', timeoutMs: 30000,
    onOutput: (kind, chunk) => {
      if (kind === 'stdout') stdout = (stdout + chunk.toString()).slice(-32768);
      else stderr = (stderr + chunk.toString()).slice(-32768);
    },
  });
  const ok = result.exitCode === 0 && stdout.includes('STAR_CODEX_LOCAL_OK') && fixture.count() === 1;
  // Fixed diagnostics only; never print raw child logs or prompts.
  console.log(JSON.stringify({ ok, synthetic: true, externalModelCalls: 0, codexExitCode: result.exitCode,
    answerMatched: stdout.includes('STAR_CODEX_LOCAL_OK'), upstreamRequests: fixture.count(),
    stderrPresent: stderr.length > 0, configError: /error loading config|unknown field|unrecognized/i.test(stderr),
    unsupportedTool: /hosted_tools_not_allowed/.test(stderr), metrics: result.metrics }, null, 2));
  process.exitCode = ok ? 0 : 1;
} finally { await fixture.close(); }
