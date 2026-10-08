import { PUBLIC_STATS_METRIC_VERSION, type PddStatsSnapshot } from './public-content';
import type { PddHomeStats } from './waybill';

export function bangkokDay(time = Date.now()): string {
  return new Date(time + 7 * 3600_000).toISOString().slice(0, 10);
}
export function offsetDay(day: string, offset: number): string {
  return new Date(Date.parse(day + 'T00:00:00Z') + offset * 86400_000).toISOString().slice(0, 10);
}
export type HistoryDay = { day: string; snapshot: PddStatsSnapshot | null };
/** Missing dates remain missing, including days on either side of an observed sample. */
export function historyWindow(snapshots: PddStatsSnapshot[], days: 7 | 30, endDay: string): HistoryDay[] {
  const byDay = new Map(snapshots.filter(row => row.metricVersion === PUBLIC_STATS_METRIC_VERSION).map(row => [row.day, row]));
  return Array.from({ length: days }, (_, index) => {
    const day = offsetDay(endDay, index - days + 1);
    return { day, snapshot: byDay.get(day) ?? null };
  });
}
/** A daily change requires adjacent dates and an unchanged metric definition. */
export function dailyChange(current: PddStatsSnapshot, previous: PddStatsSnapshot | null, key: keyof PddHomeStats): number | null {
  if (!previous || previous.metricVersion !== current.metricVersion || previous.day !== offsetDay(current.day, -1)) return null;
  // A decreasing lifetime counter cannot be interpreted as ordinary daily activity.
  const change = current.stats[key] - previous.stats[key];
  return change >= 0 ? change : null;
}
