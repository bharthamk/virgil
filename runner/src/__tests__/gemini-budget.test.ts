/**
 * The deep-tier budget planner, the quota sentinel, and the one fixture they
 * both score against — checked offline, with no key and no network.
 *
 * ## Why these tests live here rather than beside the scripts
 *
 * `scripts/` is not a workspace and is not compiled, so it has no `__tests__`
 * of its own. The convention the repo already uses is that a script's claims
 * are checked from the workspace that owns the thing the script is about —
 * `prompt-lint.test.ts` reads `scripts/measure-prompts.mjs`, `seam-purity`
 * reads `scripts/check-seam.mjs`. The nightly is the runner's, so the tooling
 * that budgets a nightly's model calls is checked from the runner.
 *
 * ## Why the imports are dynamic
 *
 * The scripts are `.mjs` with no declarations. `await import(url)` gives them a
 * runtime identity without asking TypeScript to type a file it does not build,
 * and the URL is resolved off `import.meta.url` so it works from `dist/`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const at = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const href = (rel: string) => new URL(`../../../${rel}`, import.meta.url).href;
const read = (rel: string) => readFileSync(at(rel), 'utf8');

/* eslint-disable @typescript-eslint/no-explicit-any */
const fixture: any = await import(href('scripts/verifier-catch-fixture.mjs'));
const budget: any = await import(href('scripts/gemini-budget.mjs'));
const quota: any = await import(href('scripts/gemini-quota.mjs'));

// --------------------------------------------------------------- the fixture

describe('the verifier catch-rate fixture has one home', () => {
  /**
   * The 2026-08-20 benchmark flagged this by name: the fixture was copied into
   * `gemini-benchmark.mjs` because `verifier-tier-test.mjs` executed its Ollama
   * loop on import and exported nothing. Two copies of a ground truth drift,
   * and a drifted ground truth reports a catch rate against a section nobody
   * has read. The rate is the number sheet item 17 turns on.
   */
  const CONSUMERS = ['scripts/verifier-tier-test.mjs', 'scripts/gemini-benchmark.mjs'];

  // A sentence from the defective body. Present in the fixture module; present
  // in a second copy only if somebody re-inlined one.
  const BODY_MARKER = 'the eighth being four stacked major thirds';
  // The probe for the defect that has been missed every time it was measured.
  const PROBE_MARKER = 'youtube|jazzadvice|pins';

  for (const consumer of CONSUMERS) {
    test(`${consumer} imports the fixture instead of copying it`, () => {
      const src = read(consumer);
      assert.ok(
        /from '\.\/verifier-catch-fixture\.mjs'/.test(src),
        `${consumer} must import the shared fixture module`,
      );
      assert.ok(!src.includes(BODY_MARKER), `${consumer} still carries a copy of the fixture body`);
      assert.ok(!src.includes(PROBE_MARKER), `${consumer} still carries a copy of the ground-truth probes`);
    });
  }

  test('the fixture module exports the section, the material and four probes', () => {
    assert.equal(typeof fixture.CATCH_FIXTURE.section.body, 'string');
    assert.ok(fixture.CATCH_FIXTURE.section.body.includes(BODY_MARKER));
    assert.ok(fixture.CATCH_FIXTURE.sourceMaterial.includes('major third spans four semitones'));
    assert.equal(fixture.CATCH_FIXTURE.knownAboutLearner.length, 2);
    assert.equal(fixture.GROUND_TRUTH.length, 4, 'four independently confirmed fatal defects');
  });

  test('the probes score a defect blob rather than a section', () => {
    const caught = fixture.score('inconsistent "one semitone" C to F sharp is a tritone, six semitones');
    assert.deepEqual(caught, ['C->F# called one semitone']);
    assert.deepEqual(fixture.score(''), []);
  });

  test('importing the fixture runs no model loop', () => {
    // The defect that forced the copy in the first place. A module that does
    // work on import cannot be imported by a second consumer.
    const src = read('scripts/verifier-catch-fixture.mjs');
    assert.ok(!/\bawait\s+verify\(/.test(src), 'the fixture module must not call a model');
    assert.ok(!/^for \(/m.test(src), 'the fixture module must not execute a loop on import');
  });
});

// ------------------------------------------------------------- the tier count

describe('deep-tier call count is read off the routing, not assumed', () => {
  /**
   * A warm board: every pin enriched, every topic already named. The stages
   * that fan out do nothing, and what is left is the four deep calls every
   * nightly makes plus one verify call per section the Composer's capacity
   * allows.
   */
  const warm = {
    pins: 21, unenrichedPins: 0, activeTopics: 7,
    describedTopics: 5, newGroups: 0, targetMinutes: 15, teachableTopics: 4,
  };

  test('a warm nightly is four guaranteed deep calls plus one per section', () => {
    const n = budget.nightlyCalls(warm);
    assert.equal(n.sections, 3, '15 minutes at 5 minutes a section');
    assert.deepEqual(n.deep, { min: 4, expected: 5, max: 7 });
    assert.equal(n.byStage.survey.deep, 1);
    assert.equal(n.byStage.analyse.deep, 1);
    assert.equal(n.byStage.statements.deep, 1);
    assert.equal(n.byStage.compose.deep, 1);
    assert.deepEqual(n.byStage.verify.deep, { min: 0, expected: 1, max: 3 });
    assert.equal(n.byStage.forage.deep, 0, 'nothing to enrich on a warm board');
    assert.equal(n.byStage.cluster.deep, 0, 'the Clusterer is a fast-tier agent');
  });

  test('an unenriched pin is a deep call, because the Forager runs deep', () => {
    const n = budget.nightlyCalls({ ...warm, unenrichedPins: 6 });
    assert.equal(n.byStage.forage.deep, 6);
    assert.equal(n.deep.min, 10);
  });

  test('a board under the Analyst floor loses that call', () => {
    // `analyse` returns before the model on fewer than four pins (SB-23).
    const n = budget.nightlyCalls({ ...warm, pins: 3 });
    assert.equal(n.byStage.analyse.deep, 0);
    assert.equal(n.deep.min, 3);
  });

  test('SB-285: a board with material to observe carries the Analyst conditional', () => {
    // Quoted the way the night scout's second call is: `expected` is one,
    // because a second ask only ever follows a first that came back empty, and
    // `max` is two so the plan can hold a call back for it.
    const plain = budget.nightlyCalls(warm);
    const n = budget.nightlyCalls({ ...warm, analyseSecondAsk: true });
    assert.deepEqual(n.byStage.analyse.deep, { min: 1, expected: 1, max: 2 });
    assert.equal(n.deep.expected, plain.deep.expected, 'the likely cost of the night is unchanged');
    assert.equal(n.deep.max, plain.deep.max + 1, 'and the worst case is one call larger');
    assert.equal(budget.nightlyCalls({ ...warm, pins: 3, analyseSecondAsk: true })
      .byStage.analyse.deep, 0, 'a stage under its floor is never asked, so never asked twice');
  });

  test('a board with one topic loses the Surveyor call', () => {
    // `survey` returns [] below two active topics without asking the model.
    const n = budget.nightlyCalls({ ...warm, activeTopics: 1 });
    assert.equal(n.byStage.survey.deep, 0);
  });

  test('nothing teachable means no compose call and no verify calls', () => {
    const n = budget.nightlyCalls({ ...warm, teachableTopics: 0 });
    assert.equal(n.sections, 0);
    assert.equal(n.byStage.compose.deep, 0);
    assert.deepEqual(n.byStage.verify.deep, { min: 0, expected: 0, max: 0 });
  });

  test('the ladder multiplier is reported and is not folded into the count', () => {
    // Three rungs in `structured-ladder.ts`. A logical call is one request when
    // the reply conforms — which it did 7/7 on 2026-08-20 — and three when it
    // never does. Reporting the worst case as the count would cut the run in
    // half for a risk that has not once materialised; hiding it would let a bad
    // night silently eat the reserve.
    assert.equal(budget.LADDER_RUNGS, 3);
    const n = budget.nightlyCalls(warm);
    assert.equal(n.ladderWorstCase, 21, '7 deep calls × 3 rungs, reported beside the plan');
    assert.equal(n.deep.expected, 5, 'and NOT folded into the number the plan uses');
  });
});

// ------------------------------------------------------------------ the plan

describe('the ledger fits the stages to the day cap, reserve first', () => {
  const REFERENCE = { pins: 21, unenrichedPins: 0, activeTopics: 7, describedTopics: 5, newGroups: 0, targetMinutes: 15, teachableTopics: 4 };
  const THREE_REGISTER = { pins: 21, unenrichedPins: 0, activeTopics: 9, describedTopics: 7, newGroups: 0, targetMinutes: 15, teachableTopics: 7 };

  const stages = (over: Record<string, unknown> = {}) => budget.planStages({
    dayCap: 20, reserve: 3, reference: REFERENCE, threeRegister: THREE_REGISTER, ...over,
  });

  test('the ruled priority order — two nightlies, then the catch rate', () => {
    // The variance re-run is dropped and its budget goes to
    // the catch rate. A safety number at n=0 outranks a quality number at n=1.
    const plan = stages();
    assert.deepEqual(plan.stages.map((s: any) => s.id), [
      'reference-nightly', 'three-register-nightly', 'catch-rate', 'reviewer-r1-clause2',
    ]);
    assert.ok(!plan.stages.some((s: any) => s.id === 'variance-nightly'),
      'the variance nightly is gone, not merely cut');
  });

  test('the catch rate absorbs everything above the reserve', () => {
    const plan = stages();
    const n = plan.stages.find((s: any) => s.id === 'catch-rate');
    // 20 − 3 reserved = 17 allocatable; two nightlies at 5 expected leave 7.
    assert.equal(n.plannedCalls, 7);
    assert.equal(n.elastic, true);
    assert.equal(n.belowFloor, false, '7 clears the ruled floor of 4');
    assert.equal(plan.plannedSpend, 17);
    assert.equal(plan.unallocated, 0, 'savings go to trials, not to headroom');
  });

  test('the ruled floor of 4 is a target and the reserve outranks it', () => {
    // A tight day: the floor cannot be met without borrowing from the reserve,
    // so it is not met, and the plan says so rather than borrowing.
    const plan = stages({ dayCap: 15 });
    const n = plan.stages.find((s: any) => s.id === 'catch-rate');
    assert.equal(n.plannedCalls, 2, '15 − 3 reserved − 10 for two nightlies');
    assert.equal(n.belowFloor, true);
    assert.equal(plan.reserve, 3, 'the reserve is not reduced to reach the floor');
  });

  test('a raised ceiling does not let the catch rate eat the reserve', () => {
    const plan = stages({ catchRateMax: 99 });
    assert.ok(plan.plannedSpend + plan.reserve <= 20);
    assert.equal(plan.stages.find((s: any) => s.id === 'catch-rate').plannedCalls, 7);
  });

  test('the reserve is never planned into a stage', () => {
    const plan = stages();
    assert.ok(plan.plannedSpend + plan.reserve <= 20);
  });

  test('the R1 stage is cut for budget on an ordinary day, and says why', () => {
    const cut = stages().stages.find((s: any) => s.id === 'reviewer-r1-clause2');
    assert.equal(cut.cut, true);
    assert.match(cut.cutReason, /needs 6 deep call/);
  });

  test('a smaller cap cuts from the tail and never reorders', () => {
    // 13 − 3 reserved = 10 allocatable; the two nightlies fit exactly and
    // nothing is left for the catch rate.
    const plan = stages({ dayCap: 13 });
    const ids = plan.stages.filter((s: any) => !s.cut).map((s: any) => s.id);
    assert.deepEqual(ids, ['reference-nightly', 'three-register-nightly']);
    // Cut stages are still listed, in order, with a reason — a run that says
    // nothing about what it did not do reads as a run that did everything.
    const cut = plan.stages.filter((s: any) => s.cut);
    assert.deepEqual(cut.map((s: any) => s.id), ['catch-rate', 'reviewer-r1-clause2']);
  });

  test('a budget-cut is a suffix: nothing after a cut stage runs either', () => {
    // The rule, and the reason it is a rule: running a cheap low-priority stage
    // in the gap a cut expensive one left is a reordering of the priority list
    // wearing a budget's clothes. Here the catch rate WOULD fit in what the cut
    // nightly left — 11 − 3 reserved − 5 = 3 calls — and is cut anyway.
    const plan = stages({ dayCap: 11 });
    const byId = Object.fromEntries(plan.stages.map((s: any) => [s.id, s]));
    assert.equal(byId['three-register-nightly'].cut, true);
    assert.match(byId['three-register-nightly'].cutReason, /budget/i);
    assert.equal(byId['catch-rate'].cut, true, 'the tail goes with it, though 3 calls would have fitted');
    assert.match(byId['catch-rate'].cutReason, /suffix/);
  });
});

describe('the catch rate is re-sized from the live ledger, not from the plan', () => {
  // Spend savings on trials before touching the reserve.
  const resize = (over: Record<string, number>) =>
    budget.resizeCatchRate({ planned: 7, allocatable: 7, min: 4, max: 8, ...over });

  test('a nightly that came in under plan buys extra trials', () => {
    const r = resize({ allocatable: 8 });
    assert.equal(r.n, 8);
    assert.equal(r.delta, 1);
    assert.match(r.why, /under plan/);
  });

  test('a nightly that ran over plan costs trials, never the reserve', () => {
    const r = resize({ allocatable: 4 });
    assert.equal(r.n, 4);
    assert.equal(r.delta, -3);
    assert.match(r.why, /the reserve is not touched/);
  });

  test('the ceiling still binds — one fixture does not get unlimited trials', () => {
    assert.equal(resize({ allocatable: 40 }).n, 8);
  });

  test('falling under the ruled floor is reported rather than borrowed against', () => {
    const r = resize({ allocatable: 2 });
    assert.equal(r.n, 2);
    assert.equal(r.belowFloor, true);
  });

  test('an exhausted allocation is zero trials, not a negative one', () => {
    assert.equal(resize({ allocatable: -3 }).n, 0);
  });
});

// ------------------------------------------- the usage-accounting contract: failure is not a saving

describe('the elastic stage absorbs savings, never shortfall caused by failure', () => {
  /**
   * The 2026-08-21 00:23 washout, in one number.
   *
   * Seventeen requests came back 503 and the reference nightly spent 4 of its
   * planned 5 — not because the board needed fewer calls, but because the
   * Composer never produced a section for the Verifier to check. The harness
   * read the shortfall as a saving and re-sized the catch rate UP, from 7 to 8,
   * buying an extra trial against a provider that was answering nothing.
   *
   * The elastic stage may only absorb budget freed by a stage that
   * genuinely needed fewer requests. Failure-freed budget stays unspent.
   */
  const plan = () => budget.planStages({
    dayCap: 20, reserve: 3,
    reference: { pins: 21, unenrichedPins: 0, activeTopics: 7, describedTopics: 5, newGroups: 0, targetMinutes: 15, teachableTopics: 4 },
    threeRegister: { pins: 21, unenrichedPins: 0, activeTopics: 9, describedTopics: 7, newGroups: 0, targetMinutes: 15, teachableTopics: 7 },
  });

  test('a stage that degraded did not "need fewer requests"', () => {
    // Exactly the washout's shape: 4 of 5, with four degraded pipeline stages.
    const freed = budget.failureFreed(plan(), {
      'reference-nightly': { deep: 4, status: 'ran', degraded: 4 },
    }, 'catch-rate');
    assert.equal(freed, 1, 'the one unspent call belongs to the failure, not to the trials');
  });

  test('a stage that ran clean and came in short DID need fewer requests', () => {
    const freed = budget.failureFreed(plan(), {
      'reference-nightly': { deep: 4, status: 'ran', degraded: 0 },
    }, 'catch-rate');
    assert.equal(freed, 0, 'a genuine saving is still spendable on trials');
  });

  test('a stage that threw, or was cut for a missing board, frees nothing spendable', () => {
    for (const a of [{ deep: 0, status: 'ran', threw: 'boom' }, { deep: 0, status: 'cut-no-board' }]) {
      assert.equal(budget.failureFreed(plan(), { 'reference-nightly': a }, 'catch-rate'), 5,
        `${a.status} must not fund trials`);
    }
  });

  test('a stage cut at plan time had no budget to free', () => {
    // It was never affordable. That is not a failure and not a saving; it is a
    // stage with plannedCalls of 0, and the arithmetic has to leave it alone.
    const p = budget.planStages({
      dayCap: 20, reserve: 3,
      reference: { pins: 21, unenrichedPins: 0, activeTopics: 7, describedTopics: 5, newGroups: 0, targetMinutes: 15, teachableTopics: 4 },
      threeRegister: { pins: 21, unenrichedPins: 0, activeTopics: 9, describedTopics: 7, newGroups: 0, targetMinutes: 15, teachableTopics: 7 },
    });
    assert.equal(budget.failureFreed(p, {
      'reference-nightly': { deep: 5, status: 'ran', degraded: 0 },
      'three-register-nightly': { deep: 5, status: 'ran', degraded: 0 },
    }, 'catch-rate'), 0);
  });

  test('the washout no longer buys a ninth trial', () => {
    // The live numbers from `deep-benchmark-2026-08-21.json`: 4 of 5 and 5 of 5,
    // both with degraded stages, leaving allocatable at 8 against a plan of 7.
    const r = budget.resizeCatchRate({ planned: 7, allocatable: 8, min: 4, max: 8, failureFreed: 1 });
    assert.equal(r.n, 7, 'the re-size is capped at what the stages genuinely saved');
    assert.equal(r.delta, 0);
    assert.equal(r.failureFreed, 1);
    assert.match(r.why, /freed by failure/i);
  });

  test('it can still shrink — the reserve outranks the trials either way', () => {
    const r = budget.resizeCatchRate({ planned: 7, allocatable: 4, min: 4, max: 8, failureFreed: 2 });
    assert.equal(r.n, 2, 'the shortfall AND the failure-freed budget both come off the trials');
    assert.equal(r.belowFloor, true);
  });
});

// ------------------------------------------------------- the Composer material-budget contract's two bases

describe('the budget basis is labelled, and the label is not a second opinion', () => {
  /**
   * The Composer material-budget contract gave `scoreSession` two budget denominators — `issued`, which
   * reconstructs `min(registerBudget, max(150, materialWords × 3.5))` from a
   * board's pins, and `register-only`, which is all a pinless board supports.
   * `benchmark-deep.mjs` has to label its delta columns with which one each
   * side used, so it restates the one-line rule.
   *
   * A restated rule is a rule that can drift, so this pins it to the scorer's
   * own statement of the same fact: the basis appears in the `budget-fill`
   * proxy's detail string, written by `session-score.ts` itself.
   */
  test('basisOf agrees with the basis the scorer prints', async () => {
    const core: any = await import('@sb/core');
    const fixtures: any = await import('./fixtures/reference-sessions.js');

    for (const f of [fixtures.REFERENCE_V1, fixtures.REFERENCE_V2]) {
      const card = core.scoreSession(f.session, f.board);
      const printed = /\((issued|register-only)\)/.exec(
        card.proxies.find((p: any) => p.id === 'budget-fill').detail)?.[1];
      assert.equal(budget.basisOf(f.board), printed,
        `${f.name}: the harness and the scorer disagree about the budget basis`);
    }
  });

  test('a board with pins is issued; without them it is register-only', async () => {
    const fixtures: any = await import('./fixtures/reference-sessions.js');
    assert.equal(budget.basisOf(fixtures.REFERENCE_V2.board), 'register-only',
      'the V2 fixture board carries no pins — this is the cross-basis column');
    assert.equal(budget.basisOf({ topics: [], pins: [{ id: 'p' }] }), 'issued');
    // An empty ARRAY and an absent field are different facts, and the scorer
    // keys on presence rather than length: `[]` says the board has no pins,
    // which is knowable material of zero words and lands on the Composer material-budget contract's 150-word
    // floor; absent says the pins are unknown and no budget can be reconstructed
    // at all. Asserted the way `session-score.ts` actually behaves, because a
    // label that disagrees with the scorer is worse than no label.
    assert.equal(budget.basisOf({ topics: [], pins: [] }), 'issued',
      'an empty pins array is zero material, not unknown material');
    assert.equal(budget.basisOf({ topics: [] }), 'register-only', 'absent pins cannot be reconstructed');
    assert.equal(budget.basisOf(null), 'register-only', 'no board at all cannot be issued');
  });

  test('only the two metrics that divide by a budget are basis-sensitive', () => {
    // `issued ≤ register-only` always, so the basis moves the denominator of
    // `budget-fill` and the cap of `word-budget`. Nothing else on the card
    // reads a budget, and marking more than these two would train a reader to
    // ignore the mark.
    assert.deepEqual([...budget.BASIS_SENSITIVE].sort(), ['budget-fill', 'word-budget']);
  });
});

// --------------------------------------------------------------- the sentinel

describe('the quota sentinel consumes exhaustedForPeriod', () => {
  const dayCap = () => Object.assign(new Error('gemini 429 RESOURCE_EXHAUSTED'), {
    name: 'GeminiError', status: 429, retryable: true,
    quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
    exhaustedForPeriod: true,
    // The trap: the provider's own RetryInfo on a DAILY cap said 49 seconds.
    retryAfterMs: 49_000,
  });

  const minuteCap = () => Object.assign(new Error('gemini 429 RESOURCE_EXHAUSTED'), {
    name: 'GeminiError', status: 429, retryable: true,
    quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
    exhaustedForPeriod: false, retryAfterMs: 1,
  });

  const llmThatThrows = (err: () => unknown, after = 0) => {
    let n = 0;
    return {
      calls: () => n,
      modelId: 'stub',
      async complete() { return this.structured(); },
      async structured() { n++; if (n > after) throw err(); return { value: {}, modelId: 'stub', inputTokens: 0, outputTokens: 0 }; },
    };
  };

  test('a day cap on the deep tier stops the deep tier at one request', async () => {
    const inner = llmThatThrows(dayCap);
    const ledger = quota.makeLedger({ dayCap: 20, reserve: 3 });
    const guarded = quota.guard(inner, ledger);

    await assert.rejects(() => guarded.structured({ tier: 'deep', prompt: 'a', schema: {} }));
    // Five more deep stages ask. None of them reaches the wire — the whole
    // point: the 2026-08-20 run predicted "six requests of noise" and this is
    // the thing that stops them being issued.
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => guarded.structured({ tier: 'deep', prompt: 'a', schema: {} }));
    }
    assert.equal(inner.calls(), 1, 'exactly one doomed request, not six');
    assert.equal(ledger.deepSpent, 1);
    assert.equal(ledger.deepExhausted, true);
  });

  test('it never waits on a daily cap RetryInfo', async () => {
    const inner = llmThatThrows(dayCap);
    const ledger = quota.makeLedger({ dayCap: 20, reserve: 3 });
    const slept: number[] = [];
    const guarded = quota.guard(inner, ledger, { sleep: async (ms: number) => { slept.push(ms); } });
    await assert.rejects(() => guarded.structured({ tier: 'deep', prompt: 'a', schema: {} }));
    assert.deepEqual(slept, [], 'the 49s hint on a per-DAY quota is the trap, not the fix');
  });

  test('a per-minute cap IS waited out, once', async () => {
    const inner = llmThatThrows(minuteCap, 0);
    // Succeeds on the retry: throw on call 1, answer on call 2.
    let n = 0;
    const flaky = {
      calls: () => n,
      async structured() { n++; if (n === 1) throw minuteCap(); return { value: {}, modelId: 'stub', inputTokens: 0, outputTokens: 0 }; },
      async complete() { return this.structured(); },
    };
    const ledger = quota.makeLedger({ dayCap: 20, reserve: 3 });
    const slept: number[] = [];
    const guarded = quota.guard(flaky, ledger, { sleep: async (ms: number) => { slept.push(ms); } });
    await guarded.structured({ tier: 'deep', prompt: 'a', schema: {} });
    assert.deepEqual(slept, [1]);
    assert.equal(ledger.deepSpent, 2, 'both attempts are requests and both are billed');
    assert.equal(ledger.deepExhausted, false);
    void inner;
  });

  test('the fast tier keeps working after the deep tier is spent', async () => {
    let deepCalls = 0, fastCalls = 0;
    const inner = {
      async structured(req: { tier: string }) {
        if (req.tier === 'deep') { deepCalls++; throw dayCap(); }
        fastCalls++;
        return { value: {}, modelId: 'stub', inputTokens: 0, outputTokens: 0 };
      },
      async complete(req: { tier: string }) { return this.structured(req); },
    };
    const ledger = quota.makeLedger({ dayCap: 20, reserve: 3 });
    const guarded = quota.guard(inner, ledger);
    await assert.rejects(() => guarded.structured({ tier: 'deep', prompt: 'a', schema: {} }));
    await guarded.structured({ tier: 'fast', prompt: 'a', schema: {} });
    await guarded.structured({ tier: 'fast', prompt: 'a', schema: {} });
    assert.equal(deepCalls, 1);
    assert.equal(fastCalls, 2, 'fast-tier work is valid and continues');
    assert.equal(ledger.fastSpent, 2);
  });

  test('the reserve is refused before the wire, not after', async () => {
    let n = 0;
    const inner = {
      async structured() { n++; return { value: {}, modelId: 'stub', inputTokens: 0, outputTokens: 0 }; },
      async complete() { return this.structured(); },
    };
    const ledger = quota.makeLedger({ dayCap: 5, reserve: 3 });
    const guarded = quota.guard(inner, ledger);
    await guarded.structured({ tier: 'deep', prompt: 'a', schema: {} });
    await guarded.structured({ tier: 'deep', prompt: 'a', schema: {} });
    await assert.rejects(
      () => guarded.structured({ tier: 'deep', prompt: 'a', schema: {} }),
      /reserve/i,
    );
    assert.equal(n, 2, 'the third request is refused locally — the reserve is held, not spent');
    assert.equal(ledger.deepSpent, 2);
  });

  test('the sentinel reads the seam shape, not the Gemini class', () => {
    // The classifier is `adk/src/errors.ts`, which duck-types on purpose. A
    // sentinel that imported `GeminiError` would be a second taxonomy to keep
    // in step with the first, and would stop degrading the day a second
    // provider threw the same two facts under a different name.
    const src = read('scripts/gemini-quota.mjs');
    // Prose may name the class — the rationale is worth reading. Code may not.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/GeminiError/.test(code), 'no provider class in the sentinel');
    assert.ok(!/instanceof/.test(code), 'the seam promises properties, not a prototype chain');
    assert.ok(/adk\/dist\/index\.js/.test(code), 'the ruled classifier is the one that is used');
  });
});

// ------------------------------------------- the usage-accounting contract: the circuit breaker

/**
 * The 2026-08-21 00:23 PT washout: seventeen requests, seventeen identical
 * 503s, two minutes twelve seconds, and not one number worth keeping.
 *
 * The day cap has a sentinel because a spent quota announces itself. An outage
 * does not: every 503 is individually retryable, individually degradable, and
 * individually indistinguishable from a blip. What makes it a run-ending fact
 * is the *third one in a row saying the same thing*, and nothing in the harness
 * was counting.
 */
describe('the circuit breaker stops a run the provider is not answering', () => {
  const outage = () => Object.assign(new Error(
    'gemini 503 UNAVAILABLE: This model is currently experiencing high demand.'), {
    name: 'GeminiError', status: 503, providerStatus: 'UNAVAILABLE', retryable: true,
  });

  const minuteCap = () => Object.assign(new Error('gemini 429 RESOURCE_EXHAUSTED'), {
    name: 'GeminiError', status: 429, providerStatus: 'RESOURCE_EXHAUSTED', retryable: true,
    quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
    exhaustedForPeriod: false, retryAfterMs: 1,
  });

  const badRequest = () => Object.assign(new Error('gemini 400 INVALID_ARGUMENT'), {
    name: 'GeminiError', status: 400, providerStatus: 'INVALID_ARGUMENT', retryable: false,
  });

  /** A model that throws whatever the script says, call by call. */
  const scripted = (script: Array<(() => unknown) | null>) => {
    let n = 0;
    return {
      calls: () => n,
      modelId: 'stub',
      async structured() {
        // Explicitly indexed rather than `??`, because `null` IS a step here —
        // it is the one that answers — and `null ?? fallback` would eat it.
        const step = n < script.length ? script[n] : script[script.length - 1];
        n++;
        if (step) throw step();
        return { value: {}, modelId: 'stub', inputTokens: 0, outputTokens: 0 };
      },
      async complete() { return this.structured(); },
    };
  };

  const deepCall = (g: any) => g.structured({ tier: 'deep', prompt: 'a', schema: {} });

  test('three identical failures in a row trip it, and the third is the last request', async () => {
    const inner = scripted([outage]);
    const ledger = quota.makeLedger({ dayCap: 20, reserve: 3 });
    const guarded = quota.guard(inner, ledger);

    for (let i = 0; i < 3; i++) await assert.rejects(() => deepCall(guarded));
    assert.equal(inner.calls(), 3);
    assert.ok(ledger.tripped, 'three identical 503s is an outage, not three blips');
    assert.equal(ledger.tripped.count, 3);
    assert.match(ledger.tripped.signature, /503/);

    // The seventeen-request run, had this existed: fourteen of them refused.
    for (let i = 0; i < 14; i++) {
      await assert.rejects(() => deepCall(guarded), /circuit/i);
    }
    assert.equal(inner.calls(), 3, 'nothing reaches the wire once the breaker is open');
    assert.equal(ledger.refusals.filter((r: any) => r.reason === 'circuit-open').length, 14);
  });

  test('the breaker is open for every tier, not only the one that tripped it', async () => {
    // A provider outage is not a property of a tier. The run stops.
    const inner = scripted([outage]);
    const ledger = quota.makeLedger({ dayCap: 20, reserve: 3 });
    const guarded = quota.guard(inner, ledger);
    for (let i = 0; i < 3; i++) await assert.rejects(() => deepCall(guarded));
    await assert.rejects(() => guarded.structured({ tier: 'fast', prompt: 'a', schema: {} }), /circuit/i);
    assert.equal(inner.calls(), 3);
  });

  test('two 503s and something else is not a pattern', async () => {
    const inner = scripted([outage, outage, badRequest, outage, outage]);
    const ledger = quota.makeLedger({ dayCap: 20, reserve: 3 });
    const guarded = quota.guard(inner, ledger);
    for (let i = 0; i < 5; i++) await assert.rejects(() => deepCall(guarded));
    assert.equal(inner.calls(), 5, 'a different failure resets the count — the run is not in one state');
    assert.equal(ledger.tripped, null);
  });

  test('a success resets the count', async () => {
    const inner = scripted([outage, outage, null, outage, outage]);
    const ledger = quota.makeLedger({ dayCap: 20, reserve: 3 });
    const guarded = quota.guard(inner, ledger);
    await assert.rejects(() => deepCall(guarded));
    await assert.rejects(() => deepCall(guarded));
    await deepCall(guarded);
    await assert.rejects(() => deepCall(guarded));
    await assert.rejects(() => deepCall(guarded));
    assert.equal(ledger.tripped, null, 'the provider answered in between; the streak is broken');
    assert.equal(inner.calls(), 5);
  });

  test('a healthy fast tier does not hold the breaker open for a dead deep one', async () => {
    // A nightly interleaves the fast Clusterer and the fast half of the
    // Verifier with the deep stages. If a fast success cleared the deep
    // tier's streak, the breaker would never trip on the run it exists for.
    let fast = 0;
    const inner = {
      modelId: 'stub',
      async structured(req: { tier: string }) {
        if (req.tier === 'deep') throw outage();
        fast++;
        return { value: {}, modelId: 'stub', inputTokens: 0, outputTokens: 0 };
      },
      async complete(req: { tier: string }) { return this.structured(req); },
    };
    const ledger = quota.makeLedger({ dayCap: 20, reserve: 3 });
    const guarded = quota.guard(inner, ledger);
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => deepCall(guarded));
      if (i < 2) await guarded.structured({ tier: 'fast', prompt: 'a', schema: {} });
    }
    assert.equal(fast, 2, 'the fast tier really did keep working in between');
    assert.ok(ledger.tripped, 'and the deep tier still tripped on its third identical 503');
    assert.equal(ledger.tripped.tier, 'deep');
  });

  test('a 429 the harness waits out and recovers from does not count toward the three', async () => {
    // Ruled explicitly: the per-minute cap the sentinel already handles is not a
    // symptom of an outage. Counting it would trip the breaker on a run that is
    // working exactly as designed.
    const inner = scripted([minuteCap, null, minuteCap, null, minuteCap, null]);
    const ledger = quota.makeLedger({ dayCap: 20, reserve: 3 });
    const guarded = quota.guard(inner, ledger, { sleep: async () => {} });
    await deepCall(guarded);
    await deepCall(guarded);
    await deepCall(guarded);
    assert.equal(ledger.tripped, null, 'three waits that all recovered are three successes');
    assert.equal(ledger.deepSpent, 6, 'each wait is still its own request and is still billed');
  });

  test('but a retry that fails the same way does count', async () => {
    // Three logical calls, each a 429 answered by a 429. The wait bought
    // nothing, three times, and that is the shape the breaker exists for.
    const inner = scripted([minuteCap]);
    const ledger = quota.makeLedger({ dayCap: 20, reserve: 3 });
    const guarded = quota.guard(inner, ledger, { sleep: async () => {} });
    for (let i = 0; i < 3; i++) await assert.rejects(() => deepCall(guarded));
    assert.ok(ledger.tripped, 'the retries failed identically; waiting again is not a plan');
    assert.equal(inner.calls(), 6, 'each logical call took its one ruled retry and no more');
  });

  test('one retry, and one only — a wait that fails does not buy another wait', async () => {
    // Before the usage-accounting contract the retry branch recursed into a fresh attempt whose
    // `retried` flag was unset, so a provider answering 429-with-RetryInfo
    // forever was retried until the reserve refused it. Bounded, but by the
    // wrong thing.
    const inner = scripted([minuteCap]);
    const ledger = quota.makeLedger({ dayCap: 20, reserve: 3 });
    const slept: number[] = [];
    const guarded = quota.guard(inner, ledger, { sleep: async (ms: number) => { slept.push(ms); } });
    await assert.rejects(() => deepCall(guarded));
    assert.deepEqual(slept, [1]);
    assert.equal(inner.calls(), 2);
  });

  test('the threshold is three, and it is a named constant rather than a literal', () => {
    assert.equal(quota.BREAKER_THRESHOLD, 3);
  });

  test('the trip carries what an aborted artefact has to say', async () => {
    const inner = scripted([outage]);
    const ledger = quota.makeLedger({ dayCap: 20, reserve: 3 });
    quota.enterStage(ledger, 'reference-nightly:survey');
    const guarded = quota.guard(inner, ledger);
    for (let i = 0; i < 3; i++) await assert.rejects(() => deepCall(guarded));
    assert.equal(ledger.tripped.stage, 'reference-nightly:survey');
    assert.equal(ledger.tripped.tier, 'deep');
    assert.equal(typeof ledger.tripped.at, 'string');
    assert.match(quota.abortNote(ledger), /CIRCUIT BREAKER/);
    assert.match(quota.abortNote(ledger), /503/);
  });

  test('an event is emitted so the run log says where it stopped', async () => {
    const events: any[] = [];
    const inner = scripted([outage]);
    const ledger = quota.makeLedger({ dayCap: 20, reserve: 3 });
    const guarded = quota.guard(inner, ledger, { onEvent: (e: any) => events.push(e) });
    for (let i = 0; i < 3; i++) await assert.rejects(() => deepCall(guarded));
    assert.equal(events.filter((e) => e.kind === 'tripped').length, 1, 'said once, not once per later refusal');
  });
});

// -------------------------------- the usage-accounting contract: attempts against presumed billing

describe('the day ledger reports attempts and presumed billing separately', () => {
  /**
   * The usage-accounting contract, in the words that were ruled: *transport-level 503s that arrive
   * WITHOUT a provider exhaustion signal do not count against the day's request
   * ledger — they never reached the model.*
   *
   * The cap is still enforced on ATTEMPTS, because a request that has been sent
   * cannot be un-sent and guessing in the run's favour is how a day gets spent
   * twice. The billing number is what the reconciliation reports, and the two
   * are printed side by side so nobody has to choose which one to believe.
   */
  const outage = () => Object.assign(new Error('gemini 503 UNAVAILABLE'), {
    name: 'GeminiError', status: 503, providerStatus: 'UNAVAILABLE', retryable: true,
  });
  const dayCap = () => Object.assign(new Error('gemini 429 RESOURCE_EXHAUSTED'), {
    name: 'GeminiError', status: 429, retryable: true,
    quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
    exhaustedForPeriod: true, retryAfterMs: 49_000,
  });

  const llm = (err: (() => unknown) | null) => ({
    modelId: 'stub',
    async structured() { if (err) throw err(); return { value: {}, modelId: 'stub', inputTokens: 0, outputTokens: 0 }; },
    async complete() { return this.structured(); },
  });

  const deepCall = (g: any) => g.structured({ tier: 'deep', prompt: 'a', schema: {} });

  test('a 503 without an exhaustion signal is an attempt but not a billed request', async () => {
    const ledger = quota.makeLedger({ dayCap: 20, reserve: 3 });
    const guarded = quota.guard(llm(outage), ledger);
    await assert.rejects(() => deepCall(guarded));
    await assert.rejects(() => deepCall(guarded));
    assert.equal(ledger.deepSpent, 2, 'two requests were issued and the run says so');
    assert.equal(ledger.deepBilled, 0, 'neither reached the model — the usage-accounting contract');
    assert.equal(ledger.unbilled.length, 2);
    assert.equal(ledger.attempts.every((a: any) => a.billed === false), true);
  });

  test('a day cap IS billed — it reached the model and the quota refused it', async () => {
    const ledger = quota.makeLedger({ dayCap: 20, reserve: 3 });
    const guarded = quota.guard(llm(dayCap), ledger);
    await assert.rejects(() => deepCall(guarded));
    assert.equal(ledger.deepSpent, 1);
    assert.equal(ledger.deepBilled, 1, 'the exhaustion signal is the provider counting it');
  });

  test('a success is billed, and the two counts agree on a clean run', async () => {
    const ledger = quota.makeLedger({ dayCap: 20, reserve: 3 });
    const guarded = quota.guard(llm(null), ledger);
    await deepCall(guarded);
    await guarded.structured({ tier: 'fast', prompt: 'a', schema: {} });
    assert.equal(ledger.deepBilled, 1);
    assert.equal(ledger.fastBilled, 1);
    assert.equal(ledger.unbilled.length, 0);
  });

  test('the cap is enforced on attempts, not on presumed billing', async () => {
    // The conservative direction, and deliberately so: a harness that treated an
    // unbilled 503 as free capacity would keep issuing requests into an outage
    // on the theory that they are not costing anything. The breaker stops the
    // run long before the cap does, and the cap stays honest underneath it.
    const ledger = quota.makeLedger({ dayCap: 5, reserve: 3, breaker: 99 });
    const guarded = quota.guard(llm(outage), ledger);
    await assert.rejects(() => deepCall(guarded));
    await assert.rejects(() => deepCall(guarded));
    await assert.rejects(() => deepCall(guarded), /reserve/i);
    assert.equal(ledger.deepSpent, 2);
    assert.equal(ledger.deepBilled, 0);
  });

  test('the reconciliation carries both numbers', async () => {
    const ledger = quota.makeLedger({ dayCap: 20, reserve: 3 });
    const guarded = quota.guard(llm(outage), ledger);
    await assert.rejects(() => deepCall(guarded));
    const plan = budget.planStages({
      dayCap: 20, reserve: 3,
      reference: { pins: 21, unenrichedPins: 0, activeTopics: 7, describedTopics: 5, newGroups: 0, targetMinutes: 15, teachableTopics: 4 },
    });
    const rec = budget.reconcile(plan, { 'reference-nightly': { deep: 1, status: 'ran' } }, ledger);
    assert.equal(rec.accounting.deepAttempts, 1);
    assert.equal(rec.accounting.deepBilled, 0);
    assert.equal(rec.accounting.unbilled, 1);
    const text = budget.renderReconciliation(rec);
    assert.match(text, /presumed billed/i);
    assert.match(text, /never reached the\s+model/i);
  });

  test('reconcile without a ledger still renders — the accounting is additive', () => {
    const plan = budget.planStages({
      dayCap: 20, reserve: 3,
      reference: { pins: 21, unenrichedPins: 0, activeTopics: 7, describedTopics: 5, newGroups: 0, targetMinutes: 15, teachableTopics: 4 },
    });
    const rec = budget.reconcile(plan, {});
    assert.equal(rec.accounting, null);
    assert.match(budget.renderReconciliation(rec), /ACTUAL vs PLANNED/);
  });
});
