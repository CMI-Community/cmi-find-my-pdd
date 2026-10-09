import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { changeRows, HOUR, rangeHours } from '../src/hourly-insight-view';
import { HourTable } from '../src/PddPublicPages';
import { HOURLY_RECORDS_METRIC_VERSION, HOURLY_STATS_METRIC_VERSION, type HourlyDashboard } from '../shared/hourly-content';
const unit = { lostRegistered: 1, receivedRegistered: 2, matchedParcels: 0, lostRecipientRegistered: 3, receivedRecipientRegistered: 1, matchedRecipientLeads: 0 };
function dashboard(until = '2026-10-09T15:33:00Z'): HourlyDashboard {
  const start = Date.parse('2026-10-06T09:00:00Z'), end = Date.parse(until);
  return { sampledAt: until, metricVersion: HOURLY_STATS_METRIC_VERSION, stats: unit, snapshots: [], observations: [], nextBefore: null,
    records: { metricVersion: HOURLY_RECORDS_METRIC_VERSION, from: new Date(start).toISOString(), until, firstRecordedAt: '2026-10-06T09:35:00Z',
      hours: Array.from({ length: Math.ceil((end - start) / HOUR) }, (_, index) => ({ hour: new Date(start + index * HOUR).toISOString(), stats: { ...unit } })) } };
}
describe('multi-day changes preserve recorded dates and complete totals', () => {
  it('shows the launch date and all retained dates by default without fabricating earlier zero dates', () => {
    const rows = changeRows(dashboard());
    expect(rows.map(row => row.start)).toEqual(['2026-10-05T17:00:00.000Z', '2026-10-06T17:00:00.000Z', '2026-10-07T17:00:00.000Z', '2026-10-08T17:00:00.000Z']);
    expect(rows.map(row => row.counts.lostRegistered)).toEqual([8, 24, 24, 23]);
    expect(rows.map(row => row.counts.lostRecipientRegistered)).toEqual([24, 72, 72, 69]);
    expect(rows[0].firstRecordedAt).toBe('2026-10-06T09:35:00Z');
    expect(rows.at(-1)).toMatchObject({ status: 'current', sampledUntil: '2026-10-09T15:33:00.000Z' });
    expect(rows.reduce((sum, row) => sum + row.counts.receivedRegistered!, 0)).toBe(158);
  });
  it('three days means three Bangkok dates including today, while 24 hours keeps hourly slots', () => {
    expect(changeRows(dashboard(), '', '3d').map(row => row.counts.lostRegistered)).toEqual([24, 24, 23]);
    expect(changeRows(dashboard(), '', '24h')).toHaveLength(24);
    expect(changeRows(dashboard(), '', '7d', 'hour')).toHaveLength(79);
    expect(rangeHours('3d')).toBe(72); expect(rangeHours('7d')).toBe(168);
  });
  it('selected past dates keep their exclusive midnight end even when the seven-day preset is active', () => {
    const rows = changeRows(dashboard(), '2026-10-07', '7d');
    expect(rows).toHaveLength(24); expect(rows.reduce((sum, row) => sum + row.counts.lostRegistered!, 0)).toBe(24);
    expect(rows.at(-1)?.sampledUntil).toBe('2026-10-07T17:00:00.000Z');
  });
  it('a precise midnight does not manufacture a today bucket', () => {
    const rows = changeRows(dashboard('2026-10-08T17:00:00Z'));
    expect(rows).toHaveLength(3); expect(rows.every(row => row.status === 'complete')).toBe(true);
    expect(rows.at(-1)?.sampledUntil).toBe('2026-10-08T17:00:00.000Z');
  });
  it('an unavailable snapshot hour makes its daily total unknown rather than summing incomplete coverage', () => {
    const input = dashboard(); delete input.records;
    input.snapshots = [0, 1, 3].map(index => ({ hour: new Date(Date.parse('2026-10-08T17:00:00Z') + index * HOUR).toISOString(), sampledAt: new Date(Date.parse('2026-10-08T17:00:00Z') + index * HOUR + 5000).toISOString(), metricVersion: HOURLY_STATS_METRIC_VERSION, stats: { ...unit, lostRegistered: index + 1 } }));
    const today = changeRows(input).at(-1)!;
    expect(today.counts.lostRegistered).toBeNull(); expect(today.counts.receivedRegistered).toBeNull();
  });
  it('empty recorded history stays empty even when legacy snapshots exist', () => {
    const input = dashboard(); input.records!.hours = []; input.records!.firstRecordedAt = null;
    expect(changeRows(input)).toEqual([]);
  });
  it('daily table names dates, retains first-record time and labels the live partial day', () => {
    const html = renderToStaticMarkup(createElement(HourTable, { rows: changeRows(dashboard()), mode: 'waybill', recorded: true, granularity: 'day' }));
    expect(html).toContain('2026/10/06'); expect(html).toContain('2026/10/07'); expect(html).toContain('2026/10/08');
    expect(html).toContain('16:35 起'); expect(html).toContain('截至 22:33'); expect(html).toContain('按日汇总');
    expect(html).not.toContain('>小时</th>');
  });
});
