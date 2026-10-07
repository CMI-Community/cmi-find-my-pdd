import { optionalRecipientName } from '../../../shared/recipient.ts';
import { ApiError, body, json, onlyKeys, stringValue, uuid, version } from './http.ts';
import { capability, canonicalJson, sha256 } from './security.ts';
import { DOMESTIC_WAYBILL_MESSAGE, normalizeWaybill, validatePddContact, validatePddNote, validateWaybill, validateWaybillQuery, type PddMode, type PddSource, type PddContact, type PddHomeStats, type PddPossibleCandidate, type PddPublicRecord, type PddQueryResult, type PddRegistration, type PddBatchResultItem } from '../../../shared/waybill.ts';

type Row = Record<string, any>;
export interface PddRouteContext {
  rpc: (name: string, payload: Row) => Promise<Row>;
  admin: () => Promise<string>;
  canRegister: () => Promise<boolean>;
}

export function pddNumber(value: unknown): string {
  try { return validateWaybill(value); }
  catch (error) {
    if (error instanceof Error && error.message === 'NON_DOMESTIC_WAYBILL') throw new ApiError('NON_DOMESTIC_WAYBILL', DOMESTIC_WAYBILL_MESSAGE, 422);
    throw new ApiError('INVALID_WAYBILL', '请输入完整国内快递单号，仅包含字母和数字。', 422);
  }
}
export function pddQueryNumber(value: unknown): string {
  try { return validateWaybillQuery(value); }
  catch (error) {
    if (error instanceof Error && error.message === 'NON_DOMESTIC_WAYBILL') throw new ApiError('NON_DOMESTIC_WAYBILL', DOMESTIC_WAYBILL_MESSAGE, 422);
    throw new ApiError('INVALID_WAYBILL', '请输入6至40位单号，至少包含6位已知字母或数字；每个未知字符可用 ? 或 * 表示。', 422);
  }
}
/** Historical receipts must remain readable and withdrawable after input rules tighten. */
function pddStoredNumber(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100 || !/^[A-Z0-9]{6,40}$/.test(normalizeWaybill(value))) unavailable();
  return normalizeWaybill(value);
}
export function pddContact(value: unknown): PddContact {
  try { return validatePddContact(value); }
  catch { throw new ApiError('INVALID_CONTACT', '请填写有效的微信号或电话号码。', 422); }
}
export function pddNote(value: unknown): string | null {
  try { return validatePddNote(value); }
  catch { throw new ApiError('INVALID_NOTE', '备注最多五百字，请勿使用特殊控制字符。', 422); }
}
export function pddOptionalRecipientName(value: unknown): string | null {
  try { return optionalRecipientName(value); } catch { throw new ApiError('INVALID_RECIPIENT_NAME', '收件人名须为1至80字，请勿使用控制字符。', 422); }
}
function mode(value: unknown): PddMode {
  if (value !== 'lost' && value !== 'received') throw new ApiError('INVALID_REQUEST', '请选择丢件或错收件。');
  return value;
}
function source(value: unknown): PddSource {
  if (value !== 'manual' && value !== 'barcode') throw new ApiError('INVALID_REQUEST', '单号来源不正确。');
  return value;
}
function key(request: Request): string { return stringValue(request.headers.get('idempotency-key'), '幂等请求编号', 128); }
function unavailable(): never { throw new ApiError('SERVICE_UNAVAILABLE', '暂时无法读取登记结果，请稍后重试。', 503, true); }

export function pddHomeStats(raw: Row): PddHomeStats {
  const keys = ['lostRegistered', 'receivedRegistered', 'matchedParcels', 'lostRecipientRegistered', 'receivedRecipientRegistered', 'matchedRecipientLeads'] as const;
  if (!raw || keys.some(key => !Number.isSafeInteger(raw[key]) || raw[key] < 0)) unavailable();
  return { lostRegistered: raw.lostRegistered, receivedRegistered: raw.receivedRegistered, matchedParcels: raw.matchedParcels,
    lostRecipientRegistered: raw.lostRecipientRegistered, receivedRecipientRegistered: raw.receivedRecipientRegistered, matchedRecipientLeads: raw.matchedRecipientLeads };
}

/** Always project from named fields; never forward a DB row or capability hash. */
export function pddPublic(raw: Row): PddPublicRecord {
  if (!raw || typeof raw.code !== 'string' || !['open', 'verifying', 'claimed', 'resolved'].includes(raw.resolution) || !['pending', 'active', 'withdrawn'].includes(raw.visibility) || !Number.isSafeInteger(raw.revision)) unavailable();
  return { code: raw.code, tail: String(raw.tail ?? '').slice(-4), resolution: raw.resolution, visibility: raw.visibility, revision: raw.revision,
    lostRegistered: raw.lostRegistered === true, receivedRegistered: raw.receivedRegistered === true,
    createdAt: String(raw.createdAt), updatedAt: String(raw.updatedAt) };
}
export function pddQuery(raw: Row): PddQueryResult {
  if (!raw || !['matched', 'possible', 'duplicate', 'not_found', 'closed'].includes(raw.result) || typeof raw.queryId !== 'string') unavailable();
  const possible = raw.result === 'possible';
  if (possible && (!Array.isArray(raw.candidates) || raw.candidates.length < 1 || raw.candidates.length > 5)) unavailable();
  return { queryId: raw.queryId, result: raw.result, queriedAt: String(raw.queriedAt), record: !possible && raw.record ? pddPublic(raw.record) : null,
    registeredAt: !possible && raw.registeredAt ? String(raw.registeredAt) : null,
    contact: raw.result === 'matched' && raw.contact ? pddContact(raw.contact) : null,
    note: raw.result === 'matched' ? pddNote(raw.note) : null,
    candidates: possible ? raw.candidates.map(pddPossibleCandidate) : [] };
}
function pddPossibleCandidate(raw: Row): PddPossibleCandidate {
  if (!raw || typeof raw.code !== 'string' || !/^PDD-[A-Z0-9]{1,64}$/.test(raw.code) || typeof raw.tail !== 'string' || !/^[A-Z0-9]{4}$/.test(raw.tail) ||
      typeof raw.similarity !== 'number' || !Number.isFinite(raw.similarity) || raw.similarity <= 70 || raw.similarity >= 100 ||
      typeof raw.registeredAt !== 'string' || !Number.isFinite(Date.parse(raw.registeredAt))) unavailable();
  return { code: raw.code, tail: raw.tail, similarity: raw.similarity, registeredAt: raw.registeredAt };
}
export function pddRegistration(raw: Row): PddRegistration {
  if (!raw || typeof raw.registrationCode !== 'string' || !Number.isSafeInteger(raw.revision) || !['active', 'withdrawn'].includes(raw.visibility)) unavailable();
  return { registrationCode: raw.registrationCode, number: pddStoredNumber(raw.number), mode: mode(raw.mode), source: source(raw.source),
    contact: raw.contact ? pddContact(raw.contact) : null, note: pddNote(raw.note), revision: raw.revision, visibility: raw.visibility,
    createdAt: String(raw.createdAt), updatedAt: String(raw.updatedAt), record: pddPublic(raw.record), recipientName: pddOptionalRecipientName(raw.recipientName) };
}
export function pddBatchItem(raw: Row): PddBatchResultItem {
  if (!raw || !['registered', 'matched', 'duplicate', 'closed'].includes(raw.result)) unavailable();
  return { requestId: uuid(raw.requestId), number: pddStoredNumber(raw.number), result: raw.result, record: pddPublic(raw.record),
    registration: raw.registration ? pddRegistration(raw.registration) : null,
    contact: raw.result === 'matched' && raw.contact ? pddContact(raw.contact) : null,
    note: raw.result === 'matched' ? pddNote(raw.note) : null,
    registeredAt: raw.registeredAt ? String(raw.registeredAt) : null, recipientNameSaved: raw.recipientNameSaved === true };
}

export async function pddRoute(request: Request, parts: string[], headers: Record<string, string>, context: PddRouteContext): Promise<Response | null> {
  const method = request.method;
  const call = context.rpc;
  const capHash = () => sha256(capability(request));
  const registrationReady = async () => { if (!(await context.canRegister())) throw new ApiError('SERVICE_UNAVAILABLE', '登记服务暂未开放，待提交单号会保留在本机。', 503, true); };
  if (parts[0] === 'waybill-stats' && parts.length === 1 && method === 'GET') return json(pddHomeStats(await call('pdd_home_stats', {})), 200, headers);
  if (parts[0] === 'waybill-queries') {
    if (parts.length === 1 && method === 'POST') {
      const input = await body(request); onlyKeys(input, ['queryId', 'number', 'mode', 'source', 'allowPossible']);
      if (Object.prototype.hasOwnProperty.call(input, 'allowPossible') && typeof input.allowPossible !== 'boolean') throw new ApiError('INVALID_REQUEST', '相似单号查询选项格式不正确。');
      const result = await call('pdd_query', { query_id: uuid(input.queryId), number: input.allowPossible === true ? pddQueryNumber(input.number) : pddNumber(input.number),
        mode: mode(input.mode), source: source(input.source), allow_possible: input.allowPossible === true, capability_hash: await capHash(), body_hash: await sha256(canonicalJson(input)) });
      return json(pddQuery(result), 200, headers);
    }
    if (parts.length === 3 && parts[2] === 'contact' && method === 'POST') {
      await registrationReady();
      const input = await body(request); onlyKeys(input, ['contact']);
      const result = await call('pdd_query_contact', { query_id: uuid(parts[1]), capability_hash: await capHash(), contact: pddContact(input.contact), idempotency_key: key(request), body_hash: await sha256(canonicalJson(input)) });
      return json({ saved: result.saved === true, registration: result.registration ? pddRegistration(result.registration) : null }, 200, headers);
    }
  }
  if (parts[0] === 'waybill-batches' && parts.length === 1 && method === 'POST') {
    await registrationReady();
    const input = await body(request); onlyKeys(input, ['mode', 'contact', 'note', 'items']);
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 50) throw new ApiError('INVALID_REQUEST', '每次请提交一至五十个单号。');
    const items = input.items.map((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ApiError('INVALID_REQUEST', '待提交单号格式不正确。');
      const row = item as Row; onlyKeys(row, ['requestId', 'number', 'source', 'recipientName']);
      return { request_id: uuid(row.requestId), number: pddNumber(row.number), source: source(row.source), ...(Object.prototype.hasOwnProperty.call(row, 'recipientName') ? { recipient_name: pddOptionalRecipientName(row.recipientName) } : {}) };
    });
    const result = await call('pdd_batch_register', { request_id: key(request), mode: mode(input.mode), contact: pddContact(input.contact),
      ...(Object.prototype.hasOwnProperty.call(input, 'note') ? { note: pddNote(input.note) } : {}),
      items, capability_hash: await capHash(), body_hash: await sha256(canonicalJson(input)) });
    if (!Array.isArray(result.items)) unavailable();
    return json({ submittedAt: String(result.submittedAt), items: result.items.map(pddBatchItem) }, 200, headers);
  }
  if (parts[0] === 'waybill-manage' && parts[1]) {
    const payload = { registration_code: stringValue(parts[1], '登记编号', 64), capability_hash: await capHash() };
    if (parts.length === 2 && method === 'GET') return json(pddRegistration(await call('pdd_manage', payload)), 200, headers);
    if (parts.length === 2 && method === 'PATCH') {
      const input = await body(request); onlyKeys(input, ['revision', 'contact', 'recipientName']);
      if (!('contact' in input) && !('recipientName' in input)) throw new ApiError('INVALID_REQUEST', '请提交需要更新的资料。');
      return json(pddRegistration(await call('pdd_manage_update', { ...payload, revision: version(input.revision), action: 'contact',
        ...('contact' in input ? { contact: pddContact(input.contact) } : {}), ...('recipientName' in input ? { recipient_name: pddOptionalRecipientName(input.recipientName) } : {}) })), 200, headers);
    }
    if (parts.length === 3 && parts[2] === 'withdraw' && method === 'POST') {
      const input = await body(request); onlyKeys(input, ['revision']);
      return json(pddRegistration(await call('pdd_manage_update', { ...payload, revision: version(input.revision), action: 'withdraw' })), 200, headers);
    }
  }
  if (parts[0] === 'waybills' && parts.length === 2 && method === 'GET') return json(pddPublic(await call('pdd_public', { public_code: stringValue(parts[1], '记录编号', 64) })), 200, headers);
  if (parts[0] === 'admin' && ['waybills', 'waybill-queries'].includes(parts[1])) {
    const actor = await context.admin();
    const query = new URL(request.url).searchParams;
    const offset = Number(query.get('offset') ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new ApiError('INVALID_REQUEST', '分页参数有误。');
    if (parts[1] === 'waybill-queries' && parts.length === 2 && method === 'GET') return json(await call('pdd_admin_queries', { offset, limit: 50 }), 200, headers);
    if (parts[1] === 'waybills' && parts.length === 2 && method === 'GET') return json(await call('pdd_admin_list', { offset, limit: 50 }), 200, headers);
    if (parts[1] === 'waybills' && parts.length === 3 && method === 'GET') return json(await call('pdd_admin_detail', { public_code: stringValue(parts[2], '记录编号', 64) }), 200, headers);
    if (parts[1] === 'waybills' && parts.length === 4 && parts[3] === 'actions' && method === 'POST') {
      const input = await body(request); onlyKeys(input, ['revision', 'action', 'registrationCode', 'notes']);
      if (!['verify', 'claim', 'return', 'withdraw'].includes(String(input.action))) throw new ApiError('INVALID_REQUEST', '处理操作不正确。');
      if (input.notes != null && (typeof input.notes !== 'string' || input.notes.length > 2000)) throw new ApiError('INVALID_REQUEST', '备注最多两千字。');
      const result = await call('pdd_admin_action', { public_code: stringValue(parts[2], '记录编号', 64), actor_id: actor, revision: version(input.revision), action: input.action,
        ...(input.registrationCode ? { registration_code: stringValue(input.registrationCode, '登记编号', 64) } : {}), notes: input.notes ?? '' });
      return json(result, 200, headers);
    }
  }
  if (['waybill-stats', 'waybill-queries', 'waybill-batches', 'waybill-manage', 'waybills'].includes(parts[0])) throw new ApiError('NOT_FOUND', '接口不存在。', 404);
  return null;
}
