import { request, ApiFailure } from './api';
import type { Community } from '../shared/contracts';
import type { PddQueryInput, PddQueryResult, PddContact, PddQueryContactResult, PddBatchInput, PddBatchResult, PddRegistration, PddPublicRecord, PddAdminList, PddAdminDetail, PddAdminAction, PddQueryLogPage } from '../shared/waybill';

async function pddRequest<T>(path: string, options: Parameters<typeof request>[1] = {}): Promise<T> {
  try { return await request<T>(path, options); }
  catch (error) {
    if (error instanceof ApiFailure && error.code === 'API_NOT_CONFIGURED') throw new ApiFailure('查询服务尚未配置。待提交单号会保留在当前浏览器，请稍后再试。', error.code, undefined, false);
    throw error;
  }
}
export const pddApi = {
  community: () => pddRequest<Community>('/v1/community'),
  query: (input: PddQueryInput, capability: string) => pddRequest<PddQueryResult>('/v1/waybill-queries', { method: 'POST', body: input, cap: capability, key: input.queryId }),
  queryContact: (queryId: string, contact: PddContact, capability: string) => pddRequest<PddQueryContactResult>('/v1/waybill-queries/' + encodeURIComponent(queryId) + '/contact', { method: 'POST', body: { contact }, cap: capability, key: queryId + ':contact' }),
  batch: (input: PddBatchInput, batchId: string, capability: string) => pddRequest<PddBatchResult>('/v1/waybill-batches', { method: 'POST', body: input, cap: capability, key: batchId }),
  publicRecord: (code: string) => pddRequest<PddPublicRecord>('/v1/waybills/' + encodeURIComponent(code)),
  manage: (code: string, capability: string) => pddRequest<PddRegistration>('/v1/waybill-manage/' + encodeURIComponent(code), { cap: capability }),
  updateContact: (code: string, revision: number, contact: PddContact, capability: string) => pddRequest<PddRegistration>('/v1/waybill-manage/' + encodeURIComponent(code), { method: 'PATCH', body: { revision, contact }, cap: capability }),
  withdraw: (code: string, revision: number, capability: string) => pddRequest<PddRegistration>('/v1/waybill-manage/' + encodeURIComponent(code) + '/withdraw', { method: 'POST', body: { revision }, cap: capability }),
  adminList: (token: string, offset: number) => pddRequest<PddAdminList>('/v1/admin/waybills?offset=' + offset, { token }),
  adminDetail: (token: string, code: string) => pddRequest<PddAdminDetail>('/v1/admin/waybills/' + encodeURIComponent(code), { token }),
  adminAction: (token: string, code: string, revision: number, action: PddAdminAction, notes: string, registrationCode?: string) => pddRequest<PddAdminDetail>('/v1/admin/waybills/' + encodeURIComponent(code) + '/actions', { method: 'POST', token, body: { revision, action, notes, ...(registrationCode ? { registrationCode } : {}) } }),
  adminQueries: (token: string, offset: number) => pddRequest<PddQueryLogPage>('/v1/admin/waybill-queries?offset=' + offset, { token }),
  adminCommunity: (token: string) => pddRequest<Community>('/v1/admin/community', { token }),
  updateCommunity: (token: string, community: Community) => pddRequest<Community>('/v1/admin/community', { method: 'PATCH', token, body: { groupQrUrl: community.groupQrUrl, assistantWechat: community.assistantWechat, assistantQrUrl: community.assistantQrUrl, officialAccountName: community.officialAccountName, officialAccountQrUrl: community.officialAccountQrUrl, submissionsEnabled: community.submissionsEnabled } }),
};
