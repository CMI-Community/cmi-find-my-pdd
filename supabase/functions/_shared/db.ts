import { dimensions } from './security.ts';
import { getRuntime, ensureRuntimeConfig as ensureConfig } from './runtime.ts';

/** Server-only database helpers. Never import this module into the web bundle. */
export type JsonRow = Record<string, unknown>;

export function env(name: string): string {
  const value = getRuntime(name);
  if (!value) throw new Error('CONFIGURATION_ERROR');
  return value;
}

function serviceHeaders(): Record<string, string> {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

export async function dbRpc<T>(name: string, payload: JsonRow = {}): Promise<T> {
  const response = await fetch(`${env('SUPABASE_URL')}/rest/v1/rpc/${encodeURIComponent(name)}`, {
    method: 'POST', headers: serviceHeaders(), body: JSON.stringify({ p_payload: payload }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    // Error details can contain private SQL row values. Retain only the stable code.
    const data = await response.json().catch(() => ({})) as { code?: string; message?: string };
    if (data.code === '40001') throw new Error('STALE_LEASE');
    throw new Error(`DATABASE_ERROR_${response.status}`);
  }
  return await response.json() as T;
}

export async function ensureRuntimeConfig(): Promise<void> {
  await ensureConfig(() => dbRpc<Record<string, unknown>>('runtime_config'));
}

export async function downloadOriginal(path: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`${env('SUPABASE_URL')}/storage/v1/object/authenticated/parcel-originals/${encodedPath}`, {
    headers: serviceHeaders(), signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error('IMAGE_UNAVAILABLE');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 1 || bytes.length > 5 * 1024 * 1024) throw new Error('IMAGE_UNAVAILABLE');
  try {
    const { mime, width, height } = await dimensions(bytes);
    if (width < 1 || height < 1 || width > 2048 || height > 2048) throw new Error('IMAGE_UNAVAILABLE');
    return { bytes, mime };
  } catch { throw new Error('IMAGE_UNAVAILABLE'); }
}

export async function removeStorage(bucket: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  const response = await fetch(`${env('SUPABASE_URL')}/storage/v1/object/${encodeURIComponent(bucket)}`, {
    method: 'DELETE', headers: serviceHeaders(), body: JSON.stringify({ prefixes: paths }), signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error('CLEANUP_STORAGE_ERROR');
}
