import type { Signal, Topic, TopicId } from './types.js';
import { reviewDue } from './board-areas.js';

/**
 * QUICK BURST — five minutes, and something to show for it.
 *
 * A quick burst is a five-minute slice of existing review work.
 *
 * ## Why this is almost entirely already built
 *
 * The Gardener has known what is due for retrieval practice since it was
 * written. What was missing was a way in that does not ask for a session: the
 * product's smallest unit of work was eleven minutes of reading, and for the
 * relevant barrier is not motivation, it is the size of the
 * entry. A burst is a slice of the queue that already exists.
 *
 * ## What a burst is allowed to be
 *
 * Recall prompts, and nothing else. It is deliberately NOT a feed, not a
 * discovery surface, and not new teaching — it asks about things the learner
 * has already met, which is the only thing that can honestly be done in five
 * minutes and the only thing that produces a signal worth having.
 *
 * The answers ARE evidence and do reach the signal ledger, unlike anything in
 * the commitment ledger: *"can you still explain this"* is the same question a
 * session's recall check asks, and the learner answering it is the highest
 * grade of signal this product collects. Finishing adds no participation
 * award. The signal is the useful outcome, and an honest failure to recall must
 * never become a points-earning event merely because the learner reached the
 * end of the room.
 *
 * ## The ordering, and why it is not "hardest first"
 *
 * Due-for-review first, then the topics the learner themselves flagged, then
 * whatever is coldest. Hardest-first is the obvious ordering and the wrong one:
 * five minutes that open with the thing you are worst at is five minutes nobody
 * starts. Spaced review already knows what is worth asking today.
 */

export type BurstReason =
  /** The spacing interval says today. */
  | 'due'
  /** The learner marked it still shaky or asked for it back. */
  | 'flagged'
  /** Nothing is due; this is the one that has gone quietest. */
  | 'coldest';

export interface BurstItem {
  readonly topicId: TopicId;
  readonly label: string;
  readonly reason: BurstReason;
  /** The retrieval action itself. A topic name plus two confidence buttons is
   *  self-report, not recall. Kept deterministic so reloading never swaps the
   *  question under somebody mid-burst. */
  readonly prompt: string;
}

/** A burst is this long. Not configurable — the whole point is that it is small. */
export const BURST_MINUTES = 5;
/** Roughly a prompt a minute, with time to think. Three is a burst; ten is a session. */
export const BURST_ITEMS = 3;
/** “Sooner” is not “again on the screen you just returned to.” */
export const BURST_COOLDOWN_MS = 6 * 60 * 60 * 1_000;

const flaggedTypes = new Set([
  'quick-take-still-shaky', 'resurface-refresher', 'resurface-deeper', 'pin-struggle',
]);

export const burstPrompt = (label: string): string =>
  `Without opening your sources, explain ${label} in your own words. What is the most important idea you remember?`;

/**
 * What to ask about, in the order to ask it.
 *
 * Pure, and handed everything it reads, so the same board produces the same
 * burst twice — which matters more than it looks: a burst that reshuffled on
 * every render would make a learner who reloaded feel they had lost their place.
 */
export function planBurst(
  topics: readonly Topic[],
  signals: readonly Signal[],
  now: Date,
  limit = BURST_ITEMS,
): readonly BurstItem[] {
  const live = topics.filter((t) => !t.retiredByUser);
  if (!live.length) return [];

  const lastFlagAt = new Map<TopicId, string>();
  const justRecalled = new Set<TopicId>();
  for (const s of signals) {
    if (!s.invalidated && s.sourceEvent === 'burst') {
      const age = now.getTime() - Date.parse(s.at);
      if (Number.isFinite(age) && age >= 0 && age < BURST_COOLDOWN_MS) justRecalled.add(s.topicId);
    }
    if (s.invalidated || !flaggedTypes.has(s.type)) continue;
    const seen = lastFlagAt.get(s.topicId);
    if (!seen || s.at > seen) lastFlagAt.set(s.topicId, s.at);
  }

  const due: BurstItem[] = [];
  const flagged: BurstItem[] = [];
  const cold: { item: BurstItem; at: string }[] = [];

  for (const t of live) {
    if (justRecalled.has(t.id)) continue;
    if (reviewDue(t.id, signals, t.lastExposedAt, now)) {
      due.push({ topicId: t.id, label: t.label, reason: 'due', prompt: burstPrompt(t.label) });
    } else if (lastFlagAt.has(t.id)) {
      flagged.push({ topicId: t.id, label: t.label, reason: 'flagged', prompt: burstPrompt(t.label) });
    } else {
      cold.push({
        item: { topicId: t.id, label: t.label, reason: 'coldest', prompt: burstPrompt(t.label) },
        at: t.lastExposedAt ?? t.createdAt,
      });
    }
  }

  // Oldest contact first among the cold ones, and stable on label so two topics
  // last seen at the same moment do not swap places between renders.
  cold.sort((a, b) => (a.at === b.at ? a.item.label.localeCompare(b.item.label) : a.at < b.at ? -1 : 1));

  return [...due, ...flagged, ...cold.map((c) => c.item)].slice(0, limit);
}

/**
 * What a burst answer means to the ledger.
 *
 * The same two verdicts a session's recall check uses, and deliberately the
 * same signal type: an answer given in five minutes is not weaker evidence than
 * the same answer given in eleven, and giving it its own type would let the
 * Registrar weigh the two differently by accident.
 */
export const burstSignalFor = (verdict: 'got-it' | 'not-really'): {
  type: 'recall-check'; direction: 'positive' | 'negative';
} => ({ type: 'recall-check', direction: verdict === 'got-it' ? 'positive' : 'negative' });
