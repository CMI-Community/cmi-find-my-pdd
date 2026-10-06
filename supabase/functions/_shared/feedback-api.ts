import { ApiError, body, json, onlyKeys, uuid } from './http.ts';
import { canonicalJson, sha256 } from './security.ts';
import { pddContact, type PddRouteContext } from './waybill-api.ts';
import { validateFeedbackMessage, type PddFeedback, type PddFeedbackStatus } from '../../../shared/feedback.ts';

type Row = Record<string, any>;
function status(value: unknown): PddFeedbackStatus {
  if (value !== 'new' && value !== 'reviewed' && value !== 'closed') throw new ApiError('INVALID_REQUEST', '反馈状态不正确。');
  return value;
}
function unavailable(): never { throw new ApiError('SERVICE_UNAVAILABLE', '反馈服务暂时不可用，请稍后重试。', 503, true); }
function timestamp(value: unknown): string { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) unavailable(); return value; }
function feedbackRow(raw: Row): PddFeedback {
  if (!raw || typeof raw.message !== 'string') unavailable();
  return { id: uuid(raw.id), message: raw.message, contact: raw.contact ? pddContact(raw.contact) : null, status: status(raw.status), createdAt: timestamp(raw.createdAt), updatedAt: timestamp(raw.updatedAt) };
}
export async function feedbackRoute(request: Request, parts: string[], headers: Record<string, string>, context: Pick<PddRouteContext, 'rpc' | 'admin'>): Promise<Response | null> {
  if (parts[0] === 'feedback' && parts.length === 1 && request.method === 'POST') {
    const input = await body(request); onlyKeys(input, ['message', 'contact']);
    let message: string;
    try { message = validateFeedbackMessage(input.message); } catch (error) { throw new ApiError('INVALID_REQUEST', (error as Error).message, 422); }
    const contact = input.contact == null ? null : pddContact(input.contact);
    const result = await context.rpc('pdd_feedback_submit', { request_id: uuid(request.headers.get('idempotency-key')), body_hash: await sha256(canonicalJson(input)), message, contact });
    if (result.submitted !== true) unavailable();
    return json({ submitted: true, feedbackId: uuid(result.feedbackId), submittedAt: timestamp(result.submittedAt) }, 201, headers);
  }
  if (parts[0] === 'admin' && parts[1] === 'feedback') {
    const actor = await context.admin();
    if (parts.length === 2 && request.method === 'GET') {
      const params = new URL(request.url).searchParams;
      for (const key of params.keys()) if (!['offset', 'status'].includes(key) || params.getAll(key).length !== 1) throw new ApiError('INVALID_REQUEST', '分页参数有误。');
      const rawOffset = params.get('offset') ?? '0';
      const offset = Number(rawOffset);
      if (!/^\d+$/.test(rawOffset) || !Number.isSafeInteger(offset) || offset > 100000) throw new ApiError('INVALID_REQUEST', '分页参数有误。');
      const result = await context.rpc('pdd_admin_feedback_list', { offset, limit: 50, ...(params.has('status') ? { status: status(params.get('status')) } : {}) });
      if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0 || (result.nextOffset !== null && (!Number.isSafeInteger(result.nextOffset) || result.nextOffset < 0))) unavailable();
      return json({ items: result.items.map(feedbackRow), total: result.total, nextOffset: result.nextOffset }, 200, headers);
    }
    if (parts.length === 3 && request.method === 'PATCH') {
      const input = await body(request); onlyKeys(input, ['status']);
      return json(feedbackRow(await context.rpc('pdd_admin_feedback_update', { feedback_id: uuid(parts[2]), status: status(input.status), actor_id: actor })), 200, headers);
    }
  }
  if (parts[0] === 'feedback' || parts[0] === 'admin' && parts[1] === 'feedback') throw new ApiError('NOT_FOUND', '接口不存在。', 404);
  return null;
}
