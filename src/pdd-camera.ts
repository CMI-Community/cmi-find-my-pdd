export type DecoderControls = { stop: () => void };
export type CameraSession = { ready: Promise<MediaStream>; attachDecoder: (controls: DecoderControls) => void; stop: () => void };

/** Closing a permission prompt's view must also stop a stream granted afterwards. */
export function createCameraSession(getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>): CameraSession {
  let stopped = false, stream: MediaStream | null = null, decoder: DecoderControls | null = null;
  const ready = getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } }).then(value => {
    if (stopped) { value.getTracks().forEach(track => track.stop()); throw new DOMException('Camera view was closed.', 'AbortError'); }
    stream = value;
    return value;
  });
  return {
    ready,
    attachDecoder(controls) { if (stopped) controls.stop(); else decoder = controls; },
    stop() { if (stopped) return; stopped = true; decoder?.stop(); decoder = null; stream?.getTracks().forEach(track => track.stop()); stream = null; },
  };
}
