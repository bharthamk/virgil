/**
 * Ground-truth test: the section in `verifier-catch-fixture.mjs` shipped with
 * FOUR fatal defects, all independently confirmed. Does the local fast tier
 * still catch them?
 *
 * A verifier that misses fatal defects is worse than no verifier, because it
 * manufactures confidence. This has to be measured, not assumed.
 *
 * The fixture moved out of this file and into its own module. It had to: this
 * script runs its Ollama loop at the top level, so nothing could import it, and
 * `gemini-benchmark.mjs` carried a second copy of the ground truth in order to
 * ask the same question of a different provider. One fixture, two runners — the
 * local number and the Gemini number are only comparable while that holds.
 *
 *   node scripts/verifier-tier-test.mjs
 */
import { verify, systemClock } from '../core/dist/index.js';
import { OllamaLlm } from '../adapters/dist/index.js';
import { CATCH_FIXTURE, GROUND_TRUTH, blobOf, score } from './verifier-catch-fixture.mjs';

for (const tier of ['fast', 'deep']) {
  const deps = { llm: new OllamaLlm(), clock: systemClock };
  const t0 = Date.now();
  let defects = [];
  try {
    defects = await verify(deps, { ...CATCH_FIXTURE, tier });
  } catch (e) { console.log(`${tier}: FAILED ${String(e).slice(0, 80)}`); continue; }
  const blob = blobOf(defects);
  const fatal = defects.filter(d => d.severity === 'fatal').length;
  const caught = score(blob);
  console.log(`\n${tier.toUpperCase()}  ${((Date.now() - t0) / 1000).toFixed(0)}s  ${defects.length} defects (${fatal} fatal)  ground truth: ${caught.length}/4`);
  for (const [name, probe] of GROUND_TRUTH) console.log(`   ${probe(blob) ? 'OK  ' : 'MISS'} ${name}`);
}
