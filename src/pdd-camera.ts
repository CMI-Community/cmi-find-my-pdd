export type DecoderControls = { stop: () => void };
export type CameraSession = { ready: Promise<MediaStream>; attachDecoder: (controls: DecoderControls) => void; stop: () => void };

export const cameraConstraints: MediaStreamConstraints = {
  audio: false,
  video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
};

function preferContinuousFocus(stream: MediaStream) {
  for (const track of stream.getVideoTracks?.() ?? []) {
    try {
      const capabilities = track.getCapabilities?.() as MediaTrackCapabilities & { focusMode?: string[] };
      if (capabilities?.focusMode?.includes('continuous')) {
        // Unsupported cameras keep their normal focus; failure must not hide the preview.
        void track.applyConstraints({ ...track.getConstraints?.(), advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => undefined);
      }
    } catch { /* Older Safari and fixed-focus webcams may not expose capabilities. */ }
  }
}

/** Closing a permission prompt's view must also stop a stream granted afterwards. */
export function createCameraSession(getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>): CameraSession {
  let stopped = false, stream: MediaStream | null = null, decoder: DecoderControls | null = null;
  const ready = getUserMedia(cameraConstraints).then(value => {
    if (stopped) { value.getTracks().forEach(track => track.stop()); throw new DOMException('Camera view was closed.', 'AbortError'); }
    stream = value;
    preferContinuousFocus(value);
    return value;
  });
  return {
    ready,
    attachDecoder(controls) { if (stopped) controls.stop(); else decoder = controls; },
    stop() { if (stopped) return; stopped = true; decoder?.stop(); decoder = null; stream?.getTracks().forEach(track => track.stop()); stream = null; },
  };
}

type NativeDetector = { detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]> };
type NativeDetectorConstructor = { new(options: { formats: string[] }): NativeDetector; getSupportedFormats: () => Promise<string[]> };

/** Geometry shared by the capture loop and real-pixel decoder verification. */
export function barcodeFramePlan(width: number, height: number, pass: number) {
  const variant = pass % 10, whole = variant === 7 || variant === 9, quarterTurn = variant === 9;
  const tilt = variant === 1 ? -12 : variant === 2 ? 12 : variant === 4 ? -25 : variant === 5 ? 25 : 0;
  const sourceWidth = whole ? width : width * .84, sourceHeight = whole ? height : height * (tilt ? .7 : .44);
  const sourceX = (width - sourceWidth) / 2;
  const sourceY = variant === 3 ? height * .02 : variant === 6 ? height * .54 : (height - sourceHeight) / 2;
  const scale = Math.min(1, 1280 / Math.max(sourceWidth, sourceHeight));
  const targetWidth = Math.round(sourceWidth * scale), targetHeight = Math.round(sourceHeight * scale);
  return { sourceX, sourceY, sourceWidth, sourceHeight, targetWidth, targetHeight, canvasWidth: quarterTurn ? targetHeight : targetWidth, canvasHeight: quarterTurn ? targetWidth : targetHeight, quarterTurn, tilt };
}

/** Start the preview immediately, then decode one frame at a time without uploading it. */
export function startBarcodeScanner(stream: MediaStream, video: HTMLVideoElement, onDecoded: (text: string) => void, isValid: (text: string) => boolean = () => true): DecoderControls & { ready: Promise<void> } {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, pass = 0;
  let native: NativeDetector | undefined;
  let reader: { decodeFromCanvas: (canvas: HTMLCanvasElement) => { getText: () => string } };
  let code128Reader: typeof reader;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const controls = { stop() { if (stopped) return; stopped = true; if (timer !== undefined) clearTimeout(timer); video.pause(); video.srcObject = null; } };
  const formats = ['code_128', 'code_39', 'code_93', 'itf', 'codabar'];
  const Native = (globalThis as typeof globalThis & { BarcodeDetector?: NativeDetectorConstructor }).BarcodeDetector;
  const nativeReady = typeof Native?.getSupportedFormats === 'function' ? Promise.resolve().then(() => Native.getSupportedFormats()).then(supported => {
    const supportedFormats = formats.filter(format => supported.includes(format));
    if (!stopped && supportedFormats.length) native = new Native({ formats: supportedFormats });
  }).catch(() => undefined) : Promise.resolve();
  const readerReady = Promise.all([import('@zxing/browser'), import('@zxing/library')]).then(([browser, library]) => {
    const hints = new Map();
    hints.set(library.DecodeHintType.POSSIBLE_FORMATS, [library.BarcodeFormat.CODE_128, library.BarcodeFormat.CODE_39, library.BarcodeFormat.CODE_93, library.BarcodeFormat.ITF, library.BarcodeFormat.CODABAR]);
    code128Reader = new browser.BrowserCodeReader(new library.Code128Reader());
    reader = new browser.BrowserMultiFormatOneDReader(hints);
  });
  void readerReady.catch(() => undefined); // ready still propagates failures to the scanner view.

  const drawFrame = () => {
    const width = video.videoWidth, height = video.videoHeight;
    if (!width || !height || !context) return false;
    // Most attempts use the guide's central band. Periodic whole-frame and explicit
    // quarter-turn passes also find codes outside it or held vertically.
    const { sourceX, sourceY, sourceWidth, sourceHeight, targetWidth, targetHeight, canvasWidth, canvasHeight, quarterTurn, tilt } = barcodeFramePlan(width, height, pass++);
    canvas.width = canvasWidth; canvas.height = canvasHeight;
    context.imageSmoothingEnabled = false;
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    if (quarterTurn) { context.translate(0, targetWidth); context.rotate(-Math.PI / 2); }
    else if (tilt) { context.translate(targetWidth / 2, targetHeight / 2); context.rotate(tilt * Math.PI / 180); context.translate(-targetWidth / 2, -targetHeight / 2); }
    context.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, targetWidth, targetHeight);
    return true;
  };
  const loop = async () => {
    if (stopped) return;
    try {
      if (drawFrame()) {
        let text: string | undefined;
        if (native) {
          let deadline: ReturnType<typeof setTimeout> | undefined;
          try {
            const timedOut = Symbol('timeout');
            const result = await Promise.race([native.detect(canvas), new Promise<typeof timedOut>(resolve => { deadline = setTimeout(() => resolve(timedOut), 300); })]);
            if (result === timedOut) native = undefined;
            else text = result.find(value => value.rawValue && isValid(value.rawValue))?.rawValue;
          }
          catch { native = undefined; }
          finally { if (deadline !== undefined) clearTimeout(deadline); }
        }
        if (stopped) return;
        if (!text) { try { const candidate = code128Reader.decodeFromCanvas(canvas).getText(); if (candidate && isValid(candidate)) text = candidate; } catch { /* Try the other domestic label formats below. */ } }
        if (!text) { try { const candidate = reader.decodeFromCanvas(canvas).getText(); if (candidate && isValid(candidate)) text = candidate; } catch { /* No readable barcode in this frame. */ } }
        if (text) onDecoded(text);
      }
    } catch {
      // A changing camera track can briefly make a frame unavailable. Try the
      // next frame without leaving a rejected asynchronous loop running.
    } finally {
      // Schedule after completion, so expensive frames never queue competing decodes.
      if (!stopped) timer = setTimeout(() => void loop(), 120);
    }
  };
  const ready = (async () => {
    if (!context) throw new Error('当前浏览器无法读取相机画面，请直接输入单号。');
    video.srcObject = stream;
    void nativeReady;
    await Promise.all([video.play(), readerReady]);
    if (stopped) return;
    void loop();
  })();
  return { ...controls, ready };
}
