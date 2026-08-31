import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LlmCredentialMissing, LlmRefused, type Llm, type LlmResult } from '@sb/core';

import { brokenLlm, startService, type Harness } from './service-harness.js';

/**
 * The second refusal: a connection with no credential saved.
 *
 * Dev, dogfood batch B: deep work was routed to Cloud/API, Cloud/API had no key,
 * and `POST /mark` answered **200** with *"That check did not run, so I have not
 * read your work."* — in under a second, with no reason and nothing to press.
 * Meanwhile the service's own Settings receipt was already saying, in as many
 * words, "Google credentials are still needed". The product knew. The screen
 * did not.
 *
 * This is the budget stop's defect in a second costume, and it is fixed the same
 * way: the pre-issue refusal gets a type that says "nothing was sent", every
 * agent that degrades on a model failure lets that type through, and the
 * endpoint layer answers it with a sentence naming what is missing and where to
 * fix it.
 *
 * ## What is asserted, and why in this order
 *
 *  1. the refusal reaches the wire as a 4xx with a discriminator, on both check
 *     routes — the two Dev actually pressed;
 *  2. it is NOT a 402, because the budget owns that status alone and "you have
 *     spent your limit" is a different fact with a different fix;
 *  3. a genuine model failure still degrades to `200 model-failed`, which is the
 *     half of the rule a careless fix breaks.
 */

/** Over `MIN_DRAFT_CHARS` and `MIN_WORK_CHARS`, so the agent reaches its call. */
const LONG_ENOUGH = 'They wrote this themselves and would like to know what is weak about it. '.repeat(4);

const RUBRIC = '1. States a target metric\n2. Cites three sources';

/**
 * The Cloud/API connection with nothing to authenticate with.
 *
 * The adapter raises exactly this, from `GeminiLlm.call`, before a request body
 * is built. Reproduced at the seam rather than by starting a real adapter so the
 * test is about the propagation and not about Gemini.
 */
const unconfiguredCloud = (): Llm => {
  const refuse = (): never => {
    throw new LlmCredentialMissing('cloud', 'GeminiLlm has no API key');
  };
  return {
    complete: async () => refuse(),
    structured: async <T>(): Promise<LlmResult<T>> => refuse(),
  };
};

/** The whole 409 contract, asserted the same way for every route. */
function assertCredentialRefusal(res: { status: number; body: any }): void {
  assert.equal(res.status, 409, 'a refusal is not a failure, and 200 model-failed said it was');
  assert.notEqual(res.status, 402, 'the budget owns 402 alone; this is not a budget');
  assert.equal(res.body.stoppedBy, 'model-credential');
  assert.equal(res.body.connection, 'cloud');
  assert.equal(res.body.fixAt, 'settings/models');
  assert.match(res.body.error, /Cloud\/API connection has no key saved/);
  assert.match(res.body.error, /Settings → Models/,
    'the sentence has to say where, or it is the same dead end in nicer words');
  assert.equal(res.body.outcome, undefined,
    'a degraded outcome in a refusal body would be the same lie in a new place');
}

const withUnconfiguredCloud = (tag: string): Promise<Harness> =>
  startService(tag, { llm: unconfiguredCloud() });

test('the credential refusal is a refusal in the seam, not a model failure', () => {
  const err = new LlmCredentialMissing('cloud', 'GeminiLlm has no API key');
  assert.ok(err instanceof LlmRefused,
    'every catch that degrades tests for LlmRefused; a sibling class would be caught by all of them');
  assert.equal(err.connection, 'cloud');
  assert.equal(err.detail, 'GeminiLlm has no API key',
    'the operator sentence survives for the log, and never reaches the learner');
  assert.doesNotMatch(err.message, /GeminiLlm|API key not valid/,
    'a vendor class name is not something a learner can act on');
});

test('POST /mark says what is missing and where, instead of "the check did not run"', async (t) => {
  // THE reported defect, in one test. It returned 200 `model-failed` in under a
  // second, with no reason and no control.
  const h = await withUnconfiguredCloud('credential-mark');
  t.after(() => h.close());

  assertCredentialRefusal(await h.call('POST', '/mark', { work: LONG_ENOUGH, rubric: RUBRIC }));
});

test('POST /review says the same thing on the no-rubric route', async (t) => {
  const h = await withUnconfiguredCloud('credential-review');
  t.after(() => h.close());

  assertCredentialRefusal(await h.call('POST', '/review', { draft: LONG_ENOUGH }));
});

test('the refusal writes nothing, exactly as the budget stop writes nothing', async (t) => {
  const h = await withUnconfiguredCloud('credential-writes-nothing');
  t.after(() => h.close());
  const before = {
    signals: (await h.store.listSignals()).length,
    pins: (await h.store.listPins()).length,
  };

  await h.call('POST', '/mark', { work: LONG_ENOUGH, rubric: RUBRIC });

  assert.deepEqual({
    signals: (await h.store.listSignals()).length,
    pins: (await h.store.listPins()).length,
  }, before, 'a learner who was never read is not evidence about anything');
});

test('the same endpoints still degrade when the model itself fails', async (t) => {
  /*
   * The control, and the half of the rule a careless fix breaks. Taking the
   * refusal out of the degrading bucket must not take an outage out with it: a
   * provider that is down still gets `model-failed` and a 200, because "that
   * check did not run" is the true sentence for that one.
   */
  const h = await startService('credential-outage-still-degrades', { llm: brokenLlm() });
  t.after(() => h.close());

  const marked = await h.call('POST', '/mark', { work: LONG_ENOUGH, rubric: RUBRIC });
  assert.equal(marked.status, 200);
  assert.equal(marked.body.outcome, 'model-failed');
  assert.equal(marked.body.stoppedBy, undefined, 'nothing refused this; it failed');

  const reviewed = await h.call('POST', '/review', { draft: LONG_ENOUGH });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.body.outcome, 'model-failed');
});
