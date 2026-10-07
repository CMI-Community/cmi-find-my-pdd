import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { LookupModeControls } from '../src/pdd-home';
import { RecipientBatchReceipt, RecipientQueryResults } from '../src/pdd-recipient';
import { safeRecipientQueryResponse } from '../src/pdd-api';
import { addQueueEntry, addRecipientQueueEntry, entryLookupType, lookupDraft, newPendingBatch, newQueueEntry, newRecipientPendingBatch, newRecipientQueueEntry, pendingBatchInput, pendingForScope, recipientPendingBatchInput, setLookupDraft, setPendingForScope, type WaybillDraftState } from '../src/waybill-drafts';
import type { PddRecipientQueryResult, PddRecipientRegistration } from '../shared/recipient';

const contact = { kind: 'wechat' as const, value: 'synthetic_user' };
const empty = (): WaybillDraftState => ({ entries: [], receipts: [] });
const result: PddRecipientQueryResult = { queryId: 'synthetic-query', result: 'leads_found', queriedAt: '2026-10-07T00:00:00Z', nextCursor: 'synthetic-cursor', leads: [{ recipientName: 'Synthetic Recipient', registeredAt: '2026-10-07T00:00:00Z', contact, note: '<script>synthetic</script>' }] };

describe('independent number and recipient draft flows', () => {
  it('restores four distinct input, contact and note drafts without changing old number drafts', () => {
    let state = { ...empty(), batchNotes: { lost: '旧单号备注' } };
    expect(lookupDraft(state, 'lost', 'waybill').note).toBe('旧单号备注');
    for (const mode of ['lost', 'received'] as const) for (const type of ['waybill', 'recipient'] as const) state = setLookupDraft(state, mode, type, { input: mode + ':' + type, contact: { ...contact, value: 'synthetic_' + mode + '_' + type }, note: '备注' + mode + type }) as typeof state;
    const restored = JSON.parse(JSON.stringify(state)) as WaybillDraftState;
    for (const mode of ['lost', 'received'] as const) for (const type of ['waybill', 'recipient'] as const) {
      expect(lookupDraft(restored, mode, type).input).toBe(mode + ':' + type);
      expect(lookupDraft(restored, mode, type).contact.value).toBe('synthetic_' + mode + '_' + type);
      expect(lookupDraft(restored, mode, type).note).toBe('备注' + mode + type);
    }
  });
  it('deduplicates complete normalized names within their side and preserves all other scopes', () => {
    let state = addQueueEntry([], newQueueEntry('00123456', 'lost', 'manual'));
    state = addRecipientQueueEntry(state, newRecipientQueueEntry('Synthetic   Recipient', 'lost'));
    expect(addRecipientQueueEntry(state, newRecipientQueueEntry('  SYNTHETIC recipient ', 'lost'))).toBe(state);
    state = addRecipientQueueEntry(state, newRecipientQueueEntry('Synthetic Recipient', 'received'));
    expect(state.map(entry => [entry.mode, entryLookupType(entry)])).toEqual([['lost', 'waybill'], ['lost', 'recipient'], ['received', 'recipient']]);
    expect(addRecipientQueueEntry(state, newRecipientQueueEntry('Synthetic', 'lost'))).toHaveLength(4);
  });
  it('caps each recipient scope at 50 while allowing duplicates and a different scope', () => {
    const entries = Array.from({ length: 50 }, (_, index) => newRecipientQueueEntry('Synthetic Person ' + index, 'lost'));
    expect(() => addRecipientQueueEntry(entries, newRecipientQueueEntry('Synthetic Person 50', 'lost'))).toThrow('每批最多');
    expect(addRecipientQueueEntry(entries, newRecipientQueueEntry('Synthetic Person 0', 'lost'))).toBe(entries);
    expect(addRecipientQueueEntry(entries, newRecipientQueueEntry('Synthetic Person 50', 'received'))).toHaveLength(51);
    expect(addQueueEntry(entries, newQueueEntry('00123456', 'lost', 'manual'))).toHaveLength(51);
  });
  it('freezes per-item names plus contact and note, and preserves omitted legacy wire fields on retry', () => {
    const entries = [newQueueEntry('00123456', 'lost', 'manual'), newQueueEntry('00987654', 'lost', 'manual')];
    entries[0].recipientName = 'Synthetic One'; entries[1].recipientName = 'Synthetic Two';
    const numberBatch = newPendingBatch('lost', entries, { ...contact }, '共同备注');
    entries[0].recipientName = 'Changed';
    expect(pendingBatchInput(numberBatch).items.map(item => item.recipientName)).toEqual(['Synthetic One', 'Synthetic Two']);
    const legacy = { ...numberBatch, items: [newQueueEntry('00123456', 'lost', 'manual')], note: undefined };
    const retry = pendingBatchInput(JSON.parse(JSON.stringify(legacy)));
    expect(retry).not.toHaveProperty('note'); expect(retry.items[0]).not.toHaveProperty('recipientName');
    const recipientRows = [newRecipientQueueEntry('Synthetic Person', 'lost')], recipientBatch = newRecipientPendingBatch('lost', recipientRows, { ...contact }, '📦'.repeat(500));
    recipientRows[0].number = 'Changed';
    expect(recipientPendingBatchInput(recipientBatch).items[0].recipientName).toBe('Synthetic Person');
    expect(recipientPendingBatchInput(recipientBatch).note).toBe('📦'.repeat(500));
    const state = setPendingForScope({ ...empty(), pendingBatch: legacy }, 'lost', 'recipient', recipientBatch);
    expect(pendingForScope(state, 'lost', 'waybill')?.id).toBe(legacy.id);
    expect(pendingForScope(state, 'lost', 'recipient')?.id).toBe(recipientBatch.id);
    expect(pendingForScope(setPendingForScope(state, 'lost', 'recipient'), 'lost', 'waybill')?.id).toBe(legacy.id);
  });
  it('validates every recipient and per-number optional name before freezing a batch', () => {
    expect(() => newRecipientQueueEntry('Person\nSecond', 'lost')).toThrow();
    expect(() => newRecipientQueueEntry('📦'.repeat(81), 'lost')).toThrow();
    const row = newQueueEntry('00123456', 'lost', 'manual'); row.recipientName = 'Person\nSecond';
    expect(() => newPendingBatch('lost', [row], contact)).toThrow();
    expect(() => newRecipientPendingBatch('lost', [newRecipientQueueEntry('Synthetic Person', 'lost')], contact, '📦'.repeat(501))).toThrow();
  });
});

describe('recipient visual clues and disclosure boundaries', () => {
  it('shows both complete mode labels with explicit selected state and the corresponding scene', () => {
    for (const type of ['waybill', 'recipient'] as const) {
      const html = renderToStaticMarkup(createElement(LookupModeControls, { lookupType: type, disabled: false, onChange() {} }));
      expect(html).toContain(`data-lookup="${type}"`);
      expect(html).toContain('快递单号'); expect(html).toContain('收件人名');
      const buttons = html.match(/<button\b[^>]*>.*?<\/button>/gs)!;
      expect(buttons).toHaveLength(2); expect(buttons[0]).toContain(`aria-pressed="${type === 'waybill'}"`); expect(buttons[1]).toContain(`aria-pressed="${type === 'recipient'}"`);
      expect(html).toContain(type === 'waybill' ? 'lookup-detective-waybill' : 'lookup-detective-recipient');
      expect(html).toContain(type === 'waybill' ? '看条码下方的完整国内单号' : '看面单上的收件人名');
    }
  });
  it('renders direct contacts safely with a same-name warning, paging, and a register-after-hit action', () => {
    const html = renderToStaticMarkup(createElement(RecipientQueryResults, { view: { recipientName: 'Synthetic Recipient', mode: 'lost', capability: 'SECRET-SYNTHETIC', response: result }, async onRegister() {} }));
    expect(html).toContain('同名可能是不同的人'); expect(html).toContain(contact.value); expect(html).toContain('复制联系方式');
    expect(html).toContain('继续查看同名线索'); expect(html).toContain('仍需登记，加入待提交列表'); expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).not.toContain('SECRET-SYNTHETIC');
  });
  it('allowlists name query DTOs and rejects impossible page sizes without leaking management fields', () => {
    const contaminated = { ...result, capability: 'SECRET', number: '00123456', leads: [{ ...result.leads[0], registrationCode: 'PRIVATE-CODE', address: 'PRIVATE-ADDRESS', recipientNormalized: 'private' }] };
    expect(safeRecipientQueryResponse(contaminated)).toEqual(result);
    expect(() => safeRecipientQueryResponse({ ...result, leads: Array.from({ length: 21 }, () => result.leads[0]) })).toThrow('姓名线索返回异常');
  });
  it('shows private management only and thanks only a newly server-confirmed holder', () => {
    const registration: PddRecipientRegistration = { registrationCode: 'PDD-N-SYNTHETIC', recipientName: 'Synthetic Person', mode: 'received', contact, note: null, state: 'active', revision: 1, createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z' };
    const html = (kind: 'registered' | 'duplicate') => renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(RecipientBatchReceipt, { receipt: { submittedAt: registration.createdAt, items: [{ requestId: 'synthetic', recipientName: registration.recipientName!, result: kind, registration }] } })));
    expect(html('registered')).toContain('href="/rm/PDD-N-SYNTHETIC"'); expect(html('registered')).not.toContain('href="/p/'); expect(html('registered')).toContain('谢谢你帮忙登记'); expect(html('duplicate')).not.toContain('谢谢你帮忙登记');
  });
});
