import type { Pin, PinId, Topic, TopicId } from './types.js';
import { type AliasMap, isAbsorbed, resolveTopicId } from './aliases.js';
import { rendersEmpty, stripInvisible } from './text.js';

/**
 * Split and merge — the learner's repair control for topic identity.
 *
 * Attach-only clustering (DEAD_ENDS.md D15) made the board stable by making an
 * established assignment permanent. That is the right trade and it removes
 * self-repair: both embedders still weld "seventh chords" to "tritone
 * substitution" on the seed corpus and nothing in the nightly run will ever
 * separate them. The repair path therefore has to be the user's, and being the
 * user's is what fixes its shape:
 *
 *  - the user names the new topic. No model call. A trust surface that guesses
 *    at what you meant is not a trust surface;
 *  - nothing is silent. Both operations are planned here and confirmed above,
 *    so the panel can say exactly what will happen before it happens;
 *  - comfort history is not divisible. A merge unions two histories, which is
 *    arithmetic the evidence supports. A split cannot divide one history,
 *    because no signal in the ledger says which half of the topic it was about
 *    — so the original keeps all of it and the new topic starts with none.
 *    Guessing a division would fabricate evidence, which is the one thing this
 *    product must never do.
 *
 * A new topic with no evidence is safe to create precisely because D14 was
 * fixed: `reviewDue` returns false for a topic never taught, and the Registrar
 * reports `evidenceCount: 0` with `certainty: 0`, so a fresh topic is treated as
 * unknown rather than as maximally overdue.
 *
 * Pure. Plans are computed here and applied by the store, so the validation is
 * testable without a filesystem and identical for every adapter.
 */

export type TopicOpCode =
  | 'unknown-topic'
  | 'absorbed-topic'
  | 'self-merge'
  | 'unknown-pin'
  | 'pin-not-in-topic'
  | 'empty-selection'
  | 'empty-split'
  | 'empty-label'
  | 'label-too-long';

export class TopicOpError extends Error {
  constructor(readonly code: TopicOpCode, message: string) {
    super(message);
    this.name = 'TopicOpError';
  }
}

/** Same cap the clusterer applies to a model-produced label, so a user-named
 *  topic and a fleet-named one cannot render differently. Learner text is
 *  refused at the boundary rather than silently made to fit it. */
export const MAX_LABEL_LENGTH = 60;

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface MergePlan {
  /** The survivor, holding both pin sets. Its label and summary are untouched. */
  readonly keep: Topic;
  /** The id that stops naming a topic and becomes an alias of `keep.id`. */
  readonly retiredTopicId: TopicId;
  /** Pins that change hands. */
  readonly movedPinIds: readonly PinId[];
}

/**
 * Plan `absorbId`'s pins onto `keepId`.
 *
 * Both ids are resolved first, so merging by way of an id that was itself
 * absorbed earlier lands on the live topic rather than failing. What is refused
 * is merging a topic into itself by any route, and merging *into* an id that no
 * longer names anything.
 */
export function planMerge(
  topics: readonly Topic[],
  aliases: AliasMap,
  keepId: TopicId,
  absorbId: TopicId,
): MergePlan {
  const keepResolved = resolveTopicId(keepId, aliases);
  const absorbResolved = resolveTopicId(absorbId, aliases);
  if (keepResolved === absorbResolved) {
    throw new TopicOpError('self-merge', `${keepId} and ${absorbId} are already the same topic`);
  }
  // The absorbed side is checked against the raw id: absorbing an id that has
  // already been absorbed is not a merge, it is a stale request from a panel
  // that has not refreshed, and silently redirecting it would retire a topic
  // the user never pointed at.
  if (isAbsorbed(absorbId, aliases)) {
    throw new TopicOpError('absorbed-topic', `${absorbId} was already merged into ${absorbResolved}`);
  }
  const keep = topics.find((t) => t.id === keepResolved);
  if (!keep) throw new TopicOpError('unknown-topic', `no topic ${keepId}`);
  const absorb = topics.find((t) => t.id === absorbResolved);
  if (!absorb) throw new TopicOpError('unknown-topic', `no topic ${absorbId}`);

  const held = new Set(keep.pinIds);
  const movedPinIds = absorb.pinIds.filter((id) => !held.has(id));

  return {
    keep: {
      ...keep,
      // Membership order follows the survivor, then the absorbed topic in its
      // own order. The clusterer sorts by pin id before it reads any of this,
      // so the order is for humans reading the store, not for the partition.
      pinIds: [...keep.pinIds, ...movedPinIds],
      // Exposure is a fact about material, and after the merge this topic holds
      // material that was taught. Taking the later of the two keeps D14 honest
      // in both directions: never-taught stays null only if neither was taught.
      lastExposedAt: laterOf(keep.lastExposedAt, absorb.lastExposedAt),
      // `comfort` and `state` are derived and deliberately left alone. The
      // Registrar recomputes both from the unioned ledger on the next run, and
      // writing a guess here would put a number on the board that no evidence
      // produced.
    },
    retiredTopicId: absorb.id,
    movedPinIds,
  };
}

function laterOf(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.localeCompare(b) >= 0 ? a : b;
}

export interface SplitPlan {
  /** The original, with the moved pins removed. Keeps all of the history. */
  readonly original: Topic;
  /** The new topic. User-named, and honestly empty of evidence. */
  readonly created: Topic;
  readonly movedPinIds: readonly PinId[];
}

/**
 * Plan moving `pinIds` out of `topicId` into a new topic called `newLabel`.
 *
 * A split that would take every pin is refused. That is not a pedantic check:
 * an empty original still owns the entire signal ledger for the material, so
 * the board would show a topic with no pins carrying all the comfort and a
 * topic with all the pins carrying none. If the intent was to rename, rename;
 * if it was to move everything somewhere, that is a merge.
 */
export function planSplit(
  topics: readonly Topic[],
  pins: readonly Pin[],
  aliases: AliasMap,
  topicId: TopicId,
  pinIds: readonly PinId[],
  newLabel: string,
  newTopicId: TopicId,
  now: string,
): SplitPlan {
  const resolved = resolveTopicId(topicId, aliases);
  const original = topics.find((t) => t.id === resolved);
  if (!original) throw new TopicOpError('unknown-topic', `no topic ${topicId}`);

  // `stripInvisible` before the whitespace collapse, and `rendersEmpty` rather
  // than `!label`: a name built out of bidi overrides and zero-width spaces is
  // not whitespace and survives `.trim()`, and a topic whose name renders as
  // nothing is unreachable on the board the learner is meant to run.
  const label = stripInvisible(newLabel).trim();
  if (rendersEmpty(label)) throw new TopicOpError('empty-label', 'the new topic needs a name');
  if (Array.from(label).length > MAX_LABEL_LENGTH) {
    throw new TopicOpError(
      'label-too-long', `the new topic name must contain at most ${MAX_LABEL_LENGTH} characters`,
    );
  }

  const wanted = [...new Set(pinIds)];
  if (!wanted.length) throw new TopicOpError('empty-selection', 'no pins selected to split out');

  const known = new Set(pins.map((p) => p.id));
  const unknown = wanted.filter((id) => !known.has(id));
  if (unknown.length) {
    throw new TopicOpError('unknown-pin', `no such pin: ${unknown.slice(0, 3).join(', ')}`);
  }
  const member = new Set(original.pinIds);
  const foreign = wanted.filter((id) => !member.has(id));
  if (foreign.length) {
    throw new TopicOpError('pin-not-in-topic',
      `not in ${original.label}: ${foreign.slice(0, 3).join(', ')}`);
  }
  if (wanted.length >= original.pinIds.length) {
    throw new TopicOpError('empty-split',
      'a split has to leave something behind, or it is a rename and not a split');
  }

  const moving = new Set(wanted);
  return {
    original: { ...original, pinIds: original.pinIds.filter((id) => !moving.has(id)) },
    created: {
      id: newTopicId,
      label,
      // No summary. The model is not asked to write one, and inventing one from
      // the label would be prose the learner never approved on a surface whose
      // entire point is that they said what this is.
      summary: '',
      pinIds: original.pinIds.filter((id) => moving.has(id)),
      // No evidence yet, and `waiting` is what the Registrar computes for a
      // topic with none. Stating it here keeps the board consistent before the
      // next nightly run rather than for the few hours until one happens.
      state: 'waiting',
      comfort: 0.15,
      lastExposedAt: null,
      retiredByUser: false,
      createdAt: now,
    },
    movedPinIds: [...moving].sort(byString),
  };
}
