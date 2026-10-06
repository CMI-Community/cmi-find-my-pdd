import { ApiError, json, onlyKeys } from './http.ts';
import { TELEMETRY_MAX_BYTES, validateTelemetryRows, type TelemetryReceipt, type TelemetryRow } from '../../../shared/telemetry.ts';

type Row = Record<string, any>;
export interface TelemetryContext {
  rpc: (name: string, payload: Row) => Promise<Row>;
  admin: () => Promise<string>;
  limit: () => Promise<void>;
  enabled: boolean;
  dailyLimit: number;
}

/** Streaming byte cap also applies to simple-CORS unload beacons. */
export async function telemetryBody(request: Request): Promise<TelemetryRow[]> {
  const contentType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json' && contentType !== 'text/plain') throw new ApiError('INVALID_REQUEST', '统计请求格式有误。', 415);
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > TELEMETRY_MAX_BYTES) throw new ApiError('INVALID_REQUEST', '统计请求内容过大。', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError('INVALID_REQUEST', '统计请求格式有误。');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > TELEMETRY_MAX_BYTES) { await reader.cancel(); throw new ApiError('INVALID_REQUEST', '统计请求内容过大。', 413); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let input: Record<string, unknown>;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ApiError('INVALID_REQUEST', '统计请求格式有误。'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('INVALID_REQUEST', '统计请求格式有误。');
  onlyKeys(input, ['events']);
  try { return validateTelemetryRows(input.events); }
  catch { throw new ApiError('INVALID_REQUEST', '统计事件不符合允许的格式。'); }
}

export function configuredTelemetryLimit(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return 100_000;
  return Math.max(1, Math.min(100_000, Number(value)));
}

export function createTelemetryRoutes(now: () => number = Date.now) {
  let cappedDay: string | null = null, cappedLimit = 0;
  return async (request: Request, parts: string[], headers: Record<string, string>, context: TelemetryContext): Promise<Response | null> => {
    if (parts.length === 2 && parts[0] === 'admin' && parts[1] === 'analytics' && request.method === 'GET') {
      await context.admin();
      const query = new URL(request.url).searchParams;
      if (Array.from(query.keys()).some(key => key !== 'days') || query.getAll('days').length > 1) throw new ApiError('INVALID_REQUEST', '统计日期范围有误。');
      const days = Number(query.get('days') ?? '7');
      if (!Number.isInteger(days) || days < 1 || days > 30) throw new ApiError('INVALID_REQUEST', '请选择一至三十天的统计。');
      const data = await context.rpc('pdd_telemetry_summary', { days });
      if (!Array.isArray(data.events) || !Array.isArray(data.budget)) throw new ApiError('SERVICE_UNAVAILABLE', '统计暂时不可用。', 503, true);
      const rows = data.events.map((row: Row) => {
        const safe = validateTelemetryRows([{ event: row.event, page: row.page, count: 1,
          ...Object.fromEntries(['mode', 'source', 'scanMode', 'batch', 'bucket'].filter(key => row[key] !== null && row[key] !== undefined).map(key => [key, row[key]])),
        }])[0];
        if (!Number.isSafeInteger(row.count) || row.count < 0 || typeof row.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.day)) throw new ApiError('SERVICE_UNAVAILABLE', '统计暂时不可用。', 503, true);
        const { event, page, count: _count, ...metadata } = safe;
        return { day: row.day, event, page, metadata, count: row.count };
      });
      const budget = data.budget.map((row: Row) => {
        if (typeof row.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.day) || ['acceptedBatches', 'acceptedEvents', 'dailyLimit'].some(key => !Number.isSafeInteger(row[key]) || row[key] < 0)) throw new ApiError('SERVICE_UNAVAILABLE', '统计暂时不可用。', 503, true);
        return { day: row.day, acceptedBatches: row.acceptedBatches, acceptedEvents: row.acceptedEvents, dailyLimit: row.dailyLimit,
          limitedAt: typeof row.limitedAt === 'string' && Number.isFinite(Date.parse(row.limitedAt)) ? row.limitedAt : null };
      });
      return json({ rows, budget, enabled: context.enabled, days, timezone: 'UTC', dailyLimit: context.dailyLimit, retentionDays: 30 }, 200, headers);
    }
    if (parts[0] !== 'telemetry') return null;
    if (parts.length !== 1 || request.method !== 'POST' || new URL(request.url).search) throw new ApiError('INVALID_REQUEST', '统计接口仅接受无参数的 POST 请求。');
    const events = await telemetryBody(request);
    if (!context.enabled) throw new ApiError('SERVICE_UNAVAILABLE', '统计服务暂未启用。', 503, false);
    const today = new Date(now()).toISOString().slice(0, 10);
    if (cappedDay === today && cappedLimit === context.dailyLimit) return json({ accepted: false, recorded: 0, limited: true, day: today } satisfies TelemetryReceipt, 202, headers);
    await context.limit();
    const receipt = await context.rpc('pdd_telemetry_ingest', { events, daily_limit: context.dailyLimit });
    if (typeof receipt.accepted !== 'boolean' || typeof receipt.limited !== 'boolean' || !Number.isInteger(receipt.recorded) || receipt.recorded < 0 ||
      typeof receipt.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(receipt.day) ||
      (receipt.accepted && (receipt.limited || receipt.recorded !== events.reduce((sum, row) => sum + row.count, 0))) ||
      (!receipt.accepted && (!receipt.limited || receipt.recorded !== 0))) throw new ApiError('SERVICE_UNAVAILABLE', '统计暂时不可用。', 503, true);
    if (receipt.limited) { cappedDay = receipt.day; cappedLimit = context.dailyLimit; }
    return json({ accepted: receipt.accepted, recorded: receipt.recorded, limited: receipt.limited, day: receipt.day } satisfies TelemetryReceipt, 202, headers);
  };
}

/** Bound telemetry abuse before the durable limiter. Only transient hashes live here. */
export function createTelemetryLimiter(now: () => number = Date.now) {
  let window = -1, total = 0;
  const clients = new Map<string, number>();
  return (key: string): void => {
    const current = Math.floor(now() / 60_000);
    if (current !== window) { window = current; total = 0; clients.clear(); }
    const count = clients.get(key) ?? 0;
    if (total >= 1_200 || count >= 6 || (!clients.has(key) && clients.size >= 256)) throw new ApiError('RATE_LIMITED', '统计操作过于频繁。', 429, false);
    total++; clients.set(key, count + 1);
  };
}
