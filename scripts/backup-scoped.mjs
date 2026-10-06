// Scoped public-row/storage snapshot. REST reads are NOT an atomic pg_dump.
// Only encrypted bytes reach disk; Auth credentials and Vault are never read.
import { createClient } from '@supabase/supabase-js';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectGuard, required } from './ops.mjs';

export const FORMAT = 'pdd404-scoped-row-snapshot-v1';
export const FEEDBACK_MIGRATION = '20261006141735';
export const TABLES = Object.freeze([
  ['scans', ['id']], ['images', ['id']], ['records', ['id']], ['evidence', ['id']],
  ['jobs', ['id']], ['matches', ['id']], ['followups', ['id']], ['handovers', ['id']],
  ['daily_budgets', ['day', 'environment']], ['budget_reservations', ['id']],
  ['idempotency_keys', ['scope', 'key']], ['rate_limits', ['key', 'window_start']],
  ['site_settings', ['key']], ['audit_events', ['id']], ['pdd_waybills', ['id']],
  ['pdd_registrations', ['id']], ['pdd_query_events', ['id']],
  ['pdd_write_requests', ['scope', 'key']], ['pdd_audit_events', ['id']], ['pdd_handovers', ['waybill_id']],
  ['pdd_feedback', ['id']],
].map(([name, order]) => Object.freeze({ name, order: Object.freeze(order) })));
// Older encrypted snapshots must reconstruct their original schema. A snapshot
// declaring the feedback migration must include that table, even when empty.
export function tablesForMigrations(migrations) {
  if (!Array.isArray(migrations) || !migrations.length) throw new Error('Invalid scoped migration manifest.');
  const hasFeedback = migrations.some(entry => entry?.version === FEEDBACK_MIGRATION);
  return hasFeedback ? TABLES : TABLES.filter(table => table.name !== 'pdd_feedback');
}
export const BUCKETS = Object.freeze(['parcel-originals', 'parcel-public', 'community-assets']);
export const RUNTIME_KEYS = Object.freeze(['APP_ENVIRONMENT', 'APP_PUBLIC_URL', 'ALLOWED_ORIGINS', 'ADMIN_USER_IDS', 'APP_SHA', 'OCR_ENABLED']);
const MAGIC = Buffer.from('CMIBAK01');
const MIGRATIONS = new URL('../supabase/migrations/', import.meta.url);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function rowsHash(rows) { return sha256(rows.map(canonical).sort().join('\n')); }
export function safeStorageKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= 1024 && !key.includes('\\') && !key.includes('\0') && key.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
export function sanitizeRow(table, row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`Invalid ${table} row.`);
  if (table !== 'site_settings' || row.key !== 'runtime') return row;
  const value = {};
  for (const key of RUNTIME_KEYS) if (typeof row.value?.[key] === 'string') value[key] = row.value[key];
  return { ...row, value };
}
export async function migrationManifest() {
  const names = (await readdir(MIGRATIONS)).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
  return Promise.all(names.map(async name => ({ version: name.split('_')[0], name, sha256: sha256(await readFile(new URL(name, MIGRATIONS))) })));
}
async function* tablePages(client, table) {
  for (let offset = 0; ; offset += 500) {
    let request = client.from(table.name).select('*');
    for (const column of table.order) request = request.order(column, { ascending: true });
    const { data, error } = await request.range(offset, offset + 499);
    if (error || !Array.isArray(data)) throw new Error(`Unable to read scoped table ${table.name}.`);
    yield data;
    if (data.length < 500) return;
  }
}
async function* storageObjects(client, bucket, prefix = '', depth = 0) {
  if (depth > 64) throw new Error('Storage nesting is too deep.');
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await client.storage.from(bucket).list(prefix, { limit: 100, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error || !Array.isArray(data)) throw new Error('Unable to list scoped storage.');
    for (const item of data) {
      if (typeof item.name !== 'string' || item.name.includes('/')) throw new Error('Invalid storage entry.');
      const key = prefix ? `${prefix}/${item.name}` : item.name;
      if (!safeStorageKey(key)) throw new Error('Invalid storage key.');
      if (!item.id) { yield* storageObjects(client, bucket, key, depth + 1); continue; }
      const { data: blob, error: downloadError } = await client.storage.from(bucket).download(key);
      if (downloadError || !blob) throw new Error('Incomplete scoped storage backup.');
      const bytes = Buffer.from(await blob.arrayBuffer());
      yield { bucket, key, mime: blob.type || 'application/octet-stream', size: bytes.length, sha256: sha256(bytes), base64: bytes.toString('base64') };
    }
    if (data.length < 100) return;
  }
}

// Returns chunks of JSON without accumulating the full snapshot. Table hashes
// are rechecked before this generator completes and the encrypted file commits.
export async function* snapshotChunks(client, metadata, summary = {}) {
  const tables = tablesForMigrations(metadata.migrations);
  const header = {
    format: FORMAT, ...metadata, startedAt: new Date().toISOString(),
    schemaSource: 'repository-migrations',
    limitations: [
      'Non-atomic REST row/storage reads, not a database-wide transaction or native pg_dump. Two matching row reads do not prove snapshot isolation.',
      'Auth credentials, Auth metadata, Vault, database roles, catalog ACLs and custom schema changes are excluded.',
      'Migrations are taken from this checkout, not the deployed database migration catalog.',
      'Runtime settings contain only an explicit safe allowlist; excluded runtime secrets must be configured separately.',
      'Storage is read once; concurrent storage changes are not covered by the row consistency comparison.',
    ],
  };
  yield JSON.stringify(header).slice(0, -1) + ',"tables":[';
  const hashes = new Map();
  summary.tableRows = {}; summary.storageObjects = 0; summary.tables = tables.length;
  for (let index = 0; index < tables.length; index++) {
    const table = tables[index], normalized = [], consistency = [];
    if (index) yield ',';
    yield `{"name":${JSON.stringify(table.name)},"rows":[`;
    let count = 0;
    for await (const page of tablePages(client, table)) {
      for (const original of page) {
        const row = sanitizeRow(table.name, original);
        if (count) yield ',';
        yield JSON.stringify(row);
        normalized.push(canonical(row)); consistency.push(canonical(original)); count++;
      }
    }
    const digest = sha256(normalized.sort().join('\n'));
    hashes.set(table.name, { count, digest: sha256(consistency.sort().join('\n')) }); summary.tableRows[table.name] = count;
    yield `],"rowCount":${count},"sha256":${JSON.stringify(digest)}}`;
  }
  yield '],"storage":[';
  let files = 0;
  for (const bucket of BUCKETS) for await (const item of storageObjects(client, bucket)) {
    if (files++) yield ',';
    yield JSON.stringify(item);
  }
  summary.storageObjects = files;
  // A bounded second complete read rejects a changing dataset. No hidden retry.
  for (const table of tables) {
    const normalized = [];
    for await (const page of tablePages(client, table)) for (const row of page) normalized.push(canonical(row));
    const first = hashes.get(table.name);
    if (normalized.length !== first.count || sha256(normalized.sort().join('\n')) !== first.digest) throw new Error(`Scoped table ${table.name} changed during backup; retry in a quiet window.`);
  }
  summary.verifiedAt = new Date().toISOString();
  yield `],"verifiedAt":${JSON.stringify(summary.verifiedAt)}}`;
}

export async function writeEncryptedChunks(destination, password, chunks) {
  if (typeof password !== 'string' || password.length < 24) throw new Error('BACKUP_PASSWORD must have at least 24 characters.');
  if (!destination.endsWith('.cmibak')) throw new Error('An encrypted .cmibak output path is required.');
  await mkdir(path.dirname(path.resolve(destination)), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.partial-${randomUUID()}`;
  const salt = randomBytes(16), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(password, salt, 32), iv);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(Buffer.concat([MAGIC, salt, iv]));
    for await (const chunk of chunks) await handle.writeFile(cipher.update(chunk, 'utf8'));
    await handle.writeFile(Buffer.concat([cipher.final(), cipher.getAuthTag()]));
    await handle.sync();
    await handle.close();
    // A hard link atomically publishes a completed file without overwriting one.
    await link(temporary, destination);
  } finally { await handle.close().catch(() => undefined); await rm(temporary, { force: true }); }
}
export async function readEncryptedSnapshot(source, password) {
  if (typeof password !== 'string' || password.length < 24) throw new Error('BACKUP_PASSWORD must have at least 24 characters.');
  const info = await stat(source);
  if (!info.isFile() || info.size < 52 || info.size > 1024 * 1024 * 1024) throw new Error('Invalid or oversized encrypted scoped backup.');
  const sealed = await readFile(source);
  if (!sealed.subarray(0, 8).equals(MAGIC)) throw new Error('Invalid backup format.');
  const decipher = createDecipheriv('aes-256-gcm', scryptSync(password, sealed.subarray(8, 24), 32), sealed.subarray(24, 36));
  decipher.setAuthTag(sealed.subarray(-16));
  let plaintext;
  try { plaintext = Buffer.concat([decipher.update(sealed.subarray(36, -16)), decipher.final()]); }
  catch { throw new Error('Encrypted backup authentication failed.'); }
  try { return JSON.parse(plaintext.toString('utf8')); }
  catch { throw new Error('Authenticated backup does not contain valid scoped JSON.'); }
  finally { plaintext.fill(0); }
}
export async function backupScoped(destination) {
  const project = projectGuard(), password = required('BACKUP_PASSWORD');
  if (password.length < 24) throw new Error('BACKUP_PASSWORD must have at least 24 characters.');
  const url = new URL(required('SUPABASE_URL'));
  if (url.protocol !== 'https:' || url.hostname !== `${project}.supabase.co` || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Scoped backup project URL mismatch.');
  const client = createClient(url.href, required('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
  const output = destination || path.join('backups', `pdd404-scoped-${project}-${Date.now()}.cmibak`);
  const summary = {};
  await writeEncryptedChunks(output, password, snapshotChunks(client, { project, appSha: process.env.APP_SHA || null, migrations: await migrationManifest() }, summary));
  if (!destination) {
    const prefix = `pdd404-scoped-${project}-`;
    const retained = (await readdir('backups')).filter(name => name.startsWith(prefix) && name.endsWith('.cmibak')).sort().reverse();
    for (const name of retained.slice(7)) await rm(path.join('backups', name));
  }
  console.log(`Encrypted scoped snapshot created: ${path.basename(output)}; ${summary.tables} tables, ${summary.storageObjects} storage objects. Two row reads matched. Offline restore verification is still required.`);
  return { output, ...summary };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  backupScoped(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
