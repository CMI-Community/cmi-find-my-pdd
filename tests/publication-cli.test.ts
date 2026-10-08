import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Native operational ESM is intentionally outside TS compilation.
import { independentPublicBase, publicationArguments, publicationPreview, publicationStatus, publishReviewed } from '../scripts/publications.mjs';
// @ts-expect-error Native operational ESM is intentionally outside TS compilation.
import { publicAssetPreview, uploadReviewedAsset } from '../scripts/public-assets.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const base = 'https://abcdefghijklmnopqrst.supabase.co', jwt = 'synthetic.admin.signature';
const raw = { kind: 'outreach', key: 'main', action: 'publish', expectedRevision: 0, content: { items: [] } };
describe('publication and asset operational safeguards', () => {
  it('generates a deterministic normalized review identity offline and requires exact approval plus explicit revision', async () => {
    const preview = publicationPreview(raw);
    expect(preview.artifactSha).toMatch(/^[0-9a-f]{64}$/);
    expect(publicationPreview({ content: raw.content, key: raw.key, expectedRevision: 0, action: raw.action, kind: raw.kind }).artifactSha).toBe(preview.artifactSha);
    expect(publicationArguments(['local.json'])).toEqual({ file: 'local.json', publish: false, status: false });
    expect(() => publicationArguments(['local.json', '--approved-sha=' + preview.artifactSha])).toThrow('only valid');
    const fetch = vi.fn();
    await expect(publishReviewed(raw, { publicBaseUrl: base, jwt, approvedSha: '0'.repeat(64), expectedRevision: 0, fetch })).rejects.toThrow('does not match');
    await expect(publishReviewed(raw, { publicBaseUrl: base, jwt, approvedSha: preview.artifactSha, expectedRevision: 1, fetch })).rejects.toThrow('revision');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reads the latest revision including withdrawal without publishing or exposing payloads', async () => {
    const fetch = vi.fn(async (url: string, request: RequestInit) => {
      expect(url).toBe(base + '/functions/v1/api/v1/admin/publications?kind=outreach&key=main');
      expect(request.method).toBeUndefined(); expect(request.body).toBeUndefined();
      return new Response(JSON.stringify({ data: { kind: 'outreach', key: 'main', revision: 3, action: 'withdraw', publishedAt: '2026-10-08T15:00:00Z', approvalArtifactSha: 'f'.repeat(64), payload: 'must not print' } }));
    });
    expect(await publicationStatus({ publicBaseUrl: base, jwt, kind: 'outreach', key: 'main', fetch })).toMatchObject({ revision: 3, action: 'withdraw' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(() => publicationArguments(['--status','--kind=outreach','--key=main','--publish'])).toThrow('cannot publish');
  });
  it('sends only one reviewed publication, hides transport errors and validates the receipt', async () => {
    const preview = publicationPreview(raw);
    const fetch = vi.fn(async (url: string, request: RequestInit) => {
      expect(url).toBe(base + '/functions/v1/api/v1/admin/publications');
      expect(request.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt });
      expect(JSON.parse(String(request.body))).toEqual(preview.input);
      return new Response(JSON.stringify({ data: { kind: 'outreach', key: 'main', action: 'publish', revision: 1, publishedAt: '2026-10-08T15:00:00Z', approvalArtifactSha: preview.artifactSha, private: 'must not print' } }));
    });
    const options = { publicBaseUrl: base, jwt, approvedSha: preview.artifactSha, expectedRevision: 0, fetch };
    expect(Object.keys(await publishReviewed(raw, options)).sort()).toEqual(['action', 'approvalArtifactSha', 'key', 'kind', 'publishedAt', 'revision']);
    expect(fetch).toHaveBeenCalledTimes(1);
    const failed = vi.fn(async () => { throw new Error('synthetic-secret-server-error'); });
    await expect(publishReviewed(raw, { ...options, fetch: failed })).rejects.toThrow('outcome is unknown');
    expect(failed).toHaveBeenCalledTimes(1);
    expect(() => independentPublicBase('https://osqyplgctlzdlpqmzfud.supabase.co')).toThrow('Independent');
    expect(() => independentPublicBase(base + '/functions/v1/api')).toThrow('Independent');
  });
  it('prepares synthetic public image bytes locally and requires byte-specific upload approval', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdd-public-assets-'));
    try {
      const file = path.join(directory, 'synthetic.png');
      await writeFile(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLj8AAAAASUVORK5CYII=', 'base64'));
      const preview = await publicAssetPreview(file, base), fetch = vi.fn(async () => new Response(JSON.stringify({ data: preview.summary })));
      expect(preview.summary.url).toBe(base + '/storage/v1/object/public/pdd-public-assets/' + preview.summary.key);
      await expect(uploadReviewedAsset(preview, { publicBaseUrl: base, jwt, approvedSha: '0'.repeat(64), fetch })).rejects.toThrow('does not match');
      expect(fetch).not.toHaveBeenCalled();
      expect(await uploadReviewedAsset(preview, { publicBaseUrl: base, jwt, approvedSha: preview.summary.sha256, fetch })).toMatchObject({ sha256: preview.summary.sha256 });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
