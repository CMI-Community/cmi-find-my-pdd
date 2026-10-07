-- Fixed name-flow events only; no input text or additional identity dimensions.
-- Preserve existing function identities/permissions and daily budgets.
create or replace function public.pdd_telemetry_event_valid(value text) returns boolean language sql immutable set search_path='' as $$
 select value=any(array[
  'pdd_page_view','pdd_visible_dwell','pdd_mode_selected',
  'pdd_lookup_waybill_selected','pdd_lookup_recipient_selected',
  'pdd_recipient_query_started','pdd_recipient_query_invalid','pdd_recipient_query_leads_found','pdd_recipient_query_not_found','pdd_recipient_query_error',
  'pdd_recipient_queue_added','pdd_recipient_queue_duplicate','pdd_recipient_queue_removed',
  'pdd_recipient_registration_started','pdd_recipient_registration_registered','pdd_recipient_registration_duplicate','pdd_recipient_registration_error',
  'pdd_query_started','pdd_query_invalid','pdd_query_domestic_blocked','pdd_query_matched','pdd_query_possible','pdd_query_duplicate','pdd_query_not_found','pdd_query_closed','pdd_query_error',
  'pdd_queue_added','pdd_queue_duplicate','pdd_queue_removed',
  'pdd_registration_started','pdd_registration_registered','pdd_registration_matched','pdd_registration_duplicate','pdd_registration_closed','pdd_registration_error',
  'pdd_scanner_open','pdd_scanner_close','pdd_scanner_mode','pdd_scanner_capture','pdd_scanner_not_found','pdd_scanner_decoded','pdd_scanner_permission_error','pdd_scanner_camera_error','pdd_scanner_reader_error','pdd_scanner_retried','pdd_scanner_camera_changed','pdd_scanner_mirror','pdd_scanner_focus_requested',
  'pdd_contact_copy','pdd_contact_saved','pdd_contact_error','pdd_feedback_open','pdd_feedback_started','pdd_feedback_submitted','pdd_feedback_error',
  'pdd_help_open','pdd_local_open','pdd_privacy_open','pdd_community_open','pdd_code_open','pdd_helper_qr_open'
 ]::text[])
$$;
create or replace function public.pdd_telemetry_ingest(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare item jsonb; events jsonb:=p_payload->'events'; allowed text[]; total integer:=0; counter integer;
 today date:=(now() at time zone 'UTC')::date; configured_limit integer; budget public.pdd_telemetry_budget;
begin
 if jsonb_typeof(p_payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('events','daily_limit'))
  or jsonb_typeof(events) is distinct from 'array' or jsonb_array_length(events) not between 1 and 24
  or octet_length(p_payload::text)>10000 or jsonb_typeof(p_payload->'daily_limit') is distinct from 'number'
  or coalesce(p_payload->>'daily_limit','') !~ '^[0-9]{1,6}$' then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 configured_limit:=(p_payload->>'daily_limit')::integer;
 if configured_limit not between 1 and 100000 then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 for item in select value from jsonb_array_elements(events) loop
  if jsonb_typeof(item)<>'object' or jsonb_typeof(item->'event')<>'string' or not coalesce(public.pdd_telemetry_event_valid(item->>'event'),false)
   or jsonb_typeof(item->'page')<>'string' or coalesce(item->>'page','') not in ('home','help','privacy','local')
   or jsonb_typeof(item->'count')<>'number' or coalesce(item->>'count','') !~ '^[0-9]{1,3}$'
   then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  counter:=(item->>'count')::integer;
  if counter not between 1 and 100 then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  allowed:=case
   when item->>'event'='pdd_visible_dwell' then array['bucket']
   when starts_with(item->>'event','pdd_recipient_query_') then array['mode']
   when starts_with(item->>'event','pdd_recipient_registration_') then array['mode','batch']
   when starts_with(item->>'event','pdd_recipient_queue_') or starts_with(item->>'event','pdd_lookup_') then array['mode']
   when left(item->>'event',10)='pdd_query_' then array['mode','source']
   when left(item->>'event',17)='pdd_registration_' then array['mode','batch']
   when left(item->>'event',12)='pdd_scanner_' then array['scanMode']
   when left(item->>'event',10)='pdd_queue_' or item->>'event'='pdd_mode_selected' then array['mode']
   else array[]::text[] end;
  if exists(select 1 from jsonb_object_keys(item) k where not(k=any(array['event','page','count']||allowed)))
   or (item ? 'mode' and (jsonb_typeof(item->'mode')<>'string' or item->>'mode' not in ('lost','received')))
   or (item ? 'source' and (jsonb_typeof(item->'source')<>'string' or item->>'source' not in ('manual','barcode')))
   or (item ? 'scanMode' and (jsonb_typeof(item->'scanMode')<>'string' or item->>'scanMode' not in ('photo','realtime')))
   or (item ? 'batch' and (jsonb_typeof(item->'batch')<>'string' or item->>'batch' not in ('1','2-5','6-20','21+')))
   or (item ? 'bucket' and (jsonb_typeof(item->'bucket')<>'string' or item->>'bucket' not in ('0-9s','10-29s','30-59s','1-2m','3-9m','10-30m')))
   or (item->>'event'='pdd_visible_dwell' and not(item ? 'bucket'))
   then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  total:=total+counter;
 end loop;
 -- The global daily row is locked before any aggregate write. Parallel batches
 -- can never exceed the cap, and a rejected batch contributes no partial count.
 insert into public.pdd_telemetry_budget(day,daily_limit) values(today,configured_limit) on conflict(day) do nothing;
 select * into budget from public.pdd_telemetry_budget where day=today for update;
 if budget.accepted_events+total>configured_limit or budget.accepted_batches>=20000 then
  update public.pdd_telemetry_budget set daily_limit=configured_limit,limited_at=coalesce(limited_at,now()) where day=today and (limited_at is null or daily_limit<>configured_limit);
  return jsonb_build_object('accepted',false,'recorded',0,'limited',true,'day',today);
 end if;
 for item in select value from jsonb_array_elements(events) loop
  insert into public.pdd_telemetry_daily(day,event,page,mode,source,scan_mode,batch_bucket,dwell_bucket,event_count)
   values(today,item->>'event',item->>'page',coalesce(item->>'mode',''),coalesce(item->>'source',''),coalesce(item->>'scanMode',''),coalesce(item->>'batch',''),coalesce(item->>'bucket',''),(item->>'count')::integer)
  on conflict(day,event,page,mode,source,scan_mode,batch_bucket,dwell_bucket) do update set event_count=public.pdd_telemetry_daily.event_count+excluded.event_count;
 end loop;
 update public.pdd_telemetry_budget set accepted_batches=accepted_batches+1,accepted_events=accepted_events+total,daily_limit=configured_limit where day=today;
 return jsonb_build_object('accepted',true,'recorded',total,'limited',false,'day',today);
end$$;

