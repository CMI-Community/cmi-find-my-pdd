import { HOURLY_STATS_METRIC_VERSION, type HourlyCandidate, type HourlyModelInput, type HourlySelection, type HourlySourceInput, type HourSnapshot } from './hourly-content.ts';
import { TELEMETRY_EVENTS, TELEMETRY_PAGES } from './telemetry.ts';

export const OBSERVATION_PROMPT_VERSION = 'hourly-observation-v1';
export const OBSERVATION_MODEL = 'gpt-5.6-luna';
const HOUR = 3_600_000;
const WINDOWS = [1, 3, 24] as const;
const ID = /^[a-z0-9][a-z0-9-]{0,95}$/;
const FACT_KEY = /^[0-9a-f]{64}$/;
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
const iso = (n: number) => new Date(n).toISOString();
type WindowId = 'h1' | 'h3' | 'h24';
type CountKind = 'registration' | 'operation' | 'traffic';
type CountWindow = { start: number; end: number; count: number };
type Series = (start: number, end: number) => CountWindow | null;
type Previous = HourlySourceInput['recentObservations'][number];
const THRESHOLDS = {
  registration: { reference: 5, absolute: 5, volume: 0 },
  operation: { reference: 10, absolute: 10, volume: 30 },
  traffic: { reference: 30, absolute: 20, volume: 50 },
} as const;

export function countChange(kind: CountKind, current: number, reference: number, hours: number): boolean {
  if (!integer(current) || !integer(reference)) return false;
  const rule = THRESHOLDS[kind], delta = current - reference;
  if (Math.abs(delta) < rule.absolute || Math.max(current, reference) < rule.volume) return false;
  if (reference < rule.reference) return kind === 'registration' && hours !== 1 && current >= 5 && delta > 0;
  return Math.abs(delta) / reference >= .5;
}
export function sideChange(left: number, right: number): boolean {
  if (!integer(left) || !integer(right)) return false;
  const high = Math.max(left, right), low = Math.min(left, right);
  return left + right >= 10 && high - low >= 5 && (low === 0 || high / low >= 2);
}
export function resultShare(current: number, denominator: number, previous: number, previousDenominator: number): { current: number; previous: number } | null {
  if (![current, denominator, previous, previousDenominator].every(integer) || current > denominator || previous > previousDenominator
    || Math.min(denominator, previousDenominator) < 50 || Math.max(current, previous) < 10) return null;
  const a = current / denominator * 100, b = previous / previousDenominator * 100;
  return Math.abs(a - b) + 1e-9 >= 10 ? { current: a, previous: b } : null;
}
/** Same-source comparisons only; missing previous metadata never bypasses cooling. */
export function trendEligible(candidate: HourlyCandidate, previous: Previous | undefined, now: string): boolean {
  if (!previous) return true;
  if (candidate.dedupKey === previous.dedupKey) return false;
  if (candidate.topic !== previous.topic) return true;
  const elapsed = Date.parse(now) - Date.parse(previous.publishedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0 || candidate.windowId !== previous.windowId
    || candidate.source !== previous.source || candidate.definitionVersion !== previous.definitionVersion) return false;
  if (candidate.direction && previous.direction && candidate.direction !== previous.direction) return true;
  const minimum = candidate.kind === 'registration' || candidate.kind === 'operation' || candidate.kind === 'traffic'
    ? THRESHOLDS[candidate.kind].absolute : candidate.kind === 'side-difference' ? 5 : candidate.kind === 'result-share' ? 1000 : Infinity;
  if (candidate.value === undefined || previous.value === undefined || !integer(candidate.value) || !integer(previous.value)) return false;
  const difference = Math.abs(candidate.value - previous.value);
  const material = candidate.value >= previous.value * 2 || candidate.value <= previous.value / 2;
  return (material && difference >= minimum * 2) || (elapsed >= 6 * HOUR && difference >= minimum);
}
function range(start: number, end: number): string {
  const shifted = (n: number) => new Date(n + 7 * HOUR);
  const fmt = (n: number, includeDate: boolean) => {
    const d = shifted(n), clock = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    return includeDate ? `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${clock}` : clock;
  };
  const cross = shifted(start).toISOString().slice(0, 10) !== shifted(end).toISOString().slice(0, 10);
  return `${fmt(start, cross)}–${fmt(end, cross)}`;
}
function inRange(at: string, start: number, end: number): boolean { const time = Date.parse(at); return time >= start && time < end; }
function plain(value: string, max: number): boolean { return typeof value === 'string' && !!value.trim() && Array.from(value).length <= max && !/[\u0000-\u001f\u007f]/.test(value); }
function makeCandidate(id: string, kind: HourlyCandidate['kind'], topic: string, label: string, current: CountWindow, text: string, score: number, source: string, hours: number, value: number, direction: 'up' | 'down' | 'equal'): HourlyCandidate {
  const windowId = `h${hours}` as WindowId;
  return { id: `${id}-${windowId}`, kind, topic, score: Math.round(score * 100) / 100, priority: 2,
    windowStart: iso(current.start), windowEnd: iso(current.end), dedupKey: `${id}:${windowId}:${iso(current.end)}:${value}:${direction}`,
    headlines: [{ id: 'label', text: label }], facts: [{ id: 'primary', text }], windowId, source,
    definitionVersion: kind === 'registration' || kind === 'side-difference' ? source === 'public-six-records' ? 'home-six-recorded-additions-v1' : HOURLY_STATS_METRIC_VERSION : 'server-hourly-v1', value, direction };
}

/** Coverage checks are private. The public feed contains facts, not diagnostic paragraphs. */
function telemetryHealthy(source: HourlySourceInput, start: number, end: number): boolean {
  if (source.telemetry.truncated || start < Date.parse(source.telemetry.startedAt) || end > Date.parse(source.observedUntil)) return false;
  for (let day = Math.floor(start / (24 * HOUR)) * 24 * HOUR; day < end; day += 24 * HOUR) {
    const budget = source.telemetry.budget.find(row => row.day === iso(day).slice(0, 10));
    // A missing receipt-day is a coverage gap, not a zero-event comparison.
    if (!budget || budget.limitedAt !== null || !integer(budget.acceptedEvents) || budget.acceptedEvents >= budget.dailyLimit) return false;
  }
  return true;
}
function boundedWindow(source: HourlySourceInput, start: number, end: number): boolean {
  return start >= Date.parse(source.fromHour) && end <= Date.parse(source.observedUntil) && start < end;
}
function querySeries(source: HourlySourceInput, lookup: 'waybill' | 'recipient', result?: string): Series {
  return (start, end) => {
    const first = source.queriesFirstRecordedAt === undefined ? source.telemetry.startedAt : source.queriesFirstRecordedAt[lookup];
    const available = first === null ? NaN : Math.ceil(Date.parse(first) / HOUR) * HOUR;
    if (!boundedWindow(source, start, end) || !Number.isFinite(available) || start < available) return null;
    const rows = source.queries.filter(row => row.lookup === lookup && (!result || row.result === result) && inRange(row.hour, start, end));
    if (rows.some(row => !integer(row.count))) return null;
    const count = rows.reduce((sum, row) => sum + row.count, 0);
    return integer(count) ? { start, end, count } : null;
  };
}
function eventSeries(source: HourlySourceInput, event: string): Series {
  return (start, end) => {
    if (!boundedWindow(source, start, end) || !telemetryHealthy(source, start, end)) return null;
    const rows = source.telemetry.events.filter(row => row.event === event && (TELEMETRY_PAGES as readonly string[]).includes(row.page) && inRange(row.hour, start, end));
    if (rows.some(row => !integer(row.count))) return null;
    const count = rows.reduce((sum, row) => sum + row.count, 0);
    return integer(count) ? { start, end, count } : null;
  };
}
function statsSeries(source: HourlySourceInput, metric: keyof HourSnapshot['stats']): Series {
  const snapshots = new Map(source.snapshots.map(item => [Date.parse(item.hour), item]));
  return (start, end) => {
    if (!boundedWindow(source, start, end)) return null;
    if (source.businessFirstRecordedAt !== undefined) {
      const first = source.businessFirstRecordedAt[metric];
      const available = first === null ? NaN : Math.ceil(Date.parse(first) / HOUR) * HOUR;
      if (!Number.isFinite(available) || start < available) return null;
      const rows = source.businessHours.filter(row => inRange(row.hour, start, end));
      const slots = new Set(rows.map(row => Date.parse(row.hour)));
      if (rows.length !== (end - start) / HOUR || slots.size !== rows.length
        || rows.some(row => Date.parse(row.hour) % HOUR !== 0 || row.excludedTests !== 0 || !integer(row.stats[metric]))) return null;
      const count = rows.reduce((sum, row) => sum + row.stats[metric], 0);
      return integer(count) ? { start, end, count } : null;
    }
    const first = snapshots.get(start), last = snapshots.get(end);
    if (!first || !last || Date.parse(last.sampledAt) > Date.parse(source.observedUntil)) return null;
    // All intermediate captures must exist. Do not smear multi-hour gaps into one hour.
    for (let hour = start; hour <= end; hour += HOUR) {
      const snapshot = snapshots.get(hour);
      if (!snapshot || snapshot.metricVersion !== HOURLY_STATS_METRIC_VERSION || Date.parse(snapshot.sampledAt) - hour < 0
        || Date.parse(snapshot.sampledAt) - hour > 120_000 || !integer(snapshot.stats[metric])) return null;
      if (hour > start && snapshot.stats[metric] < snapshots.get(hour - HOUR)!.stats[metric]) return null;
    }
    const business = source.businessHours.filter(row => inRange(row.hour, start, end));
    if (business.length !== (end - start) / HOUR || business.some(row => row.excludedTests !== 0 || !integer(row.stats[metric]))) return null;
    const count = last.stats[metric] - first.stats[metric];
    // Historical inserts/recounts disagree with contemporaneous event timestamps: skip them.
    if (!integer(count) || count !== business.reduce((sum, row) => sum + row.stats[metric], 0)) return null;
    return { start: Date.parse(first.sampledAt), end: Date.parse(last.sampledAt), count };
  };
}
function addSupport(candidate: HourlyCandidate, series: Series, end: number, hours: number, unit: string): void {
  if (hours !== 1) return;
  const yesterday = series(end - 25 * HOUR, end - 24 * HOUR), samples: number[] = [];
  for (let days = 1; days <= 7; days++) { const row = series(end - (days * 24 + 1) * HOUR, end - days * 24 * HOUR); if (row) samples.push(row.count); }
  let support = yesterday ? `昨日同一时段 ${yesterday.count}${unit}。` : '';
  if (samples.length >= 5) {
    samples.sort((a, b) => a - b); const middle = (samples.length - 1) / 2;
    const median = (samples[Math.floor(middle)] + samples[Math.ceil(middle)]) / 2;
    support += `近7日同小时中位数 ${median}（${samples.length}天）。`;
  }
  if (support && Array.from(candidate.facts[0].text + support).length <= 90) candidate.facts.push({ id: 'same-hour', text: support });
}
function countCandidate(id: string, topic: string, label: string, noun: string, kind: CountKind, series: Series, end: number, source: string, unit = '次'): HourlyCandidate | null {
  for (const hours of WINDOWS) {
    const current = series(end - hours * HOUR, end), reference = series(end - hours * 2 * HOUR, end - hours * HOUR);
    if (!current || !reference || Math.abs((current.end - current.start) - (reference.end - reference.start)) > 120_000
      || !countChange(kind, current.count, reference.count, hours)) continue;
    const difference = current.count - reference.count, threshold = THRESHOLDS[kind];
    const relativeScore = reference.count >= threshold.reference ? Math.abs(difference) / reference.count / .5 : Infinity;
    const score = Math.min(Math.abs(difference) / threshold.absolute, relativeScore);
    const text = `${range(current.start, current.end)} ${noun} ${current.count}${unit}，前${hours}小时 ${reference.count}${unit}。`;
    const candidate = makeCandidate(id, kind, topic, label, current, text, score, source, hours, current.count, difference > 0 ? 'up' : 'down');
    addSupport(candidate, series, end, hours, unit); return candidate;
  }
  // Equal-elapsed-day comparisons are scheduled checkpoints, not a search for the largest change.
  const local = new Date(end + 7 * HOUR), hour = local.getUTCHours();
  if ([9, 15, 21].includes(hour)) {
    const start = end - hour * HOUR, current = series(start, end), reference = series(start - 24 * HOUR, end - 24 * HOUR);
    if (current && reference && countChange(kind, current.count, reference.count, 24)) {
      const candidate = makeCandidate(`${id}-today`, kind, topic, label, current, `今日00:00–${String(hour).padStart(2, '0')}:00 ${noun} ${current.count}${unit}，昨日同期 ${reference.count}${unit}。`,
        Math.abs(current.count - reference.count) / THRESHOLDS[kind].absolute, source, 24, current.count, current.count > reference.count ? 'up' : 'down');
      candidate.definitionVersion += ':equal-elapsed-day'; return candidate;
    }
  }
  return null;
}

export function observationCandidates(source: HourlySourceInput): HourlyCandidate[] {
  const until = Date.parse(source.observedUntil);
  if (!Number.isFinite(until) || until % HOUR !== 0 || until > Date.parse(source.sampledAt) || source.metricVersion !== HOURLY_STATS_METRIC_VERSION) throw new Error('INVALID_OBSERVATION_SOURCE');
  const candidates: HourlyCandidate[] = [];
  const add = (candidate: HourlyCandidate | null) => {
    if (!candidate || !plain(candidate.facts[0].text, 90)) return;
    const prior = source.recentObservations.filter(row => row.topic === candidate.topic).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))[0];
    if (candidate.kind === 'outcome' || candidate.kind === 'production-release' || trendEligible(candidate, prior, source.sampledAt)) candidates.push(candidate);
  };
  // A capture a few seconds after an hour is not data before that boundary. Use the newest completed real sampling interval.
  const atBoundary = source.snapshots.find(row => Date.parse(row.hour) === until && Date.parse(row.sampledAt) <= until);
  const statsEnd = source.businessFirstRecordedAt !== undefined || atBoundary ? until : until - HOUR;
  const statsSource = source.businessFirstRecordedAt !== undefined ? 'public-six-records' : 'public-six-snapshot';
  const metrics = [
    ['lostRegistered', 'waybill-lost', 'waybill-registration', '单号登记', '找包裹单号新增登记', '条'],
    ['receivedRegistered', 'waybill-received', 'waybill-registration', '单号登记', '找失主单号新增登记', '条'],
    ['lostRecipientRegistered', 'recipient-lost', 'recipient-registration', '姓名登记', '找包裹姓名新增登记', '条'],
    ['receivedRecipientRegistered', 'recipient-received', 'recipient-registration', '姓名登记', '找失主姓名新增登记', '条'],
  ] as const;
  for (const [metric, id, topic, label, noun, unit] of metrics) {
    if (!Number.isFinite(statsEnd)) break;
    const candidate = countCandidate(id, topic, label, noun, 'registration', statsSeries(source, metric), statsEnd, statsSource, unit);
    add(candidate);
  }
  for (const [leftMetric, rightMetric, id, topic, label, noun] of [
    ['lostRegistered', 'receivedRegistered', 'waybill-sides', 'waybill-registration', '单号登记', '单号登记'],
    ['lostRecipientRegistered', 'receivedRecipientRegistered', 'recipient-sides', 'recipient-registration', '姓名登记', '姓名登记'],
  ] as const) {
    for (const hours of WINDOWS) {
      const left = statsSeries(source, leftMetric)(statsEnd - hours * HOUR, statsEnd), right = statsSeries(source, rightMetric)(statsEnd - hours * HOUR, statsEnd);
      if (!left || !right || !sideChange(left.count, right.count)) continue;
      add(makeCandidate(id, 'side-difference', topic, label, left, `${range(left.start, left.end)}${noun}：找包裹 ${left.count}条，找失主 ${right.count}条。`,
        Math.abs(left.count - right.count) / 5, statsSource, hours, Math.abs(left.count - right.count), left.count > right.count ? 'up' : 'down')); break;
    }
  }
  for (const lookup of ['waybill', 'recipient'] as const) {
    const label = lookup === 'waybill' ? '单号查询' : '姓名查询', topic = `query-${lookup}`, series = querySeries(source, lookup);
    add(countCandidate(`query-${lookup}`, topic, label, label, 'operation', series, until, 'server-query-log'));
    for (const result of ['not_found', lookup === 'waybill' ? 'matched' : 'leads_found']) {
      for (const hours of WINDOWS) {
        const start = until - hours * HOUR, referenceStart = start - hours * HOUR, a = querySeries(source, lookup, result)(start, until), total = series(start, until);
        const b = querySeries(source, lookup, result)(referenceStart, start), priorTotal = series(referenceStart, start);
        if (!a || !b || !total || !priorTotal) continue;
        const share = resultShare(a.count, total.count, b.count, priorTotal.count); if (!share) continue;
        const name = result === 'not_found' ? '未查到' : lookup === 'waybill' ? '完整单号匹配' : '同名线索';
        const text = `${range(start, until)}${label}返回${name} ${a.count}/${total.count}次（${share.current.toFixed(1)}%），前${hours}小时 ${b.count}/${priorTotal.count}次（${share.previous.toFixed(1)}%）。`;
        add(makeCandidate(`share-${lookup}-${result.replaceAll('_', '-')}`, 'result-share', topic, label, { start, end: until, count: a.count }, text,
          Math.abs(share.current - share.previous) / 10, 'server-query-log', hours, Math.round(share.current * 100), share.current > share.previous ? 'up' : 'down')); break;
      }
    }
  }
  const operations = [
    ['pdd_scanner_not_found', 'scanner-not-found', 'scanner', '扫码', '收到扫码未读出事件'],
    ['pdd_scanner_decoded', 'scanner-decoded', 'scanner', '扫码', '收到扫码读出事件'],
    ['pdd_scanner_permission_error', 'scanner-permission', 'scanner', '扫码', '收到相机权限错误事件'],
    ['pdd_query_invalid', 'waybill-validation', 'waybill-form', '单号输入', '收到单号输入校验事件'],
    ['pdd_recipient_query_invalid', 'recipient-validation', 'recipient-form', '姓名输入', '收到姓名输入校验事件'],
    ['pdd_registration_duplicate', 'waybill-duplicate', 'waybill-form', '单号登记', '收到单号重复登记事件'],
    ['pdd_recipient_registration_duplicate', 'recipient-duplicate', 'recipient-form', '姓名登记', '收到姓名重复登记事件'],
    ['pdd_registration_error', 'waybill-registration-error', 'waybill-form', '登记操作', '收到单号登记错误事件'],
    ['pdd_recipient_registration_error', 'recipient-registration-error', 'recipient-form', '登记操作', '收到姓名登记错误事件'],
  ] as const;
  for (const [event, id, topic, label, noun] of operations) if ((TELEMETRY_EVENTS as readonly string[]).includes(event))
    add(countCandidate(id, topic, label, noun, 'operation', eventSeries(source, event), until, 'browser-received-events'));
  add(countCandidate('page-views', 'page-views', '网站浏览', '收到页面浏览事件', 'traffic', eventSeries(source, 'pdd_page_view'), until, 'browser-received-events'));

  // Retained UTC-day events are compared as whole days, never spread into invented hours.
  if (source.legacyDailyTraffic && !source.legacyDailyTraffic.truncated) {
    const end = Math.floor(until / (24 * HOUR)) * 24 * HOUR;
    const day = (at: number) => iso(at).slice(0, 10);
    const currentDay = day(end - 24 * HOUR), previousDay = day(end - 48 * HOUR);
    const daily = (date: string): number | null => {
      const budget = source.telemetry.budget.find(row => row.day === date);
      const rows = source.legacyDailyTraffic!.events.filter(row => row.day === date);
      if (!budget || budget.limitedAt !== null || !integer(budget.acceptedEvents) || budget.acceptedEvents >= budget.dailyLimit
        || rows.length !== 1 || !integer(rows[0].count) || rows[0].count > budget.acceptedEvents) return null;
      return rows[0].count;
    };
    const current = daily(currentDay), previous = daily(previousDay);
    if (current !== null && previous !== null && countChange('traffic', current, previous, 24)) {
      const candidate = makeCandidate('daily-page-views', 'traffic', 'daily-page-views', '网站浏览',
        { start: end - 24 * HOUR, end, count: current },
        `${range(end - 24 * HOUR, end)}收到页面浏览事件 ${current}次，前24小时 ${previous}次。`,
        Math.abs(current - previous) / 20, 'browser-utc-daily-events', 24, current, current > previous ? 'up' : 'down');
      candidate.definitionVersion = 'server-utc-daily-v1'; add(candidate);
    }
  }

  if (source.outcomesAvailable && source.publishedFactKeys.every(key => FACT_KEY.test(key))) {
    const published = new Set(source.publishedFactKeys);
    for (const [kind, id, label, noun, unit] of [
      ['parcel-match', 'parcel-match', '单号匹配', '新增单号匹配', '件'],
      ['recipient-match', 'recipient-match', '姓名匹配', '新增匹配姓名线索', '条'],
      ['handover', 'handover', '实际交还', '新增正式交还记录', '件'],
    ] as const) {
      const all = source.outcomes.filter(row => row.kind === kind && FACT_KEY.test(row.key) && !published.has(row.key));
      for (const hours of WINDOWS) {
        const start = until - hours * HOUR;
        const facts = [...new Map(all.filter(row => inRange(row.at, start, until)).map(row => [row.key, row])).values()];
        if (!facts.length) continue;
        const alreadyInWindow = source.outcomes.some(row => row.kind === kind && inRange(row.at, start, until) && published.has(row.key));
        // Regroup remaining facts into their real event span; never call a filtered subset the window total.
        const actualStart = alreadyInWindow ? Math.min(...facts.map(row => Date.parse(row.at))) : start;
        const text = `${range(actualStart, until)}${alreadyInWindow ? '另有' : ''}${noun} ${facts.length}${unit}。`;
        const candidate = makeCandidate(id, 'outcome', id, label, { start: actualStart, end: until, count: facts.length }, text, facts.length, 'formal-outcomes', hours, facts.length, 'up');
        candidate.priority = 0; candidate.stableFactKeys = facts.map(row => row.key); add(candidate); break;
      }
    }
    const releases = source.verifiedReleases.filter(row => FACT_KEY.test(row.key) && !published.has(row.key) && inRange(row.at, until - 24 * HOUR, until));
    for (let index = 0; index < releases.length; index++) {
      const release = releases[index];
      if (!plain(release.text, 90) || !plain(release.category, 24)) continue;
      const candidate = makeCandidate(`release-${index}`, 'production-release', 'production-release', release.category,
        { start: Date.parse(release.at), end: until, count: 1 }, release.text, 1, 'accepted-production-release', 24, 1, 'up');
      candidate.priority = 1; candidate.stableFactKeys = [release.key]; candidate.dedupKey = `release:${release.at}:${index}`; add(candidate);
    }
  }
  return candidates.sort((a, b) => a.priority - b.priority || b.score - a.score || a.id.localeCompare(b.id)).slice(0, 32);
}

export function observationModelInput(source: HourlySourceInput, candidates: HourlyCandidate[], runId?: string): HourlyModelInput {
  return { ...(runId ? { runId } : {}), observedUntil: source.observedUntil, timezone: 'Asia/Bangkok', selectionLimit: 3,
    candidates: candidates.map(c => ({ id: c.id, kind: c.kind, topic: c.topic, score: c.score, priority: c.priority, windowStart: c.windowStart, windowEnd: c.windowEnd,
      dedupKey: c.dedupKey, headlines: c.headlines.map(h => ({ id: h.id, text: h.text })), facts: c.facts.map(f => ({ id: f.id, text: f.text })) })),
    recentObservations: source.recentObservations.slice(0, 24).map(o => ({ candidateId: o.candidateId, topic: o.topic, publishedAt: o.publishedAt })) };
}
function keys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
/** Whole-batch validation before the transactional DB check; model-authored text is never accepted. */
export function validateObservationSelection(candidates: HourlyCandidate[], value: unknown, publishedFactKeys: string[], observedUntil: string): HourlySelection {
  if (!keys(value, ['observations']) || !Array.isArray(value.observations) || value.observations.length > 3) throw new Error('INVALID_SELECTION');
  const used = new Set<string>(), topics = new Set<string>(), stable = new Set(publishedFactKeys);
  for (const choice of value.observations) {
    if (!keys(choice, ['candidateId', 'headlineId', 'factIds']) || typeof choice.candidateId !== 'string' || !ID.test(choice.candidateId)
      || typeof choice.headlineId !== 'string' || !ID.test(choice.headlineId) || !Array.isArray(choice.factIds) || choice.factIds.length < 1 || choice.factIds.length > 2
      || new Set(choice.factIds).size !== choice.factIds.length || choice.factIds.some(id => typeof id !== 'string' || !ID.test(id))) throw new Error('INVALID_SELECTION');
    const candidate = candidates.find(c => c.id === choice.candidateId);
    if (!candidate || used.has(candidate.id) || topics.has(candidate.topic) || !candidate.headlines.some(h => h.id === choice.headlineId)
      || choice.factIds[0] !== candidate.facts[0]?.id) throw new Error('INVALID_SELECTION');
    const facts = choice.factIds.map(id => candidate.facts.find(f => f.id === id));
    if (facts.some(f => !f) || !plain(facts.map(f => f!.text).join(''), 90)) throw new Error('INVALID_SELECTION');
    const start = Date.parse(candidate.windowStart), end = Date.parse(candidate.windowEnd);
    if (![start, end].every(Number.isFinite) || start >= end || end > Date.parse(observedUntil)) throw new Error('INVALID_SELECTION');
    if ((candidate.kind === 'outcome' || candidate.kind === 'production-release') && !candidate.stableFactKeys?.length) throw new Error('INVALID_SELECTION');
    for (const key of candidate.stableFactKeys ?? []) { if (!FACT_KEY.test(key) || stable.has(key)) throw new Error('INVALID_SELECTION'); stable.add(key); }
    used.add(candidate.id); topics.add(candidate.topic);
  }
  return value as unknown as HourlySelection;
}
