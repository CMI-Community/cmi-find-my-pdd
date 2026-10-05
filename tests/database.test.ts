import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { matchEvidence, qualityOf, validateExtraction } from '../shared/domain.ts';
import type { Extraction, Identifier, IdentifierType } from '../shared/contracts.ts';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

let db: PGlite;
const migrationDirectory = new URL('../supabase/migrations/', import.meta.url);

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create schema extensions;
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create schema net;
    create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as 'select 1::bigint';
    create schema cron;
    create function cron.schedule(job_name text,schedule text,command text) returns bigint language sql as 'select 1::bigint';
  `);
  const names = (await readdir(migrationDirectory)).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
  if (!names.some(name => name.endsWith('_core.sql'))) throw new Error('Expected a core migration');
  for (const name of names) {
    const migration = (await readFile(new URL(name, migrationDirectory), 'utf8'))
      .replace(/^create extension if not exists pg_net.*$/m, '')
      .replace(/^create extension if not exists pg_cron.*$/m, '');
    await db.exec(migration);
  }
}, 30_000);

afterAll(async () => { await db?.close(); });
afterEach(async () => { await db.exec('rollback; reset role;'); });

async function rpc<T = Record<string, unknown>>(name: string, payload: Record<string, unknown> = {}): Promise<T> {
  const result = await db.query<{ value: T }>(`select public.${name}($1::jsonb) as value`, [JSON.stringify(payload)]);
  return result.rows[0].value;
}
const imageSource = '00000000-0000-4000-8000-000000000001';
function extraction(value?: string, overrides: Partial<Extraction> = {}, numberOverrides: Partial<Identifier> = {}): Extraction {
  return validateExtraction({ validImage: true, recipientName: null, itemNames: [], specifications: [], tags: [],
    identifiers: value ? [{ id: 'number-1', type: 'domestic_waybill' as IdentifierType, value, carrier: 'fixture', complete: true, clear: true, shared: false, sourceImageId: imageSource, ...numberOverrides }] : [], ...overrides });
}
async function finalized(intent: 'received' | 'search', roles?: string[]): Promise<{ id: string; images: { id: string; role: string }[] }> {
  const id = randomUUID();
  const images = (roles ?? [intent === 'received' ? 'label' : 'logistics']).map(role => ({ id: randomUUID(), role }));
  await rpc('create_scan', { id, intent, capability_hash: 'a'.repeat(64), initial_request_hash: 'content-a', environment: 'test' });
  await rpc('reserve_images', { scan_id: id, version: 1, images: images.map(image => ({ ...image, path: `${id}/1/${image.role}.image`, size: 0 })) });
  await rpc('finalize_scan', { scan_id: id, version: 1, contact: { wechat: 'fixture_user', groupDeclaration: true },
    idempotency_key: id, body_hash: 'fixture-hash', images: images.map(image => ({ id: image.id, mime: 'image/jpeg', size: 1000, width: 800, height: 600 })) });
  return { id, images };
}
async function recognize(fixture: Awaited<ReturnType<typeof finalized>>, data: Extraction): Promise<void> {
  const claimed = await rpc<{ id: string; scan_id: string; lease_token: string }[]>('claim_jobs', { limit: 2 });
  const job = claimed.find(row => row.scan_id === fixture.id);
  if (!job) throw new Error('Fixture job was not claimed');
  const reservation = await rpc<{ allowed: boolean; reservationId: string }>('reserve_budget', { job_id: job.id, lease_token: job.lease_token });
  expect(reservation.allowed).toBe(true);
  const adapted = { ...data, identifiers: data.identifiers.map(number => ({ ...number, sourceImageId: fixture.images[0].id })) };
  expect(await rpc('complete_job', { job_id: job.id, lease_token: job.lease_token, reservation_id: reservation.reservationId,
    quality: qualityOf(adapted), extraction: adapted, public_title: '测试包裹', input_tokens: 100, output_tokens: 100 })).toMatchObject({ ok: true });
}

describe('real Postgres schema and transactions', () => {
  it('publishes only community assets while both parcel buckets remain private', async () => {
    const rows = await db.query<{ id: string; public: boolean }>('select id,public from storage.buckets order by id');
    expect(rows.rows).toEqual([
      { id: 'community-assets', public: true },
      { id: 'parcel-originals', public: false },
      { id: 'parcel-public', public: false },
    ]);
  });

  it('passes durable jobs, fencing, budgets, matching, handover and cleanup smoke', async () => {
    await db.exec(await readFile(new URL('./db.sql', import.meta.url), 'utf8'));
    const afterRollback = await db.query<{ count: number }>('select count(*)::integer as count from public.scans');
    expect(afterRollback.rows[0].count).toBe(0);
  }, 30_000);

  it('rejects direct anonymous business reads and service-only RPCs', async () => {
    await db.exec('set role anon');
    await expect(db.query('select * from public.scans')).rejects.toThrow(/permission denied/);
    await expect(db.query("select public.runtime_config('{}')")).rejects.toThrow(/permission denied/);
    await db.exec('reset role');
    await db.exec('set role authenticated');
    await expect(db.query('select * from public.records')).rejects.toThrow(/permission denied/);
    await expect(db.query("select public.create_scan('{}')")).rejects.toThrow(/permission denied/);
    await db.exec('reset role');
  });

  it('keeps SQL matching and OCR worker rules identical for typed, partial and generic evidence', async () => {
    const base = extraction('SF123456');
    const cases: [Extraction, Extraction][] = [
      [base, extraction('sf 123456')],
      [base, extraction('sf\u00a0123456')],
      [base, extraction('SF123456', {}, { type: 'last_mile_waybill' })],
      [base, extraction('SF123456', {}, { carrier: 'other' })],
      [base, extraction('SF123456', {}, { shared: true })],
      [extraction('1234'), extraction('1234')],
      [extraction('123'), extraction('123')],
      [extraction('....____'), extraction('....____')],
      [extraction('SF-123456'), extraction('SF123456')],
      [extraction('****3456'), extraction('SF123456')],
      [extraction('****3456', { recipientName: 'Ava' }), extraction('SF123456', { recipientName: 'ava' })],
      [extraction('123456', {}, { type: 'order_id' }), extraction('123456', {}, { type: 'order_id' })],
      [extraction('123456', {}, { type: 'unknown_id' }), extraction('123456', {}, { type: 'unknown_id' })],
      [extraction(undefined, { itemNames: ['日用品'], tags: ['物品', '包裹'] }), extraction(undefined, { itemNames: ['日用品'], tags: ['物品', '包裹'] })],
      [extraction(undefined, { itemNames: ['不锈钢蒸锅'] }), extraction(undefined, { itemNames: ['不锈钢蒸锅'] })],
      [extraction(undefined, { tags: ['蒸锅', '不锈钢', '蒸锅'] }), extraction(undefined, { tags: ['不锈钢', '蒸锅'] })],
      [extraction(undefined, { recipientName: 'ＡＶＡ', itemNames: ['蒸锅'] }), extraction(undefined, { recipientName: 'ava', itemNames: ['蒸锅'] })],
      [extraction('123456', { validImage: false }), base],
    ];
    for (const [left, right] of cases) {
      const comparison = await db.query<{ value: unknown; quality: string }>('select public.cmi_compare_extractions($1::jsonb,$2::jsonb) value, public.cmi_quality($1::jsonb) quality', [JSON.stringify(left), JSON.stringify(right)]);
      expect(comparison.rows[0].value).toEqual(matchEvidence(left, right));
      expect(comparison.rows[0].quality).toEqual(qualityOf(left));
    }
  });

  it('recomputes weak matches bidirectionally for later submissions and preserves rejected pairs', async () => {
    await db.exec('begin');
    const lost = await finalized('search');
    const item = extraction(undefined, { itemNames: ['电动打蛋器'], recipientName: 'Coco' });
    await recognize(lost, item);
    await rpc('activate_tracking', { scan_id: lost.id, version: 1, contact: { wechat: 'coco_private', groupDeclaration: true }, idempotency_key: 'track', body_hash: 'track' });
    expect(await rpc('get_scan_status', { scan_id: lost.id })).toMatchObject({ results: [] });
    const found = await finalized('received');
    await recognize(found, item);
    const progress = await rpc<{ results: unknown[] }>('get_scan_status', { scan_id: lost.id });
    expect(progress.results).toHaveLength(1);
    expect(await rpc('get_scan_status', { scan_id: found.id })).toMatchObject({ results: [{ kind: 'possible' }] });
    const pair = await db.query<{ id: string }>('select id from public.matches');
    await rpc('admin_update', { action: 'reject', match_id: pair.rows[0].id, actor_id: randomUUID() });
    expect(await rpc('get_scan_status', { scan_id: lost.id })).toMatchObject({ results: [] });
    expect(await rpc('get_scan_status', { scan_id: found.id })).toMatchObject({ results: [] });
    expect((await db.query<{ n: number }>('select count(*)::integer n from public.followups')).rows[0].n).toBe(1);
  });

  it('honors the selected PDD identifier on both sides without forcing received labels to select', async () => {
    await db.exec('begin');
    const lost = await finalized('search');
    const data = extraction('AA111111');
    data.identifiers.push({ ...data.identifiers[0], id: 'number-2', value: 'BB222222' });
    await recognize(lost, data);
    expect(await rpc('get_scan_status', { scan_id: lost.id })).toMatchObject({ requiresSelection: true, results: [] });
    await rpc('match_scan', { scan_id: lost.id, version: 1, selected_evidence_id: 'number-1' });
    await rpc('activate_tracking', { scan_id: lost.id, version: 1, contact: { wechat: 'selected_user', groupDeclaration: true }, idempotency_key: 'track', body_hash: 'track' });
    const found = await finalized('received');
    await recognize(found, extraction('BB222222'));
    expect(await rpc('get_scan_status', { scan_id: found.id })).toMatchObject({ requiresSelection: false, results: [] });
    const candidates = await rpc<{ extraction: Extraction }[]>('matching_candidates', { scan_id: found.id, intent: 'received' });
    expect(candidates[0].extraction.identifiers.map(number => number.value)).toEqual(['AA111111']);
    await rpc('match_scan', { scan_id: lost.id, version: 1, selected_evidence_id: 'number-2' });
    expect(await rpc('get_scan_status', { scan_id: found.id })).toMatchObject({ results: [{ kind: 'exact' }] });
    await db.exec('savepoint stale_page');
    await expect(rpc('match_scan', { scan_id: lost.id, version: 1, offset: 20, enforce_selection: true,
      expected_selected_identifier_id: 'number-1' })).rejects.toThrow(/VERSION_CONFLICT/);
    await db.exec('rollback to stale_page');
    expect((await db.query<{ selected_identifier_id: string }>('select selected_identifier_id from public.scans where id=$1', [lost.id])).rows[0].selected_identifier_id).toBe('number-2');
  });

  it('serves deterministic first twenty candidates and the next page without duplicate or missing results', async () => {
    await db.exec('begin');
    const searching = await finalized('search');
    const evidence = extraction(undefined, { itemNames: ['电动打蛋器'] });
    await recognize(searching, evidence);
    for (let n = 0; n < 21; n++) {
      const found = await finalized('received');
      await recognize(found, evidence);
    }
    type Page = { results: { record: { code: string } }[]; totalMatches: number; nextOffset: number | null; selectedIdentifierId: string | null };
    const request = { scan_id: searching.id, version: 1, enforce_selection: true, expected_selected_identifier_id: null };
    const first = await rpc<Page>('match_scan', { ...request, offset: 0 });
    const second = await rpc<Page>('match_scan', { ...request, offset: 20 });
    expect(first.results).toHaveLength(20);
    expect(first.totalMatches).toBe(21);
    expect(first.nextOffset).toBe(20);
    expect(second.results).toHaveLength(1);
    expect(second.totalMatches).toBe(21);
    expect(second.nextOffset).toBeNull();
    const codes = [...first.results, ...second.results].map(match => match.record.code);
    const stored = await db.query<{ public_code: string }>('select public_code from public.records order by public_code');
    expect(codes).toEqual(stored.rows.map(row => row.public_code));
    expect(new Set(codes).size).toBe(21);
    expect(await rpc<Page>('match_scan', { ...request, offset: 0 })).toEqual(first);
    await db.exec('savepoint stale_image');
    await expect(rpc('match_scan', { ...request, version: 2, offset: 20 })).rejects.toThrow(/VERSION_CONFLICT/);
    await db.exec('rollback to stale_image');
    const raw = JSON.stringify(second);
    expect(raw).not.toMatch(/fixture_user|sourceImageId|capability_hash|contact|extraction/);
  });

  it('invalidates prior tasks after a selection changes, blocks stale admin actions and locks confirmed ownership', async () => {
    await db.exec('begin');
    const lost = await finalized('search');
    const data = extraction('AA111111');
    data.identifiers.push({ ...data.identifiers[0], id: 'number-2', value: 'BB222222' });
    await recognize(lost, data);
    await rpc('match_scan', { scan_id: lost.id, version: 1, selected_evidence_id: 'number-1' });
    await rpc('activate_tracking', { scan_id: lost.id, version: 1, contact: { wechat: 'selected_user', groupDeclaration: true }, idempotency_key: 'track', body_hash: 'track' });
    const first = await finalized('received');
    await recognize(first, extraction('AA111111'));
    const oldPair = (await db.query<{ id: string }>('select id from public.matches')).rows[0];
    await rpc('match_scan', { scan_id: lost.id, version: 1, selected_evidence_id: 'number-2' });
    expect((await db.query<{ state: string }>('select state from public.matches where id=$1', [oldPair.id])).rows[0].state).toBe('invalidated');
    expect((await db.query<{ state: string }>('select state from public.followups where match_id=$1', [oldPair.id])).rows[0].state).toBe('closed');
    // Defence in depth: even a stale task left candidate cannot operate on a superseded selection.
    await db.query("update public.matches set state='candidate' where id=$1", [oldPair.id]);
    const actor = randomUUID();
    await db.exec('savepoint oldverify');
    await expect(rpc('admin_update', { action: 'verify', match_id: oldPair.id, actor_id: actor })).rejects.toThrow(/MATCH_STALE/);
    await db.exec('rollback to oldverify');
    const second = await finalized('received');
    await recognize(second, extraction('BB222222'));
    const nextPair = (await db.query<{ id: string }>('select id from public.matches where received_id=(select id from public.records where scan_id=$1)', [second.id])).rows[0];
    await rpc('admin_update', { action: 'verify', match_id: nextPair.id, actor_id: actor });
    await rpc('admin_update', { action: 'mark_claimed', match_id: nextPair.id, actor_id: actor });
    await db.exec('savepoint locked');
    await expect(rpc('match_scan', { scan_id: lost.id, version: 1, selected_evidence_id: 'number-1' })).rejects.toThrow(/SELECTION_LOCKED/);
    await db.exec('rollback to locked');
    expect((await db.query<{ selected_identifier_id: string }>('select selected_identifier_id from public.scans where id=$1', [lost.id])).rows[0].selected_identifier_id).toBe('number-2');
    await rpc('admin_update', { action: 'confirm_handover', match_id: nextPair.id, actor_id: actor });
    await db.exec('savepoint resolved');
    await expect(rpc('match_scan', { scan_id: lost.id, version: 1, selected_evidence_id: 'number-1' })).rejects.toThrow(/SELECTION_LOCKED/);
    await db.exec('rollback to resolved');
  });

  it('rejects changed create content, stable image role conflicts and stale contact/admin revisions', async () => {
    await db.exec('begin');
    const id = randomUUID();
    const payload = { id, intent: 'received', capability_hash: 'a'.repeat(64), initial_request_hash: 'hash-one', environment: 'test' };
    await rpc('create_scan', payload);
    await expect(rpc('create_scan', { ...payload, initial_request_hash: 'hash-two' })).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
    // A rejected SQL statement aborts its transaction; isolate expected failures with savepoints.
    await db.exec('rollback; begin');
    const fixture = await finalized('received', ['label', 'item']);
    await recognize(fixture, extraction('SAFE123456'));
    expect(await rpc('update_contact', { scan_id: fixture.id, revision: 1, contact: { wechat: 'changed_user', groupDeclaration: true } })).toMatchObject({ revision: 2 });
    await db.exec('savepoint stale');
    await expect(rpc('update_contact', { scan_id: fixture.id, revision: 1, contact: { wechat: 'old_user', groupDeclaration: true } })).rejects.toThrow(/VERSION_CONFLICT/);
    await db.exec('rollback to stale');
    const record = (await db.query<{ public_code: string }>('select public_code from public.records where scan_id=$1', [fixture.id])).rows[0];
    const actor = randomUUID();
    await rpc('admin_update', { action: 'rotate', public_code: record.public_code, actor_id: actor, payload: { revision: 2, capability_hash: 'b'.repeat(64) } });
    await db.exec('savepoint badimage');
    await expect(rpc('admin_update', { action: 'imageapproval', public_code: record.public_code, actor_id: actor,
      payload: { revision: 3, imageId: fixture.images[0].id, approved_image_path: 'safe/photo.jpg' } })).rejects.toThrow(/INVALID_IMAGE/);
    await db.exec('rollback to badimage');
    await rpc('admin_update', { action: 'imageapproval', public_code: record.public_code, actor_id: actor,
      payload: { revision: 3, imageId: fixture.images[1].id, approved_image_path: 'safe/photo.jpg' } });
    const publicRecord = await rpc('public_record', { public_code: record.public_code });
    expect(publicRecord).toMatchObject({ image_approved: true });
    expect(JSON.stringify(publicRecord)).not.toMatch(/changed_user|safe\/photo|SAFE123456|bbbbbbbb/);
    expect(await rpc('admin_record', { public_code: record.public_code })).toMatchObject({ revision: 4, contact: { wechat: 'changed_user' } });
  });

  it('fences expired failure callbacks while settling actual usage and reconciling unknown reservations once', async () => {
    await db.exec('begin');
    const fixture = await finalized('search');
    const job = (await rpc<{ id: string; lease_token: string }[]>('claim_jobs'))[0];
    const reservation = await rpc<{ reservationId: string }>('reserve_budget', { job_id: job.id, lease_token: job.lease_token });
    await db.query("update public.jobs set lease_expires_at=now()-interval '1 second' where id=$1", [job.id]);
    expect(await rpc('fail_job', { job_id: job.id, lease_token: job.lease_token, reservation_id: reservation.reservationId, usage_unknown: true, retryable: true })).toMatchObject({ fenced: true });
    expect((await db.query<{ state: string }>('select state from public.scans where id=$1', [fixture.id])).rows[0].state).toBe('running');
    const ledger = (await db.query('select reserved::float8 reserved,spent::float8 spent from public.daily_budgets')).rows[0];
    expect(ledger).toEqual({ reserved: 0.02, spent: 0 });
    const settlement = { job_id: job.id, lease_token: job.lease_token, reservation_id: reservation.reservationId, input_tokens: 100, output_tokens: 100 };
    await rpc('cmi_settle_budget', settlement);
    await rpc('cmi_settle_budget', settlement);
    expect((await db.query('select reserved::float8 reserved,spent::float8 spent from public.daily_budgets')).rows[0]).toEqual({ reserved: 0, spent: 0.0002 });
    expect((await db.query('select state,actual::float8 actual from public.budget_reservations')).rows[0]).toEqual({ state: 'settled', actual: 0.0002 });
  });

  it('closes a manually associated tracking record only upon actual handover', async () => {
    await db.exec('begin');
    const lost = await finalized('search');
    await recognize(lost, extraction('LOST123456'));
    await rpc('activate_tracking', { scan_id: lost.id, version: 1, contact: { wechat: 'manual_lost', groupDeclaration: true }, idempotency_key: 'track', body_hash: 'track' });
    const found = await finalized('received');
    await recognize(found, extraction('FOUND654321'));
    const codes = await db.query<{ scan_id: string; public_code: string }>('select scan_id,public_code from public.records');
    const actor = randomUUID();
    const task = await rpc<{ followupId: string }>('admin_update', { action: 'create_followup', actor_id: actor, payload: {
      receivedCode: codes.rows.find(row => row.scan_id === found.id)!.public_code,
      trackingCode: codes.rows.find(row => row.scan_id === lost.id)!.public_code,
      notes: '人工核验的关联' } });
    await rpc('admin_update', { action: 'verify', followup_id: task.followupId, actor_id: actor });
    await rpc('admin_update', { action: 'mark_claimed', followup_id: task.followupId, actor_id: actor });
    expect(await rpc('public_stats')).toMatchObject({ activeSeekerCount: 1, successfulHandoverCount: null });
    expect((await db.query<{ resolution: string }>('select resolution from public.records')).rows.every(row => row.resolution === 'claimed')).toBe(true);
    await rpc('admin_update', { action: 'confirm_handover', followup_id: task.followupId, actor_id: actor });
    expect(await rpc('public_stats')).toMatchObject({ activeSeekerCount: 0 });
    expect((await db.query<{ resolution: string }>('select resolution from public.records')).rows.every(row => row.resolution === 'resolved')).toBe(true);
    expect((await db.query<{ n: number }>('select count(*)::integer n from public.handovers')).rows[0].n).toBe(1);
  });

  it('merges settings, limits traffic, cleans every private note carrier and preserves public tombstones', async () => {
    await db.exec('begin');
    const actor = randomUUID();
    await rpc('admin_update', { action: 'settings', actor_id: actor, payload: { submissionsEnabled: true, assistantWechat: 'assistant_wechat' } });
    await rpc('admin_update', { action: 'settings', actor_id: actor, payload: { submissionsEnabled: false } });
    expect((await db.query<{ value: Record<string, unknown> }>("select value from public.site_settings where key='community'")).rows[0].value).toMatchObject({ submissionsEnabled: false, assistantWechat: 'assistant_wechat' });
    expect(await rpc('rate_limit_tick', { key: 'ip-test', window_seconds: 60, limit: 1 })).toMatchObject({ allowed: true });
    expect(await rpc('rate_limit_tick', { key: 'ip-test', window_seconds: 60, limit: 1 })).toMatchObject({ allowed: false });
    await db.query("insert into public.site_settings(key,value) values('runtime',$1::jsonb)", [JSON.stringify({ APP_ENVIRONMENT: 'test', APP_SHA: 'fixture-sha' })]);
    expect(await rpc('runtime_config')).toMatchObject({ APP_ENVIRONMENT: 'test', APP_SHA: 'fixture-sha', OPENAI_API_KEY: null, WORKER_SECRET: null });
    const lost = await finalized('search');
    await recognize(lost, extraction('PRIVATE12345'));
    await rpc('activate_tracking', { scan_id: lost.id, version: 1, contact: { wechat: 'lost_private', groupDeclaration: true }, idempotency_key: 'track', body_hash: 'track' });
    const found = await finalized('received');
    await recognize(found, extraction('PRIVATE12345'));
    const followup = (await db.query<{ id: string }>('select id from public.followups')).rows[0];
    await rpc('admin_update', { action: 'contact_received', followup_id: followup.id, actor_id: actor, payload: { notes: 'private WeChat note' } });
    await rpc('admin_update', { action: 'withdraw', public_code: (await db.query<{ public_code: string }>('select public_code from public.records where scan_id=$1', [found.id])).rows[0].public_code, actor_id: actor });
    await db.query("update public.records set closed_at=now()-interval '31 days' where scan_id=$1", [found.id]);
    const cleanup = await rpc<{ images: { id: string }[] }>('cleanup_records');
    expect(cleanup.images).toHaveLength(1);
    expect((await db.query<{ notes: string }>('select notes from public.followups')).rows[0].notes).toBe('');
    expect((await db.query<{ payload: Record<string, unknown> }>("select payload from public.audit_events where action='contact_received'")).rows[0].payload).toEqual({});
    await rpc('cleanup_images', { ids: cleanup.images.map(image => image.id) });
    expect((await db.query<{ n: number }>('select count(*)::integer n from public.images where scan_id=$1', [found.id])).rows[0].n).toBe(0);
    expect((await db.query('select capability_hash,extraction from public.scans where id=$1', [found.id])).rows[0]).toEqual({ capability_hash: '', extraction: null });
    const code = (await db.query<{ public_code: string }>('select public_code from public.records where scan_id=$1', [found.id])).rows[0].public_code;
    expect(await rpc('public_record', { public_code: code })).toMatchObject({ visibility: 'withdrawn', identifiers: [], recipientHint: null });
    await db.exec('select public.cmi_tick()');
  });
});
