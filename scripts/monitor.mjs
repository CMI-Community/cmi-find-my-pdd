import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
  const total = previous ? metrics.cpuTotal - previous.cpuTotal : 0;
  const idle = previous ? metrics.cpuIdle - previous.cpuIdle : 0;
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
  // A rolling baseline spans at least one day; brief measurement noise is not
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
  const old = previous?.alerts ?? [];
  report.changed = report.alerts.some(code => !old.includes(code)) || old.some(code => !report.alerts.includes(code));
  report.recovered = old.length > 0 && report.alerts.length === 0;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const stateFile = resolve(process.env.MONITOR_STATE_FILE ?? '.private/monitor-state.json');
  let previous = null;
  try { previous = JSON.parse(await readFile(stateFile, 'utf8')); } catch { /* first run */ }
  const report = await collect(process.env, previous);
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
  await writeFile(stateFile, JSON.stringify(report), { mode: 0o600 });
  // Credentials, metrics label sets, SQL, input and contact values never print.
  console.log(JSON.stringify({ checkedAt: report.checkedAt, changed: report.changed, recovered: report.recovered, alerts: report.alerts, website: report.website, system: report.system, resources: report.resources, metricsState: report.metricsState }));
  if (report.alerts.length) process.exitCode = 1;
}
