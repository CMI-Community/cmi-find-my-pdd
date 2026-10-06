import { createStore, get, set } from 'idb-keyval';
import { makeCapability } from './photos';
import { normalizeWaybill, validatePddNote, validateWaybill, validateWaybillQuery, type PddBatchInput, type PddContact, type PddRegistration, type PddResult } from '../shared/waybill';

export type WaybillMode = 'lost' | 'received';
export type NumberSource = 'manual' | 'barcode';
export type QueueEntry = { requestId: string; number: string; mode: WaybillMode; source: NumberSource; createdAt: string; error?: string };
export type LocalReceipt = { code: string; parentCode?: string; number: string; mode: WaybillMode; capability: string; createdAt: string; note?: string | null };
export type PendingBatch = { id: string; capability: string; mode: WaybillMode; items: QueueEntry[]; contact: PddContact; note?: string | null };
export type PendingQueryContact = { queryId: string; capability: string; contact: PddContact; number: string; mode: WaybillMode };
export type WaybillDraftState = { entries: QueueEntry[]; receipts: LocalReceipt[]; pendingBatch?: PendingBatch; pendingContacts?: PendingQueryContact[]; batchNotes?: Partial<Record<WaybillMode, string>> };

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
export function waybillQueryInputError(value: string) {
  if (!normalizeWaybillInput(value)) return '请先输入国内快递单号。';
  try { validateWaybillQuery(value); } catch { return '请填写6–40位国内快递单号，至少保留6位清楚的字母或数字。不清楚的字符可用 ? 或 * 代替一位。'; }
  return '';
}
export function queryQueueAction(number: string, result: PddResult): 'queue' | 'complete_number' | 'show_result' {
  if (result !== 'not_found') return 'show_result';
  return waybillInputError(number) ? 'complete_number' : 'queue';
}
export function addQueueEntry(entries: QueueEntry[], entry: QueueEntry): QueueEntry[] {
  const validation = waybillInputError(entry.number);
  if (validation) throw new Error('登记需要完整单号，请核对不清楚的字符后再添加。');
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
  if (waybillInputError(number)) throw new Error('登记需要完整单号，请核对不清楚的字符后再添加。');
  return { requestId: crypto.randomUUID(), number: normalizeWaybillInput(number), mode, source, createdAt: new Date().toISOString() };
}
export function draftBatchNote(state: WaybillDraftState, mode: WaybillMode) { return state.batchNotes?.[mode] || ''; }
export function setDraftBatchNote(state: WaybillDraftState, mode: WaybillMode, note: string): WaybillDraftState {
  return { ...state, batchNotes: { ...state.batchNotes, [mode]: note } };
}
export function newPendingBatch(mode: WaybillMode, items: QueueEntry[], contact: PddContact, note?: string | null): PendingBatch {
  let normalizedNote: string | null;
  try { normalizedNote = validatePddNote(note); } catch { throw new Error('补充说明最多500个字，不能包含异常字符。请调整后再提交。'); }
  if (items.some(item => waybillInputError(item.number))) throw new Error('待提交列表中有不完整单号，请核对后再登记。');
  return { id: crypto.randomUUID(), capability: makeCapability(), mode, items: items.map(item => ({ ...item })), contact: { ...contact }, note: normalizedNote };
}
export function pendingBatchInput(batch: PendingBatch): PddBatchInput {
  // Older saved retries omitted this field. Preserve their original body instead
  // of adding null and changing the already accepted idempotency payload.
  if (batch.items.some(item => waybillInputError(item.number))) throw new Error('待提交列表中有不完整单号，请核对后再登记。');
  return { mode: batch.mode, contact: batch.contact, items: batch.items.map(item => ({ requestId: item.requestId, number: item.number, source: item.source })), ...(batch.note !== undefined ? { note: batch.note } : {}) };
}
export function receiptFromRegistration(registration: PddRegistration, capability: string): LocalReceipt {
  return { code: registration.registrationCode, parentCode: registration.record.code, number: registration.number, mode: registration.mode, capability, createdAt: registration.createdAt, note: registration.note ?? null };
}
export function privateWaybillUrl(code: string, capability: string) { return `${window.location.origin}/m/${encodeURIComponent(code)}#key=${encodeURIComponent(capability)}`; }
