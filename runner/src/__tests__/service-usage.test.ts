import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Llm, LlmRequest, LlmResult } from '@sb/core';
import { LlmRefused } from '@sb/core';
import { UsageMeter, meterLlm, meterLlmAs } from '../usage.js';
import { NOW, StubLlm, brokenLlm, pin, section, session, startService } from './service-harness.js';

/**
 * What everything cost, split into the halves the learner asked for.
 *
 * The nightly has been metered since the cost model was written, and the
 * service has not — so every model call the learner buys by pressing something
 * (a pin's label, a marked answer, a depth shift, a review, a recap) was
 * invisible to the one instrument this project has for saying what it spends.
 * That was survivable while the flat seven-calls-a-night was the whole claim.
 * The quick take is a call per tap, and UX_SPEC §3 makes the per-tap line a
 * condition of shipping it, so the counter has to reach this side first.
 *
 * Deliberately the same meter, the same rows and the same report shape as the
 * nightly's. A second accounting instrument would be a second set of numbers to
 * reconcile, which is how a cost model stops being checkable.
 *
 * The endpoint once counted only learner taps: board
 * runs were deliberately excluded on the grounds that they reported themselves
 * through `pipeline.ts`. In a service nothing read that report, so a run
 * reported to nobody and the endpoint answered zero through a night that spent
 * model calls. Both lanes are counted now and the report splits them.
 */

/** A model that answers like the stub and reports tokens the way a real
 *  provider does — including the thought tokens, which are billed as output. */
const counting = (inputTokens: number, outputTokens: number): Llm => {
  const stub = new StubLlm();
  return {
    async complete(req: LlmRequest): Promise<LlmResult<string>> {
      const res = await stub.complete(req);
      return { ...res, inputTokens, outputTokens };
    },
    async structured<T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> {
      const res = await stub.structured<T>(req);
      return { ...res, inputTokens, outputTokens };
    },
  };
};

const capture = { type: 'interest' as const, envelope: pin('unused', null).envelope, note: null };

// ------------------------------------------------------------ the endpoint

test('a service that has done nothing says it has spent nothing', async (t) => {
  const h = await startService('usage-empty');
  t.after(() => h.close());

  const res = await h.call('GET', '/usage');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.llm.totals, { calls: 0, inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(res.body.llm.rows, []);
  assert.equal(res.body.runAt, NOW, 'the injected clock, not the wall clock');
  assert.ok(res.body.notes.length, 'the report carries its own limitations, as the nightly\'s does');
});

test('the label on a pin is a model call, and it is counted as one', async (t) => {
  const h = await startService('usage-pin', { llm: counting(310, 24) });
  t.after(() => h.close());

  await h.call('POST', '/pins', capture);
  const report = (await h.call('GET', '/usage')).body;

  assert.deepEqual(report.llm.totals, { calls: 1, inputTokens: 310, outputTokens: 24 });
  const [row] = report.llm.rows;
  assert.equal(row.stage, 'pin', 'attributed to what the learner pressed');
  assert.equal(row.tier, 'fast');
  assert.equal(row.reasoning, 'off');
});

test('two different taps are two rows, not one bucket', async (t) => {
  // The whole point of attributing at all: "the service spent 4,000 tokens" is
  // not a cost model, and a per-tap line cannot be derived from a total.
  const h = await startService('usage-stages', { llm: counting(100, 10) });
  t.after(() => h.close());
  await h.store.putSession(session('s1', [section('A')]));

  await h.call('POST', '/pins', capture);
  await h.call('POST', '/sessions/s1/sections/A/answer', { answer: 'because it can be redelivered' });

  const stages = ((await h.call('GET', '/usage')).body.llm.rows as { stage: string }[])
    .map((r) => r.stage).sort();
  assert.deepEqual(stages, ['answer', 'pin']);
});

// ------------------------------------------------------------- the two lanes

test('a tap is counted in the lane the learner can act on', async (t) => {
  const h = await startService('usage-lane-tap', { llm: counting(310, 24) });
  t.after(() => h.close());

  await h.call('POST', '/pins', capture);
  const report = (await h.call('GET', '/usage')).body;
  assert.equal(report.llm.rows[0].lane, 'taps');
  assert.deepEqual(report.llm.byLane.taps, { calls: 1, inputTokens: 310, outputTokens: 24 });
  // Present at zero rather than absent: "nothing ran overnight" and "this build
  // does not count runs" must not be the same answer.
  assert.deepEqual(report.llm.byLane.runs, { calls: 0, inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(report.llm.byLane.setup, { calls: 0, inputTokens: 0, outputTokens: 0 });
});

test('a board run is counted too, in its own lane, and lands in the total', async (t) => {
  /**
   * The reversal, asserted end to end. The run goes through `budgetedDeps`,
   * which was the one path in this service that reached a model without
   * reaching the meter.
   */
  const h = await startService('usage-lane-run', { llm: counting(400, 60) });
  t.after(() => h.close());
  await h.store.putPin(pin('p1', 'A'));

  await h.call('POST', '/batch');
  for (let i = 0; i < 200 && (await h.call('GET', '/batch')).body.building; i++) {
    await new Promise((r) => { setTimeout(r, 10); });
  }

  const report = (await h.call('GET', '/usage')).body;
  assert.ok(report.llm.byLane.runs.calls > 0, 'a night still costs nothing on this endpoint');
  assert.equal(report.llm.byLane.taps.calls, 0, 'the run landed in the learner\'s own column');
  // Every row from the run says which stage of it spent the tokens, which is
  // the granularity the cost model has always been written at.
  const stages = (report.llm.rows as { lane: string; stage: string }[])
    .filter((r) => r.lane === 'runs').map((r) => r.stage);
  assert.ok(stages.length && stages.every((x) => typeof x === 'string' && x.length));
  // The total is the sum, and it is the service's arithmetic rather than two
  // numbers a reader has to add up themselves.
  assert.equal(report.llm.totals.calls,
    report.llm.byLane.taps.calls + report.llm.byLane.runs.calls + report.llm.byLane.setup.calls);
  assert.equal(report.llm.totals.inputTokens,
    report.llm.byLane.taps.inputTokens + report.llm.byLane.runs.inputTokens
      + report.llm.byLane.setup.inputTokens);
  // And the board reading it does costs embedding calls, which are counted in
  // their own section because an embedding API reports no tokens.
  assert.ok(report.embed.byLane.runs.calls > 0);
});

test('the run is counted once, and a budget stop is not counted as a call', async (t) => {
  /**
   * The two instruments meet here. `budgetedLlm` wraps the meter rather than
   * the other way round, so a call the learner's own limit refused never
   * reaches the counter — and the run passes through both exactly once, so
   * metering it does not start counting anything twice.
   */
  const h = await startService('usage-lane-budget', { llm: counting(400, 60) });
  t.after(() => h.close());
  await h.store.putPin(pin('p1', 'A'));
  // A limit of one token, already spent by the first call, stops the rest.
  await h.call('PUT', '/model-budget', { limit: 1 });

  await h.call('POST', '/batch');
  for (let i = 0; i < 200 && (await h.call('GET', '/batch')).body.building; i++) {
    await new Promise((r) => { setTimeout(r, 10); });
  }

  const report = (await h.call('GET', '/usage')).body;
  const unreturned = (report.llm.rows as { issuedNotReturned: number }[])
    .reduce((a, r) => a + r.issuedNotReturned, 0);
  assert.equal(unreturned, 0,
    'a call the budget prevented was recorded as one that was issued and lost');
  // Whatever did run is counted once: the meter's own total and the sum over
  // its rows are the same arithmetic, so nothing has been added twice.
  const rows = report.llm.rows as { calls: number }[];
  assert.equal(report.llm.totals.calls, rows.reduce((a, r) => a + r.calls, 0));
});

test('an endpoint that reaches no model adds nothing to the bill', async (t) => {
  const h = await startService('usage-free', { llm: counting(100, 10) });
  t.after(() => h.close());
  await h.store.putSession(session('s1', [section('A')]));

  // Every read on the main page, plus the two writes that are pure ledger.
  await h.call('GET', '/session');
  await h.call('GET', '/flagged');
  await h.call('GET', '/progression');
  await h.call('GET', '/board');
  await h.call('POST', '/sessions/s1/sections/A/skip');

  assert.equal((await h.call('GET', '/usage')).body.llm.totals.calls, 0,
    'the flat cost of opening the panel is a claim this endpoint has to keep true');
});

test('a call that never came back is not counted, and the report says why that matters', async (t) => {
  // `usage.ts` already states it: these figures are a floor, not a ceiling.
  // A failed Scout still costs the provider something on some providers, and
  // nothing here can see it — so the floor is asserted rather than assumed.
  const h = await startService('usage-failed', { llm: brokenLlm() });
  t.after(() => h.close());

  await h.call('POST', '/pins', capture);
  const report = (await h.call('GET', '/usage')).body;
  assert.equal(report.llm.totals.calls, 0);
  assert.ok((report.notes as string[]).some((n) => /not counted/i.test(n)));
});

// --------------------------------------------------- attribution under load

test('two taps in flight at once do not land in each other\'s row', async (t) => {
  /**
   * The nightly's stages run strictly in sequence, which is what makes one
   * current-stage marker enough for it. A service does not: two requests
   * overlap the moment two windows are open, and a marker set by one and read
   * by the other attributes a pin's label to a marked answer. The endpoints
   * therefore name their stage at the call rather than setting it beforehand,
   * and this is the test that says so.
   */
  const meter = new UsageMeter();
  const slow = (ms: number): Llm => ({
    complete: async () => {
      await new Promise((r) => setTimeout(r, ms));
      return { value: 'x', modelId: 'stub', inputTokens: 1, outputTokens: 1 };
    },
    structured: async <T>(): Promise<LlmResult<T>> => {
      await new Promise((r) => setTimeout(r, ms));
      return { value: {} as T, modelId: 'stub', inputTokens: 1, outputTokens: 1 };
    },
  });

  const req = { tier: 'fast' as const, reasoning: 'off' as const, system: 's', prompt: 'p' };
  await Promise.all([
    meterLlmAs(slow(20), meter, 'pin', 'taps').complete(req),
    meterLlmAs(slow(1), meter, 'quick-take', 'taps').complete(req),
  ]);

  const rows = meter.report(NOW).llm.rows;
  assert.deepEqual(rows.map((r) => r.stage).sort(), ['pin', 'quick-take']);
  for (const row of rows) assert.equal(row.calls, 1);
});

// ------------------------------------- what a failing provider costs (audit)

test('a request that was issued and did not come back is counted, not lost', async (t) => {
  /**
   * Found in the 2026-08-22 audit. `meterLlmAs` recorded after the await, so a
   * 503, a 429 or a timeout left no trace at all and a provider that was
   * failing read as a provider that was free.
   *
   * That is not a tidiness point. **The usage-accounting contract presumes every issued
   * request billed** — there is no unbilled-503 category on this provider — and
   * this protection exists because a run took 17 × 503, retried 3 more, and hit
   * `GenerateRequestsPerDayPerProjectPerModel-FreeTier` at exactly twenty. All
   * twenty were billed. This meter would have reported none of them.
   */
  const h = await startService('usage-failed', { llm: brokenLlm() });
  t.after(() => h.close());
  await h.store.putPin(pin('p1', null));

  await h.call('POST', '/pins/p1/quick-take');

  const usage = await h.call('GET', '/usage');
  const rows = usage.body.llm.rows as { stage: string; issuedNotReturned: number }[];
  const failed = rows.filter((r) => r.issuedNotReturned > 0);
  assert.ok(failed.length > 0, `a failed call left no trace: ${JSON.stringify(rows)}`);
  assert.equal(failed.reduce((a, r) => a + r.issuedNotReturned, 0), 1);
});

test('a request that came back is still counted the way it always was', async (t) => {
  // The other direction, so the new counter cannot quietly replace the old one.
  const h = await startService('usage-ok', {});
  t.after(() => h.close());
  await h.store.putPin(pin('p1', null));

  await h.call('POST', '/pins/p1/quick-take');

  const usage = await h.call('GET', '/usage');
  const rows = usage.body.llm.rows as { calls: number; issuedNotReturned: number }[];
  assert.ok(rows.some((r) => r.calls > 0), 'a returning call stopped being counted');
  assert.equal(rows.reduce((a, r) => a + r.issuedNotReturned, 0), 0);
});

// -------------------------------- what a REFUSAL costs, and what a run's does

/** A refusal from below the meter: the shape both of this seam's own refusals
 *  take, and the one thing on this file's list that was never issued. */
class Refusal extends LlmRefused {
  constructor() {
    super('nothing was sent');
    this.name = 'Refusal';
  }
}

const throwing = (error: () => unknown): Llm => ({
  complete: async () => { throw error(); },
  structured: async <T>(): Promise<LlmResult<T>> => { throw error(); },
});

const req = { tier: 'fast' as const, reasoning: 'off' as const, system: 's', prompt: 'p' };

const unreturned = (meter: UsageMeter): number =>
  meter.report(NOW).llm.rows.reduce((a, r) => a + r.issuedNotReturned, 0);

test('a refused call is not on the bill, because nothing was issued to bill for', async () => {
  /**
   * `issuedNotReturned` means "issued and presumed billed". `LlmRefused` means
   * nothing was sent — the learner's own budget stop, or a connection with no
   * credential saved. Every throw used to reach `recordLlmFailure`, so a
   * learner who had never pasted a Cloud/API key could press Check, be told
   * correctly that no key was saved, and watch the usage panel grow a row
   * saying they had been charged for it.
   */
  const meter = new UsageMeter();
  const metered = meterLlmAs(throwing(() => new Refusal()), meter, 'mark', 'taps');

  await assert.rejects(() => metered.complete(req), Refusal);
  await assert.rejects(() => metered.structured({ ...req, schema: {} }), Refusal);

  assert.equal(unreturned(meter), 0, 'a call this product declined to make was billed to the learner');
  assert.equal(meter.report(NOW).llm.totals.calls, 0);
});

test('a genuine provider failure is still on the bill', async () => {
  // The property the exclusion must not cost. This protection exists because
  // twenty 503s were billed and this meter recorded none of them.
  const meter = new UsageMeter();
  const metered = meterLlmAs(throwing(() => new Error('503')), meter, 'mark', 'taps');

  await assert.rejects(() => metered.complete(req), /503/);
  assert.equal(unreturned(meter), 1);
});

test('the runs lane records a failing provider too, and it did not', async () => {
  /**
   * Two decorators over one meter, disagreeing about what a throw means.
   * `meterLlmAs` includes the `issuedNotReturned` catch
   * and `meterLlm` did not — so the same provider outage cost something visible
   * in the foreground and read as free overnight, on the lane that spends with
   * nobody watching and whose own 503 storm is the incident this protection was
   * written for.
   */
  const meter = new UsageMeter();
  meter.enter('compose');
  const metered = meterLlm(throwing(() => new Error('503')), meter, 'runs');

  await assert.rejects(() => metered.complete(req), /503/);
  await assert.rejects(() => metered.structured({ ...req, schema: {} }), /503/);

  const rows = meter.report(NOW).llm.rows;
  assert.equal(unreturned(meter), 2, 'a night of 503s still reads as a free night');
  assert.deepEqual(rows.map((r) => [r.lane, r.stage, r.modelId]), [['runs', 'compose', '(unreturned)']]);
});

test('and the runs lane makes the same exception for a refusal', async () => {
  const meter = new UsageMeter();
  const metered = meterLlm(throwing(() => new Refusal()), meter, 'runs');

  await assert.rejects(() => metered.complete(req), Refusal);
  assert.equal(unreturned(meter), 0);
});
