import { pddRoute, pddPublic, pddQuery, type PddRouteContext } from './waybill-api.ts';
import { ApiError } from './http.ts';

function assert(value: unknown, message = 'assertion failed'): asserts value { if (!value) throw new Error(message); }
async function rejects(run: () => Promise<unknown>, code: string) {
  try { await run(); } catch (error) { assert(error instanceof ApiError && error.code === code); return; }
  throw new Error(`expected ${code}`);
}
const id = '10000000-0000-4000-8000-000000000001';
const cap = 'a'.repeat(64);
const record = { code: 'PDD-TEST01', tail: '6001', resolution: 'open', visibility: 'active', revision: 1,
  lostRegistered: false, receivedRegistered: true, createdAt: '2026-10-06T08:00:00Z', updatedAt: '2026-10-06T08:00:00Z' };
function req(path: string, input: unknown, token = cap): Request {
  return new Request(`https://pdd404.app/v1/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': id }, body: JSON.stringify(input) });
}
function ctx(rpc: PddRouteContext['rpc'], enabled = true): PddRouteContext {
  return { rpc, admin: async () => { throw new ApiError('FORBIDDEN', 'admin only', 403); }, canRegister: async () => enabled };
}

Deno.test('exact lookup returns supplied opposite contact with a strict projection', async () => {
  let called = false;
  const response = await pddRoute(req('waybill-queries', { queryId: id, number: 'sf 990000006001', mode: 'lost', source: 'manual' }), ['waybill-queries'], { 'Cache-Control': 'no-store' }, ctx(async (name, payload) => {
    assert(name === 'pdd_query' && payload.number === 'SF990000006001');
    assert(payload.capability_hash.length === 64 && payload.capability_hash !== cap);
    called = true;
    return { queryId: id, result: 'matched', queriedAt: '2026-10-06T09:00:00Z', record: { ...record, number: 'SF990000006001', capability_hash: cap },
      registeredAt: '2026-10-06T08:00:00Z', contact: { kind: 'wechat', value: 'fictional_holder' }, address: 'synthetic secret address', capability: cap };
  }));
  assert(called && response?.headers.get('Cache-Control') === 'no-store');
  const value = (await response!.json()).data;
  assert(value.contact.value === 'fictional_holder');
  assert(!('address' in value) && !('capability' in value) && !('number' in value.record) && !('capability_hash' in value.record));
});

Deno.test('duplicate and public-code projections never return contacts or management fields', () => {
  const input = { ...record, contact: { kind: 'wechat', value: 'fictional_person' }, number: 'SF990000006001', capability_hash: cap, privateLink: '#key=secret' };
  const pub = pddPublic(input);
  const repeated = pddQuery({ queryId: id, result: 'duplicate', queriedAt: 'now', record: input, registeredAt: 'now', contact: input.contact });
  assert(repeated.contact === null && !('contact' in pub) && !('number' in pub) && !('privateLink' in pub));
});

Deno.test('lookup refuses short capability, alternate body fields and partial identifiers', async () => {
  const never = ctx(async () => { throw new Error('must not query DB'); });
  const input = { queryId: id, number: 'SF990000006001', mode: 'lost', source: 'manual' };
  await rejects(() => pddRoute(req('waybill-queries', input, 'short'), ['waybill-queries'], {}, never), 'FORBIDDEN');
  await rejects(() => pddRoute(req('waybill-queries', { ...input, includePrivate: true }), ['waybill-queries'], {}, never), 'INVALID_REQUEST');
  await rejects(() => pddRoute(req('waybill-queries', { ...input, number: '***6001' }), ['waybill-queries'], {}, never), 'INVALID_WAYBILL');
});

Deno.test('paused registrations preserve misses as queries rather than false successful registrations', async () => {
  const paused = ctx(async () => ({ queryId: id, result: 'not_found', queriedAt: 'now', record: null, registeredAt: null, contact: null }), false);
  const query = await pddRoute(req('waybill-queries', { queryId: id, number: 'SF990000006001', mode: 'lost', source: 'barcode' }), ['waybill-queries'], {}, paused);
  assert((await query!.json()).data.result === 'not_found');
  await rejects(() => pddRoute(req('waybill-batches', { mode: 'lost', contact: { kind: 'wechat', value: 'fictional_person' }, items: [{ requestId: id, number: 'SF990000006001', source: 'manual' }] }), ['waybill-batches'], {}, paused), 'SERVICE_UNAVAILABLE');
});

Deno.test('admin queries require administrator verification before DB access', async () => {
  await rejects(() => pddRoute(new Request('https://pdd404.app/v1/admin/waybill-queries'), ['admin', 'waybill-queries'], {}, ctx(async () => { throw new Error('must not query DB'); })), 'FORBIDDEN');
});
