// Disposable real PostgreSQL transactions/concurrency and encrypted restore.
// This script accepts no production connection string and never touches cloud data.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { encryptFile, decryptFile } from './crypto.mjs';

const run = promisify(execFile);
let bin;
for (const candidate of [process.env.PDD_PG_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/usr/lib/postgresql/17/bin', '/usr/lib/postgresql/16/bin'].filter(Boolean)) {
  try { await access(path.join(candidate, 'postgres')); bin = candidate; break; } catch {}
}
if (!bin) throw new Error('Set PDD_PG_BIN to an installed PostgreSQL server bin directory.');
const root = await mkdtemp(path.join(tmpdir(), 'pdd404-pg-check-'));
const data = path.join(root, 'data'), socket = path.join(root, 'socket');
await mkdir(socket);
const port = 56000 + Math.floor(Math.random() * 8000);
const env = { ...process.env, PGHOST: socket, PGPORT: String(port), PGUSER: userInfo().username, PGDATABASE: 'postgres', PGCONNECT_TIMEOUT: '5' };
const capA = 'a'.repeat(64), capB = 'b'.repeat(64);
const quote = value => "'" + JSON.stringify(value).replaceAll("'", "''") + "'::jsonb";
const invoke = (name, payload) => `select public.${name}(${quote(payload)})::text;`;
let running = false;
async function sql(statement, database = 'postgres', extraEnvironment = {}) {
  const { stdout } = await run(path.join(bin, 'psql'), ['-X', '-A', '-t', '-q', '--set', 'ON_ERROR_STOP=1', '--dbname', database, '--command', statement], { env: { ...env, ...extraEnvironment }, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}
async function rpc(name, payload, database) { return JSON.parse(await sql(invoke(name, payload), database)); }
async function bootstrap(database, roles = false) {
  await sql(`${roles ? 'create role anon; create role authenticated; create role service_role bypassrls;' : ''}
    create schema extensions; create extension pgcrypto with schema extensions;
    create schema auth; create table auth.users(id uuid primary key,email text);
    create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create schema net; create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as 'select 1::bigint';
    create schema cron; create function cron.schedule(job_name text,schedule text,command text) returns bigint language sql as 'select 1::bigint';`, database);
}
const batch = (number, mode, capability, person, requestId = randomUUID()) => ({ request_id: requestId, mode, contact: { kind: 'wechat', value: person },
  items: [{ request_id: randomUUID(), number, source: 'manual' }], capability_hash: capability, body_hash: randomBytes(32).toString('hex') });
function transactionSession() {
  const child = spawn(path.join(bin, 'psql'), ['-X', '-A', '-t', '-q', '--set', 'ON_ERROR_STOP=1'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '', ended = false;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const completion = new Promise(resolve => { child.once('exit', code => { ended = true; resolve(code); }); });
  return {
    send: statement => child.stdin.write(statement + '\n'),
    async marker(text) {
      const deadline = Date.now() + 10_000;
      while (!output.split('\n').includes(text)) {
        if (ended || Date.now() >= deadline) throw new Error(`Transaction barrier failed: ${errors || text}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    },
    async close() { if (!ended) child.stdin.end('rollback;\n\\q\n'); await completion; },
  };
}
try {
  await run(path.join(bin, 'initdb'), ['-D', data, '--auth=trust', '--no-locale', '--encoding=UTF8'], { env, maxBuffer: 1024 * 1024 });
  await run(path.join(bin, 'pg_ctl'), ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-F -k ${socket} -h 127.0.0.1 -p ${port}`, '-w', 'start'], { env });
  running = true;
  await bootstrap('postgres', true);
  const directory = new URL('../supabase/migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(n => /^\d+_.+\.sql$/.test(n)).sort()) {
    const migration = (await readFile(new URL(name, directory), 'utf8')).replace(/^create extension if not exists pg_net.*$/m, '').replace(/^create extension if not exists pg_cron.*$/m, '');
    await sql(migration);
  }
  await sql(await readFile(new URL('../tests/db.sql', import.meta.url), 'utf8'));
  assert.equal((await rpc('runtime_config', {})).OCR_ENABLED, 'false');
  console.log('Legacy real PostgreSQL transaction regression and server-only OCR default passed.');

  const missing = { query_id: randomUUID(), number: '000990000001', mode: 'lost', source: 'manual', capability_hash: capA, body_hash: 'synthetic-miss' };
  const first = await rpc('pdd_query', missing);
  assert.equal(first.result, 'not_found');
  await rpc('pdd_query', missing);
  assert.equal(await sql('select count(*) from public.pdd_query_events;'), '1');

  // Independent connections contend while one transaction keeps the number lock.
  const sameA = batch('SF990000006001', 'lost', capA, 'fictional_owner');
  const sameB = batch('SF990000006001', 'lost', capB, 'fictional_other');
  const held = sql(`begin; ${invoke('pdd_batch_register', sameA)} select pg_sleep(0.35); commit;`);
  await new Promise(resolve => setTimeout(resolve, 70));
  const [heldOutput, contender] = await Promise.all([held, rpc('pdd_batch_register', sameB)]);
  const owner = JSON.parse(heldOutput.split('\n').find(line => line.startsWith('{')));
  assert.equal(owner.items[0].result, 'registered');
  assert.equal(contender.items[0].result, 'duplicate');
  assert.equal(contender.items[0].registration, null);
  assert.equal(await sql("select count(*) from public.pdd_waybills where number='SF990000006001';"), '1');
  assert.equal(await sql("select count(*) from public.pdd_registrations where visibility='active';"), '1');
  const replay = await rpc('pdd_batch_register', sameA);
  assert.equal(replay.items[0].registration.registrationCode, owner.items[0].registration.registrationCode);

  const receivedQuery = { query_id: randomUUID(), number: 'SF990000006001', mode: 'received', source: 'barcode', capability_hash: capB, body_hash: 'received-query' };
  const hit = await rpc('pdd_query', receivedQuery);
  assert.equal(hit.result, 'matched'); assert.equal(hit.contact.value, 'fictional_owner');
  const saved = await rpc('pdd_query_contact', { query_id: receivedQuery.query_id, capability_hash: capB, contact: { kind: 'wechat', value: 'fictional_holder' }, idempotency_key: 'contact-once', body_hash: 'holder-contact' });
  assert(saved.registration);
  const lostHit = await rpc('pdd_query', { ...receivedQuery, query_id: randomUUID(), mode: 'lost', capability_hash: capA, body_hash: 'lost-hit' });
  assert.equal(lostHit.result, 'matched'); assert.equal(lostHit.contact.value, 'fictional_holder');
  const publicRecord = await rpc('pdd_public', { public_code: lostHit.record.code });
  assert(!JSON.stringify(publicRecord).includes('fictional_')); assert(!('number' in publicRecord));
  await assert.rejects(() => rpc('pdd_manage', { registration_code: saved.registration.registrationCode, capability_hash: capA }), /FORBIDDEN/);
  await assert.rejects(() => sql("set role anon; select * from public.pdd_registrations;"), /permission denied/);
  await assert.rejects(() => sql("set role authenticated; select public.pdd_query('{}');"), /permission denied/);

  // A later opposite registration is found when an earlier miss is submitted.
  const receiptBefore = batch('SF990000006002', 'received', capB, 'fictional_holder');
  await rpc('pdd_query', { ...receivedQuery, query_id: randomUUID(), number: 'SF990000006002', mode: 'lost', body_hash: 'race-miss' });
  await rpc('pdd_batch_register', receiptBefore);
  const foundAtSubmit = await rpc('pdd_batch_register', batch('SF990000006002', 'lost', capA, 'fictional_owner'));
  assert.equal(foundAtSubmit.items[0].result, 'matched');

  // Concurrent opposite-side registrations create one main row and two sides.
  await Promise.all([rpc('pdd_batch_register', batch('SF990000006003', 'lost', capA, 'fictional_owner')), rpc('pdd_batch_register', batch('SF990000006003', 'received', capB, 'fictional_holder'))]);
  assert.equal(await sql("select count(*) from public.pdd_registrations r join public.pdd_waybills w on w.id=r.waybill_id where w.number='SF990000006003';"), '2');

  // A real return can be externally verified with only the received side registered.
  const receivedOnly = await rpc('pdd_batch_register', batch('SF990000006004', 'received', capB, 'fictional_holder'));
  const code = receivedOnly.items[0].record.code, actor = randomUUID();
  let detail = await rpc('pdd_admin_detail', { public_code: code });
  detail = await rpc('pdd_admin_action', { public_code: code, revision: detail.record.revision, action: 'claim', actor_id: actor, notes: 'Synthetic external verification.' });
  assert.equal(await sql('select count(*) from public.pdd_handovers;'), '0');
  detail = await rpc('pdd_admin_action', { public_code: code, revision: detail.record.revision, action: 'return', actor_id: actor, notes: 'Synthetic actual handover.' });
  await rpc('pdd_admin_action', { public_code: code, revision: detail.record.revision, action: 'return', actor_id: actor });
  assert.equal(await sql('select count(*) from public.pdd_handovers;'), '1');
  await sql("update public.pdd_query_events set queried_at=now()-interval '31 days' where number='000990000001';");
  await rpc('pdd_cleanup', {});
  assert.equal(await sql("select count(*) from public.pdd_query_events where number='000990000001';"), '0');
  console.log('Real PostgreSQL concurrent registration, exact contacts, RLS, log retention and actual-return tests passed.');

  // Authenticate in one connection, block it on the number lock in another,
  // revoke its capability with cleanup, then let the authenticated request resume.
  const retentionNumber = 'SF990000006005';
  const retentionItem = (await rpc('pdd_batch_register', batch(retentionNumber, 'received', capA, 'fictional_retention'))).items[0];
  const retainedRegistration = retentionItem.registration;
  await sql(`update public.pdd_registrations set closed_at=now()-interval '31 days' where registration_code='${retainedRegistration.registrationCode}';
    update public.pdd_waybills set resolution='resolved',closed_at=now()-interval '31 days' where number='${retentionNumber}';`);
  const holder = transactionSession();
  let waiting;
  try {
    holder.send(`begin; select pg_advisory_xact_lock(hashtextextended('pdd-number:${retentionNumber}',0));\n\\echo PDD_RETENTION_LOCK_HELD`);
    await holder.marker('PDD_RETENTION_LOCK_HELD');
    const waiterName = `pdd-retention-waiter-${randomUUID()}`;
    waiting = sql(invoke('pdd_manage_update', { registration_code: retainedRegistration.registrationCode, capability_hash: capA,
      revision: retainedRegistration.revision, action: 'contact', contact: { kind: 'wechat', value: 'fictional_resurrection' } }), 'postgres', { PGAPPNAME: waiterName })
      .then(output => ({ succeeded: true, output }), error => ({ succeeded: false, error }));
    const deadline = Date.now() + 10_000;
    while (await sql(`select count(*) from pg_stat_activity where application_name='${waiterName}' and wait_event_type='Lock' and wait_event='advisory';`) !== '1') {
      assert(Date.now() < deadline, 'Management request did not reach the advisory-lock barrier.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    holder.send(`${invoke('pdd_cleanup', {})}\n\\echo PDD_RETENTION_REVOKED`);
    await holder.marker('PDD_RETENTION_REVOKED');
    holder.send(`commit;\n\\echo PDD_RETENTION_COMMITTED`);
    await holder.marker('PDD_RETENTION_COMMITTED');
    const mutation = await waiting;
    assert.equal(mutation.succeeded, false, 'A stale management request restored a cleaned contact.');
    assert.match(String(mutation.error), /FORBIDDEN/);
    const retained = JSON.parse(await sql(`select json_build_object('contact',contact,'capabilityHash',capability_hash,'revision',revision)::text from public.pdd_registrations where registration_code='${retainedRegistration.registrationCode}';`));
    assert.deepEqual(retained, { contact: null, capabilityHash: '', revision: retainedRegistration.revision + 1 });
    console.log('Real two-session retention barrier passed: waiting authenticated contact update was rejected after cleanup revocation.');
  } finally {
    await holder.close();
    if (waiting) await waiting;
  }

  const dumped = path.join(root, 'database.dump'), sealed = path.join(root, 'database.cmibak'), reopened = path.join(root, 'restored.dump');
  await run(path.join(bin, 'pg_dump'), ['--format=custom', '--no-owner', '--schema=public', '--schema=auth', '--file', dumped, '--dbname', 'postgres'], { env });
  const password = randomBytes(32).toString('base64url');
  await encryptFile(dumped, sealed, password); await decryptFile(sealed, reopened, password);
  await sql('create database pdd404_restore_check;');
  await bootstrap('pdd404_restore_check');
  await run(path.join(bin, 'pg_restore'), ['--no-owner', '--exit-on-error', '--clean', '--if-exists', '--dbname', 'pdd404_restore_check', reopened], { env, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(await sql('select count(*) from public.pdd_handovers;', 'pdd404_restore_check'), '1');
  assert.equal((await rpc('pdd_public', { public_code: code }, 'pdd404_restore_check')).resolution, 'resolved');
  await assert.rejects(() => sql("set role anon; select * from public.pdd_registrations;", 'pdd404_restore_check'), /permission denied/);
  console.log('Encrypted dump/decrypt and independent database restore passed; restored RLS remains closed.');
} finally {
  if (running) await run(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { env }).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
