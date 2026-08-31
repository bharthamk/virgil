/**
 * Does the Forager need the expensive tier, and does it need to think?
 *
 * It ships as `tier: 'deep'`, `reasoning: 'on'`, once per pin — the term that
 * grows with how much the learner pins, and the largest single block of calls
 * in a run. The justification in the source is *"background work: reasoning
 * stays on, latency is free at 3am"*, and **the manual-processing contract removed 3am**. There is
 * no nightly; Process runs when somebody presses it and waits for it. So the
 * setting is worth measuring rather than inheriting.
 *
 * Scout's tier was measured. The Analyst's was measured. This one never was.
 *
 * Every arm runs the REAL `forage`, with the real prompt and the real parsing;
 * only the tier and the reasoning flag are overridden, by wrapping the `Llm`
 * port rather than by editing the agent. Research is stubbed off in every arm
 * so the material is identical and the model is the only variable.
 *
 *   node scripts/forage-tier-bakeoff.mjs
 *   node scripts/forage-tier-bakeoff.mjs --store.data/store.json --limit 6
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { forage, forageBatch, systemClock, FORAGE_BATCH } from '../core/dist/index.js';
import { OllamaLlm, GeminiLlm } from '../adapters/dist/index.js';
import { LOCAL_TIERS } from '../adapters/dist/ollama-llm.js';
import { GEMINI_TIERS } from '../adapters/dist/gemini-llm.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const STORE = arg('store', '.data-forage/store.json');
const LIMIT = Number(arg('limit', '99'));
const OUT = arg('out', 'benchmarks/forage-tier');
/**
 * Which provider to measure.
 *
 * **Local models answer a different question.** `COST_MODEL.md` refuses to
 * feed local wall-clock into a cost model for exactly this reason: gemma4:12b
 * against qwen3.8:27b on a Mac says nothing about Flash against Pro. The local
 * arms are worth running — they prove the probe discriminates at all, and they
 * are free — but a TIER contract for the shipped product has to be measured on
 * the shipped provider. Hence `--provider gemini`, which spends real money and
 * says so.
 */
const PROVIDER = arg('provider', 'ollama');

if (PROVIDER === 'gemini' && !process.env.GEMINI_API_KEY) {
  const envFile = join(homedir(), '.config', 'virgil', 'env');
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
}

/** The arms. `deep/on` is what ships. */
const ALL_ARMS = [
  { name: 'deep+think', tier: 'deep', reasoning: 'on' },
  // The same tier, asked about the pins together. This is the arm that decides
  // whether batching costs quality, which is the only reason not to do it.
  { name: 'deep+batch', tier: 'deep', reasoning: 'on', batch: true },
  { name: 'fast+think', tier: 'fast', reasoning: 'on' },
  { name: 'fast', tier: 'fast', reasoning: 'off' },
];
/** `--arms deep+think,fast` to spend quota on only the arms still in question. */
const ARMS = arg('arms', '') ? ALL_ARMS.filter((a) => arg('arms', '').split(',').includes(a.name)) : ALL_ARMS;

/** The real adapter, with the tier and reasoning of one arm forced on it. */
const armLlm = (arm, sink) => {
  const inner = PROVIDER === 'gemini' ? new GeminiLlm({}) : new OllamaLlm({});
  const forced = (req) => ({ ...req, tier: arm.tier, reasoning: arm.reasoning });
  return {
    complete: (req) => inner.complete(forced(req)),
    // The Forager swallows its own model failure by design, so a probe that
    // did not capture the reason would report "model-failed" for a bad wrapper
    // exactly as it does for a bad model.
    structured: async (req) => {
      try {
        const r = await inner.structured(forced(req));
        sink.push({ ok: true, tokens: [r.inputTokens, r.outputTokens], value: r.value });
        return r;
      } catch (e) {
        sink.push({ ok: false, why: String(e).slice(0, 160) });
        throw e;
      }
    },
  };
};

/** No re-fetch in any arm: identical material, one variable. */
const noResearch = { fetchPage: async () => null, findReferences: async () => [], hasGrounding: false };

/**
 * The one automatic quality signal worth having.
 *
 * The task is "name what this passage LEANS ON but does not itself explain".
 * A concept whose own words are sitting in the passage is, on the face of it,
 * the thing the passage is about rather than a prerequisite for it — so a high
 * rate here is a model answering an easier question than the one asked.
 * Imperfect, and it is a signal rather than a verdict, which is why every
 * concept is printed for reading.
 */
const echoed = (concepts, passage) => {
  const hay = passage.toLowerCase();
  return concepts.filter((c) => hay.includes(String(c).toLowerCase().trim())).length;
};

async function main() {
  const store = JSON.parse(readFileSync(STORE, 'utf8'));
  const pins = (store.pins ?? []).slice(0, LIMIT);
  if (!pins.length) throw new Error(`no pins in ${STORE}`);
  console.log(`${pins.length} real pins from ${STORE}`);
  const tiers = PROVIDER === 'gemini' ? GEMINI_TIERS : LOCAL_TIERS;
  console.log(`provider: ${PROVIDER}   fast=${tiers.fast}  deep=${tiers.deep}`);
  if (PROVIDER === 'gemini') console.log('this arm costs real money\n'); else console.log('');

  const results = {};
  for (const arm of ARMS) {
    const calls = [];
    // `clock` is not optional: the Forager stamps the enrichment with it AFTER
    // the model returns, so a missing one throws past a perfectly good reply
    // and the agent's own catch reports it as `model-failed`. The first run of
    // this probe scored three arms at 0/0/N because of it.
    const deps = { llm: armLlm(arm, calls), research: noResearch, clock: systemClock };
    const rows = [];
    // The batch arm asks once per chunk, so the whole set is enriched up front
    // and the per-pin loop below just reads the answers back.
    const batchAt = Date.now();
    const batched = arm.batch ? await forageBatch(deps, { pins, chunk: Number(arg('chunk', String(FORAGE_BATCH))) }) : null;
    const batchMs = arm.batch ? Date.now() - batchAt : 0;
    for (const pin of pins) {
      const passage = `${pin.envelope.selection ?? ''}\n${pin.envelope.surroundingText ?? ''}`;
      const at = Date.now();
      let enrichment = null;
      try {
        enrichment = batched
          ? batched.get(pin.id)
          : await forage(deps, { pin });
      } catch (e) {
        enrichment = { outcome: 'model-failed', assumedConcepts: [], error: String(e).slice(0, 80) };
      }
      if (!enrichment) enrichment = { outcome: 'model-failed', assumedConcepts: [] };
      const concepts = enrichment.assumedConcepts ?? [];
      rows.push({
        pin: pin.id.slice(0, 8),
        title: (pin.envelope.pageTitle ?? '').slice(0, 34),
        outcome: enrichment.outcome,
        concepts,
        echoed: echoed(concepts, passage),
        ms: Date.now() - at,
      });
      process.stdout.write('.');
    }
    results[arm.name] = rows;
    const bad = calls.filter((c) => !c.ok);
    process.stdout.write(` ${arm.name} done`
      + (bad.length ? `  — ${bad.length} call(s) refused: ${bad[0].why}` : '') + '\n');
    const tokens = calls.filter((c) => c.ok).reduce((a, c) => [a[0] + c.tokens[0], a[1] + c.tokens[1]], [0, 0]);
    results[`${arm.name}:tokens`] = tokens;
    results[`${arm.name}:calls`] = calls.length;
    // The batch arm does its work before the per-pin loop, so per-pin timings
    // are all ~0 and summing them reported a batch that took no time at all.
    if (arm.batch) for (const r of rows) r.ms = batchMs / rows.length;
  }

  console.log('\n=== per arm ===');
  console.log('arm         | ok/none/fail | calls | concepts | echoed | total s');
  for (const arm of ARMS) {
    const r = results[arm.name];
    const n = (o) => r.filter((x) => x.outcome === o).length;
    const concepts = r.reduce((a, x) => a + x.concepts.length, 0);
    const ech = r.reduce((a, x) => a + x.echoed, 0);
    const total = r.reduce((a, x) => a + x.ms, 0);
    console.log(`${arm.name.padEnd(11)} | ${String(n('enriched')).padStart(2)}/${String(n('nothing-found')).padStart(2)}/${String(n('model-failed')).padStart(2)}        `
      + `| ${String(results[`${arm.name}:calls`] ?? 0).padStart(5)} | ${String(concepts).padStart(8)} | ${String(ech).padStart(6)} | ${(total / 1000).toFixed(0).padStart(7)}`);
  }

  console.log('\n=== what each arm actually said, per pin ===');
  for (let i = 0; i < pins.length; i += 1) {
    console.log(`\n[${results[ARMS[0].name][i].pin}] ${results[ARMS[0].name][i].title}`);
    console.log(`  passage: "${String(pins[i].envelope.selection ?? '').replace(/\s+/g, ' ').slice(0, 110)}"`);
    for (const arm of ARMS) {
      const r = results[arm.name][i];
      console.log(`  ${arm.name.padEnd(11)} ${r.outcome.padEnd(14)} ${JSON.stringify(r.concepts)}`);
    }
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/forage-tier-arms-${PROVIDER}.json`,
    JSON.stringify({ store: STORE, provider: PROVIDER, tiers, results }, null, 2));
  console.log(`\nwritten: ${OUT}/forage-tier-arms-${PROVIDER}.json`);
}

main().catch((e) => { console.error('bake-off failed:', e.message); process.exit(1); });
