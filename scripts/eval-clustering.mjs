/**
 * The clustering evaluation, in one runnable file.
 *
 * Four things, in order:
 *
 *  1. threshold sweep for both embedding spaces against the withheld
 *     expected-cluster key on the 21-pin seeded corpus;
 *  2. corpus sensitivity — does the chosen cut point survive the board changing
 *     shape, which is the thing a learner's board does every day;
 *  3. stability — three consecutive cold runs, asserted identical, not eyeballed;
 *  4. attach-only — re-cluster an established board and assert nothing moved.
 *
 * The metric is pairwise. Over all 210 pin pairs, does the partition put them
 * together when the key does? Topic-count agreement is not enough: a run can
 * land on nine topics and still have cut them in the wrong nine places.
 *
 *   node scripts/eval-clustering.mjs           # everything, both embedders
 *   node scripts/eval-clustering.mjs tfidf     # one space only
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { agglomerate, partition, pinClusterText, thresholdFor } from '../core/dist/index.js';
import { TfIdfEmbedder, OllamaEmbedder, DEFAULT_EMBED_MODEL } from '../adapters/dist/index.js';
import { requireOllama } from './preflight.mjs';

const pinsRaw = JSON.parse(readFileSync('scripts/eval-pins.json', 'utf8'));
const expected = JSON.parse(readFileSync('scripts/eval-expected.json', 'utf8'));
const expectOf = new Map(expected.map((e) => [e.id, e.expect]));
const KEY_TOPICS = new Set(expected.map((e) => e.expect)).size;

/** The eval fixture is flat; the clusterer reads a capture envelope. */
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
  return { precision, recall, f1, topics: groups.length };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`.padStart(6);
const shape = (groups) => groups.map((g) => g.join(',')).join(' | ');
const embed = async (embedder, pins) => {
  const vectors = await embedder.embed(pins.map(pinClusterText));
  return pins.map((p, i) => ({ id: p.id, vector: vectors[i] }));
};

// -------------------------------------------------------------- 1. sweep

async function sweep(name, embedder, thresholds) {
  const t0 = Date.now();
  const items = await embed(embedder, PINS);
  const ms = Date.now() - t0;
  const ids = PINS.map((p) => p.id);

  console.log(`\n## ${name} — ${embedder.modelId}, ${items[0].vector.length} dims`
    + `, 21 pins embedded in ${(ms / 1000).toFixed(1)}s`);
  console.log('\n| threshold | topics | precision | recall |     F1 |');
  console.log('| :-------- | -----: | --------: | -----: | -----: |');
  let best = null;
  for (const t of thresholds) {
    const groups = agglomerate(items, t);
    const s = score(groups, ids);
    console.log(`| ${t.toFixed(3)}     | ${String(s.topics).padStart(6)} | ${pct(s.precision)}    |`
      + ` ${pct(s.recall)} | ${pct(s.f1)} |`);
    if (!best || s.f1 > best.s.f1 + 1e-9) best = { t, s, groups };
  }

  const chosen = thresholdFor(embedder.modelId);
  console.log(`\nbest swept: ${best.t.toFixed(3)} — F1 ${pct(best.s.f1).trim()}, `
    + `P ${pct(best.s.precision).trim()}, R ${pct(best.s.recall).trim()}, `
    + `${best.s.topics} topics (key has ${KEY_TOPICS})`);
  console.log(`shipped cut point: ${chosen}`);
  console.log('partition at the shipped cut point:');
  for (const g of agglomerate(items, chosen)) {
    const keys = [...new Set(g.map((id) => expectOf.get(id)))];
    console.log(`  ${g.join(' ')}  -> ${keys.join(' + ')}${keys.length > 1 ? '   MERGED' : ''}`);
  }
  return { items, chosen };
}

// -------------------------------------------------- 2. corpus sensitivity

/**
 * The question the full-corpus F1 cannot answer: is the cut point a property of
 * the space, or of this particular 21 pins? A learner's board changes shape
 * constantly, and a threshold that only works at one composition is not a
 * threshold, it is a fit.
 */
async function sensitivity(name, embedder) {
  const t = thresholdFor(embedder.modelId);
  const subsets = [
    ['full board (21)', PINS],
    ['cloud only (14)', PINS.filter((p) => Number(p.id.slice(4)) <= 14)],
    ['music only (7)', PINS.filter((p) => Number(p.id.slice(4)) >= 15)],
    ['every other pin (11)', PINS.filter((_, i) => i % 2 === 0)],
  ];
  console.log(`\n### ${name} at ${t} — same cut point, different boards`);
  console.log('\n| board | topics | precision | recall |     F1 |');
  console.log('| :---- | -----: | --------: | -----: | -----: |');
  for (const [label, subset] of subsets) {
    const items = await embed(embedder, subset);
    const s = score(agglomerate(items, t), subset.map((p) => p.id));
    console.log(`| ${label.padEnd(20)} | ${String(s.topics).padStart(6)} | ${pct(s.precision)}    |`
      + ` ${pct(s.recall)} | ${pct(s.f1)} |`);
  }
}

// ---------------------------------------------------------- 3. stability

/**
 * DEAD_ENDS.md D15 measured 6, 6 and 7 topics from three identical runs. This
 * is the same experiment, asserted rather than observed — including a fresh
 * embedder instance and a fresh embedding call each time, so a cache cannot
 * manufacture the agreement.
 */
async function stability(name, make) {
  const shapes = [];
  for (let run = 1; run <= 3; run++) {
    const embedder = make();
    const items = await embed(embedder, PINS);
    shapes.push(shape(agglomerate(items, thresholdFor(embedder.modelId))));
  }
  const identical = new Set(shapes).size === 1;
  console.log(`\n### ${name} stability — 3 cold runs: ${identical ? 'IDENTICAL' : 'DIVERGED'}`);
  for (const [i, s] of shapes.entries()) console.log(`  run ${i + 1}: ${s.length} chars, ${s.split('|').length} topics`);
  assert.equal(new Set(shapes).size, 1, `three cold runs disagreed:\n${shapes.join('\n')}`);
  return shapes[0];
}

// -------------------------------------------------------- 4. attach-only

/**
 * The product requirement, stated as an assertion: a nightly run over a board
 * nobody touched must move nothing and orphan nothing. Then five new pins are
 * added and the same board is re-run, to prove the no-op is not just an empty
 * code path — the established topics must still hold exactly the pins they held.
 */
async function attachOnly(name, embedder) {
  const t = thresholdFor(embedder.modelId);
  const items = await embed(embedder, PINS);
  const cold = agglomerate(items, t);
  const established = cold.map((pinIds, i) => ({ topicId: `T${String(i + 1).padStart(2, '0')}`, memberIds: pinIds }));

  const rerun = partition({ items, existing: established, threshold: t });
  const moved = rerun.filter((g) => {
    const before = established.find((e) => e.topicId === g.topicId);
    return !before || before.memberIds.join(',') !== g.pinIds.join(',');
  });
  const orphaned = established.filter((e) => !rerun.some((g) => g.topicId === e.topicId));

  console.log(`\n### ${name} attach-only — re-run over an unchanged board`);
  console.log(`  ${rerun.length} topics back from ${established.length}`);
  console.log(`  reassignments: ${rerun.reduce((n, g) => n + g.attached.length, 0)}`);
  console.log(`  topics whose membership changed: ${moved.length}`);
  console.log(`  topics that lost their id (orphaned signals): ${orphaned.length}`);
  assert.equal(moved.length, 0, 'a re-run over an unchanged board moved a pin');
  assert.equal(orphaned.length, 0, 'a re-run over an unchanged board orphaned a topic');
  assert.equal(rerun.reduce((n, g) => n + g.attached.length, 0), 0);

  // Now with five pins withheld from the first pass and introduced on the second.
  const older = PINS.slice(0, 16);
  const newcomers = PINS.slice(16);
  const olderItems = await embed(embedder, older);
  const seedGroups = agglomerate(olderItems, t)
    .map((pinIds, i) => ({ topicId: `S${String(i + 1).padStart(2, '0')}`, memberIds: pinIds }));
  const grown = partition({ items, existing: seedGroups, threshold: t });
  const drift = seedGroups.filter((s) => {
    const after = grown.find((g) => g.topicId === s.topicId);
    return !after || s.memberIds.some((id) => !after.pinIds.includes(id));
  });
  console.log(`  + ${newcomers.length} new pins: ${grown.length} topics`
    + `, ${grown.reduce((n, g) => n + g.attached.length, 0)} attached`
    + `, ${grown.filter((g) => g.topicId === null).length} newly seeded`
    + `, ${drift.length} established topics lost a pin`);
  assert.equal(drift.length, 0, 'an established topic lost a pin when new material arrived');
}

// ------------------------------------------------------------------ run

const only = process.argv[2];
if (only !== 'tfidf') {
  await requireOllama([DEFAULT_EMBED_MODEL], {
    hint: 'The TF-IDF half needs no model: `node scripts/eval-clustering.mjs tfidf`.',
  });
}
const range = (from, to, step) => {
  const out = [];
  for (let x = from; x <= to + 1e-9; x += step) out.push(Math.round(x * 1000) / 1000);
  return out;
};

if (!only || only === 'tfidf') {
  await sweep('TF-IDF, no model', new TfIdfEmbedder(), range(0.02, 0.20, 0.01));
  await sensitivity('TF-IDF', new TfIdfEmbedder());
  await stability('TF-IDF', () => new TfIdfEmbedder());
  await attachOnly('TF-IDF', new TfIdfEmbedder());
}
if (!only || only === 'ollama') {
  await sweep('Ollama embeddings', new OllamaEmbedder(), range(0.60, 0.70, 0.005));
  await sensitivity('Ollama embeddings', new OllamaEmbedder());
  await stability('Ollama embeddings', () => new OllamaEmbedder());
  await attachOnly('Ollama embeddings', new OllamaEmbedder());
}
console.log('\nall assertions passed');
