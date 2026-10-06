import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyticsDwellBucket, analyticsFeatureEnabled, analyticsOptedOut, analyticsPage, analyticsPayload, browserAnalyticsAllowed, createAnalyticsRecorder, createVisibleDwell, sanitizedAnalyticsUrl, setAnalyticsRuntime, type AnalyticsEvent, type AnalyticsMetadata } from '../src/pdd-analytics';
afterEach(() => { vi.unstubAllGlobals(); setAnalyticsRuntime(false, false, true); });

describe('PDD404 anonymous analytics boundaries', () => {
  it('keeps omitted flags enabled only on the exact public production hosts', () => {
    for (const hostname of ['pdd404.app', 'www.pdd404.app']) {
      expect(analyticsFeatureEnabled(undefined, true, hostname)).toBe(true);
      expect(analyticsFeatureEnabled('', true, hostname)).toBe(true);
      expect(analyticsFeatureEnabled(undefined, false, hostname)).toBe(false);
    }
    for (const hostname of ['localhost', '127.0.0.1', 'pdd404-preview.vercel.app', 'pdd404.app.example.com', 'other.example', '']) {
      expect(analyticsFeatureEnabled(undefined, true, hostname)).toBe(false);
      expect(analyticsFeatureEnabled(undefined, false, hostname)).toBe(false);
    }
  });

  it('honors explicit disabling on production and requires explicit true elsewhere', () => {
    for (const production of [true, false]) for (const hostname of ['pdd404.app', 'www.pdd404.app', 'localhost', 'preview.vercel.app']) {
      expect(analyticsFeatureEnabled('false', production, hostname)).toBe(false);
      expect(analyticsFeatureEnabled('true', production, hostname)).toBe(true);
      expect(analyticsFeatureEnabled('unexpected', production, hostname)).toBe(false);
    }
  });

  it('uses an explicit static page allowlist and strips every query and fragment', () => {
    const origin = 'https://pdd404.app';
    expect(sanitizedAnalyticsUrl(origin + '/?mode=received&number=SYNTHETIC001#capability=secret', origin)).toBe(origin + '/');
    expect(sanitizedAnalyticsUrl(origin + '/community?contact=synthetic#token=secret', origin)).toBe(origin + '/help');
    expect(analyticsPage('/privacy')?.page).toBe('privacy');
    for (const path of ['/admin', '/admin/login', '/m/PDD-SYNTHETIC', '/manage/PDD-SYNTHETIC', '/p/PDD-SYNTHETIC', '/p/PDD-SYNTHETIC/share', '/unknown', '/constructor']) {
      expect(analyticsPage(path)).toBeNull();
      expect(sanitizedAnalyticsUrl(origin + path + '?secret=synthetic#cap=synthetic', origin)).toBeNull();
    }
    expect(sanitizedAnalyticsUrl('https://foreign.example/help', origin)).toBeNull();
    expect(sanitizedAnalyticsUrl('data:text/plain,synthetic', origin)).toBeNull();
  });

  it('honors Do Not Track and Global Privacy Control', () => {
    for (const preferences of [{ doNotTrack: '1' }, { doNotTrack: 'yes' }, { globalPrivacyControl: true }]) expect(analyticsOptedOut(preferences)).toBe(true);
    expect(analyticsOptedOut({ doNotTrack: '0', globalPrivacyControl: false })).toBe(false);
  });

  it('rechecks the live route for loaded SDK callbacks after SPA transitions to private pages', () => {
    const location = { pathname: '/', origin: 'https://pdd404.app' };
    vi.stubGlobal('window', { location }); vi.stubGlobal('navigator', { doNotTrack: '0' });
    setAnalyticsRuntime(true, true, false, true);
    expect(browserAnalyticsAllowed()).toBe(true);
    for (const privatePath of ['/admin', '/admin/login', '/m/PDD-SYNTHETIC', '/manage/PDD-SYNTHETIC', '/p/PDD-SYNTHETIC/share']) {
      location.pathname = privatePath; expect(browserAnalyticsAllowed()).toBe(false);
    }
    location.pathname = '/help'; expect(browserAnalyticsAllowed()).toBe(true);
    location.pathname = '/'; setAnalyticsRuntime(true, true, true, true);
    expect(browserAnalyticsAllowed()).toBe(false); // Admin recovery can render at '/'.
    setAnalyticsRuntime(true, true, false, true); vi.stubGlobal('navigator', { globalPrivacyControl: true });
    expect(browserAnalyticsAllowed()).toBe(false);
  });

  it('rejects event injection and discards private values and unexpected metadata', () => {
    expect(analyticsPayload('waybill_SYNTHETIC001', { contact: 'synthetic_contact' })).toBeNull();
    expect(analyticsPayload('query_matched', {
      mode: 'lost', source: 'barcode', contact: 'synthetic_contact', note: 'private', queryId: 'secret', url: '/m/private', cameraId: 'secret', result: 'synthetic',
    })).toEqual({ name: 'pdd_query_matched', data: { mode: 'lost', source: 'barcode' } });
    expect(analyticsPayload('registration_registered', { mode: 'received', batch: '6-20', number: 'SYNTHETIC001', source: 'manual' })).toEqual({ name: 'pdd_registration_registered', data: { mode: 'received', batch: '6-20' } });
    expect(analyticsPayload('feedback_submitted', { mode: 'lost', contact: 'synthetic_contact' })?.data).toEqual({});
    expect(analyticsPayload('query_error', { mode: 'synthetic_contact', source: 'private error' })?.data).toEqual({});
  });

  it('enforces opt-in and per-document limits, and does not let telemetry break product operations', () => {
    let allowed = false;
    const send = vi.fn(), record = createAnalyticsRecorder(send, () => allowed, 2);
    record('query_started'); expect(send).not.toHaveBeenCalled();
    allowed = true;
    record('query_started', { mode: 'lost', source: 'manual' });
    record('query_matched', { mode: 'lost', source: 'manual', contact: 'private' } as AnalyticsMetadata);
    record('query_error');
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(send.mock.calls)).not.toContain('private');
    const unavailable = createAnalyticsRecorder(() => { throw new Error('provider unavailable'); }, () => true);
    expect(() => unavailable('query_started')).not.toThrow();
    const unknown = createAnalyticsRecorder(send, () => true);
    unknown('private_number' as AnalyticsEvent); expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('bounded visible dwell segments', () => {
  it('excludes hidden time and sends each segment once on hide or route exit', () => {
    let now = 0;
    const send = vi.fn(), dwell = createVisibleDwell(() => now, send);
    now = 12_000; dwell.visibility(false); dwell.visibility(false);
    expect(send.mock.calls).toEqual([['10-29s']]);
    now = 100_000; dwell.visibility(true);
    now = 135_000; dwell.finish(); dwell.finish(); dwell.visibility(false);
    expect(send.mock.calls).toEqual([['10-29s'], ['30-59s']]);
  });
  it('does not measure initially hidden tabs, ignores sub-second segments and caps repeated visibility toggles', () => {
    let now = 0;
    const send = vi.fn(), dwell = createVisibleDwell(() => now, send, false);
    now = 90_000; dwell.visibility(false); expect(send).not.toHaveBeenCalled();
    dwell.visibility(true); now += 500; dwell.visibility(false); expect(send).not.toHaveBeenCalled();
    for (let i = 0; i < 20; i++) { dwell.visibility(true); now += 5000; dwell.visibility(false); }
    expect(send).toHaveBeenCalledTimes(10);
    expect(analyticsDwellBucket(9_999)).toBe('0-9s');
    expect(analyticsDwellBucket(10_000)).toBe('10-29s');
    expect(analyticsDwellBucket(1_800_001)).toBe('10-30m');
  });
});
