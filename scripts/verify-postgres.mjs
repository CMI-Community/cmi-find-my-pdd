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
const env = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', PGHOST: socket, PGPORT: String(port), PGUSER: userInfo().username, PGDATABASE: 'postgres', PGCONNECT_TIMEOUT: '5' };
const capA = 'a'.repeat(64), capB = 'b'.repeat(64);
const quote = value => "'" + JSON.stringify(value).replaceAll("'", "''") + "'::jsonb";
const invoke = (name, payload) => `select public.${name}(${quote(payload)})::text;`;
let running = false;
async function sql(statement, database = 'postgres', extraEnvironment = {}) {
  const { stdout } = await run(path.join(bin, 'psql'), ['-X', '-A', '-t', '-q', '--set', 'ON_ERROR_STOP=1', '--set', 'VERBOSITY=verbose', '--dbname', database, '--command', statement], { env: { ...env, ...extraEnvironment }, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}
async function rpc(name, payload, database) { return JSON.parse(await sql(invoke(name, payload), database)); }
async function businessError(operation, message) {
  await assert.rejects(operation, error => { assert.match(error.stderr ?? '', new RegExp(`ERROR:\\s+P0001:\\s+${message}\\b`)); return true; });
}
async function bootstrap(database, roles = false) {
  await sql(`${roles ? 'create role anon; create role authenticated; create role service_role bypassrls;' : ''}
    create schema extensions; create extension pgcrypto with schema extensions;
    create schema auth; create table auth.users(id uuid primary key,email text);
    create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create schema net; create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as 'select 1::bigint';
    create schema cron; create function cron.schedule(job_name text,schedule text,command text) returns bigint language sql as 'select 1::bigint';`, database);
}
const batch = (number, mode, capability, person, requestId = randomUUID(), note) => ({ request_id: requestId, mode, note, contact: { kind: 'wechat', value: person },
  items: [{ request_id: randomUUID(), number, source: 'manual' }], capability_hash: capability, body_hash: randomBytes(32).toString('hex') });
function transactionSession() {
  const child = spawn(path.join(bin, 'psql'), ['-X', '-A', '-t', '-q', '--set', 'ON_ERROR_STOP=1', '--set', 'VERBOSITY=verbose'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
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
    async expectFailure(code) { const exit = await completion; assert.notEqual(exit, 0); assert.match(errors, new RegExp(`ERROR:\\s+${code}:`)); },
  };
}
try {
  await run(path.join(bin, 'initdb'), ['-D', data, '--auth=trust', '--no-locale', '--encoding=UTF8'], { env, maxBuffer: 1024 * 1024 });
  await run(path.join(bin, 'pg_ctl'), ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-F -k ${socket} -h '' -p ${port}`, '-w', 'start'], { env });
  running = true;
  await bootstrap('postgres', true);
  const directory = new URL('../supabase/migrations/', import.meta.url);
  let backfillChecked = false;
  let businessMetadataChecked = false;
  const businessMetadataSQL = `select jsonb_agg(jsonb_build_object('name',p.proname,'oid',p.oid,'owner',p.proowner,'acl',p.proacl::text,'securityDefiner',p.prosecdef,'config',p.proconfig,'arguments',p.proargtypes::text) order by p.proname)::text
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('pdd_query','pdd_query_contact','pdd_batch_register','pdd_manage_update','pdd_admin_action','pdd_feedback_submit') and p.proargtypes='3802'::oidvector;`;
  for (const name of (await readdir(directory)).filter(n => /^\d+_.+\.sql$/.test(n)).sort()) {
    const upgrade = name === '20261006141735_home_stats_notes_feedback.sql';
    const businessUpgrade = name.endsWith('_pdd_business_conflict_errors.sql');
    const beforeBusinessMetadata = businessUpgrade ? JSON.parse(await sql(businessMetadataSQL)) : null;
    if (businessUpgrade) assert.equal(beforeBusinessMetadata.length, 6);
    if (upgrade) {
      // A pre-upgrade pair is insufficient evidence. Only a retained successful
      // exact-query event may be backfilled into the lifetime match statistic.
      await rpc('pdd_batch_register', batch('BFL990000001', 'lost', capA, 'fictional_backfill_owner'));
      await rpc('pdd_batch_register', batch('BFL990000001', 'received', capB, 'fictional_backfill_holder'));
      await rpc('pdd_batch_register', batch('BFL990000002', 'received', capB, 'fictional_backfill_holder'));
      const evidence = { query_id: randomUUID(), number: 'BFL990000002', mode: 'lost', source: 'manual', capability_hash: capA, body_hash: 'backfill-query' };
      assert.equal((await rpc('pdd_query', evidence)).result, 'matched');
      await rpc('pdd_query', evidence);
    }
    const migration = (await readFile(new URL(name, directory), 'utf8')).replace(/^create extension if not exists pg_net.*$/m, '').replace(/^create extension if not exists pg_cron.*$/m, '');
    await sql(migration);
    if (businessUpgrade) {
      assert.deepEqual(JSON.parse(await sql(businessMetadataSQL)), beforeBusinessMetadata);
      businessMetadataChecked = true;
      console.log('Business error migration preserved all six RPC OIDs, ownership, ACLs and security settings.');
    }
    if (upgrade) {
      assert.deepEqual(await rpc('pdd_home_stats', {}), { lostRegistered: 1, receivedRegistered: 2, matchedParcels: 1 });
      assert.equal(await sql("select matched_at is null from public.pdd_waybills where number='BFL990000001';"), 't');
      assert.equal(await sql("select matched_at is not null from public.pdd_waybills where number='BFL990000002';"), 't');
      await sql('truncate public.pdd_waybills,public.pdd_registrations,public.pdd_query_events,public.pdd_write_requests,public.pdd_audit_events,public.pdd_handovers cascade;');
      backfillChecked = true;
      console.log('Additive migration backfill passed: successful query evidence counted once; coexisting sides alone did not fabricate a match.');
    }
  }
  assert(backfillChecked, 'The statistics/notes/feedback upgrade migration was not exercised.');
  assert(businessMetadataChecked, 'The business conflict migration metadata was not exercised.');
  await sql(await readFile(new URL('../tests/db.sql', import.meta.url), 'utf8'));
  assert.equal((await rpc('runtime_config', {})).OCR_ENABLED, 'false');
  console.log('Legacy real PostgreSQL transaction regression and server-only OCR default passed.');

  const missing = { query_id: randomUUID(), number: '000990000001', mode: 'lost', source: 'manual', capability_hash: capA, body_hash: 'synthetic-miss' };
  const first = await rpc('pdd_query', missing);
  assert.equal(first.result, 'not_found');
  await rpc('pdd_query', missing);
  assert.equal(await sql('select count(*) from public.pdd_query_events;'), '1');

  // Independent connections contend while one transaction keeps the number lock.
  const sameA = batch('SF990000006001', 'lost', capA, 'fictional_owner', randomUUID(), 'Original synthetic owner note');
  const sameB = batch('SF990000006001', 'lost', capB, 'fictional_other', randomUUID(), 'Contending replacement note');
  const held = sql(`begin; ${invoke('pdd_batch_register', sameA)} select pg_sleep(0.35); commit;`);
  await new Promise(resolve => setTimeout(resolve, 70));
  const [heldOutput, contender] = await Promise.all([held, rpc('pdd_batch_register', sameB)]);
  const owner = JSON.parse(heldOutput.split('\n').find(line => line.startsWith('{')));
  assert.equal(owner.items[0].result, 'registered');
  assert.equal(contender.items[0].result, 'duplicate');
  assert.equal(contender.items[0].registration, null);
  assert.equal(await sql("select note from public.pdd_registrations r join public.pdd_waybills w on w.id=r.waybill_id where w.number='SF990000006001';"), 'Original synthetic owner note');
  assert.equal(await sql("select count(*) from public.pdd_waybills where number='SF990000006001';"), '1');
  assert.equal(await sql("select count(*) from public.pdd_registrations where visibility='active';"), '1');
  const replay = await rpc('pdd_batch_register', sameA);
  assert.equal(replay.items[0].registration.registrationCode, owner.items[0].registration.registrationCode);

  const receivedQuery = { query_id: randomUUID(), number: 'SF990000006001', mode: 'received', source: 'barcode', capability_hash: capB, body_hash: 'received-query' };
  const hit = await rpc('pdd_query', receivedQuery);
  assert.equal(hit.result, 'matched'); assert.equal(hit.contact.value, 'fictional_owner');
  assert.equal(hit.note, 'Original synthetic owner note');
  const saved = await rpc('pdd_query_contact', { query_id: receivedQuery.query_id, capability_hash: capB, contact: { kind: 'wechat', value: 'fictional_holder' }, idempotency_key: 'contact-once', body_hash: 'holder-contact' });
  assert(saved.registration);
  assert.equal(saved.registration.note, null);
  const lostHit = await rpc('pdd_query', { ...receivedQuery, query_id: randomUUID(), mode: 'lost', capability_hash: capA, body_hash: 'lost-hit' });
  assert.equal(lostHit.result, 'matched'); assert.equal(lostHit.contact.value, 'fictional_holder');
  const publicRecord = await rpc('pdd_public', { public_code: lostHit.record.code });
  assert(!JSON.stringify(publicRecord).includes('fictional_')); assert(!('number' in publicRecord)); assert(!('note' in publicRecord));
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

  // Independent successful-query transactions (including the same query id)
  // must mark one lifetime match and write only one idempotent query event.
  const concurrentNumber = 'CONCURRENTSCAN6006';
  const concurrentRegistration = (await rpc('pdd_batch_register', batch(concurrentNumber, 'received', capA, 'fictional_concurrent_holder', randomUUID(), 'Concurrent holder note'))).items[0].registration;
  const beforeConcurrent = await rpc('pdd_home_stats', {});
  const simultaneous = { query_id: randomUUID(), number: concurrentNumber, mode: 'lost', source: 'barcode', capability_hash: capB, body_hash: 'concurrent-query' };
  const results = await Promise.all(Array.from({ length: 8 }, () => rpc('pdd_query', simultaneous)));
  assert(results.every(result => result.result === 'matched' && result.note === 'Concurrent holder note'));
  assert.equal(await sql(`select count(*) from public.pdd_query_events where number='${concurrentNumber}';`), '1');
  await Promise.all(Array.from({ length: 4 }, () => rpc('pdd_query', { ...simultaneous, query_id: randomUUID() })));
  const afterConcurrent = await rpc('pdd_home_stats', {});
  assert.deepEqual(afterConcurrent, { ...beforeConcurrent, matchedParcels: beforeConcurrent.matchedParcels + 1 });
  assert.equal(await sql(`select count(*) from public.pdd_query_events where number='${concurrentNumber}';`), '5');
  await rpc('pdd_manage_update', { registration_code: concurrentRegistration.registrationCode, capability_hash: capA, revision: concurrentRegistration.revision, action: 'withdraw' });
  assert.equal((await rpc('pdd_query', simultaneous)).result, 'not_found');
  await rpc('pdd_batch_register', batch(concurrentNumber, 'received', capB, 'fictional_replacement_holder', randomUUID(), 'Replacement holder note'));
  assert.deepEqual(await rpc('pdd_home_stats', {}), afterConcurrent);
  await sql(`update public.pdd_waybills set resolution='resolved',closed_at=now()-interval '31 days' where number='${concurrentNumber}'; update public.pdd_registrations set closed_at=now()-interval '31 days' where waybill_id=(select id from public.pdd_waybills where number='${concurrentNumber}');`);
  await rpc('pdd_cleanup', {});
  assert.equal(await sql(`select count(*) from public.pdd_registrations where waybill_id=(select id from public.pdd_waybills where number='${concurrentNumber}') and (note is not null or contact is not null or capability_hash<>'');`), '0');
  assert.deepEqual(await rpc('pdd_home_stats', {}), afterConcurrent);
  // A transaction that never commits contributes no registrations or matches.
  await sql(`begin; ${invoke('pdd_batch_register', batch('ROLLBACK99001', 'lost', capA, 'fictional_rollback_owner', randomUUID(), 'Rollback note'))} rollback;`);
  assert.deepEqual(await rpc('pdd_home_stats', {}), afterConcurrent);

  const noteBatch = { ...batch('SF990000006001', 'lost', capB, 'fictional_note_owner', randomUUID(), 'Shared new registration note'), items: ['SF990000006001', 'SF990000006007', 'SF990000006008'].map(number => ({ request_id: randomUUID(), number, source: 'manual' })) };
  const notes = await rpc('pdd_batch_register', noteBatch);
  assert.equal(notes.items[0].registration, null);
  assert(notes.items.slice(1).every(item => item.registration.note === 'Shared new registration note'));
  assert.equal(await sql("select note from public.pdd_registrations r join public.pdd_waybills w on w.id=r.waybill_id where w.number='SF990000006001' and mode='lost';"), 'Original synthetic owner note');
  const statsBeforeBatchReplay = await rpc('pdd_home_stats', {});
  const oppositeNotes = await rpc('pdd_batch_register', batch('SF990000006007', 'received', capB, 'fictional_note_holder', randomUUID(), 'Opposite holder note'));
  assert.equal(oppositeNotes.items[0].note, 'Shared new registration note');
  const newReplay = await rpc('pdd_batch_register', noteBatch);
  assert.equal(newReplay.items[1].note, 'Opposite holder note'); assert.equal(newReplay.items[1].result, 'matched');
  const afterBatchReplay = await rpc('pdd_home_stats', {});
  assert.deepEqual(afterBatchReplay, { ...statsBeforeBatchReplay, receivedRegistered: statsBeforeBatchReplay.receivedRegistered + 1, matchedParcels: statsBeforeBatchReplay.matchedParcels + 1 });
  await rpc('pdd_batch_register', noteBatch);
  assert.deepEqual(await rpc('pdd_home_stats', {}), afterBatchReplay);
  console.log('Real PostgreSQL lifetime counts, concurrent exact matches, batch notes/replays, rollback and retention passed.');

  const feedbackInput = { request_id: randomUUID(), body_hash: 'synthetic-feedback-body', message: 'Synthetic private feedback description', contact: { kind: 'wechat', value: 'fictional_feedback_contact' } };
  const feedbackReceipts = await Promise.all(Array.from({ length: 6 }, () => rpc('pdd_feedback_submit', feedbackInput)));
  assert(feedbackReceipts.every(receipt => JSON.stringify(receipt) === JSON.stringify(feedbackReceipts[0])));
  assert.deepEqual(Object.keys(feedbackReceipts[0]).sort(), ['feedbackId', 'submitted', 'submittedAt']);
  assert.equal(await sql('select count(*) from public.pdd_feedback;'), '1');
  const feedbackId = feedbackReceipts[0].feedbackId;
  await assert.rejects(() => rpc('pdd_feedback_submit', { ...feedbackInput, body_hash: 'changed-feedback-body' }), /IDEMPOTENCY_CONFLICT/);
  await rpc('pdd_admin_feedback_update', { feedback_id: feedbackId, status: 'reviewed', actor_id: actor });
  await rpc('pdd_admin_feedback_update', { feedback_id: feedbackId, status: 'reviewed', actor_id: actor });
  assert.equal(await sql("select count(*) from public.audit_events where action='feedback_status';"), '1');
  const feedbackAudit = JSON.parse(await sql("select jsonb_agg(payload)::text from public.audit_events where action='feedback_status';"));
  assert(!JSON.stringify(feedbackAudit).includes('fictional_')); assert(!JSON.stringify(feedbackAudit).includes('description'));
  await assert.rejects(() => sql("set role authenticated; select public.pdd_admin_feedback_list('{}');"), /permission denied/);
  await assert.rejects(() => sql('set role anon; select * from public.pdd_feedback;'), /permission denied/);
  assert.deepEqual(await rpc('pdd_home_stats', {}), afterBatchReplay);
  console.log('Real PostgreSQL concurrent feedback idempotency, private receipt, audited states and browser denial passed.');

  const fuzzyNumber = 'ZXABCDEF12';
  const fuzzyRegistration = (await rpc('pdd_batch_register', batch(fuzzyNumber, 'received', capA, 'fictional_fuzzy_holder', randomUUID(), 'Private fuzzy holder note'))).items[0];
  const fuzzyQuery = number => ({ query_id: randomUUID(), number, mode: 'lost', source: 'manual', allow_possible: true, capability_hash: capB, body_hash: `fuzzy-${number}` });
  const beforeFuzzy = await rpc('pdd_home_stats', {});
  const legacyFuzzy = fuzzyQuery('ZXABCDEFXY'); delete legacyFuzzy.allow_possible;
  const firstLegacy = await rpc('pdd_query', legacyFuzzy);
  assert.equal(firstLegacy.result, 'not_found');
  assert.deepEqual(await rpc('pdd_query', legacyFuzzy), firstLegacy);
  assert.equal(await sql(`select count(*) from public.pdd_query_events where id='${legacyFuzzy.query_id}' and result='not_found';`), '1');
  assert.equal((await rpc('pdd_query', { ...legacyFuzzy, query_id: randomUUID(), allow_possible: false })).result, 'not_found');
  await assert.rejects(() => rpc('pdd_query', { ...legacyFuzzy, query_id: randomUUID(), number: 'ZXABCDEF1?' }), /INVALID_WAYBILL/);
  assert.equal((await rpc('pdd_query', fuzzyQuery('ZXABCDEXYZ'))).result, 'not_found', 'Exactly 70% must be excluded.');
  const uncertain = fuzzyQuery('ZXABCDEF1?');
  const uncertainAnswers = await Promise.all(Array.from({ length: 6 }, () => rpc('pdd_query', uncertain)));
  assert(uncertainAnswers.every(answer => answer.result === 'possible' && answer.contact === null && answer.note === null && answer.record === null && answer.registeredAt === null));
  assert.equal(await sql(`select count(*) from public.pdd_query_events where id='${uncertain.query_id}';`), '1');
  assert.equal(uncertainAnswers[0].candidates[0].similarity, 90);
  assert.deepEqual(Object.keys(uncertainAnswers[0].candidates[0]).sort(), ['code', 'registeredAt', 'similarity', 'tail']);
  assert(!JSON.stringify(uncertainAnswers[0]).includes(fuzzyNumber)); assert(!JSON.stringify(uncertainAnswers[0]).includes('fictional_')); assert(!JSON.stringify(uncertainAnswers[0]).includes('Private'));
  assert.equal((await rpc('pdd_admin_queries', { limit: 100 })).items.find(item => item.queryId === uncertain.query_id).result, 'possible');
  for (const pattern of ['ZXABCDEF1*', 'ZXABCDE12', 'ZXABCDEFX12']) {
    const answer = await rpc('pdd_query', fuzzyQuery(pattern));
    assert.equal(answer.result, 'possible'); assert.equal(answer.contact, null); assert(answer.candidates[0].similarity > 70 && answer.candidates[0].similarity < 100);
  }
  const completePossible = await rpc('pdd_query', fuzzyQuery('ZXABCDEFXY'));
  assert.equal(completePossible.result, 'possible'); assert.equal(completePossible.candidates[0].similarity, 80);
  await assert.rejects(() => rpc('pdd_query_contact', { query_id: completePossible.queryId, capability_hash: capB, contact: { kind: 'wechat', value: 'fictional_fuzzy_owner' }, idempotency_key: 'fuzzy-contact', body_hash: 'fuzzy-contact' }), /VERSION_CONFLICT/);
  for (const pattern of ['ZXABCDEF1?', 'ZXABCDEF1*']) await assert.rejects(() => rpc('pdd_batch_register', batch(pattern, 'lost', capB, 'fictional_fuzzy_owner')), /INVALID_WAYBILL/);
  assert.deepEqual(await rpc('pdd_home_stats', {}), beforeFuzzy);
  assert.equal((await rpc('pdd_batch_register', batch('ZXABCDEFXY', 'lost', capB, 'fictional_fuzzy_owner', randomUUID(), 'Explicit complete-number registration'))).items[0].result, 'registered');
  assert.equal(await sql(`select waybill_id is null from public.pdd_query_events where id='${completePossible.queryId}';`), 't');
  const rank = [];
  for (let index = 1; index <= 6; index++) {
    const number = `QRORDER000${index}`;
    const item = (await rpc('pdd_batch_register', batch(number, 'received', capA, 'fictional_rank_holder', randomUUID(), 'Private ranking note'))).items[0];
    await sql(`update public.pdd_registrations set created_at='2026-10-06T10:00:0${index}Z' where registration_code='${item.registration.registrationCode}';`);
    rank.push(item);
  }
  const ranked = await rpc('pdd_query', fuzzyQuery('QRORDER0000'));
  assert.equal(ranked.result, 'possible'); assert.equal(ranked.candidates.length, 5);
  assert.deepEqual(ranked.candidates.map(item => item.code), rank.slice(1).reverse().map(item => item.record.code));
  assert(ranked.candidates.every(item => Object.keys(item).sort().join(',') === 'code,registeredAt,similarity,tail'));
  await sql(`update public.pdd_waybills set resolution='resolved',closed_at=now() where public_code='${rank[5].record.code}';`);
  await rpc('pdd_manage_update', { registration_code: rank[4].registration.registrationCode, capability_hash: capA, revision: rank[4].registration.revision, action: 'withdraw' });
  await sql(`update public.pdd_registrations set contact=null where registration_code='${rank[3].registration.registrationCode}';`);
  await rpc('pdd_batch_register', batch('QRORDER0007', 'lost', capB, 'fictional_same_side'));
  const eligible = await rpc('pdd_query', fuzzyQuery('QRORDER0000'));
  assert.deepEqual(eligible.candidates.map(item => item.code), rank.slice(0, 3).reverse().map(item => item.record.code));
  assert.equal(eligible.contact, null); assert.equal(eligible.note, null);
  assert.equal((await rpc('pdd_query', fuzzyQuery('QRORDER0007'))).result, 'duplicate');
  assert.equal((await rpc('pdd_query', fuzzyQuery('QRORDER0006'))).result, 'closed');
  const beforeExactFuzzy = await rpc('pdd_home_stats', {});
  const exactFuzzy = await rpc('pdd_query', fuzzyQuery(fuzzyNumber));
  assert.equal(exactFuzzy.result, 'matched'); assert.equal(exactFuzzy.contact.value, 'fictional_fuzzy_holder'); assert.equal(exactFuzzy.note, 'Private fuzzy holder note'); assert.deepEqual(exactFuzzy.candidates, []);
  assert.equal(exactFuzzy.record.code, fuzzyRegistration.record.code);
  assert.deepEqual(await rpc('pdd_home_stats', {}), { ...beforeExactFuzzy, matchedParcels: beforeExactFuzzy.matchedParcels + 1 });
  const helperPermissions = JSON.parse(await sql("select jsonb_agg(jsonb_build_object('anon',has_function_privilege('anon',p.oid,'EXECUTE'),'authenticated',has_function_privilege('authenticated',p.oid,'EXECUTE')))::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'pdd_%';"));
  assert(helperPermissions.every(item => !item.anon && !item.authenticated));
  console.log('Real PostgreSQL fuzzy strict boundary, unknown/edit distance, safe candidate ordering/eligibility, concurrent logs, exact priority and match-count isolation passed.');

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

  // Business guards must be distinguishable from real engine serialization.
  // PostgREST may retry actual 40001, while P0001 guards can return promptly.
  const managedOwner = await rpc('pdd_manage', { registration_code: owner.items[0].registration.registrationCode, capability_hash: capA });
  await businessError(() => rpc('pdd_manage_update', { registration_code: managedOwner.registrationCode, capability_hash: capA, revision: managedOwner.revision + 1, action: 'contact', contact: { kind: 'wechat', value: 'fictional_rejected_contact' } }), 'VERSION_CONFLICT');
  await businessError(() => rpc('pdd_query', { ...receivedQuery, body_hash: 'changed-query' }), 'IDEMPOTENCY_CONFLICT');
  await businessError(() => rpc('pdd_batch_register', { ...sameA, body_hash: 'changed-batch' }), 'IDEMPOTENCY_CONFLICT');
  const reusedItem = { ...batch('ROLLBACKITEM990', 'lost', capA, 'fictional_reused_item'), items: [{ ...sameA.items[0], number: 'ROLLBACKITEM990' }] };
  await businessError(() => rpc('pdd_batch_register', reusedItem), 'IDEMPOTENCY_CONFLICT');
  assert.equal(await sql("select count(*) from public.pdd_waybills where number='ROLLBACKITEM990';"), '0');
  await businessError(() => rpc('pdd_query_contact', { query_id: receivedQuery.query_id, capability_hash: capB, contact: { kind: 'wechat', value: 'fictional_holder' }, idempotency_key: 'contact-once', body_hash: 'changed-contact' }), 'IDEMPOTENCY_CONFLICT');
  await businessError(() => rpc('pdd_query_contact', { query_id: receivedQuery.query_id, capability_hash: capB, contact: { kind: 'wechat', value: 'fictional_holder' }, idempotency_key: 'second-contact-key', body_hash: 'holder-contact' }), 'IDEMPOTENCY_CONFLICT');
  await businessError(() => rpc('pdd_query_contact', { query_id: completePossible.queryId, capability_hash: capB, contact: { kind: 'wechat', value: 'fictional_fuzzy_owner' }, idempotency_key: 'possible-business-error', body_hash: 'possible-business-error' }), 'VERSION_CONFLICT');
  const latest = await rpc('pdd_admin_detail', { public_code: managedOwner.record.code });
  await businessError(() => rpc('pdd_admin_action', { public_code: managedOwner.record.code, revision: latest.record.revision + 1, action: 'verify', actor_id: actor }), 'VERSION_CONFLICT');
  await businessError(() => rpc('pdd_admin_action', { public_code: managedOwner.record.code, revision: latest.record.revision, action: 'return', actor_id: actor }), 'INVALID_ADMIN_STATE');
  const lostOnly = await rpc('pdd_admin_detail', { public_code: notes.items[2].record.code });
  await businessError(() => rpc('pdd_admin_action', { public_code: lostOnly.record.code, revision: lostOnly.record.revision, action: 'claim', actor_id: actor }), 'NEEDS_RECEIVED');
  const resolvedReceived = await rpc('pdd_manage', { registration_code: receivedOnly.items[0].registration.registrationCode, capability_hash: capB });
  await businessError(() => rpc('pdd_manage_update', { registration_code: resolvedReceived.registrationCode, capability_hash: capB, revision: resolvedReceived.revision, action: 'withdraw' }), 'OWNERSHIP_LOCKED');
  await businessError(() => rpc('pdd_feedback_submit', { ...feedbackInput, body_hash: 'changed-feedback-business-error' }), 'IDEMPOTENCY_CONFLICT');
  const beforeEngineConflict = await rpc('pdd_home_stats', {});
  const serializable = transactionSession();
  try {
    serializable.send(`begin isolation level serializable; select revision from public.pdd_registrations where registration_code='${managedOwner.registrationCode}';\n\\echo PDD_SERIALIZABLE_READ`);
    await serializable.marker('PDD_SERIALIZABLE_READ');
    const current = await rpc('pdd_manage_update', { registration_code: managedOwner.registrationCode, capability_hash: capA, revision: managedOwner.revision, action: 'contact', contact: { kind: 'wechat', value: 'fictional_serialized_owner' } });
    serializable.send(`${invoke('pdd_manage_update', { registration_code: managedOwner.registrationCode, capability_hash: capA, revision: managedOwner.revision, action: 'contact', contact: { kind: 'wechat', value: 'fictional_stale_serialized_owner' } })}\n\\q`);
    await serializable.expectFailure('40001');
    assert.deepEqual(await rpc('pdd_manage', { registration_code: managedOwner.registrationCode, capability_hash: capA }), current);
    assert.equal(current.note, 'Original synthetic owner note');
    assert.deepEqual(await rpc('pdd_home_stats', {}), beforeEngineConflict);
    console.log('Real PostgreSQL business guards returned P0001 with original messages/rollback, while an actual two-session SERIALIZABLE RPC conflict retained 40001.');
  } finally { await serializable.close(); }

  const dumped = path.join(root, 'database.dump'), sealed = path.join(root, 'database.cmibak'), reopened = path.join(root, 'restored.dump');
  await run(path.join(bin, 'pg_dump'), ['--format=custom', '--no-owner', '--schema=public', '--schema=auth', '--file', dumped, '--dbname', 'postgres'], { env });
  const password = randomBytes(32).toString('base64url');
  await encryptFile(dumped, sealed, password); await decryptFile(sealed, reopened, password);
  await sql('create database pdd404_restore_check;');
  await bootstrap('pdd404_restore_check');
  await run(path.join(bin, 'pg_restore'), ['--no-owner', '--exit-on-error', '--clean', '--if-exists', '--dbname', 'pdd404_restore_check', reopened], { env, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(await sql('select count(*) from public.pdd_handovers;', 'pdd404_restore_check'), '1');
  assert.equal((await rpc('pdd_public', { public_code: code }, 'pdd404_restore_check')).resolution, 'resolved');
  assert.deepEqual(await rpc('pdd_home_stats', {}, 'pdd404_restore_check'), await rpc('pdd_home_stats', {}));
  for (const table of ['pdd_waybills', 'pdd_registrations', 'pdd_feedback']) {
    const statement = `select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb)::text from public.${table} r;`;
    assert.deepEqual(JSON.parse(await sql(statement, 'pdd404_restore_check')), JSON.parse(await sql(statement)));
  }
  await assert.rejects(() => sql("set role anon; select * from public.pdd_registrations;", 'pdd404_restore_check'), /permission denied/);
  await assert.rejects(() => sql('set role authenticated; select * from public.pdd_feedback;', 'pdd404_restore_check'), /permission denied/);
  await businessError(() => rpc('pdd_query_contact', { query_id: completePossible.queryId, capability_hash: capB, contact: { kind: 'wechat', value: 'fictional_fuzzy_owner' }, idempotency_key: 'restored-possible-error', body_hash: 'restored-possible-error' }, 'pdd404_restore_check'), 'VERSION_CONFLICT');
  await businessError(() => rpc('pdd_feedback_submit', { ...feedbackInput, body_hash: 'restored-changed-feedback' }, 'pdd404_restore_check'), 'IDEMPOTENCY_CONFLICT');
  console.log('Encrypted dump/decrypt and independent database restore passed, including lifetime stats, notes and feedback; restored RLS remains closed.');
} finally {
  if (running) await run(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { env }).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
