/**
 * The clustering evaluation at scale — 80 pins, four domains.
 *
 * `eval-clustering.mjs` proved the partition at 21 pins and nothing above it
 * (the clustering contract, ). This is the same experiment on a board four
 * times the size, with the failure modes a real board actually has: two
 * near-duplicate pin pairs, a single-pin domain outlier, and one pin whose
 * selection is fifteen times longer than the corpus average.
 *
 * Five things, in order:
 *
 *  1. partition quality at 80 — topic count and pairwise F1 against the key;
 *  2. does the shipped cut point still sit on a plateau at 4x the pins, or was
 *     0.635 a fit to 21 pins the way TF-IDF's 0.12 was a fit to that corpus;
 *  3. determinism — three cold runs over 80 pins, asserted identical;
 *  4. the incremental path — cluster the original 21, then add the remaining 59
 *     in three batches with a re-run between each, asserting that no pin that
 *     already had a topic ever moved;
 *  5. the edge cases, named and checked individually.
 *
 * The metric is pairwise over all 3,160 pin pairs, same as at 21. Topic-count
 * agreement is not evidence: a run can land on twenty-two topics and have cut
 * them in the wrong twenty-two places.
 *
 *   node scripts/eval-scale.mjs           # everything, both embedders
 *   node scripts/eval-scale.mjs ollama    # one space only
 *
 * Embedder only. No model is called, so this is cheap enough to run on every
 * change to the clustering code.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { agglomerate, partition, pinClusterText, thresholdFor } from '../core/dist/index.js';
import { TfIdfEmbedder, OllamaEmbedder, DEFAULT_EMBED_MODEL } from '../adapters/dist/index.js';
import { requireOllama } from './preflight.mjs';

const pinsRaw = JSON.parse(readFileSync('scripts/scale-pins.json', 'utf8'));
const expected = JSON.parse(readFileSync('scripts/scale-expected.json', 'utf8'));
const expectOf = new Map(expected.map((e) => [e.id, e.expect]));
const edgeOf = new Map(expected.filter((e) => e.edge).map((e) => [e.id, e.edge]));
const KEY_TOPICS = new Set(expected.map((e) => e.expect)).size;

/** The fixture is flat; the clusterer reads a capture envelope. */
const toPin = (p) => ({
  id: p.id,
  type: p.type,
  envelope: {
    selection: p.selection ?? null,
    parts: p.parts ?? [],
    surroundingText: p.surrounding ?? '',
    headingPath: p.headings ?? [],
    pageTitle: p.title ?? '',
    url: p.url ?? '',
    canonicalUrl: null,
    siteName: p.site ?? null,
    contentLanguage: 'en',
    media: null,
  },
  note: p.note ?? null,
  capturedAt: p.capturedAt,
  fromSuggestion: false,
  enrichment: null,
  topicId: null,
});

const PINS = pinsRaw.map(toPin).sort((a, b) => (a.id < b.id ? -1 : 1));
/** What each space scored on the 21-pin golden key — AGENT_EVAL_LOG.md Run 5. */
const BASELINE_F1 = { 'nomic-embed-text': 0.895, 'tfidf-v1': 0.914 };
const SEEDED = PINS.filter((p) => Number(p.id.slice(4)) <= 21);
/** Three arrivals after the original board, in the order a learner would pin. */
const BATCHES = [
  ['batch 1 (pins 22-41)', PINS.filter((p) => { const n = Number(p.id.slice(4)); return n >= 22 && n <= 41; })],
  ['batch 2 (pins 42-61)', PINS.filter((p) => { const n = Number(p.id.slice(4)); return n >= 42 && n <= 61; })],
  ['batch 3 (pins 62-80)', PINS.filter((p) => { const n = Number(p.id.slice(4)); return n >= 62 && n <= 80; })],
];

function score(groups, ids) {
  const assigned = new Map();
  groups.forEach((g, i) => g.forEach((id) => assigned.set(id, i)));
  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const same = assigned.get(ids[i]) === assigned.get(ids[j]);
      const should = expectOf.get(ids[i]) === expectOf.get(ids[j]);
      if (same && should) tp++;
      else if (same) fp++;
      else if (should) fn++;
    }
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, topics: groups.length, pairs: tp + fp + fn };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`.padStart(6);
const shape = (groups) => groups.map((g) => g.join(',')).join(' | ');
const embed = async (embedder, pins) => {
  const vectors = await embedder.embed(pins.map(pinClusterText));
  return pins.map((p, i) => ({ id: p.id, vector: vectors[i] }));
};
/** Domains, for reading the merge failures. Derived from the key, not given to anything. */
const DOMAIN = (key) => key.startsWith('rust-') ? 'rust'
  : key.startsWith('sourdough-') ? 'sourdough'
  : ['intervals', 'seventh-chords', 'tritone-sub', 'voice-leading', 'modal-interchange'].includes(key) ? 'jazz'
  : key === 'bicycle-indexing' ? 'outlier' : 'cloud';

// ------------------------------------------------- 1. partition at 80 pins

async function quality(name, embedder) {
  const t0 = Date.now();
  const items = await embed(embedder, PINS);
  const ms = Date.now() - t0;
  const t = thresholdFor(embedder.modelId);
  const groups = agglomerate(items, t);
  const s = score(groups, PINS.map((p) => p.id));

  console.log(`\n## ${name} — ${embedder.modelId}, ${items[0].vector.length} dims`
    + `, ${PINS.length} pins embedded in ${(ms / 1000).toFixed(1)}s`);
  console.log(`\nshipped cut point ${t}: **${s.topics} topics** (key has ${KEY_TOPICS})`
    + `, P ${pct(s.precision).trim()}, R ${pct(s.recall).trim()}, F1 ${pct(s.f1).trim()}`
    + ` over ${s.pairs === 0 ? 0 : (PINS.length * (PINS.length - 1)) / 2} pairs`);

  // Topic-count sanity is the coarse check that has to pass before F1 means
  // anything: 4 topics is one bucket per domain and 60 is one per pin.
  assert.ok(s.topics >= 12 && s.topics <= 34,
    `${name}: ${s.topics} topics at 80 pins is outside any defensible band (12-34)`);

  // The 21-pin numbers this is being held against (AGENT_EVAL_LOG.md Run 5).
  const baseline = BASELINE_F1[embedder.modelId] ?? null;
  if (baseline !== null && s.f1 < baseline * 0.8) {
    console.log(`\n  QUALITY REGRESSION: F1 ${pct(s.f1).trim()} at 80 pins against `
      + `${pct(baseline).trim()} at 21. The partition is materially worse at scale.`);
  }
  // Floor, not target. Below this the partition is not carrying information and
  // nothing downstream of it means anything.
  assert.ok(s.f1 >= 0.45, `${name}: pairwise F1 ${pct(s.f1).trim()} at 80 pins is below the 45% floor`);

  const merged = groups.filter((g) => new Set(g.map((id) => expectOf.get(id))).size > 1);
  const split = new Map();
  for (const [i, g] of groups.entries()) for (const id of g) {
    const k = expectOf.get(id);
    if (!split.has(k)) split.set(k, new Set());
    split.get(k).add(i);
  }
  const torn = [...split.entries()].filter(([, gs]) => gs.size > 1);

  console.log(`\ngroups holding more than one key topic: ${merged.length}`);
  for (const g of merged) {
    const keys = [...new Set(g.map((id) => expectOf.get(id)))];
    const domains = [...new Set(keys.map(DOMAIN))];
    console.log(`  ${g.length} pins: ${keys.join(' + ')}`
      + `${domains.length > 1 ? `   CROSS-DOMAIN (${domains.join('/')})` : ''}`);
  }
  console.log(`key topics split across more than one group: ${torn.length}`
    + (torn.length ? ` — ${torn.map(([k, gs]) => `${k} x${gs.size}`).join(', ')}` : ''));

  // A cross-domain merge is the failure the whole design is built to avoid: it
  // welds a comfort score out of two unrelated subjects and the learner cannot
  // read it as anything but noise.
  const crossDomain = merged.filter((g) =>
    new Set([...new Set(g.map((id) => expectOf.get(id)))].map(DOMAIN)).size > 1);
  assert.equal(crossDomain.length, 0,
    `${name}: ${crossDomain.length} group(s) welded two different domains together`);
  return { items, t, groups, s };
}

// ------------------------------------------------- 1b. the difficulty control

/**
 * The control the headline number needs before it can be read as a scale result.
 *
 * F1 falling from 89.5% at 21 pins to 53.0% at 80 has two candidate causes and
 * only one of them is scale. The other is that this corpus is simply harder: it
 * carries four or five closely related sub-topics inside each domain — seventh
 * chords next to tritone substitution next to voice leading — where the 21-pin
 * seed carried mostly well-separated ones.
 *
 * So: cluster 20-pin windows of THIS corpus on their own and score them against
 * the same key. If a 20-pin slice of this material also scores in the fifties,
 * the corpus is the cause and the pin count is not. If the slices score in the
 * eighties, scale is.
 */
async function control(name, embedder) {
  const t = thresholdFor(embedder.modelId);
  const windows = [
    ['pins 1-20', PINS.slice(0, 20)],
    ['pins 21-40', PINS.slice(20, 40)],
    ['pins 41-60', PINS.slice(40, 60)],
    ['pins 61-80', PINS.slice(60, 80)],
    // Every fourth pin: same 20 pins, spread across all four domains, which is
    // the shape a young board actually has.
    ['every 4th pin', PINS.filter((_, i) => i % 4 === 0)],
  ];
  console.log(`\n### ${name} — is it the pin count or the corpus? Same cut point, 20-pin slices`);
  console.log('\n| slice | pins | key topics in slice | topics found | precision | recall |     F1 |');
  console.log('| :---- | ---: | ------------------: | -----------: | --------: | -----: | -----: |');
  let total = 0;
  const scores = [];
  for (const [label, subset] of windows) {
    const items = await embed(embedder, subset);
    const s = score(agglomerate(items, t), subset.map((p) => p.id));
    const keys = new Set(subset.map((p) => expectOf.get(p.id))).size;
    console.log(`| ${label.padEnd(13)} | ${String(subset.length).padStart(4)} | ${String(keys).padStart(19)}`
      + ` | ${String(s.topics).padStart(12)} | ${pct(s.precision)}    | ${pct(s.recall)} | ${pct(s.f1)} |`);
    total += s.f1;
    scores.push(s.f1);
  }
  const mean = total / windows.length;
  const spread = Math.max(...scores) - Math.min(...scores);
  const full = score(agglomerate(await embed(embedder, PINS), t), PINS.map((p) => p.id));
  console.log(`\n  20-pin slices: mean F1 ${pct(mean).trim()}, spread ${pct(spread).trim()}`
    + ` (${pct(Math.min(...scores)).trim()} to ${pct(Math.max(...scores)).trim()})`);
  console.log(`  whole 80-pin board: ${pct(full.f1).trim()}`);
  // Only claim a cause when the slices agree with each other. If one 20-pin
  // slice of the same corpus scores twice another, the dominant variable is
  // WHICH material, and attributing the 80-pin number to pin count would be
  // reading a difference that is not there.
  console.log(`  ${spread > 0.25
    ? 'INCONCLUSIVE on pin count: the slices disagree with each other by more than they '
      + 'disagree with the whole board. Which material is in the slice dominates.'
    : mean - full.f1 > 0.1
      ? 'the pin count is carrying the loss — the same material scores better in slices'
      : 'the corpus is carrying the loss — 20 pins of it score no better than 80'}`);
  return { mean, spread, full: full.f1 };
}

// ------------------------------------- 2. does the cut point survive 4x pins

/**
 * The question Run 5 could not ask. 0.635 was chosen on the centre of a
 * 0.631-0.638 plateau over 21 pins. A plateau is a property of a corpus until
 * it is shown to be a property of the space, and this is the first board big
 * enough to test it.
 */
async function plateau(name, embedder, thresholds) {
  const items = await embed(embedder, PINS);
  const ids = PINS.map((p) => p.id);
  console.log(`\n### ${name} — cut point sweep at ${PINS.length} pins`);
  console.log('\n| threshold | topics | precision | recall |     F1 |');
  console.log('| :-------- | -----: | --------: | -----: | -----: |');
  let best = null;
  for (const t of thresholds) {
    const s = score(agglomerate(items, t), ids);
    const mark = Math.abs(t - thresholdFor(embedder.modelId)) < 1e-9 ? ' <- shipped' : '';
    console.log(`| ${t.toFixed(3)}     | ${String(s.topics).padStart(6)} | ${pct(s.precision)}    |`
      + ` ${pct(s.recall)} | ${pct(s.f1)} |${mark}`);
    if (!best || s.f1 > best.s.f1 + 1e-9) best = { t, s };
  }
  console.log(`\nbest at 80 pins: ${best.t.toFixed(3)} — F1 ${pct(best.s.f1).trim()}`
    + `, ${best.s.topics} topics; shipped cut point is ${thresholdFor(embedder.modelId)}`);
  return best;
}

// ------------------------------------------------------- 3. determinism

async function stability(name, make) {
  const shapes = [];
  for (let run = 1; run <= 3; run++) {
    const embedder = make();
    const items = await embed(embedder, PINS);
    shapes.push(shape(agglomerate(items, thresholdFor(embedder.modelId))));
  }
  const identical = new Set(shapes).size === 1;
  console.log(`\n### ${name} determinism at ${PINS.length} pins — 3 cold runs: `
    + `${identical ? 'IDENTICAL' : 'DIVERGED'}`);
  for (const [i, s] of shapes.entries()) {
    console.log(`  run ${i + 1}: ${s.length} chars, ${s.split('|').length} topics`);
  }
  assert.equal(new Set(shapes).size, 1, `three cold runs over 80 pins disagreed:\n${shapes.join('\n')}`);
}

// --------------------------------------------------- 4. the incremental path

/**
 * The product promise, at scale: a pin that already has a topic never moves.
 *
 * Run 5 proved this over 16 pins plus 5. Here the established board is the real
 * 21-pin seed and 59 pins arrive in three waves, two of which introduce whole
 * domains the board has never seen. Every established pin is checked against
 * the topic id it held before the batch, not merely counted.
 */
async function incremental(name, embedder) {
  const t = thresholdFor(embedder.modelId);
  const all = await embed(embedder, PINS);
  const vectorById = new Map(all.map((it) => [it.id, it.vector]));

  // The original 21, clustered cold — the board this learner already had.
  const seedItems = SEEDED.map((p) => ({ id: p.id, vector: vectorById.get(p.id) }));
  let established = agglomerate(seedItems, t)
    .map((pinIds, i) => ({ topicId: `T${String(i + 1).padStart(2, '0')}`, memberIds: pinIds }));

  console.log(`\n### ${name} incremental — established board first`);
  console.log(`  21 pins -> ${established.length} topics`);

  let seen = [...SEEDED];
  let nextId = established.length + 1;
  let totalMoved = 0;

  console.log('\n| arrival | pins on board | topics | attached | new topics | established pins moved |');
  console.log('| :------ | ------------: | -----: | -------: | ---------: | ---------------------: |');
  console.log(`| seed (21) | 21 | ${established.length} | — | ${established.length} (21 pins) | 0 |`);

  for (const [label, batch] of BATCHES) {
    seen = [...seen, ...batch];
    const items = seen.map((p) => ({ id: p.id, vector: vectorById.get(p.id) }));
    const before = new Map();
    for (const g of established) for (const id of g.memberIds) before.set(id, g.topicId);

    const out = partition({ items, existing: established, threshold: t });

    // The assertion that matters. Every pin that already had a topic must still
    // be in that same topic id — not in a topic with the same membership, the
    // same id, because comfort and signal history hang off it.
    const moved = [];
    for (const g of out) for (const id of g.pinIds) {
      const was = before.get(id);
      if (was !== undefined && was !== g.topicId) moved.push(`${id}: ${was} -> ${g.topicId}`);
    }
    const lost = [...before.keys()].filter((id) => !out.some((g) => g.pinIds.includes(id)));
    const orphanedTopics = established.filter((e) => !out.some((g) => g.topicId === e.topicId));

    const attached = out.reduce((n, g) => n + g.attached.length, 0);
    const freshTopics = out.filter((g) => g.topicId === null);
    const seededPins = freshTopics.reduce((n, g) => n + g.pinIds.length, 0);
    console.log(`| ${label} | ${seen.length} | ${out.length} | ${attached} | `
      + `${freshTopics.length} (${seededPins} pins) | ${moved.length} |`);

    assert.equal(moved.length, 0, `${name} ${label}: established pins were reassigned:\n  ${moved.join('\n  ')}`);
    assert.equal(lost.length, 0, `${name} ${label}: ${lost.length} established pin(s) fell out of the partition`);
    assert.equal(orphanedTopics.length, 0, `${name} ${label}: ${orphanedTopics.length} topic(s) lost their id`);
    // Every arriving pin either joins an existing topic or lands in one of the
    // topics seeded on this run. Neither number may be the whole batch: all
    // attached means new domains are being swallowed by old topics, all seeded
    // means the board is not recognising its own material.
    assert.equal(attached + seededPins, batch.length,
      `${name} ${label}: ${batch.length} arrived, ${attached} attached + ${seededPins} seeded`);
    assert.ok(attached > 0 && seededPins > 0,
      `${name} ${label}: degenerate arrival — ${attached} attached, ${seededPins} seeded`);
    totalMoved += moved.length;

    established = out.map((g) => ({
      topicId: g.topicId ?? `T${String(nextId++).padStart(2, '0')}`,
      memberIds: g.pinIds,
    }));
  }

  // Where the incremental board landed against the key, next to the cold one.
  const grouped = established.map((g) => g.memberIds);
  const s = score(grouped, PINS.map((p) => p.id));
  const cold = score(agglomerate(all, t), PINS.map((p) => p.id));
  console.log(`\n  incremental board: ${s.topics} topics, F1 ${pct(s.f1).trim()}`
    + ` (P ${pct(s.precision).trim()}, R ${pct(s.recall).trim()})`);
  console.log(`  same 80 pins clustered cold: ${cold.topics} topics, F1 ${pct(cold.f1).trim()}`);
  console.log(`  established pins reassigned across all three batches: ${totalMoved}`);
  assert.equal(totalMoved, 0, 'an established pin moved');
  return { incremental: s, cold };
}

// ------------------------------------------------------- 5. the edge cases

async function edges(name, embedder) {
  const t = thresholdFor(embedder.modelId);
  const items = await embed(embedder, PINS);
  const groups = agglomerate(items, t);
  const groupOf = new Map();
  groups.forEach((g, i) => g.forEach((id) => groupOf.set(id, i)));

  console.log(`\n### ${name} — the deliberate edge cases`);

  for (const pair of ['near-duplicate-a', 'near-duplicate-b']) {
    const ids = [...edgeOf.entries()].filter(([, v]) => v === pair).map(([k]) => k);
    const together = new Set(ids.map((id) => groupOf.get(id))).size === 1;
    const size = groups[groupOf.get(ids[0])].length;
    console.log(`  ${pair} (${ids.join(', ')}): ${together ? 'same topic' : 'DIFFERENT topics'}`
      + `, that topic holds ${size} pins`);
    // Near-duplicates belong together and the key says so. What is worth
    // watching is whether they pull a topic down to just the two of them.
    assert.ok(together, `${name}: near-duplicate pair ${ids.join(', ')} landed in different topics`);
  }

  const orphanId = [...edgeOf.entries()].find(([, v]) => v === 'orphan')[0];
  const orphanGroup = groups[groupOf.get(orphanId)];
  console.log(`  orphan (${orphanId}): topic of ${orphanGroup.length} pin(s)`
    + (orphanGroup.length > 1 ? ` — absorbed with ${orphanGroup.filter((i) => i !== orphanId).join(', ')}` : ' — alone, correct'));
  assert.equal(orphanGroup.length, 1, `${name}: the domain outlier was absorbed into a topic of ${orphanGroup.length}`);

  const longId = [...edgeOf.entries()].find(([, v]) => v === 'long-selection')[0];
  const longPin = PINS.find((p) => p.id === longId);
  const longGroup = groups[groupOf.get(longId)];
  const keys = [...new Set(longGroup.map((id) => expectOf.get(id)))];
  const chars = longPin.envelope.selection.length;
  const embedded = pinClusterText(longPin).length;
  console.log(`  long selection (${longId}): ${chars} chars of selection, ${embedded} reach the embedder`
    + ` — landed with ${keys.join(' + ')} (${longGroup.length} pins)`);
  assert.deepEqual(keys, [expectOf.get(longId)],
    `${name}: the long pin dragged unrelated material into its topic`);

  const sizes = groups.map((g) => g.length).sort((a, b) => b - a);
  console.log(`  topic sizes: ${sizes.join(' ')}`);
  console.log(`  singletons: ${sizes.filter((n) => n === 1).length} of ${groups.length} topics`);
}

// ------------------------------------------------------------------ run

const only = process.argv[2];
if (only !== 'tfidf') {
  await requireOllama([DEFAULT_EMBED_MODEL], {
    hint: 'The TF-IDF half needs no model: `node scripts/eval-scale.mjs tfidf`.',
  });
}
const range = (from, to, step) => {
  const out = [];
  for (let x = from; x <= to + 1e-9; x += step) out.push(Math.round(x * 1000) / 1000);
  return out;
};

console.log(`# Clustering at scale — ${PINS.length} pins, ${KEY_TOPICS} key topics, `
  + `${new Set(expected.map((e) => DOMAIN(e.expect))).size} domains`);

if (!only || only === 'ollama') {
  await quality('Ollama embeddings', new OllamaEmbedder());
  await control('Ollama embeddings', new OllamaEmbedder());
  await plateau('Ollama embeddings', new OllamaEmbedder(), range(0.600, 0.680, 0.005));
  await stability('Ollama embeddings', () => new OllamaEmbedder());
  await incremental('Ollama embeddings', new OllamaEmbedder());
  await edges('Ollama embeddings', new OllamaEmbedder());
}
if (!only || only === 'tfidf') {
  await quality('TF-IDF, no model', new TfIdfEmbedder());
  await control('TF-IDF, no model', new TfIdfEmbedder());
  await plateau('TF-IDF, no model', new TfIdfEmbedder(), range(0.04, 0.20, 0.01));
  await stability('TF-IDF', () => new TfIdfEmbedder());
  await incremental('TF-IDF', new TfIdfEmbedder());
  await edges('TF-IDF', new TfIdfEmbedder());
}
console.log('\nall assertions passed');
