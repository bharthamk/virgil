import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Llm, LlmRequest, LlmResult } from '../../../core/src/ports/llm.js';
import { GeminiError } from '../gemini-llm.js';
import { KeyLadderLlm } from '../key-ladder-llm.js';

/**
 * The ladder's whole contract: free first, paid only when the provider said
 * "not from this pool", and every other failure left exactly as it was.
 *
 * The free credential is used first, then the ladder switches to the
 * budget-guarded paid credential on a capacity failure.
 */

const answer = (value: string): LlmResult<string> =>
  ({ value, modelId: 'stub', inputTokens: 1, outputTokens: 1 });

/** An Llm that answers or throws on script, and counts what reached it. */
const scripted = (behave: () => LlmResult<string>): Llm & { calls: number } => {
  const stub = {
    calls: 0,
    async complete(_req: LlmRequest): Promise<LlmResult<string>> {
      stub.calls += 1;
      return behave();
    },
    async structured<T>(_req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> {
      stub.calls += 1;
      return behave() as LlmResult<T>;
    },
  };
  return stub;
};

const REQ: LlmRequest = { tier: 'fast', system: '', prompt: 'p' };
const capped = new GeminiError(429, 'RESOURCE_EXHAUSTED', undefined, 'day cap', undefined, 'PerDay');
const shed = new GeminiError(503, 'UNAVAILABLE', undefined, 'high demand');

test('the free arm answers and the paid arm is never touched', async () => {
  const free = scripted(() => answer('free'));
  const paid = scripted(() => answer('paid'));
  const lanes: string[] = [];
  let gated = 0;
  const ladder = new KeyLadderLlm(free, paid, {
    onLane: (l) => lanes.push(l), beforePaid: () => { gated += 1; },
  });
  assert.equal((await ladder.complete(REQ)).value, 'free');
  assert.equal(paid.calls, 0, 'the paid key was reached for while the free tier was answering');
  assert.equal(gated, 0, 'the kill-switch fired for a call that cost nothing');
  assert.deepEqual(lanes, ['free']);
});

test('a 429 on the free arm is the paid arm\'s cue — the day cap is why this class exists', async () => {
  const free = scripted(() => { throw capped; });
  const paid = scripted(() => answer('paid'));
  const lanes: string[] = [];
  let gated = 0;
  const ladder = new KeyLadderLlm(free, paid, {
    onLane: (l) => lanes.push(l), beforePaid: () => { gated += 1; },
  });
  assert.equal((await ladder.complete(REQ)).value, 'paid');
  assert.equal(gated, 1, 'money moved without the kill-switch being consulted');
  assert.deepEqual(lanes, ['paid']);
});

test('the kill-switch fires BEFORE the paid arm is touched, and its refusal stops the reach', async () => {
  // The ruling's second half: "then switches to paid with the internal
  // killswitch active." A stop must land before anything paid is issued.
  const stop = new Error('ModelBudgetStop');
  stop.name = 'ModelBudgetStop';
  const free = scripted(() => { throw capped; });
  const paid = scripted(() => answer('paid'));
  const ladder = new KeyLadderLlm(free, paid, { beforePaid: () => { throw stop; } });
  await assert.rejects(() => ladder.complete(REQ), (e: unknown) => e === stop);
  assert.equal(paid.calls, 0, 'the paid key was reached despite the kill-switch');
});

test('a 503 fails over too — free traffic is what load shedding sheds first', async () => {
  const free = scripted(() => { throw shed; });
  const paid = scripted(() => answer('paid'));
  const ladder = new KeyLadderLlm(free, paid);
  assert.equal((await ladder.structured<string>({ ...REQ, schema: {} })).value, 'paid');
});

test('a 400 does not fail over — the request is this build\'s own and money would not fix it', async () => {
  const bad = new GeminiError(400, 'INVALID_ARGUMENT', 'API_KEY_INVALID', 'bad request');
  const free = scripted(() => { throw bad; });
  const paid = scripted(() => answer('paid'));
  const ladder = new KeyLadderLlm(free, paid);
  await assert.rejects(() => ladder.complete(REQ), (e: unknown) => e === bad);
  assert.equal(paid.calls, 0, 'a request-shaped failure was retried onto the paid key');
});

test('a non-Gemini failure does not fail over — D18\'s no-retry law is not amended here', async () => {
  const transport = new Error('fetch failed');
  const free = scripted(() => { throw transport; });
  const paid = scripted(() => answer('paid'));
  const ladder = new KeyLadderLlm(free, paid);
  await assert.rejects(() => ladder.complete(REQ), (e: unknown) => e === transport);
  assert.equal(paid.calls, 0);
});

test('the paid arm\'s own refusal is the caller\'s to see — the ladder silences nothing', async () => {
  // The kill-switch: at the composition root the paid arm arrives wrapped in
  // budgetedLlm, so its refusal is a ModelBudgetStop thrown before anything is
  // issued. The ladder must pass it through untouched — a learner whose free
  // tier is spent AND whose budget is exhausted is told the truth in that
  // order, not shown a provider error.
  const stop = new Error('ModelBudgetStop');
  stop.name = 'ModelBudgetStop';
  const free = scripted(() => { throw capped; });
  const paid = scripted(() => { throw stop; });
  const ladder = new KeyLadderLlm(free, paid);
  await assert.rejects(() => ladder.complete(REQ), (e: unknown) => e === stop);
});

test('a paid-arm provider failure after failover is also left as it was', async () => {
  const free = scripted(() => { throw capped; });
  const paid = scripted(() => { throw shed; });
  const ladder = new KeyLadderLlm(free, paid);
  await assert.rejects(() => ladder.structured({ ...REQ, schema: {} }), (e: unknown) => e === shed);
});
