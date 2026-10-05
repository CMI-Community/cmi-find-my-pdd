import type { ApiResponse, Community, Stats, ScanCreate, ScanStart, ScanSubmit, ScanProgress, PrivateRecord, PublicRecord, AdminRecord, AdminTask, Extraction, CandidatePage } from '../shared/contracts';
import type { Draft } from './drafts';
import { updateDraft, getDraft } from './drafts';
export const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
export class ApiFailure extends Error {
    code: string;
    requestId?: string;
    retryable: boolean;
    constructor(message: string, code = 'NETWORK_ERROR', requestId?: string, retryable = true) { super(message); this.code = code; this.requestId = requestId; this.retryable = retryable; }
}
export async function request<T>(path: string, options: {
    method?: string;
    body?: unknown;
    cap?: string;
    token?: string;
    key?: string;
    signal?: AbortSignal;
} = {}): Promise<T> {
    if (!API_BASE)
        throw new ApiFailure('服务尚未配置，照片会保留在本机草稿。', 'API_NOT_CONFIGURED', undefined, false);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined)
        headers['Content-Type'] = 'application/json';
    if (options.cap || options.token)
        headers.Authorization = `Bearer ${options.cap || options.token}`;
    if (options.key)
        headers['Idempotency-Key'] = options.key;
    let response: Response;
    try {
        response = await fetch(`${API_BASE}${path}`, { method: options.method || 'GET', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: options.signal });
    }
    catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError')
            throw error;
        throw new ApiFailure('网络连接失败，请检查网络后重试。');
    }
    const content = await response.json().catch(() => null) as ApiResponse<T> | null;
    if (!content)
        throw new ApiFailure('服务器返回了无法读取的内容，请稍后重试。', 'INVALID_RESPONSE');
    if ('error' in content)
        throw new ApiFailure(content.error.message, content.error.code, content.error.requestId, content.error.retryable);
    if (!response.ok)
        throw new ApiFailure('请求未完成，请稍后重试。', `HTTP_${response.status}`);
    return content.data;
}
export const api = {
    community: () => request<Community>('/v1/community'), stats: () => request<Stats>('/v1/stats'),
    create: (body: ScanCreate, cap: string) => request<ScanStart>('/v1/scans', { method: 'POST', body, cap, key: body.requestId }),
    submit: (id: string, body: ScanSubmit, cap: string) => request<ScanProgress>(`/v1/scans/${encodeURIComponent(id)}/submit`, { method: 'POST', body, cap, key: `${id}:${body.imageVersion}:submit:${body.selectedIdentifierId || 'default'}` }),
    progress: (id: string, cap: string) => request<ScanProgress>(`/v1/scans/${encodeURIComponent(id)}`, { cap }),
    candidates: (id: string, imageVersion: number, selectedIdentifierId: string | null, offset: number, cap: string, signal?: AbortSignal) => {
        const query = new URLSearchParams({ imageVersion: String(imageVersion), offset: String(offset) });
        if (selectedIdentifierId)
            query.set('selectedIdentifierId', selectedIdentifierId);
        return request<CandidatePage>(`/v1/scans/${encodeURIComponent(id)}/candidates?${query}`, { cap, signal });
    },
    retry: (id: string, imageVersion: number, cap: string) => request<ScanProgress>(`/v1/scans/${encodeURIComponent(id)}/retry`, { method: 'POST', body: { imageVersion }, cap }),
    track: (body: {
        scanId: string;
        imageVersion: number;
        selectedIdentifierId?: string;
        contact: import('../shared/contracts').Contact;
    }, cap: string) => request<{
        record: PublicRecord;
    }>('/v1/trackers', { method: 'POST', body, cap, key: `${body.scanId}:tracking` }),
    publicRecord: (code: string) => request<PublicRecord>(`/v1/records/${encodeURIComponent(code)}`),
    privateRecord: (code: string, cap: string) => request<PrivateRecord>(`/v1/manage/${encodeURIComponent(code)}`, { cap }),
    contact: (code: string, revision: number, contact: import('../shared/contracts').Contact, cap: string) => request<PrivateRecord>(`/v1/manage/${encodeURIComponent(code)}`, { method: 'PATCH', body: { revision, contact }, cap }),
    withdraw: (code: string, revision: number, cap: string) => request<PrivateRecord>(`/v1/manage/${encodeURIComponent(code)}/withdraw`, { method: 'POST', body: { revision }, cap }),
    revise: (id: string, expectedVersion: number, imageRoles: import('../shared/contracts').ImageRole[], cap: string) => request<ScanStart>(`/v1/scans/${encodeURIComponent(id)}/revisions`, { method: 'POST', body: { expectedVersion, imageRoles }, cap }),
    admin: <T>(path: string, token: string, method = 'GET', body?: unknown) => request<T>(`/v1/admin${path}`, { token, method, body }),
};
export type AdminList = {
    records?: AdminRecord[];
    tasks?: AdminTask[];
    items?: unknown[];
    nextCursor?: string | null;
};
export type ReadExtraction = Extraction;
export async function uploadPhoto(url: string, token: string, blob: Blob) {
    // Supabase signed upload REST accepts multipart/form-data and a signed token in its URL.
    const signed = new URL(url, API_BASE || window.location.origin);
    if (!signed.searchParams.has('token') && token)
        signed.searchParams.set('token', token);
    const body = new FormData();
    body.append('cacheControl', '0');
    body.append('', blob, 'photo.jpg');
    const response = await fetch(signed.href, { method: 'PUT', headers: { 'x-upsert': 'false' }, body });
    if (!response.ok) {
        const error = await response.json().catch(() => null);
        // A lost response after a successful immutable upload is safe to resume.
        // The submit endpoint independently verifies this reserved object's bytes.
        if (error?.error === 'Duplicate' || error?.code === 'Duplicate')
            return;
        throw new ApiFailure('照片上传失败，请检查网络后重试。', 'UPLOAD_FAILED');
    }
}
export async function processDraft(initial: Draft, onProgress?: (p: ScanProgress) => void) {
    let draft = await getDraft(initial.id) || initial;
    const slotsExpired = draft.uploadReservedAt && Date.now() - Date.parse(draft.uploadReservedAt) > 90 * 60 * 1000;
    if (draft.needsRevision || (!draft.imageIds && (!draft.uploadSlots || slotsExpired))) {
        await updateDraft(draft.id, { status: 'uploading', error: undefined });
        const start = draft.needsRevision && draft.scanId
            ? await api.revise(draft.scanId, draft.inputVersion, draft.photos.map(p => p.role), draft.cap)
            : await api.create({ requestId: draft.id, intent: draft.kind, imageRoles: draft.photos.map(p => p.role) }, draft.cap);
        draft = await updateDraft(draft.id, { scanId: start.id, uploadSlots: start.uploads, imageIds: undefined, uploadReservedAt: new Date().toISOString(), inputVersion: start.imageVersion, needsRevision: false, uploadedIds: draft.needsRevision ? [] : (draft.uploadedIds || []) });
    }
    if (draft.uploadSlots && (draft.uploadedIds?.length || 0) < draft.uploadSlots.length) {
        await updateDraft(draft.id, { status: 'uploading', error: undefined });
        const start = { id: draft.scanId!, imageVersion: draft.inputVersion, uploads: draft.uploadSlots };
        for (let i = 0; i < start.uploads.length; i++) {
            const slot = start.uploads[i], photo = draft.photos.find(p => p.role === slot.role);
            if (draft.uploadedIds?.includes(slot.id))
                continue;
            if (!photo)
                throw new ApiFailure('上传槽位与照片不一致，请重新提交。', 'IMAGE_MISMATCH', undefined, false);
            await uploadPhoto(slot.uploadUrl, slot.token, photo.blob);
            draft = await updateDraft(draft.id, { uploadedIds: [...(draft.uploadedIds || []), slot.id] });
        }
        draft = await updateDraft(draft.id, { scanId: start.id, imageIds: start.uploads.map(p => p.id), inputVersion: start.imageVersion });
    }
    await updateDraft(draft.id, { status: 'recognizing' });
    let progress = await api.submit(draft.scanId!, { imageVersion: draft.inputVersion, imageIds: draft.imageIds!, ...(draft.kind === 'received' && draft.contact ? { contact: { ...draft.contact, groupDeclaration: !!draft.groupDeclared } } : {}) }, draft.cap);
    for (let tick = 0; tick < 90; tick++) {
        onProgress?.(progress);
        await updateDraft(draft.id, { response: progress, recordId: progress.record?.code });
        if (['succeeded', 'needs_photo', 'deferred', 'failed', 'cancelled'].includes(progress.state)) {
            const done = progress.state === 'succeeded';
            await updateDraft(draft.id, { status: done ? 'done' : 'error', response: progress, error: done ? undefined : progress.state === 'needs_photo' ? '关键信息不清楚，请重新拍摄面单或物流详情。' : progress.state === 'deferred' ? '识别服务暂时不可用，照片已上传，等待恢复处理。' : '识别未完成，请重试或联系小助手。' });
            return progress;
        }
        await new Promise(resolve => setTimeout(resolve, 1800));
        progress = await api.progress(draft.scanId!, draft.cap);
    }
    throw new ApiFailure('识别仍在处理中，可稍后从本机记录继续查看。', 'POLL_TIMEOUT');
}
export async function retryDraft(draft: Draft) {
    if (draft.response?.state === 'needs_photo')
        throw new ApiFailure('请重新拍图后提交，原照片无法用于继续识别。', 'NEEDS_PHOTO', undefined, false);
    if (draft.scanId && ['failed', 'deferred'].includes(draft.response?.state || ''))
        await api.retry(draft.scanId, draft.inputVersion, draft.cap);
    return updateDraft(draft.id, { status: 'queued', error: undefined });
}
