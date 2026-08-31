/**
 * Deterministic clustering — the partition decision, in code.
 *
 * clustering-stability constraint measured the problem: the same corpus clustered to 6, 6 and
 * 7 topics on three consecutive runs of the same prompt against the same model.
 * Topic identity is the hardest problem in the design — comfort and signal
 * history attach to topic ids — so a nightly reshuffle detaches a learner's
 * history from the thing it was about.
 *
 * Nothing here calls a model, touches I/O, or reads a clock. Given the same
 * vectors it returns the bit-identical partition every time, and that property
 * is the entire product requirement:
 *
 *  - every iteration order is fixed by sorting on pin id, never on insertion
 *    order, Map order or vector value;
 *  - every tie is broken by that same id order, so equal similarities resolve
 *    the same way on every machine;
 *  - centroids are frozen before any attachment, so which new pin is considered
 *    first cannot change where the second one lands.
 *
 * Average linkage rather than single or complete: single linkage chains two
 * topics together through one ambiguous pin, and complete linkage refuses to
 * grow a topic that has any internal spread — a learner's topic legitimately
 * has both a canonical doc and a Stack Overflow answer in it.
 */

/**
 * Float comparisons need slack, and the slack has to be applied consistently or
 * it becomes a source of instability in its own right. Two similarities within
 * EPS of each other are treated as equal, and equality is resolved by id order.
 */
export const EPS = 1e-12;

export interface Embedded {
  readonly id: string;
  readonly vector: readonly number[];
}

/** A topic that already exists, and the pins already inside it. */
export interface ExistingGroup {
  readonly topicId: string;
  readonly memberIds: readonly string[];
}

export interface PartitionGroup {
  /** Null when this group is a topic being created on this run. */
  readonly topicId: string | null;
  /** Every pin in the group, sorted by id. */
  readonly pinIds: readonly string[];
  /** The subset that joined an existing topic on this run. Empty for new topics. */
  readonly attached: readonly string[];
}

export interface PartitionInput {
  readonly items: readonly Embedded[];
  readonly existing: readonly ExistingGroup[];
  /** Cosine similarity at or above which two things belong together. */
  readonly threshold: number;
}

// ------------------------------------------------------------------- vectors

/**
 * Cosine similarity. Zero vectors return 0 rather than NaN — a pin whose text
 * produced no features (an empty selection, a page in a language the tokeniser
 * does not split) must fall out as its own topic, not poison every comparison
 * it takes part in.
 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  // Lengths can differ only through a caller bug, but the tail still counts
  // toward the norms; ignoring it would report a false similarity of 1.
  for (let i = n; i < a.length; i++) { const x = a[i] ?? 0; na += x * x; }
  for (let i = n; i < b.length; i++) { const y = b[i] ?? 0; nb += y * y; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Mean vector. Summation order is the caller's array order, so sort first. */
export function centroid(vectors: readonly (readonly number[])[]): readonly number[] {
  const width = vectors.reduce((w, v) => Math.max(w, v.length), 0);
  if (!vectors.length || !width) return [];
  const out = new Array<number>(width).fill(0);
  for (const v of vectors) for (let i = 0; i < width; i++) out[i] = (out[i] ?? 0) + (v[i] ?? 0);
  for (let i = 0; i < width; i++) out[i] = (out[i] ?? 0) / vectors.length;
  return out;
}

const byId = (a: Embedded, b: Embedded): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// -------------------------------------------------------------- agglomerative

/**
 * Agglomerative average-linkage clustering, cut at `threshold`.
 *
 * Returns groups of pin ids: each group sorted internally by id, the groups
 * themselves ordered by their smallest member id. Both orderings are part of
 * the contract — a caller that names topics from this output would otherwise
 * see the names shuffle even when the partition did not.
 *
 * O(n^3) and deliberately so. A learner's board is tens of pins, not millions,
 * and the naive form is the one whose determinism can be read off the page.
 */
export function agglomerate(
  items: readonly Embedded[],
  threshold: number,
): readonly (readonly string[])[] {
  const sorted = [...items].sort(byId);
  const n = sorted.length;
  if (n === 0) return [];

  // Full similarity matrix up front. Average linkage is then a mean over the
  // cross pairs, recomputed from the matrix rather than updated incrementally —
  // an incremental update would make the result depend on merge history, which
  // is exactly the instability being designed out.
  const sim: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = cosine(sorted[i]?.vector ?? [], sorted[j]?.vector ?? []);
      (sim[i] as number[])[j] = s;
      (sim[j] as number[])[i] = s;
    }
  }

  const avg = (a: readonly number[], b: readonly number[]): number => {
    let total = 0;
    for (const i of a) for (const j of b) total += sim[i]?.[j] ?? 0;
    return total / (a.length * b.length);
  };

  // Clusters stay ordered by smallest member id: the list starts in id order,
  // and a merge writes into the earlier slot, which already holds the smaller
  // minimum. The invariant survives every merge, so no re-sort is needed.
  let clusters: number[][] = sorted.map((_, i) => [i]);

  for (;;) {
    let best = -Infinity, bi = -1, bj = -1;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const s = avg(clusters[i] as number[], clusters[j] as number[]);
        // Strictly greater by more than EPS: a tie leaves the earlier pair
        // standing, and "earlier" means lower id. That is the tie-break.
        if (s > best + EPS) { best = s; bi = i; bj = j; }
      }
    }
    if (bi < 0 || bj < 0 || best + EPS < threshold) break;
    const merged = [...(clusters[bi] as number[]), ...(clusters[bj] as number[])].sort((x, y) => x - y);
    clusters[bi] = merged;
    clusters = clusters.filter((_, k) => k !== bj);
  }

  return clusters.map((c) => c.map((i) => sorted[i]?.id ?? '').sort(byString));
}

// ------------------------------------------------------------- attach-only

/**
 * The incremental rule, and the reason any of this exists.
 *
 * A pin that already has a topic NEVER moves. New pins attach to the nearest
 * existing centroid when they are close enough, and whatever is left clusters
 * among itself into new topics. A run over an unchanged board is therefore a
 * no-op by construction: no pin is new, so nothing is decided, so nothing can
 * reshuffle and no signal can be orphaned.
 *
 * The cost is honest and worth naming: a genuinely wrong early merge is
 * permanent until something splits it, and nothing splits it yet. That is the
 * trade clustering-stability constraint asks for — a board that is occasionally coarse beats a board that
 * is different every morning.
 */
export function partition(input: PartitionInput): readonly PartitionGroup[] {
  const items = [...input.items].sort(byId);
  const vectorOf = new Map(items.map((it) => [it.id, it.vector]));

  // Existing membership, read in topic-id order so that a pin claimed by two
  // topics — which should be impossible, and is therefore worth surviving —
  // resolves the same way every run instead of by object iteration order.
  const existing = [...input.existing].sort((a, b) => byString(a.topicId, b.topicId));
  const claimed = new Map<string, string>();
  for (const g of existing) {
    for (const pid of [...g.memberIds].sort(byString)) {
      if (vectorOf.has(pid) && !claimed.has(pid)) claimed.set(pid, g.topicId);
    }
  }

  // Centroids are computed from current members and then frozen. If they were
  // updated as pins attached, the order in which new pins were considered would
  // change where later ones landed — and pin order is not a thing the learner
  // controls or can see.
  const centroids = existing
    .map((g) => {
      const members = [...g.memberIds].filter((id) => claimed.get(id) === g.topicId).sort(byString);
      return { topicId: g.topicId, members, vector: centroid(members.map((id) => vectorOf.get(id) ?? [])) };
    })
    // A topic whose pins have all been deleted has nothing to compare against.
    // It is left entirely alone rather than being resurrected with new members.
    .filter((c) => c.members.length > 0);

  const attachedTo = new Map<string, string[]>();
  const leftover: Embedded[] = [];
  for (const it of items) {
    if (claimed.has(it.id)) continue;
    let bestTopic: string | null = null, bestSim = -Infinity;
    for (const c of centroids) {
      const s = cosine(it.vector, c.vector);
      // Ties go to the lexicographically smaller topic id, because `centroids`
      // is in that order and only a strictly better score displaces it.
      if (s > bestSim + EPS) { bestSim = s; bestTopic = c.topicId; }
    }
    if (bestTopic !== null && bestSim + EPS >= input.threshold) {
      const list = attachedTo.get(bestTopic) ?? [];
      list.push(it.id);
      attachedTo.set(bestTopic, list);
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
  for (const seeded of agglomerate(leftover, input.threshold)) {
    groups.push({ topicId: null, pinIds: seeded, attached: [] });
  }

  // partition-invariant constraint: when code partitions a set, assert the partition. It now holds by
  // construction rather than by a model's goodwill, which is precisely why the
  // assertion has to stay — a partition that is true by construction is one
  // refactor away from being false by construction, silently.
  assertPartition(items.map((it) => it.id), groups);
  return groups;
}

/**
 * Every input id in exactly one group, and no group holding an id that was
 * never an input. Throws rather than returns, because there is no sensible
 * partial answer: a dropped pin is a pin the learner deliberately saved and
 * would simply never be taught (partition-invariant constraint).
 */
export function assertPartition(
  ids: readonly string[],
  groups: readonly { readonly pinIds: readonly string[] }[],
): void {
  const seen = new Map<string, number>();
  for (const g of groups) for (const id of g.pinIds) seen.set(id, (seen.get(id) ?? 0) + 1);
  const input = new Set(ids);
  const missing = ids.filter((id) => !seen.has(id));
  const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  const foreign = [...seen.keys()].filter((id) => !input.has(id));
  if (missing.length || duplicated.length || foreign.length) {
    throw new Error(
      `clustering did not partition its input — ${missing.length} missing`
      + `, ${duplicated.length} in two groups, ${foreign.length} not from the input`
      + `${missing.length ? ` (missing: ${missing.slice(0, 5).join(', ')})` : ''}`,
    );
  }
}

// ------------------------------------------------------------- cut points

/**
 * The cut point is a property of the embedding space, not of the algorithm.
 * Cosine similarities from a trained embedding model sit far higher and far
 * closer together than TF-IDF cosines over short texts, so one constant cannot
 * serve both. Measured by threshold sweep against the 21-pin golden key —
 * AGENT_EVAL_LOG.md Run 5.
 */
export const CLUSTER_THRESHOLDS: Readonly<Record<string, number>> = {
  // Centre of the 0.631-0.638 plateau: F1 89.5% on the golden key, P 81.0 /
  // R 100.0. The plateau is narrow, and that narrowness is a stated risk.
  'nomic-embed-text': 0.635,
  // Centre of 0.112-0.127: F1 91.4%, which is *better* than the embedding model
  // on this corpus and does not survive the corpus changing shape. TF-IDF is
  // the fallback, not the default, for reasons measured in Run 5.
  'tfidf-v1': 0.12,
};

/**
 * Used when the model id has not been swept. It is the measured nomic value
 * rather than a principled constant, because there is no principled constant —
 * a cut point is a fact about one embedding space and transfers to another only
 * by luck. A new embedder wants its own sweep before it is trusted.
 *
 * Erring high is the lesser evil. Under attach-only neither error self-corrects
 * — two topics that were split apart never merge, and two that were welded
 * together never separate — but a topic split in two still teaches the same
 * material through two doors, whereas a topic welded out of unrelated material
 * has a comfort score that means nothing and cannot be read by the learner as
 * anything but noise.
 */
export const DEFAULT_CLUSTER_THRESHOLD = 0.635;

export function thresholdFor(modelId: string): number {
  // Prefix match: Ollama reports `nomic-embed-text:latest`, and a tag change
  // should not silently drop the board back to the default.
  const key = Object.keys(CLUSTER_THRESHOLDS).sort(byString).find((k) => modelId.startsWith(k));
  return key === undefined ? DEFAULT_CLUSTER_THRESHOLD : (CLUSTER_THRESHOLDS[key] ?? DEFAULT_CLUSTER_THRESHOLD);
}
