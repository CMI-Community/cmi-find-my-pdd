// This verifier NEVER connects to Supabase or accepts a database connection URL.
// Authenticated JSON stays in memory. A disposable local DB is removed afterward.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUCKETS, FORMAT, RUNTIME_KEYS, migrationManifest, readEncryptedSnapshot, rowsHash, safeStorageKey, sha256, tablesForMigrations } from './backup-scoped.mjs';
import { required } from './ops.mjs';

const run = promisify(execFile);
const migrationDirectory = new URL('../supabase/migrations/', import.meta.url);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const quote = value => "'" + JSON.stringify(value).replaceAll("'", "''") + "'::jsonb";

export function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.format !== FORMAT || !/^[a-z]{20}$/.test(snapshot.project || '') || snapshot.project === 'osqyplgctlzdlpqmzfud') throw new Error('Invalid independent scoped snapshot.');
  if (!Array.isArray(snapshot.tables) || !Array.isArray(snapshot.storage) || !Array.isArray(snapshot.migrations) || !snapshot.migrations.length) throw new Error('Incomplete scoped snapshot.');
  const definitions = tablesForMigrations(snapshot.migrations);
  if (snapshot.tables.length !== definitions.length) throw new Error('Incomplete scoped snapshot.');
  const names = new Set(definitions.map(table => table.name)), tables = new Map();
  for (const table of snapshot.tables) {
    if (!table || !names.has(table.name) || tables.has(table.name) || !Array.isArray(table.rows) || table.rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('Invalid or duplicated scoped table.');
    if (table.rowCount !== undefined && table.rowCount !== table.rows.length) throw new Error(`Invalid row count for ${table.name}.`);
    if (table.sha256 !== undefined && table.sha256 !== rowsHash(table.rows)) throw new Error(`Invalid row digest for ${table.name}.`);
    if (table.name === 'site_settings') for (const row of table.rows) {
      if (row.key === 'runtime' && Object.keys(row.value || {}).some(key => !RUNTIME_KEYS.includes(key))) throw new Error('Runtime secrets are not allowed in a scoped snapshot.');
    }
    tables.set(table.name, table.rows);
  }
  const objects = new Set();
  for (const item of snapshot.storage) {
    if (!item || !BUCKETS.includes(item.bucket) || !safeStorageKey(item.key) || typeof item.mime !== 'string' || typeof item.base64 !== 'string' || !Number.isSafeInteger(item.size) || item.size < 0) throw new Error('Invalid scoped storage object.');
    const identity = `${item.bucket}/${item.key}`;
    if (objects.has(identity)) throw new Error('Duplicate scoped storage object.');
    objects.add(identity);
    const bytes = Buffer.from(item.base64, 'base64');
    if (bytes.toString('base64') !== item.base64 || bytes.length !== item.size || sha256(bytes) !== item.sha256) throw new Error('Scoped storage checksum mismatch.');
  }
  const versions = new Set();
  for (const migration of snapshot.migrations) {
    if (!migration || !/^\d+$/.test(migration.version || '') || versions.has(migration.version) || (migration.name !== undefined && !/^[a-zA-Z0-9_-]+(?:\.sql)?$/.test(migration.name)) || (migration.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(migration.sha256))) throw new Error('Invalid scoped migration manifest.');
    versions.add(migration.version);
  }
  return tables;
}

export async function verifiedMigrations(snapshot) {
  const local = await migrationManifest(), output = [];
  for (const entry of [...snapshot.migrations].sort((a, b) => a.version.localeCompare(b.version))) {
    const migration = local.find(item => item.version === entry.version);
    // Older private snapshots recorded a cloud migration name without .sql.
    if (!migration || (entry.name?.endsWith('.sql') && entry.name !== migration.name) || (entry.sha256 && entry.sha256 !== migration.sha256)) throw new Error('Required migration is missing or differs from this checkout.');
    output.push((await readFile(new URL(migration.name, migrationDirectory), 'utf8'))
      .replace(/^create extension if not exists pg_net.*$/m, '')
      .replace(/^create extension if not exists pg_cron.*$/m, ''));
  }
  return output;
}

export const BOOTSTRAP_SQL = `
  create role anon; create role authenticated; create role service_role bypassrls;
  create schema extensions; create extension pgcrypto with schema extensions;
  create schema auth; create table auth.users(id uuid primary key,email text);
  create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
  create schema net; create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as 'select 1::bigint';
  create schema cron; create function cron.schedule(job_name text,schedule text,command text) returns bigint language sql as 'select 1::bigint';
`;

// Every table is loaded by one statement inside one transaction, preserving
// self-references and cross-table FK checks. No constraint is disabled.
export async function restoreAndCompare(snapshot, sql) {
  const tables = validateSnapshot(snapshot);
  const definitions = tablesForMigrations(snapshot.migrations);
  const migrations = await verifiedMigrations(snapshot);
  await sql(BOOTSTRAP_SQL);
  for (const migration of migrations) await sql(migration);
  const actorIds = new Set();
  for (const name of ['audit_events', 'handovers', 'pdd_audit_events', 'pdd_handovers', 'pdd_recipient_audit_events']) for (const row of tables.get(name) ?? []) {
    if (row.actor_id != null) {
      if (!uuid.test(row.actor_id)) throw new Error('Invalid audit actor UUID.');
      actorIds.add(row.actor_id);
    }
  }
  const statements = ['begin;', `truncate ${definitions.map(table => `public.${table.name}`).join(',')} cascade;`];
  if (actorIds.size) statements.push(`insert into auth.users(id) select value::uuid from jsonb_array_elements_text(${quote([...actorIds])});`);
  for (const table of definitions) {
    const rows = tables.get(table.name);
    if (!rows.length) continue;
    const columns = JSON.parse(await sql(`select jsonb_agg(column_name)::text from information_schema.columns where table_schema='public' and table_name='${table.name}';`));
    if (rows.some(row => Object.keys(row).length !== columns.length || columns.some(column => !(column in row)))) throw new Error(`Scoped row columns differ from migration schema for ${table.name}.`);
    statements.push(`insert into public.${table.name} select * from jsonb_populate_recordset(null::public.${table.name},${quote(rows)});`);
  }
  statements.push('commit;');
  await sql(statements.join('\n'));
  for (const table of definitions) {
    const expected = JSON.parse(await sql(`select coalesce(jsonb_agg(to_jsonb(row)),'[]'::jsonb)::text from jsonb_populate_recordset(null::public.${table.name},${quote(tables.get(table.name))}) row;`));
    const actual = JSON.parse(await sql(`select coalesce(jsonb_agg(to_jsonb(row)),'[]'::jsonb)::text from public.${table.name} row;`));
    if (rowsHash(expected) !== rowsHash(actual)) throw new Error(`Restored rows differ for ${table.name}.`);
    const permissions = JSON.parse(await sql(`select jsonb_build_object('rls',relrowsecurity,'anon',has_table_privilege('anon',oid,'SELECT,INSERT,UPDATE,DELETE'),'authenticated',has_table_privilege('authenticated',oid,'SELECT,INSERT,UPDATE,DELETE'))::text from pg_class where oid='public.${table.name}'::regclass;`));
    if (!permissions.rls || permissions.anon || permissions.authenticated) throw new Error(`Restored table access is not private for ${table.name}.`);
  }
  const rpcPermissions = JSON.parse(await sql(`select coalesce(jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,
    'anon',has_function_privilege('anon',p.oid,'EXECUTE'),'authenticated',has_function_privilege('authenticated',p.oid,'EXECUTE'))),'[]')::text
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'pdd_%';`));
  if (!rpcPermissions.length || rpcPermissions.some(permission => permission.anon || permission.authenticated)) throw new Error('Restored private PDD RPC has browser access.');
  if (Number(await sql('select count(*) from auth.users;')) !== actorIds.size) throw new Error('Audit actor placeholders were not restored.');
  // Storage bytes have authenticated size/hash verification in memory. There is
  // no Supabase endpoint or disk extraction; actual bucket restore is separate.
  return { tables: definitions.length, rows: [...tables.values()].reduce((sum, rows) => sum + rows.length, 0), storageObjects: snapshot.storage.length, auditActorPlaceholders: actorIds.size };
}

async function postgresBin() {
  for (const directory of [process.env.PDD_PG_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/usr/lib/postgresql/17/bin', '/usr/lib/postgresql/16/bin'].filter(Boolean)) {
    try { await access(path.join(directory, 'postgres')); await access(path.join(directory, 'initdb')); return directory; } catch {}
  }
  throw new Error('Set PDD_PG_BIN to an installed PostgreSQL server bin directory.');
}
export async function verifyScopedRestore(source, password) {
  const snapshot = await readEncryptedSnapshot(source, password);
  validateSnapshot(snapshot);
  const bin = await postgresBin();
  const temporary = await mkdtemp(path.join(tmpdir(), 'pdd404-scoped-restore-'));
  const data = path.join(temporary, 'data'), socket = path.join(temporary, 'socket');
  await mkdir(socket, { mode: 0o700 });
  // No TCP listener. Ignore inherited database credentials and connection URLs.
  const port = String(56000 + Math.floor(Math.random() * 8000));
  const env = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', PGHOST: socket, PGPORT: port, PGUSER: userInfo().username, PGDATABASE: 'postgres', PGCONNECT_TIMEOUT: '5' };
  let running = false;
  async function sql(statement) {
    return new Promise((resolve, reject) => {
      const child = spawn(path.join(bin, 'psql'), ['-X', '-A', '-t', '-q', '--set', 'ON_ERROR_STOP=1'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', failed = false;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.length > 1024 * 1024 * 1024) { failed = true; child.kill(); }
      });
      // Do not surface SQL errors that can contain contacts or full waybills.
      child.stderr.resume();
      child.on('error', () => { failed = true; reject(new Error('Unable to start offline PostgreSQL client.')); });
      child.on('close', code => code === 0 && !failed ? resolve(output.trim()) : reject(new Error('Offline restore SQL failed; no private row data has been printed.')));
      child.stdin.on('error', () => undefined);
      child.stdin.end(statement + '\n');
    });
  }
  try {
    await run(path.join(bin, 'initdb'), ['-D', data, '--auth=trust', '--no-locale', '--encoding=UTF8'], { env, maxBuffer: 1024 * 1024 });
    await run(path.join(bin, 'pg_ctl'), ['-D', data, '-l', path.join(temporary, 'postgres.log'), '-o', `-F -k ${socket} -h '' -p ${port} -c log_min_error_statement=panic -c log_statement=none`, '-w', 'start'], { env });
    running = true;
    const result = await restoreAndCompare(snapshot, sql);
    console.log(`Offline scoped restore passed: ${result.tables} tables, ${result.rows} rows; ${result.storageObjects} storage checksums verified in memory. Auth credentials/bucket deployment were not restored. Temporary database removed on exit.`);
    return result;
  } finally {
    if (running) await run(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { env }).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) { console.error('Usage: node scripts/verify-scoped-restore.mjs encrypted.cmibak'); process.exitCode = 1; }
  else verifyScopedRestore(process.argv[2], required('BACKUP_PASSWORD')).catch(error => { console.error(error.message); process.exitCode = 1; });
}
