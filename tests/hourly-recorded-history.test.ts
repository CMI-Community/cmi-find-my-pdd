import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HOURLY_RECORDS_METRIC_VERSION, HOURLY_STATS_METRIC_VERSION, hourlyDashboard, type HourlyRecordedAdditions } from '../shared/hourly-content';
import { hourRows } from '../src/hourly-insight-view';
import { HourTable } from '../src/PddPublicPages';
const six = (value: number) => ({ lostRegistered: value, receivedRegistered: value, matchedParcels: value, lostRecipientRegistered: value, receivedRecipientRegistered: value, matchedRecipientLeads: value });
const until = '2026-10-09T03:30:00Z';
function records(): HourlyRecordedAdditions {
  return { metricVersion: HOURLY_RECORDS_METRIC_VERSION, from: '2026-10-09T01:00:00Z', until,
    firstRecordedAt: '2026-10-09T01:35:29Z', hours: [
      { hour: '2026-10-09T01:00:00Z', stats: six(5) },
      { hour: '2026-10-09T02:00:00Z', stats: six(0) },
      { hour: '2026-10-09T03:00:00Z', stats: six(2) },
    ] };
}
function raw(recorded: unknown = records(), sampledAt = until) {
  return { metricVersion: HOURLY_STATS_METRIC_VERSION, sampledAt, stats: six(500), snapshots: [
    { hour: '2026-10-09T01:00:00Z', sampledAt: '2026-10-09T01:00:10Z', metricVersion: HOURLY_STATS_METRIC_VERSION, stats: six(100) },
    { hour: '2026-10-09T02:00:00Z', sampledAt: '2026-10-09T02:00:10Z', metricVersion: HOURLY_STATS_METRIC_VERSION, stats: six(400) },
  ], observations: [], nextBefore: null, records: recorded };
}

describe('public recorded-additions contract', () => {
  it('projects fixed versions, six units and timestamps without private or unknown fields', () => {
    const input = records();
    const parsed = hourlyDashboard({ ...raw({ ...input, contact: 'private', hours: input.hours.map(item => ({ ...item, rawRows: ['private'], stats: { ...item.stats, recipientName: 'private' } })) }), actor: 'private' });
    expect(parsed.records).toEqual(input); expect(JSON.stringify(parsed)).not.toContain('private');
  });
  it('keeps legacy snapshots compatible when records is omitted, but never silently ignores malformed records', () => {
    const legacy = raw(); delete (legacy as Partial<typeof legacy>).records;
    expect(hourlyDashboard(legacy).records).toBeUndefined();
    for (const invalid of [null, {}, { ...records(), metricVersion: HOURLY_STATS_METRIC_VERSION }]) expect(() => hourlyDashboard(raw(invalid))).toThrow('INVALID_HOURLY_CONTENT');
  });
  it('rejects invalid time provenance, non-hour start, negative/fractional units and future buckets', () => {
    const valid = records();
    for (const invalid of [
      { ...valid, from: '2026-10-09T01:01:00Z' },
      { ...valid, from: '2026-02-30T01:00:00Z' },
      { ...valid, until: '2026-10-09T03:31:00Z' },
      { ...valid, firstRecordedAt: '2026-10-09T03:31:00Z' },
      { ...valid, firstRecordedAt: null },
      { ...valid, hours: [{ ...valid.hours[0], stats: six(-1) }] },
      { ...valid, hours: [{ ...valid.hours[0], stats: six(0.5) }] },
      { ...valid, hours: [...valid.hours, { hour: '2026-10-09T04:00:00Z', stats: six(0) }] },
    ]) expect(() => hourlyDashboard(raw(invalid))).toThrow('INVALID_HOURLY_CONTENT');
  });
  it('rejects duplicate, out-of-order or omitted interior zero buckets instead of making unknown gaps look complete', () => {
    const valid = records();
    for (const hours of [[valid.hours[0], valid.hours[0]], [valid.hours[1], valid.hours[0]], [valid.hours[0], valid.hours[2]], [valid.hours[1]]])
      expect(() => hourlyDashboard(raw({ ...valid, hours }))).toThrow('INVALID_HOURLY_CONTENT');
  });
  it('accepts the bounded 721 slots, and rejects larger arrays or ranges', () => {
    const sampledAt = '2026-10-09T03:30:00Z', end = Date.parse(sampledAt), start = Math.floor(end / 3_600_000) * 3_600_000 - 720 * 3_600_000;
    const bounded = { metricVersion: HOURLY_RECORDS_METRIC_VERSION, from: new Date(start).toISOString(), until: sampledAt, firstRecordedAt: new Date(start + 1).toISOString(), hours: Array.from({ length: 721 }, (_, index) => ({ hour: new Date(start + index * 3_600_000).toISOString(), stats: six(0) })) };
    expect(hourlyDashboard(raw(bounded)).records?.hours).toHaveLength(721);
    expect(() => hourlyDashboard(raw({ ...bounded, hours: [...bounded.hours, bounded.hours.at(-1)] }))).toThrow();
    expect(() => hourlyDashboard(raw({ ...bounded, from: new Date(start - 3_600_000).toISOString() }))).toThrow();
  });
});

describe('recorded history never mixes source types', () => {
  it('uses bucket additions directly despite large cumulative snapshot differences, including genuine zero', () => {
    const view = hourRows(hourlyDashboard(raw()));
    expect(view.map(row => row.counts.lostRegistered)).toEqual([5, 0, 2]);
    expect(view.map(row => row.status)).toEqual(['complete', 'complete', 'current']);
    expect(view.every(row => row.source === 'recorded')).toBe(true);
    expect(view[0].sampledFrom).toBe('2026-10-09T01:00:00Z');
    expect(view[0].firstRecordedAt).toBe('2026-10-09T01:35:29Z');
    expect(view.at(-1)?.sampledUntil).toBe('2026-10-09T03:30:00.000Z');
    const html = renderToStaticMarkup(createElement(HourTable, { rows: view, mode: 'waybill', recorded: true }));
    expect(html).toContain('按登记与匹配记入时间 · 曼谷时间'); expect(html).toContain('最早记录时间：');
    expect(html).not.toContain('实际采样'); expect(html).not.toContain('没有可用采样'); expect(html).toContain('>0</td>');
  });
  it('returns no rows for empty recorded history instead of falling back to existing snapshots', () => {
    const empty = { ...records(), firstRecordedAt: null, hours: [] };
    expect(hourRows(hourlyDashboard(raw(empty)))).toEqual([]);
  });
  it('limits a selected Bangkok date to its exclusive end while keeping real read-time provenance', () => {
    const start = Date.parse('2026-10-08T00:00:00+07:00');
    const previousDay = { ...records(), from: new Date(start).toISOString(), firstRecordedAt: new Date(start + 1000).toISOString(), hours: Array.from({ length: 24 }, (_, index) => ({ hour: new Date(start + index * 3_600_000).toISOString(), stats: six(index === 0 ? 3 : 0) })) };
    const view = hourRows(hourlyDashboard(raw(previousDay)), '2026-10-08');
    expect(view).toHaveLength(24); expect(view[0].start).toBe('2026-10-07T17:00:00.000Z');
    expect(view.at(-1)?.sampledUntil).toBe('2026-10-08T17:00:00.000Z'); expect(view.every(row => row.status === 'complete')).toBe(true);
  });
  it('shows 24 completed hours at a precise boundary without inventing an empty current hour', () => {
    const sampledAt = '2026-10-08T17:00:00Z', end = Date.parse(sampledAt), start = end - 24 * 3_600_000;
    const complete = { ...records(), from: new Date(start).toISOString(), until: sampledAt, firstRecordedAt: new Date(start + 1000).toISOString(), hours: Array.from({ length: 24 }, (_, index) => ({ hour: new Date(start + index * 3_600_000).toISOString(), stats: six(1) })) };
    const dto = { ...raw(complete, sampledAt), snapshots: [] };
    expect(hourRows(hourlyDashboard(dto))).toHaveLength(24); expect(hourRows(hourlyDashboard(dto)).every(row => row.status === 'complete')).toBe(true);
    expect(hourRows(hourlyDashboard(dto), '2026-10-09')).toEqual([]);
    expect(() => hourlyDashboard({ ...dto, records: { ...complete, hours: [...complete.hours, { hour: sampledAt, stats: six(0) }] } })).toThrow();
  });
});
