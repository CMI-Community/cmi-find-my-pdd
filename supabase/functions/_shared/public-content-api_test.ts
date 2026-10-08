import { publicAssetMetadataMatches, publicContentRoute, publicHistory, publicOutreach, publicReports } from './public-content-api.ts';
import { ApiError } from './http.ts';
import { sha256 } from './security.ts';
import { canonicalPublicationArtifact, validatePublicationInput, type PublicationInput } from '../../../shared/public-content.ts';
function assert(value: unknown): asserts value { if (!value) throw new Error('assertion failed'); }
const actor = '10000000-0000-4000-8000-000000000041', stamp = '2026-10-08T13:00:00Z';
const base = 'https://abcdefghijklmnopqrst.supabase.co';
const report = { date: '2026-10-08', title: 'Synthetic observation', summary: 'Records, not people', asOf: stamp, window: 'Bangkok partial day', findings: [{ title: 'An observation', observed: 'An aggregate signal', interpretation: 'A possible explanation', unknown: 'Offline progress unknown', helpUrl: '/help#registration' }], newsIds: [], limitations: ['Synthetic fixture'] };
const six = { lostRegistered: 3, receivedRegistered: 1, matchedParcels: 0, lostRecipientRegistered: 1, receivedRecipientRegistered: 1, matchedRecipientLeads: 0 };
const request = (url: string, input?: unknown) => new Request('https://pdd404.app/v1/' + url, input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
async function approved(input: Partial<PublicationInput> = {}): Promise<PublicationInput> {
  const value = validatePublicationInput({ kind: 'insight', key: report.date, action: 'publish', expectedRevision: 0, content: report, approvalArtifactSha: '0'.repeat(64), ...input }, base);
  value.approvalArtifactSha = await sha256(canonicalPublicationArtifact(value)); return value;
}
async function rejects(run: () => Promise<unknown> | unknown, code: string) { try { await run(); } catch (error) { assert(error instanceof ApiError && error.code === code); return; } throw new Error('expected ' + code); }
const context = () => ({ admin: async () => actor, publicBaseUrl: base, assetExists: async (_url: string) => false, rpc: async (_name: string, _payload: Record<string, any>): Promise<Record<string, any>> => { throw new Error('unexpected rpc'); } });

Deno.test('public content reads project allowlisted aggregates and approved revisions without actor or audit hashes', async () => {
  const history = publicHistory({ snapshots: [{ day: report.date, sampledAt: stamp, metricVersion: 'home-six-lifetime-v1', stats: { ...six, number: 'private' }, secret: 'private' }], actorId: actor });
  assert(Object.keys(history).join(',') === 'snapshots' && Object.keys(history.snapshots[0]).sort().join(',') === 'day,metricVersion,sampledAt,stats');
  assert(Object.keys(history.snapshots[0].stats).length === 6 && !JSON.stringify(history).includes('private'));
  const reports = publicReports({ reports: [{ key: report.date, revision: 1, publishedAt: stamp, content: report, actorId: actor, approvalArtifactSha: 'private' }], nextOffset: null, secret: 'private' });
  assert(!JSON.stringify(reports).includes('private') && !JSON.stringify(reports).includes(actor));
  const outreach = publicOutreach({ catalog: null, developerGroup: null, secret: 'private' }, base);
  assert(JSON.stringify(outreach) === '{"catalog":null,"developerGroup":null}');
  await rejects(() => publicHistory({ snapshots: [{ day: report.date, sampledAt: stamp, metricVersion: 'home-six-lifetime-v1', stats: { lostRegistered: 0 } }] }), 'SERVICE_UNAVAILABLE');
  await rejects(() => publicReports({ reports: [{ key: report.date, revision: 1, publishedAt: stamp, content: { ...report, recipientName: 'private' } }], nextOffset: null }), 'SERVICE_UNAVAILABLE');
});
Deno.test('public history and report requests reject excessive/repeated dates before any data read', async () => {
  const ctx = context(); let reads = 0; ctx.rpc = async (name, input) => { reads++; if (name === 'pdd_public_stats_history') { assert(input.days === 7); return { snapshots: [] }; } assert(name === 'pdd_public_insight_reports' && input.date === report.date && input.offset === 0); return { reports: [], nextOffset: null }; };
  await publicContentRoute(request('insights/history?days=7'), ['insights', 'history'], {}, ctx);
  await publicContentRoute(request('insights/reports?date=2026-10-08'), ['insights', 'reports'], {}, ctx);
  for (const suffix of ['days=91', 'days=0', 'days=7&days=7', 'includePrivate=true']) await rejects(() => publicContentRoute(request('insights/history?' + suffix), ['insights', 'history'], {}, ctx), 'INVALID_REQUEST');
  for (const suffix of ['date=2026-02-30', 'offset=1&date=2026-10-08', 'offset=-1', 'offset=100001', 'date=2026-10-08&date=2026-10-08']) await rejects(() => publicContentRoute(request('insights/reports?' + suffix), ['insights', 'reports'], {}, ctx), 'INVALID_REQUEST');
  assert(reads === 2);
});
Deno.test('publication authenticates before reading approval payload and rejects forged or changed artifacts', async () => {
  const input = await approved(), ctx = context();
  ctx.admin = async () => { throw new ApiError('FORBIDDEN', 'admin only', 403); };
  await rejects(() => publicContentRoute(request('admin/publications', input), ['admin', 'publications'], {}, ctx), 'FORBIDDEN');
  ctx.admin = async () => actor;
  await rejects(() => publicContentRoute(request('admin/publications', { ...input, content: { ...report, title: 'Changed after approval' } }), ['admin', 'publications'], {}, ctx), 'ARTIFACT_MISMATCH');
  await rejects(() => publicContentRoute(request('admin/publications', { ...input, actor_id: actor }), ['admin', 'publications'], {}, ctx), 'INVALID_REQUEST');
  await rejects(() => publicContentRoute(request('admin/publications', { ...input, content: { ...report, findings: [{ ...report.findings[0], helpUrl: '/m/private' }] } }), ['admin', 'publications'], {}, ctx), 'INVALID_REQUEST');
});
Deno.test('publication binds the approved actor/hash/revision and projects only its receipt', async () => {
  const input = await approved(), ctx = context(); let writes = 0;
  ctx.rpc = async (name, payload) => {
    writes++; assert(name === 'pdd_publish_content' && payload.actor_id === actor && payload.expected_revision === 0 && payload.approval_artifact_sha === input.approvalArtifactSha);
    return { kind: input.kind, key: input.key, revision: 1, action: input.action, publishedAt: stamp, approvalArtifactSha: input.approvalArtifactSha, actorId: actor, secret: 'private' };
  };
  const response = await publicContentRoute(request('admin/publications', input), ['admin', 'publications'], {}, ctx);
  const value = (await response!.json()).data;
  assert(response!.status === 201 && writes === 1 && Object.keys(value).sort().join(',') === 'action,approvalArtifactSha,key,kind,publishedAt,revision');
});
Deno.test('administrator status is read-only and retains withdrawn versions for reconciliation', async () => {
  const ctx = context(); let calls = 0;
  ctx.admin = async () => { throw new ApiError('FORBIDDEN', 'admin only', 403); };
  await rejects(() => publicContentRoute(request('admin/publications?kind=group&key=developer'), ['admin', 'publications'], {}, ctx), 'FORBIDDEN');
  ctx.admin = async () => actor;
  ctx.rpc = async (name, payload) => { calls++; assert(name === 'pdd_admin_publication_status' && payload.kind === 'group' && payload.key === 'developer'); return { kind: 'group', key: 'developer', revision: 0, action: null, publishedAt: null, approvalArtifactSha: null, payload: 'private', actor }; };
  const first = await publicContentRoute(request('admin/publications?kind=group&key=developer'), ['admin', 'publications'], {}, ctx);
  const data = (await first!.json()).data; assert(data.revision === 0 && data.action === null && !('payload' in data) && !('actor' in data));
  ctx.rpc = async () => ({ kind: 'group', key: 'developer', revision: 2, action: 'withdraw', publishedAt: stamp, approvalArtifactSha: 'a'.repeat(64), payload: 'private', actor });
  const withdrawn = await publicContentRoute(request('admin/publications?kind=group&key=developer'), ['admin', 'publications'], {}, ctx);
  assert((await withdrawn!.json()).data.revision === 2 && calls === 1);
  await rejects(() => publicContentRoute(request('admin/publications?kind=group&key=developer&key=developer'), ['admin', 'publications'], {}, ctx), 'INVALID_REQUEST');
});
Deno.test('group publication requires an existing immutable asset on the dedicated instance', async () => {
  const qr = base + '/storage/v1/object/public/pdd-public-assets/' + 'a'.repeat(64) + '.png';
  const input = await approved({ kind: 'group', key: 'developer', content: { title: 'Synthetic project group', invitation: 'Discussion of features and community outreach', qrUrl: qr, qrUpdatedAt: stamp, expiresAt: null } });
  const ctx = context(); let checks = 0; ctx.assetExists = async url => { checks++; assert(url === qr); return false; };
  await rejects(() => publicContentRoute(request('admin/publications', input), ['admin', 'publications'], {}, ctx), 'INVALID_ASSET');
  assert(checks === 1);
  for (const url of [qr + '?token=private', qr.replace('pdd-public-assets', 'parcel-originals'), qr.replace('abcdefghijklmnopqrst', 'zzzzzzzzzzzzzzzzzzzz'), 'https://pdd404.app/m/private#secret']) {
    await rejects(() => publicContentRoute(request('admin/publications', { ...input, content: { ...input.content, qrUrl: url } }), ['admin', 'publications'], {}, ctx), 'INVALID_REQUEST');
  }
});
Deno.test('approved PDD404 explanation comics require an uploaded asset and remain separate from third-party news', async () => {
  const url = base + '/storage/v1/object/public/pdd-public-assets/' + 'b'.repeat(64) + '.webp';
  const item = { id: 'synthetic-explanation', kind: 'comic' as const, origin: 'pdd404' as const, title: 'Synthetic guide comic', summary: 'How to use this website', source: 'PDD404', sourceUrl: null, publishedAt: null, checkedAt: stamp, channels: ['Community chat'], thumbnailUrl: url, downloadUrl: url, copyText: null };
  const input = await approved({ kind: 'outreach', key: 'main', content: { items: [item] } });
  const ctx = context(); let checks = 0;
  ctx.assetExists = async checkedUrl => { checks++; assert(checkedUrl === url); return true; };
  ctx.rpc = async (name, payload) => { assert(name === 'pdd_publish_content' && payload.content.items[0].kind === 'comic'); return { kind: 'outreach', key: 'main', revision: 1, action: 'publish', publishedAt: stamp, approvalArtifactSha: input.approvalArtifactSha }; };
  assert((await publicContentRoute(request('admin/publications', input), ['admin', 'publications'], {}, ctx))!.status === 201 && checks === 1);
  const read = publicOutreach({ catalog: { key: 'main', revision: 1, publishedAt: stamp, content: input.content }, developerGroup: null }, base);
  assert(read.catalog!.content.items[0].kind === 'comic');
  for (const changed of [{ ...item, downloadUrl: null }, { ...item, origin: 'third-party', sourceUrl: 'https://example.com/story' }]) {
    await rejects(() => publicContentRoute(request('admin/publications', { ...input, content: { items: [changed] } }), ['admin', 'publications'], {}, ctx), 'INVALID_REQUEST');
  }
});
Deno.test('publication verifies immutable asset extension against storage MIME and a bounded nonempty size', () => {
  const url = base + '/storage/v1/object/public/pdd-public-assets/' + 'c'.repeat(64);
  assert(publicAssetMetadataMatches(url + '.webp', { contentType: 'image/webp', size: 1234 }));
  assert(publicAssetMetadataMatches(url + '.zip', { contentType: 'application/zip', size: 5 * 1024 * 1024 }));
  for (const metadata of [null, {}, { contentType: 'image/png', size: 1234 }, { contentType: 'image/webp', size: 0 }, { contentType: 'image/webp', size: 5 * 1024 * 1024 + 1 }, { contentType: 'image/webp', size: '1234' }]) assert(!publicAssetMetadataMatches(url + '.webp', metadata));
  assert(!publicAssetMetadataMatches(url + '.pdf', { contentType: 'application/pdf', size: 1234 }));
});
