import { track } from '@vercel/analytics';
import { TELEMETRY_EVENTS, TELEMETRY_DWELL_BUCKETS, telemetryMetadataKeys, validateTelemetryRows, type TelemetryEvent, type TelemetryRow, type TelemetryPage } from '../shared/telemetry';
import { addTelemetryEvent } from './pdd-telemetry';

export type AnalyticsPage = TelemetryPage;
const publicPages: Record<string, { page: AnalyticsPage; path: string }> = {
  '/': { page: 'home', path: '/' },
  '/help': { page: 'help', path: '/help' },
  '/community': { page: 'help', path: '/help' },
  '/privacy': { page: 'privacy', path: '/privacy' },
  '/local': { page: 'local', path: '/local' },
  '/insights': { page: 'insights', path: '/insights' },
  '/share': { page: 'share', path: '/share' },
};

// Do not generalize dynamic routes: management fragments and public codes must
// never become analytics identifiers. Unknown routes are excluded by default.
export function analyticsPage(pathname: string) {
  return Object.hasOwn(publicPages, pathname) ? publicPages[pathname] : null;
}

export function analyticsOptedOut(preferences: { doNotTrack?: string | null; globalPrivacyControl?: boolean }) {
  return preferences.doNotTrack === '1' || preferences.doNotTrack === 'yes' || preferences.globalPrivacyControl === true;
}

// Static deployments may omit the optional build flags. Keep the authorized
// public production site enabled while preventing preview/dev traffic mixing.
export function analyticsFeatureEnabled(flag: string | undefined, productionBuild: boolean, hostname: string) {
  if (flag === 'true') return true;
  if (flag !== undefined && flag !== '') return false;
  return productionBuild && (hostname === 'pdd404.app' || hostname === 'www.pdd404.app');
}

export function sanitizedAnalyticsUrl(value: string, origin: string) {
  try {
    const url = new URL(value, origin), page = analyticsPage(url.pathname);
    return page && url.origin === origin ? origin + page.path : null;
  } catch { return null; }
}

type EventSuffix<T extends string> = T extends `pdd_${infer Name}` ? Name : never;
export type AnalyticsEvent = Exclude<EventSuffix<TelemetryEvent>, 'page_view' | 'visible_dwell'>;
export const analyticsEvents = TELEMETRY_EVENTS.filter(event => event !== 'pdd_page_view' && event !== 'pdd_visible_dwell').map(event => event.slice(4));
export type AnalyticsMetadata = {
  mode?: 'lost' | 'received'; source?: 'manual' | 'barcode';
  scanMode?: 'photo' | 'realtime'; batch?: '1' | '2-5' | '6-20' | '21+';
};

export function analyticsBatchSize(size: number): AnalyticsMetadata['batch'] {
  return size <= 1 ? '1' : size <= 5 ? '2-5' : size <= 20 ? '6-20' : '21+';
}

// Runtime allowlists matter even with TypeScript: no DOM text, input values,
// contact type/value, notes, codes, query IDs, camera IDs or exception messages.
export function analyticsPayload(name: string, metadata: Record<string, unknown> = {}) {
  if (!(analyticsEvents as readonly string[]).includes(name)) return null;
  const data: Record<string, string> = {};
  const allowedKeys = telemetryMetadataKeys(('pdd_' + name) as TelemetryEvent);
  const values: Record<string, readonly string[]> = {
    mode: ['lost', 'received'], source: ['manual', 'barcode'], scanMode: ['photo', 'realtime'], batch: ['1', '2-5', '6-20', '21+'],
  };
  for (const key of allowedKeys) {
    const value = metadata[key];
    if (typeof value === 'string' && values[key].includes(value)) data[key] = value;
  }
  return { name: 'pdd_' + name, data };
}

export function createAnalyticsRecorder(send: (name: string, data: Record<string, string>) => void, allowed: () => boolean, limit = 100) {
  let sent = 0;
  return (name: AnalyticsEvent, metadata: AnalyticsMetadata = {}) => {
    if (!allowed() || sent >= limit) return;
    const event = analyticsPayload(name, metadata);
    if (!event) return;
    // Analytics failure must never turn a successful query into a failed one.
    try { send(event.name, event.data); sent++; } catch { /* optional telemetry */ }
  };
}

let runtimeEnabled = false, runtimeCustomEvents = false, runtimeBlocked = true, runtimeFirstParty = false, runtimeVercelCustom = false;
export function setAnalyticsRuntime(enabled: boolean, customEvents: boolean, blocked: boolean, firstParty = false, vercelCustom = customEvents) {
  runtimeEnabled = enabled; runtimeCustomEvents = customEvents; runtimeBlocked = blocked; runtimeFirstParty = firstParty; runtimeVercelCustom = vercelCustom;
}
export function browserAnalyticsAllowed() {
  return runtimeEnabled && !runtimeBlocked && typeof window !== 'undefined'
    && !!analyticsPage(window.location.pathname)
    && !analyticsOptedOut(navigator as Navigator & { globalPrivacyControl?: boolean });
}
export function customAnalyticsAllowed() { return browserAnalyticsAllowed() && runtimeCustomEvents; }
function sendPddEvent(name: string, data: Record<string, string>) {
  const page = analyticsPage(window.location.pathname);
  if (!page) return;
  if (runtimeFirstParty) {
    const row = validateTelemetryRows([{ event: name, page: page.page, count: 1, ...data }])[0];
    addTelemetryEvent(row);
  }
  if (runtimeVercelCustom) track(name, data);
}
export const trackPddEvent = createAnalyticsRecorder(sendPddEvent, customAnalyticsAllowed);
let pageViews = 0;
export function trackPddPageView(page: AnalyticsPage) {
  if (!browserAnalyticsAllowed() || !runtimeFirstParty || pageViews >= 20) return;
  addTelemetryEvent({ event: 'pdd_page_view', page, count: 1 }); pageViews++;
}

export function analyticsDwellBucket(milliseconds: number) {
  const seconds = Math.min(1800, Math.max(0, milliseconds / 1000));
  return seconds < 10 ? '0-9s' : seconds < 30 ? '10-29s' : seconds < 60 ? '30-59s'
    : seconds < 180 ? '1-2m' : seconds < 600 ? '3-9m' : '10-30m';
}

// One event per visible segment, flushed on hide, route change or pagehide.
// Hidden time is excluded; repeated hide/pagehide callbacks cannot double count.
export function createVisibleDwell(now: () => number, send: (bucket: string) => void, initiallyVisible = true) {
  let start: number | null = initiallyVisible ? now() : null;
  let finished = false, segments = 0;
  const flush = () => {
    if (start === null || finished) return;
    const elapsed = Math.min(1_800_000, Math.max(0, now() - start)); start = null;
    if (elapsed >= 1000 && segments < 10) { segments++; send(analyticsDwellBucket(elapsed)); }
  };
  return {
    visibility(visible: boolean) {
      if (finished) return;
      if (!visible) flush(); else if (start === null) start = now();
    },
    finish() { flush(); finished = true; },
  };
}

let dwellEvents = 0;
export function trackVisibleDwell(page: AnalyticsPage, bucket: string) {
  if (!runtimeEnabled || !runtimeCustomEvents || typeof navigator === 'undefined' || analyticsOptedOut(navigator as Navigator & { globalPrivacyControl?: boolean }) || dwellEvents >= 30 || !(TELEMETRY_DWELL_BUCKETS as readonly string[]).includes(bucket)) return;
  try {
    if (runtimeFirstParty) addTelemetryEvent({ event: 'pdd_visible_dwell', page, bucket: bucket as TelemetryRow['bucket'], count: 1 });
    if (runtimeVercelCustom && browserAnalyticsAllowed()) track('pdd_visible_dwell', { page, bucket });
    dwellEvents++;
  } catch { /* optional telemetry */ }
}
