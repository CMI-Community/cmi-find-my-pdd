import { ApiError, json } from './http.ts';
import { dimensions, withoutMetadata } from './security.ts';

export const PUBLIC_ASSET_LIMIT = 5 * 1024 * 1024;
export const PUBLIC_ASSET_BUCKET = 'pdd-public-assets';
const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/zip': 'zip' };
export type PublicAssetContext = {
  admin: () => Promise<string>;
  publicBaseUrl: string;
  upload: (key: string, bytes: Uint8Array, mime: string) => Promise<void>;
  audit: (actor: string, action: 'public_asset_upload_requested' | 'public_asset_uploaded', payload: { key: string; sha256: string; mime: string; bytes: number }) => Promise<void>;
};

export async function publicAssetHash(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.length); copy.set(bytes);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', copy))).map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function approvedImage(bytes: Uint8Array): Promise<{ bytes: Uint8Array; mime: string; sha256: string; key: string }> {
  if (!bytes.length || bytes.length > PUBLIC_ASSET_LIMIT) throw new ApiError('INVALID_ASSET', '公开图片须在5MiB以内。', 413);
  const image = await dimensions(bytes);
  if (!extensions[image.mime] || image.width < 1 || image.height < 1 || image.width > 12000 || image.height > 12000 || image.width * image.height > 40_000_000) throw new ApiError('INVALID_ASSET', '请使用尺寸合理的PNG、JPEG或WebP图片。', 422);
  const clean = withoutMetadata(bytes, image.mime);
  const sha = await publicAssetHash(clean);
  return { bytes: clean, mime: image.mime, sha256: sha, key: `${sha}.${extensions[image.mime]}` };
}
export async function approvedPublicAsset(bytes: Uint8Array, requestedMime?: string): Promise<{ bytes: Uint8Array; mime: string; sha256: string; key: string }> {
  if (requestedMime !== 'application/zip') return approvedImage(bytes);
  if (!bytes.length || bytes.length > PUBLIC_ASSET_LIMIT) throw new ApiError('INVALID_ASSET', '公开素材须在5MiB以内。', 413);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 52 || view.getUint32(0, true) !== 0x04034b50) throw new ApiError('INVALID_ASSET', 'ZIP素材包结构不完整。', 422);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) { end = offset; break; }
  }
  if (end < 0 || view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0 || view.getUint16(end + 8, true) < 1
    || view.getUint16(end + 8, true) !== view.getUint16(end + 10, true) || view.getUint32(end + 16, true) + view.getUint32(end + 12, true) !== end) throw new ApiError('INVALID_ASSET', '请提供完整的单卷ZIP素材包。', 422);
  // Unlike images, the exact ZIP bytes and every enclosed item are reviewed as
  // one artifact. The server never unpacks or rewrites the approved archive.
  const sha = await publicAssetHash(bytes); return { bytes, mime: 'application/zip', sha256: sha, key: `${sha}.zip` };
}
async function boundedBytes(request: Request): Promise<Uint8Array> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > PUBLIC_ASSET_LIMIT)) throw new ApiError('INVALID_ASSET', '公开素材须在5MiB以内。', 413);
  if (!request.body) throw new ApiError('INVALID_ASSET', '缺少素材内容。', 422);
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > PUBLIC_ASSET_LIMIT) { await reader.cancel(); throw new ApiError('INVALID_ASSET', '公开素材须在5MiB以内。', 413); } chunks.push(next.value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes;
}
export async function publicAssetsRoute(request: Request, parts: string[], headers: Record<string, string>, context: PublicAssetContext): Promise<Response | null> {
  if (parts[0] !== 'admin' || parts[1] !== 'public-assets') return null;
  const actor = await context.admin();
  if (parts.length !== 2 || request.method !== 'POST' || new URL(request.url).search) throw new ApiError('NOT_FOUND', '接口不存在。', 404);
  const mime = request.headers.get('content-type') ?? '';
  const approvedSha = request.headers.get('x-content-sha256') ?? '';
  if (!extensions[mime] || !/^[0-9a-f]{64}$/.test(approvedSha)) throw new ApiError('INVALID_ASSET', '请提供已审核素材的类型和SHA-256。', 422);
  const original = await boundedBytes(request), image = await approvedPublicAsset(original, mime);
  // Approval identifies the exact public copy; metadata-bearing inputs must be
  // prepared locally and re-reviewed rather than silently changing approved bytes.
  if (image.mime !== mime || image.bytes.length !== original.length || await publicAssetHash(original) !== image.sha256 || approvedSha !== image.sha256) throw new ApiError('ARTIFACT_MISMATCH', '素材与已审核公开副本不一致，请重新准备并核对。', 409);
  let base: URL;
  try { base = new URL(context.publicBaseUrl); } catch { throw new ApiError('SERVICE_UNAVAILABLE', '公开素材存储暂时不可用。', 503); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !/^[a-z]{20}\.supabase\.co$/.test(base.hostname) || base.hostname === 'osqyplgctlzdlpqmzfud.supabase.co' || !['', '/'].includes(base.pathname)) throw new ApiError('SERVICE_UNAVAILABLE', '公开素材存储配置有误。', 503);
  const payload = { key: image.key, sha256: image.sha256, mime, bytes: image.bytes.length };
  // An audit request exists before any public object is created. The adapter
  // always uses upsert:false, so approved assets cannot overwrite a version.
  await context.audit(actor, 'public_asset_upload_requested', payload);
  await context.upload(image.key, image.bytes, mime);
  await context.audit(actor, 'public_asset_uploaded', payload);
  return json({ url: `${base.origin}/storage/v1/object/public/${PUBLIC_ASSET_BUCKET}/${image.key}`, ...payload }, 201, headers);
}
