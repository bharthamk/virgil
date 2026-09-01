import type { TopicId } from './types.js';

/**
 * The topic alias map — how a merge retires an id without rewriting history.
 *
 * DEAD_ENDS.md D15 bought topic identity by making clustering attach-only, and
 * named the price plainly: neither error self-corrects. Two topics wrongly
 * welded together never separate, two wrongly split apart never merge. The
 * missing piece was never a cleverer algorithm — it was a learner-facing
 * split/merge control. This module is half of that control.
 *
 * The constraint that shapes it: the signal ledger is APPEND-ONLY. It is what
 * makes regression detectable (SB-22/SB-36), and rewriting the topic id on a
 * signal to point at the merge survivor would be a retroactive edit of evidence
 * the learner produced. So a merge does not touch signals at all. It records
 * `absorbedId -> keptId` here, and every read path resolves through this map.
 * The comfort computation then unions the two histories for free, because both
 * sets of signals resolve to the same topic id when they are read.
 *
 * Nothing in here throws on a malformed map. It is persisted state and could be
 * hand-edited, and a nightly run that hangs or crashes on a bad alias entry is a
 * worse failure than one that resolves it oddly. Every path is total.
 */
export type AliasMap = Readonly<Record<TopicId, TopicId>>;

/**
 * Chains are real: merge B into A, then A into C, and B->A->C is the honest
 * record of what the learner did. They are not compressed on write, because the
 * uncompressed map is the merge history and reading it back is how a support
 * question ("where did my topic go?") gets answered.
 *
 * The cap is on hops, not chain length as such. A learner cannot plausibly merge
 * sixty-four times down one chain; a corrupted map can loop for ever.
 */
export const MAX_ALIAS_HOPS = 64;

/** Own properties only. The map is loaded from JSON, and `__proto__` as a topic
 *  id must read as "no such alias" rather than reaching the prototype. */
function lookup(aliases: AliasMap, id: TopicId): TopicId | undefined {
  if (!Object.prototype.hasOwnProperty.call(aliases, id)) return undefined;
  const next = (aliases as Record<string, unknown>)[id];
  return typeof next === 'string' && next.length > 0 ? next : undefined;
}

/**
 * Follow the chain to the live topic id.
 *
 * A cycle resolves to the lexicographically smallest id in the cycle, and that
 * choice is doing real work: it is the same answer from every entry point, so
 * every signal in a cycle still lands on one topic and the comfort computation
 * still unions rather than splitting the history at random. `withAlias` refuses
 * to create a cycle, so this branch exists for a store that was edited by hand.
 */
export function resolveTopicId(id: TopicId, aliases: AliasMap): TopicId {
  let current = id;
  const path: TopicId[] = [id];
  const seen = new Set<TopicId>([id]);
  for (let hops = 0; hops < MAX_ALIAS_HOPS; hops++) {
    const next = lookup(aliases, current);
    if (next === undefined || next === current) return current;
    if (seen.has(next)) {
      const from = path.indexOf(next);
      return path.slice(from < 0 ? 0 : from).reduce((a, b) => (a < b ? a : b));
    }
    seen.add(next);
    path.push(next);
    current = next;
  }
  // Past the cap the map is not something a user produced. Same rule as a cycle:
  // one deterministic answer, so the history stays together.
  return path.reduce((a, b) => (a < b ? a : b));
}

/** True when this id has been absorbed by a merge and no longer names a topic
 *  on the board. Deliberately a key check, not a resolution check: an id that
 *  resolves to itself is live even if other ids point at it. */
export function isAbsorbed(id: TopicId, aliases: AliasMap): boolean {
  return lookup(aliases, id) !== undefined;
}

/**
 * Every retired id whose history now belongs to `keptId`, transitively, in id
 * order. Used by deletion: the absorbed history goes with the topic it was
 * merged into, because that is the topic the learner sees and deletes.
 */
export function absorbedInto(keptId: TopicId, aliases: AliasMap): readonly TopicId[] {
  return Object.keys(aliases)
    .filter((k) => k !== keptId && resolveTopicId(k, aliases) === keptId)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Records one merge. Refuses to close a loop — a cycle has no live terminus,
 *  so a topic's history would resolve to a topic that does not exist. */
export function withAlias(aliases: AliasMap, absorbedId: TopicId, keptId: TopicId): AliasMap {
  if (absorbedId === keptId) throw new Error('a topic cannot be an alias of itself');
  if (resolveTopicId(keptId, aliases) === absorbedId) {
    throw new Error(`alias ${absorbedId} -> ${keptId} would close a cycle`);
  }
  return { ...aliases, [absorbedId]: keptId };
}

/**
 * Resolve the topic id on a record read out of the store.
 *
 * This is a read-time projection and never a write: what is on disk keeps the id
 * it was written with. The distinction is the whole design — the ledger stays
 * append-only and verbatim, and the union happens in the reader.
 */
export function resolveOn<T extends { readonly topicId: TopicId }>(row: T, aliases: AliasMap): T {
  const resolved = resolveTopicId(row.topicId, aliases);
  return resolved === row.topicId ? row : { ...row, topicId: resolved };
}

/** As `resolveOn`, for records whose topic id is nullable (pins, statements). */
export function resolveOnNullable<T extends { readonly topicId: TopicId | null }>(
  row: T, aliases: AliasMap,
): T {
  if (row.topicId === null) return row;
  const resolved = resolveTopicId(row.topicId, aliases);
  return resolved === row.topicId ? row : { ...row, topicId: resolved };
}
