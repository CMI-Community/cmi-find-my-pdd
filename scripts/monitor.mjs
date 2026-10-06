import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ALERT_CODES = new Set(['DATABASE_UNAVAILABLE', 'CONFIGURATION_UNAVAILABLE', 'REGISTRATION_NOT_READY', 'CONNECTIONS_CRITICAL', 'CONNECTIONS_HIGH', 'DATABASE_QUOTA_UNCONFIGURED', 'DATABASE_SIZE_CRITICAL', 'DATABASE_SIZE_HIGH', 'LONG_TRANSACTION', 'LOCK_WAIT', 'IDLE_TRANSACTION', 'DATABASE_SLOW', 'TELEMETRY_MONITOR_UNAVAILABLE', 'TELEMETRY_BUDGET_HIGH', 'TELEMETRY_BUDGET_CRITICAL', 'TELEMETRY_BUDGET_EXHAUSTED', 'WEBSITE_UNAVAILABLE', 'SERVICE_UNAVAILABLE', 'WEBSITE_SLOW', 'SERVICE_SLOW', 'RESOURCE_METRICS_UNAVAILABLE', 'CPU_CRITICAL', 'CPU_HIGH', 'MEMORY_CRITICAL', 'MEMORY_HIGH', 'NEW_DEADLOCK', 'DATABASE_LIMIT_WITHIN_7_DAYS', 'MONITOR_BASELINE_UNAVAILABLE', 'MONITOR_CACHE_RESTORE_FAILED']);
const DB_COUNTERS = ['databaseBytes', 'connections', 'maxConnections', 'reservedConnections', 'activeConnections', 'waitingConnections', 'idleInTransactionConnections', 'longestTransactionSeconds', 'transactionsCommitted', 'transactionsRolledBack', 'deadlocks', 'tempBytes', 'connectionUtilization'];
const METRIC_COUNTERS = ['cpuTotal', 'cpuIdle', 'memoryTotal', 'memoryAvailable', 'load1', 'cpus'];
const numeric = value => Number.isFinite(value) && value >= 0 ? value : null;
const codes = values => Array.isArray(values) ? values.filter(value => ALERT_CODES.has(value)) : [];

/** GitHub caches can be read from PRs. Persist only this explicit safe allowlist. */
export function safeMonitorState(report) {
  if (!report || typeof report.checkedAt !== 'string' || !Number.isFinite(Date.parse(report.checkedAt)) || !report.website || !report.resources) throw new Error('Invalid monitoring state.');
  let system = null;
  if (report.system) {
    let database = null;
    if (report.system.database) {
      database = Object.fromEntries(DB_COUNTERS.map(key => [key, numeric(report.system.database[key])]));
      database.databaseSizeLimitBytes = numeric(report.system.database.databaseSizeLimitBytes);
      database.statsResetAt = Number.isFinite(Date.parse(report.system.database.statsResetAt)) ? new Date(report.system.database.statsResetAt).toISOString() : null;
    }
    system = { ok: report.system.ok === true, ready: report.system.ready === true,
      sha: /^[a-f0-9]{40}$/i.test(report.system.sha ?? '') ? report.system.sha : 'unknown',
      durationMs: numeric(report.system.durationMs), database, warnings: codes(report.system.warnings) };
  }
  const baseline = report.growthBaseline;
  return { stateVersion: 1, checkedAt: new Date(report.checkedAt).toISOString(), durationMs: numeric(report.durationMs),
    website: { ok: report.website.ok === true, status: numeric(report.website.status), durationMs: numeric(report.website.durationMs) },
    system, metricsState: report.metricsState === 'available' ? 'available' : 'unavailable',
    metrics: report.metrics ? Object.fromEntries(METRIC_COUNTERS.map(key => [key, numeric(report.metrics[key])])) : null,
    resources: { cpuUtilization: numeric(report.resources.cpuUtilization), memoryUtilization: numeric(report.resources.memoryUtilization), load1: numeric(report.resources.load1) },
    growthBaseline: baseline && numeric(baseline.at) !== null && numeric(baseline.bytes) !== null ? { at: baseline.at, bytes: baseline.bytes } : null,
    alerts: codes(report.alerts), changed: report.changed === true, recovered: report.recovered === true,
  };
}

export function previousMonitorState(value, now = Date.now()) {
  try {
    const state = safeMonitorState(value), age = now - Date.parse(state.checkedAt);
    // A delayed/lost scheduler must not look like consecutive healthy samples.
    return age >= 0 && age <= 30 * 60_000 ? state : null;
  } catch { return null; }
}

// Only numeric aggregate series are retained; exporter labels can contain SQL.
export function parseMetrics(source) {
  const result = { cpuTotal: 0, cpuIdle: 0, memoryTotal: null, memoryAvailable: null, load1: null, cpus: null };
  for (const line of source.split('\n')) {
    const match = /^([a-zA-Z_][a-zA-Z0-9_]*)(\{[^\n]*\})?\s+([-+0-9.eE]+)(?:\s+\d+)?$/.exec(line);
    if (!match || !Number.isFinite(Number(match[3]))) continue;
    const [, name, labels = '', value] = match, n = Number(value);
    if (name === 'node_cpu_seconds_total' && !/mode="(?:guest|guest_nice)"/.test(labels)) {
      result.cpuTotal += n;
      if (/mode="idle"/.test(labels)) result.cpuIdle += n;
    }
    if (name === 'node_memory_MemTotal_bytes') result.memoryTotal = n;
    if (name === 'node_memory_MemAvailable_bytes') result.memoryAvailable = n;
    if (name === 'node_load1') result.load1 = n;
    if (name === 'node_cpu_online') result.cpus = (result.cpus ?? 0) + n;
  }
  return result;
}

export function resources(metrics, previous) {
  if (!metrics) return { cpuUtilization: null, memoryUtilization: null, load1: null };
  const cpuCountersPresent = previous && ['cpuTotal', 'cpuIdle'].every(key =>
    Number.isFinite(metrics[key]) && metrics[key] >= 0 && Number.isFinite(previous[key]) && previous[key] >= 0)
    && metrics.cpuTotal > 0 && previous.cpuTotal > 0
    && metrics.cpuIdle <= metrics.cpuTotal && previous.cpuIdle <= previous.cpuTotal;
  const total = cpuCountersPresent ? metrics.cpuTotal - previous.cpuTotal : 0;
  const idle = cpuCountersPresent ? metrics.cpuIdle - previous.cpuIdle : 0;
  return {
    cpuUtilization: total > 0 && idle >= 0 && idle <= total ? 1 - idle / total : null,
    memoryUtilization: Number.isFinite(metrics.memoryTotal) && metrics.memoryTotal > 0
      && Number.isFinite(metrics.memoryAvailable) && metrics.memoryAvailable >= 0 && metrics.memoryAvailable <= metrics.memoryTotal
      ? 1 - metrics.memoryAvailable / metrics.memoryTotal : null,
    load1: metrics.load1,
  };
}

export function evaluate(report, previous) {
  const alerts = [...new Set(report.system?.warnings ?? [])];
  if (!report.website.ok) alerts.push('WEBSITE_UNAVAILABLE');
  if (!report.system?.ok) alerts.push('SERVICE_UNAVAILABLE');
  if (report.website.durationMs >= 2000 && previous?.website?.durationMs >= 2000) alerts.push('WEBSITE_SLOW');
  if (report.system?.durationMs >= 2000 && previous?.system?.durationMs >= 2000) alerts.push('SERVICE_SLOW');
  if (report.metricsState !== 'available') alerts.push('RESOURCE_METRICS_UNAVAILABLE');
  const r = report.resources, before = previous?.resources;
  if (r.cpuUtilization >= .85 && before?.cpuUtilization >= .85) alerts.push('CPU_CRITICAL');
  else if (r.cpuUtilization >= .7 && before?.cpuUtilization >= .7) alerts.push('CPU_HIGH');
  if (r.memoryUtilization >= .9) alerts.push('MEMORY_CRITICAL');
  else if (r.memoryUtilization >= .8 && before?.memoryUtilization >= .8) alerts.push('MEMORY_HIGH');
  const db = report.system?.database, old = previous?.system?.database;
  if (db && old && report.system?.database?.statsResetAt === previous.system?.database?.statsResetAt && db.deadlocks > old.deadlocks) alerts.push('NEW_DEADLOCK');
  // A saved baseline spans at least one day; brief measurement noise is not
  // extrapolated into a promise about remaining quota.
  const baseline = previous?.growthBaseline;
  if (db?.databaseSizeLimitBytes && baseline && Date.parse(report.checkedAt) - baseline.at >= 86400000) {
    const growthPerDay = (db.databaseBytes - baseline.bytes) / ((Date.parse(report.checkedAt) - baseline.at) / 86400000);
    if (growthPerDay > 0 && (db.databaseSizeLimitBytes - db.databaseBytes) / growthPerDay < 7) alerts.push('DATABASE_LIMIT_WITHIN_7_DAYS');
  }
  return [...new Set(alerts)].sort();
}

export async function collect(env, previous = null, fetcher = fetch) {
  const project = 'fogncjjsnakbhfdbfvdi';
  if (env.SUPABASE_PROJECT_ID !== project || env.SUPABASE_URL !== `https://${project}.supabase.co`) throw new Error('Independent PDD404 monitor configuration required.');
  if (!/^[a-f0-9]{64}$/i.test(env.MONITOR_SECRET ?? '')) throw new Error('Missing private monitor secret.');
  const started = Date.now();
  async function probe(url, headers = {}) {
    const at = Date.now();
    try {
      const response = await fetcher(url, { headers, signal: AbortSignal.timeout(12000), redirect: 'error' });
      return { response, status: response.status, durationMs: Date.now() - at };
    } catch { return { response: null, status: null, durationMs: Date.now() - at }; }
  }
  const [site, api, exporter] = await Promise.all([
    probe('https://pdd404.app/'),
    probe(`${env.SUPABASE_URL}/functions/v1/api/v1/ops/status`, { 'x-monitor-secret': env.MONITOR_SECRET }),
    env.SUPABASE_SERVICE_ROLE_KEY ? probe(`${env.SUPABASE_URL}/customer/v1/privileged/metrics`, { Authorization: 'Basic ' + Buffer.from('service_role:' + env.SUPABASE_SERVICE_ROLE_KEY).toString('base64') }) : null,
  ]);
  let system = null, metrics = null;
  try {
    const body = await api.response?.json();
    if (body?.data?.service === 'pdd404' && body.data.environment === 'production') system = body.data;
  } catch { /* unknown, not healthy */ }
  try { if (exporter?.response?.ok) metrics = parseMetrics(await exporter.response.text()); } catch { /* unknown */ }
  const report = {
    checkedAt: new Date().toISOString(), durationMs: Date.now() - started,
    website: { ok: site.response?.ok === true && site.response.headers.get('content-type')?.includes('text/html') === true, status: site.status, durationMs: site.durationMs },
    system: system ? { ok: system.ok === true, ready: system.ready === true, sha: system.sha, durationMs: api.durationMs, database: system.database, warnings: system.warnings } : null,
    metricsState: metrics?.memoryTotal > 0 ? 'available' : 'unavailable', metrics,
    resources: resources(metrics, previous?.metrics),
    growthBaseline: previous?.growthBaseline ?? (system?.database ? { at: Date.now(), bytes: system.database.databaseBytes } : null),
  };
  report.alerts = evaluate(report, previous);
  if (env.MONITOR_REQUIRE_BASELINE === 'true' && (!previous || report.resources.cpuUtilization === null)) report.alerts.push('MONITOR_BASELINE_UNAVAILABLE');
  if (env.MONITOR_CACHE_RESTORE_FAILED === 'true') report.alerts.push('MONITOR_CACHE_RESTORE_FAILED');
  report.alerts = [...new Set(report.alerts)].sort();
  const old = previous?.alerts ?? [];
  report.changed = report.alerts.some(code => !old.includes(code)) || old.some(code => !report.alerts.includes(code));
  report.recovered = old.length > 0 && report.alerts.length === 0;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const stateFile = resolve(process.env.MONITOR_STATE_FILE ?? '.private/monitor-state.json');
  let previous = null;
  try {
    if (process.env.MONITOR_CACHE_RESTORE_FAILED !== 'true') previous = previousMonitorState(JSON.parse(await readFile(stateFile, 'utf8')));
  } catch { /* unavailable baseline, not a healthy CPU/growth sample */ }
  const report = await collect(process.env, previous);
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
  await writeFile(stateFile, JSON.stringify(safeMonitorState(report)), { mode: 0o600 });
  // Credentials, metrics label sets, SQL, input and contact values never print.
  console.log(JSON.stringify({ checkedAt: report.checkedAt, changed: report.changed, recovered: report.recovered, alerts: report.alerts, website: report.website, system: report.system, resources: report.resources, metricsState: report.metricsState }));
  if (report.alerts.length) process.exitCode = 1;
}
