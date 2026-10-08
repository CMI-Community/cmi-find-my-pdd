import { describe, it, expect } from 'vitest';
import { bangkokDay, historyWindow, dailyChange } from '../shared/insight-history';
import { PUBLIC_STATS_METRIC_VERSION, type PddStatsSnapshot } from '../shared/public-content';

const sample = (day: string, value: number): PddStatsSnapshot => ({ day, sampledAt: day + 'T13:00:00Z', metricVersion: PUBLIC_STATS_METRIC_VERSION,
  stats: { lostRegistered: value, receivedRegistered: 0, matchedParcels: 0, lostRecipientRegistered: 0, receivedRecipientRegistered: 0, matchedRecipientLeads: 0 } });
describe('public history comparability', () => {
  it('uses Bangkok dates across UTC midnight and month boundaries', () => {
    expect(bangkokDay(Date.parse('2026-09-30T16:59:59Z'))).toBe('2026-09-30');
    expect(bangkokDay(Date.parse('2026-09-30T17:00:00Z'))).toBe('2026-10-01');
  });
  it('preserves missed days and does not interpolate or fill them with zero', () => {
    const rows = historyWindow([sample('2026-10-03', 3), sample('2026-10-06', 7)], 7, '2026-10-08');
    expect(rows.map(row => row.day)).toEqual(['2026-10-02','2026-10-03','2026-10-04','2026-10-05','2026-10-06','2026-10-07','2026-10-08']);
    expect(rows.filter(row => row.snapshot)).toHaveLength(2);
    expect(rows[2].snapshot).toBeNull();
    expect(rows.at(-1)?.snapshot).toBeNull();
  });
  it('compares only adjacent dates, without assuming missed days represent no activity', () => {
    expect(dailyChange(sample('2026-10-08', 15), sample('2026-10-07', 12), 'lostRegistered')).toBe(3);
    expect(dailyChange(sample('2026-10-08', 15), sample('2026-10-06', 12), 'lostRegistered')).toBeNull();
    expect(dailyChange(sample('2026-10-08', 15), null, 'lostRegistered')).toBeNull();
    expect(dailyChange(sample('2026-10-08', 15), sample('2026-10-07', 15), 'lostRegistered')).toBe(0);
    expect(dailyChange(sample('2026-10-08', 12), sample('2026-10-07', 15), 'lostRegistered')).toBeNull();
  });
});
