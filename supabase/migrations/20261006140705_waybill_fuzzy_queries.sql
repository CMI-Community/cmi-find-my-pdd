-- Private exact matches remain the only contact/note disclosure and match-statistic source.
-- Similar queries return at most five explicit safe candidates, never inferred numbers.
alter table public.pdd_query_events drop constraint pdd_query_events_number_check;
alter table public.pdd_query_events add constraint pdd_query_events_number_check
 check(number ~ '^[A-Z0-9?*]{6,40}$' and length(translate(number,'?*',''))>=6);
alter table public.pdd_query_events drop constraint pdd_query_events_result_check;
alter table public.pdd_query_events add constraint pdd_query_events_result_check
 check(result in ('matched','possible','duplicate','not_found','closed'));

create function public.pdd_query_number(value text) returns text language plpgsql immutable set search_path='' as $$
declare normalized text:=public.cmi_number(value); begin
 if value is null or length(value)>100 or normalized !~ '^[A-Z0-9?*]{6,40}$' or length(translate(normalized,'?*',''))<6 then
  raise exception 'INVALID_WAYBILL' using errcode='22023';
 end if;
 return normalized;
end$$;

-- One row of dynamic programming at a time; at most 40 x 40 character comparisons.
-- ? and * are each one unknown character: substituting either always costs one.
-- Rows beyond the admissible distance stop early without affecting eligible results.
create function public.pdd_query_distance(pattern text,number text,max_distance integer) returns integer language plpgsql immutable set search_path='' as $$
declare previous integer[]; current_row integer[]; i integer; j integer; cost integer; row_min integer;
 p_len integer:=length(pattern); n_len integer:=length(number); begin
 if p_len not between 6 and 40 or n_len not between 6 and 40 or max_distance not between 0 and 40
  or pattern !~ '^[A-Z0-9?*]+$' or number !~ '^[A-Z0-9]+$' then raise exception 'INVALID_WAYBILL' using errcode='22023'; end if;
 if abs(p_len-n_len)>max_distance then return max_distance+1; end if;
 previous:=array(select generate_series(0,n_len));
 for i in 1..p_len loop
  current_row:=array_fill(0,array[n_len+1]); current_row[1]:=i; row_min:=i;
  for j in 1..n_len loop
   cost:=case when substr(pattern,i,1) not in ('?','*') and substr(pattern,i,1)=substr(number,j,1) then 0 else 1 end;
   current_row[j+1]:=least(current_row[j]+1,previous[j+1]+1,previous[j]+cost);
   row_min:=least(row_min,current_row[j+1]);
  end loop;
  if row_min>max_distance then return max_distance+1; end if;
  previous:=current_row;
 end loop;
 return previous[n_len+1];
end$$;

create function public.pdd_query_lookup(n text,m text) returns jsonb language plpgsql volatile set search_path='' as $$
declare answer jsonb; candidate record; distance integer; max_length integer; score numeric;
 candidates jsonb:='[]'; deadline timestamptz:=clock_timestamp()+interval '2 seconds'; begin
 answer:=public.pdd_lookup(n,m);
 -- A full exact matched, duplicate or closed record always takes precedence.
 if answer->>'result'<>'not_found' then return answer||jsonb_build_object('candidates',candidates); end if;
 for candidate in
  select wb.number,wb.public_code,registration.created_at
  from public.pdd_waybills wb join public.pdd_registrations registration on registration.waybill_id=wb.id
  where registration.mode<>m and registration.visibility='active' and public.pdd_contact_valid(registration.contact)
   and wb.resolution<>'resolved'
   and abs(length(n)-length(wb.number))*10<greatest(length(n),length(wb.number))*3
 loop
  -- Never report a partial scan as a genuine miss or an incomplete top-five list.
  if clock_timestamp()>deadline then raise exception 'QUERY_TIMEOUT' using errcode='57014'; end if;
  max_length:=greatest(length(n),length(candidate.number));
  distance:=public.pdd_query_distance(n,candidate.number,(max_length*3-1)/10);
  if distance>0 and distance*10<max_length*3 then
   score:=100::numeric*(1-distance::numeric/max_length);
   select coalesce(jsonb_agg(selected.item order by (selected.item->>'similarity')::numeric desc,
      (selected.item->>'registeredAt')::timestamptz desc,(selected.item->>'code') collate "C"),'[]') into candidates
   from (select value item from jsonb_array_elements(candidates||jsonb_build_array(jsonb_build_object(
      'code',candidate.public_code,'tail',right(candidate.number,4),'similarity',score,'registeredAt',candidate.created_at)))
    order by (value->>'similarity')::numeric desc,(value->>'registeredAt')::timestamptz desc,(value->>'code') collate "C" limit 5) selected;
  end if;
 end loop;
 if clock_timestamp()>deadline then raise exception 'QUERY_TIMEOUT' using errcode='57014'; end if;
 if jsonb_array_length(candidates)>0 then
  return jsonb_build_object('result','possible','record',null,'registeredAt',null,'contact',null,'note',null,'candidates',candidates);
 end if;
 return answer||jsonb_build_object('candidates',candidates);
end$$;

create or replace function public.pdd_query(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare n text:=public.pdd_query_number(p_payload->>'number'); m text:=p_payload->>'mode'; s text:=p_payload->>'source';
 q public.pdd_query_events; answer jsonb; allow_possible boolean; begin
 if p_payload ? 'allow_possible' and jsonb_typeof(p_payload->'allow_possible')<>'boolean' then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 allow_possible:=coalesce((p_payload->>'allow_possible')::boolean,false);
 if not allow_possible then perform public.pdd_number(n); end if;
 if coalesce(m,'') not in ('lost','received') or coalesce(s,'') not in ('manual','barcode') or coalesce(p_payload->>'capability_hash','') !~ '^[0-9a-f]{64}$' or length(coalesce(p_payload->>'body_hash',''))=0 then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('pdd-query:'||(p_payload->>'query_id'),0));
 perform pg_advisory_xact_lock(hashtextextended('pdd-number:'||n,0));
 select * into q from public.pdd_query_events where id=(p_payload->>'query_id')::uuid;
 if found then
  if q.capability_hash<>p_payload->>'capability_hash' or q.body_hash<>p_payload->>'body_hash' or q.number<>n or q.mode<>m or q.source<>s then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='40001'; end if;
 end if;
 -- Query and replay each execute one current lookup. Candidate PII is never cached.
 -- Cached older frontends know only exact results. Suggestions require explicit opt-in.
 answer:=case when allow_possible then public.pdd_query_lookup(n,m) else public.pdd_lookup(n,m)||jsonb_build_object('candidates','[]'::jsonb) end;
 if q.id is null then
  insert into public.pdd_query_events(id,number,mode,source,capability_hash,body_hash,result,waybill_id)
   values((p_payload->>'query_id')::uuid,n,m,s,p_payload->>'capability_hash',p_payload->>'body_hash',answer->>'result',
    case when answer->>'result'='possible' then null else (select id from public.pdd_waybills where number=n) end) returning * into q;
 end if;
 if answer->>'result'='matched' and n ~ '^[A-Z0-9]{6,40}$' then
  update public.pdd_waybills set matched_at=now() where number=n and matched_at is null;
 end if;
 return answer||jsonb_build_object('queryId',q.id,'queriedAt',q.queried_at);
end$$;

-- A fuzzy query log does not become a linked registration when a full typo is later registered.
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
   update public.pdd_query_events set waybill_id=w.id where number=n and waybill_id is null and result<>'possible';
   insert into public.pdd_audit_events(waybill_id,registration_id,action) values(w.id,own.id,'register');
   outcome:=case when lookup->>'result'='matched' then 'matched' else 'registered' end;
  end if;
  receipt:=receipt||jsonb_build_array(jsonb_build_object('requestId',i->>'request_id','publicCode',w.public_code,'mode',m,'result',outcome,'registrationCode',own.registration_code));
 end loop;
 insert into public.pdd_write_requests(scope,key,capability_hash,body_hash,receipt)
  values('batch',p_payload->>'request_id',cap,p_payload->>'body_hash',receipt) returning * into prior;
 return public.pdd_batch_receipt(receipt,cap,prior.created_at);
end$$;

-- The existing retention job handles both full numbers and literal query patterns.
-- No new anonymous or authenticated table/function access is introduced.
do $$declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname like 'pdd_%' loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end$$;
