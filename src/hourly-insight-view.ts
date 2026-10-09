import type { HourSnapshot, HourlyDashboard, PublicObservation } from '../shared/hourly-content';
import { HOURLY_STATS_KEYS } from '../shared/hourly-content';
import { bangkokDay } from '../shared/insight-history';
import type { PddHomeStats } from '../shared/waybill';

export const HOUR = 3_600_000;
export type HourRow = {
  start: string; end: string; status: 'complete' | 'current' | 'missing';
  counts: Record<keyof PddHomeStats, number | null>; sampledFrom: string | null; sampledUntil: string | null;
};
const emptyCounts = () => Object.fromEntries(HOURLY_STATS_KEYS.map(key => [key, null])) as HourRow['counts'];

/** Adjacent actual captures only: missing slots and decreasing lifetime counts stay blank. */
function increase(previous: HourSnapshot | undefined, next: { sampledAt: string; metricVersion: string; stats: PddHomeStats } | undefined): HourRow['counts'] | null {
  if (!previous || !next || previous.metricVersion !== next.metricVersion || Date.parse(next.sampledAt) < Date.parse(previous.sampledAt)) return null;
  const result = emptyCounts();
  for (const key of HOURLY_STATS_KEYS) {
    const value = next.stats[key] - previous.stats[key];
    if (!Number.isSafeInteger(value) || value < 0) return null;
    result[key] = value;
  }
  return result;
}

/** Default is the latest 24 hour slots, including the labelled in-progress slot. */
export function hourRows(dashboard: HourlyDashboard, date = ''): HourRow[] {
  const sampled = Date.parse(dashboard.sampledAt), currentHour = Math.floor(sampled / HOUR) * HOUR;
  const start = date ? Date.parse(date + 'T00:00:00+07:00') : currentHour - 23 * HOUR;
  const end = date ? Math.min(start + 24 * HOUR, currentHour + HOUR) : currentHour + HOUR;
  const byHour = new Map(dashboard.snapshots.map(snapshot => [Date.parse(snapshot.hour), snapshot]));
  const rows: HourRow[] = [];
  for (let hour = start; hour < end; hour += HOUR) {
    const previous = byHour.get(hour), current = hour === currentHour;
    const next = current ? { sampledAt: dashboard.sampledAt, metricVersion: dashboard.metricVersion, stats: dashboard.stats } : byHour.get(hour + HOUR);
    const counts = increase(previous, next);
    rows.push({ start: new Date(hour).toISOString(), end: new Date(hour + HOUR).toISOString(),
      status: current ? 'current' : counts ? 'complete' : 'missing', counts: counts ?? emptyCounts(),
      sampledFrom: previous?.sampledAt ?? null, sampledUntil: next?.sampledAt ?? null });
  }
  return rows;
}

export function observationGroups(items: PublicObservation[]): { latest: PublicObservation[]; older: Array<{ date: string; items: PublicObservation[] }> } {
  if (!items.length) return { latest: [], older: [] };
  const first = items[0].publishedAt, latest = items.filter(item => item.publishedAt === first), days = new Map<string, PublicObservation[]>();
  for (const item of items) {
    if (item.publishedAt === first) continue;
    const day = bangkokDay(Date.parse(item.publishedAt));
    days.set(day, [...(days.get(day) ?? []), item]);
  }
  return { latest, older: [...days].map(([date, rows]) => ({ date, items: rows })) };
}

/** Newer polls update by ID while retaining pages already opened in this visit. */
export function mergeObservations(newest: PublicObservation[], existing: PublicObservation[]): PublicObservation[] {
  const items = new Map(existing.map(item => [item.id, item]));
  for (const item of newest) items.set(item.id, item);
  return [...items.values()].sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt) || right.id.localeCompare(left.id));
}

export type ObservationPage = { observations: PublicObservation[]; nextBefore: string | null };
type FeedGap = { id: string; cursor: string; boundaryIds: string[] };
export type ObservationPagination = { items: PublicObservation[]; tail: string | null; gaps: FeedGap[]; head: string; initialized: boolean };
export type ObservationRequest = { cursor: string; gapId: string | null };
export const emptyObservationPagination = (): ObservationPagination => ({ items: [], tail: null, gaps: [], head: '', initialized: false });

/** Polls retain the oldest loaded cursor. A disjoint head gets its own missing interval. */
export function updateObservationHead(previous: ObservationPagination, page: ObservationPage): ObservationPagination {
  const head = page.observations.map(item => item.id).join('/');
  const items = mergeObservations(page.observations, previous.items);
  if (!previous.initialized || !previous.items.length) return { items, tail: page.nextBefore, gaps: [], head, initialized: true };
  if (head === previous.head) return { ...previous, items };
  const known = new Set(previous.items.map(item => item.id));
  const overlaps = page.observations.some(item => known.has(item.id));
  const gaps = !overlaps && page.observations.length && page.nextBefore
    ? [{ id: head, cursor: page.nextBefore, boundaryIds: [...known] }, ...previous.gaps]
    : previous.gaps;
  return { ...previous, items, gaps, head };
}

export function nextObservationRequest(state: ObservationPagination): ObservationRequest | null {
  const gap = state.gaps[0];
  return gap ? { cursor: gap.cursor, gapId: gap.id } : state.tail ? { cursor: state.tail, gapId: null } : null;
}

/** A response advances its original interval even when another head arrives in flight. */
export function appendObservationPage(previous: ObservationPagination, request: ObservationRequest, page: ObservationPage): ObservationPagination {
  const items = mergeObservations(page.observations, previous.items);
  if (request.gapId === null) return { ...previous, items, tail: previous.tail === request.cursor ? page.nextBefore : previous.tail };
  const gaps = previous.gaps.flatMap(gap => {
    if (gap.id !== request.gapId || gap.cursor !== request.cursor) return [gap];
    const boundary = new Set(gap.boundaryIds);
    const bridged = page.observations.some(item => boundary.has(item.id));
    return bridged || !page.nextBefore ? [] : [{ ...gap, cursor: page.nextBefore }];
  });
  return { ...previous, items, gaps };
}
