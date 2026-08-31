import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiLlm, GEMINI_TIERS, REASONING_OFF, GeminiError } from '../gemini-llm.js';

/**
 * The transport proof. This file makes real calls to Google.
 *
 * ## Why it is separate from the contract
 *
 * `llm-contract.ts` says of itself: "No test here touches a network. The
 * transport is a function." That is not a limitation to be worked around, it is
 * the design — the contract asserts on behaviour that must hold for EVERY
 * provider, and it produces the situations it asserts on (a 429, a truncated
 * reply, exactly 137 input tokens) by handing the adapter a canned outcome. You
 * cannot ask a live service for exactly 137 input tokens, and you certainly
 * cannot ask it for a 429 on demand. So the contract's 28 assertions run offline
 * against every adapter, including this one, and they are the wrong instrument
 * for the question "is the transport real".
 *
 * This file is the right instrument. Every test below grounds one of the
 * contract's assertions in a real call — the header comment on each names which —
 * and the ones that have no live analogue are listed as unproven in
 * `artifacts/the transport contract rather than faked here.
 *
 * ## Gated, deliberately
 *
 * `LIVE=1` and a `GEMINI_API_KEY` in the environment. Without both, every test
 * skips and CI stays offline and free. The key comes from `~/.config/virgil/env`
 * (mode 600, outside the repo) and belongs to a GCP project with no billing
 * account attached, so these calls are structurally incapable of spending money.
 * Free-tier RATE LIMITS are real, though, which is what `withBackoff` is for.
 *
 *     set -a; source ~/.config/virgil/env; set +a
 *     LIVE=1 node --test adapters/dist/__tests__/gemini-live.test.js
 *
 * ## The rule this file follows
 *
 * Nothing here asserts on a latency number. Every duration this project has
 * recorded is an upper bound with unknown noise on one laptop against a shared
 * free tier, and closes by saying so. Timings are printed for the
 * proof artefact to quote as ballpark and are never a pass condition.
 */

const LIVE = process.env.LIVE === '1' && !!process.env.GEMINI_API_KEY;
const skip = LIVE ? false : 'set LIVE=1 and GEMINI_API_KEY to run the transport proof';

/** One shared instance, because the contract's concurrency assertion is about exactly that. */
const llm = (): GeminiLlm => new GeminiLlm();

/**
 * Free-tier capacity is not an adapter concern, so it is handled here.
 *
 * The adapter deliberately does NOT retry: the contract requires a transport
 * error to leave the structured ladder immediately (provider-retry constraint), and an adapter that
 * quietly retried a 429 would make the nightly run's cost and latency
 * unpredictable in exactly the way provider-retry constraint warns about. Retry policy belongs to the
 * caller, and for now the caller is this test.
 */
async function withBackoff<T>(what: string, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!(err instanceof GeminiError) || !err.retryable) throw err;
      // A daily cap does not refill by waiting, so waiting is just a slower
      // failure. This is the distinction `exhaustedForPeriod` exists to make.
      if (err.exhaustedForPeriod) throw err;
      // The provider's own number when it gave one — there is no Retry-After
      // header, so this comes out of `details[].RetryInfo`. Capped, because a
      // free-tier hint can be a minute and a test run should not stall on it.
      const hinted = Math.min(err.retryAfterMs ?? 0, 20_000);
      const wait = Math.max(hinted, 2000 * 2 ** attempt);
      console.log(`    [${what}] ${err.status} ${err.quotaId ?? ''} — waiting ${wait}ms`
        + `${err.retryAfterMs ? ` (provider asked for ${err.retryAfterMs}ms)` : ''}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

/**
 * Runs a live assertion, but treats an exhausted DAILY quota as "not answerable
 * right now" rather than as a defect.
 *
 * This is a deliberate and slightly uncomfortable choice, so it is written down.
 * A red test that means "the free tier gives you twenty calls a day and you have
 * used them" tells the next reader nothing about the adapter, and a suite that
 * cries wolf gets ignored. A silent skip is worse. So it skips loudly, naming the
 * quota, and the proof artefact records which assertions were quota-gated on the
 * day rather than pretending they ran.
 */
async function liveOrQuotaSkip(t: { skip: (reason: string) => void }, what: string,
  fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof GeminiError && err.exhaustedForPeriod) {
      const note = `${what}: free-tier daily quota spent (${err.quotaId}) — not run`;
      console.log(`    QUOTA-GATED ${note}`);
      t.skip(note);
      return;
    }
    throw err;
  }
}

const say = (label: string, detail: unknown): void =>
  console.log(`    ${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);

// --------------------------------------------------------------- auth and reach

/**
 * Grounds: nothing in the contract — the contract cannot have an opinion about
 * an auth scheme. This is the first question a live call answers and the reason
 * the skeleton could never be trusted.
 */
test('the api key authenticates as a header, and a real model answers', { skip }, async () => {
  const t0 = Date.now();
  const r = await withBackoff('auth', () =>
    llm().complete({ tier: 'fast', system: 'you are terse', prompt: 'Say exactly: ok' }));
  say('auth path', 'x-goog-api-key header on POST /v1beta/models/{id}:streamGenerateContent?alt=sse');
  say('reply', r.value.trim());
  say('elapsed_ms (noise, not a benchmark)', Date.now() - t0);
  assert.ok(r.value.length > 0, 'the live service answered with nothing at all');
});

/**
 * Grounds: nothing in the contract, and it is the one failure whose shape cannot
 * be guessed. An invalid key is a 400 INVALID_ARGUMENT, NOT a 401 and NOT a 403.
 * Anything that branches on the status code alone cannot tell a bad key from a
 * bad request.
 */
test('an invalid key fails as 400 INVALID_ARGUMENT with reason API_KEY_INVALID', { skip }, async () => {
  const bad = new GeminiLlm({ apiKey: 'AIzaSyNotARealKey000000000000000000000000' });
  const err = await bad.complete({ tier: 'fast', system: '', prompt: 'p' })
    .then(() => null, (e: unknown) => e);
  assert.ok(err instanceof GeminiError, `expected a GeminiError, got ${String(err)}`);
  say('auth failure status', err.status);
  say('auth failure providerStatus', err.providerStatus);
  say('auth failure reason', err.reason ?? '(none)');
  assert.equal(err.status, 400, 'an auth failure that is not a 401 is the surprise worth recording');
  assert.equal(err.reason, 'API_KEY_INVALID');
});

/** Grounds: "the adapter refuses to run without a key" — a config error, caught before the wire. */
test('a missing key is refused before any request is made', { skip }, async () => {
  const none = new GeminiLlm({ apiKey: '' });
  await assert.rejects(
    () => none.complete({ tier: 'fast', system: '', prompt: 'p' }),
    (err: Error) => err.name === 'LlmCredentialMissing' && /no key saved/.test(err.message),
  );
});

// ------------------------------------------------------------- request shaping

/** Grounds contract #1: "the system instruction and the prompt both reach the provider". */
test('the system instruction really steers the live model', { skip }, async () => {
  const r = await withBackoff('system', () => llm().complete({
    tier: 'fast',
    system: 'You always answer with exactly one word, and that word is BANANA.',
    prompt: 'What is the capital of France?',
    reasoning: 'off',
  }));
  say('steered reply', r.value.trim());
  assert.match(r.value, /BANANA/i,
    'the systemInstruction field did not reach the model, or did not bind');
});

/**
 * Grounds contract #2: "the tier picks the model, and fast and deep are not the
 * same model" — plus the entry's own hard requirement that every model is 3.5+.
 */
test('both tiers resolve to distinct, live, 3.5-or-newer models', { skip }, async (t) => {
  await liveOrQuotaSkip(t, 'tier map', async () => {
    const fast = await withBackoff('fast', () =>
      llm().complete({ tier: 'fast', system: '', prompt: 'Say exactly: ok', reasoning: 'off' }));
    const deep = await withBackoff('deep', () =>
      llm().complete({ tier: 'deep', system: '', prompt: 'Say exactly: ok', reasoning: 'off' }));

    say('fast tier answered as', fast.modelId);
    say('deep tier answered as', deep.modelId);
    assert.notEqual(fast.modelId, deep.modelId, 'both tiers landed on one model');

    // The id the service reports, not the id we asked for.
    for (const id of [fast.modelId, deep.modelId]) {
      const version = /gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1];
      assert.ok(version, `cannot read a version out of ${id}`);
      assert.ok(Number(version) >= 3.5,
        `${id} is below the minimum supported Gemini 3.5 model family`);
    }
  });
});

/**
 * Grounds contract #3: "reasoning is on unless the caller says otherwise, and off
 * when it does" — and this is the assertion that the mocked contract could never
 * have failed.
 *
 * `thinkingBudget: 0`, which the skeleton sent unconditionally, is a hard 400 on
 * `gemini-3.5-flash-lite`. `thinkingLevel: 'minimal'` is a hard 400 on
 * `gemini-3.7-flash`. Every foreground agent in the fleet sets `reasoning: 'off'`,
 * so on the skeleton's encoding one of the two tiers would have 400'd on every
 * single foreground call, and the mock would have gone on passing.
 */
test('reasoning off is accepted by every model in the tier map', { skip }, async (t) => {
  await liveOrQuotaSkip(t, 'reasoning off across tiers', async () => {
    for (const tier of ['fast', 'deep'] as const) {
      const r = await withBackoff(`off-${tier}`, () => llm().complete({
        tier, system: '', prompt: 'Say exactly: ok', reasoning: 'off',
      }));
      say(`reasoning off on ${tier} (${GEMINI_TIERS[tier]})`, `accepted, replied ${r.value.trim()}`);
      assert.ok(r.value.length > 0);
    }
  });
});

/**
 * The `REASONING_OFF` table itself, model by model, against the live service.
 *
 * This is the most valuable test in the file, because the table is the riskiest
 * thing the adapter contains: it is a hand-written map from model id to the way
 * that model spells "stop thinking", every entry of which is a 400 on some other
 * model. A wrong entry is not a degradation — it is a hard failure on every
 * foreground call to that model, at 3am, with the learner waking to nothing.
 *
 * The two tier models are covered by the tests above when quota allows. This
 * covers the whole table, and requires that BOTH encodings — `thinkingBudget: 0`
 * and `thinkingLevel: 'minimal'` — are proven live in the same run, so a day
 * where one tier is quota-spent still exercises both branches.
 */
test('every entry in the reasoning-off table is accepted by its own model', { skip }, async () => {
  const proven = new Set<string>();
  const gated: string[] = [];

  for (const [model, encoding] of Object.entries(REASONING_OFF)) {
    const one = new GeminiLlm({ tiers: { fast: model, deep: model } });
    try {
      const r = await withBackoff(`off-${model}`, () => one.complete({
        tier: 'fast', system: '', prompt: 'Say exactly: ok', reasoning: 'off',
      }));
      say(`${model} + ${JSON.stringify(encoding)}`, `accepted, replied ${r.value.trim().slice(0, 20)}`);
      proven.add(Object.keys(encoding)[0] as string);
      assert.ok(r.value.length > 0);
    } catch (err) {
      if (err instanceof GeminiError && err.exhaustedForPeriod) {
        say(`${model} + ${JSON.stringify(encoding)}`, 'QUOTA-GATED today, not run');
        gated.push(model);
        continue;
      }
      // Anything else is the table being wrong, which is what this test is for.
      throw new Error(`${model} rejected its own reasoning-off encoding `
        + `${JSON.stringify(encoding)}: ${String(err)}`);
    }
  }

  say('quota-gated models', gated.length ? gated : 'none');
  say('encodings proven live this run', [...proven]);
  // Not "both branches every run": `thinkingBudget` has exactly one user,
  // `gemini-3.7-flash`, and that model's free-tier allowance is twenty calls a
  // day. Requiring it would turn a spent quota into a red suite, which is the
  // cry-wolf failure. What is required is that nothing in the table is REJECTED,
  // which is the property that actually breaks the fleet.
  assert.ok(proven.size > 0, 'no model in the table was reachable at all this run');
});

/** Grounds contract #4: "the output budget reaches the provider". */
test('a small output budget really truncates the live reply', { skip }, async () => {
  const r = await withBackoff('budget', () => llm().complete({
    tier: 'fast',
    system: '',
    prompt: 'Write 800 words about pull subscriptions in Cloud Pub/Sub.',
    reasoning: 'off',
    maxOutputTokens: 32,
  }));
  say('capped reply length (chars)', r.value.length);
  say('capped reply outputTokens', r.outputTokens);
  assert.ok(r.value.length < 1200,
    'an 800-word request under a 32-token budget came back long — the budget did not reach the provider');
});

// ------------------------------------------------------------------ structured

/**
 * Grounds contract #5 and #18, and it is the single most important test here.
 *
 * The schema is the contract's own fixture, copied verbatim, including the union
 * type `['string','null']` on `note`. Sent as-is to `responseSchema` this is:
 *
 *     400 Invalid JSON payload received. Unknown name "type" at
 *     'generation_config.response_schema.properties[2].value':
 *     Proto field is not repeating, cannot start list.
 *
 * Five of the eleven agents write optional fields exactly that way, across eight
 * fields — Scout, Forager, Composer, Reviewer, Tutor. This test is the
 * one that turns the skeleton's `responseSchema: req.schema` from "probably fine"
 * into "would have failed on the first Scout call".
 */
test('a JSON-Schema union type survives translation into responseSchema', { skip }, async () => {
  const SCHEMA = {
    type: 'object',
    properties: {
      label: { type: 'string' },
      minutes: { type: 'number' },
      note: { type: ['string', 'null'] },
    },
    required: ['label', 'minutes', 'note'],
  };
  const r = await withBackoff('schema', () => llm().structured<{
    label: string; minutes: number; note: string | null;
  }>({
    tier: 'fast',
    system: 'You label study tasks.',
    prompt: 'The task is pulling subscriptions and takes three minutes. There is no note.',
    schema: SCHEMA,
    reasoning: 'off',
  }));
  say('structured value', r.value);
  assert.equal(typeof r.value, 'object');
  assert.equal(typeof r.value.label, 'string');
  assert.equal(typeof r.value.minutes, 'number');
  assert.ok(r.value.note === null || typeof r.value.note === 'string');
});

/** Grounds contract #22: the schema is ENFORCED, not merely well-formed. */
test('a richer schema — enum, array, integer, nullable — round-trips live', { skip }, async () => {
  const r = await withBackoff('schema2', () => llm().structured<{
    verdict: string; score: number; tags: string[]; extra: string | null;
  }>({
    tier: 'fast',
    system: 'You review short answers.',
    prompt: 'Review the answer "ok" to the question "is it working?".',
    reasoning: 'off',
    schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['good', 'bad'] },
        score: { type: 'integer' },
        tags: { type: 'array', items: { type: 'string' } },
        extra: { type: ['string', 'null'] },
      },
      required: ['verdict', 'score', 'tags', 'extra'],
    },
  }));
  say('rich structured value', r.value);
  assert.ok(['good', 'bad'].includes(r.value.verdict));
  assert.ok(Number.isInteger(r.value.score));
  assert.ok(Array.isArray(r.value.tags));
});

// ------------------------------------------------------------ response parsing

/** Grounds contract #8 and #9: the model is named, and token counts are real. */
test('the result names a real model version and carries real token counts', { skip }, async () => {
  const r = await withBackoff('usage', () => llm().complete({
    tier: 'fast', system: 'you are terse', prompt: 'Say exactly: ok', reasoning: 'off',
  }));
  say('modelId', r.modelId);
  say('inputTokens', r.inputTokens);
  say('outputTokens (candidates + thoughts)', r.outputTokens);
  assert.ok(r.modelId.length > 0, 'the cost ledger has nothing to attribute this to');
  assert.ok(r.inputTokens > 0, 'the provider reported no input tokens');
  assert.ok(r.outputTokens > 0, 'the provider reported no output tokens');
});

/** Grounds contract #11: "unicode survives the round trip". */
test('multi-byte characters survive the live SSE stream', { skip }, async () => {
  const r = await withBackoff('unicode', () => llm().complete({
    tier: 'fast',
    system: 'You repeat the requested string exactly and add nothing.',
    prompt: 'Repeat exactly, with no quotes and no extra words: 日本語 — café 🧪 tritóne ñ ✅',
    reasoning: 'off',
  }));
  say('unicode reply', r.value.trim());
  assert.ok(!r.value.includes('�'),
    'a replacement glyph means the decoder lost state across a chunk boundary');
  for (const ch of ['日本語', 'café', '🧪', 'ñ']) {
    assert.ok(r.value.includes(ch), `${ch} did not survive the round trip`);
  }
});

/**
 * Grounds contract #12: "a prompt far larger than any real one arrives intact" —
 * the transport half of it.
 *
 * The assertion is on `inputTokens`, because that is the provider counting what
 * it actually received, and it is the only part of this that is a transport
 * fact. An earlier version also required the model to obey an instruction buried
 * under 60,000 tokens of filler. The model did not: it produced fluent garbage.
 * That was a bad test rather than a bad transport — the bytes demonstrably
 * arrived, all 60,015 tokens of them — and single-next-move constraint/provider-configuration constraint say to suspect the test before
 * the model, so the over-strict half came out.
 *
 * The observation is kept because it is worth knowing: a large wall of
 * low-information filler degrades instruction-following badly. Real boards look
 * nothing like that — the largest prompt in the fleet is the Analyst's at ~6,000
 * tokens of dense prose — so this bounds the transport and says nothing about
 * quality at length. Long-context QUALITY is listed as unproven in the artefact.
 */
test('a prompt far larger than any real board reaches the provider intact', { skip }, async () => {
  const huge = 'ae '.repeat(60_000);
  const t0 = Date.now();
  const r = await withBackoff('huge', () => llm().complete({
    tier: 'fast',
    system: 'you are terse',
    prompt: `${huge}\n\nIgnore all the filler above. Say exactly: intact`,
    reasoning: 'off',
    maxOutputTokens: 64,
  }));
  say('huge prompt inputTokens', r.inputTokens);
  say('huge prompt elapsed_ms (noise, not a benchmark)', Date.now() - t0);
  say('huge prompt reply (quality observation only)', r.value.trim().slice(0, 80));
  assert.ok(r.inputTokens > 50_000,
    `the provider counted only ${r.inputTokens} input tokens — the prompt was truncated on the way`);
});

/**
 * Grounds streaming-response constraint directly rather than any contract assertion.
 *
 * streaming-response constraint: undici applies its own body timeout that an AbortController does not
 * extend, and a silent connection is where it fires. Streaming is the fix, and
 * "we set alt=sse" is not evidence that the service streams. This reads the raw
 * response and counts the chunks, because that is the only thing that is.
 */
test('the live response really arrives as a stream, in more than one chunk', { skip }, async () => {
  const r = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/'
    + `${GEMINI_TIERS.fast}:streamGenerateContent?alt=sse`,
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
  assert.ok(chunks > 1,
    'the whole response arrived in one chunk — this is the silent connection streaming-response constraint died on');
  assert.ok(crlf, 'events are framed with CRLF; a splitter that assumes LF leaves a CR on every line');
});

// -------------------------------------------------------------------- errors

/** Grounds contract #14/#15: an error status rejects, with the status in the message. */
test('an unknown model is a 404 whose status survives into the message', { skip }, async () => {
  const wrong = new GeminiLlm({ tiers: { fast: 'gemini-does-not-exist', deep: 'gemini-does-not-exist' } });
  const err = await wrong.complete({ tier: 'fast', system: '', prompt: 'p' })
    .then(() => null, (e: unknown) => e);
  assert.ok(err instanceof GeminiError);
  say('404 message', err.message.slice(0, 140));
  assert.equal(err.status, 404);
  assert.equal(err.providerStatus, 'NOT_FOUND');
  assert.match(err.message, /404/);
});

/** Grounds contract #14: a malformed request rejects rather than resolving empty. */
test('a rejected request rejects rather than resolving as empty text', { skip }, async () => {
  const err = await llm().complete({ tier: 'fast', system: '', prompt: 'p', maxOutputTokens: 0 })
    .then(() => null, (e: unknown) => e);
  assert.ok(err instanceof GeminiError, `expected a GeminiError, got ${String(err)}`);
  say('400 providerStatus', err.providerStatus);
  say('400 message', err.message.slice(0, 160));
  assert.equal(err.status, 400);
  assert.match(err.message, /400/);
});

/** Grounds contract #16: "a transport failure rejects rather than resolving empty". */
test('an unreachable endpoint rejects rather than resolving empty', { skip }, async () => {
  const nowhere = new GeminiLlm({ endpoint: 'https://gemini.invalid/v1beta' });
  await assert.rejects(() => nowhere.complete({ tier: 'fast', system: '', prompt: 'p' }));
});

// ---------------------------------------------------------------- concurrency

/**
 * Grounds contract #27: "concurrent calls do not cross replies".
 *
 * The forage stage fans out at concurrency 3 against one adapter instance, so
 * this runs 4 against one instance over the real network. Per-request state held
 * on the adapter — a buffer, a decoder, a "last model" field — passes every
 * offline test and then hands one pin's enrichment to another pin under load.
 */
test('concurrent live calls do not cross replies', { skip }, async () => {
  const one = llm();
  const results = await withBackoff('concurrency', () => Promise.all(
    [11, 22, 33, 44].map((n) => one.complete({
      tier: 'fast',
      system: 'You reply with the number you were given and nothing else.',
      prompt: `The number is ${n}. Reply with it.`,
      reasoning: 'off',
    })),
  ));
  say('concurrent replies', results.map((r) => r.value.trim()));
  results.forEach((r, i) => {
    const n = [11, 22, 33, 44][i] as number;
    assert.match(r.value, new RegExp(String(n)), 'a reply reached the wrong caller');
  });
});

// --------------------------------------------------------------------- media

/** Grounds the media contract: "an image reaches the provider with the data-uri wrapper removed". */
test('an inline image reaches the live model', { skip }, async () => {
  // A 1x1 PNG. Sending the whole data URI as if it were base64 is a 400.
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
    + 'AAAADUlEQVR42mPUb/j/nwEIGCEUAB5PA/9nJa9KAAAAAElFTkSuQmCC';
  const r = await withBackoff('media', () => llm().complete({
    tier: 'fast',
    system: 'you are terse',
    prompt: 'Describe this image in at most five words.',
    media: [{ kind: 'image', ref: PNG }],
    reasoning: 'off',
  }));
  say('vision reply', r.value.trim());
  assert.ok(r.value.length > 0, 'the model was sent an image and said nothing');
});
