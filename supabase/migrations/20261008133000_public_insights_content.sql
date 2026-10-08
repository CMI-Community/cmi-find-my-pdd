-- Public content contains approved aggregate prose only. Private drafts remain local.
-- Existing lifetime counters and anonymous telemetry are not changed.
create function public.pdd_content_keys(v jsonb, keys text[]) returns boolean language sql immutable set search_path='' as $$
 select coalesce(jsonb_typeof(v)='object' and v ?& keys and not exists(select 1 from jsonb_object_keys(v) k where not(k=any(keys))),false)
$$;
create function public.pdd_content_text(v jsonb, maximum integer) returns boolean language sql immutable set search_path='' as $$
 select coalesce(jsonb_typeof(v)='string' and char_length(btrim(v#>>'{}')) between 1 and maximum
  and (v#>>'{}') !~ E'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]',false)
$$;
create function public.pdd_content_timestamp(v jsonb) returns boolean language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(v) is distinct from 'string' or (v#>>'{}') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' then return false; end if;
 perform (v#>>'{}')::timestamptz; return true;
exception when others then return false;
end$$;
create function public.pdd_content_date(v text) returns boolean language plpgsql immutable set search_path='' as $$
begin
 return coalesce(v ~ '^\d{4}-\d{2}-\d{2}$' and to_char(v::date,'YYYY-MM-DD')=v,false);
exception when others then return false;
end$$;
create function public.pdd_content_asset_url(v jsonb) returns boolean language sql immutable set search_path='' as $$
 select coalesce(jsonb_typeof(v)='string' and (v#>>'{}') ~ '^https://[a-z]{20}\.supabase\.co/storage/v1/object/public/pdd-public-assets/[0-9a-f]{64}\.(png|jpg|jpeg|webp|mp4|pdf|zip)$',false)
$$;
create function public.pdd_content_source_url(v jsonb) returns boolean language sql immutable set search_path='' as $$
 select coalesce(public.pdd_content_text(v,2048) and (v#>>'{}') ~ '^https://[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(:443)?(/[^#[:space:]]*)?$'
  and lower(v#>>'{}') !~ '(\.supabase\.co[:/]|\.(local|internal|localhost)[:/]|/(m|rm|manage|admin|auth|api|functions|storage)(/|[?]|$)|[?&][^=&]*(token|capability|password|authorization|secret)[^=&]*=|[?&](cap|key)=|%2f|%5c)'
  and lower(v#>>'{}') !~ '^https://(www\.)?pdd404\.app/p/',false)
$$;
create function public.pdd_stats_six_valid(v jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare k text; begin
 if not public.pdd_content_keys(v,array['lostRegistered','receivedRegistered','matchedParcels','lostRecipientRegistered','receivedRecipientRegistered','matchedRecipientLeads']) then return false; end if;
 foreach k in array array['lostRegistered','receivedRegistered','matchedParcels','lostRecipientRegistered','receivedRecipientRegistered','matchedRecipientLeads'] loop
  if jsonb_typeof(v->k) is distinct from 'number' or (v->>k) !~ '^\d+$' or (v->>k)::numeric>9007199254740991 then return false; end if;
 end loop; return true;
end$$;
create function public.pdd_content_valid(kind text, v jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare item jsonb; f jsonb; field text; names text[]:='{}'; channels text[]; begin
 if kind='insight' then
  if not public.pdd_content_keys(v,array['date','title','summary','asOf','window','findings','newsIds','limitations'])
   or not public.pdd_content_date(v->>'date') or not public.pdd_content_text(v->'title',160)
   or not public.pdd_content_text(v->'summary',1200) or not public.pdd_content_timestamp(v->'asOf')
   or to_char((v->>'asOf')::timestamptz at time zone 'Asia/Bangkok','YYYY-MM-DD')<>v->>'date'
   or not public.pdd_content_text(v->'window',400) or jsonb_typeof(v->'findings') is distinct from 'array'
   or jsonb_array_length(v->'findings') not between 1 and 8 or jsonb_typeof(v->'newsIds') is distinct from 'array'
   or jsonb_array_length(v->'newsIds')>12 or jsonb_typeof(v->'limitations') is distinct from 'array' or jsonb_array_length(v->'limitations')>12 then return false; end if;
  for f in select value from jsonb_array_elements(v->'findings') loop
   if not public.pdd_content_keys(f,array['title','observed','interpretation','unknown','helpUrl'])
    or not public.pdd_content_text(f->'title',100) or not public.pdd_content_text(f->'observed',1200)
    or not public.pdd_content_text(f->'interpretation',1200) or not public.pdd_content_text(f->'unknown',800)
    or (f->'helpUrl'<>'null'::jsonb and (jsonb_typeof(f->'helpUrl') is distinct from 'string' or (f->>'helpUrl') !~ '^/(help)?(#[a-z][a-z0-9-]{0,63})?$')) then return false; end if;
  end loop;
  for item in select value from jsonb_array_elements(v->'newsIds') loop
   if jsonb_typeof(item) is distinct from 'string' or (item#>>'{}') !~ '^[a-z0-9][a-z0-9-]{0,63}$' or (item#>>'{}')=any(names) then return false; end if;
   names:=array_append(names,item#>>'{}');
  end loop;
  for item in select value from jsonb_array_elements(v->'limitations') loop if not public.pdd_content_text(item,800) then return false; end if; end loop;
  return true;
 elsif kind='outreach' then
  if not public.pdd_content_keys(v,array['items']) or jsonb_typeof(v->'items') is distinct from 'array' or jsonb_array_length(v->'items')>100 then return false; end if;
  for item in select value from jsonb_array_elements(v->'items') loop
   if not public.pdd_content_keys(item,array['id','kind','origin','title','summary','source','sourceUrl','publishedAt','checkedAt','channels','thumbnailUrl','downloadUrl','copyText'])
    or jsonb_typeof(item->'id') is distinct from 'string' or (item->>'id') !~ '^[a-z0-9][a-z0-9-]{0,63}$' or (item->>'id')=any(names)
    or coalesce(item->>'kind','') not in ('news','video','guide','comic','copy','image','pack') or coalesce(item->>'origin','') not in ('third-party','pdd404')
    or not public.pdd_content_text(item->'title',160) or not public.pdd_content_text(item->'summary',1000) or not public.pdd_content_text(item->'source',160)
    or (item->'sourceUrl'<>'null'::jsonb and not public.pdd_content_source_url(item->'sourceUrl'))
    or (item->'publishedAt'<>'null'::jsonb and not public.pdd_content_timestamp(item->'publishedAt'))
    or not public.pdd_content_timestamp(item->'checkedAt')
    or (item->'thumbnailUrl'<>'null'::jsonb and not public.pdd_content_asset_url(item->'thumbnailUrl'))
    or (item->'downloadUrl'<>'null'::jsonb and not public.pdd_content_asset_url(item->'downloadUrl'))
    or (item->'copyText'<>'null'::jsonb and not public.pdd_content_text(item->'copyText',4000))
    or jsonb_typeof(item->'channels') is distinct from 'array' or jsonb_array_length(item->'channels') not between 1 and 8
    or (item->>'origin'='third-party' and (item->'sourceUrl'='null'::jsonb or item->>'kind' not in ('news','video')))
    or (item->>'kind' in ('news','video','guide') and item->'sourceUrl'='null'::jsonb)
    or (item->>'kind'='copy' and item->'copyText'='null'::jsonb)
    or (item->>'kind' in ('comic','image','pack') and item->'downloadUrl'='null'::jsonb) then return false; end if;
   channels:='{}'; for f in select value from jsonb_array_elements(item->'channels') loop
    if not public.pdd_content_text(f,40) or (f#>>'{}')=any(channels) then return false; end if; channels:=array_append(channels,f#>>'{}');
   end loop;
   names:=array_append(names,item->>'id');
  end loop; return true;
 elsif kind='group' then
  return public.pdd_content_keys(v,array['title','invitation','qrUrl','qrUpdatedAt','expiresAt']) and public.pdd_content_text(v->'title',120)
   and public.pdd_content_text(v->'invitation',2000) and public.pdd_content_asset_url(v->'qrUrl') and (v->>'qrUrl') ~ '\.(png|jpg|jpeg|webp)$'
   and public.pdd_content_timestamp(v->'qrUpdatedAt') and (v->'expiresAt'='null'::jsonb or public.pdd_content_timestamp(v->'expiresAt'));
 end if;
 return false;
exception when others then return false;
end$$;

create table public.pdd_stats_daily (
 day date primary key, sampled_at timestamptz not null,
 metric_version text not null check(metric_version='home-six-lifetime-v1'),
 stats jsonb not null check(public.pdd_stats_six_valid(stats)),
 check(day=(sampled_at at time zone 'Asia/Bangkok')::date)
);
create table public.pdd_content_revisions (
 id uuid primary key default gen_random_uuid(), kind text not null check(kind in ('insight','outreach','group')),
 content_key text not null, revision integer not null check(revision>0), action text not null check(action in ('publish','withdraw')),
 payload jsonb, actor_id uuid not null, approval_artifact_sha text not null check(approval_artifact_sha ~ '^[0-9a-f]{64}$'),
 published_at timestamptz not null default now(), unique(kind,content_key,revision),
 check((kind='insight' and public.pdd_content_date(content_key)) or (kind='outreach' and content_key='main') or (kind='group' and content_key='developer')),
 check((action='withdraw' and payload is null) or (action='publish' and payload is not null and public.pdd_content_valid(kind,payload))),
 check(kind<>'insight' or action='withdraw' or payload->>'date'=content_key)
);
alter table public.pdd_stats_daily enable row level security;
alter table public.pdd_content_revisions enable row level security;
revoke all on public.pdd_stats_daily,public.pdd_content_revisions from public,anon,authenticated,service_role;
-- Writes go through transaction functions; even service_role cannot edit history.
grant select on public.pdd_stats_daily,public.pdd_content_revisions to service_role;
create function public.pdd_content_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'IMMUTABLE_HISTORY' using errcode='42501'; end$$;
create trigger pdd_stats_immutable before update or delete on public.pdd_stats_daily for each row execute function public.pdd_content_immutable();
create trigger pdd_content_immutable before update or delete on public.pdd_content_revisions for each row execute function public.pdd_content_immutable();

create function public.pdd_capture_stats_daily(p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare sampled timestamptz:=clock_timestamp(); d date; r public.pdd_stats_daily; counts jsonb; begin
 if p_payload is distinct from '{}'::jsonb then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 d:=(sampled at time zone 'Asia/Bangkok')::date;
 counts:=public.pdd_home_stats('{}');
 if not public.pdd_stats_six_valid(counts) then raise exception 'STATS_UNAVAILABLE'; end if;
 insert into public.pdd_stats_daily(day,sampled_at,metric_version,stats) values(d,sampled,'home-six-lifetime-v1',counts) on conflict(day) do nothing;
 select * into strict r from public.pdd_stats_daily where day=d;
 return jsonb_build_object('day',r.day,'sampledAt',r.sampled_at,'metricVersion',r.metric_version,'stats',r.stats);
end$$;
-- The hosted database schedule is UTC; verify cron.timezone before activation.
-- This task is independent of worker retention and the existing five-minute monitor.
select cron.schedule('pdd404-evening-public-stats','0 13 * * *','select public.pdd_capture_stats_daily(''{}''::jsonb)');

create function public.pdd_public_stats_history(p_payload jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path='' as $$
declare n integer:=30; result jsonb; begin
 if jsonb_typeof(p_payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k<>'days')
  or (p_payload ? 'days' and (jsonb_typeof(p_payload->'days') is distinct from 'number' or p_payload->>'days' !~ '^\d+$')) then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 n:=coalesce((p_payload->>'days')::integer,30); if n not between 1 and 90 then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('day',day,'sampledAt',sampled_at,'metricVersion',metric_version,'stats',stats) order by day),'[]') into result
 from public.pdd_stats_daily where day between (now() at time zone 'Asia/Bangkok')::date-n+1 and (now() at time zone 'Asia/Bangkok')::date;
 return jsonb_build_object('snapshots',result);
end$$;
create function public.pdd_content_public_version(r public.pdd_content_revisions) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('key',r.content_key,'revision',r.revision,'publishedAt',r.published_at,'content',r.payload)
$$;
create function public.pdd_public_insight_reports(p_payload jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path='' as $$
declare off integer:=0; result jsonb; total integer; selected_date text; begin
 if jsonb_typeof(p_payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('offset','date'))
  or (p_payload ? 'offset' and (jsonb_typeof(p_payload->'offset') is distinct from 'number' or p_payload->>'offset' !~ '^\d+$'))
  or (p_payload ? 'date' and (jsonb_typeof(p_payload->'date') is distinct from 'string' or not public.pdd_content_date(p_payload->>'date'))) then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 off:=coalesce((p_payload->>'offset')::integer,0); if off not between 0 and 100000 or (p_payload ? 'date' and off<>0) then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 selected_date:=p_payload->>'date';
 with latest as (select distinct on(content_key) * from public.pdd_content_revisions where kind='insight' order by content_key,revision desc),
 selected as (select * from latest where action='publish' and (selected_date is null or content_key=selected_date)),
 page as (select * from selected order by content_key desc offset off limit 20)
 select coalesce(jsonb_agg(public.pdd_content_public_version(page) order by content_key desc),'[]'),(select count(*) from selected) into result,total from page;
 return jsonb_build_object('reports',result,'nextOffset',case when total>off+20 then to_jsonb(off+20) else 'null'::jsonb end);
end$$;
create function public.pdd_public_outreach(p_payload jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path='' as $$
declare catalog public.pdd_content_revisions; grp public.pdd_content_revisions; begin
 if p_payload is distinct from '{}'::jsonb then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 select * into catalog from public.pdd_content_revisions where kind='outreach' and content_key='main' order by revision desc limit 1;
 select * into grp from public.pdd_content_revisions where kind='group' and content_key='developer' order by revision desc limit 1;
 return jsonb_build_object('catalog',case when catalog.action='publish' then public.pdd_content_public_version(catalog) else 'null'::jsonb end,
  'developerGroup',case when grp.action='publish' then public.pdd_content_public_version(grp) else 'null'::jsonb end);
end$$;
create function public.pdd_content_canonical(v jsonb) returns text language plpgsql immutable set search_path='' as $$
declare result text; begin
 if jsonb_typeof(v)='object' then
  select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||public.pdd_content_canonical(value),',' order by key collate "C"),'')||'}' into result from jsonb_each(v); return result;
 elsif jsonb_typeof(v)='array' then
  select '['||coalesce(string_agg(public.pdd_content_canonical(value),',' order by ord),'')||']' into result from jsonb_array_elements(v) with ordinality a(value,ord); return result;
 end if; return v::text;
end$$;
create function public.pdd_admin_publication_status(p_payload jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r public.pdd_content_revisions; k text; target_key text; begin
 if not public.pdd_content_keys(p_payload,array['kind','key']) or jsonb_typeof(p_payload->'kind') is distinct from 'string' or jsonb_typeof(p_payload->'key') is distinct from 'string' then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 k:=p_payload->>'kind'; target_key:=p_payload->>'key';
 if not ((k='insight' and public.pdd_content_date(target_key)) or (k='outreach' and target_key='main') or (k='group' and target_key='developer')) then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 select * into r from public.pdd_content_revisions c where c.kind=k and c.content_key=target_key order by revision desc limit 1;
 return jsonb_build_object('kind',k,'key',target_key,'revision',coalesce(r.revision,0),'action',r.action,'publishedAt',r.published_at,'approvalArtifactSha',r.approval_artifact_sha);
end$$;
create function public.pdd_publish_content(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare k text; v_content_key text; act text; expected integer; latest public.pdd_content_revisions; r public.pdd_content_revisions;
 approved text; calculated text; item jsonb; catalog public.pdd_content_revisions; begin
 if not public.pdd_content_keys(p_payload,array['kind','key','action','expected_revision','content','actor_id','approval_artifact_sha'])
  or jsonb_typeof(p_payload->'kind') is distinct from 'string' or p_payload->>'kind' not in ('insight','outreach','group')
  or jsonb_typeof(p_payload->'key') is distinct from 'string' or jsonb_typeof(p_payload->'action') is distinct from 'string' or p_payload->>'action' not in ('publish','withdraw')
  or jsonb_typeof(p_payload->'expected_revision') is distinct from 'number' or p_payload->>'expected_revision' !~ '^\d+$'
  or jsonb_typeof(p_payload->'actor_id') is distinct from 'string' or coalesce(p_payload->>'actor_id','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
  or jsonb_typeof(p_payload->'approval_artifact_sha') is distinct from 'string' or coalesce(p_payload->>'approval_artifact_sha','') !~ '^[0-9a-f]{64}$' then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 k:=p_payload->>'kind'; v_content_key:=p_payload->>'key'; act:=p_payload->>'action'; expected:=(p_payload->>'expected_revision')::integer; approved:=p_payload->>'approval_artifact_sha';
 if not ((k='insight' and public.pdd_content_date(v_content_key)) or (k='outreach' and v_content_key='main') or (k='group' and v_content_key='developer'))
  or (act='withdraw' and p_payload->'content'<>'null'::jsonb) or (act='publish' and not public.pdd_content_valid(k,p_payload->'content'))
  or (k='insight' and act='publish' and (p_payload->'content'->>'date'<>v_content_key or (p_payload->'content'->>'asOf')::timestamptz>now())) then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 calculated:=encode(extensions.digest(public.pdd_content_canonical(jsonb_build_object('kind',k,'key',v_content_key,'action',act,'expectedRevision',expected,'content',p_payload->'content')),'sha256'),'hex');
 if approved<>calculated then raise exception 'ARTIFACT_MISMATCH'; end if;
 -- Publishing a daily reference can only use an already approved shared source.
 perform pg_advisory_xact_lock(hashtext('pdd-publication'));
 select * into latest from public.pdd_content_revisions c where c.kind=k and c.content_key=v_content_key order by revision desc limit 1;
 if coalesce(latest.revision,0)<>expected then raise exception 'VERSION_CONFLICT'; end if;
 if act='withdraw' and latest.action is distinct from 'publish' then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 if act='publish' and k='insight' then
  select * into catalog from public.pdd_content_revisions c where c.kind='outreach' and c.content_key='main' order by revision desc limit 1;
  for item in select value from jsonb_array_elements(p_payload->'content'->'newsIds') loop
   if catalog.action is distinct from 'publish' or not exists(select 1 from jsonb_array_elements(catalog.payload->'items') i where i->>'id'=item#>>'{}' and i->>'kind' in ('news','video') and i->>'origin'='third-party') then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  end loop;
 elsif act='publish' and k='outreach' then
  for item in select value from jsonb_array_elements(p_payload->'content'->'items') loop if (item->>'checkedAt')::timestamptz>now() then raise exception 'INVALID_REQUEST' using errcode='22023'; end if; end loop;
 elsif act='publish' and k='group' and (p_payload->'content'->>'qrUpdatedAt')::timestamptz>now() then raise exception 'INVALID_REQUEST' using errcode='22023';
 end if;
 insert into public.pdd_content_revisions(kind,content_key,revision,action,payload,actor_id,approval_artifact_sha)
 values(k,v_content_key,expected+1,act,case when act='withdraw' then null else p_payload->'content' end,(p_payload->>'actor_id')::uuid,approved) returning * into r;
 return jsonb_build_object('kind',r.kind,'key',r.content_key,'revision',r.revision,'action',r.action,'publishedAt',r.published_at,'approvalArtifactSha',r.approval_artifact_sha);
end$$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('pdd-public-assets','pdd-public-assets',true,5242880,array['image/png','image/jpeg','image/webp','application/zip']) on conflict(id) do nothing;
-- No client Storage write policies. The administrator upload adapter is service-only,
-- validates the reviewed byte hash and always uploads with upsert:false.
do $$declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
  and p.proname in ('pdd_content_keys','pdd_content_text','pdd_content_timestamp','pdd_content_date','pdd_content_asset_url','pdd_content_source_url','pdd_stats_six_valid','pdd_content_valid','pdd_content_immutable','pdd_capture_stats_daily','pdd_public_stats_history','pdd_content_public_version','pdd_public_insight_reports','pdd_public_outreach','pdd_content_canonical','pdd_admin_publication_status','pdd_publish_content') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end$$;
