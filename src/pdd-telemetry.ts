import { TELEMETRY_MAX_BYTES, TELEMETRY_MAX_ROWS, validateTelemetryRows, type TelemetryRow } from '../shared/telemetry';

// Only aggregate counters are buffered in memory. No cookie, device/session ID,
// browser storage, input text or address is needed for this transport.
export function createTelemetryBuffer(send: (payload: string, final: boolean) => void, allowed: () => boolean, maxBatches = 4) {
  const rows = new Map<string, TelemetryRow>();
  let batches = 0;
  return {
    add(input: TelemetryRow) {
      if (!allowed() || batches >= maxBatches) return;
      let row: TelemetryRow;
      try { row = validateTelemetryRows([input])[0]; } catch { return; }
      const { count, ...dimensions } = row, key = JSON.stringify(dimensions), previous = rows.get(key);
      if (previous) previous.count = Math.min(100, previous.count + count);
      else if (rows.size < TELEMETRY_MAX_ROWS) rows.set(key, row);
    },
    flush(final = false) {
      if (!rows.size) return;
      if (!allowed() || batches >= maxBatches) { rows.clear(); return; }
      const payload = JSON.stringify({ events: [...rows.values()] }); rows.clear();
      if (new TextEncoder().encode(payload).byteLength > TELEMETRY_MAX_BYTES) return;
      batches++;
      // Best effort; a missing acknowledgement never causes retries or blocks a
      // query. Counts describe observed use and are not business/recovery facts.
      try { send(payload, final); } catch { /* optional telemetry */ }
    },
  };
}

let enabled = false;
export function setFirstPartyTelemetryEnabled(value: boolean) { enabled = value; }
const apiBase = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const endpoint = apiBase + '/v1/telemetry';
function permitted() {
  if (!enabled || !apiBase || typeof navigator === 'undefined') return false;
  const preferences = navigator as Navigator & { globalPrivacyControl?: boolean };
  return preferences.doNotTrack !== '1' && preferences.doNotTrack !== 'yes' && preferences.globalPrivacyControl !== true;
}
function send(payload: string, final: boolean) {
  // text/plain is a CORS simple request, so the server validates the JSON body
  // without an extra preflight during pagehide. The body stays below 8 KiB.
  if (final && typeof navigator.sendBeacon === 'function') {
    try { if (navigator.sendBeacon(endpoint, payload)) return; } catch { /* use fetch fallback */ }
  }
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  void fetch(endpoint, { method: 'POST', body: payload, headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true, signal: controller.signal,
  }).catch(() => undefined).finally(() => clearTimeout(timer));
}
const buffer = createTelemetryBuffer(send, permitted);
export const addTelemetryEvent = buffer.add;
export const flushTelemetry = buffer.flush;
