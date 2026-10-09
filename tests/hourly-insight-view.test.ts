import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HOURLY_STATS_METRIC_VERSION, type HourlyDashboard, type HourSnapshot, type PublicObservation } from '../shared/hourly-content';
import { appendObservationPage, emptyObservationPagination, hourRows, mergeObservations, nextObservationRequest, observationGroups, updateObservationHead } from '../src/hourly-insight-view';
import { CurrentStatistics, HourTable, ObservationList } from '../src/PddPublicPages';
const stats = (value: number) => ({ lostRegistered: value, receivedRegistered: value, matchedParcels: value, lostRecipientRegistered: value, receivedRecipientRegistered: value, matchedRecipientLeads: value });
const snapshot = (hour: string, count: number): HourSnapshot => ({ hour, sampledAt: hour.replace(':00:00Z', ':00:10Z'), metricVersion: HOURLY_STATS_METRIC_VERSION, stats: stats(count) });
function dashboard(snapshots: HourSnapshot[]): HourlyDashboard {
  return { sampledAt: '2026-10-09T03:30:00Z', metricVersion: HOURLY_STATS_METRIC_VERSION, stats: stats(120), snapshots, observations: [], nextBefore: null };
}
const observation = (id: string, publishedAt: string, text = '找包裹的单号新增14条，前一小时6条。'): PublicObservation => ({ id, publishedAt, text, category: '单号登记', windowStart: '2026-10-09T01:00:00Z', windowEnd: '2026-10-09T02:00:00Z' });

describe('hourly data view preserves actual samples and gaps', () => {
  it('shows adjacent increases and separately labels the current partial hour', () => {
    const rows = hourRows(dashboard([snapshot('2026-10-09T01:00:00Z', 100), snapshot('2026-10-09T02:00:00Z', 108), snapshot('2026-10-09T03:00:00Z', 116)]));
    expect(rows).toHaveLength(24);
    expect(rows.slice(-3).map(row => row.counts.lostRegistered)).toEqual([8, 8, 4]);
    expect(rows.slice(-3).map(row => row.status)).toEqual(['complete', 'complete', 'current']);
    expect(rows.at(-1)?.sampledFrom).toBe('2026-10-09T03:00:10Z');
    expect(rows.at(-1)?.sampledUntil).toBe('2026-10-09T03:30:00Z');
  });
  it('never spreads a multi-hour change across missing slots or treats absence as zero', () => {
    const rows = hourRows(dashboard([snapshot('2026-10-09T01:00:00Z', 100), snapshot('2026-10-09T03:00:00Z', 116)]));
    expect(rows.slice(-3).map(row => row.counts.lostRegistered)).toEqual([null, null, 4]);
    expect(rows.slice(-3).map(row => row.status)).toEqual(['missing', 'missing', 'current']);
    const html = renderToStaticMarkup(createElement(HourTable, { rows: rows.slice(-3), mode: 'waybill' }));
    expect(html.match(/aria-label="没有可用采样"/g)).toHaveLength(12);
    expect(html).toContain('进行中'); expect(html).not.toContain('>16<');
  });
  it('rejects decreasing cumulative samples for that interval and retains real zeros', () => {
    const first = snapshot('2026-10-09T02:00:00Z', 100), second = snapshot('2026-10-09T03:00:00Z', 100);
    const fresh = dashboard([first, second]); fresh.sampledAt = second.sampledAt; fresh.stats = stats(100);
    expect(hourRows(fresh).at(-1)?.counts.lostRegistered).toBe(0);
    second.stats.matchedParcels = 99;
    expect(Object.values(hourRows(dashboard([first, second])).at(-2)!.counts).every(value => value === null)).toBe(true);
  });
  it('returns the selected Bangkok day in this page without future hours', () => {
    const day = hourRows(dashboard([]), '2026-10-08');
    expect(day).toHaveLength(24); expect(day[0].start).toBe('2026-10-07T17:00:00.000Z'); expect(day.at(-1)?.end).toBe('2026-10-08T17:00:00.000Z');
    const today = hourRows(dashboard([]), '2026-10-09');
    expect(today).toHaveLength(11); expect(today.at(-1)?.status).toBe('current');
  });
  it('does not invent six zero totals while combined data is unavailable', () => {
    const html = renderToStaticMarkup(createElement(CurrentStatistics, { stats: null, loading: false, error: 'synthetic failure', readAt: null, refresh() {} }));
    expect(html).toContain('暂时无法读取'); expect(html).not.toContain('<dd>');
  });
});

describe('fact stream keeps timestamps and past entries', () => {
  it('keeps the newest batch expanded and groups older publications by Bangkok date', () => {
    const items = [observation('new-a', '2026-10-09T03:05:00Z'), observation('new-b', '2026-10-09T03:05:00Z'), observation('old-a', '2026-10-08T17:05:00Z'), observation('old-b', '2026-10-08T16:05:00Z')];
    const groups = observationGroups(items);
    expect(groups.latest.map(item => item.id)).toEqual(['new-a', 'new-b']);
    expect(groups.older.map(group => group.date)).toEqual(['2026-10-09', '2026-10-08']);
    expect(observationGroups([])).toEqual({ latest: [], older: [] });
  });
  it('does not duplicate IDs when polling overlaps a previously loaded feed page', () => {
    const old = observation('same', '2026-10-08T16:05:00Z'), newest = observation('new', '2026-10-09T03:05:00Z');
    expect(mergeObservations([newest, old], [old]).map(item => item.id)).toEqual(['new', 'same']);
  });
  it('renders only the supplied factual text and server dates, safely escaping content', () => {
    const html = renderToStaticMarkup(createElement(ObservationList, { items: [observation('safe', '2026-10-09T03:05:00Z', '<img src=x>登记新增14条。')] }));
    expect(html).toContain('&lt;img'); expect(html).not.toContain('<img'); expect(html).toContain('登记新增14条。');
    expect(html).toContain('2026-10-09T03:05:00Z'); expect(html).toContain('数据窗口');
    for (const unwanted of ['可能解释', '尚不能判断', '观察限制', '建议', '每日报告']) expect(html).not.toContain(unwanted);
  });
});

describe('fact pagination preserves its tail and fills disjoint new heads', () => {
  const id = (number: number) => 'observation-' + number;
  const page = (first: number, last: number, more = true) => ({ observations: Array.from({ length: first - last + 1 }, (_, index) => observation(id(first - index), new Date(Date.parse('2026-10-09T00:00:00Z') + (first - index) * 1000).toISOString())), nextBefore: more ? id(last) : null });
  function loadedPages() {
    let state = updateObservationHead(emptyObservationPagination(), page(100, 81));
    state = appendObservationPage(state, nextObservationRequest(state)!, page(80, 61));
    return appendObservationPage(state, nextObservationRequest(state)!, page(60, 41));
  }
  it('keeps the oldest cursor after a short overlapping new head, so the next click adds older rows', () => {
    let state = updateObservationHead(loadedPages(), page(103, 84));
    expect(nextObservationRequest(state)).toEqual({ cursor: id(41), gapId: null });
    const before = state.items.length;
    state = appendObservationPage(state, nextObservationRequest(state)!, page(40, 21));
    expect(state.items).toHaveLength(before + 20); expect(state.tail).toBe(id(21));
  });
  it('fills every middle page after more than 20 new facts, bridges to known rows, then resumes the oldest cursor', () => {
    let state = updateObservationHead(loadedPages(), page(150, 131));
    expect(nextObservationRequest(state)?.cursor).toBe(id(131));
    state = appendObservationPage(state, nextObservationRequest(state)!, page(130, 111));
    expect(nextObservationRequest(state)?.cursor).toBe(id(111));
    state = appendObservationPage(state, nextObservationRequest(state)!, page(110, 91));
    expect(state.gaps).toEqual([]); expect(nextObservationRequest(state)).toEqual({ cursor: id(41), gapId: null });
    expect(state.items.map(item => item.id)).toEqual(page(150, 41).observations.map(item => item.id));
    state = appendObservationPage(state, nextObservationRequest(state)!, page(40, 21, false));
    expect(new Set(state.items.map(item => item.id)).size).toBe(130); expect(nextObservationRequest(state)).toBeNull();
  });
  it('advances an older request while a disjoint new head arrives, without losing either cursor', () => {
    let state = updateObservationHead(emptyObservationPagination(), page(100, 81));
    const pendingTail = nextObservationRequest(state)!;
    state = updateObservationHead(state, page(150, 131));
    state = appendObservationPage(state, pendingTail, page(80, 61));
    expect(state.tail).toBe(id(61)); expect(nextObservationRequest(state)?.cursor).toBe(id(131));
    state = appendObservationPage(state, nextObservationRequest(state)!, page(130, 111));
    state = appendObservationPage(state, nextObservationRequest(state)!, page(110, 91));
    expect(nextObservationRequest(state)).toEqual({ cursor: id(61), gapId: null });
    expect(state.items.map(item => item.id)).toEqual(page(150, 61).observations.map(item => item.id));
  });
  it('retains an unfinished gap when another disjoint head arrives during its request', () => {
    let state = updateObservationHead(loadedPages(), page(150, 131));
    const pendingGap = nextObservationRequest(state)!;
    state = updateObservationHead(state, page(200, 181));
    state = appendObservationPage(state, pendingGap, page(130, 111));
    expect(state.gaps.map(gap => gap.cursor)).toEqual([id(181), id(111)]);
    state = appendObservationPage(state, nextObservationRequest(state)!, page(180, 161));
    state = appendObservationPage(state, nextObservationRequest(state)!, page(160, 141));
    expect(nextObservationRequest(state)?.cursor).toBe(id(111));
    state = appendObservationPage(state, nextObservationRequest(state)!, page(110, 91));
    expect(nextObservationRequest(state)).toEqual({ cursor: id(41), gapId: null });
    expect(state.items.map(item => item.id)).toEqual(page(200, 41).observations.map(item => item.id));
  });
  it('keeps an exhausted historical tail exhausted when the next head overlaps', () => {
    let state = updateObservationHead(emptyObservationPagination(), page(20, 1, false));
    state = updateObservationHead(state, page(23, 4));
    expect(nextObservationRequest(state)).toBeNull(); expect(state.items).toHaveLength(23);
  });
});
