import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
const directory = new URL('../supabase/migrations/', import.meta.url);
let db: PGlite;
beforeAll(async () => {
 db = new PGlite({ extensions: { pgcrypto } });
 await db.exec(`create schema extensions; create role anon; create role authenticated; create role service_role bypassrls;
 create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create schema net; create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as 'select 1::bigint';
 create schema cron; create table cron.test_jobs(name text,schedule text,command text);
 create function cron.schedule(job_name text,schedule text,command text) returns bigint language plpgsql as 'begin insert into cron.test_jobs values(job_name,schedule,command); return 1; end';`);
 for(const name of (await readdir(directory)).filter(name=>/^\d+_.+\.sql$/.test(name)).sort()) await db.exec((await readFile(new URL(name,directory),'utf8')).replace(/^create extension if not exists pg_net.*$/m,'').replace(/^create extension if not exists pg_cron.*$/m,''));
},30000);
beforeEach(async()=>{await db.exec('begin;');});afterEach(async()=>{await db.exec('rollback; reset role;');});afterAll(async()=>{await db?.close();});
async function rpc<T=Record<string,any>>(name:string,payload:Record<string,unknown>={}):Promise<T>{return(await db.query<{value:T}>(`select public.${name}($1::jsonb) value`,[JSON.stringify(payload)])).rows[0].value;}
async function rejects(name:string,payload:Record<string,unknown>,error:string){await db.exec('savepoint denial;');try{await expect(rpc(name,payload)).rejects.toThrow(error);}finally{await db.exec('rollback to savepoint denial;');}}
describe('hourly public snapshot and atomic telemetry',()=>{
 it('captures actual server time once, never fills missing slots or changes daily job',async()=>{
  const first=await rpc('pdd_capture_stats_hourly'); expect(first.metricVersion).toBe('home-six-lifetime-v1'); expect(Date.parse(first.sampledAt)).toBeGreaterThanOrEqual(Date.parse(first.hour));
  expect(await rpc('pdd_capture_stats_hourly')).toEqual(first);
  expect((await rpc('pdd_public_hourly_history',{hours:48})).snapshots).toEqual([first]);
  expect((await rpc('pdd_public_hourly_dashboard')).stats).toEqual(await rpc('pdd_home_stats'));
  expect((await rpc('pdd_public_hourly_feed')).observations).toEqual([]);
  const jobs=(await db.query<Record<string,any>>('select name,schedule,command from cron.test_jobs order by name')).rows;
  expect(jobs).toContainEqual({name:'pdd404-evening-public-stats',schedule:'0 13 * * *',command:"select public.pdd_capture_stats_daily('{}'::jsonb)"});
  expect(jobs).toContainEqual({name:'pdd404-hourly-public-stats',schedule:'0 * * * *',command:"select public.pdd_capture_stats_hourly('{}'::jsonb)"});
  await rejects('pdd_capture_stats_hourly',{hour:'2020-01-01T00:00:00Z'},'INVALID_REQUEST');
 });
 it('stores daily and hourly events using the same atomic accepted batch and rejects partial excess',async()=>{
  const input={events:[{event:'pdd_page_view',page:'insights',count:2},{event:'pdd_scanner_not_found',page:'home',scanMode:'photo',count:3}],daily_limit:5};
  expect((await rpc('pdd_telemetry_ingest',input)).recorded).toBe(5);
  expect((await db.query<Record<string,any>>('select sum(event_count)::int n from public.pdd_telemetry_daily')).rows[0].n).toBe(5);
  expect((await db.query<Record<string,any>>('select sum(event_count)::int n from public.pdd_telemetry_hourly')).rows[0].n).toBe(5);
  expect((await rpc('pdd_telemetry_ingest',{events:[{event:'pdd_page_view',page:'share',count:1}],daily_limit:5})).accepted).toBe(false);
  expect((await db.query<Record<string,any>>('select sum(event_count)::int n from public.pdd_telemetry_hourly')).rows[0].n).toBe(5);
  await rejects('pdd_telemetry_ingest',{events:[{event:'pdd_page_view',page:'admin',count:1}],daily_limit:20},'INVALID_REQUEST');
 });
 it('rejects unbounded history dates, repeated slots and private table writes',async()=>{
  for(const args of [{hours:721},{hours:0},{hours:1,date:'2020-01-01'},{date:'2020-01-01'},{date:'2099-01-01'},{includePrivate:true}])await rejects('pdd_public_hourly_history',args,'INVALID_REQUEST');
  await db.exec('set local role service_role;');
  expect((await rpc('pdd_public_hourly_history')).snapshots).toEqual([]);
  await db.exec('savepoint denial;');await expect(db.exec("insert into public.pdd_stats_hourly values(now(),now(),'home-six-lifetime-v1','{}')")).rejects.toThrow('permission denied');await db.exec('rollback to savepoint denial; reset role;');
  for(const role of ['anon','authenticated']){await db.exec('set local role '+role+';savepoint denial;');await expect(rpc('pdd_public_hourly_dashboard')).rejects.toThrow('permission denied');await db.exec('rollback to savepoint denial;reset role;');}
 });
 it('serves only bounded aggregates and keyed outcome identities to the private worker',async()=>{
  const source=await rpc('pdd_hourly_source'); expect(source.businessHours).toHaveLength(192);expect(source.snapshots).toEqual([]);expect(source.outcomesAvailable).toBe(false);expect(source.outcomes).toEqual([]);
  expect(source.telemetry.truncated).toBe(false);expect(source.queries).toEqual([]);
  await rejects('pdd_hourly_source',{hours:900},'INVALID_REQUEST');
  await db.exec("create schema vault; create table vault.decrypted_secrets(name text,decrypted_secret text); insert into vault.decrypted_secrets values('pdd_insights_ledger_key','"+'d'.repeat(64)+"');");
  const key=await db.query<Record<string,any>>("select public.pdd_insights_fact_key('parcel-match','synthetic-private-row-id') value");expect(key.rows[0].value).toMatch(/^[0-9a-f]{64}$/);expect(key.rows[0].value).not.toContain('synthetic');
  expect((await rpc('pdd_hourly_source')).outcomesAvailable).toBe(true);
  for(const role of ['anon','authenticated']){await db.exec('set local role '+role+';savepoint denial;');await expect(rpc('pdd_hourly_source')).rejects.toThrow('permission denied');await db.exec('rollback to savepoint denial;reset role;');}
 });
 it('rolls back both aggregates if the second write fails',async()=>{
  await db.exec("create function public.synthetic_hour_failure() returns trigger language plpgsql as 'begin raise exception ''synthetic hourly failure''; end'; create trigger synthetic_fail before insert on public.pdd_telemetry_hourly for each row execute function public.synthetic_hour_failure();");
  await rejects('pdd_telemetry_ingest',{events:[{event:'pdd_page_view',page:'home',count:2}],daily_limit:20},'synthetic hourly failure');
  expect((await db.query<Record<string,any>>('select count(*)::int n from public.pdd_telemetry_daily')).rows[0].n).toBe(0);
  expect((await db.query<Record<string,any>>('select count(*)::int n from public.pdd_telemetry_budget')).rows[0].n).toBe(0);
 });
});

const workerSecret='a'.repeat(64),modelKey='sk-synthetic_key_for_local_tests_only_123456789';
async function configureVault(enabled=true) {
 await db.exec(`create schema vault;create table vault.decrypted_secrets(id uuid primary key default gen_random_uuid(),name text unique,decrypted_secret text);
 create function vault.create_secret(secret text,name text,description text) returns uuid language sql as 'insert into vault.decrypted_secrets(name,decrypted_secret) values(name,secret) returning id';
 create function vault.update_secret(secret_id uuid,secret text,name text,description text) returns void language sql as 'update vault.decrypted_secrets set decrypted_secret=secret,name=update_secret.name where id=secret_id';`);
 return rpc('pdd_insights_configure_worker',{url:'https://fogncjjsnakbhfdbfvdi.supabase.co/functions/v1/insights-worker',model_key:modelKey,worker_secret:workerSecret,model:'gpt-5.6-luna',prompt_version:'hourly-observation-v1',actor_id:null,enabled});
}
async function reserve(candidates:Record<string,any>[]=[]) {
 const observedUntil=(await rpc('pdd_hourly_source')).observedUntil;
 const projected=(await db.query<{value:unknown}>('select public.pdd_insights_model_candidates($1::jsonb) value',[JSON.stringify(candidates)])).rows[0].value;
 return rpc('pdd_insights_reserve',{input:{observedUntil,timezone:'Asia/Bangkok',selectionLimit:3,candidates:projected,recentObservations:[]},candidates,model:'gpt-5.6-luna',prompt_version:'hourly-observation-v1'});
}
async function candidate(id='candidate-one',topic='registrations') {
 const end=(await rpc('pdd_hourly_source')).observedUntil;
 return {id,kind:'outcome',topic,score:1,priority:1,windowStart:new Date(Date.parse(end)-3600000).toISOString(),windowEnd:end,dedupKey:id+'-dedup',headlines:[{id:'label',text:'单号匹配'}],facts:[{id:'fact-one',text:'过去一小时新增 1 条匹配记录。'},{id:'fact-two',text:'匹配仍需核实包裹信息。'}],stableFactKeys:[id==='candidate-one'?'f'.repeat(64):'e'.repeat(64)],windowId:'h1',source:'same-six-snapshot',definitionVersion:'home-six-lifetime-v1',value:1,direction:'up'};
}
const usage={inputTokens:100,outputTokens:10,costUsd:0.000032};
describe('private hourly observer reservation and deterministic finish',()=>{
 it('authenticates runtime, only accepts dedicated configuration, and preserves stable key across updates',async()=>{
  await configureVault();const config=await rpc('pdd_insights_runtime',{worker_secret:workerSecret});expect(config).toMatchObject({enabled:true,model:'gpt-5.6-luna',dailyCallLimit:24,reservationUsd:0.01});expect(config.modelKey).toBe(modelKey);expect(config.workerSecret).toBeUndefined();
  await rejects('pdd_insights_runtime',{worker_secret:'b'.repeat(64)},'FORBIDDEN');
  const ledger=(await db.query<Record<string,any>>("select decrypted_secret from vault.decrypted_secrets where name='pdd_insights_ledger_key'")).rows[0].decrypted_secret;
  const payload={url:'https://fogncjjsnakbhfdbfvdi.supabase.co/functions/v1/insights-worker',model_key:modelKey,worker_secret:workerSecret,model:'gpt-5.6-luna',prompt_version:'hourly-observation-v1',actor_id:null,enabled:true};
  await rejects('pdd_insights_configure_worker',{...payload,url:'https://example.com/functions/v1/insights-worker'},'INVALID_REQUEST');
  for(const field of ['url','model','prompt_version'])await rejects('pdd_insights_configure_worker',{...payload,[field]:null},'INVALID_REQUEST');
  await rpc('pdd_insights_configure_worker',payload);expect((await db.query<Record<string,any>>("select decrypted_secret from vault.decrypted_secrets where name='pdd_insights_ledger_key'")).rows[0].decrypted_secret).toBe(ledger);
  await reserve();await db.exec("delete from vault.decrypted_secrets where name='pdd_insights_ledger_key'");await rejects('pdd_insights_configure_worker',payload,'CONFIGURATION_INVALID');
  const audits=(await db.query<Record<string,any>>('select payload from public.pdd_insights_audit')).rows;expect(audits.length).toBeGreaterThanOrEqual(3);expect(JSON.stringify(audits)).not.toContain(modelKey);expect(JSON.stringify(audits)).not.toContain(workerSecret);expect(JSON.stringify(audits)).not.toContain(ledger);
 });
 it('reserves quiet hours once and keeps unknown cost after completion or timeout',async()=>{
  expect((await reserve()).state).toBe('disabled');await configureVault();
  const first=await reserve();expect(first.reserved).toBe(true);expect(await reserve()).toMatchObject({reserved:false,runId:first.runId,state:'reserved'});
  expect(await rpc('pdd_insights_finish',{run_id:first.runId,state:'completed',selection:{observations:[]}})).toMatchObject({state:'completed',publishedCount:0});
  expect(await reserve()).toMatchObject({reserved:false,state:'completed'});
  expect(await rpc('pdd_insights_finish',{run_id:first.runId,state:'completed',selection:{observations:[]},usage})).toMatchObject({state:'completed',publishedCount:0});
  expect((await db.query<Record<string,any>>('select reserved_usd,cost_usd,cost_state,input from public.pdd_insights_runs')).rows[0]).toMatchObject({reserved_usd:'0.01000000',cost_usd:null,cost_state:'unknown',input:{runId:first.runId}});
  await db.exec('savepoint immutable;');await expect(db.exec('update public.pdd_insights_runs set state=state;')).rejects.toThrow('IMMUTABLE_HISTORY');await db.exec('rollback to savepoint immutable;');
 });
 it('publishes only stored fact IDs atomically, at one timestamp, with private metadata excluded publicly',async()=>{
  await configureVault();const candidates=[await candidate(),await candidate('candidate-two','recipient-match')];const run=await reserve(candidates);
  const result=await rpc('pdd_insights_finish',{run_id:run.runId,state:'completed',selection:{observations:candidates.map(c=>({candidateId:c.id,headlineId:'label',factIds:['fact-one','fact-two']}))},usage});expect(result).toMatchObject({state:'completed',publishedCount:2});
  const feed=await rpc('pdd_public_hourly_feed');expect(new Set(feed.observations.map((r:Record<string,any>)=>r.publishedAt)).size).toBe(1);expect(feed.observations[0].text).toBe(candidates[0].facts.map(f=>f.text).join(''));expect(JSON.stringify(feed)).not.toContain('dedup');expect(JSON.stringify(feed)).not.toContain('stableFact');expect(JSON.stringify(feed)).not.toContain('same-six');
  expect((await db.query<Record<string,any>>('select count(*)::int n from public.pdd_insights_fact_ledger')).rows[0].n).toBe(2);
  expect((await rpc('pdd_hourly_source')).recentObservations[0]).toMatchObject({windowId:'h1',source:'same-six-snapshot',definitionVersion:'home-six-lifetime-v1',value:1,direction:'up'});
 });
 it.each(['unknown-fact','unknown-headline','duplicate-topic','duplicate-candidate','duplicate-fact','extra-prose','too-many','long-text','support-only','reversed-order','disabled'])('rejects the whole batch for %s without partial public facts',async(mode)=>{
  await configureVault();const one=await candidate(),two=await candidate('candidate-two','recipient-match');
  if(mode==='duplicate-topic')two.topic=one.topic;
  if(mode==='long-text')one.facts=[{id:'fact-one',text:'字'.repeat(60)},{id:'fact-two',text:'字'.repeat(60)}];
  const run=await reserve([one,two]);const choices:Record<string,any>[]=[{candidateId:one.id,headlineId:'label',factIds:['fact-one']},{candidateId:two.id,headlineId:'label',factIds:['fact-one']}];
  if(mode==='unknown-fact')choices[1].factIds=['cross-candidate-fact'];if(mode==='unknown-headline')choices[1].headlineId='unknown';if(mode==='duplicate-candidate')choices[1].candidateId=one.id;if(mode==='duplicate-fact')choices[1].factIds=['fact-one','fact-one'];if(mode==='extra-prose')choices[1].text='not permitted';if(mode==='too-many')choices.push({...choices[0]},{...choices[1]});if(mode==='long-text')choices[0].factIds=['fact-one','fact-two'];
  if(mode==='support-only')choices[1].factIds=['fact-two'];if(mode==='reversed-order')choices[1].factIds=['fact-two','fact-one'];if(mode==='disabled')await rpc('pdd_insights_configure_worker',{url:'https://fogncjjsnakbhfdbfvdi.supabase.co/functions/v1/insights-worker',model_key:modelKey,worker_secret:workerSecret,model:'gpt-5.6-luna',prompt_version:'hourly-observation-v1',actor_id:null,enabled:false});
  expect(await rpc('pdd_insights_finish',{run_id:run.runId,state:'completed',selection:{observations:choices},usage})).toMatchObject({state:'rejected',publishedCount:0});
  expect((await rpc('pdd_public_hourly_feed')).observations).toEqual([]);expect((await db.query<Record<string,any>>('select count(*)::int n from public.pdd_insights_fact_ledger')).rows[0].n).toBe(0);expect((await db.query<Record<string,any>>('select state,cost_state from public.pdd_insights_runs')).rows[0]).toMatchObject({state:'rejected',cost_state:'known'});
 });
 it('records explicit service release acceptance without inventing an administrator and preserves all guards',async()=>{
  const release={release_key:'6'.repeat(64),accepted_at:new Date(Date.now()-1000).toISOString(),fact_text:'合成测试：小时观察页面已验收。',frontend_sha:'a'.repeat(40),api_sha:'b'.repeat(40),database_versions:['20261009040000','20261009050000'],actor_id:null};
  expect((await rpc('pdd_insights_accept_release',release)).releaseKey).toBe(release.release_key);
  expect((await db.query<Record<string,any>>('select actor_id from public.pdd_insights_releases')).rows[0].actor_id).toBeNull();
  expect((await db.query<Record<string,any>>("select actor_id,payload from public.pdd_insights_audit where action='insights_release_accepted'")).rows[0]).toMatchObject({actor_id:null,payload:{releaseKey:release.release_key}});
  await rejects('pdd_insights_accept_release',release,'VERSION_CONFLICT');await rejects('pdd_insights_accept_release',{...release,release_key:'5'.repeat(64),accepted_at:'2099-01-01T00:00:00Z'},'INVALID_REQUEST');await rejects('pdd_insights_accept_release',{...release,actor_id:'invented'},'INVALID_REQUEST');
 });
 it('retains reservations at 24 daily calls, rejects leaked input, and denies all browser and direct service writes',async()=>{
  await configureVault();await db.exec("insert into public.pdd_insights_runs(slot,day,reserved_at,observed_until,model,prompt_version,input,candidates,reserved_usd,state,cost_state,finished_at) select date_trunc('hour',now())-make_interval(hours=>g),(now() at time zone 'Asia/Bangkok')::date,now(),date_trunc('hour',now())-make_interval(hours=>g),'gpt-5.6-luna','hourly-observation-v1','{}','[]',0.01,'unknown','unknown',now() from generate_series(1,24) g");
  expect(await reserve()).toMatchObject({reserved:false,state:'limited'});expect((await db.query<Record<string,any>>('select count(*)::int n,sum(reserved_usd) reserved from public.pdd_insights_runs')).rows[0]).toMatchObject({n:24,reserved:'0.24000000'});
  const observedUntil=(await rpc('pdd_hourly_source')).observedUntil;
  await rejects('pdd_insights_reserve',{input:{observedUntil,timezone:'Asia/Bangkok',selectionLimit:3,candidates:[],recentObservations:[],contact:'private'},candidates:[],model:'gpt-5.6-luna',prompt_version:'hourly-observation-v1'},'INVALID_REQUEST');
  for(const role of ['anon','authenticated']){await db.exec('set local role '+role+';');await rejects('pdd_insights_runtime',{worker_secret:workerSecret},'permission denied');await rejects('pdd_insights_reserve',{},'permission denied');await db.exec('reset role;');}
  await db.exec('set local role service_role;savepoint no_write;');await expect(db.exec('delete from public.pdd_insights_runs')).rejects.toThrow('permission denied');await db.exec('rollback to savepoint no_write;reset role;');
 });
});
