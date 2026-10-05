import { createClient } from '@supabase/supabase-js';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encryptFile } from './crypto.mjs';
import { projectGuard, required, pgEnv, run } from './ops.mjs';

const project = projectGuard();
const password = required('BACKUP_PASSWORD');
const db = createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
if (new URL(required('SUPABASE_URL')).hostname !== `${project}.supabase.co`) throw new Error('Storage project mismatch.');
const temporary = await mkdtemp(path.join(tmpdir(), 'cmi-backup-'));
const output = path.resolve('backups');
await mkdir(output, { recursive: true, mode: 0o700 });
try {
  await run('pg_dump', ['--format=custom', '--no-owner', '--schema=public', '--schema=auth', '--file', path.join(temporary, 'database.dump')], { env: pgEnv() });
  const files = [];
  async function folder(bucket, prefix = '') {
    for (let offset = 0; ; offset += 100) {
      const { data, error } = await db.storage.from(bucket).list(prefix, { limit: 100, offset, sortBy: { column: 'name', order: 'asc' } });
      if (error) throw new Error('Unable to list private storage.');
      for (const item of data ?? []) {
        if (item.name === '.' || item.name === '..' || item.name.includes('/')) throw new Error('Invalid storage name.');
        const key = prefix ? `${prefix}/${item.name}` : item.name;
        if (!item.id) { await folder(bucket, key); continue; }
        const { data: blob, error: readError } = await db.storage.from(bucket).download(key);
        if (readError || !blob) throw new Error('Incomplete storage backup.');
        const local = path.join(temporary, 'storage', bucket, key);
        await mkdir(path.dirname(local), { recursive: true, mode: 0o700 });
        await writeFile(local, new Uint8Array(await blob.arrayBuffer()), { mode: 0o600 });
        files.push({ bucket, key, contentType: blob.type });
      }
      if ((data?.length ?? 0) < 100) break;
    }
  }
  await folder('parcel-originals'); await folder('parcel-public'); await folder('community-assets');
  await writeFile(path.join(temporary, 'manifest.json'), JSON.stringify({ product: 'cmi-find-my-pdd', project, createdAt: new Date().toISOString(), files, sha: process.env.APP_SHA ?? null }), { mode: 0o600 });
  const archive = path.join(temporary, 'archive.tar.gz');
  await run('tar', ['-czf', archive, '-C', temporary, 'database.dump', 'manifest.json', ...(files.length ? ['storage'] : [])]);
  const destination = path.join(output, `cmi-${project}-${Date.now()}.cmibak`);
  await encryptFile(archive, destination, password);
  const retained = (await readdir(output)).filter(n => n.startsWith(`cmi-${project}-`) && n.endsWith('.cmibak')).sort().reverse();
  for (const name of retained.slice(7)) await rm(path.join(output, name));
  console.log(`Encrypted backup created: ${path.basename(destination)} (${files.length} stored images).`);
} finally { await rm(temporary, { recursive: true, force: true }); }
