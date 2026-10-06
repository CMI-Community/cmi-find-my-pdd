-- Business conflicts are persistent until the caller changes its request/state.
-- They must not use SQLSTATE 40001: PostgREST 14 retries that transaction forever.
-- Ordinary P0001 preserves the business message; the Edge allowlist still maps it to 409.
-- https://supabase.com/docs/guides/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b
-- Never intercept a genuine database serialization_failure or change already-applied history.

do $migration$
declare
 target_names constant text[]:=array['pdd_query','pdd_query_contact','pdd_batch_register','pdd_manage_update','pdd_admin_action','pdd_feedback_submit'];
 expected_counts constant integer[]:=array[1,3,2,2,3,1];
 rewrite_pattern constant text:=$pattern$(raise[[:space:]]+exception[[:space:]]+'(?:IDEMPOTENCY_CONFLICT|VERSION_CONFLICT|OWNERSHIP_LOCKED|NEEDS_RECEIVED|INVALID_ADMIN_STATE)'[[:space:]]+using[[:space:]]+errcode[[:space:]]*=[[:space:]]*)'40001'$pattern$;
 explicit_serialization constant text:=$pattern$raise[[:space:]]+(exception[^;]*errcode[[:space:]]*=[[:space:]]*'40001'|sqlstate[[:space:]]+'40001')$pattern$;
 index integer; target oid; original_definition text; rewritten_definition text; replacements integer; remaining text[];
begin
 for index in 1..array_length(target_names,1) loop
  -- Resolve only the six reviewed public JSONB RPC signatures, never arbitrary functions.
  target:=to_regprocedure(format('public.%I(jsonb)',target_names[index]))::oid;
  if target is null or not exists(select 1 from pg_proc where oid=target and prokind='f' and prosecdef and prorettype='jsonb'::regtype) then
   raise exception 'PDD_CONFLICT_MIGRATION_UNEXPECTED_SIGNATURE: %',target_names[index];
  end if;
  original_definition:=pg_get_functiondef(target);
  select count(*) into replacements from regexp_matches(original_definition,rewrite_pattern,'gi');
  -- Source drift aborts this transaction rather than leaving a retryable business guard.
  if replacements<>expected_counts[index] then
   raise exception 'PDD_CONFLICT_MIGRATION_UNEXPECTED_SOURCE: % expected % guards, found %',target_names[index],expected_counts[index],replacements;
  end if;
  rewritten_definition:=regexp_replace(original_definition,rewrite_pattern,$replacement$\1'P0001'$replacement$,'gi');
  if rewritten_definition~*explicit_serialization then
   raise exception 'PDD_CONFLICT_MIGRATION_UNREVIEWED_GUARD: %',target_names[index];
  end if;
  -- CREATE OR REPLACE keeps the function identity, owner and existing execute grants.
  execute rewritten_definition;
 end loop;
 select array_agg(p.proname order by p.proname) into remaining
 from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
 where ns.nspname='public' and p.prokind='f' and left(p.proname,4)='pdd_'
  and pg_get_functiondef(p.oid)~*explicit_serialization;
 if remaining is not null then raise exception 'PDD_CONFLICT_MIGRATION_REMAINING_GUARDS: %',remaining; end if;
end
$migration$;
