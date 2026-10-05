-- Selection changes supersede earlier contact tasks even when images are unchanged.
create function public.cmi_match_current(m public.matches) returns boolean language plpgsql stable security definer set search_path='' as $$
declare rr public.records; tr public.records; rs public.scans; ts public.scans; a jsonb; b jsonb; comparison jsonb;
begin
 select * into rr from public.records where id=m.received_id;
 select * into tr from public.records where id=m.tracking_id;
 if rr.id is null or tr.id is null or rr.kind<>'received' or tr.kind<>'tracking' or rr.visibility<>'active' or tr.visibility<>'active'
 or rr.image_version<>m.received_version or tr.image_version<>m.tracking_version then return false; end if;
 select * into rs from public.scans where id=rr.scan_id;
 select * into ts from public.scans where id=tr.scan_id;
 if rs.state<>'succeeded' or ts.state<>'succeeded' or rs.input_version<>m.received_version or ts.input_version<>m.tracking_version then return false; end if;
 a:=rs.extraction; b:=ts.extraction;
 if rs.selected_identifier_id is not null then a:=jsonb_set(a,'{identifiers}',coalesce((select jsonb_agg(i) from jsonb_array_elements(a->'identifiers') i where i->>'id'=rs.selected_identifier_id),'[]')); end if;
 if ts.selected_identifier_id is not null then b:=jsonb_set(b,'{identifiers}',coalesce((select jsonb_agg(i) from jsonb_array_elements(b->'identifiers') i where i->>'id'=ts.selected_identifier_id),'[]')); end if;
 comparison:=public.cmi_compare_extractions(a,b);
 return comparison is not null and comparison->>'kind'=m.kind and comparison->'reasons'=m.reasons;
end$$;
revoke all on function public.cmi_match_current(public.matches) from public,anon,authenticated;
grant execute on function public.cmi_match_current(public.matches) to service_role;

create or replace function public.match_scan(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
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

create or replace function public.admin_update(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
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
  if not public.cmi_match_current(m) then raise exception 'MATCH_STALE' using errcode='40001'; end if;
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
  if m.id is null or not public.cmi_match_current(m) then raise exception 'MATCH_STALE' using errcode='40001'; end if;
  if m.id is null or m.state not in ('verified','closed') or not exists(select 1 from public.records where id=m.received_id and claimed_match_id=m.id and resolution in ('claimed','resolved')) then raise exception 'OWNERSHIP_NOT_VERIFIED' using errcode='40001'; end if;
  insert into public.handovers(match_id,received_id,actor_id) values(m.id,m.received_id,actor) on conflict(match_id) do nothing;
  update public.matches set state='closed',updated_at=now() where id=m.id;
  update public.records set resolution='resolved',closed_at=coalesce(closed_at,now()),updated_at=now() where id in (m.received_id,m.tracking_id);
  update public.followups set state='closed',updated_at=now() where match_id=m.id;
 elsif action in ('contact_received','contact_tracking','update_followup','followup') then
  if m.id is not null and not public.cmi_match_current(m) then raise exception 'MATCH_STALE' using errcode='40001'; end if;
  if action in ('contact_received','contact_tracking') and f.state='closed' then raise exception 'FOLLOWUP_CLOSED' using errcode='40001'; end if;
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
