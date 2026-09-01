import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agglomerate, partition, type Embedded } from '../domain/clustering.js';
import {
  agglomerateD1, bucketise, partitionD1, bucketThresholdFor, partitionStrategyFrom,
  D1_DEFAULT_BUCKET_THRESHOLD, DEFAULT_PARTITION_STRATEGY, type TwoSpaceEmbedded,
} from '../domain/partition-d1.js';

/**
 * D1 — the two-space partition, tested against the properties it has to keep.
 *
 * Two of those properties are inherited and non-negotiable: determinism
 * (DEAD_ENDS.md D15) and the partition assertion (D13). The rest are D1's own,
 * and the sharpest is the attach/bucket interaction rule — the coarse space is
 * a veto on the one topic the fine space chose, never a search over the others.
 * That rule is the harness's shape (`scripts/bakeoff-partition.mjs`, the D1
 * family's `attach` and the `incremental` driver), and it is the behaviour the
 * measured incremental numbers were produced by, so it is asserted here rather
 * than left to be inferred from the code.
 *
 * `SB_PARTITION=single` staying byte-identical to what shipped before this
 * module existed is also a test, not a claim: see the last section.
 */

const two = (id: string, coarse: readonly number[], fine: readonly number[]): TwoSpaceEmbedded =>
  ({ id, coarse, fine });

const shape = (groups: readonly (readonly string[])[]): string =>
  groups.map((g) => g.join(',')).join('|');

const topicsOf = (groups: readonly { topicId: string | null; pinIds: readonly string[] }[]) =>
  groups.map((g) => `${g.topicId ?? 'NEW'}:${g.pinIds.join(',')}`).join('|');

/**
 * Four pins the FINE space alone would weld into one topic — every pair sits
 * above 0.9 — split by the coarse space into two lexically unrelated halves.
 * This is the whole of D1 in one corpus.
 */
const WELDABLE: readonly TwoSpaceEmbedded[] = [
  two('a1', [1, 0, 0], [1, 0, 0]),
  two('a2', [1, 0, 0], [0.999, 0.045, 0]),
  two('b1', [0, 1, 0], [0.99, 0.14, 0]),
  two('b2', [0, 1, 0], [0.98, 0.199, 0]),
];

const FINE = 0.9;
const BUCKET = 0.08;

// ------------------------------------------------------------------- cold

test('the fine space alone welds these four pins into one topic', () => {
  // The control. Without this the next test proves nothing.
  const fine: Embedded[] = WELDABLE.map((it) => ({ id: it.id, vector: it.fine }));
  assert.equal(shape(agglomerate(fine, FINE)), 'a1,a2,b1,b2');
});

test('the coarse bucket splits a weld the fine space would have made', () => {
  assert.equal(shape(agglomerateD1(WELDABLE, BUCKET, FINE)), 'a1,a2|b1,b2');
});

test('the buckets themselves are the coarse space, cut and nothing else', () => {
  assert.equal(shape(bucketise(WELDABLE, BUCKET)), 'a1,a2|b1,b2');
});

test('a pin alone in its bucket is alone in its topic, however close the fine space thinks it is', () => {
  // The single-pin bucket. `c1` is a verbatim fine-space copy of `a1`, so the
  // fine cut would put them together at any threshold at all; the coarse space
  // has never seen its vocabulary anywhere else on the board.
  const items = [...WELDABLE, two('c1', [0, 0, 1], [1, 0, 0])];
  const out = agglomerateD1(items, BUCKET, FINE);
  assert.equal(shape(out), 'a1,a2|b1,b2|c1');
});

test('the bucket cut is inclusive at the threshold, exactly as the fine cut is', () => {
  // cos([1,0],[3,4]) = 3/5, representable either side of the compare.
  const pair = [two('a', [1, 0], [1, 0]), two('b', [3, 4], [1, 0])];
  assert.equal(shape(agglomerateD1(pair, 0.6, 0.5)), 'a,b', 'at the bucket cut, one bucket');
  assert.equal(shape(agglomerateD1(pair, 0.61, 0.5)), 'a|b', 'above it, two');
});

test('an empty board has no buckets, no groups and no error', () => {
  assert.deepEqual(agglomerateD1([], BUCKET, FINE), []);
  assert.deepEqual(bucketise([], BUCKET), []);
  assert.deepEqual(partitionD1({ items: [], existing: [], bucketThreshold: BUCKET, threshold: FINE }), []);
});

test('an existing topic with an empty board does not resurrect itself', () => {
  const out = partitionD1({
    items: [], existing: [{ topicId: 'T1', memberIds: ['gone'] }],
    bucketThreshold: BUCKET, threshold: FINE,
  });
  assert.deepEqual(out, []);
});

// ----------------------------------------------------------- determinism

test('the same input clusters to the same partition twice', () => {
  const a = agglomerateD1(WELDABLE, BUCKET, FINE);
  const b = agglomerateD1(WELDABLE, BUCKET, FINE);
  assert.deepEqual(a, b);
});

test('input order does not change the partition, in either space', () => {
  const base = agglomerateD1(WELDABLE, BUCKET, FINE);
  const reversed = [...WELDABLE].reverse();
  const shuffled = [WELDABLE[2]!, WELDABLE[0]!, WELDABLE[3]!, WELDABLE[1]!];
  assert.deepEqual(agglomerateD1(reversed, BUCKET, FINE), base);
  assert.deepEqual(agglomerateD1(shuffled, BUCKET, FINE), base);
});

test('exact ties are broken by pin id in both stages, not by position', () => {
  // Every pair scores exactly 1.0 in both spaces, so nothing but the tie-break
  // can decide anything. Ids are supplied out of sort order deliberately.
  const same = ['zz', 'aa', 'mm', 'bb'].map((id) => two(id, [1, 0], [1, 0]));
  const out = agglomerateD1(same, 0.9, 0.9);
  assert.equal(shape(out), 'aa,bb,mm,zz');
  assert.deepEqual(agglomerateD1([...same].reverse(), 0.9, 0.9), out);
});

test('groups come back id-sorted, ordered by their smallest member, across bucket boundaries', () => {
  // The harness emits bucket by bucket, which interleaves; the product restores
  // the order `agglomerate` documents, because callers name topics off it.
  const items = [
    two('m1', [0, 1, 0], [1, 0, 0]),
    two('a1', [1, 0, 0], [0, 1, 0]),
    two('z1', [1, 0, 0], [0, 1, 0]),
    two('b1', [0, 1, 0], [1, 0, 0]),
  ];
  const out = agglomerateD1(items, BUCKET, FINE);
  assert.equal(shape(out), 'a1,z1|b1,m1');
  for (const g of out) assert.deepEqual([...g], [...g].sort());
  const firsts = out.map((g) => g[0]!);
  assert.deepEqual(firsts, [...firsts].sort());
});

test('two runs of the incremental rule over the same board agree exactly', () => {
  const input = {
    items: WELDABLE,
    existing: [{ topicId: 'T1', memberIds: ['a1'] }],
    bucketThreshold: BUCKET, threshold: FINE,
  };
  assert.deepEqual(partitionD1(input), partitionD1(input));
  assert.deepEqual(
    partitionD1({ ...input, items: [...WELDABLE].reverse() }),
    partitionD1(input),
    'and the order the store happened to return pins in cannot move one',
  );
});

// ---------------------------------------------------------- attach-only

test('a re-run over an unchanged board is a no-op under D1 as well', () => {
  const out = partitionD1({
    items: WELDABLE,
    existing: [
      { topicId: 'T1', memberIds: ['a1', 'a2'] },
      { topicId: 'T2', memberIds: ['b1', 'b2'] },
    ],
    bucketThreshold: BUCKET, threshold: FINE,
  });
  assert.equal(topicsOf(out), 'T1:a1,a2|T2:b1,b2');
  assert.deepEqual(out.flatMap((g) => g.attached), [], 'nothing attached; nothing moved');
});

test('an established pin never moves, even when the coarse space now disagrees with its topic', () => {
  // `b1` is welded into T1 by history and belongs to the other bucket entirely.
  // Attach-only means history wins: the comfort ledger for T1 was earned with
  // this pin in it, and D1 does not get to re-partition an existing topic to
  // tidy up.
  //
  // The second assertion is the cost of the first, and it is the compounding
  // the real-corpus bake-off names: a topic that already straddles two buckets
  // has a coarse centroid between them, so it recruits from both. `b2` arrives
  // and is accepted by a gate that would have refused it against a clean T1.
  // That is the measured behaviour, not a defect to be patched here — nothing
  // but split/merge repairs an early weld.
  const out = partitionD1({
    items: WELDABLE,
    existing: [{ topicId: 'T1', memberIds: ['a1', 'a2', 'b1'] }],
    bucketThreshold: BUCKET, threshold: FINE,
  });
  const t1 = out.find((g) => g.topicId === 'T1');
  assert.deepEqual(t1?.pinIds, ['a1', 'a2', 'b1', 'b2']);
  assert.deepEqual(t1?.attached, ['b2'], 'only the arriving pin is reported as having joined');
});

test('a new pin joins an existing topic only when BOTH gates pass', () => {
  const items = [...WELDABLE, two('a3', [1, 0, 0], [0.999, 0.045, 0])];
  const out = partitionD1({
    items,
    existing: [{ topicId: 'T1', memberIds: ['a1', 'a2'] }, { topicId: 'T2', memberIds: ['b1', 'b2'] }],
    bucketThreshold: BUCKET, threshold: FINE,
  });
  const t1 = out.find((g) => g.topicId === 'T1');
  assert.deepEqual(t1?.pinIds, ['a1', 'a2', 'a3']);
  assert.deepEqual(t1?.attached, ['a3']);
});

test('the coarse space vetoes an attachment the fine space would have made', () => {
  // Same geometry as the shipped rule would see, plus one lexical fact: the
  // arriving pin shares no vocabulary with the topic it is semantically nearest
  // to. Under `single` it attaches; under D1 it does not.
  const items: TwoSpaceEmbedded[] = [
    two('m1', [1, 0, 0], [1, 0, 0]),
    two('m2', [1, 0, 0], [1, 0, 0]),
    two('x1', [0, 1, 0], [1, 0, 0]),
  ];
  const existing = [{ topicId: 'T1', memberIds: ['m1', 'm2'] }];

  const single = partition({
    items: items.map((it) => ({ id: it.id, vector: it.fine })), existing, threshold: FINE,
  });
  assert.equal(topicsOf(single), 'T1:m1,m2,x1', 'the shipped rule takes it');

  const d1 = partitionD1({ items, existing, bucketThreshold: BUCKET, threshold: FINE });
  assert.equal(topicsOf(d1), 'T1:m1,m2|NEW:x1', 'D1 refuses it and seeds a topic instead');
});

test('a vetoed pin does not fall through to the next-best topic', () => {
  // THE attach/bucket rule, and the one a reader is most likely to assume
  // wrongly. The fine space picks exactly one candidate — T1, at similarity
  // 1.0 against T2's 0.98 — and the coarse space either accepts that candidate
  // or the pin goes to the leftovers. T2 would satisfy both gates, and is never
  // considered, because it was not the fine space's choice.
  const items: TwoSpaceEmbedded[] = [
    two('m1', [1, 0, 0], [1, 0, 0]),
    two('m2', [1, 0, 0], [1, 0, 0]),
    two('n1', [0, 1, 0], [0.98, 0.199, 0]),
    two('x1', [0, 1, 0], [1, 0, 0]),
  ];
  const existing = [{ topicId: 'T1', memberIds: ['m1', 'm2'] }, { topicId: 'T2', memberIds: ['n1'] }];
  const out = partitionD1({ items, existing, bucketThreshold: BUCKET, threshold: FINE });
  assert.equal(topicsOf(out), 'T1:m1,m2|T2:n1|NEW:x1');
});

test('a topic whose pins were all absorbed by a merge is left alone and attracts nothing', () => {
  // How a retired alias id reaches this code: the merge moved its pins to the
  // survivor and recorded `absorbed -> kept`, so the retired topic has no
  // present members. It has no centroid, so it cannot be anybody's nearest, and
  // it is not rebuilt out of arriving pins either.
  const items = [...WELDABLE, two('a3', [1, 0, 0], [0.999, 0.045, 0])];
  const out = partitionD1({
    items,
    existing: [
      { topicId: 'A-RETIRED', memberIds: [] },
      { topicId: 'B-RETIRED', memberIds: ['deleted-pin'] },
      { topicId: 'T-LIVE', memberIds: ['a1', 'a2'] },
    ],
    bucketThreshold: BUCKET, threshold: FINE,
  });
  assert.deepEqual(out.map((g) => g.topicId).filter(Boolean), ['T-LIVE'],
    'neither retired id comes back, with or without members');
  assert.deepEqual(out.find((g) => g.topicId === 'T-LIVE')?.attached, ['a3']);
});

test('centroids are frozen, so the order new pins arrive in cannot change where they land', () => {
  const newcomers = [
    two('a3', [1, 0, 0], [0.999, 0.045, 0]),
    two('a4', [1, 0, 0], [0.998, 0.06, 0]),
  ];
  const existing = [{ topicId: 'T1', memberIds: ['a1', 'a2'] }];
  const forward = partitionD1({
    items: [...WELDABLE, ...newcomers], existing, bucketThreshold: BUCKET, threshold: FINE,
  });
  const backward = partitionD1({
    items: [...[...newcomers].reverse(), ...WELDABLE], existing, bucketThreshold: BUCKET, threshold: FINE,
  });
  assert.equal(topicsOf(forward), topicsOf(backward));
});

test('leftovers cluster among themselves under the full two-stage rule', () => {
  // Not under the fine cut alone: `b1`/`b2` are fine-similar to `a1`/`a2` and
  // would join them if the leftovers were clustered in one space.
  const out = partitionD1({
    items: WELDABLE,
    existing: [{ topicId: 'T1', memberIds: ['a1'] }],
    bucketThreshold: BUCKET, threshold: FINE,
  });
  assert.equal(topicsOf(out), 'T1:a1,a2|NEW:b1,b2');
});

// -------------------------------------------------------------------- D13

test('every pin lands in exactly one topic, at every cut of either space', () => {
  const ids = ['a1', 'a2', 'b1', 'b2'];
  for (const bucket of [0, 0.08, 0.5, 0.99]) {
    for (const fine of [0.1, 0.5, 0.9, 0.99]) {
      const out = partitionD1({
        items: WELDABLE,
        existing: [{ topicId: 'T1', memberIds: ['a1'] }],
        bucketThreshold: bucket, threshold: fine,
      });
      assert.deepEqual(out.flatMap((g) => g.pinIds).sort(), ids,
        `bucket ${bucket} / fine ${fine} did not partition its input`);
    }
  }
});

test('a zero vector in either space falls out on its own rather than poisoning the run', () => {
  const items = [
    two('a', [1, 0], [1, 0]),
    two('b', [1, 0], [1, 0]),
    two('empty-coarse', [0, 0], [1, 0]),
    two('empty-fine', [1, 0], [0, 0]),
  ];
  const out = agglomerateD1(items, 0.5, 0.5);
  assert.equal(shape(out), 'a,b|empty-coarse|empty-fine');
});

// ------------------------------------------------ the single-strategy guard

test('when every pin shares one bucket, D1 is the shipped partition, group for group', () => {
  // The regression guard, from the other direction: with the coarse stage
  // inert, D1 must reduce EXACTLY to `agglomerate`/`partition`. Any drift in
  // the second stage shows up here rather than as a quiet difference in a
  // board nobody diffed.
  const fine: readonly Embedded[] = [
    { id: 'p1', vector: [1, 0, 0] },
    { id: 'p2', vector: [0.99, 0.1, 0] },
    { id: 'p3', vector: [0, 1, 0] },
    { id: 'p4', vector: [0.1, 0.99, 0] },
    { id: 'p5', vector: [0, 0, 1] },
  ];
  const items = fine.map((it) => two(it.id, [1, 0, 0], it.vector));

  for (const t of [0.1, 0.5, 0.8, 0.95]) {
    assert.deepEqual(
      agglomerateD1(items, BUCKET, t).map((g) => [...g]),
      agglomerate(fine, t).map((g) => [...g]),
      `cold D1 drifted from the shipped rule at ${t}`,
    );
    const existing = [{ topicId: 'T1', memberIds: ['p1', 'p2'] }];
    assert.deepEqual(
      partitionD1({ items, existing, bucketThreshold: BUCKET, threshold: t }),
      partition({ items: fine, existing, threshold: t }),
      `incremental D1 drifted from the shipped rule at ${t}`,
    );
  }
});

test('an unrecognised strategy name selects the default rule, never a guess', () => {
  // D1 is the default and `single` is
  // the named escape hatch back to the rule that shipped first. What did NOT
  // change is the closed union — a typo still cannot select a partition nobody
  // measured; it lands on the default, and the stage line says which rule ran.
  assert.equal(partitionStrategyFrom('d1'), 'd1');
  assert.equal(partitionStrategyFrom(' D1 '), 'd1');
  assert.equal(partitionStrategyFrom('single'), 'single');
  assert.equal(partitionStrategyFrom(' SINGLE '), 'single');
  assert.equal(partitionStrategyFrom(undefined), DEFAULT_PARTITION_STRATEGY);
  assert.equal(partitionStrategyFrom(''), DEFAULT_PARTITION_STRATEGY);
  assert.equal(partitionStrategyFrom('D2'), DEFAULT_PARTITION_STRATEGY, 'a strategy nobody implemented is not a strategy');
  assert.equal(partitionStrategyFrom('true'), DEFAULT_PARTITION_STRATEGY);
});

test('the default partition rule is D1', () => {
  // Named as its own test rather than folded into the one above: this is the
  // ruled product decision, and a future change to it should have to delete a
  // test that says so out loud.
  assert.equal(DEFAULT_PARTITION_STRATEGY, 'd1');
});

test('the bucket cut follows the coarse space, including a tagged model name', () => {
  assert.equal(bucketThresholdFor('tfidf-v1'), 0.08);
  assert.equal(bucketThresholdFor('tfidf-v1:whatever'), 0.08);
  assert.equal(bucketThresholdFor('some-unswept-space'), D1_DEFAULT_BUCKET_THRESHOLD);
});
