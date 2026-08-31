import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  MAX_BUDGET_TOKENS, emptyModelSpend,
  type Llm, type LlmRequest, type LlmResult, type ModelMode, type ModelSpend,
} from '@sb/core';

import {
  NOW, StubLlm, noLlm, type Harness, pin, section, session, startService, topic,
} from './service-harness.js';

/**
 * The learner-facing spend limit, over HTTP.
 *
 * The budget is a setter, display, and controller, including a kill switch at
 * the configured limit. This file is the contract the panel will
 * be built against: four routes, one receipt shape, and one refusal that says
 * what it is rather than looking like a broken model.
 *
 * The unit is tokens throughout and the receipt says so in three places. This
 * build carries no price table anywhere — `usage.ts` says the cost model is
 * built from token counts "and published per-token prices", and the prices half
 * has never existed in code — so a currency figure here would be a number the
 * service invented about somebody's money.
 */

/** A model that answers like the stub and reports tokens like a real provider. */
const counting = (inputTokens: number, outputTokens: number): Llm => {
  const stub = new StubLlm();
  return {
    async complete(req: LlmRequest): Promise<LlmResult<string>> {
      return { ...(await stub.complete(req)), inputTokens, outputTokens };
    },
    async structured<T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> {
      return { ...(await stub.structured<T>(req)), inputTokens, outputTokens };
    },
  };
};

const FREE_CLI_TOKEN = 'virgil-test-cli-token-long-enough';

/** One harmless endpoint that makes both free readiness probes authoritative. */
async function readyFreeEndpoint(t: { after(fn: () => void | Promise<void>): void }): Promise<string> {
  const server = createServer((req, res) => {
    const accepted = req.url === '/api/tags'
      || (req.url === '/health' && req.headers.authorization === `Bearer ${FREE_CLI_TOKEN}`);
    res.statusCode = accepted ? 200 : 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(accepted ? { ok: true } : { error: 'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A board with a session on it, which is the cheapest route to a model call. */
async function withSession(tag: string, over = {}): Promise<Harness> {
  const h = await startService(tag, over);
  await h.store.putSession(session('s1', [section('A'), section('B')]));
  return h;
}

/** Put a connection's window where the test needs it, without spending it. */
async function seedSpend(h: Harness, connection: ModelMode, tokens: number): Promise<void> {
  const base = emptyModelSpend();
  const spend: ModelSpend = {
    since: NOW,
    connections: {
      ...base.connections,
      [connection]: { calls: 1, inputTokens: tokens, outputTokens: 0, issuedNotReturned: 0 },
    },
  };
  await h.store.putPrefs({ ...(await h.store.getPrefs()), modelSpend: spend });
}

const routeEverythingTo = async (h: Harness, mode: ModelMode): Promise<void> => {
  await h.store.putPrefs({
    ...(await h.store.getPrefs()),
    modelProviders: { cloud: mode === 'cloud', local: mode === 'local', cli: mode === 'cli' },
    modelRoutes: { quick: mode, deep: mode, images: mode },
  });
};

const depth = (h: Harness) => h.call('POST', '/sessions/s1/sections/A/depth', { direction: 'simpler' });

// ------------------------------------------------------------------- reading

test('a board with no limit says so, and still says what has been spent', async (t) => {
  const h = await startService('budget-empty');
  t.after(() => h.close());

  const res = await h.call('GET', '/model-budget');
  assert.equal(res.status, 200);
  assert.equal(res.body.budget, null);
  assert.equal(res.body.state.status, 'off');
  assert.equal(res.body.state.limit, null);
  assert.equal(res.body.state.used, 0);
  assert.equal(res.body.state.unit, 'tokens', 'the unit is on the wire, not assumed by the client');
  assert.equal(res.body.state.window, 'total');
  assert.equal(res.body.state.warnAtFraction, 0.8);
  assert.deepEqual(res.body.state.guards, ['cloud']);
  assert.deepEqual(res.body.spend, emptyModelSpend());
  assert.equal(res.body.totalTokens, 0);
  assert.ok(res.body.notes.length >= 4, 'the receipt carries its own limitations');
});

test('the display shows all three connections, so a learner can see what actually ran', async (t) => {
  const h = await startService('budget-display');
  t.after(() => h.close());
  await seedSpend(h, 'local', 12_000);

  const res = await h.call('GET', '/model-budget');
  assert.equal(res.body.spend.connections.local.inputTokens, 12_000);
  assert.equal(res.body.totalTokens, 12_000);
  assert.equal(res.body.state.used, 0,
    'a local model costs nothing, so it spends nothing — but it is not hidden');
});

// ------------------------------------------------------------------- setting

test('setting a limit answers with the same receipt the display reads', async (t) => {
  const h = await startService('budget-set');
  t.after(() => h.close());

  const put = await h.call('PUT', '/model-budget', { limit: 50_000 });
  assert.equal(put.status, 200);
  assert.equal(put.body.budget.limit, 50_000);
  assert.equal(put.body.budget.unit, 'tokens');
  assert.equal(put.body.budget.window, 'total');
  assert.equal(put.body.budget.setAt, NOW);
  assert.equal(put.body.state.status, 'ok');
  assert.equal(put.body.state.remaining, 50_000);

  const got = await h.call('GET', '/model-budget');
  assert.deepEqual(got.body, put.body, 'a client that sets does not have to ask again');
  assert.equal((await h.store.getPrefs()).modelBudget?.limit, 50_000, 'and it is on the board');
});

test('the unit may be stated and may not be changed', async (t) => {
  const h = await startService('budget-unit');
  t.after(() => h.close());

  assert.equal((await h.call('PUT', '/model-budget', { limit: 10, unit: 'tokens' })).status, 200);

  const money = await h.call('PUT', '/model-budget', { limit: 10, unit: 'usd' });
  assert.equal(money.status, 400);
  assert.equal(money.body.error, 'unit must be one of: tokens');
  assert.equal((await h.store.getPrefs()).modelBudget?.limit, 10, 'and the old limit is untouched');
});

test('a limit that is not a limit is a 400 that names the field', async (t) => {
  const h = await startService('budget-bad-limit', { llm: noLlm() });
  t.after(() => h.close());

  for (const body of [
    {}, { limit: null }, { limit: 0 }, { limit: -5 }, { limit: 1.5 }, { limit: '1000' },
    { limit: MAX_BUDGET_TOKENS + 1 }, { limit: [] }, { limit: Number.MAX_SAFE_INTEGER },
  ]) {
    const res = await h.call('PUT', '/model-budget', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.body.error, /^limit must be a whole number of tokens between 1 and 1000000000$/);
  }
  assert.equal((await h.store.getPrefs()).modelBudget, undefined, 'and nothing was stored');
});

test('a field this endpoint does not have is named rather than ignored', async (t) => {
  // A client asking for `window: 'monthly'` is asking for something this build
  // does not do. Storing the limit and dropping the rest would be a budget that
  // quietly means something other than what was asked for.
  const h = await startService('budget-extra-field');
  t.after(() => h.close());

  const res = await h.call('PUT', '/model-budget', { limit: 100, window: 'monthly' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /^body must contain only limit and unit; window is not a field here$/);
});

test('raising a limit does not erase the record of what has been spent', async (t) => {
  const h = await startService('budget-raise');
  t.after(() => h.close());

  await h.call('PUT', '/model-budget', { limit: 1_000 });
  await seedSpend(h, 'cloud', 900);

  const raised = await h.call('PUT', '/model-budget', { limit: 10_000 });
  assert.equal(raised.body.state.used, 900);
  assert.equal(raised.body.state.status, 'ok');
  assert.equal(raised.body.budget.setAt, NOW, 'still the same budget, moved');
});

test('clearing the limit turns the switch off and keeps the count', async (t) => {
  const h = await startService('budget-clear');
  t.after(() => h.close());

  await h.call('PUT', '/model-budget', { limit: 1_000 });
  await seedSpend(h, 'cloud', 2_000);

  const cleared = await h.call('DELETE', '/model-budget');
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.budget, null);
  assert.equal(cleared.body.state.status, 'off');
  assert.equal(cleared.body.state.used, 2_000);
  assert.equal((await h.store.getPrefs()).modelBudget, null);
});

test('a reset opens a new window and leaves the limit standing', async (t) => {
  const h = await startService('budget-reset');
  t.after(() => h.close());

  await h.call('PUT', '/model-budget', { limit: 1_000 });
  await seedSpend(h, 'cloud', 1_000);
  assert.equal((await h.call('GET', '/model-budget')).body.state.status, 'exhausted');

  const reset = await h.call('POST', '/model-budget/reset');
  assert.equal(reset.status, 200);
  assert.equal(reset.body.state.status, 'ok');
  assert.equal(reset.body.state.used, 0);
  assert.equal(reset.body.state.limit, 1_000);
  assert.equal(reset.body.spend.since, NOW);
});

// ------------------------------------------------------------- the recording

test('what the learner presses is charged to the connection it ran on', async (t) => {
  const h = await withSession('budget-counts', { llm: counting(310, 24) });
  t.after(() => h.close());
  await h.call('PUT', '/model-budget', { limit: 10_000 });

  assert.equal((await depth(h)).status, 200);

  const res = await h.call('GET', '/model-budget');
  assert.equal(res.body.state.used, 334);
  assert.equal(res.body.spend.connections.cloud.calls, 1);
  assert.equal(res.body.spend.connections.cloud.inputTokens, 310);
  assert.equal(res.body.spend.connections.cloud.outputTokens, 24);
  assert.equal(res.body.spend.connections.local.calls, 0);
});

test('the warning is raised at four fifths and nothing slows down', async (t) => {
  const h = await withSession('budget-warning', { llm: counting(800, 0) });
  t.after(() => h.close());
  await h.call('PUT', '/model-budget', { limit: 1_000 });

  assert.equal((await depth(h)).status, 200);
  const warned = await h.call('GET', '/model-budget');
  assert.equal(warned.body.state.status, 'warning');
  assert.equal(warned.body.state.fraction, 0.8);
  assert.equal(warned.body.state.remaining, 200);

  const next = await h.call('POST', '/sessions/s1/sections/B/depth', { direction: 'deeper' });
  assert.equal(next.status, 200, 'a warning is a flag, not a throttle');
});

// ---------------------------------------------------------- the kill switch

test('a spent budget stops the call and says it was the budget that did it', async (t) => {
  // `noLlm` is the assertion: any model call at all on this path throws, so a
  // 402 rather than a 500 is proof the refusal happened first.
  const h = await withSession('budget-stops', { llm: noLlm() });
  t.after(() => h.close());
  await h.call('PUT', '/model-budget', { limit: 1_000 });
  await seedSpend(h, 'cloud', 1_000);

  const res = await depth(h);
  assert.equal(res.status, 402, 'the one status in this service that means "raise the limit"');
  assert.equal(res.body.stoppedBy, 'model-budget');
  assert.equal(res.body.connection, 'cloud');
  assert.equal(res.body.state.status, 'exhausted');
  assert.equal(res.body.state.used, 1_000);
  assert.equal(res.body.state.limit, 1_000);
  assert.match(res.body.error, /budget stopped this before anything was sent/);
  assert.deepEqual(res.body.freeConnections.map((row: any) => ({
    connection: row.connection, enabled: row.enabled,
  })), [
    { connection: 'local', enabled: false },
    { connection: 'cli', enabled: false },
  ]);
  for (const row of res.body.freeConnections) {
    assert.ok(['ready', 'needs-setup', 'unreachable', 'not-checked'].includes(row.readiness),
      'readiness is live environment state, but it is always one bounded value');
  }
  assert.equal(res.headers.get('x-virgil-model-budget'), 'stopped:cloud');
});

test('a spent budget names ready free connections without turning either one on', async (t) => {
  const endpoint = await readyFreeEndpoint(t);
  const h = await startService('budget-free-ready', { llm: noLlm() }, {
    models: {
      localEndpoint: endpoint,
      cliEndpoint: endpoint,
      cliToken: FREE_CLI_TOKEN,
    },
  });
  t.after(() => h.close());
  await h.store.putSession(session('s1', [section('A'), section('B')]));
  await h.store.putPrefs({
    ...(await h.store.getPrefs()),
    modelProviders: { cloud: true, local: true, cli: false },
    modelRoutes: { quick: 'cloud', deep: 'cloud', images: 'cloud' },
  });
  await h.call('PUT', '/model-budget', { limit: 1_000 });
  await seedSpend(h, 'cloud', 1_000);

  const res = await depth(h);
  assert.equal(res.status, 402);
  assert.deepEqual(res.body.freeConnections, [
    { connection: 'local', enabled: true, readiness: 'ready' },
    { connection: 'cli', enabled: false, readiness: 'ready' },
  ]);
  assert.deepEqual((await h.call('GET', '/model-config')).body.routes,
    { quick: 'cloud', deep: 'cloud', images: 'cloud' }, 'the refusal rerouted work');
});

test('a stopped call leaves the board exactly as it was', async (t) => {
  const h = await withSession('budget-stops-writes-nothing', { llm: noLlm() });
  t.after(() => h.close());
  await h.call('PUT', '/model-budget', { limit: 1_000 });
  await seedSpend(h, 'cloud', 1_000);

  const signals = (await h.store.listSignals()).length;
  await depth(h);

  assert.equal((await h.store.listSignals()).length, signals,
    'a budget is not evidence about what somebody understands');
  assert.equal((await h.store.getSession('s1'))?.sections[0]?.depth, 'building',
    'and the section was not rewritten by a call that never happened');
});

test('a stopped call is not counted as a call that was issued', async (t) => {
  // The wrapper order, asserted from outside. `issuedNotReturned` means
  // "presumed billed" under the quota-accounting contract, and a refusal that charged the learner
  // for the call it prevented would be worse than no refusal.
  const h = await withSession('budget-stop-not-metered', { llm: noLlm() });
  t.after(() => h.close());
  await h.call('PUT', '/model-budget', { limit: 500 });
  await seedSpend(h, 'cloud', 500);

  await depth(h);

  const usage = await h.call('GET', '/usage');
  assert.deepEqual(usage.body.llm.totals, { calls: 0, inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(usage.body.llm.rows, [], 'nothing was issued, so nothing is in the meter');
  const budget = await h.call('GET', '/model-budget');
  assert.equal(budget.body.spend.connections.cloud.issuedNotReturned, 0);
});

test('an endpoint that degrades instead of failing still says the budget did it', async (t) => {
  /**
   * The honest-copy case. Capturing a pin catches a model failure on purpose
   * and falls back to a plain label, because losing somebody's capture over a
   * provider outage would be worse. That is the right behaviour and the wrong
   * SENTENCE for a budget stop — "the model failed" sends somebody to check an
   * API key over a limit they set themselves — so the reply carries the flag
   * even though the body is a normal 201.
   */
  const h = await startService('budget-degraded', { llm: noLlm() });
  t.after(() => h.close());
  await h.call('PUT', '/model-budget', { limit: 100 });
  await seedSpend(h, 'cloud', 100);

  const res = await h.call('POST', '/pins', {
    type: 'interest', envelope: pin('unused', null).envelope, note: null,
  });
  assert.equal(res.status, 201, 'the capture was not lost');
  assert.equal(res.headers.get('x-virgil-model-budget'), 'stopped:cloud',
    'and the panel can say which of the two things happened');
  assert.equal(
    res.headers.get('access-control-expose-headers'), 'x-virgil-model-budget',
    'named in CORS, or a browser strips it and the panel reads nothing');
});

test('an ordinary reply carries no budget flag at all', async (t) => {
  const h = await withSession('budget-quiet', { llm: counting(10, 10) });
  t.after(() => h.close());
  await h.call('PUT', '/model-budget', { limit: 10_000 });

  const res = await depth(h);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-virgil-model-budget'), null);
});

test('the switch guards the paid connection and never the free ones', async (t) => {
  const h = await withSession('budget-local-unaffected', { llm: counting(5_000, 5_000) });
  t.after(() => h.close());
  await h.call('PUT', '/model-budget', { limit: 1_000 });
  await seedSpend(h, 'cloud', 100_000);
  await routeEverythingTo(h, 'local');

  const res = await depth(h);
  assert.equal(res.status, 200, 'Ollama costs no money and must not be killed by a spend limit');

  const budget = await h.call('GET', '/model-budget');
  assert.equal(budget.body.state.status, 'exhausted', 'the cloud window is still spent');
  assert.equal(budget.body.spend.connections.local.calls, 1, 'and the local call is on the display');
  assert.equal(budget.body.totalTokens, 110_000);
});

test('raising the limit is what starts the work again', async (t) => {
  const h = await withSession('budget-raise-resumes', { llm: counting(10, 0) });
  t.after(() => h.close());
  await h.call('PUT', '/model-budget', { limit: 1_000 });
  await seedSpend(h, 'cloud', 1_000);
  assert.equal((await depth(h)).status, 402);

  await h.call('PUT', '/model-budget', { limit: 2_000 });
  assert.equal((await depth(h)).status, 200);
  assert.equal((await h.call('GET', '/model-budget')).body.state.used, 1_010,
    'and the spend carried over — raising a limit is not a reset');
});

test('clearing the limit also starts the work again', async (t) => {
  const h = await withSession('budget-clear-resumes', { llm: counting(10, 0) });
  t.after(() => h.close());
  await h.call('PUT', '/model-budget', { limit: 1_000 });
  await seedSpend(h, 'cloud', 5_000);
  assert.equal((await depth(h)).status, 402);

  await h.call('DELETE', '/model-budget');
  assert.equal((await depth(h)).status, 200);
});

test('resetting the window starts the work again, from zero', async (t) => {
  const h = await withSession('budget-reset-resumes', { llm: counting(10, 0) });
  t.after(() => h.close());
  await h.call('PUT', '/model-budget', { limit: 1_000 });
  await seedSpend(h, 'cloud', 5_000);
  assert.equal((await depth(h)).status, 402);

  await h.call('POST', '/model-budget/reset');
  assert.equal((await depth(h)).status, 200);
  assert.equal((await h.call('GET', '/model-budget')).body.state.used, 10);
});

test('the limit is reached by real work, and the next thing pressed is refused', async (t) => {
  // End to end, with no seeded state: two taps spend the budget and the third
  // is stopped. The transition is the product, not the arithmetic.
  const h = await withSession('budget-live-transition', { llm: counting(500, 0) });
  t.after(() => h.close());
  await h.call('PUT', '/model-budget', { limit: 1_000 });

  assert.equal((await depth(h)).status, 200);
  assert.equal((await h.call('POST', '/sessions/s1/sections/B/depth', { direction: 'simpler' })).status, 200);
  assert.equal((await h.call('GET', '/model-budget')).body.state.status, 'exhausted');

  const third = await depth(h);
  assert.equal(third.status, 402);
  assert.equal(third.body.stoppedBy, 'model-budget');
});

// ------------------------------------------------------------------ the run

/** A model that counts what reached it and answers nothing. */
const watched = (): Llm & { calls: number } => {
  const llm = {
    calls: 0,
    async complete(): Promise<LlmResult<string>> { llm.calls++; throw new Error('no model here'); },
    async structured<T>(): Promise<LlmResult<T>> { llm.calls++; throw new Error('no model here'); },
  };
  return llm;
};

/**
 * Start a run and come back when it is over.
 *
 * The run is fire-and-forget by design, so the only honest signal that it has
 * finished is the service saying it is no longer building. Bounded, and with no
 * sleep in it: a test that waited on a wall clock would be a test that goes red
 * on a slow machine.
 */
async function runToCompletion(h: Harness): Promise<void> {
  await h.call('POST', '/batch');
  for (let i = 0; i < 200; i++) {
    const status = await h.call('GET', '/batch');
    if (!status.body.building) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('the run never finished');
}

test('the batch is where the money goes, so the switch reaches it too', async (t) => {
  // A limit that guarded the foreground and let the run carry on would be a
  // limit in name only: the run is seven calls where a tap is one.
  const spender = watched();
  const h = await startService('budget-batch', { llm: spender });
  t.after(() => h.close());
  await h.store.putPin(pin('p1', null));
  await h.store.putPin(pin('p2', null));

  await runToCompletion(h);
  assert.ok(spender.calls > 0, 'the control: a run with no limit does reach the model');

  const before = spender.calls;
  await h.call('PUT', '/model-budget', { limit: 1_000 });
  await seedSpend(h, 'cloud', 1_000);
  await runToCompletion(h);

  assert.equal(spender.calls, before, 'a spent budget stopped the run before it issued anything');
});

// ---------------------------------------------------------------- the ledger

test('none of the budget routes touch the learning ledger', async (t) => {
  const h = await startService('budget-no-ledger');
  t.after(() => h.close());
  await h.store.putPin(pin('p1', 't1'));
  await h.store.putTopic(topic('t1', ['p1']));

  const before = {
    signals: (await h.store.listSignals()).length,
    pins: (await h.store.listPins()).length,
    topics: (await h.store.listTopics()).length,
    statements: (await h.store.listStatements()).length,
  };

  await h.call('PUT', '/model-budget', { limit: 5_000 });
  await h.call('GET', '/model-budget');
  await h.call('POST', '/model-budget/reset');
  await h.call('DELETE', '/model-budget');

  assert.deepEqual({
    signals: (await h.store.listSignals()).length,
    pins: (await h.store.listPins()).length,
    topics: (await h.store.listTopics()).length,
    statements: (await h.store.listStatements()).length,
  }, before, 'what somebody spends must not shape what they are taught');
});

test('the spend record is not writable through the preferences endpoint', async (t) => {
  const h = await startService('budget-not-via-prefs');
  t.after(() => h.close());
  await h.call('PUT', '/model-budget', { limit: 1_000 });
  await seedSpend(h, 'cloud', 900);

  const res = await h.call('PUT', '/prefs', {
    targetMinutes: 45,
    modelSpend: { since: NOW, connections: emptyModelSpend().connections },
    modelBudget: { limit: 999_999, unit: 'tokens', window: 'total', setAt: NOW },
  });
  assert.equal(res.status, 200, 'the patch validator ignores fields it does not take');

  const budget = await h.call('GET', '/model-budget');
  assert.equal(budget.body.state.limit, 1_000, 'a limit is raised through its own endpoint or not at all');
  assert.equal(budget.body.state.used, 900);
});

// ------------------------------------------- the endpoints that swallowed it

/**
 * The four foreground endpoints the 402 could never reach, and the defect that
 * made this section necessary.
 *
 * Found live, on a build where every piece of this already worked: the budget
 * stopped the call, the header said `stopped:cloud`, the service had exactly
 * one 402 and the extension had a dedicated sentence to render on it. `POST
 * /review` still answered **200** with `outcome: 'model-failed'` — "the check
 * did not run", over a limit the learner set themselves.
 *
 * The reason was one layer in. The Reviewer, the Marker, the Transcriber and
 * the Tutor's live surfaces all catch a model failure on purpose and degrade,
 * and none of them could tell a call that failed from a call that was never
 * issued. The 402 branch below fires only on a stop that PROPAGATES, and on
 * every path that ran through an agent it never did. The single test above it —
 * a section depth change, which has no such catch — was the only shape that
 * reached it, which is why the gap survived a suite that already had the switch
 * under test.
 *
 * `noLlm` is the assertion in all of these, as everywhere else in this file: a
 * 402 rather than a 500 is proof the refusal happened before anything was sent.
 */

/** Over `MIN_DRAFT_CHARS` and `MIN_WORK_CHARS`, so the agent reaches its call. */
const LONG_ENOUGH = 'They wrote this themselves and would like to know what is weak about it. '.repeat(4);

/** A board with a spent cloud budget and a model that must never be reached. */
async function exhausted(tag: string): Promise<Harness> {
  const h = await startService(tag, { llm: noLlm() });
  await h.call('PUT', '/model-budget', { limit: 1_000 });
  await seedSpend(h, 'cloud', 1_000);
  return h;
}

/** The whole 402 contract, asserted the same way for every route. */
function assertBudgetStop(res: { status: number; body: any; headers: Headers }): void {
  assert.equal(res.status, 402, 'a refusal is not a failure, and 200 said it was');
  assert.equal(res.body.stoppedBy, 'model-budget');
  assert.equal(res.body.connection, 'cloud');
  assert.equal(res.body.state.status, 'exhausted');
  assert.match(res.body.error, /budget stopped this before anything was sent/);
  assert.equal(res.headers.get('x-virgil-model-budget'), 'stopped:cloud');
  assert.equal(res.body.outcome, undefined,
    'a degraded outcome in a 402 body would be the same lie in a new place');
}

test('POST /review answers the budget, not "the check did not run"', async (t) => {
  // THE reported defect, in one test. It returned 200 `model-failed`.
  const h = await exhausted('budget-review');
  t.after(() => h.close());

  assertBudgetStop(await h.call('POST', '/review', { draft: LONG_ENOUGH }));
});

test('POST /mark answers the budget, not "the check did not run"', async (t) => {
  const h = await exhausted('budget-mark');
  t.after(() => h.close());

  assertBudgetStop(await h.call('POST', '/mark', {
    work: LONG_ENOUGH,
    rubric: '1. States a target metric\n2. Cites three sources',
  }));
});

test('POST /transcribe-pages answers the budget, not "no words on those pages"', async (t) => {
  // The worst of the four to get wrong. `model-failed` and a blank page are the
  // same empty string on the wire, and this endpoint exists to keep them apart.
  const h = await exhausted('budget-transcribe');
  t.after(() => h.close());

  assertBudgetStop(await h.call('POST', '/transcribe-pages', {
    media: ['data:image/jpeg;base64,AA=='],
  }));
});

test('the live pin surfaces answer the budget too', async (t) => {
  // Both of the Tutor's foreground routes, on one board. They degrade to the
  // same `model-failed` the Reviewer did, and the panel's copy for it points at
  // the model rather than at the limit.
  const h = await exhausted('budget-pin-surfaces');
  t.after(() => h.close());
  await h.store.putPin(pin('p1', null));

  assertBudgetStop(await h.call('POST', '/pins/p1/quick-take', {}));
  assertBudgetStop(await h.call('POST', '/pins/p1/guide', {}));
});

test('the same endpoints still degrade when the model itself fails', async (t) => {
  // The other half of the rule, and the one a careless fix breaks: taking the
  // refusal out of the degrading bucket must not take an outage out with it.
  // A provider that is down still gets `model-failed` and a 200, because
  // "the check did not run" is the true sentence for that.
  const h = await startService('budget-outage-still-degrades', { llm: noLlm() });
  t.after(() => h.close());

  const review = await h.call('POST', '/review', { draft: LONG_ENOUGH });
  assert.equal(review.status, 200);
  assert.equal(review.body.outcome, 'model-failed');
  assert.equal(review.headers.get('x-virgil-model-budget'), null, 'no budget was involved');

  const transcribed = await h.call('POST', '/transcribe-pages', {
    media: ['data:image/jpeg;base64,AA=='],
  });
  assert.equal(transcribed.status, 200);
  assert.equal(transcribed.body.outcome, 'model-failed');
});

test('a stopped endpoint writes nothing, exactly as the stopped depth change does', async (t) => {
  // `/mark` and `/review` write nothing on any path — a learner scored for
  // asking to be helped stops asking — and the 402 must not become the one
  // route that does.
  const h = await exhausted('budget-review-writes-nothing');
  t.after(() => h.close());
  const before = {
    signals: (await h.store.listSignals()).length,
    pins: (await h.store.listPins()).length,
  };

  await h.call('POST', '/review', { draft: LONG_ENOUGH });

  assert.deepEqual({
    signals: (await h.store.listSignals()).length,
    pins: (await h.store.listPins()).length,
  }, before);
});
