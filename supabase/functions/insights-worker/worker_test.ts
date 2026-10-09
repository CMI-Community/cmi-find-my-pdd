import { callObservationModel, observationRequestBody, MODEL_REQUEST_LIMIT, MODEL_RESPONSE_LIMIT } from './provider.ts';
import { insightsWorkerRoute, prepareObservationWork, type InsightsWorkerContext } from './worker.ts';
import { OBSERVATION_MODEL, OBSERVATION_PROMPT_VERSION, observationCandidates, observationModelInput } from '../../../shared/hourly-observer.ts';
import type { HourlyCandidate, HourlyModelInput, HourlySourceInput } from '../../../shared/hourly-content.ts';

function assert(value: unknown): asserts value { if (!value) throw new Error('assertion failed'); }
const key = 'sk-SYNTHETIC-EDGE-TEST-ONLY', secret = 'a'.repeat(64), runId = '00000000-0000-4000-8000-000000000001', until = '2026-10-09T03:00:00Z';
function source(): HourlySourceInput {
  return { sampledAt: '2026-10-09T03:05:00Z', observedUntil: until, fromHour: '2026-10-01T03:00:00Z', metricVersion: 'home-six-lifetime-v1', snapshots: [], businessHours: [], queries: [], outcomesAvailable: true,
    outcomes: [], publishedFactKeys: [], recentObservations: [], verifiedReleases: [], telemetry: { truncated: false, startedAt: '2026-10-01T03:00:00Z', events: [], budget: [] } };
}
const emptyInput = (): HourlyModelInput => observationModelInput(source(), [], runId);
function completed(selection: unknown = { observations: [] }, usage: unknown = { input_tokens: 100, output_tokens: 20 }) {
  return { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(selection) }] }], usage };
}
const fixture = () => {
  const input = source(), calls: Array<{ name: string; payload: Record<string, unknown> }> = [], requests: Array<{ url: string; body: string }> = [], logs: string[] = [];
  let reserved = false;
  const context: InsightsWorkerContext = { log: state => logs.push(state), rpc: async <T>(name: string, payload: Record<string, unknown>): Promise<T> => {
    calls.push({ name, payload });
    if (name === 'pdd_insights_runtime') return { enabled: true, model: OBSERVATION_MODEL, promptVersion: OBSERVATION_PROMPT_VERSION, modelKey: key, dailyCallLimit: 24, reservationUsd: .01 } as T;
    if (name === 'pdd_hourly_source') return input as T;
    if (name === 'pdd_insights_reserve') { const allowed = !reserved; reserved = true; return { reserved: allowed, runId, observedUntil: until, state: 'reserved' } as T; }
    if (name === 'pdd_insights_finish') return { state: payload.state, publishedCount: (payload.selection as { observations: unknown[] } | null)?.observations.length ?? 0 } as T;
    throw new Error('unexpected RPC');
  }, fetcher: (url, init) => { requests.push({ url: String(url), body: String(init?.body) }); return Promise.resolve(Response.json(completed())); } };
  return { input, calls, requests, logs, context };
};
const request = (value = secret, method = 'POST') => new Request('https://pdd404.app/insights-worker', { method, headers: { 'x-insights-secret': value } });

Deno.test('provider fixes endpoint, model, no storage/tools/reasoning and sends the approved ID-only schema once even for empty candidates', async () => {
  let count = 0;
  const result = await callObservationModel(key, emptyInput(), { fetcher: (url, init) => {
    count++; assert(url === 'https://api.openai.com/v1/responses' && init?.redirect === 'error');
    const body = JSON.parse(String(init?.body)); assert(body.model === OBSERVATION_MODEL && body.store === false && body.reasoning.effort === 'none' && body.max_output_tokens === 600);
    assert(!('tools' in body) && !('temperature' in body) && body.text.format.strict === true);
    assert(JSON.parse(body.input[0].content[0].text).candidates.length === 0); assert(new TextEncoder().encode(String(init?.body)).length <= MODEL_REQUEST_LIMIT);
    return Promise.resolve(Response.json(completed()));
  } });
  assert(count === 1 && result.state === 'completed' && result.usage?.costUsd === .000044);
});
Deno.test('private extra fields and oversized UTF8 input are rejected before a provider request', async () => {
  let count = 0; const fetcher = () => { count++; return Promise.resolve(Response.json(completed())); };
  const privateInput = { ...emptyInput(), publishedFactKeys: ['PRIVATE-SYNTHETIC'] } as HourlyModelInput;
  assert((await callObservationModel(key, privateInput, { fetcher })).state === 'rejected');
  const oversized = emptyInput(); oversized.recentObservations = [{ candidateId: 'synthetic', topic: '字'.repeat(MODEL_REQUEST_LIMIT), publishedAt: until }];
  assert((await callObservationModel(key, oversized, { fetcher })).state === 'rejected'); assert(count === 0);
});
Deno.test('HTTP errors and thrown provider failures keep cost unknown and never retry or copy provider details', async () => {
  for (const fetcher of [() => Promise.resolve(Response.json({ error: 'PRIVATE-SYNTHETIC' }, { status: 429 })), () => Promise.reject(new Error('PRIVATE-SYNTHETIC'))]) {
    let count = 0; const result = await callObservationModel(key, emptyInput(), { fetcher: () => { count++; return fetcher(); } });
    assert(count === 1 && result.state === 'unknown' && !JSON.stringify(result).includes('PRIVATE'));
  }
});
Deno.test('the single call timeout also bounds fetchers and response readers that ignore abort', async () => {
  for (const stage of ['fetch', 'body']) {
    const controller = new AbortController(); let count = 0;
    const work = callObservationModel(key, emptyInput(), { signal: controller.signal, fetcher: () => {
      count++; if (stage === 'fetch') return new Promise<Response>(() => {});
      return Promise.resolve(new Response(new ReadableStream({ start() {} })));
    } });
    queueMicrotask(() => controller.abort());
    assert((await work).state === 'unknown' && count === 1);
  }
});
Deno.test('streamed responses enforce the byte limit without trusting Content-Length', async () => {
  let cancelled = false;
  const result = await callObservationModel(key, emptyInput(), { fetcher: () => Promise.resolve(new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(40_000)); controller.enqueue(new Uint8Array(40_000));
  }, cancel() { cancelled = true; } }), { headers: { 'Content-Length': '1' } })) });
  assert(result.state === 'unknown' && cancelled);
  assert((await callObservationModel(key, emptyInput(), { fetcher: () => Promise.resolve(new Response('{}', { headers: { 'Content-Length': String(MODEL_RESPONSE_LIMIT + 1) } })) })).state === 'unknown');
});
Deno.test('malformed response UTF8 and JSON cannot release a reservation as known cost', async () => {
  for (const body of [new Uint8Array([255, 255]), '{broken-json']) {
    const result = await callObservationModel(key, emptyInput(), { fetcher: () => Promise.resolve(new Response(body)) });
    assert(result.state === 'unknown' && !('usage' in result));
  }
});
Deno.test('refusal, incomplete, extra output parts and non-JSON text are rejected as a whole', async () => {
  const refusal = completed(); refusal.output[0].content = [{ type: 'refusal', text: 'PRIVATE-SYNTHETIC' }];
  const incomplete = { ...completed(), status: 'incomplete' };
  const extra = completed(); extra.output[0].content.push({ type: 'output_text', text: '{}' });
  const markdown = completed(); markdown.output[0].content[0].text = '```json\n{"observations":[]}\n```';
  for (const value of [refusal, incomplete, extra, markdown]) assert((await callObservationModel(key, emptyInput(), { fetcher: () => Promise.resolve(Response.json(value)) })).state === 'rejected');
  assert((await callObservationModel(key, emptyInput(), { fetcher: () => Promise.resolve(Response.json({ ...completed(), status: 'failed', error: 'PRIVATE-SYNTHETIC' })) })).state === 'unknown');
});
Deno.test('missing usage stays unknown while malformed or out-of-budget usage cannot publish', async () => {
  const absent = await callObservationModel(key, emptyInput(), { fetcher: () => Promise.resolve(Response.json(completed({ observations: [] }, null))) });
  assert(absent.state === 'completed' && !('usage' in absent));
  for (const usage of [{ input_tokens: 32769, output_tokens: 10 }, { input_tokens: 10, output_tokens: 601 }, { input_tokens: -1, output_tokens: 0 }, { input_tokens: 3.5, output_tokens: 2 }]) {
    const result = await callObservationModel(key, emptyInput(), { fetcher: () => Promise.resolve(Response.json(completed({ observations: [] }, usage))) });
    assert(result.state === 'rejected' && !('usage' in result));
  }
});
Deno.test('invalid method/secret and runtime authentication failures cannot read aggregates or reserve', async () => {
  const f = fixture();
  assert((await insightsWorkerRoute(request(secret, 'GET'), f.context)).status === 405);
  assert((await insightsWorkerRoute(request('invalid'), f.context)).status === 401 && f.calls.length === 0);
  f.context.rpc = () => Promise.reject(new Error('FORBIDDEN'));
  assert((await insightsWorkerRoute(request(), f.context)).status === 401 && f.requests.length === 0);
});
Deno.test('disabled and mismatched runtime settings stop before source reads', async () => {
  for (const runtime of [{ enabled: false }, { enabled: true, model: 'wrong-model' }]) {
    const f = fixture(); f.context.rpc = <T>() => Promise.resolve(runtime as T);
    const response = await insightsWorkerRoute(request(), f.context);
    assert(response.status === (runtime.enabled ? 503 : 200) && f.requests.length === 0);
  }
});
Deno.test('atomic reservation precedes exactly one empty-candidate API call and a repeated slot cannot call again', async () => {
  const f = fixture(); const results = await Promise.all([insightsWorkerRoute(request(), f.context), insightsWorkerRoute(request(), f.context)]);
  assert(results.every(response => response.status === 200) && f.requests.length === 1);
  assert(f.calls[0].name === 'pdd_insights_runtime');
  const reserve = f.calls.find(row => row.name === 'pdd_insights_reserve')!, finish = f.calls.find(row => row.name === 'pdd_insights_finish')!;
  assert((reserve.payload.candidates as unknown[]).length === 0 && finish.payload.state === 'completed');
  assert(JSON.stringify(finish.payload.selection) === '{"observations":[]}');
});
Deno.test('provider failures finish unknown with no invented usage and fixed HTTP/log state only', async () => {
  const f = fixture(); f.context.fetcher = () => Promise.reject(new Error('PRIVATE-SYNTHETIC '+key));
  const response = await insightsWorkerRoute(request(), f.context), text = await response.text();
  const finish = f.calls.find(row => row.name === 'pdd_insights_finish')!;
  assert(response.status === 503 && finish.payload.state === 'unknown' && finish.payload.selection === null && !('usage' in finish.payload));
  assert(!text.includes(key) && !text.includes('PRIVATE') && f.logs.join('/') === 'unknown');
});
Deno.test('a validated observation forwards only IDs and accounting; private ledger and source fields never reach the model', async () => {
  const f = fixture(), factKey = 'b'.repeat(64);
  f.input.outcomes.push({ kind: 'parcel-match', at: '2026-10-09T02:15:00Z', key: factKey });
  const candidate = observationCandidates(f.input)[0]; assert(candidate);
  f.context.fetcher = (url, init) => { f.requests.push({ url: String(url), body: String(init?.body) }); return Promise.resolve(Response.json(completed({ observations: [{ candidateId: candidate.id, headlineId: candidate.headlines[0].id, factIds: [candidate.facts[0].id] }] }))); };
  const response = await insightsWorkerRoute(request(), f.context); assert(response.status === 200);
  const finish = f.calls.find(row => row.name === 'pdd_insights_finish')!;
  assert(finish.payload.state === 'completed' && !JSON.stringify(f.requests).includes(factKey) && !JSON.stringify(f.requests).includes('publishedFactKeys'));
  assert(!JSON.stringify(finish.payload.selection).includes('text'));
});
Deno.test('invented candidate, text field and duplicate topic selections reject the entire batch without a retry', async () => {
  for (const selection of [{ observations: [{ candidateId: 'invented', headlineId: 'invented', factIds: ['invented'] }] }, { observations: [], text: 'PRIVATE-SYNTHETIC' }]) {
    const f = fixture(); let calls = 0; f.context.fetcher = () => { calls++; return Promise.resolve(Response.json(completed(selection))); };
    const response = await insightsWorkerRoute(request(), f.context); assert(response.status === 200 && calls === 1);
    const finish = f.calls.find(row => row.name === 'pdd_insights_finish')!;
    assert(finish.payload.state === 'rejected' && JSON.stringify(finish.payload.selection) === '{"observations":[]}');
  }
  const f = fixture(); f.input.outcomes.push({ kind: 'parcel-match', at: '2026-10-09T02:15:00Z', key: 'c'.repeat(64) });
  const candidate = observationCandidates(f.input)[0], choice = { candidateId: candidate.id, headlineId: candidate.headlines[0].id, factIds: [candidate.facts[0].id] };
  f.context.fetcher = () => Promise.resolve(Response.json(completed({ observations: [choice, choice] })));
  await insightsWorkerRoute(request(), f.context);
  const finish = f.calls.find(row => row.name === 'pdd_insights_finish')!; assert(finish.payload.state === 'rejected' && JSON.stringify(finish.payload.selection) === '{"observations":[]}');
});
Deno.test('support-only or reversed primary facts reject the complete batch, including an otherwise valid outcome', async () => {
  for (const factIds of [['same-hour'], ['same-hour', 'primary']]) {
    const f = fixture();
    f.input.queries.push(
      { hour: '2026-10-09T02:00:00Z', lookup: 'waybill', mode: 'lost', source: 'manual', result: 'not_found', count: 35, excludedTests: 0 },
      { hour: '2026-10-09T01:00:00Z', lookup: 'waybill', mode: 'lost', source: 'manual', result: 'not_found', count: 10, excludedTests: 0 },
      { hour: '2026-10-08T02:00:00Z', lookup: 'waybill', mode: 'lost', source: 'manual', result: 'not_found', count: 2, excludedTests: 0 },
    );
    f.input.outcomes.push({ kind: 'parcel-match', at: '2026-10-09T02:15:00Z', key: 'd'.repeat(64) });
    const candidates = observationCandidates(f.input), query = candidates.find(c => c.id === 'query-waybill-h1')!, outcome = candidates.find(c => c.kind === 'outcome')!;
    assert(query?.facts[0].id === 'primary' && query.facts[1].id === 'same-hour' && outcome);
    f.context.fetcher = (url, init) => {
      f.requests.push({ url: String(url), body: String(init?.body) });
      assert(JSON.parse(String(init?.body)).instructions.includes('factIds 第一个必须是该 candidate facts 首项（主窗口事实）'));
      return Promise.resolve(Response.json(completed({ observations: [
        { candidateId: outcome.id, headlineId: outcome.headlines[0].id, factIds: [outcome.facts[0].id] },
        { candidateId: query.id, headlineId: query.headlines[0].id, factIds },
      ] })));
    };
    const response = await insightsWorkerRoute(request(), f.context), body = await response.json();
    const finish = f.calls.find(row => row.name === 'pdd_insights_finish')!;
    assert(response.status === 200 && f.requests.length === 1 && body.state === 'rejected' && body.publishedCount === 0);
    assert(finish.payload.state === 'rejected' && JSON.stringify(finish.payload.selection) === '{"observations":[]}');
  }
});
Deno.test('budget limits and expired reservations cannot trigger any model request', async () => {
  for (const state of ['limited', 'expired', 'disabled']) {
    const f = fixture(), rpc = f.context.rpc;
    f.context.rpc = <T>(name: string, payload: Record<string, unknown>) => name === 'pdd_insights_reserve'
      ? Promise.resolve({ reserved: false, runId: null, observedUntil: until, state } as T) : rpc<T>(name, payload);
    const response = await insightsWorkerRoute(request(), f.context);
    assert((await response.json()).state === state && f.requests.length === 0);
  }
});
Deno.test('a finish failure leaves an unknown result, never retries, and cannot claim publication completed', async () => {
  const f = fixture(), rpc = f.context.rpc; f.context.rpc = <T>(name: string, payload: Record<string, unknown>) => name === 'pdd_insights_finish' ? Promise.reject(new Error('PRIVATE-SYNTHETIC')) : rpc<T>(name, payload);
  const response = await insightsWorkerRoute(request(), f.context), body = await response.json();
  assert(response.status === 503 && body.state === 'unknown' && !('publishedCount' in body) && f.requests.length === 1);
});
Deno.test('request capacity removes whole ranked trailing candidates before reservation and never cuts a fact sentence', () => {
  const ranked: HourlyCandidate[] = Array.from({ length: 32 }, (_, i) => ({ id: 'synthetic-' + i, kind: 'registration', topic: '合成主题' + i, score: 100 - i, priority: 2,
    windowStart: '2026-10-09T02:00:00Z', windowEnd: until, dedupKey: '字'.repeat(200),
    headlines: Array.from({ length: 4 }, (_, n) => ({ id: 'headline-' + n, text: '类'.repeat(24) })),
    facts: Array.from({ length: 6 }, (_, n) => ({ id: 'fact-' + n, text: '合成事实'.padEnd(90, '字') })) }));
  const fitted = prepareObservationWork(source(), ranked);
  assert(fitted.candidates.length > 0 && fitted.candidates.length < ranked.length);
  assert(JSON.stringify(fitted.candidates) === JSON.stringify(ranked.slice(0, fitted.candidates.length)));
  assert(observationRequestBody({ ...fitted.input, runId }) !== null && fitted.candidates.every(c => c.facts.every(f => Array.from(f.text).length === 90)));
});
Deno.test('an oversized empty-candidate history loses whole oldest history items and still makes one empty call', async () => {
  const f = fixture(); f.input.recentObservations = Array.from({ length: 24 }, (_, i) => ({ candidateId: 'synthetic-' + i, topic: '合成历史'.repeat(2000), dedupKey: 'synthetic', publishedAt: until, windowStart: '2026-10-09T02:00:00Z', windowEnd: until }));
  const response = await insightsWorkerRoute(request(), f.context); assert(response.status === 200 && f.requests.length === 1);
  const reserve = f.calls.find(row => row.name === 'pdd_insights_reserve')!, stored = reserve.payload.input as HourlyModelInput;
  assert((reserve.payload.candidates as unknown[]).length === 0 && stored.recentObservations.length < 24);
  assert(stored.recentObservations.every((item, i) => item.candidateId === 'synthetic-' + i));
});
Deno.test('reserved candidates and model projection stay identical after reservation, apart from the new run ID', async () => {
  const f = fixture();
  f.input.verifiedReleases = Array.from({ length: 32 }, (_, i) => ({ key: (i + 1).toString(16).padStart(64, '0'), at: '2026-10-09T02:00:00Z', category: '合成上新'.padEnd(24, '类'), text: '合成验收'.padEnd(90, '字') }));
  const rpc = f.context.rpc;
  f.context.rpc = async <T>(name: string, payload: Record<string, unknown>) => {
    const result = await rpc<T>(name, payload);
    if (name === 'pdd_insights_reserve') f.input.recentObservations.push({ candidateId: 'post-reserve-private', topic: 'PRIVATE-SYNTHETIC', dedupKey: 'private', publishedAt: until, windowStart: '2026-10-09T02:00:00Z', windowEnd: until });
    return result;
  };
  await insightsWorkerRoute(request(), f.context); assert(f.requests.length === 1);
  const body = JSON.parse(f.requests[0].body), actual = JSON.parse(body.input[0].content[0].text), reserve = f.calls.find(row => row.name === 'pdd_insights_reserve')!;
  assert(actual.runId === runId); delete actual.runId;
  assert(JSON.stringify(actual) === JSON.stringify(reserve.payload.input));
  assert(actual.candidates.map((c: { id: string }) => c.id).join('/') === (reserve.payload.candidates as HourlyCandidate[]).map(c => c.id).join('/'));
  assert(!f.requests[0].body.includes('PRIVATE-SYNTHETIC'));
});
