import { describe, expect, it, vi } from 'vitest';
import { independentAdminBase, preparePublication, preparePublicFile, readPublicationStatus, submitPublication, submitPublicAsset } from '../src/public-content-admin-api';
const base = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/api';
const envelope = { kind: 'group', key: 'developer', action: 'publish', expectedRevision: 0, content: {
  title: 'PDD404TEST 项目群', invitation: '合成测试素材。', qrUrl: 'https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/pdd-public-assets/' + 'a'.repeat(64) + '.png',
  qrUpdatedAt: '2026-10-09T04:00:00Z', expiresAt: '2026-10-16T00:00:00+07:00',
} };
const status = { kind: 'group', key: 'developer', revision: 0, action: null, publishedAt: null, approvalArtifactSha: null } as const;
describe('administrator public content transport', () => {
  it('keeps preparation offline and rejects business/foreign targets', async () => {
    const review = await preparePublication(envelope, base);
    expect(review.sha).toMatch(/^[0-9a-f]{64}$/); expect(review.input.approvalArtifactSha).toBe(review.sha);
    expect(() => independentAdminBase('https://osqyplgctlzdlpqmzfud.supabase.co/functions/v1/api')).toThrow();
    expect(() => independentAdminBase(base + '?token=secret')).toThrow();
    await expect(preparePublication({ ...envelope, privateNote: 'never send' }, base)).rejects.toThrow();
    await expect(preparePublication({ ...envelope, content: { ...envelope.content, qrUrl: 'https://another.example/image.png' } }, base)).rejects.toThrow();
  });
  it('does not send a mismatch or an assumed revision', async () => {
    const review = await preparePublication(envelope, base), transport = vi.fn();
    await expect(submitPublication(review, status, '0'.repeat(64), { apiBase: base, token: 'synthetic', fetch: transport })).rejects.toThrow();
    await expect(submitPublication(review, { ...status, revision: 1 }, review.sha, { apiBase: base, token: 'synthetic', fetch: transport })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it('uses the current administrator header and projects the exact receipt', async () => {
    const review = await preparePublication(envelope, base);
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: { ...status, revision: 1, action: 'publish', publishedAt: '2026-10-09T04:00:00Z', approvalArtifactSha: review.sha, secret: 'drop' } }), { status: 201 }));
    const result = await submitPublication(review, status, review.sha, { apiBase: base, token: 'PDD404TEST-session', fetch: transport });
    expect(result).not.toHaveProperty('secret'); expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0]; expect(url).toBe(base + '/v1/admin/publications');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer PDD404TEST-session'); expect(url).not.toContain('session');
  });
  it('retains unknown outcome without retrying or provider error exposure', async () => {
    const review = await preparePublication(envelope, base), transport = vi.fn<typeof fetch>().mockRejectedValue(new Error('private platform response'));
    await expect(submitPublication(review, status, review.sha, { apiBase: base, token: 'synthetic', fetch: transport })).rejects.toThrow('结果未知');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('checks withdrawal status and rejects malformed success receipts', async () => {
    const review = await preparePublication(envelope, base);
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: { ...status, revision: 2, action: 'withdraw', publishedAt: '2026-10-09T04:00:00Z', approvalArtifactSha: 'b'.repeat(64) } })));
    expect((await readPublicationStatus(review.input, { apiBase: base, token: 'synthetic', fetch: transport })).action).toBe('withdraw');
    transport.mockResolvedValue(new Response(JSON.stringify({ data: { ...status, revision: 1, action: 'publish', publishedAt: 'bad', approvalArtifactSha: review.sha } })));
    await expect(submitPublication(review, status, review.sha, { apiBase: base, token: 'synthetic', fetch: transport })).rejects.toThrow('回执');
  });
  it('uploads immutable reviewed bytes once and verifies all asset identity fields', async () => {
    const asset = await preparePublicFile(new File([new Uint8Array([1, 2, 3])], 'PDD404TEST.png', { type: 'image/png' }));
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: { url: independentAdminBase(base) + '/storage/v1/object/public/pdd-public-assets/' + asset.key, sha256: asset.sha, key: asset.key, bytes: 3, mime: 'image/png' } }), { status: 201 }));
    expect((await submitPublicAsset(asset, asset.sha, { apiBase: base, token: 'synthetic', fetch: transport })).bytes).toBe(3);
    expect(transport).toHaveBeenCalledTimes(1);
    await expect(preparePublicFile(new File(['secret'], 'unsafe.txt', { type: 'text/plain' }))).rejects.toThrow();
  });
});
