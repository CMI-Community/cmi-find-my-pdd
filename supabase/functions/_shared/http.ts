import { getRuntime } from './runtime.ts';

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400, public retryable = false) { super(message); }
}

export function corsHeaders(request: Request, readConfig: (name: string) => string | undefined = getRuntime): Record<string, string> {
  const origin = request.headers.get('origin');
  const allowed = [readConfig('APP_PUBLIC_URL'), ...(readConfig('ALLOWED_ORIGINS') ?? '').split(',')]
    .filter(Boolean).map((value) => { try { return new URL(value!.trim()).origin; } catch { return ''; } });
  if (origin && !allowed.includes(origin)) throw new ApiError('FORBIDDEN', '此网站未被授权调用服务。', 403);
  return {
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Headers': 'authorization, content-type, idempotency-key, apikey, x-client-info, x-content-sha256',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600', 'Vary': 'Origin',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  };
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ data }), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}

export function failure(error: unknown, requestId: string, headers: Record<string, string> = {}): Response {
  const known = error instanceof ApiError;
  return new Response(JSON.stringify({ error: {
    code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : '服务暂时不可用，请稍后再试。',
    requestId, retryable: known ? error.retryable : true,
  } }), { status: known ? error.status : 500, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}

export async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new ApiError('INVALID_REQUEST', '请使用 JSON 请求。', 415);
  const raw = await request.text();
  if (raw.length > 32_768) throw new ApiError('INVALID_REQUEST', '请求内容过大。', 413);
  let result: unknown;
  try { result = JSON.parse(raw); } catch { throw new ApiError('INVALID_REQUEST', '请求格式有误。'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ApiError('INVALID_REQUEST', '请求必须是对象。');
  return result as Record<string, unknown>;
}

export function onlyKeys(input: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new ApiError('INVALID_REQUEST', '包含不允许提交的字段。');
}

export function stringValue(value: unknown, name: string, max = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ApiError('INVALID_REQUEST', `${name}格式有误。`);
  return value.trim();
}

export function uuid(value: unknown): string {
  const id = stringValue(value, '编号', 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new ApiError('INVALID_REQUEST', '编号格式有误。');
  return id;
}

export function version(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new ApiError('INVALID_REQUEST', '缺少有效版本号。');
  return Number(value);
}

/** Candidate GETs are fenced to the version and selection the browser rendered. */
export function candidateRequest(url: URL, currentVersion: number, currentSelection: string | null): { imageVersion: number; offset: number; selectedIdentifierId: string | null } {
  const params = url.searchParams;
  const allowed = ['imageVersion', 'offset', 'selectedIdentifierId'];
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new ApiError('INVALID_REQUEST', '候选分页参数有误。');
  }
  const rawVersion = params.get('imageVersion') ?? '';
  const rawOffset = params.get('offset') ?? '0';
  if (!/^[1-9]\d*$/.test(rawVersion) || !/^\d+$/.test(rawOffset)) throw new ApiError('INVALID_REQUEST', '候选分页参数有误。');
  const imageVersion = Number(rawVersion), offset = Number(rawOffset);
  if (!Number.isSafeInteger(imageVersion) || !Number.isSafeInteger(offset) || offset > 100000) throw new ApiError('INVALID_REQUEST', '候选分页参数超出范围。');
  const selectedIdentifierId = params.has('selectedIdentifierId') ? stringValue(params.get('selectedIdentifierId'), '选择的识别编号', 100) : null;
  if (imageVersion !== currentVersion || selectedIdentifierId !== currentSelection) throw new ApiError('VERSION_CONFLICT', '照片或选择的号码已更新，请刷新后再加载候选。', 409);
  return { imageVersion, offset, selectedIdentifierId };
}
