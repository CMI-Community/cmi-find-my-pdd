import { describe, expect, it } from 'vitest';
import { countChange, observationCandidates, observationModelInput, resultShare, sideChange, trendEligible, validateObservationSelection } from '../shared/hourly-observer.ts';
import { HOURLY_STATS_KEYS, HOURLY_STATS_METRIC_VERSION, type HourlyCandidate, type HourlySourceInput } from '../shared/hourly-content.ts';
const H = 3600000, until = Date.parse('2026-10-09T14:00:00Z'), stamp = (n: number) => new Date(n).toISOString();
const fact = (n: number) => n.toString(16).padStart(64, '0');
const six = () => Object.fromEntries(HOURLY_STATS_KEYS.map(key => [key, 0])) as unknown as HourlySourceInput['businessHours'][number]['stats'];
function source(): HourlySourceInput {
  const from = until - 192 * H;
  return { sampledAt: stamp(until + 5 * 60000), observedUntil: stamp(until), fromHour: stamp(from), metricVersion: HOURLY_STATS_METRIC_VERSION,
    snapshots: Array.from({ length: 193 }, (_, index) => ({ hour: stamp(from + index * H), sampledAt: stamp(from + index * H + 2000), metricVersion: HOURLY_STATS_METRIC_VERSION, stats: six() })),
    businessHours: Array.from({ length: 192 }, (_, index) => ({ hour: stamp(from + index * H), stats: six(), handovers: 0, excludedTests: 0 })),
    queries: [], outcomesAvailable: true, outcomes: [], verifiedReleases: [], publishedFactKeys: [], recentObservations: [],
    telemetry: { truncated: false, startedAt: stamp(from), events: [], budget: Array.from({ length: 10 }, (_, days) => ({ day: stamp(until - days * 24 * H).slice(0, 10), acceptedEvents: 100, acceptedBatches: 10, dailyLimit: 5000, limitedAt: null })) } };
}
function registration(input: HourlySourceInput, hour: number, count: number) {
  input.businessHours.find(row => Date.parse(row.hour) === hour)!.stats.lostRegistered += count;
  for (const snapshot of input.snapshots) if (Date.parse(snapshot.hour) > hour) snapshot.stats.lostRegistered += count;
}
function query(input: HourlySourceInput, hour: number, count: number, result: 'matched' | 'not_found' = 'not_found') {
  input.queries.push({ hour: stamp(hour), lookup: 'waybill', mode: 'lost', source: 'manual', result, count, excludedTests: 0 });
}
function event(input: HourlySourceInput, hour: number, count: number, name = 'pdd_page_view') {
  input.telemetry.events.push({ hour: stamp(hour), count, event: name, page: 'home', mode: null, source: null, scanMode: null, batch: null, bucket: null });
}
function choice(candidate: HourlyCandidate) { return { candidateId: candidate.id, headlineId: candidate.headlines[0].id, factIds: [candidate.facts[0].id] }; }

describe('thresholds controlling observation density', () => {
  it.each([
    ['registration', 10, 5, 1, true], ['registration', 9, 5, 1, false], ['registration', 5, 0, 1, false],
    ['registration', 5, 0, 3, true], ['registration', 0, 5, 3, true], ['operation', 30, 20, 1, true],
    ['operation', 29, 10, 1, false], ['operation', 100, 99, 24, false], ['traffic', 50, 30, 1, true],
    ['traffic', 50, 31, 1, false], ['traffic', 80, 0, 1, false],
  ] as const)('%s %i versus %i in %ih', (kind, a, b, hours, emit) => expect(countChange(kind, a, b, hours)).toBe(emit));
  it('does not call a small zero-side ratio infinite', () => { expect(sideChange(10, 0)).toBe(true); expect(sideChange(4, 0)).toBe(false); expect(sideChange(10, 6)).toBe(false); });
  it('uses a matched query numerator and complete denominator', () => {
    expect(resultShare(10, 50, 5, 50)).toEqual({ current: 20, previous: 10 });
    expect(resultShare(10, 49, 5, 50)).toBeNull(); expect(resultShare(51, 50, 1, 50)).toBeNull(); expect(resultShare(9, 50, 1, 50)).toBeNull();
  });
});
describe('real windows and source boundaries', () => {
  it('produces no stable-hour filler', () => expect(observationCandidates(source())).toEqual([]));
  it('uses public cumulative increments with real sample timestamps', () => {
    const input = source(); registration(input, until - 3 * H, 6); registration(input, until - 2 * H, 14);
    const candidate = observationCandidates(input).find(c => c.id === 'waybill-lost-h1')!;
    expect(candidate.value).toBe(14); expect(candidate.facts[0].text).toContain('14'); expect(candidate.windowEnd).toBe(stamp(until - H + 2000));
    expect(candidate.windowEnd).not.toBe(input.observedUntil);
  });
  it.each(['gap', 'test', 'backfill', 'late', 'version', 'negative'] as const)('does not publish %s snapshot comparisons', damage => {
    const input = source(); registration(input, until - 3 * H, 6); registration(input, until - 2 * H, 14);
    const snapshot = input.snapshots.find(s => Date.parse(s.hour) === until - H)!;
    if (damage === 'gap') input.snapshots = input.snapshots.filter(s => s !== snapshot);
    if (damage === 'test') input.businessHours.find(s => Date.parse(s.hour) === until - 2 * H)!.excludedTests = 1;
    if (damage === 'backfill') snapshot.stats.lostRegistered += 6;
    if (damage === 'late') snapshot.sampledAt = stamp(until - H + 121000);
    if (damage === 'version') snapshot.metricVersion = 'legacy' as typeof HOURLY_STATS_METRIC_VERSION;
    if (damage === 'negative') snapshot.stats.lostRegistered = 0;
    expect(observationCandidates(input).filter(c => c.kind === 'registration' || c.kind === 'side-difference')).toEqual([]);
  });
  it('selects 1h before looking for larger 3h changes', () => {
    const input = source(); query(input, until - H, 35); query(input, until - 2 * H, 10); query(input, until - 3 * H, 200);
    expect(observationCandidates(input).find(c => c.id.startsWith('query-waybill'))!.windowId).toBe('h1');
  });
  it('does not treat hours before the observation system started as covered query history', () => {
    const input = source(); input.telemetry.startedAt = stamp(until - H / 2); query(input, until - H, 70); query(input, until - 2 * H, 10);
    expect(observationCandidates(input).some(c => c.topic === 'query-waybill')).toBe(false);
  });
  it('adds same-hour history only after five comparable dates', () => {
    const input = source(); query(input, until - H, 35); query(input, until - 2 * H, 10);
    for (let day = 1; day <= 7; day++) query(input, until - (24 * day + 1) * H, day * 2);
    const candidate = observationCandidates(input).find(c => c.id === 'query-waybill-h1')!;
    expect(candidate.facts[1].text).toContain('中位数 8（7天）'); expect(candidate.facts[1].text).toContain('昨日同一时段 2');
  });
  it.each(['missing-budget', 'limited', 'truncated', 'started-late'] as const)('omits traffic when %s', damage => {
    const input = source(); event(input, until - H, 90); event(input, until - 2 * H, 30);
    if (damage === 'missing-budget') input.telemetry.budget = [];
    if (damage === 'limited') input.telemetry.budget.forEach(row => { row.limitedAt = stamp(until); });
    if (damage === 'truncated') input.telemetry.truncated = true;
    if (damage === 'started-late') input.telemetry.startedAt = stamp(until - H);
    expect(observationCandidates(input).filter(c => c.kind === 'traffic')).toEqual([]);
  });
  it('checks both UTC receipt dates for a midnight-crossing operation window', () => {
    const input = source(), end = Date.parse('2026-10-09T01:00:00Z'); input.observedUntil = stamp(end); input.sampledAt = stamp(end + 300000);
    event(input, end - H, 70, 'pdd_scanner_not_found'); event(input, end - 2 * H, 20, 'pdd_scanner_not_found');
    input.telemetry.budget = input.telemetry.budget.filter(row => row.day !== '2026-10-08');
    expect(observationCandidates(input).some(c => c.topic === 'scanner')).toBe(false);
  });
  it('names page-view events and scan events without inventing people or failures', () => {
    const input = source(); event(input, until - H, 90); event(input, until - 2 * H, 30);
    event(input, until - H, 60, 'pdd_scanner_not_found'); event(input, until - 2 * H, 20, 'pdd_scanner_not_found');
    const candidates = observationCandidates(input); expect(candidates.some(c => c.topic === 'page-views')).toBe(true);
    expect(candidates.find(c => c.topic === 'scanner')!.facts[0].text).toContain('未读出事件');
    expect(JSON.stringify(candidates)).not.toMatch(/用户数|成功率|API故障|转化率/);
  });
});
describe('stable outcomes and selection integrity', () => {
  it('does not reannounce a match in a wider rolling window', () => {
    const input = source(); input.outcomes.push({ kind: 'parcel-match', at: stamp(until - 2 * H), key: fact(1) }); input.publishedFactKeys = [fact(1)];
    expect(observationCandidates(input)).toEqual([]);
  });
  it('recomputes the fresh fact span of a mixed old/new group', () => {
    const input = source(); input.outcomes = [{ kind: 'parcel-match', at: stamp(until - .9 * H), key: fact(1) }, { kind: 'parcel-match', at: stamp(until - .5 * H), key: fact(2) }]; input.publishedFactKeys = [fact(1)];
    const candidate = observationCandidates(input)[0]; expect(candidate.value).toBe(1); expect(candidate.stableFactKeys).toEqual([fact(2)]);
    expect(candidate.windowStart).toBe(stamp(until - .5 * H)); expect(candidate.facts[0].text).toContain('1件');
  });
  it('does not derive a handover from a parcel match', () => {
    const input = source(); input.outcomes = [{ kind: 'parcel-match', at: stamp(until - .5 * H), key: fact(1) }];
    const candidates = observationCandidates(input); expect(candidates[0].topic).toBe('parcel-match'); expect(candidates.some(c => c.topic === 'handover')).toBe(false);
  });
  it('omits outcome candidates if the stable ledger is unavailable', () => {
    const input = source(); input.outcomesAvailable = false; input.outcomes = [{ kind: 'handover', at: stamp(until - .5 * H), key: fact(1) }];
    expect(observationCandidates(input)).toEqual([]);
  });
  it('projects no HMAC ledger or business identity to the model', () => {
    const input = source(); input.outcomes = [{ kind: 'handover', at: stamp(until - .5 * H), key: fact(919) }];
    input.verifiedReleases = [{ key: fact(920), at: stamp(until - .8 * H), category: '网站更新', text: '数据页加入小时折线图。' }];
    const dto = observationModelInput(input, observationCandidates(input));
    expect(JSON.stringify(dto)).not.toContain(fact(919)); expect(JSON.stringify(dto)).not.toContain(fact(920)); expect(JSON.stringify(dto)).not.toContain('stableFactKeys');
    expect(Object.keys(dto.candidates[0])).not.toContain('source'); expect(Object.keys(dto)).not.toContain('queries');
  });
  it('rejects the complete batch for a second invalid/cross-candidate selection', () => {
    const input = source(); input.outcomes = [{ kind: 'parcel-match', at: stamp(until - .5 * H), key: fact(1) }, { kind: 'handover', at: stamp(until - .3 * H), key: fact(2) }];
    const candidates = observationCandidates(input);
    expect(() => validateObservationSelection(candidates, { observations: [choice(candidates[0]), { ...choice(candidates[1]), factIds: ['invented'] }] }, [], input.observedUntil)).toThrow('INVALID_SELECTION');
    expect(() => validateObservationSelection(candidates, { observations: [choice(candidates[0])], text: '编造正文' }, [], input.observedUntil)).toThrow();
  });
  it('requires the primary current-window fact before optional historical context', () => {
    const input = source(); query(input, until - H, 35); query(input, until - 2 * H, 10);
    const candidates = observationCandidates(input), candidate = candidates[0];
    candidate.facts.push({ id: 'same-hour', text: '昨日同一时段2次。' });
    const select = (factIds: string[]) => ({ observations: [{ ...choice(candidate), factIds }] });
    expect(() => validateObservationSelection(candidates, select(['same-hour']), [], input.observedUntil)).toThrow();
    expect(() => validateObservationSelection(candidates, select(['same-hour', 'primary']), [], input.observedUntil)).toThrow();
    expect(validateObservationSelection(candidates, select(['primary']), [], input.observedUntil)).toEqual(select(['primary']));
    expect(validateObservationSelection(candidates, select(['primary', 'same-hour']), [], input.observedUntil)).toEqual(select(['primary', 'same-hour']));
  });
  it('rejects duplicate topics, duplicate stable facts and ledger races', () => {
    const input = source(); input.outcomes = [{ kind: 'parcel-match', at: stamp(until - .5 * H), key: fact(1) }];
    const candidate = observationCandidates(input)[0], other = { ...candidate, id: 'other', topic: 'different' };
    expect(() => validateObservationSelection([candidate, other], { observations: [choice(candidate), choice(other)] }, [], input.observedUntil)).toThrow();
    expect(() => validateObservationSelection([candidate], { observations: [choice(candidate)] }, [fact(1)], input.observedUntil)).toThrow();
  });
  it('keeps a quiet model selection empty', () => expect(validateObservationSelection([], { observations: [] }, [], stamp(until))).toEqual({ observations: [] }));
});
describe('trend cooling', () => {
  function setup() {
    const input = source(); query(input, until - H, 35); query(input, until - 2 * H, 10); const candidate = observationCandidates(input)[0];
    const previous = { candidateId: 'previous', topic: candidate.topic, dedupKey: 'prior', publishedAt: stamp(until - H), windowStart: stamp(until - 2 * H), windowEnd: stamp(until - H),
      windowId: candidate.windowId, source: candidate.source, definitionVersion: candidate.definitionVersion, value: 30, direction: 'up' as const };
    return { candidate, previous };
  }
  it('suppresses repeated magnitude within six hours', () => { const { candidate, previous } = setup(); expect(trendEligible(candidate, previous, stamp(until))).toBe(false); });
  it('permits a genuine reversal or doubled new magnitude', () => {
    const { candidate, previous } = setup(); expect(trendEligible({ ...candidate, direction: 'down' }, previous, stamp(until))).toBe(true);
    expect(trendEligible({ ...candidate, value: 70 }, previous, stamp(until))).toBe(true);
  });
  it('does not bypass cooling with a different window or missing prior data', () => {
    const { candidate, previous } = setup(); expect(trendEligible({ ...candidate, windowId: 'h24' }, previous, stamp(until))).toBe(false);
    expect(trendEligible(candidate, { ...previous, value: undefined }, stamp(until + 10 * H))).toBe(false);
  });
  it('requires a new absolute change after six hours', () => {
    const { candidate, previous } = setup(); expect(trendEligible(candidate, previous, stamp(until + 6 * H))).toBe(false);
    expect(trendEligible({ ...candidate, value: 40 }, previous, stamp(until + 6 * H))).toBe(true);
  });
});
