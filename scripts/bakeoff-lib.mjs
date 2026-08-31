/**
 * Shared machinery for the partition bake-off — corpora, vectors, clustering
 * primitives, scoring and the repair-cost model.
 *
 * This file is measurement-only. Nothing here is imported by the product, and
 * nothing here modifies `core/`. The clustering primitives are a deliberate
 * re-implementation of `core/src/domain/clustering.ts` rather than a call into
 * it, for one reason: the candidate strategies need the *merge height sequence*
 * and the *linkage matrix*, which the shipped `agglomerate` correctly does not
 * expose. `bakeoff-partition.mjs` asserts that the re-implementation reproduces
 * the shipped partition bit for bit before it trusts anything built on it.
 *
 * Determinism is preserved exactly as core preserves it: every iteration order
 * is fixed by sorting on pin id, every tie resolves by that same id order, and
 * nothing reads a clock, a hash seed or a Map insertion order.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { pinClusterText } from '../core/dist/index.js';
import { TfIdfEmbedder, OllamaEmbedder } from '../adapters/dist/index.js';
import { requireOllama } from './preflight.mjs';

export const EPS = 1e-12;

// --------------------------------------------------------------- the corpus

const pinsRaw = JSON.parse(readFileSync('scripts/scale-pins.json', 'utf8'));
const expected = JSON.parse(readFileSync('scripts/scale-expected.json', 'utf8'));

export const expectOf = new Map(expected.map((e) => [e.id, e.expect]));

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

export const PINS = pinsRaw.map(toPin).sort((a, b) => (a.id < b.id ? -1 : 1));
export const pinById = new Map(PINS.map((p) => [p.id, p]));
const num = (p) => Number(p.id.slice(4));

/**
 * Domains, for reading merge failures. Derived from the key, never given to a
 * strategy — a cross-domain weld is the failure the design most fears and it
 * has to be observed, not prevented by feeding the answer in.
 */
export const DOMAIN = (key) => key.startsWith('rust-') ? 'rust'
  : key.startsWith('sourdough-') ? 'sourdough'
  : ['intervals', 'seventh-chords', 'tritone-sub', 'voice-leading', 'modal-interchange'].includes(key) ? 'jazz'
  : key === 'bicycle-indexing' ? 'outlier' : 'cloud';

/**
 * The static boards. `seed-21` is byte-identical to `scripts/eval-pins.json`
 * (asserted in the harness), so its numbers are directly comparable to Run 5.
 * `sparse-20` is every fourth pin: 18 key topics in 20 pins, the shape a young
 * board actually has and the worst cell in Run 6.
 */
export const BOARDS = [
  ['seed-21', PINS.filter((p) => num(p) <= 21)],
  ['full-80', PINS],
  ['slice-1-20', PINS.slice(0, 20)],
  ['slice-21-40', PINS.slice(20, 40)],
  ['slice-41-60', PINS.slice(40, 60)],
  ['slice-61-80', PINS.slice(60, 80)],
  ['sparse-20', PINS.filter((_, i) => i % 4 === 0)],
];

/** Three arrivals after the original board, in the order a learner would pin. */
export const BATCHES = [
  ['batch 1 (22-41)', PINS.filter((p) => num(p) >= 22 && num(p) <= 41)],
  ['batch 2 (42-61)', PINS.filter((p) => num(p) >= 42 && num(p) <= 61)],
  ['batch 3 (62-80)', PINS.filter((p) => num(p) >= 62 && num(p) <= 80)],
];

// ------------------------------------------------------------------ vectors

/**
 * Embedding cache. The corpus is fixed and a sweep re-clusters the same eighty
 * texts thousands of times, so the embedder is called exactly once per distinct
 * text per process lifetime and the result is kept on disk. Keyed by SHA-256 of
 * the text and by model id, so a corpus edit invalidates only what it changed.
 *
 * TF-IDF is deliberately NOT cached by text: its IDF is computed over the batch
 * handed to `embed`, so a pin's vector is a property of the board it is in.
 * Caching it per text would silently change what is being measured. It is free
 * to recompute and is recomputed per board.
 */
const CACHE_PATH = process.env.SB_BAKEOFF_CACHE ?? '.bakeoff-cache/embeddings.json';
const cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {};
let cacheDirty = false;

const keyOf = (modelId, text) => `${modelId}:${createHash('sha256').update(text).digest('hex')}`;

export function saveCache() {
  if (!cacheDirty) return;
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache));
  cacheDirty = false;
}

let ollama = null;
export const OLLAMA_MODEL = 'nomic-embed-text';

/**
 * Nomic vectors for a set of pins, from cache where possible. The equivalence
 * check may request a catchable unavailable-model error so it can run and label
 * its documented TF-IDF-only fallback; benchmark callers remain strict.
 */
export async function nomicVectors(pins, { allowUnavailable = false } = {}) {
  const texts = pins.map(pinClusterText);
  const missing = [];
  for (const t of texts) if (cache[keyOf(OLLAMA_MODEL, t)] === undefined) missing.push(t);
  const uniqueMissing = [...new Set(missing)].sort();
  if (uniqueMissing.length) {
    // Checked here rather than at the top of the bake-off: a warm cache needs no
    // model at all, and a preflight that refused that run would be wrong.
    if (!ollama) await requireOllama([OLLAMA_MODEL], {
      hint: `Vectors already in ${CACHE_PATH} are reused; only ${uniqueMissing.length} new text(s) need the model.`,
      throwOnFailure: allowUnavailable,
    });
    ollama ??= new OllamaEmbedder({ model: OLLAMA_MODEL, timeoutMs: 300_000 });
    const vectors = await ollama.embed(uniqueMissing);
    for (const [i, t] of uniqueMissing.entries()) cache[keyOf(OLLAMA_MODEL, t)] = vectors[i];
    cacheDirty = true;
    saveCache();
  }
  return pins.map((p, i) => ({ id: p.id, vector: cache[keyOf(OLLAMA_MODEL, texts[i])] }));
}

const tfidf = new TfIdfEmbedder();

/** TF-IDF vectors, computed over exactly this board — see the note above. */
export async function tfidfVectors(pins) {
  const vectors = await tfidf.embed(pins.map(pinClusterText));
  return pins.map((p, i) => ({ id: p.id, vector: vectors[i] }));
}

/** Both spaces for one board, aligned by pin id and sorted by it. */
export async function spacesFor(pins) {
  const sorted = [...pins].sort((a, b) => (a.id < b.id ? -1 : 1));
  const [nomic, tf] = await Promise.all([nomicVectors(sorted), tfidfVectors(sorted)]);
  return { ids: sorted.map((p) => p.id), nomic, tfidf: tf, pins: sorted };
}

// ------------------------------------------------------- linear algebra

export function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] ?? 0, y = b[i] ?? 0; dot += x * y; na += x * x; nb += y * y; }
  for (let i = n; i < a.length; i++) { const x = a[i] ?? 0; na += x * x; }
  for (let i = n; i < b.length; i++) { const y = b[i] ?? 0; nb += y * y; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function centroid(vectors) {
  const width = vectors.reduce((w, v) => Math.max(w, v.length), 0);
  if (!vectors.length || !width) return [];
  const out = new Array(width).fill(0);
  for (const v of vectors) for (let i = 0; i < width; i++) out[i] = (out[i] ?? 0) + (v[i] ?? 0);
  for (let i = 0; i < width; i++) out[i] /= vectors.length;
  return out;
}

const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Full pairwise similarity matrix over id-sorted items. */
export function simMatrix(items) {
  const n = items.length;
  const sim = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = cosine(items[i].vector, items[j].vector);
      sim[i][j] = s; sim[j][i] = s;
    }
  }
  return sim;
}

/** The upper triangle, ascending. The board's own similarity distribution. */
export function pairwiseValues(sim) {
  const out = [];
  for (let i = 0; i < sim.length; i++) for (let j = i + 1; j < sim.length; j++) out.push(sim[i][j]);
  return out.sort((a, b) => a - b);
}

export function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

// -------------------------------------------------------- agglomerative

/**
 * Average-linkage agglomeration, run all the way to one cluster, recording the
 * height of every merge. Cutting the recorded sequence at a threshold gives the
 * identical partition to `core`'s `agglomerate` at that threshold (asserted),
 * but the sequence itself is what strategy C needs to find its own cut.
 *
 * Returns { order, heights, snapshot } where `snapshot(k)` is the partition
 * after (n - k) merges, i.e. the k-cluster partition.
 */
export function dendrogram(items) {
  const sorted = [...items].sort((a, b) => byString(a.id, b.id));
  const n = sorted.length;
  const sim = simMatrix(sorted);
  const avg = (a, b) => {
    let total = 0;
    for (const i of a) for (const j of b) total += sim[i][j];
    return total / (a.length * b.length);
  };
  let clusters = sorted.map((_, i) => [i]);
  const heights = [];
  const states = [clusters.map((c) => [...c])];
  while (clusters.length > 1) {
    let best = -Infinity, bi = -1, bj = -1;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const s = avg(clusters[i], clusters[j]);
        if (s > best + EPS) { best = s; bi = i; bj = j; }
      }
    }
    if (bi < 0) break;
    const merged = [...clusters[bi], ...clusters[bj]].sort((x, y) => x - y);
    clusters[bi] = merged;
    clusters = clusters.filter((_, k) => k !== bj);
    heights.push(best);
    states.push(clusters.map((c) => [...c]));
  }
  const label = (state) => state.map((c) => c.map((i) => sorted[i].id).sort(byString));
  return {
    n,
    heights,
    sim,
    ids: sorted.map((it) => it.id),
    /** Partition after `m` merges. */
    at: (m) => label(states[Math.max(0, Math.min(m, states.length - 1))]),
    /** Partition cut at similarity `t` — identical to core's agglomerate. */
    cut: (t) => {
      let m = 0;
      while (m < heights.length && heights[m] + EPS >= t) m++;
      return label(states[m]);
    },
  };
}

/** Convenience: the shipped algorithm, cut at t. */
export function agglomerateAt(items, t) {
  if (!items.length) return [];
  return dendrogram(items).cut(t);
}

// ------------------------------------------------------------- scoring

export function score(groups, ids) {
  const assigned = new Map();
  groups.forEach((g, i) => g.forEach((id) => assigned.set(id, i)));
  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const same = assigned.get(ids[i]) === assigned.get(ids[j]);
      const should = expectOf.get(ids[i]) === expectOf.get(ids[j]);
      if (same && should) tp++; else if (same) fp++; else if (should) fn++;
    }
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const f05 = precision + recall === 0 ? 0 : (1.25 * precision * recall) / (0.25 * precision + recall);
  return { precision, recall, f1, f05, topics: groups.length, tp, fp, fn };
}

/**
 * The two failure modes, separated, because they do not cost the learner the
 * same thing.
 *
 * WELD — a group holding more than one key topic. Repairing it is pin-by-pin
 * surgery: every pin that is not part of the group's dominant key topic has to
 * be individually moved out. `weldPins` counts exactly those pins, and
 * `weldWorst` is the largest single wrongly-merged group (its pin count and how
 * many key topics it spans), which is the number a learner actually meets.
 *
 * FRAGMENTATION — a key topic torn across several groups. Repairing it is one
 * merge tap per extra fragment. `mergeTaps` counts those taps and `tornWorst`
 * is the worst-torn topic.
 *
 * `repairCost = mergeTaps + weldPins`, both measured in learner actions. It is
 * the single number that encodes the asymmetry strategy B is built on: a wrong
 * split costs one tap, a weld costs one action per misplaced pin.
 */
export function failureProfile(groups) {
  let weldPins = 0, weldWorst = { pins: 0, keys: 0 }, crossDomain = 0;
  for (const g of groups) {
    const counts = new Map();
    for (const id of g) {
      const k = expectOf.get(id);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const dominant = Math.max(...counts.values());
    const stray = g.length - dominant;
    weldPins += stray;
    if (counts.size > 1 && (g.length > weldWorst.pins
      || (g.length === weldWorst.pins && counts.size > weldWorst.keys))) {
      weldWorst = { pins: g.length, keys: counts.size };
    }
    if (new Set([...counts.keys()].map(DOMAIN)).size > 1) crossDomain++;
  }
  const spread = new Map();
  for (const [i, g] of groups.entries()) for (const id of g) {
    const k = expectOf.get(id);
    if (!spread.has(k)) spread.set(k, new Set());
    spread.get(k).add(i);
  }
  const torn = [...spread.entries()].filter(([, s]) => s.size > 1);
  const mergeTaps = torn.reduce((n, [, s]) => n + s.size - 1, 0);
  const tornWorst = torn.reduce((m, [, s]) => Math.max(m, s.size), 1);
  return {
    weldPins, weldWorst, crossDomain,
    tornTopics: torn.length, mergeTaps, tornWorst,
    repairCost: mergeTaps + weldPins,
  };
}

export const pct = (x) => `${(x * 100).toFixed(1)}`;
export const shape = (groups) => groups.map((g) => [...g].sort(byString).join(',')).join(' | ');
export { byString };
