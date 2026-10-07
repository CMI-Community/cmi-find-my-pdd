import type { PddAuditEvent, PddContact, PddMode } from './waybill.ts';

export type PddRecipientState = 'active' | 'reviewing' | 'closed' | 'withdrawn';
/** This projection is returned only by the dedicated complete-name POST query. */
export interface PddRecipientLead {
  recipientName: string; registeredAt: string; contact: PddContact; note: string | null;
}
export interface PddRecipientQueryInput { queryId: string; recipientName: string; mode: PddMode }
export interface PddRecipientQueryResult {
  queryId: string; result: 'leads_found' | 'not_found'; queriedAt: string;
  leads: PddRecipientLead[]; nextCursor: string | null;
}
export interface PddRecipientRegistration {
  registrationCode: string; recipientName: string | null; mode: PddMode;
  contact: PddContact | null; note: string | null; state: PddRecipientState; revision: number;
  createdAt: string; updatedAt: string;
}
export interface PddRecipientBatchItem { requestId: string; recipientName: string }
export interface PddRecipientBatchInput { mode: PddMode; contact: PddContact; note?: string | null; items: PddRecipientBatchItem[] }
export interface PddRecipientBatchResultItem {
  requestId: string; recipientName: string; result: 'registered' | 'duplicate'; registration: PddRecipientRegistration | null;
}
export interface PddRecipientBatchResult { submittedAt: string; items: PddRecipientBatchResultItem[] }
export interface PddRecipientQueryLog {
  queryId: string; recipientName: string; mode: PddMode; result: 'leads_found' | 'not_found'; queriedAt: string;
}
export interface PddRecipientQueryLogPage { items: PddRecipientQueryLog[]; nextOffset: number | null }
export interface PddRecipientAdminList { items: PddRecipientRegistration[]; nextOffset: number | null }
export interface PddRecipientAdminDetail { registration: PddRecipientRegistration; events: PddAuditEvent[] }
export type PddRecipientAdminAction = 'review' | 'close' | 'withdraw';

/** Keep the displayed spelling; case folding affects ASCII English letters only. */
export function validateRecipientName(input: unknown): string {
  if (typeof input !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(input)) throw new Error('INVALID_RECIPIENT_NAME');
  const value = input.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (Array.from(value).length < 1 || Array.from(value).length > 80) throw new Error('INVALID_RECIPIENT_NAME');
  return value;
}
export function normalizeRecipientName(input: string): string {
  return validateRecipientName(input).replace(/[A-Z]/g, letter => letter.toLowerCase());
}
export function optionalRecipientName(input: unknown): string | null {
  if (input == null || input === '') return null;
  if (typeof input === 'string' && !/[\u0000-\u001f\u007f-\u009f]/.test(input) && !input.trim()) return null;
  return validateRecipientName(input);
}
