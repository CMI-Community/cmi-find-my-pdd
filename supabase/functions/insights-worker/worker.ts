import type { HourlyRuntime, HourlySourceInput, HourlyReservation, HourlySelection, HourlyCandidate, HourlyModelInput } from '../../../shared/hourly-content.ts';
import { hourlyId } from '../../../shared/hourly-content.ts';
import { OBSERVATION_MODEL, OBSERVATION_PROMPT_VERSION, observationCandidates, observationModelInput, validateObservationSelection } from '../../../shared/hourly-observer.ts';
import { callObservationModel, observationRequestBody } from './provider.ts';

type Status = 'completed' | 'rejected' | 'unknown' | 'disabled' | 'expired' | 'limited' | 'reserved' | 'unavailable' | 'unauthorized' | 'method_not_allowed';
export type InsightsWorkerContext = { rpc: <T>(name: string, payload: Record<string, unknown>) => Promise<T>; fetcher?: typeof fetch; log?: (state: Status) => void };
const statuses: Status[] = ['reserved', 'completed', 'rejected', 'unknown', 'disabled', 'expired', 'limited'];
const response = (state: Status, status = 200, publishedCount?: number) => Response.json({ state, ...(publishedCount === undefined ? {} : { publishedCount }) }, { status, headers: { 'Cache-Control': 'no-store' } });

/** Only whole trailing candidates/history items are removed, before the durable reservation. */
export function prepareObservationWork(source: HourlySourceInput, ranked: HourlyCandidate[]): { candidates: HourlyCandidate[]; input: HourlyModelInput } {
  const candidates = [...ranked]; let recentCount = Math.min(24, source.recentObservations.length);
  const project = () => observationModelInput({ ...source, recentObservations: source.recentObservations.slice(0, recentCount) }, candidates);
  let input = project();
  const fits = () => observationRequestBody({ ...input, runId: '00000000-0000-4000-8000-000000000000' }) !== null;
  while (!fits() && candidates.length) { candidates.pop(); input = project(); }
  while (!fits() && recentCount) { recentCount--; input = project(); }
  if (!fits()) throw new Error('INVALID_OBSERVATION_SOURCE');
  return { candidates, input };
}

/** Authentication precedes all aggregates. Reservation is the only authority to start one call. */
export async function insightsWorkerRoute(request: Request, context: InsightsWorkerContext): Promise<Response> {
  if (request.method !== 'POST') return response('method_not_allowed', 405);
  const secret = request.headers.get('x-insights-secret') ?? '';
  if (!/^[0-9a-f]{64}$/.test(secret)) return response('unauthorized', 401);
  const emit = (state: Status, status = 200, count?: number) => { context.log?.(state); return response(state, status, count); };
  let runtime: HourlyRuntime;
  try { runtime = await context.rpc<HourlyRuntime>('pdd_insights_runtime', { worker_secret: secret }); }
  catch (error) { return error instanceof Error && ['FORBIDDEN', 'DATABASE_ERROR_403'].includes(error.message) ? emit('unauthorized', 401) : emit('unavailable', 503); }
  if (!runtime || typeof runtime.enabled !== 'boolean') return emit('unavailable', 503);
  if (!runtime.enabled) return emit('disabled');
  if (runtime.model !== OBSERVATION_MODEL || runtime.promptVersion !== OBSERVATION_PROMPT_VERSION || runtime.dailyCallLimit !== 24
    || runtime.reservationUsd !== .01 || !runtime.modelKey || !/^sk-[A-Za-z0-9_-]{16,500}$/.test(runtime.modelKey)) return emit('unavailable', 503);
  let source: HourlySourceInput, reservation: HourlyReservation, candidates: HourlyCandidate[], modelInput: HourlyModelInput;
  try {
    source = await context.rpc<HourlySourceInput>('pdd_hourly_source', {});
    const prepared = prepareObservationWork(source, observationCandidates(source)); candidates = prepared.candidates; modelInput = prepared.input;
    reservation = await context.rpc<HourlyReservation>('pdd_insights_reserve', { input: modelInput, candidates, model: OBSERVATION_MODEL, prompt_version: OBSERVATION_PROMPT_VERSION });
    if (!reservation || typeof reservation.reserved !== 'boolean' || !statuses.includes(reservation.state)
      || Date.parse(reservation.observedUntil) !== Date.parse(source.observedUntil)) return emit('unavailable', 503);
    if (!reservation.reserved) return emit(reservation.state);
    if (reservation.state !== 'reserved' || !reservation.runId) return emit('unavailable', 503);
    hourlyId(reservation.runId);
  } catch { return emit('unavailable', 503); }
  const model = await callObservationModel(runtime.modelKey, { ...modelInput, runId: reservation.runId! }, { fetcher: context.fetcher });
  let state = model.state, selection: HourlySelection | null = state === 'unknown' ? null : { observations: [] };
  if (model.state === 'completed') {
    try { selection = validateObservationSelection(candidates, model.selection, source.publishedFactKeys, reservation.observedUntil); }
    catch { state = 'rejected'; }
  }
  try {
    const result = await context.rpc<{ state: Status; publishedCount: number }>('pdd_insights_finish', { run_id: reservation.runId, state, selection, ...(model.usage ? { usage: model.usage } : {}) });
    if (!result || !['completed', 'rejected', 'unknown'].includes(result.state) || !Number.isSafeInteger(result.publishedCount) || result.publishedCount < 0 || result.publishedCount > 3) return emit('unknown', 503);
    return emit(result.state, result.state === 'unknown' ? 503 : 200, result.publishedCount);
  } catch { return emit('unknown', 503); }
}
