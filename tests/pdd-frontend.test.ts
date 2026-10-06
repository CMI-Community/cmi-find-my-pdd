import { describe, expect, it, vi } from 'vitest';
import { addQueueEntry, newPendingBatch, normalizeWaybillInput, settleQueue, waybillInputError, type QueueEntry } from '../src/waybill-drafts';
import { createCameraSession } from '../src/pdd-camera';

const entry = (requestId: string, number: string, mode: 'lost' | 'received' = 'lost'): QueueEntry => ({ requestId, number, mode, source: 'manual', createdAt: '2026-10-06T10:00:00Z' });
describe('PDD404 local single-number queues', () => {
  it('preserves leading zero and never guesses ambiguous characters', () => {
    expect(normalizeWaybillInput(' 00 ab1234 ')).toBe('00AB1234');
    expect(normalizeWaybillInput('O01234')).not.toBe(normalizeWaybillInput('001234'));
    expect(waybillInputError('123')).toBeTruthy();
    expect(waybillInputError('00AB1234')).toBe('');
  });
  it('deduplicates the current mode while preserving the other mode', () => {
    const first = entry('a', '00AB1234');
    const initial = [first];
    expect(addQueueEntry(initial, entry('b', ' 00ab1234 '))).toBe(initial);
    expect(addQueueEntry(initial, entry('c', '00AB1234', 'received'))).toHaveLength(2);
  });
  it('clears only settled rows and keeps failed and subsequently added rows', () => {
    const rows = [entry('saved', '111111'), entry('failed', '222222'), entry('added-later', '333333')];
    const next = settleQueue(rows, ['saved'], { failed: '网络失败，请重试' });
    expect(next.map(item => item.requestId)).toEqual(['failed', 'added-later']);
    expect(next[0].error).toBe('网络失败，请重试');
  });
  it('keeps each mode within the API batch limit and still accepts existing rows', () => {
    const full = Array.from({ length: 50 }, (_, index) => entry(String(index), 'TEST' + String(index).padStart(4, '0')));
    expect(() => addQueueEntry(full, entry('new', 'TEST9999'))).toThrow('每批最多');
    expect(addQueueEntry(full, entry('same', 'TEST0000'))).toBe(full);
    expect(addQueueEntry(full, entry('other-mode', 'TEST9999', 'received'))).toHaveLength(51);
  });
  it('freezes a batch snapshot and capability for a safe retry after a lost response', () => {
    const rows = [entry('a', '00123456')], contact = { kind: 'wechat' as const, value: 'synthetic_user' };
    const batch = newPendingBatch('lost', rows, contact);
    rows[0].number = '00999999'; contact.value = 'changed_user'; rows.push(entry('b', '00888888'));
    expect(batch.items).toHaveLength(1);
    expect(batch.items[0].number).toBe('00123456');
    expect(batch.contact.value).toBe('synthetic_user');
    expect(batch.capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
describe('barcode camera lifecycle', () => {
  function stream() { const stop = vi.fn(); return { value: { getTracks: () => [{ stop }] } as unknown as MediaStream, stop }; }
  it('immediately requests the rear camera without audio and propagates denial', async () => {
    const denied = new DOMException('denied', 'NotAllowedError');
    const request = vi.fn().mockRejectedValue(denied);
    const session = createCameraSession(request);
    expect(request).toHaveBeenCalledWith({ audio: false, video: { facingMode: { ideal: 'environment' } } });
    await expect(session.ready).rejects.toBe(denied);
    session.stop();
  });
  it('stops every track when permission is granted after the scanner closes', async () => {
    let grant!: (value: MediaStream) => void;
    const session = createCameraSession(() => new Promise(resolve => { grant = resolve; }));
    session.stop();
    const granted = stream(); grant(granted.value);
    await expect(session.ready).rejects.toMatchObject({ name: 'AbortError' });
    expect(granted.stop).toHaveBeenCalledOnce();
  });
  it('stops decoding and camera once, including a decoder that attaches late', async () => {
    const granted = stream(), decoder = { stop: vi.fn() }, lateDecoder = { stop: vi.fn() };
    const session = createCameraSession(async () => granted.value);
    await session.ready; session.attachDecoder(decoder); session.stop(); session.stop(); session.attachDecoder(lateDecoder);
    expect(decoder.stop).toHaveBeenCalledOnce();
    expect(granted.stop).toHaveBeenCalledOnce();
    expect(lateDecoder.stop).toHaveBeenCalledOnce();
  });
});
