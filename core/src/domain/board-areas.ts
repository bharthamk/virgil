import type { Signal, Topic, TopicId } from './types.js';

/**
 * The five places a topic can be on the board.
 *
 * Get Started / Currently Learning / Recharging / Paused / Learnt.
 *
 * They are NOT `TopicState`, and that separation is the point of this file.
 * `TopicState` is what the Registrar computes for the agents — three values,
 * read by the Gardener when it decides what to teach and by the Composer when
 * it picks a register. The board is what a person sees, and two of the five
 * areas here are facts the three states were hiding:
 *
 *  - **Paused** was being reported as *settled*. `applyComfort` maps
 *    `retiredByUser` straight to `'settled'`, so a topic the learner had put
 *    down sat on the board under a heading claiming they had learnt it. That is
 *    not a rename, it is a correction: the product was telling somebody they
 *    knew something because they had stopped asking about it.
 *  - **Recharging** was not being reported at all. Spaced review has been in
 *    the Gardener since it was written, but `state` cannot carry it — a topic
 *    due for retrieval practice is still `settled` — so the one thing on this
 *    board that says *come back to this on purpose* was invisible on it.
 *
 * The review rule itself lives here now rather than privately in
 * `gardener.ts`, because two surfaces answer the same question and a second
 * copy of a spacing rule is a rule that drifts from the one that fires.
 */
export type BoardArea =
  /** Filed, and nothing has happened on it yet. Where the raw pins land too. */
  | 'get-started'
  /** Evidence exists and it is not solid yet. */
  | 'learning'
  /** Learnt, and due for retrieval practice again. */
  | 'recharging'
  /** The learner retired it. Theirs to un-retire; never quietly dropped. */
  | 'paused'
  /** Comfortable, certain, and not due back. */
  | 'learnt';

const DAY_MS = 86_400_000;

/** Expanding intervals, in days. Standard spaced retrieval, nothing exotic. */
export const REVIEW_INTERVALS = [1, 3, 7, 16, 35, 70] as const;

export function daysSince(iso: string | null, now: Date): number {
  if (!iso) return Infinity;
  return (now.getTime() - Date.parse(iso)) / DAY_MS;
}

/** Which review interval a topic has earned, from how many times it has been
 *  successfully recalled. Failure moves it back down, it does not reset to zero. */
export function reviewDue(
  topicId: TopicId,
  signals: readonly Signal[],
  lastExposed: string | null,
  now: Date,
): boolean {
  // You cannot review something you have never been taught. Without this, a
  // never-exposed topic has daysSince() === Infinity and reads as maximally
  // overdue — which demoted the learner's worst topic to a "quick check" and
  // sorted it below a topic with no evidence at all.
  if (!lastExposed) return false;

  const graded = signals
    .filter((s) => s.topicId === topicId && !s.invalidated
      && (s.type === 'answer-correct' || s.type === 'answer-wrong' || s.type === 'recall-check'))
    .sort((a, b) => a.at.localeCompare(b.at));
  if (!graded.length) return false;

  let step = 0;
  for (const s of graded) {
    if (s.direction === 'positive') step = Math.min(step + 1, REVIEW_INTERVALS.length - 1);
    else step = Math.max(0, step - 1);
  }
  const interval = REVIEW_INTERVALS[step] ?? 1;
  return daysSince(lastExposed, now) >= interval;
}

/**
 * Which area a topic belongs in, in the order the board reads.
 *
 * Ordered so the earlier answer wins where two could be true, and every one of
 * those orderings is a decision:
 *
 *  - **Retired beats everything.** A learner who put a topic down has said
 *    something about it that no amount of computed comfort outranks. It is also
 *    the only branch here that is a person's own instruction rather than an
 *    inference, and those are never overridden by an inference.
 *  - **Recharging beats Learnt**, because a topic that is due back is not
 *    finished, and "Learnt" is the one heading on this board that could be read
 *    as a promise.
 *  - **Get Started is untouched `waiting`**. A quick-take answer is real
 *    engagement but not demonstrated competence: it moves a waiting topic to
 *    Currently Learning on the human board without pretending the Registrar
 *    has settled it. An invalidated answer cannot keep making that claim.
 */
export function boardAreaFor(topic: Topic, signals: readonly Signal[], now: Date): BoardArea {
  if (topic.retiredByUser) return 'paused';
  if (topic.state === 'settled') {
    return reviewDue(topic.id, signals, topic.lastExposedAt, now) ? 'recharging' : 'learnt';
  }
  if (topic.state === 'waiting') {
    const answeredTake = signals.some((signal) =>
      signal.topicId === topic.id && !signal.invalidated
      && (signal.type === 'quick-take-got-it' || signal.type === 'quick-take-still-shaky'));
    return answeredTake ? 'learning' : 'get-started';
  }
  return 'learning';
}
