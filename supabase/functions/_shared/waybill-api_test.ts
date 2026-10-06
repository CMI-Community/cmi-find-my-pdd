import { pddRoute, pddPublic, pddQuery, pddBatchItem, pddHomeStats, type PddRouteContext } from './waybill-api.ts';
import { ApiError } from './http.ts';
import { canonicalJson, sha256 } from './security.ts';

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
      registeredAt: '2026-10-06T08:00:00Z', contact: { kind: 'wechat', value: 'fictional_holder' }, note: 'Synthetic blue box', address: 'synthetic secret address', capability: cap };
  }));
  assert(called && response?.headers.get('Cache-Control') === 'no-store');
  const value = (await response!.json()).data;
  assert(value.contact.value === 'fictional_holder');
  assert(value.note === 'Synthetic blue box');
  assert(!('address' in value) && !('capability' in value) && !('number' in value.record) && !('capability_hash' in value.record));
});

Deno.test('duplicate and public-code projections never return contacts or management fields', () => {
  const input = { ...record, contact: { kind: 'wechat', value: 'fictional_person' }, note: 'Synthetic private note', number: 'SF990000006001', capability_hash: cap, privateLink: '#key=secret' };
  const pub = pddPublic(input);
  const repeated = pddQuery({ queryId: id, result: 'duplicate', queriedAt: 'now', record: input, registeredAt: 'now', contact: input.contact, note: input.note });
  const item = pddBatchItem({ requestId: id, number: input.number, result: 'duplicate', record: input, registration: null, contact: input.contact, note: input.note, registeredAt: 'now' });
  assert(repeated.contact === null && repeated.note === null && item.note === null && !('note' in pub) && !('contact' in pub) && !('number' in pub) && !('privateLink' in pub));
});

Deno.test('lookup refuses short capability, alternate body fields and partial identifiers', async () => {
  const never = ctx(async () => { throw new Error('must not query DB'); });
  const input = { queryId: id, number: 'SF990000006001', mode: 'lost', source: 'manual' };
  await rejects(() => pddRoute(req('waybill-queries', input, 'short'), ['waybill-queries'], {}, never), 'FORBIDDEN');
  await rejects(() => pddRoute(req('waybill-queries', { ...input, includePrivate: true }), ['waybill-queries'], {}, never), 'INVALID_REQUEST');
  await rejects(() => pddRoute(req('waybill-queries', { ...input, number: '***6001' }), ['waybill-queries'], {}, never), 'INVALID_WAYBILL');
});

Deno.test('forwarding numbers cannot query or batch-register through old clients or fuzzy flags', async () => {
  let calls = 0;
  const never = ctx(async () => { calls++; throw new Error('must not query DB'); });
  for (const mode of ['lost', 'received']) for (const source of ['manual', 'barcode']) {
    for (const number of ['JTTH000990001', ' jtth 000990001 ', 'J T T H\u00a0000990001']) {
      for (const extra of [{}, { allowPossible: false }, { allowPossible: true }]) {
        await rejects(() => pddRoute(req('waybill-queries', { queryId: id, number, mode, source, ...extra }), ['waybill-queries'], {}, never), 'NON_DOMESTIC_WAYBILL');
      }
      await rejects(() => pddRoute(req('waybill-batches', { mode, contact: { kind: 'wechat', value: 'fictional_person' }, items: [
        { requestId: id, number: 'SF000990001', source },
        { requestId: '00000000-0000-4000-8000-000000000002', number, source },
      ] }), ['waybill-batches'], {}, never), 'NON_DOMESTIC_WAYBILL');
    }
    await rejects(() => pddRoute(req('waybill-queries', { queryId: id, number: 'JTTH00099?001', mode, source, allowPossible: true }), ['waybill-queries'], {}, never), 'NON_DOMESTIC_WAYBILL');
  }
  assert(calls === 0);
});

Deno.test('previously admitted forwarding registrations still project for private management and withdrawal', async () => {
  const historical = { registrationCode: 'PDD-R-SYNTHETIC', number: 'JTTH000990001', mode: 'lost', source: 'manual',
    contact: { kind: 'wechat', value: 'fictional_person' }, note: null, revision: 1, visibility: 'active', createdAt: 'now', updatedAt: 'now', record };
  const context = ctx(async (name) => {
    assert(['pdd_manage', 'pdd_manage_update'].includes(name));
    return { ...historical, visibility: name === 'pdd_manage_update' ? 'withdrawn' : 'active' };
  });
  const get = new Request('https://pdd404.app/v1/waybill-manage/PDD-R-SYNTHETIC', { headers: { Authorization: `Bearer ${cap}` } });
  assert((await (await pddRoute(get, ['waybill-manage', 'PDD-R-SYNTHETIC'], {}, context))!.json()).data.number === historical.number);
  const withdrawn = await pddRoute(req('waybill-manage/PDD-R-SYNTHETIC/withdraw', { revision: 1 }), ['waybill-manage', 'PDD-R-SYNTHETIC', 'withdraw'], {}, context);
  assert((await withdrawn!.json()).data.visibility === 'withdrawn');
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

Deno.test('home statistics allowlist is anonymous, genuine, and separate from registration availability', async () => {
  const result = await pddRoute(new Request('https://pdd404.app/v1/waybill-stats'), ['waybill-stats'], {}, ctx(async (name, payload) => {
    assert(name === 'pdd_home_stats' && Object.keys(payload).length === 0);
    return { lostRegistered: 0, receivedRegistered: 7, matchedParcels: 2, contacts: ['private'], handoverCount: 3 };
  }, false));
  const value = (await result!.json()).data;
  assert(JSON.stringify(value) === JSON.stringify({ lostRegistered: 0, receivedRegistered: 7, matchedParcels: 2 }));
  for (const count of [-1, 1.5, '4', null, Number.MAX_SAFE_INTEGER + 1]) {
    await rejects(async () => pddHomeStats({ lostRegistered: count, receivedRegistered: 0, matchedParcels: 0 }), 'SERVICE_UNAVAILABLE');
  }
});

Deno.test('old batch body hashes are unchanged and optional notes remain normalized outside the hash', async () => {
  const original = { mode: 'lost', contact: { kind: 'wechat', value: 'fictional_person' }, items: [{ requestId: id, number: 'SF990000006001', source: 'manual' }] };
  for (const input of [original, { ...original, note: '  Synthetic note  ' }]) {
    await pddRoute(req('waybill-batches', input), ['waybill-batches'], {}, ctx(async (name, payload) => {
      assert(name === 'pdd_batch_register' && payload.body_hash === await sha256(canonicalJson(input)));
      if ('note' in input) assert(payload.note === 'Synthetic note'); else assert(!('note' in payload));
      return { submittedAt: 'now', items: [] };
    }));
  }
  await rejects(() => pddRoute(req('waybill-batches', { ...original, note: 'x'.repeat(501) }), ['waybill-batches'], {}, ctx(async () => { throw new Error('must not call database'); })), 'INVALID_NOTE');
});

Deno.test('fuzzy query preserves unknown characters and strictly projects safe candidate fields', async () => {
  const response = await pddRoute(req('waybill-queries', { queryId: id, number: 'sf990?0000*001', mode: 'lost', source: 'manual', allowPossible: true }), ['waybill-queries'], {}, ctx(async (name, payload) => {
    assert(name === 'pdd_query' && payload.number === 'SF990?0000*001' && payload.allow_possible === true);
    return { queryId: id, result: 'possible', queriedAt: 'now', record: { ...record, number: 'SF990000006001' }, contact: { kind: 'wechat', value: 'fictional_private' }, note: 'Private candidate note', registeredAt: 'now',
      candidates: [{ code: 'PDD-TEST01', tail: '6001', similarity: 85.714285714, registeredAt: '2026-10-06T08:00:00Z', number: 'SF990000006001', contact: { kind: 'wechat', value: 'fictional_private' }, note: 'Private candidate note', capability_hash: cap }] };
  }));
  const data = (await response!.json()).data;
  assert(data.result === 'possible' && data.contact === null && data.note === null && data.record === null && data.registeredAt === null);
  assert(Object.keys(data.candidates[0]).sort().join(',') === 'code,registeredAt,similarity,tail');
  assert(!JSON.stringify(data).includes('fictional_private') && !JSON.stringify(data).includes('Private candidate note') && !JSON.stringify(data).includes('SF990000006001') && !JSON.stringify(data).includes(cap));
});

Deno.test('candidate confidence must be strictly above seventy and below full equality', async () => {
  const candidate = { code: 'PDD-TEST01', tail: '6001', similarity: 80, registeredAt: '2026-10-06T08:00:00Z' };
  const possible = { queryId: id, result: 'possible', queriedAt: 'now', candidates: [candidate] };
  for (const similarity of [70, 100, -1, '80', null, NaN]) await rejects(async () => pddQuery({ ...possible, candidates: [{ ...candidate, similarity }] }), 'SERVICE_UNAVAILABLE');
  for (const candidates of [[], undefined, Array.from({ length: 6 }, () => candidate)]) await rejects(async () => pddQuery({ ...possible, candidates }), 'SERVICE_UNAVAILABLE');
  const exact = pddQuery({ ...possible, result: 'matched', candidates: [{ ...candidate, contact: 'private' }], contact: { kind: 'wechat', value: 'fictional_private' }, note: 'Exact note' });
  assert(exact.candidates.length === 0 && exact.contact?.value === 'fictional_private' && exact.note === 'Exact note');
});

Deno.test('unknown-query syntax never permits incomplete registration or alternate private flags', async () => {
  const never = ctx(async () => { throw new Error('must not call database'); });
  const query = { queryId: id, number: 'ABCDEF?12', mode: 'lost', source: 'manual', allowPossible: true };
  for (const input of [{ ...query, number: '????12345' }, { ...query, includePrivate: true }]) await rejects(() => pddRoute(req('waybill-queries', input), ['waybill-queries'], {}, never), input.number === '????12345' ? 'INVALID_WAYBILL' : 'INVALID_REQUEST');
  await rejects(() => pddRoute(req('waybill-batches', { mode: 'lost', contact: { kind: 'wechat', value: 'fictional_person' }, items: [{ requestId: id, number: 'ABCDEF?12', source: 'manual' }] }), ['waybill-batches'], {}, never), 'INVALID_WAYBILL');
});

Deno.test('old exact-query clients retain their body hash and must explicitly opt in to suggestions', async () => {
  const oldInput = { queryId: id, number: 'ABCDEFGHXY', mode: 'lost', source: 'manual' };
  for (const input of [oldInput, { ...oldInput, allowPossible: false }, { ...oldInput, allowPossible: true }]) {
    await pddRoute(req('waybill-queries', input), ['waybill-queries'], {}, ctx(async (name, payload) => {
      assert(name === 'pdd_query' && payload.allow_possible === ('allowPossible' in input && input.allowPossible === true));
      assert(payload.body_hash === await sha256(canonicalJson(input)));
      return { queryId: id, result: 'not_found', queriedAt: 'now', record: null, contact: null, note: null, registeredAt: null, candidates: [] };
    }));
  }
  const never = ctx(async () => { throw new Error('must not call database'); });
  for (const allowPossible of [null, 'true', 1]) await rejects(() => pddRoute(req('waybill-queries', { ...oldInput, allowPossible }), ['waybill-queries'], {}, never), 'INVALID_REQUEST');
  await rejects(() => pddRoute(req('waybill-queries', { ...oldInput, number: 'ABCDEFGH?Y' }), ['waybill-queries'], {}, never), 'INVALID_WAYBILL');
});
