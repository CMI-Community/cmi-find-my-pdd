import { describe, expect, it } from 'vitest';
import { openAIErrorCode } from '../supabase/functions/_shared/openai-errors';

describe('provider failure classification', () => {
  it('does not retry exhausted quota as transient throttling', () => {
    expect(openAIErrorCode(429, { error: { code: 'insufficient_quota' } })).toBe('OPENAI_QUOTA_EXCEEDED');
    expect(openAIErrorCode(429, { error: { type: 'insufficient_quota' } })).toBe('OPENAI_QUOTA_EXCEEDED');
    expect(openAIErrorCode(429, { error: { code: 'credit_balance_exhausted', type: 'insufficient_quota' } })).toBe('OPENAI_CREDIT_EXHAUSTED');
    expect(openAIErrorCode(429, { error: { code: 'project_spend_limit_exceeded' } })).toBe('OPENAI_SPEND_LIMIT');
    expect(openAIErrorCode(429, { error: { code: 'organization_spend_limit_exceeded' } })).toBe('OPENAI_SPEND_LIMIT');
    expect(openAIErrorCode(429, { error: { code: 'organization_usage_limit_exceeded' } })).toBe('OPENAI_USAGE_LIMIT');
    expect(openAIErrorCode(429, { error: { code: 'rate_limit_exceeded' } })).toBe('OPENAI_RATE_LIMIT');
  });
  it('uses stable codes without disclosing provider messages', () => {
    const privatePayload = { error: { message: 'sensitive provider message', code: 'unknown' } };
    expect(openAIErrorCode(401, privatePayload)).toBe('OPENAI_AUTH_ERROR');
    expect(openAIErrorCode(503, privatePayload)).toBe('OPENAI_UNAVAILABLE');
    expect(openAIErrorCode(400, privatePayload)).toBe('INVALID_EXTRACTION');
    expect(openAIErrorCode(429, null)).toBe('OPENAI_RATE_LIMIT');
  });
});
