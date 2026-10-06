import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
let sha = process.env.VERCEL_GIT_COMMIT_SHA ?? 'uncommitted';
try { sha = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
export default defineConfig({
  plugins: [react(), { name: 'pdd404-build-identity', transformIndexHtml: () => [
    { tag: 'meta', attrs: { name: 'pdd404-version', content: '0.2.0' }, injectTo: 'head' },
    { tag: 'meta', attrs: { name: 'pdd404-build', content: sha }, injectTo: 'head' },
  ] }],
  define: { __APP_VERSION__: JSON.stringify('0.2.0'), __BUILD_SHA__: JSON.stringify(sha) },
  build: { sourcemap: false },
  test: { include: ['tests/**/*.test.ts'] }
});
