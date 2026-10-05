-- Preserve selection and image-version consistency across candidate result pages.
create or replace function public.match_scan(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.scans; own public.records; target public.records; ts public.scans;
 results jsonb:='[]'; choice text; comparison jsonb; source_extraction jsonb; target_extraction jsonb;
 mid uuid; count_eligible integer; offset_value integer:=greatest(0,least(100000,coalesce((p_payload->>'offset')::integer,0))); total integer;
begin
 perform pg_advisory_xact_lock(hashtext('cmi-job-slots'));
 select * into s from public.scans where id=(p_payload->>'scan_id')::uuid for update;
 if not found or s.input_version<>(p_payload->>'version')::integer then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
 -- Pagination reads must use the same selected evidence as the first page.
 -- Validate under the row lock so an intervening selection change cannot slip through API prechecks.
 if coalesce((p_payload->>'enforce_selection')::boolean,false) then
  if not (p_payload ? 'expected_selected_identifier_id') or p_payload ? 'selected_evidence_id' then raise exception 'INVALID_PAGINATION_SELECTION' using errcode='22023'; end if;
  if (p_payload->>'expected_selected_identifier_id') is distinct from s.selected_identifier_id then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
 end if;
 if s.state<>'succeeded' or s.quality='unusable' then return jsonb_build_object('ok',true,'results','[]'::jsonb,'requiresSelection',false); end if;
 choice:=coalesce(p_payload->>'selected_evidence_id',s.selected_identifier_id);
 select count(distinct(type,value)) into count_eligible from public.evidence where scan_id=s.id and version=s.input_version and type in ('domestic_waybill','consolidation_waybill','last_mile_waybill');
 if choice is not null and not exists(select 1 from public.evidence where scan_id=s.id and version=s.input_version and identifier_id=choice) then raise exception 'INVALID_SELECTION' using errcode='22023'; end if;
 if s.intent='search' and count_eligible>1 and choice is null then return jsonb_build_object('ok',true,'results','[]'::jsonb,'requiresSelection',true); end if;
 select * into own from public.records where scan_id=s.id and visibility='active' for update;
 if choice is distinct from s.selected_identifier_id and choice is not null then
  if own.id is not null and own.resolution in ('claimed','resolved') then raise exception 'SELECTION_LOCKED' using errcode='40001'; end if;
  if own.id is not null then
   update public.matches set state='invalidated',updated_at=now() where (received_id=own.id or tracking_id=own.id) and state<>'closed';
   update public.followups set state='closed',updated_at=now() where match_id in (select id from public.matches where received_id=own.id or tracking_id=own.id);
   update public.records set revision=revision+1,updated_at=now() where id=own.id;
  end if;
  update public.scans set selected_identifier_id=choice,updated_at=now() where id=s.id;
 end if;
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
