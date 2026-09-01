/**
 * What the deep tier is about to cost, computed before anything is spent.
 *
 * `gemini-3.7-flash` on the free tier is **twenty requests a day**, shared with
 * every other lane on the same key. One benchmark got a single
 * request into the run before the day cap took it, and every quality number in
 * `GEMINI_BENCHMARK_2026-08-20.md` belongs to a substituted model as a result.
 * The lesson recorded there is not "get more quota", it is: **decide what the
 * twenty buy before spending the first one.**
 *
 * So this module is arithmetic and nothing else — no network, no key, no model,
 * no store write. It answers three questions:
 *
 *   1. how many DEEP-tier calls does one nightly cost, on THIS board, at THIS
 *      commit — read off the agents' own tier declarations and the pipeline's
 *      own guards, never assumed from a previous run's total;
 *   2. which of the planned stages fit inside the cap with the reserve held
 *      back, in the configured priority order;
 *   3. what the run actually spent against that plan, so the artefact can carry
 *      actual-vs-planned instead of a total.
 *
 * ## Why the count is a RANGE and not a number
 *
 * Six of the eight stages are decidable before the run: the Forager runs once
 * per unenriched pin, and the Surveyor, Analyst, Registrar and Composer run
 * once each or not at all, on guards this file reproduces. The Verifier is not:
 * it runs once per composed section and `tierFor(section)` picks the tier from
 * the section's TEXT, which does not exist until the Composer has written it.
 * A planner that reported one number would be guessing at the only stage whose
 * cost it cannot know, so it reports `min`, `expected` and `max`, plans on
 * `expected`, and lets the sentinel in `gemini-quota.mjs` enforce the reserve.
 */

import {
  computeComfort, tend, duePool, prospectGaps, PROSPECT_MAX_MODEL_CALLS,
  modalityAlreadyLive, modalityDenialLive, modalityTallies, modalityWorthAsking,
  observableMaterial,
} from '../core/dist/index.js';

// ------------------------------------------------------------- the constants

/**
 * Rungs in `adapters/src/structured-ladder.ts`. Every logical call is one
 * request when the reply conforms and up to three when it does not.
 *
 * Reported, never folded into the plan. The 2026-08-20 run made seven logical
 * calls and issued exactly seven requests — native `responseSchema` conformed
 * 7/7, zero ladder retries — so planning at 3× would cut the run to a third of
 * its size for a multiplier that has not once materialised on this provider.
 * Planning at 1× and holding a hard reserve is the trade this makes, and the
 * worst case is printed beside the plan so the reader can see what was traded.
 */
export const LADDER_RUNGS = 3;

/** Minutes the Composer allots a section (`composer.ts`, `perSection`). */
export const MINUTES_PER_SECTION = 5;

/** The Analyst returns before the model below this many pins (SB-23). */
export const ANALYST_PIN_FLOOR = 4;

/** The Surveyor returns `[]` below this many active topics, with no call. */
export const SURVEYOR_TOPIC_FLOOR = 2;

/**
 * The share of verify calls that route deep, from the only measurement there is.
 *
 * 2026-08-20, three composed sections, `tierFor` sent **1 deep and 2 fast**.
 * That is n=1 on one board and it is labelled as such wherever it is used: it
 * moves `expected` and nothing else. `min` assumes every section routes fast and
 * `max` assumes every section routes deep, and both are facts about the function
 * rather than about a run.
 */
export const VERIFY_DEEP_SHARE = 1 / 3;

/**
 * Which budget a scorecard measured against.
 *
 * `issued` reconstructs what the Composer actually handed the model:
 * `min(registerBudget, max(150, materialWords × 3.5))`. `register-only` is the
 * register share alone, which is all a board without pins can support.
 *
 * The rule is `board.pins ? 'issued' : 'register-only'` and it lives in
 * `session-score.ts`. It is restated here rather than parsed out of the proxy's
 * detail string — a one-line derivation is safer to repeat than a sentence is
 * to regex — and `gemini-budget.test.ts` asserts the two still agree, so a
 * divergence is a red test rather than a wrong column.
 */
export const basisOf = (board) => (board?.pins ? 'issued' : 'register-only');

/**
 * Metrics whose value depends on which budget was used as the denominator.
 *
 * `issued ≤ register-only` always, so a smaller denominator raises `budget-fill`
 * and tightens `word-budget`'s cap. Everything else on the card is untouched.
 */
export const BASIS_SENSITIVE = new Set(['budget-fill', 'word-budget']);

// --------------------------------------------------------------- board shape

/**
 * The eight numbers the count needs, read off a store.
 *
 * Separated from `nightlyCalls` so the arithmetic can be tested without a
 * store and so the planner can be run against a board it will not open twice.
 */
export async function boardShape(store, now = new Date()) {
  const pins = await store.listPins();
  const unenriched = await store.listPins({ unenrichedOnly: true });
  const topics = await store.listTopics();
  const signals = await store.listSignals();
  const prefs = await store.getPrefs();
  const statements = await store.listStatements();
  const answered = new Set((await store.listProspectProposals()).map((p) => p.evidenceKey));

  const active = topics.filter((t) => !t.retiredByUser);
  const comforts = topics.map((t) => computeComfort(t.id, signals, now));
  const decisions = tend({ topics, comforts, signals, now });
  const pool = duePool(decisions);

  // The Composer's own filter: `hold`, `offer-retire` and (off a revision
  // night) `settled` never reach a section. Reproduced rather than approximated
  // — a planner that counted every topic would budget verify calls for sections
  // the Composer was never going to write.
  const teachable = pool.teach.filter(
    (d) => d.disposition !== 'hold' && d.disposition !== 'offer-retire' && d.disposition !== 'settled',
  ).length;

  return {
    pins: pins.length,
    unenrichedPins: unenriched.length,
    activeTopics: active.length,
    // The Registrar skips its call when no topic has evidence and the Analyst
    // found nothing. Only the first half is knowable here; the second is not,
    // so this over-counts by at most one call on an evidence-free board.
    describedTopics: comforts.filter((c) => (c.evidenceCount ?? 0) > 0).length,
    // Every group already has a name on a board that has been clustered.
    newGroups: 0,
    targetMinutes: prefs.targetMinutes,
    teachableTopics: teachable,
    fallback: pool.fallback ?? null,
    /**
     * Gaps the night scout has not already put to the learner.
     *
     * Computed here rather than guessed, because it is the one thing that
     * decides whether that stage spends anything at all. The gap list is pure
     * and cheap: it reads records this function has already loaded.
     */
    prospectGaps: prefs.prospect === false
      ? 0
      : prospectGaps({ statements, topics, signals, pins })
        .filter((gap) => !answered.has(gap.key)).length,
    /**
     * Whether the night will buy SB-282's classification call.
     *
     * Knowable in advance, unlike the night scout's second call, because every
     * gate on it is arithmetic: a live denial, a question already standing, or
     * too few checked outcomes to make a contrast possible. On most boards on
     * most nights this is zero, which is the point of gating it that way.
     */
    modalityAsk: !modalityDenialLive(prefs.modalityDenied, now)
      && !modalityAlreadyLive(statements)
      && modalityWorthAsking(modalityTallies(topics, signals, now)) ? 1 : 0,
    /**
     * Whether the Analyst may buy a second ask on this board.
     *
     * The third thing in the night whose cost cannot be known in advance, and
     * the guard for it is arithmetic over records this function has already
     * loaded, so it is computed rather than assumed. It decides whether the
     * stage's `max` is one or two; it can never move `expected`, because a
     * second ask only ever follows a first that came back empty.
     */
    analyseSecondAsk: observableMaterial({ pins, topics }),
  };
}

// -------------------------------------------------------------- the counting

const range = (min, expected, max) => ({ min, expected, max });

/**
 * Deep- and fast-tier calls for one nightly on a board of this shape.
 *
 * The tier of every stage is read from the agent that owns it, at this commit:
 *
 * | stage      | agent     | tier   | how many                                |
 * |------------|-----------|--------|-----------------------------------------|
 * | forage     | Forager   | deep   | one per unenriched pin                  |
 * | cluster    | Clusterer | fast   | one per group that needs a NAME         |
 * | survey     | Surveyor  | deep   | one, above the two-topic floor          |
 * | analyse    | Analyst   | deep   | one above the four-pin floor, two if the first comes back empty on a board with material |
 * | statements | Registrar | deep   | one, if anything is describable         |
 * |            | Registrar | fast   | plus one to classify demand kinds, only when a modality question is askable |
 * | compose    | Composer  | deep   | one, if anything is teachable           |
 * | prospect   | Prospector| deep   | one on an unanswered gap, two if it proposes |
 * | verify     | Verifier  | either | one per section, `tierFor` picks which  |
 *
 * `comfort` and `garden` are pure arithmetic and cost nothing, which is why
 * they are not in the table — a fact worth keeping in view, because they are
 * the two stages that decide what the paid ones are asked.
 */
export function nightlyCalls(shape) {
  const capacity = Math.max(1, Math.floor(shape.targetMinutes / MINUTES_PER_SECTION));
  const sections = Math.min(capacity, shape.teachableTopics);

  const verifyDeep = range(0, Math.round(sections * VERIFY_DEEP_SHARE), sections);
  const verifyFast = range(0, sections - verifyDeep.expected, sections);

  const byStage = {
    forage: { tier: 'deep', deep: shape.unenrichedPins, fast: 0 },
    cluster: { tier: 'fast', deep: 0, fast: shape.newGroups },
    survey: { tier: 'deep', deep: shape.activeTopics >= SURVEYOR_TOPIC_FLOOR ? 1 : 0, fast: 0 },
    /**
     * The third stage whose cost cannot be known in advance, and the cheapest
     * of the three to reason about: the second ask happens only when the first
     * succeeded and returned nothing, so `expected` is one and `max` is two on
     * a board carrying enough read material for the guard to allow it.
     */
    analyse: {
      tier: 'deep',
      deep: shape.pins >= ANALYST_PIN_FLOOR
        ? (shape.analyseSecondAsk ? range(1, 1, 2) : 1)
        : 0,
      fast: 0,
    },
    statements: {
      tier: 'deep',
      deep: shape.describedTopics > 0 ? 1 : 0,
      // SB-282's classification. Fast tier and reasoning off: naming what kind
      // of thing a topic is takes no thinking pass, and the night's deep budget
      // belongs to the stages that teach.
      fast: shape.modalityAsk ?? 0,
    },
    compose: { tier: 'deep', deep: sections > 0 ? 1 : 0, fast: 0 },
    /**
     * The second stage whose cost cannot be known in advance, and for a
     * different reason from the Verifier's: the first call decides whether
     * there is a second. A gap list with something on it always buys the
     * choosing call, and only a night that admits a proposal buys the one that
     * names where to look. So `expected` is one and `max` is the cap.
     */
    prospect: {
      tier: 'deep',
      deep: shape.prospectGaps > 0 ? range(1, 1, PROSPECT_MAX_MODEL_CALLS) : range(0, 0, 0),
      fast: 0,
    },
    verify: { tier: 'tierFor(section)', deep: verifyDeep, fast: verifyFast },
  };

  const pick = (v, k) => (typeof v === 'number' ? v : v[k]);
  const sum = (k, tier) => Object.values(byStage).reduce((a, s) => a + pick(s[tier], k), 0);

  const deep = range(sum('min', 'deep'), sum('expected', 'deep'), sum('max', 'deep'));
  const fast = range(sum('min', 'fast'), sum('expected', 'fast'), sum('max', 'fast'));

  return {
    sections,
    capacity,
    byStage,
    deep,
    fast,
    /** Every deep call taking all three rungs. Reported; never planned on. */
    ladderWorstCase: deep.max * LADDER_RUNGS,
  };
}

// ----------------------------------------------------------------- the plan

/**
 * Priority order. Numbered because budget cuts preserve this order.
 *
 *  1. the warm nightly on the reference board;
 *  2. the three-register aged board — `THREE_REGISTER_SESSION_2026-08-20.md`
 *     came back PARTIAL and names this run as the single thing that turns it
 *     into a YES;
 *  3. the deep-tier Verifier catch rate — sheet item 17, which stands at n=0 on
 *     the selected model through the real transport;
 *  4. the Reviewer R1 clause-2 re-check — six adversarial drafts, n=1. Lowest
 *     priority and **cut first**: R1 passed both clauses locally, so this asks
 *     whether a different model reads the anti-rewrite prompt text differently.
 *     A good question, and the only one on this list that nothing is waiting on.
 *
 * ## The variance re-run was dropped, and what it bought
 *
 * An earlier draft of this list held a third nightly — a repeat of (1) on the
 * same starting board, to say whether a number was the model or the weather.
 * The variance run was removed and its budget moved to the catch rate. The
 * trade is explicit: run-to-run variance on the reference nightly goes back to
 * n=1 and stays unmeasured, and in exchange sheet item 17 goes from n=0 to n≥4
 * on the selected model through the real transport. Item 17 is a *safety* number —
 * how often the Verifier catches a fatal defect in wrong-but-sourced material —
 * and a safety number at n=0 outranks a quality number at n=1.
 *
 * The cut is a suffix, so on a twenty-call day the
 * R1 stage is expected to be cut. It is in the ledger anyway: a stage nobody
 * budgeted is a stage nobody knows was skipped.
 */
export const STAGE_ORDER = [
  'reference-nightly', 'three-register-nightly', 'catch-rate', 'reviewer-r1-clause2',
];

/** Six adversarial drafts, n=1, one deep call each. Fixed — not elastic like the catch rate. */
export const REVIEWER_R1_DRAFTS = 6;

/**
 * Fit the four stages to the cap, holding the reserve back.
 *
 * ## Two rules, and they are rules rather than preferences
 *
 * **The reserve is never planned into a stage.** It exists so that a run which
 * overruns still has calls left to re-ask the one question that mattered, and a
 * reserve that gets spent when the plan is tight is not a reserve. `planStages`
 * only ever allocates `dayCap − reserve`; `gemini-quota.mjs` refuses the wire
 * below it, so the guarantee does not depend on the forecast being right.
 *
 * **A budget cut is a SUFFIX.** If a stage does not fit, it and everything after
 * it are cut. Running a cheap low-priority stage in the gap an expensive
 * high-priority one left is a reordering of the priority list wearing a
 * budget's clothes. The cost is visible and is
 * printed: a suffix cut can leave calls unspent above the reserve, and the
 * ledger says how many rather than quietly absorbing them.
 *
 * Stages are gated on `expected`, not on `max`. Gating on `max` would refuse a
 * nightly whenever fewer than seven calls remained, which on a twenty-call day
 * costs a whole stage to a worst case that has never been observed; the
 * sentinel's hard reserve is what makes that safe.
 */
export function planStages(opts) {
  const dayCap = opts.dayCap ?? 20;
  const reserve = opts.reserve ?? 3;
  /**
   * The catch rate's ceiling and target floor.
   *
   * `catchRateMin` is a target rather than a guarantee: the reserve is hard
   * and outranks it, so a
   * day where both nightlies run long produces fewer than four trials and says
   * so rather than borrowing from the three calls held back.
   *
   * `catchRateMax` is high enough that the remainder, not the cap, is what
   * bounds `n` on an ordinary day so unused nightly budget can fund more trials.
   * It is not infinite: past a certain point another trial on the SAME fixture
   * stops being evidence and starts being precision about one section, and
   * `GEMINI_BENCHMARK_2026-08-20.md` §5 already records that a keyword probe
   * over one fixture is a narrow instrument.
   */
  const catchRateMin = opts.catchRateMin ?? 4;
  const catchRateMax = opts.catchRateMax ?? 8;

  const reference = nightlyCalls(opts.reference);
  const threeRegister = nightlyCalls(opts.threeRegister ?? opts.reference);

  const wanted = [
    { id: 'reference-nightly', kind: 'nightly', what: 'warm nightly, reference board', calls: reference },
    { id: 'three-register-nightly', kind: 'nightly', what: 'three-register aged board', calls: threeRegister },
    { id: 'catch-rate', kind: 'catch-rate', what: 'deep-tier Verifier catch rate (sheet item 17)', calls: null },
    {
      id: 'reviewer-r1-clause2', kind: 'fixed',
      what: `Reviewer R1 clause-2 re-check, ${REVIEWER_R1_DRAFTS} adversarial drafts, n=1`,
      calls: { deep: range(REVIEWER_R1_DRAFTS, REVIEWER_R1_DRAFTS, REVIEWER_R1_DRAFTS) },
    },
  ];

  let usable = dayCap - reserve;
  let cutting = false;
  const stages = [];

  for (const w of wanted) {
    if (cutting) {
      stages.push({ ...w, plannedCalls: 0, cut: true, cutReason: 'cut with the tail — a budget cut is a suffix' });
      continue;
    }

    if (w.kind === 'catch-rate') {
      /**
       * The one elastic stage, and the one that
       * absorbs everything above the reserve.
       *
       * `n` takes the whole remaining allocation rather than a fixed slice.
       * That is the ruling in one line — *spend savings on catch-rate n before
       * touching the reserve* — and it is why the stage is resized again at
       * execution time from the LIVE ledger rather than only here: a nightly
       * that comes in under `expected` should turn into extra trials, and a
       * plan-time number cannot know that it did.
       *
       * Each trial is exactly one deep call on one fixture, so the stage can be
       * stopped between trials without stranding a request — which is what
       * makes it safe to give it the remainder.
       */
      const n = Math.max(0, Math.min(catchRateMax, usable));
      if (n === 0) {
        cutting = true;
        stages.push({ ...w, plannedCalls: 0, cut: true, cutReason: 'no budget above the reserve' });
        continue;
      }
      usable -= n;
      stages.push({
        ...w, plannedCalls: n, n, cut: false, deepRange: range(n, n, n),
        elastic: true, floor: catchRateMin,
        // Said out loud rather than left for a reader to derive. The floor is a
        // target, not a guarantee: the reserve is hard and outranks it.
        belowFloor: n < catchRateMin,
      });
      continue;
    }

    const need = w.calls.deep.expected;
    if (need > usable) {
      cutting = true;
      stages.push({
        ...w, plannedCalls: 0, cut: true,
        cutReason: `budget — needs ${need} deep call(s), ${usable} available above the reserve of ${reserve}`,
      });
      continue;
    }
    usable -= need;
    stages.push({ ...w, plannedCalls: need, cut: false, deepRange: w.calls.deep });
  }

  const plannedSpend = stages.reduce((a, s) => a + s.plannedCalls, 0);

  return {
    dayCap,
    reserve,
    catchRateMin,
    catchRateMax,
    stages,
    plannedSpend,
    /** Above the reserve and not allocated — the visible cost of the suffix rule. */
    unallocated: dayCap - reserve - plannedSpend,
    worstCase: stages.reduce((a, s) => a + (s.deepRange?.max ?? 0), 0),
  };
}

/**
 * Did this stage fail, or did it simply need less than it was given?
 *
 * The only two facts that distinguish them
 * apart are on the stage's own result: whether the run threw, and whether any
 * pipeline stage inside it degraded. Anything that did not finish as a clean
 * `ran` did not "need fewer requests" — it needed the same ones and did not get
 * them, which is a shortfall rather than a saving.
 */
export const stageFailed = (a) => Boolean(
  a && (a.threw || (a.degraded ?? 0) > 0 || (a.status ?? 'ran') !== 'ran'),
);

/**
 * Budget earlier stages left unspent because something failed.
 *
 * A reference nightly spent 4 of its planned 5, not because the
 * board needed fewer calls but because the Composer never produced a section
 * for the Verifier to check. The harness read that one call as a saving and
 * bought an extra catch-rate trial with it, against a provider that was
 * answering nothing. Failure-freed budget stays unspent; the elastic stage may
 * only absorb what a stage genuinely did not need.
 *
 * A stage that was cut at plan time is not in this number: `plannedCalls` is
 * already 0, so there is nothing to free. A stage that has not been reached is
 * not in it either — it has not freed anything yet.
 */
export function failureFreed(plan, actualByStage, beforeId) {
  let freed = 0;
  for (const s of plan.stages) {
    if (s.id === beforeId) break;
    const a = actualByStage[s.id];
    if (!a) continue;
    const short = s.plannedCalls - (a.deep ?? 0);
    if (short > 0 && stageFailed(a)) freed += short;
  }
  return freed;
}

/**
 * Re-size the elastic stage from the live ledger, at the moment it is reached.
 *
 * Savings may increase catch-rate `n`, but never consume the hard three-call
 * reserve. The plan allocates on `expected`; if
 * the two nightlies came in under it, this is where the difference turns into
 * extra trials instead of quietly becoming unspent headroom.
 *
 * It can also shrink. A nightly that ran long leaves less than planned, and the
 * honest answer then is fewer trials — never the reserve.
 *
 * `failureFreed` distinguishes the
 * two ways a stage comes in under plan. Budget freed by failure is subtracted
 * before the ceiling is applied, so it stays unspent rather than being handed
 * to the one stage that will take anything it is offered.
 */
export function resizeCatchRate({ planned, allocatable, min, max, failureFreed = 0 }) {
  const absorbable = allocatable - failureFreed;
  const n = Math.max(0, Math.min(max, absorbable));
  const withheld = failureFreed > 0
    ? ` ${failureFreed} call(s) freed by failure are not absorbed`
    : '';
  return {
    n,
    planned,
    delta: n - planned,
    failureFreed,
    absorbable,
    belowFloor: n < min,
    why: (n > planned
      ? `the nightlies came in ${n - planned} call(s) under plan — spent on trials`
      : n < planned
        ? `the nightlies ran ${planned - n} call(s) short of plan — trials cut, the reserve is not touched`
        : 'as planned') + withheld,
  };
}

// -------------------------------------------------------------- the printing

const bar = (n, of) => '█'.repeat(Math.min(n, of)) + '·'.repeat(Math.max(0, of - n));

export function renderPlan(plan) {
  const out = [];
  out.push(`DEEP-TIER CALL LEDGER — planned before the first request`);
  out.push(`  day cap ${plan.dayCap} · hard reserve ${plan.reserve} · allocatable ${plan.dayCap - plan.reserve}`);
  out.push('');
  out.push(`  #  stage                        planned   range (min/exp/max)  what`);
  plan.stages.forEach((s, i) => {
    const r = s.deepRange ? `${s.deepRange.min}/${s.deepRange.expected}/${s.deepRange.max}` : '—';
    out.push(`  ${i + 1}  ${(s.cut ? `[CUT] ${s.id}` : s.id).padEnd(28)} ${String(s.plannedCalls).padStart(7)}   ${r.padEnd(19)}  ${s.what}`);
    if (s.cut) out.push(`     ${''.padEnd(28)}         ${s.cutReason}`);
    if (s.elastic) {
      out.push(`     ${''.padEnd(28)}         elastic: n is re-sized from the live ledger when this stage`
        + ` is reached (floor ${s.floor}, ceiling ${plan.catchRateMax})`);
      if (s.belowFloor) {
        out.push(`     ${''.padEnd(28)}         BELOW THE TARGET FLOOR OF ${s.floor} — the reserve is hard and outranks it`);
      }
    }
  });
  out.push('');
  out.push(`  planned spend ${plan.plannedSpend} · reserve ${plan.reserve} · unallocated ${plan.unallocated}`
    + ` · ${bar(plan.plannedSpend, plan.dayCap)}`);
  out.push(`  worst case if every stage runs long: ${plan.worstCase} deep calls`
    + ` (and ${plan.worstCase * LADDER_RUNGS} requests if the structured ladder never conformed —`);
  out.push(`  it conformed 7/7 on 2026-08-20, so the plan is at 1× and the reserve is what covers the difference)`);
  return out.join('\n');
}

/**
 * Actual against planned, for the artefact. Written whatever the run did.
 *
 * The optional ledger adds a billed-request column. `actual` and `remaining`
 * stay counted in REQUESTS ISSUED, because that is what the cap is enforced on
 * and a reconciliation that quietly switched denominators would be worse than
 * one that reported a single number. The billing figures sit beside them.
 */
export function reconcile(plan, actualByStage, ledger = null) {
  const rows = plan.stages.map((s) => {
    const a = actualByStage[s.id] ?? { deep: 0, status: s.cut ? 'cut-at-plan' : 'not-reached' };
    return {
      stage: s.id,
      planned: s.plannedCalls,
      actual: a.deep ?? 0,
      delta: (a.deep ?? 0) - s.plannedCalls,
      status: a.status ?? (s.cut ? 'cut-at-plan' : 'ran'),
      note: a.note ?? s.cutReason ?? null,
    };
  });
  const spent = rows.reduce((x, r) => x + r.actual, 0);
  return {
    rows,
    dayCap: plan.dayCap,
    plannedSpend: plan.plannedSpend,
    actualSpend: spent,
    reserve: plan.reserve,
    reserveIntact: spent <= plan.dayCap - plan.reserve,
    remaining: plan.dayCap - spent,
    accounting: ledger ? {
      deepAttempts: ledger.deepSpent,
      deepBilled: ledger.deepBilled,
      fastAttempts: ledger.fastSpent,
      fastBilled: ledger.fastBilled,
      unbilled: ledger.unbilled.length,
      /** What the day has left if only presumed-billed requests consume quota. */
      remainingIfUnbilled: plan.dayCap - ledger.deepBilled,
    } : null,
  };
}

export function renderReconciliation(rec) {
  const out = ['ACTUAL vs PLANNED — deep-tier calls', ''];
  out.push('  stage                        planned  actual  delta  status');
  for (const r of rec.rows) {
    out.push(`  ${r.stage.padEnd(28)} ${String(r.planned).padStart(7)} ${String(r.actual).padStart(7)}`
      + ` ${String(r.delta >= 0 ? `+${r.delta}` : r.delta).padStart(6)}  ${r.status}`);
    if (r.note) out.push(`  ${''.padEnd(28)} ${r.note}`);
  }
  out.push('');
  out.push(`  planned ${rec.plannedSpend} · actual ${rec.actualSpend} · remaining ${rec.remaining}`
    + ` · reserve ${rec.reserve} ${rec.reserveIntact ? 'INTACT' : 'BREACHED'}`);

  /**
   * Issued and presumed-billed columns stay side by side.
   *
   * They are equal on any run the provider actually answered, which is the
   * point: the line is silent about the distinction until a run needs it, and
   * then it says exactly how many requests the day is not being charged for and
   * on whose authority.
   */
  const acc = rec.accounting;
  if (acc) {
    out.push('');
    out.push(`  requests ISSUED     ${acc.deepAttempts} deep · ${acc.fastAttempts} fast`);
    out.push(`  presumed BILLED     ${acc.deepBilled} deep · ${acc.fastBilled} fast`
      + (acc.unbilled ? '' : '   (no divergence — every request reached the model)'));
    if (acc.unbilled) {
      out.push(`  ${acc.unbilled} request(s) failed in transport with no exhaustion signal and never reached the`);
      out.push(`  model, so they are excluded from presumed billing: ${acc.remainingIfUnbilled} of`);
      out.push(`  ${rec.dayCap} deep request(s) remain on that reading. The cap and the reserve above are`);
      out.push('  enforced on ISSUED, which is the pessimistic number and stays the one the run obeys.');
    }
  }
  return out.join('\n');
}
