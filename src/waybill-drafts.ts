import { createStore, get, set } from 'idb-keyval';
import { makeCapability } from './photos';
import { DOMESTIC_WAYBILL_MESSAGE, isNonDomesticWaybill, normalizeWaybill, validatePddNote, validateWaybill, validateWaybillQuery, type PddBatchInput, type PddContact, type PddRegistration, type PddResult } from '../shared/waybill';
import type { PddLookupType } from '../shared/waybill';
import { normalizeRecipientName, optionalRecipientName, validateRecipientName, type PddRecipientBatchInput, type PddRecipientRegistration } from '../shared/recipient';

export type WaybillMode = 'lost' | 'received';
export type NumberSource = 'manual' | 'barcode';
export type QueueEntry = { requestId: string; number: string; mode: WaybillMode; source: NumberSource; createdAt: string; error?: string; lookupType?: PddLookupType; recipientName?: string | null };
export type LocalReceipt = { code: string; parentCode?: string; number: string; mode: WaybillMode; capability: string; createdAt: string; note?: string | null; lookupType?: PddLookupType; recipientName?: string | null };
export type PendingBatch = { id: string; capability: string; mode: WaybillMode; items: QueueEntry[]; contact: PddContact; note?: string | null; lookupType?: PddLookupType };
export type PendingQueryContact = { queryId: string; capability: string; contact: PddContact; number: string; mode: WaybillMode };
export type LookupScope = `${WaybillMode}:${PddLookupType}`;
export type LookupDraft = { input: string; source: NumberSource; contact: PddContact; note: string };
export type WaybillDraftState = { entries: QueueEntry[]; receipts: LocalReceipt[]; pendingBatch?: PendingBatch; pendingContacts?: PendingQueryContact[]; batchNotes?: Partial<Record<WaybillMode, string>>; lookupDrafts?: Partial<Record<LookupScope, LookupDraft>>; pendingBatches?: Partial<Record<LookupScope, PendingBatch>> };
export const lookupScope = (mode: WaybillMode, type: PddLookupType): LookupScope => `${mode}:${type}`;
export const entryLookupType = (entry: { lookupType?: PddLookupType }) => entry.lookupType || 'waybill';
export function lookupDraft(state: WaybillDraftState, mode: WaybillMode, type: PddLookupType): LookupDraft {
  return state.lookupDrafts?.[lookupScope(mode, type)] || { input: '', source: 'manual', contact: { kind: 'wechat', value: '' }, note: type === 'waybill' ? draftBatchNote(state, mode) : '' };
}
export function setLookupDraft(state: WaybillDraftState, mode: WaybillMode, type: PddLookupType, patch: Partial<LookupDraft>): WaybillDraftState {
  return { ...state, lookupDrafts: { ...state.lookupDrafts, [lookupScope(mode, type)]: { ...lookupDraft(state, mode, type), ...patch } } };
}
export function pendingForScope(state: WaybillDraftState, mode: WaybillMode, type: PddLookupType) {
  return state.pendingBatches?.[lookupScope(mode, type)] || (state.pendingBatch?.mode === mode && entryLookupType(state.pendingBatch) === type ? state.pendingBatch : undefined);
}
export function setPendingForScope(state: WaybillDraftState, mode: WaybillMode, type: PddLookupType, pending?: PendingBatch): WaybillDraftState {
  return { ...state, ...(state.pendingBatch?.mode === mode && entryLookupType(state.pendingBatch) === type ? { pendingBatch: undefined } : {}), pendingBatches: { ...state.pendingBatches, [lookupScope(mode, type)]: pending } };
}
export function recipientInputError(value: string) {
  try { validateRecipientName(value); return ''; } catch { return value.trim() ? '收件人名需为1–80个字，不能包含换行或异常字符。请照面单完整填写。' : '请先输入面单上的收件人名。'; }
}

// This store intentionally does not read or resume any of the legacy photo/OCR drafts.
const db = createStore('pdd404-domestic-waybills-v1', 'drafts');
const emptyState = (): WaybillDraftState => ({ entries: [], receipts: [] });
export function normalizeWaybillInput(value: string) { return normalizeWaybill(value); }
export const needsDomesticWaybillReminder = isNonDomesticWaybill;
export function waybillInputError(value: string) {
  const number = normalizeWaybillInput(value);
  if (!number) return '请先输入国内快递单号。';
  if (needsDomesticWaybillReminder(value)) return DOMESTIC_WAYBILL_MESSAGE;
  try { validateWaybill(value); } catch { return '请填写完整的国内快递单号（6–40位字母或数字），不要填订单编号。'; }
  return '';
}
export function waybillQueryInputError(value: string) {
  if (!normalizeWaybillInput(value)) return '请先输入国内快递单号。';
  if (needsDomesticWaybillReminder(value)) return DOMESTIC_WAYBILL_MESSAGE;
  try { validateWaybillQuery(value); } catch { return '请填写6–40位国内快递单号，至少保留6位清楚的字母或数字。不清楚的字符可用 ? 或 * 代替一位。'; }
  return '';
}
export function queryQueueAction(number: string, result: PddResult): 'queue' | 'complete_number' | 'show_result' {
  if (result !== 'not_found') return 'show_result';
  return waybillInputError(number) ? 'complete_number' : 'queue';
}
export function addQueueEntry(entries: QueueEntry[], entry: QueueEntry): QueueEntry[] {
  if (needsDomesticWaybillReminder(entry.number)) throw new Error(DOMESTIC_WAYBILL_MESSAGE);
  const validation = waybillInputError(entry.number);
  if (validation) throw new Error('登记需要完整单号，请核对不清楚的字符后再添加。');
  if (entries.some(item => entryLookupType(item) === 'waybill' && item.mode === entry.mode && normalizeWaybillInput(item.number) === normalizeWaybillInput(entry.number))) return entries;
  if (entries.filter(item => entryLookupType(item) === 'waybill' && item.mode === entry.mode).length >= 50) throw new Error('每批最多登记50个单号，请先提交下方列表，再继续查询。当前单号仍保留在输入框中。');
  return [...entries, { ...entry, number: normalizeWaybillInput(entry.number) }];
}
export function newRecipientQueueEntry(name: string, mode: WaybillMode): QueueEntry {
  const recipientName = validateRecipientName(name);
  return { requestId: crypto.randomUUID(), number: recipientName, recipientName, lookupType: 'recipient', mode, source: 'manual', createdAt: new Date().toISOString() };
}
export function addRecipientQueueEntry(entries: QueueEntry[], entry: QueueEntry): QueueEntry[] {
  const normalized = normalizeRecipientName(entry.number);
  if (entries.some(item => entryLookupType(item) === 'recipient' && item.mode === entry.mode && normalizeRecipientName(item.number) === normalized)) return entries;
  if (entries.filter(item => entryLookupType(item) === 'recipient' && item.mode === entry.mode).length >= 50) throw new Error('每批最多登记50个收件人名，请先提交列表。当前姓名仍保留在输入框中。');
  return [...entries, { ...entry, number: validateRecipientName(entry.number), recipientName: validateRecipientName(entry.number), lookupType: 'recipient' }];
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
  if (needsDomesticWaybillReminder(number)) throw new Error(DOMESTIC_WAYBILL_MESSAGE);
  if (waybillInputError(number)) throw new Error('登记需要完整单号，请核对不清楚的字符后再添加。');
  return { requestId: crypto.randomUUID(), number: normalizeWaybillInput(number), mode, source, createdAt: new Date().toISOString() };
}
export function draftBatchNote(state: WaybillDraftState, mode: WaybillMode) { return state.batchNotes?.[mode] || ''; }
export function setDraftBatchNote(state: WaybillDraftState, mode: WaybillMode, note: string): WaybillDraftState {
  return { ...state, batchNotes: { ...state.batchNotes, [mode]: note } };
}
export function newPendingBatch(mode: WaybillMode, items: QueueEntry[], contact: PddContact, note?: string | null): PendingBatch {
  if (items.some(item => needsDomesticWaybillReminder(item.number))) throw new Error(DOMESTIC_WAYBILL_MESSAGE + ' 请从待提交列表移除集运单号。');
  let normalizedNote: string | null;
  try { normalizedNote = validatePddNote(note); } catch { throw new Error('补充说明最多500个字，不能包含异常字符。请调整后再提交。'); }
  if (items.some(item => waybillInputError(item.number))) throw new Error('待提交列表中有不完整单号，请核对后再登记。');
  let normalizedItems: QueueEntry[];
  try { normalizedItems = items.map(item => ({ ...item, ...(item.recipientName !== undefined ? { recipientName: optionalRecipientName(item.recipientName) } : {}) })); } catch { throw new Error('收件人名最多80个字，不能包含换行或异常字符。请检查每一行。'); }
  return { id: crypto.randomUUID(), capability: makeCapability(), mode, items: normalizedItems, contact: { ...contact }, note: normalizedNote };
}
export function newRecipientPendingBatch(mode: WaybillMode, items: QueueEntry[], contact: PddContact, note?: string | null): PendingBatch {
  if (!items.length || items.length > 50) throw new Error('每批需要1–50个收件人名。');
  let normalizedNote: string | null;
  try { normalizedNote = validatePddNote(note); } catch { throw new Error('补充说明最多500个字，不能包含异常字符。请调整后再提交。'); }
  return { id: crypto.randomUUID(), capability: makeCapability(), lookupType: 'recipient', mode, items: items.map(item => ({ ...item, number: validateRecipientName(item.number), recipientName: validateRecipientName(item.number) })), contact: { ...contact }, note: normalizedNote };
}
export function recipientPendingBatchInput(batch: PendingBatch): PddRecipientBatchInput {
  return { mode: batch.mode, contact: batch.contact, items: batch.items.map(item => ({ requestId: item.requestId, recipientName: validateRecipientName(item.number) })), ...(batch.note !== undefined ? { note: batch.note } : {}) };
}
export function pendingBatchInput(batch: PendingBatch): PddBatchInput {
  if (batch.items.some(item => needsDomesticWaybillReminder(item.number))) throw new Error(DOMESTIC_WAYBILL_MESSAGE + ' 此旧批次不能继续提交。');
  // Older saved retries omitted this field. Preserve their original body instead
  // of adding null and changing the already accepted idempotency payload.
  if (batch.items.some(item => waybillInputError(item.number))) throw new Error('待提交列表中有不完整单号，请核对后再登记。');
  return { mode: batch.mode, contact: batch.contact, items: batch.items.map(item => ({ requestId: item.requestId, number: item.number, source: item.source, ...(item.recipientName !== undefined ? { recipientName: item.recipientName } : {}) })), ...(batch.note !== undefined ? { note: batch.note } : {}) };
}
export function receiptFromRegistration(registration: PddRegistration, capability: string): LocalReceipt {
  return { code: registration.registrationCode, parentCode: registration.record.code, number: registration.number, mode: registration.mode, capability, createdAt: registration.createdAt, note: registration.note ?? null, recipientName: registration.recipientName };
}
export function receiptFromRecipient(registration: PddRecipientRegistration, capability: string): LocalReceipt {
  return { code: registration.registrationCode, number: registration.recipientName || '姓名已清理', recipientName: registration.recipientName, lookupType: 'recipient', mode: registration.mode, capability, createdAt: registration.createdAt, note: registration.note };
}
export function privateRecipientUrl(code: string, capability: string) { return `${window.location.origin}/rm/${encodeURIComponent(code)}#key=${encodeURIComponent(capability)}`; }
export function privateWaybillUrl(code: string, capability: string) { return `${window.location.origin}/m/${encodeURIComponent(code)}#key=${encodeURIComponent(capability)}`; }
