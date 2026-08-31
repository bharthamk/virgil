import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiLlm, GeminiBlockedError } from '../gemini-llm.js';

/**
 * A reply the provider terminated on its own content policy.
 *
 * the transport contract §3z left this open on purpose: a
 * `finishReason: SAFETY` candidate arrives over a **200**, with the ordinary SSE
 * framing and no text — which is byte-for-byte what a model that answered
 * nothing looks like. An empty reply is a legitimate answer everywhere in this
 * fleet (the Forager's `nothing-found`, the Composer's `nothing-to-teach`), so
 * the two collapsing into one is the "fails open, manufactures confidence"
 * shape: the learner is told the board had nothing to teach, when in fact the
 * model refused to teach it.
 *
 * The adapter closes this fail-closed: a
 * safety termination is a **model failure**, and must never be indistinguishable
 * from an empty reply.
 *
 * Why a rejection rather than a typed result: `LlmResult` has no channel for
 * "no answer" — the port's entire error taxonomy is the rejection, and
 * `llm-contract.ts` states it four times over ("rejects rather than resolving
 * empty", for 4xx, 5xx, transport and deadline). Upstream, a throw out of the
 * seam is already precisely what the agents record as `model-failed`
 * (`forager.ts`'s catch, `reviewer.ts`, and the Composer's `model-failed`
 * outcome from the "night the model emptied" commit). A new typed result would
 * be a second, parallel taxonomy that every one of the eleven agents would have
 * to learn; a throw lands in the machinery they already have.
 *
 * NOTHING HERE CALLS GOOGLE. The transport is a function.
 *
 * Fixture provenance, stated honestly: the SSE **framing** below is the recorded
 * framing from `gemini-llm-contract.test.ts` (CRLF events, `data: ` with a
 * space, no `[DONE]`, `modelVersion` per event, usage on every event). The
 * `finishReason` / `promptFeedback` **payloads** are the documented shapes — a
 * live recording of one would mean deliberately prompting the service for
 * material it refuses, which is neither cheap on a 20-req/day key nor something
 * to leave in a repo. Every field the adapter reads is on the recorded path.
 */

const encoder = new TextEncoder();

const stream = (events: readonly unknown[]): Response =>
  new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join('')));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

const usage = { promptTokenCount: 412, candidatesTokenCount: 0, thoughtsTokenCount: 0 };

/** A candidate the service terminated. `parts` is absent entirely, as it is live. */
const terminated = (finishReason: string, partial?: string) => ({
  candidates: [{
    ...(partial === undefined ? {} : { content: { parts: [{ text: partial }], role: 'model' } }),
    finishReason,
    index: 0,
    safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH', blocked: true }],
  }],
  usageMetadata: usage,
  modelVersion: 'gemini-3.5-flash-lite',
  responseId: 'recorded-shape-not-a-live-response',
});

/** The prompt-side block: no candidates at all, only `promptFeedback`. */
const promptBlocked = {
  promptFeedback: {
    blockReason: 'SAFETY',
    safetyRatings: [{ category: 'HARM_CATEGORY_HARASSMENT', probability: 'HIGH', blocked: true }],
  },
  usageMetadata: { promptTokenCount: 412 },
  modelVersion: 'gemini-3.5-flash-lite',
};

/** An ordinary, well-behaved reply, framed exactly as the live service frames one. */
const ordinary = (text: string) => [
  {
    candidates: [{ content: { parts: [{ text }], role: 'model' }, index: 0 }],
    usageMetadata: usage,
    modelVersion: 'gemini-3.5-flash-lite',
  },
  {
    candidates: [{
      content: { parts: [{ text: '', thoughtSignature: 'EqUDCqIDARFNMg8u9Gyole' }], role: 'model' },
      finishReason: 'STOP',
      index: 0,
    }],
    usageMetadata: usage,
    modelVersion: 'gemini-3.5-flash-lite',
  },
];

async function withStream<T>(events: readonly unknown[], fn: (llm: GeminiLlm) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => stream(events)) as unknown as typeof globalThis.fetch;
  try {
    return await fn(new GeminiLlm({ endpoint: 'https://stub.invalid/v1beta', apiKey: 'not-a-real-key' }));
  } finally {
    globalThis.fetch = real;
  }
}

const complete = (llm: GeminiLlm) => llm.complete({ tier: 'fast', system: '', prompt: 'teach this pin' });

test('a SAFETY-terminated reply rejects instead of arriving as an empty answer', async () => {
  await withStream([terminated('SAFETY')], async (llm) => {
    await assert.rejects(
      () => complete(llm),
      (e: unknown) => {
        if (!(e instanceof GeminiBlockedError)) {
          return assert.fail('the content-refusal contract: a safety block is a model failure, and the seam says so in a type '
            + 'a caller can tell apart from a 429 or a dead socket');
        }
        assert.equal(e.finishReason, 'SAFETY');
        assert.match(e.message, /SAFETY/, 'the reason has to survive into the message a human reads at 3am');
        return true;
      },
    );
  });
});

test('the block is distinguishable from an empty reply, which still resolves as an empty string', async () => {
  // The pair is the whole point. Same status, same framing, same zero characters
  // of text — and opposite facts about the night.
  const empty = await withStream(ordinary(''), complete);
  assert.equal(empty.value, '', 'an empty answer is still the caller\'s to interpret (llm-contract)');
  await withStream([terminated('SAFETY')], async (llm) => {
    await assert.rejects(() => complete(llm));
  });
});

test('a structured call that is blocked rejects rather than being retried three times', async () => {
  // The ladder retries drift and truncation because more headroom fixes those. A
  // refusal is not a budget problem: retrying it spends two more of twenty daily
  // requests to be refused twice more, which is graceful-degradation constraint’s lesson pointed at quota.
  let attempts = 0;
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    attempts += 1;
    return stream([terminated('SAFETY')]);
  }) as unknown as typeof globalThis.fetch;
  try {
    const llm = new GeminiLlm({ endpoint: 'https://stub.invalid/v1beta', apiKey: 'not-a-real-key' });
    await assert.rejects(() => llm.structured({
      tier: 'deep', system: '', prompt: 'p', schema: { type: 'object', properties: {} },
    }));
    assert.equal(attempts, 1, 'a refusal retried is a refusal paid for three times');
  } finally {
    globalThis.fetch = real;
  }
});

test('the other refusal reasons the envelope can carry are blocks too', async () => {
  for (const reason of ['RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY']) {
    await withStream([terminated(reason)], async (llm) => {
      await assert.rejects(() => complete(llm), (e: unknown) => {
        assert.ok(e instanceof GeminiBlockedError, `${reason} arrived as a readable answer`);
        assert.equal((e as GeminiBlockedError).finishReason, reason);
        return true;
      });
    });
  }
});

test('a prompt refused before generation is a block, even with no candidate to carry a reason', async () => {
  await withStream([promptBlocked], async (llm) => {
    await assert.rejects(() => complete(llm), (e: unknown) => {
      assert.ok(e instanceof GeminiBlockedError);
      assert.equal((e as GeminiBlockedError).blockReason, 'SAFETY');
      return true;
    });
  });
});

test('a block that arrives after some text has streamed is still a block', async () => {
  // Live, the service can emit a sentence and then stop on the policy. Half a
  // section presented as a whole one is graceful-degradation constraint wearing a different hat: the learner
  // cannot tell a truncated explanation from a complete one, so fail-closed
  // applies here too and the partial text goes into the message, not the result.
  await withStream([ordinary('A pull subscription lets the consumer')[0], terminated('SAFETY', '')],
    async (llm) => {
      await assert.rejects(() => complete(llm), (e: unknown) => e instanceof GeminiBlockedError);
    });
});

test('MAX_TOKENS is not a block, because more headroom is the documented fix for it', async () => {
  // The structured ladder's second rung exists for exactly this reason. Turning
  // truncation into a hard failure would delete the graceful-degradation constraint repair the contract
  // asserts on.
  const r = await withStream([{
    candidates: [{ content: { parts: [{ text: '{"label": "pull subs", "minu' }], role: 'model' }, finishReason: 'MAX_TOKENS', index: 0 }],
    usageMetadata: usage,
    modelVersion: 'gemini-3.5-flash-lite',
  }], complete);
  assert.equal(r.value, '{"label": "pull subs", "minu');
});

test('STOP and an unstated finish reason are both ordinary replies', async () => {
  const stopped = await withStream(ordinary('a label'), complete);
  assert.equal(stopped.value, 'a label');
  const unstated = await withStream([ordinary('a label')[0]], complete);
  assert.equal(unstated.value, 'a label', 'the mid-stream events carry no finishReason at all');
});
