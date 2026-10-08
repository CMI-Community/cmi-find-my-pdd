import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import type { PddRecipientBatchResult, PddRecipientQueryResult } from '../shared/recipient';
// @ts-expect-error Native operational ESM is intentionally outside TS compilation.
import { TABLES, FORMAT, FEEDBACK_MIGRATION, TELEMETRY_MIGRATION, RECIPIENT_MIGRATION, PUBLIC_CONTENT_MIGRATION, bucketsForMigrations, canonical, migrationManifest, readEncryptedSnapshot, rowsHash, sanitizeRow, sha256, snapshotChunks, tablesForMigrations, writeEncryptedChunks } from '../scripts/backup-scoped.mjs';
// @ts-expect-error Native operational ESM is intentionally outside TS compilation.
import { BOOTSTRAP_SQL, restoreAndCompare, validateSnapshot, verifiedMigrations, verifyScopedRestore } from '../scripts/verify-scoped-restore.mjs';

const password = 'synthetic-scoped-backup-password-at-least-24';
const project = 'abcdefghijklmnopqrst';
type Row = Record<string, unknown>;
type Snapshot = { format: string; project: string; migrations: { version: string; name: string; sha256: string }[]; tables: { name: string; rows: Row[]; rowCount: number; sha256: string }[]; storage: { bucket: string; key: string; mime: string; size: number; sha256: string; base64: string }[] };
let source: PGlite, fixture: Snapshot;
const tableNames = (TABLES as { name: string; order: string[] }[]).map(table => table.name);

beforeAll(async () => {
  source = new PGlite({ extensions: { pgcrypto } });
  await source.exec(BOOTSTRAP_SQL);
  const migrations = await migrationManifest();
  for (const statement of await verifiedMigrations({ migrations })) await source.exec(statement);
  const id = () => randomUUID();
  const scans = [id(), id()], records = [id(), id()], image = id(), job = id(), match = id(), followup = id(), actor = id();
  // Self-referencing records intentionally require a single INSERT statement.
  await source.exec(`
    insert into public.scans(id,intent,capability_hash,environment) values('${scans[0]}','received','synthetic','test'),('${scans[1]}','search','synthetic','test');
    insert into public.images(id,scan_id,version,role,path) values('${image}','${scans[0]}',1,'label','synthetic/label.png');
    insert into public.records(id,scan_id,kind,image_version,contact,duplicate_of) values('${records[0]}','${scans[0]}','received',1,'{"wechat":"fictional_contact","groupDeclaration":true}','${records[1]}'),('${records[1]}','${scans[1]}','tracking',1,'{"wechat":"fictional_contact","groupDeclaration":true}','${records[0]}');
    insert into public.evidence(scan_id,version,identifier_id,type,value,complete,clear,shared,source_image_id) values('${scans[0]}',1,'fixture','domestic_waybill','SF000990123456',true,true,false,'${image}');
    insert into public.jobs(id,scan_id,version) values('${job}','${scans[0]}',1);
    insert into public.matches(id,received_id,tracking_id,received_version,tracking_version,kind) values('${match}','${records[0]}','${records[1]}',1,1,'exact');
    insert into public.followups(id,match_id) values('${followup}','${match}');
    insert into public.handovers(match_id,followup_id,received_id,actor_id) values('${match}','${followup}','${records[0]}','${actor}');
    insert into public.daily_budgets(day,environment,reserved,spent) values('2026-10-06','test',0.02,0.01);
    insert into public.budget_reservations(job_id,lease_token,attempt,day,environment) values('${job}','${id()}',1,'2026-10-06','test');
    insert into public.idempotency_keys(scope,key,body_hash,response) values('synthetic','fixture','synthetic','{}');
    insert into public.rate_limits(key,window_start,count) values('synthetic',now(),1);
    insert into public.audit_events(actor_id,action,record_id) values('${actor}','synthetic','${records[0]}');
    insert into public.site_settings(key,value) values('runtime','{"OCR_ENABLED":"false","APP_ENVIRONMENT":"test"}');
  `);
  const batch = { request_id: id(), mode: 'received', note: 'Synthetic holder description', contact: { kind: 'wechat', value: 'fictional_holder' }, capability_hash: 'a'.repeat(64), body_hash: 'synthetic-batch', items: [{ request_id: id(), number: '001234560001', source: 'barcode', recipient_name: 'Synthetic José' }] };
  const registered = (await source.query<{ value: { items: { record: { code: string } }[] } }>('select public.pdd_batch_register($1::jsonb) value', [JSON.stringify(batch)])).rows[0].value;
  const query = { query_id: id(), number: '001234560001', mode: 'lost', source: 'manual', capability_hash: 'b'.repeat(64), body_hash: 'synthetic-query' };
  await source.query('select public.pdd_query($1::jsonb)', [JSON.stringify(query)]);
  await source.query('select public.pdd_query_contact($1::jsonb)', [JSON.stringify({ query_id: query.query_id, capability_hash: query.capability_hash, contact: { kind: 'wechat', value: 'fictional_owner' }, idempotency_key: 'synthetic-contact', body_hash: 'synthetic-contact' })]);
  const beforeClaim = (await source.query<{ revision: number }>('select revision from public.pdd_waybills')).rows[0].revision;
  await source.query('select public.pdd_admin_action($1::jsonb)', [JSON.stringify({ public_code: registered.items[0].record.code, revision: beforeClaim, action: 'claim', actor_id: actor, notes: 'Synthetic verification.' })]);
  const revision = (await source.query<{ revision: number }>('select revision from public.pdd_waybills')).rows[0].revision;
  await source.query('select public.pdd_admin_action($1::jsonb)', [JSON.stringify({ public_code: registered.items[0].record.code, revision, action: 'return', actor_id: actor, notes: 'Synthetic handover.' })]);
  await source.query('select public.pdd_batch_register($1::jsonb)', [JSON.stringify({ ...batch, request_id: id(), mode: 'lost', note: 'Synthetic owner description', body_hash: 'synthetic-owner-batch', items: [{ request_id: id(), number: '001234560002', source: 'manual', recipient_name: 'Synthetic 王小明' }] })]);
  const recipientBatch = { request_id: id(), mode: 'lost', note: 'Synthetic private name note', contact: { kind: 'wechat', value: 'fictional_name_seeker' }, capability_hash: 'a'.repeat(64), body_hash: 'synthetic-name-batch',
    items: ['Synthetic 王小明', 'ผู้รับทดสอบ', 'Jose\u0301 示例'].map(recipient_name => ({ request_id: id(), recipient_name })) };
  const recipients = (await source.query<{ value: PddRecipientBatchResult }>('select public.pdd_recipient_batch_register($1::jsonb) value', [JSON.stringify(recipientBatch)])).rows[0].value;
  await source.query('select public.pdd_recipient_admin_action($1::jsonb)', [JSON.stringify({ registration_code: recipients.items[0].registration!.registrationCode, actor_id: actor, revision: 1, action: 'review' })]);
  await source.query('select public.pdd_recipient_query($1::jsonb)', [JSON.stringify({ query_id: id(), recipient_name: 'Synthetic 王小明', mode: 'received', capability_hash: 'b'.repeat(64), body_hash: 'synthetic-name-query' })]);
  const feedback = { request_id: id(), body_hash: 'synthetic-feedback', message: 'Synthetic private camera feedback', contact: { kind: 'wechat', value: 'fictional_feedback_contact' } };
  const receipt = (await source.query<{ value: { feedbackId: string } }>('select public.pdd_feedback_submit($1::jsonb) value', [JSON.stringify(feedback)])).rows[0].value;
  await source.query('select public.pdd_feedback_submit($1::jsonb)', [JSON.stringify(feedback)]);
  await source.query('select public.pdd_admin_feedback_update($1::jsonb)', [JSON.stringify({ feedback_id: receipt.feedbackId, status: 'reviewed', actor_id: actor })]);
  await source.query('select public.pdd_telemetry_ingest($1::jsonb)', [JSON.stringify({ events: [
    { event: 'pdd_page_view', page: 'home', count: 3 },
    { event: 'pdd_query_matched', page: 'home', count: 2, mode: 'lost', source: 'barcode' },
    { event: 'pdd_visible_dwell', page: 'help', count: 1, bucket: '30-59s' },
  ], daily_limit: 100000 })]);
  await source.query("insert into public.pdd_stats_daily(day,sampled_at,metric_version,stats) values((now() at time zone 'Asia/Bangkok')::date,now(),'home-six-lifetime-v1',public.pdd_home_stats('{}'))");
  const publication = { kind: 'outreach', key: 'main', action: 'publish', expectedRevision: 0, content: { items: [] } };
  await source.query('select public.pdd_publish_content($1::jsonb)', [JSON.stringify({ kind: publication.kind, key: publication.key, action: publication.action, expected_revision: 0, content: publication.content, actor_id: actor, approval_artifact_sha: sha256(canonical(publication)) })]);
  const tables = [];
  for (const name of tableNames) {
    const rows = (await source.query<{ value: Row }>(`select to_jsonb(row) value from public.${name} row`)).rows.map(row => row.value);
    tables.push({ name, rows, rowCount: rows.length, sha256: rowsHash(rows) });
  }
  const bytes = Buffer.from('synthetic storage bytes');
  const publicBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLj8AAAAASUVORK5CYII=', 'base64');
  fixture = { format: FORMAT, project, migrations, tables, storage: [
    { bucket: 'community-assets', key: 'synthetic/example.bin', mime: 'application/octet-stream', size: bytes.length, sha256: sha256(bytes), base64: bytes.toString('base64') },
    { bucket: 'pdd-public-assets', key: sha256(publicBytes) + '.png', mime: 'image/png', size: publicBytes.length, sha256: sha256(publicBytes), base64: publicBytes.toString('base64') },
  ] };
}, 30_000);
afterAll(async () => { await source?.close(); });

function mockClient(changed = false, runtimeChanged = false, data = fixture) {
  const calls = new Map<string, number>();
  const bucketCalls = new Set<string>();
  return {
    calls, bucketCalls,
    from(name: string) {
      const request = { select: () => request, order: () => request, range: async () => {
        calls.set(name, (calls.get(name) || 0) + 1);
        const rows = data.tables.find(table => table.name === name)!.rows;
        if (runtimeChanged && name === 'site_settings') return { data: rows.map(row => row.key === 'runtime' ? { ...row, value: { ...(row.value as Row), WORKER_SECRET: calls.get(name) === 1 ? 'synthetic-first' : 'synthetic-second' } } : row), error: null };
        return { data: changed && name === 'pdd_waybills' && calls.get(name) === 2 ? [] : rows, error: null };
      } }; return request;
    },
    storage: { from: (bucket: string) => {
      bucketCalls.add(bucket);
      return {
        list: async (prefix: string) => {
          const names = new Map<string, { name: string; id?: string }>();
          for (const item of data.storage.filter(item => item.bucket === bucket)) {
            const remaining = prefix ? item.key.startsWith(prefix + '/') ? item.key.slice(prefix.length + 1) : null : item.key;
            if (remaining !== null) { const [name, ...rest] = remaining.split('/'); names.set(name, { name, ...(rest.length ? {} : { id: 'synthetic-object' }) }); }
          }
          return { data: [...names.values()], error: null };
        },
        download: async (key: string) => { const item = data.storage.find(item => item.bucket === bucket && item.key === key); return { data: item ? new Blob([new Uint8Array(Buffer.from(item.base64, 'base64'))], { type: item.mime }) : null, error: null }; },
      };
    } },
  };
}
async function writeFixture(file: string) {
  await writeEncryptedChunks(file, password, [JSON.stringify(fixture)]);
}
async function snapshotForMigrations(migrations: Snapshot['migrations']): Promise<Snapshot> {
  const schema = new PGlite({ extensions: { pgcrypto } });
  try {
    await schema.exec(BOOTSTRAP_SQL);
    for (const statement of await verifiedMigrations({ migrations })) await schema.exec(statement);
    const tables: Snapshot['tables'] = [];
    for (const table of tablesForMigrations(migrations)) {
      const columns = new Set((await schema.query<{ column_name: string }>('select column_name from information_schema.columns where table_schema=$1 and table_name=$2', ['public', table.name])).rows.map(row => row.column_name));
      const rows = fixture.tables.find(entry => entry.name === table.name)!.rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => columns.has(key))));
      tables.push({ name: table.name, rows, rowCount: rows.length, sha256: rowsHash(rows) });
    }
    return { ...fixture, migrations, tables, storage: fixture.storage.filter(item => bucketsForMigrations(migrations).includes(item.bucket)) };
  } finally { await schema.close(); }
}
describe('scoped encrypted fallback and restore', () => {
  it('round-trips a CMIBAK01 stream without plaintext files, rejects authentication tampering and never overwrites', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdd404-sealed-test-'));
    try {
      const file = path.join(directory, 'snapshot.cmibak'), client = mockClient();
      await writeEncryptedChunks(file, password, snapshotChunks(client, { project, migrations: fixture.migrations }));
      const sealed = await readFile(file);
      expect(sealed.subarray(0, 8).toString()).toBe('CMIBAK01');
      expect(sealed.includes(Buffer.from('fictional_owner'))).toBe(false);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      const opened = await readEncryptedSnapshot(file, password);
      expect(validateSnapshot(opened).size).toBe(28);
      expect(client.calls.size).toBe(28);
      expect(opened.storage).toEqual(fixture.storage);
      expect(client.bucketCalls.has('pdd-public-assets')).toBe(true);
      expect([...client.calls.values()].every(count => count === 2)).toBe(true);
      expect(opened.authMetadata).toBeUndefined();
      await expect(writeFixture(file)).rejects.toThrow();
      expect(await readFile(file)).toEqual(sealed);
      await expect(readEncryptedSnapshot(file, 'incorrect-password-of-more-than-24')).rejects.toThrow('authentication failed');
      sealed[40] ^= 1;
      const damaged = path.join(directory, 'damaged.cmibak'); await writeFile(damaged, sealed);
      await expect(readEncryptedSnapshot(damaged, password)).rejects.toThrow('authentication failed');
      expect((await readdir(directory)).sort()).toEqual(['damaged.cmibak', 'snapshot.cmibak']);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('rejects changing REST rows before a completed artifact exists and removes encrypted partials', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdd404-changing-test-'));
    try {
      await expect(writeEncryptedChunks(path.join(directory, 'snapshot.cmibak'), password, snapshotChunks(mockClient(true), { project, migrations: fixture.migrations }))).rejects.toThrow('changed during backup');
      expect(await readdir(directory)).toEqual([]);
      // Even excluded secret fields participate in the in-memory consistency
      // comparison, so their modification is not silently treated as stable.
      await expect(writeEncryptedChunks(path.join(directory, 'snapshot.cmibak'), password, snapshotChunks(mockClient(false, true), { project, migrations: fixture.migrations }))).rejects.toThrow('changed during backup');
      expect(await readdir(directory)).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('excludes runtime secrets and validates table allowlists, digests and safe storage paths', () => {
    expect(sanitizeRow('site_settings', { key: 'runtime', value: { OCR_ENABLED: 'false', OPENAI_API_KEY: 'synthetic_secret', WORKER_SECRET: 'synthetic_secret', APP_SHA: 'synthetic' } }).value).toEqual({ OCR_ENABLED: 'false', APP_SHA: 'synthetic' });
    expect(() => validateSnapshot({ ...fixture, tables: fixture.tables.slice(1) })).toThrow('Incomplete');
    expect(() => validateSnapshot({ ...fixture, tables: [...fixture.tables.slice(1), fixture.tables[1]] })).toThrow('duplicated');
    expect(() => validateSnapshot({ ...fixture, storage: [{ ...fixture.storage[0], key: '../escape.bin' }] })).toThrow('Invalid');
    expect(() => validateSnapshot({ ...fixture, storage: [{ ...fixture.storage[0], sha256: '0'.repeat(64) }] })).toThrow('checksum');
    expect(() => validateSnapshot({ ...fixture, tables: fixture.tables.map(table => table.name === 'pdd_waybills' ? { ...table, sha256: '0'.repeat(64) } : table) })).toThrow('digest');
    for (const name of ['pdd_telemetry_daily', 'pdd_telemetry_budget', 'pdd_recipient_leads', 'pdd_recipient_query_events', 'pdd_recipient_audit_events', 'pdd_stats_daily', 'pdd_content_revisions']) {
      expect(() => validateSnapshot({ ...fixture, tables: fixture.tables.filter(table => table.name !== name) })).toThrow('Incomplete');
    }
    const emptyRecipientTables = { ...fixture, tables: fixture.tables.map(table => table.name.startsWith('pdd_recipient_') ? { ...table, rows: [], rowCount: 0, sha256: rowsHash([]) } : table) };
    expect(validateSnapshot(emptyRecipientTables).size).toBe(28);
    for (const name of ['pdd_recipient_leads', 'pdd_recipient_query_events', 'pdd_recipient_audit_events']) {
      expect(() => validateSnapshot({ ...emptyRecipientTables, tables: emptyRecipientTables.tables.filter(table => table.name !== name) })).toThrow('Incomplete');
    }
    const emptyPublic = { ...fixture, tables: fixture.tables.map(table => ['pdd_stats_daily','pdd_content_revisions'].includes(table.name) ? { ...table, rows: [], rowCount: 0, sha256: rowsHash([]) } : table) };
    expect(validateSnapshot(emptyPublic).size).toBe(28);
    for (const name of ['pdd_stats_daily','pdd_content_revisions']) expect(() => validateSnapshot({ ...emptyPublic, tables: emptyPublic.tables.filter(table => table.name !== name) })).toThrow('Incomplete');
    expect(() => validateSnapshot({ ...fixture, storage: fixture.storage.map(item => item.bucket === 'pdd-public-assets' ? { ...item, key: '0'.repeat(64) + '.png' } : item) })).toThrow('immutable bytes');
  });
  it('restores populated legacy and PDD tables with FK/self references, RLS and audit UUID placeholders', async () => {
    expect(fixture.tables.every(table => table.rows.length > 0)).toBe(true);
    const database = new PGlite({ extensions: { pgcrypto } });
    try {
      const sql = async (statement: string): Promise<string> => {
        const results = await database.exec(statement);
        const last = results.at(-1)?.rows[0];
        return last ? String(Object.values(last)[0]) : '';
      };
      const result = await restoreAndCompare(fixture, sql);
      expect(result).toMatchObject({ tables: 28, storageObjects: 2, auditActorPlaceholders: 1 });
      expect(await sql("select count(*) from public.pdd_stats_daily")).toBe('1');
      expect(await sql("select count(*) from public.pdd_content_revisions where approval_artifact_sha ~ '^[0-9a-f]{64}$'")).toBe('1');
      expect(JSON.parse(await sql("select public.pdd_public_outreach('{}')::text"))).toMatchObject({ catalog: { revision: 1, content: { items: [] } }, developerGroup: null });
      expect(await sql("select has_table_privilege('authenticated','public.pdd_content_revisions','SELECT')::text")).toBe('false');
      expect(JSON.parse(await sql("select public.pdd_home_stats('{}'::jsonb)::text"))).toEqual({ lostRegistered: 2, receivedRegistered: 1, matchedParcels: 1,
        lostRecipientRegistered: 4, receivedRecipientRegistered: 1, matchedRecipientLeads: 2 });
      expect((await database.query<{ note: string | null }>('select note from public.pdd_registrations order by note nulls first')).rows.map(row => row.note)).toEqual([null, 'Synthetic holder description', 'Synthetic owner description']);
      expect((await database.query<{ recipient_name: string | null }>('select recipient_name from public.pdd_registrations order by recipient_name nulls first')).rows.map(row => row.recipient_name)).toEqual([null, 'Synthetic José', 'Synthetic 王小明']);
      expect((await database.query<{ recipient_name: string }>('select recipient_name from public.pdd_recipient_leads order by recipient_name collate "C"')).rows.map(row => row.recipient_name)).toEqual(['José 示例', 'Synthetic 王小明', 'ผู้รับทดสอบ']);
      const nameQuery = (await database.query<{ value: PddRecipientQueryResult }>('select public.pdd_recipient_query($1::jsonb) value', [JSON.stringify({ query_id: randomUUID(), recipient_name: 'Synthetic 王小明', mode: 'received', capability_hash: 'b'.repeat(64), body_hash: 'restored-name-query' })])).rows[0].value;
      expect(nameQuery.result).toBe('leads_found');
      expect(new Set(nameQuery.leads.map(lead => lead.contact.value))).toEqual(new Set(['fictional_holder', 'fictional_name_seeker']));
      expect(await sql("select has_table_privilege('anon','public.pdd_recipient_leads','SELECT')::text")).toBe('false');
      expect(await sql("select has_function_privilege('authenticated','public.pdd_recipient_query(jsonb)','EXECUTE')::text")).toBe('false');
      expect((await database.query<{ message: string; contact: unknown; status: string }>('select message,contact,status from public.pdd_feedback')).rows).toEqual([{ message: 'Synthetic private camera feedback', contact: { kind: 'wechat', value: 'fictional_feedback_contact' }, status: 'reviewed' }]);
      expect((await database.query<{ event: string; page: string; mode: string; source: string; dwell_bucket: string; event_count: number }>('select event,page,mode,source,dwell_bucket,event_count from public.pdd_telemetry_daily order by event')).rows).toEqual([
        { event: 'pdd_page_view', page: 'home', mode: '', source: '', dwell_bucket: '', event_count: 3 },
        { event: 'pdd_query_matched', page: 'home', mode: 'lost', source: 'barcode', dwell_bucket: '', event_count: 2 },
        { event: 'pdd_visible_dwell', page: 'help', mode: '', source: '', dwell_bucket: '30-59s', event_count: 1 },
      ]);
      expect((await database.query<{ accepted_batches: number; accepted_events: number; daily_limit: number; limited_at: string | null }>('select accepted_batches,accepted_events,daily_limit,limited_at from public.pdd_telemetry_budget')).rows).toEqual([{ accepted_batches: 1, accepted_events: 6, daily_limit: 100000, limited_at: null }]);
    } finally { await database.close(); }
  }, 30_000);
  it('restores the encrypted pre-public-content schema without requiring or reading the two new tables or public asset bucket', async () => {
    const migrations = fixture.migrations.filter(entry => entry.version < PUBLIC_CONTENT_MIGRATION);
    const old = await snapshotForMigrations(migrations), database = new PGlite({ extensions: { pgcrypto } });
    const directory = await mkdtemp(path.join(tmpdir(), 'pdd404-pre-public-content-'));
    try {
      const file = path.join(directory, 'legacy.cmibak'), client = mockClient(false, false, old);
      await writeEncryptedChunks(file, password, snapshotChunks(client, { project, migrations }));
      const opened = await readEncryptedSnapshot(file, password);
      expect(validateSnapshot(opened).size).toBe(26);
      expect(client.calls.has('pdd_stats_daily')).toBe(false); expect(client.calls.has('pdd_content_revisions')).toBe(false);
      expect(client.bucketCalls.has('pdd-public-assets')).toBe(false);
      const sql = async (statement: string) => { const result = await database.exec(statement); const row = result.at(-1)?.rows[0]; return row ? String(Object.values(row)[0]) : ''; };
      expect(await restoreAndCompare(opened, sql)).toMatchObject({ tables: 26, storageObjects: 1, auditActorPlaceholders: 1 });
      expect(await sql("select count(*) from storage.buckets where id='pdd-public-assets'")).toBe('0');
      expect(() => validateSnapshot({ ...opened, migrations: fixture.migrations })).toThrow('Incomplete');
    } finally { await database.close(); await rm(directory, { recursive: true, force: true }); }
  }, 30_000);
  it('restores encrypted pre-recipient tables and original column schemas without requiring name resources', async () => {
    const migrations = fixture.migrations.filter(entry => entry.version < RECIPIENT_MIGRATION);
    const old = await snapshotForMigrations(migrations);
    const database = new PGlite({ extensions: { pgcrypto } });
    const directory = await mkdtemp(path.join(tmpdir(), 'pdd404-pre-recipient-scoped-test-'));
    try {
      const file = path.join(directory, 'legacy.cmibak'), client = mockClient(false, false, old);
      await writeEncryptedChunks(file, password, snapshotChunks(client, { project, migrations }));
      const opened = await readEncryptedSnapshot(file, password);
      expect(validateSnapshot(opened).size).toBe(23);
      expect([...client.calls.keys()].some(name => name.startsWith('pdd_recipient_'))).toBe(false);
      const sql = async (statement: string) => { const result = await database.exec(statement); const row = result.at(-1)?.rows[0]; return row ? String(Object.values(row)[0]) : ''; };
      expect(await restoreAndCompare(opened, sql)).toMatchObject({ tables: 23, auditActorPlaceholders: 1 });
      expect(await sql("select count(*) from information_schema.columns where table_schema='public' and table_name='pdd_registrations' and column_name='recipient_name'")).toBe('0');
      expect(await sql("select count(*) from information_schema.tables where table_schema='public' and table_name like 'pdd_recipient_%'")).toBe('0');
      expect(() => validateSnapshot({ ...opened, migrations: fixture.migrations })).toThrow('Incomplete');
    } finally { await database.close(); await rm(directory, { recursive: true, force: true }); }
  }, 30_000);
  it('restores the pre-six-stat schema and rejects a new manifest with missing lifetime markers', async () => {
    const migrations = fixture.migrations.filter(entry => entry.version < '20261007121000');
    const old = await snapshotForMigrations(migrations);
    const directory = await mkdtemp(path.join(tmpdir(), 'pdd404-pre-six-stats-test-'));
    const database = new PGlite({ extensions: { pgcrypto } });
    try {
      const file = path.join(directory, 'legacy.cmibak');
      await writeEncryptedChunks(file, password, snapshotChunks(mockClient(false, false, old), { project, migrations }));
      const opened = await readEncryptedSnapshot(file, password);
      const sql = async (statement: string) => { const result = await database.exec(statement); const row = result.at(-1)?.rows[0]; return row ? String(Object.values(row)[0]) : ''; };
      expect(await restoreAndCompare(opened, sql)).toMatchObject({ tables: 26, auditActorPlaceholders: 1 });
      expect(await sql("select count(*) from information_schema.columns where table_schema='public' and column_name in ('recipient_registered_at','recipient_matched_at')")).toBe('0');
      expect(JSON.parse(await sql("select public.pdd_home_stats('{}'::jsonb)::text"))).toEqual({ lostRegistered: 2, receivedRegistered: 1, matchedParcels: 1 });
    } finally { await database.close(); await rm(directory, { recursive: true, force: true }); }
    for (const column of ['recipient_registered_at', 'recipient_matched_at']) {
      const incomplete = structuredClone(fixture);
      const table = incomplete.tables.find(table => table.name === 'pdd_registrations')!;
      delete table.rows[0][column]; table.sha256 = rowsHash(table.rows);
      const target = new PGlite({ extensions: { pgcrypto } });
      try {
        const sql = async (statement: string) => { const result = await target.exec(statement); const row = result.at(-1)?.rows[0]; return row ? String(Object.values(row)[0]) : ''; };
        await expect(restoreAndCompare(incomplete, sql)).rejects.toThrow('columns differ');
      } finally { await target.close(); }
    }
  }, 30_000);
  it('restores an encrypted pre-telemetry 21-table snapshot without requiring or reading new aggregates', async () => {
    const migrations = fixture.migrations.filter(entry => entry.version < TELEMETRY_MIGRATION);
    const old = await snapshotForMigrations(migrations);
    const database = new PGlite({ extensions: { pgcrypto } });
    const directory = await mkdtemp(path.join(tmpdir(), 'pdd404-pre-telemetry-scoped-test-'));
    try {
      const file = path.join(directory, 'legacy.cmibak'), client = mockClient(false, false, old);
      await writeEncryptedChunks(file, password, snapshotChunks(client, { project, migrations }));
      const opened = await readEncryptedSnapshot(file, password);
      expect(validateSnapshot(opened).size).toBe(21);
      expect(client.calls.has('pdd_telemetry_daily')).toBe(false);
      expect(client.calls.has('pdd_telemetry_budget')).toBe(false);
      const sql = async (statement: string) => { const result = await database.exec(statement); const row = result.at(-1)?.rows[0]; return row ? String(Object.values(row)[0]) : ''; };
      expect(await restoreAndCompare(opened, sql)).toMatchObject({ tables: 21, auditActorPlaceholders: 1 });
      expect(await sql("select count(*) from public.pdd_feedback where status='reviewed'")).toBe('1');
      expect(await sql("select count(*) from information_schema.tables where table_schema='public' and table_name in ('pdd_telemetry_daily','pdd_telemetry_budget')")).toBe('0');
      expect(() => validateSnapshot({ ...opened, migrations: fixture.migrations })).toThrow('Incomplete');
    } finally { await database.close(); await rm(directory, { recursive: true, force: true }); }
  }, 30_000);
  it('restores an encrypted pre-feedback 20-table snapshot using its original migration manifest', async () => {
    const migrations = fixture.migrations.filter(entry => entry.version < FEEDBACK_MIGRATION);
    const legacy = new PGlite({ extensions: { pgcrypto } }), restored = new PGlite({ extensions: { pgcrypto } });
    const directory = await mkdtemp(path.join(tmpdir(), 'pdd404-legacy-scoped-test-'));
    try {
      await legacy.exec(BOOTSTRAP_SQL);
      for (const statement of await verifiedMigrations({ migrations })) await legacy.exec(statement);
      await legacy.query('select public.pdd_batch_register($1::jsonb)', [JSON.stringify({ request_id: randomUUID(), mode: 'received', contact: { kind: 'wechat', value: 'fictional_legacy_holder' }, capability_hash: 'a'.repeat(64), body_hash: 'legacy-batch', items: [{ request_id: randomUUID(), number: 'LEGACY0012345', source: 'manual' }] })]);
      const tables: Snapshot['tables'] = [];
      for (const table of tablesForMigrations(migrations)) {
        const rows = (await legacy.query<{ value: Row }>(`select to_jsonb(row) value from public.${table.name} row`)).rows.map(row => row.value);
        tables.push({ name: table.name, rows, rowCount: rows.length, sha256: rowsHash(rows) });
      }
      const old: Snapshot = { format: FORMAT, project, migrations, tables, storage: [] };
      const file = path.join(directory, 'legacy.cmibak');
      const client = mockClient(false, false, old);
      await writeEncryptedChunks(file, password, snapshotChunks(client, { project, migrations }));
      const opened = await readEncryptedSnapshot(file, password);
      expect(validateSnapshot(opened).size).toBe(20); expect(client.calls.has('pdd_feedback')).toBe(false);
      const sql = async (statement: string) => { const result = await restored.exec(statement); const row = result.at(-1)?.rows[0]; return row ? String(Object.values(row)[0]) : ''; };
      expect(await restoreAndCompare(opened, sql)).toMatchObject({ tables: 20, auditActorPlaceholders: 0 });
      expect((await restored.query<{ contact: unknown }>('select contact from public.pdd_registrations')).rows).toEqual([{ contact: { kind: 'wechat', value: 'fictional_legacy_holder' } }]);
      expect(await sql("select count(*) from information_schema.tables where table_schema='public' and table_name='pdd_feedback'")).toBe('0');
      // The same 20 tables are incomplete if the header claims the new schema.
      expect(() => validateSnapshot({ ...opened, migrations: fixture.migrations })).toThrow('Incomplete');
    } finally { await legacy.close(); await restored.close(); await rm(directory, { recursive: true, force: true }); }
  }, 30_000);
  it('rejects incomplete cross-table references with the actual FK constraint', async () => {
    const broken = structuredClone(fixture);
    const registrations = broken.tables.find(table => table.name === 'pdd_registrations')!;
    registrations.rows[0].waybill_id = randomUUID();
    registrations.sha256 = rowsHash(registrations.rows);
    const database = new PGlite({ extensions: { pgcrypto } });
    try {
      const sql = async (statement: string): Promise<string> => {
        const results = await database.exec(statement);
        const last = results.at(-1)?.rows[0];
        return last ? String(Object.values(last)[0]) : '';
      };
      await expect(restoreAndCompare(broken, sql)).rejects.toThrow(/foreign key/);
    } finally { await database.close(); }
  }, 30_000);
  it('rejects a recipient snapshot with missing new columns or a restored name RPC exposed to browsers', async () => {
    const missingColumn = structuredClone(fixture);
    const registrations = missingColumn.tables.find(table => table.name === 'pdd_registrations')!;
    delete registrations.rows[0].recipient_name_key;
    registrations.sha256 = rowsHash(registrations.rows);
    for (const exposeRpc of [false, true]) {
      const database = new PGlite({ extensions: { pgcrypto } });
      try {
        const sql = async (statement: string): Promise<string> => {
          if (exposeRpc && statement.includes("'signature',p.oid::regprocedure::text")) await database.exec('grant execute on function public.pdd_recipient_query(jsonb) to authenticated;');
          const results = await database.exec(statement);
          const last = results.at(-1)?.rows[0];
          return last ? String(Object.values(last)[0]) : '';
        };
        await expect(restoreAndCompare(exposeRpc ? fixture : missingColumn, sql)).rejects.toThrow(exposeRpc ? 'private PDD RPC has browser access' : 'columns differ');
      } finally { await database.close(); }
    }
  }, 30_000);
  it.runIf(process.env.RUN_SCOPED_POSTGRES_TEST === 'true')('runs authenticated restore in disposable real PostgreSQL using no cloud URL', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdd404-pg-scoped-test-'));
    try {
      const file = path.join(directory, 'snapshot.cmibak');
      await writeFixture(file);
      expect(await verifyScopedRestore(file, password)).toMatchObject({ tables: 28, storageObjects: 2, auditActorPlaceholders: 1 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30_000);
});
