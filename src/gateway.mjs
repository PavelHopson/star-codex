import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { SafeError, ensure, validateRequest } from './profile.mjs';

function sendError(res, status, code) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify({ error: { type: 'star_codex', code, message: code } }));
}
function authorized(req, token) {
  const actual = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    ensure(size <= maxBytes, 'request_too_large', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new SafeError('invalid_json'); }
}
export async function startGateway(profile) {
  const token = randomBytes(32).toString('hex');
  const events = [];
  const active = new Set();
  let attempted = 0;
  let admitted = 0;
  let rejected = 0;
  const handlers = new Set();
  let closing;
  async function handle(req, res) {
    let controller;
    let timer;
    let event;
    try {
      ensure(!req.headers.origin, 'browser_origin_not_allowed', 403);
      ensure(authorized(req, token), 'unauthorized', 401);
      ensure(req.method === 'POST' && req.url === '/v1/responses', 'route_not_allowed', 404);
      ensure(req.headers['content-type']?.split(';')[0] === 'application/json' && !req.headers['content-encoding'], 'json_required', 415);
      ensure(admitted < profile.limits.maxRequests, 'session_budget_exhausted', 429);
      ensure(active.size < profile.limits.concurrency, 'capacity_exhausted', 429);
      admitted++;
      controller = new AbortController();
      active.add(controller);
      event = { request: admitted, outcome: 'failed', code: 'request_failed', httpStatus: null, elapsedMs: 0, responseBytes: 0, upstreamAttempted: false, cost: null };
      const start = performance.now();
      const abort = () => controller.abort();
      req.once('aborted', abort);
      res.once('close', () => { if (!res.writableFinished) abort(); });
      timer = setTimeout(() => { controller.abort(); sendError(res, 504, 'request_timeout'); req.destroy(); }, profile.limits.timeoutMs);
      try {
        const body = validateRequest(await readBody(req, profile.limits.maxInputBytes), profile);
        ensure(!controller.signal.aborted, 'request_timeout', 504);
        attempted++;
        event.upstreamAttempted = true;
        // Core HTTP avoids proxy environment variables and always targets literal loopback.
        await forward(body, profile, controller.signal, res, event);
        event.outcome = 'transport_completed';
        event.code = 'ok';
      } finally {
        event.elapsedMs = Math.round(performance.now() - start);
      }
    } catch (error) {
      const code = error instanceof SafeError ? error.code : controller?.signal.aborted ? 'request_aborted' : 'upstream_unavailable';
      if (event) event.code = code;
      else rejected++;
      sendError(res, error instanceof SafeError ? error.status : 502, code);
    } finally {
      clearTimeout(timer);
      if (controller) active.delete(controller);
      if (event) events.push(Object.freeze(event));
    }
  }
  const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
    const pending = handle(req, res);
    handlers.add(pending);
    pending.finally(() => handlers.delete(pending));
  });
  server.requestTimeout = profile.limits.timeoutMs;
  server.headersTimeout = Math.min(profile.limits.timeoutMs, 10000);
  server.maxConnections = 16;
  server.on('clientError', (_error, socket) => socket.destroy());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`, token,
    snapshot: () => ({ profile: profile.id, model: profile.model, admitted, attempted, rejected, active: active.size, events: [...events], costMeasured: false }),
    close: () => {
      closing ??= (async () => {
        for (const controller of active) controller.abort();
        const closed = new Promise(resolve => server.close(resolve));
        server.closeAllConnections();
        await closed;
        await Promise.allSettled([...handlers]);
      })();
      return closing;
    },
  };
}

function forward(body, profile, signal, downstream, event) {
  return new Promise((resolve, reject) => {
    const upstream = http.request(`${profile.baseUrl}/responses`, {
      method: 'POST', signal, agent: false,
      headers: { 'content-type': 'application/json', accept: body.stream ? 'text/event-stream' : 'application/json' },
    }, response => {
      (async () => {
        event.httpStatus = response.statusCode;
        // Never relay upstream errors, cookies, redirects or credential-bearing headers.
        ensure(response.statusCode === 200, 'upstream_rejected', 502);
        const type = response.headers['content-type']?.split(';')[0];
        ensure(type === (body.stream ? 'text/event-stream' : 'application/json'), 'upstream_protocol_mismatch', 502);
        downstream.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        for await (const chunk of response) {
          event.responseBytes += chunk.length;
          ensure(event.responseBytes <= profile.limits.maxResponseBytes, 'response_too_large', 502);
          if (!downstream.write(chunk)) await once(downstream, 'drain', { signal });
        }
        downstream.end();
        resolve();
      })().catch(error => { response.destroy(); upstream.destroy(); reject(error); });
    });
    upstream.on('error', reject);
    upstream.end(JSON.stringify(body));
  });
}
