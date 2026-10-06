import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { addQueueEntry, needsDomesticWaybillReminder, newPendingBatch, newQueueEntry, pendingBatchInput, waybillInputError, waybillQueryInputError, type PendingBatch, type QueueEntry } from '../src/waybill-drafts';

vi.mock('@supabase/supabase-js', () => ({ createClient: () => null }));
import { DomesticWaybillReminder } from '../src/PddApp';

describe('confirmed JTTH query reminder', () => {
  it('blocks queue creation, stale persisted entries and retry batches in both modes and input sources', () => {
    const contact = { kind: 'wechat' as const, value: 'synthetic_owner' };
    for (const mode of ['lost', 'received'] as const) for (const source of ['manual', 'barcode'] as const) {
      const number = ' jtth 000990001 ';
      const stale: QueueEntry = { requestId: 'synthetic-invalid', number, mode, source, createdAt: '2026-10-06T00:00:00Z' };
      const valid: QueueEntry = { ...stale, requestId: 'synthetic-valid', number: 'SF000990001' };
      expect(waybillInputError(number)).toContain('集运');
      expect(waybillQueryInputError(number)).toContain('中国境内');
      expect(() => newQueueEntry(number, mode, source)).toThrow('集运');
      expect(() => addQueueEntry([], stale)).toThrow('集运');
      expect(() => newPendingBatch(mode, [valid, stale], contact)).toThrow('集运');
      const pending: PendingBatch = { id: 'synthetic-batch', capability: 'synthetic-capability', mode, items: [valid, stale], contact };
      expect(() => pendingBatchInput(pending)).toThrow('集运');
      expect(pending.items).toEqual([valid, stale]); // Reject the whole old request, never silently change its idempotent body.
      expect(pendingBatchInput({ ...pending, items: [valid] }).items[0].number).toBe(valid.number);
    }
  });
  it('recognizes only the confirmed prefix after removing whitespace and normalizing case, even before minimum-length validation', () => {
    for (const input of ['JTTH1234567890', 'jtth1234567890', '  jTtH 1234\n567890\t', '\u3000J T T H\u00a0123456', 'JTTH']) expect(needsDomesticWaybillReminder(input)).toBe(true);
    expect(waybillQueryInputError('JTTH')).toBeTruthy(); // The dedicated reminder runs before this generic validation.
    for (const input of ['JT1234567890', 'YT1234567890', 'SF1234567890', 'JTT?1234567890', 'JTT*1234567890', '00JTTH123456', 'JTT', '']) expect(needsDomesticWaybillReminder(input)).toBe(false);
  });
  it('shows the reason, domestic-number locations and one explicit return-to-edit action in the existing accessible dialog', () => {
    const html = renderToStaticMarkup(createElement(DomesticWaybillReminder, { onClose() {} }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('请填写国内快递单号');
    expect(html).toContain('可能是集运或境外配送单号');
    expect(html).toContain('包裹从中国境内寄出时的快递单号');
    expect(html).toContain('拼多多 App 的物流详情');
    expect(html).toContain('包裹面单');
    expect(html).toContain('返回修改单号');
    expect(html).not.toContain('继续查询');
  });
});
