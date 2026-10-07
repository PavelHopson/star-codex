import http from 'node:http';
import { once } from 'node:events';
import { validateProfile } from './profile.mjs';
import { startGateway } from './gateway.mjs';

export async function startFixture() {
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain the synthetic request; never retain a prompt. */ }
    requests++;
    const item = { id: 'msg_local', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'STAR_CODEX_LOCAL_OK', annotations: [] }] };
    const response = { id: 'resp_local', object: 'response', created_at: 1, status: 'completed', model: 'fixture-model', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const data of [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'STAR_CODEX_LOCAL_OK' },
      { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'STAR_CODEX_LOCAL_OK' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ]) res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    profile: validateProfile('fixture', {
      model: 'fixture-model', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, vision: false,
      limits: { concurrency: 1, maxRequests: 4, timeoutMs: 5000, maxInputBytes: 2097152, maxResponseBytes: 65536, maxOutputTokens: 64 },
    }),
    count: () => requests,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
}
export async function gatewayDemo() {
  const fixture = await startFixture();
  const gateway = await startGateway(fixture.profile);
  try {
    const response = await fetch(`${gateway.url}/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fixture-model', stream: true, input: 'Synthetic local transport check' }),
    });
    const body = await response.text();
    if (!response.ok || !body.includes('response.completed') || fixture.count() !== 1) throw new Error('demo_failed');
    return { ok: true, synthetic: true, externalCalls: 0, requests: fixture.count(), ...gateway.snapshot() };
  } finally { await gateway.close(); await fixture.close(); }
}
