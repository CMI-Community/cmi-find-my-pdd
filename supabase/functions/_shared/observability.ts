import { ApiError } from './http.ts';

/** Only static names enter logs: URL segments can contain waybills or capabilities. */
export function apiParts(url: string): string[] {
  return new URL(url).pathname.replace(/^\/functions\/v1\/api/, '').replace(/^\/api/, '').replace(/^\/v1/, '').split('/').filter(Boolean);
}
export function observedRoute(request: Request): string {
  const [first, second, third, fourth] = apiParts(request.url);
  if (first === 'health') return 'health';
  if (first === 'ops' && second === 'status') return 'ops.status';
  if (first === 'telemetry') return 'telemetry';
  if (first === 'community') return 'community';
  if (first === 'stats') return 'legacy.stats';
  if (first === 'waybill-stats') return 'waybill.stats';
  if (first === 'waybill-queries') return third === 'contact' ? 'waybill.query.contact' : 'waybill.query';
  if (first === 'waybill-batches') return 'waybill.batch';
  if (first === 'waybill-manage') return third === 'withdraw' ? 'waybill.manage.withdraw' : 'waybill.manage';
  if (first === 'waybills') return 'waybill.public';
  if (first === 'recipient-queries') return third === 'pages' ? 'recipient.query.page' : 'recipient.query';
  if (first === 'recipient-batches') return 'recipient.batch';
  if (first === 'recipient-manage') return third === 'withdraw' ? 'recipient.manage.withdraw' : 'recipient.manage';
  if (first === 'feedback') return 'feedback.submit';
  if (first === 'scans') return ['candidates', 'submit', 'select', 'revisions', 'retry'].includes(third) ? `legacy.scan.${third}` : 'legacy.scan';
  if (first === 'trackers') return 'legacy.tracker';
  if (first === 'records') return third === 'image' ? 'legacy.public.image' : 'legacy.public';
  if (first === 'manage') return third === 'withdraw' ? 'legacy.manage.withdraw' : 'legacy.manage';
  if (first === 'admin') {
    if (second === 'system') return 'admin.system';
    if (second === 'analytics') return 'admin.analytics';
    if (second === 'waybills') return fourth === 'actions' ? 'admin.waybill.action' : third ? 'admin.waybill.detail' : 'admin.waybill.list';
    if (second === 'waybill-queries') return 'admin.query.list';
    if (second === 'recipients') return fourth === 'actions' ? 'admin.recipient.action' : third ? 'admin.recipient.detail' : 'admin.recipient.list';
    if (second === 'recipient-queries') return 'admin.recipient.query.list';
    if (second === 'feedback') return third ? 'admin.feedback.update' : 'admin.feedback.list';
    if (['community', 'scans', 'tasks', 'records', 'duplicates', 'recognition', 'audit'].includes(second)) return `admin.legacy.${second}`;
  }
  return 'unknown';
}

const ERROR_CODES = new Set(['INTERNAL_ERROR', 'SERVICE_UNAVAILABLE', 'FORBIDDEN', 'NOT_FOUND', 'INVALID_REQUEST', 'INVALID_WAYBILL', 'INVALID_RECIPIENT_NAME', 'DUPLICATE_RECIPIENT', 'INVALID_CONTACT', 'INVALID_NOTE', 'RATE_LIMITED', 'VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'QUERY_TIMEOUT', 'QUERY_EXPIRED', 'SCAN_EXPIRED', 'OWNERSHIP_LOCKED', 'NEEDS_RECEIVED', 'INVALID_ADMIN_STATE', 'INVALID_IMAGE', 'UPLOAD_INCOMPLETE', 'NEEDS_PHOTO', 'OCR_DEFERRED']);
export function observedError(error: unknown): string {
  return error instanceof ApiError && ERROR_CODES.has(error.code) ? error.code : 'INTERNAL_ERROR';
}
function milliseconds(value: number): number { return Number.isFinite(value) ? Math.round(Math.max(0, Math.min(value, 600_000))) : 0; }
export type DatabaseTiming = { calls: number; errors: number; durationMs: number; maxDurationMs: number };
export function databaseTiming(): DatabaseTiming { return { calls: 0, errors: 0, durationMs: 0, maxDurationMs: 0 }; }

/** One in-memory summary per request; no telemetry inserts or private SQL errors. */
export function observedFetch(timing: DatabaseTiming, send: typeof fetch = fetch, now: () => number = performance.now.bind(performance)): typeof fetch {
  return async (input, init) => {
    const start = now();
    timing.calls++;
    try {
      const response = await send(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(8_000) });
      if (!response.ok) timing.errors++;
      return response;
    } catch (error) {
      timing.errors++;
      throw error;
    } finally {
      const elapsed = milliseconds(now() - start);
      timing.durationMs += elapsed;
      timing.maxDurationMs = Math.max(timing.maxDurationMs, elapsed);
    }
  };
}

export function requestObservation(request: Request, requestId: string, status: number, durationMs: number, timing: DatabaseTiming, errorCode: string | null, successSampleRate = 0.1, random: () => number = Math.random): Record<string, unknown> | null {
  const sampleRate = Number.isFinite(successSampleRate) ? Math.max(0, Math.min(1, successSampleRate)) : 0.1;
  // Failed/slow requests are retained. Platform invocation metrics supply full traffic totals.
  const important = status >= 400 || durationMs >= 1_500;
  if (!important && random() >= sampleRate) return null;
  return {
    event: 'pdd404.api_request', schemaVersion: 1, requestId,
    route: observedRoute(request), method: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(request.method) ? request.method : 'OTHER',
    status, durationMs: milliseconds(durationMs),
    database: { calls: timing.calls, errors: timing.errors, durationMs: milliseconds(timing.durationMs), maxDurationMs: milliseconds(timing.maxDurationMs) },
    errorCategory: errorCode && ERROR_CODES.has(errorCode) ? errorCode : status >= 500 ? 'SERVICE_UNAVAILABLE' : null,
    sampleRate: important ? 1 : sampleRate,
  };
}
