-- Complete recipient-name leads are independent of exact-waybill matching/statistics.
-- New tables and RPCs are server-only; query projections disclose no parcel/code/capability.
create function public.pdd_recipient_name(value text) returns text language plpgsql immutable set search_path='' as $$
declare cleaned text; spaces constant text:=U&'\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'; begin
 if value is null or value ~ U&'[\0001-\001F\007F-\009F]' then raise exception 'INVALID_RECIPIENT_NAME' using errcode='22023'; end if;
 cleaned:=regexp_replace(btrim(normalize(value,NFC),spaces),'['||spaces||']+',' ','g');
 if char_length(cleaned) not between 1 and 80 then raise exception 'INVALID_RECIPIENT_NAME' using errcode='22023'; end if;
 return cleaned;
end$$;
create function public.pdd_recipient_key(value text) returns text language sql immutable set search_path='' as $$
 select case when value is null then null else translate(public.pdd_recipient_name(value),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') end
$$;

alter table public.pdd_registrations add column recipient_name text;
alter table public.pdd_registrations add column recipient_name_key text;
alter table public.pdd_registrations add constraint pdd_registration_recipient_valid check(
 (recipient_name is null and recipient_name_key is null) or
 (recipient_name is not null and recipient_name=public.pdd_recipient_name(recipient_name) and recipient_name_key is not distinct from public.pdd_recipient_key(recipient_name)));
create index pdd_registration_recipient_lookup on public.pdd_registrations(recipient_name_key,mode,created_at,id) where visibility='active' and recipient_name_key is not null;

create table public.pdd_recipient_leads (
 id uuid primary key default gen_random_uuid(),
 registration_code text not null unique default 'PDD-N-'||upper(encode(extensions.gen_random_bytes(8),'hex')),
 request_id uuid not null unique, mode text not null check(mode in ('lost','received')),
 recipient_name text, recipient_name_key text, contact jsonb, note text,
 capability_hash text not null check(capability_hash='' or capability_hash ~ '^[0-9a-f]{64}$'),
 state text not null default 'active' check(state in ('active','reviewing','closed','withdrawn')),
 revision integer not null default 1 check(revision>=1), created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(), closed_at timestamptz,
 check((recipient_name is null and recipient_name_key is null) or (recipient_name is not null and recipient_name=public.pdd_recipient_name(recipient_name) and recipient_name_key is not distinct from public.pdd_recipient_key(recipient_name))),
 check(contact is null or coalesce(public.pdd_contact_valid(contact),false)),
 check(note is null or (char_length(note) between 1 and 500 and note is not distinct from public.pdd_clean_text(note,500))),
 check(state not in ('active','reviewing') or (recipient_name is not null and contact is not null and capability_hash<>''))
);
create unique index pdd_recipient_one_active_contact on public.pdd_recipient_leads(recipient_name_key,mode,(contact->>'kind'),(contact->>'value')) where state in ('active','reviewing');
create index pdd_recipient_lead_lookup on public.pdd_recipient_leads(recipient_name_key,mode,created_at,id) where state in ('active','reviewing');
create table public.pdd_recipient_query_events (
 id uuid primary key, recipient_name text not null, recipient_name_key text not null,
 mode text not null check(mode in ('lost','received')), capability_hash text not null check(capability_hash ~ '^[0-9a-f]{64}$'),
 body_hash text not null check(length(body_hash)>0), result text not null check(result in ('leads_found','not_found')),
 queried_at timestamptz not null default now(), cursors jsonb not null default '[]' check(jsonb_typeof(cursors)='array'),
 check(recipient_name=public.pdd_recipient_name(recipient_name) and recipient_name_key=public.pdd_recipient_key(recipient_name))
);
create index pdd_recipient_query_time on public.pdd_recipient_query_events(queried_at desc,id);
create table public.pdd_recipient_audit_events (
 id uuid primary key default gen_random_uuid(), lead_id uuid not null references public.pdd_recipient_leads(id),
 actor_id uuid, action text not null, created_at timestamptz not null default now()
);
do $$declare t text; begin
 foreach t in array array['pdd_recipient_leads','pdd_recipient_query_events','pdd_recipient_audit_events'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end$$;

create function public.pdd_recipient_snapshot(r public.pdd_recipient_leads) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('registrationCode',r.registration_code,'recipientName',r.recipient_name,'mode',r.mode,
 'contact',public.pdd_contact_projection(r.contact),'note',r.note,'state',r.state,'revision',r.revision,'createdAt',r.created_at,'updatedAt',r.updated_at)
$$;
-- Cursor anchors contain internal IDs only in the private query log, never in a DTO.
-- Upper bound fixes the original query's creation window; withdrawals are rechecked each page.
create function public.pdd_recipient_lookup(key text,m text,until_at timestamptz,after_anchor jsonb default null) returns jsonb language plpgsql stable set search_path='' as $$
declare rows jsonb; leads jsonb; anchor jsonb; begin
 with all_leads as (
  select r.recipient_name,r.contact,r.note,r.created_at,r.id,'waybill'::text source
  from public.pdd_registrations r join public.pdd_waybills w on w.id=r.waybill_id
  where r.recipient_name_key=key and r.mode<>m and r.visibility='active' and r.closed_at is null and w.resolution<>'resolved' and public.pdd_contact_valid(r.contact)
  union all
  select r.recipient_name,r.contact,r.note,r.created_at,r.id,'recipient'::text source from public.pdd_recipient_leads r
  where r.recipient_name_key=key and r.mode<>m and r.state in ('active','reviewing') and r.closed_at is null and public.pdd_contact_valid(r.contact)
 ), page as (
  select * from all_leads where created_at<=until_at and (after_anchor is null or (created_at,id,source)>((after_anchor->>'at')::timestamptz,(after_anchor->>'id')::uuid,after_anchor->>'source'))
  order by created_at,id,source limit 21
 ) select coalesce(jsonb_agg(to_jsonb(page) order by created_at,id,source),'[]') into rows from page;
 select coalesce(jsonb_agg(jsonb_build_object('recipientName',r->>'recipient_name','registeredAt',r->'created_at','contact',public.pdd_contact_projection(r->'contact'),'note',r->'note') order by ord),'[]') into leads
 from jsonb_array_elements(rows) with ordinality x(r,ord) where ord<=20;
 if jsonb_array_length(rows)>20 then
  anchor:=jsonb_build_object('at',rows->19->'created_at','id',rows->19->'id','source',rows->19->'source');
 end if;
 return jsonb_build_object('leads',leads,'anchor',anchor);
end$$;
create function public.pdd_recipient_query_response(q public.pdd_recipient_query_events,after_anchor jsonb default null) returns jsonb language plpgsql volatile set search_path='' as $$
declare answer jsonb; cursor jsonb; token uuid; begin
 answer:=public.pdd_recipient_lookup(q.recipient_name_key,q.mode,q.queried_at,after_anchor);
 if answer->'anchor'<>'null'::jsonb then
  select value into cursor from jsonb_array_elements(q.cursors) where value->'anchor'=answer->'anchor' limit 1;
  if cursor is null then
   token:=gen_random_uuid(); cursor:=jsonb_build_object('token',token,'anchor',answer->'anchor');
   update public.pdd_recipient_query_events set cursors=cursors||jsonb_build_array(cursor) where id=q.id;
  else token:=(cursor->>'token')::uuid; end if;
 end if;
 return jsonb_build_object('queryId',q.id,'result',case when jsonb_array_length(answer->'leads')>0 then 'leads_found' else 'not_found' end,
 'queriedAt',q.queried_at,'leads',answer->'leads','nextCursor',token);
end$$;
create function public.pdd_recipient_query(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare n text:=public.pdd_recipient_name(p_payload->>'recipient_name'); m text:=p_payload->>'mode'; cap text:=p_payload->>'capability_hash'; q public.pdd_recipient_query_events; answer jsonb; begin
 if coalesce(jsonb_typeof(p_payload->'recipient_name'),'')<>'string' or coalesce(m,'') not in ('lost','received') or coalesce(cap,'') !~ '^[0-9a-f]{64}$' or length(coalesce(p_payload->>'body_hash',''))=0 or p_payload->>'query_id' is null then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('pdd-recipient-registry',0));
 select * into q from public.pdd_recipient_query_events where id=(p_payload->>'query_id')::uuid;
 if found then
  if q.capability_hash<>cap or q.body_hash<>p_payload->>'body_hash' or q.recipient_name_key<>public.pdd_recipient_key(n) or q.mode<>m then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='P0001'; end if;
 else
  answer:=public.pdd_recipient_lookup(public.pdd_recipient_key(n),m,now());
  insert into public.pdd_recipient_query_events(id,recipient_name,recipient_name_key,mode,capability_hash,body_hash,result)
   values((p_payload->>'query_id')::uuid,n,public.pdd_recipient_key(n),m,cap,p_payload->>'body_hash',case when jsonb_array_length(answer->'leads')>0 then 'leads_found' else 'not_found' end) returning * into q;
 end if;
 -- Always read current disclosure state, never cache contacts or notes in a receipt.
 return public.pdd_recipient_query_response(q);
end$$;
create function public.pdd_recipient_query_page(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare q public.pdd_recipient_query_events; cursor jsonb; begin
 perform pg_advisory_xact_lock(hashtextextended('pdd-recipient-registry',0));
 select * into q from public.pdd_recipient_query_events where id=(p_payload->>'query_id')::uuid;
 if not found or q.capability_hash<>coalesce(p_payload->>'capability_hash','') then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if q.queried_at<now()-interval '30 days' then raise exception 'QUERY_EXPIRED' using errcode='22023'; end if;
 select value into cursor from jsonb_array_elements(q.cursors) where value->>'token'=p_payload->>'cursor';
 if cursor is null then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 return public.pdd_recipient_query_response(q,cursor->'anchor');
end$$;

create function public.pdd_recipient_batch_receipt(receipt jsonb,cap text,submitted_at timestamptz) returns jsonb language plpgsql stable set search_path='' as $$
declare i jsonb; r public.pdd_recipient_leads; items jsonb:='[]'; begin
 for i in select value from jsonb_array_elements(receipt) loop
  select * into r from public.pdd_recipient_leads where registration_code=i->>'registrationCode' and capability_hash=cap and cap<>'';
  items:=items||jsonb_build_array(jsonb_build_object('requestId',i->>'requestId','recipientName',i->>'recipientName','result',i->>'result','registration',case when r.id is not null then public.pdd_recipient_snapshot(r) else null end));
 end loop;
 return jsonb_build_object('submittedAt',submitted_at,'items',items);
end$$;
create function public.pdd_recipient_batch_register(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare m text:=p_payload->>'mode'; cap text:=p_payload->>'capability_hash'; c jsonb:=public.pdd_contact_projection(p_payload->'contact'); v_note text;
 prior public.pdd_write_requests; r public.pdd_recipient_leads; i jsonb; n text; outcome text; receipt jsonb:='[]'; begin
 if p_payload ? 'note' and p_payload->'note'<>'null'::jsonb and jsonb_typeof(p_payload->'note')<>'string' then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 v_note:=public.pdd_clean_text(p_payload->>'note',500);
 if coalesce(m,'') not in ('lost','received') or c is null or coalesce(cap,'') !~ '^[0-9a-f]{64}$' or length(coalesce(p_payload->>'request_id','')) not between 1 and 128 or length(coalesce(p_payload->>'body_hash',''))=0
 or coalesce(jsonb_typeof(p_payload->'items'),'')<>'array' then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 if jsonb_array_length(p_payload->'items') not between 1 and 50 then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(p_payload->'items') entry(value) where jsonb_typeof(entry.value)<>'object' or jsonb_typeof(entry.value->'recipient_name')<>'string' or entry.value->>'request_id' is null)
 or (select count(*)<>count(distinct public.pdd_recipient_key(value->>'recipient_name')) or count(*)<>count(distinct value->>'request_id') from jsonb_array_elements(p_payload->'items')) then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('pdd-recipient-registry',0));
 select * into prior from public.pdd_write_requests where scope='recipient-batch' and key=p_payload->>'request_id';
 if found then
  if prior.capability_hash<>cap or prior.body_hash<>p_payload->>'body_hash' or jsonb_array_length(prior.receipt)=0 then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='P0001'; end if;
  return public.pdd_recipient_batch_receipt(prior.receipt,cap,prior.created_at);
 end if;
 for i in select value from jsonb_array_elements(p_payload->'items') loop
  n:=public.pdd_recipient_name(i->>'recipient_name');
  if exists(select 1 from public.pdd_recipient_leads where request_id=(i->>'request_id')::uuid) then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='P0001'; end if;
  select * into r from public.pdd_recipient_leads where recipient_name_key=public.pdd_recipient_key(n) and mode=m and state in ('active','reviewing') and contact->>'kind'=c->>'kind' and contact->>'value'=c->>'value';
  if found then outcome:='duplicate'; r:=null;
  else
   insert into public.pdd_recipient_leads(request_id,mode,recipient_name,recipient_name_key,contact,note,capability_hash) values((i->>'request_id')::uuid,m,n,public.pdd_recipient_key(n),c,v_note,cap) returning * into r;
   insert into public.pdd_recipient_audit_events(lead_id,action) values(r.id,'register'); outcome:='registered';
  end if;
  -- Receipt stores the submitting name but no third-party contact or note snapshot.
  receipt:=receipt||jsonb_build_array(jsonb_build_object('requestId',i->>'request_id','recipientName',n,'result',outcome,'registrationCode',r.registration_code));
 end loop;
 insert into public.pdd_write_requests(scope,key,capability_hash,body_hash,receipt) values('recipient-batch',p_payload->>'request_id',cap,p_payload->>'body_hash',receipt) returning * into prior;
 return public.pdd_recipient_batch_receipt(receipt,cap,prior.created_at);
end$$;

create function public.pdd_recipient_manage(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.pdd_recipient_leads; begin
 select * into r from public.pdd_recipient_leads where registration_code=p_payload->>'registration_code' and capability_hash=p_payload->>'capability_hash' and capability_hash<>'';
 if not found then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 return public.pdd_recipient_snapshot(r);
end$$;
create function public.pdd_recipient_manage_update(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.pdd_recipient_leads; a text:=p_payload->>'action'; n text; c jsonb; begin
 perform pg_advisory_xact_lock(hashtextextended('pdd-recipient-registry',0));
 select * into r from public.pdd_recipient_leads where registration_code=p_payload->>'registration_code' for update;
 if not found or r.capability_hash='' or r.capability_hash<>coalesce(p_payload->>'capability_hash','') then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if r.revision<>coalesce((p_payload->>'revision')::integer,0) then raise exception 'VERSION_CONFLICT' using errcode='P0001'; end if;
 if a='update' then
  if r.state not in ('active','reviewing') or not (p_payload ? 'recipient_name' or p_payload ? 'contact') then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  if p_payload ? 'recipient_name' and coalesce(jsonb_typeof(p_payload->'recipient_name'),'')<>'string' then raise exception 'INVALID_RECIPIENT_NAME' using errcode='22023'; end if;
  n:=case when p_payload ? 'recipient_name' then public.pdd_recipient_name(p_payload->>'recipient_name') else r.recipient_name end;
  c:=case when p_payload ? 'contact' then public.pdd_contact_projection(p_payload->'contact') else r.contact end;
  if c is null then raise exception 'INVALID_CONTACT' using errcode='22023'; end if;
  if exists(select 1 from public.pdd_recipient_leads where id<>r.id and recipient_name_key=public.pdd_recipient_key(n) and mode=r.mode and state in ('active','reviewing') and contact->>'kind'=c->>'kind' and contact->>'value'=c->>'value') then raise exception 'DUPLICATE_RECIPIENT' using errcode='P0001'; end if;
  update public.pdd_recipient_leads set recipient_name=n,recipient_name_key=public.pdd_recipient_key(n),contact=c,revision=revision+1,updated_at=now() where id=r.id returning * into r;
 elsif a='withdraw' then
  if r.state not in ('active','reviewing') then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  update public.pdd_recipient_leads set state='withdrawn',closed_at=now(),revision=revision+1,updated_at=now() where id=r.id returning * into r;
 else raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 insert into public.pdd_recipient_audit_events(lead_id,action) values(r.id,'owner_'||a);
 return public.pdd_recipient_snapshot(r);
end$$;

create function public.pdd_recipient_admin_list(p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare off integer:=coalesce((p_payload->>'offset')::integer,0); lim integer:=coalesce((p_payload->>'limit')::integer,50); rows jsonb; total bigint; begin
 if off<0 or off>100000 or lim not between 1 and 100 then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 select count(*) into total from public.pdd_recipient_leads;
 select coalesce(jsonb_agg(public.pdd_recipient_snapshot(r) order by r.updated_at desc,r.id),'[]') into rows from (select * from public.pdd_recipient_leads order by updated_at desc,id offset off limit lim) r;
 return jsonb_build_object('items',rows,'nextOffset',case when off+lim<total then off+lim else null end);
end$$;
create function public.pdd_recipient_admin_queries(p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare off integer:=coalesce((p_payload->>'offset')::integer,0); lim integer:=coalesce((p_payload->>'limit')::integer,50); rows jsonb; total bigint; begin
 if off<0 or off>100000 or lim not between 1 and 100 then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 select count(*) into total from public.pdd_recipient_query_events;
 select coalesce(jsonb_agg(jsonb_build_object('queryId',r.id,'recipientName',r.recipient_name,'mode',r.mode,'result',r.result,'queriedAt',r.queried_at) order by r.queried_at desc,r.id),'[]') into rows from (select * from public.pdd_recipient_query_events order by queried_at desc,id offset off limit lim) r;
 return jsonb_build_object('items',rows,'nextOffset',case when off+lim<total then off+lim else null end);
end$$;
create function public.pdd_recipient_admin_detail(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.pdd_recipient_leads; events jsonb; begin
 select * into r from public.pdd_recipient_leads where registration_code=p_payload->>'registration_code';
 if not found then raise exception 'RECORD_NOT_FOUND' using errcode='22023'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'action',action,'actorId',actor_id,'notes','','createdAt',created_at) order by created_at desc,id),'[]') into events from (select * from public.pdd_recipient_audit_events where lead_id=r.id order by created_at desc,id limit 100) e;
 return jsonb_build_object('registration',public.pdd_recipient_snapshot(r),'events',events);
end$$;
create function public.pdd_recipient_admin_action(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.pdd_recipient_leads; actor uuid:=(p_payload->>'actor_id')::uuid; a text:=p_payload->>'action'; begin
 if actor is null or coalesce(a,'') not in ('review','close','withdraw') then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('pdd-recipient-registry',0));
 select * into r from public.pdd_recipient_leads where registration_code=p_payload->>'registration_code' for update;
 if not found then raise exception 'RECORD_NOT_FOUND' using errcode='22023'; end if;
 if r.revision<>coalesce((p_payload->>'revision')::integer,0) then raise exception 'VERSION_CONFLICT' using errcode='P0001'; end if;
 if r.state not in ('active','reviewing') then raise exception 'INVALID_ADMIN_STATE' using errcode='P0001'; end if;
 update public.pdd_recipient_leads set state=case a when 'review' then 'reviewing' when 'close' then 'closed' else 'withdrawn' end,
 closed_at=case when a in ('close','withdraw') then now() else null end,revision=revision+1,updated_at=now() where id=r.id returning * into r;
 insert into public.pdd_recipient_audit_events(lead_id,actor_id,action) values(r.id,actor,'admin_'||a);
 return public.pdd_recipient_admin_detail(jsonb_build_object('registration_code',r.registration_code));
end$$;

create or replace function public.pdd_registration_snapshot(r public.pdd_registrations) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('registrationCode',r.registration_code,'number',w.number,'mode',r.mode,'source',r.source,
  'contact',public.pdd_contact_projection(r.contact),'note',r.note,'recipientName',r.recipient_name,'revision',r.revision,'visibility',r.visibility,
  'createdAt',r.created_at,'updatedAt',r.updated_at,'record',public.pdd_public_snapshot(w))
 from public.pdd_waybills w where w.id=r.waybill_id
$$;
-- Extend the current reviewed functions in place, preserving prior domestic/fuzzy/error guards.
-- Every source anchor is checked before rewriting so unexpected historical source fails safely.
do $migration$
declare definition text; anchor text; replacement text; begin
 definition:=pg_get_functiondef('public.pdd_batch_register(jsonb)'::regprocedure);
 anchor:=$anchor$ if p_payload ? 'note'$anchor$;
 if strpos(definition,anchor)=0 then raise exception 'RECIPIENT_BATCH_SOURCE_CHANGED'; end if;
 definition:=replace(definition,anchor,$replacement$ perform pg_advisory_xact_lock(hashtextextended('pdd-recipient-registry',0));
 if p_payload ? 'note'$replacement$);
 anchor:=$anchor$  n:=public.pdd_number(i->>'number');$anchor$;
 if strpos(definition,anchor)=0 then raise exception 'RECIPIENT_BATCH_NUMBER_SOURCE_CHANGED'; end if;
 definition:=replace(definition,anchor,anchor||$replacement$
  if i ? 'recipient_name' and i->'recipient_name'<>'null'::jsonb then
   if jsonb_typeof(i->'recipient_name')<>'string' then raise exception 'INVALID_RECIPIENT_NAME' using errcode='22023'; end if;
   perform public.pdd_recipient_name(i->>'recipient_name');
  end if;$replacement$);
 anchor:=$anchor$insert into public.pdd_registrations(waybill_id,request_id,mode,source,contact,capability_hash,note)
    values(w.id,(i->>'request_id')::uuid,m,i->>'source',c,cap,v_note)$anchor$;
 if strpos(definition,anchor)=0 then raise exception 'RECIPIENT_BATCH_INSERT_SOURCE_CHANGED'; end if;
 definition:=replace(definition,anchor,$replacement$insert into public.pdd_registrations(waybill_id,request_id,mode,source,contact,capability_hash,note,recipient_name,recipient_name_key)
    values(w.id,(i->>'request_id')::uuid,m,i->>'source',c,cap,v_note,case when i->>'recipient_name' is not null then public.pdd_recipient_name(i->>'recipient_name') end,public.pdd_recipient_key(i->>'recipient_name'))$replacement$);
 anchor:=$anchor$'registrationCode',own.registration_code)$anchor$;
 if strpos(definition,anchor)=0 then raise exception 'RECIPIENT_BATCH_RECEIPT_SOURCE_CHANGED'; end if;
 definition:=replace(definition,anchor,$replacement$'registrationCode',own.registration_code,'recipientNameSaved',own.id is not null and own.recipient_name is not null)$replacement$);
 execute definition;

 definition:=pg_get_functiondef('public.pdd_batch_receipt(jsonb,text,timestamptz)'::regprocedure);
 anchor:=$anchor$'requestId',i->>'requestId','number',w.number,'result',outcome,$anchor$;
 if strpos(definition,anchor)=0 then raise exception 'RECIPIENT_RECEIPT_SOURCE_CHANGED'; end if;
 execute replace(definition,anchor,anchor||$replacement$'recipientNameSaved',coalesce((i->>'recipientNameSaved')::boolean,false),$replacement$);

 definition:=pg_get_functiondef('public.pdd_manage_update(jsonb)'::regprocedure);
 anchor:=$anchor$ select * into r from public.pdd_registrations where registration_code=$anchor$;
 if strpos(definition,anchor)=0 then raise exception 'RECIPIENT_MANAGE_SOURCE_CHANGED'; end if;
 definition:=replace(definition,anchor,$replacement$ perform pg_advisory_xact_lock(hashtextextended('pdd-recipient-registry',0));
$replacement$||anchor);
 anchor:=$anchor$  if c is null or r.visibility<>'active' then raise exception 'INVALID_CONTACT' using errcode='22023'; end if;
  update public.pdd_registrations set contact=c,revision=revision+1,updated_at=now() where id=r.id returning * into r;$anchor$;
 if strpos(definition,anchor)=0 then raise exception 'RECIPIENT_MANAGE_CONTACT_SOURCE_CHANGED'; end if;
 definition:=replace(definition,anchor,$replacement$  if r.visibility<>'active' or not (p_payload ? 'contact' or p_payload ? 'recipient_name') then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  if p_payload ? 'contact' and c is null then raise exception 'INVALID_CONTACT' using errcode='22023'; end if;
  if p_payload ? 'recipient_name' and p_payload->'recipient_name'<>'null'::jsonb and jsonb_typeof(p_payload->'recipient_name')<>'string' then raise exception 'INVALID_RECIPIENT_NAME' using errcode='22023'; end if;
  update public.pdd_registrations set contact=case when p_payload ? 'contact' then c else contact end,
   recipient_name=case when p_payload ? 'recipient_name' then case when p_payload->>'recipient_name' is null then null else public.pdd_recipient_name(p_payload->>'recipient_name') end else recipient_name end,
   recipient_name_key=case when p_payload ? 'recipient_name' then public.pdd_recipient_key(p_payload->>'recipient_name') else recipient_name_key end,
   revision=revision+1,updated_at=now() where id=r.id returning * into r;$replacement$);
 execute definition;

 definition:=pg_get_functiondef('public.pdd_admin_action(jsonb)'::regprocedure);
 anchor:=$anchor$ select * into w from public.pdd_waybills where public_code=$anchor$;
 if strpos(definition,anchor)=0 then raise exception 'RECIPIENT_ADMIN_SOURCE_CHANGED'; end if;
 execute replace(definition,anchor,$replacement$ perform pg_advisory_xact_lock(hashtextextended('pdd-recipient-registry',0));
$replacement$||anchor);

 definition:=pg_get_functiondef('public.pdd_cleanup(jsonb)'::regprocedure);
 anchor:=$anchor$ -- Use the same ordered number locks$anchor$;
 if strpos(definition,anchor)=0 then raise exception 'RECIPIENT_CLEANUP_SOURCE_CHANGED'; end if;
 definition:=replace(definition,anchor,$replacement$ perform pg_advisory_xact_lock(hashtextextended('pdd-recipient-registry',0));
$replacement$||anchor);
 anchor:=$anchor$set contact=null,note=null,capability_hash=''$anchor$;
 if strpos(definition,anchor)=0 then raise exception 'RECIPIENT_CLEANUP_CONTACT_SOURCE_CHANGED'; end if;
 definition:=replace(definition,anchor,$replacement$set contact=null,note=null,recipient_name=null,recipient_name_key=null,capability_hash=''$replacement$);
 anchor:=$anchor$(contact is not null or note is not null or capability_hash<>'')$anchor$;
 definition:=replace(definition,anchor,$replacement$(contact is not null or note is not null or recipient_name is not null or capability_hash<>'')$replacement$);
 -- Preserve recipient batch request identity after clearing private receipts. Duplicate
 -- items have no registration request_id, so deleting the key could recreate an old batch.
 anchor:=$anchor$ delete from public.pdd_write_requests where created_at<now()-interval '30 days';$anchor$;
 if strpos(definition,anchor)=0 then raise exception 'RECIPIENT_CLEANUP_IDEMPOTENCY_SOURCE_CHANGED'; end if;
 definition:=replace(definition,anchor,$replacement$ delete from public.pdd_write_requests where scope<>'recipient-batch' and created_at<now()-interval '30 days';$replacement$);
 anchor:=$anchor$ return jsonb_build_object('cleanedRegistrations',cleaned);$anchor$;
 if strpos(definition,anchor)=0 then raise exception 'RECIPIENT_CLEANUP_RETURN_SOURCE_CHANGED'; end if;
 definition:=replace(definition,anchor,$replacement$ update public.pdd_recipient_leads set recipient_name=null,recipient_name_key=null,contact=null,note=null,capability_hash='',revision=revision+1,updated_at=now()
  where closed_at<now()-interval '30 days' and (recipient_name is not null or contact is not null or note is not null or capability_hash<>'');
 delete from public.pdd_recipient_query_events where queried_at<now()-interval '30 days';
 -- Clear every old recipient receipt, including duplicates without a registrationCode.
 -- Retain only request key/capability/body digests as an idempotency tombstone.
 update public.pdd_write_requests wr set receipt='[]'::jsonb where wr.scope='recipient-batch' and wr.receipt<>'[]'::jsonb and
  (wr.created_at<now()-interval '30 days' or exists(select 1 from jsonb_array_elements(wr.receipt) item join public.pdd_recipient_leads r on r.registration_code=item->>'registrationCode' where r.capability_hash=''));
 return jsonb_build_object('cleanedRegistrations',cleaned);$replacement$);
 execute definition;
end
$migration$;

-- Revoke helpers as well as security-definer entrypoints. No browser database access.
do $$declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'pdd_%' loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end$$;
