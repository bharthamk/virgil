/**
 * One real Composer invocation against the local model, read-only.
 *
 * Reproduces the compose stage of the nightly exactly — same store, same
 * deterministic comfort model, same Gardener decisions — but writes nothing
 * back, so it can be run repeatedly without moving the learner's state.
 *
 * It exists to measure the two things a unit test cannot:
 *
 *   1. whether prose leaks around the JSON on the structured path, and
 *   2. how the words the model actually wrote track the register-weighted
 *      budget it was given.
 *
 * Slow — this is a 27B model writing several hundred words per section.
 */
import { readFileSync } from 'node:fs';
import {
  compose, computeComfort, registerFor, wordBudgets, tend, duePool, orderTopics, systemClock,
} from '../core/dist/index.js';
import { OllamaLlm, LOCAL_TIERS } from '../adapters/dist/index.js';
import { requireOllama } from './preflight.mjs';

await requireOllama([LOCAL_TIERS.deep], {
  hint: 'The Composer is the one thing this measures, so there is no no-model path.',
});

const store = JSON.parse(readFileSync('.data/store.json', 'utf8'));
const now = new Date();
const comforts = store.topics.map((t) => computeComfort(t.id, store.signals, now));
const pool = duePool(tend({ topics: store.topics, comforts, signals: store.signals, now }));

const rank = new Map(orderTopics(store.topics, store.edges).map((t, i) => [t.id, i]));
const decisions = [...pool.teach].sort((a, b) => (rank.get(a.topicId) ?? 0) - (rank.get(b.topicId) ?? 0));

const targetMinutes = store.prefs.targetMinutes;
const byId = new Map(store.topics.map((t) => [t.id, t]));
const comfortById = new Map(comforts.map((c) => [c.topicId, c]));

// The same set the Composer will choose, so the budgets printed below are the
// ones it was actually handed.
const capacity = Math.max(1, Math.floor(targetMinutes / 5));
const chosen = decisions
  .filter((d) => !['hold', 'settled', 'offer-retire'].includes(d.disposition))
  .sort((a, b) => b.priority - a.priority)
  .slice(0, capacity)
  .filter((d) => byId.has(d.topicId));
const registers = chosen.map((d) => registerFor(comfortById.get(d.topicId)));
const budgets = wordBudgets(targetMinutes, registers);

console.log(`budget ${targetMinutes}min across ${chosen.length} section(s)`);
for (const [i, d] of chosen.entries()) {
  console.log(`  ${byId.get(d.topicId).label.padEnd(34)} ${registers[i].padEnd(12)} target ${budgets[i]} words`);
}
console.log(`  ${''.padEnd(34)} ${''.padEnd(12)} total  ${budgets.reduce((a, b) => a + b, 0)} words\n`);

// Intercept the raw reply so leaked prose can be measured rather than assumed
// — the extractor would otherwise quietly clean it up before anyone saw it.
const llm = new OllamaLlm();
let raw = '';
let attempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const res = await realFetch(...args);
  const [a, b] = res.body.tee();
  attempts++;
  void (async () => {
    let text = '';
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of a) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try { text += JSON.parse(line).message?.content ?? ''; } catch { /* partial */ }
      }
    }
    raw = text;
  })();
  return new Response(b, { status: res.status });
};

const t0 = Date.now();
const session = await compose({ llm, clock: systemClock }, {
  topics: store.topics,
  pins: store.pins,
  comforts,
  decisions,
  observations: [],
  knownAboutLearner: store.statements.map((s) => s.text),
  targetMinutes,
  interfaceLanguage: store.prefs.interfaceLanguage,
});
console.log(`composed in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

const first = raw.indexOf('{');
const last = raw.lastIndexOf('}');
const before = first < 0 ? raw.length : first;
const after = last < 0 ? raw.length : raw.length - last - 1;
console.log(`${attempts} model call(s); last raw reply ${raw.length} chars, `
  + `${before} before the first "{", ${after} after the last "}"`);
if (before || after) {
  console.log(`  LEAKED BEFORE: ${JSON.stringify(raw.slice(0, Math.min(before, 200)))}`);
  console.log(`  LEAKED AFTER:  ${JSON.stringify(raw.slice(last + 1, last + 1 + Math.min(after, 200)))}`);
} else {
  console.log('  no prose around the JSON');
}

const budgetFor = new Map(chosen.map((d, i) => [d.topicId, budgets[i]]));
console.log('\nsection                            register     target  actual   ratio  minutes');
let words = 0;
for (const s of session.sections) {
  const n = s.body.trim().split(/\s+/).length;
  const target = budgetFor.get(s.topicId) ?? 0;
  words += n;
  console.log(`  ${s.heading.slice(0, 32).padEnd(32)} ${s.depth.padEnd(12)} ${String(target).padStart(6)} ${String(n).padStart(7)} ${(n / target).toFixed(2).padStart(7)} ${s.estimatedMinutes.toFixed(1).padStart(8)}`);
}
console.log(`  ${'TOTAL'.padEnd(32)} ${''.padEnd(12)} ${String(budgets.reduce((a, b) => a + b, 0)).padStart(6)} ${String(words).padStart(7)} ${''.padStart(7)} ${session.estimatedMinutes.toFixed(1).padStart(8)} of ${targetMinutes}`);
