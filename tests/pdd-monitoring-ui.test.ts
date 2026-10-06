import { describe, expect, it } from 'vitest';
import { monitoringSeries, type AnalyticsRow } from '../src/PddMonitoring';

const row = (day: string, event: AnalyticsRow['event'], count: number, metadata: Record<string, string> = {}, page = 'home'): AnalyticsRow => ({ day, event, count, metadata, page });
describe('administrator monitoring charts', () => {
  it('combines observed page views across pages and preserves dates without inventing missing-day values', () => {
    const result = monitoringSeries([
      row('2026-10-06', 'pdd_page_view', 4), row('2026-10-06', 'pdd_page_view', 2, {}, 'help'),
      row('2026-10-04', 'pdd_page_view', 3), row('2026-10-05', 'pdd_query_started', 100),
    ]);
    expect(result.views).toEqual([{ day: '2026-10-04', count: 3 }, { day: '2026-10-06', count: 6 }]);
    expect(result.dwell).toEqual([]);
  });
  it('orders actual dwell buckets and ignores invalid or unrelated data', () => {
    const result = monitoringSeries([
      row('2026-10-06', 'pdd_visible_dwell', 3, { bucket: '3-9m' }),
      row('2026-10-05', 'pdd_visible_dwell', 2, { bucket: '10-29s' }),
      row('2026-10-06', 'pdd_visible_dwell', 1, { bucket: '3-9m' }, 'help'),
      row('2026-10-06', 'pdd_visible_dwell', 100, { bucket: 'invalid' }),
      row('2026-10-06', 'pdd_page_view', Number.NaN),
    ]);
    expect(result.dwell).toEqual([{ bucket: '10-29s', count: 2 }, { bucket: '3-9m', count: 4 }]);
    expect(result.views).toEqual([]);
    expect(monitoringSeries([])).toEqual({ views: [], dwell: [] });
  });
});
