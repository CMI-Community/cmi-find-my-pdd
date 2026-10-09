// This helper receives only the disposable PostgreSQL verifier's local client.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const MODEL='gpt-5.6-luna',PROMPT='hourly-observation-v1',SECRET='a'.repeat(64),KEY='sk-synthetic_private_local_only_123456789';
export async function verifyHourlyWorker({sql,rpc,invoke,quote}) {
 await sql(`create schema vault;create table vault.decrypted_secrets(id uuid primary key default gen_random_uuid(),name text unique,decrypted_secret text);
 create function vault.create_secret(secret text,name text,description text) returns uuid language sql as $$insert into vault.decrypted_secrets(name,decrypted_secret) values(name,secret) returning id$$;
 create function vault.update_secret(secret_id uuid,secret text,name text,description text) returns void language sql as $$update vault.decrypted_secrets set decrypted_secret=secret,name=update_secret.name where id=secret_id$$;`);
 await sql(`create table net.test_calls(id bigint generated always as identity primary key,url text,headers jsonb,body jsonb,timeout_ms integer);
 create or replace function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$declare result bigint;begin insert into net.test_calls(url,headers,body,timeout_ms) values(url,headers,body,timeout_milliseconds) returning id into result;return result;end$$;`);
 const config={url:'https://fogncjjsnakbhfdbfvdi.supabase.co/functions/v1/insights-worker',model_key:KEY,worker_secret:SECRET,model:MODEL,prompt_version:PROMPT,actor_id:null,enabled:true};
 assert.equal((await rpc('pdd_insights_configure_worker',config)).configured,true);
 const runtime=await rpc('pdd_insights_runtime',{worker_secret:SECRET});assert.equal(runtime.modelKey,KEY);assert.equal(runtime.workerSecret,undefined);assert.equal(runtime.reservationUsd,.01);
 await assert.rejects(()=>rpc('pdd_insights_runtime',{worker_secret:'b'.repeat(64)}),/FORBIDDEN/);
 await assert.rejects(()=>rpc('pdd_insights_configure_worker',{...config,url:'https://example.com/functions/v1/insights-worker'}),/INVALID_REQUEST/);
 const ledgerKey=await sql("select decrypted_secret from vault.decrypted_secrets where name='pdd_insights_ledger_key';");
 await rpc('pdd_insights_configure_worker',config);assert.equal(await sql("select decrypted_secret from vault.decrypted_secrets where name='pdd_insights_ledger_key';"),ledgerKey);
 assert.equal((await rpc('pdd_insights_wake',{})).awakened,true);
 assert.equal(await sql("select bool_and(timeout_ms=90000 and headers?'x-insights-secret' and not(headers?'x-worker-secret') and body='{}'::jsonb) from net.test_calls;"),'t');
 const source=await rpc('pdd_hourly_source',{}),slot=source.observedUntil;
 const reserve={input:{observedUntil:slot,timezone:'Asia/Bangkok',selectionLimit:3,candidates:[],recentObservations:[]},candidates:[],model:MODEL,prompt_version:PROMPT};
 const attempts=await Promise.all(Array.from({length:12},()=>rpc('pdd_insights_reserve',reserve)));
 assert.equal(attempts.filter(r=>r.reserved).length,1);assert.equal(new Set(attempts.map(r=>r.runId)).size,1);
 const run=attempts[0],empty={observations:[]};
 assert.deepEqual(await rpc('pdd_insights_finish',{run_id:run.runId,state:'unknown',selection:empty,usage:{inputTokens:100,outputTokens:10,costUsd:.000032}}),{state:'unknown',publishedCount:0});
 assert.equal((await rpc('pdd_insights_reserve',reserve)).reserved,false);
 assert.deepEqual(JSON.parse(await sql(`select jsonb_build_object('reserved',reserved_usd,'cost',cost_usd,'costState',cost_state,'state',state,'selection',selection)::text from public.pdd_insights_runs where id='${run.runId}';`)),{reserved:.01,cost:null,costState:'unknown',state:'unknown',selection:null});
 await assert.rejects(()=>sql(`update public.pdd_insights_runs set state='completed' where id='${run.runId}';`),/IMMUTABLE_HISTORY/);
 await assert.rejects(()=>sql(`begin;delete from vault.decrypted_secrets where name='pdd_insights_ledger_key';${invoke('pdd_insights_configure_worker',config)}commit;`),/CONFIGURATION_INVALID/);
 assert.equal(await sql("select decrypted_secret from vault.decrypted_secrets where name='pdd_insights_ledger_key';"),ledgerKey);
 const base=Date.parse(slot);
 const candidate=(id,topic,hour,key)=>({id,kind:'outcome',topic,score:1,priority:0,windowStart:new Date(hour-3600000).toISOString(),windowEnd:new Date(hour).toISOString(),dedupKey:id+'-dedup',headlines:[{id:'label',text:'单号匹配'}],facts:[{id:'primary',text:'合成验证：该时段新增 1 条匹配记录。'},{id:'support',text:'匹配记录与实际交还是分别记录的。'}],stableFactKeys:[key],windowId:'h1',source:'server-hourly-v1',definitionVersion:'home-six-lifetime-v1',value:1,direction:'up'});
 async function seed(candidates,hours) {
  const id=randomUUID(),hour=new Date(base-hours*3600000).toISOString(),input={observedUntil:hour,timezone:'Asia/Bangkok',selectionLimit:3,candidates:JSON.parse(await sql(`select public.pdd_insights_model_candidates(${quote(candidates)})::text;`)),recentObservations:[],runId:id};
  await sql(`insert into public.pdd_insights_runs(id,slot,day,reserved_at,observed_until,model,prompt_version,input,candidates,reserved_usd) values('${id}','${hour}',(clock_timestamp() at time zone 'Asia/Bangkok')::date,clock_timestamp(),'${hour}','${MODEL}','${PROMPT}',${quote(input)},${quote(candidates)},0.01);`);
  return id;
 }
 const usage={inputTokens:100,outputTokens:10,costUsd:.000032};
 const c1=candidate('verified-one','parcel-match',base-3600000,'d'.repeat(64)),c2=candidate('verified-two','recipient-match',base-3600000,'e'.repeat(64));
 const acceptedId=await seed([c1,c2],1),choice=c=>({candidateId:c.id,headlineId:'label',factIds:['primary','support']});
 assert.deepEqual(await rpc('pdd_insights_finish',{run_id:acceptedId,state:'completed',selection:{observations:[choice(c1),choice(c2)]},usage}),{state:'completed',publishedCount:2});
 assert.equal(await sql(`select count(distinct published_at) from public.pdd_insights_feed where run_id='${acceptedId}';`),'1');
 assert.equal(await sql(`select body from public.pdd_insights_feed where run_id='${acceptedId}' limit 1;`),c1.facts.map(f=>f.text).join(''));
 const metadata=(await rpc('pdd_hourly_source',{})).recentObservations;assert.equal(metadata.length,2);assert.equal(metadata[0].source,'server-hourly-v1');assert.equal(metadata[0].value,1);
 const release={release_key:'6'.repeat(64),accepted_at:new Date(Date.now()-1000).toISOString(),fact_text:'合成验收：小时观察功能已经完成生产核对。',frontend_sha:'a'.repeat(40),api_sha:'b'.repeat(40),database_versions:['20261009040000','20261009050000'],actor_id:null};
 assert.equal((await rpc('pdd_insights_accept_release',release)).releaseKey,release.release_key);
 assert.equal(await sql("select actor_id is null from public.pdd_insights_releases where release_key='"+release.release_key+"';"),'t');
 assert.equal(await sql("select actor_id is null from public.pdd_insights_audit where action='insights_release_accepted';"),'t');
 await assert.rejects(()=>rpc('pdd_insights_accept_release',release),/VERSION_CONFLICT/);
 const beforeCounts=await sql("select jsonb_build_object('feed',(select count(*) from public.pdd_insights_feed),'ledger',(select count(*) from public.pdd_insights_fact_ledger))::text;");
 const invalidFirst=candidate('invalid-first','invalid-one',base-7200000,'9'.repeat(64)),invalidSecond=candidate('invalid-second','invalid-two',base-7200000,'8'.repeat(64));
 const rejectedId=await seed([invalidFirst,invalidSecond],2);
 assert.deepEqual(await rpc('pdd_insights_finish',{run_id:rejectedId,state:'completed',selection:{observations:[choice(invalidFirst),{...choice(invalidSecond),factIds:['unknown']}]},usage}),{state:'rejected',publishedCount:0});
 assert.equal(await sql("select jsonb_build_object('feed',(select count(*) from public.pdd_insights_feed),'ledger',(select count(*) from public.pdd_insights_fact_ledger))::text;"),beforeCounts);
 assert.equal(await sql(`select selection is null from public.pdd_insights_runs where id='${rejectedId}';`),'t');
 // A valid first card must also roll back when a later card selects only support or reverses facts.
 for(const [index,factIds] of [['support-only',['support']],['reversed-order',['support','primary']]].entries()) {
  const [mode,ids]=factIds,offset=5+index,cA=candidate(mode+'-first',mode+'-first',base-offset*3600000,(index?'4':'3').repeat(64)),cB=candidate(mode+'-second',mode+'-second',base-offset*3600000,(index?'2':'1').repeat(64));
  const id=await seed([cA,cB],offset);
  assert.deepEqual(await rpc('pdd_insights_finish',{run_id:id,state:'completed',selection:{observations:[choice(cA),{...choice(cB),factIds:ids}]},usage}),{state:'rejected',publishedCount:0});
  assert.equal(await sql("select jsonb_build_object('feed',(select count(*) from public.pdd_insights_feed),'ledger',(select count(*) from public.pdd_insights_fact_ledger))::text;"),beforeCounts);
 }
 // Hold a genuine configuration UPDATE uncommitted: finish must wait, then observe disabled.
 const stopped=candidate('stopped-run','stopped-run',base-7*3600000,'0'.repeat(64)),stoppedId=await seed([stopped],7),marker=52414022;
 const stopping=sql(`begin;${invoke('pdd_insights_configure_worker',{...config,enabled:false})}select pg_advisory_xact_lock(${marker});select pg_sleep(0.8);commit;`);
 let marked=false;
 for(let attempt=0;attempt<60;attempt++){if(await sql(`select exists(select 1 from pg_locks where locktype='advisory' and classid=0 and objid=${marker} and granted);`)==='t'){marked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
 assert(marked,'Local configuration transaction must hold its explicit readiness marker');
 const stoppedResult=await rpc('pdd_insights_finish',{run_id:stoppedId,state:'completed',selection:{observations:[choice(stopped)]},usage});await stopping;
 assert.deepEqual(stoppedResult,{state:'rejected',publishedCount:0});assert.equal(await sql(`select count(*) from public.pdd_insights_feed where run_id='${stoppedId}';`),'0');
 await rpc('pdd_insights_configure_worker',config);
 const sharedKey='7'.repeat(64),raceA=candidate('race-one','race-one',base-10800000,sharedKey),raceB=candidate('race-two','race-two',base-14400000,sharedKey);
 const raceIds=[await seed([raceA],3),await seed([raceB],4)];
 const finishes=await Promise.all(raceIds.map((id,i)=>rpc('pdd_insights_finish',{run_id:id,state:'completed',selection:{observations:[choice(i===0?raceA:raceB)]},usage})));
 assert.equal(finishes.filter(r=>r.state==='completed').length,1);assert.equal(finishes.filter(r=>r.state==='rejected').length,1);assert.equal(await sql(`select count(*) from public.pdd_insights_fact_ledger where fact_key='${sharedKey}';`),'1');
 const limit=JSON.parse(await sql(`begin;truncate public.pdd_insights_runs,public.pdd_insights_feed,public.pdd_insights_fact_ledger,public.pdd_insights_audit cascade;
 insert into public.pdd_insights_runs(slot,day,reserved_at,observed_until,model,prompt_version,input,candidates,reserved_usd,state,cost_state,finished_at) select date_trunc('hour',now())-make_interval(hours=>g),(now() at time zone 'Asia/Bangkok')::date,now(),date_trunc('hour',now())-make_interval(hours=>g),'${MODEL}','${PROMPT}','{}','[]',0.01,'unknown','unknown',now() from generate_series(1,24) g;
 ${invoke('pdd_insights_reserve',reserve)} rollback;`));
 assert.equal(limit.reserved,false);assert.equal(limit.state,'limited');
 const publicFeed=JSON.stringify(await rpc('pdd_public_hourly_dashboard',{}));for(const privateValue of [KEY,SECRET,ledgerKey,sharedKey,'dedupKey','promptVersion','modelKey'])assert(!publicFeed.includes(privateValue));
 const audits=await sql('select coalesce(jsonb_agg(payload),\'[]\')::text from public.pdd_insights_audit;');assert(!audits.includes(KEY));assert(!audits.includes(SECRET));assert(!audits.includes(ledgerKey));assert(!audits.includes(c1.facts[0].text));
 for(const role of ['anon','authenticated'])for(const name of ['pdd_insights_runtime','pdd_insights_reserve','pdd_insights_finish','pdd_insights_configure_worker','pdd_insights_wake'])await assert.rejects(()=>sql(`set role ${role};${invoke(name,{})}`),/permission denied/);
 for(const table of ['pdd_insights_runs','pdd_insights_audit'])assert.equal(await sql(`select not has_table_privilege('service_role','public.${table}','INSERT,UPDATE,DELETE');`),'t');
 console.log('Hourly observer real PostgreSQL passed: fixed service-authenticated runtime/Vault configuration, HMAC key preservation/loss failclosed, 12-session single-slot reservation, unknown cost held, deterministic whole-batch publication at one timestamp, invalid/support-only/reversed batch rollback, serialized concurrent disable, concurrent stable-fact deduplication, independent 24-call/0.24 daily ceiling, and closed public/audit projection.');
}
