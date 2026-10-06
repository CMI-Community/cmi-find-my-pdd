import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/api', async importOriginal => ({ ...await importOriginal<typeof import('../src/api')>(), request: vi.fn() }));
import { request } from '../src/api';
import { pddApi } from '../src/pdd-api';

const mockedRequest = vi.mocked(request);
beforeEach(() => { mockedRequest.mockReset(); });

describe('PDD404 new public and administrator API contracts', () => {
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
