import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
// @ts-expect-error Native operational ESM is intentionally outside TS compilation.
import { TABLES, FORMAT, migrationManifest, readEncryptedSnapshot, rowsHash, sanitizeRow, sha256, snapshotChunks, writeEncryptedChunks } from '../scripts/backup-scoped.mjs';
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
  const batch = { request_id: id(), mode: 'received', contact: { kind: 'wechat', value: 'fictional_holder' }, capability_hash: 'a'.repeat(64), body_hash: 'synthetic-batch', items: [{ request_id: id(), number: '001234560001', source: 'barcode' }] };
  const registered = (await source.query<{ value: { items: { record: { code: string } }[] } }>('select public.pdd_batch_register($1::jsonb) value', [JSON.stringify(batch)])).rows[0].value;
  const query = { query_id: id(), number: '001234560001', mode: 'lost', source: 'manual', capability_hash: 'b'.repeat(64), body_hash: 'synthetic-query' };
  await source.query('select public.pdd_query($1::jsonb)', [JSON.stringify(query)]);
  await source.query('select public.pdd_query_contact($1::jsonb)', [JSON.stringify({ query_id: query.query_id, capability_hash: query.capability_hash, contact: { kind: 'wechat', value: 'fictional_owner' }, idempotency_key: 'synthetic-contact', body_hash: 'synthetic-contact' })]);
  const beforeClaim = (await source.query<{ revision: number }>('select revision from public.pdd_waybills')).rows[0].revision;
  await source.query('select public.pdd_admin_action($1::jsonb)', [JSON.stringify({ public_code: registered.items[0].record.code, revision: beforeClaim, action: 'claim', actor_id: actor, notes: 'Synthetic verification.' })]);
  const revision = (await source.query<{ revision: number }>('select revision from public.pdd_waybills')).rows[0].revision;
  await source.query('select public.pdd_admin_action($1::jsonb)', [JSON.stringify({ public_code: registered.items[0].record.code, revision, action: 'return', actor_id: actor, notes: 'Synthetic handover.' })]);
  const tables = [];
  for (const name of tableNames) {
    const rows = (await source.query<{ value: Row }>(`select to_jsonb(row) value from public.${name} row`)).rows.map(row => row.value);
    tables.push({ name, rows, rowCount: rows.length, sha256: rowsHash(rows) });
  }
  const bytes = Buffer.from('synthetic storage bytes');
  fixture = { format: FORMAT, project, migrations, tables, storage: [{ bucket: 'community-assets', key: 'synthetic/example.bin', mime: 'application/octet-stream', size: bytes.length, sha256: sha256(bytes), base64: bytes.toString('base64') }] };
}, 30_000);
afterAll(async () => { await source?.close(); });

function mockClient(changed = false, runtimeChanged = false) {
  const calls = new Map<string, number>();
  return {
    calls,
    from(name: string) {
      const request = { select: () => request, order: () => request, range: async () => {
        calls.set(name, (calls.get(name) || 0) + 1);
        const rows = fixture.tables.find(table => table.name === name)!.rows;
        if (runtimeChanged && name === 'site_settings') return { data: rows.map(row => row.key === 'runtime' ? { ...row, value: { ...(row.value as Row), WORKER_SECRET: calls.get(name) === 1 ? 'synthetic-first' : 'synthetic-second' } } : row), error: null };
        return { data: changed && name === 'pdd_waybills' && calls.get(name) === 2 ? [] : rows, error: null };
      } }; return request;
    },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) },
  };
}
async function writeFixture(file: string) {
  await writeEncryptedChunks(file, password, [JSON.stringify(fixture)]);
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
      expect(validateSnapshot(opened).size).toBe(20);
      expect(client.calls.size).toBe(20);
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
      expect(result).toMatchObject({ tables: 20, storageObjects: 1, auditActorPlaceholders: 1 });
    } finally { await database.close(); }
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
  it.runIf(process.env.RUN_SCOPED_POSTGRES_TEST === 'true')('runs authenticated restore in disposable real PostgreSQL using no cloud URL', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdd404-pg-scoped-test-'));
    try {
      const file = path.join(directory, 'snapshot.cmibak');
      await writeFixture(file);
      expect(await verifyScopedRestore(file, password)).toMatchObject({ tables: 20, storageObjects: 1, auditActorPlaceholders: 1 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30_000);
});
