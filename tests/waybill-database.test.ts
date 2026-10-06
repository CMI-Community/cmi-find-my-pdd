import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import type { PddAdminDetail, PddBatchResult, PddContact, PddMode, PddQueryContactResult, PddQueryResult, PddRegistration } from '../shared/waybill.ts';

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
  return rpc('pdd_query', { query_id: queryId, number, mode, source: 'manual', capability_hash: cap, body_hash: `query-${number}-${mode}` });
}
async function batch(number: string, mode: PddMode, contact = lostContact, cap = capA, requestId = randomUUID()): Promise<PddBatchResult> {
  return rpc('pdd_batch_register', { request_id: requestId, mode, contact, capability_hash: cap, body_hash: `batch-${number}-${mode}`,
    items: [{ request_id: randomUUID(), number, source: 'manual' }] });
}

describe('PDD404 isolated transactional flow', () => {
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
    const tables = ['pdd_waybills','pdd_registrations','pdd_query_events','pdd_write_requests','pdd_audit_events','pdd_handovers'];
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
