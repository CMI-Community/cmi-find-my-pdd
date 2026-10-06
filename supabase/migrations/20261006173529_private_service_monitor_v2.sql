-- Read-only pressure snapshot; never returns rows, SQL, users or client addresses.
-- Capacity quotas/CPU/memory come from the provider, not invented database limits.
create function public.pdd_monitor_status(p_payload jsonb default '{}') returns jsonb
language sql stable security definer set search_path='' set statement_timeout='3s' as $$
 with activity as (
  select count(*) connections,
   count(*) filter(where state='active') active_connections,
   count(*) filter(where wait_event_type='Lock') waiting_connections,
   count(*) filter(where state like 'idle in transaction%') idle_in_transaction_connections,
   coalesce(max(greatest(0,extract(epoch from (now()-xact_start)))),0) longest_transaction_seconds
  from pg_catalog.pg_stat_activity where backend_type='client backend'
 ), config as (
  select pg_catalog.current_setting('max_connections')::integer maximum,
   pg_catalog.current_setting('superuser_reserved_connections')::integer
    +coalesce(nullif(pg_catalog.current_setting('reserved_connections',true),''),'0')::integer reserved
 )
 select pg_catalog.jsonb_build_object(
  'databaseBytes',pg_catalog.pg_database_size(pg_catalog.current_database()),
  'connections',a.connections,'maxConnections',c.maximum,'reservedConnections',c.reserved,
  'activeConnections',a.active_connections,'waitingConnections',a.waiting_connections,
  'idleInTransactionConnections',a.idle_in_transaction_connections,
  'longestTransactionSeconds',round(a.longest_transaction_seconds,3),
  'databaseSizeLimitBytes',null,
  'transactionsCommitted',coalesce(d.xact_commit,0),'transactionsRolledBack',coalesce(d.xact_rollback,0),
  'deadlocks',coalesce(d.deadlocks,0),'tempBytes',coalesce(d.temp_bytes,0),'statsResetAt',d.stats_reset
 ) from activity a cross join config c
 left join pg_catalog.pg_stat_database d on d.datname=pg_catalog.current_database()
$$;
revoke all on function public.pdd_monitor_status(jsonb) from public,anon,authenticated;
grant execute on function public.pdd_monitor_status(jsonb) to service_role;
