/**
 * Does the product's D1 reproduce the bake-off's D1, or merely resemble it?
 *
 * `PARTITION_BAKEOFF_2026-08-19.md` and `REAL_CORPUS_BAKEOFF_2026-08-19.md` are
 * the specification for `core/src/domain/partition-d1.ts`: the numbers in them
 * are what selecting `SB_PARTITION=d1` is supposed to buy. A re-implementation
 * that is nearly the harness buys nearly those numbers, which is to say it buys
 * numbers nobody measured. So this asserts the partitions are the same, on the
 * corpora the artefacts were written from, at the setting they chose.
 *
 * THE TWO SIDES
 *
 *   reference — `dendrogram` / `cosine` / `centroid` from `bakeoff-lib.mjs`,
 *     driven by the D1 strategy transcribed verbatim from `bakeoff-partition.mjs`
 *     (the `D1` entry of `FAMILIES`, lines 248-264, and the `incremental` arrival
 *     driver, lines 550-624). No product code is involved beyond `pinClusterText`
 *     and the two embedder adapters, which both sides must share or they would
 *     not be clustering the same vectors.
 *   product   — `agglomerateD1` and `partitionD1` from `core/dist`.
 *
 * WHAT IS COMPARED. The PARTITION: each group id-sorted, the groups themselves
 * sorted, joined. Deliberately not the emission order — the harness emits bucket
 * by bucket and the product restores `agglomerate`'s documented order (groups by
 * smallest member id), which is a stated difference in `partition-d1.ts` and is
 * not a difference in what the learner gets. Everything else — membership, topic
 * continuity across arrivals, which pins attach — is compared exactly.
 *
 *   node scripts/check-d1-equivalence.mjs
 *
 * Exits non-zero on any divergence. Needs Ollama for the `nomic` half; without
 * it the TF-IDF-only half still runs and the report says plainly which half was
 * proven and which was not.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pinClusterText, agglomerateD1, partitionD1 } from '../core/dist/index.js';
import { TfIdfEmbedder } from '../adapters/dist/index.js';
import { dendrogram, cosine, centroid, nomicVectors, saveCache, EPS, OLLAMA_MODEL } from './bakeoff-lib.mjs';

/** The setting both artefacts carried: TF-IDF bucket 0.08, then nomic 0.635. */
const TC = 0.08;
const TT = 0.635;

/**
 * The fine cut used when no embedding model is reachable and TF-IDF has to play
 * the fine role as well. 0.635 is a fact about the nomic space: in TF-IDF it is
 * so far above the board's distribution that every pin comes back a singleton,
 * and a check where nothing merges checks nothing. 0.12 is TF-IDF's own measured
 * cut (`CLUSTER_THRESHOLDS`), which puts the fallback comparison somewhere real.
 */
const TT_TFIDF = 0.12;
const fineCut = (fine) => (fine === 'nomic' ? TT : TT_TFIDF);

// ------------------------------------------------------------- the corpora

/** Identical to `bakeoff-lib.mjs`'s `toPin` — the fixture is flat, the
 *  clusterer reads a capture envelope. */
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

const load = (path) => JSON.parse(readFileSync(path, 'utf8')).map(toPin)
  .sort((a, b) => (a.id < b.id ? -1 : 1));

const seedPins = load('scripts/eval-pins.json');
const syntheticPins = load('scripts/real-pins.json');
const scalePins = load('scripts/scale-pins.json');

const num = (p) => Number(p.id.slice(4));
const slice = (pins, lo, hi) => pins.filter((p) => num(p) >= lo && num(p) <= hi);

/**
 * The seed board is the first 21 pins of the corpus it is compared against, or
 * the incremental protocol is measuring two different things. The harness
 * asserts this too (`bakeoff-partition.mjs` lines 119-122); it is repeated here
 * because this script can be run on its own.
 */
assert.equal(
  JSON.stringify(seedPins.map((p) => p.envelope.selection)),
  JSON.stringify(slice(scalePins, 1, 21).map((p) => p.envelope.selection)),
  'the 21-pin seed fixture is no longer the first 21 scale pins',
);

// ------------------------------------------------------------------ spaces

const tfidf = new TfIdfEmbedder();

/**
 * TF-IDF is recomputed per board and never cached: its IDF is a property of the
 * batch handed to `embed`, so a pin's vector is a fact about the board it is in.
 * The product's clusterer embeds the whole board in one call for the same
 * reason, so this is what production does as well as what the harness did.
 */
async function tfidfOf(pins) {
  const vectors = await tfidf.embed(pins.map(pinClusterText));
  return new Map(pins.map((p, i) => [p.id, vectors[i]]));
}

/** Nomic, through the bake-off's own disk cache — the same vectors the
 *  artefacts' numbers were computed from, where the cache still holds them. */
async function nomicOf(pins) {
  const items = await nomicVectors(pins);
  return new Map(items.map((it) => [it.id, it.vector]));
}

/**
 * One board in both spaces. `fine` selects which space plays the fine role:
 * 'nomic' is the shipped D1 setting, 'tfidf' is the fallback this script uses
 * when no embedding model is reachable — structurally identical, and honest
 * about being a weaker claim.
 */
async function spacesOf(pins, fine) {
  const sorted = [...pins].sort((a, b) => (a.id < b.id ? -1 : 1));
  const coarse = await tfidfOf(sorted);
  const fineMap = fine === 'nomic' ? await nomicOf(sorted) : coarse;
  return {
    pins: sorted,
    items: sorted.map((p) => ({ id: p.id, coarse: coarse.get(p.id), fine: fineMap.get(p.id) })),
  };
}

// ------------------------------------------------------- the reference side

/** `bakeoff-partition.mjs` line 158. */
const cutSubset = (items, t) => (items.length ? dendrogram(items).cut(t) : []);

/**
 * `bakeoff-partition.mjs` lines 251-259, verbatim but for the parameter shape:
 * bucket in the coarse space, then cut inside each bucket in the fine one.
 */
function refCold(items, tc, tt) {
  const fineItems = items.map((it) => ({ id: it.id, vector: it.fine }));
  const tfItems = items.map((it) => ({ id: it.id, vector: it.coarse }));
  const byId = new Map(fineItems.map((it) => [it.id, it]));
  const out = [];
  for (const bucket of cutSubset(tfItems, tc)) {
    const sub = bucket.map((id) => byId.get(id));
    for (const g of cutSubset(sub, tt)) out.push(g);
  }
  return out;
}

/** `bakeoff-partition.mjs` line 262. */
const refAccept = (tc, tt) => (vN, vT) => vT >= tc && vN >= tt;

/**
 * `bakeoff-partition.mjs` lines 566-618 — one arrival of the attach-only
 * driver, lifted with only the vector plumbing adapted. Established topics are
 * given, both centroids are frozen, the candidate topic is chosen on the fine
 * space alone, and the single acceptance test then sees both similarities.
 */
function refArrive(items, established, tc, tt) {
  const vN = new Map(items.map((it) => [it.id, it.fine]));
  const vT = new Map(items.map((it) => [it.id, it.coarse]));
  const accept = refAccept(tc, tt);

  const claimed = new Map();
  for (const g of [...established].sort((x, y) => (x.topicId < y.topicId ? -1 : 1))) {
    for (const id of [...g.memberIds].sort()) if (!claimed.has(id)) claimed.set(id, g.topicId);
  }
  const centroids = [...established]
    .sort((x, y) => (x.topicId < y.topicId ? -1 : 1))
    .map((g) => {
      const members = [...g.memberIds].filter((id) => claimed.get(id) === g.topicId).sort();
      return {
        topicId: g.topicId, members,
        cN: centroid(members.map((id) => vN.get(id))),
        cT: centroid(members.map((id) => vT.get(id))),
      };
    })
    .filter((c) => c.members.length > 0);

  const attachedTo = new Map();
  const leftover = [];
  for (const it of [...items].sort((x, y) => (x.id < y.id ? -1 : 1))) {
    if (claimed.has(it.id)) continue;
    let bestTopic = null, bestSim = -Infinity, bestC = null;
    for (const c of centroids) {
      const s = cosine(vN.get(it.id), c.cN);
      if (s > bestSim + EPS) { bestSim = s; bestTopic = c.topicId; bestC = c; }
    }
    const ok = bestC !== null
      && accept(cosine(vN.get(it.id), bestC.cN), cosine(vT.get(it.id), bestC.cT));
    if (ok) attachedTo.set(bestTopic, [...(attachedTo.get(bestTopic) ?? []), it.id]);
    else leftover.push(it.id);
  }

  const groups = centroids.map((c) => ({
    topicId: c.topicId,
    pinIds: [...c.members, ...(attachedTo.get(c.topicId) ?? [])].sort(),
  }));
  const left = items.filter((it) => leftover.includes(it.id));
  for (const g of refCold(left, tc, tt)) groups.push({ topicId: null, pinIds: [...g].sort() });
  return groups;
}

// ---------------------------------------------------------------- compare

/** The partition, canonically: membership only, order removed on both sides. */
const canon = (groups) => groups
  .map((g) => [...g].sort().join(','))
  .sort()
  .join(' | ');

/**
 * Topic continuity, without depending on the two sides having handed out the
 * same topic ids. Each group is reported as whether it is a topic that already
 * existed or one being created, plus its membership; the ids themselves are
 * assigned by each chain in its own emission order and are not the claim.
 */
const canonTopics = (groups) => groups
  .map((g) => `${g.topicId === null ? 'NEW' : 'EXISTING'}:${[...g.pinIds].sort().join(',')}`)
  .sort()
  .join(' | ');

const pad = (n) => `T${String(n).padStart(2, '0')}`;

/**
 * The arrival driver, run identically over both implementations: seed board
 * cold, then each batch attach-only, comparing the partition after every
 * arrival rather than only at the end — a divergence that heals by the last
 * batch is still a divergence.
 */
async function compareIncremental(name, corpus, batches, fine, results) {
  const tt = fineCut(fine);
  const seed = await spacesOf(slice(corpus, 1, 21), fine);
  let refEstablished = refCold(seed.items, TC, tt)
    .map((ids, i) => ({ topicId: pad(i + 1), memberIds: [...ids].sort() }));
  let prodEstablished = agglomerateD1(seed.items, TC, tt)
    .map((ids, i) => ({ topicId: pad(i + 1), memberIds: [...ids].sort() }));
  results.push({
    board: `${name} seed-21 cold`, fine,
    ok: canon(refEstablished.map((g) => g.memberIds)) === canon(prodEstablished.map((g) => g.memberIds)),
    ref: canon(refEstablished.map((g) => g.memberIds)),
    prod: canon(prodEstablished.map((g) => g.memberIds)),
  });

  let seen = [...slice(corpus, 1, 21)];
  let refNext = refEstablished.length + 1, prodNext = prodEstablished.length + 1;
  for (const [label, batch] of batches) {
    seen = [...seen, ...batch];
    const { items } = await spacesOf(seen, fine);

    // Each side runs its OWN chain from its own seed, which is what the
    // artefacts' incremental numbers were produced by. Feeding the product the
    // reference's state at every step would prove one arrival at a time and
    // hide any drift that compounds.
    const refGroups = refArrive(items, refEstablished, TC, tt);
    const prodGroups = partitionD1({
      items, existing: prodEstablished, bucketThreshold: TC, threshold: tt,
    });

    // Both sides asserted for the promise the whole design exists for.
    for (const [side, before, groups] of [
      ['reference', refEstablished, refGroups], ['product', prodEstablished, prodGroups],
    ]) {
      const was = new Map();
      for (const g of before) for (const id of g.memberIds) was.set(id, g.topicId);
      for (const g of groups) for (const id of g.pinIds) {
        assert.ok(!was.has(id) || was.get(id) === g.topicId,
          `${side}: ${id} moved out of ${was.get(id)} on ${label}`);
      }
    }

    results.push({
      board: `${name} ${label}`, fine,
      ok: canonTopics(refGroups) === canonTopics(prodGroups),
      ref: canonTopics(refGroups),
      prod: canonTopics(prodGroups),
    });

    refEstablished = refGroups.map((g) => ({
      topicId: g.topicId ?? pad(refNext++), memberIds: [...g.pinIds].sort(),
    }));
    prodEstablished = prodGroups.map((g) => ({
      topicId: g.topicId ?? pad(prodNext++), memberIds: [...g.pinIds].sort(),
    }));
  }
}

async function compareCold(name, pins, fine, results) {
  const tt = fineCut(fine);
  const { items } = await spacesOf(pins, fine);
  const ref = canon(refCold(items, TC, tt));
  const prod = canon(agglomerateD1(items, TC, tt));
  results.push({ board: `${name} cold`, fine, ok: ref === prod, ref, prod });
}

// ------------------------------------------------------------------- run

const results = [];

let nomicAvailable = false;
try {
  await nomicVectors(seedPins.slice(0, 1));
  nomicAvailable = true;
} catch (err) {
  console.log(`nomic unavailable — ${String(err).slice(0, 120)}`);
}

const spacesToCheck = nomicAvailable ? ['tfidf', 'nomic'] : ['tfidf'];

for (const fine of spacesToCheck) {
  await compareCold('seed-21', seedPins, fine, results);
  await compareCold('synthetic-50', syntheticPins, fine, results);
  await compareCold('scale-80', scalePins, fine, results);
  // Two arrival batches for the independently authored 50-pin corpus,
  // three for the 80-pin synthetic one.
  await compareIncremental('synthetic-50', syntheticPins, [
    ['batch 1 (22-36)', slice(syntheticPins, 22, 36)],
    ['batch 2 (37-50)', slice(syntheticPins, 37, 50)],
  ], fine, results);
  await compareIncremental('scale-80', scalePins, [
    ['batch 1 (22-41)', slice(scalePins, 22, 41)],
    ['batch 2 (42-61)', slice(scalePins, 42, 61)],
    ['batch 3 (62-80)', slice(scalePins, 62, 80)],
  ], fine, results);
}

saveCache();

console.log(`\n# D1 equivalence — product against the bake-off harness, coarse tfidf ${TC}\n`);
console.log('| board | fine space | fine cut | groups | verdict |');
console.log('| :---- | :--------- | -------: | -----: | :------ |');
for (const r of results) {
  const groups = r.ref.split(' | ').length;
  console.log(`| ${r.board} | ${r.fine} | ${fineCut(r.fine)} | ${groups} | ${r.ok ? 'IDENTICAL' : 'DIVERGED'} |`);
}

const bad = results.filter((r) => !r.ok);
for (const r of bad) {
  console.log(`\nDIVERGENCE — ${r.board} (${r.fine})`);
  console.log(`  reference: ${r.ref}`);
  console.log(`  product  : ${r.prod}`);
}

console.log(`\n${results.length} comparisons, ${bad.length} divergences`);
if (!nomicAvailable) {
  console.log('\nHALF PROVEN ONLY: no embedding model was reachable, so the fine space here is'
    + ` TF-IDF as well. The two-stage structure, the bucket cut, the attach protocol and the`
    + ` arrival driver are all exercised; what is NOT proven is the shipped setting's own fine`
    + ` space (${OLLAMA_MODEL}). Re-run with Ollama up for the full claim.`);
} else {
  console.log(`\nBoth halves proven: the coarse TF-IDF bucket layer and the shipped fine space (${OLLAMA_MODEL}).`);
}

if (bad.length) process.exit(1);
console.log('\nall comparisons identical');
