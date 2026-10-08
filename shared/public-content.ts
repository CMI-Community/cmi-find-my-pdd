import type { PddHomeStats } from './waybill.ts';

export const PUBLIC_STATS_METRIC_VERSION = 'home-six-lifetime-v1';
export const PUBLIC_ASSET_BUCKET = 'pdd-public-assets';
export const PUBLIC_CONTENT_KINDS = ['insight', 'outreach', 'group'] as const;
export type PublicContentKind = typeof PUBLIC_CONTENT_KINDS[number];
export interface PddStatsSnapshot { day: string; sampledAt: string; metricVersion: typeof PUBLIC_STATS_METRIC_VERSION; stats: PddHomeStats }
export interface PddStatsHistory { snapshots: PddStatsSnapshot[] }
export interface InsightFinding { title: string; observed: string; interpretation: string; unknown: string; helpUrl: string | null }
export interface InsightReport {
  date: string; title: string; summary: string; asOf: string; window: string;
  findings: InsightFinding[]; newsIds: string[]; limitations: string[];
}
export type OutreachItemKind = 'news' | 'video' | 'guide' | 'comic' | 'copy' | 'image' | 'pack';
export interface OutreachItem {
  id: string; kind: OutreachItemKind; origin: 'third-party' | 'pdd404';
  title: string; summary: string; source: string; sourceUrl: string | null;
  publishedAt: string | null; checkedAt: string; channels: string[];
  thumbnailUrl: string | null; downloadUrl: string | null; copyText: string | null;
}
export interface OutreachCatalog { items: OutreachItem[] }
export interface DeveloperGroup { title: string; invitation: string; qrUrl: string; qrUpdatedAt: string; expiresAt: string | null }
export interface PublishedContent<T> { key: string; revision: number; publishedAt: string; content: T }
export interface PddInsightReports { reports: PublishedContent<InsightReport>[]; nextOffset: number | null }
export interface PddOutreach {
  catalog: PublishedContent<OutreachCatalog> | null;
  developerGroup: PublishedContent<DeveloperGroup> | null;
}
export interface PublicationInput {
  kind: PublicContentKind; key: string; action: 'publish' | 'withdraw'; expectedRevision: number;
  content: InsightReport | OutreachCatalog | DeveloperGroup | null; approvalArtifactSha: string;
}
export interface PublicationReceipt {
  kind: PublicContentKind; key: string; revision: number; action: 'publish' | 'withdraw';
  publishedAt: string; approvalArtifactSha: string;
}
export interface PublicationStatus {
  kind: PublicContentKind; key: string; revision: number; action: 'publish' | 'withdraw' | null;
  publishedAt: string | null; approvalArtifactSha: string | null;
}
type ObjectValue = Record<string, unknown>;
function invalid(): never { throw new Error('INVALID_PUBLIC_CONTENT'); }
function object(value: unknown, keys: readonly string[]): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as ObjectValue;
  if (Object.keys(row).some(key => !keys.includes(key)) || keys.some(key => !(key in row))) invalid();
  return row;
}
function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid();
  return value.trim();
}
function array(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) invalid(); return value; }
export function publicContentDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) invalid();
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) invalid();
  return value;
}
function nullable<T>(value: unknown, validate: (value: unknown) => T): T | null { return value === null ? null : validate(value); }
export function validatePublicSourceUrl(value: unknown): string {
  const urlText = text(value, 2048);
  let url: URL;
  try { url = new URL(urlText); } catch { return invalid(); }
  const hostname = url.hostname.toLowerCase();
  let path: string;
  try { path = decodeURIComponent(url.pathname).toLowerCase(); } catch { return invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')
    || !hostname.includes('.') || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.localhost')
    || /^[\d.]+$/.test(hostname) || hostname.includes(':') || hostname.endsWith('.supabase.co')
    || /\/(?:m|rm|manage|admin|auth|api|functions|storage)(?:\/|$)/.test(path)
    || (['pdd404.app', 'www.pdd404.app'].includes(hostname) && /^\/p\//.test(path))) invalid();
  for (const key of url.searchParams.keys()) if (/token|capability|password|authorization|secret|^cap$|^key$/i.test(key)) invalid();
  return url.href;
}
/** Only immutable objects in the dedicated public bucket; never business storage. */
export function validatePublicAssetUrl(value: unknown, supabaseUrl?: string): string {
  const urlText = text(value, 2048);
  let url: URL;
  try { url = new URL(urlText); } catch { return invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port
    || !/^[a-z]{20}\.supabase\.co$/.test(url.hostname)
    || !/^\/storage\/v1\/object\/public\/pdd-public-assets\/[0-9a-f]{64}\.(?:png|jpg|jpeg|webp|mp4|pdf|zip)$/.test(url.pathname)) invalid();
  if (supabaseUrl) { let origin: string; try { origin = new URL(supabaseUrl).origin; } catch { return invalid(); } if (url.origin !== origin) invalid(); }
  return url.href;
}
function helpUrl(value: unknown): string {
  if (typeof value !== 'string' || !/^\/(?:help)?(?:#[a-z][a-z0-9-]{0,63})?$/.test(value)) invalid();
  return value;
}
function itemId(value: unknown): string { const id = text(value, 64); if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) invalid(); return id; }
export function validateInsightReport(value: unknown): InsightReport {
  const row = object(value, ['date', 'title', 'summary', 'asOf', 'window', 'findings', 'newsIds', 'limitations']);
  const findings = array(row.findings, 8).map(value => {
    const finding = object(value, ['title', 'observed', 'interpretation', 'unknown', 'helpUrl']);
    return { title: text(finding.title, 100), observed: text(finding.observed, 1200), interpretation: text(finding.interpretation, 1200), unknown: text(finding.unknown, 800), helpUrl: nullable(finding.helpUrl, helpUrl) };
  });
  if (!findings.length) invalid();
  const newsIds = array(row.newsIds, 12).map(itemId);
  if (new Set(newsIds).size !== newsIds.length) invalid();
  const date = publicContentDate(row.date), asOf = timestamp(row.asOf);
  if (new Date(Date.parse(asOf) + 7 * 3600_000).toISOString().slice(0, 10) !== date) invalid();
  return { date, title: text(row.title, 160), summary: text(row.summary, 1200), asOf, window: text(row.window, 400), findings, newsIds, limitations: array(row.limitations, 12).map(value => text(value, 800)) };
}
export function validateOutreachCatalog(value: unknown, supabaseUrl?: string): OutreachCatalog {
  const row = object(value, ['items']);
  const items = array(row.items, 100).map(value => {
    const item = object(value, ['id', 'kind', 'origin', 'title', 'summary', 'source', 'sourceUrl', 'publishedAt', 'checkedAt', 'channels', 'thumbnailUrl', 'downloadUrl', 'copyText']);
    if (!['news', 'video', 'guide', 'comic', 'copy', 'image', 'pack'].includes(String(item.kind)) || !['third-party', 'pdd404'].includes(String(item.origin))) invalid();
    const kind = item.kind as OutreachItemKind, origin = item.origin as OutreachItem['origin'];
    const sourceUrl = nullable(item.sourceUrl, validatePublicSourceUrl), downloadUrl = nullable(item.downloadUrl, value => validatePublicAssetUrl(value, supabaseUrl));
    const copyText = nullable(item.copyText, value => text(value, 4000));
    if ((origin === 'third-party' && (!sourceUrl || !['news', 'video'].includes(kind)))
      || (['news', 'guide', 'video'].includes(kind) && !sourceUrl)
      || (kind === 'copy' && !copyText) || (['comic', 'image', 'pack'].includes(kind) && !downloadUrl)) invalid();
    const channels = array(item.channels, 8).map(value => text(value, 40));
    if (!channels.length || new Set(channels).size !== channels.length) invalid();
    return { id: itemId(item.id), kind, origin, title: text(item.title, 160), summary: text(item.summary, 1000), source: text(item.source, 160), sourceUrl,
      publishedAt: nullable(item.publishedAt, timestamp), checkedAt: timestamp(item.checkedAt), channels,
      thumbnailUrl: nullable(item.thumbnailUrl, value => validatePublicAssetUrl(value, supabaseUrl)), downloadUrl, copyText };
  });
  if (new Set(items.map(item => item.id)).size !== items.length) invalid();
  return { items };
}
export function validateDeveloperGroup(value: unknown, supabaseUrl?: string): DeveloperGroup {
  const row = object(value, ['title', 'invitation', 'qrUrl', 'qrUpdatedAt', 'expiresAt']);
  const qrUrl = validatePublicAssetUrl(row.qrUrl, supabaseUrl);
  if (!/\.(?:png|jpg|jpeg|webp)$/.test(qrUrl)) invalid();
  return { title: text(row.title, 120), invitation: text(row.invitation, 2000), qrUrl, qrUpdatedAt: timestamp(row.qrUpdatedAt), expiresAt: nullable(row.expiresAt, timestamp) };
}
export function validatePublicationInput(value: unknown, supabaseUrl?: string): PublicationInput {
  const row = object(value, ['kind', 'key', 'action', 'expectedRevision', 'content', 'approvalArtifactSha']);
  if (!(PUBLIC_CONTENT_KINDS as readonly unknown[]).includes(row.kind) || !['publish', 'withdraw'].includes(String(row.action))
    || !Number.isSafeInteger(row.expectedRevision) || Number(row.expectedRevision) < 0
    || typeof row.approvalArtifactSha !== 'string' || !/^[0-9a-f]{64}$/.test(row.approvalArtifactSha)) invalid();
  const kind = row.kind as PublicContentKind, key = kind === 'insight' ? publicContentDate(row.key) : row.key;
  if ((kind === 'outreach' && key !== 'main') || (kind === 'group' && key !== 'developer')) invalid();
  const action = row.action as PublicationInput['action'];
  const content = action === 'withdraw' ? null : kind === 'insight' ? validateInsightReport(row.content) : kind === 'outreach' ? validateOutreachCatalog(row.content, supabaseUrl) : validateDeveloperGroup(row.content, supabaseUrl);
  if ((action === 'withdraw' && row.content !== null) || (kind === 'insight' && content && (content as InsightReport).date !== key)) invalid();
  return { kind, key: key as string, action, expectedRevision: row.expectedRevision as number, content, approvalArtifactSha: row.approvalArtifactSha };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as ObjectValue)[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
/** Hash this exact, normalized publication envelope before asking for approval. */
export function canonicalPublicationArtifact(input: PublicationInput): string {
  return canonical({ kind: input.kind, key: input.key, action: input.action, expectedRevision: input.expectedRevision, content: input.content });
}
