/** Privacy boundary shared by first-party browser batching and the Edge API. */
export const TELEMETRY_EVENTS = [
  'pdd_page_view', 'pdd_visible_dwell',
  'pdd_mode_selected', 'pdd_query_started', 'pdd_query_invalid', 'pdd_query_domestic_blocked',
  'pdd_lookup_waybill_selected', 'pdd_lookup_recipient_selected',
  'pdd_recipient_query_started', 'pdd_recipient_query_invalid', 'pdd_recipient_query_leads_found', 'pdd_recipient_query_not_found', 'pdd_recipient_query_error',
  'pdd_recipient_queue_added', 'pdd_recipient_queue_duplicate', 'pdd_recipient_queue_removed',
  'pdd_recipient_registration_started', 'pdd_recipient_registration_registered', 'pdd_recipient_registration_duplicate', 'pdd_recipient_registration_error',
  'pdd_query_matched', 'pdd_query_possible', 'pdd_query_duplicate', 'pdd_query_not_found', 'pdd_query_closed', 'pdd_query_error',
  'pdd_queue_added', 'pdd_queue_duplicate', 'pdd_queue_removed',
  'pdd_registration_started', 'pdd_registration_registered', 'pdd_registration_matched', 'pdd_registration_duplicate', 'pdd_registration_closed', 'pdd_registration_error',
  'pdd_scanner_open', 'pdd_scanner_close', 'pdd_scanner_mode', 'pdd_scanner_capture', 'pdd_scanner_not_found', 'pdd_scanner_decoded',
  'pdd_scanner_permission_error', 'pdd_scanner_camera_error', 'pdd_scanner_reader_error', 'pdd_scanner_retried',
  'pdd_scanner_camera_changed', 'pdd_scanner_mirror', 'pdd_scanner_focus_requested',
  'pdd_contact_copy', 'pdd_contact_saved', 'pdd_contact_error', 'pdd_feedback_open', 'pdd_feedback_started', 'pdd_feedback_submitted', 'pdd_feedback_error',
  'pdd_help_open', 'pdd_local_open', 'pdd_privacy_open', 'pdd_community_open', 'pdd_code_open', 'pdd_helper_qr_open',
] as const;
export const TELEMETRY_PAGES = ['home', 'help', 'privacy', 'local', 'insights', 'share'] as const;
export const TELEMETRY_DWELL_BUCKETS = ['0-9s', '10-29s', '30-59s', '1-2m', '3-9m', '10-30m'] as const;
export type TelemetryEvent = typeof TELEMETRY_EVENTS[number];
export type TelemetryPage = typeof TELEMETRY_PAGES[number];
export type TelemetryRow = {
  event: TelemetryEvent; page: TelemetryPage; count: number;
  mode?: 'lost' | 'received'; source?: 'manual' | 'barcode'; scanMode?: 'photo' | 'realtime'; batch?: '1' | '2-5' | '6-20' | '21+';
  bucket?: typeof TELEMETRY_DWELL_BUCKETS[number];
};
export type TelemetryReceipt = { accepted: boolean; recorded: number; limited: boolean; day: string };
export const TELEMETRY_MAX_ROWS = 24;
export const TELEMETRY_MAX_BYTES = 8_192;

export function telemetryMetadataKeys(event: TelemetryEvent): string[] {
  if (event === 'pdd_visible_dwell') return ['bucket'];
  if (event.startsWith('pdd_recipient_query_')) return ['mode'];
  if (event.startsWith('pdd_recipient_registration_')) return ['mode', 'batch'];
  if (event.startsWith('pdd_recipient_queue_') || event.startsWith('pdd_lookup_')) return ['mode'];
  if (event.startsWith('pdd_query_')) return ['mode', 'source'];
  if (event.startsWith('pdd_registration_')) return ['mode', 'batch'];
  if (event.startsWith('pdd_scanner_')) return ['scanMode'];
  if (event.startsWith('pdd_queue_') || event === 'pdd_mode_selected') return ['mode'];
  return [];
}

export function validateTelemetryRows(value: unknown): TelemetryRow[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > TELEMETRY_MAX_ROWS) throw new Error('INVALID_TELEMETRY');
  const values: Record<string, readonly string[]> = { mode: ['lost', 'received'], source: ['manual', 'barcode'], scanMode: ['photo', 'realtime'], batch: ['1', '2-5', '6-20', '21+'], bucket: TELEMETRY_DWELL_BUCKETS };
  return value.map(input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_TELEMETRY');
    const row = input as Record<string, unknown>;
    if (!(TELEMETRY_EVENTS as readonly unknown[]).includes(row.event) || !(TELEMETRY_PAGES as readonly unknown[]).includes(row.page) || !Number.isInteger(row.count) || Number(row.count) < 1 || Number(row.count) > 100) throw new Error('INVALID_TELEMETRY');
    const event = row.event as TelemetryEvent, metadata = telemetryMetadataKeys(event);
    if (Object.keys(row).some(key => !['event', 'page', 'count', ...metadata].includes(key))) throw new Error('INVALID_TELEMETRY');
    const safe: TelemetryRow = { event, page: row.page as TelemetryPage, count: Number(row.count) };
    for (const key of metadata) if (Object.hasOwn(row, key)) {
      if (typeof row[key] !== 'string' || !values[key].includes(row[key] as string)) throw new Error('INVALID_TELEMETRY');
      (safe as Record<string, unknown>)[key] = row[key];
    }
    if (event === 'pdd_visible_dwell' && !safe.bucket) throw new Error('INVALID_TELEMETRY');
    return safe;
  });
}
