import { request, ApiFailure, API_BASE } from './api';
import { PUBLIC_STATS_METRIC_VERSION, publicContentDate, validateInsightReport, validateOutreachCatalog, validateDeveloperGroup,
  type PddStatsHistory, type PddInsightReports, type PddOutreach, type PublishedContent } from '../shared/public-content';
import type { PddHomeStats } from '../shared/waybill';
import { bangkokDay } from '../shared/insight-history';

const invalid = () => new ApiFailure('公开内容暂时无法读取，请稍后重试。', 'INVALID_RESPONSE');
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function time(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw invalid();
  return value;
}
function stats(value: unknown): PddHomeStats {
  const item = row(value);
  for (const key of ['lostRegistered','receivedRegistered','matchedParcels','lostRecipientRegistered','receivedRecipientRegistered','matchedRecipientLeads']) {
    if (!Number.isSafeInteger(item[key]) || Number(item[key]) < 0) throw invalid();
  }
  return { lostRegistered: Number(item.lostRegistered), receivedRegistered: Number(item.receivedRegistered), matchedParcels: Number(item.matchedParcels),
    lostRecipientRegistered: Number(item.lostRecipientRegistered), receivedRecipientRegistered: Number(item.receivedRecipientRegistered), matchedRecipientLeads: Number(item.matchedRecipientLeads) };
}
function published<T>(value: unknown, validate: (value: unknown) => T): PublishedContent<T> {
  const item = row(value);
  if (typeof item.key !== 'string' || !Number.isSafeInteger(item.revision) || Number(item.revision) < 1) throw invalid();
  return { key: item.key, revision: Number(item.revision), publishedAt: time(item.publishedAt), content: validate(item.content) };
}
async function safe<T>(path: string, validate: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
  const value = await request<unknown>(path, { signal });
  try { return validate(value); } catch { throw invalid(); }
}
export const publicContentApi = {
  history: (days: 7 | 30, signal?: AbortSignal) => safe<PddStatsHistory>('/v1/insights/history?days=' + days, value => {
    const result = row(value);
    if (!Array.isArray(result.snapshots) || result.snapshots.length > 31) throw invalid();
    const snapshots = result.snapshots.map(value => {
      const item = row(value), day = publicContentDate(item.day), sampledAt = time(item.sampledAt);
      if (item.metricVersion !== PUBLIC_STATS_METRIC_VERSION || bangkokDay(Date.parse(sampledAt)) !== day) throw invalid();
      return { day, sampledAt, metricVersion: PUBLIC_STATS_METRIC_VERSION as typeof PUBLIC_STATS_METRIC_VERSION, stats: stats(item.stats) };
    });
    if (new Set(snapshots.map(item => item.day)).size !== snapshots.length) throw invalid();
    return { snapshots };
  }, signal),
  reports: (date = '', offset = 0, signal?: AbortSignal) => safe<PddInsightReports>('/v1/insights/reports?' + (date ? 'date=' + encodeURIComponent(date) : 'offset=' + offset), value => {
    const result = row(value);
    if (!Array.isArray(result.reports) || result.reports.length > 20 || (result.nextOffset !== null && (!Number.isSafeInteger(result.nextOffset) || Number(result.nextOffset) < 0))) throw invalid();
    const reports = result.reports.map(value => published(value, validateInsightReport));
    if (reports.some(report => report.key !== report.content.date)) throw invalid();
    return { reports, nextOffset: result.nextOffset as number | null };
  }, signal),
  outreach: (signal?: AbortSignal) => safe<PddOutreach>('/v1/outreach', value => {
    const result = row(value);
    const catalog = result.catalog === null ? null : published(result.catalog, value => validateOutreachCatalog(value, API_BASE));
    const developerGroup = result.developerGroup === null ? null : published(result.developerGroup, value => validateDeveloperGroup(value, API_BASE));
    if ((catalog && catalog.key !== 'main') || (developerGroup && developerGroup.key !== 'developer')) throw invalid();
    return { catalog, developerGroup };
  }, signal),
};
