-- Read retained lifetime facts by their recorded timestamps. This is not a
-- historical snapshot backfill, and never reconstructs anonymous UTC-day clicks.
create function public.pdd_public_hourly_records(p_payload jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
 n integer:=48; d date; first_at timestamptz; end_at timestamptz;
 sampled timestamptz:=statement_timestamp(); first_recorded timestamptz; result jsonb;
begin
 if jsonb_typeof(p_payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('hours','date')) or (p_payload?'hours' and p_payload?'date') then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
 if p_payload?'date' then
  if not public.pdd_content_date(p_payload->>'date') then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  d:=(p_payload->>'date')::date;
  if d<(sampled at time zone 'Asia/Bangkok')::date-29 or d>(sampled at time zone 'Asia/Bangkok')::date then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  first_at:=d::timestamp at time zone 'Asia/Bangkok'; end_at:=least((d+1)::timestamp at time zone 'Asia/Bangkok',sampled);
 else
  if p_payload?'hours' then
   if jsonb_typeof(p_payload->'hours') is distinct from 'number' or coalesce(p_payload->>'hours','')!~'^[0-9]{1,3}$' then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
   n:=(p_payload->>'hours')::integer;
  end if;
  if n not between 1 and 720 then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  first_at:=(date_trunc('hour',sampled at time zone 'UTC') at time zone 'UTC')-make_interval(hours=>n); end_at:=sampled;
 end if;
 with sides as (
  -- Deduplicate across the whole retained history BEFORE selecting the window:
  -- withdrawing and registering the same side again is not a new lifetime side.
  select mode,waybill_id,min(created_at) at from public.pdd_registrations group by mode,waybill_id
 ), facts as (
  select case mode when 'lost' then 'lostRegistered' else 'receivedRegistered' end metric,at from sides
  union all select 'matchedParcels',matched_at from public.pdd_waybills where matched_at is not null
  union all select case mode when 'lost' then 'lostRecipientRegistered' else 'receivedRecipientRegistered' end,recipient_registered_at from public.pdd_registrations where recipient_registered_at is not null
  union all select case mode when 'lost' then 'lostRecipientRegistered' else 'receivedRecipientRegistered' end,created_at from public.pdd_recipient_leads
  union all select 'matchedRecipientLeads',recipient_matched_at from public.pdd_registrations where recipient_matched_at is not null
  union all select 'matchedRecipientLeads',recipient_matched_at from public.pdd_recipient_leads where recipient_matched_at is not null
 ), origin as (
  select min(at) earliest from facts
 ), buckets as (
  select h as hour from origin cross join lateral generate_series(
   greatest(first_at, date_trunc('hour',origin.earliest at time zone 'UTC') at time zone 'UTC'),
   date_trunc('hour',(end_at-interval '1 microsecond') at time zone 'UTC') at time zone 'UTC',interval '1 hour') h
  where origin.earliest is not null and first_at<end_at
 ), counts as (
  select date_trunc('hour',at at time zone 'UTC') at time zone 'UTC' as hour,metric,count(*) total
  from facts where at>=first_at and at<end_at group by 1,2
 ), values_by_hour as (
  select b.hour,jsonb_build_object(
   'lostRegistered',coalesce(max(total) filter(where metric='lostRegistered'),0),
   'receivedRegistered',coalesce(max(total) filter(where metric='receivedRegistered'),0),
   'matchedParcels',coalesce(max(total) filter(where metric='matchedParcels'),0),
   'lostRecipientRegistered',coalesce(max(total) filter(where metric='lostRecipientRegistered'),0),
   'receivedRecipientRegistered',coalesce(max(total) filter(where metric='receivedRecipientRegistered'),0),
   'matchedRecipientLeads',coalesce(max(total) filter(where metric='matchedRecipientLeads'),0)) stats
  from buckets b left join counts c on c.hour=b.hour group by b.hour
 ) select (select origin.earliest from origin),coalesce(jsonb_agg(jsonb_build_object('hour',hour,'stats',stats) order by hour),'[]') into first_recorded,result from values_by_hour;
 return jsonb_build_object('metricVersion','home-six-recorded-additions-v1','from',first_at,'until',sampled,'firstRecordedAt',first_recorded,'hours',result);
end$$;
revoke all on function public.pdd_public_hourly_records(jsonb) from public,anon,authenticated;
grant execute on function public.pdd_public_hourly_records(jsonb) to service_role;

-- Keep the history RPC identity, grants and existing genuine snapshots. Dashboard
-- already calls this function, so it obtains the independent recorded series.
do $migration$
declare definition text; anchor constant text:=$anchor$return jsonb_build_object('sampledAt',sampled,'snapshots',result);$anchor$;
begin
 definition:=pg_get_functiondef('public.pdd_public_hourly_history(jsonb)'::regprocedure);
 if length(definition)-length(replace(definition,anchor,''))<>length(anchor) then raise exception 'HOURLY_HISTORY_SOURCE_CHANGED'; end if;
 execute replace(definition,anchor,$replacement$return jsonb_build_object('sampledAt',sampled,'snapshots',result,'records',public.pdd_public_hourly_records(p_payload));$replacement$);
end
$migration$;

-- Private quality gates use the same retained event clocks as the public series.
-- Add six earliest timestamps and two query clocks, never business identifiers.
do $migration$
declare definition text; anchor constant text:=$anchor$from public.pdd_telemetry_budget where day>=(since_at at time zone 'UTC')::date)));$anchor$;
begin
 definition:=pg_get_functiondef('public.pdd_hourly_source(jsonb)'::regprocedure);
 if length(definition)-length(replace(definition,anchor,''))<>length(anchor) then raise exception 'HOURLY_SOURCE_HISTORY_CHANGED'; end if;
 execute replace(definition,anchor,$replacement$from public.pdd_telemetry_budget where day>=(since_at at time zone 'UTC')::date)))||jsonb_build_object(
  'businessFirstRecordedAt',jsonb_build_object(
   'lostRegistered',(select min(created_at) from public.pdd_registrations where mode='lost'),
   'receivedRegistered',(select min(created_at) from public.pdd_registrations where mode='received'),
   'matchedParcels',(select min(matched_at) from public.pdd_waybills where matched_at is not null),
   'lostRecipientRegistered',(select min(at) from(select recipient_registered_at at from public.pdd_registrations where mode='lost' and recipient_registered_at is not null union all select created_at from public.pdd_recipient_leads where mode='lost') facts),
   'receivedRecipientRegistered',(select min(at) from(select recipient_registered_at at from public.pdd_registrations where mode='received' and recipient_registered_at is not null union all select created_at from public.pdd_recipient_leads where mode='received') facts),
   'matchedRecipientLeads',(select min(at) from(select recipient_matched_at at from public.pdd_registrations where recipient_matched_at is not null union all select recipient_matched_at from public.pdd_recipient_leads where recipient_matched_at is not null) facts)),
  'queriesFirstRecordedAt',jsonb_build_object(
   'waybill',(select min(queried_at) from public.pdd_query_events where number!~*'(TEST|SYNTH|FIXTURE|DEMO|PDD404)'),
   'recipient',(select min(queried_at) from public.pdd_recipient_query_events where coalesce(recipient_name,'')!~*'(TEST|SYNTH|FIXTURE|DEMO|测试|合成|验收)')),
  'legacyDailyTraffic',jsonb_build_object('truncated',false,'events',(
   select coalesce(jsonb_agg(jsonb_build_object('day',day,'count',count) order by day),'[]') from(
    select day,sum(event_count) count from public.pdd_telemetry_daily
    where event='pdd_page_view' and day>=(until_at at time zone 'UTC')::date-8 and day<(until_at at time zone 'UTC')::date
    group by day order by day limit 8) daily)));$replacement$);
end
$migration$;
