import { describe, it, expect } from 'vitest';
import { normalizeRecipientName, optionalRecipientName, validateRecipientName } from '../shared/recipient.ts';
describe('complete recipient-name validation', () => {
  it('keeps spelling and other-language case, NFC, significant word spaces and punctuation', () => {
    expect(validateRecipientName(' \uFEFFALEX\u00a0\u2003 Chen  ')).toBe('ALEX Chen');
    expect(normalizeRecipientName(' ALEX\u2028\u2029 Chen ')).toBe('alex chen');
    expect(validateRecipientName('Jose\u0301')).toBe('José');
    expect(normalizeRecipientName('ÄLEX 小明 สมชาย-二')).toBe('Älex 小明 สมชาย-二');
    expect(normalizeRecipientName('收件人 小明')).not.toBe(normalizeRecipientName('小明'));
    expect(normalizeRecipientName('小 明')).not.toBe(normalizeRecipientName('小明'));
  });
  it('counts code points and rejects C0/C1 controls before trimming', () => {
    expect(validateRecipientName('😀'.repeat(80))).toHaveLength(160);
    for (const value of [undefined, 1, '', '   ', '😀'.repeat(81), '小明\n', '\tAlex', 'Alex\u007f', 'Alex\u0085']) expect(() => validateRecipientName(value)).toThrow('INVALID_RECIPIENT_NAME');
    expect(optionalRecipientName(null)).toBeNull(); expect(optionalRecipientName('')).toBeNull();
    expect(optionalRecipientName(' \u00a0\u2003\uFEFF ')).toBeNull();
    expect(() => optionalRecipientName(' \n ')).toThrow('INVALID_RECIPIENT_NAME');
  });
});
