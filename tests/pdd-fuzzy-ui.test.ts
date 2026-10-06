import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PddQueryResult } from '../shared/waybill';

vi.mock('@supabase/supabase-js', () => ({ createClient: () => null }));
import { PossibleQueryDetails, PossibleRegistrationAction } from '../src/PddApp';

const possible = {
  queryId: 'synthetic-query', result: 'possible', queriedAt: '2026-10-06T14:00:00Z', record: null, registeredAt: null,
  contact: { kind: 'wechat', value: 'private_contact_sentinel' }, note: 'private_note_sentinel',
  candidates: [{ code: 'PDD-P-SYNTHETIC', tail: '3456', similarity: 88.888888889, registeredAt: '2026-10-06T13:00:00Z', number: 'private_full_number_sentinel', capability: 'private_capability_sentinel' }],
} as unknown as PddQueryResult; // Deliberately malformed extra private fields must never render.

describe('fuzzy clues without direct private disclosure', () => {
  it('shows only public clue fields and sends users to screenshot and administrator verification', () => {
    const html = renderToStaticMarkup(createElement(PossibleQueryDetails, { number: '0012?456', response: possible }));
    expect(html).toContain('0012?456');
    expect(html).toContain('PDD-P-SYNTHETIC');
    expect(html).toContain('3456');
    expect(html).toContain('88.9%');
    expect(html).toContain('字符相似度，不代表包裹归属');
    expect(html).toContain('请截图保存本页，联系 CMI 小助手');
    expect(html).not.toContain('private_');
    expect(html).not.toContain('复制联系方式');
    expect(html).not.toContain('<a');
  });
  it('offers explicit local registration only for full numbers and keeps the action disabled while saving', () => {
    const full = renderToStaticMarkup(createElement(PossibleRegistrationAction, { number: '00123456', busy: false, onRegister() {} }));
    expect(full).toContain('仍要登记这个完整单号');
    expect(full).not.toContain('disabled');
    const unknown = renderToStaticMarkup(createElement(PossibleRegistrationAction, { number: '0012*456', busy: false, onRegister() {} }));
    expect(unknown).toContain('登记需要完整单号');
    expect(unknown).not.toContain('<button');
    const busy = renderToStaticMarkup(createElement(PossibleRegistrationAction, { number: '00123456', busy: true, onRegister() {} }));
    expect(busy).toContain('disabled');
    expect(busy).toContain('正在加入待提交列表');
  });
});
