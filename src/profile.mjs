import { open } from 'node:fs/promises';

export class SafeError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export function ensure(condition, code, status) {
  if (!condition) throw new SafeError(code, status);
}
function keys(value, expected, code) {
  ensure(value && typeof value === 'object' && !Array.isArray(value), code);
  ensure(Object.keys(value).sort().join('|') === [...expected].sort().join('|'), code);
}
export function validateProfile(id, profile) {
  ensure(/^[a-z][a-z0-9-]{0,47}$/.test(id), 'invalid_profile_name');
  keys(profile, ['model', 'baseUrl', 'vision', 'limits'], 'invalid_profile_fields');
  ensure(typeof profile.model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(profile.model), 'invalid_model');
  ensure(typeof profile.vision === 'boolean', 'invalid_vision');
  // Literal IPv4 loopback only: no DNS, redirects, URL credentials or cloud route.
  ensure(typeof profile.baseUrl === 'string' && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/v1$/.test(profile.baseUrl), 'local_endpoint_required');
  let url;
  try { url = new URL(profile.baseUrl); } catch { throw new SafeError('local_endpoint_required'); }
  ensure(Number(url.port) > 0 && Number(url.port) <= 65535, 'invalid_port');
  const bounds = {
    concurrency: [1, 4], maxRequests: [1, 100], timeoutMs: [50, 120000],
    maxInputBytes: [256, 2097152], maxResponseBytes: [256, 8388608], maxOutputTokens: [1, 8192],
  };
  keys(profile.limits, Object.keys(bounds), 'invalid_limits');
  for (const [name, [min, max]] of Object.entries(bounds)) {
    ensure(Number.isSafeInteger(profile.limits[name]) && profile.limits[name] >= min && profile.limits[name] <= max, 'invalid_limits');
  }
  return Object.freeze({ id, ...profile, limits: Object.freeze({ ...profile.limits }) });
}
export async function loadProfiles(path) {
  const file = await open(path, 'r');
  let bytes;
  try {
    ensure((await file.stat()).isFile(), 'config_not_file');
    const buffer = Buffer.alloc(16385);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    ensure(size <= 16384, 'config_too_large');
    bytes = buffer.subarray(0, size);
  } finally { await file.close(); }
  let config;
  try { config = JSON.parse(bytes.toString('utf8')); } catch { throw new SafeError('invalid_config'); }
  keys(config, ['version', 'profiles'], 'invalid_config_fields');
  ensure(config.version === 1 && config.profiles && !Array.isArray(config.profiles), 'invalid_config');
  const entries = Object.entries(config.profiles);
  ensure(entries.length > 0 && entries.length <= 16, 'invalid_profiles');
  return new Map(entries.map(([id, profile]) => [id, validateProfile(id, profile)]));
}

export function validateRequest(body, profile) {
  ensure(body && typeof body === 'object' && !Array.isArray(body), 'invalid_request');
  ensure(body.model === profile.model, 'model_not_allowed');
  ensure(typeof body.input === 'string' || Array.isArray(body.input), 'invalid_input');
  ensure(body.stream === undefined || typeof body.stream === 'boolean', 'invalid_stream');
  ensure(!body.background && !body.previous_response_id && !body.conversation, 'stateful_request_not_supported');
  if (body.tools !== undefined) {
    ensure(Array.isArray(body.tools), 'invalid_tools');
    for (const tool of body.tools) {
      if (tool?.type === 'namespace') {
        ensure(Array.isArray(tool.tools) && tool.tools.every(t => t && ['function', 'custom'].includes(t.type)), 'hosted_tools_not_allowed');
      } else {
        ensure(tool && ['function', 'custom'].includes(tool.type), 'hosted_tools_not_allowed');
      }
    }
  }
  // Iterative traversal bounds stack use and rejects hidden external media fetches.
  const pending = [body.input];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    ensure(!['input_file', 'input_audio', 'input_video', 'additional_tools', 'tool_search_output', 'computer', 'computer_use_preview'].includes(value.type), 'unsupported_capability');
    if (value.type === 'input_image' || Object.hasOwn(value, 'image_url')) {
      ensure(profile.vision, 'vision_not_enabled');
      ensure(typeof value.image_url === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value.image_url), 'embedded_image_required');
    }
    for (const child of Object.values(value)) if (child && typeof child === 'object') pending.push(child);
  }
  if (body.max_output_tokens !== undefined) ensure(Number.isSafeInteger(body.max_output_tokens) && body.max_output_tokens > 0, 'invalid_output_limit');
  return { ...body, store: false, max_output_tokens: Math.min(body.max_output_tokens ?? profile.limits.maxOutputTokens, profile.limits.maxOutputTokens) };
}
