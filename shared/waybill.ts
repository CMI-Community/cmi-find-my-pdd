import type { Resolution, Visibility } from './contracts.ts';

export type PddMode = 'lost' | 'received';
export type PddSource = 'manual' | 'barcode';
export interface PddContact { kind: 'wechat' | 'phone'; value: string }
export interface PddHomeStats { lostRegistered: number; receivedRegistered: number; matchedParcels: number }
export type PddResult = 'matched' | 'possible' | 'duplicate' | 'not_found' | 'closed';
export interface PddPossibleCandidate { code: string; tail: string; similarity: number; registeredAt: string }
export interface PddPublicRecord {
  code: string; tail: string; resolution: Resolution; visibility: Visibility;
  revision: number; lostRegistered: boolean; receivedRegistered: boolean;
  createdAt: string; updatedAt: string;
}
export interface PddRegistration {
  registrationCode: string; number: string; mode: PddMode; source: PddSource;
  contact: PddContact | null; note: string | null; revision: number; visibility: 'active' | 'withdrawn';
  createdAt: string; updatedAt: string; record: PddPublicRecord;
}
export interface PddQueryInput { queryId: string; number: string; mode: PddMode; source: PddSource; allowPossible?: boolean }
/** The exact-number lookup is the sole intentional direct-contact projection. */
export interface PddQueryResult {
  queryId: string; result: PddResult; queriedAt: string;
  record: PddPublicRecord | null; registeredAt: string | null; contact: PddContact | null; note: string | null;
  candidates: PddPossibleCandidate[];
}
export interface PddQueryContactResult { saved: true; registration: PddRegistration | null }
export interface PddBatchItem { requestId: string; number: string; source: PddSource }
export interface PddBatchInput { mode: PddMode; contact: PddContact; note?: string | null; items: PddBatchItem[] }
export interface PddBatchResultItem {
  requestId: string; number: string; result: 'registered' | 'matched' | 'duplicate' | 'closed';
  record: PddPublicRecord; registration: PddRegistration | null;
  contact: PddContact | null; note: string | null; registeredAt: string | null;
}
export interface PddBatchResult { submittedAt: string; items: PddBatchResultItem[] }
export interface PddQueryLog {
  queryId: string; number: string; mode: PddMode; source: PddSource; result: PddResult;
  queriedAt: string; code: string | null; contact: PddContact | null; contactSubmittedAt: string | null;
}
export interface PddAdminRecord extends PddPublicRecord {
  number: string; lostContact: PddContact | null; receivedContact: PddContact | null; queryCount: number;
}
export interface PddAuditEvent { id: string; action: string; actorId: string | null; notes: string; createdAt: string }
export interface PddAdminDetail {
  record: PddAdminRecord; registrations: PddRegistration[]; queries: PddQueryLog[]; events: PddAuditEvent[];
}
export interface PddAdminList { items: PddAdminRecord[]; nextOffset: number | null }
export interface PddQueryLogPage { items: PddQueryLog[]; nextOffset: number | null }
export type PddAdminAction = 'verify' | 'claim' | 'return' | 'withdraw';

/** Never guess missing digits or conflate punctuation with a different number. */
export function normalizeWaybill(input: string): string {
  return input.replace(/\s/g, '').toUpperCase();
}
/** Only the confirmed forwarding prefix is excluded; never guess other formats. */
export function isNonDomesticWaybill(input: string): boolean {
  return normalizeWaybill(input).startsWith('JTTH');
}
export const DOMESTIC_WAYBILL_MESSAGE = 'JTTH 开头的是集运或境外配送单号，请在拼多多物流详情或包裹面单查找中国境内的完整快递单号。';
function requireDomesticWaybill(value: string): void {
  if (isNonDomesticWaybill(value)) throw new Error('NON_DOMESTIC_WAYBILL');
}
export function validateWaybill(input: unknown): string {
  if (typeof input !== 'string' || input.length > 100) throw new Error('INVALID_WAYBILL');
  const value = normalizeWaybill(input);
  requireDomesticWaybill(value);
  if (!/^[A-Z0-9]{6,40}$/.test(value)) throw new Error('INVALID_WAYBILL');
  return value;
}
/** Unknown characters are literal one-character placeholders, never inferred digits. */
export function validateWaybillQuery(input: unknown): string {
  if (typeof input !== 'string' || input.length > 100) throw new Error('INVALID_WAYBILL');
  const value = normalizeWaybill(input);
  requireDomesticWaybill(value);
  if (!/^[A-Z0-9?*]{6,40}$/.test(value) || value.replace(/[?*]/g, '').length < 6) throw new Error('INVALID_WAYBILL');
  return value;
}
export function validatePddContact(input: unknown): PddContact {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_CONTACT');
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['kind', 'value'].includes(key)) || typeof raw.value !== 'string') throw new Error('INVALID_CONTACT');
  const value = raw.value.trim();
  if (raw.kind === 'wechat' && /^[a-zA-Z][-_a-zA-Z0-9]{5,63}$/.test(value)) return { kind: 'wechat', value };
  if (raw.kind === 'phone' && value.length <= 32 && /^\+?[0-9][0-9 ()-]{5,30}[0-9]$/.test(value) && value.replace(/\D/g, '').length >= 7) return { kind: 'phone', value };
  throw new Error('INVALID_CONTACT');
}

/** Unicode characters, rather than UTF-16 units, are the displayed note limit. */
export function validatePddNote(input: unknown): string | null {
  if (input == null) return null;
  if (typeof input !== 'string') throw new Error('INVALID_NOTE');
  const value = input.trim();
  if (Array.from(value).length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(input)) throw new Error('INVALID_NOTE');
  return value || null;
}
