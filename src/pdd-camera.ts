export type DecoderControls = { stop: () => void };
export type BarcodeScanMode = 'realtime' | 'photo';
export type BarcodeSnapshotResult = { result: 'decoded'; text: string } | { result: 'not_found' };
export type BarcodeScannerControls = DecoderControls & {
  ready: Promise<void>;
  setMode: (mode: BarcodeScanMode) => void;
  capture: () => Promise<BarcodeSnapshotResult>;
};
export type CameraSession = { ready: Promise<MediaStream>; attachDecoder: (controls: DecoderControls) => void; stop: () => void };
export type CameraFocusMode = 'continuous' | 'single-shot' | 'manual';
export type CameraDescription = {
  deviceId?: string;
  facingMode?: string;
  focusMode?: CameraFocusMode;
  focusModes: CameraFocusMode[];
  focusDistance?: { min: number; max: number; step?: number; current?: number };
};

export function cameraConstraintsForDevice(deviceId?: string): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
      width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 },
    },
  };
}
export const cameraConstraints = cameraConstraintsForDevice();

type FocusCapabilities = MediaTrackCapabilities & { focusMode?: string[]; focusDistance?: { min?: number; max?: number; step?: number } };
type FocusSettings = MediaTrackSettings & { focusMode?: string; focusDistance?: number };
type FocusConstraints = MediaTrackConstraints & { focusMode?: ConstrainDOMString; focusDistance?: ConstrainDouble };
const focusModes: CameraFocusMode[] = ['continuous', 'single-shot', 'manual'];
const isFocusMode = (value: unknown): value is CameraFocusMode => focusModes.includes(value as CameraFocusMode);
const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Missing browser capabilities stay missing; a request is not an observed setting. */
export function describeCamera(stream: MediaStream): CameraDescription {
  const track = stream.getVideoTracks?.()[0];
  let capabilities: FocusCapabilities = {}, settings: FocusSettings = {};
  try { capabilities = track?.getCapabilities?.() ?? {}; } catch { /* Older browsers may not expose camera controls. */ }
  try { settings = track?.getSettings?.() ?? {}; } catch { /* Do not infer the actual device from requested constraints. */ }
  const description: CameraDescription = { focusModes: focusModes.filter(mode => Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes(mode)) };
  if (typeof settings.deviceId === 'string' && settings.deviceId) description.deviceId = settings.deviceId;
  if (typeof settings.facingMode === 'string' && settings.facingMode) description.facingMode = settings.facingMode;
  if (isFocusMode(settings.focusMode)) description.focusMode = settings.focusMode;
  const range = capabilities.focusDistance;
  if (finiteNumber(range?.min) && finiteNumber(range?.max) && range.min <= range.max) {
    description.focusDistance = { min: range.min, max: range.max };
    if (finiteNumber(range.step) && range.step > 0) description.focusDistance.step = range.step;
    if (finiteNumber(settings.focusDistance)) description.focusDistance.current = settings.focusDistance;
  }
  return description;
}

const focusOperations = new WeakMap<MediaStreamTrack, { revision: number; tail: Promise<void>; cancel?: () => void }>();
function focusAborted() { return new DOMException('相机已关闭、已切换，或有更新的对焦请求。', 'AbortError'); }
function trackEnded(track: MediaStreamTrack) { return track.readyState === 'ended'; }
function stopCameraTrack(track: MediaStreamTrack) {
  const state = focusOperations.get(track);
  if (state) { state.revision++; state.cancel?.(); }
  track.stop();
}

/** Serialize lens changes. A newer request replaces queued work and stale UI results. */
export async function setCameraFocus(stream: MediaStream, mode: CameraFocusMode, distance?: number): Promise<CameraDescription> {
  const track = stream.getVideoTracks?.()[0];
  if (!track || trackEnded(track)) throw focusAborted();
  const state = focusOperations.get(track) ?? { revision: 0, tail: Promise.resolve() };
  focusOperations.set(track, state);
  const revision = ++state.revision;
  const operation = state.tail.then(async () => {
    if (trackEnded(track) || revision !== state.revision) throw focusAborted();
    const description = describeCamera(stream);
    if (!description.focusModes.includes(mode)) throw new DOMException('这台摄像头或浏览器不支持所选对焦方式。请调整包裹距离或选择另一台摄像头。', 'NotSupportedError');
    if (distance !== undefined) {
      const range = description.focusDistance;
      if (mode !== 'manual' || !range) throw new DOMException('这台摄像头未提供可用的手动对焦调节。', 'NotSupportedError');
      if (!finiteNumber(distance) || distance < range.min || distance > range.max) throw new RangeError('对焦值超出这台摄像头支持的范围。');
      if (range.step) {
        const steps = (distance - range.min) / range.step;
        if (Math.abs(steps - Math.round(steps)) > 1e-6) throw new RangeError('对焦值不符合这台摄像头支持的调节步长。');
      }
    }
    const constraints = { ...track.getConstraints?.() } as FocusConstraints;
    // Retain camera/resolution/exposure constraints, but replace prior focus choices.
    delete constraints.focusMode; delete constraints.focusDistance;
    if (constraints.advanced) constraints.advanced = constraints.advanced.map(value => {
      const next = { ...value } as FocusConstraints;
      delete next.focusMode; delete next.focusDistance;
      return next;
    }).filter(value => Object.keys(value).length > 0);
    constraints.focusMode = { exact: mode };
    if (distance !== undefined) constraints.focusDistance = { exact: distance };
    // Older Chromium camera controls read bare values in the first advanced
    // set. Mirror the same atomic choice there without discarding its other
    // controls; required basic values still apply in conforming browsers.
    const advanced = constraints.advanced ?? [];
    constraints.advanced = [
      { ...advanced[0], focusMode: mode, ...(distance !== undefined ? { focusDistance: distance } : {}) } as FocusConstraints,
      ...advanced.slice(1),
    ];
    let cancel!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => { cancel = () => reject(focusAborted()); });
    state.cancel = cancel;
    track.addEventListener?.('ended', cancel, { once: true });
    try { await Promise.race([track.applyConstraints(constraints), aborted]); }
    finally {
      track.removeEventListener?.('ended', cancel);
      if (state.cancel === cancel) state.cancel = undefined;
    }
    if (trackEnded(track) || revision !== state.revision) throw focusAborted();
    return describeCamera(stream);
  });
  state.tail = operation.then(() => undefined, () => undefined);
  return operation;
}

/** Closing a permission prompt's view must also stop a stream granted afterwards. */
export function createCameraSession(getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>, constraints: MediaStreamConstraints = cameraConstraints): CameraSession {
  let stopped = false, stream: MediaStream | null = null, decoder: DecoderControls | null = null;
  const ready = getUserMedia(constraints).then(value => {
    if (stopped) { value.getTracks().forEach(stopCameraTrack); throw new DOMException('Camera view was closed.', 'AbortError'); }
    stream = value;
    return value;
  });
  return {
    ready,
    attachDecoder(controls) { if (stopped) controls.stop(); else { if (decoder && decoder !== controls) decoder.stop(); decoder = controls; } },
    stop() {
      if (stopped) return;
      stopped = true;
      const currentDecoder = decoder, currentStream = stream;
      decoder = null; stream = null;
      try { currentDecoder?.stop(); } finally { currentStream?.getTracks().forEach(stopCameraTrack); }
    },
  };
}

type NativeDetector = { detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]> };
type NativeDetectorConstructor = { new(options: { formats: string[] }): NativeDetector; getSupportedFormats: () => Promise<string[]> };
const videoScanners = new WeakMap<HTMLVideoElement, DecoderControls>();

/** Geometry shared by the capture loop and real-pixel decoder verification. */
export function barcodeFramePlan(width: number, height: number, pass: number, maximumDimension = 1280) {
  const variant = pass % 10, whole = variant === 7 || variant === 9, quarterTurn = variant === 9;
  const tilt = variant === 1 ? -12 : variant === 2 ? 12 : variant === 4 ? -25 : variant === 5 ? 25 : 0;
  const sourceWidth = whole ? width : width * .84, sourceHeight = whole ? height : height * (tilt ? .7 : .44);
  const sourceX = (width - sourceWidth) / 2;
  const sourceY = variant === 3 ? height * .02 : variant === 6 ? height * .54 : (height - sourceHeight) / 2;
  const scale = Math.min(1, maximumDimension / Math.max(sourceWidth, sourceHeight));
  const targetWidth = Math.round(sourceWidth * scale), targetHeight = Math.round(sourceHeight * scale);
  return { sourceX, sourceY, sourceWidth, sourceHeight, targetWidth, targetHeight, canvasWidth: quarterTurn ? targetHeight : targetWidth, canvasHeight: quarterTurn ? targetWidth : targetHeight, quarterTurn, tilt };
}

/** Preview and barcode decoding stay local. Photo mode waits for an explicit capture. */
export function startBarcodeScanner(stream: MediaStream, video: HTMLVideoElement, onDecoded: (text: string) => void, isValid: (text: string) => boolean = () => true, options: { mode?: BarcodeScanMode } = {}): BarcodeScannerControls {
  videoScanners.get(video)?.stop();
  let stopped = false, initialized = false, loopRunning = false, pass = 0, revision = 0;
  let mode = options.mode ?? 'realtime';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelNative: (() => void) | undefined, cancelPhoto: (() => void) | undefined;
  let photoPromise: Promise<BarcodeSnapshotResult> | undefined;
  let native: NativeDetector | undefined, nativeDisabled = false;
  let reader: { decodeFromCanvas: (canvas: HTMLCanvasElement) => { getText: () => string } };
  let code128Reader: typeof reader;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const aborted = () => new DOMException('相机已关闭、已切换，或识别方式已改变。', 'AbortError');
  const current = (token: number) => !stopped && token === revision && video.srcObject === stream && !stream.getVideoTracks?.().some(trackEnded);
  const assertCurrent = (token: number) => { if (!current(token)) throw aborted(); };
  const interrupt = () => {
    revision++;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    // A native detect promise cannot be cancelled. Disable that detector before
    // starting another operation, then ignore its late result without overlap.
    cancelNative?.(); cancelNative = undefined;
    cancelPhoto?.(); cancelPhoto = undefined;
  };
  const scheduleLive = (delay = 120) => {
    if (stopped || !initialized || mode !== 'realtime' || photoPromise || timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; void loop(); }, delay);
  };
  const controls: DecoderControls & { setMode: (next: BarcodeScanMode) => void } = {
    stop() {
      if (stopped) return;
      stopped = true; interrupt();
      if (videoScanners.get(video) === controls) videoScanners.delete(video);
      if (video.srcObject === stream) { video.pause(); video.srcObject = null; }
    },
    setMode(next) {
      if (stopped || next === mode) return;
      mode = next; interrupt();
      if (mode === 'realtime') scheduleLive(0);
    },
  };
  videoScanners.set(video, controls);
  const formats = ['code_128', 'code_39', 'code_93', 'itf', 'codabar'];
  const Native = (globalThis as typeof globalThis & { BarcodeDetector?: NativeDetectorConstructor }).BarcodeDetector;
  const nativeReady = typeof Native?.getSupportedFormats === 'function' ? Promise.resolve().then(() => Native.getSupportedFormats()).then(supported => {
    const supportedFormats = formats.filter(format => supported.includes(format));
    if (!stopped && !nativeDisabled && supportedFormats.length) native = new Native({ formats: supportedFormats });
  }).catch(() => undefined) : Promise.resolve();
  const readerReady = Promise.all([import('@zxing/browser'), import('@zxing/library')]).then(([browser, library]) => {
    const hints = new Map();
    hints.set(library.DecodeHintType.POSSIBLE_FORMATS, [library.BarcodeFormat.CODE_128, library.BarcodeFormat.CODE_39, library.BarcodeFormat.CODE_93, library.BarcodeFormat.ITF, library.BarcodeFormat.CODABAR]);
    code128Reader = new browser.BrowserCodeReader(new library.Code128Reader());
    reader = new browser.BrowserMultiFormatOneDReader(hints);
  });
  void readerReady.catch(() => undefined); // ready still propagates failures to the scanner view.

  const drawFrame = (source: CanvasImageSource, width: number, height: number, framePass: number, maximumDimension = 1280) => {
    if (!width || !height || !context) return false;
    const { sourceX, sourceY, sourceWidth, sourceHeight, targetWidth, targetHeight, canvasWidth, canvasHeight, quarterTurn, tilt } = barcodeFramePlan(width, height, framePass, maximumDimension);
    canvas.width = canvasWidth; canvas.height = canvasHeight;
    context.imageSmoothingEnabled = false;
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    if (quarterTurn) { context.translate(0, targetWidth); context.rotate(-Math.PI / 2); }
    else if (tilt) { context.translate(targetWidth / 2, targetHeight / 2); context.rotate(tilt * Math.PI / 180); context.translate(-targetWidth / 2, -targetHeight / 2); }
    context.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, targetWidth, targetHeight);
    return true;
  };
  const decodeFrame = async (token: number) => {
    assertCurrent(token);
    let text: string | undefined;
    if (native) {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const timedOut = Symbol('timeout'), cancelled = Symbol('cancelled');
        const result = await Promise.race([native.detect(canvas), new Promise<typeof timedOut | typeof cancelled>(resolve => {
          deadline = setTimeout(() => resolve(timedOut), 300);
          cancelNative = () => {
            nativeDisabled = true; native = undefined;
            if (deadline !== undefined) clearTimeout(deadline);
            resolve(cancelled);
          };
        })]);
        if (result === cancelled) throw aborted();
        if (result === timedOut) { nativeDisabled = true; native = undefined; }
        else text = result.find(value => value.rawValue && isValid(value.rawValue))?.rawValue;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        nativeDisabled = true; native = undefined;
      } finally { if (deadline !== undefined) clearTimeout(deadline); cancelNative = undefined; }
    }
    assertCurrent(token);
    if (!text) { try { const candidate = code128Reader.decodeFromCanvas(canvas).getText(); if (candidate && isValid(candidate)) text = candidate; } catch { /* Try the other domestic label formats below. */ } }
    if (!text) { try { const candidate = reader.decodeFromCanvas(canvas).getText(); if (candidate && isValid(candidate)) text = candidate; } catch { /* No readable barcode in this frame. */ } }
    return text;
  };
  const loop = async () => {
    if (stopped || loopRunning || mode !== 'realtime' || photoPromise) return;
    if (video.srcObject !== stream) { controls.stop(); return; }
    loopRunning = true;
    const token = revision;
    try {
      if (drawFrame(video, video.videoWidth, video.videoHeight, pass++)) {
        const text = await decodeFrame(token);
        if (current(token) && text) onDecoded(text);
      }
    } catch {
      // Camera changes can make a frame unavailable. Only a current live mode
      // schedules the next frame; cancelled work never publishes a late result.
    } finally { loopRunning = false; scheduleLive(); }
  };
  const ready = (async () => {
    if (!context) throw new Error('当前浏览器无法读取相机画面，请直接输入单号。');
    video.srcObject = stream;
    void nativeReady;
    await Promise.all([video.play(), readerReady]);
    if (stopped) return;
    initialized = true;
    if (mode === 'realtime') void loop();
  })();
  const capture = (): Promise<BarcodeSnapshotResult> => {
    if (photoPromise) return photoPromise;
    if (stopped || video.srcObject !== stream || stream.getVideoTracks?.().some(trackEnded)) return Promise.reject(aborted());
    const width = video.videoWidth, height = video.videoHeight;
    if (!width || !height) return Promise.reject(new DOMException('相机画面还未准备好，请稍等后再拍照识别。', 'InvalidStateError'));
    const photo = document.createElement('canvas'), photoContext = photo.getContext('2d', { willReadFrequently: true });
    if (!photoContext) return Promise.reject(new Error('当前浏览器无法读取拍照画面，请直接输入单号。'));
    photo.width = width; photo.height = height;
    try { photoContext.drawImage(video, 0, 0, width, height); }
    catch { return Promise.reject(new DOMException('暂时无法拍下相机画面，请稳住后重试。', 'InvalidStateError')); }
    // Freeze once, with no CSS mirroring. Every later attempt uses this canvas,
    // even when the preview or package moves after the user's click.
    interrupt();
    const token = revision;
    let completed = false, yieldTimer: ReturnType<typeof setTimeout> | undefined, cancelYield: (() => void) | undefined;
    let rejectCancellation!: (error: DOMException) => void;
    const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
    const cancel = () => {
      if (completed) return;
      cancelYield?.(); rejectCancellation(aborted());
    };
    cancelPhoto = cancel;
    const yieldToUI = () => new Promise<void>((resolve, reject) => {
      yieldTimer = setTimeout(() => { yieldTimer = undefined; cancelYield = undefined; resolve(); }, 16);
      cancelYield = () => { if (yieldTimer !== undefined) clearTimeout(yieldTimer); yieldTimer = undefined; reject(aborted()); };
    });
    const run = (async (): Promise<BarcodeSnapshotResult> => {
      await Promise.race([ready, cancellation]);
      assertCurrent(token);
      // Nine distinct, bounded attempts. Full-frame and vertical attempts lead;
      // photo decoding retains up to 2048 pixels without upscaling small frames.
      for (const framePass of [7, 9, 0, 1, 2, 3, 4, 5, 6]) {
        await yieldToUI(); assertCurrent(token);
        if (drawFrame(photo, width, height, framePass, 2048)) {
          const text = await decodeFrame(token); assertCurrent(token);
          if (text) {
            completed = true; onDecoded(text);
            return { result: 'decoded', text };
          }
        }
      }
      completed = true;
      return { result: 'not_found' };
    })();
    const task = Promise.race([run, cancellation]).finally(() => {
      if (yieldTimer !== undefined) clearTimeout(yieldTimer);
      if (cancelPhoto === cancel) cancelPhoto = undefined;
      // Release pixels, including on close or a failed decoder initialization.
      photo.width = 0; photo.height = 0;
      if (photoPromise === task) { photoPromise = undefined; scheduleLive(0); }
    });
    photoPromise = task;
    return task;
  };
  return { ...controls, ready, capture };
}
