-- Independent hourly model observer; no effect on OCR workers or existing budgets.
create table public.pdd_insights_runs (
 id uuid primary key default gen_random_uuid(), slot timestamptz not null unique,
 day date not null, reserved_at timestamptz not null default clock_timestamp(),
 observed_until timestamptz not null, model text not null, prompt_version text not null,
 input jsonb not null, candidates jsonb not null,
 state text not null default 'reserved' check(state in ('reserved','completed','rejected','unknown')),
 reserved_usd numeric(12,8) not null check(reserved_usd>0), cost_usd numeric(12,8),
 cost_state text not null default 'reserved' check(cost_state in ('reserved','known','unknown')),
 usage jsonb, selection jsonb, failure_code text, finished_at timestamptz,
 check(slot=date_trunc('hour',slot at time zone 'UTC') at time zone 'UTC' and observed_until=slot),
 check(day=(reserved_at at time zone 'Asia/Bangkok')::date),
 check((cost_state='known' and cost_usd is not null and cost_usd>=0) or (cost_state<>'known' and cost_usd is null)),
 check((state='reserved' and finished_at is null) or (state<>'reserved' and finished_at>=reserved_at)),
 check(jsonb_typeof(input)='object' and jsonb_typeof(candidates)='array')
);
create index pdd_insights_runs_budget on public.pdd_insights_runs(day);
alter table public.pdd_insights_runs enable row level security;
revoke all on public.pdd_insights_runs from public,anon,authenticated,service_role;
grant select on public.pdd_insights_runs to service_role;
create table public.pdd_insights_audit (
 id uuid primary key default gen_random_uuid(), at timestamptz not null default clock_timestamp(), actor_id uuid,
 run_id uuid references public.pdd_insights_runs(id), action text not null check(action in ('insights_worker_configured','insights_run_reserved','insights_run_finished','insights_release_accepted')),
 payload jsonb not null check(jsonb_typeof(payload)='object')
);
alter table public.pdd_insights_audit enable row level security;
revoke all on public.pdd_insights_audit from public,anon,authenticated,service_role;
grant select on public.pdd_insights_audit to service_role;
create trigger pdd_insights_audit_immutable before update or delete on public.pdd_insights_audit for each row execute function public.pdd_content_immutable();
alter table public.pdd_insights_feed add constraint pdd_insights_feed_run_fk foreign key(run_id) references public.pdd_insights_runs(id);
alter table public.pdd_insights_settings add column daily_call_limit integer not null default 24 check(daily_call_limit=24);
alter table public.pdd_insights_settings add column reservation_usd numeric(12,8) not null default 0.01 check(reservation_usd=0.01);

-- Acceptance by a controlled service records a NULL actor instead of impersonating an administrator.
alter table public.pdd_insights_releases alter column actor_id drop not null;
do $$declare definition text; anchor text; begin
 definition:=pg_get_functiondef('public.pdd_insights_accept_release(jsonb)'::regprocedure);
 anchor:=$a$or coalesce(p_payload->>'actor_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'$a$;
 if strpos(definition,anchor)=0 then raise exception 'HOURLY_RELEASE_ACTOR_SOURCE_CHANGED'; end if;
 definition:=replace(definition,anchor,$a$or (p_payload->'actor_id'<>'null'::jsonb and coalesce(p_payload->>'actor_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')$a$);
 anchor:=$a$insert into public.audit_events(actor_id,action,payload) values(actor,'insights_release_accepted'$a$;
 if strpos(definition,anchor)=0 then raise exception 'HOURLY_RELEASE_AUDIT_SOURCE_CHANGED'; end if;
 execute replace(definition,anchor,$a$insert into public.pdd_insights_audit(actor_id,action,payload) values(actor,'insights_release_accepted'$a$);
end$$;

create function public.pdd_insights_plain_text(v jsonb,maximum integer) returns boolean language sql immutable set search_path='' as $$
 select public.pdd_content_text(v,maximum) and (v#>>'{}')!~'[[:cntrl:]]'
$$;
create function public.pdd_insights_candidates_valid(v jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare c jsonb; item jsonb; ids text[]:='{}'; keys text[]; begin
 if jsonb_typeof(v) is distinct from 'array' or jsonb_array_length(v)>64 then return false; end if;
 for c in select value from jsonb_array_elements(v) loop
  if jsonb_typeof(c) is distinct from 'object' or not c ?& array['id','kind','topic','score','priority','windowStart','windowEnd','dedupKey','headlines','facts']
   or exists(select 1 from jsonb_object_keys(c) k where k not in ('id','kind','topic','score','priority','windowStart','windowEnd','dedupKey','headlines','facts','stableFactKeys','windowId','source','definitionVersion','value','direction'))
   or coalesce(c->>'id','')!~'^[a-z0-9][a-z0-9-]{0,95}$' or c->>'id'=any(ids)
   or coalesce(c->>'kind','') not in ('registration','operation','traffic','outcome','production-release','side-difference','result-share')
   or not public.pdd_insights_plain_text(c->'topic',80) or not public.pdd_insights_plain_text(c->'dedupKey',200)
   or jsonb_typeof(c->'score') is distinct from 'number' or (c->>'score')::numeric<0
   or coalesce(c->>'priority','')!~'^[0-9]{1,2}$'
   or not public.pdd_content_timestamp(c->'windowStart') or not public.pdd_content_timestamp(c->'windowEnd')
   or (c->>'windowStart')::timestamptz>=(c->>'windowEnd')::timestamptz
   or jsonb_typeof(c->'headlines') is distinct from 'array' or jsonb_array_length(c->'headlines') not between 1 and 4
   or jsonb_typeof(c->'facts') is distinct from 'array' or jsonb_array_length(c->'facts') not between 1 and 6 then return false; end if;
  ids:=array_append(ids,c->>'id'); keys:='{}';
  for item in select value from jsonb_array_elements(c->'headlines') loop
   if not public.pdd_content_keys(item,array['id','text']) or coalesce(item->>'id','')!~'^[a-z0-9][a-z0-9-]{0,95}$' or item->>'id'=any(keys) or not public.pdd_insights_plain_text(item->'text',24) then return false; end if;
   keys:=array_append(keys,item->>'id');
  end loop;
  keys:='{}';
  for item in select value from jsonb_array_elements(c->'facts') loop
   if not public.pdd_content_keys(item,array['id','text']) or coalesce(item->>'id','')!~'^[a-z0-9][a-z0-9-]{0,95}$' or item->>'id'=any(keys) or not public.pdd_insights_plain_text(item->'text',90) then return false; end if;
   keys:=array_append(keys,item->>'id');
  end loop;
  if c?'stableFactKeys' then
   if jsonb_typeof(c->'stableFactKeys') is distinct from 'array' or jsonb_array_length(c->'stableFactKeys')>1000
    or exists(select 1 from jsonb_array_elements(c->'stableFactKeys') k where jsonb_typeof(k)<>'string' or k#>>'{}'!~'^[0-9a-f]{64}$')
    or (select count(*)<>count(distinct value) from jsonb_array_elements(c->'stableFactKeys')) then return false; end if;
  end if;
  if c->>'kind' in ('outcome','production-release') and (not(c?'stableFactKeys') or jsonb_array_length(c->'stableFactKeys')=0) then return false; end if;
  if c?'windowId' and coalesce(c->>'windowId','') not in ('h1','h3','h24') then return false; end if;
  if c?'source' and not public.pdd_insights_plain_text(c->'source',100) then return false; end if;
  if c?'definitionVersion' and not public.pdd_insights_plain_text(c->'definitionVersion',100) then return false; end if;
  if c?'value' and coalesce(c->>'value','')!~'^[0-9]{1,15}$' then return false; end if;
  if c?'direction' and coalesce(c->>'direction','') not in ('up','down','equal') then return false; end if;
 end loop;
 return true;
exception when others then return false;
end$$;

create function public.pdd_insights_model_candidates(v jsonb) returns jsonb language sql immutable set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',c->'id','kind',c->'kind','topic',c->'topic','score',c->'score','priority',c->'priority','windowStart',c->'windowStart','windowEnd',c->'windowEnd','dedupKey',c->'dedupKey','headlines',c->'headlines','facts',c->'facts') order by n),'[]') from jsonb_array_elements(v) with ordinality items(c,n)
$$;
create function public.pdd_insights_input_valid(v jsonb,candidates jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare r jsonb; begin
 if jsonb_typeof(v) is distinct from 'object' or not v ?& array['observedUntil','timezone','selectionLimit','candidates','recentObservations']
  or exists(select 1 from jsonb_object_keys(v) k where k not in ('runId','observedUntil','timezone','selectionLimit','candidates','recentObservations'))
  or not public.pdd_content_timestamp(v->'observedUntil') or v->>'timezone' is distinct from 'Asia/Bangkok' or v->'selectionLimit'<>'3'::jsonb
  or not public.pdd_insights_candidates_valid(candidates) or octet_length(candidates::text)>524288
  or v->'candidates' is distinct from public.pdd_insights_model_candidates(candidates) or octet_length(v::text)>32768
  or jsonb_typeof(v->'recentObservations') is distinct from 'array' or jsonb_array_length(v->'recentObservations')>100 then return false; end if;
 if v?'runId' and coalesce(v->>'runId','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
 for r in select value from jsonb_array_elements(v->'recentObservations') loop
  if not public.pdd_content_keys(r,array['candidateId','topic','publishedAt']) or coalesce(r->>'candidateId','')!~'^[a-z0-9][a-z0-9-]{0,95}$'
   or not public.pdd_insights_plain_text(r->'topic',80) or not public.pdd_content_timestamp(r->'publishedAt') then return false; end if;
 end loop;
 return true;
exception when others then return false;
end$$;
create function public.pdd_insights_reserve(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare sampled timestamptz:=clock_timestamp(); slot_at timestamptz; day_at date; settings public.pdd_insights_settings; r public.pdd_insights_runs; c jsonb; begin
 if not public.pdd_content_keys(p_payload,array['input','candidates','prompt_version','model']) or not public.pdd_insights_input_valid(p_payload->'input',p_payload->'candidates')
  or p_payload->>'model' is distinct from 'gpt-5.6-luna' or p_payload->>'prompt_version' is distinct from 'hourly-observation-v1' then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 slot_at:=date_trunc('hour',sampled at time zone 'UTC') at time zone 'UTC';day_at:=(sampled at time zone 'Asia/Bangkok')::date;
 if (p_payload->'input'->>'observedUntil')::timestamptz<>slot_at or exists(select 1 from jsonb_array_elements(p_payload->'candidates') item where (item->>'windowEnd')::timestamptz>slot_at) then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 select * into settings from public.pdd_insights_settings where id for share;
 if not settings.enabled then return jsonb_build_object('reserved',false,'runId',null,'observedUntil',slot_at,'state','disabled'); end if;
 if settings.model is distinct from p_payload->>'model' or settings.prompt_version is distinct from p_payload->>'prompt_version' then raise exception 'VERSION_CONFLICT' using errcode='P0001'; end if;
 perform pg_advisory_xact_lock(hashtextextended('pdd-insights-budget:'||day_at::text,0));
 select * into r from public.pdd_insights_runs where slot=slot_at;
 if found then return jsonb_build_object('reserved',false,'runId',r.id,'observedUntil',r.observed_until,'state',r.state); end if;
 sampled:=clock_timestamp();
 if date_trunc('hour',sampled at time zone 'UTC') at time zone 'UTC'<>slot_at then return jsonb_build_object('reserved',false,'runId',null,'observedUntil',slot_at,'state','expired'); end if;
 if (select count(*) from public.pdd_insights_runs where day=day_at)>=settings.daily_call_limit
  or (select coalesce(sum(reserved_usd),0) from public.pdd_insights_runs where day=day_at)+settings.reservation_usd>0.24 then
  return jsonb_build_object('reserved',false,'runId',null,'observedUntil',slot_at,'state','limited');
 end if;
 r.id:=gen_random_uuid();
 insert into public.pdd_insights_runs(id,slot,day,reserved_at,observed_until,model,prompt_version,input,candidates,reserved_usd)
 values(r.id,slot_at,day_at,sampled,slot_at,settings.model,settings.prompt_version,(p_payload->'input')||jsonb_build_object('runId',r.id),p_payload->'candidates',settings.reservation_usd) returning * into r;
 insert into public.pdd_insights_audit(run_id,action,payload) values(r.id,'insights_run_reserved',jsonb_build_object('runId',r.id,'slot',r.slot,'day',r.day,'model',r.model,'promptVersion',r.prompt_version,'reservationUsd',r.reserved_usd));
 return jsonb_build_object('reserved',true,'runId',r.id,'observedUntil',r.observed_until,'state',r.state);
end$$;
create function public.pdd_insights_finish(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.pdd_insights_runs; choice jsonb; candidate jsonb; headline jsonb; fact jsonb; key text; feed_id uuid; published timestamptz:=clock_timestamp();
 observer_enabled boolean; choices jsonb; used_ids text[]:='{}'; used_topics text[]:='{}'; used_keys text[]:='{}'; body text; fact_id text; final_state text; failure text; inserted integer:=0; v_usage jsonb; amount numeric; begin
 if jsonb_typeof(p_payload) is distinct from 'object' or not p_payload ?& array['run_id','state','selection'] or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('run_id','state','selection','usage'))
  or coalesce(p_payload->>'run_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or coalesce(p_payload->>'state','') not in ('completed','rejected','unknown') then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 v_usage:=p_payload->'usage';
 if v_usage is not null and v_usage<>'null'::jsonb then
  if not public.pdd_content_keys(v_usage,array['inputTokens','outputTokens','costUsd']) or coalesce(v_usage->>'inputTokens','')!~'^[0-9]{1,6}$' or (v_usage->>'inputTokens')::integer>100000
   or coalesce(v_usage->>'outputTokens','')!~'^[0-9]{1,3}$' or (v_usage->>'outputTokens')::integer>600 or jsonb_typeof(v_usage->'costUsd') is distinct from 'number' or (v_usage->>'costUsd')::numeric<0 or (v_usage->>'costUsd')::numeric>0.01 then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  amount:=round(((v_usage->>'inputTokens')::numeric*0.20+(v_usage->>'outputTokens')::numeric*1.20)/1000000,8);
  if abs(amount-(v_usage->>'costUsd')::numeric)>0.000000005 or amount>0.01 then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 else v_usage:=null; end if;
 select * into r from public.pdd_insights_runs where id=(p_payload->>'run_id')::uuid for update;
 if not found then raise exception 'RECORD_NOT_FOUND' using errcode='P0001'; end if;
 if r.state<>'reserved' then return jsonb_build_object('state',r.state,'publishedCount',(select count(*) from public.pdd_insights_feed where run_id=r.id)); end if;
 final_state:=p_payload->>'state';
 if final_state='completed' then
  begin
   if not public.pdd_content_keys(p_payload->'selection',array['observations']) or jsonb_typeof(p_payload->'selection'->'observations') is distinct from 'array' or jsonb_array_length(p_payload->'selection'->'observations')>3 then raise exception 'INVALID_SELECTION' using errcode='P0001'; end if;
   select enabled into observer_enabled from public.pdd_insights_settings where id for share;
   if observer_enabled is distinct from true then raise exception 'OBSERVER_DISABLED' using errcode='P0001'; end if;
   choices:=p_payload->'selection'->'observations';
   for choice in select value from jsonb_array_elements(choices) loop
    if not public.pdd_content_keys(choice,array['candidateId','headlineId','factIds']) or coalesce(choice->>'candidateId','')!~'^[a-z0-9][a-z0-9-]{0,95}$' or coalesce(choice->>'headlineId','')!~'^[a-z0-9][a-z0-9-]{0,95}$'
     or jsonb_typeof(choice->'factIds') is distinct from 'array' or jsonb_array_length(choice->'factIds') not between 1 and 2
     or exists(select 1 from jsonb_array_elements(choice->'factIds') k where jsonb_typeof(k)<>'string' or k#>>'{}'!~'^[a-z0-9][a-z0-9-]{0,95}$')
     or (select count(*)<>count(distinct value) from jsonb_array_elements(choice->'factIds')) then raise exception 'INVALID_SELECTION' using errcode='P0001'; end if;
    select value into candidate from jsonb_array_elements(r.candidates) where value->>'id'=choice->>'candidateId';
    if candidate is null or choice->'factIds'->>0 is distinct from candidate->'facts'->0->>'id' or candidate->>'id'=any(used_ids) or candidate->>'topic'=any(used_topics) then raise exception 'INVALID_SELECTION' using errcode='P0001'; end if;
    select value into headline from jsonb_array_elements(candidate->'headlines') where value->>'id'=choice->>'headlineId';
    if headline is null then raise exception 'INVALID_SELECTION' using errcode='P0001'; end if;
    body:='';
    for fact_id in select value from jsonb_array_elements_text(choice->'factIds') loop
     select value into fact from jsonb_array_elements(candidate->'facts') where value->>'id'=fact_id;
     if fact is null then raise exception 'INVALID_SELECTION' using errcode='P0001'; end if;
     body:=body||(fact->>'text');
    end loop;
    if not public.pdd_insights_plain_text(to_jsonb(body),90) or (candidate->>'windowEnd')::timestamptz>r.observed_until or (candidate->>'windowEnd')::timestamptz>published then raise exception 'INVALID_SELECTION' using errcode='P0001'; end if;
    for key in select value from jsonb_array_elements_text(coalesce(candidate->'stableFactKeys','[]')) loop
     if key=any(used_keys) or exists(select 1 from public.pdd_insights_fact_ledger where fact_key=key) then raise exception 'ALREADY_ANNOUNCED_FACT' using errcode='P0001'; end if;
     used_keys:=array_append(used_keys,key);
    end loop;
    insert into public.pdd_insights_feed(run_id,candidate_id,topic,dedup_key,category,body,window_start,window_end,published_at)
     values(r.id,candidate->>'id',candidate->>'topic',candidate->>'dedupKey',headline->>'text',body,(candidate->>'windowStart')::timestamptz,(candidate->>'windowEnd')::timestamptz,published) returning id into feed_id;
    insert into public.pdd_insights_fact_ledger(fact_key,feed_id,created_at) select value,feed_id,published from jsonb_array_elements_text(coalesce(candidate->'stableFactKeys','[]'));
    used_ids:=array_append(used_ids,candidate->>'id');used_topics:=array_append(used_topics,candidate->>'topic');inserted:=inserted+1;
   end loop;
  exception when unique_violation then final_state:='rejected';failure:='ALREADY_ANNOUNCED_FACT';inserted:=0;
   when sqlstate 'P0001' then final_state:='rejected';failure:='INVALID_SELECTION';inserted:=0;
  end;
 end if;
 if final_state='unknown' then failure:='UNKNOWN_COST';v_usage:=null;amount:=null; end if;
 update public.pdd_insights_runs set state=final_state,finished_at=published,selection=case when final_state='completed' then p_payload->'selection' else null end,
  usage=v_usage,cost_usd=amount,cost_state=case when v_usage is null then 'unknown' else 'known' end,failure_code=failure where id=r.id;
 insert into public.pdd_insights_audit(run_id,action,payload) values(r.id,'insights_run_finished',jsonb_build_object('runId',r.id,'state',final_state,'publishedCount',inserted,'costState',case when v_usage is null then 'unknown' else 'known' end,'failureCode',failure));
 return jsonb_build_object('state',final_state,'publishedCount',inserted);
end$$;

create function public.pdd_insights_run_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' or old.state<>'reserved' or (to_jsonb(new)-array['state','cost_usd','cost_state','usage','selection','failure_code','finished_at']) is distinct from (to_jsonb(old)-array['state','cost_usd','cost_state','usage','selection','failure_code','finished_at']) then raise exception 'IMMUTABLE_HISTORY' using errcode='42501'; end if;
 return new;
end$$;
create trigger pdd_insights_run_immutable before update or delete on public.pdd_insights_runs for each row execute function public.pdd_insights_run_immutable();

create function public.pdd_insights_runtime(p_payload jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare secret text; model_key text; ledger_key text; settings public.pdd_insights_settings; begin
 if not public.pdd_content_keys(p_payload,array['worker_secret']) or coalesce(p_payload->>'worker_secret','')!~'^[0-9a-f]{64}$' or to_regclass('vault.decrypted_secrets') is null then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 select decrypted_secret into secret from vault.decrypted_secrets where name='pdd_insights_worker_secret' limit 1;
 if secret is null or extensions.digest(secret,'sha256')<>extensions.digest(p_payload->>'worker_secret','sha256') then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 select * into settings from public.pdd_insights_settings where id;
 if not settings.enabled then return jsonb_build_object('enabled',false,'model',settings.model,'promptVersion',settings.prompt_version,'dailyCallLimit',settings.daily_call_limit,'reservationUsd',settings.reservation_usd); end if;
 select decrypted_secret into model_key from vault.decrypted_secrets where name='pdd_insights_model_key' limit 1;
 select decrypted_secret into ledger_key from vault.decrypted_secrets where name='pdd_insights_ledger_key' limit 1;
 if model_key is null or (model_key!~'^sk-[A-Za-z0-9_-]+$' or length(model_key) not between 19 and 503) or ledger_key is null or ledger_key!~'^[0-9a-f]{64}$' then raise exception 'CONFIGURATION_INVALID' using errcode='P0001'; end if;
 return jsonb_build_object('enabled',true,'model',settings.model,'promptVersion',settings.prompt_version,'modelKey',model_key,'dailyCallLimit',settings.daily_call_limit,'reservationUsd',settings.reservation_usd);
end$$;
create function public.pdd_insights_configure_worker(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid; item record; secret_id uuid; ledger_key text; begin
 if not public.pdd_content_keys(p_payload,array['url','model_key','worker_secret','model','prompt_version','actor_id','enabled'])
  or p_payload->>'url' is distinct from 'https://fogncjjsnakbhfdbfvdi.supabase.co/functions/v1/insights-worker'
  or (coalesce(p_payload->>'model_key','')!~'^sk-[A-Za-z0-9_-]+$' or length(p_payload->>'model_key') not between 19 and 503) or coalesce(p_payload->>'worker_secret','')!~'^[0-9a-f]{64}$'
  or p_payload->>'model' is distinct from 'gpt-5.6-luna' or p_payload->>'prompt_version' is distinct from 'hourly-observation-v1' or jsonb_typeof(p_payload->'enabled') is distinct from 'boolean'
  or (p_payload->'actor_id'<>'null'::jsonb and coalesce(p_payload->>'actor_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 if to_regclass('vault.decrypted_secrets') is null or to_regprocedure('vault.create_secret(text,text,text)') is null or to_regprocedure('vault.update_secret(uuid,text,text,text)') is null then raise exception 'CONFIGURATION_INVALID' using errcode='P0001'; end if;
 perform pg_advisory_xact_lock(hashtextextended('pdd-insights-configuration',0));actor:=(p_payload->>'actor_id')::uuid;
 if exists(select 1 from vault.decrypted_secrets where name in ('pdd_insights_worker_url','pdd_insights_model_key','pdd_insights_worker_secret','pdd_insights_ledger_key') group by name having count(*)>1) then raise exception 'CONFIGURATION_INVALID' using errcode='P0001'; end if;
 select decrypted_secret into ledger_key from vault.decrypted_secrets where name='pdd_insights_ledger_key' limit 1;
 if ledger_key is null then
  if exists(select 1 from public.pdd_insights_fact_ledger) or exists(select 1 from public.pdd_insights_runs) then raise exception 'CONFIGURATION_INVALID' using errcode='P0001'; end if;
  perform vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'pdd_insights_ledger_key','Stable private insight fact identities');
 elsif ledger_key!~'^[0-9a-f]{64}$' then raise exception 'CONFIGURATION_INVALID' using errcode='P0001'; end if;
 for item in select * from (values('pdd_insights_worker_url',p_payload->>'url'),('pdd_insights_model_key',p_payload->>'model_key'),('pdd_insights_worker_secret',p_payload->>'worker_secret')) as secrets(name,value) loop
  select id into secret_id from vault.decrypted_secrets where name=item.name limit 1;
  if secret_id is null then perform vault.create_secret(item.value,item.name,'Private hourly observer runtime');
  else perform vault.update_secret(secret_id,item.value,item.name,'Private hourly observer runtime'); end if;
 end loop;
 update public.pdd_insights_settings set enabled=(p_payload->>'enabled')::boolean,model=p_payload->>'model',prompt_version=p_payload->>'prompt_version',configured_at=clock_timestamp(),actor_id=actor where id;
 insert into public.pdd_insights_audit(actor_id,action,payload) values(actor,'insights_worker_configured',jsonb_build_object('enabled',(p_payload->>'enabled')::boolean,'model',p_payload->>'model','promptVersion',p_payload->>'prompt_version','dailyCallLimit',24,'reservationUsd',0.01,'schedule','5 * * * *'));
 return jsonb_build_object('configured',true,'enabled',(p_payload->>'enabled')::boolean,'model',p_payload->>'model','promptVersion',p_payload->>'prompt_version','dailyCallLimit',24,'reservationUsd',0.01);
end$$;
create function public.pdd_insights_wake(p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare u text; secret text; request_id bigint; begin
 if p_payload is distinct from '{}'::jsonb then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 if not(select enabled from public.pdd_insights_settings where id) or to_regclass('vault.decrypted_secrets') is null then return '{"awakened":false}'; end if;
 select decrypted_secret into u from vault.decrypted_secrets where name='pdd_insights_worker_url' limit 1;
 select decrypted_secret into secret from vault.decrypted_secrets where name='pdd_insights_worker_secret' limit 1;
 if u is null or u<>'https://fogncjjsnakbhfdbfvdi.supabase.co/functions/v1/insights-worker' or secret is null or secret!~'^[0-9a-f]{64}$' then return '{"awakened":false}'; end if;
 select net.http_post(url:=u,headers:=jsonb_build_object('Content-Type','application/json','x-insights-secret',secret),body:='{}'::jsonb,timeout_milliseconds:=90000) into request_id;
 return jsonb_build_object('awakened',true,'requestId',request_id);
exception when others then return '{"awakened":false}';
end$$;
select cron.schedule('pdd404-hourly-insights-worker','5 * * * *','select public.pdd_insights_wake(''{}''::jsonb)');

-- Private preceding values for cooldown/strong-change checks; never a public DTO.
do $$declare definition text; anchor text; replacement text; begin
 definition:=pg_get_functiondef('public.pdd_hourly_source(jsonb)'::regprocedure);
 anchor:=$a$'recentObservations',(select coalesce(jsonb_agg(jsonb_build_object('topic',topic,'dedupKey',dedup_key,'publishedAt',published_at,'windowStart',window_start,'windowEnd',window_end) order by published_at desc,id desc),'[]') from(select * from public.pdd_insights_feed where published_at>=since_at order by published_at desc,id desc limit 100) recent)$a$;
 replacement:=$a$'recentObservations',(select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('candidateId',recent.candidate_id,'topic',recent.topic,'dedupKey',recent.dedup_key,'publishedAt',recent.published_at,'windowStart',recent.window_start,'windowEnd',recent.window_end,'windowId',candidate->'windowId','source',candidate->'source','definitionVersion',candidate->'definitionVersion','value',candidate->'value','direction',candidate->'direction')) order by recent.published_at desc,recent.id desc),'[]') from(select * from public.pdd_insights_feed where published_at>=since_at order by published_at desc,id desc limit 100) recent join public.pdd_insights_runs run on run.id=recent.run_id left join lateral(select value as candidate from jsonb_array_elements(run.candidates) where value->>'id'=recent.candidate_id) metadata on true)$a$;
 if strpos(definition,anchor)=0 then raise exception 'HOURLY_SOURCE_METADATA_CHANGED'; end if;
 execute replace(definition,anchor,replacement);
end$$;
do $$declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('pdd_insights_plain_text','pdd_insights_candidates_valid','pdd_insights_model_candidates','pdd_insights_input_valid','pdd_insights_reserve','pdd_insights_finish','pdd_insights_run_immutable','pdd_insights_runtime','pdd_insights_configure_worker','pdd_insights_wake') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end$$;
