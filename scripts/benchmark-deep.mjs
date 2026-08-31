/**
 * The ruled deep-tier benchmark, as one command.
 *
 *   npm run benchmark:deep -- --dry-run    # the plan, no calls of any kind
 *   npm run benchmark:deep -- --stub       # the whole pipeline, offline
 *   npm run benchmark:deep                 # the real thing, at quota reset
 *
 * ## What this exists to stop happening again
 *
 * The target configuration was not measured in the earlier run. Earlier lanes on the same
 * free-tier key had spent all twenty of `gemini-3.7-flash`'s daily requests, the
 * benchmark's first deep call came back 429, and the day's quality numbers all
 * belong to a substituted model. `GEMINI_BENCHMARK_2026-08-20.md` §7 lists four
 * things that were cut and §9 lists what should change. Three of the four are in
 * this file's stage list; the fourth — the deep Surveyor reading — falls out of
 * stage 1 for free.
 *
 * The lesson recorded there is that twenty requests is not a budget you discover,
 * it is a budget you allocate. So nothing here calls a model until the ledger has
 * been computed and printed, every call is counted against it, and the first
 * daily 429 stops the deep tier at that request rather than at the sixth.
 *
 * ## Order of operations, and why preflight does not touch the network
 *
 *   preflight   key present · pins resolvable in the RECORDED inventory · boards
 *               present · harness built · baselines readable · 18 checks live
 *   stage 0     LIVE ListModels — the run's FIRST real call, deliberately
 *   stages 1-4  in the ruled priority order, each against a fresh copy of its board
 *   scoring     the 18-check harness, per stage, against three baselines
 *   results     a markdown file ready for promotion, plus the raw JSON
 *
 * Preflight is offline because a preflight that spends a request has spent 5% of
 * the day's deep budget to find out whether it may spend the other 95%. The pins
 * are checked against `gemini-model-inventory.json`, which is recorded rather
 * than live — and which therefore CANNOT catch a pin that moved since it was
 * written. That is exactly why stage 0 exists and why it is a stage rather than
 * a check: it is a real call, it is billed, and it goes in the ledger.
 */

import { mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';

import { systemClock, partitionStrategyFrom, verify, scoreSession, boardFromStore, computeComfort, registerFor } from '../core/dist/index.js';
import { OllamaEmbedder, TfIdfEmbedder, JsonStore, LocalResearch } from '../adapters/dist/index.js';
import { runBatch } from '../runner/dist/pipeline.js';
import { UsageMeter, meterLlm, meterEmbedder, formatUsage } from '../runner/dist/usage.js';

import {
  boardShape, nightlyCalls, planStages, renderPlan, reconcile, renderReconciliation,
  resizeCatchRate, failureFreed, basisOf, BASIS_SENSITIVE, LADDER_RUNGS,
} from './gemini-budget.mjs';
import {
  makeLedger, guard, enterStage, abortNote, deepRemaining, deepAllocatable, QuotaRefusal,
  BREAKER_THRESHOLD, EXIT_CIRCUIT_BREAKER, OUTCOME_CIRCUIT_BREAKER,
} from './gemini-quota.mjs';
import { CATCH_FIXTURE, GROUND_TRUTH, blobOf, score as scoreCatch } from './verifier-catch-fixture.mjs';

// ------------------------------------------------------------------- config

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (f, d = null) => {
  const hit = argv.find((a) => a.startsWith(`--${f}=`));
  if (hit) return hit.slice(f.length + 3);
  const i = argv.indexOf(`--${f}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const MODE = has('stub') ? 'stub' : has('dry-run') ? 'dry-run' : 'live';
const DAY_CAP = Number(val('day-cap', 20));
const RESERVE = Number(val('reserve', 3));
const CATCH_RATE_MIN = Number(val('catch-rate-min', 4));
const CATCH_RATE_MAX = Number(val('catch-rate-max', 8));
const OUT_DIR = val('out', join(ROOT, '.data-deep'));
const ENV_FILE = val('env-file', join(homedir(), '.config', 'virgil', 'env'));
/** Stub only: make the Nth DEEP call come back as a free-tier day cap. */
const STUB_DAYCAP_AT = Number(val('stub-daycap-at', 0));
/** Stub only: make the Nth DEEP call and every one after it a provider 503. */
const STUB_OUTAGE_AT = Number(val('stub-outage-at', 0));
/** Stub only: fail the Nth DEEP call and only that one — a blip, not an outage. */
const STUB_BLIP_AT = Number(val('stub-blip-at', 0));

/** Pinned. Never an alias — `gemini-pro-latest` is a 3.1 model (transport proof §2). */
const PINS = { fast: 'gemini-3.5-flash-lite', deep: 'gemini-3.7-flash' };

const INVENTORY = JSON.parse(readFileSync(join(ROOT, 'scripts', 'gemini-model-inventory.json'), 'utf8'));

/** The board every reference number since REFERENCE_SESSION_V2 was taken against. */
const REFERENCE_BOARD = join(ROOT, '.data', 'store.json');
/** The Reviewer R1 re-eval harness — read only; it belongs to the R1 lane. */
const REVIEWER_R1_HARNESS = val('reviewer-r1-harness',
  join(ROOT, 'artifacts', 'reviewer_r1_eval', 'harness'));

/** The aged three-register board, on its own branch. Read, never merged. */
const THREE_REGISTER_BOARD = val('three-register-board',
  join(ROOT, '..', '.virgil-wt', 'three-register', '.data-3r', 'store.json'));

const log = (s = '') => console.log(s);
const lines = [];
const say = (s = '') => { lines.push(s); log(s); };

// ---------------------------------------------------------------- preflight

/**
 * Everything that can be known without spending a request.
 *
 * Each check reports rather than throws, and the run refuses only at the end,
 * so somebody at 00:01 sees every problem at once instead of one per attempt.
 */
async function preflight() {
  const checks = [];
  const add = (name, ok, detail, fatal = true) => { checks.push({ name, ok, detail, fatal }); return ok; };

  // --- the key. Read, never printed, never written anywhere. -------------
  if (MODE === 'live') {
    let keyOk = false, detail = '';
    if (!existsSync(ENV_FILE)) {
      detail = `no ${ENV_FILE}`;
    } else {
      const mode = statSync(ENV_FILE).mode & 0o777;
      const raw = readFileSync(ENV_FILE, 'utf8');
      // Sourced here rather than requiring `set -a; source...` in the shell,
      // so the key never reaches a shell history or a process listing.
      for (const line of raw.split('\n')) {
        const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
        if (m) process.env[m[1]] ??= m[2].replace(/^['"]|['"]$/g, '');
      }
      const key = process.env.GEMINI_API_KEY ?? '';
      keyOk = key.length > 20;
      // Length and mode only. Not a prefix, not a suffix, not a fingerprint:
      // a partial key in an artefact is still a partial key in an artefact.
      detail = keyOk
        ? `present (${key.length} chars, ${ENV_FILE} mode ${mode.toString(8)})`
        : `GEMINI_API_KEY missing or too short in ${ENV_FILE}`;
      if (keyOk && mode & 0o077) detail += ' — WARNING: readable by others';
    }
    add('api key', keyOk, detail);
  } else {
    add('api key', true, `not needed in ${MODE} mode — no request will be made`, false);
  }

  // --- the pins, against the RECORDED inventory --------------------------
  const known = new Map(INVENTORY.models.map((m) => [m.id, m]));
  for (const [tier, id] of Object.entries(PINS)) {
    const m = known.get(id);
    const ok = Boolean(m) && m.generateContent === true && (m.version ?? 0) >= INVENTORY.floor.minimumVersion;
    add(`pin: ${tier} = ${id}`, ok, ok
      ? `in the recorded inventory, v${m.version} ≥ ${INVENTORY.floor.minimumVersion}, generateContent`
      : m ? `v${m.version} is below the ${INVENTORY.floor.minimumVersion} floor, or cannot generateContent`
        : 'not in the recorded inventory');
  }
  add('pins are not aliases', !Object.values(PINS).some((id) => id in INVENTORY.aliases),
    `aliases resolve and move; ${Object.keys(INVENTORY.aliases).join(', ')} are recorded as traps`);

  // --- the boards --------------------------------------------------------
  if (MODE === 'stub') {
    add('boards', true, 'stub mode builds its own board from the offline harness', false);
  } else {
    add('reference board', existsSync(REFERENCE_BOARD), REFERENCE_BOARD);
    add('three-register board', existsSync(THREE_REGISTER_BOARD), THREE_REGISTER_BOARD
      + (existsSync(THREE_REGISTER_BOARD) ? '' : ' — stage 2 will be CUT, not silently skipped'), false);
  }

  // --- the harness -------------------------------------------------------
  const fixtures = join(ROOT, 'runner', 'dist', '__tests__', 'fixtures', 'reference-sessions.js');
  add('build is current', existsSync(fixtures), 'runner/dist — run `npm run build` if this fails');

  const probe = scoreSession({ sections: [], closingNote: null, estimatedMinutes: 0, targetMinutes: 15 }, { topics: [] });
  add('eval harness has 18 hard checks', probe.hard.length === 18,
    `${probe.hard.length} hard checks — learner-action adds the non-vacuous floor`);

  // --- the baselines -----------------------------------------------------
  for (const [name, path] of Object.entries(BASELINE_PATHS)) {
    add(`baseline: ${name}`, existsSync(path), path + (existsSync(path) ? '' : ' — its column will read n/a'), false);
  }

  return checks;
}

const BASELINE_PATHS = {
  'floor-2026-08-20': join(ROOT, '.data-gemini', 'store.json'),
  'three-register-attempt-1': join(ROOT, 'artifacts', 'three_register', 'attempt1', 'store.json'),
};

// -------------------------------------------------------------------- deps

/** A fresh, isolated copy of a board. Every stage gets its own. */
function isolate(sourcePath, tag) {
  const dir = join(OUT_DIR, tag);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, 'store.json');
  copyFileSync(sourcePath, dest);
  return dest;
}

async function stubLlm() {
  // The offline convention the repo already uses: the nightly test harness's
  // scripted model, which answers every schema as a pure function of the prompt.
  // `eval-session.mjs` imports a test fixture the same way.
  const mod = await import('../runner/dist/__tests__/batch-harness.js');
  return mod;
}

/** A free-tier per-day 429, exactly as the provider sends it. */
const dayCapError = () => Object.assign(new Error(
  'gemini 429 RESOURCE_EXHAUSTED: Quota exceeded for metric: '
  + 'generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20'), {
  name: 'GeminiError', status: 429, providerStatus: 'RESOURCE_EXHAUSTED', retryable: true,
  quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
  exhaustedForPeriod: true,
  // The trap, reproduced faithfully: RetryInfo said 49s on a cap that does not
  // refill for hours. A sentinel that waits on this is the defect under test.
  retryAfterMs: 49_000,
});

/**
 * A provider capacity 503, exactly as it arrived on 2026-08-21 at 00:23 PT.
 *
 * Seventeen of these in a row, two minutes twelve seconds, no exhaustion signal
 * anywhere on the envelope — which is why nothing stopped. Reproduced field for
 * field so the breaker is tested against the thing that happened rather than
 * against a tidier version of it.
 */
const outageError = () => Object.assign(new Error(
  'gemini 503 UNAVAILABLE: This model is currently experiencing high demand. '
  + 'Spikes in demand are usually temporary. Please try again later.'), {
  name: 'GeminiError', status: 503, providerStatus: 'UNAVAILABLE', retryable: true,
});

/**
 * Wrap a stub model so the DEEP tier fails from the Nth call on.
 *
 * Neither abort rule can be proven by a run that never meets one, and neither
 * can be asked of the live service — a day cap costs the day to produce and an
 * outage cannot be requested at all. So both are proven here, mid-sequence, as
 * ordinary offline tests.
 *
 * The day cap fires once, at the Nth call; the outage is continuous from the
 * Nth call onward, because that is the difference between the two failures.
 */
function injectFailures(inner, { dayCapAt = 0, outageAt = 0, blipAt = 0 } = {}) {
  let deep = 0;
  const wrap = (method) => async (req) => {
    if (req?.tier === 'deep') {
      deep += 1;
      if (outageAt > 0 && deep >= outageAt) throw outageError();
      if (dayCapAt > 0 && deep >= dayCapAt) throw dayCapError();
      if (blipAt > 0 && deep === blipAt) throw outageError();
    }
    return inner[method](req);
  };
  return { modelId: inner.modelId, complete: wrap('complete'), structured: wrap('structured') };
}

// ------------------------------------------------------------------- stages

async function runBatchStage({ id, boardPath, ledger, llm, embedderKind }) {
  enterStage(ledger, id);
  const before = ledger.deepSpent;
  const meter = new UsageMeter();
  const enter = meter.enter.bind(meter);
  meter.enter = (s) => { ledger.stage = `${id}:${s}`; enter(s); };

  const partitionStrategy = partitionStrategyFrom(process.env.SB_PARTITION ?? 'd1');
  const store = new JsonStore(boardPath);
  const deps = {
    llm: meterLlm(llm, meter),
    // The embedding space is held fixed on purpose. There is no Gemini embedder,
    // and TF-IDF moves every topic boundary on the board — a run made that way
    // compares a DIFFERENT PARTITION against the V2 bar and reports the
    // difference as a model result.
    embedder: meterEmbedder(embedderKind.fine, meter),
    ...(partitionStrategy === 'd1' ? { coarseEmbedder: meterEmbedder(embedderKind.coarse, meter) } : {}),
    store,
    research: new LocalResearch(),
    clock: systemClock,
  };

  const t0 = Date.now();
  let result = null, threw = null;
  try {
    result = await runBatch(deps, {
      concurrency: Number(process.env.SB_CONCURRENCY ?? 3),
      usage: meter,
      partitionStrategy,
      onStage: (r) => say(`    ${r.failed ? '!' : ' '} ${r.stage.padEnd(11)} ${String((r.ms / 1000).toFixed(1)).padStart(6)}s  ${r.detail}`),
    });
  } catch (err) {
    threw = String(err).slice(0, 300);
    say(`    ! the run itself threw — ${threw}`);
  }

  const deep = ledger.deepSpent - before;
  const degraded = result?.reports.filter((r) => r.failed).length ?? 0;
  say(`    → ${deep} deep call(s), ${degraded} stage(s) degraded, ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);

  return {
    id, boardPath, deep, threw, degraded,
    status: ledger.tripped?.stage.startsWith(id) ? 'stopped-by-circuit-breaker'
      : ledger.deepExhausted && ledger.stoppedAt?.startsWith(id) ? 'stopped-by-day-cap'
        : threw ? 'threw' : 'ran',
    reports: result?.reports ?? [],
    withheld: result?.withheld ?? [],
    outcome: result?.session?.outcome ?? null,
    sections: result?.session?.sections.length ?? 0,
    usage: meter.report(new Date(t0).toISOString()),
  };
}

async function runCatchRate({ n, ledger, llm }) {
  enterStage(ledger, 'catch-rate');
  const before = ledger.deepSpent;
  const trials = [];
  for (let i = 0; i < n; i++) {
    if (ledger.tripped) {
      say(`    run ${i + 1}: CUT — the circuit breaker is open`);
      break;
    }
    if (ledger.deepExhausted) {
      say(`    run ${i + 1}: CUT — the deep tier is spent`);
      break;
    }
    const t0 = Date.now();
    try {
      const defects = await verify({ llm, clock: systemClock }, { ...CATCH_FIXTURE, tier: 'deep' });
      const blob = blobOf(defects);
      const caught = scoreCatch(blob);
      const fatal = defects.filter((d) => d.severity === 'fatal').length;
      say(`    run ${i + 1}  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${defects.length} defects`
        + ` (${fatal} fatal)  ground truth: ${caught.length}/4`);
      for (const [name, probe] of GROUND_TRUTH) say(`       ${probe(blob) ? 'OK  ' : 'MISS'} ${name}`);
      trials.push({ run: i + 1, defects: defects.length, fatal, caught, ms: Date.now() - t0 });
    } catch (err) {
      const why = err instanceof QuotaRefusal ? err.message : String(err).slice(0, 200);
      say(`    run ${i + 1}: FAILED — ${why}`);
      trials.push({ run: i + 1, failure: why });
    }
  }
  const scored = trials.filter((t) => !t.failure);
  const mean = scored.length ? scored.reduce((a, t) => a + t.caught.length, 0) / scored.length : null;
  if (scored.length) {
    say(`    → caught ${scored.map((t) => `${t.caught.length}/4`).join(', ')} — mean ${mean.toFixed(2)}/4 over n=${scored.length}`);
  }
  return { id: 'catch-rate', deep: ledger.deepSpent - before, n: scored.length, mean, trials, status: 'ran' };
}

/**
 * Stage 5 — the Reviewer R1 clause-2 re-check.
 *
 * R1 passed both clauses locally. The open question is narrower and real: the
 * anti-rewrite behaviour is *prompt text*, and a different model reads prompt
 * text differently, so six adversarial drafts on the deep tier would say whether
 * the fence holds off the local model. Lowest priority and cut first, because
 * nothing downstream is waiting on the answer.
 *
 * **It cannot run through this harness today, and that is a finding rather than
 * an omission.** `eval-reviewer-r1.mjs` constructs `new OllamaLlm()` itself and
 * has no seam to hand it a different model, and its leak / named-the-ask
 * detectors are module-local in a file that runs its whole eval on import — the
 * same shape as the fixture duplication this rerun just fixed. Re-implementing
 * those detectors here would produce a second scorer for one ground truth,
 * which is the exact defect, so it is not done.
 *
 * The probe below therefore costs zero deep calls and reports precisely what
 * would have to change. The harness belongs to the R1 lane; the one-line seam
 * is theirs to add.
 */
async function runReviewerR1({ ledger, plannedCalls }) {
  enterStage(ledger, 'reviewer-r1-clause2');
  const dir = REVIEWER_R1_HARNESS;
  const corpusPath = join(dir, 'reviewer-drafts.json');
  const evalPath = join(dir, 'eval-reviewer-r1.mjs');

  if (!existsSync(corpusPath) || !existsSync(evalPath)) {
    const note = `the R1 harness is not readable at ${dir}`;
    say(`    ! ${note}`);
    return { id: 'reviewer-r1-clause2', deep: 0, status: 'cut-no-harness', note };
  }

  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
  const adversarial = corpus.drafts.filter((d) => d.condition === 'adversarial');
  const src = readFileSync(evalPath, 'utf8');
  const modelSeam = /--llm|llmFactory|LLM_FACTORY|makeLlm/.test(src);

  say(`    ${adversarial.length} adversarial draft(s) in the corpus`
    + ` (${adversarial.map((d) => d.id).join(', ')})`);

  if (!modelSeam) {
    const note = 'the R1 harness builds `new OllamaLlm()` itself and exposes no seam for a different '
      + 'model; its leak and named-the-ask detectors are module-local in a file that runs its eval on '
      + 'import. Re-implementing them here would be a second scorer for one ground truth — the exact '
      + 'defect this rerun fixed elsewhere. NEXT QUOTA DAY: add an llm-factory seam to '
      + 'eval-reviewer-r1.mjs (R1 lane\'s file), then this stage is 6 deep calls.';
    say(`    ! CUT — no model seam in the harness. 0 deep calls spent.`);
    say(`      ${note}`);
    return {
      id: 'reviewer-r1-clause2', deep: 0, status: 'cut-no-model-seam', note,
      wouldHaveCost: plannedCalls, drafts: adversarial.map((d) => d.id),
    };
  }

  // The seam exists — a later lane added it. Hand the guarded model over.
  const note = 'the harness now exposes a model seam; run it directly with the guarded llm';
  say(`    the harness exposes a model seam — run it with: node ${evalPath} --arm post --repeat 1 --only ${adversarial.map((d) => d.id).join(',')}`);
  return { id: 'reviewer-r1-clause2', deep: 0, status: 'needs-manual-invocation', note };
}

// ------------------------------------------------------------------ scoring

/**
 * Score the latest session in a store — but only if THIS run built it.
 *
 * Every board carries the sessions it has already had: the reference board has
 * four, the aged three-register board has its attempts. A stage whose compose
 * degraded leaves the store's newest session untouched, and scoring that is
 * how a run reports a card for a session it did not produce. Caught in the
 * offline day-cap self-test, where a stage that composed nothing scored 15/17
 * off the seed nightly's session.
 *
 * `notBefore` is the stage's own start. `builtAt` is the honest clock for a
 * stored session and is what `eval-session.mjs` already reads.
 */
const cardOf = async (storePath, notBefore = null) => {
  if (!existsSync(storePath)) return null;
  const store = new JsonStore(storePath);
  const session = await store.latestSession();
  if (!session) return null;
  const builtAt = session.builtAt ? Date.parse(session.builtAt) : null;
  if (notBefore && (!builtAt || builtAt < Date.parse(notBefore))) {
    return { stale: true, builtAt: session.builtAt ?? null };
  }
  const board = await boardFromStore(store, new Date(session.builtAt ?? Date.now()));
  return { card: scoreSession(session, board), session, basis: basisOf(board) };
};

async function baselines() {
  const out = {};
  const mod = await import('../runner/dist/__tests__/fixtures/reference-sessions.js').catch(() => null);
  if (mod) {
    // The V2 fixture board carries no pins — that is why `no-verbatim-overquote`
    // skips on it — so it can only ever be scored register-only. This is the
    // cross-basis column and everything downstream has to say so.
    out['v2-bar'] = {
      card: scoreSession(mod.REFERENCE_V2.session, mod.REFERENCE_V2.board),
      basis: basisOf(mod.REFERENCE_V2.board),
    };
  }
  for (const [name, path] of Object.entries(BASELINE_PATHS)) {
    const c = await cardOf(path).catch(() => null);
    if (c) out[name] = c;
  }
  return out;
}

/** Per-check status change, per-proxy numeric delta. Skips are never passes. */
function deltas(card, base, basis = null, baseBasis = null) {
  if (!base) return null;
  const crossBasis = Boolean(basis && baseBasis && basis !== baseBasis);
  /**
   * The material-aware budget contract gave the scorer two budget bases, and a delta taken across them
   * is not a delta about the model.
   *
   * `issued` is what the Composer was actually given; `register-only` is the
   * register share alone, which is all a pinless board can support. Since
   * `issued ≤ register-only`, the same session scores a HIGHER `budget-fill`
   * on the issued basis and faces a TIGHTER cap on `word-budget` — measured at
   * 0.12 vs 0.44 on a board with a thin topic. So on a cross-basis column those
   * two rows carry the difference between two denominators as well as whatever
   * the model did, and the number is marked rather than silently reported.
   */
  const mark = (id, value) => (crossBasis && BASIS_SENSITIVE.has(id)
    ? `${value}  ⚠ cross-basis (${baseBasis} → ${basis})` : value);

  const byId = new Map(base.hard.map((c) => [c.id, c]));
  const hard = card.hard.map((c) => {
    const b = byId.get(c.id);
    return {
      name: c.id,
      base: b?.status ?? 'absent',
      now: c.status,
      crossBasis: crossBasis && BASIS_SENSITIVE.has(c.id),
      // A skipped check is never a pass, and the delta column says so in words
      // rather than in a symbol somebody has to remember the meaning of.
      delta: mark(c.id, !b ? 'new check — no baseline'
        : b.status === c.status ? '—'
          : c.status === 'pass' && b.status === 'fail' ? '+ fixed'
            : c.status === 'pass' && b.status === 'skipped' ? '+ now checkable'
              : c.status === 'fail' ? 'REGRESSION'
                : c.status === 'skipped' && b.status === 'pass' ? '− skipped, NOT passed'
                  : '?'),
    };
  });
  const baseProx = new Map((base.proxies ?? []).map((p) => [p.id, p.value]));
  const proxies = (card.proxies ?? []).map((p) => {
    const d = typeof p.value === 'number' && typeof baseProx.get(p.id) === 'number'
      ? Number((p.value - baseProx.get(p.id)).toFixed(3)) : null;
    return {
      name: p.id,
      base: baseProx.has(p.id) ? baseProx.get(p.id) : null,
      now: p.value,
      delta: d,
      crossBasis: crossBasis && BASIS_SENSITIVE.has(p.id),
      note: crossBasis && BASIS_SENSITIVE.has(p.id)
        ? `⚠ cross-basis: baseline ${baseBasis}, this run ${basis} — the difference is partly two denominators`
        : null,
    };
  });
  return { hard, proxies, basis, baseBasis, crossBasis };
}

// ------------------------------------------------------- comparability notes

/**
 * What at current HEAD makes a number NOT comparable to yesterday's.
 *
 * Computed rather than asserted where it can be, because a comparability note
 * that is written once and never re-derived is a note that goes stale silently.
 */
async function comparabilityNotes(threeRegisterBoard) {
  const notes = [];

  notes.push({
    what: 'the eval harness gained a 17th hard check',
    detail: 'The withheld-content contract added `closing-note-withheld`. Every check is addressed by name and nothing '
      + 'counts them, so check-for-check comparison against the 2026-08-20 card holds — but the '
      + 'TOTALS do not: "14 of 16" and "15 of 17" are not the same denominator, and no line may '
      + 'compare them as counts.',
    affects: 'hard-check totals',
  });

  notes.push({
    what: 'the closing note is now stripped of withheld sections',
    detail: 'The withheld-content contract also changed the product: `stripWithheldTopics` rewrites the note in the verify '
      + 'stage. On 2026-08-20 the shipped session carried a note describing two sections the learner '
      + 'never saw. The session CONTENT therefore differs at HEAD for the same model output, so '
      + '`session-words`, `closing-note` clause counts and anything derived from the note are not '
      + 'like-for-like. Pure function, no model call — it costs nothing in the ledger.',
    affects: 'session-words, closing-note, closing-note-withheld',
  });

  /**
   * The material-aware budget contract split the budget into two bases, and the delta columns straddle
   * them. Two distinct hazards, and neither is about the model.
   */
  notes.push({
    what: 'the V2-bar column compares two different budget denominators',
    detail: 'The material-aware budget contract made a section\'s budget `min(registerBudget, max(150, materialWords × 3.5))` and '
      + 'the scorer reconstructs it when the board carries pins — the `issued` basis. The V2 fixture '
      + 'board has NO pins (which is why `no-verbatim-overquote` skips on it), so it can only be scored '
      + '`register-only`. Since `issued ≤ register-only`, the same session scores a HIGHER `budget-fill` '
      + 'and faces a TIGHTER `word-budget` cap on the issued basis — measured at 0.12 register-only '
      + 'against 0.44 issued for identical output on a board with a thin topic. Those two rows in the '
      + 'V2 column therefore carry the difference between two denominators as well as whatever the model '
      + 'did. They are marked ⚠ in the tables. Every other row in that column is basis-independent.',
    affects: 'budget-fill and word-budget, in the v2-bar column only',
  });

  notes.push({
    what: 'the stored baselines are re-scored today and no longer match their published numbers',
    detail: 'The floor-2026-08-20 and three-register-attempt-1 columns are computed by scoring their '
      + 'stored sessions with TODAY\'s harness, so both sides of those deltas share the `issued` basis '
      + 'and the comparison is sound. But the sessions themselves were composed before material-aware budgeting '
      + 'register-only budgets, and re-scoring them against the reconstructed issued budget moves the '
      + 'number: a reader diffing this table against the published artefacts will find they disagree, '
      + 'and the published ones are not wrong. Trust the deltas here; do not quote either column as a '
      + 'correction to `GEMINI_BENCHMARK_2026-08-20.md` or `THREE_REGISTER_SESSION_2026-08-20.md`.',
    affects: 'budget-fill in the floor-2026-08-20 and three-register-attempt-1 columns',
  });

  notes.push({
    what: 'the material-aware budget contract changes what the Composer is asked for, not which agents are called',
    detail: 'A thin topic now gets a shorter section by construction. That moves session-words, '
      + 'budget-fill and duration-fill on any board carrying a topic with little material — and the '
      + 'three-register board has exactly one, which is the board the contract was written off. It does '
      + 'NOT move the deep-call ledger: the budget parameterises the brief, and the same seven agents '
      + 'are called in the same order at the same tiers. Re-derived rather than assumed.',
    affects: 'session-words, budget-fill, duration-fill — not the call count',
  });

  notes.push({
    what: 'main moved substantially between the two runs',
    detail: 'the associated fixes, the withheld-content filter, learn-now (1B), the toast widening (the capture-feedback contract), and the '
      + 'Gemma and ADK merges. The 2026-08-20 run benchmarked `bcfd827`; this one benchmarks current '
      + 'HEAD. Prompt-affecting changes move quality numbers independently of the model.',
    affects: 'every quality number',
  });

  notes.push({
    what: 'yesterday\'s deep tier was a substituted model',
    detail: 'Four of seven calls on 2026-08-20, including the Composer\'s, were made by '
      + '`gemini-3.5-flash-lite` wearing the deep tier\'s name. Every delta against that column is a '
      + 'FLOOR-to-real comparison, not a run-to-run one, and improvement against it is expected '
      + 'rather than informative.',
    affects: 'the floor-2026-08-20 column',
  });

  notes.push({
    what: 'three historical passes were vacuous under the earlier harness',
    detail: '`question-well-formed` and `question-restraint` still describe shape and restraint; '
      + 'the new `learner-action` check now fails a session with zero questions. '
      + '`duration-fits-budget` still passes at 1.5 minutes of 15 by under-filling. A deep-tier run that '
      + 'fills the budget and asks questions can score the same or worse on those three while being '
      + 'plainly better. Read the proxies.',
    affects: 'learner-action, question-well-formed, question-restraint, duration-fits-budget',
  });

  notes.push({
    what: 'the three-register stage scores against its own baseline',
    detail: 'Not the V2 bar. `THREE_REGISTER_SESSION_2026-08-20.md` attempt 1 is 15 pass / 0 fail / 2 skip '
      + 'with register-spread 0.667 on the aged board, and that is the number this stage moves. The bar '
      + 'for the flagship claim is one session shipping all three registers, which no local attempt '
      + 'reached: 3/3 composed, 2/3 shipped at best.',
    affects: 'the three-register-nightly stage',
  });

  notes.push({
    what: 'the embedding space is local in both runs',
    detail: 'There is no Gemini embedder. `nomic-embed-text` via Ollama, partition d1, in both runs — '
      + 'held fixed on purpose so only the LLM changed. It is also a real gap in the "two adapters, '
      + 'not a rewrite" claim and should stay named.',
    affects: 'nothing, by construction — recorded so it stays that way',
  });

  /**
   * Computed, not asserted: how far apart the two bases actually are TODAY, on
   * the two boards this run compares against.
   *
   * The prose above quotes 0.12 vs 0.44 from the thin-board benchmark's thin board. This
   * measures the same divergence on the real baselines by scoring each stored
   * session twice — once with its pins, once without — which is exactly the
   * `issued` / `register-only` switch. If the two agree, the caveat is
   * theoretical on these boards and the note says so.
   */
  for (const [name, path] of Object.entries(BASELINE_PATHS)) {
    if (!existsSync(path)) continue;
    try {
      const store = new JsonStore(path);
      const session = await store.latestSession();
      if (!session) continue;
      const board = await boardFromStore(store, new Date(session.builtAt ?? Date.now()));
      const fill = (b) => scoreSession(session, b).proxies.find((p) => p.id === 'budget-fill')?.value;
      const issued = fill(board);
      const registerOnly = fill({ ...board, pins: undefined });
      const gap = Math.abs((issued ?? 0) - (registerOnly ?? 0));
      notes.push({
        what: `budget-basis divergence measured on ${name}`,
        detail: `budget-fill scores ${registerOnly} register-only and ${issued} issued on this board `
          + `— a gap of ${gap.toFixed(3)}. `
          + (gap >= 0.05
            ? 'Large enough that a cross-basis delta on this metric says more about which denominator '
              + 'was used than about the model.'
            : 'Small enough that the basis is not doing much work on this board — the caveat still '
              + 'stands, but the number is not being carried by it.'),
        affects: 'budget-fill',
        computed: true,
      });
    } catch { /* a baseline that will not score is already reported as n/a */ }
  }

  // Computed, not asserted: does the aged board still derive three registers?
  if (existsSync(threeRegisterBoard)) {
    try {
      const store = new JsonStore(threeRegisterBoard);
      const topics = await store.listTopics();
      const signals = await store.listSignals();
      const now = new Date();
      const registers = new Set(topics.map((t) => registerFor(computeComfort(t.id, signals, now))));
      notes.push({
        what: 'the aged board still spans the registers it was built to span',
        detail: `derived from the board as it stands: ${[...registers].sort().join(', ')} `
          + `(${registers.size} distinct across ${topics.length} topics). `
          + (registers.size >= 3
            ? 'Three registers are still reachable, so the stage is comparable to attempt 1.'
            : 'FEWER THAN THREE — prior runs have moved the ledger. Re-seed before reading this stage '
              + 'as a repeat of attempt 1: `node scripts/seed-three-register.mjs` on the evidence branch.'),
        affects: 'the three-register-nightly stage',
        computed: true,
      });
    } catch (err) {
      notes.push({ what: 'the aged board could not be read', detail: String(err).slice(0, 200), affects: 'stage 2' });
    }
  }

  return notes;
}

// --------------------------------------------------------------------- main

mkdirSync(OUT_DIR, { recursive: true });

say(`VIRGIL — deep-tier Gemini benchmark`);
say(`  mode ${MODE} · fast=${PINS.fast} · deep=${PINS.deep} (pinned, never aliased)`);
say(`  out  ${OUT_DIR}`);
say('');

// ---- preflight -------------------------------------------------------------
say('PREFLIGHT — offline; no request is made here, deliberately');
const checks = await preflight();
for (const c of checks) say(`  ${c.ok ? 'ok  ' : c.fatal ? 'FAIL' : 'warn'}  ${c.name.padEnd(34)} ${c.detail}`);
const fatal = checks.filter((c) => !c.ok && c.fatal);
say('');
if (fatal.length) {
  say(`preflight refused: ${fatal.length} blocking problem(s). Nothing was called.`);
  writeFileSync(join(OUT_DIR, 'preflight-failed.txt'), lines.join('\n'));
  process.exit(2);
}

// ---- the board shapes and the ledger --------------------------------------
let referenceSource = REFERENCE_BOARD;
let threeRegisterSource = THREE_REGISTER_BOARD;
let embedderKind = { fine: new OllamaEmbedder(), coarse: new TfIdfEmbedder() };
let baseLlm = null;
let harness = null;

if (MODE === 'stub') {
  harness = await stubLlm();
  embedderKind = { fine: harness.groupEmbedder(), coarse: harness.groupEmbedder('stub-coarse') };
  // Build a warm board once, with an UNGUARDED model: constructing the board is
  // not part of the benchmark and must not be billed to it.
  const seedDir = mkdtempSync(join(tmpdir(), 'virgil-deep-stub-'));
  const seedPath = join(seedDir, 'store.json');
  const seedStore = new JsonStore(seedPath);
  for (const pin of harness.generateBoard(21, 7)) await seedStore.putPin(pin);
  await runBatch({
    llm: new harness.ScriptedLlm(), embedder: embedderKind.fine, coarseEmbedder: embedderKind.coarse,
    store: seedStore, research: new LocalResearch(), clock: systemClock,
  }, { concurrency: 3, partitionStrategy: 'd1' });
  referenceSource = seedPath;
  threeRegisterSource = seedPath;
  baseLlm = injectFailures(new harness.ScriptedLlm(), {
    dayCapAt: STUB_DAYCAP_AT, outageAt: STUB_OUTAGE_AT, blipAt: STUB_BLIP_AT,
  });
  say(`stub board built at ${seedPath}`
    + (STUB_DAYCAP_AT > 0 ? ` · a day cap will be injected on deep call #${STUB_DAYCAP_AT}` : '')
    + (STUB_OUTAGE_AT > 0 ? ` · a provider outage will be injected from deep call #${STUB_OUTAGE_AT}` : '')
    + (STUB_BLIP_AT > 0 ? ` · a single 503 will be injected on deep call #${STUB_BLIP_AT}` : ''));
  say('');
} else if (MODE === 'live') {
  const { GeminiLlm } = await import('../adapters/dist/gemini-llm.js');
  baseLlm = new GeminiLlm({ tiers: PINS });
}

const shapeOf = async (path) => (existsSync(path) ? boardShape(new JsonStore(path)) : null);
const referenceShape = await shapeOf(referenceSource);
const threeRegisterShape = await shapeOf(threeRegisterSource);

if (!referenceShape) {
  say(`no reference board at ${referenceSource} — nothing to plan. Stopped before any call.`);
  process.exit(2);
}

const plan = planStages({
  dayCap: DAY_CAP, reserve: RESERVE, catchRateMin: CATCH_RATE_MIN, catchRateMax: CATCH_RATE_MAX,
  reference: referenceShape,
  threeRegister: threeRegisterShape ?? referenceShape,
});

say(renderPlan(plan));
say('');
say('  board shapes the count was read off:');
for (const [name, s] of Object.entries({ reference: referenceShape, 'three-register': threeRegisterShape })) {
  if (!s) { say(`    ${name.padEnd(15)} absent`); continue; }
  const n = nightlyCalls(s);
  say(`    ${name.padEnd(15)} ${s.pins} pins (${s.unenrichedPins} unenriched) · ${s.activeTopics} topics`
    + ` · ${s.teachableTopics} teachable · ${s.targetMinutes}min → ${n.sections} section(s)`);
}
say('');

if (!threeRegisterShape) {
  say('  NOTE: the three-register board is absent, so stage 2 is CUT. It is not silently skipped:');
  say(`        expected at ${THREE_REGISTER_BOARD} (branch evidence/three-register, not merged).`);
  say('');
}

if (MODE === 'dry-run') {
  writeFileSync(join(OUT_DIR, 'plan.json'), `${JSON.stringify({ plan, referenceShape, threeRegisterShape }, null, 2)}\n`);
  writeFileSync(join(OUT_DIR, 'plan.txt'), `${lines.join('\n')}\n`);
  say('dry run — no model was called, by any tier. Plan written; nothing was spent.');
  process.exit(0);
}

// ---- execute ---------------------------------------------------------------
const ledger = makeLedger({ dayCap: DAY_CAP, reserve: RESERVE });
const llm = guard(baseLlm, ledger, {
  onEvent: (e) => {
    if (e.kind === 'exhausted') say(`  !! ${e.tier.toUpperCase()} TIER STOPPED at ${e.stage} — ${e.note}`);
    if (e.kind === 'tripped') {
      say(`  !! CIRCUIT BREAKER at ${e.stage} — ${e.count} identical ${e.signature} failure(s) in a row`);
      say(`     on the ${e.tier} tier. The run stops issuing requests, by every tier, now (the quota-accounting contract).`);
    }
    if (e.kind === 'refused') say(`  ·· refused before the wire (${e.reason}) at ${e.stage}`);
    if (e.kind === 'waiting') say(`  ·· per-minute cap at ${e.stage}, waiting ${e.ms}ms as the provider asked`);
    if (e.kind === 'wait-too-long') say(`  ·· provider asked for ${e.ms}ms — longer than the run will hold; degrading`);
  },
});

const actual = {};
const startedAt = new Date().toISOString();

// Stage 0 — the LIVE model re-check. The first real call, on purpose.
if (MODE === 'live') {
  say('STAGE 0 — live ListModels (the run\'s first real call; a recorded fixture cannot catch a moved pin)');
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    const live = new Set(((await r.json()).models ?? []).map((m) => m.name.replace(/^models\//, '')));
    for (const [tier, id] of Object.entries(PINS)) {
      const ok = live.has(id);
      say(`  ${ok ? 'ok  ' : 'FAIL'}  ${tier} pin ${id} ${ok ? 'still resolves live' : 'IS NO LONGER LISTED'}`);
      if (!ok) { say('  a moved pin invalidates every comparison. Stopped before spending the deep tier.'); process.exit(3); }
    }
    actual['listmodels'] = { deep: 0, status: 'ran', note: `${live.size} models listed; both pins resolve` };
  } catch (err) {
    say(`  ! ListModels failed — ${String(err).slice(0, 200)}`);
    say('  this is a transport fact, not a quota fact; continuing, and the artefact says so.');
    actual['listmodels'] = { deep: 0, status: 'failed', note: String(err).slice(0, 200) };
  }
  say('');
}

const boardFor = { 'reference-nightly': referenceSource, 'three-register-nightly': threeRegisterSource };
const stageStores = {};
/** When each stage began, so scoring can refuse a session the stage did not build. */
const stageStartedAt = {};

for (const s of plan.stages) {
  if (s.cut) {
    say(`STAGE ${s.id} — CUT AT PLAN: ${s.cutReason}`);
    actual[s.id] = { deep: 0, status: 'cut-at-plan', note: s.cutReason };
    say('');
    continue;
  }
  /**
   * Two different reasons to stop, kept apart on purpose.
   *
   * A cap means come back tomorrow; an outage means come back in an hour and
   * the day's allowance is probably still there. A harness that collapsed them
   * would send somebody to wait for a quota reset that was never the problem.
   */
  if (ledger.tripped) {
    say(`STAGE ${s.id} — CUT: the circuit breaker is open. Not attempted.`);
    actual[s.id] = {
      deep: 0, status: 'cut-circuit-breaker',
      note: `${ledger.tripped.count} identical ${ledger.tripped.signature} failure(s) in a row`
        + ` at "${ledger.tripped.stage}" — the run stopped issuing requests (the quota-accounting contract)`,
    };
    say('');
    continue;
  }
  if (ledger.deepExhausted) {
    say(`STAGE ${s.id} — CUT: the deep tier is spent. Not attempted.`);
    actual[s.id] = { deep: 0, status: 'cut-day-cap', note: 'the deep tier was stopped by a daily cap in an earlier stage' };
    say('');
    continue;
  }

  say(`STAGE ${s.id} — ${s.what} (planned ${s.plannedCalls} deep, ${deepRemaining(ledger)} left of ${DAY_CAP})`);

  if (s.kind === 'catch-rate') {
    // Savings from the two nightlies go here, before the
    // reserve is touched. The plan allocated on `expected`; this is where what
    // actually happened turns into trials.
    //
    // The quota-accounting contract amends it: only budget an earlier stage genuinely did not need
    // may be absorbed. On 2026-08-21 two nightlies that had failed their way to
    // a smaller bill re-sized this stage UP, from 7 trials to 8, and bought an
    // extra trial against a provider that was answering nothing.
    const freed = failureFreed(plan, actual, s.id);
    const sized = resizeCatchRate({
      planned: s.plannedCalls, allocatable: deepAllocatable(ledger), failureFreed: freed,
      min: plan.catchRateMin, max: plan.catchRateMax,
    });
    if (freed > 0) {
      say(`    ${freed} call(s) went unspent because earlier stages FAILED, not because they needed`);
      say(`      fewer. That budget is not absorbed here (the quota-accounting contract) and stays unspent.`);
    }
    if (sized.delta !== 0) say(`    n re-sized ${s.plannedCalls} → ${sized.n}: ${sized.why}`);
    if (sized.belowFloor) {
      say(`    ! below the ruled floor of ${plan.catchRateMin} trials. The reserve is hard and was not`);
      say(`      touched; fewer trials is the honest answer and the artefact records n.`);
    }
    actual[s.id] = { ...(await runCatchRate({ n: sized.n, ledger, llm })), resized: sized };
  } else if (s.id === 'reviewer-r1-clause2') {
    actual[s.id] = await runReviewerR1({ ledger, plannedCalls: s.plannedCalls });
  } else {
    const src = boardFor[s.id];
    if (!src || !existsSync(src)) {
      say(`    ! no board at ${src} — stage cut`);
      actual[s.id] = { deep: 0, status: 'cut-no-board', note: `no board at ${src}` };
      say('');
      continue;
    }
    const boardPath = isolate(src, s.id);
    stageStores[s.id] = boardPath;
    stageStartedAt[s.id] = new Date().toISOString();
    actual[s.id] = await runBatchStage({ id: s.id, boardPath, ledger, llm, embedderKind });
  }
  say('');
}

// ---- reconcile -------------------------------------------------------------
const rec = reconcile(plan, actual, ledger);
say(renderReconciliation(rec));
const aborted = abortNote(ledger);
if (aborted) { say(''); say(`  ${aborted}`); }
say('');

// ---- score -----------------------------------------------------------------
say('SCORING — 18 hard checks, against three baselines');
const base = await baselines();
const scored = {};
for (const [id, path] of Object.entries(stageStores)) {
  const c = await cardOf(path, stageStartedAt[id]).catch(() => null);
  if (!c) { say(`  ${id.padEnd(26)} no session in the store — nothing to score`); continue; }
  if (c.stale) {
    // Not a card. A stage that composed nothing has no session, and the
    // newest one in the store belongs to a run that is not this one.
    say(`  ${id.padEnd(26)} NO SESSION FROM THIS RUN — the newest in the store was built ${c.builtAt},`);
    say(`  ${''.padEnd(26)} before this stage started. The stage degraded; it is not scored, and a`);
    say(`  ${''.padEnd(26)} scorecard from the board's previous session would have been a lie.`);
    scored[id] = { noSession: true, staleBuiltAt: c.builtAt };
    continue;
  }
  const against = id === 'three-register-nightly'
    ? ['three-register-attempt-1', 'v2-bar']
    : ['v2-bar', 'floor-2026-08-20'];
  scored[id] = {
    card: c.card,
    passed: c.card.passed,
    hard: {
      pass: c.card.hard.filter((x) => x.status === 'pass').length,
      fail: c.card.hard.filter((x) => x.status === 'fail').length,
      skip: c.card.hard.filter((x) => x.status === 'skipped').length,
    },
    basis: c.basis,
    deltas: Object.fromEntries(against.map((b) =>
      [b, deltas(c.card, base[b]?.card, c.basis, base[b]?.basis)])),
  };
  const h = scored[id].hard;
  say(`  ${id.padEnd(26)} ${h.pass} pass / ${h.fail} fail / ${h.skip} skip of 17`
    + `  [budget basis: ${c.basis}]`
    + `  — compared against ${against.filter((b) => base[b]).join(', ') || 'nothing available'}`);
  for (const [b, d] of Object.entries(scored[id].deltas)) {
    if (d?.crossBasis) {
      say(`  ${''.padEnd(26)} ! vs ${b}: budget basis differs (${d.baseBasis} → ${d.basis}).`
        + ` budget-fill and word-budget are marked cross-basis.`);
    }
  }
}
say('');

const notes = await comparabilityNotes(threeRegisterSource);
say('COMPARABILITY — what at HEAD is not like-for-like');
for (const n of notes) say(`  · ${n.what}${n.computed ? ' [computed]' : ''}`);
say('');

// ---- write -----------------------------------------------------------------
/**
 * The LOCAL date, not the UTC one.
 *
 * The quota day rolls at midnight US-Pacific and the operator running this is
 * looking at a local clock. A run started at 00:40 AEST on the 21st has a UTC
 * date of the 20th, and an artefact called `..._2026-08-20.md` sitting next to
 * yesterday's `GEMINI_BENCHMARK_2026-08-20.md` is a filing error waiting to be
 * read as a second version of the same run. `--stamp` overrides.
 */
const stamp = val('stamp', new Date().toLocaleDateString('en-CA'));

/**
 * What this run WAS, in one greppable word.
 *
 * A run stopped by an outage produced no quality numbers and must not be read
 * as one that did. The distinction has to survive into the artefact and into
 * the exit code, because the thing that reads it next may be a cron line.
 */
const outcome = ledger.tripped ? OUTCOME_CIRCUIT_BREAKER : 'completed';
say(`OUTCOME — ${outcome}`);
if (ledger.tripped) {
  say(`  the breaker opened after ${BREAKER_THRESHOLD} identical failures; ${ledger.deepSpent} deep`);
  say(`  request(s) were attempted and ${ledger.deepBilled} are presumed billed (the quota-accounting contract).`);
}
say('');

const results = {
  startedAt, finishedAt: new Date().toISOString(), stamp, mode: MODE, pins: PINS, outcome,
  plan, actual, reconciliation: rec, ledger: {
    dayCap: ledger.dayCap, reserve: ledger.reserve,
    deepSpent: ledger.deepSpent, fastSpent: ledger.fastSpent,
    deepBilled: ledger.deepBilled, fastBilled: ledger.fastBilled, unbilled: ledger.unbilled,
    deepExhausted: ledger.deepExhausted, stoppedAt: ledger.stoppedAt,
    breaker: ledger.breaker, tripped: ledger.tripped,
    refusals: ledger.refusals, attempts: ledger.attempts,
  },
  abortNote: aborted, scored, comparability: notes, preflight: checks,
};
const jsonPath = join(OUT_DIR, `deep-benchmark-${stamp}.json`);
const mdPath = join(OUT_DIR, `GEMINI_BENCHMARK_DEEP_${stamp}.md`);
writeFileSync(jsonPath, `${JSON.stringify(results, null, 2)}\n`);
writeFileSync(mdPath, renderMarkdown(results));
writeFileSync(join(OUT_DIR, `deep-benchmark-${stamp}.log`), `${lines.join('\n')}\n`);

log(`\nwritten:\n  ${mdPath}   ← ready for promotion to Projects/virgil/artifacts/\n  ${jsonPath}`);
log(`\ndeep tier: ${ledger.deepSpent} attempted, ${ledger.deepBilled} presumed billed,`
  + ` ${deepRemaining(ledger)} remaining, reserve ${ledger.reserve} ${rec.reserveIntact ? 'intact' : 'BREACHED'}`);

/**
 * The exit code, set rather than taken.
 *
 * `process.exit()` does not wait for a pending write and the last two lines are
 * the two the run is read for — the same defect `runner/src/cli.ts` documents.
 * Nothing runs after this, so setting the code and letting the process end on
 * its own is both correct and enough.
 *
 * The code is distinct from preflight's 2 and the moved-pin 3 because they are
 * different instructions to whoever is waiting: 2 means fix the machine, 3
 * means the comparison is void, and this one means the provider was not
 * answering and the run is worth repeating at a quieter hour.
 */
if (outcome === OUTCOME_CIRCUIT_BREAKER) {
  log(`\n${OUTCOME_CIRCUIT_BREAKER}: ${aborted}`);
  process.exitCode = EXIT_CIRCUIT_BREAKER;
}

function renderMarkdown(r) {
  const o = [];
  o.push(`# Virgil — deep-tier Gemini benchmark`);
  o.push('');
  o.push(`**Date:** ${r.stamp} · **Mode:** ${r.mode} · **Outcome:** \`${r.outcome}\``);
  o.push(`**Scope:** this Gemini run is limited to benchmark validation.`);
  o.push(`**Pins:** fast \`${r.pins.fast}\` · deep \`${r.pins.deep}\` (never aliased)`);
  o.push('');
  o.push(`> Generated by \`scripts/benchmark-deep.mjs\`; the measured tables are source data.`);
  o.push('');
  if (r.outcome === OUTCOME_CIRCUIT_BREAKER) {
    // Said at the top, before anything that looks like a result. A reader who
    // reaches §2 without knowing this is reading a scorecard from a run that
    // never got an answer out of the provider.
    o.push(`> **THIS RUN WAS ABORTED — \`${OUTCOME_CIRCUIT_BREAKER}\`.** The circuit breaker`);
    o.push(`> opened after ${r.ledger.breaker} identical failures and no further request was issued.`);
    o.push(`> Nothing below is a quality measurement of \`${r.pins.deep}\`: it is an account of`);
    o.push(`> what was attempted and what it cost. See §1 for the ledger and the abort reason.`);
    o.push('');
  }
  o.push('## 1. The deep-tier ledger');
  o.push('');
  o.push('```');
  o.push(renderPlan(r.plan));
  o.push('```');
  o.push('');
  o.push('```');
  o.push(renderReconciliation(r.reconciliation));
  o.push('```');
  if (r.abortNote) { o.push(''); o.push(`**${r.abortNote}**`); }
  o.push('');
  const deepAttempts = r.ledger.attempts.filter((a) => a.tier === 'deep');
  const retried = deepAttempts.filter((a) => a.retried).length;
  o.push(`Ladder note: a logical call is one request while the structured reply conforms and up to `
    + `${LADDER_RUNGS} when it does not. ${deepAttempts.length} deep request(s) and `
    + `${r.ledger.attempts.length - deepAttempts.length} fast request(s) were issued; `
    + `${retried} deep request(s) were a per-minute-cap retry. On 2026-08-20 the ladder conformed `
    + `7/7 and 7 logical calls cost exactly 7 requests.`);
  o.push('');
  o.push('## 2. Per-check deltas');
  for (const [id, s] of Object.entries(r.scored)) {
    o.push('');
    if (s.noSession) {
      o.push(`### ${id} — NOT SCORED`);
      o.push('');
      o.push(`This stage built no session. The newest session in its board was written `
        + `${s.staleBuiltAt ?? 'at an unknown time'}, before the stage started, so it belongs to an `
        + `earlier run. It is deliberately not scored: a card taken from the board's previous session `
        + `would report a night that did not happen.`);
      continue;
    }
    o.push(`### ${id} — ${s.hard.pass} pass / ${s.hard.fail} fail / ${s.hard.skip} skip of 17`);
    o.push('');
    o.push(`Budget basis: \`${s.basis}\` (the material-aware budget contract).`);
    for (const [baseName, d] of Object.entries(s.deltas)) {
      if (!d) { o.push(''); o.push(`*No \`${baseName}\` baseline was readable; that column is n/a.*`); continue; }
      o.push('');
      o.push(`**vs ${baseName}** — budget basis: baseline \`${d.baseBasis ?? '?'}\`, this run \`${d.basis ?? '?'}\``
        + (d.crossBasis ? ' — **CROSS-BASIS**, see §3' : ''));
      o.push('');
      o.push('| check | baseline | this run | |');
      o.push('|---|---|---|---|');
      for (const c of d.hard) o.push(`| ${c.name}${c.crossBasis ? ' ⚠' : ''} | ${c.base} | ${c.now} | ${c.delta} |`);
      o.push('');
      o.push('| proxy | baseline | this run | delta | |');
      o.push('|---|---|---|---|---|');
      for (const p of d.proxies) {
        o.push(`| ${p.name}${p.crossBasis ? ' ⚠' : ''} | ${p.base ?? '—'} | ${p.now} | ${p.delta ?? '—'} | ${p.note ?? ''} |`);
      }
    }
  }
  o.push('');
  o.push('## 3. Comparability — what is not like-for-like');
  o.push('');
  for (const n of r.comparability) {
    o.push(`**${n.what}**${n.computed ? ' *(computed from the board, not asserted)*' : ''}`);
    o.push('');
    o.push(n.detail);
    o.push('');
    o.push(`*Affects:* ${n.affects}`);
    o.push('');
  }
  o.push('## 4. Preflight');
  o.push('');
  o.push('| check | | detail |');
  o.push('|---|---|---|');
  for (const c of r.preflight) o.push(`| ${c.name} | ${c.ok ? 'ok' : c.fatal ? 'FAIL' : 'warn'} | ${c.detail} |`);
  o.push('');
  return `${o.join('\n')}\n`;
}
