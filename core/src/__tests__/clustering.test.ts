import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agglomerate, partition, assertPartition, cosine, centroid, thresholdFor,
  DEFAULT_CLUSTER_THRESHOLD, type Embedded,
} from '../domain/clustering.js';

/**
 * DEAD_ENDS.md D15: the same 21 pins, the same prompt, the same model, three
 * runs — 6, 6 and 7 topics. Comfort and signal history attach to topic ids, so
 * that variance detaches a learner's history from the thing it was about.
 *
 * These tests exist to make the fix falsifiable. "It looked the same three
 * times" is not a property; identical output over shuffled input, and a
 * provable no-op over an unchanged board, are.
 */

const v = (id: string, vector: readonly number[]): Embedded => ({ id, vector });

/** Two tight pairs, far apart from each other, plus a lone outlier. */
const CORPUS: readonly Embedded[] = [
  v('p1', [1, 0, 0]),
  v('p2', [0.99, 0.1, 0]),
  v('p3', [0, 1, 0]),
  v('p4', [0.1, 0.99, 0]),
  v('p5', [0, 0, 1]),
];

const shape = (groups: readonly (readonly string[])[]): string =>
  groups.map((g) => g.join(',')).join('|');

test('the same input clusters to the same partition twice', () => {
  const a = agglomerate(CORPUS, 0.8);
  const b = agglomerate(CORPUS, 0.8);
  assert.deepEqual(a, b);
  assert.equal(shape(a), 'p1,p2|p3,p4|p5');
});

test('input order does not change the partition', () => {
  // The real caller reads pins out of a store; nothing guarantees the order is
  // the same tomorrow. If order can move a pin, the partition is not stable.
  const reversed = [...CORPUS].reverse();
  const shuffled = [CORPUS[3]!, CORPUS[0]!, CORPUS[4]!, CORPUS[2]!, CORPUS[1]!];
  const base = agglomerate(CORPUS, 0.8);
  assert.deepEqual(agglomerate(reversed, 0.8), base);
  assert.deepEqual(agglomerate(shuffled, 0.8), base);
});

test('exact ties are broken by pin id, not by position', () => {
  // Four identical vectors: every merge candidate scores exactly 1.0, so the
  // only thing that can decide the order is the tie-break. Ids are deliberately
  // supplied in an order that does not match their sort order.
  const same = [v('zz', [1, 0]), v('aa', [1, 0]), v('mm', [1, 0]), v('bb', [1, 0])];
  const out = agglomerate(same, 0.9);
  assert.equal(shape(out), 'aa,bb,mm,zz');
  assert.deepEqual(agglomerate([...same].reverse(), 0.9), out);
});

test('a group is ordered by id, and groups are ordered by their smallest id', () => {
  const out = agglomerate(CORPUS, 0.8);
  for (const g of out) assert.deepEqual([...g], [...g].sort());
  const firsts = out.map((g) => g[0]!);
  assert.deepEqual(firsts, [...firsts].sort());
});

test('the cut is inclusive: similarity exactly at the threshold merges', () => {
  // cos([1,0],[3,4]) = 3/5, exactly representable either side of the compare.
  const pair = [v('a', [1, 0]), v('b', [3, 4])];
  assert.equal(cosine([1, 0], [3, 4]), 0.6);
  assert.equal(shape(agglomerate(pair, 0.6)), 'a,b', 'at the threshold, merge');
  assert.equal(shape(agglomerate(pair, 0.61)), 'a|b', 'above it, do not');
});

test('a zero vector falls out on its own instead of poisoning the comparison', () => {
  // An empty selection, or a language the tokeniser does not split. Returning
  // NaN here would make every comparison involving it false and the failure
  // would be invisible.
  const out = agglomerate([v('a', [1, 0]), v('b', [1, 0]), v('empty', [0, 0])], 0.5);
  assert.equal(shape(out), 'a,b|empty');
});

test('average linkage does not chain two topics together through one pin', () => {
  // Single linkage would merge all three: each neighbour pair is above 0.8.
  // Average linkage refuses, because the ends are not close to each other.
  const chain = [v('a', [1, 0]), v('b', [0.8, 0.6]), v('c', [0.28, 0.96])];
  const out = agglomerate(chain, 0.8);
  assert.ok(out.length > 1, 'the far ends must not end up in one topic');
});

// ------------------------------------------------------------- attach-only

const topicsOf = (groups: readonly { topicId: string | null; pinIds: readonly string[] }[]) =>
  groups.map((g) => `${g.topicId ?? 'NEW'}:${g.pinIds.join(',')}`).join('|');

test('a re-run over an unchanged board is a no-op', () => {
  // The whole product requirement in one assertion: nothing is decided, so
  // nothing can reshuffle and no signal can be orphaned.
  const existing = [
    { topicId: 'T1', memberIds: ['p1', 'p2'] },
    { topicId: 'T2', memberIds: ['p3', 'p4'] },
    { topicId: 'T3', memberIds: ['p5'] },
  ];
  const out = partition({ items: CORPUS, existing, threshold: 0.8 });
  assert.equal(topicsOf(out), 'T1:p1,p2|T2:p3,p4|T3:p5');
  assert.deepEqual(out.flatMap((g) => g.attached), [], 'nothing attached; nothing moved');
});

test('an assigned pin never moves, even when a different topic now fits better', () => {
  // p2 belongs to T1 by history but sits closer to T2's material. Attach-only
  // means history wins: the learner's comfort ledger for T1 was earned on this
  // pin, and moving it silently invalidates that.
  const items = [v('p1', [1, 0]), v('p2', [0, 1]), v('p3', [0, 1])];
  const out = partition({
    items,
    existing: [{ topicId: 'T1', memberIds: ['p1', 'p2'] }, { topicId: 'T2', memberIds: ['p3'] }],
    threshold: 0.9,
  });
  assert.equal(topicsOf(out), 'T1:p1,p2|T2:p3');
});

test('a new pin joins the nearest existing topic when it is close enough', () => {
  const items = [...CORPUS, v('p6', [0.95, 0.05, 0])];
  const out = partition({
    items,
    existing: [{ topicId: 'T1', memberIds: ['p1', 'p2'] }, { topicId: 'T2', memberIds: ['p3', 'p4'] }],
    threshold: 0.8,
  });
  const t1 = out.find((g) => g.topicId === 'T1');
  assert.deepEqual(t1?.pinIds, ['p1', 'p2', 'p6']);
  assert.deepEqual(t1?.attached, ['p6']);
});

test('a new pin that fits nothing seeds its own topic', () => {
  const out = partition({
    items: [...CORPUS, v('p9', [0, 0.6, 0.8])],
    existing: [{ topicId: 'T1', memberIds: ['p1', 'p2'] }],
    threshold: 0.95,
  });
  const fresh = out.filter((g) => g.topicId === null);
  assert.ok(fresh.some((g) => g.pinIds.includes('p9')));
  assert.ok(fresh.every((g) => g.attached.length === 0));
});

test('new pins that fit nothing existing still cluster among themselves', () => {
  const out = partition({
    items: [v('p1', [1, 0, 0]), v('n1', [0, 1, 0]), v('n2', [0, 0.99, 0.1])],
    existing: [{ topicId: 'T1', memberIds: ['p1'] }],
    threshold: 0.8,
  });
  assert.equal(topicsOf(out), 'T1:p1|NEW:n1,n2');
});

test('centroids are frozen, so the order new pins arrive in cannot change where they land', () => {
  const newcomers = [v('a1', [0.9, 0.44, 0]), v('a2', [0.95, 0.31, 0])];
  const existing = [{ topicId: 'T1', memberIds: ['p1', 'p2'] }];
  const forward = partition({ items: [...CORPUS, ...newcomers], existing, threshold: 0.85 });
  const backward = partition({ items: [...newcomers.reverse(), ...CORPUS], existing, threshold: 0.85 });
  assert.equal(topicsOf(forward), topicsOf(backward));
});

test('a topic whose pins have all been deleted is left alone, not resurrected', () => {
  const out = partition({
    items: [v('p1', [1, 0])],
    existing: [{ topicId: 'T1', memberIds: ['p1'] }, { topicId: 'GONE', memberIds: ['deleted'] }],
    threshold: 0.5,
  });
  assert.equal(topicsOf(out), 'T1:p1');
});

// ------------------------------------------------------------------ D13

test('every pin lands in exactly one topic', () => {
  // The rule now holds by construction. The assertion stays anyway: a partition
  // that is true by construction is one refactor away from being false by
  // construction, silently, and that is exactly how D13 happened.
  for (const threshold of [0.1, 0.5, 0.8, 0.99]) {
    const out = partition({ items: CORPUS, existing: [{ topicId: 'T1', memberIds: ['p1'] }], threshold });
    const all = out.flatMap((g) => g.pinIds).sort();
    assert.deepEqual(all, ['p1', 'p2', 'p3', 'p4', 'p5']);
  }
});

test('the partition assertion catches a dropped pin', () => {
  assert.throws(
    () => assertPartition(['a', 'b'], [{ pinIds: ['a'] }]),
    /1 missing/,
  );
});

test('the partition assertion catches a pin in two topics', () => {
  assert.throws(
    () => assertPartition(['a', 'b'], [{ pinIds: ['a', 'b'] }, { pinIds: ['b'] }]),
    /1 in two groups/,
  );
});

test('a pin claimed by two existing topics resolves to one, deterministically', () => {
  // Should be impossible. Worth surviving anyway: the alternative is throwing
  // on a board the learner can neither see nor repair.
  const out = partition({
    items: [v('p1', [1, 0]), v('p2', [0, 1])],
    existing: [{ topicId: 'T2', memberIds: ['p1'] }, { topicId: 'T1', memberIds: ['p1', 'p2'] }],
    threshold: 0.9,
  });
  // T1 sorts first and so claims p1; T2 is then left with no present members
  // at all and drops out of the run untouched rather than being rebuilt.
  assert.equal(topicsOf(out), 'T1:p1,p2', 'lowest topic id keeps the pin');
});

// -------------------------------------------------------------- thresholds

test('the cut point follows the embedding space, including a tagged model name', () => {
  assert.equal(thresholdFor('nomic-embed-text'), 0.635);
  assert.equal(thresholdFor('nomic-embed-text:latest'), 0.635);
  assert.equal(thresholdFor('tfidf-v1'), 0.12);
  assert.equal(thresholdFor('some-unswept-model'), DEFAULT_CLUSTER_THRESHOLD);
});

test('centroid is the mean, and an empty set has no centroid to speak of', () => {
  assert.deepEqual(centroid([[1, 0], [0, 1]]), [0.5, 0.5]);
  assert.deepEqual(centroid([]), []);
});
