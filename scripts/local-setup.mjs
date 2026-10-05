import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BODY = 12 * 1024 * 1024;
const imageRoles = ['group', 'assistant', 'officialAccount'];
const fields = ['environmentChoice', 'adminEmail', 'assistantWechat', 'officialAccountName', 'publishCommunityAssets', 'images'];
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
async function regularPath(path, optional = true) {
  try { if ((await lstat(path)).isSymbolicLink()) fail('配置路径不能是符号链接。'); }
  catch (error) { if (error.code !== 'ENOENT' || !optional) throw error; }
}
async function privateWrite(path, data) {
  await regularPath(dirname(path));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await regularPath(path);
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try { await writeFile(temporary, data, { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export function validateSetup(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) fail('配置字段不正确。');
  if (!['current_empty_as_test', 'release_free_slot', 'paid_separate'].includes(input.environmentChoice)) fail('请选择测试环境方案。');
  const adminEmail = String(input.adminEmail || '').trim();
  if (adminEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) fail('请填写管理员登录邮箱。');
  const assistantWechat = String(input.assistantWechat || '').trim();
  const officialAccountName = String(input.officialAccountName || '').trim();
  if (assistantWechat.length > 64 || officialAccountName.length > 80) fail('联系方式或公众号名称过长。');
  if (typeof input.publishCommunityAssets !== 'boolean') fail('请明确社区资料的公开范围。');
  if (!input.images || typeof input.images !== 'object' || Array.isArray(input.images) || Object.keys(input.images).some(key => !imageRoles.includes(key))) fail('二维码图片位置不正确。');
  const images = {};
  for (const [role, image] of Object.entries(input.images)) {
    if (!image || Object.keys(image).some(key => !['mime', 'base64'].includes(key)) || !['image/jpeg', 'image/png'].includes(image.mime) || typeof image.base64 !== 'string') fail('二维码图片格式不正确。');
    if (image.base64.length > 3 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64)) fail('二维码图片过大或无法读取。');
    const bytes = Buffer.from(image.base64, 'base64');
    const valid = image.mime === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff : bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    if (!valid || bytes.length < 32) fail('请选择有效的二维码图片。');
    images[role] = { bytes, extension: image.mime === 'image/jpeg' ? 'jpg' : 'png' };
  }
  return { environmentChoice: input.environmentChoice, adminEmail, assistantWechat, officialAccountName, publishCommunityAssets: input.publishCommunityAssets, images };
}
export function createSetupServer({ workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..'), apiBase = 'https://fogncjjsnakbhfdbfvdi.supabase.co/functions/v1/api' } = {}) {
  const csrf = randomBytes(32).toString('hex');
  const root = resolve(workspace, '.private');
  const configPath = resolve(root, 'setup.json');
  const json = (response, status, data) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); };
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    try {
      const port = server.address()?.port;
      const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
      if (!origins.some(origin => origin.slice(7) === request.headers.host) || request.headers['x-forwarded-host'] || request.headers['x-forwarded-for']) fail('只允许本机直接访问配置服务。', 403);
      if (request.headers.origin && !origins.includes(request.headers.origin)) fail('配置请求来源不正确。', 403);
      if (request.headers['sec-fetch-site'] === 'cross-site') fail('禁止跨站访问配置服务。', 403);
      const url = new URL(request.url, origins[0]);
      if (request.method === 'GET' && url.pathname === '/') {
        const html = (await readFile(new URL('./local-setup.html', import.meta.url), 'utf8')).replaceAll('__SETUP_CSRF__', csrf);
        response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${csrf}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); return;
      }
      const token = request.headers['x-setup-csrf'];
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(csrf))) fail('请从本机配置页面操作。', 403);
      if (request.method === 'GET' && url.pathname === '/api/status') {
        await regularPath(root);
        let keyPresent = false, config = null;
        try { await regularPath(resolve(root, 'test.env')); keyPresent = /^OPENAI_API_KEY=\s*["']?sk-/m.test(await readFile(resolve(root, 'test.env'), 'utf8')); } catch { /* absent */ }
        try { await regularPath(configPath); config = JSON.parse(await readFile(configPath, 'utf8')); } catch { /* absent */ }
        let backend = null;
        try { const result = await fetch(`${apiBase}/v1/health`, { signal: AbortSignal.timeout(5000) }); if (result.ok) backend = (await result.json()).data; } catch { /* unavailable */ }
        json(response, 200, { keyPresent, backend, config, configPath }); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/config') {
        if (!request.headers['content-type']?.startsWith('application/json')) fail('配置必须通过表单提交。', 415);
        let size = 0; const chunks = [];
        for await (const chunk of request) { size += chunk.length; if (size > MAX_BODY) fail('配置图片总量过大。', 413); chunks.push(chunk); }
        let input;
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('配置无法读取。'); }
        const validated = validateSetup(input), savedImages = {};
        await regularPath(root);
        await regularPath(configPath);
        try {
          const previous = JSON.parse(await readFile(configPath, 'utf8'));
          for (const role of imageRoles) {
            const path = previous.images?.[role];
            if ([resolve(root, `setup-${role}.jpg`), resolve(root, `setup-${role}.png`)].includes(path)) {
              await regularPath(path, false); savedImages[role] = path;
            }
          }
        } catch (error) { if (error.status) throw error; }
        for (const [role, image] of Object.entries(validated.images)) {
          const path = resolve(root, `setup-${role}.${image.extension}`);
          await privateWrite(path, image.bytes); savedImages[role] = path;
        }
        const { images: _images, ...settings } = validated;
        const saved = { ...settings, images: savedImages, savedAt: new Date().toISOString(), appliedToCloud: false };
        await privateWrite(configPath, JSON.stringify(saved, null, 2) + '\n');
        json(response, 200, { saved: true, appliedToCloud: false, configPath }); return;
      }
      fail('没有这个配置接口。', 404);
    } catch (error) { json(response, error.status || 500, { error: error.status ? error.message : '本机配置保存失败，请检查私有目录权限。' }); }
  });
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createSetupServer();
  server.listen(5180, '127.0.0.1', () => console.log('CMI 测试配置面板：http://localhost:5180（仅本机，配置不会进入 Git）'));
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '5180端口已被占用，请关闭旧配置服务。' : '无法启动本机配置服务。'); process.exitCode = 1; });
}
