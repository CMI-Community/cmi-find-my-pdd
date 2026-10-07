import { describe, expect, it, vi } from 'vitest';
import { createTelemetryBuffer } from '../src/pdd-telemetry';
import { TELEMETRY_MAX_BYTES, validateTelemetryRows, type TelemetryRow } from '../shared/telemetry';

describe('bounded first-party telemetry batching', () => {
  it('accepts fixed name-flow events but rejects names and disclosure data', () => {
    expect(validateTelemetryRows([{ event: 'pdd_recipient_query_leads_found', page: 'home', mode: 'received', count: 1 }])).toHaveLength(1);
    expect(validateTelemetryRows([{ event: 'pdd_recipient_registration_registered', page: 'home', mode: 'lost', batch: '2-5', count: 1 }])).toHaveLength(1);
    for (const privateField of ['recipientName', 'contact', 'note', 'queryId', 'number']) {
      expect(() => validateTelemetryRows([{ event: 'pdd_recipient_query_started', page: 'home', mode: 'lost', count: 1, [privateField]: 'synthetic-private' }])).toThrow('INVALID_TELEMETRY');
    }
    expect(() => validateTelemetryRows([{ event: 'pdd_recipient_query_started', page: 'home', source: 'barcode', count: 1 }])).toThrow('INVALID_TELEMETRY');
  });
  it('aggregates repeated actions without making a request per action, and never posts an empty batch', () => {
    const send = vi.fn(), buffer = createTelemetryBuffer(send, () => true);
    for (let count = 0; count < 50; count++) buffer.add({ event: 'pdd_query_started', page: 'home', mode: 'lost', source: 'barcode', count: 1 });
    expect(send).not.toHaveBeenCalled();
    buffer.flush(); buffer.flush();
    expect(send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(send.mock.calls[0][0]);
    expect(payload).toEqual({ events: [{ event: 'pdd_query_started', page: 'home', mode: 'lost', source: 'barcode', count: 50 }] });
    expect(validateTelemetryRows(payload.events)).toHaveLength(1);
  });

  it('rejects private data, forged routes and event metadata before they enter a batch', () => {
    const send = vi.fn(), buffer = createTelemetryBuffer(send, () => true);
    buffer.add({ event: 'pdd_query_matched', page: 'home', count: 1, number: 'SYNTHETIC001' } as unknown as TelemetryRow);
    buffer.add({ event: 'pdd_page_view', page: '/m/PDD-SYNTHETIC#secret', count: 1 } as unknown as TelemetryRow);
    buffer.add({ event: 'pdd_feedback_submitted', page: 'home', count: 1, mode: 'lost' });
    buffer.add({ event: 'pdd_visible_dwell', page: 'home', count: 1 });
    buffer.flush(); expect(send).not.toHaveBeenCalled();
    buffer.add({ event: 'pdd_visible_dwell', page: 'home', count: 1, bucket: '30-59s' });
    buffer.flush(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toBe(true);
    expect(JSON.stringify(send.mock.calls)).not.toMatch(/SYNTHETIC|secret|number/);
  });

  it('caps row counts, payload size, aggregate rows and total batches without retrying provider failures', () => {
    const send = vi.fn((_payload: string, _final: boolean) => { throw new Error('network failure'); }), buffer = createTelemetryBuffer(send, () => true, 2);
    for (let i = 0; i < 200; i++) buffer.add({ event: 'pdd_page_view', page: 'home', count: 1 });
    expect(() => buffer.flush()).not.toThrow();
    expect(JSON.parse(send.mock.calls[0][0]).events[0].count).toBe(100);
    buffer.flush(); expect(send).toHaveBeenCalledTimes(1);
    for (const page of ['home', 'help', 'privacy', 'local'] as const) for (const mode of ['lost', 'received'] as const) for (const source of ['manual', 'barcode'] as const) for (const event of ['pdd_query_started', 'pdd_query_matched'] as const) buffer.add({ event, page, mode, source, count: 1 });
    buffer.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(send.mock.calls[1][0]).events).toHaveLength(24);
    expect(new TextEncoder().encode(send.mock.calls[1][0]).byteLength).toBeLessThan(TELEMETRY_MAX_BYTES);
    buffer.add({ event: 'pdd_page_view', page: 'home', count: 1 }); buffer.flush();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('discards pending events when the user opts out before a flush', () => {
    let allowed = true;
    const send = vi.fn(), buffer = createTelemetryBuffer(send, () => allowed);
    buffer.add({ event: 'pdd_page_view', page: 'home', count: 1 });
    allowed = false; buffer.flush();
    allowed = true; buffer.flush();
    expect(send).not.toHaveBeenCalled();
  });
});
