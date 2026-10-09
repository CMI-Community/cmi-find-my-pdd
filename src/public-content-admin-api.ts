import { canonicalPublicationArtifact, validatePublicationInput, type PublicationInput, type PublicationReceipt, type PublicationStatus } from '../shared/public-content';

export const PUBLIC_UPLOAD_LIMIT = 5 * 1024 * 1024;
export type ReviewedPublication = { input: PublicationInput; canonical: string; sha: string };
export type ReviewedAsset = { bytes: Uint8Array<ArrayBuffer>; sha: string; mime: string; key: string };
const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/zip': 'zip' };
export function independentAdminBase(apiBase: string): string {
  const url = new URL(apiBase);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || !/^[a-z]{20}\.supabase\.co$/.test(url.hostname) || url.hostname === 'osqyplgctlzdlpqmzfud.supabase.co'
    || url.pathname !== '/functions/v1/api') throw new Error('公开内容服务未正确配置。');
  return url.origin;
}
export async function publicSha(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(value => value.toString(16).padStart(2, '0')).join('');
}
export async function preparePublication(raw: unknown, apiBase: string): Promise<ReviewedPublication> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('请选择合法的公开内容JSON文件。');
  let input: PublicationInput;
  try { input = validatePublicationInput({ ...raw, approvalArtifactSha: '0'.repeat(64) }, independentAdminBase(apiBase)); }
  catch { throw new Error('公开内容格式或素材地址无效，请重新准备文件。'); }
  const canonical = canonicalPublicationArtifact(input), sha = await publicSha(new TextEncoder().encode(canonical));
  return { input: { ...input, approvalArtifactSha: sha }, canonical, sha };
}
export async function preparePublicFile(file: File): Promise<ReviewedAsset> {
  if (!extensions[file.type] || file.size < 1 || file.size > PUBLIC_UPLOAD_LIMIT) throw new Error('请选择5MiB以内、已准备好的PNG、JPEG、WebP或ZIP公开副本。');
  const bytes = new Uint8Array(await file.arrayBuffer()), sha = await publicSha(bytes);
  return { bytes, sha, mime: file.type, key: sha + '.' + extensions[file.type] };
}
type Options = { apiBase: string; token: string; fetch?: typeof fetch; signal?: AbortSignal };
async function adminFetch(path: string, options: Options, method = 'GET', body?: BodyInit, extra: Record<string, string> = {}): Promise<unknown> {
  independentAdminBase(options.apiBase);
  if (!options.token) throw new Error('请先登录管理员工作台。');
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(options.apiBase + path, { method, body, credentials: 'omit', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + options.token, ...extra },
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
  } catch { throw new Error(method === 'GET' ? '当前修订读取失败，请重新读取。' : '结果未知，请先核对当前修订或素材状态，不要重复提交。'); }
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(response.status === 409 ? '内容修订或素材SHA不一致，请重新核对并审核。' : '操作未完成（HTTP ' + response.status + '），请核对状态后再操作。');
  if (!payload || typeof payload !== 'object' || !('data' in payload)) throw new Error('回执无法读取，请先核对状态，不要重复提交。');
  return payload.data;
}
export async function readPublicationStatus(input: PublicationInput, options: Options): Promise<PublicationStatus> {
  const raw = await adminFetch('/v1/admin/publications?' + new URLSearchParams({ kind: input.kind, key: input.key }), options) as PublicationStatus;
  if (!raw || raw.kind !== input.kind || raw.key !== input.key || !Number.isSafeInteger(raw.revision) || raw.revision < 0
    || (raw.revision === 0 ? raw.action !== null || raw.publishedAt !== null || raw.approvalArtifactSha !== null
      : !['publish', 'withdraw'].includes(raw.action ?? '') || typeof raw.publishedAt !== 'string' || !Number.isFinite(Date.parse(raw.publishedAt)) || !/^[0-9a-f]{64}$/.test(raw.approvalArtifactSha ?? ''))) throw new Error('当前修订回执无效。');
  return { kind: raw.kind, key: raw.key, revision: raw.revision, action: raw.action, publishedAt: raw.publishedAt, approvalArtifactSha: raw.approvalArtifactSha };
}
export async function submitPublication(review: ReviewedPublication, status: PublicationStatus, approvedSha: string, options: Options): Promise<PublicationReceipt> {
  if (approvedSha !== review.sha || review.sha !== await publicSha(new TextEncoder().encode(canonicalPublicationArtifact(review.input)))
    || status.kind !== review.input.kind || status.key !== review.input.key || status.revision !== review.input.expectedRevision) throw new Error('审核SHA或当前修订不一致。');
  const raw = await adminFetch('/v1/admin/publications', options, 'POST', JSON.stringify(review.input), { 'Content-Type': 'application/json' }) as PublicationReceipt;
  if (!raw || raw.kind !== review.input.kind || raw.key !== review.input.key || raw.revision !== review.input.expectedRevision + 1
    || raw.action !== review.input.action || raw.approvalArtifactSha !== review.sha || !Number.isFinite(Date.parse(raw.publishedAt))) throw new Error('发表回执不一致，请只读核对当前修订。');
  return { kind: raw.kind, key: raw.key, revision: raw.revision, action: raw.action, publishedAt: raw.publishedAt, approvalArtifactSha: raw.approvalArtifactSha };
}
export async function submitPublicAsset(asset: ReviewedAsset, approvedSha: string, options: Options): Promise<{ url: string; sha256: string; bytes: number }> {
  if (approvedSha !== asset.sha || await publicSha(asset.bytes) !== asset.sha) throw new Error('素材审核SHA不一致。');
  const raw = await adminFetch('/v1/admin/public-assets', options, 'POST', asset.bytes, { 'Content-Type': asset.mime, 'x-content-sha256': asset.sha }) as Record<string, unknown>;
  const url = independentAdminBase(options.apiBase) + '/storage/v1/object/public/pdd-public-assets/' + asset.key;
  if (!raw || raw.url !== url || raw.key !== asset.key || raw.sha256 !== asset.sha || raw.mime !== asset.mime || raw.bytes !== asset.bytes.length) throw new Error('素材回执不一致，请核对已审核文件，不能重复覆盖。');
  return { url, sha256: asset.sha, bytes: asset.bytes.length };
}
