-- Expand the existing contact contract without changing stored rows, lengths,
-- RPC identity, grants, or the allowlisted contact projection.
create or replace function public.pdd_contact_valid(c jsonb) returns boolean language sql immutable set search_path='' as $$
 select jsonb_typeof(c)='object' and c-'kind'-'value'='{}'::jsonb and jsonb_typeof(c->'value')='string'
 and case c->>'kind'
 when 'wechat' then btrim(c->>'value') ~ '^[a-zA-Z_][-_a-zA-Z0-9]{5,63}$'
 when 'phone' then length(btrim(c->>'value'))<=32 and btrim(c->>'value') ~ '^\+?[0-9][0-9 ()-]{5,30}[0-9]$' and length(regexp_replace(c->>'value','[^0-9]','','g'))>=7
 else false end
$$;
