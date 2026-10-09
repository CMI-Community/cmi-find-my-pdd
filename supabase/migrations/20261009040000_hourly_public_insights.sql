-- Independent hourly public facts. Existing daily snapshots, budgets and monitoring remain intact.
create table public.pdd_stats_hourly (
 hour timestamptz primary key check(hour=date_trunc('hour',hour at time zone 'UTC') at time zone 'UTC'),
 sampled_at timestamptz not null check(sampled_at>=hour and sampled_at<hour+interval '1 hour'),
 metric_version text not null check(metric_version='home-six-lifetime-v1'),
 stats jsonb not null check(public.pdd_stats_six_valid(stats))
);
create table public.pdd_telemetry_hourly (
 hour timestamptz not null check(hour=date_trunc('hour',hour at time zone 'UTC') at time zone 'UTC'),
 event text not null check(public.pdd_telemetry_event_valid(event)),
 page text not null check(page in ('home','help','privacy','local','insights','share')),
 mode text not null default '' check(mode in ('','lost','received')),
 source text not null default '' check(source in ('','manual','barcode')),
 scan_mode text not null default '' check(scan_mode in ('','photo','realtime')),
 batch_bucket text not null default '' check(batch_bucket in ('','1','2-5','6-20','21+')),
 dwell_bucket text not null default '' check(dwell_bucket in ('','0-9s','10-29s','30-59s','1-2m','3-9m','10-30m')),
 event_count bigint not null check(event_count>=0),
 primary key(hour,event,page,mode,source,scan_mode,batch_bucket,dwell_bucket)
);
create table public.pdd_insights_settings (
 id boolean primary key default true check(id), telemetry_started_at timestamptz not null default clock_timestamp(),
 enabled boolean not null default false, model text, prompt_version text,
 configured_at timestamptz, actor_id uuid,
 check(model is null or length(model) between 1 and 100), check(prompt_version is null or length(prompt_version) between 1 and 100)
);
insert into public.pdd_insights_settings(id) values(true);
create table public.pdd_insights_feed (
 id uuid primary key default gen_random_uuid(), run_id uuid not null,
 candidate_id text not null check(length(candidate_id) between 1 and 128),
 topic text not null check(length(topic) between 1 and 80), dedup_key text not null check(length(dedup_key) between 1 and 200),
 category text not null check(public.pdd_content_text(to_jsonb(category),24)),
 body text not null check(public.pdd_content_text(to_jsonb(body),90)),
 window_start timestamptz not null, window_end timestamptz not null,
 published_at timestamptz not null default clock_timestamp(),
 check(window_start<window_end and window_end<=published_at), unique(run_id,candidate_id)
);
create index pdd_insights_feed_order on public.pdd_insights_feed(published_at desc,id desc);
create table public.pdd_insights_fact_ledger (
 fact_key text primary key check(fact_key~'^[0-9a-f]{64}$'),
 feed_id uuid not null references public.pdd_insights_feed(id), created_at timestamptz not null default clock_timestamp()
);
create trigger pdd_hourly_stats_immutable before update or delete on public.pdd_stats_hourly for each row execute function public.pdd_content_immutable();
create trigger pdd_hourly_feed_immutable before update or delete on public.pdd_insights_feed for each row execute function public.pdd_content_immutable();
create trigger pdd_hourly_ledger_immutable before update or delete on public.pdd_insights_fact_ledger for each row execute function public.pdd_content_immutable();

create function public.pdd_capture_stats_hourly(p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare sampled timestamptz:=clock_timestamp(); slot timestamptz; r public.pdd_stats_hourly; begin
 if p_payload<>'{}'::jsonb then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 slot:=date_trunc('hour',sampled at time zone 'UTC') at time zone 'UTC';
 perform pg_advisory_xact_lock(hashtextextended('pdd-hourly-stats:'||slot::text,0));
 select * into r from public.pdd_stats_hourly where hour=slot;
 if not found then insert into public.pdd_stats_hourly(hour,sampled_at,metric_version,stats)
  values(slot,sampled,'home-six-lifetime-v1',public.pdd_home_stats('{}')) returning * into r; end if;
 return jsonb_build_object('hour',r.hour,'sampledAt',r.sampled_at,'metricVersion',r.metric_version,'stats',r.stats);
end$$;
create function public.pdd_public_hourly_history(p_payload jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path='' as $$
declare n integer:=48; d date; first_at timestamptz; last_at timestamptz; sampled timestamptz:=statement_timestamp(); result jsonb; begin
 if jsonb_typeof(p_payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('hours','date')) or (p_payload?'hours' and p_payload?'date') then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 if p_payload?'date' then
  if not public.pdd_content_date(p_payload->>'date') then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  d:=(p_payload->>'date')::date;
  if d<(sampled at time zone 'Asia/Bangkok')::date-29 or d>(sampled at time zone 'Asia/Bangkok')::date then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  first_at:=d::timestamp at time zone 'Asia/Bangkok'; last_at:=(d+1)::timestamp at time zone 'Asia/Bangkok';
 else
  if p_payload?'hours' then
   if jsonb_typeof(p_payload->'hours') is distinct from 'number' or coalesce(p_payload->>'hours','')!~'^[0-9]{1,3}$' then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
   n:=(p_payload->>'hours')::integer;
  end if;
  if n not between 1 and 720 then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  last_at:=date_trunc('hour',sampled at time zone 'UTC') at time zone 'UTC'; first_at:=last_at-make_interval(hours=>n);
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('hour',hour,'sampledAt',sampled_at,'metricVersion',metric_version,'stats',stats) order by hour),'[]') into result
 from public.pdd_stats_hourly where hour>=first_at and hour<=last_at and sampled_at<=sampled;
 return jsonb_build_object('sampledAt',sampled,'snapshots',result);
end$$;
create function public.pdd_public_hourly_feed(p_payload jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path='' as $$
declare anchor public.pdd_insights_feed; result jsonb; next_id uuid; total integer; begin
 if jsonb_typeof(p_payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k<>'before') then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 if p_payload?'before' then
  if coalesce(p_payload->>'before','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  select * into anchor from public.pdd_insights_feed where id=(p_payload->>'before')::uuid;
  if not found then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 end if;
 with chosen as(select * from public.pdd_insights_feed where anchor.id is null or (published_at,id)<(anchor.published_at,anchor.id) order by published_at desc,id desc limit 21), numbered as(select *,row_number() over(order by published_at desc,id desc) n from chosen)
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'category',category,'text',body,'publishedAt',published_at,'windowStart',window_start,'windowEnd',window_end) order by n) filter(where n<=20),'[]'),count(*),(array_agg(id order by n) filter(where n=20))[1] into result,total,next_id from numbered;
 return jsonb_build_object('observations',result,'nextBefore',case when total>20 then next_id else null end);
end$$;
create function public.pdd_public_hourly_dashboard(p_payload jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if jsonb_typeof(p_payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('hours','date','before')) then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 return public.pdd_public_hourly_history(p_payload-'before')||jsonb_build_object('metricVersion','home-six-lifetime-v1','stats',public.pdd_home_stats('{}'))||public.pdd_public_hourly_feed(p_payload-'hours'-'date');
end$$;

-- Both aggregates share the already validated batch, UTC day budget and transaction.
alter table public.pdd_telemetry_daily drop constraint pdd_telemetry_daily_page_check;
alter table public.pdd_telemetry_daily add constraint pdd_telemetry_daily_page_check check(page in ('home','help','privacy','local','insights','share'));
do $$declare definition text; anchor text; begin
 definition:=pg_get_functiondef('public.pdd_telemetry_ingest(jsonb)'::regprocedure);
 anchor:=$a$not in ('home','help','privacy','local')$a$;
 if strpos(definition,anchor)=0 then raise exception 'HOURLY_TELEMETRY_PAGE_SOURCE_CHANGED'; end if;
 definition:=replace(definition,anchor,$a$not in ('home','help','privacy','local','insights','share')$a$);
 anchor:=$a$ end loop;
 update public.pdd_telemetry_budget set accepted_batches$a$;
 if strpos(definition,anchor)=0 then raise exception 'HOURLY_TELEMETRY_WRITE_SOURCE_CHANGED'; end if;
 definition:=replace(definition,anchor,$a$  insert into public.pdd_telemetry_hourly(hour,event,page,mode,source,scan_mode,batch_bucket,dwell_bucket,event_count)
   values(date_trunc('hour',now() at time zone 'UTC') at time zone 'UTC',item->>'event',item->>'page',coalesce(item->>'mode',''),coalesce(item->>'source',''),coalesce(item->>'scanMode',''),coalesce(item->>'batch',''),coalesce(item->>'bucket',''),(item->>'count')::integer)
  on conflict(hour,event,page,mode,source,scan_mode,batch_bucket,dwell_bucket) do update set event_count=public.pdd_telemetry_hourly.event_count+excluded.event_count;
 end loop;
 update public.pdd_telemetry_budget set accepted_batches$a$);
 execute definition;
 -- Keep existing retention behavior and its schedule. Only add the hourly anonymous aggregate cleanup.
 definition:=pg_get_functiondef('public.pdd_telemetry_cleanup(jsonb)'::regprocedure);
 anchor:=$a$ delete from public.pdd_telemetry_daily$a$;
 if strpos(definition,anchor)=0 then raise exception 'HOURLY_TELEMETRY_RETENTION_SOURCE_CHANGED'; end if;
 definition:=replace(definition,anchor,$a$ delete from public.pdd_telemetry_hourly where hour<(date_trunc('hour',now() at time zone 'UTC') at time zone 'UTC')-interval '30 days';
 delete from public.pdd_telemetry_daily$a$);
 execute definition;
end$$;

select cron.schedule('pdd404-hourly-public-stats','0 * * * *','select public.pdd_capture_stats_hourly(''{}''::jsonb)');
do $$declare t text; f record; begin
 foreach t in array array['pdd_stats_hourly','pdd_telemetry_hourly','pdd_insights_settings','pdd_insights_feed','pdd_insights_fact_ledger'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on public.%I to service_role',t);
 end loop;
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('pdd_capture_stats_hourly','pdd_public_hourly_history','pdd_public_hourly_feed','pdd_public_hourly_dashboard') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end$$;

-- Explicit accepted production changes are not inferred from a migration or merged PR.
create table public.pdd_insights_releases (
 release_key text primary key check(release_key~'^[0-9a-f]{64}$'),
 accepted_at timestamptz not null, fact_text text not null check(public.pdd_content_text(to_jsonb(fact_text),90)),
 frontend_sha text not null check(frontend_sha~'^[0-9a-f]{40}$'), api_sha text not null check(api_sha~'^[0-9a-f]{40}$'),
 database_versions jsonb not null check(jsonb_typeof(database_versions)='array' and jsonb_array_length(database_versions)<=40),
 actor_id uuid not null, created_at timestamptz not null default clock_timestamp(), check(accepted_at<=created_at)
);
alter table public.pdd_insights_releases enable row level security;
revoke all on public.pdd_insights_releases from public,anon,authenticated,service_role;
grant select on public.pdd_insights_releases to service_role;
create trigger pdd_hourly_release_immutable before update or delete on public.pdd_insights_releases for each row execute function public.pdd_content_immutable();
create function public.pdd_insights_accept_release(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.pdd_insights_releases; actor uuid; begin
 if not public.pdd_content_keys(p_payload,array['release_key','accepted_at','fact_text','frontend_sha','api_sha','database_versions','actor_id'])
 or coalesce(p_payload->>'release_key','')!~'^[0-9a-f]{64}$' or not public.pdd_content_timestamp(p_payload->'accepted_at')
 or not public.pdd_content_text(p_payload->'fact_text',90) or coalesce(p_payload->>'frontend_sha','')!~'^[0-9a-f]{40}$'
 or coalesce(p_payload->>'api_sha','')!~'^[0-9a-f]{40}$' or jsonb_typeof(p_payload->'database_versions') is distinct from 'array'
 or jsonb_array_length(p_payload->'database_versions')>40 or exists(select 1 from jsonb_array_elements(p_payload->'database_versions') v where jsonb_typeof(v)<>'string' or v#>>'{}'!~'^[0-9]{14}$')
 or (p_payload->>'accepted_at')::timestamptz>clock_timestamp() or coalesce(p_payload->>'actor_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 actor:=(p_payload->>'actor_id')::uuid;
 insert into public.pdd_insights_releases(release_key,accepted_at,fact_text,frontend_sha,api_sha,database_versions,actor_id)
 values(p_payload->>'release_key',(p_payload->>'accepted_at')::timestamptz,p_payload->>'fact_text',p_payload->>'frontend_sha',p_payload->>'api_sha',p_payload->'database_versions',actor) on conflict(release_key) do nothing returning * into r;
 if not found then raise exception 'VERSION_CONFLICT' using errcode='P0001'; end if;
 insert into public.audit_events(actor_id,action,payload) values(actor,'insights_release_accepted',jsonb_build_object('releaseKey',r.release_key,'frontendSha',r.frontend_sha,'apiSha',r.api_sha,'acceptedAt',r.accepted_at));
 return jsonb_build_object('releaseKey',r.release_key,'acceptedAt',r.accepted_at);
end$$;
-- Private keyed stable identities, never a business id sent to the model or browser.
create function public.pdd_insights_fact_key(domain text,identity text) returns text language plpgsql stable security definer set search_path='' as $$
declare secret text; begin
 if domain not in ('parcel-match','recipient-match-waybill','recipient-match-independent','handover','release') then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 if to_regclass('vault.decrypted_secrets') is null then return null; end if;
 select decrypted_secret into secret from vault.decrypted_secrets where name='pdd_insights_ledger_key' limit 1;
 if secret is null or secret!~'^[0-9a-f]{64}$' then return null; end if;
 return encode(extensions.hmac(domain||':'||identity,secret,'sha256'),'hex');
end$$;
create function public.pdd_hourly_source(p_payload jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path='' as $$
declare until_at timestamptz:=date_trunc('hour',statement_timestamp() at time zone 'UTC') at time zone 'UTC';
 since_at timestamptz; started_at timestamptz; snapshots jsonb; business jsonb; queries jsonb; telemetry jsonb; total_events integer;
 outcomes jsonb; releases jsonb; ledger_ready boolean; begin
 if p_payload<>'{}'::jsonb then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 since_at:=until_at-interval '8 days'; select telemetry_started_at into started_at from public.pdd_insights_settings where id;
 snapshots:=public.pdd_public_hourly_history(jsonb_build_object('hours',192))->'snapshots';
 with p as(select since_at first_at,until_at last_at), first_waybill as(
  select r.waybill_id,r.mode,min(r.created_at) event_at,bool_or(w.number~*'(TEST|SYNTH|FIXTURE|DEMO|PDD404)') test
  from public.pdd_registrations r join public.pdd_waybills w on w.id=r.waybill_id group by r.waybill_id,r.mode
 ), events as(
  select case mode when 'lost' then 'lostRegistered' else 'receivedRegistered' end metric,event_at,test from first_waybill
  union all select 'matchedParcels',matched_at,number~*'(TEST|SYNTH|FIXTURE|DEMO|PDD404)' from public.pdd_waybills where matched_at is not null
  union all select case r.mode when 'lost' then 'lostRecipientRegistered' else 'receivedRecipientRegistered' end,r.recipient_registered_at,w.number~*'(TEST|SYNTH|FIXTURE|DEMO|PDD404)' or coalesce(r.recipient_name,'')~*'(TEST|SYNTH|FIXTURE|DEMO|测试|合成|验收)' from public.pdd_registrations r join public.pdd_waybills w on w.id=r.waybill_id where r.recipient_registered_at is not null
  union all select case mode when 'lost' then 'lostRecipientRegistered' else 'receivedRecipientRegistered' end,created_at,coalesce(recipient_name,'')~*'(TEST|SYNTH|FIXTURE|DEMO|测试|合成|验收)' from public.pdd_recipient_leads
  union all select 'matchedRecipientLeads',r.recipient_matched_at,w.number~*'(TEST|SYNTH|FIXTURE|DEMO|PDD404)' or coalesce(r.recipient_name,'')~*'(TEST|SYNTH|FIXTURE|DEMO|测试|合成|验收)' from public.pdd_registrations r join public.pdd_waybills w on w.id=r.waybill_id where r.recipient_matched_at is not null
  union all select 'matchedRecipientLeads',recipient_matched_at,coalesce(recipient_name,'')~*'(TEST|SYNTH|FIXTURE|DEMO|测试|合成|验收)' from public.pdd_recipient_leads where recipient_matched_at is not null
  union all select 'handovers',h.created_at,w.number~*'(TEST|SYNTH|FIXTURE|DEMO|PDD404)' from public.pdd_handovers h join public.pdd_waybills w on w.id=h.waybill_id
 ), grouped as(select date_trunc('hour',event_at at time zone 'UTC') at time zone 'UTC' as hour,
  count(*) filter(where metric='lostRegistered') lost,count(*) filter(where metric='receivedRegistered') received,count(*) filter(where metric='matchedParcels') matched,
  count(*) filter(where metric='lostRecipientRegistered') lost_name,count(*) filter(where metric='receivedRecipientRegistered') received_name,count(*) filter(where metric='matchedRecipientLeads') matched_name,
  count(*) filter(where metric='handovers') handovers,count(*) filter(where test) tests
  from events,p where event_at>=p.first_at and event_at<p.last_at group by 1)
 select coalesce(jsonb_agg(jsonb_build_object('hour',g,'stats',jsonb_build_object('lostRegistered',coalesce(lost,0),'receivedRegistered',coalesce(received,0),'matchedParcels',coalesce(matched,0),'lostRecipientRegistered',coalesce(lost_name,0),'receivedRecipientRegistered',coalesce(received_name,0),'matchedRecipientLeads',coalesce(matched_name,0)),'handovers',coalesce(handovers,0),'excludedTests',coalesce(tests,0)) order by g),'[]') into business
 from generate_series(since_at,until_at-interval '1 hour',interval '1 hour') g left join grouped on grouped.hour=g;
 with events as(
  select queried_at,mode,source,result,'waybill' lookup,number~*'(TEST|SYNTH|FIXTURE|DEMO|PDD404)' test from public.pdd_query_events where queried_at>=since_at and queried_at<until_at
  union all select queried_at,mode,null,result,'recipient',coalesce(recipient_name,'')~*'(TEST|SYNTH|FIXTURE|DEMO|测试|合成|验收)' from public.pdd_recipient_query_events where queried_at>=since_at and queried_at<until_at
 ), grouped as(select date_trunc('hour',queried_at at time zone 'UTC') at time zone 'UTC' as hour,lookup,mode,source,result,count(*) filter(where not test) count,count(*) filter(where test) tests from events group by 1,2,3,4,5)
 select coalesce(jsonb_agg(jsonb_build_object('hour',hour,'lookup',lookup,'mode',mode,'source',source,'result',result,'count',count,'excludedTests',tests) order by hour,lookup,mode,source,result),'[]') into queries from grouped;
 select count(*) into total_events from public.pdd_telemetry_hourly where hour>=since_at and hour<until_at;
 select coalesce(jsonb_agg(jsonb_build_object('hour',hour,'event',event,'page',page,'mode',nullif(mode,''),'source',nullif(source,''),'scanMode',nullif(scan_mode,''),'batch',nullif(batch_bucket,''),'bucket',nullif(dwell_bucket,''),'count',event_count) order by hour,event,page,mode,source,scan_mode,batch_bucket,dwell_bucket),'[]') into telemetry
 from(select * from public.pdd_telemetry_hourly where hour>=since_at and hour<until_at order by hour,event,page,mode,source,scan_mode,batch_bucket,dwell_bucket limit 20000) rows;
 ledger_ready:=public.pdd_insights_fact_key('release','probe') is not null;
 if ledger_ready then
  with facts as(
   select 'parcel-match' kind,matched_at as at,public.pdd_insights_fact_key('parcel-match',id::text) key from public.pdd_waybills where matched_at>=greatest(since_at,started_at) and matched_at<until_at and number!~*'(TEST|SYNTH|FIXTURE|DEMO|PDD404)'
   union all select 'recipient-match',r.recipient_matched_at,public.pdd_insights_fact_key('recipient-match-waybill',r.id::text) from public.pdd_registrations r join public.pdd_waybills w on w.id=r.waybill_id where r.recipient_matched_at>=greatest(since_at,started_at) and r.recipient_matched_at<until_at and w.number!~*'(TEST|SYNTH|FIXTURE|DEMO|PDD404)' and coalesce(r.recipient_name,'')!~*'(TEST|SYNTH|FIXTURE|DEMO|测试|合成|验收)'
   union all select 'recipient-match',recipient_matched_at,public.pdd_insights_fact_key('recipient-match-independent',id::text) from public.pdd_recipient_leads where recipient_matched_at>=greatest(since_at,started_at) and recipient_matched_at<until_at and coalesce(recipient_name,'')!~*'(TEST|SYNTH|FIXTURE|DEMO|测试|合成|验收)'
   union all select 'handover',h.created_at,public.pdd_insights_fact_key('handover',h.waybill_id::text) from public.pdd_handovers h join public.pdd_waybills w on w.id=h.waybill_id where h.created_at>=greatest(since_at,started_at) and h.created_at<until_at and w.number!~*'(TEST|SYNTH|FIXTURE|DEMO|PDD404)'
  ) select coalesce(jsonb_agg(to_jsonb(facts) order by at,key),'[]') into outcomes from facts;
  select coalesce(jsonb_agg(jsonb_build_object('key',public.pdd_insights_fact_key('release',release_key),'at',accepted_at,'category','网站更新','text',fact_text) order by accepted_at),'[]') into releases from public.pdd_insights_releases where accepted_at>=greatest(since_at,started_at) and accepted_at<until_at;
 end if;
 return jsonb_build_object('sampledAt',statement_timestamp(),'observedUntil',until_at,'fromHour',since_at,'metricVersion','home-six-lifetime-v1','snapshots',snapshots,'businessHours',business,'queries',queries,
 'outcomesAvailable',ledger_ready,'outcomes',coalesce(outcomes,'[]'),'verifiedReleases',coalesce(releases,'[]'),'publishedFactKeys',(select coalesce(jsonb_agg(fact_key order by fact_key),'[]') from public.pdd_insights_fact_ledger),
 'recentObservations',(select coalesce(jsonb_agg(jsonb_build_object('topic',topic,'dedupKey',dedup_key,'publishedAt',published_at,'windowStart',window_start,'windowEnd',window_end) order by published_at desc,id desc),'[]') from(select * from public.pdd_insights_feed where published_at>=since_at order by published_at desc,id desc limit 100) recent),
 'telemetry',jsonb_build_object('startedAt',started_at,'truncated',total_events>20000,'events',telemetry,'budget',(select coalesce(jsonb_agg(jsonb_build_object('day',day,'acceptedEvents',accepted_events,'acceptedBatches',accepted_batches,'dailyLimit',daily_limit,'limitedAt',limited_at) order by day),'[]') from public.pdd_telemetry_budget where day>=(since_at at time zone 'UTC')::date)));
end$$;
do $$declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('pdd_insights_accept_release','pdd_insights_fact_key','pdd_hourly_source') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end$$;
