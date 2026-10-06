import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { needsDomesticWaybillReminder, waybillQueryInputError } from '../src/waybill-drafts';

vi.mock('@supabase/supabase-js', () => ({ createClient: () => null }));
import { DomesticWaybillReminder } from '../src/PddApp';

describe('confirmed JTTH query reminder', () => {
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
