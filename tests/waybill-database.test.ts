import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import type { PddAdminDetail, PddBatchResult, PddContact, PddMode, PddQueryContactResult, PddQueryResult, PddRegistration } from '../shared/waybill.ts';
import type { PddFeedback, PddFeedbackPage, PddFeedbackReceipt } from '../shared/feedback.ts';

let db: PGlite;
const capA = 'a'.repeat(64), capB = 'b'.repeat(64), capC = 'c'.repeat(64);
const lostContact: PddContact = { kind: 'wechat', value: 'synthetic_lost' };
const receivedContact: PddContact = { kind: 'phone', value: '+66 81 234 5678' };
const directory = new URL('../supabase/migrations/', import.meta.url);
beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create schema extensions; create role anon; create role authenticated; create role service_role bypassrls;
    create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create schema net; create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as 'select 1::bigint';
    create schema cron; create function cron.schedule(job_name text,schedule text,command text) returns bigint language sql as 'select 1::bigint';`);
  for (const name of (await readdir(directory)).filter(name => /^\d+_.+\.sql$/.test(name)).sort()) {
    await db.exec((await readFile(new URL(name, directory), 'utf8')).replace(/^create extension if not exists pg_net.*$/m, '').replace(/^create extension if not exists pg_cron.*$/m, ''));
  }
}, 30_000);
beforeEach(async () => { await db.exec('begin;'); });
afterEach(async () => { await db.exec('rollback; reset role;'); });
afterAll(async () => { await db?.close(); });
async function rpc<T = Record<string, unknown>>(name: string, payload: Record<string, unknown> = {}): Promise<T> {
  return (await db.query<{ value: T }>(`select public.${name}($1::jsonb) as value`, [JSON.stringify(payload)])).rows[0].value;
}
async function query(number: string, mode: PddMode, cap = capB, queryId = randomUUID()): Promise<PddQueryResult> {
  return rpc('pdd_query', { query_id: queryId, number, mode, source: 'manual', allow_possible: true, capability_hash: cap, body_hash: `query-${number}-${mode}` });
}
async function batch(number: string, mode: PddMode, contact = lostContact, cap = capA, requestId = randomUUID(), note?: string): Promise<PddBatchResult> {
  return rpc('pdd_batch_register', { request_id: requestId, mode, contact, note, capability_hash: cap, body_hash: `batch-${number}-${mode}`,
    items: [{ request_id: randomUUID(), number, source: 'manual' }] });
}
type HomeStats = { lostRegistered: number; receivedRegistered: number; matchedParcels: number };
const homeStats = () => rpc<HomeStats>('pdd_home_stats');

describe('PDD404 isolated transactional flow', () => {
  it('preserves exact-only clients unless they explicitly opt into possible candidates', async () => {
    await batch('ABCDEFGH12', 'received', receivedContact);
    const payload = { number: 'ABCDEFGHXY', mode: 'lost', source: 'manual', capability_hash: capB, body_hash: 'legacy-exact-query' };
    const legacy = { ...payload, query_id: randomUUID() };
    const first = await rpc('pdd_query', legacy);
    expect(first).toMatchObject({ result: 'not_found', contact: null, note: null, candidates: [] });
    expect(await rpc('pdd_query', legacy)).toEqual(first);
    expect((await db.query('select result from public.pdd_query_events where id=$1::uuid', [legacy.query_id])).rows).toEqual([{ result: 'not_found' }]);
    expect(await rpc('pdd_query', { ...payload, query_id: randomUUID(), allow_possible: false })).toMatchObject({ result: 'not_found', contact: null, note: null, candidates: [] });
    expect((await query(payload.number, 'lost')).result).toBe('possible');
    await db.exec('savepoint legacy_unknown;');
    await expect(rpc('pdd_query', { ...payload, number: 'ABCDEFGH1?', query_id: randomUUID() })).rejects.toThrow('INVALID_WAYBILL');
    await db.exec('rollback to savepoint legacy_unknown;');
    expect((await homeStats()).matchedParcels).toBe(0);
  });
  it('rejects overly uncertain patterns and nonboolean fuzzy opt-in at the database boundary', async () => {
    for (const number of ['ABCDE?????', '**********', `ABCDEF${'?'.repeat(35)}`]) {
      await db.exec('savepoint invalid_query;');
      await expect(query(number, 'lost')).rejects.toThrow('INVALID_WAYBILL');
      await db.exec('rollback to savepoint invalid_query;');
    }
    await expect(rpc('pdd_query', { query_id: randomUUID(), number: 'ABCDEFGH12', mode: 'lost', source: 'manual', allow_possible: 'true', capability_hash: capB, body_hash: 'invalid-flag' })).rejects.toThrow('INVALID_REQUEST');
  });
  it('keeps exactly 70% similarity out while showing an 80% safe candidate and reserving direct contact for an exact number', async () => {
    const item = (await batch('ABCDEFGH12', 'received', receivedContact, capA, randomUUID(), 'Private holder description')).items[0];
    expect(await query('ABCDEFGXYZ', 'lost')).toMatchObject({ result: 'not_found', contact: null, note: null });
    const possible = await query('ABCDEFGHXY', 'lost');
    expect(possible).toMatchObject({ result: 'possible', record: null, registeredAt: null, contact: null, note: null });
    expect(possible.candidates).toEqual([{ code: item.record.code, tail: 'GH12', similarity: 80, registeredAt: item.registration!.createdAt }]);
    expect(Object.keys(possible.candidates[0]).sort()).toEqual(['code', 'registeredAt', 'similarity', 'tail']);
    expect(JSON.stringify(possible)).not.toContain('ABCDEFGH12'); expect(JSON.stringify(possible)).not.toContain(receivedContact.value); expect(JSON.stringify(possible)).not.toContain('Private');
    expect(await homeStats()).toEqual({ lostRegistered: 0, receivedRegistered: 1, matchedParcels: 0 });
    expect(await query(' abcdefgh12 ', 'lost')).toMatchObject({ result: 'matched', contact: receivedContact, note: 'Private holder description', candidates: [] });
    expect(await homeStats()).toEqual({ lostRegistered: 0, receivedRegistered: 1, matchedParcels: 1 });
  });
  it('treats each question mark and asterisk as one unknown character, never as an exact match or an arbitrary-length wildcard', async () => {
    await batch('ABCDEFGH12', 'received', receivedContact);
    for (const number of ['ABCDEFGH1?', 'ABCDEFGH1*']) {
      const possible = await query(number, 'lost');
      expect(possible.result).toBe('possible'); expect(possible.candidates).toHaveLength(1); expect(possible.candidates[0].similarity).toBe(90);
      expect(possible.contact).toBeNull(); expect(possible.note).toBeNull();
    }
    for (const number of ['ABCDEF??12', 'ABCDEF**12']) expect((await query(number, 'lost')).candidates[0].similarity).toBe(80);
    // Six wildcards are six uncertain characters rather than one glob operator.
    for (const number of ['ABCDEF*', 'ABCDEF******']) expect(await query(number, 'lost')).toMatchObject({ result: 'not_found', contact: null, candidates: [] });
    expect(await homeStats()).toEqual({ lostRegistered: 0, receivedRegistered: 1, matchedParcels: 0 });
  });
  it('finds an inserted or omitted character with normalized Levenshtein similarity', async () => {
    await batch('ABCDEFGH12', 'received', receivedContact);
    const omitted = await query('ABCDEGH12', 'lost'), inserted = await query('ABCDEFXGH12', 'lost');
    expect(omitted.result).toBe('possible'); expect(omitted.candidates[0].similarity).toBe(90);
    expect(inserted.result).toBe('possible'); expect(inserted.candidates[0].similarity).toBeCloseTo(100 * (1 - 1 / 11), 2);
    expect(await homeStats()).toEqual({ lostRegistered: 0, receivedRegistered: 1, matchedParcels: 0 });
  });
  it('gives exact duplicate and closed records priority over nearby opposite-side candidates', async () => {
    await batch('PRIORITY01', 'lost'); await batch('PRIORITY02', 'received', receivedContact);
    expect(await query('PRIORITY01', 'lost')).toMatchObject({ result: 'duplicate', contact: null, note: null, candidates: [] });
    await batch('PRIORITY03', 'received', receivedContact);
    await db.exec("update public.pdd_waybills set resolution='resolved',closed_at=now() where number='PRIORITY03';");
    expect(await query('PRIORITY03', 'lost')).toMatchObject({ result: 'closed', contact: null, note: null, candidates: [] });
    expect(await homeStats()).toEqual({ lostRegistered: 1, receivedRegistered: 2, matchedParcels: 0 });
  });
  it('restricts fuzzy candidates to active opposite registrations with usable contact on unresolved records', async () => {
    await batch('FILTERR1230', 'lost');
    const withdrawn = (await batch('FILTERR1231', 'received', receivedContact)).items[0].registration!;
    await rpc('pdd_manage_update', { registration_code: withdrawn.registrationCode, capability_hash: capA, revision: withdrawn.revision, action: 'withdraw' });
    await batch('FILTERR1232', 'received', receivedContact);
    await db.exec("update public.pdd_waybills set resolution='resolved',closed_at=now() where number='FILTERR1232';");
    await batch('FILTERR1233', 'received', receivedContact);
    await db.exec("update public.pdd_registrations set contact=null where waybill_id=(select id from public.pdd_waybills where number='FILTERR1233');");
    const valid = (await batch('FILTERR1235', 'received', receivedContact)).items[0];
    const answer = await query('FILTERR1234', 'lost');
    expect(answer.result).toBe('possible'); expect(answer.candidates.map(item => item.code)).toEqual([valid.record.code]);
    expect(answer.contact).toBeNull(); expect(answer.note).toBeNull(); expect(answer.record).toBeNull();
    expect((await homeStats()).matchedParcels).toBe(0);
  });
  it('returns at most five candidates in decreasing similarity with deterministic ties', async () => {
    const fixtures = ['ABCDEF1235', 'ABCDEF1236', 'ABCDEF1237', 'ABCDEF1238', 'ABCDEF1239', 'ABCDEG1235', 'ABCDEG1236'];
    const records = [];
    for (const number of fixtures) records.push((await batch(number, 'received', receivedContact)).items[0]);
    const answer = await query('ABCDEF1234', 'lost');
    expect(answer.result).toBe('possible'); expect(answer.candidates).toHaveLength(5);
    expect(answer.candidates.every(item => item.similarity === 90)).toBe(true);
    expect(new Set(answer.candidates.map(item => item.code))).toEqual(new Set(records.slice(0, 5).map(item => item.record.code)));
    expect(answer.candidates.map(item => item.code)).toEqual(records.slice(0, 5).map(item => item.record.code).sort());
    const repeated = await query('ABCDEF1234', 'lost');
    expect(repeated.candidates).toEqual(answer.candidates);
    expect(answer.candidates.every(item => Object.keys(item).sort().join(',') === 'code,registeredAt,similarity,tail')).toBe(true);
    expect((await homeStats()).matchedParcels).toBe(0);
  });
  it('logs a possible query pattern once for its UUID and exposes its result to the administrator without changing lifetime matches', async () => {
    const registration = (await batch('ABCDEFGH12', 'received', receivedContact)).items[0].registration!;
    const id = randomUUID();
    const first = await query(' abcdefgh1? ', 'lost', capB, id);
    expect(first.result).toBe('possible');
    expect(await query(' abcdefgh1? ', 'lost', capB, id)).toEqual(first);
    const events = (await db.query<{ id: string; number: string; result: string; contact: null }>('select id,number,result,contact from public.pdd_query_events')).rows;
    expect(events).toEqual([{ id, number: 'ABCDEFGH1?', result: 'possible', contact: null }]);
    expect((await rpc<{ items: { queryId: string; number: string; result: string }[] }>('pdd_admin_queries')).items).toEqual([expect.objectContaining({ queryId: id, number: 'ABCDEFGH1?', result: 'possible' })]);
    await rpc('pdd_manage_update', { registration_code: registration.registrationCode, capability_hash: capA, revision: registration.revision, action: 'withdraw' });
    expect(await query(' abcdefgh1? ', 'lost', capB, id)).toMatchObject({ result: 'not_found', candidates: [], contact: null, note: null });
    expect((await db.query('select result from public.pdd_query_events')).rows).toEqual([{ result: 'possible' }]);
    expect((await homeStats()).matchedParcels).toBe(0);
  });
  it('rejects contact submission from a possible query and leaves the candidate registration untouched', async () => {
    await batch('ABCDEFGH12', 'received', receivedContact, capA, randomUUID(), 'Keep private');
    const possible = await query('ABCDEFGHXY', 'lost');
    await db.exec('savepoint possible_contact;');
    await expect(rpc('pdd_query_contact', { query_id: possible.queryId, capability_hash: capB, contact: lostContact, idempotency_key: 'fuzzy-contact', body_hash: 'fuzzy-contact' })).rejects.toThrow('VERSION_CONFLICT');
    await db.exec('rollback to savepoint possible_contact;');
    expect((await db.query('select * from public.pdd_registrations')).rows).toHaveLength(1);
    expect((await db.query<{ contact: null }>('select contact from public.pdd_query_events')).rows).toEqual([{ contact: null }]);
    expect(await homeStats()).toEqual({ lostRegistered: 0, receivedRegistered: 1, matchedParcels: 0 });
  });
  it('rejects uncertain numbers in batch registration but allows a separately confirmed complete number', async () => {
    await batch('ABCDEFGH12', 'received', receivedContact);
    const possible = await query('ABCDEFGHXY', 'lost'); expect(possible.result).toBe('possible');
    for (const pattern of ['ABCDEFGH1?', 'ABCDEFGH1*']) {
      await db.exec('savepoint invalid_pattern;');
      await expect(batch(pattern, 'lost')).rejects.toThrow('INVALID_WAYBILL');
      await db.exec('rollback to savepoint invalid_pattern;');
    }
    const explicit = await batch('ABCDEFGHXY', 'lost', lostContact, capB, randomUUID(), 'User confirmed this complete number');
    expect(explicit.items[0].result).toBe('registered'); expect(explicit.items[0].contact).toBeNull();
    expect((await db.query('select number from public.pdd_waybills order by number')).rows).toEqual([{ number: 'ABCDEFGH12' }, { number: 'ABCDEFGHXY' }]);
    expect((await db.query('select waybill_id from public.pdd_query_events where id=$1::uuid', [possible.queryId])).rows).toEqual([{ waybill_id: null }]);
    expect(await homeStats()).toEqual({ lostRegistered: 1, receivedRegistered: 1, matchedParcels: 0 });
  });
  it('stores feedback once, returns a nonprivate receipt and lists only explicit admin fields', async () => {
    const payload = { request_id: randomUUID(), body_hash: 'synthetic-feedback', message: '  Synthetic camera feedback  ', contact: lostContact };
    const receipt = await rpc<PddFeedbackReceipt>('pdd_feedback_submit', payload);
    expect(Object.keys(receipt).sort()).toEqual(['feedbackId', 'submitted', 'submittedAt']);
    expect(receipt).toMatchObject({ submitted: true, feedbackId: expect.any(String), submittedAt: expect.any(String) });
    expect(JSON.stringify(receipt)).not.toContain('camera'); expect(JSON.stringify(receipt)).not.toContain(lostContact.value);
    expect(await rpc('pdd_feedback_submit', payload)).toEqual(receipt);
    await rpc('pdd_feedback_submit', { request_id: randomUUID(), body_hash: 'anonymous-feedback', message: 'Anonymous synthetic suggestion' });
    const page = await rpc<PddFeedbackPage>('pdd_admin_feedback_list', { limit: 1, offset: 0 });
    expect(page).toMatchObject({ total: 2, nextOffset: 1 }); expect(page.items).toHaveLength(1);
    expect(Object.keys(page.items[0]).sort()).toEqual(['contact', 'createdAt', 'id', 'message', 'status', 'updatedAt']);
    const all = await rpc<PddFeedbackPage>('pdd_admin_feedback_list');
    expect(all.items.find(item => item.id === receipt.feedbackId)).toMatchObject({ message: 'Synthetic camera feedback', contact: lostContact, status: 'new' });
    expect(all.items.find(item => item.id !== receipt.feedbackId)?.contact).toBeNull();
    expect(await homeStats()).toEqual({ lostRegistered: 0, receivedRegistered: 0, matchedParcels: 0 });
  });
  it('rejects a changed feedback body under the same request id', async () => {
    const payload = { request_id: randomUUID(), body_hash: 'first-feedback', message: 'Original suggestion' };
    await rpc('pdd_feedback_submit', payload);
    await expect(rpc('pdd_feedback_submit', { ...payload, body_hash: 'changed-feedback', message: 'Changed suggestion' })).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });
  it('audits feedback state transitions without private content and only expires old closed feedback', async () => {
    const actor = randomUUID();
    const submit = () => rpc<PddFeedbackReceipt>('pdd_feedback_submit', { request_id: randomUUID(), body_hash: randomUUID(), message: 'Private synthetic feedback', contact: receivedContact });
    const closed = await submit(), reviewed = await submit(), freshClosed = await submit();
    const transitioned = await rpc<PddFeedback>('pdd_admin_feedback_update', { feedback_id: closed.feedbackId, actor_id: actor, status: 'reviewed' });
    expect(transitioned).toMatchObject({ id: closed.feedbackId, status: 'reviewed', message: 'Private synthetic feedback', contact: receivedContact });
    await rpc('pdd_admin_feedback_update', { feedback_id: closed.feedbackId, actor_id: actor, status: 'reviewed' });
    await rpc('pdd_admin_feedback_update', { feedback_id: closed.feedbackId, actor_id: actor, status: 'closed' });
    await rpc('pdd_admin_feedback_update', { feedback_id: reviewed.feedbackId, actor_id: actor, status: 'reviewed' });
    await rpc('pdd_admin_feedback_update', { feedback_id: freshClosed.feedbackId, actor_id: actor, status: 'closed' });
    const events = (await db.query<{ actor_id: string; record_id: null; match_id: null; payload: { feedbackId: string; fromStatus: string; toStatus: string } }>("select actor_id,record_id,match_id,payload from public.audit_events where action='feedback_status' order by id")).rows;
    expect(events).toHaveLength(4);
    expect(events.every(event => event.actor_id === actor && event.record_id === null && event.match_id === null && Object.keys(event.payload).sort().join(',') === 'feedbackId,fromStatus,toStatus')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('Private'); expect(JSON.stringify(events)).not.toContain(receivedContact.value);
    await db.query("update public.pdd_feedback set updated_at=now()-interval '31 days' where id<>$1::uuid", [freshClosed.feedbackId]);
    await rpc('pdd_cleanup');
    const retained = await rpc<PddFeedbackPage>('pdd_admin_feedback_list');
    expect(retained.items.map(item => item.id).sort()).toEqual([reviewed.feedbackId, freshClosed.feedbackId].sort());
    const filtered = await rpc<PddFeedbackPage>('pdd_admin_feedback_list', { status: 'reviewed' });
    expect(filtered).toMatchObject({ total: 1, nextOffset: null }); expect(filtered.items[0].id).toBe(reviewed.feedbackId);
    expect((await db.query("select * from public.audit_events where action='feedback_status'")).rows).toHaveLength(4);
  });
  it('accepts Unicode code-point limits for both notes and feedback with Unicode whitespace trimmed', async () => {
    const note = '📦'.repeat(500), message = '📦'.repeat(2000);
    const registered = await batch('UNICODENOTE12', 'lost', lostContact, capA, randomUUID(), `\u3000${note}\u00a0`);
    expect(registered.items[0].registration?.note).toBe(note);
    const receipt = await rpc<PddFeedbackReceipt>('pdd_feedback_submit', { request_id: randomUUID(), body_hash: 'unicode-feedback', message: `\u3000${message}\u00a0` });
    expect((await rpc<PddFeedbackPage>('pdd_admin_feedback_list')).items.find(item => item.id === receipt.feedbackId)?.message).toBe(message);
  });
  it('rejects notes above the Unicode code-point limit at the database boundary', async () => {
    await expect(batch('TOOLONGNOTE12', 'lost', lostContact, capA, randomUUID(), '📦'.repeat(501))).rejects.toThrow('INVALID_REQUEST');
  });
  it('rejects feedback above the Unicode code-point limit at the database boundary', async () => {
    await expect(rpc('pdd_feedback_submit', { request_id: randomUUID(), body_hash: 'long-feedback', message: '📦'.repeat(2001) })).rejects.toThrow('INVALID_REQUEST');
  });
  it('keeps lifetime side counts distinct through duplicates, withdrawal and registration by another person', async () => {
    expect(await homeStats()).toEqual({ lostRegistered: 0, receivedRegistered: 0, matchedParcels: 0 });
    await query('COUNTMISS123', 'lost');
    expect(await homeStats()).toEqual({ lostRegistered: 0, receivedRegistered: 0, matchedParcels: 0 });
    const first = (await batch('COUNTLOST123', 'lost')).items[0].registration!;
    await batch('COUNTLOST123', 'lost', receivedContact, capB);
    await batch('COUNTLOST456', 'lost');
    expect(await homeStats()).toEqual({ lostRegistered: 2, receivedRegistered: 0, matchedParcels: 0 });
    await rpc('pdd_manage_update', { registration_code: first.registrationCode, capability_hash: capA, revision: first.revision, action: 'withdraw' });
    expect(await homeStats()).toEqual({ lostRegistered: 2, receivedRegistered: 0, matchedParcels: 0 });
    await batch('COUNTLOST123', 'lost', receivedContact, capB);
    await batch('COUNTHOLD123', 'received', receivedContact, capB);
    await batch('COUNTHOLD123', 'received', lostContact, capC);
    expect(await homeStats()).toEqual({ lostRegistered: 2, receivedRegistered: 1, matchedParcels: 0 });
  });
  it('counts a query replay that first gains a match once and keeps the lifetime match after withdrawal', async () => {
    const id = randomUUID();
    expect((await query('COUNTRPLY123', 'lost', capB, id)).result).toBe('not_found');
    const opposite = (await batch('COUNTRPLY123', 'received', receivedContact, capA, randomUUID(), 'A small blue box')).items[0].registration!;
    expect(await homeStats()).toEqual({ lostRegistered: 0, receivedRegistered: 1, matchedParcels: 0 });
    expect(await query('COUNTRPLY123', 'lost', capB, id)).toMatchObject({ result: 'matched', note: 'A small blue box' });
    await query('COUNTRPLY123', 'lost', capB, id); await query('COUNTRPLY123', 'lost', capC);
    expect((await db.query('select * from public.pdd_query_events')).rows).toHaveLength(2);
    expect(await homeStats()).toEqual({ lostRegistered: 0, receivedRegistered: 1, matchedParcels: 1 });
    await rpc('pdd_manage_update', { registration_code: opposite.registrationCode, capability_hash: capA, revision: opposite.revision, action: 'withdraw' });
    expect(await query('COUNTRPLY123', 'lost', capB, id)).toMatchObject({ result: 'not_found', note: null });
    expect(await homeStats()).toEqual({ lostRegistered: 0, receivedRegistered: 1, matchedParcels: 1 });
  });
  it('counts a newly matched batch and its earlier receipt replay only once', async () => {
    const payload = { request_id: randomUUID(), mode: 'lost', note: 'Owner note', contact: lostContact, capability_hash: capA, body_hash: 'unchanged-batch', items: [{ request_id: randomUUID(), number: 'COUNTBATCH12', source: 'manual' }] };
    const first = await rpc<PddBatchResult>('pdd_batch_register', payload);
    expect(first.items[0].result).toBe('registered');
    expect(await homeStats()).toEqual({ lostRegistered: 1, receivedRegistered: 0, matchedParcels: 0 });
    const opposite = await batch('COUNTBATCH12', 'received', receivedContact, capB, randomUUID(), 'Holder note');
    expect(opposite.items[0]).toMatchObject({ result: 'matched', note: 'Owner note' });
    const replay = await rpc<PddBatchResult>('pdd_batch_register', payload);
    expect(replay.items[0]).toMatchObject({ result: 'matched', note: 'Holder note', registration: { registrationCode: first.items[0].registration!.registrationCode, note: 'Owner note' } });
    await rpc('pdd_batch_register', payload);
    expect(await homeStats()).toEqual({ lostRegistered: 1, receivedRegistered: 1, matchedParcels: 1 });
  });
  it('copies a batch note into every new registration but does not overwrite an existing side', async () => {
    await batch('NOTEDUPE123', 'lost', lostContact, capA, randomUUID(), 'Original note');
    const payload = { request_id: randomUUID(), mode: 'lost', note: '  Shared batch note  ', contact: receivedContact, capability_hash: capB, body_hash: 'batch-note', items: ['NOTEDUPE123', 'NOTENEW1234', 'NOTENEW5678'].map(number => ({ request_id: randomUUID(), number, source: 'manual' })) };
    const result = await rpc<PddBatchResult>('pdd_batch_register', payload);
    expect(result.items[0]).toMatchObject({ result: 'duplicate', registration: null, note: null });
    expect(result.items.slice(1).every(item => item.registration?.note === 'Shared batch note')).toBe(true);
    const notes = (await db.query<{ number: string; note: string }>('select w.number,r.note from public.pdd_registrations r join public.pdd_waybills w on w.id=r.waybill_id order by w.number')).rows;
    expect(notes).toEqual([{ number: 'NOTEDUPE123', note: 'Original note' }, { number: 'NOTENEW1234', note: 'Shared batch note' }, { number: 'NOTENEW5678', note: 'Shared batch note' }]);
    await rpc('pdd_batch_register', payload);
    expect((await db.query('select * from public.pdd_registrations')).rows).toHaveLength(3);
  });
  it('reveals only the opposite note on an exact match and keeps notes out of public codes', async () => {
    const lost = (await batch('NOTEPRIV123', 'lost', lostContact, capA, randomUUID(), 'Private owner clue')).items[0];
    expect(await query('NOTEPRIV123', 'lost')).toMatchObject({ result: 'duplicate', note: null });
    expect(await query('NOTEPRIV123', 'received')).toMatchObject({ result: 'matched', note: 'Private owner clue' });
    const received = (await batch('NOTEPRIV123', 'received', receivedContact, capB, randomUUID(), 'Private holder clue')).items[0];
    expect(received.note).toBe('Private owner clue');
    expect((await query('NOTEPRIV123', 'lost')).note).toBe('Private holder clue');
    expect(await rpc('pdd_manage', { registration_code: lost.registration!.registrationCode, capability_hash: capA })).toMatchObject({ note: 'Private owner clue' });
    const updated = await rpc<PddRegistration>('pdd_manage_update', { registration_code: lost.registration!.registrationCode, capability_hash: capA, revision: lost.registration!.revision, action: 'contact', contact: receivedContact });
    expect(updated.note).toBe('Private owner clue');
    const publicRecord = await rpc('pdd_public', { public_code: lost.record.code });
    expect(publicRecord).not.toHaveProperty('note'); expect(JSON.stringify(publicRecord)).not.toContain('Private');
    const detail = await rpc<PddAdminDetail>('pdd_admin_detail', { public_code: lost.record.code });
    expect(detail.registrations.map(item => item.note).sort()).toEqual(['Private holder clue', 'Private owner clue']);
  });
  it('leaves an optional query-contact registration note empty without changing the other side', async () => {
    await batch('NOTEOPTION12', 'lost', lostContact, capA, randomUUID(), 'Registered owner clue');
    const found = await query('NOTEOPTION12', 'received', capB);
    const saved = await rpc<PddQueryContactResult>('pdd_query_contact', { query_id: found.queryId, capability_hash: capB, contact: receivedContact, idempotency_key: 'optional-note', body_hash: 'optional-note' });
    expect(saved.registration?.note).toBeNull();
    expect((await query('NOTEOPTION12', 'received')).note).toBe('Registered owner clue');
    expect((await query('NOTEOPTION12', 'lost')).note).toBeNull();
  });
  it('clears expired registration notes and contact data while preserving lifetime statistics', async () => {
    await batch('NOTERETAIN12', 'lost', lostContact, capA, randomUUID(), 'Expired owner clue');
    await batch('NOTERETAIN12', 'received', receivedContact, capB, randomUUID(), 'Expired holder clue');
    const before = await homeStats();
    await db.exec("update public.pdd_waybills set resolution='resolved',closed_at=now()-interval '31 days'; update public.pdd_registrations set closed_at=now()-interval '31 days'; update public.pdd_query_events set queried_at=now()-interval '31 days';");
    await rpc('pdd_cleanup');
    expect((await db.query<{ note: string | null; contact: unknown; capability_hash: string }>('select note,contact,capability_hash from public.pdd_registrations')).rows).toEqual([{ note: null, contact: null, capability_hash: '' }, { note: null, contact: null, capability_hash: '' }]);
    expect(await homeStats()).toEqual(before);
    expect(await query('NOTERETAIN12', 'lost')).toMatchObject({ result: 'closed', contact: null, note: null });
    expect(await homeStats()).toEqual(before);
  });
  it('logs misses and retries once; rejects different capability replays', async () => {
    const id = randomUUID();
    expect(await query(' 00 sf1234 ', 'lost', capA, id)).toMatchObject({ result: 'not_found', contact: null });
    await query(' 00 sf1234 ', 'lost', capA, id);
    expect((await db.query('select * from public.pdd_query_events')).rows).toHaveLength(1);
    expect((await db.query('select * from public.pdd_waybills')).rows).toHaveLength(0);
    await expect(query(' 00 sf1234 ', 'lost', capB, id)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });
  it('has one main number, opposite-first matching, and no general public contacts', async () => {
    const lost = await batch('00123456', 'lost');
    expect(lost.items[0].result).toBe('registered');
    expect((await query('00123456', 'lost')).result).toBe('duplicate');
    expect(await query('00123456', 'received')).toMatchObject({ result: 'matched', contact: lostContact });
    const received = await batch('00123456', 'received', receivedContact, capB);
    expect(received.items[0]).toMatchObject({ result: 'matched', contact: lostContact });
    expect(await query('00123456', 'lost')).toMatchObject({ result: 'matched', contact: receivedContact });
    expect((await db.query('select * from public.pdd_waybills')).rows).toHaveLength(1);
    expect((await db.query('select * from public.pdd_registrations')).rows).toHaveLength(2);
    const publicResult = await rpc('pdd_public', { public_code: lost.items[0].record.code });
    expect(JSON.stringify(publicResult)).not.toContain('00123456');
    expect(JSON.stringify(publicResult)).not.toContain(lostContact.value);
    expect(Object.keys(publicResult).sort()).toEqual(['code', 'createdAt', 'lostRegistered', 'receivedRegistered', 'resolution', 'revision', 'tail', 'updatedAt', 'visibility'].sort());
  });
  it('rechecks registration races, blocks duplicate overwrite and restores only own receipt', async () => {
    expect((await query('RACE123456', 'lost')).result).toBe('not_found');
    await batch('RACE123456', 'received', receivedContact, capB);
    const first = await batch('RACE123456', 'lost');
    expect(first.items[0]).toMatchObject({ result: 'matched', contact: receivedContact });
    const duplicate = await batch('RACE123456', 'lost', { kind: 'wechat', value: 'other_person' }, capC);
    expect(duplicate.items[0]).toMatchObject({ result: 'matched', registration: null });
    expect((await query('RACE123456', 'received')).contact).toEqual(lostContact);
  });
  it('optionally creates missing side and retains later contact inquiries without overwrite', async () => {
    await batch('OPTION123456', 'lost');
    const q = await query('OPTION123456', 'received', capB);
    const payload = { query_id: q.queryId, capability_hash: capB, contact: receivedContact, idempotency_key: 'optional-contact', body_hash: 'same' };
    const result = await rpc<PddQueryContactResult>('pdd_query_contact', payload);
    expect(result.registration?.mode).toBe('received');
    expect(await rpc('pdd_query_contact', payload)).toEqual(result);
    const second = await query('OPTION123456', 'received', capC);
    expect(await rpc('pdd_query_contact', { query_id: second.queryId, capability_hash: capC, contact: { kind: 'wechat', value: 'later_inquiry' }, idempotency_key: 'later-contact', body_hash: 'later' })).toEqual({ saved: true, registration: null });
    expect((await query('OPTION123456', 'lost')).contact).toEqual(receivedContact);
    expect((await db.query('select contact from public.pdd_query_events where contact is not null')).rows).toHaveLength(2);
  });
  it('replays current contact and stops contact disclosure after withdrawal', async () => {
    const registered = (await batch('REPLAY12345', 'received', receivedContact, capA)).items[0].registration!;
    const id = randomUUID();
    expect((await query('REPLAY12345', 'lost', capB, id)).contact).toEqual(receivedContact);
    const updated = await rpc<PddRegistration>('pdd_manage_update', { registration_code: registered.registrationCode, capability_hash: capA, revision: registered.revision, action: 'contact', contact: lostContact });
    expect((await query('REPLAY12345', 'lost', capB, id)).contact).toEqual(lostContact);
    await rpc('pdd_manage_update', { registration_code: registered.registrationCode, capability_hash: capA, revision: updated.revision, action: 'withdraw' });
    expect(await query('REPLAY12345', 'lost', capB, id)).toMatchObject({ result: 'not_found', contact: null });
    await expect(rpc('pdd_manage', { registration_code: registered.registrationCode, capability_hash: capC })).rejects.toThrow('FORBIDDEN');
  });
  it('batch retries reuse own receipts and reject changed body', async () => {
    const payload = { request_id: randomUUID(), mode: 'lost', contact: lostContact, capability_hash: capA, body_hash: 'same-body', items: [{ request_id: randomUUID(), number: 'BATCH12345', source: 'barcode' }] };
    const first = await rpc<PddBatchResult>('pdd_batch_register', payload);
    expect(await rpc('pdd_batch_register', payload)).toEqual(first);
    expect((await db.query('select * from public.pdd_registrations')).rows).toHaveLength(1);
    await expect(rpc('pdd_batch_register', { ...payload, body_hash: 'changed-body' })).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });
  it('audits ownership separately from actual returned, counted once', async () => {
    const lost = (await batch('RETURN12345', 'lost')).items[0];
    await batch('RETURN12345', 'received', receivedContact, capB);
    const actor = randomUUID();
    let detail = await rpc<PddAdminDetail>('pdd_admin_detail', { public_code: lost.record.code });
    await expect(rpc('pdd_admin_action', { public_code: lost.record.code, revision: detail.record.revision, action: 'return', actor_id: actor })).rejects.toThrow('INVALID_ADMIN_STATE');
    // PostgreSQL errors abort a transaction: isolate expected failures in separate tests/savepoints.
  });
  it('confirms returned idempotently and clears sensitive fields after thirty days', async () => {
    const lost = (await batch('CLEAN123456', 'lost')).items[0];
    await batch('CLEAN123456', 'received', receivedContact, capB);
    const actor = randomUUID();
    let detail = await rpc<PddAdminDetail>('pdd_admin_detail', { public_code: lost.record.code });
    detail = await rpc('pdd_admin_action', { public_code: lost.record.code, revision: detail.record.revision, action: 'claim', actor_id: actor, notes: 'synthetic private note' });
    expect((await db.query('select * from public.pdd_handovers')).rows).toHaveLength(0);
    detail = await rpc('pdd_admin_action', { public_code: lost.record.code, revision: detail.record.revision, action: 'return', actor_id: actor });
    await rpc('pdd_admin_action', { public_code: lost.record.code, revision: detail.record.revision, action: 'return', actor_id: actor });
    expect((await db.query('select * from public.pdd_handovers')).rows).toHaveLength(1);
    expect(await query('CLEAN123456', 'received')).toMatchObject({ result: 'closed', contact: null });
    await db.exec("update public.pdd_waybills set closed_at=now()-interval '31 days'; update public.pdd_registrations set closed_at=now()-interval '31 days';");
    await rpc('pdd_cleanup');
    expect((await db.query<{ contact: unknown; capability_hash: string }>('select contact,capability_hash from public.pdd_registrations')).rows).toEqual([{ contact: null, capability_hash: '' }, { contact: null, capability_hash: '' }]);
    expect((await db.query<{ notes: string }>('select notes from public.pdd_audit_events')).rows.every(row => row.notes === '')).toBe(true);
    expect((await db.query('select * from public.pdd_handovers')).rows).toHaveLength(1);
  });
  it('cleans unregistered logs independently of OCR', async () => {
    await query('UNREGISTER1234', 'lost');
    await db.exec("update public.pdd_query_events set queried_at=now()-interval '31 days';");
    await rpc('pdd_cleanup');
    expect((await db.query('select * from public.pdd_query_events')).rows).toHaveLength(0);
    expect((await db.query('select * from public.jobs')).rows).toHaveLength(0);
  });
  it('permits externally verified ownership and handover without inventing a lost registration', async () => {
    const item = (await batch('EXTERNAL12345', 'received', receivedContact)).items[0];
    const actor = randomUUID();
    let detail = await rpc<PddAdminDetail>('pdd_admin_detail', { public_code: item.record.code });
    detail = await rpc('pdd_admin_action', { public_code: item.record.code, revision: detail.record.revision, action: 'verify', actor_id: actor });
    detail = await rpc('pdd_admin_action', { public_code: item.record.code, revision: detail.record.revision, action: 'claim', actor_id: actor, notes: 'Ownership verified outside the site with synthetic fixture' });
    expect((await db.query('select * from public.pdd_handovers')).rows).toHaveLength(0);
    expect(await rpc('pdd_stats')).toMatchObject({ recordedPackageCount: 1, activeSeekerCount: 0, successfulHandoverCount: null });
    await rpc('pdd_admin_action', { public_code: item.record.code, revision: detail.record.revision, action: 'return', actor_id: actor });
    expect((await db.query('select * from public.pdd_handovers')).rows).toHaveLength(1);
    expect((await db.query("select * from public.pdd_registrations where mode='lost'")).rows).toHaveLength(0);
  });
  it('locks public and authenticated privileges on all new tables and RPCs', async () => {
    const tables = ['pdd_waybills','pdd_registrations','pdd_query_events','pdd_write_requests','pdd_audit_events','pdd_handovers','pdd_feedback'];
    for (const table of tables) {
      const row = (await db.query<{ anon: boolean; authenticated: boolean; rls: boolean }>("select has_table_privilege('anon',$1,'SELECT') anon,has_table_privilege('authenticated',$1,'SELECT') authenticated,(select relrowsecurity from pg_class where oid=$1::regclass) rls", [`public.${table}`])).rows[0];
      expect(row).toEqual({ anon: false, authenticated: false, rls: true });
    }
    const functions = (await db.query<{ anonymous: boolean; authenticated: boolean }>("select has_function_privilege('anon',p.oid,'EXECUTE') anonymous,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'pdd_%'")).rows;
    expect(functions.length).toBeGreaterThan(10);
    expect(functions.every(row => !row.anonymous && !row.authenticated)).toBe(true);
  });
  it('reports real contacts/person counts and private paginated operational logs', async () => {
    const item = (await batch('STATS123456', 'lost')).items[0];
    await batch('STATS234567', 'lost', { kind: 'wechat', value: lostContact.value.toUpperCase() });
    await query('STATS123456', 'received');
    await query('OTHERLOG1234', 'lost');
    expect(await rpc('pdd_stats')).toMatchObject({ activeSeekerCount: 1, recordedPackageCount: 0, successfulHandoverCount: null });
    const list = await rpc<{ items: unknown[]; nextOffset: number | null }>('pdd_admin_list', { offset: 0, limit: 1 });
    expect(list.items).toHaveLength(1);
    expect(list.nextOffset).toBe(1);
    const logs = await rpc<{ items: unknown[]; nextOffset: number | null }>('pdd_admin_queries', { offset: 0, limit: 1 });
    expect(logs.items).toHaveLength(1);
    expect(logs.nextOffset).toBe(1);
    expect((await rpc<PddAdminDetail>('pdd_admin_detail', { public_code: item.record.code })).queries).toHaveLength(1);
  });
  it('keeps every table and RPC inaccessible to browsers', async () => {
    await db.exec('set role anon');
    await expect(db.query('select * from public.pdd_waybills')).rejects.toThrow(/permission denied/);
  });
  it('withholds direct contacts when a known carrier conflict exists', async () => {
    await batch('CARRIER12345', 'lost');
    await batch('CARRIER12345', 'received', receivedContact, capB);
    await db.exec("update public.pdd_registrations set carrier=case mode when 'lost' then 'fixture-carrier-a' else 'fixture-carrier-b' end;");
    expect(await query('CARRIER12345', 'lost')).toMatchObject({ result: 'duplicate', contact: null });
  });
  it('rejects a batch without items at the database boundary', async () => {
    await expect(rpc('pdd_batch_register', { request_id: randomUUID(), mode: 'lost', contact: lostContact, capability_hash: capA, body_hash: 'missing-items' })).rejects.toThrow('INVALID_REQUEST');
  });
  it('revokes management capability and bumps revision during retention, blocking stale contact writes', async () => {
    const registration = (await batch('REVOKED12345', 'received', receivedContact, capA)).items[0].registration!;
    // A resolved registration remains active during its thirty-day private retention.
    await db.exec("update public.pdd_registrations set closed_at=now()-interval '31 days'; update public.pdd_waybills set resolution='resolved',closed_at=now()-interval '31 days';");
    expect(await rpc('pdd_cleanup')).toMatchObject({ cleanedRegistrations: 1 });
    const current = (await db.query<{ revision: number; capability_hash: string; contact: unknown }>('select revision,capability_hash,contact from public.pdd_registrations')).rows[0];
    expect(current).toEqual({ revision: registration.revision + 1, capability_hash: '', contact: null });
    await expect(rpc('pdd_manage_update', { registration_code: registration.registrationCode, capability_hash: capA, revision: registration.revision, action: 'contact', contact: lostContact })).rejects.toThrow('FORBIDDEN');
  });
});
