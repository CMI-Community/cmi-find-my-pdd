-- Lifetime recipient-lead counts stay separate from parcel matching/return facts.
-- These timestamps contain no name/contact snapshot and survive privacy cleanup.
alter table public.pdd_registrations add column recipient_registered_at timestamptz;
alter table public.pdd_registrations add column recipient_matched_at timestamptz;
alter table public.pdd_recipient_leads add column recipient_matched_at timestamptz;

-- Backfill only a currently retained name or an explicit successful-save receipt.
-- A receipt gives a proven save time. Without one, use this migration's timestamp,
-- not the parcel's creation time (a name may have been added much later).
with saved_receipts as (
 select item->>'registrationCode' registration_code,min(w.created_at) saved_at
 from public.pdd_write_requests w cross join lateral jsonb_array_elements(w.receipt) item
 where w.scope='batch' and item->'recipientNameSaved'='true'::jsonb and item->>'registrationCode' is not null
 group by item->>'registrationCode'
), evidence as (
 select r.id,e.saved_at from public.pdd_registrations r
 left join saved_receipts e on e.registration_code=r.registration_code
 where r.recipient_name is not null or e.registration_code is not null
)
update public.pdd_registrations r set recipient_registered_at=coalesce(e.saved_at,now())
from evidence e where r.id=e.id;
-- No historical name-query result can prove which individual rows were returned.
-- recipient_matched_at therefore starts empty on both sources.

create function public.pdd_recipient_stat_markers() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_table_name='pdd_registrations' then
  if tg_op='UPDATE' and old.recipient_registered_at is not null then
   new.recipient_registered_at:=old.recipient_registered_at;
  elsif new.recipient_registered_at is null and new.recipient_name is not null then
   new.recipient_registered_at:=now();
  end if;
 end if;
 if tg_op='UPDATE' and old.recipient_matched_at is not null then
  new.recipient_matched_at:=old.recipient_matched_at;
 end if;
 return new;
end$$;
create trigger pdd_registration_recipient_stats before insert or update on public.pdd_registrations
 for each row execute function public.pdd_recipient_stat_markers();
create trigger pdd_recipient_lead_stats before update on public.pdd_recipient_leads
 for each row execute function public.pdd_recipient_stat_markers();

create or replace function public.pdd_home_stats(p_payload jsonb default '{}') returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'lostRegistered',(select count(distinct waybill_id) from public.pdd_registrations where mode='lost'),
  'receivedRegistered',(select count(distinct waybill_id) from public.pdd_registrations where mode='received'),
  'matchedParcels',(select count(*) from public.pdd_waybills where matched_at is not null),
  'lostRecipientRegistered',(select count(*) from public.pdd_registrations where mode='lost' and recipient_registered_at is not null)+(select count(*) from public.pdd_recipient_leads where mode='lost'),
  'receivedRecipientRegistered',(select count(*) from public.pdd_registrations where mode='received' and recipient_registered_at is not null)+(select count(*) from public.pdd_recipient_leads where mode='received'),
  'matchedRecipientLeads',(select count(*) from public.pdd_registrations where recipient_matched_at is not null)+(select count(*) from public.pdd_recipient_leads where recipient_matched_at is not null))
$$;

-- Internal references identify exactly the first 20 disclosed rows, including
-- both sources. The 21st row is only a pagination probe and is never marked.
create or replace function public.pdd_recipient_lookup(key text,m text,until_at timestamptz,after_anchor jsonb default null) returns jsonb language plpgsql stable set search_path='' as $$
declare rows jsonb; leads jsonb; refs jsonb; anchor jsonb; begin
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
 select coalesce(jsonb_agg(jsonb_build_object('recipientName',r->>'recipient_name','registeredAt',r->'created_at','contact',public.pdd_contact_projection(r->'contact'),'note',r->'note') order by ord),'[]'),
  coalesce(jsonb_agg(jsonb_build_object('source',r->>'source','id',r->>'id') order by ord),'[]') into leads,refs
 from jsonb_array_elements(rows) with ordinality x(r,ord) where ord<=20;
 if jsonb_array_length(rows)>20 then
  anchor:=jsonb_build_object('at',rows->19->'created_at','id',rows->19->'id','source',rows->19->'source');
 end if;
 return jsonb_build_object('leads',leads,'anchor',anchor,'returnedRefs',refs);
end$$;

create or replace function public.pdd_recipient_query_response(q public.pdd_recipient_query_events,after_anchor jsonb default null) returns jsonb language plpgsql volatile set search_path='' as $$
declare answer jsonb; cursor jsonb; token uuid; begin
 -- The same registry lock serializes response selection with rename, withdrawal
 -- and cleanup, including initial queries, opaque pages and idempotent replays.
 perform pg_advisory_xact_lock(hashtextextended('pdd-recipient-registry',0));
 answer:=public.pdd_recipient_lookup(q.recipient_name_key,q.mode,q.queried_at,after_anchor);
 update public.pdd_registrations r set recipient_matched_at=now()
 where r.recipient_matched_at is null and exists(
  select 1 from jsonb_array_elements(answer->'returnedRefs') ref where ref->>'source'='waybill' and (ref->>'id')::uuid=r.id);
 update public.pdd_recipient_leads r set recipient_matched_at=now()
 where r.recipient_matched_at is null and exists(
  select 1 from jsonb_array_elements(answer->'returnedRefs') ref where ref->>'source'='recipient' and (ref->>'id')::uuid=r.id);
 if answer->'anchor'<>'null'::jsonb then
  select value into cursor from jsonb_array_elements(q.cursors) where value->'anchor'=answer->'anchor' limit 1;
  if cursor is null then
   token:=gen_random_uuid(); cursor:=jsonb_build_object('token',token,'anchor',answer->'anchor');
   update public.pdd_recipient_query_events set cursors=cursors||jsonb_build_array(cursor) where id=q.id;
  else token:=(cursor->>'token')::uuid; end if;
 end if;
 -- returnedRefs are private transient input, never added to the response/receipt.
 return jsonb_build_object('queryId',q.id,'result',case when jsonb_array_length(answer->'leads')>0 then 'leads_found' else 'not_found' end,
  'queriedAt',q.queried_at,'leads',answer->'leads','nextCursor',token);
end$$;

revoke all on function public.pdd_recipient_stat_markers() from public,anon,authenticated;
grant execute on function public.pdd_recipient_stat_markers() to service_role;
-- CREATE OR REPLACE preserves the existing RPC identities, owners and ACLs.
