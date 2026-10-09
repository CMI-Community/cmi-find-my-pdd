import { OBSERVATION_MODEL } from '../../../shared/hourly-observer.ts';
import type { HourlyModelInput, HourlyUsage } from '../../../shared/hourly-content.ts';
import { OBSERVATION_SYSTEM_PROMPT } from './prompt.ts';

const ENDPOINT = 'https://api.openai.com/v1/responses';
export const MODEL_REQUEST_LIMIT = 32_768;
export const MODEL_RESPONSE_LIMIT = 65_536;
const selectionSchema = { type: 'object', additionalProperties: false, required: ['observations'], properties: {
  observations: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false,
    required: ['candidateId', 'headlineId', 'factIds'], properties: {
      candidateId: { type: 'string' }, headlineId: { type: 'string' }, factIds: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string' } },
    } } },
} };
type Row = Record<string, unknown>;
type ProviderOptions = { fetcher?: typeof fetch; signal?: AbortSignal };
export type ObservationModelResult = { state: 'completed'; selection: unknown; usage?: HourlyUsage } | { state: 'rejected' | 'unknown'; usage?: HourlyUsage };
function object(value: unknown): value is Row { return !!value && typeof value === 'object' && !Array.isArray(value); }
function keys(value: unknown, required: string[], optional: string[] = []): value is Row {
  return object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key));
}
/** SQL checks the projection at reservation too; direct provider callers cannot append private fields. */
function modelInputAllowed(input: HourlyModelInput): boolean {
  return keys(input, ['observedUntil', 'timezone', 'selectionLimit', 'candidates', 'recentObservations'], ['runId'])
    && input.timezone === 'Asia/Bangkok' && input.selectionLimit === 3 && Array.isArray(input.candidates) && input.candidates.length <= 32
    && input.candidates.every(c => keys(c, ['id', 'kind', 'topic', 'score', 'priority', 'windowStart', 'windowEnd', 'dedupKey', 'headlines', 'facts'])
      && Array.isArray(c.headlines) && c.headlines.every(h => keys(h, ['id', 'text']))
      && Array.isArray(c.facts) && c.facts.every(f => keys(f, ['id', 'text'])))
    && Array.isArray(input.recentObservations) && input.recentObservations.length <= 24
    && input.recentObservations.every(item => keys(item, ['candidateId', 'topic', 'publishedAt']));
}
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('MODEL_UNAVAILABLE'));
    if (signal.aborted) { void promise.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function boundedBody(response: Response, signal: AbortSignal): Promise<string> {
  const size = response.headers.get('content-length');
  if ((size && (!/^\d+$/.test(size) || Number(size) > MODEL_RESPONSE_LIMIT)) || !response.body) {
    void response.body?.cancel().catch(() => {}); throw new Error('MODEL_UNAVAILABLE');
  }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '';
  try {
    while (true) {
      const part = await withAbort(reader.read(), signal);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MODEL_RESPONSE_LIMIT) throw new Error('MODEL_UNAVAILABLE');
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    void reader.cancel().catch(() => {}); throw new Error('MODEL_UNAVAILABLE');
  } finally { reader.releaseLock(); }
}
function usageOf(value: unknown): HourlyUsage | undefined {
  if (!object(value) || !Number.isSafeInteger(value.input_tokens) || Number(value.input_tokens) < 0 || Number(value.input_tokens) > 32_768
    || !Number.isSafeInteger(value.output_tokens) || Number(value.output_tokens) < 0 || Number(value.output_tokens) > 600) return;
  const inputTokens = Number(value.input_tokens), outputTokens = Number(value.output_tokens);
  const costUsd = Math.round((inputTokens * .20 + outputTokens * 1.20) / 1_000_000 * 1e8) / 1e8;
  return { inputTokens, outputTokens, costUsd };
}

/** Shared preflight includes the entire JSON request and its UTF8 overhead. */
export function observationRequestBody(input: HourlyModelInput): string | null {
  try {
    if (!modelInputAllowed(input)) return null;
    const body = JSON.stringify({ model: OBSERVATION_MODEL, store: false, reasoning: { effort: 'none' }, max_output_tokens: 600,
      instructions: OBSERVATION_SYSTEM_PROMPT, input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify(input) }] }],
      text: { format: { type: 'json_schema', name: 'pdd404_observation_selection', strict: true, schema: selectionSchema } } });
    return new TextEncoder().encode(body).byteLength > MODEL_REQUEST_LIMIT ? null : body;
  } catch { return null; }
}

/** Exactly one fixed-origin request; failures never retry or expose provider error bodies. */
export async function callObservationModel(key: string, input: HourlyModelInput, options: ProviderOptions = {}): Promise<ObservationModelResult> {
  const body = observationRequestBody(input);
  if (!key || body === null) return { state: 'rejected' };
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(40_000)]) : AbortSignal.timeout(40_000);
  let raw: unknown;
  try {
    if (signal.aborted) return { state: 'unknown' };
    const response = await withAbort((options.fetcher ?? fetch)(ENDPOINT, {
      method: 'POST', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal,
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Accept: 'application/json' }, body,
    }), signal);
    if (!response.ok) { void response.body?.cancel().catch(() => {}); return { state: 'unknown' }; }
    raw = JSON.parse(await boundedBody(response, signal));
  } catch { return { state: 'unknown' }; }
  if (!object(raw)) return { state: 'rejected' };
  if (raw.status === 'failed') return { state: 'unknown' };
  const usage = usageOf(raw.usage), usagePart = usage ? { usage } : {};
  if (raw.usage !== undefined && raw.usage !== null && !usage) return { state: 'rejected' };
  if (raw.status !== 'completed' || raw.error != null || raw.incomplete_details != null || !Array.isArray(raw.output) || raw.output.length !== 1) return { state: 'rejected', ...usagePart };
  const message = raw.output[0];
  if (!object(message) || message.type !== 'message' || message.role !== 'assistant' || message.status !== 'completed'
    || !Array.isArray(message.content) || message.content.length !== 1) return { state: 'rejected', ...usagePart };
  const content = message.content[0];
  if (!object(content) || content.type !== 'output_text' || typeof content.text !== 'string') return { state: 'rejected', ...usagePart };
  try { return { state: 'completed', selection: JSON.parse(content.text), ...usagePart }; }
  catch { return { state: 'rejected', ...usagePart }; }
}
