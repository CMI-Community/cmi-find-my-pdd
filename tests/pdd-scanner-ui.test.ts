import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CameraDescription } from '../src/pdd-camera';

// Importing the UI must never create a real authentication client in tests.
vi.mock('@supabase/supabase-js', () => ({ createClient: () => null }));
import { createScannerCameraController, defaultPreviewMirror, initialScannerFocusDistance, observedScannerFocus, refreshScannerDevices, ScannerCameraControls, ScannerReadControls, ScannerDevicePicker, scannerFailureCanEnumerate, ScannerPreview, scannerFocusOptions } from '../src/PddApp';

function description(values: Partial<CameraDescription> = {}): CameraDescription { return { focusModes: [], ...values }; }
function stream() {
  const track = { stop: vi.fn(), readyState: 'live' };
  track.stop.mockImplementation(() => { track.readyState = 'ended'; });
  return { value: { getTracks: () => [track] } as unknown as MediaStream, track };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(next => { resolve = next; }); return { resolve, promise }; }
function controlsHtml(camera: CameraDescription, values: Record<string, unknown> = {}) {
  return renderToStaticMarkup(createElement(ScannerCameraControls, {
    camera, devices: [{ deviceId: 'synthetic-front', label: 'Synthetic front' }], selectedDevice: 'synthetic-front', mirrored: true, manualFocus: false, focusValue: 1, focusBusy: false, focusMessage: '', focusError: '', disabled: false,
    onCamera() {}, onMirror() {}, onFocusMode() {}, onDistance() {}, ...values,
  }));
}

describe('scanner preview and useful camera controls', () => {
  it('makes photo capture a separate user action and disables capture until ready or while decoding', () => {
    const props = { mode: 'photo' as const, ready: true, busy: false, onMode() {}, onCapture() {} };
    const ready = renderToStaticMarkup(createElement(ScannerReadControls, props));
    expect(ready).toContain('拍照并识别条形码');
    expect(ready).toContain('实时扫码');
    expect(ready.match(/<button[^>]*class="[^"]*pdd-capture-button[^>]*>/)?.[0]).not.toContain('disabled');
    const preparing = renderToStaticMarkup(createElement(ScannerReadControls, { ...props, ready: false }));
    expect(preparing.match(/<button[^>]*class="[^"]*pdd-capture-button[^>]*>/)?.[0]).toContain('disabled');
    const decoding = renderToStaticMarkup(createElement(ScannerReadControls, { ...props, busy: true }));
    expect(decoding).toContain('正在识别这张照片');
    expect(decoding.match(/<button[^>]*class="[^"]*pdd-capture-button[^>]*>/)?.[0]).toContain('disabled');
    const realtime = renderToStaticMarkup(createElement(ScannerReadControls, { ...props, mode: 'realtime' }));
    expect(realtime).not.toContain('pdd-capture-button');
    expect(realtime).not.toContain('正在识别这张照片');
  });
  it('follows observed front/rear settings and uses distinct desktop/mobile fallback', () => {
    expect(defaultPreviewMirror(description({ facingMode: 'user' }), false)).toBe(true);
    expect(defaultPreviewMirror(description({ facingMode: 'user' }), true)).toBe(true);
    expect(defaultPreviewMirror(description({ facingMode: 'environment' }), false)).toBe(false);
    expect(defaultPreviewMirror(description({ facingMode: 'environment' }), true)).toBe(false);
    expect(defaultPreviewMirror(description(), false)).toBe(true);
    expect(defaultPreviewMirror(description(), true)).toBe(false);
  });
  it('renders mirror state on the video only, without introducing another camera or media source', () => {
    const videoRef = { current: null };
    const mirrored = renderToStaticMarkup(createElement(ScannerPreview, { videoRef, mirrored: true, onDimensions() {} }));
    const regular = renderToStaticMarkup(createElement(ScannerPreview, { videoRef, mirrored: false, onDimensions() {} }));
    expect(mirrored).toContain('data-preview-mirrored="true"');
    expect(regular).toContain('data-preview-mirrored="false"');
    expect(mirrored).toMatch(/^<video\b[^>]*><\/video>$/);
    expect(mirrored).not.toContain('src=');
  });
  it('does not invent autofocus or a usable slider from missing/constant capabilities', () => {
    expect(scannerFocusOptions(description())).toEqual({ automatic: null, manual: false });
    expect(scannerFocusOptions(description({ focusModes: ['manual'] }))).toEqual({ automatic: null, manual: false });
    expect(scannerFocusOptions(description({ focusModes: ['manual'], focusDistance: { min: 1, max: 1 } })).manual).toBe(false);
    const fixed = controlsHtml(description({ focusModes: ['manual'], focusDistance: { min: 1, max: 1 } }), { manualFocus: true });
    expect(fixed).not.toContain('type="range"');
    expect(fixed).toContain('当前摄像头暂不支持在网页中调焦');
    expect(fixed).toContain('不要继续靠近');
    expect(fixed).not.toContain('没有自动对焦');
  });
  it('provides a supported automatic choice and defers manual controls until settings confirm manual', () => {
    const camera = description({ focusModes: ['single-shot', 'continuous', 'manual'], focusDistance: { min: .1, max: 3 } });
    expect(scannerFocusOptions(camera)).toEqual({ automatic: 'continuous', manual: true });
    expect(scannerFocusOptions(description({ focusModes: ['single-shot'] })).automatic).toBe('single-shot');
    expect(observedScannerFocus(camera, 'manual')).toEqual({ confirmed: false, manual: false });
    expect(observedScannerFocus({ ...camera, focusMode: 'continuous' }, 'manual')).toEqual({ confirmed: false, manual: false });
    expect(observedScannerFocus({ ...camera, focusMode: 'manual' }, 'manual')).toEqual({ confirmed: true, manual: true });
    expect(controlsHtml(camera)).not.toContain('type="range"');
    const manual = controlsHtml({ ...camera, focusMode: 'manual' }, { manualFocus: true });
    expect(manual).toContain('type="range"');
    expect(manual).toContain('step="any"');
    expect(manual).toContain('慢慢拖动，直到黑白线条清楚');
  });
  it('chooses a valid initial focus request including offset steps and nonaligned maxima', () => {
    const camera = description({ focusModes: ['manual'], focusDistance: { min: .1, max: 2.4, step: .5 } });
    const value = initialScannerFocusDistance(camera);
    expect(value).toBeGreaterThanOrEqual(.1);
    expect(value).toBeLessThanOrEqual(2.4);
    expect((value - .1) / .5).toBeCloseTo(Math.round((value - .1) / .5));
    expect(initialScannerFocusDistance({ ...camera, focusDistance: { min: .1, max: 2.4, step: .5, current: 99 } })).toBe(2.1);
    expect(initialScannerFocusDistance(description({ focusDistance: { min: 0, max: 1, current: .73 } }))).toBe(.73);
  });
  it('shows camera selection only for multiple cameras and keeps it usable after a camera failure', () => {
    expect(controlsHtml(description())).not.toContain('<select');
    const html = controlsHtml(description(), { devices: [{ deviceId: 'a', label: 'A' }, { deviceId: 'b', label: 'B' }], selectedDevice: 'b', disabled: true });
    expect(html).toContain('选择摄像头');
    expect(html).toContain('value="b" selected');
    const select = html.match(/<select\b[^>]*>/)?.[0];
    expect(select).toBeTruthy();
    expect(select).not.toContain('disabled');
  });
  it('reports focus failure separately without disabling a supported slider or asserting clarity', () => {
    const html = controlsHtml(description({ focusMode: 'manual', focusModes: ['manual'], focusDistance: { min: 0, max: 2, step: .2 } }), { manualFocus: true, focusBusy: true, focusError: '对焦调整没有成功，扫码仍在继续。' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('正在调整对焦，相机保持开启');
    expect(html.match(/<input\b[^>]*type="range"[^>]*>/)?.[0]).not.toContain('disabled');
    expect(html).not.toContain('已清晰');
  });
  it('allows device recovery after initial hardware/constraint failures, but not permission refusal', async () => {
    expect(scannerFailureCanEnumerate(new DOMException('synthetic', 'NotReadableError'))).toBe(true);
    expect(scannerFailureCanEnumerate(new DOMException('synthetic', 'OverconstrainedError'))).toBe(true);
    expect(scannerFailureCanEnumerate(new DOMException('synthetic', 'NotAllowedError'))).toBe(false);
    expect(scannerFailureCanEnumerate(new DOMException('synthetic', 'SecurityError'))).toBe(false);
    const available = [{ kind: 'videoinput', deviceId: 'a', label: '' }, { kind: 'videoinput', deviceId: 'b', label: 'Synthetic external' }, { kind: 'audioinput', deviceId: 'audio', label: 'Synthetic microphone' }] as MediaDeviceInfo[];
    let devices: { deviceId: string; label: string }[] = [];
    await refreshScannerDevices({ enumerateDevices: async () => available }, () => true, value => { devices = value; });
    const html = renderToStaticMarkup(createElement(ScannerDevicePicker, { devices, selectedDevice: '', onCamera() {} }));
    expect(html).toContain('请选择摄像头');
    expect(html).toContain('Synthetic external');
    expect(html).not.toContain('Synthetic microphone');
    expect(html).not.toContain('disabled');
    expect(html).not.toContain('当前摄像头');
  });
  it('discards late device enumeration after a different request becomes current', async () => {
    const enumeration = deferred<MediaDeviceInfo[]>(), onDevices = vi.fn();
    let current = true;
    const pending = refreshScannerDevices({ enumerateDevices: () => enumeration.promise }, () => current, onDevices);
    current = false; enumeration.resolve([{ kind: 'videoinput', deviceId: 'old', label: 'Old camera' }] as MediaDeviceInfo[]);
    await pending;
    expect(onDevices).not.toHaveBeenCalled();
    await refreshScannerDevices({ enumerateDevices: async () => { throw new Error('Synthetic enumeration failure'); } }, () => true, onDevices);
    expect(onDevices).not.toHaveBeenCalled();
  });
});

describe('scanner view camera switching lifecycle', () => {
  it('requests permission immediately, then stops the old tracks and decoder before a selected device opens', async () => {
    const first = stream(), second = stream();
    const getUserMedia = vi.fn().mockResolvedValueOnce(first.value).mockImplementationOnce(async () => { expect(first.track.stop).toHaveBeenCalledOnce(); return second.value; });
    const controller = createScannerCameraController(getUserMedia);
    const firstSession = controller.open();
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(getUserMedia.mock.calls[0][0].video.facingMode).toEqual({ ideal: 'environment' });
    await firstSession.ready;
    const decoder = { stop: vi.fn() }; firstSession.attachDecoder(decoder);
    const secondSession = controller.open('synthetic-back');
    expect(decoder.stop).toHaveBeenCalledOnce();
    expect(getUserMedia.mock.calls[1][0].video.deviceId).toEqual({ exact: 'synthetic-back' });
    await secondSession.ready;
    expect(controller.isCurrent(firstSession)).toBe(false);
    expect(controller.isCurrent(secondSession)).toBe(true);
    // A stale view's cleanup uses its owned session, not the controller's new session.
    firstSession.stop();
    expect(second.track.stop).not.toHaveBeenCalled();
    controller.stop(); expect(second.track.stop).toHaveBeenCalledOnce();
  });
  it('stops an old permission grant that arrives after switching without stopping the new session', async () => {
    const grant = deferred<MediaStream>(), late = stream(), current = stream();
    const getUserMedia = vi.fn().mockReturnValueOnce(grant.promise).mockResolvedValueOnce(current.value);
    const controller = createScannerCameraController(getUserMedia), old = controller.open();
    const rejected = expect(old.ready).rejects.toMatchObject({ name: 'AbortError' });
    const next = controller.open('synthetic-next'); await next.ready;
    grant.resolve(late.value); await rejected;
    expect(late.track.stop).toHaveBeenCalledOnce();
    expect(current.track.stop).not.toHaveBeenCalled();
    expect(controller.isCurrent(next)).toBe(true);
    controller.stop();
  });
  it('closing a pending permission request never leaves its later stream running', async () => {
    const grant = deferred<MediaStream>(), late = stream();
    const controller = createScannerCameraController(() => grant.promise), session = controller.open();
    const rejected = expect(session.ready).rejects.toMatchObject({ name: 'AbortError' });
    controller.stop(); controller.stop(); grant.resolve(late.value); await rejected;
    expect(late.track.stop).toHaveBeenCalledOnce();
    expect(controller.isCurrent(session)).toBe(false);
  });
});
