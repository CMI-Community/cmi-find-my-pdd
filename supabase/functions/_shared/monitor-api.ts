import { ApiError, json } from './http.ts';

const DATABASE_FIELDS = ['databaseBytes', 'connections', 'maxConnections', 'reservedConnections', 'activeConnections', 'waitingConnections', 'idleInTransactionConnections', 'longestTransactionSeconds', 'transactionsCommitted', 'transactionsRolledBack', 'deadlocks', 'tempBytes'] as const;
type DatabaseStatus = Record<typeof DATABASE_FIELDS[number], number> & { databaseSizeLimitBytes: number | null; connectionUtilization: number; statsResetAt: string | null };
type TelemetryStatus = { day: string; acceptedEvents: number; acceptedBatches: number; dailyLimit: number; batchLimit: number; limitedAt: string | null };
export interface MonitorContext {
  admin: () => Promise<string>;
  secret: string | undefined;
  databaseLimit: string | undefined;
  configuration: () => Promise<void>;
  database: () => Promise<Record<string, unknown>>;
  registration: () => Promise<boolean>;
  telemetry?: () => Promise<Record<string, unknown>>;
  runtime: (name: string) => string | undefined;
  version: string;
  now?: () => number;
}

export function monitorTelemetry(raw: Record<string, unknown>): TelemetryStatus | null {
  if (!Array.isArray(raw.budget) || raw.budget.length > 1) throw new ApiError('SERVICE_UNAVAILABLE', '统计预算监控暂时不可用。', 503, true);
  if (!raw.budget.length) return null;
  const budget = raw.budget[0] as Record<string, unknown>;
  if (!budget || typeof budget.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(budget.day) ||
    ['acceptedEvents', 'acceptedBatches', 'dailyLimit'].some(key => !Number.isSafeInteger(budget[key]) || Number(budget[key]) < 0) ||
    Number(budget.dailyLimit) < 1 || Number(budget.dailyLimit) > 100_000 ||
    budget.limitedAt !== null && (typeof budget.limitedAt !== 'string' || !Number.isFinite(Date.parse(budget.limitedAt)))) {
    throw new ApiError('SERVICE_UNAVAILABLE', '统计预算监控暂时不可用。', 503, true);
  }
  return { day: budget.day, acceptedEvents: Number(budget.acceptedEvents), acceptedBatches: Number(budget.acceptedBatches),
    dailyLimit: Number(budget.dailyLimit), batchLimit: 20_000, limitedAt: budget.limitedAt as string | null };
}

/** Monitor tokens remain server-only, exactly like existing management capabilities. */
export function authorizeMonitor(request: Request, secret: string | undefined): void {
  const validFormat = secret && (/^[a-f0-9]{64}$/i.test(secret) || /^[A-Za-z0-9_-]{43}$/.test(secret));
  const supplied = request.headers.get('x-monitor-secret') ?? '';
  let mismatch = supplied.length ^ (secret?.length ?? 0);
  for (let index = 0; index < (secret?.length ?? 64); index++) mismatch |= (supplied.charCodeAt(index) || 0) ^ (secret?.charCodeAt(index) || 0);
  if (!validFormat || mismatch !== 0) throw new ApiError('FORBIDDEN', '仅授权监控可访问此接口。', 403);
}

export function monitorDatabase(raw: Record<string, unknown>, limit: string | undefined): DatabaseStatus {
  if (!raw || DATABASE_FIELDS.some(field => typeof raw[field] !== 'number' || !Number.isFinite(raw[field]) || Number(raw[field]) < 0) ||
    Number(raw.maxConnections) <= Number(raw.reservedConnections) ||
    raw.statsResetAt !== null && (typeof raw.statsResetAt !== 'string' || !Number.isFinite(Date.parse(raw.statsResetAt)))) {
    throw new ApiError('SERVICE_UNAVAILABLE', '数据库监控暂时不可用。', 503, true);
  }
  const databaseSizeLimitBytes = limit && /^\d+$/.test(limit) && Number.isSafeInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : null;
  return {
    databaseBytes: Number(raw.databaseBytes), connections: Number(raw.connections), maxConnections: Number(raw.maxConnections), reservedConnections: Number(raw.reservedConnections),
    activeConnections: Number(raw.activeConnections), waitingConnections: Number(raw.waitingConnections), idleInTransactionConnections: Number(raw.idleInTransactionConnections),
    longestTransactionSeconds: Number(raw.longestTransactionSeconds), transactionsCommitted: Number(raw.transactionsCommitted), transactionsRolledBack: Number(raw.transactionsRolledBack),
    deadlocks: Number(raw.deadlocks), tempBytes: Number(raw.tempBytes), statsResetAt: raw.statsResetAt as string | null,
    databaseSizeLimitBytes, connectionUtilization: Number(raw.connections) / (Number(raw.maxConnections) - Number(raw.reservedConnections)),
  };
}

export async function monitorRoute(request: Request, parts: string[], headers: Record<string, string>, context: MonitorContext): Promise<Response | null> {
  const serviceMonitor = parts.length === 2 && parts[0] === 'ops' && parts[1] === 'status';
  const adminMonitor = parts.length === 2 && parts[0] === 'admin' && parts[1] === 'system';
  if (!serviceMonitor && !adminMonitor) return null;
  if (request.method !== 'GET' || new URL(request.url).search) throw new ApiError('INVALID_REQUEST', '监控接口仅接受无参数的 GET 请求。');
  if (serviceMonitor) authorizeMonitor(request, context.secret);
  else await context.admin();
  const now = context.now ?? Date.now;
  const started = now();
  let configuration = false, registration = false, database: DatabaseStatus | null = null;
  let telemetry: TelemetryStatus | null = null, telemetryOk: boolean | null = context.telemetry ? false : null;
  const databaseStarted = now();
  let databaseDurationMs = 0;
  await Promise.all([
    (async () => {
      try { database = monitorDatabase(await context.database(), context.databaseLimit); }
      catch { /* Failed probes are states, never private exception details. */ }
      finally { databaseDurationMs = Math.max(0, now() - databaseStarted); }
    })(),
    (async () => {
      try { await context.configuration(); configuration = true; registration = await context.registration(); }
      catch { /* No secret or database error text enters the response. */ }
    })(),
    (async () => {
      if (!context.telemetry) return;
      try { telemetry = monitorTelemetry(await context.telemetry()); telemetryOk = true; }
      catch { /* Only an availability state is exposed on failed budget reads. */ }
    })(),
  ]);
  // Avoid TypeScript's closure control-flow narrowing without weakening the DTO.
  const resources = database as DatabaseStatus | null;
  const warnings: string[] = [];
  if (!resources) warnings.push('DATABASE_UNAVAILABLE');
  if (!configuration) warnings.push('CONFIGURATION_UNAVAILABLE');
  if (!registration) warnings.push('REGISTRATION_NOT_READY');
  if (telemetryOk === false) warnings.push('TELEMETRY_MONITOR_UNAVAILABLE');
  const budget = telemetry as TelemetryStatus | null;
  if (budget) {
    if (budget.limitedAt) warnings.push('TELEMETRY_BUDGET_EXHAUSTED');
    else if (budget.acceptedEvents / budget.dailyLimit >= 0.85 || budget.acceptedBatches / budget.batchLimit >= 0.85) warnings.push('TELEMETRY_BUDGET_CRITICAL');
    else if (budget.acceptedEvents / budget.dailyLimit >= 0.7 || budget.acceptedBatches / budget.batchLimit >= 0.7) warnings.push('TELEMETRY_BUDGET_HIGH');
  }
  if (resources) {
    if (resources.connectionUtilization >= 0.9) warnings.push('CONNECTIONS_CRITICAL');
    else if (resources.connectionUtilization >= 0.8) warnings.push('CONNECTIONS_HIGH');
    if (resources.databaseSizeLimitBytes === null) warnings.push('DATABASE_QUOTA_UNCONFIGURED');
    else if (resources.databaseBytes / resources.databaseSizeLimitBytes >= 0.85) warnings.push('DATABASE_SIZE_CRITICAL');
    else if (resources.databaseBytes / resources.databaseSizeLimitBytes >= 0.7) warnings.push('DATABASE_SIZE_HIGH');
    if (resources.longestTransactionSeconds >= 30) warnings.push('LONG_TRANSACTION');
    if (resources.waitingConnections > 0) warnings.push('LOCK_WAIT');
    if (resources.idleInTransactionConnections > 0) warnings.push('IDLE_TRANSACTION');
    if (databaseDurationMs >= 1_500) warnings.push('DATABASE_SLOW');
  }
  const ok = Boolean(resources && configuration);
  return json({ service: 'pdd404', version: context.version,
    sha: context.runtime('DEPLOY_SHA') ?? context.runtime('APP_SHA') ?? 'unknown', environment: context.runtime('APP_ENVIRONMENT') ?? 'unknown',
    checkedAt: new Date(now()).toISOString(), ok, ready: ok && registration,
    durationMs: Math.max(0, now() - started),
    checks: { database: { ok: Boolean(resources), durationMs: databaseDurationMs }, configuration: { ok: configuration }, registration: { ok: registration }, telemetry: { ok: telemetryOk } },
    database: resources, telemetry: budget, warnings,
  }, ok ? 200 : 503, headers);
}
