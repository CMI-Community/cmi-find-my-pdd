import { ApiError } from './http.ts';
import { authorizeMonitor, monitorDatabase, monitorRoute, type MonitorContext } from './monitor-api.ts';
import { databaseTiming, observedError, observedFetch, observedRoute, requestObservation } from './observability.ts';
import { createPublicCache } from './public-cache.ts';
import { configuredTelemetryLimit, createTelemetryLimiter, createTelemetryRoutes, telemetryBody, type TelemetryContext } from './telemetry-api.ts';
import { TELEMETRY_EVENTS, validateTelemetryRows } from '../../../shared/telemetry.ts';

function assert(condition: unknown, message = 'assertion failed'): asserts condition { if (!condition) throw new Error(message); }
function throws(fn: () => unknown, code: string) {
  try { fn(); } catch (error) { assert(error instanceof ApiError && error.code === code); return; }
  throw new Error(`expected ${code}`);
}
const secret = 'a'.repeat(64);
const resource = { databaseBytes: 100, connections: 8, maxConnections: 100, reservedConnections: 3,
  activeConnections: 2, waitingConnections: 0, idleInTransactionConnections: 0, longestTransactionSeconds: 0,
  transactionsCommitted: 40, transactionsRolledBack: 2, deadlocks: 0, tempBytes: 0, statsResetAt: null };
function context(overrides: Partial<MonitorContext> = {}): MonitorContext {
  return { secret, databaseLimit: '1000', admin: () => Promise.resolve('synthetic-admin'),
    configuration: () => Promise.resolve(), database: () => Promise.resolve(resource), registration: () => Promise.resolve(true),
    runtime: name => ({ APP_SHA: 'synthetic-sha', APP_ENVIRONMENT: 'test' } as Record<string, string>)[name], version: 'synthetic-version', ...overrides };
}
function request(path = '/v1/ops/status', authorized = true): Request {
  return new Request(`https://example.test${path}`, { headers: authorized ? { 'x-monitor-secret': secret } : {} });
}

Deno.test('monitor authentication accepts only a server header and 32-byte configured secrets', () => {
  authorizeMonitor(request(), secret);
  for (const value of [undefined, '', 'short', 'a'.repeat(42)]) throws(() => authorizeMonitor(request(), value), 'FORBIDDEN');
  throws(() => authorizeMonitor(request('/v1/ops/status?token=' + secret, false), secret), 'FORBIDDEN');
  throws(() => authorizeMonitor(request('/v1/ops/status', false), secret), 'FORBIDDEN');
  const encoded = 'A'.repeat(43);
  authorizeMonitor(new Request('https://example.test', { headers: { 'x-monitor-secret': encoded } }), encoded);
});

Deno.test('unauthorized monitors perform zero configuration, registration or DB probes', async () => {
  let calls = 0;
  const blocked = context({ configuration: () => { calls++; return Promise.resolve(); }, database: () => { calls++; return Promise.resolve(resource); }, registration: () => { calls++; return Promise.resolve(true); } });
  try { await monitorRoute(request('/v1/ops/status', false), ['ops', 'status'], {}, blocked); }
  catch (error) { assert(error instanceof ApiError && error.code === 'FORBIDDEN'); }
  assert(calls === 0);
});

Deno.test('private monitor projects resources and reports threshold warnings without row data', async () => {
  const response = await monitorRoute(request(), ['ops', 'status'], {}, context({ database: () => Promise.resolve({ ...resource,
    databaseBytes: 900, connections: 89, maxConnections: 100, reservedConnections: 3, waitingConnections: 2,
    idleInTransactionConnections: 1, longestTransactionSeconds: 31, number: 'SYNTHETIC-PRIVATE', contact: 'private-contact', query: 'private-sql', secret }) }));
  assert(response?.status === 200);
  const { data } = await response.json();
  assert(data.ok === true && data.ready === true);
  assert(data.warnings.includes('CONNECTIONS_CRITICAL') && data.warnings.includes('DATABASE_SIZE_CRITICAL'));
  assert(data.warnings.includes('LOCK_WAIT') && data.warnings.includes('LONG_TRANSACTION') && data.warnings.includes('IDLE_TRANSACTION'));
  const encoded = JSON.stringify(data);
  for (const privateValue of ['SYNTHETIC-PRIVATE', 'private-contact', 'private-sql', secret]) assert(!encoded.includes(privateValue));
});

Deno.test('monitor returns real 503 for missing DB/config and never includes exception details', async () => {
  const fail = () => Promise.reject(new Error('secret-private-database-row'));
  const response = await monitorRoute(request(), ['ops', 'status'], {}, context({ database: fail, configuration: fail }));
  assert(response?.status === 503);
  const { data } = await response.json();
  assert(data.database === null && data.ok === false && data.ready === false);
  assert(data.checks.database.ok === false && data.checks.configuration.ok === false);
  assert(!JSON.stringify(data).includes('secret-private'));
});

Deno.test('admin monitor uses existing authorization and quotas remain unknown unless configured', async () => {
  let authorized = false;
  const response = await monitorRoute(request('/v1/admin/system', false), ['admin', 'system'], {}, context({
    admin: () => { authorized = true; return Promise.resolve('synthetic-admin'); }, databaseLimit: undefined, registration: () => Promise.resolve(false),
  }));
  assert(authorized && response?.status === 200);
  const { data } = await response.json();
  assert(data.ready === false && data.database.databaseSizeLimitBytes === null && data.warnings.includes('DATABASE_QUOTA_UNCONFIGURED'));
  assert(data.warnings.includes('REGISTRATION_NOT_READY'));
  for (const invalid of [{ ...resource, connections: NaN }, { ...resource, maxConnections: 0 }, { ...resource, statsResetAt: 'not-a-time' }]) throws(() => monitorDatabase(invalid, '100'), 'SERVICE_UNAVAILABLE');
});

Deno.test('private monitor warns before event/batch budgets fill and projects only safe counts', async () => {
  for (const fixture of [
    { acceptedEvents: 70, acceptedBatches: 1, expected: 'TELEMETRY_BUDGET_HIGH', limitedAt: null },
    { acceptedEvents: 85, acceptedBatches: 1, expected: 'TELEMETRY_BUDGET_CRITICAL', limitedAt: null },
    { acceptedEvents: 1, acceptedBatches: 14_000, expected: 'TELEMETRY_BUDGET_HIGH', limitedAt: null },
    { acceptedEvents: 1, acceptedBatches: 17_000, expected: 'TELEMETRY_BUDGET_CRITICAL', limitedAt: null },
    { acceptedEvents: 99, acceptedBatches: 1, expected: 'TELEMETRY_BUDGET_EXHAUSTED', limitedAt: '2026-10-07T00:00:00Z' },
  ]) {
    const response = await monitorRoute(request(), ['ops', 'status'], {}, context({ telemetry: () => Promise.resolve({
      budget: [{ ...fixture, day: '2026-10-07', dailyLimit: 100, contact: 'private-contact', ip: 'private-ip' }], events: [{ message: 'private-row' }],
    }) }));
    assert(response?.status === 200);
    const { data } = await response.json();
    assert(data.warnings.includes(fixture.expected) && data.checks.telemetry.ok === true);
    assert(data.telemetry.acceptedEvents === fixture.acceptedEvents && data.telemetry.batchLimit === 20_000);
    assert(!JSON.stringify(data).includes('private-'));
  }
  const empty = await monitorRoute(request(), ['ops', 'status'], {}, context({ telemetry: () => Promise.resolve({ budget: [] }) }));
  assert(empty && (await empty.json()).data.telemetry === null);
  const failed = await monitorRoute(request(), ['ops', 'status'], {}, context({ telemetry: () => Promise.reject(new Error('private-error')) }));
  assert(failed?.status === 200);
  const { data } = await failed.json();
  assert(data.warnings.includes('TELEMETRY_MONITOR_UNAVAILABLE') && data.ok === true && !JSON.stringify(data).includes('private-error'));
});

Deno.test('request logs use static routes and discard private path, query, body, headers and errors', () => {
  const request = new Request('https://example.test/functions/v1/api/v1/waybill-manage/PRIVATECODE1234/withdraw?phone=123456789', {
    method: 'POST', headers: { Authorization: 'Bearer private-token', 'Content-Type': 'application/json' }, body: '{"contact":"private-body"}',
  });
  assert(observedRoute(request) === 'waybill.manage.withdraw');
  const log = requestObservation(request, 'synthetic-request-id', 503, 2_000, { calls: 2, errors: 1, durationMs: 80, maxDurationMs: 70 }, observedError(new Error('PRIVATECODE1234')))!;
  assert(log.sampleRate === 1 && log.errorCategory === 'INTERNAL_ERROR');
  const encoded = JSON.stringify(log);
  for (const privateValue of ['PRIVATECODE1234', '123456789', 'private-token', 'private-body']) assert(!encoded.includes(privateValue));
  assert(observedRoute(new Request('https://example.test/v1/private-contact-value')) === 'unknown');
  assert(observedError(new ApiError('private-error-value', 'private-message')) === 'INTERNAL_ERROR');
});

Deno.test('recipient request diagnostics keep only static route/error categories', () => {
  const routes = [
    ['/recipient-queries', 'recipient.query'],
    ['/recipient-queries/PRIVATE-QUERY-ID/pages', 'recipient.query.page'],
    ['/recipient-batches', 'recipient.batch'],
    ['/recipient-manage/PRIVATE-REGISTRATION-CODE', 'recipient.manage'],
    ['/recipient-manage/PRIVATE-REGISTRATION-CODE/withdraw', 'recipient.manage.withdraw'],
    ['/admin/recipients', 'admin.recipient.list'],
    ['/admin/recipients/PRIVATE-REGISTRATION-CODE', 'admin.recipient.detail'],
    ['/admin/recipients/PRIVATE-REGISTRATION-CODE/actions', 'admin.recipient.action'],
    ['/admin/recipient-queries', 'admin.recipient.query.list'],
  ];
  for (const [path, route] of routes) {
    const request = new Request('https://example.test/v1' + path + '?recipientName=PRIVATE-NAME&phone=PRIVATE-PHONE', {
      method: 'POST', headers: { Authorization: 'Bearer PRIVATE-CAPABILITY', 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipientName: 'PRIVATE-NAME', contact: 'PRIVATE-CONTACT', note: 'PRIVATE-NOTE' }),
    });
    assert(observedRoute(request) === route);
    for (const errorCode of ['INVALID_RECIPIENT_NAME', 'DUPLICATE_RECIPIENT']) {
      assert(observedError(new ApiError(errorCode, 'PRIVATE-ERROR-MESSAGE')) === errorCode);
      const log = requestObservation(request, 'synthetic-request-id', 409, 2, databaseTiming(), errorCode)!;
      assert(log.route === route && log.errorCategory === errorCode);
      assert(!JSON.stringify(log).includes('PRIVATE-'));
    }
  }
});

Deno.test('healthy logs are sampled, errors/slow calls retained and fetch failures counted without SQL details', async () => {
  const normal = request('/v1/community');
  assert(requestObservation(normal, 'id', 200, 5, databaseTiming(), null, 0.1, () => 0.9) === null);
  assert(requestObservation(normal, 'id', 200, 5, databaseTiming(), null, 0.1, () => 0.05)?.sampleRate === 0.1);
  assert(requestObservation(normal, 'id', 429, 5, databaseTiming(), 'RATE_LIMITED', 0, () => 1)?.sampleRate === 1);
  assert(requestObservation(normal, 'id', 200, 1_500, databaseTiming(), null, 0, () => 1)?.sampleRate === 1);
  const timing = databaseTiming();
  let elapsed = 0;
  await observedFetch(timing, () => { elapsed = 90; return Promise.resolve(new Response('private-sql', { status: 503 })); }, () => elapsed)('https://example.test');
  try { await observedFetch(timing, () => { elapsed += 10; return Promise.reject(new Error('private-error')); }, () => elapsed)('https://example.test'); } catch { /* expected */ }
  assert(timing.calls === 2 && timing.errors === 2 && timing.durationMs === 100 && timing.maxDurationMs === 90);
});

Deno.test('public cache coalesces traffic, expires and never preserves failed or invalidated loads', async () => {
  let now = 0, loads = 0;
  const cache = createPublicCache(30_000, () => now);
  const load = () => { loads++; return Promise.resolve({ lostRegistered: loads }); };
  const values = await Promise.all(Array.from({ length: 40 }, () => cache.get('waybill-stats', load)));
  assert(loads === 1 && values.every(value => value.lostRegistered === 1));
  now = 29_999; await cache.get('waybill-stats', load); assert(loads === 1);
  now = 30_000; const refreshed = await cache.get('waybill-stats', load); assert(refreshed.lostRegistered === 2);
  cache.clear();
  try { await cache.get('community', () => Promise.reject(new Error('DB down'))); } catch { /* expected */ }
  assert((await cache.get('community', () => Promise.resolve({ ready: true }))).ready === true);
  let release!: (value: string) => void;
  const old = cache.get('stats', () => new Promise<string>(resolve => { release = resolve; }));
  cache.clear(); release('old'); await old;
  assert(await cache.get('stats', () => Promise.resolve('new')) === 'new');
});

function telemetryRequest(events: unknown, contentType = 'text/plain;charset=UTF-8') {
  return new Request('https://example.test/v1/telemetry', { method: 'POST', headers: { 'content-type': contentType }, body: JSON.stringify({ events }) });
}
function telemetryContext(overrides: Partial<TelemetryContext> = {}): TelemetryContext {
  return { admin: () => Promise.resolve('synthetic-admin'), enabled: true, dailyLimit: 100_000, limit: () => Promise.resolve(),
    rpc: (_name, payload) => Promise.resolve({ accepted: true, limited: false, recorded: payload.events.reduce((sum: number, row: { count: number }) => sum + row.count, 0), day: '2026-10-07' }), ...overrides };
}

Deno.test('telemetry accepts bounded simple-CORS JSON and rejects unknown/private metadata before DB', async () => {
  const rows = [{ event: 'pdd_query_started', page: 'home', count: 2, mode: 'lost', source: 'barcode' }];
  assert((await telemetryBody(telemetryRequest(rows)))[0].count === 2);
  assert((await telemetryBody(telemetryRequest(rows, 'application/json')))[0].source === 'barcode');
  for (const events of [[], Array.from({ length: 25 }, () => rows[0]), [{ ...rows[0], count: 101 }], [{ ...rows[0], number: 'PRIVATE12345' }], [{ ...rows[0], page: 'admin' }], [{ event: 'pdd_visible_dwell', page: 'home', count: 1 }], [{ event: 'pdd_page_view', page: 'home', count: 1, source: 'barcode' }]]) {
    let rejected = false;
    try { await telemetryBody(telemetryRequest(events)); } catch (error) { rejected = error instanceof ApiError && error.code === 'INVALID_REQUEST'; }
    assert(rejected);
  }
  let tooLarge = false;
  try { await telemetryBody(new Request('https://example.test', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(8_193) })); }
  catch (error) { tooLarge = error instanceof ApiError && error.status === 413; }
  assert(tooLarge);
  assert(TELEMETRY_EVENTS.includes('pdd_scanner_camera_changed'));
  assert(validateTelemetryRows([{ event: 'pdd_visible_dwell', page: 'help', count: 1, bucket: '10-29s' }])[0].bucket === '10-29s');
});

Deno.test('telemetry uses atomic server cap and stops DB calls until next UTC day after exhaustion', async () => {
  let day = Date.parse('2026-10-07T12:00:00Z'), calls = 0, limits = 0;
  const route = createTelemetryRoutes(() => day), rows = [{ event: 'pdd_page_view', page: 'home', count: 1 }];
  const context = telemetryContext({ limit: () => { limits++; return Promise.resolve(); }, rpc: () => {
    calls++; return Promise.resolve({ accepted: false, recorded: 0, limited: true, day: new Date(day).toISOString().slice(0, 10) });
  } });
  const first = await route(telemetryRequest(rows), ['telemetry'], {}, context);
  assert(first?.status === 202 && (await first.json()).data.limited === true);
  await route(telemetryRequest(rows), ['telemetry'], {}, context);
  assert(calls === 1 && limits === 1);
  day += 24 * 60 * 60 * 1000; await route(telemetryRequest(rows), ['telemetry'], {}, context);
  assert(Number(calls) === 2 && Number(limits) === 2);
});

Deno.test('telemetry disabled state never invents accepted data and admin aggregates require authentication', async () => {
  const route = createTelemetryRoutes(), rows = [{ event: 'pdd_page_view', page: 'home', count: 1 }];
  let calls = 0, denied = false;
  try { await route(telemetryRequest(rows), ['telemetry'], {}, telemetryContext({ enabled: false, rpc: () => { calls++; return Promise.resolve({}); } })); }
  catch (error) { denied = error instanceof ApiError && error.status === 503; }
  assert(denied && calls === 0);
  try { await route(new Request('https://example.test/v1/admin/analytics'), ['admin', 'analytics'], {}, telemetryContext({ admin: () => Promise.reject(new ApiError('FORBIDDEN', 'denied', 403)), rpc: () => { calls++; return Promise.resolve({}); } })); }
  catch (error) { assert(error instanceof ApiError && error.status === 403); }
  assert(calls === 0);
  const response = await route(new Request('https://example.test/v1/admin/analytics?days=7'), ['admin', 'analytics'], {}, telemetryContext({ rpc: () => Promise.resolve({
    events: [{ day: '2026-10-07', event: 'pdd_page_view', page: 'home', count: 400, contact: 'private-contact', bucket: null }], budget: [], secret: 'private-secret',
  }) }));
  assert(response?.status === 200);
  const data = (await response.json()).data;
  assert(data.rows[0].count === 400 && data.rows[0].metadata && data.days === 7);
  assert(!JSON.stringify(data).includes('private-'));
});

Deno.test('telemetry limiter bounds client rate/memory and configurable daily cap cannot exceed100k', () => {
  let now = 0;
  const limit = createTelemetryLimiter(() => now);
  for (let index = 0; index < 6; index++) limit('synthetic-client-hash');
  throws(() => limit('synthetic-client-hash'), 'RATE_LIMITED');
  now = 60_000; limit('synthetic-client-hash');
  for (let index = 0; index < 255; index++) limit('synthetic-hash-' + index);
  throws(() => limit('new-client-over-memory-cap'), 'RATE_LIMITED');
  assert(configuredTelemetryLimit(undefined) === 100_000 && configuredTelemetryLimit('1000000') === 100_000 && configuredTelemetryLimit('25') === 25);
});
