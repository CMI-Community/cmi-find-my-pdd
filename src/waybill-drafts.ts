import { createStore, get, set } from 'idb-keyval';
import { makeCapability } from './photos';
import { normalizeWaybill, validateWaybill, type PddContact } from '../shared/waybill';

export type WaybillMode = 'lost' | 'received';
export type NumberSource = 'manual' | 'barcode';
export type QueueEntry = { requestId: string; number: string; mode: WaybillMode; source: NumberSource; createdAt: string; error?: string };
export type LocalReceipt = { code: string; parentCode?: string; number: string; mode: WaybillMode; capability: string; createdAt: string };
export type PendingBatch = { id: string; capability: string; mode: WaybillMode; items: QueueEntry[]; contact: PddContact };
export type PendingQueryContact = { queryId: string; capability: string; contact: PddContact; number: string; mode: WaybillMode };
export type WaybillDraftState = { entries: QueueEntry[]; receipts: LocalReceipt[]; pendingBatch?: PendingBatch; pendingContacts?: PendingQueryContact[] };

// This store intentionally does not read or resume any of the legacy photo/OCR drafts.
const db = createStore('pdd404-domestic-waybills-v1', 'drafts');
const emptyState = (): WaybillDraftState => ({ entries: [], receipts: [] });
export function normalizeWaybillInput(value: string) { return normalizeWaybill(value); }
export function waybillInputError(value: string) {
  const number = normalizeWaybillInput(value);
  if (!number) return '请先输入国内快递单号。';
  try { validateWaybill(value); } catch { return '请填写完整的国内快递单号（6–40位字母或数字），不要填订单编号。'; }
  return '';
}
export function addQueueEntry(entries: QueueEntry[], entry: QueueEntry): QueueEntry[] {
  if (entries.some(item => item.mode === entry.mode && normalizeWaybillInput(item.number) === normalizeWaybillInput(entry.number))) return entries;
  if (entries.filter(item => item.mode === entry.mode).length >= 50) throw new Error('每批最多登记50个单号，请先提交下方列表，再继续查询。当前单号仍保留在输入框中。');
  return [...entries, { ...entry, number: normalizeWaybillInput(entry.number) }];
}
export function settleQueue(entries: QueueEntry[], settledIds: string[], errors: Record<string, string> = {}) {
  const settled = new Set(settledIds);
  return entries.filter(item => !settled.has(item.requestId)).map(item => errors[item.requestId] ? { ...item, error: errors[item.requestId] } : item);
}
export async function readWaybillDrafts(): Promise<WaybillDraftState> { return await get<WaybillDraftState>('state', db) || emptyState(); }
export async function saveWaybillDrafts(state: WaybillDraftState) {
  await set('state', state, db);
  window.dispatchEvent(new Event('waybill-drafts-changed'));
  return state;
}
export function newQueueEntry(number: string, mode: WaybillMode, source: NumberSource): QueueEntry {
  return { requestId: crypto.randomUUID(), number: normalizeWaybillInput(number), mode, source, createdAt: new Date().toISOString() };
}
export function newPendingBatch(mode: WaybillMode, items: QueueEntry[], contact: PddContact): PendingBatch {
  return { id: crypto.randomUUID(), capability: makeCapability(), mode, items: items.map(item => ({ ...item })), contact: { ...contact } };
}
export function privateWaybillUrl(code: string, capability: string) { return `${window.location.origin}/m/${encodeURIComponent(code)}#key=${encodeURIComponent(capability)}`; }
