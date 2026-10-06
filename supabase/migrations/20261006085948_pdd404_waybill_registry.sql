-- Independent manual domestic-waybill flow; the previous image-derived schema stays intact.
create table public.pdd_waybills (
 id uuid primary key default gen_random_uuid(),
 public_code text not null unique default 'PDD-'||upper(encode(extensions.gen_random_bytes(6),'hex')),
 number text not null unique check(number ~ '^[A-Z0-9]{6,40}$'),
 resolution text not null default 'open' check(resolution in ('open','verifying','claimed','resolved')),
 revision integer not null default 1, created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(), closed_at timestamptz
);
create table public.pdd_registrations (
 id uuid primary key default gen_random_uuid(), waybill_id uuid not null references public.pdd_waybills(id),
 registration_code text not null unique default 'PDD-R-'||upper(encode(extensions.gen_random_bytes(8),'hex')),
 request_id uuid not null unique, mode text not null check(mode in ('lost','received')),
 source text not null check(source in ('manual','barcode')), carrier text,
 contact jsonb, capability_hash text not null check(capability_hash='' or capability_hash ~ '^[0-9a-f]{64}$'),
 visibility text not null default 'active' check(visibility in ('active','withdrawn')),
 revision integer not null default 1, created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(), closed_at timestamptz
);
create unique index pdd_one_active_side on public.pdd_registrations(waybill_id,mode) where visibility='active';
create table public.pdd_query_events (
 id uuid primary key, number text not null check(number ~ '^[A-Z0-9]{6,40}$'),
 mode text not null check(mode in ('lost','received')), source text not null check(source in ('manual','barcode')),
 capability_hash text not null check(capability_hash='' or capability_hash ~ '^[0-9a-f]{64}$'), body_hash text not null,
 result text not null check(result in ('matched','duplicate','not_found','closed')),
 waybill_id uuid references public.pdd_waybills(id), queried_at timestamptz not null default now(),
 contact jsonb, contact_submitted_at timestamptz, registration_id uuid references public.pdd_registrations(id)
);
create index pdd_query_number_time on public.pdd_query_events(number,queried_at desc);
create table public.pdd_write_requests (
 scope text not null, key text not null, capability_hash text not null, body_hash text not null,
 receipt jsonb not null, created_at timestamptz not null default now(), primary key(scope,key)
);
create table public.pdd_audit_events (
 id uuid primary key default gen_random_uuid(), waybill_id uuid not null references public.pdd_waybills(id),
 registration_id uuid references public.pdd_registrations(id), actor_id uuid, action text not null,
 notes text not null default '', created_at timestamptz not null default now()
);
create table public.pdd_handovers (
 waybill_id uuid primary key references public.pdd_waybills(id), actor_id uuid not null,
 created_at timestamptz not null default now()
);

do $$declare t text; begin
 foreach t in array array['pdd_waybills','pdd_registrations','pdd_query_events','pdd_write_requests','pdd_audit_events','pdd_handovers'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public, anon, authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end$$;

create function public.pdd_number(t text) returns text language plpgsql immutable set search_path='' as $$
declare n text:=public.cmi_number(t); begin
 if t is null or length(t)>100 or n !~ '^[A-Z0-9]{6,40}$' then raise exception 'INVALID_WAYBILL' using errcode='22023'; end if;
 return n;
end$$;
create function public.pdd_contact_valid(c jsonb) returns boolean language sql immutable set search_path='' as $$
 select jsonb_typeof(c)='object' and c-'kind'-'value'='{}'::jsonb and jsonb_typeof(c->'value')='string'
 and case c->>'kind'
 when 'wechat' then btrim(c->>'value') ~ '^[a-zA-Z][-_a-zA-Z0-9]{5,63}$'
 when 'phone' then length(btrim(c->>'value'))<=32 and btrim(c->>'value') ~ '^\+?[0-9][0-9 ()-]{5,30}[0-9]$' and length(regexp_replace(c->>'value','[^0-9]','','g'))>=7
 else false end
$$;
create function public.pdd_contact_projection(c jsonb) returns jsonb language sql immutable set search_path='' as $$
 select case when public.pdd_contact_valid(c) then jsonb_build_object('kind',c->>'kind','value',btrim(c->>'value')) else null end
$$;
create function public.pdd_public_snapshot(w public.pdd_waybills) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('code',w.public_code,'tail',right(w.number,4),'resolution',w.resolution,'revision',w.revision,
  'visibility',case when exists(select 1 from public.pdd_registrations r where r.waybill_id=w.id and r.visibility='active') then 'active' else 'withdrawn' end,
  'lostRegistered',exists(select 1 from public.pdd_registrations r where r.waybill_id=w.id and r.mode='lost' and r.visibility='active'),
  'receivedRegistered',exists(select 1 from public.pdd_registrations r where r.waybill_id=w.id and r.mode='received' and r.visibility='active'),
  'createdAt',w.created_at,'updatedAt',w.updated_at)
$$;
create function public.pdd_registration_snapshot(r public.pdd_registrations) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('registrationCode',r.registration_code,'number',w.number,'mode',r.mode,'source',r.source,
  'contact',public.pdd_contact_projection(r.contact),'revision',r.revision,'visibility',r.visibility,
  'createdAt',r.created_at,'updatedAt',r.updated_at,'record',public.pdd_public_snapshot(w))
 from public.pdd_waybills w where w.id=r.waybill_id
$$;
create function public.pdd_lookup(n text,m text) returns jsonb language plpgsql stable set search_path='' as $$
declare w public.pdd_waybills; own public.pdd_registrations; opposite public.pdd_registrations; outcome text; begin
 select * into w from public.pdd_waybills where number=n;
 if not found then return jsonb_build_object('result','not_found','record',null,'registeredAt',null,'contact',null); end if;
 select * into own from public.pdd_registrations where waybill_id=w.id and mode=m and visibility='active';
 select * into opposite from public.pdd_registrations where waybill_id=w.id and mode<>m and visibility='active';
 if w.resolution='resolved' then outcome:='closed';
 elsif opposite.id is not null and public.pdd_contact_valid(opposite.contact) and (own.carrier is null or opposite.carrier is null or lower(own.carrier)=lower(opposite.carrier)) then outcome:='matched';
 elsif own.id is not null then outcome:='duplicate'; else outcome:='not_found'; end if;
 return jsonb_build_object('result',outcome,'record',public.pdd_public_snapshot(w),
  'registeredAt',case when outcome='matched' then opposite.created_at when outcome='duplicate' then own.created_at else null end,
  'contact',case when outcome='matched' then public.pdd_contact_projection(opposite.contact) else null end);
end$$;
create function public.pdd_query(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare n text:=public.pdd_number(p_payload->>'number'); m text:=p_payload->>'mode'; s text:=p_payload->>'source';
 q public.pdd_query_events; answer jsonb; begin
 if coalesce(m,'') not in ('lost','received') or coalesce(s,'') not in ('manual','barcode') or coalesce(p_payload->>'capability_hash','') !~ '^[0-9a-f]{64}$' or length(coalesce(p_payload->>'body_hash',''))=0 then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('pdd-query:'||(p_payload->>'query_id'),0));
 perform pg_advisory_xact_lock(hashtextextended('pdd-number:'||n,0));
 select * into q from public.pdd_query_events where id=(p_payload->>'query_id')::uuid;
 if found then
  if q.capability_hash<>p_payload->>'capability_hash' or q.body_hash<>p_payload->>'body_hash' or q.number<>n or q.mode<>m or q.source<>s then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='40001'; end if;
 else
  answer:=public.pdd_lookup(n,m);
  insert into public.pdd_query_events(id,number,mode,source,capability_hash,body_hash,result,waybill_id)
   values((p_payload->>'query_id')::uuid,n,m,s,p_payload->>'capability_hash',p_payload->>'body_hash',answer->>'result',(select id from public.pdd_waybills where number=n)) returning * into q;
 end if;
 -- Replays read current contacts; private contact snapshots are never cached.
 return public.pdd_lookup(n,m)||jsonb_build_object('queryId',q.id,'queriedAt',q.queried_at);
end$$;

create function public.pdd_query_contact(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare q public.pdd_query_events; w public.pdd_waybills; own public.pdd_registrations; prior public.pdd_write_requests;
 answer jsonb; v_scope text:='query-contact:'||(p_payload->>'query_id'); c jsonb:=public.pdd_contact_projection(p_payload->'contact'); begin
 if c is null or length(coalesce(p_payload->>'idempotency_key',''))=0 or length(coalesce(p_payload->>'body_hash',''))=0 then raise exception 'INVALID_CONTACT' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_scope,0));
 select * into q from public.pdd_query_events where id=(p_payload->>'query_id')::uuid;
 if not found or q.capability_hash='' or q.capability_hash<>coalesce(p_payload->>'capability_hash','') then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 select * into prior from public.pdd_write_requests where pdd_write_requests.scope=v_scope and key=p_payload->>'idempotency_key';
 if found then
  if prior.capability_hash<>q.capability_hash or prior.body_hash<>p_payload->>'body_hash' then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='40001'; end if;
  select * into own from public.pdd_registrations where registration_code=prior.receipt->>'registrationCode' and capability_hash=q.capability_hash;
  return jsonb_build_object('saved',true,'registration',case when own.id is not null then public.pdd_registration_snapshot(own) else null end);
 end if;
 if q.contact_submitted_at is not null then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='40001'; end if;
 if q.queried_at<now()-interval '24 hours' then raise exception 'QUERY_EXPIRED' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('pdd-number:'||q.number,0));
 select * into q from public.pdd_query_events where id=q.id for update;
 if q.id is null or q.capability_hash<>coalesce(p_payload->>'capability_hash','') then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 answer:=public.pdd_lookup(q.number,q.mode);
 if answer->>'result'<>'matched' then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
 select * into w from public.pdd_waybills where number=q.number for update;
 select * into own from public.pdd_registrations where waybill_id=w.id and mode=q.mode and visibility='active';
 if own.id is null then
  insert into public.pdd_registrations(waybill_id,request_id,mode,source,contact,capability_hash)
   values(w.id,q.id,q.mode,q.source,c,q.capability_hash) returning * into own;
  update public.pdd_waybills set revision=revision+1,updated_at=now(),closed_at=null where id=w.id;
  insert into public.pdd_audit_events(waybill_id,registration_id,action) values(w.id,own.id,'register_from_match');
 else own:=null; end if;
 update public.pdd_query_events set contact=c,contact_submitted_at=now(),waybill_id=w.id,registration_id=own.id where id=q.id;
 insert into public.pdd_write_requests(scope,key,capability_hash,body_hash,receipt)
  values(v_scope,p_payload->>'idempotency_key',q.capability_hash,p_payload->>'body_hash',jsonb_build_object('registrationCode',own.registration_code));
 return jsonb_build_object('saved',true,'registration',case when own.id is not null then public.pdd_registration_snapshot(own) else null end);
end$$;

create function public.pdd_batch_receipt(receipt jsonb,cap text,submitted_at timestamptz) returns jsonb language plpgsql stable set search_path='' as $$
declare i jsonb; w public.pdd_waybills; r public.pdd_registrations; lookup jsonb; outcome text; items jsonb:='[]'; begin
 for i in select value from jsonb_array_elements(receipt) loop
  select * into w from public.pdd_waybills where public_code=i->>'publicCode';
  select * into r from public.pdd_registrations where registration_code=i->>'registrationCode' and capability_hash=cap and cap<>'';
  lookup:=public.pdd_lookup(w.number,i->>'mode'); outcome:=i->>'result';
  if lookup->>'result'='closed' then outcome:='closed';
  elsif lookup->>'result'='matched' then outcome:='matched';
  elsif outcome='matched' then outcome:=case when r.id is not null then 'registered' else 'duplicate' end; end if;
  items:=items||jsonb_build_array(jsonb_build_object('requestId',i->>'requestId','number',w.number,'result',outcome,
   'record',public.pdd_public_snapshot(w),'registration',case when r.id is not null then public.pdd_registration_snapshot(r) else null end,
   'contact',case when outcome='matched' then lookup->'contact' else null end,'registeredAt',coalesce(lookup->'registeredAt',to_jsonb(r.created_at))));
 end loop;
 return jsonb_build_object('submittedAt',submitted_at,'items',items);
end$$;
create function public.pdd_batch_register(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare m text:=p_payload->>'mode'; cap text:=p_payload->>'capability_hash'; c jsonb:=public.pdd_contact_projection(p_payload->'contact');
 prior public.pdd_write_requests; w public.pdd_waybills; own public.pdd_registrations; i jsonb; n text; lookup jsonb; outcome text; receipt jsonb:='[]'; begin
 if coalesce(m,'') not in ('lost','received') or c is null or coalesce(cap,'') !~ '^[0-9a-f]{64}$' or length(coalesce(p_payload->>'request_id',''))=0 or length(coalesce(p_payload->>'body_hash',''))=0
 or coalesce(jsonb_typeof(p_payload->'items'),'')<>'array' or jsonb_array_length(p_payload->'items') not between 1 and 50 then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 if (select count(*)<>count(distinct public.pdd_number(value->>'number')) or count(*)<>count(distinct value->>'request_id') from jsonb_array_elements(p_payload->'items')) then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('pdd-batch:'||(p_payload->>'request_id'),0));
 select * into prior from public.pdd_write_requests where scope='batch' and key=p_payload->>'request_id';
 if found then
  if prior.capability_hash<>cap or prior.body_hash<>p_payload->>'body_hash' then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='40001'; end if;
  return public.pdd_batch_receipt(prior.receipt,cap,prior.created_at);
 end if;
 -- Ordered locks eliminate cross-batch deadlocks; registration and lookup share these locks.
 for n in select public.pdd_number(value->>'number') from jsonb_array_elements(p_payload->'items') order by 1 loop
  perform pg_advisory_xact_lock(hashtextextended('pdd-number:'||n,0));
 end loop;
 for i in select value from jsonb_array_elements(p_payload->'items') loop
  n:=public.pdd_number(i->>'number');
  if coalesce(i->>'source','') not in ('manual','barcode') then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  insert into public.pdd_waybills(number) values(n) on conflict(number) do nothing;
  select * into w from public.pdd_waybills where number=n for update;
  select * into own from public.pdd_registrations where waybill_id=w.id and mode=m and visibility='active';
  lookup:=public.pdd_lookup(n,m);
  if w.resolution='resolved' then outcome:='closed'; own:=null;
  elsif own.id is not null then outcome:=case when lookup->>'result'='matched' then 'matched' else 'duplicate' end; own:=null;
  else
   if exists(select 1 from public.pdd_registrations where request_id=(i->>'request_id')::uuid) then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='40001'; end if;
   insert into public.pdd_registrations(waybill_id,request_id,mode,source,contact,capability_hash)
    values(w.id,(i->>'request_id')::uuid,m,i->>'source',c,cap) returning * into own;
   update public.pdd_waybills set revision=revision+1,updated_at=now(),closed_at=null where id=w.id;
   update public.pdd_query_events set waybill_id=w.id where number=n and waybill_id is null;
   insert into public.pdd_audit_events(waybill_id,registration_id,action) values(w.id,own.id,'register');
   outcome:=case when lookup->>'result'='matched' then 'matched' else 'registered' end;
  end if;
  receipt:=receipt||jsonb_build_array(jsonb_build_object('requestId',i->>'request_id','publicCode',w.public_code,'mode',m,'result',outcome,'registrationCode',own.registration_code));
 end loop;
 insert into public.pdd_write_requests(scope,key,capability_hash,body_hash,receipt)
  values('batch',p_payload->>'request_id',cap,p_payload->>'body_hash',receipt) returning * into prior;
 return public.pdd_batch_receipt(receipt,cap,prior.created_at);
end$$;

create function public.pdd_manage(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.pdd_registrations; begin
 select * into r from public.pdd_registrations where registration_code=p_payload->>'registration_code' and capability_hash=p_payload->>'capability_hash' and capability_hash<>'';
 if not found then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 return public.pdd_registration_snapshot(r);
end$$;
create function public.pdd_manage_update(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.pdd_registrations; w public.pdd_waybills; a text:=p_payload->>'action'; c jsonb:=public.pdd_contact_projection(p_payload->'contact'); begin
 select * into r from public.pdd_registrations where registration_code=p_payload->>'registration_code' and capability_hash=p_payload->>'capability_hash' and capability_hash<>'';
 if not found then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 select * into w from public.pdd_waybills where id=r.waybill_id;
 perform pg_advisory_xact_lock(hashtextextended('pdd-number:'||w.number,0));
 select * into w from public.pdd_waybills where id=w.id for update;
 select * into r from public.pdd_registrations where id=r.id for update;
 -- Authorization read before waiting for the number lock may have been revoked.
 if r.id is null or r.capability_hash='' or r.capability_hash<>coalesce(p_payload->>'capability_hash','') then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if r.revision<>coalesce((p_payload->>'revision')::integer,0) then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
 if a='contact' then
  if c is null or r.visibility<>'active' then raise exception 'INVALID_CONTACT' using errcode='22023'; end if;
  update public.pdd_registrations set contact=c,revision=revision+1,updated_at=now() where id=r.id returning * into r;
 elsif a='withdraw' then
  if w.resolution in ('claimed','resolved') then raise exception 'OWNERSHIP_LOCKED' using errcode='40001'; end if;
  update public.pdd_registrations set visibility='withdrawn',closed_at=coalesce(closed_at,now()),revision=revision+1,updated_at=now() where id=r.id returning * into r;
 else raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 update public.pdd_waybills set revision=revision+1,updated_at=now(),closed_at=case when not exists(select 1 from public.pdd_registrations where waybill_id=w.id and visibility='active') then coalesce(closed_at,now()) else closed_at end where id=w.id;
 insert into public.pdd_audit_events(waybill_id,registration_id,action) values(w.id,r.id,'owner_'||a);
 return public.pdd_registration_snapshot(r);
end$$;
create function public.pdd_public(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.pdd_waybills; begin
 select * into w from public.pdd_waybills where public_code=p_payload->>'public_code';
 if not found then raise exception 'RECORD_NOT_FOUND' using errcode='22023'; end if;
 return public.pdd_public_snapshot(w);
end$$;

create function public.pdd_query_log(q public.pdd_query_events) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('queryId',q.id,'number',q.number,'mode',q.mode,'source',q.source,'result',q.result,'queriedAt',q.queried_at,
  'code',(select public_code from public.pdd_waybills where id=q.waybill_id),'contact',public.pdd_contact_projection(q.contact),'contactSubmittedAt',q.contact_submitted_at)
$$;
create function public.pdd_admin_snapshot(w public.pdd_waybills) returns jsonb language sql stable set search_path='' as $$
 select public.pdd_public_snapshot(w)||jsonb_build_object('number',w.number,
  'lostContact',(select public.pdd_contact_projection(contact) from public.pdd_registrations where waybill_id=w.id and mode='lost' and visibility='active'),
  'receivedContact',(select public.pdd_contact_projection(contact) from public.pdd_registrations where waybill_id=w.id and mode='received' and visibility='active'),
  'queryCount',(select count(*) from public.pdd_query_events where number=w.number))
$$;
create function public.pdd_admin_list(p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare off integer:=greatest(0,coalesce((p_payload->>'offset')::integer,0)); lim integer:=least(100,greatest(1,coalesce((p_payload->>'limit')::integer,50))); rows jsonb; total integer; begin
 select count(*) into total from public.pdd_waybills where p_payload->>'resolution' is null or resolution=p_payload->>'resolution';
 select coalesce(jsonb_agg(public.pdd_admin_snapshot(w)),'[]') into rows from (select * from public.pdd_waybills where p_payload->>'resolution' is null or resolution=p_payload->>'resolution' order by updated_at desc,id offset off limit lim) w;
 return jsonb_build_object('items',rows,'nextOffset',case when off+lim<total then off+lim else null end);
end$$;
create function public.pdd_admin_queries(p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare off integer:=greatest(0,coalesce((p_payload->>'offset')::integer,0)); lim integer:=least(100,greatest(1,coalesce((p_payload->>'limit')::integer,50))); rows jsonb; total integer; begin
 select count(*) into total from public.pdd_query_events;
 select coalesce(jsonb_agg(public.pdd_query_log(q)),'[]') into rows from (select * from public.pdd_query_events order by queried_at desc,id offset off limit lim) q;
 return jsonb_build_object('items',rows,'nextOffset',case when off+lim<total then off+lim else null end);
end$$;
create function public.pdd_admin_detail(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.pdd_waybills; regs jsonb; queries jsonb; events jsonb; begin
 select * into w from public.pdd_waybills where public_code=p_payload->>'public_code';
 if not found then raise exception 'RECORD_NOT_FOUND' using errcode='22023'; end if;
 select coalesce(jsonb_agg(public.pdd_registration_snapshot(r)),'[]') into regs from (select * from public.pdd_registrations where waybill_id=w.id order by created_at,id) r;
 select coalesce(jsonb_agg(public.pdd_query_log(q)),'[]') into queries from (select * from public.pdd_query_events where number=w.number order by queried_at desc,id limit 100) q;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'action',action,'actorId',actor_id,'notes',notes,'createdAt',created_at)),'[]') into events from (select * from public.pdd_audit_events where waybill_id=w.id order by created_at desc,id limit 100) e;
 return jsonb_build_object('record',public.pdd_admin_snapshot(w),'registrations',regs,'queries',queries,'events',events);
end$$;
create function public.pdd_admin_action(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.pdd_waybills; r public.pdd_registrations; a text:=p_payload->>'action'; actor uuid:=(p_payload->>'actor_id')::uuid; note text:=coalesce(p_payload->>'notes',''); begin
 if actor is null or length(note)>2000 then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 select * into w from public.pdd_waybills where public_code=p_payload->>'public_code';
 if not found then raise exception 'RECORD_NOT_FOUND' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('pdd-number:'||w.number,0));
 select * into w from public.pdd_waybills where id=w.id for update;
 if w.revision<>coalesce((p_payload->>'revision')::integer,0) then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
 if a='verify' and w.resolution in ('open','verifying') then
  update public.pdd_waybills set resolution='verifying' where id=w.id;
 elsif a='claim' and w.resolution in ('open','verifying','claimed') then
  if not exists(select 1 from public.pdd_registrations where waybill_id=w.id and mode='received' and visibility='active') then raise exception 'NEEDS_RECEIVED' using errcode='40001'; end if;
  update public.pdd_waybills set resolution='claimed' where id=w.id;
 elsif a='return' and w.resolution in ('claimed','resolved') then
  insert into public.pdd_handovers(waybill_id,actor_id) values(w.id,actor) on conflict do nothing;
  update public.pdd_waybills set resolution='resolved',closed_at=coalesce(closed_at,now()) where id=w.id;
  update public.pdd_registrations set closed_at=coalesce(closed_at,now()),revision=revision+1,updated_at=now() where waybill_id=w.id;
 elsif a='withdraw' then
  select * into r from public.pdd_registrations where waybill_id=w.id and registration_code=p_payload->>'registration_code' for update;
  if r.id is null then raise exception 'RECORD_NOT_FOUND' using errcode='22023'; end if;
  update public.pdd_registrations set visibility='withdrawn',closed_at=coalesce(closed_at,now()),revision=revision+1,updated_at=now() where id=r.id;
  update public.pdd_waybills set resolution=case when resolution='resolved' then resolution else 'open' end,closed_at=case when not exists(select 1 from public.pdd_registrations where waybill_id=w.id and visibility='active') then coalesce(closed_at,now()) else closed_at end where id=w.id;
 else raise exception 'INVALID_ADMIN_STATE' using errcode='40001'; end if;
 update public.pdd_waybills set revision=revision+1,updated_at=now() where id=w.id;
 insert into public.pdd_audit_events(waybill_id,registration_id,actor_id,action,notes) values(w.id,r.id,actor,a,note);
 return public.pdd_admin_detail(jsonb_build_object('public_code',w.public_code));
end$$;
create function public.pdd_stats(p_payload jsonb default '{}') returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object(
  'recordedPackageCount',(select count(*) from public.pdd_registrations where mode='received' and visibility='active'),
  'activeSeekerCount',(select count(distinct contact->>'kind'||':'||case when contact->>'kind'='phone' then regexp_replace(contact->>'value','[^0-9]','','g') else lower(contact->>'value') end) from public.pdd_registrations r join public.pdd_waybills w on w.id=r.waybill_id where r.mode='lost' and r.visibility='active' and w.resolution<>'resolved'),
  'successfulHandoverCount',(select case when count(*)>5 then count(*) else null end from public.pdd_handovers))
$$;
create function public.pdd_cleanup(p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare cleaned integer; n text; begin
 -- Use the same ordered number locks as registration/contact mutations. A request
 -- that authenticated before this cleanup must recheck authorization after waiting.
 for n in
  select number from (
   select w.number from public.pdd_waybills w where w.closed_at<now()-interval '30 days'
   union
   select w.number from public.pdd_registrations r join public.pdd_waybills w on w.id=r.waybill_id where r.closed_at<now()-interval '30 days'
   union
   select q.number from public.pdd_query_events q where q.queried_at<now()-interval '30 days'
  ) expired_numbers order by number
 loop perform pg_advisory_xact_lock(hashtextextended('pdd-number:'||n,0)); end loop;
 update public.pdd_registrations set contact=null,capability_hash='',revision=revision+1,updated_at=now() where closed_at<now()-interval '30 days' and (contact is not null or capability_hash<>'');
 get diagnostics cleaned=row_count;
 update public.pdd_query_events q set contact=null,capability_hash='' where exists(select 1 from public.pdd_waybills w where w.number=q.number and w.closed_at<now()-interval '30 days')
  or exists(select 1 from public.pdd_registrations r where r.id=q.registration_id and r.closed_at<now()-interval '30 days');
 update public.pdd_audit_events e set notes='' where exists(select 1 from public.pdd_waybills w where w.id=e.waybill_id and w.closed_at<now()-interval '30 days')
  or exists(select 1 from public.pdd_registrations r where r.id=e.registration_id and r.closed_at<now()-interval '30 days');
 delete from public.pdd_query_events where queried_at<now()-interval '30 days';
 delete from public.pdd_write_requests where created_at<now()-interval '30 days';
 return jsonb_build_object('cleanedRegistrations',cleaned);
end$$;
-- Retention runs independently of the OCR worker, its credits and its queue.
select cron.schedule('pdd404-retention','17 * * * *','select public.pdd_cleanup()');

do $$declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'pdd_%' loop
  execute format('revoke all on function %s from public, anon, authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end$$;
