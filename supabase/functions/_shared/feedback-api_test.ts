import { feedbackRoute } from './feedback-api.ts';
import { ApiError } from './http.ts';
function assert(value: unknown): asserts value { if (!value) throw new Error('assertion failed'); }
const id = '10000000-0000-4000-8000-000000000021';
const date = '2026-10-06T14:00:00Z';
const req = (input: unknown) => new Request('https://pdd404.app/v1/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': id }, body: JSON.stringify(input) });
async function rejects(run: () => Promise<unknown>, code: string) { try { await run(); } catch (error) { assert(error instanceof ApiError && error.code === code); return; } throw new Error('expected ' + code); }

Deno.test('feedback accepts anonymous suggestions but public receipt never exposes contact, message or capabilities', async () => {
  const response = await feedbackRoute(req({ message: '  Synthetic camera feedback\nSecond line  ', contact: { kind: 'wechat', value: 'synthetic_user' } }), ['feedback'], {}, {
    admin: async () => { throw new Error('not an admin route'); },
    rpc: async (name, payload) => { assert(name === 'pdd_feedback_submit' && payload.message === 'Synthetic camera feedback\nSecond line' && payload.contact.value === 'synthetic_user' && payload.body_hash.length === 64); return { submitted: true, feedbackId: id, submittedAt: date, message: payload.message, contact: payload.contact, capability: 'secret' }; },
  });
  assert(response?.status === 201);
  const data = (await response!.json()).data;
  assert(Object.keys(data).sort().join(',') === 'feedbackId,submitted,submittedAt');
});
Deno.test('feedback supports no contact, rejects unsafe or oversized input before database access', async () => {
  let calls = 0;
  const context = { admin: async () => '', rpc: async (_name: string, payload: Record<string, any>) => { calls++; assert(payload.contact === null); return { submitted: true, feedbackId: id, submittedAt: date }; } };
  await feedbackRoute(req({ message: 'Anonymous synthetic suggestion' }), ['feedback'], {}, context);
  assert(calls === 1);
  for (const input of [{ message: '' }, { message: 'x'.repeat(2001) }, { message: 'unsafe\u0000' }, { message: 'test', includePrivate: true }, { message: 'test', contact: { kind: 'wechat', value: 'bad' } }]) await rejects(() => feedbackRoute(req(input), ['feedback'], {}, context), 'message' in input && input.contact ? 'INVALID_CONTACT' : 'INVALID_REQUEST');
  assert(calls === 1);
});
Deno.test('feedback administration verifies administrator before reading or changing private feedback', async () => {
  const context = { admin: async () => { throw new ApiError('FORBIDDEN', 'admin only', 403); }, rpc: async () => { throw new Error('must not touch database'); } };
  await rejects(() => feedbackRoute(new Request('https://pdd404.app/v1/admin/feedback'), ['admin', 'feedback'], {}, context), 'FORBIDDEN');
  await rejects(() => feedbackRoute(new Request('https://pdd404.app/v1/admin/feedback/' + id, { method: 'PATCH' }), ['admin', 'feedback', id], {}, context), 'FORBIDDEN');
});
Deno.test('feedback admin projection drops unintended row data and audits status via verified actor', async () => {
  const row = { id, message: 'Synthetic suggestion', contact: null, status: 'reviewed', createdAt: date, updatedAt: date, requestId: id, capability: 'secret', address: 'not allowed' };
  const context = { admin: async () => id, rpc: async (name: string, payload: Record<string, any>) => { if (name === 'pdd_admin_feedback_list') return { items: [row], total: 1, nextOffset: null, secrets: 'not allowed' }; assert(name === 'pdd_admin_feedback_update' && payload.actor_id === id && payload.status === 'reviewed'); return row; } };
  const response = await feedbackRoute(new Request('https://pdd404.app/v1/admin/feedback?offset=0'), ['admin', 'feedback'], {}, context);
  const data = (await response!.json()).data;
  assert(Object.keys(data).sort().join(',') === 'items,nextOffset,total' && Object.keys(data.items[0]).sort().join(',') === 'contact,createdAt,id,message,status,updatedAt');
  const patch = new Request('https://pdd404.app/v1/admin/feedback/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'reviewed' }) });
  const changed = await feedbackRoute(patch, ['admin', 'feedback', id], {}, context);
  assert((await changed!.json()).data.status === 'reviewed');
});
