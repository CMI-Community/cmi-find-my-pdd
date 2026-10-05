-- CMI Find My PDD: all browser access goes through authenticated API functions.
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create table public.scans (
 id uuid primary key default gen_random_uuid(), intent text not null check(intent in ('received','search')),
 capability_hash text not null, initial_request_hash text not null default '', input_version integer not null default 1 check(input_version>0),
 environment text not null default 'prod' check(environment in ('prod','test')),
 state text not null default 'draft' check(state in ('draft','queued','running','succeeded','needs_photo','deferred','failed','cancelled')),
 quality text check(quality in ('complete','partial','unusable')), extraction jsonb, suggested_matches jsonb not null default '[]',
 selected_identifier_id text, error_code text, created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '24 hours'
);
create table public.images (
 id uuid primary key, scan_id uuid not null references public.scans(id), version integer not null,
 role text not null check(role in ('label','item','logistics','product')), path text not null unique,
 mime text not null default 'image/jpeg', size bigint not null default 0 check(size>=0), width integer, height integer,
 upload_state text not null default 'reserved' check(upload_state in ('reserved','uploaded','deleting')),
 created_at timestamptz not null default now(), unique(scan_id,version,role)
);
create table public.records (
 id uuid primary key default gen_random_uuid(), scan_id uuid not null unique references public.scans(id),
 public_code text not null unique default 'CMI-'||upper(encode(extensions.gen_random_bytes(5),'hex')),
 kind text not null check(kind in ('received','tracking')), image_version integer not null,
 revision integer not null default 1, contact jsonb not null,
 visibility text not null default 'pending' check(visibility in ('pending','active','withdrawn')),
 resolution text not null default 'open' check(resolution in ('open','verifying','claimed','resolved')),
 duplicate_of uuid references public.records(id), claimed_match_id uuid, claimed_followup_id uuid, public_title text not null default '待核实包裹',
 approved_image_path text, image_approved boolean not null default false, created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(), closed_at timestamptz
);
create table public.evidence (
 id uuid primary key default gen_random_uuid(), scan_id uuid not null references public.scans(id), version integer not null,
 identifier_id text not null, type text not null check(type in ('domestic_waybill','consolidation_waybill','last_mile_waybill','order_id','unknown_id')),
 value text not null, carrier text, complete boolean not null, clear boolean not null, shared boolean not null,
 source_image_id uuid not null references public.images(id), unique(scan_id,version,identifier_id)
);
create index evidence_lookup on public.evidence(type,value) where complete and clear;
create table public.jobs (
 id uuid primary key default gen_random_uuid(), scan_id uuid not null references public.scans(id), version integer not null,
 status text not null default 'pending' check(status in ('pending','leased','completed','failed','cancelled')),
 attempts integer not null default 0 check(attempts between 0 and 3), next_run_at timestamptz not null default now(),
 lease_token uuid, lease_expires_at timestamptz, error_code text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(scan_id,version)
);
create index jobs_available on public.jobs(next_run_at) where status in ('pending','leased');
create table public.matches (
 id uuid primary key default gen_random_uuid(), received_id uuid not null references public.records(id),
 tracking_id uuid not null references public.records(id), received_version integer not null, tracking_version integer not null,
 kind text not null check(kind in ('exact','possible')), reasons jsonb not null default '[]',
 state text not null default 'candidate' check(state in ('candidate','verified','rejected','invalidated','closed')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(received_id,tracking_id)
);
create table public.followups (
 id uuid primary key default gen_random_uuid(), match_id uuid unique references public.matches(id),
 received_record_id uuid references public.records(id), tracking_record_id uuid references public.records(id),
 kind text check(kind in ('exact','possible')), reasons jsonb not null default '[]',
 state text not null default 'needs_review' check(state in ('needs_review','ready_to_contact','contacting','awaiting_handover','closed')),
 received_contacted_at timestamptz, tracking_contacted_at timestamptz, notes text not null default '',
 updated_at timestamptz not null default now()
);
create table public.handovers (
 id uuid primary key default gen_random_uuid(), match_id uuid unique references public.matches(id), followup_id uuid unique references public.followups(id),
 received_id uuid not null unique references public.records(id), actor_id uuid not null,
 created_at timestamptz not null default now()
);
create unique index followups_manual_once on public.followups(received_record_id) where match_id is null;
create table public.daily_budgets (
 day date not null, environment text not null check(environment in ('prod','test')),
 reserved numeric(12,8) not null default 0, spent numeric(12,8) not null default 0,
 primary key(day,environment), check(reserved>=0 and spent>=0)
);
create table public.budget_reservations (
 id uuid primary key default gen_random_uuid(), job_id uuid not null references public.jobs(id),
 lease_token uuid not null, attempt integer not null, day date not null, environment text not null,
 amount numeric(12,8) not null default .02, actual numeric(12,8), input_tokens integer, output_tokens integer,
 state text not null default 'reserved' check(state in ('reserved','settled','unknown')),
 created_at timestamptz not null default now(), unique(job_id,attempt), unique(job_id,lease_token)
);
create table public.idempotency_keys (
 scope text not null, key text not null, body_hash text not null, response jsonb not null,
 created_at timestamptz not null default now(), primary key(scope,key)
);
create table public.rate_limits (
 key text not null, window_start timestamptz not null, count integer not null,
 primary key(key,window_start)
);
create table public.site_settings (key text primary key, value jsonb not null default '{}', updated_at timestamptz not null default now());
insert into public.site_settings(key,value) values('community','{"submissionsEnabled":false,"ready":false}');
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('parcel-originals','parcel-originals',false,5242880,array['image/jpeg','image/png','image/webp']),
 ('parcel-public','parcel-public',false,5242880,array['image/jpeg','image/png','image/webp'])
 on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create table public.audit_events (
 id uuid primary key default gen_random_uuid(), actor_id uuid not null, action text not null,
 record_id uuid, match_id uuid, payload jsonb not null default '{}', created_at timestamptz not null default now()
);

-- No direct table access for end users, including authenticated non-admin accounts.
do $$declare t text; begin
 foreach t in array array['scans','images','records','evidence','jobs','matches','followups','handovers','daily_budgets','budget_reservations','idempotency_keys','rate_limits','site_settings','audit_events'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon, authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end$$;

create function public.cmi_contact_valid(c jsonb) returns boolean language sql immutable as $$
 select c is not null and length(trim(coalesce(c->>'wechat',''))) between 1 and 64
 and coalesce((c->>'groupDeclaration')::boolean,false)
 and length(coalesce(c->>'other',''))<=256
$$;

create function public.cmi_record_snapshot(r public.records) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('code',r.public_code,'kind',r.kind,
  'title',r.public_title,'image_approved',r.image_approved,
  'recipientHint',case when length(s.extraction->>'recipientName')>0 then left(s.extraction->>'recipientName',1)||'＊' else null end,
  'identifiers',coalesce((select jsonb_agg(jsonb_build_object('type',e.type,'tail',right(e.value,4))) from public.evidence e where e.scan_id=s.id and e.version=s.input_version),'[]'),
  'quality',s.quality,'resolution',r.resolution,'visibility',r.visibility,'updatedAt',r.updated_at)
 from public.scans s where s.id=r.scan_id
$$;

create function public.wake_worker(p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare u text; secret text; request_id bigint;
begin
 if to_regclass('vault.decrypted_secrets') is null then return '{"awakened":false}'; end if;
 select decrypted_secret into u from vault.decrypted_secrets where name='cmi_worker_url' limit 1;
 select decrypted_secret into secret from vault.decrypted_secrets where name='cmi_worker_secret' limit 1;
 if u is null or secret is null then return '{"awakened":false}'; end if;
 select net.http_post(url:=u, headers:=jsonb_build_object('Content-Type','application/json','x-worker-secret',secret),body:='{}'::jsonb,timeout_milliseconds:=5000) into request_id;
 return jsonb_build_object('awakened',true,'requestId',request_id);
exception when others then
 -- The committed job remains the source of truth if immediate wake-up fails.
 return '{"awakened":false}';
end$$;

create function public.create_scan(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.scans; v_id uuid:=coalesce((p_payload->>'id')::uuid,gen_random_uuid()); v_intent text:=coalesce(p_payload->>'intent',p_payload->>'kind');
begin
 if v_intent not in ('received','search') or length(coalesce(p_payload->>'capability_hash',''))<>64 then raise exception 'INVALID_SCAN' using errcode='22023'; end if;
 insert into public.scans(id,intent,capability_hash,initial_request_hash,environment) values(v_id,v_intent,p_payload->>'capability_hash',coalesce(p_payload->>'initial_request_hash',''),coalesce(p_payload->>'environment','prod')) on conflict(id) do nothing;
 select * into s from public.scans where id=v_id;
 if s.capability_hash<>p_payload->>'capability_hash' or s.intent<>v_intent then raise exception 'REQUEST_ID_CONFLICT' using errcode='23505'; end if;
 if s.initial_request_hash<>coalesce(p_payload->>'initial_request_hash','') then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='23505'; end if;
 return jsonb_build_object('ok',true,'id',s.id,'scanId',s.id,'version',s.input_version,'imageVersion',s.input_version,'state',s.state);
end$$;

create function public.reserve_images(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.scans; i jsonb; n integer; paths jsonb:='[]'; expected_prefix text;
begin
 select * into s from public.scans where id=(p_payload->>'scan_id')::uuid for update;
 if not found or s.state<>'draft' or s.input_version<>(p_payload->>'version')::integer then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
 n:=jsonb_array_length(p_payload->'images');
 if n not between 1 and 2 then raise exception 'INVALID_IMAGE_COUNT' using errcode='22023'; end if;
 expected_prefix:=s.id||'/'||s.input_version||'/';
 for i in select * from jsonb_array_elements(p_payload->'images') loop
  if left(i->>'path',length(expected_prefix))<>expected_prefix or position('..' in (i->>'path'))>0 then raise exception 'INVALID_IMAGE_PATH' using errcode='22023'; end if;
  if (s.intent='received' and i->>'role' not in ('label','item')) or (s.intent='search' and i->>'role' not in ('logistics','product')) then raise exception 'INVALID_IMAGE_ROLE' using errcode='22023'; end if;
  insert into public.images(id,scan_id,version,role,path,mime,size,width,height)
   values((i->>'id')::uuid,s.id,s.input_version,i->>'role',i->>'path',coalesce(i->>'mime','image/jpeg'),coalesce((i->>'size')::bigint,0),(i->>'width')::integer,(i->>'height')::integer)
   on conflict(scan_id,version,role) do nothing;
 end loop;
 if (select count(*) from public.images where scan_id=s.id and version=s.input_version)>2 then raise exception 'INVALID_IMAGE_COUNT' using errcode='22023'; end if;
 select coalesce(jsonb_agg(to_jsonb(im)),'[]') into paths from public.images im where scan_id=s.id and version=s.input_version;
 return jsonb_build_object('ok',true,'images',paths,'version',s.input_version);
end$$;

create function public.finalize_scan(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.scans; r public.records; j public.jobs; i jsonb; answer jsonb; prior public.idempotency_keys;
begin
 perform pg_advisory_xact_lock(hashtext('cmi-job-slots'));
 select * into s from public.scans where id=(p_payload->>'scan_id')::uuid for update;
 if not found then raise exception 'SCAN_NOT_FOUND' using errcode='22023'; end if;
 select * into prior from public.idempotency_keys where scope='finalize:'||s.id and key=p_payload->>'idempotency_key';
 if found then
  if prior.body_hash<>p_payload->>'body_hash' then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='23505'; end if;
  return prior.response;
 end if;
 if s.input_version<>(p_payload->>'version')::integer or s.state<>'draft' then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
 if s.intent='received' and not public.cmi_contact_valid(p_payload->'contact') then raise exception 'CONTACT_REQUIRED' using errcode='22023'; end if;
 for i in select * from jsonb_array_elements(coalesce(p_payload->'images','[]')) loop
  if (i->>'size')::bigint not between 1 and 5242880 or i->>'mime' not in ('image/jpeg','image/png','image/webp') or (i->>'width')::integer not between 1 and 2048 or (i->>'height')::integer not between 1 and 2048 then raise exception 'INVALID_IMAGE' using errcode='22023'; end if;
  update public.images set upload_state='uploaded',mime=i->>'mime',size=(i->>'size')::bigint,width=(i->>'width')::integer,height=(i->>'height')::integer where id=(i->>'id')::uuid and scan_id=s.id and version=s.input_version;
  if not found then raise exception 'IMAGE_NOT_RESERVED' using errcode='22023'; end if;
 end loop;
 if (select count(*) from public.images where scan_id=s.id and version=s.input_version and upload_state='uploaded') not between 1 and 2 then raise exception 'IMAGE_REQUIRED' using errcode='22023'; end if;
 if not exists(select 1 from public.images where scan_id=s.id and version=s.input_version and upload_state='uploaded' and role=case when s.intent='received' then 'label' else 'logistics' end) then raise exception 'LABEL_REQUIRED' using errcode='22023'; end if;
 update public.scans set state='queued',updated_at=now(),error_code=null where id=s.id;
 if s.intent='received' then
  insert into public.records(scan_id,kind,image_version,contact) values(s.id,'received',s.input_version,p_payload->'contact')
  on conflict(scan_id) do update set image_version=excluded.image_version,contact=excluded.contact,visibility='pending',updated_at=now() returning * into r;
 end if;
 insert into public.jobs(scan_id,version) values(s.id,s.input_version) returning * into j;
 answer:=jsonb_build_object('ok',true,'scanId',s.id,'version',s.input_version,'state','queued','publicCode',r.public_code,'jobId',j.id);
 insert into public.idempotency_keys(scope,key,body_hash,response) values('finalize:'||s.id,p_payload->>'idempotency_key',p_payload->>'body_hash',answer);
 perform public.wake_worker('{}');
 return answer;
end$$;

create function public.revise_scan(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.scans; r public.records;
begin
 perform pg_advisory_xact_lock(hashtext('cmi-job-slots'));
 select * into s from public.scans where id=(p_payload->>'scan_id')::uuid for update;
 if not found or s.input_version<>(p_payload->>'version')::integer or s.state='cancelled' then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
 select * into r from public.records where scan_id=s.id;
 if found and r.resolution in ('claimed','resolved') then raise exception 'RECORD_CLOSED' using errcode='40001'; end if;
 update public.jobs set status='cancelled',updated_at=now() where scan_id=s.id and status in ('pending','leased');
 update public.matches set state='invalidated',updated_at=now() where received_id=r.id or tracking_id=r.id;
 update public.followups set state='closed',updated_at=now() where received_record_id=r.id or tracking_record_id=r.id;
 update public.records set image_version=s.input_version+1,revision=revision+1,visibility='pending',resolution='open',image_approved=false,updated_at=now() where scan_id=s.id;
 update public.scans set input_version=input_version+1,state='draft',quality=null,extraction=null,suggested_matches='[]',selected_identifier_id=null,error_code=null,updated_at=now() where id=s.id returning * into s;
 return jsonb_build_object('ok',true,'scanId',s.id,'version',s.input_version,'imageVersion',s.input_version,'state','draft');
end$$;

create function public.cancel_scan(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.scans; rid uuid;
begin
 perform pg_advisory_xact_lock(hashtext('cmi-job-slots'));
 select * into s from public.scans where id=(p_payload->>'scan_id')::uuid for update;
 if not found or s.input_version<>(p_payload->>'version')::integer then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
 update public.scans set state='cancelled',updated_at=now(),expires_at=least(expires_at,now()) where id=s.id;
 update public.jobs set status='cancelled',updated_at=now() where scan_id=s.id and status in ('pending','leased');
 update public.records set visibility='withdrawn',closed_at=coalesce(closed_at,now()),updated_at=now() where scan_id=s.id returning id into rid;
 update public.matches set state='invalidated',updated_at=now() where received_id=rid or tracking_id=rid;
 update public.followups set state='closed',updated_at=now() where received_record_id=rid or tracking_record_id=rid;
 return '{"ok":true,"state":"cancelled"}';
end$$;

create function public.cmi_clean(t text) returns text language sql immutable set search_path='' as $$
 select lower(normalize(trim(coalesce(t,'')),NFKC))
$$;
create function public.cmi_specific(t text) returns boolean language sql immutable set search_path='' as $$
 select length(public.cmi_clean(t))>=2 and public.cmi_clean(t) not in
 ('日用品','用品','商品','物品','包裹','其他','快递','生活用品','家居','衣服','服装','食品','unknown','item','package')
$$;
create function public.cmi_number(t text) returns text language sql immutable set search_path='' as $$
 select upper(translate(regexp_replace(coalesce(t,''),'[[:space:]]','','g'),U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF',''))
$$;
create function public.cmi_individual(n jsonb) returns boolean language sql immutable set search_path='' as $$
 select n->>'type' in ('domestic_waybill','last_mile_waybill','consolidation_waybill')
 and not coalesce((n->>'shared')::boolean,true) and coalesce((n->>'clear')::boolean,false) and coalesce((n->>'complete')::boolean,false)
 and length(regexp_replace(public.cmi_number(n->>'value'),'[^A-Z0-9]','','g'))>=6 and n->>'value' !~ '[*?]'
$$;
create function public.cmi_quality(e jsonb) returns text language plpgsql immutable set search_path='' as $$
begin
 if not coalesce((e->>'validImage')::boolean,false) then return 'unusable'; end if;
 if exists(select 1 from jsonb_array_elements(coalesce(e->'identifiers','[]')) it where public.cmi_individual(it)) then return 'complete'; end if;
 if length(coalesce(e->>'recipientName',''))>0
 or exists(select 1 from jsonb_array_elements(coalesce(e->'identifiers','[]')) it where length(regexp_replace(public.cmi_number(it->>'value'),'[^A-Z0-9]','','g'))>=4)
 or exists(select 1 from jsonb_array_elements_text(coalesce(e->'itemNames','[]')) it where public.cmi_specific(it))
 or (select count(*) from jsonb_array_elements_text(coalesce(e->'tags','[]')) it where public.cmi_specific(it))>=2 then return 'partial'; end if;
 return 'unusable';
end$$;
-- Deliberately mirrors shared/domain.ts. See the SQL/TypeScript parity tests.
create function public.cmi_compare_extractions(a jsonb,b jsonb) returns jsonb language plpgsql immutable set search_path='' as $$
declare x jsonb; y jsonb; xv text; yv text; exact_weak boolean:=false; tails boolean:=false;
 name_same boolean; item_same boolean; tag_count integer; reasons jsonb:='[]'; ranking integer;
begin
 if public.cmi_quality(a)='unusable' or public.cmi_quality(b)='unusable' then return null; end if;
 for x in select value from jsonb_array_elements(coalesce(a->'identifiers','[]')) loop
  xv:=public.cmi_number(x->>'value');
  if length(regexp_replace(xv,'[^A-Z0-9]','','g'))<4 then continue; end if;
  for y in select value from jsonb_array_elements(coalesce(b->'identifiers','[]')) loop
   yv:=public.cmi_number(y->>'value');
   if length(regexp_replace(yv,'[^A-Z0-9]','','g'))<4 or x->>'type'<>y->>'type' then continue; end if;
   if length(coalesce(x->>'carrier',''))>0 and length(coalesce(y->>'carrier',''))>0 and public.cmi_clean(x->>'carrier')<>public.cmi_clean(y->>'carrier') then continue; end if;
   if public.cmi_individual(x) and public.cmi_individual(y) and xv=yv then return jsonb_build_object('kind','exact','reasons',jsonb_build_array('完整同类型包裹运单号一致'),'rank',100); end if;
   if coalesce((x->>'clear')::boolean,false) and coalesce((y->>'clear')::boolean,false) and xv=yv and x->>'type'<>'unknown_id' then exact_weak:=true; end if;
   if x->>'type' not in ('order_id','unknown_id') and length(regexp_replace(xv,'[*?]','','g'))>=4 and length(regexp_replace(yv,'[*?]','','g'))>=4 and right(xv,4)=right(yv,4) and right(xv,4)!~'[*?]' then tails:=true; end if;
  end loop;
 end loop;
 name_same:=length(coalesce(a->>'recipientName',''))>0 and length(coalesce(b->>'recipientName',''))>0 and public.cmi_clean(a->>'recipientName')=public.cmi_clean(b->>'recipientName');
 select exists(select 1 from jsonb_array_elements_text(coalesce(a->'itemNames','[]')) ai cross join jsonb_array_elements_text(coalesce(b->'itemNames','[]')) bi where public.cmi_specific(ai) and public.cmi_specific(bi) and public.cmi_clean(ai)=public.cmi_clean(bi)) into item_same;
 select count(distinct public.cmi_clean(atag)) into tag_count from jsonb_array_elements_text(coalesce(a->'tags','[]')) atag cross join jsonb_array_elements_text(coalesce(b->'tags','[]')) btag where public.cmi_specific(atag) and public.cmi_specific(btag) and public.cmi_clean(atag)=public.cmi_clean(btag);
 if exact_weak then reasons:=reasons||jsonb_build_array('相同的订单或集运线索，需要核实独立包裹'); end if;
 if name_same then reasons:=reasons||jsonb_build_array('收件线索相同'); end if;
 if item_same then reasons:=reasons||jsonb_build_array('具体物品名称相同'); end if;
 if tag_count>=2 then reasons:=reasons||jsonb_build_array('多个具体物品标签相符'); end if;
 if tails and (name_same or item_same or tag_count>=2 or exact_weak) then reasons:=reasons||jsonb_build_array('同类型号码尾号及其他线索相符'); end if;
 if jsonb_array_length(reasons)=0 then return null; end if;
 ranking:=case when exact_weak or (tails and jsonb_array_length(reasons)>=2) then 80 when name_same and (item_same or tag_count>=2) then 60 else 40 end;
 return jsonb_build_object('kind','possible','reasons',reasons,'rank',ranking);
end$$;

-- Matching is evaluated dynamically; an earlier OCR snapshot cannot hide later submissions.
create function public.match_scan(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.scans; own public.records; target public.records; ts public.scans;
 results jsonb:='[]'; choice text; comparison jsonb; source_extraction jsonb; target_extraction jsonb;
 mid uuid; count_eligible integer; offset_value integer:=greatest(0,least(100000,coalesce((p_payload->>'offset')::integer,0))); total integer;
begin
 perform pg_advisory_xact_lock(hashtext('cmi-job-slots'));
 select * into s from public.scans where id=(p_payload->>'scan_id')::uuid for update;
 if not found or s.input_version<>(p_payload->>'version')::integer then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
 if s.state<>'succeeded' or s.quality='unusable' then return jsonb_build_object('ok',true,'results','[]'::jsonb,'requiresSelection',false); end if;
 choice:=coalesce(p_payload->>'selected_evidence_id',s.selected_identifier_id);
 select count(distinct(type,value)) into count_eligible from public.evidence where scan_id=s.id and version=s.input_version and type in ('domestic_waybill','consolidation_waybill','last_mile_waybill');
 if choice is not null and not exists(select 1 from public.evidence where scan_id=s.id and version=s.input_version and identifier_id=choice) then raise exception 'INVALID_SELECTION' using errcode='22023'; end if;
 if s.intent='search' and count_eligible>1 and choice is null then return jsonb_build_object('ok',true,'results','[]'::jsonb,'requiresSelection',true); end if;
 if choice is not null then update public.scans set selected_identifier_id=choice where id=s.id; end if;
 select * into own from public.records where scan_id=s.id and visibility='active';
 source_extraction:=s.extraction;
 if choice is not null then source_extraction:=jsonb_set(source_extraction,'{identifiers}',coalesce((select jsonb_agg(it) from jsonb_array_elements(source_extraction->'identifiers') it where it->>'id'=choice),'[]')); end if;
 for target in select r.* from public.records r where r.scan_id<>s.id and r.visibility='active' and r.kind=case when s.intent='search' then 'received' else 'tracking' end
  and (r.resolution in ('open','verifying') or (r.resolution='claimed' and own.id is not null and exists(select 1 from public.matches mm where mm.state='verified' and mm.received_id in (own.id,r.id) and mm.tracking_id in (own.id,r.id)))) loop
  if own.id is not null and exists(select 1 from public.matches mt where mt.state='rejected'
   and mt.received_id=case when own.kind='received' then own.id else target.id end and mt.tracking_id=case when own.kind='tracking' then own.id else target.id end
   and mt.received_version=case when own.kind='received' then own.image_version else target.image_version end and mt.tracking_version=case when own.kind='tracking' then own.image_version else target.image_version end) then continue; end if;
  select * into ts from public.scans where id=target.scan_id;
  if ts.state<>'succeeded' or ts.input_version<>target.image_version then continue; end if;
  target_extraction:=ts.extraction;
  if ts.selected_identifier_id is not null then target_extraction:=jsonb_set(target_extraction,'{identifiers}',coalesce((select jsonb_agg(it) from jsonb_array_elements(target_extraction->'identifiers') it where it->>'id'=ts.selected_identifier_id),'[]')); end if;
  comparison:=public.cmi_compare_extractions(source_extraction,target_extraction);
  if comparison is null then continue; end if;
  results:=results||jsonb_build_array(jsonb_build_object('record',public.cmi_record_snapshot(target),'kind',comparison->>'kind','reasons',comparison->'reasons','rank',comparison->'rank'));
  if own.id is not null then
   insert into public.matches(received_id,tracking_id,received_version,tracking_version,kind,reasons)
    values(case when own.kind='received' then own.id else target.id end,case when own.kind='tracking' then own.id else target.id end,
      case when own.kind='received' then own.image_version else target.image_version end,case when own.kind='tracking' then own.image_version else target.image_version end,comparison->>'kind',comparison->'reasons')
    on conflict(received_id,tracking_id) do update set received_version=excluded.received_version,tracking_version=excluded.tracking_version,kind=excluded.kind,reasons=excluded.reasons,
      state=case when public.matches.state='invalidated' then 'candidate' else public.matches.state end,updated_at=now()
    where (public.matches.received_version,public.matches.tracking_version,public.matches.kind,public.matches.reasons,public.matches.state='invalidated')
     is distinct from (excluded.received_version,excluded.tracking_version,excluded.kind,excluded.reasons,false) returning id into mid;
   if mid is null then select mt.id into mid from public.matches mt where mt.received_id=case when own.kind='received' then own.id else target.id end and mt.tracking_id=case when own.kind='tracking' then own.id else target.id end; end if;
   insert into public.followups(match_id,received_record_id,tracking_record_id,kind,reasons) select mt.id,mt.received_id,mt.tracking_id,mt.kind,mt.reasons from public.matches mt where mt.id=mid and mt.state='candidate'
    on conflict(match_id) do update set kind=excluded.kind,reasons=excluded.reasons,
     state=case when public.followups.state='closed' then 'needs_review' else public.followups.state end,updated_at=now()
     where public.followups.kind is distinct from excluded.kind or public.followups.reasons is distinct from excluded.reasons or public.followups.state='closed';
  end if;
 end loop;
 total:=jsonb_array_length(results);
 select coalesce(jsonb_agg(item),'[]') into results from (select it item from jsonb_array_elements(results) it order by (it->>'rank')::integer desc,it->'record'->>'updatedAt' desc,it->'record'->>'code' limit 20 offset offset_value) page;
 return jsonb_build_object('ok',true,'results',results,'requiresSelection',false,'selectedIdentifierId',choice,'totalMatches',total,'nextOffset',case when offset_value+20<total then offset_value+20 else null end);
end$$;

create function public.matching_candidates(p_payload jsonb) returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(c)),'[]') from (
  select r.id,r.scan_id,r.image_version,r.kind,case when s.selected_identifier_id is null then s.extraction else jsonb_set(s.extraction,'{identifiers}',
   coalesce((select jsonb_agg(i) from jsonb_array_elements(s.extraction->'identifiers') i where i->>'id'=s.selected_identifier_id),'[]')) end extraction from public.records r join public.scans s on s.id=r.scan_id
  where r.visibility='active' and r.resolution in ('open','verifying') and s.state='succeeded' and r.image_version=s.input_version
   and r.scan_id<>(p_payload->>'scan_id')::uuid and r.kind=case when p_payload->>'intent'='received' then 'tracking' else 'received' end
  order by r.updated_at desc limit 1000
 ) c
$$;

create function public.public_stats(p_payload jsonb default '{}') returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object(
  'recordedPackageCount',(select count(*) from public.records where kind='received' and visibility='active' and duplicate_of is null),
  'activeSeekerCount',(select count(distinct lower(trim(contact->>'wechat'))) from public.records where kind='tracking' and visibility='active' and resolution in ('open','verifying','claimed') and duplicate_of is null),
  'successfulHandoverCount',case when (select count(*) from public.handovers)>5 then (select count(*) from public.handovers) else null end)
$$;

create function public.update_contact(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.records;
begin
 select * into r from public.records where scan_id=(p_payload->>'scan_id')::uuid for update;
 if not found or r.revision<>(p_payload->>'revision')::integer or r.visibility='withdrawn' then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
 if not public.cmi_contact_valid(p_payload->'contact') then raise exception 'CONTACT_REQUIRED' using errcode='22023'; end if;
 update public.records set contact=p_payload->'contact',revision=revision+1,updated_at=now() where id=r.id returning * into r;
 return jsonb_build_object('ok',true,'revision',r.revision);
end$$;

create function public.retry_scan(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.scans; j public.jobs;
begin
 perform pg_advisory_xact_lock(hashtext('cmi-job-slots'));
 select * into s from public.scans where id=(p_payload->>'scan_id')::uuid for update;
 if not found or s.input_version<>(p_payload->>'version')::integer or s.state not in ('failed','deferred')
 or exists(select 1 from public.records where scan_id=s.id and visibility='withdrawn') then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
 select * into j from public.jobs where scan_id=s.id and version=s.input_version for update;
 if j.attempts>=3 then raise exception 'NEEDS_PHOTO' using errcode='22023'; end if;
 if s.error_code in ('CONFIGURATION_ERROR','OPENAI_AUTH_ERROR','INVALID_EXTRACTION','IMAGE_UNAVAILABLE') then raise exception 'NEEDS_PHOTO' using errcode='22023'; end if;
 update public.jobs set status='pending',next_run_at=now(),lease_token=null,lease_expires_at=null,updated_at=now() where id=j.id;
 update public.scans set state='queued',error_code=null,updated_at=now() where id=s.id;
 perform public.wake_worker('{}');
 return '{"ok":true,"state":"queued"}';
end$$;

create function public.get_scan_status(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.scans; r public.records; m jsonb;
begin
 select * into s from public.scans where id=(p_payload->>'scan_id')::uuid;
 if not found then raise exception 'SCAN_NOT_FOUND' using errcode='22023'; end if;
 select * into r from public.records where scan_id=s.id;
 m:=public.match_scan(jsonb_build_object('scan_id',s.id,'version',s.input_version,'selected_evidence_id',p_payload->>'selected_evidence_id','offset',p_payload->'offset'));
 return jsonb_build_object('ok',true,'id',s.id,'intent',s.intent,'imageVersion',s.input_version,'state',s.state,'quality',s.quality,'extraction',s.extraction,
  'record',case when r.id is null then null else public.cmi_record_snapshot(r) end,'results',m->'results','requiresSelection',m->'requiresSelection',
  'selectedIdentifierId',coalesce(m->>'selectedIdentifierId',s.selected_identifier_id),'errorCode',s.error_code,'totalMatches',m->'totalMatches','nextOffset',m->'nextOffset');
end$$;

create function public.activate_tracking(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.scans; r public.records; prior public.idempotency_keys; answer jsonb;
begin
 perform pg_advisory_xact_lock(hashtext('cmi-job-slots'));
 select * into s from public.scans where id=(p_payload->>'scan_id')::uuid for update;
 if not found then raise exception 'SCAN_NOT_FOUND' using errcode='22023'; end if;
 select * into prior from public.idempotency_keys where scope='tracking:'||s.id and key=p_payload->>'idempotency_key';
 if found then
  if prior.body_hash<>p_payload->>'body_hash' then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='23505'; end if;
  return prior.response;
 end if;
 if s.intent<>'search' or s.input_version<>(p_payload->>'version')::integer or s.state<>'succeeded' or s.quality='unusable' then raise exception 'TRACKING_NOT_READY' using errcode='40001'; end if;
 if not public.cmi_contact_valid(p_payload->'contact') then raise exception 'CONTACT_REQUIRED' using errcode='22023'; end if;
 insert into public.records(scan_id,kind,image_version,contact,visibility) values(s.id,'tracking',s.input_version,p_payload->'contact','active')
  on conflict(scan_id) do update set contact=excluded.contact,visibility='active',updated_at=now() returning * into r;
 answer:=jsonb_build_object('ok',true,'publicCode',r.public_code,'record',public.cmi_record_snapshot(r),'matching',public.match_scan(jsonb_build_object('scan_id',s.id,'version',s.input_version)));
 insert into public.idempotency_keys(scope,key,body_hash,response) values('tracking:'||s.id,p_payload->>'idempotency_key',p_payload->>'body_hash',answer);
 return answer;
end$$;

create function public.public_record(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.records;
begin
 select * into r from public.records where public_code=p_payload->>'public_code';
 if not found then raise exception 'RECORD_NOT_FOUND' using errcode='22023'; end if;
 if r.visibility='withdrawn' then return jsonb_build_object('code',r.public_code,'kind',r.kind,'title','信息已撤回','recipientHint',null,'identifiers','[]'::jsonb,'quality',null,'resolution',r.resolution,'visibility','withdrawn','updatedAt',r.updated_at); end if;
 return public.cmi_record_snapshot(r);
end$$;

create function public.admin_record(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.records; s public.scans;
begin
 select * into r from public.records where public_code=p_payload->>'public_code';
 if not found then raise exception 'RECORD_NOT_FOUND' using errcode='22023'; end if;
 select * into s from public.scans where id=r.scan_id;
 return jsonb_build_object('id',r.id,'record',public.cmi_record_snapshot(r),'scanId',s.id,'imageVersion',s.input_version,'revision',r.revision,'contact',r.contact,
  'extraction',s.extraction,'state',s.state,'createdAt',r.created_at,'duplicateOf',r.duplicate_of,'canRevise',r.resolution not in ('claimed','resolved'),
  'images',coalesce((select jsonb_agg(to_jsonb(i)) from public.images i where scan_id=s.id and version=s.input_version),'[]'),
  'results',(public.match_scan(jsonb_build_object('scan_id',s.id,'version',s.input_version)))->'results');
end$$;

create function public.admin_update(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare action text:=p_payload->>'action'; actor uuid:=(p_payload->>'actor_id')::uuid; r public.records; tr public.records; m public.matches; f public.followups; fid uuid; p jsonb:=coalesce(p_payload->'payload','{}'); tracking uuid;
begin
 if actor is null then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtext('cmi-job-slots'));
 if p_payload->>'public_code' is not null then select * into r from public.records where public_code=p_payload->>'public_code' for update; end if;
 if p_payload->>'match_id' is not null then select * into m from public.matches where id=(p_payload->>'match_id')::uuid for update; end if;
 if p_payload->>'followup_id' is not null then
  select * into f from public.followups where id=(p_payload->>'followup_id')::uuid for update;
  if not found then raise exception 'FOLLOWUP_NOT_FOUND' using errcode='22023'; end if;
  if f.match_id is not null then select * into m from public.matches where id=f.match_id for update;
  else
   select * into r from public.records where id=f.received_record_id for update;
   if f.tracking_record_id is not null then select * into tr from public.records where id=f.tracking_record_id for update; end if;
  end if;
 end if;
 if r.id is not null and p->>'revision' is not null and r.revision<>(p->>'revision')::integer then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
 if action='create_followup' then
  if r.id is null then select * into r from public.records where public_code=p->>'receivedCode' and kind='received' for update; end if;
  if r.id is null or r.kind<>'received' or r.visibility<>'active' or r.resolution not in ('open','verifying') then raise exception 'RECORD_NOT_FOUND' using errcode='22023'; end if;
  if p->>'trackingCode' is not null then
   select * into tr from public.records where public_code=p->>'trackingCode' and kind='tracking' and visibility='active' and resolution in ('open','verifying') for update;
   if not found then raise exception 'RECORD_NOT_FOUND' using errcode='22023'; end if;
   tracking:=tr.id;
  end if;
  insert into public.followups(received_record_id,tracking_record_id,notes) values(r.id,tracking,coalesce(p->>'notes',''))
   on conflict(received_record_id) where match_id is null do update set notes=excluded.notes,tracking_record_id=excluded.tracking_record_id,updated_at=now() returning * into f;
 elsif f.id is not null and f.match_id is null and action in ('verify','mark_claimed','confirm_handover','reject') then
  if action='verify' then
   if r.visibility<>'active' or (f.tracking_record_id is not null and (tr.id is null or tr.kind<>'tracking' or tr.visibility<>'active' or tr.resolution='resolved')) then raise exception 'RECORD_NOT_ACTIVE' using errcode='40001'; end if;
   update public.followups set state='ready_to_contact',notes=coalesce(p->>'notes',notes),updated_at=now() where id=f.id;
   update public.records set resolution='verifying',revision=revision+1,updated_at=now() where id in (r.id,f.tracking_record_id) and resolution='open';
  elsif action='mark_claimed' then
   if f.state not in ('ready_to_contact','contacting','awaiting_handover') or r.visibility<>'active' or r.claimed_match_id is not null or (r.claimed_followup_id is not null and r.claimed_followup_id<>f.id)
   or (f.tracking_record_id is not null and (tr.id is null or tr.kind<>'tracking' or tr.visibility<>'active' or tr.resolution='resolved' or tr.claimed_match_id is not null or (tr.claimed_followup_id is not null and tr.claimed_followup_id<>f.id))) then raise exception 'OWNERSHIP_NOT_VERIFIED' using errcode='40001'; end if;
   update public.records set resolution='claimed',claimed_followup_id=f.id,revision=revision+1,updated_at=now() where id in (r.id,f.tracking_record_id);
   update public.followups set state='awaiting_handover',updated_at=now() where id=f.id;
  elsif action='confirm_handover' then
   if f.state not in ('awaiting_handover','closed') or r.claimed_followup_id is distinct from f.id or r.resolution not in ('claimed','resolved')
   or (f.tracking_record_id is not null and (tr.id is null or tr.claimed_followup_id is distinct from f.id or tr.resolution not in ('claimed','resolved'))) then raise exception 'OWNERSHIP_NOT_VERIFIED' using errcode='40001'; end if;
   insert into public.handovers(followup_id,received_id,actor_id) values(f.id,r.id,actor) on conflict(received_id) do nothing;
   update public.records set resolution='resolved',closed_at=coalesce(closed_at,now()),updated_at=now() where id in (r.id,f.tracking_record_id);
   update public.followups set state='closed',updated_at=now() where id=f.id;
  else
   if r.resolution in ('claimed','resolved') then raise exception 'OWNERSHIP_ALREADY_CONFIRMED' using errcode='40001'; end if;
   update public.followups set state='closed',updated_at=now() where id=f.id;
  end if;
 elsif action in ('verify_match','verify','confirm_owner','mark_claimed') then
  if m.id is null or m.state not in ('candidate','verified') then raise exception 'MATCH_NOT_ACTIVE' using errcode='40001'; end if;
  if not exists(select 1 from public.records where id=m.received_id and image_version=m.received_version and visibility='active') or not exists(select 1 from public.records where id=m.tracking_id and image_version=m.tracking_version and visibility='active') then raise exception 'MATCH_STALE' using errcode='40001'; end if;
  if action in ('mark_claimed','confirm_owner') then
   if m.state<>'verified' then raise exception 'MATCH_NOT_VERIFIED' using errcode='40001'; end if;
   if exists(select 1 from public.records where id in (m.received_id,m.tracking_id) and ((claimed_match_id is not null and claimed_match_id<>m.id) or claimed_followup_id is not null)) then raise exception 'ALREADY_CLAIMED' using errcode='40001'; end if;
   update public.records set resolution='claimed',claimed_match_id=m.id,revision=revision+1,updated_at=now() where id in (m.received_id,m.tracking_id);
   update public.followups set state='awaiting_handover',updated_at=now() where match_id=m.id;
  else
   update public.matches set state='verified',updated_at=now() where id=m.id;
   update public.records set resolution='verifying',revision=revision+1,updated_at=now() where id in (m.received_id,m.tracking_id) and resolution='open';
   update public.followups set state='ready_to_contact',updated_at=now() where match_id=m.id;
  end if;
 elsif action in ('reject_match','reject') then
  if m.id is null or m.state not in ('candidate','verified') or exists(select 1 from public.records where claimed_match_id=m.id and resolution in ('claimed','resolved')) then raise exception 'MATCH_NOT_ACTIVE' using errcode='40001'; end if;
  update public.matches set state='rejected',updated_at=now() where id=m.id;
  update public.followups set state='closed',updated_at=now() where match_id=m.id;
 elsif action in ('handover','confirm_handover') then
  if m.id is null or m.state not in ('verified','closed') or not exists(select 1 from public.records where id=m.received_id and claimed_match_id=m.id and resolution in ('claimed','resolved')) then raise exception 'OWNERSHIP_NOT_VERIFIED' using errcode='40001'; end if;
  insert into public.handovers(match_id,received_id,actor_id) values(m.id,m.received_id,actor) on conflict(match_id) do nothing;
  update public.matches set state='closed',updated_at=now() where id=m.id;
  update public.records set resolution='resolved',closed_at=coalesce(closed_at,now()),updated_at=now() where id in (m.received_id,m.tracking_id);
  update public.followups set state='closed',updated_at=now() where match_id=m.id;
 elsif action in ('contact_received','contact_tracking','update_followup','followup') then
  fid:=coalesce((p_payload->>'followup_id')::uuid,(select id from public.followups where match_id=m.id));
  update public.followups set received_contacted_at=case when action='contact_received' then coalesce(received_contacted_at,now()) else received_contacted_at end,
   tracking_contacted_at=case when action='contact_tracking' then coalesce(tracking_contacted_at,now()) else tracking_contacted_at end,
   notes=coalesce(p->>'notes',notes),state=coalesce(p->>'state',case when action in ('contact_received','contact_tracking') then 'contacting' else state end),updated_at=now() where id=fid;
  if not found then raise exception 'FOLLOWUP_NOT_FOUND' using errcode='22023'; end if;
 elsif action in ('withdraw','hide') then
  if r.id is null then raise exception 'RECORD_NOT_FOUND' using errcode='22023'; end if;
  perform public.cancel_scan(jsonb_build_object('scan_id',r.scan_id,'version',r.image_version));
 elsif action='duplicate' then
  update public.records set duplicate_of=(p->>'duplicateOf')::uuid,visibility='withdrawn',closed_at=now(),updated_at=now() where id=r.id;
  update public.matches set state='invalidated',updated_at=now() where received_id=r.id or tracking_id=r.id;
  update public.followups set state='closed',updated_at=now() where received_record_id=r.id or tracking_record_id=r.id;
 elsif action='retry' then
  if r.id is null then raise exception 'RECORD_NOT_FOUND' using errcode='22023'; end if;
  perform public.retry_scan(jsonb_build_object('scan_id',r.scan_id,'version',r.image_version));
 elsif action='rotate' then
  if r.id is null or length(coalesce(p->>'capability_hash',''))<>64 then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  update public.scans set capability_hash=p->>'capability_hash',updated_at=now() where id=r.scan_id;
  update public.records set revision=revision+1,updated_at=now() where id=r.id;
 elsif action='imageapproval' then
  if r.id is null or not exists(select 1 from public.images where id=(p->>'imageId')::uuid and scan_id=r.scan_id and version=r.image_version and role in ('item','product')) then raise exception 'INVALID_IMAGE' using errcode='22023'; end if;
  if position('..' in coalesce(p->>'approved_image_path',''))>0 or length(coalesce(p->>'approved_image_path',''))=0 then raise exception 'INVALID_IMAGE' using errcode='22023'; end if;
  update public.records set approved_image_path=p->>'approved_image_path',image_approved=true,revision=revision+1,updated_at=now() where id=r.id;
 elsif action in ('settings','update_settings') then
  insert into public.site_settings(key,value) values('community',p) on conflict(key) do update set value=public.site_settings.value||excluded.value,updated_at=now();
 else raise exception 'UNKNOWN_ADMIN_ACTION' using errcode='22023'; end if;
 insert into public.audit_events(actor_id,action,record_id,match_id,payload) values(actor,action,r.id,m.id,p||jsonb_build_object('followupId',coalesce(f.id,fid)));
 return jsonb_build_object('ok',true,'action',action,'followupId',f.id);
end$$;

create function public.rate_limit_tick(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare n integer; start_at timestamptz; seconds integer:=greatest(1,least(86400,(p_payload->>'window_seconds')::integer));
begin
 start_at:=to_timestamp(floor(extract(epoch from now())/seconds)*seconds);
 insert into public.rate_limits(key,window_start,count) values(p_payload->>'key',start_at,1)
 on conflict(key,window_start) do update set count=public.rate_limits.count+1 returning count into n;
 return jsonb_build_object('allowed',n<=(p_payload->>'limit')::integer,'count',n,'resetAt',start_at+make_interval(secs=>seconds));
end$$;

create function public.claim_jobs(p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare slots integer; j public.jobs; result jsonb:='[]';
begin
 perform pg_advisory_xact_lock(hashtext('cmi-job-slots'));
 update public.jobs jb set status='cancelled',updated_at=now() from public.scans s where s.id=jb.scan_id and jb.status in ('pending','leased') and (jb.version<>s.input_version or s.state='cancelled');
 update public.jobs jb set status='failed',error_code='RETRIES_EXHAUSTED',updated_at=now() where attempts>=3 and status='leased' and lease_expires_at<=now();
 update public.scans s set state='failed',error_code='RETRIES_EXHAUSTED',updated_at=now() from public.jobs jb where jb.scan_id=s.id and jb.version=s.input_version and jb.status='failed' and s.state in ('queued','running','deferred');
 slots:=greatest(0,2-(select count(*) from public.jobs where status='leased' and lease_expires_at>now()));
 for j in select * from public.jobs where attempts<3 and next_run_at<=now() and (status='pending' or (status='leased' and lease_expires_at<=now())) order by created_at for update skip locked limit least(slots,greatest(1,least(2,coalesce((p_payload->>'limit')::integer,1)))) loop
  update public.jobs set status='leased',lease_token=gen_random_uuid(),lease_expires_at=now()+interval '180 seconds',updated_at=now() where id=j.id returning * into j;
  update public.scans set state='running',updated_at=now() where id=j.scan_id and input_version=j.version;
  result:=result||jsonb_build_array(to_jsonb(j)||jsonb_build_object('scan',(select to_jsonb(s)-'capability_hash' from public.scans s where s.id=j.scan_id),
   'images',coalesce((select jsonb_agg(to_jsonb(i)) from public.images i where scan_id=j.scan_id and version=j.version and upload_state='uploaded'),'[]')));
 end loop;
 return result;
end$$;

create function public.reserve_budget(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs; s public.scans; b public.daily_budgets; reservation public.budget_reservations; d date:=timezone('Asia/Bangkok',now())::date; lim numeric;
begin
 perform pg_advisory_xact_lock(hashtext('cmi-job-slots'));
 select * into j from public.jobs where id=(p_payload->>'job_id')::uuid for update;
 if not found or j.status<>'leased' or j.lease_token<>(p_payload->>'lease_token')::uuid or j.lease_expires_at<=now() then raise exception 'STALE_LEASE' using errcode='40001'; end if;
 select * into s from public.scans where id=j.scan_id;
 if s.input_version<>j.version or s.state='cancelled' then raise exception 'STALE_VERSION' using errcode='40001'; end if;
 select * into reservation from public.budget_reservations where job_id=j.id and lease_token=j.lease_token;
 if found then return jsonb_build_object('allowed',true,'reservationId',reservation.id,'attempt',reservation.attempt); end if;
 if j.attempts>=3 then raise exception 'RETRIES_EXHAUSTED' using errcode='40001'; end if;
 insert into public.daily_budgets(day,environment) values(d,s.environment) on conflict do nothing;
 select * into b from public.daily_budgets where day=d and environment=s.environment for update;
 lim:=case when s.environment='prod' then 4.9 else .1 end;
 if b.reserved+b.spent+.02>lim then
  update public.jobs set status='pending',lease_token=null,lease_expires_at=null,next_run_at=((d+1)::timestamp at time zone 'Asia/Bangkok'),updated_at=now() where id=j.id;
  update public.scans set state='deferred',error_code='BUDGET_DEFERRED',updated_at=now() where id=s.id;
  return '{"allowed":false,"reason":"BUDGET_DEFERRED"}';
 end if;
 update public.daily_budgets set reserved=reserved+.02 where day=d and environment=s.environment;
 update public.jobs set attempts=attempts+1 where id=j.id returning * into j;
 insert into public.budget_reservations(job_id,lease_token,attempt,day,environment) values(j.id,j.lease_token,j.attempts,d,s.environment) returning * into reservation;
 return jsonb_build_object('allowed',true,'reservationId',reservation.id,'attempt',j.attempts,'reservedUsd',.02);
end$$;

create function public.cmi_settle_budget(p_payload jsonb) returns void language plpgsql security definer set search_path='' as $$
declare b public.budget_reservations; v_actual numeric; unknown boolean:=coalesce((p_payload->>'usage_unknown')::boolean,false);
begin
 if p_payload->>'reservation_id' is null then return; end if;
 select * into b from public.budget_reservations where id=(p_payload->>'reservation_id')::uuid for update;
 if not found or b.state='settled' then return; end if;
 if b.job_id<>(p_payload->>'job_id')::uuid or b.lease_token<>(p_payload->>'lease_token')::uuid then raise exception 'RESERVATION_MISMATCH' using errcode='42501'; end if;
 -- Unknown provider usage stays encumbered; spent reports actual reconciled charges only.
 if unknown then
  update public.budget_reservations set state='unknown',actual=null,input_tokens=null,output_tokens=null where id=b.id;
  return;
 end if;
 v_actual:=greatest(0,coalesce((p_payload->>'input_tokens')::numeric,0)*.0000004+coalesce((p_payload->>'output_tokens')::numeric,0)*.0000016);
 update public.daily_budgets set reserved=greatest(0,reserved-b.amount),spent=spent+v_actual where day=b.day and environment=b.environment;
 update public.budget_reservations set state='settled',actual=v_actual,input_tokens=(p_payload->>'input_tokens')::integer,output_tokens=(p_payload->>'output_tokens')::integer where id=b.id;
end$$;

create function public.complete_job(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs; s public.scans; i jsonb; v_quality text:=p_payload->>'quality'; matching jsonb;
begin
 perform pg_advisory_xact_lock(hashtext('cmi-job-slots'));
 -- Settle upstream usage even if this worker was fenced out after a user revision.
 perform public.cmi_settle_budget(p_payload);
 select * into j from public.jobs where id=(p_payload->>'job_id')::uuid for update;
 if not found or j.status<>'leased' or j.lease_token<>(p_payload->>'lease_token')::uuid or j.lease_expires_at<=now() then return '{"ok":false,"fenced":true}'; end if;
 select * into s from public.scans where id=j.scan_id for update;
 if s.input_version<>j.version or s.state='cancelled' then update public.jobs set status='cancelled' where id=j.id; return '{"ok":false,"fenced":true}'; end if;
 if v_quality not in ('complete','partial','unusable') then raise exception 'INVALID_QUALITY' using errcode='22023'; end if;
 delete from public.evidence where scan_id=s.id and version=j.version;
 for i in select * from jsonb_array_elements(coalesce(p_payload->'extraction'->'identifiers','[]')) loop
  if not exists(select 1 from public.images where id=(i->>'sourceImageId')::uuid and scan_id=s.id and version=j.version) then raise exception 'INVALID_SOURCE_IMAGE' using errcode='22023'; end if;
  insert into public.evidence(scan_id,version,identifier_id,type,value,carrier,complete,clear,shared,source_image_id)
   values(s.id,j.version,i->>'id',i->>'type',public.cmi_number(i->>'value'),nullif(i->>'carrier',''),(i->>'complete')::boolean,(i->>'clear')::boolean,(i->>'shared')::boolean,(i->>'sourceImageId')::uuid);
 end loop;
 update public.scans set state=case when v_quality='unusable' then 'needs_photo' else 'succeeded' end,quality=v_quality,extraction=p_payload->'extraction',suggested_matches=coalesce(p_payload->'matches','[]'),error_code=null,updated_at=now() where id=s.id;
 update public.records set visibility=case when v_quality='unusable' then 'pending' else 'active' end,image_version=j.version,public_title=coalesce(p_payload->>'public_title','待核实包裹'),updated_at=now() where scan_id=s.id and visibility<>'withdrawn';
 update public.jobs set status='completed',lease_expires_at=null,updated_at=now() where id=j.id;
 matching:=public.match_scan(jsonb_build_object('scan_id',s.id,'version',j.version));
 return jsonb_build_object('ok',true,'state',case when v_quality='unusable' then 'needs_photo' else 'succeeded' end,'matching',matching);
end$$;

create function public.fail_job(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs; s public.scans; retryable boolean:=coalesce((p_payload->>'retryable')::boolean,true); final boolean;
begin
 perform pg_advisory_xact_lock(hashtext('cmi-job-slots'));
 perform public.cmi_settle_budget(p_payload);
 select * into j from public.jobs where id=(p_payload->>'job_id')::uuid for update;
 if not found or j.status<>'leased' or j.lease_token<>(p_payload->>'lease_token')::uuid or j.lease_expires_at<=now() then return '{"ok":false,"fenced":true}'; end if;
 select * into s from public.scans where id=j.scan_id for update;
 if s.input_version<>j.version or s.state='cancelled' then update public.jobs set status='cancelled' where id=j.id; return '{"ok":false,"fenced":true}'; end if;
 final:=not retryable or j.attempts>=3;
 update public.jobs set status=case when final then 'failed' else 'pending' end,lease_token=null,lease_expires_at=null,next_run_at=now()+make_interval(secs=>case when j.attempts=1 then 30 else 120 end),error_code=p_payload->>'error_code',updated_at=now() where id=j.id;
 update public.scans set state=case when final then 'failed' else 'queued' end,error_code=p_payload->>'error_code',updated_at=now() where id=s.id;
 return jsonb_build_object('ok',true,'retrying',not final);
end$$;

create function public.cleanup_records(p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare paths jsonb; public_paths jsonb;
begin
 perform pg_advisory_xact_lock(hashtext('cmi-job-slots'));
 update public.scans s set state='cancelled',extraction=null,quality=null,capability_hash='',updated_at=now()
 where (not exists(select 1 from public.records r where r.scan_id=s.id) and s.expires_at<now())
 or exists(select 1 from public.records r where r.scan_id=s.id and r.closed_at<now()-interval '30 days');
 update public.records set contact='{}',image_approved=false where closed_at<now()-interval '30 days';
 update public.followups f set notes='' where exists(select 1 from public.records r where r.id in (f.received_record_id,f.tracking_record_id) and r.closed_at<now()-interval '30 days');
 update public.audit_events a set payload='{}' where exists(select 1 from public.records r where r.id=a.record_id and r.closed_at<now()-interval '30 days')
 or exists(select 1 from public.matches m join public.records r on r.id in (m.received_id,m.tracking_id) where m.id=a.match_id and r.closed_at<now()-interval '30 days')
 or exists(select 1 from public.followups f join public.records r on r.id in (f.received_record_id,f.tracking_record_id) where f.id::text=a.payload->>'followupId' and r.closed_at<now()-interval '30 days');
 update public.jobs j set status='cancelled' from public.scans s where s.id=j.scan_id and s.state='cancelled' and j.status in ('pending','leased');
 delete from public.evidence e using public.scans s where s.id=e.scan_id and s.state='cancelled' and s.capability_hash='';
 update public.images i set upload_state='deleting' from public.scans s where s.id=i.scan_id and ((s.state='cancelled' and s.capability_hash='') or (i.version<>s.input_version and i.created_at<now()-interval '24 hours'));
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'path',path)),'[]') into paths from (select id,path from public.images where upload_state='deleting' limit 100) expired;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'path',approved_image_path)),'[]') into public_paths from (select id,approved_image_path from public.records where closed_at<now()-interval '30 days' and approved_image_path is not null limit 100) expired_public;
 delete from public.rate_limits where window_start<now()-interval '2 days';
 delete from public.idempotency_keys where created_at<now()-interval '30 days';
 return jsonb_build_object('images',paths,'publicImages',public_paths);
end$$;
create function public.cleanup_images(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 delete from public.evidence where source_image_id in (select id from public.images where upload_state='deleting' and id in (select value::uuid from jsonb_array_elements_text(p_payload->'ids')));
 delete from public.images where upload_state='deleting' and id in (select value::uuid from jsonb_array_elements_text(p_payload->'ids'));
 update public.records set approved_image_path=null,image_approved=false where id in (select value::uuid from jsonb_array_elements_text(coalesce(p_payload->'record_ids','[]')));
 return '{"ok":true}';
end$$;

create function public.cmi_tick() returns void language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.jobs where next_run_at<=now() and (status='pending' or (status='leased' and lease_expires_at<=now())))
 or exists(select 1 from public.images where upload_state='deleting')
 or exists(select 1 from public.scans s where s.expires_at<now() and s.capability_hash<>'' and not exists(select 1 from public.records r where r.scan_id=s.id))
 or exists(select 1 from public.images i join public.scans s on s.id=i.scan_id where i.version<>s.input_version and i.created_at<now()-interval '24 hours')
 or exists(select 1 from public.records where closed_at<now()-interval '30 days' and (contact<>'{}' or approved_image_path is not null)) then perform public.wake_worker('{}'); end if;
end$$;

create function public.runtime_config(p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare config jsonb; openai text; worker text;
begin
 select value into config from public.site_settings where key='runtime';
 if to_regclass('vault.decrypted_secrets') is not null then
  select decrypted_secret into openai from vault.decrypted_secrets where name='cmi_openai_api_key' limit 1;
  select decrypted_secret into worker from vault.decrypted_secrets where name='cmi_worker_secret' limit 1;
 end if;
 return jsonb_build_object('OPENAI_API_KEY',openai,'WORKER_SECRET',worker,'ADMIN_USER_IDS',config->>'ADMIN_USER_IDS',
  'APP_PUBLIC_URL',config->>'APP_PUBLIC_URL','ALLOWED_ORIGINS',config->>'ALLOWED_ORIGINS','APP_SHA',config->>'APP_SHA','APP_ENVIRONMENT',config->>'APP_ENVIRONMENT');
end$$;
select cron.schedule('cmi-durable-worker','* * * * *','select public.cmi_tick()');

-- Lock every RPC down; Edge/API service role must authenticate before invoking them.
do $$declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
 ('cmi_contact_valid','cmi_record_snapshot','wake_worker','create_scan','reserve_images','finalize_scan','revise_scan','cancel_scan','match_scan','get_scan_status','activate_tracking','public_record','admin_record','admin_update','rate_limit_tick','claim_jobs','reserve_budget','cmi_settle_budget','complete_job','fail_job','cleanup_records','cleanup_images','cmi_tick','matching_candidates','public_stats','update_contact','retry_scan','runtime_config','cmi_clean','cmi_specific','cmi_number','cmi_individual','cmi_quality','cmi_compare_extractions') loop
  execute format('revoke all on function %s from public, anon, authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end$$;
