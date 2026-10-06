import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import type { CandidatePage, Community, Extraction, ImageRole, PublicRecord, ScanProgress, ScanStart, PrivateRecord } from '../../../shared/contracts.ts';
import { APP_VERSION } from '../../../shared/contracts.ts';
import { publicSummary } from '../../../shared/domain.ts';
import { ApiError, body, candidateRequest, corsHeaders, failure, json, onlyKeys, stringValue, uuid, version } from '../_shared/http.ts';
import { bearer, capability, canonicalJson, contact, dimensions, fingerprint, sha256, withoutMetadata } from '../_shared/security.ts';
import { ensureRuntimeConfig, getRuntime } from '../_shared/runtime.ts';
import { pddRoute } from '../_shared/waybill-api.ts';
import { feedbackRoute } from '../_shared/feedback-api.ts';

type Row = Record<string, any>;
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;
const BUCKET = 'parcel-originals';
const ROLES: ImageRole[] = ['label', 'item', 'logistics', 'product'];
const MAX_BYTES = 5 * 1024 * 1024;
function database(): SupabaseClient {
  const url = getRuntime('SUPABASE_URL');
  const key = getRuntime('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new ApiError('SERVICE_UNAVAILABLE', '服务尚未完成配置。', 503, true);
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function rpc(db: SupabaseClient, name: string, payload: Row): Promise<Row> {
  const { data, error } = await db.rpc(name, { p_payload: payload });
  if (error) {
    const raw = String(error.message ?? '');
    const recognized = ['VERSION_CONFLICT', 'SCAN_EXPIRED', 'QUERY_EXPIRED', 'QUERY_TIMEOUT', 'RATE_LIMITED', 'FORBIDDEN', 'INVALID_IMAGE', 'UPLOAD_INCOMPLETE', 'NEEDS_PHOTO', 'OCR_DEFERRED', 'INVALID_REQUEST', 'INVALID_CONTACT', 'INVALID_WAYBILL', 'IDEMPOTENCY_CONFLICT', 'RECORD_NOT_FOUND', 'SCAN_NOT_FOUND', 'WAYBILL_NOT_FOUND', 'QUERY_NOT_FOUND', 'OWNERSHIP_LOCKED', 'NEEDS_RECEIVED', 'INVALID_ADMIN_STATE'].find((code) => raw.includes(code));
    if (recognized === 'RECORD_NOT_FOUND' || recognized === 'SCAN_NOT_FOUND' || recognized === 'WAYBILL_NOT_FOUND' || recognized === 'QUERY_NOT_FOUND') throw new ApiError('NOT_FOUND', '记录不存在。', 404);
    if (recognized === 'OWNERSHIP_LOCKED') throw new ApiError('OWNERSHIP_LOCKED', '包裹已确认归属，撤回请联系小助手处理。', 409);
    if (recognized === 'NEEDS_RECEIVED') throw new ApiError('NEEDS_RECEIVED', '需有有效的错收件登记才能确认实际包裹归属。', 409);
    if (recognized === 'INVALID_ADMIN_STATE') throw new ApiError('INVALID_ADMIN_STATE', '当前状态不能执行此操作，请先核实并确认归属。', 409);
    if (recognized === 'QUERY_TIMEOUT') throw new ApiError('QUERY_TIMEOUT', '疑似线索查询暂时较慢，请稍后重试，或核对完整国内单号后再查询。', 503, true);
    if (recognized === 'QUERY_EXPIRED') throw new ApiError('QUERY_EXPIRED', '这次查询已过期，请重新查询后留下联系方式。', 410);
    if (error.code === '40001' || error.code === '23505' || recognized === 'VERSION_CONFLICT' || recognized === 'IDEMPOTENCY_CONFLICT') throw new ApiError(recognized ?? 'VERSION_CONFLICT', '内容已更新或请求重复，请刷新后重试。', 409);
    if (recognized === 'SCAN_EXPIRED') throw new ApiError('SCAN_EXPIRED', '本次查询已过期，请重新上传。', 410);
    if (recognized === 'RATE_LIMITED') throw new ApiError('RATE_LIMITED', '操作过于频繁，请稍后再试。', 429, true);
    if (error.code === '42501' || recognized === 'FORBIDDEN') throw new ApiError('FORBIDDEN', '没有访问权限。', 403);
    if (error.code === '22023' || recognized) throw new ApiError(recognized ?? 'INVALID_REQUEST', recognized === 'NEEDS_PHOTO' ? '请补充清晰照片后再试。' : '请求内容或当前状态不符合要求。', 422);
    // Database error details may contain private row values; never return or log them.
    throw new ApiError('SERVICE_UNAVAILABLE', '服务暂时不可用，请稍后重试。', 503, true);
  }
  return data ?? {};
}

async function scanAccess(db: SupabaseClient, request: Request, id: string): Promise<Row> {
  const hash = await sha256(capability(request));
  const { data, error } = await db.from('scans').select('*').eq('id', uuid(id)).eq('capability_hash', hash).maybeSingle();
  if (error) throw new ApiError('SERVICE_UNAVAILABLE', '服务暂时不可用。', 503, true);
  if (!data) throw new ApiError('FORBIDDEN', '管理凭证无效。', 403);
  const { data: record } = await db.from('records').select('id').eq('scan_id', id).maybeSingle();
  if (!record && data.expires_at && Date.parse(data.expires_at) < Date.now()) throw new ApiError('SCAN_EXPIRED', '本次查询已过期，请重新上传。', 410);
  return data;
}

async function recordAccess(db: SupabaseClient, request: Request, code: string): Promise<{ scan: Row; record: Row }> {
  const { data: record, error } = await db.from('records').select('*').eq('public_code', code).maybeSingle();
  if (error) throw new ApiError('SERVICE_UNAVAILABLE', '服务暂时不可用。', 503, true);
  if (!record) throw new ApiError('NOT_FOUND', '记录不存在。', 404);
  return { record, scan: await scanAccess(db, request, record.scan_id) };
}

async function admin(db: SupabaseClient, request: Request): Promise<string> {
  const { data, error } = await db.auth.getUser(bearer(request));
  const allowed = (getRuntime('ADMIN_USER_IDS') ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  if (error || !data.user || !allowed.includes(data.user.id)) throw new ApiError('FORBIDDEN', '仅管理员可执行此操作。', 403);
  return data.user.id;
}

async function limited(db: SupabaseClient, request: Request, route: string, limit = 30): Promise<void> {
  const key = await sha256(`${fingerprint(request)}:${route}`);
  const result = await rpc(db, 'rate_limit_tick', { key, window_seconds: 60, limit });
  if (result.allowed === false) throw new ApiError('RATE_LIMITED', '操作过于频繁，请稍后再试。', 429, true);
}

function imageRoles(input: unknown, intent: string): ImageRole[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 2 || input.some((role) => !ROLES.includes(role)) || new Set(input).size !== input.length) throw new ApiError('INVALID_IMAGE', '每包请上传一至两张不同用途的照片。');
  const roles = input as ImageRole[];
  const required = intent === 'received' ? 'label' : 'logistics';
  const optional = intent === 'received' ? 'item' : 'product';
  if (!roles.includes(required) || roles.some((role) => role !== required && role !== optional)) throw new ApiError('INVALID_IMAGE', intent === 'received' ? '请至少拍摄一张面单照片。' : '请至少上传一张物流截图。');
  return roles;
}

function selectedIdentifier(scan: Row, input: unknown): string {
  const selected = stringValue(input, '选择的识别编号', 100);
  const identifiers: Row[] = scan.extraction?.identifiers ?? [];
  if (scan.state !== 'succeeded' || !identifiers.some((entry) => entry.id === selected && ['domestic_waybill', 'last_mile_waybill', 'consolidation_waybill'].includes(entry.type))) {
    throw new ApiError('INVALID_REQUEST', '只能选择本次识别出的包裹运单线索。');
  }
  return selected;
}

async function reserve(db: SupabaseClient, scanId: string, inputVersion: number, roles: ImageRole[]): Promise<ScanStart> {
  const imageRows = roles.map((role) => ({ id: crypto.randomUUID(), role, path: `${scanId}/${inputVersion}/${role}.image`, mime: 'image/jpeg', size: 0 }));
  const saved = await rpc(db, 'reserve_images', { scan_id: scanId, version: inputVersion, images: imageRows });
  const rows: Row[] = Array.isArray(saved.images) ? saved.images : imageRows;
  const uploads = await Promise.all(rows.map(async (row) => {
    const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(row.path, { upsert: false });
    if (error || !data) throw new ApiError('SERVICE_UNAVAILABLE', '无法准备上传，请稍后重试。', 503, true);
    return { id: row.id, role: row.role as ImageRole, uploadUrl: data.signedUrl, path: row.path, token: data.token, bucket: BUCKET };
  }));
  return { id: scanId, imageVersion: inputVersion, uploads };
}

async function checkImages(db: SupabaseClient, scan: Row, ids: unknown): Promise<Row[]> {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 2 || new Set(ids).size !== ids.length) throw new ApiError('INVALID_IMAGE', '图片数量有误。');
  const { data, error } = await db.from('images').select('*').eq('scan_id', scan.id).eq('version', scan.input_version);
  if (error) throw new ApiError('SERVICE_UNAVAILABLE', '暂时无法检查图片。', 503, true);
  if (!data || data.length !== ids.length || data.some((row) => !ids.includes(row.id))) throw new ApiError('UPLOAD_INCOMPLETE', '请先完成全部照片上传。');
  imageRoles(data.map((row) => row.role), scan.intent);
  const checked: Row[] = [];
  for (const row of data) {
    if (row.path !== `${scan.id}/${scan.input_version}/${row.role}.image`) throw new ApiError('INVALID_IMAGE', '图片路径不符合当前版本。');
    const { data: file, error: downloadError } = await db.storage.from(BUCKET).download(row.path);
    if (downloadError || !file) throw new ApiError('UPLOAD_INCOMPLETE', '图片尚未上传完成，请重试。', 409, true);
    if (!file.size || file.size > MAX_BYTES) throw new ApiError('INVALID_IMAGE', '单张图片不能超过 5MB。');
    const pixels = await dimensions(new Uint8Array(await file.arrayBuffer()));
    if (pixels.width < 1 || pixels.height < 1 || Math.max(pixels.width, pixels.height) > 2048) throw new ApiError('INVALID_IMAGE', '图片最长边不能超过 2048 像素。');
    if (file.type && file.type !== 'application/octet-stream' && file.type !== pixels.mime) throw new ApiError('INVALID_IMAGE', '图片内容与文件格式不一致。');
    checked.push({ id: row.id, ...pixels, size: file.size });
  }
  return checked;
}

const IDENTIFIERS = ['domestic_waybill', 'consolidation_waybill', 'last_mile_waybill', 'order_id', 'unknown_id'];
function publicDto(row: Row): PublicRecord {
  const code = String(row.code ?? row.public_code ?? '');
  const updatedAt = row.updatedAt ?? row.updated_at;
  if (!/^CMI-[A-Z0-9-]{1,60}$/.test(code) || !['pending', 'active', 'withdrawn'].includes(row.visibility) || typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt))) {
    throw new ApiError('SERVICE_UNAVAILABLE', '记录暂时无法读取，请稍后再试。', 503, true);
  }
  const visibility = row.visibility;
  const title = visibility === 'withdrawn' ? '记录已撤回' : publicSummary({ identifiers: [], recipientName: null, itemNames: [String(row.title ?? '')], specifications: [], tags: [], validImage: true });
  const identifiers = visibility === 'withdrawn' ? [] : (Array.isArray(row.identifiers) ? row.identifiers : []).filter((entry: Row) => IDENTIFIERS.includes(entry.type) && !['order_id', 'unknown_id'].includes(entry.type)).map((entry: Row) => ({ type: entry.type, tail: String(entry.tail ?? '').slice(-4) }));
  const rawHint = row.recipientHint ?? row.recipient_hint;
  const recipientHint = typeof rawHint === 'string' && /^[\p{L}]/u.test(rawHint) ? `${Array.from(rawHint)[0]}••` : null;
  const origin = (getRuntime('APP_PUBLIC_URL') ?? '').replace(/\/$/, '');
  return { code, kind: row.kind === 'tracking' ? 'tracking' : 'received', title,
    recipientHint: visibility === 'withdrawn' ? null : recipientHint,
    identifiers, quality: ['complete', 'partial', 'unusable'].includes(row.quality) ? row.quality : null,
    resolution: ['open', 'verifying', 'claimed', 'resolved'].includes(row.resolution) ? row.resolution : 'open', visibility,
    updatedAt, url: `${origin}/p/${encodeURIComponent(code)}`,
    imageUrl: visibility === 'withdrawn' ? null : row.image_approved === true ? `${getRuntime('SUPABASE_URL')}/functions/v1/api/v1/records/${encodeURIComponent(code)}/image` : null,
  } as PublicRecord;
}

async function publicFor(db: SupabaseClient, code: string): Promise<PublicRecord> {
  const result = await rpc(db, 'public_record', { public_code: code });
  if (!result || result.found === false || !(result.code ?? result.record?.code ?? result.public_code)) throw new ApiError('NOT_FOUND', '记录不存在。', 404);
  return publicDto(result.record ?? result);
}

async function matchResults(db: SupabaseClient, rawMatches: Row[]): Promise<ScanProgress['results']> {
  return await Promise.all(rawMatches.map(async (entry: Row) => {
    const record = entry.record ? publicDto(entry.record) : await publicFor(db, entry.publicCode ?? entry.public_code ?? entry.code);
    return { record, kind: entry.kind === 'exact' ? 'exact' as const : 'possible' as const, reasons: Array.isArray(entry.reasons) ? entry.reasons.filter((text: unknown) => typeof text === 'string').map((text: string) => text.replace(/\d{6,}/g, '***')) : [] };
  }));
}

async function scanProgress(db: SupabaseClient, id: string): Promise<ScanProgress> {
  // Legacy status RPC performs matching writes. The retired photo flow stays read-only.
  let source: Row;
  if (getRuntime('OCR_ENABLED') === 'true') source = await rpc(db, 'get_scan_status', { scan_id: id });
  else {
    const { data: scan, error } = await db.from('scans').select('*').eq('id', id).maybeSingle();
    if (error || !scan) throw new ApiError('NOT_FOUND', '旧图片草稿不存在。', 404);
    const { data: record } = await db.from('records').select('public_code').eq('scan_id', id).maybeSingle();
    source = { ...scan, intent: scan.intent, imageVersion: scan.input_version, publicCode: record?.public_code, results: [], errorCode: 'OCR_DISABLED' };
  }
  const state = source.state;
  const intent = source.intent ?? source.kind;
  const imageVersion = source.imageVersion ?? source.version ?? source.input_version;
  if (!['draft', 'queued', 'running', 'succeeded', 'needs_photo', 'deferred', 'failed', 'cancelled'].includes(state) ||
      !['received', 'search'].includes(intent) || !Number.isInteger(imageVersion) || imageVersion < 1) {
    throw new ApiError('SERVICE_UNAVAILABLE', '暂时无法读取识别进度，请稍后再试。', 503, true);
  }
  const code = source.publicCode ?? source.public_code ?? source.record?.code;
  const rawMatches = Array.isArray(source.matches) ? source.matches : Array.isArray(source.results) ? source.results : [];
  const results = await matchResults(db, rawMatches);
  const extraction = source.extraction ?? source.recognition ?? null;
  const identifiers = (extraction as Extraction | null)?.identifiers ?? [];
  const selected = source.selectedIdentifierId ?? source.selected_identifier_id ?? null;
  const selectable = identifiers.filter((identifier) => ['domestic_waybill', 'last_mile_waybill', 'consolidation_waybill'].includes(identifier.type));
  const distinct = new Set(selectable.map((identifier) => `${identifier.type}:${identifier.value.replace(/\s/g, '').toUpperCase()}`));
  return { id, intent, imageVersion,
    state, quality: source.quality ?? null, extraction, record: source.record ? publicDto(source.record) : code ? await publicFor(db, code) : null,
    results, requiresSelection: typeof source.requiresSelection === 'boolean' ? source.requiresSelection : distinct.size > 1 && !selected,
    selectedIdentifierId: selected, errorCode: source.errorCode ?? source.error_code ?? null };
}

async function privateDto(db: SupabaseClient, code: string): Promise<PrivateRecord> {
  let source: Row;
  if (getRuntime('OCR_ENABLED') === 'true') source = await rpc(db, 'admin_record', { public_code: code });
  else {
    const { data: record, error } = await db.from('records').select('*').eq('public_code', code).maybeSingle();
    if (error || !record) throw new ApiError('NOT_FOUND', '旧登记不存在。', 404);
    source = record;
  }
  const record = source.record ?? source;
  const scanId = source.scanId ?? source.scan_id ?? record.scan_id;
  const progress = await scanProgress(db, scanId);
  const { data: images } = await db.from('images').select('id,role,path').eq('scan_id', scanId).eq('version', progress.imageVersion);
  const privateImages = await Promise.all((images ?? []).map(async (image) => {
    const { data } = await db.storage.from(BUCKET).createSignedUrl(image.path, 120);
    return { id: image.id, role: image.role as ImageRole, url: data?.signedUrl ?? '' };
  }));
  return { record: progress.record ?? publicDto(record), scanId, imageVersion: progress.imageVersion,
    revision: source.revision ?? record.revision, contact: source.contact ?? record.contact, extraction: progress.extraction,
    images: privateImages, results: progress.results, state: progress.state, canRevise: !['claimed', 'resolved'].includes(record.resolution) && record.visibility !== 'withdrawn' };
}

async function settings(db: SupabaseClient): Promise<Community> {
  const { data, error } = await db.from('site_settings').select('*');
  if (error) throw new ApiError('SERVICE_UNAVAILABLE', '社区资料暂时不可用。', 503, true);
  const map: Row = {};
  for (const row of data ?? []) { if (row.key) map[row.key] = row.value; else Object.assign(map, row); }
  const raw = map.community ?? map;
  const community: Community = {
    groupQrUrl: raw.groupQrUrl ?? raw.group_qr_url ?? null,
    assistantWechat: raw.assistantWechat ?? raw.assistant_wechat ?? null,
    assistantQrUrl: raw.assistantQrUrl ?? raw.assistant_qr_url ?? null,
    officialAccountName: raw.officialAccountName ?? raw.official_account_name ?? null,
    officialAccountQrUrl: raw.officialAccountQrUrl ?? raw.official_account_qr_url ?? null,
    projectUrl: 'https://github.com/CMI-Community/cmi-find-my-pdd',
    submissionsEnabled: raw.submissionsEnabled === true || raw.submissions_enabled === true,
    ready: false,
  };
  community.ready = Boolean(community.groupQrUrl && community.assistantWechat && community.officialAccountName && community.officialAccountQrUrl);
  return community;
}

async function kickWorker(): Promise<void> {
  const key = getRuntime('WORKER_SECRET');
  const url = getRuntime('SUPABASE_URL');
  if (!key || !url) return;
  try { await fetch(`${url}/functions/v1/worker`, { method: 'POST', headers: { 'x-worker-secret': key, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3000) }); } catch { /* durable cron retries */ }
}

function backgroundWake(): void {
  const promise = kickWorker();
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(promise);
}

function idem(request: Request): string {
  return stringValue(request.headers.get('idempotency-key'), '幂等请求编号', 128);
}

async function route(request: Request, db: SupabaseClient, headers: Record<string, string>): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/functions\/v1\/api/, '').replace(/^\/api/, '').replace(/^\/v1/, '') || '/';
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const method = request.method;
  if (path === '/health' && method === 'GET') {
    let ready = false, ok = false;
    try { const community = await settings(db); await rpc(db, 'pdd_stats', {}); ready = community.ready && community.submissionsEnabled && Boolean(getRuntime('ADMIN_USER_IDS')); ok = true; } catch { /* configuration pending */ }
    return json({ service: 'pdd404', version: APP_VERSION, sha: getRuntime('DEPLOY_SHA') ?? getRuntime('APP_SHA') ?? 'unknown', environment: getRuntime('APP_ENVIRONMENT') ?? 'test', ok, ready }, 200, headers);
  }
  await limited(db, request, parts[0] ?? 'root', method === 'GET' ? 120 : 20);
  if (parts[0] === 'feedback' && method === 'POST') await limited(db, request, 'feedback-submit', 5);
  const feedbackResponse = await feedbackRoute(request, parts, headers, { rpc: (name, payload) => rpc(db, name, payload), admin: () => admin(db, request) });
  if (feedbackResponse) return feedbackResponse;
  const pddResponse = await pddRoute(request, parts, headers, {
    rpc: (name, payload) => rpc(db, name, payload), admin: () => admin(db, request),
    canRegister: async () => { const community = await settings(db); return community.ready && community.submissionsEnabled && Boolean(getRuntime('ADMIN_USER_IDS')); },
  });
  if (pddResponse) return pddResponse;
  const legacyScope = ['scans', 'trackers', 'manage'].includes(parts[0]) ||
    parts[0] === 'admin' && ['scans', 'tasks', 'records', 'duplicates', 'recognition'].includes(parts[1]);
  if (getRuntime('OCR_ENABLED') !== 'true' && legacyScope &&
      (method !== 'GET' || parts[0] === 'scans' && parts[2] === 'candidates')) {
    throw new ApiError('SERVICE_UNAVAILABLE', '图片识别入口已暂停，请在首页输入或扫描国内快递单号。', 503, false);
  }
  if (path === '/community' && method === 'GET') return json(await settings(db), 200, headers);
  if (path === '/stats' && method === 'GET') {
    const result = await rpc(db, 'pdd_stats', {});
    const success = Object.hasOwn(result, 'successfulHandoverCount') ? result.successfulHandoverCount : result.successful_handover_count;
    const recorded = result.recordedPackageCount ?? result.recorded_package_count;
    const seekers = result.activeSeekerCount ?? result.active_seeker_count;
    if (![recorded, seekers].every((count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) || !(success === null || typeof success === 'number' && Number.isSafeInteger(success) && success >= 0)) throw new ApiError('SERVICE_UNAVAILABLE', '统计暂时不可用。', 503, true);
    return json({ recordedPackageCount: recorded, activeSeekerCount: seekers, successfulHandoverCount: typeof success === 'number' && success > 5 ? success : null }, 200, headers);
  }
  if (path === '/scans' && method === 'POST') {
    if (getRuntime('OCR_ENABLED') !== 'true') throw new ApiError('SERVICE_UNAVAILABLE', '图片识别入口已暂停，请在首页输入或扫描国内快递单号。', 503, false);
    const input = await body(request); onlyKeys(input, ['requestId', 'intent', 'imageRoles']);
    const id = uuid(input.requestId);
    if (input.intent !== 'received' && input.intent !== 'search') throw new ApiError('INVALID_REQUEST', '请选择登记或查询。');
    const roles = imageRoles(input.imageRoles, input.intent);
    const community = await settings(db);
    if (input.intent === 'received' && (!community.submissionsEnabled || !community.ready || !getRuntime('ADMIN_USER_IDS'))) throw new ApiError('SERVICE_UNAVAILABLE', '社区联系服务尚未配置完成，暂时不能正式登记。', 503, true);
    if (!getRuntime('OPENAI_API_KEY') || !getRuntime('WORKER_SECRET')) throw new ApiError('SERVICE_UNAVAILABLE', '识别服务尚未完成配置，请稍后再试。', 503, true);
    await rpc(db, 'create_scan', { id, intent: input.intent, kind: input.intent, initial_request_hash: await sha256(canonicalJson({ intent: input.intent, imageRoles: roles })),
      capability_hash: await sha256(capability(request)), environment: getRuntime('APP_ENVIRONMENT') ?? 'test' });
    const scan = await scanAccess(db, request, id);
    if (scan.state !== 'draft') throw new ApiError('VERSION_CONFLICT', '该提交已经开始处理，请查看进度。', 409);
    return json(await reserve(db, id, scan.input_version, roles), 201, headers);
  }
  if (parts[0] === 'scans' && parts[1]) {
    if (method !== 'GET' && getRuntime('OCR_ENABLED') !== 'true') throw new ApiError('SERVICE_UNAVAILABLE', '图片识别入口已暂停，请使用国内快递单号查询。', 503, false);
    const scan = await scanAccess(db, request, parts[1]);
    if (parts.length === 2 && method === 'GET') return json(await scanProgress(db, scan.id), 200, headers);
    if (parts[2] === 'candidates' && parts.length === 3 && method === 'GET') {
      const page = candidateRequest(url, scan.input_version, scan.selected_identifier_id ?? null);
      if (scan.state !== 'succeeded' || scan.quality === 'unusable') throw new ApiError('INVALID_REQUEST', '请先完成有效图片识别后查看候选。', 422);
      const source = await rpc(db, 'match_scan', { scan_id: scan.id, version: page.imageVersion, offset: page.offset,
        enforce_selection: true, expected_selected_identifier_id: page.selectedIdentifierId });
      if (source.requiresSelection === true) throw new ApiError('INVALID_REQUEST', '请先选择本次要查询的包裹运单线索。');
      const total = source.totalMatches;
      const next = source.nextOffset;
      if (!Array.isArray(source.results) || source.results.length > 20 || !Number.isSafeInteger(total) || total < 0 ||
          !(next === null || Number.isSafeInteger(next) && next > page.offset && next <= total)) {
        throw new ApiError('SERVICE_UNAVAILABLE', '暂时无法加载候选，请稍后再试。', 503, true);
      }
      const data: CandidatePage = { results: await matchResults(db, source.results), nextOffset: next, totalMatches: total,
        imageVersion: page.imageVersion, selectedIdentifierId: page.selectedIdentifierId };
      return json(data, 200, headers);
    }
    if (parts[2] === 'submit' && method === 'POST') {
      const input = await body(request); onlyKeys(input, ['imageVersion', 'imageIds', 'contact', 'selectedIdentifierId']);
      if (version(input.imageVersion) !== scan.input_version) throw new ApiError('VERSION_CONFLICT', '照片版本已更新，请刷新。', 409);
      if (input.selectedIdentifierId != null) {
        const selected = selectedIdentifier(scan, input.selectedIdentifierId);
        await rpc(db, 'match_scan', { scan_id: scan.id, version: scan.input_version, selected_evidence_id: selected });
        return json(await scanProgress(db, scan.id), 200, headers);
      }
      const images = await checkImages(db, scan, input.imageIds);
      const ownContact = scan.intent === 'received' ? contact(input.contact) : null;
      if (scan.intent === 'search' && input.contact) throw new ApiError('INVALID_REQUEST', '查询阶段不收取联系方式。');
      await rpc(db, 'finalize_scan', { scan_id: scan.id, version: scan.input_version, images,
        contact: ownContact, group_declared: ownContact?.groupDeclaration ?? false, idempotency_key: idem(request), body_hash: await sha256(canonicalJson(input)) });
      backgroundWake();
      return json(await scanProgress(db, scan.id), 202, headers);
    }
    if (parts[2] === 'select' && method === 'POST') {
      const input = await body(request); onlyKeys(input, ['imageVersion', 'selectedIdentifierId']);
      if (version(input.imageVersion) !== scan.input_version) throw new ApiError('VERSION_CONFLICT', '照片版本已更新。', 409);
      const selected = selectedIdentifier(scan, input.selectedIdentifierId);
      await rpc(db, 'match_scan', { scan_id: scan.id, version: scan.input_version, selected_evidence_id: selected, selected_identifier_id: selected });
      return json(await scanProgress(db, scan.id), 200, headers);
    }
    if (parts[2] === 'revisions' && method === 'POST') {
      const input = await body(request); onlyKeys(input, ['expectedVersion', 'imageRoles']);
      const roles = imageRoles(input.imageRoles, scan.intent);
      const result = await rpc(db, 'revise_scan', { scan_id: scan.id, version: version(input.expectedVersion) });
      return json(await reserve(db, scan.id, result.version ?? result.input_version ?? scan.input_version + 1, roles), 201, headers);
    }
    if (parts[2] === 'retry' && method === 'POST') {
      const input = await body(request); onlyKeys(input, ['imageVersion']);
      await rpc(db, 'retry_scan', { scan_id: scan.id, version: version(input.imageVersion) });
      backgroundWake();
      return json(await scanProgress(db, scan.id), 202, headers);
    }
  }
  if (path === '/trackers' && method === 'POST') {
    const input = await body(request); onlyKeys(input, ['scanId', 'imageVersion', 'selectedIdentifierId', 'contact']);
    const scan = await scanAccess(db, request, uuid(input.scanId));
    if (scan.intent !== 'search') throw new ApiError('INVALID_REQUEST', '仅查询记录可申请追踪。');
    const community = await settings(db);
    if (!community.submissionsEnabled || !community.ready || !getRuntime('ADMIN_USER_IDS')) throw new ApiError('SERVICE_UNAVAILABLE', '社区联系服务尚未配置完成，暂时不能正式登记。', 503, true);
    const ownContact = contact(input.contact);
    if (version(input.imageVersion) !== scan.input_version) throw new ApiError('VERSION_CONFLICT', '照片版本已更新。', 409);
    if (input.selectedIdentifierId != null) {
      const selected = selectedIdentifier(scan, input.selectedIdentifierId);
      await rpc(db, 'match_scan', { scan_id: scan.id, version: scan.input_version, selected_evidence_id: selected });
    }
    const currentProgress = await scanProgress(db, scan.id);
    if (currentProgress.requiresSelection) throw new ApiError('INVALID_REQUEST', '请先选择本次要追踪的包裹运单线索。');
    const result = await rpc(db, 'activate_tracking', { scan_id: scan.id, version: version(input.imageVersion), selected_identifier_id: input.selectedIdentifierId ?? null,
      contact: ownContact, group_declared: true, idempotency_key: idem(request), body_hash: await sha256(canonicalJson(input)) });
    const code = result.publicCode ?? result.public_code ?? result.code;
    return json({ record: await publicFor(db, code) }, 201, headers);
  }
  if (parts[0] === 'records' && parts[1] && method === 'GET') {
    const publicRecord = await publicFor(db, parts[1]);
    if (parts.length === 2) return json(publicRecord, 200, headers);
    if (parts[2] === 'image') {
      const { data } = await db.from('records').select('approved_image_path,image_approved,visibility').eq('public_code', parts[1]).maybeSingle();
      if (!data?.approved_image_path || data.image_approved !== true || data.visibility !== 'active') throw new ApiError('NOT_FOUND', '没有可公开的照片。', 404);
      const { data: image, error } = await db.storage.from('parcel-public').download(data.approved_image_path);
      if (error || !image) throw new ApiError('NOT_FOUND', '照片不存在。', 404);
      return new Response(image, { headers: { ...headers, 'Content-Type': image.type, 'Cache-Control': 'no-store' } });
    }
  }
  if (parts[0] === 'manage' && parts[1]) {
    const access = await recordAccess(db, request, parts[1]);
    if (parts.length === 2 && method === 'GET') return json(await privateDto(db, parts[1]), 200, headers);
    if (parts.length === 2 && method === 'PATCH') {
      const input = await body(request); onlyKeys(input, ['revision', 'contact']);
      await rpc(db, 'update_contact', { scan_id: access.scan.id, revision: version(input.revision), contact: contact(input.contact) });
      return json(await privateDto(db, parts[1]), 200, headers);
    }
    if (parts[2] === 'withdraw' && method === 'POST') {
      const input = await body(request); onlyKeys(input, ['revision']);
      if (version(input.revision) !== access.record.revision) throw new ApiError('VERSION_CONFLICT', '记录已更新，请刷新。', 409);
      await rpc(db, 'cancel_scan', { scan_id: access.scan.id, version: access.scan.input_version, revision: input.revision });
      return json({ withdrawn: true }, 200, headers);
    }
  }
  if (parts[0] === 'admin') return adminRoute(request, db, parts.slice(1), headers);
  throw new ApiError('NOT_FOUND', '接口不存在。', 404);
}

async function adminRoute(request: Request, db: SupabaseClient, parts: string[], headers: Record<string, string>): Promise<Response> {
  const actor = await admin(db, request);
  const method = request.method;
  if (parts[0] === 'community' && method === 'GET') return json(await settings(db), 200, headers);
  if (parts[0] === 'scans' && parts[1]) {
    const scanId = uuid(parts[1]);
    if (parts.length === 2 && method === 'GET') {
      const scan = await scanProgress(db, scanId);
      const { data: imageRows } = await db.from('images').select('id,role,path').eq('scan_id', scanId).eq('version', scan.imageVersion);
      const images = await Promise.all((imageRows ?? []).map(async (image) => {
        const { data } = await db.storage.from(BUCKET).createSignedUrl(image.path, 120);
        return { id: image.id, role: image.role, url: data?.signedUrl ?? '' };
      }));
      const { data: record } = await db.from('records').select('public_code,contact').eq('scan_id', scanId).maybeSingle();
      return json({ scan, images, contact: record?.contact ?? null, recordCode: record?.public_code ?? null }, 200, headers);
    }
    if (parts[2] === 'retry' && method === 'POST') {
      const input = await body(request); onlyKeys(input, ['imageVersion']);
      await rpc(db, 'retry_scan', { scan_id: scanId, version: version(input.imageVersion) });
      backgroundWake();
      return json(await scanProgress(db, scanId), 202, headers);
    }
  }
  if (parts[0] === 'tasks' && parts.length === 1 && method === 'POST') {
    const input = await body(request); onlyKeys(input, ['receivedCode', 'trackingCode', 'notes']);
    const receivedCode = stringValue(input.receivedCode, '误收记录编号', 64);
    const trackingCode = input.trackingCode ? stringValue(input.trackingCode, '追踪记录编号', 64) : null;
    const { data: received } = await db.from('records').select('id,kind,visibility,resolution').eq('public_code', receivedCode).maybeSingle();
    if (!received || received.kind !== 'received' || received.visibility !== 'active' || received.resolution === 'resolved') throw new ApiError('INVALID_REQUEST', '请选择尚未交还的有效误收包裹。');
    if (input.notes != null && (typeof input.notes !== 'string' || input.notes.length > 2000)) throw new ApiError('INVALID_REQUEST', '备注过长。');
    const result = await rpc(db, 'admin_update', { action: 'create_followup', actor_id: actor, public_code: receivedCode,
      payload: { receivedCode, trackingCode, notes: input.notes ?? '' } });
    return json(result, 201, headers);
  }
  if (parts[0] === 'community' && method === 'PATCH') {
    const input = await body(request); onlyKeys(input, ['groupQrUrl', 'assistantWechat', 'assistantQrUrl', 'officialAccountName', 'officialAccountQrUrl', 'submissionsEnabled']);
    for (const [key, value] of Object.entries(input)) {
      if (key.endsWith('Url') && value !== null && (typeof value !== 'string' || !value.startsWith('https://'))) throw new ApiError('INVALID_REQUEST', '二维码图片必须使用 HTTPS 地址。');
      if (key === 'submissionsEnabled' && typeof value !== 'boolean') throw new ApiError('INVALID_REQUEST', '提交开关必须是布尔值。');
      if (key === 'assistantWechat' && value !== null) stringValue(value, '小助手微信', 64);
      if (key === 'officialAccountName' && value !== null) stringValue(value, '公众号名称', 80);
    }
    await rpc(db, 'admin_update', { action: 'settings', actor_id: actor, payload: input });
    return json(await settings(db), 200, headers);
  }
  if (parts[0] === 'records' && parts[1] && method === 'GET') {
    const privateRecord = await privateDto(db, parts[1]);
    const { data } = await db.from('records').select('id,created_at,duplicate_of').eq('public_code', parts[1]).single();
    return json({ ...privateRecord, id: data?.id, createdAt: data?.created_at, duplicateOf: data?.duplicate_of }, 200, headers);
  }
  if (parts[0] === 'records' && parts[1] && method === 'POST') {
    const input = await body(request); const action = parts[2];
    if (!['retry', 'rotate', 'duplicate', 'withdraw', 'imageapproval'].includes(action)) throw new ApiError('NOT_FOUND', '操作不存在。', 404);
    onlyKeys(input, action === 'duplicate' ? ['duplicateOf', 'revision'] : action === 'imageapproval' ? ['imageId', 'revision', 'confirmedSafe'] : ['revision']);
    version(input.revision);
    if (action === 'duplicate') {
      const duplicateId = uuid(input.duplicateOf);
      const { data: current } = await db.from('records').select('id,kind').eq('public_code', parts[1]).maybeSingle();
      const { data: original } = await db.from('records').select('id,kind,visibility').eq('id', duplicateId).maybeSingle();
      if (!current || !original || original.id === current.id || current.kind !== original.kind || original.visibility !== 'active') throw new ApiError('INVALID_REQUEST', '请选择另一条同类型的有效原始登记。');
    }
    let newCapability: string | null = null;
    let uncommittedImagePath: string | null = null;
    if (action === 'rotate') {
      newCapability = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      input.capability_hash = await sha256(newCapability);
    }
    if (action === 'imageapproval') {
      if (input.confirmedSafe !== true) throw new ApiError('INVALID_IMAGE', '请先确认图片不含面单、地址或私人联系方式。');
      const { data: record } = await db.from('records').select('scan_id,image_version,revision,visibility').eq('public_code', parts[1]).maybeSingle();
      if (!record || record.visibility !== 'active') throw new ApiError('INVALID_REQUEST', '记录不是有效状态。');
      if (version(input.revision) !== record.revision) throw new ApiError('VERSION_CONFLICT', '记录已更新。', 409);
      const { data: image } = await db.from('images').select('*').eq('id', uuid(input.imageId)).eq('scan_id', record.scan_id).eq('version', record.image_version).in('role', ['item', 'product']).maybeSingle();
      if (!image) throw new ApiError('INVALID_IMAGE', '只能审核本记录的物品照片。');
      const { data: file, error } = await db.storage.from(BUCKET).download(image.path);
      if (error || !file || file.size > MAX_BYTES) throw new ApiError('INVALID_IMAGE', '图片无法验证。');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = await dimensions(bytes);
      const publicPath = `${parts[1]}/${crypto.randomUUID()}.${parsed.mime.split('/')[1]}`;
      const { error: copyError } = await db.storage.from('parcel-public').upload(publicPath, withoutMetadata(bytes, parsed.mime), { contentType: parsed.mime, upsert: false });
      if (copyError) throw new ApiError('SERVICE_UNAVAILABLE', '无法保存审核图片。', 503, true);
      input.approved_image_path = publicPath;
      input.path = publicPath;
      uncommittedImagePath = publicPath;
    }
    let result: Row;
    try { result = await rpc(db, 'admin_update', { action, actor_id: actor, public_code: parts[1], payload: input }); }
    catch (error) {
      // A connection failure can hide a committed transaction. Remove a copy
      // only after a definite transactional rejection, never on unknown outcome.
      if (uncommittedImagePath && error instanceof ApiError && !error.retryable) await db.storage.from('parcel-public').remove([uncommittedImagePath]);
      throw error;
    }
    if (action === 'retry') backgroundWake();
    return json(newCapability ? { rotated: true, privateLink: `${(getRuntime('APP_PUBLIC_URL') ?? '').replace(/\/$/, '')}/m/${encodeURIComponent(parts[1])}#key=${newCapability}` } : result, 200, headers);
  }
  if (parts[0] === 'tasks' && parts[1] && method === 'PATCH') {
    const input = await body(request); onlyKeys(input, ['action', 'notes']);
    if (!['contact_received', 'contact_tracking', 'mark_claimed', 'confirm_handover', 'reject', 'verify'].includes(String(input.action))) throw new ApiError('INVALID_REQUEST', '操作无效。');
    if (input.notes != null && (typeof input.notes !== 'string' || input.notes.length > 2000)) throw new ApiError('INVALID_REQUEST', '备注过长。');
    const result = await rpc(db, 'admin_update', { action: input.action, followup_id: uuid(parts[1]), actor_id: actor, payload: { notes: input.notes ?? '' } });
    return json(result, 200, headers);
  }
  if (method === 'GET') {
    const query = new URL(request.url).searchParams;
    const offset = Math.max(0, Number(query.get('offset') ?? 0));
    if (!Number.isSafeInteger(offset) || offset > 100000) throw new ApiError('INVALID_REQUEST', '分页参数有误。');
    if (parts[0] === 'records' || parts[0] === 'duplicates') {
      let selection = db.from('records').select('id,public_code,created_at,duplicate_of').order('created_at', { ascending: false }).range(offset, offset + 49);
      if (parts[0] === 'duplicates') selection = selection.not('duplicate_of', 'is', null);
      const { data, error } = await selection;
      if (error) throw new ApiError('SERVICE_UNAVAILABLE', '暂时无法加载登记。', 503, true);
      return json(await Promise.all((data ?? []).map(async (row) => ({ ...(await privateDto(db, row.public_code)), id: row.id, createdAt: row.created_at, duplicateOf: row.duplicate_of }))), 200, headers);
    }
    if (parts[0] === 'tasks') {
      const { data, error } = await db.from('followups').select('*').order('updated_at', { ascending: false }).range(offset, offset + 49);
      if (error) throw new ApiError('SERVICE_UNAVAILABLE', '暂时无法加载跟进任务。', 503, true);
      const tasks = await Promise.all((data ?? []).map(async (row) => {
        const { data: received } = await db.from('records').select('public_code').eq('id', row.received_record_id).maybeSingle();
        const { data: tracking } = row.tracking_record_id ? await db.from('records').select('public_code').eq('id', row.tracking_record_id).maybeSingle() : { data: null };
        return { id: row.id, matchId: row.match_id, receivedCode: received?.public_code ?? '', trackingCode: tracking?.public_code ?? null, state: row.state, kind: row.kind ?? null, reasons: row.reasons ?? [],
          receivedContactedAt: row.received_contacted_at ?? null, trackingContactedAt: row.tracking_contacted_at ?? null, notes: row.notes ?? '', updatedAt: row.updated_at };
      }));
      return json(tasks, 200, headers);
    }
    if (parts[0] === 'recognition') {
      const { data, error } = await db.from('scans').select('id,intent,input_version,state,quality,error_code,updated_at').in('state', ['failed', 'needs_photo', 'deferred', 'queued', 'running']).order('updated_at', { ascending: false }).range(offset, offset + 49);
      if (error) throw new ApiError('SERVICE_UNAVAILABLE', '暂时无法加载异常任务。', 503, true);
      const rows = await Promise.all((data ?? []).map(async (scan) => {
        const { data: record } = await db.from('records').select('public_code,contact').eq('scan_id', scan.id).maybeSingle();
        return { ...scan, recordCode: record?.public_code ?? null, contact: record?.contact ?? null };
      }));
      return json(rows, 200, headers);
    }
    if (parts[0] === 'audit') {
      const { data, error } = await db.from('audit_events').select('id,action,actor_id,record_id,created_at').order('created_at', { ascending: false }).range(offset, offset + 49);
      if (error) throw new ApiError('SERVICE_UNAVAILABLE', '暂时无法加载操作历史。', 503, true);
      return json(data ?? [], 200, headers);
    }
  }
  throw new ApiError('NOT_FOUND', '管理员接口不存在。', 404);
}

Deno.serve(async (request: Request) => {
  const requestId = crypto.randomUUID();
  let headers: Record<string, string> = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  try {
    const db = database();
    await ensureRuntimeConfig(async () => {
      const { data, error } = await db.rpc('runtime_config', { p_payload: {} });
      if (error || !data) throw new ApiError('SERVICE_UNAVAILABLE', '服务配置暂时不可用，请稍后再试。', 503, true);
      return data as Record<string, unknown>;
    });
    headers = { ...corsHeaders(request), 'X-Request-ID': requestId };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    return await route(request, db, headers);
  } catch (error) {
    console.error(JSON.stringify({ requestId, code: error instanceof ApiError ? error.code : 'INTERNAL_ERROR' }));
    return failure(error, requestId, headers);
  }
});
