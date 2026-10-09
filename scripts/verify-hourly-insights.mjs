// Invoked only with the disposable local PostgreSQL verifier's SQL client.
import assert from 'node:assert/strict';
export async function verifyHourlyInsights({sql,rpc,quote,invoke,businessError,actor}) {
  const stats=await rpc('pdd_home_stats',{});
  const concurrent=await Promise.all(Array.from({length:8},()=>rpc('pdd_capture_stats_hourly',{})));
  assert(concurrent.every(row=>JSON.stringify(row)===JSON.stringify(concurrent[0])));
  const captured=concurrent[0];
  assert.deepEqual(captured.stats,stats);assert.equal(captured.metricVersion,'home-six-lifetime-v1');
  assert(Date.parse(captured.sampledAt)>=Date.parse(captured.hour));
  assert(Date.parse(captured.sampledAt)<Date.parse(captured.hour)+3600000);
  assert.equal(await sql('select count(*) from public.pdd_stats_hourly;'),'1');
  assert.deepEqual((await rpc('pdd_public_hourly_history',{hours:48})).snapshots,[captured]);
  const dashboard=await rpc('pdd_public_hourly_dashboard',{});
  assert.deepEqual(dashboard.stats,stats);assert.deepEqual(dashboard.observations,[]);
  for (const payload of [{hours:721},{hours:0},{hours:1,date:'2026-01-01'},{date:'2099-01-01'},{includePrivate:true}])
    await assert.rejects(()=>rpc('pdd_public_hourly_history',payload),/INVALID_REQUEST/);
  await assert.rejects(()=>rpc('pdd_capture_stats_hourly',{hour:'2020-01-01T00:00:00Z'}),/INVALID_REQUEST/);
  await assert.rejects(()=>sql('update public.pdd_stats_hourly set sampled_at=sampled_at;'),/IMMUTABLE_HISTORY/);
  for (const role of ['anon','authenticated']) for (const name of ['pdd_public_hourly_dashboard','pdd_public_hourly_history','pdd_public_hourly_feed','pdd_hourly_source','pdd_capture_stats_hourly'])
    await assert.rejects(()=>sql(`set role ${role}; ${invoke(name,{})}`),/permission denied/);
  for (const table of ['pdd_stats_hourly','pdd_telemetry_hourly','pdd_insights_settings','pdd_insights_feed','pdd_insights_fact_ledger','pdd_insights_releases']) {
    assert.equal(await sql(`select has_table_privilege('service_role','public.${table}','SELECT') and not has_table_privilege('service_role','public.${table}','INSERT,UPDATE,DELETE');`),'t');
  }
  const reset='begin; delete from public.pdd_telemetry_daily; delete from public.pdd_telemetry_hourly; delete from public.pdd_telemetry_budget;';
  const input={events:[{event:'pdd_page_view',page:'insights',count:2},{event:'pdd_scanner_not_found',page:'home',scanMode:'photo',count:3}],daily_limit:5};
  const overflow={events:[{event:'pdd_page_view',page:'share',count:1}],daily_limit:5};
  const output=await sql(`${reset} set local role service_role; ${invoke('pdd_telemetry_ingest',input)} ${invoke('pdd_telemetry_ingest',overflow)} reset role;
    select jsonb_build_object('daily',(select sum(event_count) from public.pdd_telemetry_daily),'hourly',(select sum(event_count) from public.pdd_telemetry_hourly),'budget',(select accepted_events from public.pdd_telemetry_budget))::text; rollback;`);
  const [accepted,rejected,counts]=output.split('\n').filter(line=>line.startsWith('{')).map(JSON.parse);
  assert.equal(accepted.recorded,5);assert.equal(rejected.accepted,false);assert.deepEqual(counts,{daily:5,hourly:5,budget:5});
  const original=await sql("select jsonb_build_object('daily',(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') from public.pdd_telemetry_daily t),'hourly',(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') from public.pdd_telemetry_hourly t),'budget',(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') from public.pdd_telemetry_budget t))::text;");
  await assert.rejects(()=>sql(`${reset}
    create function public.synthetic_hour_failure() returns trigger language plpgsql as $$begin raise exception 'synthetic hourly failure'; end$$;
    create trigger synthetic_fail before insert on public.pdd_telemetry_hourly for each row execute function public.synthetic_hour_failure();
    ${invoke('pdd_telemetry_ingest',input)} commit;`),/synthetic hourly failure/);
  assert.equal(await sql("select jsonb_build_object('daily',(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') from public.pdd_telemetry_daily t),'hourly',(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') from public.pdd_telemetry_hourly t),'budget',(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') from public.pdd_telemetry_budget t))::text;"),original);
  const source=await rpc('pdd_hourly_source',{});
  assert.equal(source.businessHours.length,192);assert.equal(source.outcomesAvailable,false);assert.deepEqual(source.outcomes,[]);
  assert.equal(source.telemetry.truncated,false);assert.equal(source.snapshots.length,1);
  const encoded=JSON.stringify(source);for(const field of ['recipientName','recipient_name','contact','note','registrationCode','capability','body_hash'])assert(!encoded.includes('"'+field+'"'));
  const keyOutput=await sql(`begin; create schema vault; create table vault.decrypted_secrets(name text,decrypted_secret text);
    insert into vault.decrypted_secrets values('pdd_insights_ledger_key','${'d'.repeat(64)}');
    select jsonb_build_object('first',public.pdd_insights_fact_key('parcel-match','synthetic-business-id'),'repeat',public.pdd_insights_fact_key('parcel-match','synthetic-business-id'),'other',public.pdd_insights_fact_key('handover','synthetic-business-id'),'available',public.pdd_hourly_source('{}')->'outcomesAvailable')::text; rollback;`);
  const keyed=JSON.parse(keyOutput);assert.match(keyed.first,/^[0-9a-f]{64}$/);assert.equal(keyed.first,keyed.repeat);assert.notEqual(keyed.first,keyed.other);assert.equal(keyed.available,true);
  const release={release_key:'f'.repeat(64),accepted_at:new Date(Date.now()-1000).toISOString(),fact_text:'合成测试：查询界面已完成生产验收。',frontend_sha:'a'.repeat(40),api_sha:'b'.repeat(40),database_versions:['20261009040000'],actor_id:actor};
  const releaseOutput=await sql(`begin; set local role service_role; ${invoke('pdd_insights_accept_release',release)} reset role; select jsonb_build_object('count',(select count(*) from public.pdd_insights_releases),'audit',(select payload from public.pdd_insights_audit where action='insights_release_accepted'))::text; rollback;`);
  const [,releaseProof]=releaseOutput.split('\n').filter(line=>line.startsWith('{')).map(JSON.parse);
  assert.equal(releaseProof.count,1);assert(!JSON.stringify(releaseProof.audit).includes(release.fact_text));
  console.log('Hourly real PostgreSQL checks passed: concurrent first-sample idempotence, genuine gaps, bounded public projection/closed ACL, shared budget and both-write rollback, bounded private source with keyed outcome availability, and accepted-release audit without prose.');
}
