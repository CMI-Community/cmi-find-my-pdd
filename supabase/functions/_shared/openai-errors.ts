/** Keep provider messages and request payloads out of application diagnostics. */
export function openAIErrorCode(status: number, payload: unknown): string {
  if (status === 401 || status === 403) return 'OPENAI_AUTH_ERROR';
  if (status === 429) {
    const error = payload && typeof payload === 'object' && 'error' in payload ? (payload as { error: unknown }).error : null;
    const fields = error && typeof error === 'object' ? error as { code?: unknown; type?: unknown } : null;
    if (fields?.code === 'credit_balance_exhausted') return 'OPENAI_CREDIT_EXHAUSTED';
    if (fields?.code === 'organization_spend_limit_exceeded' || fields?.code === 'project_spend_limit_exceeded') return 'OPENAI_SPEND_LIMIT';
    if (fields?.code === 'organization_usage_limit_exceeded') return 'OPENAI_USAGE_LIMIT';
    if (fields?.code === 'insufficient_quota' || fields?.type === 'insufficient_quota') return 'OPENAI_QUOTA_EXCEEDED';
    return 'OPENAI_RATE_LIMIT';
  }
  return status >= 500 ? 'OPENAI_UNAVAILABLE' : 'INVALID_EXTRACTION';
}
