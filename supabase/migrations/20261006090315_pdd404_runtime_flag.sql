-- Expose the server-only OCR switch in the existing runtime fallback. No client permission changes.
create or replace function public.runtime_config(p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare config jsonb; openai text; worker text;
begin
 select value into config from public.site_settings where key='runtime';
 if to_regclass('vault.decrypted_secrets') is not null then
  select decrypted_secret into openai from vault.decrypted_secrets where name='cmi_openai_api_key' limit 1;
  select decrypted_secret into worker from vault.decrypted_secrets where name='cmi_worker_secret' limit 1;
 end if;
 return jsonb_build_object('OPENAI_API_KEY',openai,'WORKER_SECRET',worker,'ADMIN_USER_IDS',config->>'ADMIN_USER_IDS',
  'APP_PUBLIC_URL',config->>'APP_PUBLIC_URL','ALLOWED_ORIGINS',config->>'ALLOWED_ORIGINS','APP_SHA',config->>'APP_SHA','APP_ENVIRONMENT',config->>'APP_ENVIRONMENT','OCR_ENABLED',coalesce(config->>'OCR_ENABLED','false'));
end$$;
revoke all on function public.runtime_config(jsonb) from public, anon, authenticated;
grant execute on function public.runtime_config(jsonb) to service_role;
