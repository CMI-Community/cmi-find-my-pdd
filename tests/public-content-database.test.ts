import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { canonicalPublicationArtifact, validatePublicationInput, type PublicationInput } from '../shared/public-content.ts';
const directory = new URL('../supabase/migrations/', import.meta.url), actor = randomUUID();
let db: PGlite;
beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create schema extensions; create role anon; create role authenticated; create role service_role bypassrls;
  create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
  create schema net; create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as 'select 1::bigint';
  create schema cron; create table cron.test_jobs(name text, schedule text, command text);
  create function cron.schedule(job_name text,schedule text,command text) returns bigint language plpgsql as 'begin insert into cron.test_jobs values(job_name,schedule,command); return 1; end';`);
  for (const name of (await readdir(directory)).filter(name => /^\d+_.+\.sql$/.test(name)).sort()) await db.exec((await readFile(new URL(name, directory), 'utf8')).replace(/^create extension if not exists pg_net.*$/m, '').replace(/^create extension if not exists pg_cron.*$/m, ''));
}, 30_000);
beforeEach(async () => { await db.exec('begin;'); });
afterEach(async () => { await db.exec('rollback; reset role;'); });
afterAll(async () => { await db?.close(); });
async function rpc<T = Record<string, any>>(name: string, payload: Record<string, unknown> = {}): Promise<T> { return (await db.query<{ value: T }>(`select public.${name}($1::jsonb) value`, [JSON.stringify(payload)])).rows[0].value; }
async function rejection(run: () => Promise<unknown>, message: string) {
  await db.exec('savepoint expected_failure;');
  try { await expect(run()).rejects.toThrow(message); } finally { await db.exec('rollback to savepoint expected_failure;'); }
}
function report(date: string) { return { date, title: '合成社区观察', summary: '数字表示记录，不是人数。', asOf: date + 'T13:00:00Z', window: '曼谷当日00:00至采样时刻', findings: [{ title: 'Synthetic observation', observed: 'Formal records only', interpretation: 'A possible explanation', unknown: 'Offline progress remains unknown', helpUrl: '/help#registration' }], newsIds: [] as string[], limitations: ['Synthetic test evidence'] }; }
function publishPayload(options: Partial<PublicationInput> = {}) {
  const input = validatePublicationInput({ kind: 'insight', key: '2020-01-01', action: 'publish', expectedRevision: 0, content: report('2020-01-01'), approvalArtifactSha: '0'.repeat(64), ...options });
  const approval_artifact_sha = createHash('sha256').update(canonicalPublicationArtifact(input)).digest('hex');
  return { kind: input.kind, key: input.key, action: input.action, expected_revision: input.expectedRevision, content: input.content, actor_id: actor, approval_artifact_sha };
}

describe('public insight snapshots and reviewed publication transactions', () => {
  it('captures only the existing six counter definition with server time and keeps same-day history immutable', async () => {
    await rpc('pdd_batch_register', { request_id: randomUUID(), mode: 'lost', contact: { kind: 'wechat', value: 'synthetic_public_person' }, capability_hash: 'a'.repeat(64), body_hash: 'synthetic', items: [{ request_id: randomUUID(), number: 'PDD404TESTSNAP01', source: 'manual' }] });
    const counters = await rpc('pdd_home_stats'), first = await rpc('pdd_capture_stats_daily');
    expect(first.stats).toEqual(counters); expect(first.metricVersion).toBe('home-six-lifetime-v1');
    expect(Object.keys(first).sort()).toEqual(['day', 'metricVersion', 'sampledAt', 'stats']);
    await rpc('pdd_batch_register', { request_id: randomUUID(), mode: 'received', contact: { kind: 'wechat', value: 'synthetic_public_holder' }, capability_hash: 'b'.repeat(64), body_hash: 'second', items: [{ request_id: randomUUID(), number: 'PDD404TESTSNAP02', source: 'manual' }] });
    expect(await rpc('pdd_capture_stats_daily')).toEqual(first);
    expect((await rpc('pdd_home_stats')).receivedRegistered).toBe(1);
    expect((await rpc('pdd_public_stats_history', { days: 7 })).snapshots).toEqual([first]);
    await rejection(() => rpc('pdd_capture_stats_daily', { day: '2020-01-01', stats: counters }), 'INVALID_REQUEST');
    await rejection(() => db.exec("update public.pdd_stats_daily set sampled_at=sampled_at+interval '1 second'"), 'IMMUTABLE_HISTORY');
  });
  it('bounds history and keeps empty content distinct from zero metrics', async () => {
    expect(await rpc('pdd_public_stats_history')).toEqual({ snapshots: [] });
    expect(await rpc('pdd_public_insight_reports')).toEqual({ reports: [], nextOffset: null });
    expect(await rpc('pdd_public_outreach')).toEqual({ catalog: null, developerGroup: null });
    expect(await rpc('pdd_admin_publication_status', { kind: 'outreach', key: 'main' })).toEqual({ kind: 'outreach', key: 'main', revision: 0, action: null, publishedAt: null, approvalArtifactSha: null });
    for (const input of [{ days: 0 }, { days: 91 }, { days: '7' }, { days: 7, number: 'private' }]) await rejection(() => rpc('pdd_public_stats_history', input), 'INVALID_REQUEST');
    await rejection(() => rpc('pdd_public_insight_reports', { date: '2026-02-30' }), 'INVALID_REQUEST');
  });
  it('binds exact approved bytes including Chinese copy and audits the verified actor before any public version appears', async () => {
    const input = publishPayload(), result = await rpc('pdd_publish_content', input);
    expect(result).toMatchObject({ kind: 'insight', key: '2020-01-01', revision: 1, action: 'publish', approvalArtifactSha: input.approval_artifact_sha });
    const stored = (await db.query<{ actor_id: string; approval_artifact_sha: string }>('select * from public.pdd_content_revisions')).rows[0];
    expect(stored.actor_id).toBe(actor); expect(stored.approval_artifact_sha).toBe(input.approval_artifact_sha);
    const read = await rpc('pdd_public_insight_reports', { date: '2020-01-01' });
    expect(read.reports[0].content).toEqual(input.content);
    expect(Object.keys(read.reports[0]).sort()).toEqual(['content', 'key', 'publishedAt', 'revision']);
    expect(JSON.stringify(read)).not.toContain(actor); expect(JSON.stringify(read)).not.toContain(input.approval_artifact_sha);
    await rejection(() => rpc('pdd_publish_content', { ...input, content: { ...input.content, title: 'Changed after review' } }), 'ARTIFACT_MISMATCH');
    await rejection(() => rpc('pdd_publish_content', input), 'VERSION_CONFLICT');
    expect((await db.query<{ count: number }>('select count(*) count from public.pdd_content_revisions')).rows[0].count).toBe(1);
  });
  it('appends revisions and withdrawal tombstones without resurrecting a formerly public report', async () => {
    await rpc('pdd_publish_content', publishPayload());
    await rpc('pdd_publish_content', publishPayload({ expectedRevision: 1, content: { ...report('2020-01-01'), title: 'Reviewed correction' } }));
    expect((await rpc('pdd_public_insight_reports')).reports[0].revision).toBe(2);
    await rpc('pdd_publish_content', publishPayload({ expectedRevision: 2, action: 'withdraw', content: null }));
    expect(await rpc('pdd_public_insight_reports')).toEqual({ reports: [], nextOffset: null });
    const status = await rpc('pdd_admin_publication_status', { kind: 'insight', key: '2020-01-01' });
    expect(status).toMatchObject({ kind: 'insight', key: '2020-01-01', revision: 3, action: 'withdraw' });
    expect(Object.keys(status).sort()).toEqual(['action', 'approvalArtifactSha', 'key', 'kind', 'publishedAt', 'revision']);
    expect((await db.query('select revision,action from public.pdd_content_revisions order by revision')).rows).toEqual([{ revision: 1, action: 'publish' }, { revision: 2, action: 'publish' }, { revision: 3, action: 'withdraw' }]);
    await rejection(() => db.exec("delete from public.pdd_content_revisions where revision=1"), 'IMMUTABLE_HISTORY');
    await rejection(() => rpc('pdd_publish_content', publishPayload({ expectedRevision: 3, action: 'withdraw', content: null })), 'INVALID_REQUEST');
  });
  it('rejects private or extra content fields and requires daily source IDs from an approved shared catalog', async () => {
    const invalid = publishPayload();
    await rejection(() => rpc('pdd_publish_content', { ...invalid, content: { ...invalid.content, contact: 'private' } }), 'INVALID_REQUEST');
    await rejection(() => rpc('pdd_publish_content', publishPayload({ content: { ...report('2020-01-01'), newsIds: ['missing-story'] } })), 'INVALID_REQUEST');
    const catalog = { items: [{ id: 'story-one', kind: 'news' as const, origin: 'third-party' as const, title: 'Synthetic source', summary: 'A short attributed summary', source: 'Synthetic publisher', sourceUrl: 'https://example.com/news/story', publishedAt: null, checkedAt: '2020-01-01T12:00:00Z', channels: ['微信群'], thumbnailUrl: null, downloadUrl: null, copyText: null }] };
    await rpc('pdd_publish_content', publishPayload({ kind: 'outreach', key: 'main', content: catalog }));
    await rpc('pdd_publish_content', publishPayload({ content: { ...report('2020-01-01'), newsIds: ['story-one'] } }));
    expect((await rpc('pdd_public_outreach')).catalog.content.items[0].publishedAt).toBeNull();
    const sourceUrls = ['https://pdd404.app/m/private', 'https://example.com/news?token=private', 'https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/parcel-originals/private.jpg'];
    for (const sourceUrl of sourceUrls) await rejection(() => rpc('pdd_publish_content', { ...publishPayload({ kind: 'outreach', key: 'main', expectedRevision: 1, content: catalog }), content: { items: [{ ...catalog.items[0], sourceUrl }] } }), 'INVALID_REQUEST');
    await rpc('pdd_publish_content', publishPayload({ kind: 'outreach', key: 'main', expectedRevision: 1, content: { items: [{ ...catalog.items[0], origin: 'pdd404', kind: 'video' }] } }));
    await rejection(() => rpc('pdd_publish_content', publishPayload({ expectedRevision: 1, content: { ...report('2020-01-01'), newsIds: ['story-one'] } })), 'INVALID_REQUEST');
  });
  it('denies direct anonymous/authenticated database and RPC access, and even service-role history edits', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role};`);
      await rejection(() => db.query('select * from public.pdd_stats_daily'), 'permission denied');
      await rejection(() => db.query('select * from public.pdd_content_revisions'), 'permission denied');
      await rejection(() => rpc('pdd_public_stats_history'), 'permission denied');
      await rejection(() => rpc('pdd_publish_content', publishPayload()), 'permission denied');
      await rejection(() => rpc('pdd_admin_publication_status', { kind: 'outreach', key: 'main' }), 'permission denied');
      await db.exec('reset role;');
    }
    await db.exec('set role service_role;');
    expect(await rpc('pdd_public_outreach')).toEqual({ catalog: null, developerGroup: null });
    await rejection(() => db.exec('delete from public.pdd_content_revisions'), 'permission denied');
    await rejection(() => db.exec("insert into public.pdd_content_revisions(kind,content_key,revision,action,payload,actor_id,approval_artifact_sha) values('outreach','main',1,'publish','{\"items\":[]}',gen_random_uuid(),repeat('a',64))"), 'permission denied');
    await rejection(() => db.exec("insert into public.pdd_stats_daily values(current_date,now(),'home-six-lifetime-v1','{}')"), 'permission denied');
    await db.exec('reset role;');
    expect((await db.query("select schedule,command from cron.test_jobs where name='pdd404-evening-public-stats'")).rows).toEqual([{ schedule: '0 13 * * *', command: "select public.pdd_capture_stats_daily('{}'::jsonb)" }]);
  });
  it('publishes explanation comics as first-party downloadable content only', async () => {
    const url = 'https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/pdd-public-assets/' + 'c'.repeat(64) + '.webp';
    const comic = { id: 'synthetic-comic', kind: 'comic' as const, origin: 'pdd404' as const, title: 'Synthetic website guide', summary: 'An explanation of the query tool', source: 'PDD404', sourceUrl: null, publishedAt: null, checkedAt: '2020-01-01T12:00:00Z', channels: ['Community chat'], thumbnailUrl: url, downloadUrl: url, copyText: null };
    const input = publishPayload({ kind: 'outreach', key: 'main', content: { items: [comic] } });
    await rpc('pdd_publish_content', input);
    expect((await rpc('pdd_public_outreach')).catalog.content.items[0].kind).toBe('comic');
    for (const changed of [{ ...comic, downloadUrl: null }, { ...comic, origin: 'third-party', sourceUrl: 'https://example.com/story' }]) await rejection(() => rpc('pdd_publish_content', { ...input, expected_revision: 1, content: { items: [changed] } }), 'INVALID_REQUEST');
    await rejection(() => rpc('pdd_publish_content', publishPayload({ content: { ...report('2020-01-01'), newsIds: ['synthetic-comic'] } })), 'INVALID_REQUEST');
  });
});
