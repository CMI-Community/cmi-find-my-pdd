-- Transactional smoke test. Safe to run on an empty TEST project: all fixtures roll back.
-- The Supabase infrastructure (Storage, Cron, pg_net) is intentionally not exercised here.
begin;
create function pg_temp.check_true(condition boolean, message text) returns void language plpgsql as $$
begin if condition is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if; end$$;

create function pg_temp.new_scan(intent text) returns uuid language plpgsql as $$
declare sid uuid:=gen_random_uuid(); iid uuid:=gen_random_uuid(); role text:=case when intent='received' then 'label' else 'logistics' end; payload jsonb;
begin
 perform public.create_scan(jsonb_build_object('id',sid,'intent',intent,'capability_hash',repeat('a',64),'environment','test'));
 perform public.reserve_images(jsonb_build_object('scan_id',sid,'version',1,'images',jsonb_build_array(jsonb_build_object('id',iid,'role',role,'path',sid||'/1/'||role||'.image','mime','image/jpeg','size',0))));
 payload:=jsonb_build_object('scan_id',sid,'version',1,'idempotency_key',sid::text,'body_hash','hash',
  'contact',jsonb_build_object('wechat','test_'||intent,'groupDeclaration',true),
  'images',jsonb_build_array(jsonb_build_object('id',iid,'mime','image/jpeg','size',1200,'width',800,'height',600)));
 perform public.finalize_scan(payload);
 perform public.finalize_scan(payload);
 perform pg_temp.check_true((select count(*)=1 from public.jobs where scan_id=sid),'finalize idempotency');
 return sid;
end$$;

create function pg_temp.finish_scan(sid uuid, number text, number_type text default 'domestic_waybill', quality text default 'complete') returns jsonb language plpgsql as $$
declare claimed jsonb; job jsonb; budget jsonb; photo uuid; extraction jsonb; answer jsonb;
begin
 claimed:=public.claim_jobs('{"limit":2}');
 select value into job from jsonb_array_elements(claimed) where value->>'scan_id'=sid::text;
 if job is null then raise exception 'TEST JOB NOT CLAIMED'; end if;
 budget:=public.reserve_budget(jsonb_build_object('job_id',job->>'id','lease_token',job->>'lease_token'));
 perform pg_temp.check_true((budget->>'allowed')::boolean,'test budget available');
 select id into photo from public.images where scan_id=sid and version=1;
 extraction:=jsonb_build_object('identifiers',case when number is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('id','number-1','type',number_type,'value',number,'carrier','fixture-carrier','complete',true,'clear',true,'shared',false,'sourceImageId',photo)) end,
  'recipientName','示例姓名','itemNames','["不锈钢蒸锅"]'::jsonb,'specifications','[]'::jsonb,'tags','["蒸锅","不锈钢"]'::jsonb,'validImage',quality<>'unusable');
 answer:=public.complete_job(jsonb_build_object('job_id',job->>'id','lease_token',job->>'lease_token','reservation_id',budget->>'reservationId',
  'quality',quality,'extraction',extraction,'public_title','不锈钢蒸锅','input_tokens',100,'output_tokens',100));
 perform pg_temp.check_true((answer->>'ok')::boolean,'complete current lease');
 return extraction;
end$$;

do $$
declare received uuid; searching uuid; unusable uuid; other uuid; first_code text; contact jsonb:='{"wechat":"test_seeker_private","other":"private contact","groupDeclaration":true}';
 progress jsonb; extraction jsonb; r public.records; m public.matches; f public.followups; actor uuid:=gen_random_uuid(); public_data jsonb;
begin
 received:=pg_temp.new_scan('received');
 extraction:=pg_temp.finish_scan(received,'SF123456789012');
 select * into r from public.records where scan_id=received;
 first_code:=r.public_code;
 public_data:=public.public_record(jsonb_build_object('public_code',first_code));
 perform pg_temp.check_true(not (public_data ? 'contact') and not (public_data ? 'extraction') and not (public_data ? 'capability_hash'),'public field whitelist');
 perform pg_temp.check_true(position('SF123456789012' in public_data::text)=0 and position('test_received' in public_data::text)=0,'public masks full number and contact');
 searching:=pg_temp.new_scan('search');
 perform pg_temp.finish_scan(searching,'SF123456789012');
 progress:=public.get_scan_status(jsonb_build_object('scan_id',searching));
 perform pg_temp.check_true(progress->>'state'='succeeded' and jsonb_array_length(progress->'results')=1,'query finds an existing package');
 perform pg_temp.check_true(not exists(select 1 from public.records where scan_id=searching),'query does not create tracking record');
 perform public.activate_tracking(jsonb_build_object('scan_id',searching,'version',1,'contact',contact,'idempotency_key','tracking-one','body_hash','tracking-hash'));
 perform public.activate_tracking(jsonb_build_object('scan_id',searching,'version',1,'contact',contact,'idempotency_key','tracking-one','body_hash','tracking-hash'));
 perform public.get_scan_status(jsonb_build_object('scan_id',searching));
 perform public.get_scan_status(jsonb_build_object('scan_id',received));
 perform pg_temp.check_true((select count(*)=1 from public.matches),'one match per pair');
 perform pg_temp.check_true((select count(*)=1 from public.followups),'one follow-up per match');
 select * into m from public.matches limit 1;
 select * into f from public.followups where match_id=m.id;
 begin
  perform public.admin_update(jsonb_build_object('action','confirm_handover','followup_id',f.id,'actor_id',actor));
  raise exception 'handover without ownership should fail';
 exception when serialization_failure then null; end;
 perform public.admin_update(jsonb_build_object('action','verify','followup_id',f.id,'actor_id',actor));
 perform pg_temp.check_true((select resolution='verifying' from public.records where id=m.received_id),'candidate verification is not ownership');
 perform public.admin_update(jsonb_build_object('action','mark_claimed','followup_id',f.id,'actor_id',actor));
 perform public.admin_update(jsonb_build_object('action','confirm_handover','followup_id',f.id,'actor_id',actor));
 perform public.admin_update(jsonb_build_object('action','confirm_handover','followup_id',f.id,'actor_id',actor));
 perform pg_temp.check_true((select count(*)=1 from public.handovers),'actual handover counted once');
 perform pg_temp.check_true(public.public_stats('{}')->>'successfulHandoverCount' is null,'success count hidden through five');
 other:=pg_temp.new_scan('search');
 perform pg_temp.finish_scan(other,'OTHER9876543210');
 progress:=public.get_scan_status(jsonb_build_object('scan_id',other));
 perform pg_temp.check_true(progress->>'state'='succeeded' and jsonb_array_length(progress->'results')=0,'no match is successful recognition');
 unusable:=pg_temp.new_scan('search');
 perform pg_temp.finish_scan(unusable,null,'unknown_id','unusable');
 progress:=public.get_scan_status(jsonb_build_object('scan_id',unusable));
 perform pg_temp.check_true(progress->>'state'='needs_photo','unusable recognition is not no-match');
 begin
  perform public.activate_tracking(jsonb_build_object('scan_id',unusable,'version',1,'contact',contact,'idempotency_key','bad','body_hash','bad'));
  raise exception 'unusable tracking should fail';
 exception when serialization_failure then null; end;
end$$;

do $$
declare a uuid; b uuid; c uuid; claims jsonb; old_job jsonb; new_job jsonb; result jsonb; budget jsonb; stable_code text; before_spent numeric; vday date:=timezone('Asia/Bangkok',now())::date;
begin
 a:=pg_temp.new_scan('received'); b:=pg_temp.new_scan('received'); c:=pg_temp.new_scan('received');
 claims:=public.claim_jobs('{"limit":2}');
 perform pg_temp.check_true(jsonb_array_length(claims)=2,'global max two workers');
 perform pg_temp.check_true(jsonb_array_length(public.claim_jobs('{"limit":2}'))=0,'third worker cannot lease');
 old_job:=claims->0;
 update public.jobs set lease_expires_at=now()-interval '1 second' where id=(old_job->>'id')::uuid;
 new_job:=public.claim_jobs('{"limit":1}')->0;
 perform pg_temp.check_true(new_job->>'lease_token'<>old_job->>'lease_token','expired lease gets a new fencing token');
 result:=public.complete_job(jsonb_build_object('job_id',old_job->>'id','lease_token',old_job->>'lease_token','quality','unusable','extraction','{}'::jsonb));
 perform pg_temp.check_true((result->>'fenced')::boolean,'expired worker cannot write');
 budget:=public.reserve_budget(jsonb_build_object('job_id',new_job->>'id','lease_token',new_job->>'lease_token'));
 perform pg_temp.check_true((budget->>'allowed')::boolean,'reservation is atomic');
 perform pg_temp.check_true(public.reserve_budget(jsonb_build_object('job_id',new_job->>'id','lease_token',new_job->>'lease_token'))->>'reservationId'=budget->>'reservationId','reservation replay does not double reserve');
 select spent into before_spent from public.daily_budgets where day=vday and environment='test';
 select public_code into stable_code from public.records where scan_id=(new_job->>'scan_id')::uuid;
 perform public.revise_scan(jsonb_build_object('scan_id',new_job->>'scan_id','version',1));
 result:=public.complete_job(jsonb_build_object('job_id',new_job->>'id','lease_token',new_job->>'lease_token','reservation_id',budget->>'reservationId','input_tokens',100,'output_tokens',100,'quality','unusable','extraction','{}'::jsonb));
 perform pg_temp.check_true((result->>'fenced')::boolean,'revision cancels old worker');
 perform pg_temp.check_true((select spent=before_spent+.0002 from public.daily_budgets where day=vday and environment='test'),'fenced call still settles actual fees');
 perform pg_temp.check_true((select state='draft' and input_version=2 from public.scans where id=(new_job->>'scan_id')::uuid),'new scan survives stale result');
 perform pg_temp.check_true((select public_code from public.records where scan_id=(new_job->>'scan_id')::uuid)=stable_code,'public code stable');
 perform public.cancel_scan(jsonb_build_object('scan_id',a,'version',(select input_version from public.scans where id=a)));
 perform public.cancel_scan(jsonb_build_object('scan_id',b,'version',(select input_version from public.scans where id=b)));
 perform public.cancel_scan(jsonb_build_object('scan_id',c,'version',(select input_version from public.scans where id=c)));
end$$;

do $$
declare sid uuid; job jsonb; reservation jsonb; result jsonb; i integer; d date:=timezone('Asia/Bangkok',now())::date; prior numeric;
begin
 sid:=pg_temp.new_scan('search');
 job:=public.claim_jobs('{"limit":1}')->0;
 select spent into prior from public.daily_budgets where day=d and environment='test';
 update public.daily_budgets set spent=.09,reserved=0 where day=d and environment='test';
 reservation:=public.reserve_budget(jsonb_build_object('job_id',job->>'id','lease_token',job->>'lease_token'));
 perform pg_temp.check_true(not (reservation->>'allowed')::boolean,'test daily cap blocks two-cent reservation');
 perform pg_temp.check_true((select attempts=0 from public.jobs where id=(job->>'id')::uuid),'budget deferral does not consume an attempt');
 update public.daily_budgets set spent=prior where day=d and environment='test';
 perform public.retry_scan(jsonb_build_object('scan_id',sid,'version',1));
 for i in 1..3 loop
  job:=public.claim_jobs('{"limit":1}')->0;
  reservation:=public.reserve_budget(jsonb_build_object('job_id',job->>'id','lease_token',job->>'lease_token'));
  result:=public.fail_job(jsonb_build_object('job_id',job->>'id','lease_token',job->>'lease_token','reservation_id',reservation->>'reservationId','usage_unknown',true,'error_code','OPENAI_TIMEOUT','retryable',true));
  update public.jobs set next_run_at=now()-interval '1 second' where scan_id=sid;
 end loop;
 perform pg_temp.check_true((select status='failed' and attempts=3 from public.jobs where scan_id=sid),'three attempts stop automatic retries');
 perform pg_temp.check_true((select spent+reserved>=prior+.06 and spent=prior from public.daily_budgets where day=d and environment='test'),'unknown timeout remains reserved without reporting estimated spend');
 perform pg_temp.check_true((select count(*)=3 from public.budget_reservations where job_id=(job->>'id')::uuid and state='unknown' and actual is null),'each unknown retry preserves its separate encumbrance');
end$$;

do $$
declare sid uuid; rid uuid; job jsonb; contact jsonb:='{"wechat":"partial_user","groupDeclaration":true}'; code text; f public.followups; actor uuid:=gen_random_uuid(); cleanup jsonb;
begin
 -- Reset the test-only budget ledger to isolate this retention scenario.
 update public.daily_budgets set spent=0,reserved=0 where environment='test';
 sid:=pg_temp.new_scan('search');
 perform pg_temp.finish_scan(sid,'****5678','domestic_waybill','partial');
 perform public.activate_tracking(jsonb_build_object('scan_id',sid,'version',1,'contact',contact,'idempotency_key','partial-track','body_hash','partial-hash'));
 perform pg_temp.check_true(exists(select 1 from public.records where scan_id=sid),'partial evidence can register tracking');
 sid:=pg_temp.new_scan('received');
 perform pg_temp.finish_scan(sid,'MANUAL11112222');
 select id,public_code into rid,code from public.records where scan_id=sid;
 perform public.admin_update(jsonb_build_object('action','create_followup','actor_id',actor,'payload',jsonb_build_object('receivedCode',code,'notes','群内人工核实')));
 select * into f from public.followups where received_record_id=rid and match_id is null;
 perform public.admin_update(jsonb_build_object('action','verify','followup_id',f.id,'actor_id',actor));
 perform public.admin_update(jsonb_build_object('action','mark_claimed','followup_id',f.id,'actor_id',actor));
 perform public.admin_update(jsonb_build_object('action','confirm_handover','followup_id',f.id,'actor_id',actor));
 perform public.admin_update(jsonb_build_object('action','confirm_handover','followup_id',f.id,'actor_id',actor));
 perform pg_temp.check_true((select count(*)=1 from public.handovers where received_id=rid),'manual handover unique without fabricated tracking');
 update public.records set closed_at=now()-interval '31 days' where id=rid;
 cleanup:=public.cleanup_records('{}');
 perform pg_temp.check_true((select rc.contact='{}' from public.records rc where id=rid),'closed contacts removed after thirty days');
 perform pg_temp.check_true((select extraction is null and capability_hash='' from public.scans where id=sid),'closed raw OCR and capabilities removed');
 perform pg_temp.check_true(exists(select 1 from jsonb_array_elements(cleanup->'images') x where x->>'id'=(select id::text from public.images where scan_id=sid)),'cleanup returns private originals for Storage API removal');
 sid:=pg_temp.new_scan('search');
 update public.scans set expires_at=now()-interval '1 second' where id=sid;
 perform public.cleanup_records('{}');
 perform pg_temp.check_true((select capability_hash='' and state='cancelled' from public.scans where id=sid),'query expires after twenty-four hours');
end$$;

do $$declare tab text; fn record; begin
 foreach tab in array array['scans','images','records','evidence','jobs','matches','followups','handovers','daily_budgets','budget_reservations','idempotency_keys','rate_limits','site_settings','audit_events'] loop
  perform pg_temp.check_true(not has_table_privilege('anon','public.'||tab,'SELECT') and not has_table_privilege('authenticated','public.'||tab,'SELECT'),'direct business reads denied: '||tab);
  perform pg_temp.check_true((select relrowsecurity from pg_class where oid=('public.'||tab)::regclass),'RLS enabled: '||tab);
 end loop;
 for fn in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' loop
  perform pg_temp.check_true(not has_function_privilege('anon',fn.signature,'EXECUTE') and not has_function_privilege('authenticated',fn.signature,'EXECUTE'),'RPC execution denied: '||fn.signature);
 end loop;
end$$;
rollback;
