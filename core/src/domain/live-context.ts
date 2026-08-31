import { cosine, thresholdFor } from './clustering.js';
import type { Pin, Topic, TopicId } from './types.js';

/**
 * Derives foreground learner context without waiting for background clustering.
 * Material and topic documents must be embedded in one call because batch-fitted
 * embedders produce vectors that are comparable only within that call.
 */

/**
 * How much of one member pin goes into its topic's document.
 *
 * A topic is matched on what it is actually made of, not only on the sentence
 * the Clusterer wrote about it: a label of two words and a one-line summary is
 * a thin thing to match a passage against, and the pins are the evidence.
 */
export const TOPIC_DOC_PIN_CHARS = 400;

/** How many member pins contribute. Enough to characterise a topic, bounded so
 *  a topic with two hundred pins does not produce a document that is mostly
 *  noise and costs a fortune to embed. */
export const TOPIC_DOC_PINS = 8;

/**
 * How much of the material is matched.
 *
 * The same window the quick take reads, so the thing being matched is the
 * thing being taught. A match made on more text than the take is written from
 * would pitch a register at material the learner never sees.
 */
export const MATCH_MATERIAL = 4_000;

/**
 * The text that represents a topic in the comparison.
 *
 * Deterministic in the pins' stored order, so the same board yields the same
 * document and the same match on two consecutive requests. A learner asking the
 * same question twice and being taught at two different registers would be the
 * kind of instability this product's clustering work exists to avoid.
 */
export function topicDocument(topic: Topic, pins: readonly Pin[]): string {
  const byId = new Map(pins.map((p) => [p.id, p]));
  const parts: string[] = [topic.label, topic.summary];
  for (const pinId of topic.pinIds.slice(0, TOPIC_DOC_PINS)) {
    const pin = byId.get(pinId);
    if (!pin) continue;
    const e = pin.envelope;
    const text = (e.selection ?? e.surroundingText ?? '').trim();
    if (text) parts.push(text.slice(0, TOPIC_DOC_PIN_CHARS));
  }
  return parts.filter(Boolean).join('\n');
}

/** One topic's claim on the material, and how strong it is. */
export interface TopicMatch {
  readonly topicId: TopicId;
  readonly similarity: number;
}

/**
 * The topics this material is about, best first.
 *
 * `vectors` are in the caller's order: the material first, then one per topic,
 * from the same embed call. Anything at or above the cut for this space is a
 * match; everything else is not, and an empty list is a real answer.
 *
 * **Nothing is returned below the cut.** Attaching material to the nearest
 * topic regardless of distance would put a passage about short stories onto a
 * topic about Firestore indexes and then read that topic's comfort to decide
 * how to teach it — which is worse than knowing nothing, because knowing
 * nothing is at least true. `from-nothing` on a genuinely new subject is the
 * honest pitch for it, and always was.
 */
export function matchTopics(
  materialVector: readonly number[],
  topicVectors: readonly { readonly topicId: TopicId; readonly vector: readonly number[] }[],
  modelId: string,
  opts: { readonly threshold?: number } = {},
): readonly TopicMatch[] {
  if (!materialVector.length) return [];
  const cut = opts.threshold ?? thresholdFor(modelId);
  const scored: TopicMatch[] = [];
  for (const { topicId, vector } of topicVectors) {
    if (!vector.length) continue;
    const similarity = cosine(materialVector, vector);
    if (similarity >= cut) scored.push({ topicId, similarity });
  }
  // Ties broken by topic id so the order is total and reproducible: two topics
  // at the same distance must not swap between two requests.
  return scored.sort((a, b) => (b.similarity - a.similarity) || a.topicId.localeCompare(b.topicId));
}

/**
 * Which topic's history should teach this, and where it came from.
 *
 * `filed` is the Clusterer's answer, and it wins where it exists: once the
 * partition has placed a pin, that placement is the board's truth and a live
 * guess must not quietly override it. `live` is this file's answer for
 * everything the partition has not reached yet, which on the active path is
 * almost everything, because the learner pinned it four seconds ago.
 *
 * `null` means the board holds nothing about this, which is a fact and not a
 * failure.
 */
export type ContextSource = 'filed' | 'live' | 'none';

export interface LiveContext {
  readonly topicId: TopicId | null;
  readonly source: ContextSource;
  /** Every topic above the cut, best first. The first is `topicId` when the
   *  source is `live`. Used for "what else on your board is about this". */
  readonly related: readonly TopicMatch[];
}

export function resolveContext(
  filedTopicId: TopicId | null | undefined,
  matches: readonly TopicMatch[],
): LiveContext {
  if (filedTopicId) return { topicId: filedTopicId, source: 'filed', related: matches };
  const best = matches[0];
  if (!best) return { topicId: null, source: 'none', related: [] };
  return { topicId: best.topicId, source: 'live', related: matches };
}
