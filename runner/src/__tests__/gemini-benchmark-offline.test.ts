/**
 * The deep-tier benchmark entrypoint, driven end to end, offline.
 *
 * ## Why this is a test and not a rehearsal
 *
 * The run this harness exists for gets ONE attempt a day. Twenty deep requests
 * refill at midnight US-Pacific and are shared with every other lane on the key,
 * so a bug found at 00:05 is not a bug you fix and re-run — it is the day. On
 * The target configuration was never measured, and the reason
 * was quota rather than code.
 *
 * So the pipeline is proven here, against a scripted model, with no key and no
 * network, before it is trusted with the real thing. Two runs:
 *
 *  1. a clean sequence, which checks the ledger reconciles and the artefacts
 *     land;
 *  2. a sequence with a free-tier DAY CAP injected mid-flight, which is the
 *     only way the abort rule can be proven — you cannot ask the live service
 *     for a 429 on demand, and spending the day's quota to produce one is the
 *     thing this whole file is trying to avoid.
 *
 * The second run is the important one. It asserts the specific failure
 * `GEMINI_BENCHMARK_2026-08-20.md` anomaly 2 predicted: that a nightly begun
 * with the deep tier spent would issue "roughly six" doomed requests, one per
 * stage. It must issue one.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ENTRY = join(ROOT, 'scripts', 'benchmark-deep.mjs');

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Run the entrypoint as a child process, the way an operator will.
 *
 * In-process would be quicker and would prove less: the thing under test is a
 * top-level script with an exit code, and half its contract is that it refuses
 * before it spends anything.
 */
function runEntry(args: string[]): { code: number; out: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'virgil-deep-test-'));
  try {
    const out = execFileSync(process.execPath, [ENTRY, ...args, '--out', dir], {
      cwd: ROOT, encoding: 'utf8', timeout: 300_000,
      // No key, ever. If anything in this path reads one, it finds nothing —
      // which is itself part of what is being asserted.
      env: { ...process.env, GEMINI_API_KEY: '', SB_DB: '' },
    });
    return { code: 0, out, dir };
  } catch (err: any) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}`, dir };
  }
}

const resultsIn = (dir: string) => {
  const f = readdirSync(dir).find((x) => x.startsWith('deep-benchmark-') && x.endsWith('.json'));
  assert.ok(f, `no results JSON in ${dir}: ${readdirSync(dir).join(', ')}`);
  return JSON.parse(readFileSync(join(dir, f), 'utf8'));
};

// --------------------------------------------------------------- the dry run

describe('dry run: the plan is printed and nothing is spent', () => {
  let r: ReturnType<typeof runEntry>;
  before(() => { r = runEntry(['--dry-run']); });

  test('it exits clean and says plainly that nothing was called', () => {
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /no model was called, by any tier/);
  });

  test('preflight makes no request — it is offline by design', () => {
    assert.match(r.out, /PREFLIGHT — offline; no request is made here/);
    // The pins are checked against a RECORDED inventory. A preflight that
    // spent a request to validate a pin would spend 5% of the day's deep
    // budget asking permission to spend the other 95%.
    assert.match(r.out, /pin: deep = gemini-3\.7-flash\s+in the recorded inventory/);
    assert.match(r.out, /pin: fast = gemini-3\.5-flash-lite\s+in the recorded inventory/);
  });

  test('the ledger is computed before anything, and the reserve is held out', () => {
    assert.match(r.out, /DEEP-TIER CALL LEDGER — planned before the first request/);
    const plan = JSON.parse(readFileSync(join(r.dir, 'plan.json'), 'utf8')).plan;
    assert.equal(plan.dayCap, 20);
    assert.equal(plan.reserve, 3);
    assert.ok(plan.plannedSpend + plan.reserve <= plan.dayCap,
      'the reserve is never planned into a stage');
    assert.deepEqual(plan.stages.map((s: any) => s.id), [
      'reference-nightly', 'three-register-nightly', 'catch-rate', 'reviewer-r1-clause2',
    ], 'the priority order keeps variance behind the catch-rate measurement');
  });

  test('the deep count is read off the board, not carried over from last time', () => {
    const { referenceShape } = JSON.parse(readFileSync(join(r.dir, 'plan.json'), 'utf8'));
    // Whatever the board holds today, the shape it was counted from is recorded
    // beside the number. A ledger that cannot say what it counted is a guess.
    assert.equal(typeof referenceShape.pins, 'number');
    assert.equal(typeof referenceShape.activeTopics, 'number');
    assert.equal(typeof referenceShape.teachableTopics, 'number');
    assert.match(r.out, /board shapes the count was read off/);
  });

  test('no key is required to plan, and none is printed', () => {
    assert.ok(!/AIza/.test(r.out), 'nothing that looks like a key reaches the output');
  });
});

// ------------------------------------------------------------- the clean run

describe('stub run: the whole sequence, offline', () => {
  let r: ReturnType<typeof runEntry>;
  let results: any;
  before(() => { r = runEntry(['--stub']); results = resultsIn(r.dir); });

  test('it completes and writes both artefacts', () => {
    assert.equal(r.code, 0, r.out.slice(-3000));
    const files = readdirSync(r.dir);
    assert.ok(files.some((f) => /^GEMINI_BENCHMARK_DEEP_\d{4}-\d{2}-\d{2}\.md$/.test(f)),
      `no promotable markdown in ${files.join(', ')}`);
    assert.ok(files.some((f) => /^deep-benchmark-.*\.json$/.test(f)));
  });

  test('all budgeted stages ran, in the ruled order', () => {
    const ran = results.plan.stages.filter((s: any) => !s.cut).map((s: any) => s.id);
    assert.deepEqual(ran, ['reference-nightly', 'three-register-nightly', 'catch-rate'],
      'the R1 stage is lowest priority and is expected to be cut for budget');
    for (const id of ran) assert.equal(results.actual[id].status, 'ran', `${id} did not run`);
  });

  test('actual reconciles against planned and the reserve survives', () => {
    const rec = results.reconciliation;
    assert.equal(rec.actualSpend, results.ledger.deepSpent);
    assert.equal(rec.reserveIntact, true);
    assert.ok(results.ledger.deepSpent <= results.plan.dayCap - results.plan.reserve,
      'the run never ate into the reserve');
    for (const row of rec.rows) {
      assert.equal(typeof row.planned, 'number');
      assert.equal(typeof row.actual, 'number');
      assert.equal(row.delta, row.actual - row.planned);
    }
  });

  test('each stage got its own copy of the board', () => {
    // Otherwise the "variance" re-run is a run on a board the first run changed,
    // which measures the board rather than the model.
    for (const id of ['reference-nightly', 'three-register-nightly']) {
      assert.ok(existsSync(join(r.dir, id, 'store.json')), `${id} has no isolated store`);
    }
  });

  test('the catch rate absorbed the budget freed by dropping the variance run', () => {
    const cr = results.actual['catch-rate'];
    assert.ok(cr.n >= 1, 'the catch rate ran');
    assert.ok(cr.resized, 'n is re-sized from the live ledger when the stage is reached');
    assert.equal(cr.deep, cr.n + cr.trials.filter((t: any) => t.failure).length,
      'every trial is one deep call');
    // The whole point of the reorder: sheet item 17 goes from n=0 on the ruled
    // model to a real sample, and the reserve is untouched either way.
    assert.ok(results.ledger.deepSpent <= results.plan.dayCap - results.plan.reserve);
  });

  test('the scorecard is the 18-check one', () => {
    for (const [id, s] of Object.entries<any>(results.scored)) {
      if (s.noSession) continue;
      assert.equal(s.card.hard.length, 18, `${id} scored against the wrong harness`);
    }
  });

  test('deltas are computed against both bars, and a skip is never a pass', () => {
    const ref = results.scored['reference-nightly'];
    assert.ok(ref.deltas['v2-bar'], 'no V2 bar column');
    assert.ok('floor-2026-08-20' in ref.deltas, 'no yesterday-floor column');
    for (const d of Object.values<any>(ref.deltas)) {
      if (!d) continue;
      for (const c of d.hard) {
        if (c.now === 'skipped' && c.base === 'pass') {
          assert.match(c.delta, /NOT passed/, 'a check the bar cleared and this run skipped must say so');
        }
      }
    }
  });

  test('the three-register stage is scored against its own baseline, not the V2 bar alone', () => {
    const tr = results.scored['three-register-nightly'];
    assert.ok('three-register-attempt-1' in tr.deltas,
      'the flagship claim moves against attempt 1 (15/17), not against REFERENCE_SESSION_V2');
  });

  test('the comparability notes are written, and one of them is computed', () => {
    const notes = results.comparability;
    assert.ok(notes.some((n: any) => /17th hard check/.test(n.what)));
    assert.ok(notes.some((n: any) => /closing note/.test(n.what)));
    assert.ok(notes.some((n: any) => n.computed === true),
      'at least one note is derived from the board rather than asserted in prose');
  });
});

// ----------------------------------------------------------- the day cap run

describe('stub run with a day cap injected mid-sequence', () => {
  let r: ReturnType<typeof runEntry>;
  let results: any;
  // Deep call #6 lands inside the SECOND stage on this board, which is the
  // case that matters: a cap met mid-sequence, with stages on both sides of it.
  before(() => { r = runEntry(['--stub', '--stub-daycap-at=6']); results = resultsIn(r.dir); });

  test('the run completes rather than dying — a spent quota is a fact, not a crash', () => {
    assert.equal(r.code, 0, r.out.slice(-3000));
  });

  test('the deep tier stops at the request that met the cap', () => {
    assert.equal(results.ledger.deepExhausted, true);
    assert.equal(results.ledger.deepSpent, 6, 'the capped request is billed; nothing after it is issued');
    assert.match(results.ledger.stoppedAt, /^three-register-nightly:/);
  });

  test('the remaining deep stages issue ONE refusal, not six doomed requests', () => {
    // The predicted failure, in the artefact's own words: "a nightly begun with
    // the deep tier exhausted would issue one doomed request per stage —
    // roughly six — each failing the stage into its own degrade path."
    const refusedDeep = results.ledger.refusals.filter((x: any) => x.tier === 'deep');
    assert.ok(refusedDeep.length >= 1, 'the later stages must be refused, not silently skipped');
    const deepAttempts = results.ledger.attempts.filter((a: any) => a.tier === 'deep');
    assert.equal(deepAttempts.length, 6, 'no deep request reached the wire after the cap');
  });

  test('the provider RetryInfo on a daily cap is not waited on', () => {
    // The 429 that closed 2026-08-20 carried RetryInfo 49s beside a quotaId
    // saying PerDay. The injected error reproduces that exactly.
    assert.ok(!/waiting 49000ms/.test(r.out), 'a per-day cap must never be slept on');
    assert.match(r.out, /DEEP TIER STOPPED/);
    assert.match(results.abortNote, /RetryInfo was not waited on/);
  });

  test('the stages after the cap are marked CUT, not degraded and not silently absent', () => {
    // The catch rate was budgeted and would have run; the cap took it.
    assert.equal(results.actual['catch-rate'].status, 'cut-day-cap');
    assert.equal(results.actual['catch-rate'].deep, 0);
    // The R1 stage never had a budget, so its reason stays the one it had at
    // plan time. Two different facts about the same run, kept apart: a stage
    // relabelled by the cap would hide that it was never affordable.
    assert.equal(results.actual['reviewer-r1-clause2'].status, 'cut-at-plan');
    // Cut stages stay in the reconciliation with a negative delta. A run that
    // drops them reads as a run that did what it planned.
    const rows = results.reconciliation.rows.map((x: any) => x.stage);
    assert.deepEqual(rows, ['reference-nightly', 'three-register-nightly', 'catch-rate', 'reviewer-r1-clause2']);
    const cutStage = results.reconciliation.rows.find((x: any) => x.stage === 'catch-rate');
    assert.ok(cutStage.delta < 0, 'a cut stage shows as a shortfall against the plan');
  });

  test('the fast tier kept working inside the capped stage', () => {
    // "Keep fast-tier work going where valid" — the Verifier's fast sections and
    // the Clusterer are not blocked by a deep-tier cap, and a harness that
    // stopped everything would throw away the half of the night that still works.
    assert.ok(results.ledger.fastSpent > 0, 'no fast-tier work survived the cap');
  });

  test('a stage that composed nothing is NOT scored off the board’s previous session', () => {
    const tr = results.scored['three-register-nightly'];
    assert.ok(tr?.noSession, 'the degraded stage must report no session rather than a stale card');
    assert.match(r.out, /NO SESSION FROM THIS RUN/);
  });

  test('the artefact records what was cut and why, in one place', () => {
    const md = readdirSync(r.dir).find((f) => f.startsWith('GEMINI_BENCHMARK_DEEP_'));
    const text = readFileSync(join(r.dir, md!), 'utf8');
    assert.match(text, /DEEP TIER STOPPED/);
    assert.match(text, /cut-day-cap/);
    assert.match(text, /NOT SCORED/);
  });
});

// ------------------------------------------------------------ the outage run

/**
 * Provider-capacity failure accounting, replayed offline.
 *
 * That run met a provider capacity outage — seventeen requests, seventeen
 * identical `503 UNAVAILABLE`, two minutes twelve seconds — and spent every
 * planned attempt on it, because a 503 is individually retryable and nothing
 * was counting how many times the same one had arrived. It then re-sized the
 * elastic stage UP, from 7 trials to 8, on the theory that the earlier stages
 * had come in under plan. They had not come in under plan; they had failed.
 *
 * A day cap can be asked for on demand by spending the day. An outage cannot be
 * asked for at all, which makes the stub the only honest place to prove this.
 */
describe('stub run with a provider outage injected', () => {
  let r: ReturnType<typeof runEntry>;
  let results: any;
  // From the first deep request onward, exactly as it arrived: the run never
  // gets a single usable answer.
  before(() => { r = runEntry(['--stub', '--stub-outage-at=1']); results = resultsIn(r.dir); });

  test('it aborts with a distinct, greppable outcome rather than crashing', () => {
    assert.equal(r.code, 4, `expected the circuit-breaker exit code\n${r.out.slice(-3000)}`);
    assert.match(r.out, /aborted-circuit-breaker/);
    assert.equal(results.outcome, 'aborted-circuit-breaker');
    // Not a stack trace. The operator reading this at 02:00 is being told a
    // fact about the provider, not shown a defect in the harness.
    assert.ok(!/at Object\.<anonymous>|Error:.*\n\s+at /.test(r.out), 'the abort is reported, not thrown');
  });

  test('it stops at the third identical failure, not at the seventeenth', () => {
    const deepAttempts = results.ledger.attempts.filter((a: any) => a.tier === 'deep');
    assert.equal(deepAttempts.length, 3, 'three requests bought the diagnosis; the other fourteen bought nothing');
    assert.equal(deepAttempts.every((a: any) => a.ok === false), true);
    assert.ok(results.ledger.tripped, 'the breaker is what stopped the run');
    assert.equal(results.ledger.tripped.count, 3);
    assert.match(results.ledger.tripped.signature, /503/);
  });

  test('nothing of any tier reaches the wire after the trip', () => {
    // The washout's real cost was the fourteen requests after the diagnosis was
    // already in hand. On this board the third failure lands on the nightly's
    // last deep call, so the run stops between stages rather than mid-stage —
    // which is why the assertion is about the wire and not about the refusal
    // list. (The in-stage refusal path is covered request-by-request in
    // `gemini-budget.test.ts`, where a fourteen-request tail can be arranged.)
    assert.equal(results.ledger.attempts.length, 3,
      'every request in the ledger is one of the three that diagnosed the outage');
    // Said once, where an operator reads it, and not repeated per cut stage.
    assert.equal(r.out.match(/CIRCUIT BREAKER at /g)?.length, 1);
    assert.match(r.out, /The run stops issuing requests, by every tier/);
  });

  test('the ledger separates the attempts made from what was presumed billed', () => {
    // The quota-accounting contract’s accounting clause: a 503 with no exhaustion signal never
    // reached the model, so the day's allowance survives the outage — and the
    // artefact has to show both numbers for the reconciliation to be checkable.
    assert.equal(results.ledger.deepSpent, 3, 'three attempts were made and the run says so');
    assert.equal(results.ledger.deepBilled, 0, 'none of them reached the model');
    assert.equal(results.ledger.unbilled.length, 3);
    assert.equal(results.reconciliation.accounting.deepAttempts, 3);
    assert.equal(results.reconciliation.accounting.deepBilled, 0);
  });

  test('the stages after the trip are marked cut by the breaker, not by a cap', () => {
    // Two different facts about a run, and a harness that collapsed them would
    // send somebody to wait for a quota reset that was never the problem.
    for (const id of ['three-register-nightly', 'catch-rate']) {
      assert.equal(results.actual[id].status, 'cut-circuit-breaker', id);
      assert.equal(results.actual[id].deep, 0);
    }
    assert.equal(results.ledger.deepExhausted, false, 'the day cap was never met — this was the provider');
  });

  test('the elastic stage does not absorb the budget the failures freed', () => {
    // The defect this replaces: on 2026-08-21 the catch rate was re-sized 7 → 8
    // because two failed nightlies had "come in under plan".
    const cr = results.actual['catch-rate'];
    assert.ok(!cr.resized || cr.resized.n <= cr.resized.planned,
      'a failed stage must never buy the elastic stage another trial');
  });

  test('the artefacts are written exactly as an aborted run', () => {
    const files = readdirSync(r.dir);
    assert.ok(files.some((f) => /^GEMINI_BENCHMARK_DEEP_\d{4}-\d{2}-\d{2}\.md$/.test(f)), files.join(', '));
    const md = readFileSync(join(r.dir, files.find((f) => f.startsWith('GEMINI_BENCHMARK_DEEP_'))!), 'utf8');
    assert.match(md, /aborted-circuit-breaker/);
    assert.match(md, /CIRCUIT BREAKER/);
    assert.match(md, /cut-circuit-breaker/);
    // The reconciliation is not skipped on an aborted run. A run that writes
    // nothing when it fails is a run nobody can audit afterwards.
    assert.match(md, /ACTUAL vs PLANNED/);
    assert.match(md, /presumed billed/i);
  });
});

// ------------------------------------------------ the failure-freed re-size

/**
 * The quota-accounting contract’s second clause, end to end: a stage that failed did not save.
 *
 * One 503 on the second deep call — a blip, not an outage, so the breaker does
 * not open and the run goes all the way through. The Analyst fails, the
 * Registrar has nothing to describe and skips its call, and the nightly comes
 * in one request under plan. That is precisely the shape the 2026-08-21 washout
 * presented, and the harness read it as a saving and bought another trial with
 * it.
 *
 * The ceiling is raised for the run so that the remainder, rather than
 * `catchRateMax`, is what bounds `n` — otherwise the cap hides the defect and
 * the test passes for the wrong reason.
 */
describe('stub run where a stage fails its way to a smaller bill', () => {
  let r: ReturnType<typeof runEntry>;
  let results: any;
  before(() => {
    r = runEntry(['--stub', '--stub-blip-at=2', '--catch-rate-max=12']);
    results = resultsIn(r.dir);
  });

  test('the run completes — one blip is not an outage', () => {
    assert.equal(r.code, 0, r.out.slice(-3000));
    assert.equal(results.outcome, 'completed');
    assert.equal(results.ledger.tripped, null, 'a single failure must not trip the breaker');
  });

  test('the nightly came in under plan, and it came in under plan by failing', () => {
    const row = results.reconciliation.rows.find((x: any) => x.stage === 'reference-nightly');
    assert.equal(row.delta, -1, 'one planned request was never made');
    assert.ok(results.actual['reference-nightly'].degraded > 0, 'and a stage inside it degraded');
  });

  test('the elastic stage does not spend it', () => {
    const sized = results.actual['catch-rate'].resized;
    assert.equal(sized.failureFreed, 1);
    assert.equal(sized.delta, 0, 'the washout re-sized 7 → 8 on exactly this shortfall');
    assert.equal(sized.n, sized.absorbable);
    assert.match(sized.why, /not absorbed/);
    assert.match(r.out, /went unspent because earlier stages FAILED/);
  });

  test('and the call stays unspent rather than landing anywhere else', () => {
    // Not in the trials, not in the reserve, not quietly absorbed by the next
    // stage. Above the reserve and unspent is the honest place for it.
    assert.equal(results.reconciliation.remaining, results.plan.reserve + 1);
    assert.equal(results.reconciliation.reserveIntact, true);
  });

  test('the 503 is an attempt but not a billed request', () => {
    assert.equal(results.ledger.deepSpent - results.ledger.deepBilled, 1);
    assert.equal(results.ledger.unbilled.length, 1);
    assert.match(results.ledger.unbilled[0].signature, /503/);
  });
});
