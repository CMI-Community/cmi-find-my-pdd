-- Vault exposes optional fourth/fifth key-id parameters. Check their complete
-- catalog signatures and defaults before using the shorter call syntax.
-- Preserve the function identity, owner, ACL, configuration and every stored row.
do $$
declare definition text; anchor text; replacement text;
begin
 definition:=pg_get_functiondef('public.pdd_insights_configure_worker(jsonb)'::regprocedure);
 anchor:=$a$to_regprocedure('vault.create_secret(text,text,text)') is null or to_regprocedure('vault.update_secret(uuid,text,text,text)') is null$a$;
 replacement:=$a$not exists(select 1 from pg_catalog.pg_proc where oid=to_regprocedure('vault.create_secret(text,text,text,uuid)') and pronargdefaults>=1) or not exists(select 1 from pg_catalog.pg_proc where oid=to_regprocedure('vault.update_secret(uuid,text,text,text,uuid)') and pronargdefaults>=1)$a$;
 if strpos(definition,anchor)=0 or strpos(substr(definition,strpos(definition,anchor)+length(anchor)),anchor)>0 then
  raise exception 'INSIGHTS_VAULT_GUARD_SOURCE_CHANGED';
 end if;
 execute replace(definition,anchor,replacement);
end$$;
