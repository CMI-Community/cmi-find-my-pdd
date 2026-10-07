import { request, ApiFailure } from './api';
import type { Community } from '../shared/contracts';
import type { PddQueryInput, PddQueryResult, PddContact, PddQueryContactResult, PddBatchInput, PddBatchResult, PddRegistration, PddPublicRecord, PddAdminList, PddAdminDetail, PddAdminAction, PddQueryLogPage, PddHomeStats } from '../shared/waybill';
import type { PddFeedbackInput, PddFeedbackResult, PddFeedback, PddFeedbackStatus, PddFeedbackList } from '../shared/feedback';
import type { PddRecipientQueryInput, PddRecipientQueryResult, PddRecipientBatchInput, PddRecipientBatchResult, PddRecipientRegistration, PddRecipientAdminList, PddRecipientAdminDetail, PddRecipientAdminAction, PddRecipientQueryLogPage } from '../shared/recipient';

async function pddRequest<T>(path: string, options: Parameters<typeof request>[1] = {}): Promise<T> {
  try { return await request<T>(path, options); }
  catch (error) {
    if (error instanceof ApiFailure && error.code === 'API_NOT_CONFIGURED') throw new ApiFailure('查询服务尚未配置。待提交线索会保留在当前浏览器，请稍后再试。', error.code, undefined, false);
    throw error;
  }
}
export function safeRecipientQueryResponse(value: PddRecipientQueryResult): PddRecipientQueryResult {
  if (!value || !['leads_found', 'not_found'].includes(value.result) || !Array.isArray(value.leads) || value.leads.length > 20 || !Number.isFinite(Date.parse(value.queriedAt)) || (value.nextCursor !== null && typeof value.nextCursor !== 'string')) throw new ApiFailure('姓名线索返回异常，请重新查询。', 'INVALID_RESPONSE');
  const leads = value.leads.map(item => {
    if (!item || typeof item.recipientName !== 'string' || !Number.isFinite(Date.parse(item.registeredAt)) || !item.contact || !['wechat', 'phone'].includes(item.contact.kind) || typeof item.contact.value !== 'string' || (item.note !== null && typeof item.note !== 'string')) throw new ApiFailure('姓名线索返回异常，请重新查询。', 'INVALID_RESPONSE');
    return { recipientName: item.recipientName, registeredAt: item.registeredAt, contact: { kind: item.contact.kind, value: item.contact.value }, note: item.note };
  });
  return { queryId: value.queryId, result: value.result, queriedAt: value.queriedAt, leads, nextCursor: value.nextCursor };
}
function homeStatsResponse(value: PddHomeStats): PddHomeStats {
  if (!value || [value.lostRegistered, value.receivedRegistered, value.matchedParcels, value.lostRecipientRegistered, value.receivedRecipientRegistered, value.matchedRecipientLeads].some(count => !Number.isSafeInteger(count) || count < 0)) throw new ApiFailure('统计返回异常，请稍后重试。', 'INVALID_RESPONSE');
  return { lostRegistered: value.lostRegistered, receivedRegistered: value.receivedRegistered, matchedParcels: value.matchedParcels,
    lostRecipientRegistered: value.lostRecipientRegistered, receivedRecipientRegistered: value.receivedRecipientRegistered, matchedRecipientLeads: value.matchedRecipientLeads };
}
export function safeQueryResponse(value: PddQueryResult): PddQueryResult {
  if (value.result !== 'possible') return value;
  if (!Array.isArray(value.candidates) || !value.candidates.length || value.candidates.length > 5) throw new ApiFailure('疑似线索返回异常，请重新查询。', 'INVALID_RESPONSE');
  const candidates = value.candidates.map(item => {
    if (!item || typeof item.code !== 'string' || !item.code || typeof item.tail !== 'string' || !/^[A-Z0-9]{4}$/.test(item.tail) || !Number.isFinite(item.similarity) || item.similarity <= 70 || item.similarity >= 100 || typeof item.registeredAt !== 'string' || !Number.isFinite(Date.parse(item.registeredAt))) throw new ApiFailure('疑似线索返回异常，请重新查询。', 'INVALID_RESPONSE');
    return { code: item.code, tail: item.tail, similarity: item.similarity, registeredAt: item.registeredAt };
  });
  // Fuzzy clues never carry direct contacts, notes, full numbers or capabilities.
  return { queryId: value.queryId, result: 'possible', queriedAt: value.queriedAt, candidates, record: null, registeredAt: null, contact: null, note: null };
}
export const pddApi = {
  community: () => pddRequest<Community>('/v1/community'),
  stats: async () => homeStatsResponse(await pddRequest<PddHomeStats>('/v1/waybill-stats')),
  submitFeedback: (input: PddFeedbackInput, idempotencyKey: string) => pddRequest<PddFeedbackResult>('/v1/feedback', { method: 'POST', body: input, key: idempotencyKey }),
  adminFeedbackList: (token: string, offset = 0, status?: PddFeedbackStatus) => pddRequest<PddFeedbackList>('/v1/admin/feedback?offset=' + offset + (status ? '&status=' + encodeURIComponent(status) : ''), { token }),
  adminFeedbackUpdate: (id: string, status: PddFeedbackStatus, token: string) => pddRequest<PddFeedback>('/v1/admin/feedback/' + encodeURIComponent(id), { method: 'PATCH', body: { status }, token }),
  query: async (input: PddQueryInput, capability: string) => safeQueryResponse(await pddRequest<PddQueryResult>('/v1/waybill-queries', { method: 'POST', body: { ...input, allowPossible: true }, cap: capability, key: input.queryId })),
  queryContact: (queryId: string, contact: PddContact, capability: string) => pddRequest<PddQueryContactResult>('/v1/waybill-queries/' + encodeURIComponent(queryId) + '/contact', { method: 'POST', body: { contact }, cap: capability, key: queryId + ':contact' }),
  batch: (input: PddBatchInput, batchId: string, capability: string) => pddRequest<PddBatchResult>('/v1/waybill-batches', { method: 'POST', body: input, cap: capability, key: batchId }),
  recipientQuery: async (input: PddRecipientQueryInput, capability: string) => safeRecipientQueryResponse(await pddRequest<PddRecipientQueryResult>('/v1/recipient-queries', { method: 'POST', body: input, cap: capability, key: input.queryId })),
  recipientQueryPage: async (queryId: string, cursor: string, capability: string) => safeRecipientQueryResponse(await pddRequest<PddRecipientQueryResult>('/v1/recipient-queries/' + encodeURIComponent(queryId) + '/pages', { method: 'POST', body: { cursor }, cap: capability })),
  recipientBatch: (input: PddRecipientBatchInput, batchId: string, capability: string) => pddRequest<PddRecipientBatchResult>('/v1/recipient-batches', { method: 'POST', body: input, cap: capability, key: batchId }),
  recipientManage: (code: string, capability: string) => pddRequest<PddRecipientRegistration>('/v1/recipient-manage/' + encodeURIComponent(code), { cap: capability }),
  recipientUpdate: (code: string, revision: number, recipientName: string, contact: PddContact, capability: string) => pddRequest<PddRecipientRegistration>('/v1/recipient-manage/' + encodeURIComponent(code), { method: 'PATCH', body: { revision, recipientName, contact }, cap: capability }),
  recipientWithdraw: (code: string, revision: number, capability: string) => pddRequest<PddRecipientRegistration>('/v1/recipient-manage/' + encodeURIComponent(code) + '/withdraw', { method: 'POST', body: { revision }, cap: capability }),
  adminRecipients: (token: string, offset: number) => pddRequest<PddRecipientAdminList>('/v1/admin/recipients?offset=' + offset, { token }),
  adminRecipientDetail: (token: string, code: string) => pddRequest<PddRecipientAdminDetail>('/v1/admin/recipients/' + encodeURIComponent(code), { token }),
  adminRecipientAction: (token: string, code: string, revision: number, action: PddRecipientAdminAction) => pddRequest<PddRecipientAdminDetail>('/v1/admin/recipients/' + encodeURIComponent(code) + '/actions', { method: 'POST', token, body: { revision, action } }),
  adminRecipientQueries: (token: string, offset: number) => pddRequest<PddRecipientQueryLogPage>('/v1/admin/recipient-queries?offset=' + offset, { token }),
  publicRecord: (code: string) => pddRequest<PddPublicRecord>('/v1/waybills/' + encodeURIComponent(code)),
  manage: (code: string, capability: string) => pddRequest<PddRegistration>('/v1/waybill-manage/' + encodeURIComponent(code), { cap: capability }),
  updateContact: (code: string, revision: number, contact: PddContact, capability: string) => pddRequest<PddRegistration>('/v1/waybill-manage/' + encodeURIComponent(code), { method: 'PATCH', body: { revision, contact }, cap: capability }),
  updateWaybillRecipient: (code: string, revision: number, recipientName: string | null, contact: PddContact, capability: string) => pddRequest<PddRegistration>('/v1/waybill-manage/' + encodeURIComponent(code), { method: 'PATCH', body: { revision, recipientName, contact }, cap: capability }),
  withdraw: (code: string, revision: number, capability: string) => pddRequest<PddRegistration>('/v1/waybill-manage/' + encodeURIComponent(code) + '/withdraw', { method: 'POST', body: { revision }, cap: capability }),
  adminList: (token: string, offset: number) => pddRequest<PddAdminList>('/v1/admin/waybills?offset=' + offset, { token }),
  adminDetail: (token: string, code: string) => pddRequest<PddAdminDetail>('/v1/admin/waybills/' + encodeURIComponent(code), { token }),
  adminAction: (token: string, code: string, revision: number, action: PddAdminAction, notes: string, registrationCode?: string) => pddRequest<PddAdminDetail>('/v1/admin/waybills/' + encodeURIComponent(code) + '/actions', { method: 'POST', token, body: { revision, action, notes, ...(registrationCode ? { registrationCode } : {}) } }),
  adminQueries: (token: string, offset: number) => pddRequest<PddQueryLogPage>('/v1/admin/waybill-queries?offset=' + offset, { token }),
  adminCommunity: (token: string) => pddRequest<Community>('/v1/admin/community', { token }),
  updateCommunity: (token: string, community: Community) => pddRequest<Community>('/v1/admin/community', { method: 'PATCH', token, body: { groupQrUrl: community.groupQrUrl, assistantWechat: community.assistantWechat, assistantQrUrl: community.assistantQrUrl, officialAccountName: community.officialAccountName, officialAccountQrUrl: community.officialAccountQrUrl, submissionsEnabled: community.submissionsEnabled } }),
};
