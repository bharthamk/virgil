import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GEMMA_MODELS, GEMMA_SCOUT_TIERS, GeminiLlm, GeminiError, REASONING_OFF,
} from '../gemini-llm.js';

/**
 * Live Gemma transport proof for the fast Scout route.
 *
 * Same shape and same gate as `gemini-live.test.ts`, and separate from it for a
 * reason that is not filing: the free tier meters per model, so a file that
 * mixes families spends the Gemini deep tier's twenty-a-day proving something
 * about Gemma. These models have their own pool and this file only touches it.
 *
 *     LIVE=1 GEMINI_API_KEY=… node --test adapters/dist/__tests__/gemma-live.test.js
 *
 * Without both, every test skips and CI stays offline and free.
 *
 * ## What this file exists to catch
 *
 * The Gemini port's headline was that four things the skeleton "knew" were wrong.
 * The Gemma port found a fifth, and it is the same lesson pointing the other way:
 * `responseSchema` was expected to be ABSENT here and is present, while
 * `thinkingLevel: 'low'` — chosen as the unknown-model fallback precisely because
 * it was "the only value every model accepted" — is a hard 400 on this whole
 * family. Both halves are asserted below, because both are the kind of fact that
 * a mock will agree with either way.
 *
 * Nothing here asserts on a latency number. Timings are printed for the artefact
 * to quote as ballpark and are never a pass condition — `DEAD_ENDS.md` closes by
 * saying no duration recorded in this project should enter a cost model.
 */

const LIVE = process.env.LIVE === '1' && !!process.env.GEMINI_API_KEY;
const skip = LIVE ? false : 'set LIVE=1 and GEMINI_API_KEY to run the Gemma transport proof';

const FAST = GEMMA_SCOUT_TIERS.fast;

/** An adapter pointed at one Gemma id on both tiers, so `tier: 'fast'` reaches it. */
const on = (model: string): GeminiLlm => new GeminiLlm({ tiers: { fast: model, deep: model } });

/** Retry policy belongs to the caller, and for now the caller is this test. */
async function withBackoff<T>(what: string, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!(err instanceof GeminiError) || !err.retryable) throw err;
      if (err.exhaustedForPeriod) throw err;
      const hinted = Math.min(err.retryAfterMs ?? 0, 20_000);
      const wait = Math.max(hinted, 2000 * 2 ** attempt);
      console.log(`    [${what}] ${err.status} ${err.quotaId ?? ''} — waiting ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

const say = (label: string, detail: unknown): void =>
  console.log(`    ${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);

// ------------------------------------------------------------- reach and tier

/**
 * Grounds contract #2 for the ported fast tier, and answers the question
 * `ListModels` gets wrong.
 *
 * The model list advertises `supportedGenerationMethods: ["generateContent",
 * "countTokens"]` for both Gemma ids — no `streamGenerateContent`. That is the
 * ONLY method this adapter speaks, so read literally the port was impossible.
 * It is not: the streaming endpoint answers 200 and frames SSE exactly as the
 * Gemini models do. `ListModels` understates what the endpoint accepts, which is
 * worth knowing before anyone gates a future port on that field.
 */
test('the pinned Gemma model answers over the streaming endpoint the adapter uses', { skip }, async () => {
  const t0 = Date.now();
  const r = await withBackoff('reach', () => on(FAST).complete({
    tier: 'fast', system: 'you are terse', prompt: 'Say exactly: ok', reasoning: 'off',
  }));
  say('model asked for', FAST);
  say('modelVersion the service answered as', r.modelId);
  say('reply', r.value.trim());
  say('elapsed_ms (noise, not a benchmark)', Date.now() - t0);
  assert.ok(r.value.length > 0, 'the live Gemma model answered with nothing at all');
  assert.equal(r.modelId, FAST, 'a pinned id must answer as itself; anything else is an alias');
  assert.ok(r.inputTokens > 0 && r.outputTokens > 0, 'the cost ledger has nothing to count');
});

// -------------------------------------------------------- the reasoning table

/**
 * The most valuable test in this file, and the direct analogue of the one that
 * caught its own author's guess on the Gemini side.
 *
 * It asserts BOTH directions, which the Gemini version does not need to:
 *
 *  - every entry in `REASONING_OFF` for a Gemma id is accepted, and
 *  - the two encodings NOT chosen are really refused.
 *
 * The second half is what makes the family-split fallback evidence rather than
 * taste. If `low` ever starts working here, this test goes red and the fallback
 * can go back to being one constant — which is the outcome anyone reading
 * `portableReasoningOff` would like to be told about.
 */
test('Gemma accepts minimal, and refuses both other encodings', { skip }, async () => {
  for (const model of GEMMA_MODELS) {
    assert.deepEqual(REASONING_OFF[model], { thinkingLevel: 'minimal' },
      `${model} is not mapped to the encoding this test proves`);

    const r = await withBackoff(`off-${model}`, () => on(model).complete({
      tier: 'fast', system: '', prompt: 'Say exactly: ok', reasoning: 'off',
    }));
    say(`${model} + thinkingLevel:minimal`, `accepted, replied ${r.value.trim().slice(0, 24)}`);
    assert.ok(r.value.length > 0);

    // The refusals, by raw call — the adapter has no way to send an encoding it
    // does not believe in, which is the point of the table.
    for (const thinkingConfig of [{ thinkingLevel: 'low' }, { thinkingBudget: 0 }]) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': process.env.GEMINI_API_KEY as string,
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'Say exactly: ok' }] }],
            generationConfig: { maxOutputTokens: 32, thinkingConfig },
          }),
        },
      );
      const body = await res.text();
      const message = String((JSON.parse(body) as { error?: { message?: string } })?.error?.message ?? '');
      say(`${model} + ${JSON.stringify(thinkingConfig)}`, `${res.status} ${message.slice(0, 80)}`);
      assert.equal(res.status, 400,
        `${model} accepted ${JSON.stringify(thinkingConfig)} — the family split can be retired`);
      assert.match(message, /not supported for this model/i);
    }
  }
});

// ------------------------------------------------------------- structured out

/**
 * The assumption the port was scoped around, tested rather than believed.
 *
 * Gemma endpoints have historically not carried structured output, and the plan
 * for this lane was "wire it, watch `responseSchema` 400, fall back to JSON
 * prompting". It does not 400. This asserts the capability directly so that the
 * day it is withdrawn is a red test rather than a silent slide onto the ladder's
 * lower rungs.
 */
test('Gemma accepts responseSchema, including the Scout union it has to translate', { skip }, async () => {
  const t0 = Date.now();
  const r = await withBackoff('schema', () => on(FAST).structured<{
    label: string; matchedExistingLabel: string | null; confidence: number;
  }>({
    tier: 'fast',
    reasoning: 'off',
    system: 'You label learning material for a study tool. Answer with JSON only.',
    prompt: 'Passage: "A composite index is required for a query that combines an equality '
      + 'filter with a range filter on a different field."\nPage: Query data | Firestore',
    // The Scout's own schema, verbatim — the union on `matchedExistingLabel` is
    // the field that is a 400 if `toGeminiSchema` stops translating.
    schema: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        matchedExistingLabel: { type: ['string', 'null'] },
        confidence: { type: 'number' },
      },
      required: ['label', 'matchedExistingLabel', 'confidence'],
    },
    maxOutputTokens: 200,
  }));
  say('structured value', r.value);
  say('elapsed_ms (noise, not a benchmark)', Date.now() - t0);
  assert.equal(typeof r.value.label, 'string');
  assert.ok(r.value.label.length > 0, 'a structured reply with an empty label is a blank toast');
  assert.ok(r.value.matchedExistingLabel === null || typeof r.value.matchedExistingLabel === 'string');
  assert.equal(typeof r.value.confidence, 'number');
});

// ------------------------------------------------------------ request shaping

/** Grounds contract #1: "the system instruction and the prompt both reach the provider". */
test('the system instruction really steers the live Gemma model', { skip }, async () => {
  const r = await withBackoff('system', () => on(FAST).complete({
    tier: 'fast',
    system: 'You always answer with exactly one word, and that word is BANANA.',
    prompt: 'What is the capital of France?',
    reasoning: 'off',
  }));
  say('steered reply', r.value.trim());
  assert.match(r.value, /BANANA/i,
    'systemInstruction did not reach the model, or did not bind — Gemma would then need it folded into the prompt');
});

/** Grounds contract #4: "the output budget reaches the provider". */
test('a small output budget really truncates the live Gemma reply', { skip }, async () => {
  const r = await withBackoff('budget', () => on(FAST).complete({
    tier: 'fast',
    system: '',
    prompt: 'Write 800 words about composite indexes in Firestore.',
    reasoning: 'off',
    maxOutputTokens: 32,
  }));
  say('capped reply length (chars)', r.value.length);
  assert.ok(r.value.length < 1200, 'the budget did not reach the provider');
});

// ------------------------------------------------------------------ transport

/**
 * Grounds D19, on this family specifically.
 *
 * Gemma streams differently from the Gemini models in a way the offline fixture
 * now records: the JSON object arrives split across events MID-TOKEN. That is
 * only safe because the adapter concatenates, and it is only observable live.
 */
test('a Gemma response really arrives as a stream, CRLF-framed, in more than one chunk', { skip }, async () => {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${FAST}:streamGenerateContent?alt=sse`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY as string,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'List the numbers 1 to 60, one per line.' }] }],
        generationConfig: { maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: 'minimal' } },
      }),
    },
  );
  assert.equal(r.status, 200);
  say('content-type', r.headers.get('content-type') ?? '(none)');
  assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/);

  let chunks = 0;
  let events = 0;
  let crlf = false;
  const decoder = new TextDecoder();
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    chunks++;
    const s = decoder.decode(chunk, { stream: true });
    if (s.includes('\r\n')) crlf = true;
    events += s.split('data:').length - 1;
  }
  say('network chunks', chunks);
  say('sse events', events);
  say('CRLF framing', crlf);
  assert.ok(chunks > 1, 'the whole response arrived in one chunk — the silent connection D19 died on');
  assert.ok(crlf, 'events are framed with CRLF; a splitter that assumes LF leaves a CR on every line');
});

// --------------------------------------------------------------------- errors

/**
 * Grounds contract #14/#15 on this family: the error envelope does not change
 * shape between model families, so `GeminiError` decodes a Gemma failure with no
 * Gemma-specific code.
 */
test('a Gemma error arrives in the same envelope the Gemini models use', { skip }, async () => {
  const err = await on(FAST).complete({ tier: 'fast', system: '', prompt: 'p', maxOutputTokens: 0 })
    .then(() => null, (e: unknown) => e);
  assert.ok(err instanceof GeminiError, `expected a GeminiError, got ${String(err)}`);
  say('400 providerStatus', err.providerStatus);
  say('400 message', err.message.slice(0, 160));
  assert.equal(err.status, 400);
  assert.equal(err.providerStatus, 'INVALID_ARGUMENT');
  assert.match(err.message, /400/);
});

test('an unknown Gemma id is a 404 rather than a silent fall back to something else', { skip }, async () => {
  const err = await on('gemma-4-does-not-exist').complete({ tier: 'fast', system: '', prompt: 'p' })
    .then(() => null, (e: unknown) => e);
  assert.ok(err instanceof GeminiError);
  say('404 message', err.message.slice(0, 140));
  assert.equal(err.status, 404);
  assert.equal(err.providerStatus, 'NOT_FOUND');
});
