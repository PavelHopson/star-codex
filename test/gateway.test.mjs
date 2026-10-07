import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadProfiles, validateProfile, validateRequest } from '../src/profile.mjs';
import { startGateway } from '../src/gateway.mjs';
import { childEnvironment, codexArgs, root } from '../src/launcher.mjs';
import { gatewayDemo } from '../src/demo.mjs';

function profile(port = 11434, limits = {}) {
  return validateProfile('test', {
    model: 'fixture-model', baseUrl: `http://127.0.0.1:${port}/v1`, vision: false,
    limits: { concurrency: 1, maxRequests: 6, timeoutMs: 1000, maxInputBytes: 4096, maxResponseBytes: 4096, maxOutputTokens: 32, ...limits },
  });
}
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('bounded_condition_not_reached');
}
async function setup(t, handler = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }, limits) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) });
    handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const gateway = await startGateway(profile(server.address().port, limits));
  t.after(async () => { await gateway.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  const call = (body = {}, options = {}) => fetch(`${gateway.url}${options.path ?? '/responses'}`, {
    method: options.method ?? 'POST',
    headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json', ...options.headers },
    body: JSON.stringify({ model: 'fixture-model', input: 'synthetic-secret-prompt', ...body }),
    signal: options.signal,
  });
  return { gateway, requests, call };
}

test('native request preserves tools/history; strips storage and caps tokens', async t => {
  const { call, requests, gateway } = await setup(t);
  const input = [{ type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{}' }, { type: 'function_call_output', call_id: 'call_1', output: 'synthetic' }];
  const response = await call({ input, tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }], max_output_tokens: 999, store: true }, { headers: { cookie: 'private', 'x-api-key': 'private' } });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body.input, input);
  assert.equal(requests[0].body.max_output_tokens, 32);
  assert.equal(requests[0].body.store, false);
  for (const header of ['authorization', 'cookie', 'x-api-key']) assert.equal(requests[0].headers[header], undefined);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const audit = JSON.stringify(gateway.snapshot());
  assert.ok(!audit.includes('synthetic-secret-prompt') && !audit.includes(gateway.token));
  assert.equal(gateway.snapshot().costMeasured, false);
});
test('authentication, browser and route denial never reach upstream', async t => {
  const { call, requests } = await setup(t);
  for (const options of [{ headers: { authorization: 'Bearer wrong' } }, { headers: { origin: 'http://hostile.example' } }, { path: '/responses?url=http://evil' }, { path: '/chat/completions' }, { headers: { 'content-type': 'text/plain' } }]) {
    const response = await call({}, options);
    assert.ok(response.status >= 400);
    await response.text();
  }
  assert.equal(requests.length, 0);
});
test('model override, hosted tools and unsupported media fail closed', async t => {
  const { call, requests } = await setup(t);
  for (const body of [{ model: 'other' }, { tools: [{ type: 'web_search' }] }, { input: [{ type: 'input_image', image_url: 'http://evil' }] }, { input: [{ type: 'input_file', file_url: 'http://evil' }] }, { previous_response_id: 'other_session' }, { background: true }]) {
    assert.equal((await call(body)).status, 400);
  }
  assert.equal(requests.length, 0);
});
test('budget counts all admitted requests including rejected payloads', async t => {
  const { call, requests } = await setup(t, undefined, { maxRequests: 1 });
  assert.equal((await call({ model: 'wrong' })).status, 400);
  assert.equal((await call()).status, 429);
  assert.equal(requests.length, 0);
});
test('native Codex namespaces preserve functions but cannot hide hosted tools', async t => {
  const { call, requests } = await setup(t);
  const tools = [{ type: 'namespace', name: 'functions', description: 'Synthetic tools', tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] }];
  assert.equal((await call({ tools })).status, 200);
  assert.deepEqual(requests[0].body.tools, tools);
  for (const nested of [[{ type: 'web_search' }], [{ type: 'namespace', tools: [] }], null]) {
    assert.equal((await call({ tools: [{ type: 'namespace', name: 'unsafe', tools: nested }] })).status, 400);
  }
  assert.equal(requests.length, 1);
});
test('image_url in a tool JSON schema is not treated as an attached image', () => {
  const p = profile();
  const body = { model: p.model, input: 'text only', tools: [{ type: 'function', name: 'describe_schema', parameters: { type: 'object', properties: { image_url: { type: 'string' } } } }] };
  assert.deepEqual(validateRequest(body, p).tools, body.tools);
});
test('upstream errors are sanitized; no fallback or retry', async t => {
  const { call, requests, gateway } = await setup(t, (_req, res) => {
    res.writeHead(402, { 'set-cookie': 'secret=value', 'content-type': 'application/json' });
    res.end('{"error":"provider-private-payload"}');
  });
  const response = await call();
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.ok(!(await response.text()).includes('provider-private-payload'));
  assert.equal(requests.length, 1);
  assert.equal(gateway.snapshot().events[0].httpStatus, 402);
});
test('redirects never followed', async t => {
  const { call, requests } = await setup(t, (_req, res) => { res.writeHead(307, { location: 'http://169.254.169.254/' }); res.end(); });
  assert.equal((await call()).status, 502);
  assert.equal(requests.length, 1);
});
test('wrong upstream media type is rejected', async t => {
  const { call } = await setup(t, (_req, res) => { res.end('<html>private</html>'); });
  const response = await call();
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes('<html>'));
});
test('input byte bound blocks dispatch', async t => {
  const { call, requests } = await setup(t, undefined, { maxInputBytes: 256 });
  try { const response = await call({ input: 'x'.repeat(500) }); assert.equal(response.status, 413); }
  catch (error) { assert.equal(error.name, 'TypeError'); } // Node may close an oversized incoming body.
  assert.equal(requests.length, 0);
});
test('response byte bound truncates transport and records failure', async t => {
  const { call, gateway } = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('x'.repeat(1024)); }, { maxResponseBytes: 256 });
  await assert.rejects(async () => { const response = await call(); await response.text(); });
  assert.equal(gateway.snapshot().events[0].code, 'response_too_large');
});
test('concurrency rejects second request without queuing; timeout frees slot', async t => {
  const { call, requests, gateway } = await setup(t, () => {}, { timeoutMs: 150 });
  const first = call().then(async r => { await r.text(); return r.status; }).catch(() => 504);
  await waitFor(() => requests.length > 0);
  assert.equal((await call()).status, 429);
  assert.equal(await first, 504);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(gateway.snapshot().active, 0);
  assert.equal(requests.length, 1);
});
test('client cancellation aborts owned upstream and releases capacity', async t => {
  let disconnected = false;
  const { call, requests, gateway } = await setup(t, (_req, res) => { res.once('close', () => { disconnected = true; }); });
  const abort = new AbortController();
  const pending = call({}, { signal: abort.signal }).catch(() => null);
  await waitFor(() => requests.length > 0);
  abort.abort();
  await pending;
  for (let i = 0; i < 50 && !disconnected; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(disconnected, true);
  assert.equal(gateway.snapshot().active, 0);
});
test('SSE delta/function events preserved byte-for-byte', async t => {
  const sse = 'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"{}"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n';
  const { call } = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sse); });
  const response = await call({ stream: true });
  assert.equal(await response.text(), sse);
});
test('built-in demo is synthetic and one request only', async () => {
  const result = await gatewayDemo();
  assert.equal(result.ok, true);
  assert.equal(result.requests, 1);
  assert.equal(result.externalCalls, 0);
});
test('literal loopback URL prevents DNS/SSRF/credential/query changes', () => {
  const base = profile();
  for (const baseUrl of ['https://api.openai.com/v1', 'http://localhost:11434/v1', 'http://127.0.0.1.evil:80/v1', 'http://a:b@127.0.0.1:1234/v1', 'http://127.0.0.1:1234/v1?key=secret', 'http://127.1:1234/v1', 'http://2130706433:1234/v1', 'http://127.0.0.1:99999/v1']) {
    const { id, ...raw } = base;
    assert.throws(() => validateProfile(id, { ...raw, baseUrl }));
  }
});
test('configuration reader accepts exact schema and bounds oversized files before parsing', async () => {
  await mkdir(path.join(root, '.runtime'), { recursive: true });
  const dir = await mkdtemp(path.join(root, '.runtime', 'config-test-'));
  const file = path.join(dir, 'profiles.json');
  const { id, ...raw } = profile();
  await writeFile(file, JSON.stringify({ version: 1, profiles: { [id]: raw } }));
  assert.equal((await loadProfiles(file)).get(id).model, raw.model);
  await writeFile(file, ' '.repeat(17000));
  await assert.rejects(loadProfiles(file), { code: 'config_too_large' });
  await writeFile(file, '{invalid');
  await assert.rejects(loadProfiles(file), { code: 'invalid_config' });
});
test('gateway shutdown is idempotent and drains aborted request bookkeeping', async t => {
  const { call, requests, gateway } = await setup(t, () => {});
  const pending = call().then(r => r.text()).catch(() => null);
  await waitFor(() => requests.length > 0);
  await Promise.all([gateway.close(), gateway.close()]);
  await pending;
  assert.equal(gateway.snapshot().active, 0);
  assert.equal(gateway.snapshot().events.length, 1);
  assert.notEqual(gateway.snapshot().events[0].outcome, 'transport_completed');
});
test('unknown fields, bad limits, TOML injection and nonfinite values denied', () => {
  const { id, ...raw } = profile();
  for (const delta of [{ fallback: 'cloud' }, { model: 'bad"\nmodel_provider="openai"' }, { vision: 'true' }, { limits: { ...raw.limits, timeoutMs: Infinity } }, { limits: { ...raw.limits, concurrency: 0 } }]) assert.throws(() => validateProfile(id, { ...raw, ...delta }));
});
test('vision opt-in retains embedded content and rejects remote media', () => {
  const p = { ...profile(), vision: true };
  const input = [{ type: 'input_image', image_url: 'data:image/png;base64,YQ==' }];
  assert.deepEqual(validateRequest({ model: p.model, input }, p).input, input);
  assert.throws(() => validateRequest({ model: p.model, input: [{ type: 'input_image', image_url: 'https://example.org/private' }] }, p));
});
test('media and late-bound hosted tools cannot bypass top-level tool policy', () => {
  const p = profile();
  for (const type of ['input_audio', 'input_video', 'additional_tools', 'tool_search_output']) {
    assert.throws(() => validateRequest({ model: p.model, input: [{ type, url: 'https://example.org', tools: [{ type: 'web_search' }] }] }, p), { code: 'unsupported_capability' });
  }
});
test('launcher isolates credentials and proxy/environment injection', () => {
  const env = childEnvironment({ Path: 'test-path', SystemRoot: 'windows', OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', HTTP_PROXY: 'private', NODE_OPTIONS: '--require evil', CODEX_HOME: 'private' }, 'E:/owned', 'local-token');
  assert.equal(env.Path, 'test-path');
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'HTTP_PROXY', 'NODE_OPTIONS']) assert.equal(env[key], undefined);
  assert.equal(env.CODEX_HOME, 'E:/owned');
  assert.equal(env.STAR_CODEX_TOKEN, 'local-token');
});
test('launcher has no bypass, secret CLI argument, retry or global profile', () => {
  const args = codexArgs(profile(), { url: 'http://127.0.0.1:1234/v1', token: 'secret-value' }, 'E:/owned');
  const joined = args.join(' ');
  assert.ok(!joined.includes('secret-value') && !joined.includes('dangerously') && !joined.includes('full-auto'));
  for (const field of ['approval_policy="on-request"', 'sandbox_mode="read-only"', 'request_max_retries=0', 'stream_max_retries=0', 'wire_api="responses"', 'web_search="disabled"']) assert.ok(joined.includes(field), field);
});
