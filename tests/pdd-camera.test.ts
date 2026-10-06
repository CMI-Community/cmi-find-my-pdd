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
  const photos: { canvas: HTMLCanvasElement; drawImage: ReturnType<typeof vi.fn> }[] = [];
  let created = false;
  vi.stubGlobal('document', { createElement: vi.fn(() => {
    if (!created) { created = true; return canvas; }
    const drawImage = vi.fn(), photoContext = { drawImage, fillRect: vi.fn(), rotate: vi.fn(), translate: vi.fn(), imageSmoothingEnabled: true };
    const photo = { width: 0, height: 0, getContext: () => photoContext } as unknown as HTMLCanvasElement;
    photos.push({ canvas: photo, drawImage }); return photo;
  }) });
  const video = {
    videoWidth: 1280, videoHeight: 720, srcObject: null,
    play: vi.fn(() => play), pause: vi.fn(),
  } as unknown as HTMLVideoElement;
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  return { video, stream, context, canvas, track, photos };
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

  it('clears a pending native deadline immediately on close', async () => {
    const result = deferred<{ rawValue: string }[]>();
    vi.stubGlobal('BarcodeDetector', class {
      static getSupportedFormats() { return Promise.resolve(['code_128']); }
      detect() { return result.promise; }
    });
    const { video, stream } = fixtures(), onDecoded = vi.fn();
    const { startBarcodeScanner } = await import('../src/pdd-camera');
    const controls = startBarcodeScanner(stream, video, onDecoded); await controls.ready;
    expect(vi.getTimerCount()).toBe(1);
    controls.stop(); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    result.resolve([{ rawValue: '12345678901234' }]); await vi.advanceTimersByTimeAsync(1000);
    expect(onDecoded).not.toHaveBeenCalled(); expect(decoder.decode).not.toHaveBeenCalled();
  });

  it('does not let an old scanner ready or stop clear the replacement video stream', async () => {
    const playing = deferred<void>(), { video, stream, context, photos } = fixtures(playing.promise), next = focusCamera();
    vi.mocked(video.play).mockReturnValueOnce(playing.promise).mockResolvedValue(undefined);
    const { startBarcodeScanner } = await import('../src/pdd-camera');
    const old = startBarcodeScanner(stream, video, vi.fn());
    // Let the module finish loading while the old video.play stays pending.
    await vi.advanceTimersByTimeAsync(0);
    const current = startBarcodeScanner(next.stream, video, vi.fn()); await current.ready;
    expect(video.srcObject).toBe(next.stream);
    old.stop(); playing.resolve(); await old.ready;
    expect(video.srcObject).toBe(next.stream);
    expect(context.drawImage).not.toHaveBeenCalled(); expect(photos[0].drawImage).toHaveBeenCalledOnce();
    expect(decoder.constructed).toHaveBeenCalledTimes(2);
    expect(decoder.fastDecode).toHaveBeenCalledOnce();
    expect(decoder.decode).toHaveBeenCalledOnce(); current.stop();
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

  it('keeps the camera default focus without automatically forcing continuous autofocus', async () => {
    const oldConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: { ideal: 'environment' } };
    const track = {
      stop: vi.fn(), getCapabilities: () => ({ focusMode: ['manual', 'continuous'] }),
      getConstraints: () => oldConstraints, applyConstraints: vi.fn().mockRejectedValue(new Error('Camera refused autofocus')),
    };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
    const { createCameraSession } = await import('../src/pdd-camera');
    const session = createCameraSession(vi.fn().mockResolvedValue(stream));
    await expect(session.ready).resolves.toBe(stream);
    expect(track.applyConstraints).not.toHaveBeenCalled();
    session.stop(); expect(track.stop).toHaveBeenCalledOnce();
  });
});

describe('explicit local photo barcode decoding', () => {
  it('keeps the preview open without decoding or scheduling while waiting for a photo', async () => {
    const { stream, video } = fixtures(), { startBarcodeScanner } = await import('../src/pdd-camera');
    const scanner = startBarcodeScanner(stream, video, vi.fn(), undefined, { mode: 'photo' });
    await scanner.ready; await vi.advanceTimersByTimeAsync(10000);
    expect(video.srcObject).toBe(stream); expect(video.play).toHaveBeenCalledOnce();
    expect(decoder.fastDecode).not.toHaveBeenCalled(); expect(decoder.decode).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0); scanner.stop();
  });

  it('freezes one full original frame, shares repeated clicks, and yields before decoding', async () => {
    const { stream, video, photos, context } = fixtures(), { startBarcodeScanner } = await import('../src/pdd-camera');
    const onDecoded = vi.fn();
    const scanner = startBarcodeScanner(stream, video, onDecoded, undefined, { mode: 'photo' }); await scanner.ready;
    decoder.decode.mockImplementationOnce(() => { throw new Error('Whole frame misses'); }).mockReturnValue({ getText: () => '12345678901234' });
    const result = scanner.capture(); expect(scanner.capture()).toBe(result);
    expect(photos).toHaveLength(1); expect(photos[0].drawImage).toHaveBeenCalledExactlyOnceWith(video, 0, 0, 1280, 720);
    expect(decoder.decode).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15); expect(decoder.decode).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(decoder.decode).toHaveBeenCalledOnce();
    expect(onDecoded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16);
    await expect(result).resolves.toEqual({ result: 'decoded', text: '12345678901234' });
    expect(onDecoded).toHaveBeenCalledExactlyOnceWith('12345678901234');
    expect(context.drawImage.mock.calls.every(call => call[0] === photos[0].canvas)).toBe(true);
    expect(context.rotate).toHaveBeenCalledWith(-Math.PI / 2);
    expect(photos[0].canvas.width).toBe(0); expect(photos[0].canvas.height).toBe(0);
    expect(video.srcObject).toBe(stream); scanner.stop();
  });

  it('makes nine bounded attempts then waits for another explicit photo without a retry loop', async () => {
    const { stream, video, photos, context } = fixtures(), { startBarcodeScanner } = await import('../src/pdd-camera');
    const scanner = startBarcodeScanner(stream, video, vi.fn(), undefined, { mode: 'photo' }); await scanner.ready;
    const result = scanner.capture(); await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toEqual({ result: 'not_found' });
    expect(decoder.decode).toHaveBeenCalledTimes(9); expect(context.drawImage).toHaveBeenCalledTimes(9);
    expect(context.drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 1280, 720, 0, 0, 1280, 720]);
    expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(10000);
    expect(decoder.decode).toHaveBeenCalledTimes(9); expect(photos).toHaveLength(1);
    const again = scanner.capture(); expect(again).not.toBe(result); await vi.advanceTimersByTimeAsync(1000);
    await expect(again).resolves.toEqual({ result: 'not_found' });
    expect(decoder.decode).toHaveBeenCalledTimes(18); expect(photos).toHaveLength(2); scanner.stop();
  });

  it('returns success even when the existing decoded callback closes the camera session', async () => {
    const { stream, video } = fixtures(), { startBarcodeScanner, createCameraSession } = await import('../src/pdd-camera');
    const session = createCameraSession(async () => stream); await session.ready;
    const scanner = startBarcodeScanner(stream, video, () => session.stop(), undefined, { mode: 'photo' });
    session.attachDecoder(scanner); await scanner.ready;
    decoder.fastDecode.mockReturnValue({ getText: () => '12345678901234' });
    const result = scanner.capture(); await vi.advanceTimersByTimeAsync(16);
    await expect(result).resolves.toEqual({ result: 'decoded', text: '12345678901234' });
    expect(video.srcObject).toBeNull(); expect(video.pause).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('switches between photo and realtime on the same stream without another permission request', async () => {
    const { stream, video } = fixtures(), { startBarcodeScanner } = await import('../src/pdd-camera');
    const scanner = startBarcodeScanner(stream, video, vi.fn(), undefined, { mode: 'photo' }); await scanner.ready;
    scanner.setMode('realtime'); await vi.advanceTimersByTimeAsync(0); expect(decoder.decode).toHaveBeenCalledOnce();
    scanner.setMode('photo'); await vi.advanceTimersByTimeAsync(1000); expect(decoder.decode).toHaveBeenCalledOnce();
    expect(video.srcObject).toBe(stream); expect(video.play).toHaveBeenCalledOnce(); expect(video.pause).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0); scanner.stop();
  });

  it('cancels a native photo wait immediately and ignores its late result after close', async () => {
    const nativeResult = deferred<{ rawValue: string }[]>(), detect = vi.fn(() => nativeResult.promise);
    vi.stubGlobal('BarcodeDetector', class { static getSupportedFormats() { return Promise.resolve(['code_128']); } detect = detect; });
    const { stream, video, photos } = fixtures(), onDecoded = vi.fn(), { startBarcodeScanner } = await import('../src/pdd-camera');
    const scanner = startBarcodeScanner(stream, video, onDecoded, undefined, { mode: 'photo' }); await scanner.ready;
    const result = scanner.capture().catch(error => error); await vi.advanceTimersByTimeAsync(16);
    expect(detect).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(1);
    scanner.stop(); expect(vi.getTimerCount()).toBe(0); expect(await result).toMatchObject({ name: 'AbortError' });
    expect(photos[0].canvas.width).toBe(0);
    nativeResult.resolve([{ rawValue: '12345678901234' }]); await vi.advanceTimersByTimeAsync(1000);
    expect(onDecoded).not.toHaveBeenCalled(); expect(decoder.decode).not.toHaveBeenCalled();
  });

  it('interrupts an old realtime native frame before capturing without overlapping native calls', async () => {
    const nativeResult = deferred<{ rawValue: string }[]>(), detect = vi.fn(() => nativeResult.promise);
    vi.stubGlobal('BarcodeDetector', class { static getSupportedFormats() { return Promise.resolve(['code_128']); } detect = detect; });
    const { stream, video } = fixtures(), onDecoded = vi.fn(), { startBarcodeScanner } = await import('../src/pdd-camera');
    const scanner = startBarcodeScanner(stream, video, onDecoded); await scanner.ready; expect(detect).toHaveBeenCalledOnce();
    decoder.fastDecode.mockReturnValue({ getText: () => '12345678901234' });
    const result = scanner.capture(); await vi.advanceTimersByTimeAsync(16);
    await expect(result).resolves.toEqual({ result: 'decoded', text: '12345678901234' });
    expect(detect).toHaveBeenCalledOnce(); expect(onDecoded).toHaveBeenCalledOnce();
    scanner.setMode('photo'); nativeResult.resolve([{ rawValue: 'OLD-WAYBILL' }]); await vi.advanceTimersByTimeAsync(0);
    expect(onDecoded).toHaveBeenCalledExactlyOnceWith('12345678901234'); scanner.stop();
  });

  it('cancels a pending photo before the decoder finishes loading without waiting for it', async () => {
    const loading = deferred<void>(); decoder.loading = loading.promise;
    const { stream, video } = fixtures(), { startBarcodeScanner } = await import('../src/pdd-camera');
    const scanner = startBarcodeScanner(stream, video, vi.fn(), undefined, { mode: 'photo' });
    const result = scanner.capture().catch(error => error); scanner.stop();
    expect(await result).toMatchObject({ name: 'AbortError' }); expect(vi.getTimerCount()).toBe(0);
    loading.resolve(); await scanner.ready; expect(decoder.decode).not.toHaveBeenCalled();
  });

  it('cancels photo work when changing mode or replacing the scanner and retains the new preview', async () => {
    const { stream, video } = fixtures(), next = focusCamera(), { startBarcodeScanner } = await import('../src/pdd-camera');
    const onDecoded = vi.fn(), old = startBarcodeScanner(stream, video, onDecoded, undefined, { mode: 'photo' }); await old.ready;
    const first = old.capture().catch(error => error); old.setMode('realtime');
    expect(await first).toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0); old.setMode('photo');
    const second = old.capture().catch(error => error);
    const current = startBarcodeScanner(next.stream, video, vi.fn(), undefined, { mode: 'photo' }); await current.ready;
    expect(await second).toMatchObject({ name: 'AbortError' });
    expect(video.srcObject).toBe(next.stream); expect(onDecoded).not.toHaveBeenCalled(); current.stop();
  });

  it('rejects a not-yet-ready video with an actionable error and takes no empty photo', async () => {
    const { stream, video, photos } = fixtures(), { startBarcodeScanner } = await import('../src/pdd-camera');
    const scanner = startBarcodeScanner(stream, video, vi.fn(), undefined, { mode: 'photo' }); await scanner.ready;
    Object.defineProperty(video, 'videoWidth', { value: 0 });
    await expect(scanner.capture()).rejects.toMatchObject({ name: 'InvalidStateError', message: expect.stringContaining('稍等') });
    expect(photos).toHaveLength(0); expect(decoder.decode).not.toHaveBeenCalled(); scanner.stop();
  });
});

function focusCamera() {
  const capabilities = { focusMode: ['continuous', 'single-shot', 'manual'], focusDistance: { min: 0, max: 10, step: .5 } };
  const settings = { deviceId: 'actual-camera', facingMode: 'user', focusMode: 'continuous', focusDistance: 3 };
  const constraints = {
    width: { ideal: 1280 }, height: { ideal: 720 }, deviceId: { exact: 'actual-camera' },
    focusMode: { exact: 'continuous' }, focusDistance: { exact: 2 },
    advanced: [{ exposureMode: 'continuous', focusMode: 'continuous' }, { torch: false }],
  };
  const track = {
    readyState: 'live', stop: vi.fn(() => { track.readyState = 'ended'; }),
    getCapabilities: vi.fn(() => capabilities), getSettings: vi.fn(() => settings), getConstraints: vi.fn(() => constraints),
    applyConstraints: vi.fn(async (value: MediaTrackConstraints & { focusMode?: { exact: string }; focusDistance?: { exact: number } }) => {
      if (value.focusMode) settings.focusMode = value.focusMode.exact;
      if (value.focusDistance) settings.focusDistance = value.focusDistance.exact;
    }),
  };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  return { stream, track, capabilities, settings, constraints };
}

describe('capability-limited camera selection and focus', () => {
  it('selects an explicit device without conflicting with the default rear-camera preference', async () => {
    const { cameraConstraintsForDevice, createCameraSession } = await import('../src/pdd-camera');
    const selected = cameraConstraintsForDevice('usb-camera');
    expect(selected).toMatchObject({ audio: false, video: { deviceId: { exact: 'usb-camera' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    expect(selected.video).not.toHaveProperty('facingMode');
    expect(cameraConstraintsForDevice()).toMatchObject({ video: { facingMode: { ideal: 'environment' } } });
    const { stream } = focusCamera(), request = vi.fn().mockResolvedValue(stream);
    const session = createCameraSession(request, selected);
    expect(request).toHaveBeenCalledWith(selected); await session.ready; session.stop();
  });

  it('describes only the actual device settings and supported focus range', async () => {
    const { stream } = focusCamera(), { describeCamera } = await import('../src/pdd-camera');
    expect(describeCamera(stream)).toEqual({
      deviceId: 'actual-camera', facingMode: 'user', focusMode: 'continuous',
      focusModes: ['continuous', 'single-shot', 'manual'], focusDistance: { min: 0, max: 10, step: .5, current: 3 },
    });
    const hidden = { getVideoTracks: () => [{ getCapabilities: () => { throw new Error('Not available'); }, getSettings: () => ({}) }] } as unknown as MediaStream;
    expect(describeCamera(hidden)).toEqual({ focusModes: [] });
    const fixed = { getVideoTracks: () => [{ getCapabilities: () => ({ focusMode: ['none'], focusDistance: { min: 0, max: 5 } }), getSettings: () => ({}) }] } as unknown as MediaStream;
    expect(describeCamera(fixed)).toEqual({ focusModes: [], focusDistance: { min: 0, max: 5 } });
  });

  it('atomically applies manual mode and distance while preserving unrelated constraints', async () => {
    const { stream, track, constraints } = focusCamera(), { setCameraFocus } = await import('../src/pdd-camera');
    const result = await setCameraFocus(stream, 'manual', 4.5);
    expect(track.applyConstraints).toHaveBeenCalledOnce();
    expect(track.applyConstraints.mock.calls[0][0]).toEqual({
      width: constraints.width, height: constraints.height, deviceId: constraints.deviceId,
      focusMode: { exact: 'manual' }, focusDistance: { exact: 4.5 },
      advanced: [{ exposureMode: 'continuous', focusMode: 'manual', focusDistance: 4.5 }, { torch: false }],
    });
    expect(constraints.advanced[0].focusMode).toBe('continuous');
    expect(result.focusMode).toBe('manual'); expect(result.focusDistance?.current).toBe(4.5);
  });

  it('removes an old manual distance when returning to automatic focus', async () => {
    const { stream, track } = focusCamera(), { setCameraFocus } = await import('../src/pdd-camera');
    await setCameraFocus(stream, 'single-shot');
    expect(track.applyConstraints.mock.calls[0][0].focusMode).toEqual({ exact: 'single-shot' });
    expect(track.applyConstraints.mock.calls[0][0]).not.toHaveProperty('focusDistance');
    expect(track.applyConstraints.mock.calls[0][0].advanced?.[0]).toMatchObject({ exposureMode: 'continuous', focusMode: 'single-shot' });
    expect(track.applyConstraints.mock.calls[0][0].advanced?.[0]).not.toHaveProperty('focusDistance');
  });

  it('supports a driver that reads focus controls only from the first advanced set', async () => {
    const { stream, track, settings } = focusCamera(), { setCameraFocus } = await import('../src/pdd-camera');
    track.applyConstraints.mockImplementationOnce(async constraints => {
      const first = constraints.advanced?.[0] as { focusMode?: string; focusDistance?: number };
      if (first.focusMode) settings.focusMode = first.focusMode;
      if (first.focusDistance !== undefined) settings.focusDistance = first.focusDistance;
    });
    const result = await setCameraFocus(stream, 'manual', 5);
    expect(track.applyConstraints).toHaveBeenCalledOnce();
    expect(result.focusMode).toBe('manual'); expect(result.focusDistance?.current).toBe(5);
  });

  it('refuses unsupported modes and invalid manual values before touching the camera', async () => {
    const { stream, track, capabilities } = focusCamera(), { setCameraFocus } = await import('../src/pdd-camera');
    capabilities.focusMode = ['continuous'];
    await expect(setCameraFocus(stream, 'manual', 3)).rejects.toMatchObject({ name: 'NotSupportedError' });
    capabilities.focusMode = ['continuous', 'manual'];
    await expect(setCameraFocus(stream, 'manual', 11)).rejects.toThrow('范围');
    await expect(setCameraFocus(stream, 'manual', Number.NaN)).rejects.toThrow('范围');
    await expect(setCameraFocus(stream, 'manual', 3.25)).rejects.toThrow('步长');
    await expect(setCameraFocus(stream, 'continuous', 3)).rejects.toMatchObject({ name: 'NotSupportedError' });
    expect(track.applyConstraints).not.toHaveBeenCalled();
  });

  it('surfaces a real applyConstraints rejection and retains the observed settings', async () => {
    const { stream, track } = focusCamera(), { setCameraFocus, describeCamera } = await import('../src/pdd-camera');
    const denied = new DOMException('Driver refused focus mode', 'OverconstrainedError');
    track.applyConstraints.mockRejectedValueOnce(denied);
    await expect(setCameraFocus(stream, 'manual', 3)).rejects.toBe(denied);
    expect(describeCamera(stream).focusMode).toBe('continuous');
    expect(track.readyState).toBe('live');
  });

  it('serializes in-flight lens changes and replaces intermediate queued slider values', async () => {
    const { stream, track, settings } = focusCamera(), { setCameraFocus } = await import('../src/pdd-camera');
    const applying = deferred<void>();
    track.applyConstraints.mockImplementationOnce(() => applying.promise);
    const first = setCameraFocus(stream, 'continuous').catch(error => error);
    await vi.advanceTimersByTimeAsync(0); expect(track.applyConstraints).toHaveBeenCalledOnce();
    const middle = setCameraFocus(stream, 'manual', 4).catch(error => error);
    const latest = setCameraFocus(stream, 'manual', 7);
    await vi.advanceTimersByTimeAsync(0); expect(track.applyConstraints).toHaveBeenCalledOnce();
    applying.resolve();
    expect(await first).toMatchObject({ name: 'AbortError' });
    expect(await middle).toMatchObject({ name: 'AbortError' });
    expect((await latest).focusDistance?.current).toBe(7);
    expect(track.applyConstraints).toHaveBeenCalledTimes(2);
    expect(settings.focusMode).toBe('manual');
  });

  it('discards an in-flight focus result after session stop and rejects later controls', async () => {
    const { stream, track } = focusCamera(), { setCameraFocus, createCameraSession } = await import('../src/pdd-camera');
    const applying = deferred<void>(); track.applyConstraints.mockImplementationOnce(() => applying.promise);
    const session = createCameraSession(async () => stream); await session.ready;
    const pending = setCameraFocus(stream, 'manual', 3).catch(error => error);
    await vi.advanceTimersByTimeAsync(0); session.stop();
    expect(await pending).toMatchObject({ name: 'AbortError' });
    await expect(setCameraFocus(stream, 'continuous')).rejects.toMatchObject({ name: 'AbortError' });
    expect(track.applyConstraints).toHaveBeenCalledOnce(); expect(track.stop).toHaveBeenCalledOnce();
    applying.resolve(); await vi.advanceTimersByTimeAsync(0);
  });

  it('stops a late old-device grant without stopping the new device session', async () => {
    const oldGrant = deferred<MediaStream>(), old = focusCamera(), next = focusCamera();
    const { createCameraSession, cameraConstraintsForDevice } = await import('../src/pdd-camera');
    const oldSession = createCameraSession(() => oldGrant.promise, cameraConstraintsForDevice('old'));
    oldSession.stop();
    const nextSession = createCameraSession(async () => next.stream, cameraConstraintsForDevice('next'));
    await nextSession.ready; oldGrant.resolve(old.stream);
    await expect(oldSession.ready).rejects.toMatchObject({ name: 'AbortError' });
    expect(old.track.stop).toHaveBeenCalledOnce(); expect(next.track.stop).not.toHaveBeenCalled();
    nextSession.stop();
  });

  it('stops all camera tracks even if decoder cleanup fails', async () => {
    const { stream, track } = focusCamera(), { createCameraSession } = await import('../src/pdd-camera');
    const session = createCameraSession(async () => stream); await session.ready;
    session.attachDecoder({ stop() { throw new Error('Decoder cleanup failed'); } });
    expect(() => session.stop()).toThrow('Decoder cleanup failed');
    expect(track.stop).toHaveBeenCalledOnce(); session.stop();
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

function frozenPixelFixtures(initial: GrayFrame) {
  const { video, stream } = fixtures();
  Object.defineProperty(video, 'videoWidth', { value: initial.width });
  Object.defineProperty(video, 'videoHeight', { value: initial.height });
  let preview = initial;
  const frames = new Map<HTMLCanvasElement, GrayFrame>(), frozen: GrayFrame[] = [];
  vi.stubGlobal('document', { createElement: () => {
    let rotation = 0;
    const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
    const context = {
      translate() {}, rotate(value: number) { rotation = value; }, imageSmoothingEnabled: false, fillStyle: '#fff',
      fillRect() { rotation = 0; },
      drawImage(source: CanvasImageSource, ...args: number[]) {
        const frame = source === video ? preview : frames.get(source as HTMLCanvasElement)!;
        if (args.length === 4) {
          // Independently copy the current video pixels once. Subsequent video
          // changes cannot alter the canvas used by production capture passes.
          const copy = { ...frame, pixels: frame.pixels.slice() }; frames.set(canvas, copy); frozen.push(copy);
        } else {
          const [sourceX, sourceY, sourceWidth, sourceHeight, _x, _y, targetWidth, targetHeight] = args;
          frames.set(canvas, renderCapture(frame, {
            sourceX, sourceY, sourceWidth, sourceHeight, targetWidth, targetHeight,
            canvasWidth: canvas.width, canvasHeight: canvas.height,
            quarterTurn: Math.abs(rotation + Math.PI / 2) < 1e-8,
            tilt: Math.abs(rotation + Math.PI / 2) < 1e-8 ? 0 : rotation * 180 / Math.PI,
          }));
        }
      },
      getImageData() {
        const frame = frames.get(canvas)!;
        const rgba = new Uint8ClampedArray(frame.width * frame.height * 4);
        frame.pixels.forEach((value, index) => { rgba[index * 4] = rgba[index * 4 + 1] = rgba[index * 4 + 2] = value; rgba[index * 4 + 3] = 255; });
        return { data: rgba };
      },
    };
    return canvas;
  } });
  return { video, stream, frozen, changePreview(frame: GrayFrame) { preview = frame; } };
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

  it.each([25, 90])('decodes an actual frozen %s-degree photo after the live preview changes', async angle => {
    const source = syntheticCode128(angle), { video, stream, frozen, changePreview } = frozenPixelFixtures(source);
    decoder.fastDecode.mockImplementation(canvas => new actualBrowser.BrowserCodeReader(new actualLibrary.Code128Reader()).decodeFromCanvas(canvas));
    decoder.decode.mockImplementation(canvas => new actualBrowser.BrowserMultiFormatOneDReader(hints).decodeFromCanvas(canvas));
    const onDecoded = vi.fn(), { startBarcodeScanner } = await import('../src/pdd-camera');
    const scanner = startBarcodeScanner(stream, video, onDecoded, text => text === fixtureNumber, { mode: 'photo' }); await scanner.ready;
    const result = scanner.capture();
    changePreview({ ...source, pixels: new Uint8ClampedArray(source.width * source.height).fill(255) });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toEqual({ result: 'decoded', text: fixtureNumber });
    expect(frozen).toHaveLength(1); expect(frozen[0].pixels).toEqual(source.pixels);
    expect(onDecoded).toHaveBeenCalledExactlyOnceWith(fixtureNumber);
    expect(vi.getTimerCount()).toBe(0); scanner.stop();
  });

  it('retains more fine pixels for a high-resolution photo without upscaling a small camera frame', async () => {
    const { barcodeFramePlan } = await import('../src/pdd-camera');
    expect(barcodeFramePlan(3840, 2160, 7, 2048)).toMatchObject({ targetWidth: 2048, targetHeight: 1152 });
    expect(barcodeFramePlan(640, 480, 7, 2048)).toMatchObject({ targetWidth: 640, targetHeight: 480 });
  });
});
