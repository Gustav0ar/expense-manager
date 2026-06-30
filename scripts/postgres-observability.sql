\pset pager off
\pset null '(null)'
\timing on

\echo ''
\echo '== database health =='
select
	current_database() as database,
	pg_postmaster_start_time() as started_at,
	now() - pg_postmaster_start_time() as uptime,
	stats_reset,
	numbackends,
	xact_commit,
	xact_rollback,
	deadlocks,
	temp_files,
	pg_size_pretty(temp_bytes) as temp_bytes,
	round((100.0 * blks_hit / nullif(blks_hit + blks_read, 0))::numeric, 2) as cache_hit_pct
from pg_stat_database
where datname = current_database();

\echo ''
\echo '== connection states =='
select
	coalesce(state, 'background') as state,
	count(*) as connections,
	max(now() - state_change) as longest_state_age
from pg_stat_activity
where datname = current_database()
group by coalesce(state, 'background')
order by connections desc;

\echo ''
\echo '== long transactions over 60s =='
select
	pid,
	usename,
	state,
	now() - xact_start as age,
	left(query, 240) as query
from pg_stat_activity
where datname = current_database()
	and xact_start is not null
	and now() - xact_start > interval '60 seconds'
order by age desc;

\echo ''
\echo '== lock waits and blockers =='
select
	blocked_activity.pid as blocked_pid,
	blocked_activity.usename as blocked_user,
	now() - blocked_activity.query_start as blocked_age,
	left(blocked_activity.query, 180) as blocked_query,
	blocking_activity.pid as blocking_pid,
	blocking_activity.usename as blocking_user,
	now() - blocking_activity.query_start as blocking_age,
	left(blocking_activity.query, 180) as blocking_query
from pg_locks blocked_lock
join pg_stat_activity blocked_activity on blocked_activity.pid = blocked_lock.pid
join pg_locks blocking_lock
	on blocking_lock.locktype = blocked_lock.locktype
	and blocking_lock.database is not distinct from blocked_lock.database
	and blocking_lock.relation is not distinct from blocked_lock.relation
	and blocking_lock.page is not distinct from blocked_lock.page
	and blocking_lock.tuple is not distinct from blocked_lock.tuple
	and blocking_lock.virtualxid is not distinct from blocked_lock.virtualxid
	and blocking_lock.transactionid is not distinct from blocked_lock.transactionid
	and blocking_lock.classid is not distinct from blocked_lock.classid
	and blocking_lock.objid is not distinct from blocked_lock.objid
	and blocking_lock.objsubid is not distinct from blocked_lock.objsubid
	and blocking_lock.pid <> blocked_lock.pid
join pg_stat_activity blocking_activity on blocking_activity.pid = blocking_lock.pid
where not blocked_lock.granted
	and blocking_lock.granted
order by blocked_age desc;

\echo ''
\echo '== slow queries by total execution time =='
select
	calls,
	round(total_exec_time::numeric, 2) as total_exec_ms,
	round(mean_exec_time::numeric, 2) as mean_exec_ms,
	rows,
	left(regexp_replace(query, '\s+', ' ', 'g'), 260) as query
from pg_stat_statements
where dbid = (select oid from pg_database where datname = current_database())
order by total_exec_time desc
limit 20;

\echo ''
\echo '== slow queries by mean execution time, minimum 5 calls =='
select
	calls,
	round(total_exec_time::numeric, 2) as total_exec_ms,
	round(mean_exec_time::numeric, 2) as mean_exec_ms,
	rows,
	left(regexp_replace(query, '\s+', ' ', 'g'), 260) as query
from pg_stat_statements
where dbid = (select oid from pg_database where datname = current_database())
	and calls >= 5
order by mean_exec_time desc
limit 20;

\echo ''
\echo '== largest tables and indexes =='
select
	relid::regclass as table_name,
	pg_size_pretty(pg_total_relation_size(relid)) as total_size,
	pg_size_pretty(pg_relation_size(relid)) as table_size,
	pg_size_pretty(pg_indexes_size(relid)) as indexes_size,
	n_live_tup,
	n_dead_tup
from pg_stat_user_tables
order by pg_total_relation_size(relid) desc
limit 20;

\echo ''
\echo '== table scan mix =='
select
	relid::regclass as table_name,
	seq_scan,
	idx_scan,
	seq_tup_read,
	idx_tup_fetch,
	round((100.0 * idx_scan / nullif(seq_scan + idx_scan, 0))::numeric, 2) as index_scan_pct
from pg_stat_user_tables
order by seq_scan desc, seq_tup_read desc
limit 30;

\echo ''
\echo '== dead tuples and vacuum freshness =='
select
	relid::regclass as table_name,
	n_live_tup,
	n_dead_tup,
	round((100.0 * n_dead_tup / greatest(n_live_tup + n_dead_tup, 1))::numeric, 2) as dead_tuple_pct,
	last_vacuum,
	last_autovacuum,
	last_analyze,
	last_autoanalyze
from pg_stat_user_tables
order by n_dead_tup desc
limit 30;

\echo ''
\echo '== hot update ratio =='
select
	relid::regclass as table_name,
	n_tup_upd,
	n_tup_hot_upd,
	round((100.0 * n_tup_hot_upd / nullif(n_tup_upd, 0))::numeric, 2) as hot_update_pct
from pg_stat_user_tables
where n_tup_upd > 0
order by hot_update_pct nulls first, n_tup_upd desc;

\echo ''
\echo '== candidate unused non-unique indexes, verify after real traffic before dropping =='
select
	s.relid::regclass as table_name,
	s.indexrelid::regclass as index_name,
	s.idx_scan,
	pg_size_pretty(pg_relation_size(s.indexrelid)) as index_size
from pg_stat_user_indexes s
join pg_index i on i.indexrelid = s.indexrelid
where s.idx_scan = 0
	and not i.indisunique
	and not i.indisprimary
	and pg_relation_size(s.indexrelid) > 16384
order by pg_relation_size(s.indexrelid) desc;

\echo ''
\echo '== structurally duplicate indexes =='
with indexes as (
	select
		indrelid,
		indisunique,
		indisprimary,
		indkey,
		indclass,
		indcollation,
		indoption,
		coalesce(indexprs::text, '') as indexprs,
		coalesce(indpred::text, '') as indpred,
		indexrelid
	from pg_index
)
select
	indrelid::regclass as table_name,
	array_agg(indexrelid::regclass order by indexrelid::regclass::text) as duplicate_indexes,
	count(*) as duplicate_count
from indexes
group by
	indrelid,
	indisunique,
	indisprimary,
	indkey,
	indclass,
	indcollation,
	indoption,
	indexprs,
	indpred
having count(*) > 1
order by duplicate_count desc, table_name;

\echo ''
\echo '== invalid or not-ready indexes =='
select
	indrelid::regclass as table_name,
	indexrelid::regclass as index_name,
	indisvalid,
	indisready,
	indislive
from pg_index
where not indisvalid
	or not indisready
	or not indislive
order by table_name, index_name;
