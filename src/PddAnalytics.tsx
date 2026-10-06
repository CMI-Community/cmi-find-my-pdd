import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Analytics, type BeforeSendEvent } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import { analyticsOptedOut, analyticsPage, browserAnalyticsAllowed, createVisibleDwell, sanitizedAnalyticsUrl, setAnalyticsRuntime, trackPddPageView, trackVisibleDwell } from './pdd-analytics';
import { flushTelemetry, setFirstPartyTelemetryEnabled } from './pdd-telemetry';

function filterEvent<T extends { url: string; route?: string }>(event: T): T | null {
  if (!browserAnalyticsAllowed()) return null;
  const url = sanitizedAnalyticsUrl(event.url, window.location.origin);
  if (!url) return null;
  // Drop query strings and fragments even on the home/help URLs. Speed Insights
  // also receives a static route name, never a dynamic code or management path.
  return { ...event, url, ...('route' in event ? { route: new URL(url).pathname } : {}) };
}

export function PddAnalytics({ blocked = false }: { blocked?: boolean }) {
  const location = useLocation(), page = analyticsPage(location.pathname);
  const optedOut = typeof navigator !== 'undefined' && analyticsOptedOut(navigator as Navigator & { globalPrivacyControl?: boolean });
  const production = import.meta.env.PROD;
  const webEnabled = production && import.meta.env.VITE_WEB_ANALYTICS_ENABLED === 'true';
  const speedEnabled = production && import.meta.env.VITE_SPEED_INSIGHTS_ENABLED === 'true';
  const vercelCustom = webEnabled && import.meta.env.VITE_ANALYTICS_CUSTOM_EVENTS === 'true';
  const firstParty = production && import.meta.env.VITE_FIRST_PARTY_ANALYTICS_ENABLED === 'true';
  const customEvents = firstParty || vercelCustom;
  setFirstPartyTelemetryEnabled(firstParty);
  setAnalyticsRuntime(webEnabled || speedEnabled || firstParty, customEvents, blocked || optedOut, firstParty, vercelCustom);

  useEffect(() => {
    if (!customEvents || blocked || optedOut || !page) return;
    trackPddPageView(page.page);
    const createDwell = () => createVisibleDwell(() => performance.now(), bucket => trackVisibleDwell(page.page, bucket), !document.hidden);
    let dwell = createDwell();
    const visibility = () => { dwell.visibility(!document.hidden); if (document.hidden) flushTelemetry(true); };
    const pagehide = () => { dwell.finish(); flushTelemetry(true); };
    const pageshow = (event: PageTransitionEvent) => { if (event.persisted) { dwell = createDwell(); trackPddPageView(page.page); } };
    const timer = firstParty ? window.setInterval(() => flushTelemetry(), 60_000) : null;
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('pageshow', pageshow);
    return () => { dwell.finish(); flushTelemetry(); if (timer !== null) window.clearInterval(timer); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', pagehide); window.removeEventListener('pageshow', pageshow); };
  }, [location.pathname, customEvents, firstParty, blocked, optedOut]);

  if (blocked || optedOut || !page) return null;
  return <>
    {webEnabled && <Analytics route={page.path} path={page.path} beforeSend={(event: BeforeSendEvent) => filterEvent(event)} mode="production" debug={false} />}
    {speedEnabled && <SpeedInsights route={page.path} sampleRate={0.1} beforeSend={filterEvent} debug={false} />}
  </>;
}
