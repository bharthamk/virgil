import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agglomerate, partition, assertPartition, type Embedded } from '../domain/clustering.js';
import { planMerge, planSplit, TopicOpError } from '../domain/topic-ops.js';
import { resolveTopicId, withAlias, type AliasMap } from '../domain/aliases.js';
import { verify, dispositionFor, type Defect } from '../agents/verifier.js';
import type { Llm, LlmRequest, LlmResult } from '../ports/llm.js';
import { fixedClock } from '../ports/clock.js';
import type { Pin, Topic } from '../domain/types.js';

/**
 * Properties rather than examples.
 *
 * `clustering.test.ts` and `aliases.test.ts` are example-based and thorough,
 * and none of this repeats them. What they cannot do is run the invariant over
 * inputs nobody chose: "input order does not change the partition" is asserted
 * there on one handmade board of four pins, and the interesting version of that
 * claim is thirty pins in a real-looking space, permuted two hundred ways.
 *
 * Everything here is seeded and deterministic. A property test that fails only
 * on Tuesdays is worse than no property test, because the next person deletes it.
 */

// ------------------------------------------------------------------ a corpus

/** mulberry32. Small, seeded, and the same sequence on every machine. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A board shaped like a real one: a few dense clusters, some drift inside each,
 * and a couple of pins that belong to nothing. Uniform noise would cluster to
 * one blob or to n singletons and would assert nothing about tie-breaking.
 */
function board(seed: number, clusters: number, perCluster: number, dims = 8): Embedded[] {
  const r = rng(seed);
  const items: Embedded[] = [];
  for (let c = 0; c < clusters; c++) {
    const centre = Array.from({ length: dims }, () => r() * 2 - 1);
    for (let i = 0; i < perCluster; i++) {
      items.push({
        // Ids deliberately not in cluster order, so id order and true grouping
        // disagree and tie-breaking by id is actually exercised.
        id: `p-${((c * perCluster + i) * 7919) % 997}`,
        vector: centre.map((x) => x + (r() - 0.5) * 0.35),
      });
    }
  }
  for (let i = 0; i < 3; i++) {
    items.push({ id: `lone-${i}`, vector: Array.from({ length: dims }, () => r() * 2 - 1) });
  }
  return items;
}

const shuffled = <T>(items: readonly T[], r: () => number): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
};

const canonical = (groups: readonly (readonly string[])[]): string =>
  JSON.stringify(groups.map((g) => [...g].sort()).sort((a, b) => (a[0]! < b[0]! ? -1 : 1)));

// --------------------------------------------- clustering, under permutation

test('the partition is the same under two hundred permutations of the same board', () => {
  const items = board(1, 4, 7);
  const expected = canonical(agglomerate(items, 0.635));
  const r = rng(99);
  for (let i = 0; i < 200; i++) {
    assert.equal(canonical(agglomerate(shuffled(items, r), 0.635)), expected,
      `permutation ${i} produced a different partition`);
  }
});

test('the output order is the same too, not merely the same grouping', () => {
  // The stronger claim, and the one the clusterer's naming depends on: the
  // groups come back in the same order, so a caller naming them from position
  // does not see the names shuffle when the partition did not.
  const items = board(2, 3, 6);
  const expected = JSON.stringify(agglomerate(items, 0.635));
  const r = rng(7);
  for (let i = 0; i < 50; i++) {
    assert.equal(JSON.stringify(agglomerate(shuffled(items, r), 0.635)), expected,
      `permutation ${i} reordered the output`);
  }
});

test('every pin lands in exactly one group, at every threshold and every seed', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const items = board(seed, 3, 6);
    for (const threshold of [0, 0.2, 0.5, 0.635, 0.8, 0.95, 1]) {
      const groups = agglomerate(items, threshold);
      const flat = groups.flat();
      assert.equal(flat.length, items.length, `seed ${seed} threshold ${threshold}: pins lost or duplicated`);
      assert.equal(new Set(flat).size, items.length, `seed ${seed} threshold ${threshold}: a pin is in two groups`);
    }
  }
});

test('attaching to existing topics is permutation-stable as well', () => {
  // The half that actually runs every night: some pins are already in topics,
  // and the order this run's new pins are considered in must not decide where
  // any of them land.
  const items = board(3, 3, 6);
  const existing = [
    { topicId: 'T1', memberIds: items.slice(0, 4).map((i) => i.id) },
    { topicId: 'T2', memberIds: items.slice(6, 9).map((i) => i.id) },
  ];
  const key = (gs: readonly { topicId: string | null; pinIds: readonly string[] }[]): string =>
    JSON.stringify(gs.map((g) => [g.topicId, [...g.pinIds].sort()])
      .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)));

  const expected = key(partition({ items, existing, threshold: 0.635 }));
  const r = rng(11);
  for (let i = 0; i < 100; i++) {
    const out = partition({
      items: shuffled(items, r),
      existing: shuffled(existing, r),
      threshold: 0.635,
    });
    assertPartition(items.map((x) => x.id), out);
    assert.equal(key(out), expected, `permutation ${i} moved a pin`);
  }
});

test('a board of identical vectors is still a partition, not a crash', () => {
  const items: Embedded[] = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, vector: [1, 1, 1] }));
  const groups = agglomerate(items, 0.635);
  assert.equal(groups.flat().length, 12);
  assert.equal(JSON.stringify(agglomerate(shuffled(items, rng(4)), 0.635)), JSON.stringify(groups));
});

test('vectors full of things that are not numbers do not produce a NaN partition', () => {
  const items: Embedded[] = [
    { id: 'a', vector: [1, 0, 0] },
    { id: 'b', vector: [NaN, NaN, NaN] },
    { id: 'c', vector: [Infinity, 0, 0] },
    { id: 'd', vector: [] },
    { id: 'e', vector: [0, 0, 0] },
    { id: 'f', vector: [1, 0, 0] },
  ];
  const groups = agglomerate(items, 0.635);
  assert.equal(groups.flat().length, 6, 'a bad vector took a pin off the board');
  assert.equal(new Set(groups.flat()).size, 6);
  // Determinism is the thing that must survive: the same rubbish, twice.
  assert.equal(JSON.stringify(agglomerate(items, 0.635)), JSON.stringify(groups));
});

// -------------------------------------------------- merge, then split it back

const topic = (id: string, pinIds: readonly string[], over: Partial<Topic> = {}): Topic => ({
  id, label: `label of ${id}`, summary: `summary of ${id}`, pinIds,
  state: 'working', comfort: 0.5, lastExposedAt: null, retiredByUser: false,
  createdAt: '2026-07-01T00:00:00Z', ...over,
});

const asPin = (id: string): Pin => ({
  id, type: 'interest', note: null, capturedAt: '2026-07-01T00:00:00Z',
  fromSuggestion: false, enrichment: null, topicId: null,
  envelope: {
    selection: id, parts: [], surroundingText: id, headingPath: [], pageTitle: id,
    url: 'https://e.com', canonicalUrl: null, siteName: null, contentLanguage: 'en', media: null,
  },
});

test('a merge followed by a split of the same pins is a partition of the same pins', () => {
  const t1 = topic('T1', ['a', 'b'], { lastExposedAt: '2026-08-01T00:00:00Z' });
  const t2 = topic('T2', ['c', 'd'], { lastExposedAt: '2026-08-10T00:00:00Z' });
  const pins = ['a', 'b', 'c', 'd'].map(asPin);

  const merged = planMerge([t1, t2], {}, 'T1', 'T2');
  assert.deepEqual([...merged.keep.pinIds].sort(), ['a', 'b', 'c', 'd']);
  assert.equal(merged.retiredTopicId, 'T2');
  assert.equal(merged.keep.lastExposedAt, '2026-08-10T00:00:00Z', 'the later exposure did not survive');

  const aliases = withAlias({}, 'T2', 'T1');
  const split = planSplit([merged.keep], pins, aliases, 'T1', ['c', 'd'], 'back out again', 'T3',
    '2026-08-20T00:00:00Z');

  // The pins are conserved and never shared.
  const back = [...split.original.pinIds, ...split.created.pinIds].sort();
  assert.deepEqual(back, ['a', 'b', 'c', 'd'], 'the round trip lost or duplicated a pin');
  assert.equal(new Set(back).size, 4);
  assert.deepEqual([...split.original.pinIds], ['a', 'b']);
  assert.deepEqual([...split.created.pinIds], ['c', 'd']);
});

test('a split does not undo the merge, and the history stays where the merge put it', () => {
  // The invariant the design states in as many words: a merge unions two
  // histories because that is arithmetic the evidence supports, and a split
  // cannot divide one because no signal says which half it was about. So a
  // round trip is NOT an undo, and it must not pretend to be one.
  const merged = planMerge([topic('T1', ['a', 'b']), topic('T2', ['c', 'd'])], {}, 'T1', 'T2');
  const aliases = withAlias({}, 'T2', 'T1');
  const split = planSplit([merged.keep], ['a', 'b', 'c', 'd'].map(asPin), aliases, 'T1',
    ['c', 'd'], 'back out again', 'T3', '2026-08-20T00:00:00Z');

  assert.equal(split.created.id, 'T3', 'the split resurrected the absorbed id');
  assert.notEqual(split.created.id, 'T2');
  assert.equal(resolveTopicId('T2', aliases), 'T1',
    'the split silently un-merged the ledger the merge had unioned');
  assert.equal(split.created.lastExposedAt, null, 'the new topic claimed exposure it never had');
  assert.equal(split.original.id, 'T1', 'the original stopped being the topic holding the history');
});

test('a merge chain of thirty resolves to one topic from every entry point', () => {
  let aliases: AliasMap = {};
  const ids = Array.from({ length: 30 }, (_, i) => `T${i}`);
  // Merge each into the next: T0 -> T1 -> ... -> T29.
  for (let i = 0; i < ids.length - 1; i++) {
    aliases = withAlias(aliases, ids[i] as string, ids[i + 1] as string);
  }
  const answers = new Set(ids.map((id) => resolveTopicId(id, aliases)));
  assert.deepEqual([...answers], ['T29'], 'a chain resolved to more than one live topic');
});

test('a split that would empty the original is refused however it is spelled', () => {
  const t = topic('T1', ['a', 'b']);
  const pins = ['a', 'b'].map(asPin);
  for (const selection of [['a', 'b'], ['b', 'a'], ['a', 'a', 'b'], ['a', 'b', 'a', 'b']]) {
    assert.throws(() => planSplit([t], pins, {}, 'T1', selection, 'x', 'T9', '2026-08-20T00:00:00Z'),
      (e: unknown) => e instanceof TopicOpError && e.code === 'empty-split',
      `${JSON.stringify(selection)} emptied the original`);
  }
});

// ---------------------------------------- what the model gives back, mangled

const clock = fixedClock('2026-08-19T00:00:00Z');

const answering = (payload: unknown): Llm => ({
  complete: async () => { throw new Error('not used'); },
  structured: async <T>(_req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> =>
    ({ value: payload as T, modelId: 'stub', inputTokens: 0, outputTokens: 0 }),
});

const section = {
  topicId: 't1', heading: 'h', body: 'b', depth: 'building' as const,
  estimatedMinutes: 3, question: null, sourceIds: [], mediumWarning: null,
};

const verified = (payload: unknown): Promise<readonly Defect[]> =>
  verify({ llm: answering(payload), clock },
    { section, sourceMaterial: 'material', knownAboutLearner: [] });

test('only an actually empty finding list is a clean verdict', async () => {
  assert.deepEqual([...await verified({ defects: [] })], []);
  // A list containing malformed rows is not the same claim as an empty list.
  // The provider adapter should reject these against the schema; this runtime
  // boundary independently fails closed if an implementation does not.
  for (const payload of [
    { defects: [null, undefined, 0, '', []] },
    { defects: [{}] },
    { defects: [{ kind: 'unsupported' }] },
    { defects: [{ quote: 'q' }] },
    { defects: [{ problem: 'p' }] },
  ]) {
    await assert.rejects(() => verified(payload),
      `${JSON.stringify(payload)} was read as a clean bill of health`);
  }
});

test('an answer whose defect list is not a list throws, and throwing is the safe direction', async () => {
  // These read like missing optional chains and are not. The pipeline treats a
  // Verifier that threw as `unverified` and does NOT ship the section
  // (`verify-stage.test.ts`: "a section whose verifier call failed is not
  // shipped"). Softening either of these would turn "the model returned
  // something we cannot read" into "the model found zero defects", which ships
  // the section — the exact fail-open the normalising filter exists to avoid.
  for (const payload of [null, undefined, {}, [], { defects: null },
    { defects: 'not a list' }, { defects: {} }, { defects: 42 }]) {
    await assert.rejects(() => verified(payload),
      `${JSON.stringify(payload) ?? 'undefined'} was read as a clean bill of health`);
  }
});

test('an answer that is a bare scalar is unchecked, not a clean bill of health', async () => {
  // This was a recorded KNOWN GAP: `res.value.defects` on a string is
  // `undefined`, and the old `?? []` made it an empty finding list, shipping
  // the section verified — the one fail-OPEN path in the filter. The Verifier
  // now refuses any reply that carries no defects list, so a bare scalar is
  // handed back to `verifySections` and withheld as `unverified`. The adapter
  // contract also guards this at the parse; the Verifier no longer has to
  // trust that promise to be kept.
  for (const payload of ['a string', 42, true]) {
    await assert.rejects(() => verified(payload),
      `${JSON.stringify(payload)} was read as a clean bill of health`);
  }
});

test('a hallucinated defect kind makes the whole verdict unchecked', async () => {
  await assert.rejects(() => verified({
    defects: [
      { kind: 'made-up-kind', quote: 'q1', problem: 'p1', severity: 'fatal' },
      { kind: 'inconsistent', quote: 'q3', problem: 'p3', severity: 'fatal' },
    ],
  }), /unknown defect kind/i);
});

test('a severity the model wrote in its own casing still withholds the section', async () => {
  // The measured failure this guards: an exact-match filter on model output
  // discarded every defect and failed OPEN, which is the one direction a safety
  // check must never fail in.
  for (const severity of ['fatal', 'FATAL', 'Fatal', '  fatal  ', '\nFATAL\t']) {
    const out = await verified({ defects: [{ kind: 'INCONSISTENT', quote: 'q', problem: 'p', severity }] });
    assert.equal(out.length, 1, `severity ${JSON.stringify(severity)} lost the defect`);
    assert.equal(dispositionFor(out), 'withhold', `severity ${JSON.stringify(severity)} failed open`);
  }
});

test('weak remains weak, while every unknown severity makes the verdict unchecked', async () => {
  const weak = await verified({
    defects: [{ kind: 'unsupported', quote: 'q', problem: 'p', severity: 'weak' }],
  });
  assert.equal(weak[0]?.severity, 'weak');
  assert.equal(dispositionFor(weak), 'keep');
  for (const severity of ['moderate', 'severe', 'critical', '', null, 42, 'fatality']) {
    await assert.rejects(
      () => verified({ defects: [{ kind: 'unsupported', quote: 'q', problem: 'p', severity }] }),
      /(?:unknown defect severity|malformed defect)/i,
      `${JSON.stringify(severity)} was downgraded to weak`,
    );
  }
});

test('a fatal defect with no usable evidence is unchecked rather than silently clean', async () => {
  // A fatal finding without the quote or explanation cannot be shown as a
  // defect. Silently dropping it is still the fail-open direction: the section
  // ships even though the verifier explicitly tried to stop it. Throwing hands
  // the section to verifySections as `unverified`, which withholds without
  // pretending an unreadable finding was evidence.
  for (const defect of [
    { kind: 'inconsistent', quote: '', problem: 'the arithmetic does not work', severity: 'fatal' },
    { kind: 'inconsistent', quote: 'four semitones', problem: '', severity: 'FATAL' },
  ]) {
    await assert.rejects(
      () => verified({ defects: [defect] }),
      /fatal defect.*usable (quote|explanation)/i,
      `${JSON.stringify(defect)} was discarded and the section read as clean`,
    );
  }
});

test('the verifier never invents a defect out of a well-formed clean answer', async () => {
  assert.deepEqual([...await verified({ defects: [] })], []);
  assert.equal(dispositionFor(await verified({ defects: [] })), 'keep');
});
