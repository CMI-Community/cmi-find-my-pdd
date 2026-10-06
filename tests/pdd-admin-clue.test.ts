import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PddAdminDetail } from '../shared/waybill';

vi.mock('@supabase/supabase-js', () => ({ createClient: () => null }));
import { AdminClueLookupForm, adminClueLookupError, createAdminDetailLookup, normalizeAdminClueCode } from '../src/PddApp';

const detail = { record: { code: 'PDD-A123456789BC' }, registrations: [], queries: [], events: [] } as unknown as PddAdminDetail;
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(fetchDetail = vi.fn(async (_token: string, _code: string) => detail)) {
  let token = 'synthetic-admin-token';
  const callbacks = { isCurrentToken: (value: string) => value === token, onStart: vi.fn(), onDetail: vi.fn(), onError: vi.fn(), onLoading: vi.fn() };
  const lookup = createAdminDetailLookup(fetchDetail, callbacks);
  return { lookup, fetchDetail, callbacks, token, changeToken: (value: string) => { token = value; } };
}

describe('administrator lookup by public clue number', () => {
  it('normalizes a screenshot code while rejecting numbers, registration codes and incomplete clues before an API call', async () => {
    expect(normalizeAdminClueCode('  pdd-a123456789bc\n')).toBe('PDD-A123456789BC');
    const value = fixture();
    for (const input of ['', '123456789012', 'PDD-R-A123456789BC', 'PDD-A12345', 'PDD-A123456789GZ']) await value.lookup.open(value.token, input);
    expect(value.fetchDetail).not.toHaveBeenCalled();
    expect(value.callbacks.onError).toHaveBeenCalledTimes(5);
    await value.lookup.open(value.token, ' pdd-a123456789bc ');
    expect(value.fetchDetail).toHaveBeenCalledWith(value.token, 'PDD-A123456789BC');
    expect(value.callbacks.onDetail).toHaveBeenCalledWith(detail);
    expect(value.callbacks.onLoading.mock.calls).toEqual([[true], [false]]);
  });
  it('blocks duplicate requests and does not revive a closed detail or clear a newer request busy state', async () => {
    const first = deferred<PddAdminDetail>(), second = deferred<PddAdminDetail>();
    const fetchDetail = vi.fn<(token: string, code: string) => Promise<PddAdminDetail>>().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const value = fixture(fetchDetail);
    const oldRequest = value.lookup.open(value.token, 'PDD-A123456789BC');
    await value.lookup.open(value.token, 'PDD-A123456789BC');
    expect(fetchDetail).toHaveBeenCalledTimes(1);
    value.lookup.cancel();
    const newRequest = value.lookup.open(value.token, 'PDD-123456789ABC');
    first.resolve(detail); await oldRequest;
    expect(value.callbacks.onDetail).not.toHaveBeenCalled();
    expect(value.callbacks.onLoading.mock.calls).toEqual([[true], [false], [true]]);
    second.resolve(detail); await newRequest;
    expect(value.callbacks.onDetail).toHaveBeenCalledTimes(1);
    expect(value.callbacks.onLoading.mock.calls.at(-1)).toEqual([false]);
  });
  it('keeps late success and errors from a previous session out of the workbench', async () => {
    for (const fail of [false, true]) {
      const pending = deferred<PddAdminDetail>();
      const value = fixture(vi.fn(() => pending.promise));
      const request = value.lookup.open(value.token, 'PDD-A123456789BC');
      value.changeToken('another-synthetic-session');
      if (fail) pending.reject(new Error('stale failure')); else pending.resolve(detail);
      await request;
      expect(value.callbacks.onDetail).not.toHaveBeenCalled();
      expect(value.callbacks.onError).not.toHaveBeenCalled();
      await value.lookup.open(value.token, 'PDD-A123456789BC');
      expect(value.fetchDetail).toHaveBeenCalledTimes(1);
    }
  });
  it('reports missing records clearly and allows a fresh attempt after failure', async () => {
    const fetchDetail = vi.fn<(token: string, code: string) => Promise<PddAdminDetail>>().mockRejectedValueOnce({ code: 'RECORD_NOT_FOUND', message: 'internal detail' }).mockResolvedValue(detail);
    const value = fixture(fetchDetail);
    await value.lookup.open(value.token, 'PDD-A123456789BC');
    expect(value.callbacks.onError).toHaveBeenCalledWith('没有找到这个线索编号。请核对截图中的完整编号后重试。');
    expect(value.callbacks.onLoading.mock.calls.at(-1)).toEqual([false]);
    await value.lookup.open(value.token, 'PDD-A123456789BC');
    expect(value.callbacks.onDetail).toHaveBeenCalledWith(detail);
    expect(adminClueLookupError(new Error('网络连接失败，请检查网络后重试。'))).toContain('登记详情读取失败');
  });
  it('labels the public-code field and provides a usable cancel action while loading', () => {
    const props = { value: 'PDD-A123456789BC', busy: false, loading: false, onChange() {}, onSubmit() {}, onCancel() {} };
    const html = renderToStaticMarkup(createElement(AdminClueLookupForm, props));
    const inputId = html.match(/<input id="([^"]+)"/)?.[1];
    expect(inputId).toBeTruthy();
    expect(html).toContain('for="' + inputId + '"');
    expect(html).toContain('按线索编号查看登记');
    expect(html).not.toContain('取消读取');
    const loading = renderToStaticMarkup(createElement(AdminClueLookupForm, { ...props, busy: true, loading: true }));
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toMatch(/<input[^>]+disabled=""/);
    expect(loading).toMatch(/<button[^>]+disabled="">正在查看/);
    expect(loading).toMatch(/<button type="button"[^>]*>取消读取<\/button>/);
  });
});
