import { describe, expect, it } from 'vitest';
import { normalizeWaybill, validatePddContact, validatePddNote, validateWaybill, validateWaybillQuery } from '../shared/waybill.ts';

describe('domestic waybill and self-supplied contacts', () => {
  it('rejects the confirmed forwarding prefix for full and fuzzy input without guessing other formats', () => {
    for (const number of ['JTTH000990001', 'jtth000990001', ' J T T H\u00a0000990001\n', 'JTTH', 'JTTH00099?001', 'JTTH00099*001']) {
      expect(() => validateWaybill(number)).toThrow('NON_DOMESTIC_WAYBILL');
      expect(() => validateWaybillQuery(number)).toThrow('NON_DOMESTIC_WAYBILL');
    }
    for (const number of ['JT000990001', 'YT000990001', 'SF000990001', '000990001', '00JTTH000990001']) {
      expect(validateWaybill(number)).toBe(number);
      expect(validateWaybillQuery(number)).toBe(number);
    }
    expect(validateWaybillQuery('JTT?000990001')).toBe('JTT?000990001');
  });
  it('removes whitespace, preserves leading zeros and rejects inferred/partial numbers', () => {
    expect(normalizeWaybill(' 00 sf\u00a01234\n')).toBe('00SF1234');
    expect(validateWaybill('000123456')).toBe('000123456');
    for (const value of ['12345', 'SF-123456', 'SF*123456', '１２３４５６', 'https://example.test', 'A'.repeat(41)]) expect(() => validateWaybill(value)).toThrow('INVALID_WAYBILL');
  });
  it('accepts WeChat IDs and international phones but no additional fields', () => {
    expect(validatePddContact({ kind: 'wechat', value: ' Example_12 ' })).toEqual({ kind: 'wechat', value: 'Example_12' });
    for (const value of ['_demo_2026', '_000000000000', 'example-12', 'wxid_test123456789']) {
      expect(validatePddContact({ kind: 'wechat', value })).toEqual({ kind: 'wechat', value });
    }
    for (const value of ['小禾', 'demo name', 'demo😊', 'demo.123', '-demo12', '123456', '_demo']) {
      expect(() => validatePddContact({ kind: 'wechat', value })).toThrow('INVALID_CONTACT');
    }
    expect(validatePddContact({ kind: 'phone', value: '+66 81 234 5678' })).toEqual({ kind: 'phone', value: '+66 81 234 5678' });
    for (const value of [{ kind: 'wechat', value: '昵称' }, { kind: 'phone', value: '123' }, { kind: 'wechat', value: 'tester_12', admin: true }]) expect(() => validatePddContact(value)).toThrow('INVALID_CONTACT');
  });
  it('preserves one-character unknown placeholders only for query input', () => {
    expect(validateWaybillQuery(' 00 sf?12*34\n')).toBe('00SF?12*34');
    expect(validateWaybillQuery('000123456')).toBe('000123456');
    for (const input of ['??????', 'ABC12?', 'ABCDEF'.padEnd(41, '*'), 'ABCDEF-12', '１２３４５６', 123]) expect(() => validateWaybillQuery(input)).toThrow('INVALID_WAYBILL');
    for (const input of ['ABCDEF?', 'ABCDEF*']) expect(() => validateWaybill(input)).toThrow('INVALID_WAYBILL');
  });
  it('trims optional notes, counts Unicode characters and rejects hidden controls', () => {
    expect(validatePddNote(undefined)).toBeNull();
    expect(validatePddNote(null)).toBeNull();
    expect(validatePddNote(' \n\t ')).toBeNull();
    expect(validatePddNote('\u00a0 蓝色盒子\n请保留 \u3000')).toBe('蓝色盒子\n请保留');
    expect(validatePddNote('📦'.repeat(500))).toHaveLength(1000);
    for (const input of ['📦'.repeat(501), 123, {}, '\u000btrimmed control', 'bad\u009fcontrol', 'bad\u0000control']) expect(() => validatePddNote(input)).toThrow('INVALID_NOTE');
    expect(validatePddNote('line one\tvalue\r\nline two')).toBe('line one\tvalue\r\nline two');
  });
});
