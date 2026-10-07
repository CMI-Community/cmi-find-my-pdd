import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => ({ createClient: () => null }));
import { BatchNoteField, HomeStats, WaybillNote } from '../src/PddApp';

describe('registration notes and truthful public totals', () => {
  it('shows local note text safely with its visibility explanation and Unicode character count', () => {
    const html = renderToStaticMarkup(createElement(BatchNoteField, { value: '📦'.repeat(500), disabled: true, onChange() {} }));
    expect(html).toContain('补充说明（选填）');
    expect(html).toContain('500/500字');
    expect(html).toContain('本次所有单号使用同一条备注');
    expect(html).toContain('对方查到包裹时会与联系方式一起显示');
    expect(html.match(/<textarea\b[^>]*>/)?.[0]).toContain('disabled');
    expect(html.match(/<textarea\b[^>]*>/)?.[0]).toContain('aria-describedby');
  });
  it('renders opposing and private notes as escaped text and omits absent legacy notes', () => {
    expect(renderToStaticMarkup(createElement(WaybillNote, {}))).toBe('');
    expect(renderToStaticMarkup(createElement(WaybillNote, { note: null }))).toBe('');
    const html = renderToStaticMarkup(createElement(WaybillNote, { note: '<img src=x onerror=alert(1)>\n晚上领取', label: '对方备注' }));
    expect(html).toContain('对方备注');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
    expect(html).toContain('\n晚上领取');
  });
  it('never substitutes zeros for loading or failed totals', () => {
    const loading = renderToStaticMarkup(createElement(HomeStats, { stats: null, loading: true, error: '', onRefresh() {} }));
    expect(loading).toContain('正在读取真实登记统计');
    expect(loading).not.toContain('<dd>');
    const failed = renderToStaticMarkup(createElement(HomeStats, { stats: null, loading: false, error: 'synthetic network failure', onRefresh() {} }));
    expect(failed).toContain('统计暂时无法读取');
    expect(failed).toContain('重试读取');
    expect(failed).not.toContain('<dd>');
  });
  it('shows genuine zero counts and marks previous successful totals as stale after failure', () => {
    const html = renderToStaticMarkup(createElement(HomeStats, { stats: { lostRegistered: 0, receivedRegistered: 1200, matchedParcels: 7, lostRecipientRegistered: 4, receivedRecipientRegistered: 8, matchedRecipientLeads: 2 }, loading: false, error: 'synthetic timeout', onRefresh() {} }));
    expect(html).toContain('pdd-stat-number">0</span>');
    expect(html).toContain('1,200');
    expect(html.match(/<dd>/g)).toHaveLength(6);
    for (const label of ['快递单号', '收件人名', '找包裹的单号', '找失主的单号', '已匹配包裹', '找包裹的姓名线索', '找失主的姓名线索', '已匹配姓名线索']) expect(html).toContain(label);
    expect(html.match(/pdd-stat-unit">条/g)).toHaveLength(5);
    expect(html).toContain('pdd-stat-unit">件');
    expect(html).not.toContain('多收');
    expect(html).toContain('上方为最近一次读取的数字');
  });
});
