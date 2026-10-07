import { ApiError, body, json, onlyKeys, stringValue, uuid, version } from './http.ts';
import { capability, canonicalJson, sha256 } from './security.ts';
import { pddContact, pddNote, type PddRouteContext } from './waybill-api.ts';
import { validateRecipientName, type PddRecipientRegistration, type PddRecipientQueryResult, type PddRecipientBatchResultItem, type PddRecipientLead } from '../../../shared/recipient.ts';
import type { PddMode } from '../../../shared/waybill.ts';

type Row = Record<string, any>;
export function pddRecipientName(value: unknown): string {
  try { return validateRecipientName(value); }
  catch { throw new ApiError('INVALID_RECIPIENT_NAME', '请输入1至80字的完整收件人名，请勿使用控制字符。', 422); }
}
function mode(value: unknown): PddMode {
  if (value !== 'lost' && value !== 'received') throw new ApiError('INVALID_REQUEST', '请选择丢件或错收件。');
  return value;
}
function unavailable(): never { throw new ApiError('SERVICE_UNAVAILABLE', '姓名线索服务暂时不可用，请稍后重试。', 503, true); }
function time(value: unknown): string { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) unavailable(); return value; }
function recipientLead(raw: Row): PddRecipientLead {
  if (!raw || !raw.contact) unavailable();
  return { recipientName: pddRecipientName(raw.recipientName), registeredAt: time(raw.registeredAt), contact: pddContact(raw.contact), note: pddNote(raw.note) };
}
export function recipientQuery(raw: Row): PddRecipientQueryResult {
  if (!raw || !['leads_found', 'not_found'].includes(raw.result) || !Array.isArray(raw.leads) || raw.leads.length > 20 || (raw.result === 'not_found' && raw.leads.length) || (raw.result === 'leads_found' && !raw.leads.length)) unavailable();
  return { queryId: uuid(raw.queryId), result: raw.result, queriedAt: time(raw.queriedAt), leads: raw.leads.map(recipientLead), nextCursor: raw.nextCursor == null ? null : uuid(raw.nextCursor) };
}
export function recipientRegistration(raw: Row): PddRecipientRegistration {
  if (!raw || typeof raw.registrationCode !== 'string' || !/^PDD-N-[A-Z0-9]{1,64}$/.test(raw.registrationCode) || !['active', 'reviewing', 'closed', 'withdrawn'].includes(raw.state) || !Number.isInteger(raw.revision) || raw.revision < 1) unavailable();
  return { registrationCode: raw.registrationCode, recipientName: raw.recipientName == null ? null : pddRecipientName(raw.recipientName), mode: mode(raw.mode), contact: raw.contact == null ? null : pddContact(raw.contact), note: pddNote(raw.note), state: raw.state, revision: raw.revision, createdAt: time(raw.createdAt), updatedAt: time(raw.updatedAt) };
}
function batchItem(raw: Row): PddRecipientBatchResultItem {
  if (!raw || !['registered', 'duplicate'].includes(raw.result)) unavailable();
  return { requestId: uuid(raw.requestId), recipientName: pddRecipientName(raw.recipientName), result: raw.result, registration: raw.registration ? recipientRegistration(raw.registration) : null };
}
function adminDetail(raw: Row) {
  if (!Array.isArray(raw.events)) unavailable();
  return { registration: recipientRegistration(raw.registration), events: raw.events.map((event: Row) => ({ id: uuid(event.id), action: stringValue(event.action, '操作', 64), actorId: event.actorId == null ? null : uuid(event.actorId), notes: '', createdAt: time(event.createdAt) })) };
}
function nextOffset(value: unknown): number | null { if (value == null) return null; if (!Number.isSafeInteger(value) || Number(value) < 0) unavailable(); return Number(value); }

export async function recipientRoute(request: Request, parts: string[], headers: Record<string, string>, context: PddRouteContext): Promise<Response | null> {
  const method = request.method, call = context.rpc;
  const capHash = () => sha256(capability(request));
  const ready = async () => { if (!(await context.canRegister())) throw new ApiError('SERVICE_UNAVAILABLE', '登记服务暂未开放，待提交收件人会保留在本机。', 503, true); };
  if (parts[0] === 'recipient-queries') {
    if (parts.length === 1 && method === 'POST') {
      const input = await body(request); onlyKeys(input, ['queryId', 'recipientName', 'mode']);
      return json(recipientQuery(await call('pdd_recipient_query', { query_id: uuid(input.queryId), recipient_name: pddRecipientName(input.recipientName), mode: mode(input.mode), capability_hash: await capHash(), body_hash: await sha256(canonicalJson(input)) })), 200, headers);
    }
    if (parts.length === 3 && parts[2] === 'pages' && method === 'POST') {
      const input = await body(request); onlyKeys(input, ['cursor']);
      return json(recipientQuery(await call('pdd_recipient_query_page', { query_id: uuid(parts[1]), cursor: uuid(input.cursor), capability_hash: await capHash() })), 200, headers);
    }
  }
  if (parts[0] === 'recipient-batches' && parts.length === 1 && method === 'POST') {
    await ready();
    const input = await body(request); onlyKeys(input, ['mode', 'contact', 'note', 'items']);
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 50) throw new ApiError('INVALID_REQUEST', '每次请提交一至五十个收件人。');
    const items = input.items.map((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ApiError('INVALID_REQUEST', '待提交收件人格式不正确。');
      const row = item as Row; onlyKeys(row, ['requestId', 'recipientName']);
      return { request_id: uuid(row.requestId), recipient_name: pddRecipientName(row.recipientName) };
    });
    const result = await call('pdd_recipient_batch_register', { request_id: stringValue(request.headers.get('idempotency-key'), '幂等请求编号', 128), mode: mode(input.mode), contact: pddContact(input.contact), ...('note' in input ? { note: pddNote(input.note) } : {}), items, capability_hash: await capHash(), body_hash: await sha256(canonicalJson(input)) });
    if (!Array.isArray(result.items) || result.items.length > 50) unavailable();
    return json({ submittedAt: time(result.submittedAt), items: result.items.map(batchItem) }, 200, headers);
  }
  if (parts[0] === 'recipient-manage' && parts[1]) {
    const payload = { registration_code: stringValue(parts[1], '登记编号', 64), capability_hash: await capHash() };
    if (parts.length === 2 && method === 'GET') return json(recipientRegistration(await call('pdd_recipient_manage', payload)), 200, headers);
    if (parts.length === 2 && method === 'PATCH') {
      const input = await body(request); onlyKeys(input, ['revision', 'recipientName', 'contact']);
      if (!('recipientName' in input) && !('contact' in input)) throw new ApiError('INVALID_REQUEST', '请提交需要更新的资料。');
      return json(recipientRegistration(await call('pdd_recipient_manage_update', { ...payload, revision: version(input.revision), action: 'update', ...('recipientName' in input ? { recipient_name: pddRecipientName(input.recipientName) } : {}), ...('contact' in input ? { contact: pddContact(input.contact) } : {}) })), 200, headers);
    }
    if (parts.length === 3 && parts[2] === 'withdraw' && method === 'POST') {
      const input = await body(request); onlyKeys(input, ['revision']);
      return json(recipientRegistration(await call('pdd_recipient_manage_update', { ...payload, revision: version(input.revision), action: 'withdraw' })), 200, headers);
    }
  }
  if (parts[0] === 'admin' && ['recipients', 'recipient-queries'].includes(parts[1])) {
    const actor = await context.admin();
    const params = new URL(request.url).searchParams, offset = Number(params.get('offset') ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || [...params.keys()].some(key => key !== 'offset')) throw new ApiError('INVALID_REQUEST', '分页参数有误。');
    if (parts.length === 2 && method === 'GET') {
      const result = await call(parts[1] === 'recipients' ? 'pdd_recipient_admin_list' : 'pdd_recipient_admin_queries', { offset, limit: 50 });
      if (!Array.isArray(result.items)) unavailable();
      return json({ items: parts[1] === 'recipients' ? result.items.map(recipientRegistration) : result.items.map((row: Row) => {
        if (!['leads_found', 'not_found'].includes(row.result)) unavailable();
        return { queryId: uuid(row.queryId), recipientName: pddRecipientName(row.recipientName), mode: mode(row.mode), result: row.result, queriedAt: time(row.queriedAt) };
      }), nextOffset: nextOffset(result.nextOffset) }, 200, headers);
    }
    if (parts[1] === 'recipients' && parts.length === 3 && method === 'GET') return json(adminDetail(await call('pdd_recipient_admin_detail', { registration_code: stringValue(parts[2], '登记编号', 64) })), 200, headers);
    if (parts[1] === 'recipients' && parts.length === 4 && parts[3] === 'actions' && method === 'POST') {
      const input = await body(request); onlyKeys(input, ['revision', 'action']);
      if (!['review', 'close', 'withdraw'].includes(String(input.action))) throw new ApiError('INVALID_REQUEST', '处理操作不正确。');
      return json(adminDetail(await call('pdd_recipient_admin_action', { registration_code: stringValue(parts[2], '登记编号', 64), actor_id: actor, revision: version(input.revision), action: input.action })), 200, headers);
    }
  }
  if (['recipient-queries', 'recipient-batches', 'recipient-manage'].includes(parts[0])) throw new ApiError('NOT_FOUND', '接口不存在。', 404);
  return null;
}
