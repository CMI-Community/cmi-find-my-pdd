import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FeedbackForm, feedbackInput } from '../src/pdd-feedback';
import { validateFeedbackMessage } from '../shared/feedback';

describe('community feedback', () => {
  it('allows contact-free feedback and validates supplied contact instead of silently dropping it', () => {
    expect(feedbackInput('  Synthetic suggestion\nDetail  ', { kind: 'wechat', value: '' })).toEqual({ message: 'Synthetic suggestion\nDetail', contact: null });
    expect(feedbackInput('suggestion', { kind: 'wechat', value: ' synthetic_user ' }).contact?.value).toBe('synthetic_user');
    expect(() => feedbackInput('suggestion', { kind: 'phone', value: 'invalid' })).toThrow();
  });
  it('accepts Unicode within the documented limit and rejects oversized or empty messages', () => {
    expect(validateFeedbackMessage('😀'.repeat(2000))).toHaveLength(4000);
    for (const invalid of ['', '   ', '字'.repeat(2001), 'hello\u0000']) expect(() => validateFeedbackMessage(invalid)).toThrow();
  });
  it('shows a real form with optional contact and administrator-only disclosure before submission', () => {
    const html = renderToStaticMarkup(createElement(FeedbackForm));
    expect(html).toContain('建议或问题说明');
    expect(html).toContain('联系方式（选填）');
    expect(html).toContain('仅供社区管理员查看');
    expect(html).toContain('提交反馈');
    expect(html).not.toContain('反馈已收到');
  });
});
