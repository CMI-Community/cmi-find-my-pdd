import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/api', async importOriginal => ({ ...await importOriginal<typeof import('../src/api')>(), request: vi.fn() }));
import { request } from '../src/api';
import { pddApi } from '../src/pdd-api';
import type { PddQueryResult } from '../shared/waybill';

const mockedRequest = vi.mocked(request);
beforeEach(() => { mockedRequest.mockReset(); });

describe('PDD404 new public and administrator API contracts', () => {
  it('explicitly opts in to safe fuzzy clues and strips private or unexpected fields from possible results', async () => {
    const input = { queryId: 'synthetic-query', number: '0012?456', mode: 'lost' as const, source: 'manual' as const };
    mockedRequest.mockResolvedValueOnce({ queryId: input.queryId, result: 'possible', queriedAt: '2026-10-06T14:00:00Z', record: { number: 'private_number' }, registeredAt: 'private_time', contact: { kind: 'wechat', value: 'private_contact' }, note: 'private_note', capability: 'private_capability', candidates: [{ code: 'PDD-P-SYNTHETIC', tail: '3456', similarity: 87.5, registeredAt: '2026-10-06T13:00:00Z', number: 'private_number', contact: 'private_contact' }] });
    const result = await pddApi.query(input, 'synthetic-capability');
    expect(mockedRequest).toHaveBeenLastCalledWith('/v1/waybill-queries', { method: 'POST', body: { ...input, allowPossible: true }, cap: 'synthetic-capability', key: input.queryId });
    expect(result.contact).toBeNull();
    expect(result.note).toBeNull();
    expect(result.record).toBeNull();
    expect(result.registeredAt).toBeNull();
    expect(result.candidates).toEqual([{ code: 'PDD-P-SYNTHETIC', tail: '3456', similarity: 87.5, registeredAt: '2026-10-06T13:00:00Z' }]);
    expect(JSON.stringify(result)).not.toContain('private_');
  });
  it('does not present threshold-boundary, exact or unmasked results as fuzzy candidates', async () => {
    const base = { queryId: 'synthetic-query', result: 'possible', queriedAt: '2026-10-06T14:00:00Z', record: null, registeredAt: null, contact: null, note: null };
    for (const candidate of [{ code: 'PDD-P-SYNTHETIC', tail: '3456', similarity: 70, registeredAt: '2026-10-06T13:00:00Z' }, { code: 'PDD-P-SYNTHETIC', tail: '3456', similarity: 100, registeredAt: '2026-10-06T13:00:00Z' }, { code: 'PDD-P-SYNTHETIC', tail: '00123456', similarity: 90, registeredAt: '2026-10-06T13:00:00Z' }]) {
      mockedRequest.mockResolvedValueOnce({ ...base, candidates: [candidate] });
      await expect(pddApi.query({ queryId: base.queryId, number: '0012?456', mode: 'lost', source: 'manual' }, 'synthetic-capability')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
  });
  it('keeps exact matching contacts and notes available under the existing query contract', async () => {
    const exact = { queryId: 'synthetic-query', result: 'matched', queriedAt: '2026-10-06T14:00:00Z', record: null, registeredAt: '2026-10-06T13:00:00Z', contact: { kind: 'wechat', value: 'synthetic_user' }, note: '晚上领取', candidates: [] } as PddQueryResult;
    mockedRequest.mockResolvedValueOnce(exact);
    expect(await pddApi.query({ queryId: exact.queryId, number: '00123456', mode: 'lost', source: 'manual' }, 'synthetic-capability')).toBe(exact);
  });
  it('reads only validated cumulative counts and rejects malformed data instead of showing zeros', async () => {
    mockedRequest.mockResolvedValueOnce({ lostRegistered: 3, receivedRegistered: 4, matchedParcels: 2, internal: 'synthetic' });
    expect(await pddApi.stats()).toEqual({ lostRegistered: 3, receivedRegistered: 4, matchedParcels: 2 });
    expect(mockedRequest).toHaveBeenCalledWith('/v1/waybill-stats', {});
    for (const invalid of [{ lostRegistered: -1, receivedRegistered: 0, matchedParcels: 0 }, { lostRegistered: 0, receivedRegistered: '2', matchedParcels: 0 }, { lostRegistered: 0, receivedRegistered: 0 }]) {
      mockedRequest.mockResolvedValueOnce(invalid);
      await expect(pddApi.stats()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
  });
  it('sends feedback with a stable request ID and no browser capability or administrator token', async () => {
    const input = { message: 'synthetic feedback' }, receipt = { submitted: true, feedbackId: 'synthetic-id', submittedAt: '2026-10-06T14:00:00Z' };
    mockedRequest.mockResolvedValueOnce(receipt);
    expect(await pddApi.submitFeedback(input, 'synthetic-request')).toBe(receipt);
    expect(mockedRequest).toHaveBeenCalledWith('/v1/feedback', { method: 'POST', body: input, key: 'synthetic-request' });
  });
  it('keeps administrator feedback retrieval and status changes behind the administrator token', async () => {
    mockedRequest.mockResolvedValue({});
    await pddApi.adminFeedbackList('synthetic-token', 50, 'reviewed');
    expect(mockedRequest).toHaveBeenLastCalledWith('/v1/admin/feedback?offset=50&status=reviewed', { token: 'synthetic-token' });
    await pddApi.adminFeedbackUpdate('synthetic/id', 'closed', 'synthetic-token');
    expect(mockedRequest).toHaveBeenLastCalledWith('/v1/admin/feedback/synthetic%2Fid', { method: 'PATCH', body: { status: 'closed' }, token: 'synthetic-token' });
  });
  it('changes only the contact when managing a registration, preserving its existing note', async () => {
    mockedRequest.mockResolvedValue({});
    const contact = { kind: 'wechat' as const, value: 'synthetic_user' };
    await pddApi.updateContact('synthetic-registration', 2, contact, 'synthetic-capability');
    expect(mockedRequest).toHaveBeenLastCalledWith('/v1/waybill-manage/synthetic-registration', { method: 'PATCH', body: { revision: 2, contact }, cap: 'synthetic-capability' });
  });
});
