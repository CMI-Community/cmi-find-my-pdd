import { approvedImage, approvedPublicAsset, PUBLIC_ASSET_LIMIT, publicAssetHash, publicAssetsRoute, type PublicAssetContext } from './public-assets-api.ts';
import { ApiError } from './http.ts';
function assert(value: unknown): asserts value { if (!value) throw new Error('assertion failed'); }
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLj8AAAAASUVORK5CYII='), byte => byte.charCodeAt(0));
const base = 'https://abcdefghijklmnopqrst.supabase.co';
const req = (bytes: Uint8Array, hash: string, extra: Record<string, string> = {}) => new Request('https://pdd404.app/v1/admin/public-assets', { method: 'POST', headers: { 'Content-Type': 'image/png', 'x-content-sha256': hash, ...extra }, body: new Uint8Array(bytes) });
async function rejects(run: () => Promise<unknown>, code: string) { try { await run(); } catch (error) { assert(error instanceof ApiError && error.code === code); return; } throw new Error('expected ' + code); }
function context(): PublicAssetContext & { calls: string[] } {
  const calls: string[] = [];
  return { calls, admin: async () => { calls.push('admin'); return 'synthetic-actor'; }, publicBaseUrl: base,
    audit: async (actor, action, payload) => { assert(actor === 'synthetic-actor' && Object.keys(payload).sort().join(',') === 'bytes,key,mime,sha256'); calls.push(action); },
    upload: async (key, bytes, mime) => { assert(key === `${await publicAssetHash(png)}.png` && mime === 'image/png' && bytes.length === png.length); calls.push('upload'); },
  };
}
Deno.test('approved public images use immutable hashes and audit before upload, with a safe allowlisted receipt', async () => {
  const ctx = context(), hash = await publicAssetHash(png);
  const response = await publicAssetsRoute(req(png, hash), ['admin', 'public-assets'], {}, ctx);
  assert(response?.status === 201);
  const data = (await response.json()).data;
  assert(data.url === `${base}/storage/v1/object/public/pdd-public-assets/${hash}.png` && data.sha256 === hash);
  assert(Object.keys(data).sort().join(',') === 'bytes,key,mime,sha256,url');
  assert(ctx.calls.join(',') === 'admin,public_asset_upload_requested,upload,public_asset_uploaded');
});
Deno.test('asset administrators are verified before reading or creating any public bytes', async () => {
  const ctx = context(); ctx.admin = async () => { throw new ApiError('FORBIDDEN', 'admin only', 403); };
  await rejects(() => publicAssetsRoute(req(png, '0'.repeat(64)), ['admin', 'public-assets'], {}, ctx), 'FORBIDDEN');
  assert(ctx.calls.length === 0);
});
Deno.test('asset approval rejects changed bytes, hidden metadata, spoofed MIME and oversized streams before a write', async () => {
  const ctx = context(), hash = await publicAssetHash(png);
  await rejects(() => publicAssetsRoute(req(png, '0'.repeat(64)), ['admin', 'public-assets'], {}, ctx), 'ARTIFACT_MISMATCH');
  await rejects(() => publicAssetsRoute(req(png, hash, { 'Content-Type': 'image/jpeg' }), ['admin', 'public-assets'], {}, ctx), 'ARTIFACT_MISMATCH');
  const text = new TextEncoder().encode('Comment\0Synthetic private metadata'), chunk = new Uint8Array(text.length + 12);
  new DataView(chunk.buffer).setUint32(0, text.length); chunk.set(new TextEncoder().encode('tEXt'), 4); chunk.set(text, 8);
  const metadata = new Uint8Array(png.length + chunk.length); metadata.set(png.slice(0, 33)); metadata.set(chunk, 33); metadata.set(png.slice(33), 33 + chunk.length);
  assert((await approvedImage(metadata)).sha256 === hash);
  await rejects(() => publicAssetsRoute(req(metadata, hash), ['admin', 'public-assets'], {}, ctx), 'ARTIFACT_MISMATCH');
  await rejects(() => publicAssetsRoute(req(new Uint8Array(PUBLIC_ASSET_LIMIT + 1), hash), ['admin', 'public-assets'], {}, ctx), 'INVALID_ASSET');
  await rejects(() => publicAssetsRoute(req(png, hash, { 'content-length': String(PUBLIC_ASSET_LIMIT + 1) }), ['admin', 'public-assets'], {}, ctx), 'INVALID_ASSET');
  assert(ctx.calls.every(call => call === 'admin'));
});
Deno.test('asset storage failures cannot become successful uploads and invalid project destinations never write', async () => {
  const ctx = context(), hash = await publicAssetHash(png);
  ctx.publicBaseUrl = 'https://osqyplgctlzdlpqmzfud.supabase.co';
  await rejects(() => publicAssetsRoute(req(png, hash), ['admin', 'public-assets'], {}, ctx), 'SERVICE_UNAVAILABLE');
  ctx.publicBaseUrl = base; ctx.upload = async () => { throw new ApiError('ASSET_EXISTS', 'immutable', 409); };
  await rejects(() => publicAssetsRoute(req(png, hash), ['admin', 'public-assets'], {}, ctx), 'ASSET_EXISTS');
  assert(!ctx.calls.includes('public_asset_uploaded'));
  assert(await publicAssetsRoute(new Request('https://pdd404.app/v1/other'), ['other'], {}, ctx) === null);
});
Deno.test('reviewed ZIP packages preserve the exact enclosed bytes and require a complete bounded archive', async () => {
  const zip = Uint8Array.from(atob('UEsDBBQAAAAAAACgSF2SUZigFQAAABUAAAAKAAAAUkVBRE1FLnR4dFN5bnRoZXRpYyBwdWJsaWMgcGFja1BLAQIUAxQAAAAAAACgSF2SUZigFQAAABUAAAAKAAAAAAAAAAAAAACAAQAAAABSRUFETUUudHh0UEsFBgAAAAABAAEAOAAAAD0AAAAAAA=='), byte => byte.charCodeAt(0));
  const prepared = await approvedPublicAsset(zip, 'application/zip');
  assert(prepared.sha256 === await publicAssetHash(zip) && prepared.key.endsWith('.zip') && prepared.bytes === zip);
  const ctx = context(); ctx.upload = async (key, bytes, mime) => { assert(key === prepared.key && mime === 'application/zip' && bytes.length === zip.length); ctx.calls.push('upload'); };
  const response = await publicAssetsRoute(req(zip, prepared.sha256, { 'Content-Type': 'application/zip' }), ['admin','public-assets'], {}, ctx);
  assert(response?.status === 201 && (await response.json()).data.url.endsWith(prepared.key));
  await rejects(() => approvedPublicAsset(zip.slice(0, -1), 'application/zip'), 'INVALID_ASSET');
  await rejects(() => approvedPublicAsset(new Uint8Array(60), 'application/zip'), 'INVALID_ASSET');
  await rejects(() => publicAssetsRoute(req(zip, '0'.repeat(64), { 'Content-Type': 'application/zip' }), ['admin','public-assets'], {}, ctx), 'ARTIFACT_MISMATCH');
});
