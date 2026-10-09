import type { PddHomeStats } from './waybill.ts';

export const HOURLY_STATS_METRIC_VERSION = 'home-six-lifetime-v1' as const;
export const HOURLY_RECORDS_METRIC_VERSION = 'home-six-recorded-additions-v1' as const;
export const HOURLY_FEED_PAGE_SIZE = 20;
export const HOURLY_HISTORY_DEFAULT_HOURS = 48;
export const HOURLY_HISTORY_MAX_HOURS = 720;
export const HOURLY_STATS_KEYS = ['lostRegistered', 'receivedRegistered', 'matchedParcels', 'lostRecipientRegistered', 'receivedRecipientRegistered', 'matchedRecipientLeads'] as const;
/** hour is the UTC server slot; sampledAt is the actual first capture, not an invented boundary. */
export interface HourSnapshot { hour: string; sampledAt: string; metricVersion: typeof HOURLY_STATS_METRIC_VERSION; stats: PddHomeStats }
export interface PublicObservation { id: string; category: string; text: string; publishedAt: string; windowStart: string; windowEnd: string }
export interface HourlyRecordedAdditions {
  metricVersion: typeof HOURLY_RECORDS_METRIC_VERSION; from: string; until: string; firstRecordedAt: string | null;
  hours: Array<{ hour: string; stats: PddHomeStats }>;
}
export interface HourlyHistory { sampledAt: string; snapshots: HourSnapshot[]; records?: HourlyRecordedAdditions }
export interface HourlyFeed { observations: PublicObservation[]; nextBefore: string | null }
export interface HourlyDashboard extends HourlyHistory, HourlyFeed { metricVersion: typeof HOURLY_STATS_METRIC_VERSION; stats: PddHomeStats }
export interface HourlyReadParameters { hours?: number; date?: string; before?: string }

/** Private deterministic candidates. The model receives only the projected text/id fields. */
export interface HourlyCandidate {
 id:string; kind:'registration'|'operation'|'traffic'|'outcome'|'production-release'|'side-difference'|'result-share';
 topic:string;score:number;priority:number;windowStart:string;windowEnd:string;dedupKey:string;
 headlines:Array<{id:string;text:string}>;facts:Array<{id:string;text:string}>;
 stableFactKeys?:string[];windowId?:'h1'|'h3'|'h24';source?:string;definitionVersion?:string;value?:number;direction?:'up'|'down'|'equal';
}
export interface HourlyModelInput {runId?:string;observedUntil:string;timezone:'Asia/Bangkok';selectionLimit:3;candidates:Array<Omit<HourlyCandidate,'stableFactKeys'|'windowId'|'source'|'definitionVersion'|'value'|'direction'>>;recentObservations:Array<{candidateId:string;topic:string;publishedAt:string}>}
export interface HourlySelection {observations:Array<{candidateId:string;headlineId:string;factIds:string[]}>}
export interface HourlyUsage {inputTokens:number;outputTokens:number;costUsd:number}
export interface HourlyReservation {reserved:boolean;runId:string|null;observedUntil:string;state:'reserved'|'completed'|'rejected'|'unknown'|'disabled'|'expired'|'limited'}
export interface HourlyRuntime {enabled:boolean;model:string|null;promptVersion:string|null;modelKey?:string;dailyCallLimit:24;reservationUsd:0.01}

export type HourlyQueryCount = { hour: string; lookup: 'waybill' | 'recipient'; mode: 'lost' | 'received'; source: 'manual' | 'barcode' | null; result: 'matched' | 'possible' | 'duplicate' | 'not_found' | 'closed' | 'leads_found'; count: number; excludedTests: number };
export type HourlyBusinessCount = { hour: string; stats: PddHomeStats; handovers: number; excludedTests: number };
/** Private preprocessor input: only bounded aggregates, never business identifiers or user input. */
export interface HourlySourceInput {
  sampledAt: string; observedUntil: string; fromHour: string; metricVersion: typeof HOURLY_STATS_METRIC_VERSION;
  snapshots: HourSnapshot[]; businessHours: HourlyBusinessCount[]; queries: HourlyQueryCount[];
  businessFirstRecordedAt?: Record<keyof PddHomeStats, string | null>;
  queriesFirstRecordedAt?: { waybill: string | null; recipient: string | null };
  legacyDailyTraffic?: { truncated: boolean; events: Array<{ day: string; count: number }> };
  outcomesAvailable: boolean; outcomes: Array<{ kind: 'parcel-match' | 'recipient-match' | 'handover'; at: string; key: string }> ; publishedFactKeys: string[]; recentObservations: Array<{ candidateId: string; topic: string; dedupKey: string; publishedAt: string; windowStart: string; windowEnd: string;windowId?:'h1'|'h3'|'h24';source?:string;definitionVersion?:string;value?:number;direction?:'up'|'down'|'equal' }>; verifiedReleases: Array<{ key: string; at: string; category: string; text: string }>;
  telemetry: { truncated: boolean; startedAt: string; events: Array<{ hour: string; event: string; page: string; mode: string | null; source: string | null; scanMode: string | null; batch: string | null; bucket: string | null; count: number }>; budget: Array<{ day: string; acceptedEvents: number; acceptedBatches: number; dailyLimit: number; limitedAt: string | null }> };
}

type Row = Record<string, unknown>;
function invalid(): never { throw new Error('INVALID_HOURLY_CONTENT'); }
function row(value: unknown): Row { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value as Row; }
function numeric(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) invalid(); return Number(value); }
function timestamp(value: unknown): string { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) invalid(); return value; }
export function hourlyId(value: unknown): string { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) invalid(); return value; }
function text(value: unknown, maximum: number): string { if (typeof value !== 'string' || !value.trim() || Array.from(value).length > maximum || /[\u0000-\u001f\u007f]/.test(value)) invalid(); return value; }
export function hourlySix(value: unknown): PddHomeStats { const input = row(value); return Object.fromEntries(HOURLY_STATS_KEYS.map(key => [key, numeric(input[key])])) as unknown as PddHomeStats; }
export function hourlySnapshot(value: unknown): HourSnapshot {
  const input = row(value), hour = timestamp(input.hour), sampledAt = timestamp(input.sampledAt);
  if (input.metricVersion !== HOURLY_STATS_METRIC_VERSION || Date.parse(hour) % 3600000 !== 0 || Math.floor(Date.parse(sampledAt) / 3600000) !== Date.parse(hour) / 3600000) invalid();
  return { hour, sampledAt, metricVersion: HOURLY_STATS_METRIC_VERSION, stats: hourlySix(input.stats) };
}
export function hourlyObservation(value: unknown): PublicObservation {
  const input = row(value), windowStart = timestamp(input.windowStart), windowEnd = timestamp(input.windowEnd), publishedAt = timestamp(input.publishedAt);
  if (Date.parse(windowStart) >= Date.parse(windowEnd) || Date.parse(windowEnd) > Date.parse(publishedAt)) invalid();
  return { id: hourlyId(input.id), category: text(input.category, 24), text: text(input.text, 90), publishedAt, windowStart, windowEnd };
}
/** Recorded additions are event-time buckets, never reconstructed cumulative snapshots. */
export function hourlyRecordedAdditions(value: unknown, sampledAt: string): HourlyRecordedAdditions {
  const input = row(value), hourSize = 3_600_000;
  const strictTime = (value: unknown) => {
    const parsed = timestamp(value), civil = parsed.slice(0, 10);
    const [year, month, day] = civil.split('-').map(Number);
    if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== civil) invalid();
    return parsed;
  };
  const from = strictTime(input.from), until = strictTime(input.until);
  const firstRecordedAt = input.firstRecordedAt === null ? null : strictTime(input.firstRecordedAt);
  const start = Date.parse(from), end = Date.parse(until), first = firstRecordedAt === null ? null : Date.parse(firstRecordedAt);
  if (input.metricVersion !== HOURLY_RECORDS_METRIC_VERSION || start % hourSize !== 0 || start > end
    || end !== Date.parse(sampledAt) || end - start > (HOURLY_HISTORY_MAX_HOURS + 1) * hourSize
    || (first !== null && first > end) || !Array.isArray(input.hours) || input.hours.length > HOURLY_HISTORY_MAX_HOURS + 1) invalid();
  let previous: number | null = null;
  const expectedFirst = first === null ? null : Math.max(start, Math.floor(first / hourSize) * hourSize);
  const hours = input.hours.map(value => {
    const item = row(value), hour = strictTime(item.hour), at = Date.parse(hour);
    if (first === null || at % hourSize !== 0 || at < start || at >= end || at < Math.floor(first / hourSize) * hourSize
      || (previous === null ? at !== expectedFirst : at !== previous + hourSize)) invalid();
    previous = at;
    return { hour, stats: hourlySix(item.stats) };
  });
  return { metricVersion: HOURLY_RECORDS_METRIC_VERSION, from, until, firstRecordedAt, hours };
}
export function hourlyHistory(value: unknown): HourlyHistory {
  const input = row(value), sampledAt = timestamp(input.sampledAt);
  if (!Array.isArray(input.snapshots) || input.snapshots.length > HOURLY_HISTORY_MAX_HOURS + 1) invalid();
  const snapshots = input.snapshots.map(hourlySnapshot), seen = new Set<string>(); let previous = -Infinity;
  for (const snapshot of snapshots) { const at = Date.parse(snapshot.hour); if (seen.has(snapshot.hour) || at <= previous || Date.parse(snapshot.sampledAt) > Date.parse(sampledAt)) invalid(); seen.add(snapshot.hour); previous = at; }
  return { sampledAt, snapshots, ...(input.records === undefined ? {} : { records: hourlyRecordedAdditions(input.records, sampledAt) }) };
}
export function hourlyFeed(value: unknown): HourlyFeed {
  const input = row(value); if (!Array.isArray(input.observations) || input.observations.length > HOURLY_FEED_PAGE_SIZE) invalid();
  const observations = input.observations.map(hourlyObservation), seen = new Set<string>(); let previous = Infinity;
  for (const item of observations) { const at = Date.parse(item.publishedAt); if (seen.has(item.id) || at > previous) invalid(); seen.add(item.id); previous = at; }
  const nextBefore = input.nextBefore === null ? null : hourlyId(input.nextBefore);
  if (nextBefore !== null && (observations.length !== HOURLY_FEED_PAGE_SIZE || observations.at(-1)?.id !== nextBefore)) invalid();
  return { observations, nextBefore };
}
export function hourlyDashboard(value: unknown): HourlyDashboard {
  const input = row(value); if (input.metricVersion !== HOURLY_STATS_METRIC_VERSION) invalid();
  return { ...hourlyHistory(input), metricVersion: HOURLY_STATS_METRIC_VERSION, stats: hourlySix(input.stats), ...hourlyFeed(input) };
}
