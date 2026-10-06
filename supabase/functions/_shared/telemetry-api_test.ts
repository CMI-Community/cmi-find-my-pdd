import { ApiError } from './http.ts';
import { createTelemetryRoutes, type TelemetryContext } from './telemetry-api.ts';

function assert(condition: unknown): asserts condition { if (!condition) throw new Error('assertion failed'); }
const events = [{ event: 'pdd_page_view', page: 'home', count: 2 }];
const request = () => new Request('https://example.test/v1/telemetry', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ events }) });
const context = (receipt: Record<string, unknown>): TelemetryContext => ({ enabled: true, dailyLimit: 100_000,
  admin: () => Promise.resolve('synthetic-admin'), limit: () => Promise.resolve(), rpc: () => Promise.resolve(receipt) });

Deno.test('telemetry never confirms a malformed or partial database receipt', async () => {
  for (const receipt of [
    { accepted: true, recorded: 1, limited: false, day: '2026-10-07' },
    { accepted: false, recorded: 1, limited: true, day: '2026-10-07' },
    { accepted: false, recorded: 0, limited: false, day: '2026-10-07' },
    { accepted: true, recorded: 2, limited: true, day: '2026-10-07' },
    { accepted: true, recorded: 2, limited: false, day: 'private-query-value' },
  ]) {
    let rejected = false;
    try { await createTelemetryRoutes()(request(), ['telemetry'], {}, context(receipt)); }
    catch (error) { rejected = error instanceof ApiError && error.status === 503; }
    assert(rejected);
  }
});

Deno.test('admin analytics rejects unbounded/repeated date queries before summary RPC', async () => {
  let calls = 0;
  const admin = context({}); admin.rpc = () => { calls++; return Promise.resolve({}); };
  for (const query of ['days=31', 'days=0', 'days=2.5', 'days=7&days=8', 'days=7&contact=private']) {
    let rejected = false;
    try { await createTelemetryRoutes()(new Request('https://example.test/v1/admin/analytics?' + query), ['admin', 'analytics'], {}, admin); }
    catch (error) { rejected = error instanceof ApiError && error.code === 'INVALID_REQUEST'; }
    assert(rejected);
  }
  assert(calls === 0);
});
