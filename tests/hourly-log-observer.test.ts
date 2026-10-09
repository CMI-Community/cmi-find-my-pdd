import { describe, expect, it } from 'vitest';
import { observationCandidates } from '../shared/hourly-observer';
import { HOURLY_STATS_KEYS, HOURLY_STATS_METRIC_VERSION, type HourlySourceInput } from '../shared/hourly-content';
const H = 3_600_000, end = Date.parse('2026-10-09T08:00:00Z'), iso = (at: number) => new Date(at).toISOString();
const zero = () => Object.fromEntries(HOURLY_STATS_KEYS.map(key => [key, 0])) as unknown as HourlySourceInput['businessHours'][number]['stats'];
function input(): HourlySourceInput {
  const from = end - 192 * H;
  return { sampledAt: iso(end + 300_000), observedUntil: iso(end), fromHour: iso(from), metricVersion: HOURLY_STATS_METRIC_VERSION,
    snapshots: [], businessHours: Array.from({ length: 192 }, (_, index) => ({ hour: iso(from + index * H), stats: zero(), handovers: 0, excludedTests: 0 })),
    businessFirstRecordedAt: Object.fromEntries(HOURLY_STATS_KEYS.map(key => [key, iso(from)])) as NonNullable<HourlySourceInput['businessFirstRecordedAt']>,
    queriesFirstRecordedAt: { waybill: iso(from), recipient: null }, queries: [], outcomesAvailable: false, outcomes: [], publishedFactKeys: [], recentObservations: [], verifiedReleases: [],
    telemetry: { startedAt: iso(end + 60_000), truncated: false, events: [], budget: ['2026-10-07', '2026-10-08'].map(day => ({ day, acceptedEvents: 300, acceptedBatches: 10, dailyLimit: 1000, limitedAt: null })) } };
}
const rows = (source: HourlySourceInput) => observationCandidates(source).filter(item => item.kind === 'registration');
function registration(source: HourlySourceInput) {
  source.businessHours.at(-1)!.stats.lostRegistered = 14; source.businessHours.at(-2)!.stats.lostRegistered = 6;
}
describe('historical recorded facts without invented captures', () => {
  it('uses completed event buckets before new capture/telemetry enablement', () => {
    const source = input(); registration(source);
    const candidate = rows(source)[0];
    expect(candidate.value).toBe(14); expect(candidate.windowEnd).toBe(source.observedUntil);
    expect(candidate.source).toBe('public-six-records'); expect(candidate.definitionVersion).toBe('home-six-recorded-additions-v1');
    expect(candidate.facts[0].text).toContain('前1小时 6条'); expect(source.snapshots).toEqual([]);
  });
  it.each(['partial-first-hour', 'unknown-first-record', 'gap', 'duplicate-hour', 'test-pollution'] as const)('skips %s recorded windows', damage => {
    const source = input(); registration(source);
    if (damage === 'partial-first-hour') source.businessFirstRecordedAt!.lostRegistered = iso(end - 1.5 * H);
    if (damage === 'unknown-first-record') source.businessFirstRecordedAt!.lostRegistered = null;
    if (damage === 'gap') source.businessHours.splice(-2, 1);
    if (damage === 'duplicate-hour') source.businessHours.at(-2)!.hour = source.businessHours.at(-1)!.hour;
    if (damage === 'test-pollution') source.businessHours.at(-1)!.excludedTests = 1;
    expect(rows(source)).toEqual([]);
  });
  it('uses the query log coverage independently of new browser hourly coverage', () => {
    const source = input(); source.queries = [70, 10].map((count, index) => ({ hour: iso(end - (index + 1) * H), lookup: 'waybill', mode: 'lost', source: 'manual', result: 'not_found', count, excludedTests: 0 }));
    expect(observationCandidates(source).some(item => item.topic === 'query-waybill')).toBe(true);
    source.queriesFirstRecordedAt!.waybill = iso(end - 1.5 * H);
    expect(observationCandidates(source).some(item => item.topic === 'query-waybill')).toBe(false);
  });
  it('compares retained daily traffic as complete UTC days and does not manufacture hourly observations', () => {
    const source = input(); source.legacyDailyTraffic = { truncated: false, events: [{ day: '2026-10-07', count: 30 }, { day: '2026-10-08', count: 90 }] };
    const candidates = observationCandidates(source), candidate = candidates.find(item => item.topic === 'daily-page-views')!;
    expect(candidate.definitionVersion).toBe('server-utc-daily-v1'); expect(candidate.windowStart).toBe('2026-10-08T00:00:00.000Z'); expect(candidate.windowEnd).toBe('2026-10-09T00:00:00.000Z');
    expect(candidate.facts[0].text).toContain('10/8 07:00–10/9 07:00'); expect(candidates.some(item => item.topic === 'page-views')).toBe(false);
    source.recentObservations = [{ candidateId: candidate.id, topic: candidate.topic, dedupKey: candidate.dedupKey, publishedAt: source.sampledAt, windowStart: candidate.windowStart, windowEnd: candidate.windowEnd, windowId: candidate.windowId, source: candidate.source, definitionVersion: candidate.definitionVersion, value: candidate.value, direction: candidate.direction }];
    expect(observationCandidates(source).some(item => item.topic === 'daily-page-views')).toBe(false);
  });
  it.each(['missing-budget', 'limited', 'truncated', 'duplicate-day', 'exceeds-receipts'] as const)('skips %s daily traffic evidence', damage => {
    const source = input(); source.legacyDailyTraffic = { truncated: false, events: [{ day: '2026-10-07', count: 30 }, { day: '2026-10-08', count: 90 }] };
    if (damage === 'missing-budget') source.telemetry.budget = [];
    if (damage === 'limited') source.telemetry.budget[0].limitedAt = source.sampledAt;
    if (damage === 'truncated') source.legacyDailyTraffic.truncated = true;
    if (damage === 'duplicate-day') source.legacyDailyTraffic.events.push({ day: '2026-10-08', count: 1 });
    if (damage === 'exceeds-receipts') source.legacyDailyTraffic.events[1].count = 301;
    expect(observationCandidates(source).some(item => item.topic === 'daily-page-views')).toBe(false);
  });
});
