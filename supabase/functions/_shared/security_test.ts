import { capability, canonicalJson, contact, dimensions, sha256, withoutMetadata } from './security.ts';
import { ApiError, candidateRequest, corsHeaders } from './http.ts';
import { createRuntimeCache } from './runtime.ts';

function assert(condition: unknown, message = 'assertion failed'): asserts condition { if (!condition) throw new Error(message); }
function throws(fn: () => unknown, code: string) {
  try { fn(); } catch (error) { assert(error instanceof ApiError && error.code === code); return; }
  throw new Error(`expected ${code}`);
}

Deno.test('capability requires exactly 32 bytes and does not accept JWT/user identifiers', () => {
  const make = (token: string) => new Request('https://example.test', { headers: { authorization: `Bearer ${token}` } });
  const token = 'a'.repeat(64);
  assert(capability(make(token)) === token);
  assert(capability(make('A'.repeat(43))).length === 43);
  throws(() => capability(make('short-token')), 'FORBIDDEN');
  throws(() => capability(make(`${'A'.repeat(43)}.jwt.signature`)), 'FORBIDDEN');
});

Deno.test('contact is the reporter contact with explicit group declaration only', () => {
  const result = contact({ wechat: 'reporter_123', groupDeclaration: true });
  assert(result.wechat === 'reporter_123' && result.groupDeclaration === true);
  throws(() => contact({ wechat: 'reporter_123', groupDeclaration: false }), 'INVALID_REQUEST');
  throws(() => contact({ wechat: 'reporter_123', groupDeclaration: true, recipientPhone: '12345678900' }), 'INVALID_REQUEST');
  throws(() => contact({ wechat: '中文昵称', groupDeclaration: true }), 'INVALID_REQUEST');
});

Deno.test('capability hashes are stable and no raw capability is stored by helper', async () => {
  const hash = await sha256('A'.repeat(43));
  assert(hash.length === 64 && hash !== 'A'.repeat(43));
  assert(await sha256('A'.repeat(43)) === hash);
});

Deno.test('idempotency digest does not conflict when JSON object keys reorder', async () => {
  const first = { imageVersion: 1, contact: { wechat: 'test_person', groupDeclaration: true } };
  const retry = { contact: { groupDeclaration: true, wechat: 'test_person' }, imageVersion: 1 };
  assert(await sha256(canonicalJson(first)) === await sha256(canonicalJson(retry)));
  assert(await sha256(canonicalJson(first)) !== await sha256(canonicalJson({ ...retry, imageVersion: 2 })));
});

Deno.test('image dimensions come from bytes rather than browser metadata', async () => {
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLj8AAAAASUVORK5CYII='), (byte) => byte.charCodeAt(0));
  const result = await dimensions(png);
  assert(result.mime === 'image/png' && result.width === 1 && result.height === 1);
  let invalid = false;
  try { await dimensions(new TextEncoder().encode('<svg>secret</svg>')); } catch (error) { invalid = error instanceof ApiError && error.code === 'INVALID_IMAGE'; }
  assert(invalid);
  let incomplete = false;
  try { await dimensions(png.slice(0, 24)); } catch (error) { incomplete = error instanceof ApiError && error.code === 'INVALID_IMAGE'; }
  assert(incomplete);
});

Deno.test('CORS allows configured origin only, with no wildcard credential leak', () => {
  const settings: Record<string, string> = { APP_PUBLIC_URL: 'https://example.test', ALLOWED_ORIGINS: 'http://localhost:5173' };
  const configured = (name: string) => settings[name];
  const headers = corsHeaders(new Request('https://api.test', { headers: { origin: 'https://example.test' } }), configured);
  assert(headers['Access-Control-Allow-Origin'] === 'https://example.test');
  throws(() => corsHeaders(new Request('https://api.test', { headers: { origin: 'https://malicious.test' } }), configured), 'FORBIDDEN');
});

Deno.test('approved binary asset upload preflight permits its exact checksum and authentication headers', () => {
  const settings: Record<string, string> = { APP_PUBLIC_URL: 'https://example.test' };
  const request = new Request('https://api.test/v1/admin/public-assets', { method: 'OPTIONS', headers: {
    origin: 'https://example.test', 'access-control-request-method': 'POST',
    'access-control-request-headers': 'authorization,apikey,content-type,x-content-sha256',
  } });
  const headers = corsHeaders(request, name => settings[name]);
  const permitted = new Set(headers['Access-Control-Allow-Headers'].split(',').map(value => value.trim().toLowerCase()));
  for (const requested of request.headers.get('access-control-request-headers')!.split(',')) assert(permitted.has(requested));
  assert(headers['Access-Control-Allow-Origin'] === 'https://example.test');
  assert(headers['Access-Control-Allow-Methods'].split(',').map(value => value.trim()).includes('POST'));
  assert(!permitted.has('x-insights-secret') && !permitted.has('*'));
  throws(() => corsHeaders(new Request(request, { headers: { origin: 'https://malicious.test' } }), name => settings[name]), 'FORBIDDEN');
});

Deno.test('candidate paging requires the displayed input version and identifier selection', () => {
  const valid = candidateRequest(new URL('https://example.test/candidates?imageVersion=3&offset=20&selectedIdentifierId=chosen-id'), 3, 'chosen-id');
  assert(valid.offset === 20 && valid.imageVersion === 3 && valid.selectedIdentifierId === 'chosen-id');
  const unselected = candidateRequest(new URL('https://example.test/candidates?imageVersion=3'), 3, null);
  assert(unselected.offset === 0 && unselected.selectedIdentifierId === null);
  throws(() => candidateRequest(new URL('https://example.test/candidates?imageVersion=2&offset=20&selectedIdentifierId=chosen-id'), 3, 'chosen-id'), 'VERSION_CONFLICT');
  throws(() => candidateRequest(new URL('https://example.test/candidates?imageVersion=3&offset=20'), 3, 'chosen-id'), 'VERSION_CONFLICT');
  throws(() => candidateRequest(new URL('https://example.test/candidates?imageVersion=3&offset=20&selectedIdentifierId=old-id'), 3, 'chosen-id'), 'VERSION_CONFLICT');
});

Deno.test('candidate paging rejects ambiguous or unbounded query parameters', () => {
  for (const query of ['offset=20', 'imageVersion=0', 'imageVersion=3&offset=-1', 'imageVersion=3&offset=1.5', 'imageVersion=3&offset=100001',
    'imageVersion=3&offset=20&offset=40', 'imageVersion=3&selectedIdentifierId=', 'imageVersion=3&trackingNumber=manual']) {
    throws(() => candidateRequest(new URL(`https://example.test/candidates?${query}`), 3, null), 'INVALID_REQUEST');
  }
});

Deno.test('runtime configuration shares concurrent loads and refreshes rotated Vault values after sixty seconds', async () => {
  let clock = 0;
  let calls = 0;
  let current: Record<string, unknown> = { WORKER_SECRET: 'first-test-key', ADMIN_USER_IDS: 'test-admin' };
  const cache = createRuntimeCache(() => undefined, () => clock);
  const loader = async () => { calls++; await Promise.resolve(); return current; };
  await Promise.all([cache.ensure(loader), cache.ensure(loader), cache.ensure(loader)]);
  assert(calls === 1 && cache.get('WORKER_SECRET') === 'first-test-key');
  clock = 59_999;
  await cache.ensure(loader);
  assert(calls === 1);
  current = { WORKER_SECRET: 'rotated-test-key', ADMIN_USER_IDS: null };
  clock = 60_000;
  await cache.ensure(loader);
  assert(Number(calls) === 2 && cache.get('WORKER_SECRET') === 'rotated-test-key');
  assert(cache.get('ADMIN_USER_IDS') === undefined);
});

Deno.test('runtime configuration preserves explicit environment precedence and only loads its allowlist', async () => {
  const native: Record<string, string> = { WORKER_SECRET: 'native-test-key' };
  const cache = createRuntimeCache((name) => native[name]);
  await cache.ensure(async () => ({ WORKER_SECRET: 'vault-test-key', APP_SHA: 'test-code-sha', SUPABASE_SERVICE_ROLE_KEY: 'unsupported-fallback' }));
  assert(cache.get('WORKER_SECRET') === 'native-test-key');
  assert(cache.get('APP_SHA') === 'test-code-sha');
  assert(cache.get('SUPABASE_SERVICE_ROLE_KEY') === undefined);
});

Deno.test('runtime configuration fails closed when refresh fails and permits a later recovery', async () => {
  let clock = 0;
  const cache = createRuntimeCache(() => undefined, () => clock);
  await cache.ensure(async () => ({ WORKER_SECRET: 'previous-test-key' }));
  clock = 60_001;
  let rejected = false;
  try { await cache.ensure(async () => { throw new Error('unavailable'); }); } catch { rejected = true; }
  assert(rejected && cache.get('WORKER_SECRET') === 'previous-test-key');
  await cache.ensure(async () => ({ WORKER_SECRET: 'recovered-test-key' }));
  assert(cache.get('WORKER_SECRET') === 'recovered-test-key');
});

Deno.test('public copy removes hidden PNG metadata while preserving rendering chunks', async () => {
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLj8AAAAASUVORK5CYII='), (byte) => byte.charCodeAt(0));
  const text = new TextEncoder().encode('Location\0private-address');
  const chunk = new Uint8Array(text.length + 12);
  new DataView(chunk.buffer).setUint32(0, text.length);
  chunk.set(new TextEncoder().encode('tEXt'), 4); chunk.set(text, 8);
  const original = new Uint8Array(png.length + chunk.length);
  original.set(png.slice(0, 33)); original.set(chunk, 33); original.set(png.slice(33), 33 + chunk.length);
  const safe = withoutMetadata(original, 'image/png');
  assert(safe.length === png.length);
  assert(!new TextDecoder().decode(safe).includes('private-address'));
  assert((await dimensions(safe)).width === 1);
});
