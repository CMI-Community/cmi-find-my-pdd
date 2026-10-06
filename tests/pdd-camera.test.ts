import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const decoder = vi.hoisted(() => ({
  loading: undefined as Promise<void> | undefined,
  decode: vi.fn(),
  fastDecode: vi.fn(),
  constructed: vi.fn(),
}));

vi.mock('@zxing/browser', async () => {
  await decoder.loading;
  return { BrowserCodeReader: class {
    decodeFromCanvas(canvas: HTMLCanvasElement) { return decoder.fastDecode(canvas); }
  }, BrowserMultiFormatOneDReader: class {
    constructor(hints: Map<number, unknown>) { decoder.constructed(hints); }
    decodeFromCanvas(canvas: HTMLCanvasElement) { return decoder.decode(canvas); }
  } };
});
vi.mock('@zxing/library', () => ({
  DecodeHintType: { POSSIBLE_FORMATS: 2 },
  BarcodeFormat: { CODE_128: 4, CODE_39: 2, CODE_93: 3, ITF: 8, CODABAR: 1 },
  Code128Reader: class {},
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

function fixtures(play: Promise<void> = Promise.resolve()) {
  const context = { drawImage: vi.fn(), fillRect: vi.fn(), translate: vi.fn(), rotate: vi.fn(), imageSmoothingEnabled: true };
  const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
  const video = {
    videoWidth: 1280, videoHeight: 720, srcObject: null,
    play: vi.fn(() => play), pause: vi.fn(),
  } as unknown as HTMLVideoElement;
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  return { video, stream, context, canvas, track };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  decoder.loading = Promise.resolve();
  decoder.constructed.mockReset();
  decoder.decode.mockReset().mockImplementation(() => { throw new Error('Synthetic frame has no barcode'); });
  decoder.fastDecode.mockReset().mockImplementation(() => { throw new Error('Synthetic frame has no Code128'); });
  vi.stubGlobal('BarcodeDetector', undefined);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('barcode scanner scheduling and camera lifecycle', () => {
  it('starts the camera preview before the decoder module finishes loading', async () => {
    const loading = deferred<void>(); decoder.loading = loading.promise;
    const { video, stream } = fixtures();
    const { startBarcodeScanner } = await import('../src/pdd-camera');
    const controls = startBarcodeScanner(stream, video, vi.fn());
    expect(video.srcObject).toBe(stream);
    expect(video.play).toHaveBeenCalledOnce();
    expect(decoder.decode).not.toHaveBeenCalled();
    controls.stop(); loading.resolve(); await controls.ready;
    expect(video.srcObject).toBeNull();
    expect(decoder.decode).not.toHaveBeenCalled();
  });

  it('does not restart or decode when stopped while video.play is pending', async () => {
    const playing = deferred<void>();
    const { video, stream } = fixtures(playing.promise);
    const onDecoded = vi.fn(), { startBarcodeScanner } = await import('../src/pdd-camera');
    const controls = startBarcodeScanner(stream, video, onDecoded);
    controls.stop(); playing.resolve(); await controls.ready;
    await vi.advanceTimersByTimeAsync(1000);
    expect(video.srcObject).toBeNull();
    expect(video.pause).toHaveBeenCalledOnce();
    expect(decoder.decode).not.toHaveBeenCalled();
    expect(onDecoded).not.toHaveBeenCalled();
  });

  it('waits for native decoding to finish before scheduling another frame', async () => {
    const first = deferred<{ rawValue: string }[]>(), second = deferred<{ rawValue: string }[]>();
    const detect = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    vi.stubGlobal('BarcodeDetector', class {
      static getSupportedFormats() { return Promise.resolve(['code_128']); }
      detect = detect;
    });
    const { video, stream } = fixtures(), { startBarcodeScanner } = await import('../src/pdd-camera');
    const controls = startBarcodeScanner(stream, video, vi.fn()); await controls.ready;
    expect(detect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(detect).toHaveBeenCalledOnce();
    expect(decoder.decode).not.toHaveBeenCalled();
    first.resolve([]); await vi.advanceTimersByTimeAsync(0);
    expect(decoder.decode).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(119); expect(detect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(detect).toHaveBeenCalledTimes(2);
    controls.stop(); second.resolve([]); await vi.advanceTimersByTimeAsync(0);
  });

  it('discards a native result that finishes after the scanner closes', async () => {
    const result = deferred<{ rawValue: string }[]>(), detect = vi.fn(() => result.promise);
    vi.stubGlobal('BarcodeDetector', class {
      static getSupportedFormats() { return Promise.resolve(['code_128']); }
      detect = detect;
    });
    const { video, stream } = fixtures(), onDecoded = vi.fn();
    const { startBarcodeScanner } = await import('../src/pdd-camera');
    const controls = startBarcodeScanner(stream, video, onDecoded); await controls.ready;
    controls.stop(); result.resolve([{ rawValue: '12345678901234' }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onDecoded).not.toHaveBeenCalled();
    expect(decoder.decode).not.toHaveBeenCalled();
    expect(detect).toHaveBeenCalledOnce();
  });

  it('keeps ZXing working if native detection throws and disables the failing native path', async () => {
    const detect = vi.fn().mockRejectedValue(new Error('Unsupported native source'));
    vi.stubGlobal('BarcodeDetector', class {
      static getSupportedFormats() { return Promise.resolve(['code_128']); }
      detect = detect;
    });
    decoder.decode.mockReturnValue({ getText: () => '12345678901234' });
    const { video, stream } = fixtures(), onDecoded = vi.fn();
    const { startBarcodeScanner } = await import('../src/pdd-camera');
    const controls = startBarcodeScanner(stream, video, onDecoded); await controls.ready;
    await vi.advanceTimersByTimeAsync(0);
    expect(onDecoded).toHaveBeenCalledWith('12345678901234');
    await vi.advanceTimersByTimeAsync(120);
    expect(detect).toHaveBeenCalledOnce();
    expect(decoder.decode).toHaveBeenCalledTimes(2);
    controls.stop();
  });

  it('uses ZXing when a partial native implementation has no supported-formats method', async () => {
    vi.stubGlobal('BarcodeDetector', class {});
    const { video, stream } = fixtures(), { startBarcodeScanner } = await import('../src/pdd-camera');
    const controls = startBarcodeScanner(stream, video, vi.fn());
    await controls.ready;
    expect(decoder.decode).toHaveBeenCalledOnce(); controls.stop();
  });

  it('starts ZXing even if native format discovery never resolves', async () => {
    const supported = deferred<string[]>();
    vi.stubGlobal('BarcodeDetector', class {
      static getSupportedFormats() { return supported.promise; }
    });
    const { video, stream } = fixtures(), { startBarcodeScanner } = await import('../src/pdd-camera');
    const controls = startBarcodeScanner(stream, video, vi.fn()); await controls.ready;
    expect(decoder.decode).toHaveBeenCalledOnce(); controls.stop();
  });

  it('disables a native detector after its deadline and ignores its late result', async () => {
    const result = deferred<{ rawValue: string }[]>(), detect = vi.fn(() => result.promise);
    vi.stubGlobal('BarcodeDetector', class {
      static getSupportedFormats() { return Promise.resolve(['code_128']); }
      detect = detect;
    });
    const { video, stream } = fixtures(), onDecoded = vi.fn();
    const { startBarcodeScanner } = await import('../src/pdd-camera');
    const controls = startBarcodeScanner(stream, video, onDecoded); await controls.ready;
    await vi.advanceTimersByTimeAsync(299); expect(decoder.decode).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(decoder.decode).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(120); expect(decoder.decode).toHaveBeenCalledTimes(2);
    expect(detect).toHaveBeenCalledOnce();
    result.resolve([{ rawValue: '12345678901234' }]); await vi.advanceTimersByTimeAsync(0);
    expect(onDecoded).not.toHaveBeenCalled(); controls.stop();
  });

  it('uses the Code128 fast path before the restricted multi-format fallback', async () => {
    decoder.fastDecode.mockReturnValue({ getText: () => '12345678901234' });
    const { video, stream } = fixtures(), onDecoded = vi.fn();
    const { startBarcodeScanner } = await import('../src/pdd-camera');
    const controls = startBarcodeScanner(stream, video, onDecoded); await controls.ready;
    expect(onDecoded).toHaveBeenCalledWith('12345678901234');
    expect(decoder.decode).not.toHaveBeenCalled();
    expect([...decoder.constructed.mock.calls[0][0].values()]).toEqual([[4, 2, 3, 8, 1]]);
    controls.stop();
  });

  it('skips an invalid first native candidate and returns the next valid barcode', async () => {
    const detect = vi.fn().mockResolvedValue([{ rawValue: 'SKU' }, { rawValue: '12345678901234' }]);
    vi.stubGlobal('BarcodeDetector', class {
      static getSupportedFormats() { return Promise.resolve(['code_128']); }
      detect = detect;
    });
    const { video, stream } = fixtures(), onDecoded = vi.fn();
    const { startBarcodeScanner } = await import('../src/pdd-camera');
    const controls = startBarcodeScanner(stream, video, onDecoded, text => text === '12345678901234');
    await controls.ready; await vi.advanceTimersByTimeAsync(0);
    expect(onDecoded).toHaveBeenCalledOnce();
    expect(onDecoded).toHaveBeenCalledWith('12345678901234');
    expect(decoder.fastDecode).not.toHaveBeenCalled(); controls.stop();
  });

  it('continues through invalid native and fast-path readings to a valid fallback barcode', async () => {
    vi.stubGlobal('BarcodeDetector', class {
      static getSupportedFormats() { return Promise.resolve(['code_128']); }
      detect() { return Promise.resolve([{ rawValue: 'SKU' }]); }
    });
    decoder.fastDecode.mockReturnValue({ getText: () => 'SKU' });
    decoder.decode.mockReturnValue({ getText: () => '12345678901234' });
    const { video, stream } = fixtures(), onDecoded = vi.fn();
    const { startBarcodeScanner } = await import('../src/pdd-camera');
    const controls = startBarcodeScanner(stream, video, onDecoded, text => text === '12345678901234');
    await controls.ready; await vi.advanceTimersByTimeAsync(0);
    expect(decoder.fastDecode).toHaveBeenCalledOnce();
    expect(decoder.decode).toHaveBeenCalledOnce();
    expect(onDecoded).toHaveBeenCalledOnce();
    expect(onDecoded).toHaveBeenCalledWith('12345678901234'); controls.stop();
  });

  it('reports decoder initialization failure without silently continuing an empty scan loop', async () => {
    const { video, stream } = fixtures();
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) });
    const { startBarcodeScanner } = await import('../src/pdd-camera');
    const controls = startBarcodeScanner(stream, video, vi.fn());
    await expect(controls.ready).rejects.toThrow('无法读取相机画面');
    await vi.advanceTimersByTimeAsync(1000);
    expect(decoder.decode).not.toHaveBeenCalled(); controls.stop();
  });

  it('requests autofocus only when supported and preserves the original camera constraints', async () => {
    const oldConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: { ideal: 'environment' } };
    const track = {
      stop: vi.fn(), getCapabilities: () => ({ focusMode: ['manual', 'continuous'] }),
      getConstraints: () => oldConstraints, applyConstraints: vi.fn().mockRejectedValue(new Error('Camera refused autofocus')),
    };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
    const { createCameraSession } = await import('../src/pdd-camera');
    const session = createCameraSession(vi.fn().mockResolvedValue(stream));
    await expect(session.ready).resolves.toBe(stream);
    expect(track.applyConstraints).toHaveBeenCalledOnce();
    expect(track.applyConstraints.mock.calls[0][0]).toMatchObject(oldConstraints);
    session.stop(); expect(track.stop).toHaveBeenCalledOnce();
  });
});

// Use the real installed CommonJS decoders, outside the lifecycle mocks above.
// These fixtures contain only a synthetic Code128 number and generated pixels.
const require = createRequire(import.meta.url);
const actualLibrary = require('@zxing/library') as typeof import('@zxing/library');
const actualBrowser = require('@zxing/browser') as typeof import('@zxing/browser');
type GrayFrame = { width: number; height: number; pixels: Uint8ClampedArray };
const fixtureNumber = '12345678901234';

function syntheticCode128(angle: number, centerY = 240, invalidChecksum = false): GrayFrame {
  const codes = [105, ...fixtureNumber.match(/../g)!.map(Number)];
  const checksum = codes.reduce((sum, code, index) => sum + code * (index || 1), 0) % 103;
  codes.push(invalidChecksum ? (checksum + 1) % 103 : checksum, 106);
  const patterns = (actualLibrary.Code128Reader as unknown as { CODE_PATTERNS: Int32Array[] }).CODE_PATTERNS;
  const runs = codes.flatMap(code => Array.from(patterns[code]));
  const modules = runs.reduce((sum, value) => sum + value, 0) + 24;
  const bar = new Uint8ClampedArray(modules * 2).fill(255);
  let position = 24;
  runs.forEach((run, index) => { if (!(index % 2)) bar.fill(0, position, position + run * 2); position += run * 2; });
  const width = 640, height = 480, pixels = new Uint8ClampedArray(width * height).fill(255);
  const radians = angle * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const horizontal = cosine * (x - width / 2) + sine * (y - centerY) + bar.length / 2;
    const vertical = -sine * (x - width / 2) + cosine * (y - centerY);
    if (Math.abs(vertical) < 40 && horizontal >= 0 && horizontal < bar.length) pixels[y * width + x] = bar[Math.floor(horizontal)];
  }
  return { width, height, pixels };
}

function renderCapture(frame: GrayFrame, plan: ReturnType<typeof import('../src/pdd-camera').barcodeFramePlan>): GrayFrame {
  const width = plan.canvasWidth, height = plan.canvasHeight, pixels = new Uint8ClampedArray(width * height).fill(255);
  const radians = plan.tilt * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
  // Independently rasterize the canvas transform at pixel centers, then sample
  // source pixels. The geometry comes from the production capture plan.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let localX = x + .5, localY = y + .5;
    if (plan.quarterTurn) { localX = plan.targetWidth - y - .5; localY = x + .5; }
    else if (plan.tilt) {
      const dx = localX - plan.targetWidth / 2, dy = localY - plan.targetHeight / 2;
      localX = cosine * dx + sine * dy + plan.targetWidth / 2;
      localY = -sine * dx + cosine * dy + plan.targetHeight / 2;
    }
    if (localX < 0 || localY < 0 || localX >= plan.targetWidth || localY >= plan.targetHeight) continue;
    const sourceX = Math.floor(plan.sourceX + localX * plan.sourceWidth / plan.targetWidth);
    const sourceY = Math.floor(plan.sourceY + localY * plan.sourceHeight / plan.targetHeight);
    if (sourceX >= 0 && sourceX < frame.width && sourceY >= 0 && sourceY < frame.height) pixels[y * width + x] = frame.pixels[sourceY * frame.width + sourceX];
  }
  return { width, height, pixels };
}

function pixelCanvas(frame: GrayFrame): HTMLCanvasElement {
  const rgba = new Uint8ClampedArray(frame.width * frame.height * 4);
  frame.pixels.forEach((value, index) => { rgba[index * 4] = rgba[index * 4 + 1] = rgba[index * 4 + 2] = value; rgba[index * 4 + 3] = 255; });
  return { width: frame.width, height: frame.height, getContext: () => ({ getImageData: () => ({ data: rgba }) }) } as unknown as HTMLCanvasElement;
}

describe('real Code128 pixels and production capture geometry', () => {
  const hints = new Map([[actualLibrary.DecodeHintType.POSSIBLE_FORMATS, [actualLibrary.BarcodeFormat.CODE_128, actualLibrary.BarcodeFormat.CODE_39, actualLibrary.BarcodeFormat.CODE_93, actualLibrary.BarcodeFormat.ITF, actualLibrary.BarcodeFormat.CODABAR]]]);
  function decode(frame: GrayFrame, defaultFormats = false) {
    try { return new actualBrowser.BrowserMultiFormatOneDReader(defaultFormats ? undefined : hints).decodeFromCanvas(pixelCanvas(frame)).getText(); }
    catch { return undefined; }
  }
  it.each([
    ['top edge', 0, 48], ['bottom edge', 0, 432], ['clockwise tilt', 25, 240],
    ['counterclockwise tilt', -25, 240], ['vertical barcode', 90, 240],
  ] as const)('recovers %s that the old default whole-frame scan misses', async (_name, angle, centerY) => {
    const source = syntheticCode128(angle, centerY);
    expect(decode(source, true)).toBeUndefined();
    const { barcodeFramePlan } = await import('../src/pdd-camera');
    const results = Array.from({ length: 10 }, (_, pass) => decode(renderCapture(source, barcodeFramePlan(source.width, source.height, pass))));
    expect(results).toContain(fixtureNumber);
    expect(results.filter(Boolean).every(value => value === fixtureNumber)).toBe(true);
  });

  it('rejects a synthetic barcode with a damaged Code128 checksum', async () => {
    const source = syntheticCode128(0, 240, true), { barcodeFramePlan } = await import('../src/pdd-camera');
    for (let pass = 0; pass < 10; pass++) expect(decode(renderCapture(source, barcodeFramePlan(source.width, source.height, pass)))).toBeUndefined();
  });
});
