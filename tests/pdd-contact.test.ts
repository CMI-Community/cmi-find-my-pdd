import { describe, expect, it } from 'vitest';
import { contactInputError } from '../src/pdd-contact';

describe('contact corrections', () => {
  it('explains common nickname/paste mistakes without declaring an account verified', () => {
    for (const value of ['小禾', 'Little He', '微信号：demo_2026', 'demo😊']) {
      expect(contactInputError({ kind: 'wechat', value })).toContain('可能是微信昵称');
    }
    expect(contactInputError({ kind: 'wechat', value: '_demo' })).toContain('至少需要6位');
    expect(contactInputError({ kind: 'wechat', value: '12345678' })).toContain('电话号码');
    // An all-letter nickname is indistinguishable from an ID by syntax alone.
    expect(contactInputError({ kind: 'wechat', value: 'LittleHe' })).toBe('');
    expect(contactInputError({ kind: 'wechat', value: '_demo_2026' })).toBe('');
    expect(contactInputError({ kind: 'wechat', value: '' }, true)).toBe('');
    expect(contactInputError({ kind: 'wechat', value: '' })).toContain('请填写');
  });
});
