import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyModelSpend, fixedClock,
  type LearnerPrefs, type Llm, type LlmRequest, type LlmResult, type ModelSpend,
} from '@sb/core';

import {
  ModelBudgetLedger, ModelBudgetStop, budgetedLlm, budgetStopInScope, firePaidGateInScope,
  withBudgetScope,
} from '../model-budget.js';
import { pin, section, session, startService } from './service-harness.js';

/**
 * THE FREE ARM, AND THE GATE THAT WAITS FOR THE PAID ONE.
 *
 * The fallback contract lives in one word — `'defer'` — passed to `gate` by two composition
 * roots, and until this file existed not one test set it. `budgetedLlm(llm,
 * ledger)` defaults to `'stop'`, so every existing budget test proved the other
 * branch and the money branch shipped on the strength of the code reading
 * correctly.
 *
 * What `'defer'` has to be true about, in the order the calls happen:
 *
 *  1. an exhausted budget does not stop a call that the free tier can answer —
 *     the free tier is the learner's own and the kill switch guards the switch
 *     to money, not the switch to a model;
 *  2. the moment the ladder reaches for the paid key, the same
 *     `ModelBudgetStop` is thrown, with the same 402 shape the panel has always
 *     read, before anything paid is issued;
 *  3. the gate belongs to the call that armed it — not to the request, not to
 *     whichever of three concurrent calls reaches the paid arm first, and not
 *     to a budget that has since been reset;
 *  4. with nowhere to arm a gate at all, it stops everything. A kill switch is
 *     allowed exactly one failure direction.
 */

const NOW = '2026-08-19T03:00:00.000Z';
const clock = fixedClock(NOW);

const PREFS: LearnerPrefs = {
  targetMinutes: 15,
  interfaceLanguage: 'en',
  pausedUntil: null,
  excludedDomains: [],
  interview: {},
  rejectedOrigins: {},
};

const budgeted = (limit: number) =>
  ({ limit, unit: 'tokens', window: 'total', setAt: NOW } as const);

const spent = (tokens: number): ModelSpend => ({
  since: NOW,
  connections: {
    ...emptyModelSpend().connections,
    cloud: { calls: 1, inputTokens: tokens, outputTokens: 0, issuedNotReturned: 0 },
  },
});

class PrefsStore {
  constructor(public prefs: LearnerPrefs = PREFS) {}
  async getPrefs(): Promise<LearnerPrefs> { return this.prefs; }
  async putPrefs(prefs: LearnerPrefs): Promise<void> { this.prefs = prefs; }
}

const ledgerOver = (store: PrefsStore): ModelBudgetLedger =>
  new ModelBudgetLedger({ store, clock });

const req: LlmRequest = { tier: 'fast', system: 's', prompt: 'p' };

/**
 * The ladder, reduced to the only thing this file is about.
 *
 * The real `KeyLadderLlm` tries the free key, and on a 429 or a 503 calls
 * `beforePaid` and then the paid key. Which of those two rungs answers is
 * decided per call here, so a test can say "this one exhausted the free tier"
 * without owning a fake provider that returns provider-shaped errors.
 */
const ladder = (reachesPaid: (req: LlmRequest) => boolean): Llm & { paid: number; free: number } => {
  const llm = {
    paid: 0,
    free: 0,
    async complete(r: LlmRequest): Promise<LlmResult<string>> {
      if (!reachesPaid(r)) { llm.free++; return { value: 'free', modelId: 'free', inputTokens: 1, outputTokens: 1 }; }
      firePaidGateInScope();
      llm.paid++;
      return { value: 'paid', modelId: 'paid', inputTokens: 1, outputTokens: 1 };
    },
    async structured<T>(r: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> {
      if (!reachesPaid(r)) { llm.free++; return { value: {} as T, modelId: 'free', inputTokens: 1, outputTokens: 1 }; }
      firePaidGateInScope();
      llm.paid++;
      return { value: {} as T, modelId: 'paid', inputTokens: 1, outputTokens: 1 };
    },
  };
  return llm;
};

// ------------------------------------------------------- the free arm passes

test('an exhausted budget does not stop a call the free tier can answer', async () => {
  // The contract itself. Under `'stop'` this same call is a 402 before the model
  // is touched; the free tier is capacity the learner already has and a limit
  // on money must not spend it for them.
  const store = new PrefsStore({ ...PREFS, modelBudget: budgeted(1_000), modelSpend: spent(1_000) });
  const llm = ladder(() => false);
  const guarded = budgetedLlm(llm, ledgerOver(store), 'defer');

  const res = await withBudgetScope(() => guarded.complete(req));

  assert.equal(res.value, 'free');
  assert.equal(llm.free, 1);
  assert.equal(llm.paid, 0);
  assert.equal(budgetStopInScope(), null, 'nothing was stopped, so nothing may say it was');
});

test('the same call under the old behaviour is still refused before the model', async () => {
  // The control. `'defer'` is a per-connection composition choice and a
  // single-key deployment must keep today's exact behaviour.
  const store = new PrefsStore({ ...PREFS, modelBudget: budgeted(1_000), modelSpend: spent(1_000) });
  const llm = ladder(() => false);

  await assert.rejects(
    () => withBudgetScope(() => budgetedLlm(llm, ledgerOver(store), 'stop').complete(req)),
    ModelBudgetStop);
  assert.equal(llm.free, 0, 'the model was reached at all');
});

// ------------------------------------------------------- the paid arm stops

test('the gate fires at the paid switch, carrying the shape the 402 is built from', async () => {
  const store = new PrefsStore({ ...PREFS, modelBudget: budgeted(1_000), modelSpend: spent(1_500) });
  const llm = ladder(() => true);
  const guarded = budgetedLlm(llm, ledgerOver(store), 'defer');

  await assert.rejects(
    () => withBudgetScope(() => guarded.complete(req)),
    (err: unknown) => err instanceof ModelBudgetStop
      && err.connection === 'cloud'
      && err.state.status === 'exhausted'
      && err.state.used === 1_500
      && err.state.limit === 1_000,
    'the panel reads the connection and the state straight off this error');
  assert.equal(llm.paid, 0, 'the paid key was reached before the gate said no');
});

test('a stop fired inside the call is still visible on the request that answered', async () => {
  // `budgetStopInScope` is what puts `x-virgil-model-budget` on a reply whose
  // handler swallowed the failure and degraded. The gate now fires on a child
  // record belonging to one call, so a stop written only there would be a stop
  // the panel never hears about — the exact silence that header exists to end.
  const store = new PrefsStore({ ...PREFS, modelBudget: budgeted(1_000), modelSpend: spent(1_500) });
  const guarded = budgetedLlm(ladder(() => true), ledgerOver(store), 'defer');

  const seen = await withBudgetScope(async () => {
    await guarded.complete(req).catch(() => undefined);
    return budgetStopInScope();
  });

  assert.equal(seen, 'cloud');
});

// ------------------------------------------------- the gate belongs to a call

test('a budget that recovers mid-request does not eat the next call', async () => {
  /**
   * The regression. `gate` armed the scope when the budget stopped and never
   * cleared it when the budget did not — so on the request-wide record this ran
   * against, a gate armed by the first call was still sitting there for the
   * second. A learner who raised their limit or reset their window between two
   * calls of one request met a 402 quoting the spend from before they fixed it.
   */
  const store = new PrefsStore({ ...PREFS, modelBudget: budgeted(1_000), modelSpend: spent(1_500) });
  const llm = ladder(() => true);
  const guarded = budgetedLlm(llm, ledgerOver(store), 'defer');

  await withBudgetScope(async () => {
    await assert.rejects(() => guarded.complete(req), ModelBudgetStop);
    // The learner presses "reset the window" in another tab.
    store.prefs = { ...store.prefs, modelSpend: emptyModelSpend() };
    const res = await guarded.complete(req);
    assert.equal(res.value, 'paid', 'a gate armed before the reset stopped a call allowed after it');
  });
  assert.equal(llm.paid, 1);
});

test('one of three calls at once cannot fire a gate another one armed', async () => {
  /**
   * The second half of the same defect, and the one a per-call record is for.
   * Forage and verify issue three model calls concurrently inside a single
   * request scope. With the gate on the request, a call that gated cleanly
   * could reach the paid arm and throw a stop armed by a different call — a 402
   * about a connection and a spend that had nothing to do with the request the
   * learner was waiting on.
   *
   * Here the routes are exhausted only while the first call gates: the store's
   * spend is put back before the others read it, so exactly one call arms a
   * gate and all three reach the paid arm.
   */
  const store = new PrefsStore({ ...PREFS, modelBudget: budgeted(1_000), modelSpend: spent(1_500) });
  let reads = 0;
  store.getPrefs = async (): Promise<LearnerPrefs> => {
    reads++;
    // The first `gate` sees an exhausted window; every later read sees the
    // window the learner reset while these three were in flight.
    return reads === 1 ? store.prefs : { ...store.prefs, modelSpend: emptyModelSpend() };
  };
  const llm = ladder(() => true);
  const guarded = budgetedLlm(llm, ledgerOver(store), 'defer');

  const settled = await withBudgetScope(() => Promise.allSettled([
    guarded.complete(req), guarded.complete(req), guarded.complete(req),
  ]));

  const stopped = settled.filter((s) => s.status === 'rejected');
  assert.equal(stopped.length, 1, 'a gate armed by one call was fired by another');
  assert.ok(stopped[0]?.status === 'rejected' && stopped[0].reason instanceof ModelBudgetStop);
  assert.equal(llm.paid, 2, 'the two calls that gated cleanly were both allowed through');
});

// ------------------------------------------------------------- fail closed

test('with nowhere to arm a gate, the deferred switch stops everything', async () => {
  /**
   * The one failure direction a kill switch is allowed. Without a scope the
   * armed stop would evaporate and the paid arm would spend through an
   * exhausted budget in silence, so `'defer'` outside a scope is `'stop'`.
   */
  const store = new PrefsStore({ ...PREFS, modelBudget: budgeted(1_000), modelSpend: spent(1_500) });
  const llm = ladder(() => true);

  await assert.rejects(
    () => budgetedLlm(llm, ledgerOver(store), 'defer').complete(req), ModelBudgetStop);
  assert.equal(llm.free + llm.paid, 0, 'the model was reached with no gate anywhere');
});

// ------------------------------------------------------- the wiring, in situ

/**
 * The low-level deferred gate remains covered above, but the product's visible
 * Cloud/API limit is a hard stop across the whole cloud route. A free arm must
 * not make the UI say “stopping” while requests continue to move its ledger.
 * The fake below stands where the real key ladder stands inside `deps.llm`.
 */
const laddered = (reachesPaid: () => boolean): Llm => ({
  async complete(): Promise<LlmResult<string>> {
    if (reachesPaid()) firePaidGateInScope();
    return { value: 'answered', modelId: 'ladder', inputTokens: 1, outputTokens: 1 };
  },
  async structured<T>(): Promise<LlmResult<T>> {
    if (reachesPaid()) firePaidGateInScope();
    return { value: {} as T, modelId: 'ladder', inputTokens: 1, outputTokens: 1 };
  },
});

/** A board with a session on it: the cheapest route to a foreground model call. */
async function exhausted(tag: string, llm: Llm, freeArm: boolean) {
  const h = await startService(tag, { llm }, { models: { freeArm } });
  await h.store.putSession(session('s1', [section('A')]));
  await h.store.putPin(pin('p1', null));
  await h.call('PUT', '/model-budget', { limit: 1_000 });
  await h.store.putPrefs({ ...(await h.store.getPrefs()), modelSpend: spent(5_000) });
  return h;
}

const depth = (h: Awaited<ReturnType<typeof exhausted>>) =>
  h.call('POST', '/sessions/s1/sections/A/depth', { direction: 'deeper' });

test('freeArm on: the visible Cloud/API limit stops before the free tier', async (t) => {
  const h = await exhausted('free-arm-on', laddered(() => false), true);
  t.after(() => h.close());

  const res = await depth(h);
  assert.equal(res.status, 402);
  assert.equal(res.body.stoppedBy, 'model-budget');
  assert.equal(res.headers.get('x-virgil-model-budget'), 'stopped:cloud');
});

test('freeArm on: the paid arm still meets the same 402', async (t) => {
  const h = await exhausted('free-arm-paid', laddered(() => true), true);
  t.after(() => h.close());

  // Byte for byte the body `model-budget-endpoints.test.ts` asserts on the
  // `'stop'` path. A second refusal shape would be a second thing for the panel
  // to recognise.
  const res = await depth(h);
  assert.equal(res.status, 402);
  assert.equal(res.body.stoppedBy, 'model-budget');
  assert.equal(res.body.connection, 'cloud');
  assert.equal(res.body.state.status, 'exhausted');
  assert.equal(res.body.state.used, 5_000);
  assert.equal(res.body.state.limit, 1_000);
  assert.match(res.body.error, /budget stopped this before anything was sent/);
  assert.equal(res.headers.get('x-virgil-model-budget'), 'stopped:cloud');
});

test('freeArm off: the same free-tier call is refused before the model', async (t) => {
  // The discriminator. Same board, same budget, same model — only the flag
  // differs, so a `freeArm` that stopped reaching `gate` would show up here as
  // a 200 where the single-key deployment must still answer 402.
  const h = await exhausted('free-arm-off', laddered(() => false), false);
  t.after(() => h.close());

  const res = await depth(h);
  assert.equal(res.status, 402);
  assert.equal(res.body.stoppedBy, 'model-budget');
});
