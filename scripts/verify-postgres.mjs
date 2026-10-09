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
import { FORMAT, canonical, migrationManifest, rowsHash, sha256, tablesForMigrations, writeEncryptedChunks } from './backup-scoped.mjs';
import { verifyScopedRestore } from './verify-scoped-restore.mjs';
import { verifyHourlyInsights } from './verify-hourly-insights.mjs';
import { verifyHourlyWorker } from './verify-hourly-worker.mjs';

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
    grant usage on schema public to anon,authenticated,service_role;
    create schema extensions; create extension pgcrypto with schema extensions;
    create schema auth; create table auth.users(id uuid primary key,email text);
    create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create schema net; create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as 'select 1::bigint';
    create schema cron; create table cron.job(jobid bigint generated always as identity primary key,jobname text unique,schedule text,command text);
    create function cron.schedule(job_name text,schedule text,command text) returns bigint language plpgsql as $$declare result bigint; begin
      insert into cron.job(jobname,schedule,command) values(job_name,schedule,command) on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command returning jobid into result; return result;
    end$$;`, database);
}
const batch = (number, mode, capability, person, requestId = randomUUID(), note) => ({ request_id: requestId, mode, note, contact: { kind: 'wechat', value: person },
  items: [{ request_id: randomUUID(), number, source: 'manual' }], capability_hash: capability, body_hash: randomBytes(32).toString('hex') });
const parcelStats = ({ lostRegistered, receivedRegistered, matchedParcels }) => ({ lostRegistered, receivedRegistered, matchedParcels });
const recipientBatch = (name, mode = 'received', capability = capA, person = 'fictional_name_holder', note = 'Synthetic name note') => ({
  request_id: randomUUID(), mode, contact: { kind: 'wechat', value: person }, note,
  items: [{ request_id: randomUUID(), recipient_name: name }], capability_hash: capability, body_hash: randomBytes(32).toString('hex'),
});
const recipientQuery = (name, mode = 'lost', capability = capB) => ({
  query_id: randomUUID(), recipient_name: name, mode, capability_hash: capability, body_hash: randomBytes(32).toString('hex'),
});
async function verifyRecipientTelemetry(database = 'postgres') {
  const names = ['pdd_lookup_waybill_selected', 'pdd_lookup_recipient_selected',
    'pdd_recipient_query_started', 'pdd_recipient_query_invalid', 'pdd_recipient_query_leads_found', 'pdd_recipient_query_not_found', 'pdd_recipient_query_error',
    'pdd_recipient_queue_added', 'pdd_recipient_queue_duplicate', 'pdd_recipient_queue_removed',
    'pdd_recipient_registration_started', 'pdd_recipient_registration_registered', 'pdd_recipient_registration_duplicate', 'pdd_recipient_registration_error'];
  const events = names.map(event => ({ event, page: 'home', mode: 'lost', count: 1, ...(event.startsWith('pdd_recipient_registration_') ? { batch: '2-5' } : {}) }));
  const input = { events, daily_limit: 50 };
  const before = await rpc('pdd_telemetry_summary', { days: 30 }, database);
  const businessBefore = await rpc('pdd_home_stats', {}, database);
  // These temporary fixture changes are always rolled back in the disposable DB.
  // Reuse the same synthetic daily cap; never change the surrounding budget.
  const resetFixture = 'begin; delete from public.pdd_telemetry_daily; delete from public.pdd_telemetry_budget; set local role service_role;';
  const output = await sql(`${resetFixture} ${invoke('pdd_telemetry_ingest', input)} ${invoke('pdd_telemetry_summary', { days: 1 })} rollback;`, database);
  const [receipt, summary] = output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.equal(receipt.accepted, true); assert.equal(receipt.recorded, names.length);
  assert.deepEqual(new Set(summary.events.map(event => event.event)), new Set(names));
  assert.equal(summary.budget[0].dailyLimit, 50);
  assert(summary.events.every(event => event.mode === 'lost' && event.source === null && event.scanMode === null));
  const valid = { event: 'pdd_recipient_query_started', page: 'home', mode: 'received', count: 1 };
  const forbidden = ['recipientName', 'recipient_name', 'number', 'contact', 'note', 'code', 'capability', 'cursor', 'queryId', 'registrationCode', 'url'];
  for (const field of forbidden) {
    const invalid = { events: [valid, { ...valid, [field]: 'synthetic_private_metadata' }], daily_limit: 50 };
    await assert.rejects(() => sql(`${resetFixture} ${invoke('pdd_telemetry_ingest', invalid)} rollback;`, database), /INVALID_REQUEST/);
  }
  for (const extra of [{ source: 'manual' }, { scanMode: 'photo' }, { batch: '1' }, { event: 'pdd_recipient_arbitrary' }]) {
    await assert.rejects(() => sql(`${resetFixture} ${invoke('pdd_telemetry_ingest', { events: [{ ...valid, ...extra }], daily_limit: 50 })} rollback;`, database), /INVALID_REQUEST/);
  }
  assert.deepEqual(await rpc('pdd_telemetry_summary', { days: 30 }, database), before);
  assert.deepEqual(await rpc('pdd_home_stats', {}, database), businessBefore);
}
async function verifyRecipientLifetimeStats() {
  const initial = await rpc('pdd_home_stats', {});
  const returnsBefore = await sql('select count(*) from public.pdd_handovers;');
  const name = '六项统计双来源收件人';
  const namedBatch = (number, mode, capability, person) => {
    const input = batch(number, mode, capability, person);
    input.items[0].recipient_name = name;
    return input;
  };
  const lostInput = namedBatch('STATREGISTRY99001', 'lost', capA, 'fictional_stats_lost_number');
  const receivedInput = namedBatch('STATREGISTRY99002', 'received', capA, 'fictional_stats_received_number');
  const lostWaybill = (await rpc('pdd_batch_register', lostInput)).items[0].registration;
  const receivedWaybill = (await rpc('pdd_batch_register', receivedInput)).items[0].registration;
  const lostNameInput = recipientBatch(name, 'lost', capA, 'fictional_stats_lost_name');
  const receivedNameInput = recipientBatch(name, 'received', capA, 'fictional_stats_received_name');
  const lostName = (await rpc('pdd_recipient_batch_register', lostNameInput)).items[0].registration;
  const receivedName = (await rpc('pdd_recipient_batch_register', receivedNameInput)).items[0].registration;
  const registered = { ...initial, lostRegistered: initial.lostRegistered + 1, receivedRegistered: initial.receivedRegistered + 1,
    lostRecipientRegistered: initial.lostRecipientRegistered + 2, receivedRecipientRegistered: initial.receivedRecipientRegistered + 2 };
  assert.deepEqual(await rpc('pdd_home_stats', {}), registered);
  await rpc('pdd_batch_register', lostInput); await rpc('pdd_recipient_batch_register', receivedNameInput);
  assert.equal((await rpc('pdd_recipient_batch_register', recipientBatch(name, 'received', capB, 'fictional_stats_received_name'))).items[0].result, 'duplicate');
  assert.deepEqual(await rpc('pdd_home_stats', {}), registered);

  // Both sides disclose both sources. Competing/repeated queries mark each row once.
  for (const mode of ['lost', 'received']) {
    const input = recipientQuery(name, mode);
    const results = await Promise.all(Array.from({ length: 8 }, () => rpc('pdd_recipient_query', input)));
    assert(results.every(result => result.leads.length === 2 && !('returnedRefs' in result)));
    await Promise.all(Array.from({ length: 4 }, () => rpc('pdd_recipient_query', recipientQuery(name, mode))));
  }
  const matched = { ...registered, matchedRecipientLeads: registered.matchedRecipientLeads + 4 };
  assert.deepEqual(await rpc('pdd_home_stats', {}), matched);
  assert.equal(await sql('select count(*) from public.pdd_handovers;'), returnsBefore);

  const late = (await rpc('pdd_batch_register', batch('STATREGISTRY99003', 'received', capA, 'fictional_stats_late_name'))).items[0].registration;
  const beforeLateName = { ...matched, receivedRegistered: matched.receivedRegistered + 1 };
  assert.deepEqual(await rpc('pdd_home_stats', {}), beforeLateName);
  let lateCurrent = await rpc('pdd_manage_update', { registration_code: late.registrationCode, capability_hash: capA, revision: late.revision, action: 'contact', recipient_name: '统计后补姓名' });
  const afterLateName = { ...beforeLateName, receivedRecipientRegistered: beforeLateName.receivedRecipientRegistered + 1 };
  assert.deepEqual(await rpc('pdd_home_stats', {}), afterLateName);
  const lateMarker = await sql(`select recipient_registered_at::text from public.pdd_registrations where registration_code='${late.registrationCode}';`);
  assert(lateMarker);
  lateCurrent = await rpc('pdd_manage_update', { registration_code: late.registrationCode, capability_hash: capA, revision: lateCurrent.revision, action: 'contact', recipient_name: '统计更正姓名' });
  lateCurrent = await rpc('pdd_manage_update', { registration_code: late.registrationCode, capability_hash: capA, revision: lateCurrent.revision, action: 'contact', recipient_name: null });
  assert.equal(await sql(`select recipient_registered_at::text from public.pdd_registrations where registration_code='${late.registrationCode}';`), lateMarker);
  assert.deepEqual(await rpc('pdd_home_stats', {}), afterLateName);

  // Every independent record remains cumulative, even a same-name replacement.
  await rpc('pdd_recipient_manage_update', { registration_code: receivedName.registrationCode, capability_hash: capA, revision: receivedName.revision, action: 'withdraw' });
  const replacement = (await rpc('pdd_recipient_batch_register', recipientBatch(name, 'received', capB, 'fictional_stats_received_name'))).items[0].registration;
  assert(replacement);
  const replacementStats = { ...afterLateName, receivedRecipientRegistered: afterLateName.receivedRecipientRegistered + 1 };
  assert.deepEqual(await rpc('pdd_home_stats', {}), replacementStats);
  await rpc('pdd_manage_update', { registration_code: receivedWaybill.registrationCode, capability_hash: capA, revision: receivedWaybill.revision, action: 'withdraw' });
  await sql(`update public.pdd_registrations set closed_at=now()-interval '31 days' where registration_code='${receivedWaybill.registrationCode}';
    update public.pdd_waybills set resolution='resolved',closed_at=now()-interval '31 days' where number='STATREGISTRY99002';
    update public.pdd_recipient_leads set closed_at=now()-interval '31 days' where registration_code='${receivedName.registrationCode}';`);
  await rpc('pdd_cleanup', {});
  const cleanedWaybill = JSON.parse(await sql(`select jsonb_build_object('name',recipient_name,'contact',contact,'note',note,'registered',recipient_registered_at is not null,'matched',recipient_matched_at is not null)::text from public.pdd_registrations where registration_code='${receivedWaybill.registrationCode}';`));
  assert.deepEqual(cleanedWaybill, { name: null, contact: null, note: null, registered: true, matched: true });
  const cleanedName = JSON.parse(await sql(`select jsonb_build_object('name',recipient_name,'contact',contact,'note',note,'matched',recipient_matched_at is not null)::text from public.pdd_recipient_leads where registration_code='${receivedName.registrationCode}';`));
  assert.deepEqual(cleanedName, { name: null, contact: null, note: null, matched: true });
  assert.deepEqual(await rpc('pdd_home_stats', {}), replacementStats);

  const rolledBackNumber = namedBatch('STATROLLBACK99001', 'lost', capA, 'fictional_stats_rolledback');
  await sql(`begin; ${invoke('pdd_batch_register', rolledBackNumber)} ${invoke('pdd_recipient_batch_register', recipientBatch('统计回滚姓名'))} ${invoke('pdd_recipient_query', recipientQuery(name))} rollback;`);
  assert.deepEqual(await rpc('pdd_home_stats', {}), replacementStats);
  assert.equal(await sql(`select recipient_matched_at is null from public.pdd_recipient_leads where registration_code='${replacement.registrationCode}';`), 't');
  assert.equal(await sql("select count(*) from public.pdd_waybills where number='STATROLLBACK99001';"), '0');
  assert.equal(await sql('select count(*) from public.pdd_handovers;'), returnsBefore);
  assert.equal(await sql(`select recipient_matched_at is not null from public.pdd_registrations where registration_code='${lostWaybill.registrationCode}';`), 't');
  assert.equal(await sql(`select recipient_matched_at is not null from public.pdd_recipient_leads where registration_code='${lostName.registrationCode}';`), 't');
  console.log('Six-statistics real transactions passed: both sources/sides, per-record cumulative totals, duplicate/replay isolation, late-name marking, rename/clear retention, concurrent first-hit deduplication, privacy cleanup preserving markers, and registration/hit rollback with parcel/return isolation.');
}
async function verifyPublicInsightsContent(actor) {
  assert.equal(await sql('select count(*) from public.pdd_stats_daily;'), '0', 'Applying the new schema must not infer historical daily counts.');
  const before = await rpc('pdd_home_stats', {});
  // 20:00 is the cron schedule, not a capture RPC guard. Exercise the real
  // service-role capture at any test time instead of inserting a stand-in row.
  assert.equal(await sql("select schedule from cron.job where jobname='pdd404-evening-public-stats';"), '0 13 * * *');
  const captureStartedAt = JSON.parse(await sql('select to_jsonb(clock_timestamp())::text;'));
  const frozen = JSON.parse(await sql(`begin; set local role service_role; ${invoke('pdd_capture_stats_daily', {})} commit;`));
  const timing = JSON.parse(await sql("select jsonb_build_object('bangkokDay',day=(sampled_at at time zone 'Asia/Bangkok')::date,'notFuture',sampled_at<=clock_timestamp())::text from public.pdd_stats_daily;"));
  assert.equal(timing.bangkokDay, true, 'The day must come from the actual server sample in Bangkok.');
  assert.equal(timing.notFuture, true, 'The sample must record actual server time.');
  assert(Date.parse(frozen.sampledAt) >= Date.parse(captureStartedAt), 'The first capture must be acquired by this real RPC call.');
  assert.deepEqual(frozen.stats, before); assert.equal(frozen.metricVersion, 'home-six-lifetime-v1');
  const changedWindow = await sql(`begin; set local role service_role; ${invoke('pdd_batch_register', batch('HISTORYIMMUTABLE99001', 'lost', capA, 'fictional_daily_history'))}
    select jsonb_build_object('live',public.pdd_home_stats('{}'),'snapshot',public.pdd_capture_stats_daily('{}'))::text; rollback;`);
  const changed = JSON.parse(changedWindow.split('\n').filter(line => line.startsWith('{')).at(-1));
  assert.equal(changed.live.lostRegistered, before.lostRegistered + 1);
  assert.deepEqual(changed.snapshot, frozen, 'A rerun must keep the exact first daily sample timestamp and counters despite new business activity.');
  assert.deepEqual(await rpc('pdd_home_stats', {}), before, 'The history verification registration is rolled back.');
  assert.deepEqual((await rpc('pdd_public_stats_history', { days: 30 })).snapshots, [frozen]);
  assert.equal(await sql('select count(*) from public.pdd_stats_daily;'), '1');
  await assert.rejects(() => rpc('pdd_capture_stats_daily', { day: '2020-01-01' }), /INVALID_REQUEST/);
  await assert.rejects(() => sql('update public.pdd_stats_daily set sampled_at=sampled_at;'), /IMMUTABLE_HISTORY/);
  await assert.rejects(() => sql('delete from public.pdd_stats_daily;'), /IMMUTABLE_HISTORY/);

  const asOf = new Date(Date.now() - 60_000).toISOString(), day = new Date(Date.parse(asOf) + 7 * 3600_000).toISOString().slice(0, 10);
  const sourceItem = { id: 'synthetic-news', kind: 'news', origin: 'third-party', title: 'Synthetic source title', summary: 'Synthetic public source summary', source: 'Synthetic publisher',
    sourceUrl: 'https://example.org/synthetic-report', publishedAt: asOf, checkedAt: asOf, channels: ['网站'], thumbnailUrl: null, downloadUrl: null, copyText: null };
  const catalog = { items: [sourceItem] };
  const publication = (kind, key, action, expectedRevision, content) => {
    const envelope = { kind, key, action, expectedRevision, content };
    return { kind, key, action, expected_revision: expectedRevision, content, actor_id: actor, approval_artifact_sha: sha256(canonical(envelope)) };
  };
  const initial = publication('outreach', 'main', 'publish', 0, catalog);
  assert.deepEqual(await rpc('pdd_admin_publication_status', { kind: 'outreach', key: 'main' }), { kind: 'outreach', key: 'main', revision: 0, action: null, publishedAt: null, approvalArtifactSha: null });
  const concurrent = await Promise.allSettled([rpc('pdd_publish_content', initial), rpc('pdd_publish_content', initial)]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(String(concurrent.find(result => result.status === 'rejected').reason), /VERSION_CONFLICT/);
  const first = concurrent.find(result => result.status === 'fulfilled').value;
  assert.equal(first.revision, 1); assert.equal(first.approvalArtifactSha, initial.approval_artifact_sha);
  const savedFirst = JSON.parse(await sql("select to_jsonb(r)::text from public.pdd_content_revisions r where kind='outreach' and revision=1;"));
  const revised = { items: [{ ...sourceItem, title: 'Synthetic corrected public title' }] };
  assert.equal((await rpc('pdd_publish_content', publication('outreach', 'main', 'publish', 1, revised))).revision, 2);
  const projected = await rpc('pdd_public_outreach', {});
  assert.equal(projected.catalog.content.items[0].title, revised.items[0].title);
  assert(!JSON.stringify(projected).includes(actor) && !JSON.stringify(projected).includes('approvalArtifactSha'));
  assert.equal((await rpc('pdd_publish_content', publication('outreach', 'main', 'withdraw', 2, null))).revision, 3);
  assert.equal((await rpc('pdd_public_outreach', {})).catalog, null);
  const withdrawnStatus = await rpc('pdd_admin_publication_status', { kind: 'outreach', key: 'main' });
  assert.equal(withdrawnStatus.revision, 3); assert.equal(withdrawnStatus.action, 'withdraw');
  assert.equal(withdrawnStatus.approvalArtifactSha, publication('outreach', 'main', 'withdraw', 2, null).approval_artifact_sha);
  assert.deepEqual(JSON.parse(await sql("select to_jsonb(r)::text from public.pdd_content_revisions r where kind='outreach' and revision=1;")), savedFirst, 'Revisions and withdrawal retain the original approved content and audit identity.');
  await rpc('pdd_publish_content', publication('outreach', 'main', 'publish', 3, revised));
  const report = { date: day, title: 'Synthetic daily insights', summary: 'Synthetic aggregate report summary', asOf, window: 'Synthetic observation window',
    findings: [{ title: 'Synthetic finding', observed: 'Synthetic measured count', interpretation: 'Synthetic bounded interpretation', unknown: 'Synthetic limitation', helpUrl: '/help' }], newsIds: ['synthetic-news'], limitations: ['Synthetic fixture; never real parcel outcomes.'] };
  const reportReceipt = await rpc('pdd_publish_content', publication('insight', day, 'publish', 0, report));
  assert.equal(reportReceipt.approvalArtifactSha, publication('insight', day, 'publish', 0, report).approval_artifact_sha);
  assert.deepEqual((await rpc('pdd_public_insight_reports', { date: day })).reports[0].content, report);
  const beforeInvalid = await sql('select count(*) from public.pdd_content_revisions;');
  await assert.rejects(() => rpc('pdd_publish_content', { ...publication('insight', day, 'publish', 1, report), approval_artifact_sha: '0'.repeat(64) }), /ARTIFACT_MISMATCH/);
  const incomplete = structuredClone(report); delete incomplete.findings[0].unknown;
  await assert.rejects(() => rpc('pdd_publish_content', publication('insight', day, 'publish', 1, incomplete)), /INVALID_REQUEST/);
  await assert.rejects(() => rpc('pdd_publish_content', publication('insight', day, 'publish', 1, { ...report, newsIds: ['unapproved-source'] })), /INVALID_REQUEST/);
  await assert.rejects(() => rpc('pdd_publish_content', publication('outreach', 'main', 'publish', 4, { items: [{ ...sourceItem, contact: 'synthetic-private-extra' }] })), /INVALID_REQUEST/);
  assert.equal(await sql('select count(*) from public.pdd_content_revisions;'), beforeInvalid);
  await assert.rejects(() => sql("update public.pdd_content_revisions set payload=payload where kind='outreach';"), /IMMUTABLE_HISTORY/);
  await assert.rejects(() => sql("delete from public.pdd_content_revisions where kind='outreach';"), /IMMUTABLE_HISTORY/);
  for (const role of ['anon', 'authenticated']) {
    for (const table of ['pdd_stats_daily', 'pdd_content_revisions']) await assert.rejects(() => sql(`set role ${role}; select * from public.${table};`), /permission denied/);
    for (const name of ['pdd_capture_stats_daily', 'pdd_public_stats_history', 'pdd_public_insight_reports', 'pdd_public_outreach', 'pdd_publish_content', 'pdd_admin_publication_status']) await assert.rejects(() => sql(`set role ${role}; ${invoke(name, {})}`), /permission denied/);
  }
  console.log('Public insights real PostgreSQL passed: no history backfill, actual server-time Bangkok day (20:00 is schedule only), immutable first daily sample, changed business count isolation, concurrent optimistic publication, hash verification, complete content, shared source references, retained withdrawal audit and browser privilege denial.');
}
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
  let domesticGuardChecked = false;
  let monitorClusterChecked = false;
  let recipientStatsUpgradeChecked = false;
  let publicContentUpgradeChecked = false;
  let hourlyUpgradeChecked = false;
  const hourlyTables = ['pdd_stats_hourly','pdd_telemetry_hourly','pdd_insights_settings','pdd_insights_feed','pdd_insights_fact_ledger','pdd_insights_releases'];
  const hourlyMetadataSQL = `select jsonb_agg(jsonb_build_object('name',p.proname,'oid',p.oid,'owner',p.proowner,'acl',p.proacl::text,'securityDefiner',p.prosecdef,'config',p.proconfig,'arguments',p.proargtypes::text,'definition',pg_get_functiondef(p.oid)) order by p.proname)::text
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('pdd_home_stats','pdd_telemetry_ingest','pdd_telemetry_cleanup');`;
  let recipientUpgradeFixture, recipientUpgradeBefore, recipientUpgradeDigest, recipientUpgradeMetadata;
  const recipientStatsMetadataSQL = `select jsonb_agg(jsonb_build_object('name',p.proname,'oid',p.oid,'owner',p.proowner,'acl',p.proacl::text,'securityDefiner',p.prosecdef,'config',p.proconfig,'arguments',p.proargtypes::text) order by p.proname)::text
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('pdd_home_stats','pdd_recipient_lookup','pdd_recipient_query_response');`;
  const recipientMarkerColumnsSQL = `select table_name||'.'||column_name from information_schema.columns where table_schema='public'
    and table_name in ('pdd_registrations','pdd_recipient_leads') and column_name in ('recipient_registered_at','recipient_matched_at') order by table_name,column_name;`;
  const monitorMetadataSQL = `select jsonb_build_object('oid',p.oid,'owner',p.proowner,'acl',p.proacl::text,'securityDefiner',p.prosecdef,'config',p.proconfig,'arguments',p.proargtypes::text,'definition',pg_get_functiondef(p.oid))::text
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='pdd_monitor_status' and p.proargtypes='3802'::oidvector;`;
  const monitorSizeSQL = `select jsonb_build_object('reported',(public.pdd_monitor_status('{}')->>'databaseBytes')::bigint,
    'cluster',(select sum(pg_database_size(oid))::bigint from pg_database),
    'current',pg_database_size(current_database()))::text;`;
  const assertClusterSize = result => { assert.equal(result.reported, result.cluster); assert(result.reported > result.current); };
  const tableDigest = async () => {
    const names = (await sql("select tablename from pg_tables where schemaname='public' order by tablename;")).split('\n');
    const quoteIdentifier = name => '"' + name.replaceAll('"','""') + '"';
    return JSON.parse(await sql('select jsonb_build_object(' + names.flatMap(name => ["'" + name.replaceAll("'","''") + "'", `(select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]')::text) from public.${quoteIdentifier(name)} t)`]).join(',') + ')::text;'));
  };
  const domesticMetadataSQL = `select jsonb_agg(jsonb_build_object('name',p.proname,'oid',p.oid,'owner',p.proowner,'acl',p.proacl::text,'securityDefiner',p.prosecdef,'config',p.proconfig) order by p.proname)::text
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('pdd_number','pdd_query_number','pdd_query_contact');`;
  const forwardingNumber = 'JTTH000990001';
  let historicalRegistration, historicalQuery, historicalContact, forwardingBefore, forwardingMetadata;
  const forwardingSnapshot = async () => JSON.parse(await sql(`select jsonb_build_object(
    'waybills',(select coalesce(jsonb_agg(to_jsonb(w) order by id),'[]') from public.pdd_waybills w),
    'registrations',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.pdd_registrations r),
    'queries',(select coalesce(jsonb_agg(to_jsonb(q) order by id),'[]') from public.pdd_query_events q),
    'writes',(select coalesce(jsonb_agg(to_jsonb(p) order by scope,key),'[]') from public.pdd_write_requests p),
    'audits',(select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from public.pdd_audit_events a))::text;`));
  const businessMetadataSQL = `select jsonb_agg(jsonb_build_object('name',p.proname,'oid',p.oid,'owner',p.proowner,'acl',p.proacl::text,'securityDefiner',p.prosecdef,'config',p.proconfig,'arguments',p.proargtypes::text) order by p.proname)::text
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('pdd_query','pdd_query_contact','pdd_batch_register','pdd_manage_update','pdd_admin_action','pdd_feedback_submit') and p.proargtypes='3802'::oidvector;`;
  for (const name of (await readdir(directory)).filter(n => /^\d+_.+\.sql$/.test(n)).sort()) {
    const upgrade = name === '20261006141735_home_stats_notes_feedback.sql';
    const businessUpgrade = name.endsWith('_pdd_business_conflict_errors.sql');
    const domesticUpgrade = name.endsWith('_domestic_waybill_guard.sql');
    const monitorClusterUpgrade = name.endsWith('_monitor_cluster_database_size.sql');
    const recipientStatsUpgrade = name.endsWith('_home_recipient_stats.sql');
    const publicContentUpgrade = name.endsWith('_public_insights_content.sql');
    const hourlyUpgrade = name.endsWith('_hourly_public_insights.sql');
    const workerUpgrade = name.endsWith('_hourly_insights_worker.sql');
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
    let workerBeforeTables,workerBeforeCron,workerBeforeSource,workerBeforeMetadata;
    const workerMetadataSQL="select jsonb_agg(jsonb_build_object('name',p.proname,'oid',p.oid,'owner',p.proowner,'acl',p.proacl::text,'securityDefiner',p.prosecdef,'config',p.proconfig,'arguments',p.proargtypes::text) order by p.proname)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('pdd_hourly_source','pdd_insights_accept_release');";
    if(workerUpgrade){
      workerBeforeTables=await tableDigest();workerBeforeCron=await sql("select coalesce(jsonb_agg(to_jsonb(j) order by jobname),'[]')::text from cron.job j;");
      workerBeforeSource=await sql("select pg_get_functiondef('public.pdd_hourly_source(jsonb)'::regprocedure);");workerBeforeMetadata=await sql(workerMetadataSQL);
      await sql(`begin;${migration}rollback;`);
      assert.equal(await sql("select to_regclass('public.pdd_insights_runs') is null and to_regclass('public.pdd_insights_audit') is null;"),'t');
      assert.equal(await sql("select count(*) from information_schema.columns where table_schema='public' and table_name='pdd_insights_settings' and column_name in ('daily_call_limit','reservation_usd');"),'0');
      assert.deepEqual(await tableDigest(),workerBeforeTables);assert.equal(await sql("select coalesce(jsonb_agg(to_jsonb(j) order by jobname),'[]')::text from cron.job j;"),workerBeforeCron);
      assert.equal(await sql("select pg_get_functiondef('public.pdd_hourly_source(jsonb)'::regprocedure);"),workerBeforeSource);assert.equal(await sql(workerMetadataSQL),workerBeforeMetadata);
      assert.equal(await sql("select attnotnull from pg_attribute where attrelid='public.pdd_insights_releases'::regclass and attname='actor_id';"),'t');
    }
    let hourlyBeforeTables, hourlyBeforeCron, hourlyBeforeMetadata;
    if (hourlyUpgrade) {
      hourlyBeforeTables = await tableDigest();
      hourlyBeforeCron = await sql("select coalesce(jsonb_agg(to_jsonb(j) order by jobname),'[]')::text from cron.job j;");
      hourlyBeforeMetadata = JSON.parse(await sql(hourlyMetadataSQL));
      await sql(`begin; ${migration} rollback;`);
      for (const table of hourlyTables) assert.equal(await sql(`select to_regclass('public.${table}') is null;`), 't');
      assert.equal(await sql("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='pdd_capture_stats_hourly';"), '0');
      assert.deepEqual(await tableDigest(), hourlyBeforeTables);
      assert.equal(await sql("select coalesce(jsonb_agg(to_jsonb(j) order by jobname),'[]')::text from cron.job j;"), hourlyBeforeCron);
      assert.deepEqual(JSON.parse(await sql(hourlyMetadataSQL)), hourlyBeforeMetadata);
    }
    let publicContentBeforeTables, publicContentBeforeCron;
    if (publicContentUpgrade) {
      publicContentBeforeTables = await tableDigest();
      publicContentBeforeCron = await sql("select coalesce(jsonb_agg(to_jsonb(j) order by jobname),'[]')::text from cron.job j;");
      await sql(`begin; ${migration} rollback;`);
      assert.equal(await sql("select to_regclass('public.pdd_stats_daily') is null and to_regclass('public.pdd_content_revisions') is null;"), 't');
      assert.equal(await sql("select count(*) from storage.buckets where id='pdd-public-assets';"), '0');
      assert.equal(await sql("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='pdd_capture_stats_daily';"), '0');
      assert.equal(await sql("select coalesce(jsonb_agg(to_jsonb(j) order by jobname),'[]')::text from cron.job j;"), publicContentBeforeCron);
      assert.deepEqual(await tableDigest(), publicContentBeforeTables);
    }
    if (recipientStatsUpgrade) {
      const withName = (number, mode, recipientName) => {
        const input = batch(number, mode, capA, 'fictional_stats_upgrade');
        input.items[0].recipient_name = recipientName;
        return input;
      };
      const retainedInput = withName('STATBACKFILL99001', 'received', '统计升级保留姓名');
      const receiptInput = withName('STATBACKFILL99002', 'lost', '统计升级回执姓名');
      const unprovenInput = withName('STATBACKFILL99003', 'received', '统计升级无证据姓名');
      const retained = (await rpc('pdd_batch_register', retainedInput)).items[0].registration;
      const receiptOnly = (await rpc('pdd_batch_register', receiptInput)).items[0].registration;
      const unproven = (await rpc('pdd_batch_register', unprovenInput)).items[0].registration;
      const noName = (await rpc('pdd_batch_register', batch('STATBACKFILL99004', 'lost', capA, 'fictional_stats_upgrade'))).items[0].registration;
      const independent = (await rpc('pdd_recipient_batch_register', recipientBatch('统计升级独立姓名', 'lost'))).items[0].registration;
      // Historical query events retain no row references and cannot prove a hit marker.
      assert.equal((await rpc('pdd_recipient_query', recipientQuery(retained.recipientName))).leads.length, 1);
      assert.equal((await rpc('pdd_recipient_query', recipientQuery(independent.recipientName, 'received'))).leads.length, 1);
      await sql(`update public.pdd_registrations set recipient_name=null,recipient_name_key=null where registration_code in ('${receiptOnly.registrationCode}','${unproven.registrationCode}');
        update public.pdd_registrations set created_at=now()-interval '10 days' where registration_code='${retained.registrationCode}';
        update public.pdd_write_requests set receipt=receipt #- '{0,recipientNameSaved}' where scope='batch' and key in ('${retainedInput.request_id}','${unprovenInput.request_id}');
        update public.pdd_write_requests set created_at=now()-interval '5 days' where scope='batch' and key='${receiptInput.request_id}';`);
      recipientUpgradeFixture = { retained, receiptOnly, unproven, noName, independent };
      recipientUpgradeBefore = await rpc('pdd_home_stats', {});
      recipientUpgradeDigest = await tableDigest();
      recipientUpgradeMetadata = JSON.parse(await sql(recipientStatsMetadataSQL));
      const expected = { ...recipientUpgradeBefore, lostRecipientRegistered: 2, receivedRecipientRegistered: 1, matchedRecipientLeads: 0 };
      const trial = JSON.parse(await sql(`begin; ${migration} ${invoke('pdd_home_stats', {})} rollback;`));
      assert.deepEqual(trial, expected);
      assert.equal(await sql(recipientMarkerColumnsSQL), '', 'Rollback left new marker columns behind.');
      assert.deepEqual(await tableDigest(), recipientUpgradeDigest);
      assert.deepEqual(JSON.parse(await sql(recipientStatsMetadataSQL)), recipientUpgradeMetadata);
      // An encrypted pre-upgrade pg_dump is restored before applying the new migration.
      const oldDump = path.join(root, 'pre-recipient-stats.dump'), oldSealed = path.join(root, 'pre-recipient-stats.cmibak'), oldReopened = path.join(root, 'pre-recipient-stats-restored.dump');
      await run(path.join(bin, 'pg_dump'), ['--format=custom', '--no-owner', '--schema=public', '--schema=auth', '--file', oldDump, '--dbname', 'postgres'], { env });
      const oldPassword = randomBytes(32).toString('base64url');
      await encryptFile(oldDump, oldSealed, oldPassword); await decryptFile(oldSealed, oldReopened, oldPassword);
      await sql('create database pdd404_old_stats_restore;');
      await bootstrap('pdd404_old_stats_restore');
      await run(path.join(bin, 'pg_restore'), ['--no-owner', '--exit-on-error', '--clean', '--if-exists', '--dbname', 'pdd404_old_stats_restore', oldReopened], { env, maxBuffer: 2 * 1024 * 1024 });
      assert.equal(await sql(recipientMarkerColumnsSQL, 'pdd404_old_stats_restore'), '');
      assert.deepEqual(await rpc('pdd_home_stats', {}, 'pdd404_old_stats_restore'), recipientUpgradeBefore);
      await sql(migration, 'pdd404_old_stats_restore');
      assert.deepEqual(await rpc('pdd_home_stats', {}, 'pdd404_old_stats_restore'), expected);
      await assert.rejects(() => sql('set role anon; select * from public.pdd_recipient_leads;', 'pdd404_old_stats_restore'), /permission denied/);
    }
    let beforeMonitorMetadata, beforeMonitorTables;
    if (monitorClusterUpgrade) {
      beforeMonitorMetadata = JSON.parse(await sql(monitorMetadataSQL));
      beforeMonitorTables = await tableDigest();
      const transactionSize = JSON.parse(await sql(`begin; ${migration} set local role service_role; ${monitorSizeSQL} rollback;`));
      assertClusterSize(transactionSize);
      assert.deepEqual(JSON.parse(await sql(monitorMetadataSQL)), beforeMonitorMetadata);
      assert.deepEqual(await tableDigest(), beforeMonitorTables);
    }
    if (domesticUpgrade) {
      forwardingMetadata = JSON.parse(await sql(domesticMetadataSQL));
      historicalRegistration = (await rpc('pdd_batch_register', batch(forwardingNumber, 'received', capA, 'fictional_forwarding_holder'))).items[0].registration;
      historicalQuery = { query_id: randomUUID(), number: forwardingNumber, mode: 'lost', source: 'manual', capability_hash: capB, body_hash: 'historical-forwarding-query' };
      assert.equal((await rpc('pdd_query', historicalQuery)).result, 'matched');
      historicalContact = { query_id: historicalQuery.query_id, capability_hash: capB, contact: { kind: 'wechat', value: 'fictional_forwarding_owner' }, idempotency_key: 'historical-forwarding-contact', body_hash: 'historical-forwarding-contact' };
      await rpc('pdd_query_contact', historicalContact);
      historicalQuery = { ...historicalQuery, query_id: randomUUID(), body_hash: 'historical-unsubmitted-query' };
      await rpc('pdd_query', historicalQuery);
      forwardingBefore = await forwardingSnapshot();
    }
    if (name.endsWith('_wechat_leading_underscore.sql')) {
      const contactMetadataSQL = `select jsonb_build_object('oid',p.oid,'owner',p.proowner,'acl',p.proacl::text,'securityDefiner',p.prosecdef,'config',p.proconfig)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='pdd_contact_valid';`;
      const metadata = JSON.parse(await sql(contactMetadataSQL)), digest = await tableDigest();
      const input = quote({ kind: 'wechat', value: '_PDD404TEST_2026' });
      assert.equal(await sql(`select public.pdd_contact_valid(${input});`), 'f');
      assert.equal(await sql(`begin; ${migration} select public.pdd_contact_valid(${input}); rollback;`), 't');
      assert.equal(await sql(`select public.pdd_contact_valid(${input});`), 'f');
      assert.deepEqual(JSON.parse(await sql(contactMetadataSQL)), metadata);
      assert.deepEqual(await tableDigest(), digest);
      await sql(`begin; ${migration} commit;`);
      assert.deepEqual(JSON.parse(await sql(contactMetadataSQL)), metadata);
      assert.deepEqual(await tableDigest(), digest);
      assert.equal(await sql(`select public.pdd_contact_valid(${input});`), 't');
      assert.equal(await sql(`select public.pdd_contact_projection(${input})->>'value';`), '_PDD404TEST_2026');
      assert.equal(await sql(`select public.pdd_contact_valid(${quote({ kind: 'wechat', value: 'A'.repeat(64) })});`), 't');
      for (const value of ['昵称', 'space name', '-PDD404TEST', '123456', '_tiny']) {
        assert.equal(await sql(`select public.pdd_contact_valid(${quote({ kind: 'wechat', value })});`), 'f');
      }
      const lead = await rpc('pdd_recipient_batch_register', recipientBatch('下划线迁移合成收件人', 'received', capA, '_PDD404TEST_2026'));
      assert.equal(lead.items[0].registration.contact.value, '_PDD404TEST_2026');
      assert.equal((await rpc('pdd_recipient_query', recipientQuery('下划线迁移合成收件人'))).leads[0].contact.value, '_PDD404TEST_2026');
      console.log('WeChat underscore migration passed real rollback/commit, unchanged stored rows/function identity/ACL, legacy length compatibility, and exact-name contact readback.');
    } else {
      await sql(publicContentUpgrade || hourlyUpgrade || workerUpgrade ? `begin; ${migration} commit;` : migration);
    }
    if (publicContentUpgrade) {
      assert.equal(await sql('select count(*) from public.pdd_stats_daily;'), '0');
      assert.equal(await sql('select count(*) from public.pdd_content_revisions;'), '0');
      assert.equal(await sql("select public from storage.buckets where id='pdd-public-assets';"), 't');
      assert.equal(await sql("select schedule from cron.job where jobname='pdd404-evening-public-stats';"), '0 13 * * *');
      assert.equal(await sql("select coalesce(jsonb_agg(to_jsonb(j) order by jobname),'[]')::text from cron.job j where jobname<>'pdd404-evening-public-stats';"), publicContentBeforeCron);
      const afterTables = await tableDigest(); delete afterTables.pdd_stats_daily; delete afterTables.pdd_content_revisions;
      assert.deepEqual(afterTables, publicContentBeforeTables);
      publicContentUpgradeChecked = true;
      console.log('Public-content migration passed actual transaction rollback/commit: no residual tables/RPC/bucket/cron job after rollback, no historical inference, prior table digests and cron jobs preserved.');
    }
    if(workerUpgrade){
      const afterTables=await tableDigest();delete afterTables.pdd_insights_runs;delete afterTables.pdd_insights_audit;
      // New settings columns have safe fixed defaults; every previous value is unchanged.
      delete afterTables.pdd_insights_settings;const oldSettingsDigest=workerBeforeTables.pdd_insights_settings;delete workerBeforeTables.pdd_insights_settings;
      assert.deepEqual(afterTables,workerBeforeTables);
      assert.equal(await sql("select md5(coalesce(jsonb_agg(to_jsonb(t)-array['daily_call_limit','reservation_usd'] order by to_jsonb(t)::text),'[]')::text) from public.pdd_insights_settings t;"),oldSettingsDigest);
      assert.equal(await sql("select coalesce(jsonb_agg(to_jsonb(j) order by jobname),'[]')::text from cron.job j where jobname<>'pdd404-hourly-insights-worker';"),workerBeforeCron);
      assert.equal(await sql("select schedule from cron.job where jobname='pdd404-hourly-insights-worker';"),'5 * * * *');assert.equal(await sql(workerMetadataSQL),workerBeforeMetadata);
      assert.equal(await sql("select attnotnull from pg_attribute where attrelid='public.audit_events'::regclass and attname='actor_id';"),'t');
      assert.equal(await sql("select attnotnull from pg_attribute where attrelid='public.pdd_insights_releases'::regclass and attname='actor_id';"),'f');
      console.log('Independent observer migration passed real rollback/commit: no residual runs/audit/settings columns/job, prior values and all preexisting jobs retained.');
    }
    if (hourlyUpgrade) {
      const afterTables = await tableDigest(); for (const table of hourlyTables) delete afterTables[table];
      assert.deepEqual(afterTables, hourlyBeforeTables);
      assert.equal(await sql("select coalesce(jsonb_agg(to_jsonb(j) order by jobname),'[]')::text from cron.job j where jobname<>'pdd404-hourly-public-stats';"), hourlyBeforeCron);
      assert.equal(await sql("select schedule from cron.job where jobname='pdd404-hourly-public-stats';"), '0 * * * *');
      const afterMetadata = JSON.parse(await sql(hourlyMetadataSQL));
      for (let i=0;i<hourlyBeforeMetadata.length;i++) {
        const {definition: beforeDefinition,...beforeIdentity}=hourlyBeforeMetadata[i];
        const {definition: afterDefinition,...afterIdentity}=afterMetadata[i];
        assert.deepEqual(afterIdentity,beforeIdentity);
        if (beforeIdentity.name==='pdd_home_stats') assert.equal(afterDefinition,beforeDefinition);
        else assert.notEqual(afterDefinition,beforeDefinition);
      }
      assert.equal(await sql('select count(*) from public.pdd_stats_hourly;'),'0');
      assert.equal(await sql('select count(*) from public.pdd_telemetry_hourly;'),'0');
      hourlyUpgradeChecked=true;
      console.log('Hourly migration passed actual rollback/commit, no historical backfill, prior row digests and cron jobs preserved, unchanged RPC identities/ACL and six-stat definition.');
    }
    if (recipientStatsUpgrade) {
      assert.deepEqual(JSON.parse(await sql(recipientStatsMetadataSQL)), recipientUpgradeMetadata);
      assert.deepEqual(await rpc('pdd_home_stats', {}), { ...recipientUpgradeBefore, lostRecipientRegistered: 2, receivedRecipientRegistered: 1, matchedRecipientLeads: 0 });
      assert.equal(await sql(recipientMarkerColumnsSQL), 'pdd_recipient_leads.recipient_matched_at\npdd_registrations.recipient_matched_at\npdd_registrations.recipient_registered_at');
      const evidence = JSON.parse(await sql(`select jsonb_object_agg(registration_code,recipient_registered_at is not null)::text from public.pdd_registrations;`));
      assert.equal(evidence[recipientUpgradeFixture.retained.registrationCode], true);
      assert.equal(evidence[recipientUpgradeFixture.receiptOnly.registrationCode], true);
      assert.equal(evidence[recipientUpgradeFixture.unproven.registrationCode], false);
      assert.equal(evidence[recipientUpgradeFixture.noName.registrationCode], false);
      assert.equal(await sql(`select recipient_registered_at>created_at from public.pdd_registrations where registration_code='${recipientUpgradeFixture.retained.registrationCode}';`), 't', 'A current name without a save receipt must use migration time, not parcel creation time.');
      assert.equal(await sql(`select r.recipient_registered_at=w.created_at from public.pdd_registrations r join public.pdd_write_requests w on w.scope='batch'
        and exists(select 1 from jsonb_array_elements(w.receipt) item where item->>'registrationCode'=r.registration_code and item->'recipientNameSaved'='true'::jsonb)
        where r.registration_code='${recipientUpgradeFixture.receiptOnly.registrationCode}';`), 't', 'An explicit save receipt must retain its proven save time.');
      assert.equal(await sql('select count(*) from public.pdd_registrations where recipient_matched_at is not null;'), '0');
      assert.equal(await sql('select count(*) from public.pdd_recipient_leads where recipient_matched_at is not null;'), '0');
      await sql('truncate public.pdd_waybills,public.pdd_registrations,public.pdd_query_events,public.pdd_write_requests,public.pdd_audit_events,public.pdd_handovers,public.pdd_recipient_leads,public.pdd_recipient_query_events,public.pdd_recipient_audit_events cascade;');
      recipientStatsUpgradeChecked = true;
      console.log('Six-statistics migration passed real rollback, retained-name/explicit-receipt-only backfill, zero historical hit inference, RPC identity/ACL preservation, and encrypted pre-upgrade dump restore plus migration.');
    }
    if (monitorClusterUpgrade) {
      const afterMonitorMetadata = JSON.parse(await sql(monitorMetadataSQL));
      const { definition: oldDefinition, ...oldIdentity } = beforeMonitorMetadata;
      const { definition: newDefinition, ...newIdentity } = afterMonitorMetadata;
      assert.notEqual(newDefinition, oldDefinition);
      assert.deepEqual(newIdentity, oldIdentity);
      assert.deepEqual(await tableDigest(), beforeMonitorTables);
      assertClusterSize(JSON.parse(await sql(`begin read only; set local role service_role; ${monitorSizeSQL} commit;`)));
      monitorClusterChecked = true;
      console.log('Cluster quota migration passed real transaction rollback, preserved RPC identity/owner/ACL/security and every public-table digest, and service-role read-only size equals all databases including templates.');
    }
    if (domesticUpgrade) {
      assert.deepEqual(JSON.parse(await sql(domesticMetadataSQL)), forwardingMetadata);
      assert.deepEqual(await forwardingSnapshot(), forwardingBefore);
      for (const mode of ['lost', 'received']) for (const source of ['manual', 'barcode']) {
        for (const number of [forwardingNumber, ' jtth 000990001 ', 'J T T H\u00a0000990001']) {
          for (const flags of [{}, { allow_possible: false }, { allow_possible: true }]) {
            await assert.rejects(() => rpc('pdd_query', { ...historicalQuery, query_id: randomUUID(), number, mode, source, ...flags }), /NON_DOMESTIC_WAYBILL/);
          }
          const mixed = batch('SF000990002', mode, capA, 'fictional_mixed_batch');
          mixed.items.push({ request_id: randomUUID(), number, source });
          await assert.rejects(() => rpc('pdd_batch_register', mixed), /NON_DOMESTIC_WAYBILL/);
        }
      }
      await assert.rejects(() => rpc('pdd_query', { ...historicalQuery, query_id: randomUUID(), number: 'JTTH00099?001', allow_possible: true }), /NON_DOMESTIC_WAYBILL/);
      for (const contact of [historicalContact, { ...historicalContact, query_id: historicalQuery.query_id, idempotency_key: 'new-forwarding-contact' }]) {
        await assert.rejects(() => rpc('pdd_query_contact', contact), /NON_DOMESTIC_WAYBILL/);
      }
      await assert.rejects(() => rpc('pdd_query_contact', { ...historicalContact, capability_hash: 'c'.repeat(64) }), /FORBIDDEN/);
      assert.deepEqual(await forwardingSnapshot(), forwardingBefore);
      assert.equal((await rpc('pdd_manage', { registration_code: historicalRegistration.registrationCode, capability_hash: capA })).number, forwardingNumber);
      const updated = await rpc('pdd_manage_update', { registration_code: historicalRegistration.registrationCode, capability_hash: capA, revision: historicalRegistration.revision,
        action: 'contact', contact: { kind: 'wechat', value: 'fictional_updated_holder' } });
      assert.equal(updated.number, forwardingNumber);
      const withdrawn = await rpc('pdd_manage_update', { registration_code: updated.registrationCode, capability_hash: capA, revision: updated.revision, action: 'withdraw' });
      assert.equal(withdrawn.visibility, 'withdrawn');
      assert.equal(await sql("select count(*) from public.pdd_audit_events where action='owner_withdraw';"), '1');
      await sql('truncate public.pdd_waybills,public.pdd_registrations,public.pdd_query_events,public.pdd_write_requests,public.pdd_audit_events,public.pdd_handovers cascade;');
      domesticGuardChecked = true;
      console.log('Domestic guard real PostgreSQL upgrade passed: mixed batches/query/contact replays reject without side effects; history and RPC identities remain intact and withdrawal is audited.');
    }
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
  assert(domesticGuardChecked, 'The domestic-waybill guard upgrade was not exercised.');
  assert(monitorClusterChecked, 'The cluster database-size migration was not exercised.');
  assert(recipientStatsUpgradeChecked, 'The recipient statistics migration was not exercised.');
  assert(publicContentUpgradeChecked, 'The public insight/content migration was not exercised.');
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

  // Hold the current registry-before-number lock order in another connection,
  // revoke the capability with cleanup, then let the waiting management resume.
  const retentionNumber = 'SF990000006005';
  const retentionItem = (await rpc('pdd_batch_register', batch(retentionNumber, 'received', capA, 'fictional_retention'))).items[0];
  const retainedRegistration = retentionItem.registration;
  await sql(`update public.pdd_registrations set closed_at=now()-interval '31 days' where registration_code='${retainedRegistration.registrationCode}';
    update public.pdd_waybills set resolution='resolved',closed_at=now()-interval '31 days' where number='${retentionNumber}';`);
  const holder = transactionSession();
  let waiting;
  try {
    holder.send(`begin; select pg_advisory_xact_lock(hashtextextended('pdd-recipient-registry',0)); select pg_advisory_xact_lock(hashtextextended('pdd-number:${retentionNumber}',0));\n\\echo PDD_RETENTION_LOCK_HELD`);
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

  // New telemetry writes are bounded, anonymous and separate from registrations.
  const telemetryEvent = { event: 'pdd_page_view', page: 'home', count: 10 };
  const telemetryInput = { events: [telemetryEvent], daily_limit: 50 };
  const businessBeforeTelemetry = await rpc('pdd_home_stats', {});
  await sql(`begin; ${invoke('pdd_telemetry_ingest', telemetryInput)} rollback;`);
  assert.equal(await sql('select count(*) from public.pdd_telemetry_daily;'), '0');
  assert.equal(await sql('select count(*) from public.pdd_telemetry_budget;'), '0');
  await assert.rejects(() => rpc('pdd_telemetry_ingest', { ...telemetryInput, events: [telemetryEvent, { ...telemetryEvent, ip: 'synthetic-private-ip' }] }), /INVALID_REQUEST/);
  await assert.rejects(() => rpc('pdd_telemetry_ingest', { ...telemetryInput, events: [{ event: 'pdd_visible_dwell', page: 'home', count: 1 }] }), /INVALID_REQUEST/);
  await assert.rejects(() => rpc('pdd_telemetry_ingest', { ...telemetryInput, daily_limit: 100001 }), /INVALID_REQUEST/);
  assert.equal(await sql('select count(*) from public.pdd_telemetry_budget;'), '0');
  const telemetryRace = await Promise.all(Array.from({ length: 12 }, () => rpc('pdd_telemetry_ingest', telemetryInput)));
  assert.equal(telemetryRace.filter(receipt => receipt.accepted).length, 5);
  assert.equal(telemetryRace.filter(receipt => receipt.limited).length, 7);
  assert(telemetryRace.every(receipt => receipt.day === new Date().toISOString().slice(0, 10)));
  assert.equal(await sql('select sum(event_count) from public.pdd_telemetry_daily;'), '50');
  assert.equal(await sql('select sum(event_count) from public.pdd_telemetry_hourly;'), '50', 'Concurrent accepted batches must write both aggregates under one unchanged cap.');
  let telemetrySummary = await rpc('pdd_telemetry_summary', { days: 7 });
  assert.equal(telemetrySummary.budget[0].acceptedBatches, 5);
  assert.equal(telemetrySummary.budget[0].acceptedEvents, 50);
  assert(telemetrySummary.budget[0].limitedAt);
  assert.deepEqual(await rpc('pdd_home_stats', {}), businessBeforeTelemetry);
  for (const name of ['pdd_telemetry_ingest', 'pdd_telemetry_summary', 'pdd_monitor_status']) {
    await assert.rejects(() => sql(`set role anon; ${invoke(name, name === 'pdd_telemetry_ingest' ? telemetryInput : {})}`), /permission denied/);
    await assert.rejects(() => sql(`set role authenticated; ${invoke(name, name === 'pdd_telemetry_ingest' ? telemetryInput : {})}`), /permission denied/);
  }
  const monitor = JSON.parse(await sql(`begin read only; set local role service_role; ${invoke('pdd_monitor_status', {})} commit;`));
  assert(monitor.databaseBytes > 0 && monitor.connections >= 1 && monitor.maxConnections > monitor.reservedConnections);
  assertClusterSize(JSON.parse(await sql(`begin read only; set local role service_role; ${monitorSizeSQL} commit;`)));
  assert.equal(monitor.databaseSizeLimitBytes, null);
  assert(!JSON.stringify(monitor).includes('fictional_'));
  const monitorColumns = await sql("select string_agg(key,',' order by key) from jsonb_object_keys(public.pdd_monitor_status('{}')) key;");
  const monitorDefinition = JSON.parse(await sql(monitorMetadataSQL)).definition;
  await sql("insert into public.pdd_telemetry_daily(day,event,page,event_count) values((now() at time zone 'UTC')::date-30,'pdd_page_view','help',2); insert into public.pdd_telemetry_budget(day,daily_limit) values((now() at time zone 'UTC')::date-30,50);");
  assert.deepEqual(await rpc('pdd_telemetry_cleanup', {}), { aggregateRows: 1, budgetRows: 1 });
  telemetrySummary = await rpc('pdd_telemetry_summary', { days: 30 });
  console.log('Telemetry real transactions/concurrency passed: invalid/rolled-back batches wrote nothing, 12 competing batches stayed at exactly 50 events, no registration stats changed; monitor RPC passed a service-role read-only transaction and public access was denied.');

  await verifyRecipientLifetimeStats();
  const nameNumber = 'RECIPIENT990001';
  const numberWithName = batch(nameNumber, 'received', capA, 'fictional_name_number', randomUUID(), 'Synthetic numbered recipient note');
  numberWithName.items[0].recipient_name = '  Jose\u0301  示例  ';
  const numberedRecipient = (await rpc('pdd_batch_register', numberWithName)).items[0];
  assert.equal(numberedRecipient.recipientNameSaved, true);
  assert.equal(numberedRecipient.registration.recipientName, 'José 示例');
  const duplicateNumber = batch(nameNumber, 'received', capB, 'fictional_other_number_holder');
  duplicateNumber.items[0].recipient_name = '未保存的收件人';
  const unsavedRecipient = (await rpc('pdd_batch_register', duplicateNumber)).items[0];
  assert.equal(unsavedRecipient.registration, null);
  assert.equal(unsavedRecipient.recipientNameSaved, false);
  assert.equal((await rpc('pdd_recipient_query', recipientQuery('未保存的收件人'))).result, 'not_found');
  assert.equal((await rpc('pdd_manage', { registration_code: numberedRecipient.registration.registrationCode, capability_hash: capA })).recipientName, 'José 示例');
  const oppositeNameNumber = batch(nameNumber, 'lost', capB, 'fictional_name_owner');
  oppositeNameNumber.items[0].recipient_name = 'José 示例';
  const matchedNameNumber = (await rpc('pdd_batch_register', oppositeNameNumber)).items[0];
  assert.equal(matchedNameNumber.result, 'matched');
  assert.equal(matchedNameNumber.recipientNameSaved, true);
  assert.equal(matchedNameNumber.registration.recipientName, 'José 示例');
  const beforeNameOnly = await rpc('pdd_home_stats', {});

  const nfcPayload = recipientBatch('Jose\u0301 示例');
  const sameRequestNames = await Promise.all(Array.from({ length: 6 }, () => rpc('pdd_recipient_batch_register', nfcPayload)));
  const nfcRegistration = sameRequestNames[0].items[0].registration;
  assert(nfcRegistration);
  assert.equal(nfcRegistration.recipientName, 'José 示例');
  assert(sameRequestNames.every(receipt => receipt.items[0].registration.registrationCode === nfcRegistration.registrationCode));
  const deniedNameDuplicate = (await rpc('pdd_recipient_batch_register', recipientBatch('José 示例', 'received', capB))).items[0];
  assert.equal(deniedNameDuplicate.result, 'duplicate');
  assert.equal(deniedNameDuplicate.registration, null);
  await assert.rejects(() => rpc('pdd_recipient_manage', { registration_code: nfcRegistration.registrationCode, capability_hash: capB }), /FORBIDDEN/);
  const recipientRestoreQuery = recipientQuery('josé 示例');
  const unionNames = await rpc('pdd_recipient_query', recipientRestoreQuery);
  assert.equal(unionNames.result, 'leads_found');
  assert.equal(unionNames.leads.length, 2);
  assert.deepEqual(new Set(unionNames.leads.map(lead => lead.contact.value)), new Set(['fictional_name_number', 'fictional_name_holder']));
  assert(unionNames.leads.every(lead => Object.keys(lead).sort().join(',') === 'contact,note,recipientName,registeredAt'));
  assert(unionNames.leads.every(lead => lead.note));
  for (const name of ['José', 'Jose 示例', '收件人 José 示例']) assert.equal((await rpc('pdd_recipient_query', recipientQuery(name))).result, 'not_found');
  for (const name of ['ผู้รับทดสอบ', '测试收件人']) {
    await rpc('pdd_recipient_batch_register', recipientBatch(name));
    assert.equal((await rpc('pdd_recipient_query', recipientQuery(name))).leads[0].recipientName, name);
  }
  const ownAfterHit = (await rpc('pdd_recipient_batch_register', recipientBatch('José 示例', 'lost', capB, 'fictional_name_seeker'))).items[0];
  assert.equal(ownAfterHit.result, 'registered', 'Finding an opposite lead must not block a separate own registration.');
  await rpc('pdd_recipient_batch_register', recipientBatch('José 示例', 'received', capB, 'fictional_name_other'));
  assert.equal((await rpc('pdd_recipient_query', recipientQuery('José 示例'))).leads.length, 3);

  const nameRaceA = recipientBatch('并发收件人', 'received', capA, 'fictional_same_name_contact');
  const nameRaceB = recipientBatch('并发收件人', 'received', capB, 'fictional_same_name_contact');
  const nameRace = await Promise.all([rpc('pdd_recipient_batch_register', nameRaceA), rpc('pdd_recipient_batch_register', nameRaceB)]);
  assert.deepEqual(nameRace.map(receipt => receipt.items[0].result).sort(), ['duplicate', 'registered']);
  assert.equal(nameRace.filter(receipt => receipt.items[0].registration !== null).length, 1);
  assert.equal(await sql("select count(*) from public.pdd_recipient_leads where recipient_name='并发收件人';"), '1');
  const nameWinner = nameRace.findIndex(receipt => receipt.items[0].registration !== null);
  await assert.rejects(() => rpc('pdd_recipient_manage', { registration_code: nameRace[nameWinner].items[0].registration.registrationCode, capability_hash: nameWinner === 0 ? capB : capA }), /FORBIDDEN/);
  await rpc('pdd_recipient_batch_register', recipientBatch('并发收件人', 'received', capB, 'fictional_different_contact'));
  assert.equal((await rpc('pdd_recipient_query', recipientQuery('并发收件人'))).leads.length, 2);
  const firstRename = (await rpc('pdd_recipient_batch_register', recipientBatch('姓名更正甲'))).items[0].registration;
  await rpc('pdd_recipient_batch_register', recipientBatch('姓名更正乙'));
  await businessError(() => rpc('pdd_recipient_manage_update', { registration_code: firstRename.registrationCode, capability_hash: capA, revision: firstRename.revision, action: 'update', recipient_name: '姓名更正乙' }), 'DUPLICATE_RECIPIENT');
  assert.equal((await rpc('pdd_recipient_manage', { registration_code: firstRename.registrationCode, capability_hash: capA })).recipientName, '姓名更正甲');
  const renamed = await rpc('pdd_recipient_manage_update', { registration_code: firstRename.registrationCode, capability_hash: capA, revision: firstRename.revision, action: 'update', recipient_name: '姓名更正丙' });
  assert.equal(renamed.revision, firstRename.revision + 1);
  assert.equal((await rpc('pdd_recipient_query', recipientQuery('姓名更正甲'))).result, 'not_found');
  assert.equal((await rpc('pdd_recipient_query', recipientQuery('姓名更正丙'))).leads.length, 1);
  const renameWithdrawRace = await Promise.allSettled([
    rpc('pdd_recipient_manage_update', { registration_code: renamed.registrationCode, capability_hash: capA, revision: renamed.revision, action: 'update', recipient_name: '姓名更正丁' }),
    rpc('pdd_recipient_manage_update', { registration_code: renamed.registrationCode, capability_hash: capA, revision: renamed.revision, action: 'withdraw' }),
  ]);
  assert.equal(renameWithdrawRace.filter(result => result.status === 'fulfilled').length, 1);
  const afterRenameRace = await rpc('pdd_recipient_manage', { registration_code: renamed.registrationCode, capability_hash: capA });
  if (afterRenameRace.state !== 'withdrawn') await rpc('pdd_recipient_manage_update', { registration_code: renamed.registrationCode, capability_hash: capA, revision: afterRenameRace.revision, action: 'withdraw' });
  for (const name of ['姓名更正丙', '姓名更正丁']) assert.equal((await rpc('pdd_recipient_query', recipientQuery(name))).result, 'not_found');

  const originalTombstoneInput = recipientBatch('旧重复回执收件人', 'received', capA, 'fictional_tombstone_holder');
  const originalTombstoneLead = (await rpc('pdd_recipient_batch_register', originalTombstoneInput)).items[0].registration;
  const duplicateTombstoneInput = recipientBatch('旧重复回执收件人', 'received', capB, 'fictional_tombstone_holder');
  const duplicateTombstoneReceipt = await rpc('pdd_recipient_batch_register', duplicateTombstoneInput);
  assert.equal(duplicateTombstoneReceipt.items[0].result, 'duplicate');
  assert.equal(duplicateTombstoneReceipt.items[0].registration, null);
  const recipientRequestRow = (input, database = 'postgres') => sql(`select jsonb_build_object('key',key,'capabilityHash',capability_hash,'bodyHash',body_hash,'receipt',receipt)::text from public.pdd_write_requests where scope='recipient-batch' and key='${input.request_id}';`, database).then(JSON.parse);
  assert.equal((await recipientRequestRow(duplicateTombstoneInput)).receipt[0].registrationCode, null);
  await sql(`update public.pdd_write_requests set created_at=now()-interval '31 days' where scope='recipient-batch' and key='${duplicateTombstoneInput.request_id}';`);
  await rpc('pdd_cleanup', {});
  const duplicateTombstone = await recipientRequestRow(duplicateTombstoneInput);
  assert.deepEqual(duplicateTombstone, { key: duplicateTombstoneInput.request_id, capabilityHash: capB, bodyHash: duplicateTombstoneInput.body_hash, receipt: [] });
  const tombstoneLeadCount = await sql('select count(*) from public.pdd_recipient_leads;');
  await businessError(() => rpc('pdd_recipient_batch_register', duplicateTombstoneInput), 'IDEMPOTENCY_CONFLICT');
  assert.equal(await sql('select count(*) from public.pdd_recipient_leads;'), tombstoneLeadCount);
  await rpc('pdd_recipient_manage_update', { registration_code: originalTombstoneLead.registrationCode, capability_hash: capA, revision: originalTombstoneLead.revision, action: 'withdraw' });
  await businessError(() => rpc('pdd_recipient_batch_register', duplicateTombstoneInput), 'IDEMPOTENCY_CONFLICT');
  assert.equal(await sql('select count(*) from public.pdd_recipient_leads;'), tombstoneLeadCount);
  await sql(`update public.pdd_recipient_leads set closed_at=now()-interval '31 days' where registration_code='${originalTombstoneLead.registrationCode}';`);
  await rpc('pdd_cleanup', {});
  assert.deepEqual((await recipientRequestRow(originalTombstoneInput)).receipt, [], 'A newer receipt referencing a cleared lead must also be scrubbed.');
  await businessError(() => rpc('pdd_recipient_batch_register', originalTombstoneInput), 'IDEMPOTENCY_CONFLICT');
  await businessError(() => rpc('pdd_recipient_batch_register', duplicateTombstoneInput), 'IDEMPOTENCY_CONFLICT');
  assert.equal(await sql('select count(*) from public.pdd_recipient_leads;'), tombstoneLeadCount);
  await assert.rejects(() => rpc('pdd_recipient_manage', { registration_code: originalTombstoneLead.registrationCode, capability_hash: capA }), /FORBIDDEN/);
  const freshTombstoneLead = (await rpc('pdd_recipient_batch_register', recipientBatch('旧重复回执收件人', 'received', capB, 'fictional_tombstone_holder'))).items[0];
  assert.equal(freshTombstoneLead.result, 'registered');
  assert(freshTombstoneLead.registration);
  assert.equal(await sql('select count(*) from public.pdd_recipient_leads;'), String(Number(tombstoneLeadCount) + 1));

  const pageName = '分页测试收件人';
  const pageRegistrations = [];
  for (let index = 0; index < 22; index++) pageRegistrations.push((await rpc('pdd_recipient_batch_register', recipientBatch(pageName, 'received', capA, `fictional_page_holder_${index}`, `Synthetic page note ${index}`))).items[0].registration);
  const pageInput = recipientQuery(pageName);
  const beforeNamePages = await rpc('pdd_home_stats', {});
  const firstPages = await Promise.all(Array.from({ length: 8 }, () => rpc('pdd_recipient_query', pageInput)));
  const firstNamePage = firstPages[0];
  assert(firstPages.every(page => JSON.stringify(page) === JSON.stringify(firstNamePage)));
  assert.equal(firstNamePage.leads.length, 20); assert(firstNamePage.nextCursor);
  const afterFirstPage = { ...beforeNamePages, matchedRecipientLeads: beforeNamePages.matchedRecipientLeads + 20 };
  assert.deepEqual(await rpc('pdd_home_stats', {}), afterFirstPage);
  assert.equal(await sql(`select count(*) from public.pdd_recipient_leads where recipient_name='${pageName}' and recipient_matched_at is not null;`), '20');
  const notYetShown = pageRegistrations.filter(registration => !firstNamePage.leads.some(lead => lead.contact.value === registration.contact.value));
  assert.equal(notYetShown.length, 2);
  for (const registration of notYetShown) assert.equal(await sql(`select recipient_matched_at is null from public.pdd_recipient_leads where registration_code='${registration.registrationCode}';`), 't', 'Pagination probes or unseen rows must not be counted.');
  await rpc('pdd_recipient_manage_update', { registration_code: notYetShown[0].registrationCode, capability_hash: capA, revision: notYetShown[0].revision, action: 'withdraw' });
  assert.deepEqual(await rpc('pdd_home_stats', {}), afterFirstPage);
  const pagePayload = { query_id: pageInput.query_id, cursor: firstNamePage.nextCursor, capability_hash: capB };
  const secondPages = await Promise.all(Array.from({ length: 8 }, () => rpc('pdd_recipient_query_page', pagePayload)));
  const secondNamePage = secondPages[0];
  assert(secondPages.every(page => JSON.stringify(page) === JSON.stringify(secondNamePage)));
  assert.equal(secondNamePage.leads.length, 1); assert.equal(secondNamePage.nextCursor, null);
  assert.equal(secondNamePage.leads[0].contact.value, notYetShown[1].contact.value);
  const afterSecondPage = { ...afterFirstPage, matchedRecipientLeads: afterFirstPage.matchedRecipientLeads + 1 };
  assert.deepEqual(await rpc('pdd_home_stats', {}), afterSecondPage);
  assert.equal(await sql(`select recipient_matched_at is null from public.pdd_recipient_leads where registration_code='${notYetShown[0].registrationCode}';`), 't', 'A row withdrawn before its page was returned is never a successful name hit.');
  await assert.rejects(() => rpc('pdd_recipient_query_page', { ...pagePayload, capability_hash: capA }), /FORBIDDEN/);
  const unrelatedPageQuery = await rpc('pdd_recipient_query', recipientQuery('José 示例'));
  await assert.rejects(() => rpc('pdd_recipient_query_page', { ...pagePayload, query_id: unrelatedPageQuery.queryId }), /INVALID_CURSOR|INVALID_REQUEST|FORBIDDEN/);
  await rpc('pdd_recipient_manage_update', { registration_code: notYetShown[1].registrationCode, capability_hash: capA, revision: notYetShown[1].revision, action: 'withdraw' });
  assert.equal((await rpc('pdd_recipient_query_page', pagePayload)).leads.length, 0, 'An opaque page replay must not disclose a withdrawn contact snapshot.');
  // The unrelated query may match a row already seen; compare to its live baseline.
  const afterPageWithdraw = await rpc('pdd_home_stats', {});
  await rpc('pdd_recipient_query_page', pagePayload);
  assert.deepEqual(await rpc('pdd_home_stats', {}), afterPageWithdraw);
  assert.deepEqual(parcelStats(await rpc('pdd_home_stats', {})), parcelStats(beforeNameOnly));
  const recipientAudits = await sql('select coalesce(jsonb_agg(to_jsonb(a)),\'[]\')::text from public.pdd_recipient_audit_events a;');
  assert(!recipientAudits.includes('fictional_')); assert(!recipientAudits.includes('Synthetic name note'));
  for (const table of ['pdd_recipient_leads', 'pdd_recipient_query_events', 'pdd_recipient_audit_events']) {
    await assert.rejects(() => sql(`set role anon; select * from public.${table};`), /permission denied/);
    await assert.rejects(() => sql(`set role authenticated; select * from public.${table};`), /permission denied/);
  }
  await assert.rejects(() => sql("set role authenticated; select public.pdd_recipient_query('{}');"), /permission denied/);

  const retentionName = (await rpc('pdd_recipient_batch_register', recipientBatch('清理屏障收件人'))).items[0].registration;
  const closedRetentionName = await rpc('pdd_recipient_admin_action', { registration_code: retentionName.registrationCode, actor_id: actor, revision: retentionName.revision, action: 'close' });
  const closedNameRegistration = closedRetentionName.registration ?? closedRetentionName;
  await sql(`update public.pdd_recipient_leads set closed_at=now()-interval '31 days' where registration_code='${retentionName.registrationCode}';`);
  const nameLockHolder = transactionSession();
  let nameWaiter;
  try {
    nameLockHolder.send("begin; select pg_advisory_xact_lock(hashtextextended('pdd-recipient-registry',0));\n\\echo PDD_NAME_LOCK_HELD");
    await nameLockHolder.marker('PDD_NAME_LOCK_HELD');
    const waiterName = `pdd-name-retention-waiter-${randomUUID()}`;
    nameWaiter = sql(invoke('pdd_recipient_manage_update', { registration_code: retentionName.registrationCode, capability_hash: capA,
      revision: closedNameRegistration.revision, action: 'update', recipient_name: '不可复活的收件人' }), 'postgres', { PGAPPNAME: waiterName })
      .then(output => ({ succeeded: true, output }), error => ({ succeeded: false, error }));
    const deadline = Date.now() + 10_000;
    while (await sql(`select count(*) from pg_stat_activity where application_name='${waiterName}' and wait_event_type='Lock' and wait_event='advisory';`) !== '1') {
      assert(Date.now() < deadline, 'Recipient management did not reach the cleanup advisory-lock barrier.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    nameLockHolder.send(`${invoke('pdd_cleanup', {})}\n\\echo PDD_NAME_CAP_REVOKED`);
    await nameLockHolder.marker('PDD_NAME_CAP_REVOKED');
    nameLockHolder.send('commit;\n\\echo PDD_NAME_CLEANUP_COMMITTED');
    await nameLockHolder.marker('PDD_NAME_CLEANUP_COMMITTED');
    const mutation = await nameWaiter;
    assert.equal(mutation.succeeded, false); assert.match(String(mutation.error), /FORBIDDEN/);
    const cleaned = JSON.parse(await sql(`select jsonb_build_object('recipientName',recipient_name,'nameKey',recipient_name_key,'contact',contact,'note',note,'capabilityHash',capability_hash,'revision',revision)::text from public.pdd_recipient_leads where registration_code='${retentionName.registrationCode}';`));
    assert.deepEqual(cleaned, { recipientName: null, nameKey: null, contact: null, note: null, capabilityHash: '', revision: closedNameRegistration.revision + 1 });
  } finally { await nameLockHolder.close(); if (nameWaiter) await nameWaiter; }
  assert.deepEqual(parcelStats(await rpc('pdd_home_stats', {})), parcelStats(beforeNameOnly));
  await verifyRecipientTelemetry();
  console.log('Recipient real PostgreSQL checks passed: NFC/multilingual exact lookup, both sources, post-hit registration, independent counts, duplicate ownership, rename/withdraw races, live opaque pagination, cleanup revocation barrier and old duplicate tombstones preventing recreation.');
  console.log('Recipient telemetry real PostgreSQL checks passed: all 14 fixed events accepted under the unchanged synthetic cap; private metadata, scanner/source flags and unknown events rejected atomically.');
  await verifyPublicInsightsContent(actor);
  assert(hourlyUpgradeChecked);
  await verifyHourlyInsights({sql,rpc,quote,invoke,businessError,actor});
  await verifyHourlyWorker({sql,rpc,quote,invoke});

  const dumped = path.join(root, 'database.dump'), sealed = path.join(root, 'database.cmibak'), reopened = path.join(root, 'restored.dump');
  const beforeRestoreStats = await rpc('pdd_home_stats', {});
  await run(path.join(bin, 'pg_dump'), ['--format=custom', '--no-owner', '--schema=public', '--schema=auth', '--file', dumped, '--dbname', 'postgres'], { env });
  const password = randomBytes(32).toString('base64url');
  await encryptFile(dumped, sealed, password); await decryptFile(sealed, reopened, password);
  await sql('create database pdd404_restore_check;');
  await bootstrap('pdd404_restore_check');
  await run(path.join(bin, 'pg_restore'), ['--no-owner', '--exit-on-error', '--clean', '--if-exists', '--dbname', 'pdd404_restore_check', reopened], { env, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(await sql('select count(*) from public.pdd_handovers;', 'pdd404_restore_check'), '1');
  assert.equal((await rpc('pdd_public', { public_code: code }, 'pdd404_restore_check')).resolution, 'resolved');
  assert.deepEqual(await rpc('pdd_home_stats', {}, 'pdd404_restore_check'), await rpc('pdd_home_stats', {}));
  assert.equal(await sql(recipientMarkerColumnsSQL, 'pdd404_restore_check'), await sql(recipientMarkerColumnsSQL));
  for (const table of ['pdd_waybills', 'pdd_registrations', 'pdd_feedback', 'pdd_recipient_leads', 'pdd_recipient_query_events', 'pdd_recipient_audit_events', 'pdd_write_requests', 'pdd_stats_daily', 'pdd_content_revisions']) {
    const order = table === 'pdd_write_requests' ? 'r.scope,r.key' : table === 'pdd_stats_daily' ? 'r.day' : 'r.id';
    const statement = `select coalesce(jsonb_agg(to_jsonb(r) order by ${order}),'[]'::jsonb)::text from public.${table} r;`;
    assert.deepEqual(JSON.parse(await sql(statement, 'pdd404_restore_check')), JSON.parse(await sql(statement)));
  }
  await assert.rejects(() => sql("set role anon; select * from public.pdd_registrations;", 'pdd404_restore_check'), /permission denied/);
  await assert.rejects(() => sql('set role authenticated; select * from public.pdd_feedback;', 'pdd404_restore_check'), /permission denied/);
  const restoredNames = await rpc('pdd_recipient_query', recipientRestoreQuery, 'pdd404_restore_check');
  assert.deepEqual(restoredNames.leads, (await rpc('pdd_recipient_query', recipientRestoreQuery)).leads);
  assert.deepEqual(await rpc('pdd_home_stats', {}, 'pdd404_restore_check'), beforeRestoreStats);
  assert.deepEqual(parcelStats(await rpc('pdd_home_stats', {}, 'pdd404_restore_check')), parcelStats(beforeNameOnly));
  await assert.rejects(() => sql('set role anon; select * from public.pdd_recipient_leads;', 'pdd404_restore_check'), /permission denied/);
  await assert.rejects(() => sql("set role authenticated; select public.pdd_recipient_query('{}');", 'pdd404_restore_check'), /permission denied/);
  await businessError(() => rpc('pdd_recipient_batch_register', duplicateTombstoneInput, 'pdd404_restore_check'), 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(await recipientRequestRow(duplicateTombstoneInput, 'pdd404_restore_check'), duplicateTombstone);
  await businessError(() => rpc('pdd_query_contact', { query_id: completePossible.queryId, capability_hash: capB, contact: { kind: 'wechat', value: 'fictional_fuzzy_owner' }, idempotency_key: 'restored-possible-error', body_hash: 'restored-possible-error' }, 'pdd404_restore_check'), 'VERSION_CONFLICT');
  await businessError(() => rpc('pdd_feedback_submit', { ...feedbackInput, body_hash: 'restored-changed-feedback' }, 'pdd404_restore_check'), 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(await rpc('pdd_telemetry_summary', { days: 30 }, 'pdd404_restore_check'), telemetrySummary);
  await verifyRecipientTelemetry('pdd404_restore_check');
  assert.equal(await sql(`select public.pdd_contact_valid(${quote({ kind: 'wechat', value: '_PDD404TEST_2026' })});`, 'pdd404_restore_check'), 't');
  assert.equal(await sql("select string_agg(key,',' order by key) from jsonb_object_keys(public.pdd_monitor_status('{}')) key;", 'pdd404_restore_check'), monitorColumns);
  assert.equal(JSON.parse(await sql(monitorMetadataSQL, 'pdd404_restore_check')).definition, monitorDefinition);
  assertClusterSize(JSON.parse(await sql(`begin read only; set local role service_role; ${monitorSizeSQL} commit;`, 'pdd404_restore_check')));
  await assert.rejects(() => sql("set role anon; select public.pdd_telemetry_summary('{}');", 'pdd404_restore_check'), /permission denied/);
  await assert.rejects(() => sql("set role anon; select public.pdd_monitor_status('{}');", 'pdd404_restore_check'), /permission denied/);
  await assert.rejects(() => sql("set role authenticated; select public.pdd_monitor_status('{}');", 'pdd404_restore_check'), /permission denied/);
  console.log('Telemetry aggregates/budget and private monitor RPC survived encrypted independent restore, with size matching the restored cluster total and public privileges still denied.');
  await assert.rejects(() => rpc('pdd_query', { ...historicalQuery, query_id: randomUUID() }, 'pdd404_restore_check'), /NON_DOMESTIC_WAYBILL/);
  await assert.rejects(() => rpc('pdd_batch_register', batch(forwardingNumber, 'lost', capA, 'fictional_restored_forwarding'), 'pdd404_restore_check'), /NON_DOMESTIC_WAYBILL/);
  console.log('Encrypted dump/decrypt and independent database restore passed, including lifetime stats, notes and feedback; restored RLS remains closed.');
  const migrations = await migrationManifest(), scopedTables = [];
  for (const table of tablesForMigrations(migrations)) {
    const rows = JSON.parse(await sql(`select coalesce(jsonb_agg(to_jsonb(r)),'[]')::text from public.${table.name} r;`));
    scopedTables.push({ name: table.name, rows, rowCount: rows.length, sha256: rowsHash(rows) });
  }
  const publicImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLj8AAAAASUVORK5CYII=', 'base64'), imageSha = sha256(publicImage);
  const scoped = { format: FORMAT, project: 'abcdefghijklmnopqrst', migrations, tables: scopedTables,
    storage: [{ bucket: 'pdd-public-assets', key: imageSha + '.png', mime: 'image/png', size: publicImage.length, sha256: imageSha, base64: publicImage.toString('base64') }] };
  const scopedFile = path.join(root, 'public-content-scoped.cmibak');
  await writeEncryptedChunks(scopedFile, password, [JSON.stringify(scoped)]);
  const restoredScoped = await verifyScopedRestore(scopedFile, password);
  assert.equal(restoredScoped.tables, tablesForMigrations(migrations).length); assert.equal(restoredScoped.storageObjects, 1); assert(restoredScoped.auditActorPlaceholders >= 1);
  console.log(`Actual PostgreSQL encrypted scoped restore passed all ${restoredScoped.tables} table values/constraints/privileges, including hourly aggregates and private facts; dedicated public asset bytes/identity and bucket configuration verified offline.`);
} finally {
  if (running) await run(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { env }).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
