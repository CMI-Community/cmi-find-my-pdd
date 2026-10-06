import { createClient } from '@supabase/supabase-js';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decryptFile } from './crypto.mjs';
import { projectGuard, required, pgEnv, run } from './ops.mjs';

const project = projectGuard();
if (process.env.APP_ENVIRONMENT !== 'test') throw new Error('Restore runs only in an isolated test project. Production recovery requires a reviewed maintenance procedure.');
if (process.env.RESTORE_TARGET_CONFIRM !== project) throw new Error('Set RESTORE_TARGET_CONFIRM to the exact isolated test project ID.');
if (process.env.RESTORE_OFFLINE_CONFIRMED !== 'true') throw new Error('First disable/remove target API and worker, then explicitly set RESTORE_OFFLINE_CONFIRMED=true.');
const source = process.argv[2]; if (!source) throw new Error('Usage: npm run ops:restore -- backups/file.cmibak');
if (new URL(required('SUPABASE_URL')).hostname !== `${project}.supabase.co`) throw new Error('Storage project mismatch.');
const dbEnvironment = pgEnv();
const db = createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
const temporary = await mkdtemp(path.join(tmpdir(), 'cmi-restore-'));
try {
  const archive = path.join(temporary, 'archive.tar.gz');
  await decryptFile(source, archive, required('BACKUP_PASSWORD'));
  await run('tar', ['-xzf', archive, '-C', temporary]);
  const manifest = JSON.parse(await readFile(path.join(temporary, 'manifest.json'), 'utf8'));
  if (manifest.product !== 'cmi-find-my-pdd') throw new Error('Wrong product backup.');
  await run('psql', ['--set', 'ON_ERROR_STOP=1', '--dbname', 'postgres', '--command', "do $$begin if to_regclass('cron.job') is not null then perform cron.unschedule(jobid) from cron.job where jobname in ('cmi-durable-worker','pdd404-retention'); end if; end$$;"], { env: dbEnvironment });
  await run('pg_restore', ['--no-owner', '--exit-on-error', '--clean', '--if-exists', '--dbname', 'postgres', path.join(temporary, 'database.dump')], { env: dbEnvironment });
  const runtime = JSON.stringify({ APP_ENVIRONMENT: 'test', APP_PUBLIC_URL: required('APP_PUBLIC_URL'), ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? required('APP_PUBLIC_URL'), ADMIN_USER_IDS: process.env.ADMIN_USER_IDS ?? '', OCR_ENABLED: 'false', APP_SHA: process.env.APP_SHA ?? 'restore-test' }).replace(/'/g, "''");
  const isolate = path.join(temporary, 'isolate.sql');
  await writeFile(isolate, `begin;
update public.scans set environment='test', state=case when state in ('queued','running','deferred') then 'failed' else state end;
update public.jobs set status='cancelled',lease_token=null,lease_expires_at=null where status in ('pending','leased');
update public.site_settings set value=value||'{"submissionsEnabled":false}'::jsonb where key='community';
insert into public.site_settings(key,value) values('runtime','${runtime}'::jsonb) on conflict(key) do update set value=excluded.value;
commit;`, { mode: 0o600 });
  await run('psql', ['--set', 'ON_ERROR_STOP=1', '--dbname', 'postgres', '--file', isolate], { env: dbEnvironment });
  for (const file of manifest.files) {
    if (!['parcel-originals', 'parcel-public', 'community-assets'].includes(file.bucket) || file.key.includes('..') || file.key.startsWith('/')) throw new Error('Invalid storage manifest.');
    const data = await readFile(path.join(temporary, 'storage', file.bucket, file.key));
    const { error } = await db.storage.from(file.bucket).upload(file.key, data, { contentType: file.contentType, upsert: true });
    if (error) throw new Error('Storage restore failed.');
  }
  console.log('Isolated restore completed. Run the acceptance suite before any recovery action.');
} finally { await rm(temporary, { recursive: true, force: true }); }
