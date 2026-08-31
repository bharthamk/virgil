/**
 * The partition bake-off — five candidate strategies, seven boards, one table.
 *
 * AGENT_EVAL_LOG.md Run 6 measured the problem this quantifies: the shipped cut
 * point (nomic @ 0.635) is a fit to the 21-pin board. It scores F1 53.0% at 80
 * pins where the sweep optimum has moved to 0.675, quality is domain-shaped
 * (vendor docs 89-93%, shared-vocabulary domains 42-57%), a sparse young board
 * scores 36.4%, and attach-only arrival costs a further ten F1 points on top.
 *
 * The open question is not "what number is best on this corpus" — Run 6 already
 * showed that question has a different answer on every board. It is: what
 * PARTITION RULE is robust across board size, domain mixture and board age,
 * given that the model may not make partition decisions (determinism is law)
 * and the learner now has manual split/merge as a repair path.
 *
 * Five families, all deterministic, none of them calling a model:
 *
 *   A  fixed threshold per space — what ships today.
 *   B  conservative over-split — a deliberately higher fixed cut, selected on
 *      repair cost rather than F1, because a wrong split is one merge tap and a
 *      weld is pin-by-pin surgery.
 *   C  adaptive — the cut point read off the board's own similarity
 *      distribution (percentile) or its own merge-height sequence (largest gap,
 *      knee). No fixed number at all.
 *   D  two-stage — coarse lexical buckets first, then a tighter cut inside each
 *      bucket, so the threshold no longer has to span cross-domain variance.
 *   E  hybrid spaces — nomic and TF-IDF as two votes: intersection, union, or a
 *      normalised margin sum.
 *
 * Two things make the numbers honest rather than flattering:
 *
 *   1. Every family with a free parameter is scored BOTH fitted (best setting
 *      over all seven boards — the number a sweep would report, and the sin Run
 *      6 caught) and held out, leave-one-board-out: the setting is chosen on the
 *      other six boards and reported on the seventh. The gap between the two is
 *      the size of the fit.
 *   2. F1 is not the only column. `weldPins` and `mergeTaps` separate the two
 *      failure modes, and `repairCost = mergeTaps + weldPins` prices them in
 *      learner actions.
 *
 *   node scripts/bakeoff-partition.mjs            # everything
 *   node scripts/bakeoff-partition.mjs --quick    # skip the incremental stage
 *
 * Embedder only, no model. Nomic vectors are cached to `.bakeoff-cache/`
 * (gitignored) because the corpus is fixed and the sweeps re-cluster the same
 * eighty texts thousands of times. TF-IDF is deliberately not cached: its IDF is
 * a property of the board, so it is recomputed per board.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agglomerate as coreAgglomerate, pinClusterText, thresholdFor } from '../core/dist/index.js';
import { OllamaEmbedder } from '../adapters/dist/index.js';
import {
  BOARDS, BATCHES, PINS, expectOf, DOMAIN, spacesFor, dendrogram, simMatrix,
  pairwiseValues, percentile, cosine, centroid, score, failureProfile, shape,
  saveCache, EPS, OLLAMA_MODEL,
} from './bakeoff-lib.mjs';

const QUICK = process.argv.includes('--quick');
const pctf = (x) => (x * 100).toFixed(1);

// --------------------------------------------------------------- board setup

const boards = [];
for (const [name, pins] of BOARDS) {
  const s = await spacesFor(pins);
  boards.push({
    name, pins, s,
    n: s.ids.length,
    keyTopics: new Set(s.ids.map((id) => expectOf.get(id))).size,
    dN: dendrogram(s.nomic),
    dT: dendrogram(s.tfidf),
    simN: simMatrix(s.nomic),
    simT: simMatrix(s.tfidf),
  });
}
for (const b of boards) {
  b.pvN = pairwiseValues(b.simN);
  b.pvT = pairwiseValues(b.simT);
  const m = (v) => v.reduce((a, x) => a + x, 0) / v.length;
  const sd = (v, mu) => Math.sqrt(v.reduce((a, x) => a + (x - mu) ** 2, 0) / v.length) || 1;
  b.meanN = m(b.pvN); b.sdN = sd(b.pvN, b.meanN);
  b.meanT = m(b.pvT); b.sdT = sd(b.pvT, b.meanT);
}
const board = (name) => boards.find((b) => b.name === name);

console.log(`# Partition bake-off — ${boards.length} boards, ${PINS.length} pins in the corpus`);
console.log(`\n| board | pins | key topics |`);
console.log(`| :---- | ---: | ---------: |`);
for (const b of boards) console.log(`| ${b.name} | ${b.n} | ${b.keyTopics} |`);

// ------------------------------------------------- the re-implementation check

/**
 * Everything below is built on a local re-implementation of core's agglomerate,
 * because the strategies need the merge-height sequence core correctly hides.
 * The re-implementation is worth nothing unless it reproduces the shipped
 * partition exactly, so that is asserted first, on every board, in both spaces.
 */
{
  let checked = 0;
  for (const b of boards) {
    for (const [items, d, t] of [[b.s.nomic, b.dN, 0.635], [b.s.tfidf, b.dT, 0.12]]) {
      assert.equal(shape(d.cut(t)), shape(coreAgglomerate(items, t)),
        `${b.name}: local dendrogram cut disagrees with core.agglomerate at ${t}`);
      checked++;
    }
  }
  // And the shipped constants are what this harness thinks they are.
  assert.equal(thresholdFor('nomic-embed-text'), 0.635);
  assert.equal(thresholdFor('tfidf-v1'), 0.12);

  // The seed board's numbers are only comparable to Run 5 if it is the same
  // twenty-one pins and the same key, so that is checked rather than assumed.
  const seedFixture = JSON.parse(readFileSync('scripts/eval-pins.json', 'utf8'));
  const seedKey = JSON.parse(readFileSync('scripts/eval-expected.json', 'utf8'));
  const scaleFixture = JSON.parse(readFileSync('scripts/scale-pins.json', 'utf8'));
  const scaleKey = JSON.parse(readFileSync('scripts/scale-expected.json', 'utf8'));
  assert.equal(JSON.stringify(seedFixture), JSON.stringify(scaleFixture.slice(0, 21)),
    'the 21-pin seed fixture is no longer byte-identical to the first 21 scale pins');
  assert.deepEqual(seedKey.map((e) => e.expect), scaleKey.slice(0, 21).map((e) => e.expect),
    'the 21-pin key disagrees with the scale key over the same pins');

  console.log(`\nre-implementation check: ${checked} cuts reproduce core.agglomerate exactly`);
  console.log('seed board: 21 pins byte-identical to scripts/eval-pins.json, key agrees');
}

// -------------------------------------------------------- clustering engines

/** Dual-space average-linkage. `accept` gates a merge, `rank` picks among the
 *  eligible. Determinism identical to core: id-sorted items, EPS tie-break. */
function agglomerateDual(b, items, accept, rank) {
  const pos = new Map(b.s.ids.map((id, i) => [id, i]));
  const idx = items.map((it) => pos.get(it.id));
  const avg = (sim, a, c) => {
    let total = 0;
    for (const i of a) for (const j of c) total += sim[idx[i]][idx[j]];
    return total / (a.length * c.length);
  };
  let clusters = items.map((_, i) => [i]);
  for (;;) {
    let best = -Infinity, bi = -1, bj = -1;
    for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) {
      const aN = avg(b.simN, clusters[i], clusters[j]);
      const aT = avg(b.simT, clusters[i], clusters[j]);
      if (!accept(aN, aT)) continue;
      const r = rank(aN, aT);
      if (r > best + EPS) { best = r; bi = i; bj = j; }
    }
    if (bi < 0) break;
    clusters[bi] = [...clusters[bi], ...clusters[bj]].sort((x, y) => x - y);
    clusters = clusters.filter((_, k) => k !== bj);
  }
  return clusters.map((c) => c.map((i) => items[i].id).sort());
}

/** Single-space cut over an arbitrary subset, via a fresh dendrogram. */
const cutSubset = (items, t) => (items.length ? dendrogram(items).cut(t) : []);

/** C2 / C2b: cut points read off the merge-height sequence itself. */
function gapCut(heights, floor) {
  const above = heights.filter((h) => h >= floor);
  if (above.length < 2) return heights.length ? heights[0] + 1e-9 : 1;
  let bestGap = -1, bestM = 1;
  for (let m = 1; m < above.length; m++) {
    const g = above[m - 1] - above[m];
    if (g > bestGap + EPS) { bestGap = g; bestM = m; }
  }
  return (above[bestM - 1] + above[bestM]) / 2;
}
function kneeCut(heights) {
  const N = heights.length;
  if (N < 3) return heights[0] ?? 1;
  const ymax = heights[0], ymin = heights[N - 1];
  const span = ymax - ymin || 1;
  let best = -Infinity, bi = 0;
  for (let i = 0; i < N; i++) {
    const x = i / (N - 1);
    const dv = (heights[i] - ymin) / span - (1 - x);
    if (dv > best + EPS) { best = dv; bi = i; }
  }
  return (heights[bi] + (heights[bi + 1] ?? heights[bi])) / 2;
}

// ----------------------------------------------------------- the strategies

/**
 * A family is a name, a grid of parameter settings, a cold clusterer and an
 * attach rule. `params: [null]` means the family has no free parameter and so
 * cannot be fitted — A, C2 and C2b are in that position by construction, which
 * is a point in their favour and is stated as such in the write-up.
 */
const FAMILIES = [
  {
    id: 'A-nomic', label: 'A. fixed nomic @0.635 (shipped)', params: [null],
    cluster: (b, items) => cutSubset(items, 0.635),
    attach: () => (vN) => vN >= 0.635,
    describe: () => 'nomic 0.635',
  },
  {
    id: 'A-tfidf', label: 'A. fixed TF-IDF @0.12 (shipped fallback)', params: [null],
    space: 'tfidf',
    cluster: (b, items, _p, tfItems) => cutSubset(tfItems, 0.12),
    attach: () => (vN, vT) => vT >= 0.12,
    describe: () => 'tfidf 0.12',
  },
  {
    id: 'A-0.675', label: 'A2. fixed nomic @0.675 (Run 6 80-pin optimum)', params: [null],
    cluster: (b, items) => cutSubset(items, 0.675),
    attach: () => (vN) => vN >= 0.675,
    describe: () => 'nomic 0.675',
  },
  {
    id: 'B', label: 'B. conservative over-split (fixed, repair-cost selected)',
    // Constrained at or above the shipped cut: the family's thesis is that the
    // cheap-repair direction is over-splitting, so a value below shipped would
    // not be this strategy.
    params: range(0.635, 0.760, 0.005),
    objective: 'repair',
    cluster: (b, items, t) => cutSubset(items, t),
    attach: (b, t) => (vN) => vN >= t,
    describe: (t) => `nomic ${t.toFixed(3)}`,
  },
  {
    id: 'C1', label: 'C1. adaptive — percentile of the board\'s pairwise distribution',
    params: [0.80, 0.82, 0.84, 0.86, 0.88, 0.90, 0.92, 0.94, 0.95, 0.96, 0.97, 0.98],
    cluster: (b, items, p) => cutSubset(items, percentile(b.pvN, p)),
    attach: (b, p) => { const t = percentile(b.pvN, p); return (vN) => vN >= t; },
    describe: (p) => `nomic p${(p * 100).toFixed(0)} of board pairwise`,
  },
  {
    id: 'C2', label: 'C2. adaptive — largest gap in the merge-height sequence', params: [null],
    cluster: (b, items) => {
      const d = dendrogram(items);
      const pv = pairwiseValues(simMatrix(items));
      const mu = pv.reduce((a, x) => a + x, 0) / (pv.length || 1);
      return d.cut(gapCut(d.heights, mu));
    },
    attach: (b) => { const t = gapCut(b.dN.heights, b.meanN); return (vN) => vN >= t; },
    describe: () => 'largest gap above board mean similarity',
  },
  {
    id: 'C2b', label: 'C2b. adaptive — knee of the merge-height curve', params: [null],
    cluster: (b, items) => { const d = dendrogram(items); return d.cut(kneeCut(d.heights)); },
    attach: (b) => { const t = kneeCut(b.dN.heights); return (vN) => vN >= t; },
    describe: () => 'kneedle on merge heights',
  },
  {
    id: 'D1', label: 'D1. two-stage — TF-IDF coarse bucket, then nomic tight',
    params: cross([0.04, 0.06, 0.08, 0.10, 0.12, 0.14], [0.58, 0.60, 0.62, 0.635, 0.65, 0.67]),
    cluster: (b, items, [tc, tt], tfItems) => {
      const byId = new Map(items.map((it) => [it.id, it]));
      const out = [];
      for (const bucket of cutSubset(tfItems, tc)) {
        const sub = bucket.map((id) => byId.get(id));
        for (const g of cutSubset(sub, tt)) out.push(g);
      }
      return out;
    },
    // Attaching means joining an existing topic: the arriving pin must land in
    // the same coarse bucket as the topic AND clear the tight cut.
    attach: (b, [tc, tt]) => (vN, vT) => vT >= tc && vN >= tt,
    describe: ([tc, tt]) => `tfidf bucket ${tc.toFixed(2)} -> nomic ${tt.toFixed(3)}`,
  },
  {
    id: 'D2', label: 'D2. two-stage — nomic coarse bucket, then bucket-relative percentile',
    params: cross([0.55, 0.58, 0.60, 0.62], [0.75, 0.80, 0.85, 0.90]),
    cluster: (b, items, [tc, p]) => {
      const byId = new Map(items.map((it) => [it.id, it]));
      const out = [];
      for (const bucket of cutSubset(items, tc)) {
        const sub = bucket.map((id) => byId.get(id));
        if (sub.length < 3) { out.push(bucket); continue; }
        const pv = pairwiseValues(simMatrix(sub));
        for (const g of cutSubset(sub, percentile(pv, p))) out.push(g);
      }
      return out;
    },
    attach: (b, [tc, p]) => { const t = percentile(b.pvN, p); return (vN) => vN >= tc && vN >= t; },
    describe: ([tc, p]) => `nomic bucket ${tc.toFixed(2)} -> within-bucket p${(p * 100).toFixed(0)}`,
  },
  {
    id: 'E1', label: 'E1. hybrid — merge only where BOTH spaces agree (intersection)',
    params: cross([0.500, 0.550, 0.575, 0.600, 0.620, 0.635, 0.650, 0.670], [0.04, 0.06, 0.08, 0.10, 0.12, 0.14, 0.16]),
    dual: true,
    cluster: (b, items, [tn, tt]) => agglomerateDual(b, items, (aN, aT) => aN >= tn && aT >= tt, (aN) => aN),
    attach: (b, [tn, tt]) => (vN, vT) => vN >= tn && vT >= tt,
    describe: ([tn, tt]) => `nomic ${tn.toFixed(3)} AND tfidf ${tt.toFixed(2)}`,
  },
  {
    id: 'E2', label: 'E2. hybrid — merge where EITHER space is confident (union)',
    params: cross([0.635, 0.660, 0.680, 0.700, 0.720, 0.740], [0.10, 0.12, 0.15, 0.20, 0.25]),
    dual: true,
    cluster: (b, items, [tn, tt]) => agglomerateDual(b, items, (aN, aT) => aN >= tn || aT >= tt, (aN) => aN),
    attach: (b, [tn, tt]) => (vN, vT) => vN >= tn || vT >= tt,
    describe: ([tn, tt]) => `nomic ${tn.toFixed(3)} OR tfidf ${tt.toFixed(2)}`,
  },
  {
    id: 'E3', label: 'E3. hybrid — z-normalised margin sum across both spaces',
    params: [-0.2, 0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.2],
    dual: true,
    cluster: (b, items, k) => {
      const z = (aN, aT) => ((aN - b.meanN) / b.sdN + (aT - b.meanT) / b.sdT) / 2;
      return agglomerateDual(b, items, (aN, aT) => z(aN, aT) >= k, (aN, aT) => z(aN, aT));
    },
    attach: (b, k) => (vN, vT) => ((vN - b.meanN) / b.sdN + (vT - b.meanT) / b.sdT) / 2 >= k,
    describe: (k) => `z-margin >= ${k.toFixed(1)}`,
  },
];

function range(from, to, step) {
  const out = [];
  for (let x = from; x <= to + 1e-9; x += step) out.push(Math.round(x * 1000) / 1000);
  return out;
}
function cross(a, b) {
  const out = [];
  for (const x of a) for (const y of b) out.push([x, y]);
  return out;
}
const paramKey = (p) => JSON.stringify(p);

// ------------------------------------------------------- the score matrix

/** Every family x every parameter setting x every board, computed once. */
const results = new Map();
for (const f of FAMILIES) {
  const perParam = new Map();
  for (const p of f.params) {
    const cells = boards.map((b) => {
      const groups = f.cluster(b, b.s.nomic, p, b.s.tfidf);
      const s = score(groups, b.s.ids);
      const fail = failureProfile(groups);
      return { board: b.name, groups, ...s, ...fail, repairPerPin: fail.repairCost / b.n };
    });
    perParam.set(paramKey(p), cells);
  }
  results.set(f.id, perParam);
}

/** Pick the best setting over a chosen subset of boards. */
function selectOn(f, boardNames) {
  const idx = boardNames.map((n) => boards.findIndex((b) => b.name === n));
  let best = null;
  for (const p of f.params) {
    const cells = results.get(f.id).get(paramKey(p));
    const mean = idx.reduce((a, i) => a + cells[i].f1, 0) / idx.length;
    const repair = idx.reduce((a, i) => a + cells[i].repairPerPin, 0) / idx.length;
    const objective = f.objective === 'repair' ? -repair : mean;
    if (!best || objective > best.objective + 1e-12) best = { p, objective, mean, repair };
  }
  return best;
}

// -------------------------------------------------- 1. the fitted headline

console.log('\n\n## 1. Fitted — best setting for each family over all seven boards');
console.log('\nThis is the number a sweep reports and the number Run 6 warned about: the');
console.log('parameter has seen every board it is scored on. Read section 2 before believing it.');
console.log(`\n| strategy | setting | ${boards.map((b) => b.name).join(' | ')} | mean | worst |`);
console.log(`| :------- | :------ | ${boards.map(() => '---:').join(' | ')} | ---: | ----: |`);

const fitted = new Map();
for (const f of FAMILIES) {
  const sel = selectOn(f, boards.map((b) => b.name));
  fitted.set(f.id, sel.p);
  const cells = results.get(f.id).get(paramKey(sel.p));
  const f1s = cells.map((c) => c.f1);
  console.log(`| ${f.id} | ${f.describe(sel.p)} | ${f1s.map(pctf).join(' | ')}`
    + ` | **${pctf(f1s.reduce((a, x) => a + x) / f1s.length)}** | ${pctf(Math.min(...f1s))} |`);
}

// ------------------------------------------------ 2. held out, leave-one-out

console.log('\n\n## 2. Held out — leave-one-board-out');
console.log('\nFor each board, the family\'s parameter is chosen on the other six and reported');
console.log('on the seventh. A family with no free parameter (A, A2, C2, C2b) scores the same');
console.log('in both sections by construction — nothing was fitted, so nothing can overfit.');
console.log(`\n| strategy | ${boards.map((b) => b.name).join(' | ')} | mean | worst | fit gap |`);
console.log(`| :------- | ${boards.map(() => '---:').join(' | ')} | ---: | ----: | ------: |`);

const lobo = new Map();
for (const f of FAMILIES) {
  const cells = [];
  const picks = [];
  for (const held of boards) {
    const sel = selectOn(f, boards.filter((b) => b.name !== held.name).map((b) => b.name));
    picks.push(f.describe(sel.p));
    const row = results.get(f.id).get(paramKey(sel.p));
    cells.push(row[boards.indexOf(held)]);
  }
  lobo.set(f.id, cells);
  const f1s = cells.map((c) => c.f1);
  const mean = f1s.reduce((a, x) => a + x) / f1s.length;
  const fittedCells = results.get(f.id).get(paramKey(fitted.get(f.id)));
  const fittedMean = fittedCells.reduce((a, c) => a + c.f1, 0) / fittedCells.length;
  console.log(`| ${f.id} | ${f1s.map(pctf).join(' | ')} | **${pctf(mean)}**`
    + ` | ${pctf(Math.min(...f1s))} | ${(fittedMean * 100 - mean * 100).toFixed(1)} |`);
  const distinct = [...new Set(picks)];
  if (distinct.length > 1) console.log(`|   ↳ settings chosen | ${distinct.join(', ')} |`);
}

// ----------------------------------------- 3. weld and fragmentation profile

console.log('\n\n## 3. Failure profile at the fitted setting — the two modes, separated');
console.log('\n`weld pins` is how many pins sit in a group that is not theirs: repairing them is');
console.log('pin-by-pin split surgery, one action each. `merge taps` is how many merge taps would');
console.log('reunite every torn topic: one tap per extra fragment. `worst weld` is the largest');
console.log('single wrongly-merged group — the one a learner actually meets — as pins/key topics.');
console.log('`repair cost` is the sum in learner actions, and `x-domain` counts groups welding two');
console.log('different subjects together, the failure the design most fears.');

for (const f of FAMILIES) {
  const cells = results.get(f.id).get(paramKey(fitted.get(f.id)));
  console.log(`\n### ${f.id} — ${f.describe(fitted.get(f.id))}`);
  console.log('\n| board | topics | key | weld pins | worst weld | torn topics | merge taps | repair cost | cost/pin | x-domain |');
  console.log('| :---- | -----: | --: | --------: | :--------- | ----------: | ---------: | ----------: | -------: | -------: |');
  for (const [i, c] of cells.entries()) {
    const b = boards[i];
    console.log(`| ${c.board} | ${c.topics} | ${b.keyTopics} | ${c.weldPins}`
      + ` | ${c.weldWorst.pins ? `${c.weldWorst.pins} pins / ${c.weldWorst.keys} topics` : '—'}`
      + ` | ${c.tornTopics} | ${c.mergeTaps} | ${c.repairCost} | ${c.repairPerPin.toFixed(3)} | ${c.crossDomain} |`);
  }
  const tot = cells.reduce((a, c) => a + c.repairCost, 0);
  const pins = boards.reduce((a, b) => a + b.n, 0);
  console.log(`\n  total repair cost over all boards: ${tot} actions over ${pins} pin-slots`
    + ` (${(tot / pins).toFixed(3)}/pin); cross-domain welds: ${cells.reduce((a, c) => a + c.crossDomain, 0)}`);
}

// -------------------------------------------- 3b. topic-count inflation (B)

console.log('\n\n## 3b. Topic-count inflation — the cost strategy B is supposed to pay');
console.log(`\n| strategy | ${boards.map((b) => b.name).join(' | ')} |`);
console.log(`| :------- | ${boards.map(() => '---:').join(' | ')} |`);
console.log(`| key | ${boards.map((b) => b.keyTopics).join(' | ')} |`);
for (const f of FAMILIES) {
  const cells = results.get(f.id).get(paramKey(fitted.get(f.id)));
  console.log(`| ${f.id} | ${cells.map((c, i) => `${c.topics} (${c.topics > boards[i].keyTopics ? '+' : ''}${c.topics - boards[i].keyTopics})`).join(' | ')} |`);
}

// ------------------------------------------- 4. do the two spaces complement

console.log('\n\n## 4. Do the two spaces\' errors overlap or complement?');
console.log('\nEvery pin pair on the 80-pin board, classified by which space would put it');
console.log('together at its own shipped cut, against what the key says.');
{
  const b = board('full-80');
  let both = { right: 0, wrong: 0 }, nomicOnly = { right: 0, wrong: 0 },
    tfidfOnly = { right: 0, wrong: 0 }, neither = { missed: 0, correct: 0 };
  for (let i = 0; i < b.n; i++) for (let j = i + 1; j < b.n; j++) {
    const n = b.simN[i][j] >= 0.635, t = b.simT[i][j] >= 0.12;
    const should = expectOf.get(b.s.ids[i]) === expectOf.get(b.s.ids[j]);
    if (n && t) should ? both.right++ : both.wrong++;
    else if (n) should ? nomicOnly.right++ : nomicOnly.wrong++;
    else if (t) should ? tfidfOnly.right++ : tfidfOnly.wrong++;
    else should ? neither.missed++ : neither.correct++;
  }
  console.log('\n| pair verdict | same key topic | different key topics |');
  console.log('| :----------- | -------------: | -------------------: |');
  console.log(`| both spaces say together | ${both.right} | ${both.wrong} |`);
  console.log(`| nomic only | ${nomicOnly.right} | ${nomicOnly.wrong} |`);
  console.log(`| TF-IDF only | ${tfidfOnly.right} | ${tfidfOnly.wrong} |`);
  console.log(`| neither | ${neither.missed} | ${neither.correct} |`);
  const prec = (r, w) => (r + w === 0 ? 0 : (r / (r + w)) * 100).toFixed(1);
  console.log(`\n  precision of a pair both spaces agree on: ${prec(both.right, both.wrong)}%`);
  console.log(`  precision where only nomic says together: ${prec(nomicOnly.right, nomicOnly.wrong)}%`);
  console.log(`  precision where only TF-IDF says together: ${prec(tfidfOnly.right, tfidfOnly.wrong)}%`);
  console.log(`  true pairs neither space reaches: ${neither.missed} — the ceiling on any intersection rule`);
}

// ------------------------------ 4b. how board-relative is each fixed constant

/**
 * Run 5 rejected TF-IDF as the default because its cut point was "a fit to one
 * board, not a property of a space". The test of that claim is simple and had
 * never been run: express each fixed constant as a percentile of its own space's
 * pairwise distribution on each board. A constant that is a property of a space
 * sits at the same percentile everywhere. One that is a fit to a corpus moves.
 */
console.log('\n\n## 4b. Where each fixed constant sits in its own board\'s distribution');
console.log('\nA cut point that is a property of a space sits at the same percentile on every');
console.log('board. One that is a fit to a corpus moves. Swing is max percentile minus min.');
console.log('\n| board | tfidf 0.08 | tfidf 0.12 | nomic 0.635 |');
console.log('| :---- | ---------: | ---------: | ----------: |');
{
  const rows = { t08: [], t12: [], n635: [] };
  const at = (v, x) => (v.filter((y) => y < x).length / v.length) * 100;
  for (const b of boards) {
    const a = at(b.pvT, 0.08), c = at(b.pvT, 0.12), d = at(b.pvN, 0.635);
    rows.t08.push(a); rows.t12.push(c); rows.n635.push(d);
    console.log(`| ${b.name} | p${a.toFixed(1)} | p${c.toFixed(1)} | p${d.toFixed(1)} |`);
  }
  const swing = (v) => (Math.max(...v) - Math.min(...v)).toFixed(1);
  console.log(`| **swing** | **${swing(rows.t08)}** | **${swing(rows.t12)}** | **${swing(rows.n635)}** |`);
}

// ------------------------------------------------- 5. determinism, asserted

console.log('\n\n## 5. Determinism');
console.log('\nEvery strategy, twice over the 80-pin board, with the embedder called fresh from');
console.log('Ollama on both passes rather than served from the bake-off cache — so the assertion');
console.log('covers the whole chain, not just the clustering arithmetic.');
{
  const b = board('full-80');
  const embedder = new OllamaEmbedder({ model: OLLAMA_MODEL, timeoutMs: 300_000 });
  const texts = b.pins.map(pinClusterText);
  const passes = [];
  for (let run = 0; run < 2; run++) {
    const vectors = await embedder.embed(texts);
    passes.push(b.pins.map((p, i) => ({ id: p.id, vector: vectors[i] })));
  }
  assert.equal(
    JSON.stringify(passes[0]), JSON.stringify(passes[1]),
    'two fresh Ollama embedding passes over the same 80 texts returned different vectors',
  );
  let diverged = 0;
  for (const f of FAMILIES) {
    const shapes = passes.map((items) => {
      const tmp = { ...b, s: { ...b.s, nomic: items }, simN: simMatrix(items) };
      tmp.pvN = pairwiseValues(tmp.simN);
      tmp.meanN = tmp.pvN.reduce((a, x) => a + x, 0) / tmp.pvN.length;
      tmp.sdN = Math.sqrt(tmp.pvN.reduce((a, x) => a + (x - tmp.meanN) ** 2, 0) / tmp.pvN.length) || 1;
      tmp.dN = dendrogram(items);
      return shape(f.cluster(tmp, items, fitted.get(f.id), tmp.s.tfidf));
    });
    const same = shapes[0] === shapes[1];
    if (!same) diverged++;
    console.log(`  ${f.id.padEnd(8)} ${same ? 'IDENTICAL' : 'DIVERGED'} (${shapes[0].split('|').length} topics)`);
    assert.equal(shapes[0], shapes[1], `${f.id} produced different partitions on two runs`);
  }
  console.log(`\n  ${FAMILIES.length} strategies, 2 runs each, ${diverged} divergences`);
}

// ------------------------------------------------- 6. incremental arrival

/**
 * Attach-only arrival, driven by each strategy's own rule.
 *
 * The shape is core's `partition`: pins that already have a topic never move,
 * centroids are frozen before any attachment, arriving pins join the nearest
 * existing centroid when the strategy's rule accepts, and the rest cluster among
 * themselves with the strategy's cold rule. What varies between strategies is
 * only the acceptance test.
 *
 * Both spaces are recomputed over the current board at every arrival, which is
 * what production does — and for TF-IDF it means the space itself shifts as the
 * board grows. Attach-only is what makes that survivable: a shifted space cannot
 * move a pin that already has a topic.
 */
async function incremental(f, p) {
  const seedPins = PINS.filter((x) => Number(x.id.slice(4)) <= 21);
  const seedSpaces = await spacesFor(seedPins);
  const seedBoard = boardLike(seedSpaces, seedPins);
  let established = f.cluster(seedBoard, seedSpaces.nomic, p, seedSpaces.tfidf)
    .map((ids, i) => ({ topicId: `T${String(i + 1).padStart(2, '0')}`, memberIds: ids }));
  let seen = [...seedPins];
  let nextId = established.length + 1;
  let moved = 0;
  const rows = [[`seed (21)`, 21, established.length, '—', established.length]];

  for (const [label, batch] of BATCHES) {
    seen = [...seen, ...batch];
    const spaces = await spacesFor(seen);
    const b = boardLike(spaces, seen);
    const vN = new Map(spaces.nomic.map((it) => [it.id, it.vector]));
    const vT = new Map(spaces.tfidf.map((it) => [it.id, it.vector]));
    const accept = f.attach(b, p);

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
    for (const pin of [...seen].sort((x, y) => (x.id < y.id ? -1 : 1))) {
      if (claimed.has(pin.id)) continue;
      let bestTopic = null, bestSim = -Infinity, bestC = null;
      for (const c of centroids) {
        const s = cosine(vN.get(pin.id), c.cN);
        if (s > bestSim + EPS) { bestSim = s; bestTopic = c.topicId; bestC = c; }
      }
      const ok = bestC !== null
        && accept(cosine(vN.get(pin.id), bestC.cN), cosine(vT.get(pin.id), bestC.cT));
      if (ok) attachedTo.set(bestTopic, [...(attachedTo.get(bestTopic) ?? []), pin.id]);
      else leftover.push(pin.id);
    }

    const groups = centroids.map((c) => ({
      topicId: c.topicId,
      pinIds: [...c.members, ...(attachedTo.get(c.topicId) ?? [])].sort(),
    }));
    const leftN = spaces.nomic.filter((it) => leftover.includes(it.id));
    const leftT = spaces.tfidf.filter((it) => leftover.includes(it.id));
    for (const g of f.cluster(b, leftN, p, leftT)) groups.push({ topicId: null, pinIds: [...g].sort() });

    const before = new Map();
    for (const g of established) for (const id of g.memberIds) before.set(id, g.topicId);
    for (const g of groups) for (const id of g.pinIds) {
      if (before.has(id) && before.get(id) !== g.topicId) moved++;
    }
    const attached = [...attachedTo.values()].reduce((a, l) => a + l.length, 0);
    rows.push([label, seen.length, groups.length, attached, groups.filter((g) => !g.topicId).length]);
    established = groups.map((g) => ({
      topicId: g.topicId ?? `T${String(nextId++).padStart(2, '0')}`,
      memberIds: g.pinIds,
    }));
  }

  const groups = established.map((g) => g.memberIds);
  const ids = PINS.map((x) => x.id);
  return { rows, moved, score: score(groups, ids), fail: failureProfile(groups) };
}

function boardLike(spaces, pins) {
  const simN = simMatrix(spaces.nomic), simT = simMatrix(spaces.tfidf);
  const pvN = pairwiseValues(simN), pvT = pairwiseValues(simT);
  const m = (v) => v.reduce((a, x) => a + x, 0) / (v.length || 1);
  const sd = (v, mu) => Math.sqrt(v.reduce((a, x) => a + (x - mu) ** 2, 0) / (v.length || 1)) || 1;
  const meanN = m(pvN), meanT = m(pvT);
  return {
    pins, s: spaces, n: spaces.ids.length, simN, simT, pvN, pvT,
    meanN, sdN: sd(pvN, meanN), meanT, sdT: sd(pvT, meanT),
    dN: dendrogram(spaces.nomic), dT: dendrogram(spaces.tfidf),
  };
}

if (!QUICK) {
  console.log('\n\n## 6. Incremental arrival — 21 pins, then three batches, attach-only');
  console.log('\nEvery strategy runs its own acceptance rule at every arrival. `moved` must be zero:');
  console.log('a pin that already has a topic never moves, which is the product promise and is');
  console.log('asserted, not merely counted. `delta` is against the SAME strategy clustering the');
  console.log('same 80 pins cold — the price of having arrived one batch at a time.');
  console.log('\n| strategy | topics cold | topics incremental | F1 cold | F1 incremental | delta | weld pins | merge taps | moved |');
  console.log('| :------- | ----------: | -----------------: | ------: | -------------: | ----: | --------: | ---------: | ----: |');
  for (const f of FAMILIES) {
    const p = fitted.get(f.id);
    const cold = results.get(f.id).get(paramKey(p))[boards.indexOf(board('full-80'))];
    const inc = await incremental(f, p);
    assert.equal(inc.moved, 0, `${f.id}: an established pin moved during incremental arrival`);
    console.log(`| ${f.id} | ${cold.topics} | ${inc.score.topics} | ${pctf(cold.f1)} | ${pctf(inc.score.f1)}`
      + ` | ${(inc.score.f1 * 100 - cold.f1 * 100).toFixed(1)} | ${inc.fail.weldPins} (cold ${cold.weldPins})`
      + ` | ${inc.fail.mergeTaps} (cold ${cold.mergeTaps}) | ${inc.moved} |`);
  }
}

// ------------------------------------------- 7. how fragile is each setting

/**
 * A family that only works at one value of its parameter has not solved the
 * problem Run 6 named — it has moved the fit somewhere less visible. So the full
 * grid, not just the winner: if the neighbours of the chosen setting score far
 * worse, the choice is a spike and should be distrusted.
 */
console.log('\n\n## 7. Parameter sensitivity — is the winning setting a plateau or a spike?');
for (const f of FAMILIES.filter((x) => x.params.length > 1)) {
  console.log(`\n### ${f.id} — ${f.label}`);
  console.log('\n| setting | mean F1 | worst board | repair/pin |');
  console.log('| :------ | ------: | ----------: | ---------: |');
  const rows = f.params.map((p) => {
    const cells = results.get(f.id).get(paramKey(p));
    const f1s = cells.map((c) => c.f1);
    return {
      p, mean: f1s.reduce((a, x) => a + x) / f1s.length, worst: Math.min(...f1s),
      repair: cells.reduce((a, c) => a + c.repairPerPin, 0) / cells.length,
    };
  }).sort((a, b) => b.mean - a.mean);
  for (const r of rows.slice(0, 12)) {
    const star = paramKey(r.p) === paramKey(fitted.get(f.id)) ? ' <- chosen' : '';
    console.log(`| ${f.describe(r.p)} | ${pctf(r.mean)} | ${pctf(r.worst)} | ${r.repair.toFixed(3)} |${star}`);
  }
  if (rows.length > 12) console.log(`|   ↳ ${rows.length - 12} weaker settings not shown | | | |`);
}

saveCache();
console.log('\nall assertions passed');
