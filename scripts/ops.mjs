import { spawn } from 'node:child_process';
export function required(name) { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; }
export function projectGuard() {
  const id = required('SUPABASE_PROJECT_ID');
  if (!/^[a-z]{20}$/.test(id) || ['osqyplgctlzdlpqmzfud'].includes(id)) throw new Error('Independent product project required.');
  return id;
}
export function pgEnv() {
  const connection = new URL(required('SUPABASE_DB_URL'));
  if (!['postgres:', 'postgresql:'].includes(connection.protocol)) throw new Error('Postgres URL required.');
  const project = projectGuard();
  const localTest = process.env.APP_ENVIRONMENT === 'test' && ['localhost', '127.0.0.1'].includes(connection.hostname);
  const direct = connection.hostname === `db.${project}.supabase.co`;
  const pooler = connection.hostname.endsWith('.pooler.supabase.com') && decodeURIComponent(connection.username) === `postgres.${project}`;
  if (!localTest && !direct && !pooler) throw new Error('Database connection does not match intended independent project.');
  return { ...process.env, PGHOST: connection.hostname, PGPORT: connection.port || '5432', PGUSER: decodeURIComponent(connection.username), PGPASSWORD: decodeURIComponent(connection.password), PGDATABASE: connection.pathname.slice(1) || 'postgres', PGSSLMODE: connection.hostname === 'localhost' || connection.hostname === '127.0.0.1' ? 'disable' : 'require' };
}
export async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', () => reject(new Error(`Unable to run ${command}; install the documented prerequisite.`)));
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
