import { describe, expect, it } from 'vitest';
import { normalizeWaybill, validatePddContact, validateWaybill } from '../shared/waybill.ts';

describe('domestic waybill and self-supplied contacts', () => {
  it('removes whitespace, preserves leading zeros and rejects inferred/partial numbers', () => {
    expect(normalizeWaybill(' 00 sf\u00a01234\n')).toBe('00SF1234');
    expect(validateWaybill('000123456')).toBe('000123456');
    for (const value of ['12345', 'SF-123456', 'SF*123456', '１２３４５６', 'https://example.test', 'A'.repeat(41)]) expect(() => validateWaybill(value)).toThrow('INVALID_WAYBILL');
  });
  it('accepts WeChat IDs and international phones but no additional fields', () => {
    expect(validatePddContact({ kind: 'wechat', value: ' Example_12 ' })).toEqual({ kind: 'wechat', value: 'Example_12' });
    expect(validatePddContact({ kind: 'phone', value: '+66 81 234 5678' })).toEqual({ kind: 'phone', value: '+66 81 234 5678' });
    for (const value of [{ kind: 'wechat', value: '昵称' }, { kind: 'phone', value: '123' }, { kind: 'wechat', value: 'tester_12', admin: true }]) expect(() => validatePddContact(value)).toThrow('INVALID_CONTACT');
  });
});
