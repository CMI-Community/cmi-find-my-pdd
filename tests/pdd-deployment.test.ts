import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const page = vi.hoisted(() => ({ preload: vi.fn(), render: vi.fn(), getUserMedia: vi.fn() }));
vi.mock('../src/pdd-barcode-reader', () => ({ preloadBarcodeReader: page.preload }));
vi.mock('../src/PddApp', () => ({ default: () => null }));
vi.mock('react-dom/client', () => ({ default: { createRoot: () => ({ render: page.render }) } }));
vi.mock('react-router-dom', () => ({ BrowserRouter: () => null }));

const file = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const configuration = JSON.parse(file('vercel.json')) as {
  rewrites: { source: string; destination: string }[];
  headers: { source: string; headers: { key: string; value: string }[] }[];
};

beforeEach(() => { vi.resetModules(); page.preload.mockReset(); page.render.mockReset(); page.getUserMedia.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('same-site WASM deployment', () => {
  it('allows WASM compilation without granting JavaScript eval or external script execution', () => {
    const headers = configuration.headers.filter(rule => rule.source === '/(.*)').flatMap(rule => rule.headers);
    const value = headers.find(header => header.key.toLowerCase() === 'content-security-policy')?.value;
    expect(value).toBeDefined();
    const directives = new Map(value!.split(';').map(part => {
      const [name, ...tokens] = part.trim().split(/\s+/); return [name, tokens];
    }));
    expect(directives.get('script-src')).toContain("'self'");
    expect(directives.get('script-src')).toContain("'wasm-unsafe-eval'");
    expect([...directives.values()].flat()).not.toContain("'unsafe-eval'");
    expect(directives.get('script-src')).not.toContain("'unsafe-inline'");
    expect(directives.get('script-src')!.some(token => /^(https?:|\*|data:|blob:)/.test(token))).toBe(false);
    expect(directives.get('connect-src')).toContain("'self'");
  });

  it('keeps reader binaries and required notices outside the SPA rewrite', () => {
    const applies = (path: string) => configuration.rewrites.some(rule => new RegExp('^' + rule.source + '$').test(path));
    expect(applies('/help')).toBe(true);
    expect(applies('/assets/zxing_reader-example.wasm')).toBe(false);
    expect(applies('/assets/third-party-notices.txt')).toBe(false);
    const notice = file('public/assets/third-party-notices.txt');
    const metadata = JSON.parse(file('node_modules/zxing-wasm/package.json')) as { version: string };
    expect(notice).toContain('zxing-wasm ' + metadata.version);
    expect(notice).toContain(file('node_modules/zxing-wasm/LICENSE').trim());
    expect(notice).toContain('Apache License');
    expect(notice).toContain('Copyright 2023 Ze-Zheng Wu');
    expect(notice).toContain('Copyright (C) 2022 gitlost');
    expect(notice).toContain('Redistributions in binary form must reproduce');
    expect(notice).toContain('Copyright (c) 2017 Sean Barrett');
  });

  it('preloads independently of rendering and never requests camera permission on page open', async () => {
    let complete!: () => void;
    page.preload.mockReturnValue(new Promise<void>(resolve => { complete = resolve; }));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: page.getUserMedia } });
    vi.stubGlobal('document', { querySelector: () => ({}), getElementById: () => ({ id: 'root' }) });
    await import('../src/main');
    expect(page.preload).toHaveBeenCalledOnce();
    // The unresolved WASM load cannot hold the page's root rendering hostage.
    expect(page.render).toHaveBeenCalledOnce(); expect(page.getUserMedia).not.toHaveBeenCalled();
    const reader = file('src/pdd-barcode-reader.ts');
    expect(reader).not.toMatch(/getUserMedia|enumerateDevices|createCameraSession|startBarcodeScanner/);
    expect(reader).toContain("from 'zxing-wasm/reader'");
    expect(reader).toContain("from 'zxing-wasm/reader/zxing_reader.wasm?url'");
    complete();
  });

  it('keeps the page available when decoder preloading fails', async () => {
    page.preload.mockRejectedValue(new Error('Synthetic WASM compilation failure'));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: page.getUserMedia } });
    vi.stubGlobal('document', { querySelector: () => ({}), getElementById: () => ({ id: 'root' }) });
    await import('../src/main'); await Promise.resolve();
    expect(page.render).toHaveBeenCalledOnce(); expect(page.getUserMedia).not.toHaveBeenCalled();
  });
});
