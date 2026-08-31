import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LlmCredentialMissing, emptyModelSpend, fixedClock, modelBudgetState,
  type LearnerPrefs, type Llm, type LlmRequest, type LlmResult, type ModelSpend,
} from '@sb/core';
import { JsonStore } from '@sb/adapters';

import {
  ModelBudgetLedger, ModelBudgetStop, budgetedLlm, firePaidGateInScope, withBudgetScope,
} from '../model-budget.js';
import { ModelRouter } from '../model-routing.js';

/**
 * The kill switch, at the seam it actually sits on.
 *
 * The property under test throughout is *refused before the call is issued*,
 * and it is asserted with a model that throws on any use at all — because "we
 * stopped it" and "we called it and threw the answer away" look identical from
 * a test that only checks the error, and only one of them is free.
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

/** The two store methods the ledger uses, and nothing else it could reach. */
class PrefsStore {
  writes = 0;
  private mutations: Promise<unknown> = Promise.resolve();
  constructor(public prefs: LearnerPrefs = PREFS) {}
  async getPrefs(): Promise<LearnerPrefs> { return this.prefs; }
  async putPrefs(prefs: LearnerPrefs): Promise<void> { this.writes++; this.prefs = prefs; }
  async mutatePrefs(change: (current: LearnerPrefs) => LearnerPrefs): Promise<LearnerPrefs> {
    const next = this.mutations.then(async () => {
      const changed = change(this.prefs);
      this.writes++;
      this.prefs = changed;
      return changed;
    });
    this.mutations = next.then(() => undefined, () => undefined);
    return next;
  }
}

const ledgerOver = (store: PrefsStore, onWriteError?: (e: unknown) => void): ModelBudgetLedger =>
  new ModelBudgetLedger({ store, clock, ...(onWriteError ? { onWriteError } : {}) });

const req: LlmRequest = { tier: 'fast', system: 's', prompt: 'p' };

/** A model that reports what it was told to. */
const counting = (inputTokens: number, outputTokens: number): Llm => ({
  async complete(): Promise<LlmResult<string>> {
    return { value: 'ok', modelId: 'stub', inputTokens, outputTokens };
  },
  async structured<T>(): Promise<LlmResult<T>> {
    return { value: {} as T, modelId: 'stub', inputTokens, outputTokens };
  },
});

/** Being called is itself the failure. */
const forbidden = (): Llm & { calls: number } => {
  const llm = {
    calls: 0,
    async complete(): Promise<LlmResult<string>> {
      llm.calls++;
      throw new Error('the model was reached — the budget did not stop this before it was issued');
    },
    async structured<T>(): Promise<LlmResult<T>> {
      llm.calls++;
      throw new Error('the model was reached — the budget did not stop this before it was issued');
    },
  };
  return llm;
};

const spent = (connection: 'cloud' | 'local' | 'cli', tokens: number): ModelSpend => {
  const base = emptyModelSpend();
  return {
    since: NOW,
    connections: {
      ...base.connections,
      [connection]: { calls: 1, inputTokens: tokens, outputTokens: 0, issuedNotReturned: 0 },
    },
  };
};

const budgeted = (limit: number, setAt = NOW) =>
  ({ limit, unit: 'tokens', window: 'total', setAt } as const);

// -------------------------------------------------------------- setting it

test('a new limit opens a fresh window, because nothing was being measured before', async () => {
  const store = new PrefsStore({ ...PREFS, modelSpend: spent('cloud', 5_000) });
  const receipt = await ledgerOver(store).setLimit(10_000);

  assert.equal(receipt.state.status, 'ok');
  assert.equal(receipt.state.limit, 10_000);
  assert.equal(receipt.state.used, 0,
    'a first limit must not be charged against tokens spent while no limit existed');
  assert.equal(receipt.budget?.setAt, NOW);
  assert.equal(receipt.spend.since, NOW);
});

test('moving an existing limit leaves the window alone — raising it is not forgetting', async () => {
  const store = new PrefsStore();
  await ledgerOver(store).setLimit(1_000);
  store.prefs = { ...store.prefs, modelSpend: spent('cloud', 900) };

  const raised = await ledgerOver(store).setLimit(5_000);
  assert.equal(raised.state.used, 900, 'the record of what has been spent survived the raise');
  assert.equal(raised.state.limit, 5_000);
  assert.equal(raised.state.status, 'ok');
  assert.equal(raised.budget?.setAt, NOW, 'and it is still the same budget, not a new one');

  const lowered = await ledgerOver(store).setLimit(500);
  assert.equal(lowered.state.status, 'exhausted',
    'lowering a limit below what is already spent stops the connection immediately');
});

test('a limit outside the range this service will store is refused rather than kept', async () => {
  const ledger = ledgerOver(new PrefsStore());
  for (const bad of [0, -1, 2.5, Number.NaN, 10_000_000_000]) {
    await assert.rejects(() => ledger.setLimit(bad), RangeError, `${bad} was stored`);
  }
});

test('clearing the limit keeps the record of what was spent', async () => {
  const store = new PrefsStore({ ...PREFS, modelSpend: spent('cloud', 7_000) });
  await ledgerOver(store).setLimit(10_000);
  store.prefs = { ...store.prefs, modelSpend: spent('cloud', 7_000) };

  const cleared = await ledgerOver(store).clear();
  assert.equal(cleared.budget, null);
  assert.equal(cleared.state.status, 'off');
  assert.equal(cleared.state.used, 7_000, 'turning a limit off is not asking to forget the bill');
});

test('the deployment ceiling survives a learner clear and cannot be raised', async () => {
  const store = new PrefsStore({ ...PREFS, modelSpend: spent('cloud', 100) });
  const ledger = new ModelBudgetLedger({ store, clock, operatorLimit: 100 });

  await assert.rejects(() => ledger.setLimit(101), /cannot exceed/);
  const cleared = await ledger.clear();
  assert.equal(cleared.learnerBudget, null);
  assert.equal(cleared.operatorLimit, 100);
  assert.equal(cleared.state.limit, 100);
  assert.equal(cleared.state.status, 'exhausted');
  const llm = forbidden();
  await assert.rejects(() => budgetedLlm(llm, ledger).complete(req), ModelBudgetStop);
  assert.equal(llm.calls, 0, 'clearing learner settings bypassed the operator ceiling');
});

test('separate ledgers admit only one cloud call against the same remaining budget', async () => {
  const store = new PrefsStore({
    ...PREFS, modelBudget: budgeted(100), modelSpend: spent('cloud', 90),
  });
  let calls = 0;
  const model: Llm = {
    async complete(): Promise<LlmResult<string>> {
      calls++;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      return { value: 'ok', modelId: 'stub', inputTokens: 20, outputTokens: 0 };
    },
    async structured<T>(): Promise<LlmResult<T>> {
      throw new Error('not used');
    },
  };
  // These are deliberately different ledger instances: that is the same
  // topology as the hosted service and hosted job over one board.
  const first = budgetedLlm(model, ledgerOver(store)).complete(req);
  const second = budgetedLlm(model, ledgerOver(store)).complete(req);
  const settled = await Promise.allSettled([first, second]);

  assert.equal(calls, 1, 'both calls crossed the gate before either spend write landed');
  assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = settled.find((result) => result.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected' && rejected.reason instanceof ModelBudgetStop);
  assert.equal((await ledgerOver(store).receipt()).state.used, 110,
    'the returned call is counted before the waiting call gates again');
  assert.equal(store.prefs.modelBudgetLease ?? null, null, 'the admission lease was released');
});

test('a reset zeroes the window and keeps the limit', async () => {
  const store = new PrefsStore({ ...PREFS, modelBudget: budgeted(1_000), modelSpend: spent('cloud', 1_000) });
  const ledger = ledgerOver(store);
  assert.equal((await ledger.receipt()).state.status, 'exhausted');

  const after = await ledger.reset();
  assert.equal(after.state.status, 'ok');
  assert.equal(after.state.used, 0);
  assert.equal(after.state.limit, 1_000, 'the limit is still in force — this is a new window, not no budget');
  assert.equal(after.spend.since, NOW);
});

test('a reset leaves the ledgers the limit was never measured against', async () => {
  /*
   * Reported live: "Start a new window" zeroed Local's 14 calls and 7,100
   * tokens alongside Cloud/API's, on a page that had just finished explaining
   * that the limit guards Cloud/API alone. No confirmation, no undo, and no
   * sentence anywhere offering to touch it.
   */
  const store = new PrefsStore({
    ...PREFS,
    modelBudget: budgeted(1_000),
    modelSpend: {
      since: NOW,
      connections: {
        cloud: { calls: 9, inputTokens: 312, outputTokens: 0, issuedNotReturned: 0 },
        local: { calls: 14, inputTokens: 5_200, outputTokens: 1_900, issuedNotReturned: 0 },
        cli: { calls: 2, inputTokens: 40, outputTokens: 10, issuedNotReturned: 0 },
      },
    },
  });

  const after = await ledgerOver(store).reset();

  assert.equal(after.state.used, 0, 'the count the limit stops is the count that starts again');
  assert.equal(after.spend.connections.cloud.calls, 0);
  assert.deepEqual(after.spend.connections.local,
    { calls: 14, inputTokens: 5_200, outputTokens: 1_900, issuedNotReturned: 0 });
  assert.deepEqual(after.spend.connections.cli,
    { calls: 2, inputTokens: 40, outputTokens: 10, issuedNotReturned: 0 });
  assert.equal(after.totalTokens, 7_150, 'what the free connections did is still on the receipt');
});

test('a first limit opens its window without wiping the free connections either', async () => {
  const store = new PrefsStore({
    ...PREFS,
    modelSpend: {
      since: NOW,
      connections: {
        cloud: { calls: 9, inputTokens: 5_000, outputTokens: 0, issuedNotReturned: 0 },
        local: { calls: 14, inputTokens: 5_200, outputTokens: 1_900, issuedNotReturned: 0 },
        cli: { calls: 0, inputTokens: 0, outputTokens: 0, issuedNotReturned: 0 },
      },
    },
  });

  const after = await ledgerOver(store).setLimit(1_000);

  assert.equal(after.state.used, 0,
    'a first limit is not a bill for tokens spent while no limit existed');
  assert.equal(after.spend.connections.local.inputTokens, 5_200,
    'and it is not a reason to forget what the free connection did');
});

test('the receipt says in words what the numbers are not', async () => {
  const receipt = await ledgerOver(new PrefsStore()).receipt();
  assert.equal(receipt.state.status, 'off');
  assert.ok(receipt.notes.some((n) => /tokens, not money/i.test(n)),
    'a surface reading this must not be able to render it as currency by accident');
  assert.ok(receipt.notes.some((n) => /Local and Agent CLI/.test(n)));
  assert.ok(receipt.notes.some((n) => /floor/.test(n)));
  assert.ok(
    receipt.notes.some((n) => /new window.*Cloud\/API count back to zero/is.test(n)
      && /left exactly as they are/i.test(n)),
    'the button says what it clears before it is pressed, not after',
  );
});

// ------------------------------------------------------------ the kill switch

test('a spent budget refuses the call before the model is touched at all', async () => {
  const store = new PrefsStore({
    ...PREFS, modelBudget: budgeted(1_000), modelSpend: spent('cloud', 1_000),
  });
  const llm = forbidden();
  const guarded = budgetedLlm(llm, ledgerOver(store));

  await assert.rejects(() => guarded.complete(req), ModelBudgetStop);
  await assert.rejects(() => guarded.structured({ ...req, schema: {} }), ModelBudgetStop);
  assert.equal(llm.calls, 0, 'the whole point: nothing was issued, so nothing was billed');
});

test('the refusal says which connection stopped and what the numbers were', async () => {
  const store = new PrefsStore({
    ...PREFS, modelBudget: budgeted(1_000), modelSpend: spent('cloud', 1_200),
  });
  const guarded = budgetedLlm(forbidden(), ledgerOver(store));

  await assert.rejects(() => guarded.complete(req), (err: unknown) => {
    assert.ok(err instanceof ModelBudgetStop);
    assert.equal(err.connection, 'cloud');
    assert.equal(err.state.status, 'exhausted');
    assert.equal(err.state.used, 1_200);
    assert.equal(err.state.limit, 1_000);
    assert.match(err.message, /budget stopped this before anything was sent/);
    assert.match(err.message, /1,200 of 1,000 tokens/, 'the sentence carries its own evidence');
    return true;
  });
});

test('a spent CLOUD budget does not stop a call routed to a local model', async () => {
  // The design decision, enforced. Ollama costs nothing, so a spend limit that
  // killed it would take away the free option at the moment the paid one ran
  // out — which is the opposite of what somebody setting a limit wants.
  const store = new PrefsStore({
    ...PREFS,
    modelBudget: budgeted(1_000),
    modelSpend: spent('cloud', 5_000),
    modelProviders: { cloud: false, local: true, cli: false },
    modelRoutes: { quick: 'local', deep: 'local', images: 'local' },
  });
  const guarded = budgetedLlm(counting(40, 10), ledgerOver(store));

  const res = await guarded.complete(req);
  assert.equal(res.value, 'ok');
  assert.equal(store.prefs.modelSpend?.connections.local.calls, 1, 'and it was still counted');
  assert.equal(store.prefs.modelSpend?.connections.local.inputTokens, 40);
  assert.equal(store.prefs.modelSpend?.connections.cloud.inputTokens, 5_000,
    'the cloud window was not touched by a local call');
});

test('the same is true of the operator’s own CLI bridge', async () => {
  const store = new PrefsStore({
    ...PREFS,
    modelBudget: budgeted(1_000),
    modelSpend: spent('cloud', 5_000),
    modelProviders: { cloud: false, local: false, cli: true },
    modelRoutes: { quick: 'cli', deep: 'cli', images: 'cli' },
  });
  const guarded = budgetedLlm(counting(1, 1), ledgerOver(store));

  await guarded.complete(req);
  assert.equal(store.prefs.modelSpend?.connections.cli.calls, 1);
});

test('a call under the limit goes through, and takes the window with it', async () => {
  const store = new PrefsStore({ ...PREFS, modelBudget: budgeted(1_000) });
  const guarded = budgetedLlm(counting(300, 200), ledgerOver(store));

  await guarded.complete(req);
  const first = modelBudgetState(store.prefs.modelBudget ?? null, store.prefs.modelSpend ?? emptyModelSpend());
  assert.equal(first.used, 500);
  assert.equal(first.status, 'ok');

  await guarded.complete(req);
  const second = modelBudgetState(store.prefs.modelBudget ?? null, store.prefs.modelSpend ?? emptyModelSpend());
  assert.equal(second.used, 1_000);
  assert.equal(second.status, 'exhausted', 'the call that reaches the limit is allowed; the next one is not');

  // And the next one is refused, without a model behind it to answer.
  await assert.rejects(() => budgetedLlm(forbidden(), ledgerOver(store)).complete(req), ModelBudgetStop);
});

test('the warning is a flag and nothing else — the call still runs', async () => {
  const store = new PrefsStore({ ...PREFS, modelBudget: budgeted(1_000) });
  const ledger = ledgerOver(store);
  await budgetedLlm(counting(800, 0), ledger).complete(req);

  const receipt = await ledger.receipt();
  assert.equal(receipt.state.status, 'warning');
  await budgetedLlm(counting(1, 0), ledger).complete(req);
  assert.equal((await ledger.receipt()).state.used, 801, 'nothing was throttled or downgraded');
});

test('a call that was issued and did not come back is counted, not treated as free', async () => {
  const store = new PrefsStore({ ...PREFS, modelBudget: budgeted(1_000) });
  const broken: Llm = {
    complete: async () => { throw new Error('503'); },
    structured: async <T>(): Promise<LlmResult<T>> => { throw new Error('503'); },
  };
  await assert.rejects(() => budgetedLlm(broken, ledgerOver(store)).complete(req), /503/);

  assert.equal(store.prefs.modelSpend?.connections.cloud.issuedNotReturned, 1);
  assert.equal(store.prefs.modelSpend?.connections.cloud.calls, 0);
  assert.equal(store.prefs.modelSpend?.connections.cloud.inputTokens, 0,
    'no token count was invented for a request the provider never described');
});

test('a budget refusal is NOT recorded as an issued request', async () => {
  // The distinction the whole ordering exists to protect. The quota-accounting contract reads
  // `issuedNotReturned` as "presumed billed", and a stop that charged the
  // learner for the call it prevented would be worse than no stop at all.
  const store = new PrefsStore({
    ...PREFS, modelBudget: budgeted(1_000), modelSpend: spent('cloud', 1_000),
  });
  const before = store.writes;
  await assert.rejects(() => budgetedLlm(forbidden(), ledgerOver(store)).complete(req), ModelBudgetStop);

  assert.equal(store.prefs.modelSpend?.connections.cloud.issuedNotReturned, 0);
  assert.equal(store.writes, before, 'a refusal writes nothing at all');
});

test('a refusal thrown from INSIDE the call is not recorded as an issued request either', async () => {
  const store = new PrefsStore({ ...PREFS, modelBudget: budgeted(1_000) });
  const refusing: Llm = {
    complete: async () => { throw new LlmCredentialMissing('cloud', 'no key saved'); },
    structured: async <T>(): Promise<LlmResult<T>> => {
      throw new LlmCredentialMissing('cloud', 'no key saved');
    },
  };
  const guarded = budgetedLlm(refusing, ledgerOver(store));

  await assert.rejects(() => guarded.complete(req), LlmCredentialMissing);
  await assert.rejects(() => guarded.structured({ ...req, schema: {} }), LlmCredentialMissing);

  assert.equal(store.prefs.modelSpend, undefined,
    'a call that was never built was charged to the connection it would have run on');
  assert.equal(store.prefs.modelBudgetLease ?? null, null,
    'coordination around the attempted call did not leave a live lease behind');
});

test('a deferred stop fired by the paid arm is a refusal, not a lost request', async () => {
  // The same rule, for the refusal this file's own kill switch throws from
  // inside the call rather than in front of it.
  const store = new PrefsStore({
    ...PREFS, modelBudget: budgeted(1_000), modelSpend: spent('cloud', 1_000),
  });
  const ladder: Llm = {
    complete: async () => { firePaidGateInScope(); throw new Error('unreachable'); },
    structured: async <T>(): Promise<LlmResult<T>> => {
      firePaidGateInScope();
      throw new Error('unreachable');
    },
  };
  const guarded = budgetedLlm(ladder, ledgerOver(store), 'defer');
  const before = store.writes;

  await assert.rejects(() => withBudgetScope(() => guarded.complete(req)), ModelBudgetStop);

  assert.equal(store.prefs.modelSpend?.connections.cloud.issuedNotReturned, 0);
  assert.equal(store.writes, before);
});

test('a request whose connection cannot be resolved is neither stopped nor charged', async () => {
  // The routes point at a provider that is switched off. The router throws on
  // exactly this input before issuing anything, so nothing is spent and there
  // is nothing to charge — and a budget must not turn that into its own error.
  const store = new PrefsStore({
    ...PREFS,
    modelBudget: budgeted(1),
    modelSpend: spent('cloud', 10_000),
    modelProviders: { cloud: false, local: true, cli: false },
    modelRoutes: { quick: 'cloud', deep: 'cloud', images: 'cloud' },
  });
  const ledger = ledgerOver(store);
  assert.equal(await ledger.connectionFor(req), null);

  const res = await budgetedLlm(counting(5, 5), ledger).complete(req);
  assert.equal(res.value, 'ok');
  assert.equal(store.prefs.modelSpend?.connections.cloud.inputTokens, 10_000, 'nothing was charged');
});

test('a bookkeeping write that fails is reported, not thrown at the learner', async () => {
  // The call has already happened and the answer is already paid for. Throwing
  // would discard a result somebody was charged for in order to complain about
  // a write.
  const store = new PrefsStore({ ...PREFS, modelBudget: budgeted(1_000) });
  const mutate = store.mutatePrefs.bind(store);
  store.mutatePrefs = async (change) => {
    const before = store.prefs;
    const after = change(before);
    if (after.modelSpend !== before.modelSpend) throw new Error('disk is gone');
    return mutate(() => after);
  };
  const seen: unknown[] = [];

  const res = await budgetedLlm(counting(10, 10), ledgerOver(store, (e) => seen.push(e))).complete(req);
  assert.equal(res.value, 'ok', 'the answer still reached the caller');
  assert.equal(seen.length, 1);
  assert.match(String(seen[0]), /disk is gone/);
});

test('two calls at once cannot lose one of their counts', async () => {
  // Read-modify-write on one document. Without the queue, the second read sees
  // the state before the first write and the budget silently undercounts.
  const store = new PrefsStore({ ...PREFS, modelBudget: budgeted(10_000) });
  const guarded = budgetedLlm(counting(100, 0), ledgerOver(store));

  await Promise.all(Array.from({ length: 8 }, () => guarded.complete(req)));
  assert.equal(store.prefs.modelSpend?.connections.cloud.calls, 8);
  assert.equal(store.prefs.modelSpend?.connections.cloud.inputTokens, 800);
});

test('a route change after admission cannot turn an allowed Local call into a paid Cloud call', async () => {
  const exhausted = spent('cloud', 1_000);
  const store = new PrefsStore({
    ...PREFS, modelMode: 'cloud', modelBudget: budgeted(1_000), modelSpend: exhausted,
  });
  const localView: LearnerPrefs = {
    ...store.prefs, modelMode: 'local',
  };
  let reads = 0;
  store.getPrefs = async () => ++reads <= 3 ? localView : store.prefs;
  const calls: string[] = [];
  const named = (mode: string): Llm => ({
    complete: async () => {
      calls.push(mode);
      return { value: mode, modelId: mode, inputTokens: 5, outputTokens: 5 };
    },
    structured: async <T>() => {
      calls.push(mode);
      return { value: {} as T, modelId: mode, inputTokens: 5, outputTokens: 5 };
    },
  });
  const router = new ModelRouter({
    store,
    providers: {
      cloud: named('cloud'), local: () => named('local'), cli: () => named('cli'),
    },
  });

  const result = await budgetedLlm(router, ledgerOver(store)).complete(req);

  assert.equal(result.value, 'local');
  assert.deepEqual(calls, ['local'], 'the router re-read a changed paid route after the gate');
  assert.equal(store.prefs.modelSpend?.connections.local.calls, 1);
  assert.equal(store.prefs.modelSpend?.connections.cloud.calls, 1);
});

// ------------------------------------------------------------- across a boot

test('the limit and the window survive the process that set them', async () => {
  // A budget a learner can clear by restarting the service is not a budget.
  // This is why the ledger keeps no running total of its own.
  const path = join(mkdtempSync(join(tmpdir(), 'sb-budget-')), 'db.json');
  const first = new ModelBudgetLedger({ store: new JsonStore(path), clock });
  await first.setLimit(1_000);
  await budgetedLlm(counting(400, 100), first).complete(req);

  const second = new ModelBudgetLedger({ store: new JsonStore(path), clock });
  const receipt = await second.receipt();
  assert.equal(receipt.state.limit, 1_000);
  assert.equal(receipt.state.used, 500);
  assert.equal(receipt.state.status, 'ok');
  assert.equal(receipt.spend.connections.cloud.calls, 1);
  assert.equal(receipt.totalTokens, 500);

  await budgetedLlm(counting(500, 0), second).complete(req);
  const third = new ModelBudgetLedger({ store: new JsonStore(path), clock });
  assert.equal((await third.receipt()).state.status, 'exhausted');
  await assert.rejects(
    () => budgetedLlm(forbidden(), third).complete(req), ModelBudgetStop,
    'and the switch is still thrown in a process that never saw the calls that spent it');
});
