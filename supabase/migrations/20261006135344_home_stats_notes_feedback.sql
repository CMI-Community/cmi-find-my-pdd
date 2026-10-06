-- Additive PDD404 lifetime statistics, private registration notes and feedback.
-- No public-code projection, management capability, OCR schema or recovery statistic changes.
create function public.pdd_clean_text(value text,max_length integer) returns text language plpgsql immutable set search_path='' as $$
declare cleaned text; begin
 if value is null then return null; end if;
 -- Reject control characters before trimming; only tab, LF and CR are allowed.
 if value ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F-\009F]' then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 cleaned:=btrim(value,U&'\0009\000A\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
 if char_length(cleaned)>max_length then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 return nullif(cleaned,'');
end$$;

alter table public.pdd_waybills add column matched_at timestamptz;
alter table public.pdd_registrations add column note text check(note is null or (char_length(note) between 1 and 500 and note is not distinct from public.pdd_clean_text(note,500)));
-- Backfill only retained successful-query evidence, never infer a match from two sides.
update public.pdd_waybills w set matched_at=e.first_match
 from (select number,min(queried_at) first_match from public.pdd_query_events where result='matched' group by number) e
 where w.number=e.number and w.matched_at is null;

create function public.pdd_home_stats(p_payload jsonb default '{}') returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'lostRegistered',(select count(distinct waybill_id) from public.pdd_registrations where mode='lost'),
  'receivedRegistered',(select count(distinct waybill_id) from public.pdd_registrations where mode='received'),
  'matchedParcels',(select count(*) from public.pdd_waybills where matched_at is not null))
$$;


create or replace function public.pdd_registration_snapshot(r public.pdd_registrations) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('registrationCode',r.registration_code,'number',w.number,'mode',r.mode,'source',r.source,
  'contact',public.pdd_contact_projection(r.contact),'note',r.note,'revision',r.revision,'visibility',r.visibility,
  'createdAt',r.created_at,'updatedAt',r.updated_at,'record',public.pdd_public_snapshot(w))
 from public.pdd_waybills w where w.id=r.waybill_id
$$;

create or replace function public.pdd_lookup(n text,m text) returns jsonb language plpgsql stable set search_path='' as $$
declare w public.pdd_waybills; own public.pdd_registrations; opposite public.pdd_registrations; outcome text; begin
 select * into w from public.pdd_waybills where number=n;
 if not found then return jsonb_build_object('result','not_found','record',null,'registeredAt',null,'contact',null,'note',null); end if;
 select * into own from public.pdd_registrations where waybill_id=w.id and mode=m and visibility='active';
 select * into opposite from public.pdd_registrations where waybill_id=w.id and mode<>m and visibility='active';
 if w.resolution='resolved' then outcome:='closed';
 elsif opposite.id is not null and public.pdd_contact_valid(opposite.contact) and (own.carrier is null or opposite.carrier is null or lower(own.carrier)=lower(opposite.carrier)) then outcome:='matched';
 elsif own.id is not null then outcome:='duplicate'; else outcome:='not_found'; end if;
 return jsonb_build_object('result',outcome,'record',public.pdd_public_snapshot(w),
  'registeredAt',case when outcome='matched' then opposite.created_at when outcome='duplicate' then own.created_at else null end,
  'contact',case when outcome='matched' then public.pdd_contact_projection(opposite.contact) else null end,
  'note',case when outcome='matched' then opposite.note else null end);
end$$;

create or replace function public.pdd_query(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
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
 answer:=public.pdd_lookup(n,m);
 if answer->>'result'='matched' then
  update public.pdd_waybills set matched_at=now() where number=n and matched_at is null;
 end if;
 return answer||jsonb_build_object('queryId',q.id,'queriedAt',q.queried_at);
end$$;

create or replace function public.pdd_batch_receipt(receipt jsonb,cap text,submitted_at timestamptz) returns jsonb language plpgsql volatile set search_path='' as $$
declare i jsonb; w public.pdd_waybills; r public.pdd_registrations; lookup jsonb; outcome text; items jsonb:='[]'; n text; begin
 -- Replays also serialize their current lookup with withdrawals and cleanup.
 for n in select wb.number from jsonb_array_elements(receipt) item join public.pdd_waybills wb on wb.public_code=item->>'publicCode' order by wb.number loop
  perform pg_advisory_xact_lock(hashtextextended('pdd-number:'||n,0));
 end loop;
 for i in select value from jsonb_array_elements(receipt) loop
  select * into w from public.pdd_waybills where public_code=i->>'publicCode';
  select * into r from public.pdd_registrations where registration_code=i->>'registrationCode' and capability_hash=cap and cap<>'';
  lookup:=public.pdd_lookup(w.number,i->>'mode'); outcome:=i->>'result';
  if lookup->>'result'='closed' then outcome:='closed';
  elsif lookup->>'result'='matched' then
   outcome:='matched';
   update public.pdd_waybills set matched_at=now() where id=w.id and matched_at is null;
  elsif outcome='matched' then outcome:=case when r.id is not null then 'registered' else 'duplicate' end; end if;
  items:=items||jsonb_build_array(jsonb_build_object('requestId',i->>'requestId','number',w.number,'result',outcome,
   'record',public.pdd_public_snapshot(w),'registration',case when r.id is not null then public.pdd_registration_snapshot(r) else null end,
   'contact',case when outcome='matched' then lookup->'contact' else null end,
   'note',case when outcome='matched' then lookup->'note' else null end,'registeredAt',coalesce(lookup->'registeredAt',to_jsonb(r.created_at))));
 end loop;
 return jsonb_build_object('submittedAt',submitted_at,'items',items);
end$$;

create or replace function public.pdd_batch_register(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare m text:=p_payload->>'mode'; cap text:=p_payload->>'capability_hash'; c jsonb:=public.pdd_contact_projection(p_payload->'contact');
 prior public.pdd_write_requests; w public.pdd_waybills; own public.pdd_registrations; i jsonb; n text; lookup jsonb; outcome text; receipt jsonb:='[]'; v_note text; begin
 if p_payload ? 'note' and p_payload->'note'<>'null'::jsonb and jsonb_typeof(p_payload->'note')<>'string' then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 v_note:=public.pdd_clean_text(p_payload->>'note',500);
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
   insert into public.pdd_registrations(waybill_id,request_id,mode,source,contact,capability_hash,note)
    values(w.id,(i->>'request_id')::uuid,m,i->>'source',c,cap,v_note) returning * into own;
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


-- Feedback is a separate private administrative resource, not a parcel registration.
create table public.pdd_feedback (
 id uuid primary key default gen_random_uuid(), request_id uuid not null unique,
 body_hash text not null check(length(body_hash)>0),
 message text not null check(char_length(message) between 1 and 2000 and message is not distinct from public.pdd_clean_text(message,2000)),
 contact jsonb check(contact is null or coalesce(public.pdd_contact_valid(contact),false)),
 status text not null default 'new' check(status in ('new','reviewed','closed')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index pdd_feedback_status_time on public.pdd_feedback(status,created_at desc,id);
alter table public.pdd_feedback enable row level security;
revoke all on public.pdd_feedback from public,anon,authenticated;
grant all on public.pdd_feedback to service_role;

create function public.pdd_feedback_snapshot(f public.pdd_feedback) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',f.id,'message',f.message,'contact',public.pdd_contact_projection(f.contact),
  'status',f.status,'createdAt',f.created_at,'updatedAt',f.updated_at)
$$;
create function public.pdd_feedback_submit(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.pdd_feedback; request uuid:=(p_payload->>'request_id')::uuid;
 msg text; c jsonb; begin
 if request is null or length(coalesce(p_payload->>'body_hash',''))=0 or coalesce(jsonb_typeof(p_payload->'message'),'')<>'string' then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 msg:=public.pdd_clean_text(p_payload->>'message',2000);
 if msg is null then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 if p_payload ? 'contact' and p_payload->'contact'<>'null'::jsonb then
  c:=public.pdd_contact_projection(p_payload->'contact');
  if c is null then raise exception 'INVALID_CONTACT' using errcode='22023'; end if;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('pdd-feedback:'||request::text,0));
 select * into r from public.pdd_feedback where request_id=request;
 if found then
  if r.body_hash<>p_payload->>'body_hash' then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='40001'; end if;
 else
  insert into public.pdd_feedback(request_id,body_hash,message,contact) values(request,p_payload->>'body_hash',msg,c) returning * into r;
 end if;
 -- The receipt intentionally contains no message, contact or administrative data.
 return jsonb_build_object('submitted',true,'feedbackId',r.id,'submittedAt',r.created_at);
end$$;
create function public.pdd_admin_feedback_list(p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare off integer:=coalesce((p_payload->>'offset')::integer,0); lim integer:=coalesce((p_payload->>'limit')::integer,50);
 filter text:=p_payload->>'status'; rows jsonb; total bigint; begin
 if off<0 or off>100000 or lim<1 or lim>100 or (filter is not null and filter not in ('new','reviewed','closed')) then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 select count(*) into total from public.pdd_feedback where filter is null or status=filter;
 select coalesce(jsonb_agg(public.pdd_feedback_snapshot(f)),'[]') into rows from
  (select * from public.pdd_feedback where filter is null or status=filter order by created_at desc,id offset off limit lim) f;
 return jsonb_build_object('items',rows,'total',total,'nextOffset',case when off+lim<total then off+lim else null end);
end$$;
create function public.pdd_admin_feedback_update(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.pdd_feedback; actor uuid:=(p_payload->>'actor_id')::uuid; next_status text:=p_payload->>'status'; old_status text; begin
 if actor is null or coalesce(next_status,'') not in ('new','reviewed','closed') then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 select * into r from public.pdd_feedback where id=(p_payload->>'feedback_id')::uuid for update;
 if not found then raise exception 'RECORD_NOT_FOUND' using errcode='22023'; end if;
 old_status:=r.status;
 if old_status<>next_status then
  update public.pdd_feedback set status=next_status,updated_at=now() where id=r.id returning * into r;
  insert into public.audit_events(actor_id,action,payload)
   values(actor,'feedback_status',jsonb_build_object('feedbackId',r.id,'fromStatus',old_status,'toStatus',next_status));
 end if;
 return public.pdd_feedback_snapshot(r);
end$$;


create or replace function public.pdd_cleanup(p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
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
 update public.pdd_registrations set contact=null,note=null,capability_hash='',revision=revision+1,updated_at=now() where closed_at<now()-interval '30 days' and (contact is not null or note is not null or capability_hash<>'');
 get diagnostics cleaned=row_count;
 update public.pdd_query_events q set contact=null,capability_hash='' where exists(select 1 from public.pdd_waybills w where w.number=q.number and w.closed_at<now()-interval '30 days')
  or exists(select 1 from public.pdd_registrations r where r.id=q.registration_id and r.closed_at<now()-interval '30 days');
 update public.pdd_audit_events e set notes='' where exists(select 1 from public.pdd_waybills w where w.id=e.waybill_id and w.closed_at<now()-interval '30 days')
  or exists(select 1 from public.pdd_registrations r where r.id=e.registration_id and r.closed_at<now()-interval '30 days');
 delete from public.pdd_query_events where queried_at<now()-interval '30 days';
 delete from public.pdd_write_requests where created_at<now()-interval '30 days';
 delete from public.pdd_feedback where status='closed' and updated_at<now()-interval '30 days';
 return jsonb_build_object('cleanedRegistrations',cleaned);
end$$;


-- All RPCs are called by the authenticated Edge service only. Browsers never query tables.
do $$declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'pdd_%' loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end$$;
