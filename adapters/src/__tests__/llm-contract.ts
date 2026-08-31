import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Llm } from '@sb/core';

/**
 * The `Llm` contract, written once and run against every adapter.
 *
 * The adapter seam says the port costs "two adapters, not a rewrite".
 * That promise is only as good as the definition of what an adapter has to do,
 * and until now that definition lived in prose on `ports/llm.ts` and in tests
 * written against one implementation. A second adapter could satisfy the
 * TypeScript interface completely and still be wrong in every way that matters
 * — drop the system instruction, swallow a 429 into an empty string, retry a
 * timeout three times, hand back JSON of the wrong shape.
 *
 * That failure class is not hypothetical. DEAD_ENDS.md D10 is the Analyst's
 * truncated JSON killing a nine-minute run; D11 is a capability difference read
 * as a crash for a whole evening because the plumbing around the model was
 * suspected last instead of first. Both are integration-plumbing bugs at this
 * seam, and both are cheap to catch here and expensive to catch in a nightly
 * run against a paid API.
 *
 * So the contract is executable, and it is provider-neutral. An adapter is
 * bound to it by supplying an `LlmSubject`: something that can build the
 * adapter with its transport replaced by a fake, and decode what the adapter
 * put on the wire back into the neutral `SeamCall` shape below. Nothing in this
 * file knows what Ollama or Gemini or anything else looks like, which is the
 * whole point — the next adapter inherits every assertion for the price of one
 * binding.
 *
 * No test here touches a network. The transport is a function.
 */

// ------------------------------------------------------------ what we assert on

/**
 * One request as it reached the provider, decoded out of that provider's wire
 * format by the binding.
 *
 * These are the fields `LlmRequest` promises to carry. A field that cannot
 * survive the trip to the provider is a field the agents cannot rely on, and
 * every one of them is load-bearing somewhere: `tier` is the cost model,
 * `reasoning` is the 12x latency lever from D2, `maxOutputTokens` is the
 * headroom whose absence caused D10.
 */
export interface SeamCall {
  /** The concrete model the tier resolved to. */
  readonly model: string;
  /** The system instruction, as the provider received it. */
  readonly system: string;
  /** The user text, as the provider received it. May wrap the caller's prompt. */
  readonly prompt: string;
  /** Whether the request asked the provider to constrain output to JSON. */
  readonly jsonMode: boolean;
  /** The schema, if this provider carries it in a field of its own. */
  readonly schemaOnWire: unknown;
  /** Whether the provider was asked to run its thinking pass. */
  readonly thinking: boolean;
  /** The output budget the provider was given. */
  readonly maxOutputTokens: number;
  /** Image payloads, provider-encoded. */
  readonly images: readonly string[];
  /** Whether a deadline was attached to the call at all. */
  readonly hasAbortSignal: boolean;
}

/** What the fake transport does when the adapter calls it. */
export type TransportOutcome =
  /** A normal reply. `splitBytes` delivers it one byte per chunk. */
  | { kind: 'text'; text: string; inputTokens?: number; outputTokens?: number; splitBytes?: boolean }
  /** The provider answered with an error status — 429, 500, 503. */
  | { kind: 'http'; status: number; body?: string }
  /** The connection failed: DNS, reset, TLS. */
  | { kind: 'network'; message: string }
  /** The deadline fired. Shaped as the abort the adapter's own timer produces. */
  | { kind: 'abort' };

export interface LlmSession {
  readonly llm: Llm;
  /** Every call the adapter made, in order, decoded. */
  readonly calls: readonly SeamCall[];
  close(): void;
}

export interface LlmSubject {
  readonly name: string;
  /** Build the adapter with its transport replaced by `serve`. */
  open(serve: (call: SeamCall) => TransportOutcome): LlmSession;
}

/** Serves the given outcomes in order, repeating the last one for ever. */
export const inOrder = (outcomes: readonly TransportOutcome[]) => {
  let i = 0;
  return (): TransportOutcome => outcomes[Math.min(i++, outcomes.length - 1)] as TransportOutcome;
};

const text = (s: string): TransportOutcome => ({ kind: 'text', text: s });

/**
 * A schema "reached the provider" whether it travelled in a field of its own
 * (Gemini's `responseSchema`) or inside the prompt (what Ollama has to do).
 * Both are conforming; caring which would bake one provider into the contract.
 */
const schemaReached = (call: SeamCall, schema: unknown): boolean =>
  JSON.stringify(call.schemaOnWire) === JSON.stringify(schema)
  || call.prompt.includes(JSON.stringify(schema));

// -------------------------------------------------------------------- fixtures

const SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    minutes: { type: 'number' },
    note: { type: ['string', 'null'] },
  },
  required: ['label', 'minutes', 'note'],
};

const CONFORMING = { label: 'pull subscriptions', minutes: 3, note: null };

const call = <T>(n: number, arr: readonly T[]): T => {
  assert.ok(arr.length > n, `expected at least ${n + 1} calls, saw ${arr.length}`);
  return arr[n] as T;
};

// ------------------------------------------------------------------- the suite

/**
 * Registers the whole contract against one adapter.
 *
 * Every test name is written as the promise being kept, because a failure line
 * is the only documentation anyone reads at 3am.
 */
export function runLlmContract(subject: LlmSubject): void {
  /**
   * One test, one session, one canned script. The transport serves the
   * outcomes in order and repeats the last one, so a test that expects three
   * attempts does not have to spell out three replies.
   */
  const named = (name: string, outcomes: readonly TransportOutcome[], fn: (s: LlmSession) => Promise<void>) =>
    test(`[${subject.name}] ${name}`, async () => {
      const s = subject.open(inOrder(outcomes));
      try { await fn(s); } finally { s.close(); }
    });

  // ------------------------------------------------------------ request shaping

  named('the system instruction and the prompt both reach the provider',
    [text('hello')], async (s) => {
      await s.llm.complete({ tier: 'fast', system: 'you are terse', prompt: 'label this passage' });
      const c = call(0, s.calls);
      assert.match(c.system, /you are terse/, 'a dropped system instruction is a silently different agent');
      assert.match(c.prompt, /label this passage/);
    });

  named('the tier picks the model, and fast and deep are not the same model',
    [text('x')], async (s) => {
      await s.llm.complete({ tier: 'fast', system: '', prompt: 'p' });
      await s.llm.complete({ tier: 'deep', system: '', prompt: 'p' });
      const fast = call(0, s.calls).model;
      const deep = call(1, s.calls).model;
      assert.ok(fast.length > 0 && deep.length > 0, 'the tier resolved to nothing');
      assert.notEqual(fast, deep,
        'an adapter that maps both tiers onto one model silently deletes the cost model');
    });

  named('reasoning is on unless the caller says otherwise, and off when it does',
    [text('x')], async (s) => {
      await s.llm.complete({ tier: 'deep', system: '', prompt: 'p' });
      await s.llm.complete({ tier: 'fast', system: '', prompt: 'p', reasoning: 'off' });
      assert.equal(call(0, s.calls).thinking, true, 'the documented default is on');
      assert.equal(call(1, s.calls).thinking, false,
        'reasoning off is the 12x latency lever from D2 — an adapter that ignores it breaks the toast budget');
    });

  named('the output budget reaches the provider, and a request without one still gets a budget',
    [text('x')], async (s) => {
      await s.llm.complete({ tier: 'deep', system: '', prompt: 'p', maxOutputTokens: 6000 });
      await s.llm.complete({ tier: 'deep', system: '', prompt: 'p' });
      assert.equal(call(0, s.calls).maxOutputTokens, 6000,
        'D10 was a headroom bug — an adapter that drops the budget reintroduces it');
      assert.ok(call(1, s.calls).maxOutputTokens > 0, 'an unstated budget must become a real one');
    });

  named('a structured call declares JSON output and carries the schema',
    [text(JSON.stringify(CONFORMING))], async (s) => {
      await s.llm.structured({ tier: 'deep', system: '', prompt: 'p', schema: SCHEMA });
      const c = call(0, s.calls);
      assert.equal(c.jsonMode, true, 'the provider was never told to constrain its output');
      assert.ok(schemaReached(c, SCHEMA), 'the schema never left the process');
    });

  named('every call carries a deadline',
    [text('x')], async (s) => {
      await s.llm.complete({ tier: 'deep', system: '', prompt: 'p' });
      assert.equal(call(0, s.calls).hasAbortSignal, true,
        'D19: a call with no deadline of its own inherits whatever the runtime feels like, '
        + 'and the nightly run has no one watching it');
    });

  // ----------------------------------------------------------- response parsing

  named('the provider text comes back verbatim',
    [text('  a label with edges  ')], async (s) => {
      const r = await s.llm.complete({ tier: 'fast', system: '', prompt: 'p' });
      assert.equal(r.value, '  a label with edges  ',
        'an adapter that trims, joins or reformats is deciding something the agent owns');
    });

  named('the model that actually answered is named in the result',
    [text('x')], async (s) => {
      const r = await s.llm.complete({ tier: 'deep', system: '', prompt: 'p' });
      assert.ok(r.modelId.length > 0, 'the cost ledger has nothing to attribute this to');
      assert.equal(r.modelId, call(0, s.calls).model);
    });

  named('token counts are reported from the provider, not invented',
    [{ kind: 'text', text: 'x', inputTokens: 137, outputTokens: 42 }], async (s) => {
      const r = await s.llm.complete({ tier: 'deep', system: '', prompt: 'p' });
      assert.equal(r.inputTokens, 137);
      assert.equal(r.outputTokens, 42);
    });

  named('an empty reply is an empty string, not an error and not null',
    [text('')], async (s) => {
      const r = await s.llm.complete({ tier: 'fast', system: '', prompt: 'p' });
      assert.equal(r.value, '', 'the caller decides what an empty answer means; the adapter does not');
    });

  named('unicode survives the round trip even when the transport splits characters',
    [{ kind: 'text', text: '日本語 — café 🧪 tritóne ñ ✅', splitBytes: true }], async (s) => {
      const r = await s.llm.complete({ tier: 'fast', system: '', prompt: 'p' });
      assert.equal(r.value, '日本語 — café 🧪 tritóne ñ ✅',
        'a decoder that does not carry state across chunks turns every multi-byte character '
        + 'into replacement glyphs, and a learner reading a mangled section has no way to tell '
        + 'whether the model or the plumbing did it');
    });

  named('a prompt far larger than any real one arrives intact',
    [text('x')], async (s) => {
      const huge = 'æ '.repeat(60_000);
      await s.llm.complete({ tier: 'deep', system: '', prompt: huge });
      assert.ok(call(0, s.calls).prompt.includes(huge),
        'an adapter that truncates silently makes the Composer teach from half a board');
    });

  named('an empty prompt and an empty system instruction are not an error',
    [text('')], async (s) => {
      const r = await s.llm.complete({ tier: 'fast', system: '', prompt: '' });
      assert.equal(r.value, '');
    });

  // -------------------------------------------------------- error propagation

  named('an error status rejects, and the status is in the message',
    [{ kind: 'http', status: 429, body: 'rate limited' }], async (s) => {
      await assert.rejects(
        () => s.llm.complete({ tier: 'fast', system: '', prompt: 'p' }),
        /429/,
        'a 429 that resolves as empty text is the worst possible outcome: the agent believes '
        + 'the model answered nothing, which is a legitimate answer everywhere in this fleet',
      );
    });

  named('a 5xx rejects rather than resolving empty',
    [{ kind: 'http', status: 503 }], async (s) => {
      await assert.rejects(() => s.llm.complete({ tier: 'deep', system: '', prompt: 'p' }), /503/);
    });

  named('a transport failure rejects rather than resolving empty',
    [{ kind: 'network', message: 'ECONNRESET' }], async (s) => {
      await assert.rejects(() => s.llm.complete({ tier: 'deep', system: '', prompt: 'p' }));
    });

  named('a fired deadline rejects rather than resolving empty',
    [{ kind: 'abort' }], async (s) => {
      await assert.rejects(() => s.llm.complete({ tier: 'deep', system: '', prompt: 'p' }));
    });

  // ------------------------------------------------------- structured semantics

  named('structured output comes back parsed, not as a string',
    [text(JSON.stringify(CONFORMING))], async (s) => {
      const r = await s.llm.structured<typeof CONFORMING>({ tier: 'deep', system: '', prompt: 'p', schema: SCHEMA });
      assert.deepEqual(r.value, CONFORMING);
      assert.equal(typeof r.value, 'object', 'the caller must never have to parse this itself');
    });

  named('prose around a conforming object is tolerated rather than failed',
    [text(`Sure! Here you go:\n\`\`\`json\n${JSON.stringify(CONFORMING)}\n\`\`\`\nAnything else?`)],
    async (s) => {
      const r = await s.llm.structured({ tier: 'deep', system: '', prompt: 'p', schema: SCHEMA });
      assert.deepEqual(r.value, CONFORMING);
      assert.equal(s.calls.length, 1, 'no retry should have been needed');
    });

  named('truncated JSON is retried with more headroom and no repair lecture',
    [text('{"label": "pull subs", "minu'), text(JSON.stringify(CONFORMING))], async (s) => {
      const r = await s.llm.structured({ tier: 'deep', system: '', prompt: 'p', schema: SCHEMA, maxOutputTokens: 1000 });
      assert.deepEqual(r.value, CONFORMING);
      assert.equal(s.calls.length, 2);
      assert.ok(call(1, s.calls).maxOutputTokens > call(0, s.calls).maxOutputTokens,
        'D10 was a budget problem — retrying it with the same budget retries the failure');
      assert.doesNotMatch(call(1, s.calls).prompt, /did not match the required schema/,
        'a reply that never parsed cannot have violated a schema; saying so teaches the model nothing');
    });

  named('schema drift is retried, and the retry is told which field was wrong',
    [text(JSON.stringify({ label: 'x', minutes: 'three', note: null })), text(JSON.stringify(CONFORMING))],
    async (s) => {
      const r = await s.llm.structured({ tier: 'deep', system: '', prompt: 'p', schema: SCHEMA });
      assert.deepEqual(r.value, CONFORMING);
      assert.equal(s.calls.length, 2);
      assert.match(call(1, s.calls).prompt, /minutes/,
        'retrying drift with the identical prompt asks the model to guess again');
    });

  named('well-formed JSON of the wrong shape never reaches the caller',
    [text(JSON.stringify({ label: 'x' }))], async (s) => {
      await assert.rejects(
        () => s.llm.structured({ tier: 'deep', system: '', prompt: 'p', schema: SCHEMA }),
        /did not conform|schema/i,
        'the port promises the schema is ENFORCED — an adapter that only proves the bytes '
        + 'parsed hands the agent a shape it will read fields off and find undefined',
      );
      assert.equal(s.calls.length, 3, 'the documented ladder is three attempts, no more and no fewer');
    });

  named('an empty reply to a structured call is refused, not returned as undefined',
    [text('')], async (s) => {
      await assert.rejects(() => s.llm.structured({ tier: 'deep', system: '', prompt: 'p', schema: SCHEMA }));
    });

  named('the last attempt turns the thinking pass off',
    [text('not json at all')], async (s) => {
      await assert.rejects(() => s.llm.structured({ tier: 'deep', system: '', prompt: 'p', schema: SCHEMA }));
      assert.equal(s.calls.length, 3);
      assert.equal(call(2, s.calls).thinking, false,
        'the thinking pass is usually what ate the budget; the last try must stop paying for it');
    });

  named('a transport error inside a structured call is not retried',
    [{ kind: 'http', status: 500 }], async (s) => {
      await assert.rejects(() => s.llm.structured({ tier: 'deep', system: '', prompt: 'p', schema: SCHEMA }));
      assert.equal(s.calls.length, 1,
        'retrying a dead transport with DOUBLE the budget only takes longer to fail the same way — '
        + 'and on the nightly run that time is multiplied across every stage');
    });

  named('a fired deadline inside a structured call is not retried either',
    [{ kind: 'abort' }], async (s) => {
      await assert.rejects(() => s.llm.structured({ tier: 'deep', system: '', prompt: 'p', schema: SCHEMA }));
      assert.equal(s.calls.length, 1);
    });

  // -------------------------------------------------------------- concurrency

  test(`[${subject.name}] concurrent calls do not cross replies`, async () => {
    // The forage stage fans out at concurrency 3 against one adapter instance.
    // An adapter holding per-request state on the instance — a buffer, a
    // decoder, a "last model" field — passes every test above and then hands
    // one pin's enrichment to another pin under load.
    const s = subject.open((c) => text(`echo:${/#(\d+)/.exec(c.prompt)?.[1] ?? '?'}`));
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => s.llm.complete({ tier: 'fast', system: '', prompt: `label this #${i}` })),
      );
      assert.deepEqual(results.map((r) => r.value), Array.from({ length: 8 }, (_, i) => `echo:${i}`),
        'a reply reached the wrong caller');
    } finally {
      s.close();
    }
  });
}

/**
 * The media half of the contract, for adapters whose provider takes images.
 * Separate because a provider without vision should not be failed for it — the
 * honest-degradation rule from SB-23 applied to the seam itself.
 */
export function runLlmMediaContract(subject: LlmSubject): void {
  test(`[${subject.name}] an image reaches the provider with the data-uri wrapper removed`, async () => {
    const s = subject.open(() => text('a diagram of a pull subscription'));
    try {
      await s.llm.complete({
        tier: 'fast', system: '', prompt: 'describe this',
        media: [{ kind: 'image', ref: 'data:image/png;base64,iVBORw0KGgo=' }],
      });
      const c = call(0, s.calls);
      assert.deepEqual(c.images, ['iVBORw0KGgo='],
        'sending the whole data URI as if it were base64 is a 400 from every provider, '
        + 'and it is the kind of thing only a real call finds');
    } finally {
      s.close();
    }
  });
}
