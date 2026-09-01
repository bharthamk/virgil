/**
 * D1 — the two-space partition, as a selectable strategy.
 *
 * `clustering.ts` holds the shipped rule: one embedding space, one cut point,
 * average linkage, attach-only. This module holds the alternative that two
 * bake-offs put ahead of it, in the shape the measurements were made in.
 *
 * WHAT D1 IS
 *
 * Bucket the board with a COARSE lexical space at a loose cut, then cluster
 * inside each bucket with the FINE embedding space at the shipped cut. Two pins
 * can only end up in one topic if a lexical test and a semantic test both say
 * so; the fine cut point is not re-fitted, it is relieved of the job of also
 * spanning cross-domain variance.
 *
 * WHY IT IS HERE, IN NUMBERS
 *
 * The partition bake-off of 2026-08-19, reproducible here with
 * `scripts/bakeoff-partition.mjs` — twelve strategies over seven synthetic
 * boards. D1 at tfidf 0.08 -> nomic 0.635 wins
 * the held-out mean (73.8 against the shipped rule's 65.8), has the best worst
 * board of anything measured (57.1), cuts repair cost per pin from 0.313 to
 * 0.259 while inverting its shape from mostly-welds to mostly-tears, and is the
 * only family whose leave-one-board-out fit gap is exactly zero.
 *
 * `REAL_CORPUS_BAKEOFF_2026-08-19.md` — the same harness over 50 pins lifted
 * verbatim from 38 public pages nobody on this project wrote. Carried over
 * blind with nothing re-fitted, D1 scores 73.8 against the shipped rule's 59.7,
 * cuts repair cost from 38 learner actions to 23, and holds its lead under the
 * pessimistic keying of the six ambiguous pins (72.1 against 65.9). Under
 * incremental arrival — the number a learner actually lives in — it reaches
 * 79.5 where the shipped rule reaches 47.6.
 *
 * WHAT THE EVIDENCE DOES NOT SAY
 *
 * That D1 should be the default. Two things are on the record against it and
 * both belong next to the code rather than only in an artefact:
 *
 *  - the coarse cut is a spike, not a plateau. Moving it from 0.08 to 0.10 on
 *    the synthetic corpus drops the worst board from 57.1 to 33.3.
 *  - the mechanism D1 was built on — two spaces making complementary errors —
 *    did not reproduce on real text. There, TF-IDF at its own cut reached zero
 *    pairs nomic did not also reach, so the bucket acts as a filter on the fine
 *    space's false pairs rather than as a second opinion, and simply raising the
 *    fine cut (strategy B, nomic 0.730) beat D1 by 15.8 held-out points on that
 *    corpus — a result which is itself fragile to how six pins are keyed.
 *
 * Both cautions were on the record when the flip was ruled (the D1 partition default,
 * 2026-08-20) and are the reason the flip came with a standing guard rather
 * than a shrug: this is the default rule now, `SB_PARTITION=single` is the way
 * back to what shipped before this module existed, and no change to
 * `D1_BUCKET_THRESHOLDS` lands without both bake-off harnesses run again.
 *
 * DETERMINISM
 *
 * Identical discipline to `clustering.ts`, because it is the same requirement
 * (DEAD_ENDS.md D15) and half of it is literally the same code: every iteration
 * order is fixed by sorting on pin id, every tie resolves by that id order,
 * centroids are frozen before any attachment, and nothing reads a clock, a hash
 * seed or a Map insertion order. Both stages are `agglomerate` from
 * `clustering.ts`, so the tie-break is not merely the same discipline, it is the
 * same implementation.
 */
import {
  EPS, agglomerate, assertPartition, centroid, cosine,
  type Embedded, type ExistingGroup, type PartitionGroup,
} from './clustering.js';

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------- the selector

/**
 * Which partition rule a run uses.
 *
 * `d1` is this module and the default. `single` is the older rule in
 * `clustering.ts`, kept reachable by name. Deliberately a closed union rather
 * than a free string: an unknown value must not silently select a partition
 * nobody measured.
 */
export type PartitionStrategyId = 'single' | 'd1';

export const PARTITION_STRATEGIES: readonly PartitionStrategyId[] = ['single', 'd1'];

/**
 * The rule a run uses when nothing selects one.
 *
 * Flipped to `d1` on 2026-08-20 (the D1 partition default). What earned the flip is on the
 * record above: D1 wins the held-out mean on both corpora, has the best worst
 * board of anything measured, and reaches 79.5 against 47.6 under the
 * incremental arrival a learner actually lives in. What did NOT change is the
 * caution beside it — the coarse cut is a spike, not a plateau — so the
 * equivalence harness (`npm run check:d1`) and both bake-offs guard any future
 * move of `D1_BUCKET_THRESHOLDS`.
 */
export const DEFAULT_PARTITION_STRATEGY: PartitionStrategyId = 'd1';

/**
 * Reads a strategy name from configuration. Anything unrecognised — including
 * a typo, an empty string or an absent variable — is the default, because the
 * failure mode of guessing is a board partitioned by a rule the operator did
 * not ask for and cannot see. The union stays closed for the same reason: a
 * typo lands on a measured rule, and the run's stage line names which one.
 */
export function partitionStrategyFrom(raw: string | undefined | null): PartitionStrategyId {
  const name = (raw ?? '').trim().toLowerCase();
  return (PARTITION_STRATEGIES as readonly string[]).includes(name)
    ? (name as PartitionStrategyId)
    : DEFAULT_PARTITION_STRATEGY;
}

// ------------------------------------------------------------- cut points

/**
 * The coarse bucket cut, per coarse space.
 *
 * 0.08 for TF-IDF is the synthetic bake-off's choice, carried to the real
 * corpus without re-fitting and measured there at +14.1 mean F1 over the
 * shipped rule. The real corpus's own best value was 0.12 (81.3 against 73.8),
 * but 0.08 is the value that has now been measured on two corpora rather than
 * fitted on one, and it is the more keying-stable of the two: 73.8 / 72.1
 * across both keyings of the ambiguous pins, a spread of 1.7, the smallest in
 * that run.
 *
 * Do NOT nudge this to 0.10 on the intuition that a tighter bucket is safer.
 * That exact move was measured: mean F1 down four points, worst board down
 * twenty-four, 57.1 to 33.3.
 */
export const D1_BUCKET_THRESHOLDS: Readonly<Record<string, number>> = {
  'tfidf-v1': 0.08,
};

/**
 * Used when the coarse space has not been swept. Same reasoning as
 * `DEFAULT_CLUSTER_THRESHOLD`: there is no principled constant, a cut point is
 * a fact about one space, and a new coarse space wants its own sweep. This
 * value is the TF-IDF one and is a guess anywhere else.
 */
export const D1_DEFAULT_BUCKET_THRESHOLD = 0.08;

export function bucketThresholdFor(modelId: string): number {
  const key = Object.keys(D1_BUCKET_THRESHOLDS).sort(byString).find((k) => modelId.startsWith(k));
  return key === undefined ? D1_DEFAULT_BUCKET_THRESHOLD : (D1_BUCKET_THRESHOLDS[key] ?? D1_DEFAULT_BUCKET_THRESHOLD);
}

// ------------------------------------------------------------------ inputs

/**
 * One pin in both spaces at once.
 *
 * The two vectors are not comparable with each other and are never mixed: the
 * coarse vector only ever meets other coarse vectors, the fine vector only ever
 * meets fine ones. They are carried in one object solely so the pairing is
 * fixed by construction rather than by two arrays staying in step.
 */
export interface TwoSpaceEmbedded {
  readonly id: string;
  /** The lexical space the buckets are cut in — TF-IDF today. */
  readonly coarse: readonly number[];
  /** The embedding space the topics are cut in — nomic today. */
  readonly fine: readonly number[];
}

export interface D1PartitionInput {
  readonly items: readonly TwoSpaceEmbedded[];
  readonly existing: readonly ExistingGroup[];
  /** Coarse cosine at or above which two pins share a bucket. */
  readonly bucketThreshold: number;
  /** Fine cosine at or above which two pins in one bucket share a topic. */
  readonly threshold: number;
}

// ----------------------------------------------------------- cold clustering

/**
 * The coarse buckets: `agglomerate` in the coarse space, nothing else.
 *
 * Transitive by construction, which is the property that separates D1 from a
 * pairwise two-space vote (strategy E1): two pins can share a bucket without
 * being lexically similar to each other, provided the linkage path holds. The
 * synthetic bake-off's section 3 is where that difference is priced.
 */
export function bucketise(
  items: readonly TwoSpaceEmbedded[],
  bucketThreshold: number,
): readonly (readonly string[])[] {
  return agglomerate(items.map((it) => ({ id: it.id, vector: it.coarse })), bucketThreshold);
}

/**
 * D1 cold: bucket in the coarse space, then cluster inside each bucket in the
 * fine space.
 *
 * Ported from the harness, `scripts/bakeoff-partition.mjs` lines 248-264 (the
 * `D1` entry of `FAMILIES`, its `cluster` closure), whose `cutSubset` is
 * `dendrogram(items).cut(t)` from `scripts/bakeoff-lib.mjs` lines 214-262 — and
 * that in turn is asserted equal to this file's `agglomerate`, char for char,
 * on every board in both spaces, at `bakeoff-partition.mjs` lines 100-108. The
 * numbers in the two artefacts are the specification; this is the same
 * arithmetic in the product's own primitives.
 *
 * ONE DELIBERATE DIFFERENCE, AND IT IS ORDER ONLY. The harness emits groups
 * bucket by bucket, so its group order interleaves buckets rather than being
 * globally id-ordered. `agglomerate` documents the opposite — groups ordered by
 * their smallest member id — and callers name topics off that order, so the
 * output is re-sorted into it here. The partition (the sets of pin ids) is
 * identical; only the sequence differs, and `scripts/check-d1-equivalence.mjs`
 * compares the two canonically for exactly this reason.
 */
export function agglomerateD1(
  items: readonly TwoSpaceEmbedded[],
  bucketThreshold: number,
  threshold: number,
): readonly (readonly string[])[] {
  if (!items.length) return [];
  const fineOf = new Map(items.map((it) => [it.id, it.fine]));
  const out: (readonly string[])[] = [];
  for (const bucket of bucketise(items, bucketThreshold)) {
    const sub: Embedded[] = bucket.map((id) => ({ id, vector: fineOf.get(id) ?? [] }));
    for (const group of agglomerate(sub, threshold)) out.push(group);
  }
  // Groups are disjoint and each is internally id-sorted, so their first
  // elements are a total order and sorting on it is the canonical form.
  return out.sort((a, b) => byString(a[0] ?? '', b[0] ?? ''));
}

// -------------------------------------------------------------- attach-only

/**
 * D1 incremental, and the rule that decides how a bucket interacts with attach.
 *
 * The reference behaviour is the harness's arrival driver — `incremental()` in
 * `scripts/bakeoff-partition.mjs` lines 550-624, over the vectors and
 * primitives of `scripts/bakeoff-lib.mjs` — plus the `D1` family's own
 * acceptance rule at line 262, `(vN, vT) => vT >= tc && vN >= tt`. Both
 * artefacts' incremental tables were produced by that driver, so it is the
 * behaviour being reproduced here rather than a redesign of it.
 *
 * THE ATTACH/BUCKET INTERACTION RULE, stated plainly because it is the one
 * thing about D1 that a reader will otherwise assume wrongly:
 *
 *  1. An arriving pin does NOT get bucketed against the board. Cold D1 buckets
 *     transitively; attach does not re-run that. Bucket membership at attach
 *     time is a CENTROID test — the pin's coarse vector against the existing
 *     topic's coarse centroid — because an existing topic is a decision already
 *     made and its members must not be re-partitioned to find out where a
 *     newcomer goes.
 *  2. The candidate topic is chosen in the FINE space alone. The nearest
 *     fine centroid wins, ties to the lexicographically smaller topic id, and
 *     that single candidate is then tested. The coarse test is a veto on that
 *     one topic, never a search over the others: a pin the fine space sent to
 *     topic A and the coarse space refused does NOT fall through to topic B.
 *     It goes to the leftovers and may seed a new topic instead. This is the
 *     harness's shape exactly (`bestSim` is computed on nomic only, then
 *     `accept` is called once, with both similarities to that same centroid).
 *  3. Leftovers cluster among themselves under the full cold D1 rule — coarse
 *     buckets first, fine cut inside them.
 *  4. Everything the shipped rule promises still holds: a pin that already has
 *     a topic never moves, centroids are frozen before any attachment, and a
 *     topic with no surviving members is left alone rather than resurrected.
 *
 * Consequence worth naming: an arriving pin can be lexically close to the
 * topic's centroid without being close to any single member of it, and can be
 * refused by a topic it would have shared a transitive bucket with cold. That
 * asymmetry between cold and incremental is inherent to attach-only and is
 * present in the measured numbers, which is why it is reproduced rather than
 * smoothed over.
 */
export function partitionD1(input: D1PartitionInput): readonly PartitionGroup[] {
  const items = [...input.items].sort((a, b) => byString(a.id, b.id));
  const coarseOf = new Map(items.map((it) => [it.id, it.coarse]));
  const fineOf = new Map(items.map((it) => [it.id, it.fine]));

  // Existing membership, read in topic-id order — same reasoning as
  // `partition`: a pin claimed by two topics should be impossible and is
  // therefore worth resolving the same way on every run instead of by object
  // iteration order.
  const existing = [...input.existing].sort((a, b) => byString(a.topicId, b.topicId));
  const claimed = new Map<string, string>();
  for (const g of existing) {
    for (const pid of [...g.memberIds].sort(byString)) {
      if (fineOf.has(pid) && !claimed.has(pid)) claimed.set(pid, g.topicId);
    }
  }

  // Both centroids, computed from current members and then frozen. The coarse
  // centroid is what the bucket veto is measured against, so it is frozen for
  // the same reason the fine one is: otherwise the order newcomers are
  // considered in decides where later ones land.
  const centroids = existing
    .map((g) => {
      const members = [...g.memberIds].filter((id) => claimed.get(id) === g.topicId).sort(byString);
      return {
        topicId: g.topicId,
        members,
        fine: centroid(members.map((id) => fineOf.get(id) ?? [])),
        coarse: centroid(members.map((id) => coarseOf.get(id) ?? [])),
      };
    })
    // A topic whose pins have all been deleted — or absorbed by a merge, which
    // is how a retired alias id reaches this code — has nothing to compare
    // against. It is left entirely alone rather than resurrected with new
    // members, so a retired id cannot attract an arriving pin.
    .filter((c) => c.members.length > 0);

  const attachedTo = new Map<string, string[]>();
  const leftover: TwoSpaceEmbedded[] = [];
  for (const it of items) {
    if (claimed.has(it.id)) continue;
    // Rule 2: the candidate is chosen in the fine space alone.
    let best: (typeof centroids)[number] | null = null;
    let bestSim = -Infinity;
    for (const c of centroids) {
      const s = cosine(it.fine, c.fine);
      // Ties go to the lexicographically smaller topic id, because `centroids`
      // is in that order and only a strictly better score displaces it.
      if (s > bestSim + EPS) { bestSim = s; best = c; }
    }
    const accepted = best !== null
      && bestSim + EPS >= input.threshold
      // Rule 1: the coarse test is a veto on that one topic.
      && cosine(it.coarse, best.coarse) + EPS >= input.bucketThreshold;
    if (accepted && best !== null) {
      const list = attachedTo.get(best.topicId) ?? [];
      list.push(it.id);
      attachedTo.set(best.topicId, list);
    } else {
      leftover.push(it);
    }
  }

  const groups: PartitionGroup[] = [];
  for (const c of centroids) {
    const attached = (attachedTo.get(c.topicId) ?? []).sort(byString);
    groups.push({
      topicId: c.topicId,
      pinIds: [...c.members, ...attached].sort(byString),
      attached,
    });
  }
  // Rule 3.
  for (const seeded of agglomerateD1(leftover, input.bucketThreshold, input.threshold)) {
    groups.push({ topicId: null, pinIds: seeded, attached: [] });
  }

  // D13, for the same reason `partition` asserts it: a partition that is true
  // by construction is one refactor away from being false by construction,
  // silently, and a dropped pin is one the learner saved and would never be
  // taught. A second rule that partitions gets its own assertion, not a shared
  // assumption that the first one's still covers it.
  assertPartition(items.map((it) => it.id), groups);
  return groups;
}
