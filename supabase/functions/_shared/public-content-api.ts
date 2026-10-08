import {
  PUBLIC_STATS_METRIC_VERSION, canonicalPublicationArtifact, publicContentDate,
  validateDeveloperGroup, validateInsightReport, validateOutreachCatalog, validatePublicationInput,
  type DeveloperGroup, type InsightReport, type OutreachCatalog, type PddInsightReports,
  type PddOutreach, type PddStatsHistory, type PublicationReceipt, type PublicationStatus, type PublishedContent,
} from '../../../shared/public-content.ts';
import { pddHomeStats } from './waybill-api.ts';
import { ApiError, body, json, uuid } from './http.ts';
import { sha256 } from './security.ts';

type Row = Record<string, any>;
export type PublicContentContext = {
  rpc: (name: string, payload: Row) => Promise<Row>;
  admin: () => Promise<string>;
  publicBaseUrl: string;
  assetExists: (url: string) => Promise<boolean>;
};
/** Storage info only; references must point to a supported uploaded file, never a blob read. */
export function publicAssetMetadataMatches(url: string, metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const row = metadata as Row, extension = new URL(url).pathname.split('.').at(-1);
  const mimeByExtension: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', zip: 'application/zip' };
  const expectedMime = mimeByExtension[extension ?? ''];
  return Boolean(expectedMime) && row.contentType === expectedMime && Number.isSafeInteger(row.size) && row.size > 0 && row.size <= 5 * 1024 * 1024;
}
function invalid(): never { throw new ApiError('INVALID_REQUEST', '公开内容或参数格式有误。', 422); }
function unavailable(): never { throw new ApiError('SERVICE_UNAVAILABLE', '公开内容暂时无法读取，请稍后重试。', 503, true); }
function time(value: unknown): string { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) unavailable(); return value; }
function parameters(request: Request, allowed: string[]): URLSearchParams {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid();
  return params;
}
function bounded(value: string | null, fallback: number, minimum: number, maximum: number): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) invalid();
  const n = Number(value); if (!Number.isSafeInteger(n) || n < minimum || n > maximum) invalid(); return n;
}
function date(value: unknown): string { try { return publicContentDate(value); } catch { return invalid(); } }
function published<T>(row: Row, validate: (value: unknown) => T): PublishedContent<T> {
  if (!row || typeof row.key !== 'string' || !Number.isSafeInteger(row.revision) || row.revision < 1) unavailable();
  try { return { key: row.key, revision: row.revision, publishedAt: time(row.publishedAt), content: validate(row.content) }; }
  catch { return unavailable(); }
}
export function publicHistory(raw: Row): PddStatsHistory {
  if (!raw || !Array.isArray(raw.snapshots) || raw.snapshots.length > 90) unavailable();
  const seen = new Set<string>();
  const snapshots = raw.snapshots.map((row: Row) => {
    let day: string; try { day = publicContentDate(row.day); } catch { return unavailable(); }
    const sampledAt = time(row.sampledAt);
    if (row.metricVersion !== PUBLIC_STATS_METRIC_VERSION || seen.has(day)
      || new Date(Date.parse(sampledAt) + 7 * 3600_000).toISOString().slice(0, 10) !== day) unavailable();
    seen.add(day);
    return { day, sampledAt, metricVersion: PUBLIC_STATS_METRIC_VERSION as typeof PUBLIC_STATS_METRIC_VERSION, stats: pddHomeStats(row.stats) };
  });
  return { snapshots };
}
export function publicReports(raw: Row): PddInsightReports {
  if (!raw || !Array.isArray(raw.reports) || raw.reports.length > 20
    || (raw.nextOffset !== null && (!Number.isSafeInteger(raw.nextOffset) || raw.nextOffset < 0))) unavailable();
  const reports = raw.reports.map((row: Row) => {
    const value = published<InsightReport>(row, validateInsightReport);
    if (value.key !== value.content.date) unavailable();
    return value;
  });
  return { reports, nextOffset: raw.nextOffset };
}
export function publicOutreach(raw: Row, baseUrl: string): PddOutreach {
  if (!raw || !('catalog' in raw) || !('developerGroup' in raw)) unavailable();
  const catalog = raw.catalog === null ? null : published<OutreachCatalog>(raw.catalog, value => validateOutreachCatalog(value, baseUrl));
  const developerGroup = raw.developerGroup === null ? null : published<DeveloperGroup>(raw.developerGroup, value => validateDeveloperGroup(value, baseUrl));
  if ((catalog && catalog.key !== 'main') || (developerGroup && developerGroup.key !== 'developer')) unavailable();
  return { catalog, developerGroup };
}
function receipt(raw: Row): PublicationReceipt {
  if (!raw || !['insight', 'outreach', 'group'].includes(raw.kind) || typeof raw.key !== 'string'
    || !['publish', 'withdraw'].includes(raw.action) || !Number.isSafeInteger(raw.revision) || raw.revision < 1
    || typeof raw.approvalArtifactSha !== 'string' || !/^[0-9a-f]{64}$/.test(raw.approvalArtifactSha)) unavailable();
  return { kind: raw.kind, key: raw.key, action: raw.action, revision: raw.revision, publishedAt: time(raw.publishedAt), approvalArtifactSha: raw.approvalArtifactSha };
}
export async function publicContentRoute(request: Request, parts: string[], headers: Record<string, string>, context: PublicContentContext): Promise<Response | null> {
  if (parts[0] === 'insights') {
    if (request.method !== 'GET' || parts.length !== 2) throw new ApiError('NOT_FOUND', '接口不存在。', 404);
    if (parts[1] === 'history') {
      const params = parameters(request, ['days']);
      return json(publicHistory(await context.rpc('pdd_public_stats_history', { days: bounded(params.get('days'), 30, 1, 90) })), 200, headers);
    }
    if (parts[1] === 'reports') {
      const params = parameters(request, ['date', 'offset']), offset = bounded(params.get('offset'), 0, 0, 100000);
      if (params.has('date') && offset !== 0) invalid();
      return json(publicReports(await context.rpc('pdd_public_insight_reports', { offset, ...(params.has('date') ? { date: date(params.get('date')) } : {}) })), 200, headers);
    }
    throw new ApiError('NOT_FOUND', '接口不存在。', 404);
  }
  if (parts[0] === 'outreach') {
    if (request.method !== 'GET' || parts.length !== 1) throw new ApiError('NOT_FOUND', '接口不存在。', 404);
    parameters(request, []);
    return json(publicOutreach(await context.rpc('pdd_public_outreach', {}), context.publicBaseUrl), 200, headers);
  }
  if (parts[0] === 'admin' && parts[1] === 'publications') {
    const actor = uuid(await context.admin());
    if (request.method === 'GET' && parts.length === 2) {
      const params = parameters(request, ['kind', 'key']);
      let target;
      try { target = validatePublicationInput({ kind: params.get('kind'), key: params.get('key'), action: 'withdraw', expectedRevision: 0, content: null, approvalArtifactSha: '0'.repeat(64) }); } catch { return invalid(); }
      const raw = await context.rpc('pdd_admin_publication_status', { kind: target.kind, key: target.key });
      if (!raw || raw.kind !== target.kind || raw.key !== target.key || !Number.isSafeInteger(raw.revision) || raw.revision < 0) unavailable();
      let result: PublicationStatus;
      if (raw.revision === 0) {
        if (raw.action !== null || raw.publishedAt !== null || raw.approvalArtifactSha !== null) unavailable();
        result = { kind: target.kind, key: target.key, revision: 0, action: null, publishedAt: null, approvalArtifactSha: null };
      } else result = receipt(raw);
      return json(result, 200, headers);
    }
    if (request.method !== 'POST' || parts.length !== 2) throw new ApiError('NOT_FOUND', '接口不存在。', 404);
    parameters(request, []);
    const raw = await body(request);
    let input;
    try { input = validatePublicationInput(raw, context.publicBaseUrl); } catch { return invalid(); }
    if (await sha256(canonicalPublicationArtifact(input)) !== input.approvalArtifactSha) throw new ApiError('ARTIFACT_MISMATCH', '内容与已审核版本不一致，请重新核对。', 409);
    const assetUrls = new Set<string>();
    if (input.action === 'publish' && input.kind === 'outreach') for (const item of (input.content as OutreachCatalog).items) {
      if (item.thumbnailUrl) assetUrls.add(item.thumbnailUrl); if (item.downloadUrl) assetUrls.add(item.downloadUrl);
    }
    if (input.action === 'publish' && input.kind === 'group') assetUrls.add((input.content as DeveloperGroup).qrUrl);
    if (assetUrls.size > 40) invalid();
    // Metadata existence/type/size only, sequential and bounded; no business blobs are read.
    for (const url of assetUrls) if (!await context.assetExists(url)) throw new ApiError('INVALID_ASSET', '公开素材尚未上传或无法核实。', 422);
    const result = receipt(await context.rpc('pdd_publish_content', {
      kind: input.kind, key: input.key, action: input.action, expected_revision: input.expectedRevision,
      content: input.content, actor_id: actor, approval_artifact_sha: input.approvalArtifactSha,
    }));
    if (result.kind !== input.kind || result.key !== input.key || result.action !== input.action
      || result.revision !== input.expectedRevision + 1 || result.approvalArtifactSha !== input.approvalArtifactSha) unavailable();
    return json(result, 201, headers);
  }
  return null;
}
