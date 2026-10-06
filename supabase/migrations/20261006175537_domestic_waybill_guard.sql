-- Reject the confirmed forwarding prefix at both private query/registration boundaries.
-- No historical rows are deleted or rewritten; management/withdrawal stays available.
create or replace function public.pdd_number(t text) returns text language plpgsql immutable set search_path='' as $$
declare n text:=public.cmi_number(t); begin
 if left(n,4)='JTTH' then raise exception 'NON_DOMESTIC_WAYBILL' using errcode='22023'; end if;
 if t is null or length(t)>100 or n !~ '^[A-Z0-9]{6,40}$' then raise exception 'INVALID_WAYBILL' using errcode='22023'; end if;
 return n;
end$$;

create or replace function public.pdd_query_number(value text) returns text language plpgsql immutable set search_path='' as $$
declare normalized text:=public.cmi_number(value); begin
 if left(normalized,4)='JTTH' then raise exception 'NON_DOMESTIC_WAYBILL' using errcode='22023'; end if;
 if value is null or length(value)>100 or normalized !~ '^[A-Z0-9?*]{6,40}$' or length(translate(normalized,'?*',''))<6 then
  raise exception 'INVALID_WAYBILL' using errcode='22023';
 end if;
 return normalized;
end$$;

-- A contact-only request contains no number. Check its historical query after
-- capability verification and before any idempotent receipt/contact write.
-- Preserve the current function identity, owner, ACL and business error guards.
do $migration$
declare
 target oid:=to_regprocedure('public.pdd_query_contact(jsonb)')::oid;
 definition text; anchor constant text:=$anchor$ select * into prior from public.pdd_write_requests where pdd_write_requests.scope=v_scope and key=p_payload->>'idempotency_key';$anchor$;
begin
 if target is null then raise exception 'PDD_DOMESTIC_GUARD_MISSING_CONTACT_RPC'; end if;
 definition:=pg_get_functiondef(target);
 if length(definition)-length(replace(definition,anchor,''))<>length(anchor) then
  raise exception 'PDD_DOMESTIC_GUARD_UNEXPECTED_CONTACT_SOURCE';
 end if;
 execute replace(definition,anchor,$guard$ if left(public.cmi_number(q.number),4)='JTTH' then raise exception 'NON_DOMESTIC_WAYBILL' using errcode='22023'; end if;
$guard$||anchor);
end
$migration$;
