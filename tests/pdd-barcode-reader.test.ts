import { beforeEach, describe, expect, it, vi } from 'vitest';

const wasm = vi.hoisted(() => ({ prepare: vi.fn(), read: vi.fn() }));
vi.mock('zxing-wasm/reader', () => ({ prepareZXingModule: wasm.prepare, readBarcodes: wasm.read }));

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(next => { resolve = next; }); return { promise, resolve }; }
const image = { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) } as ImageData;
beforeEach(() => { vi.resetModules(); wasm.prepare.mockReset().mockResolvedValue({}); wasm.read.mockReset().mockResolvedValue([]); });

describe('same-origin preloaded WASM reader', () => {
  it('starts module initialization immediately once and overrides the CDN with the bundled reader asset', async () => {
    const loading = deferred<object>(); wasm.prepare.mockReturnValue(loading.promise);
    const { preloadBarcodeReader } = await import('../src/pdd-barcode-reader');
    const first = preloadBarcodeReader(), second = preloadBarcodeReader();
    expect(second).toBe(first); await Promise.resolve();
    expect(wasm.prepare).toHaveBeenCalledOnce();
    const options = wasm.prepare.mock.calls[0][0];
    expect(options.fireImmediately).toBe(true);
    const url = options.overrides.locateFile('zxing_reader.wasm', 'https://cdn.invalid/');
    expect(url).toMatch(/^\//); expect(url).toContain('zxing_reader.wasm'); expect(url).not.toMatch(/https?:|jsdelivr|unpkg/);
    expect(options.overrides.locateFile('other.file', '/assets/')).toBe('/assets/other.file');
    loading.resolve({}); await first;
  });
  it('names module load failure separately from a camera failure', async () => {
    wasm.prepare.mockRejectedValue(new Error('synthetic WASM compile failure'));
    const { preloadBarcodeReader } = await import('../src/pdd-barcode-reader');
    await expect(preloadBarcodeReader()).rejects.toMatchObject({ name: 'BarcodeReaderUnavailableError', message: expect.stringContaining('刷新页面') });
    await expect(preloadBarcodeReader()).rejects.toMatchObject({ name: 'BarcodeReaderUnavailableError' });
    expect(wasm.prepare).toHaveBeenCalledOnce();
  });
  it('serializes requests across scanner instances and restricts formats without changing complete numbers', async () => {
    const pending = deferred<unknown[]>(); wasm.read.mockReturnValueOnce(pending.promise).mockResolvedValueOnce([{ isValid: true, text: '001234567890', format: 'Code128' }]);
    const { readWaybillBarcodes } = await import('../src/pdd-barcode-reader');
    const first = readWaybillBarcodes(image), second = readWaybillBarcodes(image);
    await vi.waitFor(() => expect(wasm.read).toHaveBeenCalledOnce());
    expect(wasm.read.mock.calls[0][1]).toMatchObject({ formats: ['Code128', 'Code39', 'Code93', 'ITF', 'Codabar'], tryHarder: true, returnErrors: false, maxNumberOfSymbols: 8 });
    pending.resolve([]); await first;
    expect(await second).toEqual([{ isValid: true, text: '001234567890', format: 'Code128' }]);
    expect(wasm.read).toHaveBeenCalledTimes(2);
  });
  it('drops queued cancelled work before touching WASM and ignores a running request after cancellation', async () => {
    const pending = deferred<unknown[]>(); wasm.read.mockReturnValue(pending.promise);
    const { readWaybillBarcodes } = await import('../src/pdd-barcode-reader');
    let runningCurrent = true, queuedCurrent = true;
    const running = readWaybillBarcodes(image, () => runningCurrent).catch(error => error);
    const queued = readWaybillBarcodes(image, () => queuedCurrent).catch(error => error);
    await vi.waitFor(() => expect(wasm.read).toHaveBeenCalledOnce());
    runningCurrent = false; queuedCurrent = false; pending.resolve([{ isValid: true, text: '123456789012' }]);
    expect(await running).toMatchObject({ name: 'AbortError' });
    expect(await queued).toMatchObject({ name: 'AbortError' });
    expect(wasm.read).toHaveBeenCalledOnce();
  });
  it('recovers the serialization queue after a failed decode', async () => {
    wasm.read.mockRejectedValueOnce(new Error('synthetic failed decode')).mockResolvedValueOnce([]);
    const { readWaybillBarcodes } = await import('../src/pdd-barcode-reader');
    const first = readWaybillBarcodes(image), second = readWaybillBarcodes(image);
    await expect(first).rejects.toThrow('synthetic failed decode');
    await expect(second).resolves.toEqual([]);
  });
});
