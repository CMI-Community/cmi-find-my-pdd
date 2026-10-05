import { createStore, get, set, del, values } from 'idb-keyval';
import { makeCapability, type LocalPhoto } from './photos';
export type Contact = {
    wechat: string;
    other?: string;
};
export type Draft = {
    id: string;
    batchId?: string;
    cap: string;
    kind: 'received' | 'search';
    photos: LocalPhoto[];
    status: 'draft' | 'queued' | 'uploading' | 'recognizing' | 'done' | 'error';
    createdAt: string;
    updatedAt: string;
    contact?: Contact;
    groupDeclared?: boolean;
    inputVersion: number;
    error?: string;
    recordId?: string;
    scanId?: string;
    imageIds?: string[];
    uploadSlots?: import('../shared/contracts').UploadSlot[];
    uploadReservedAt?: string;
    uploadedIds?: string[];
    needsRevision?: boolean;
    response?: import('../shared/contracts').ScanProgress;
};
const db = createStore('cmi-find-my-pdd', 'drafts');
export function notifyDrafts() { window.dispatchEvent(new Event('drafts-changed')); }
export async function saveDraft(draft: Draft) {
    await set(draft.id, { ...draft, updatedAt: new Date().toISOString() }, db);
    notifyDrafts();
    return draft;
}
export async function newDraft(kind: Draft['kind']): Promise<Draft> {
    const now = new Date().toISOString();
    const draft: Draft = { id: crypto.randomUUID(), cap: makeCapability(), kind, photos: [], status: 'draft', createdAt: now, updatedAt: now, inputVersion: 1 };
    if (kind === 'received') {
        let batchId = sessionStorage.getItem('cmi-pdd-active-batch');
        if (!batchId) {
            batchId = crypto.randomUUID();
            sessionStorage.setItem('cmi-pdd-active-batch', batchId);
        }
        draft.batchId = batchId;
    }
    // Capability persistence must succeed before any server request.
    await saveDraft(draft);
    return draft;
}
export async function getDraft(id: string) { return get<Draft>(id, db); }
export async function listDrafts() { return (await values<Draft>(db)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
export async function removeDraft(id: string) { await del(id, db); notifyDrafts(); }
export async function updateDraft(id: string, update: Partial<Draft>) {
    const draft = await getDraft(id);
    if (!draft)
        throw new Error('本机草稿不存在，请重新提交。');
    return saveDraft({ ...draft, ...update });
}
export function managementUrl(id: string, cap: string) { return `${window.location.origin}/m/${id}#key=${encodeURIComponent(cap)}`; }
