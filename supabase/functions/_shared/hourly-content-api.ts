import { hourlyDashboard, hourlyFeed, hourlyHistory, hourlyId, HOURLY_HISTORY_DEFAULT_HOURS, HOURLY_HISTORY_MAX_HOURS, type HourlyReadParameters } from '../../../shared/hourly-content.ts';
import { publicContentDate } from '../../../shared/public-content.ts';
import { ApiError, json } from './http.ts';

type Row = Record<string, any>;
export interface HourlyContentContext { rpc: (name: string, payload: Row) => Promise<Row>; now?: () => number }
function invalid(): never { throw new ApiError('INVALID_REQUEST', '小时数据参数有误。', 422); }
function unavailable(): never { throw new ApiError('SERVICE_UNAVAILABLE', '小时数据暂时无法读取。', 503, true); }
export function hourlyReadParameters(request: Request, endpoint: string, now = Date.now()): HourlyReadParameters {
  const params = new URL(request.url).searchParams, allowed = endpoint === 'feed' ? ['before'] : endpoint === 'hourly' ? ['hours', 'date'] : ['hours', 'date', 'before'];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid();
  if (params.has('hours') && params.has('date')) invalid();
  const result: HourlyReadParameters = {};
  if (endpoint !== 'feed') {
    if (params.has('date')) {
      try { result.date = publicContentDate(params.get('date')); } catch { return invalid(); }
      const today = new Date(now + 7 * 3600000).toISOString().slice(0, 10);
      const distance = (Date.parse(today) - Date.parse(result.date)) / 86400000;
      if (distance < 0 || distance > 29) invalid();
    } else {
      const hours = params.get('hours') ?? String(HOURLY_HISTORY_DEFAULT_HOURS);
      if (!/^[0-9]{1,3}$/.test(hours) || Number(hours) < 1 || Number(hours) > HOURLY_HISTORY_MAX_HOURS) invalid();
      result.hours = Number(hours);
    }
  }
  if (params.has('before')) { try { result.before = hourlyId(params.get('before')); } catch { return invalid(); } }
  return result;
}
/** Bounded, process-local cache of safe public DTOs. Failed loads are never cached. */
export function createHourlyPublicCache(ttlMs = 30000, now: () => number = Date.now) {
  const entries = new Map<string, { value: unknown; expires: number }>(), loading = new Map<string, Promise<unknown>>();
  return async function get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const at = now(), hit = entries.get(key); if (hit && hit.expires > at) return hit.value as T;
    for (const [name, entry] of entries) if (entry.expires <= at) entries.delete(name);
    const waiting = loading.get(key); if (waiting) return await waiting as T;
    // Simultaneous distinct keys are bounded as well as completed entries.
    if (loading.size >= 64) throw new ApiError('RATE_LIMITED', '读取过于频繁，请稍后再试。', 429);
    const promise = load().then(value => { if (entries.size >= 64) entries.delete(entries.keys().next().value!); entries.set(key, { value, expires: now() + ttlMs }); return value; }).finally(() => { loading.delete(key); });
    loading.set(key, promise); return await promise;
  };
}
const cached = createHourlyPublicCache();
export async function hourlyContentRoute(request: Request, parts: string[], headers: Record<string, string>, context: HourlyContentContext): Promise<Response | null> {
  if (parts[0] !== 'insights' || !['dashboard', 'hourly', 'feed'].includes(parts[1])) return null;
  if (parts.length !== 2 || request.method !== 'GET') throw new ApiError('NOT_FOUND', '接口不存在。', 404);
  const endpoint = parts[1], params = hourlyReadParameters(request, endpoint, context.now?.() ?? Date.now());
  const names: Record<string, string> = { dashboard: 'pdd_public_hourly_dashboard', hourly: 'pdd_public_hourly_history', feed: 'pdd_public_hourly_feed' };
  const validate = endpoint === 'dashboard' ? hourlyDashboard : endpoint === 'hourly' ? hourlyHistory : hourlyFeed;
  const load = async () => { const raw = await context.rpc(names[endpoint], params); try { return validate(raw); } catch { return unavailable(); } };
  // Injected clock contexts are synthetic fixtures and deliberately bypass global cache.
  const value = context.now ? await load() : await cached(endpoint + ':' + JSON.stringify(params), load);
  return json(value, 200, headers);
}
