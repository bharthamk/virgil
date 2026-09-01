/**
 * The nightly, run against Gemini, with every HTTP request counted.
 *
 * The model-benchmark boundary: Gemini is used here for benchmarking. Dev and testing stay on
 * Sonnet and Luna; runs like this one exist to find out whether the product
 * performs as expected before anything public leans on it.
 *
 * This lives in `scripts/` and not in any workspace `src` on purpose. `seam-purity.test.ts`
 * fails on the token `GeminiLlm` anywhere under `core/ adapters/ runner/ extension/`
 * except the two composition roots and the adapter itself,
 * because which provider the product runs on is a composition-root decision in
 * release configuration, and a benchmark harness is not that
 * commit. Nothing here is wired into the shipped roots.
 *
 *   node scripts/gemini-benchmark.mjs survey    # 1 deep call: the edge count
 *   node scripts/gemini-benchmark.mjs nightly   # the full run
 *
 * Env: SB_DB (isolate it — `.data-gemini/store.json`), GEMINI_API_KEY.
 * The key is read by the adapter from the environment and is never printed,
 * logged or written to any artefact by this file: `fetch` is wrapped below and
 * records the URL and the status, never the headers.
 *
 * Latency figures it prints are this Mac talking to Google over whatever this
 * connection is today. They are a ballpark for a human, never a measurement of
 * the model, and the usage report deliberately excludes them for that reason.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { systemClock, partitionStrategyFrom, survey, verify } from '../core/dist/index.js';
import { OllamaEmbedder, TfIdfEmbedder, JsonStore, LocalResearch } from '../adapters/dist/index.js';
import { GeminiLlm, GEMINI_TIERS } from '../adapters/dist/gemini-llm.js';
import { runBatch } from '../runner/dist/pipeline.js';
import { UsageMeter, meterLlm, meterEmbedder, formatUsage } from '../runner/dist/usage.js';
import { CATCH_FIXTURE, GROUND_TRUTH, blobOf, score } from './verifier-catch-fixture.mjs';

const DB = process.env.SB_DB ?? '.data-gemini/store.json';
mkdirSync(dirname(DB), { recursive: true });

// ------------------------------------------------- every request, as it happens

/**
 * Request accounting at the transport, not at the port.
 *
 * `UsageMeter` counts what came back from a call that SUCCEEDED, which is the
 * right instrument for a cost model and the wrong one for a quota: the free
 * tier bills attempts. A structured call is a three-rung ladder and a 429 is an
 * attempt that never reaches the meter, so the only honest count of "requests
 * spent today" is taken here.
 */
const requests = [];
let stage = 'boot';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.includes('generativelanguage.googleapis.com')) return realFetch(url, init);
  const model = /\/models\/([^:]+):/.exec(u)?.[1] ?? '?';
  const t = Date.now();
  try {
    const r = await realFetch(url, init);
    requests.push({ stage, model, status: r.status, ms: Date.now() - t });
    process.stderr.write(`      · ${model} ${r.status} ${((Date.now() - t) / 1000).toFixed(1)}s\n`);
    return r;
  } catch (err) {
    requests.push({ stage, model, status: 'transport', ms: Date.now() - t, error: String(err).slice(0, 120) });
    throw err;
  }
};

const meter = new UsageMeter();
const enter = meter.enter.bind(meter);
meter.enter = (s) => { stage = s; enter(s); };

/**
 * `--fast-tier-only` maps BOTH tiers onto `gemini-3.5-flash-lite`.
 *
 * Not a configuration anybody should ship: the contract has an assertion whose
 * whole point is that an adapter mapping both tiers onto one model silently
 * deletes the cost model, and it is right. It exists here for one situation,
 * which is the one this benchmark met — the deep tier's free-tier DAILY cap is
 * spent, so the alternative to substituting the model is measuring nothing at
 * all. Any run made this way is a transport proof and a quality FLOOR. It is
 * not a reading of the deep tier and every number it produces has to say so.
 */
const FAST_ONLY = process.argv.includes('--fast-tier-only');
const tiers = FAST_ONLY ? { fast: GEMINI_TIERS.fast, deep: GEMINI_TIERS.fast } : GEMINI_TIERS;

const partitionStrategy = partitionStrategyFrom(process.env.SB_PARTITION);
const deps = {
  llm: meterLlm(new GeminiLlm({ tiers }), meter),
  // The embedding space stays local and unchanged. There is no Gemini embedder,
  // and swapping in TF-IDF would move every topic boundary on the board — the
  // benchmark would then be comparing a different partition against the V2 bar
  // and calling the difference a model result.
  embedder: meterEmbedder(new OllamaEmbedder(), meter),
  ...(partitionStrategy === 'd1' ? { coarseEmbedder: meterEmbedder(new TfIdfEmbedder(), meter) } : {}),
  store: new JsonStore(DB),
  research: new LocalResearch(),
  clock: systemClock,
};

const spend = () => {
  const byModel = {};
  for (const r of requests) {
    const k = `${r.model} ${r.status}`;
    byModel[k] = (byModel[k] ?? 0) + 1;
  }
  return byModel;
};

const finish = (startedAt, extra = {}) => {
  const usage = meter.report(startedAt);
  const log = { startedAt, models: tiers, fastTierOnly: FAST_ONLY, requests, spend: spend(), usage, ...extra };
  const path = join(dirname(DB), `gemini-run-${startedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(path, `${JSON.stringify(log, null, 2)}\n`);
  console.log(`\nrequests issued: ${requests.length}`);
  for (const [k, n] of Object.entries(spend())) console.log(`  ${k.padEnd(34)} ${n}`);
  console.log(`\n${formatUsage(usage)}`);
  console.log(`  run log written to ${path}`);
};

const cmd = process.argv[2] ?? 'nightly';
const startedAt = new Date().toISOString();
console.log(`models: fast=${tiers.fast} deep=${tiers.deep} · store=${DB} · ${cmd}`
  + (FAST_ONLY ? '  [DEEP TIER SUBSTITUTED — quality floor only]' : '') + '\n');

if (cmd === 'survey') {
  // The cheapest question worth asking: one deep call, and it settles the
  // Surveyor edge count the Flash probe left open (3 edges against a frontier
  // 15) — measured through the real agent and the real adapter this time,
  // rather than by pasting the prompt into an IDE.
  stage = 'survey';
  const topics = await deps.store.listTopics();
  const t = Date.now();
  let edges = [];
  let failure = null;
  try {
    edges = await survey(deps, { topics });
  } catch (err) {
    failure = String(err).slice(0, 400);
    console.log(`  ! survey FAILED — ${failure}`);
    if (err && typeof err === 'object') {
      console.log(`    retryAfterMs=${err.retryAfterMs} quotaId=${err.quotaId} exhaustedForPeriod=${err.exhaustedForPeriod}`);
    }
  }
  console.log(`  survey  ${((Date.now() - t) / 1000).toFixed(1)}s  ${edges.length} prerequisite edges over ${topics.length} topics`);
  for (const e of edges) {
    const label = (id) => topics.find((x) => x.id === id)?.label ?? id;
    console.log(`    ${label(e.from)} -> ${label(e.to)}  (${e.confidence}) ${e.justification}`);
  }
  finish(startedAt, { topics: topics.length, edges, failure });

} else if (cmd === 'nightly') {
  const t0 = Date.now();
  const result = await runBatch(deps, {
    concurrency: Number(process.env.SB_CONCURRENCY ?? 3),
    usage: meter,
    partitionStrategy,
    onStage: (r) => console.log(`  ${r.failed ? '!' : ' '} ${r.stage.padEnd(10)} ${String((r.ms / 1000).toFixed(1)).padStart(6)}s  ${r.detail}`),
  });
  const degraded = result.reports.filter((r) => r.failed);
  const built = Boolean(result.session?.outcome === 'composed' && result.session.sections.length);
  console.log(`\nnightly complete in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`
    + (degraded.length ? ` — ${degraded.length} stage(s) degraded` : '')
    + (built ? '' : ' — NO SESSION BUILT'));
  for (const w of result.withheld) {
    console.log(`\n  WITHHELD (${w.reason}): ${w.heading}`);
    if (w.reason === 'unverified') console.log(`    the verifier call failed — ${w.error ?? 'no detail'}`);
    for (const d of w.defects) console.log(`    [${d.kind}] ${d.problem}`);
  }
  if (result.session?.outcome === 'composed') {
    console.log(`\nSession — ${result.session.sections.length} sections, ~${Math.round(result.session.estimatedMinutes)} min`);
    for (const s of result.session.sections) {
      console.log(`  [${s.depth}] ${s.heading}  (~${s.estimatedMinutes.toFixed(1)}min${s.mediumWarning ? ', MEDIUM WARNING' : ''})`);
    }
  }
  finish(startedAt, {
    reports: result.reports,
    withheld: result.withheld,
    outcome: result.session?.outcome ?? null,
  });

} else if (cmd === 'verifier') {
  /**
   * Sheet item 17 — the catch rate, on live Gemini.
   *
   * The fixture is the defective section that actually shipped in
   * REFERENCE_SESSION v1, with four independently confirmed fatal defects and a
   * keyword probe for each. It is now IMPORTED from
   * `scripts/verifier-catch-fixture.mjs`, which is the fix for the drift hazard
   * this file's earlier copy created: the local qwen number, the flash-lite
   * number and the deep-tier number answer sheet item 17 only while all three
   * were measured against the same object.
   *
   * `n` is the run count: each run extends the sample. A single verifier run is
   * a coin toss reported as a percentage.
   */
  const n = Number(process.argv.find((a) => a.startsWith('--n='))?.slice(4) ?? 3);
  const tier = process.argv.includes('--deep') ? 'deep' : 'fast';
  stage = 'verify';
  const trials = [];
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    let defects = [];
    let failure = null;
    try {
      defects = await verify({ llm: deps.llm, clock: systemClock }, { ...CATCH_FIXTURE, tier });
    } catch (e) {
      failure = String(e).slice(0, 200);
      console.log(`  run ${i + 1}: FAILED ${failure}`);
      trials.push({ run: i + 1, failure });
      continue;
    }
    const blob = blobOf(defects);
    const fatal = defects.filter((d) => d.severity === 'fatal').length;
    const caught = score(blob);
    console.log(`\n  run ${i + 1}  ${tier}  ${((Date.now() - t0) / 1000).toFixed(1)}s  `
      + `${defects.length} defects (${fatal} fatal)  ground truth: ${caught.length}/4`);
    for (const [name, probe] of GROUND_TRUTH) console.log(`     ${probe(blob) ? 'OK  ' : 'MISS'} ${name}`);
    trials.push({ run: i + 1, tier, defects: defects.length, fatal, caught, ms: Date.now() - t0 });
  }
  const scored = trials.filter((t) => !t.failure);
  console.log(`\n  caught, across ${scored.length} run(s): `
    + `${scored.map((t) => `${t.caught.length}/4`).join(', ')}`);
  finish(startedAt, { verifier: { tier, n, trials } });

} else {
  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}
