import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
// @ts-expect-error Local operation entrypoint is intentionally plain JavaScript.
import { createSetupServer } from '../scripts/local-setup.mjs';

const running: Array<{ server: any; workspace: string }> = [];
afterEach(async () => {
  for (const { server, workspace } of running.splice(0)) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(workspace, { recursive: true, force: true });
  }
});
async function start() {
  const workspace = await mkdtemp(join(tmpdir(), 'cmi-setup-test-'));
  const server = createSetupServer({ workspace, apiBase: 'http://127.0.0.1:1' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  running.push({ server, workspace });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(origin)).text();
  const csrf = html.match(/const csrf='([a-f0-9]{64})'/)![1];
  const request = (path: string, body?: unknown, extraHeaders: Record<string, string> = {}) => fetch(origin + path, {
    method: body ? 'POST' : 'GET', headers: { 'X-Setup-CSRF': csrf, Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined
  });
  return { workspace, origin, request };
}
const valid = { environmentChoice: 'current_empty_as_test', adminEmail: 'synthetic@example.test', assistantWechat: '', officialAccountName: '', publishCommunityAssets: false, images: {} };
describe('loopback-only setup form', () => {
  it('rejects DNS rebinding, cross-site writes and requests without the local nonce', async () => {
    const { origin, request, workspace } = await start();
    const reboundStatus = await new Promise(resolve => {
      const req = httpRequest(origin, { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); });
      req.on('error', error => { throw error; }); req.end();
    });
    expect(reboundStatus).toBe(403);
    expect((await request('/api/config', valid, { Origin: 'https://attacker.example' })).status).toBe(403);
    expect((await fetch(origin + '/api/status')).status).toBe(403);
    expect((await request('/api/status', undefined, { 'X-Setup-CSRF': 'x'.repeat(64) })).status).toBe(403);
    await expect(readFile(join(workspace, '.private/setup.json'))).rejects.toThrow();
  });
  it('keeps keys out of status and rejects credential fields submitted to the community form', async () => {
    const { request, workspace } = await start();
    await mkdir(join(workspace, '.private'));
    const marker = 'sk-synthetic-local-secret-only';
    await writeFile(join(workspace, '.private/test.env'), `OPENAI_API_KEY=${marker}\n`);
    const status = await (await request('/api/status')).text();
    expect(JSON.parse(status).keyPresent).toBe(true);
    expect(status).not.toContain(marker);
    expect((await request('/api/config', { ...valid, OPENAI_API_KEY: marker })).status).toBe(400);
  });
  it('saves private configuration, preserves saved images and does not pretend it is applied', async () => {
    const { request, workspace } = await start();
    const image = Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(40)]);
    const first = await request('/api/config', { ...valid, images: { group: { mime: 'image/jpeg', base64: image.toString('base64') } } });
    expect(first.status).toBe(200);
    expect((await first.json()).appliedToCloud).toBe(false);
    expect((await request('/api/config', valid)).status).toBe(200);
    const saved = JSON.parse(await readFile(join(workspace, '.private/setup.json'), 'utf8'));
    expect(saved.images.group).toBe(join(workspace, '.private/setup-group.jpg'));
    expect(saved.appliedToCloud).toBe(false);
    expect((await stat(join(workspace, '.private/setup.json'))).mode & 0o777).toBe(0o600);
    expect((await request('/api/config', { ...valid, images: { group: { mime: 'image/jpeg', base64: Buffer.alloc(64).toString('base64') } } })).status).toBe(400);
  });
  it('refuses a symlinked private directory rather than reading or writing outside the workspace', async () => {
    const { request, workspace } = await start();
    const outside = await mkdtemp(join(tmpdir(), 'cmi-setup-outside-'));
    try {
      await symlink(outside, join(workspace, '.private'));
      expect((await request('/api/status')).status).toBe(400);
      expect((await request('/api/config', valid)).status).toBe(400);
      await expect(readFile(join(outside, 'setup.json'))).rejects.toThrow();
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
});
