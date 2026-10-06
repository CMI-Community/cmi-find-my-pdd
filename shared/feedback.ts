import type { PddContact } from './waybill.ts';

export type PddFeedbackStatus = 'new' | 'reviewed' | 'closed';
export interface PddFeedbackInput { message: string; contact?: PddContact | null }
export interface PddFeedbackReceipt { submitted: true; feedbackId: string; submittedAt: string }
export type PddFeedbackResult = PddFeedbackReceipt;
export interface PddFeedback { id: string; message: string; contact: PddContact | null; status: PddFeedbackStatus; createdAt: string; updatedAt: string }
export interface PddFeedbackPage { items: PddFeedback[]; total: number; nextOffset: number | null }
export type PddFeedbackList = PddFeedbackPage;
export function validateFeedbackMessage(value: unknown): string {
  if (typeof value !== 'string') throw new Error('请填写建议或遇到的问题。');
  const message = value.trim();
  if (!message || Array.from(message).length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) throw new Error('请填写1至2000字的建议或问题说明。');
  return message;
}
