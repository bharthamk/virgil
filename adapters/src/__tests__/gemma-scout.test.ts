import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fallbackLabel, scout } from '@sb/core';
import type { CaptureEnvelope } from '@sb/core';
import {
  GEMINI_TIERS, GEMMA_MODELS, GEMMA_SCOUT_TIERS, GeminiLlm, REASONING_OFF,
} from '../gemini-llm.js';

/**
 * The Scout, on Gemma — the architecture's "Scout onto Gemma", offline.
 *
 * Every fixture below is TRANSCRIBED from a real `gemma-4-26b-a4b-it` response
 * recorded on 2026-08-20, not written from the API reference. That is the rule
 * the transport proof arrived at the hard way — a skeleton passed 28/28 against
 * shapes it had invented while four separate things about the live service were
 * wrong — and the Gemma port is the second time it paid: this family was
 * expected not to support `responseSchema` at all, and it does.
 *
 * The live half is `gemma-live.test.ts`, `LIVE=1`-gated. NOTHING HERE CALLS
 * GOOGLE: the transport is a function, the endpoint resolves to nothing, and the
 * key is a literal.
 */

// ------------------------------------------------------------------ fixtures

const encoder = new TextEncoder();

/**
 * One recorded Gemma structured stream, byte for byte as it arrived.
 *
 * Two things here are NOT decoration and neither is in the Gemini fixture next
 * door, because Gemma does not stream the way the Gemini models do:
 *
 *  - The JSON is split ACROSS events mid-token — `{"` arrives, then
 *    `label": "Database Indexing", "matchedExistingLabel": null, "confidence`,
 *    then `": 0.95}`. An adapter that parsed each event's text as a document,
 *    or that reassembled on any boundary but concatenation, gets three fragments
 *    and no object. The Gemini recording happens to deliver its whole reply in
 *    one event, so this failure mode is invisible there.
 *  - The final event carries `text: ""` and `finishReason: STOP` and NO
 *    `thoughtSignature`. Gemini's trailing event has one. Anything keying off
 *    the signature to spot the end of a Gemma stream waits forever.
 *
 * Also recorded and load-bearing: no `thoughtsTokenCount` field at all. On this
 * call `thinkingLevel: 'minimal'` really did zero the thinking pass, where the
 * same prompt with no `thinkingConfig` spent 46 thought tokens on a one-token
 * answer.
 */
const RECORDED_SCOUT_EVENTS: readonly string[] = [
  '{"candidates": [{"content": {"parts": [{"text": "{\\""}],"role": "model"},"index": 0}],'
  + '"usageMetadata": {"promptTokenCount": 52,"candidatesTokenCount": 1,"totalTokenCount": 53,'
  + '"promptTokensDetails": [{"modality": "TEXT","tokenCount": 52}],"serviceTier": "standard"},'
  + '"modelVersion": "gemma-4-26b-a4b-it","responseId": "recorded-shape-not-a-live-response"}',
  '{"candidates": [{"content": {"parts": [{"text": "label\\": \\"Database Indexing\\", '
  + '\\"matchedExistingLabel\\": null, \\"confidence"}],"role": "model"},"index": 0}],'
  + '"usageMetadata": {"promptTokenCount": 52,"candidatesTokenCount": 17,"totalTokenCount": 69,'
  + '"promptTokensDetails": [{"modality": "TEXT","tokenCount": 52}],"serviceTier": "standard"},'
  + '"modelVersion": "gemma-4-26b-a4b-it","responseId": "recorded-shape-not-a-live-response"}',
  '{"candidates": [{"content": {"parts": [{"text": "\\": 0.95}"}],"role": "model"},"index": 0}],'
  + '"usageMetadata": {"promptTokenCount": 52,"candidatesTokenCount": 24,"totalTokenCount": 76,'
  + '"promptTokensDetails": [{"modality": "TEXT","tokenCount": 52}],"serviceTier": "standard"},'
  + '"modelVersion": "gemma-4-26b-a4b-it","responseId": "recorded-shape-not-a-live-response"}',
  '{"candidates": [{"content": {"parts": [{"text": ""}],"role": "model"},"finishReason": "STOP",'
  + '"index": 0}],"usageMetadata": {"promptTokenCount": 52,"candidatesTokenCount": 24,'
  + '"totalTokenCount": 76,"promptTokensDetails": [{"modality": "TEXT","tokenCount": 52}],'
  + '"serviceTier": "standard"},"modelVersion": "gemma-4-26b-a4b-it",'
  + '"responseId": "recorded-shape-not-a-live-response"}',
];

/** As the service frames it: `data: ` with a space, CRLF CRLF between, no `[DONE]`. */
const sse = (events: readonly string[]): Response => new Response(
  encoder.encode(events.map((e) => `data: ${e}\r\n\r\n`).join('')),
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);

interface WireBody {
  systemInstruction: { parts: { text: string }[] };
  contents: { role: string; parts: { text?: string }[] }[];
  generationConfig: {
    maxOutputTokens: number;
    thinkingConfig?: { thinkingBudget?: number; thinkingLevel?: string };
    responseMimeType?: string;
    responseSchema?: unknown;
  };
}

interface Wire { model: string; body: WireBody }

/**
 * Runs `fn` against a stubbed transport, handing back every request that was
 * made so the test can assert on what went ON THE WIRE rather than on what the
 * adapter believes it sent.
 */
async function onWire<T>(
  respond: (call: number) => Response,
  fn: (llm: GeminiLlm) => Promise<T>,
  tiers: Readonly<{ fast: string; deep: string }> = GEMMA_SCOUT_TIERS,
): Promise<{ result: T | Error; wire: Wire[] }> {
  const wire: Wire[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    wire.push({
      model: /\/models\/([^:]+):/.exec(String(url))?.[1] ?? '',
      body: JSON.parse(String(init.body)) as WireBody,
    });
    return respond(wire.length - 1);
  }) as unknown as typeof globalThis.fetch;
  try {
    const result = await fn(
      new GeminiLlm({ endpoint: 'https://stub.invalid/v1beta', apiKey: 'not-a-real-key', tiers }),
    ).catch((e: unknown) => e as Error);
    return { result, wire };
  } finally {
    globalThis.fetch = real;
  }
}

const SCOUT_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    matchedExistingLabel: { type: ['string', 'null'] },
    confidence: { type: 'number' },
  },
  required: ['label', 'matchedExistingLabel', 'confidence'],
};

const scoutCall = (llm: GeminiLlm): Promise<unknown> => llm.structured({
  tier: 'fast',
  reasoning: 'off',
  system: 'You label learning material. Answer with JSON only.',
  prompt: 'Passage: "A composite index is required for a query combining equality and range filters."',
  schema: SCOUT_SCHEMA,
  maxOutputTokens: 200,
});

// --------------------------------------------------------------- the tier map

test('the Scout tier map pins a Gemma id, and pinning is the whole point', () => {
  assert.match(GEMMA_SCOUT_TIERS.fast, /^gemma-/,
    'the fast tier is what "Scout onto Gemma" moves; nothing else does');
  // The trap the transport proof caught on the Gemini side was `gemini-pro-latest`
  // silently resolving to a 3.1 model. Gemma has no alias to fall into, and this
  // asserts the id stays a real one rather than acquiring one later.
  assert.ok(!/latest/.test(GEMMA_SCOUT_TIERS.fast),
    'an alias under a cost ledger is a ledger that cannot be reconciled');
  assert.ok(GEMMA_MODELS.includes(GEMMA_SCOUT_TIERS.fast),
    'the chosen fast model is not one of the ids the live list actually offered');
});

test('moving the fast tier to Gemma leaves the deep tier exactly where it was', () => {
  // "Scout onto Gemma" is a claim about small-model triage. A Gemma deep tier
  // would be a quality decision, and this lane has no evidence for one.
  assert.equal(GEMMA_SCOUT_TIERS.deep, GEMINI_TIERS.deep);
});

// ------------------------------------------------------ the reasoning encoding

test('every Gemma id on the key has its own reasoning-off entry', () => {
  for (const model of GEMMA_MODELS) {
    assert.ok(REASONING_OFF[model], `${model} has no entry, so it would fall back to a guess`);
  }
});

test('no Gemma entry spells reasoning-off in a way Gemma rejects', () => {
  // Both alternatives are a hard 400 on this family — "Thinking level is not
  // supported for this model", "Thinking budget is not supported for this model" —
  // and Scout sets `reasoning: 'off'` on every single call. A wrong entry here is
  // not a degradation, it is every pin in the product failing to get a label.
  for (const model of GEMMA_MODELS) {
    const encoding = REASONING_OFF[model] as Record<string, unknown>;
    assert.deepEqual(encoding, { thinkingLevel: 'minimal' },
      `${model} is mapped to ${JSON.stringify(encoding)}, which the live model refuses`);
  }
});

test('a foreground Gemma call asks for minimal thinking on the wire', async () => {
  const { wire } = await onWire(() => sse(RECORDED_SCOUT_EVENTS), scoutCall);
  const cfg = wire[0]?.body.generationConfig.thinkingConfig;
  assert.deepEqual(cfg, { thinkingLevel: 'minimal' },
    `Gemma was sent ${JSON.stringify(cfg)}; only "minimal" is accepted by this family`);
});

test('an unlisted Gemma id inherits its family encoding rather than a 400', async () => {
  // The old fallback was the constant `{ thinkingLevel: 'low' }`, justified as
  // "the only value every model probed accepted". That generalisation held over
  // five Gemini models and broke on the sixth. A `gemma-5-*` that appears on
  // ListModels tomorrow must degrade, not 400 on every foreground call at 3am.
  const unseen = 'gemma-5-9b-it';
  assert.ok(!REASONING_OFF[unseen], 'this test is meaningless if the id is in the table');
  const { wire } = await onWire(
    () => sse(RECORDED_SCOUT_EVENTS), scoutCall, { fast: unseen, deep: unseen },
  );
  assert.deepEqual(wire[0]?.body.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
});

test('an unlisted Gemini id still gets the encoding its own family accepts', async () => {
  // The family split must not become "minimal everywhere". `minimal` is a 400 on
  // gemini-3.7-flash, so flipping the default would trade one family's outage
  // for the other's.
  const unseen = 'gemini-9.9-flash';
  assert.ok(!REASONING_OFF[unseen], 'this test is meaningless if the id is in the table');
  const { wire } = await onWire(
    () => sse(RECORDED_SCOUT_EVENTS), scoutCall, { fast: unseen, deep: unseen },
  );
  assert.deepEqual(wire[0]?.body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
});

// -------------------------------------------------------------- structured out

test('the Scout schema reaches Gemma translated, not raw', async () => {
  const { wire } = await onWire(() => sse(RECORDED_SCOUT_EVENTS), scoutCall);
  const cfg = wire[0]?.body.generationConfig;
  assert.equal(cfg?.responseMimeType, 'application/json',
    'Gemma accepts native structured output — the port was scoped expecting it would not');
  const props = (cfg?.responseSchema as { properties: Record<string, unknown> }).properties;
  // `{"type": ["string","null"]}` is a proto error, on Gemma exactly as on Gemini.
  assert.deepEqual(props.matchedExistingLabel, { type: 'string', nullable: true });
});

test('a Gemma reply split across SSE events mid-token still parses', async () => {
  // The recorded stream breaks the object at `{"` / `label":...` / `": 0.95}`.
  // Concatenation is the only reassembly that survives it.
  const { result } = await onWire(() => sse(RECORDED_SCOUT_EVENTS), scoutCall);
  assert.ok(!(result instanceof Error), `the recorded Gemma reply did not parse: ${String(result)}`);
  const r = result as { value: { label: string; matchedExistingLabel: string | null; confidence: number } };
  assert.equal(r.value.label, 'Database Indexing');
  assert.equal(r.value.matchedExistingLabel, null);
  assert.equal(r.value.confidence, 0.95);
});

test('the ledger is attributed to the model that answered, and counts what arrived', async () => {
  const { result } = await onWire(() => sse(RECORDED_SCOUT_EVENTS), scoutCall);
  const r = result as { modelId: string; inputTokens: number; outputTokens: number };
  assert.equal(r.modelId, 'gemma-4-26b-a4b-it', 'the ledger has the wrong model against this cost');
  assert.equal(r.inputTokens, 52);
  // No `thoughtsTokenCount` on this recording: minimal really is off on Gemma,
  // where the Gemini deep tier bills thought tokens whatever it is asked for.
  assert.equal(r.outputTokens, 24);
});

// ------------------------------------------------------------- failing closed

/**
 * The reply that never becomes JSON, which is the case the fallback was scoped
 * for and which `responseSchema` turning out to work does NOT retire.
 *
 * Recorded from Gemma's actual behaviour when `responseMimeType` is set and no
 * schema is: it narrates its own plan in prose and never emits an object. Under
 * a schema this should not happen, and "should not" is not a guarantee — so the
 * question this asserts is what the learner sees when it does.
 */
const PROSE_EVENT = '{"candidates": [{"content": {"parts": [{"text": '
  + '"* Target: A JSON object. * Content: a label string field."}],"role": "model"},'
  + '"finishReason": "STOP","index": 0}],"usageMetadata": {"promptTokenCount": 16,'
  + '"candidatesTokenCount": 13,"totalTokenCount": 29},"modelVersion": "gemma-4-26b-a4b-it"}';

test('a Gemma reply that never parses leaves the ladder as a rejection', async () => {
  const { result, wire } = await onWire(() => sse([PROSE_EVENT]), scoutCall);
  assert.ok(result instanceof Error, 'unparseable prose resolved as if it were a label');
  assert.match(result.message, /did not conform after 3 attempts/);
  // Three rungs, not one: the ladder buys headroom before it gives up, and the
  // rejection is what Scout's caller is hung on.
  assert.equal(wire.length, 3);
});

test('and the toast still gets a label, which is the whole point of failing this way', async () => {
  // Scout's failure must never become the learner's failure. The service
  // catches the rejection above and calls `fallbackLabel`; this asserts the two
  // halves meet, so that a Gemma outage is a worse label rather than a blank
  // toast or a spinner.
  const envelope: CaptureEnvelope = {
    selection: 'A composite index is required for a query combining equality and range filters.',
    parts: [{ role: 'passage', text: 'A composite index is required.' }],
    surroundingText: 'Firestore builds single-field indexes automatically.',
    headingPath: ['Query data', 'Query limitations'],
    pageTitle: 'Query data | Firestore',
    url: 'https://cloud.example.test/firestore/query',
    canonicalUrl: null,
    siteName: 'cloud.example.test',
    contentLanguage: 'en',
    media: null,
  };

  const { result } = await onWire(() => sse([PROSE_EVENT]), (llm) => scout(
    { llm, clock: { now: () => new Date('2026-08-20T09:00:00Z') } },
    { envelope, type: 'struggle', note: null, existingTopicLabels: [] },
  ));

  assert.ok(result instanceof Error, 'scout swallowed a model failure instead of reporting it');
  assert.equal(fallbackLabel(envelope), 'Query limitations',
    'the label the learner would actually see when Gemma is unreachable');
});
