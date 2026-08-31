import type { Topic, Signal, SignalType, TopicId } from '../domain/types.js';
import { daysSince, reviewDue } from '../domain/board-areas.js';
import { dueWeight } from '../domain/commitments.js';
import type { Commitment } from '../domain/commitments.js';
import { NOT_NOW_DAYS, choiceWeight, notNowMark } from '../domain/signals.js';
import type { ComfortResult } from './registrar.js';

/**
 * GARDENER — decay, resurfacing, retirement, and what gets taught this run.
 *
 * SB-22: a learning board that rots is not neutral, it is guilt. This agent is
 * what makes the board living rather than a landfill, and it is the hardest
 * thing here for a copycat to replicate.
 *
 * Deliberately deterministic. Spacing intervals and decay are arithmetic; making
 * them a model call would buy nothing and cost predictability, explainability
 * and money on every nightly run.
 */

/**
 * The spacing rule moved to `domain/board-areas.ts` and is imported back.
 *
 * It stayed private here for as long as this agent was the only thing that
 * asked the question. The board asks it too now — a topic due for retrieval
 * practice is what "Recharging" means — and two copies of a spacing rule is a
 * rule that drifts from the one that actually fires.
 */
export { REVIEW_INTERVALS } from '../domain/board-areas.js';

/** SB-22: pinned but never engaged with. Offered for retirement, never silently
 *  dropped — the learner chose to pin it and that choice deserves a question. */
export const ABANDONED_AFTER_DAYS = 28;

export type Disposition =
  | 'teach'          // in the candidate pool
  | 'review'         // due for retrieval practice
  | 'resurface'      // regressed, needs bringing back (SB-36)
  | 'settled'        // absorbed; retire quietly
  | 'offer-retire'   // pinned and abandoned; ask before dropping (SB-22)
  | 'hold';          // nothing to do this run

export interface GardenDecision {
  readonly topicId: TopicId;
  readonly disposition: Disposition;
  readonly reason: string;
  /** Higher sorts earlier into the session. */
  readonly priority: number;
}

export interface GardenInput {
  readonly topics: readonly Topic[];
  readonly comforts: readonly ComfortResult[];
  readonly signals: readonly Signal[];
  readonly now: Date;
  /** Learner-owned IANA zone for deadline nearness. */
  readonly timeZone?: string;
  /**
   * What the learner is on the hook for (2026-08-23).
   *
   * **The capability the commitment ledger exists to unlock.** This agent
   * schedules by decay, which is right when nothing is at stake and wrong the
   * week before an assignment: a topic the learner is comfortable with and is
   * examined on in three days outranks one that has merely gone quiet.
   *
   * Optional, and absent means unchanged. A caller that knows nothing about
   * deadlines gets exactly the rankings it got before this existed.
   */
  readonly commitments?: readonly Commitment[];
}

/**
 * SB-62: the two marks that mean "come back to this", and what each one asks
 * the next session to be.
 *
 * Kept as a table rather than as two `if`s because the reason line is what the
 * story actually demands — *"the resurface must cite the mark when it fires, so
 * the learner sees the product kept the promise"* — and a reason written at the
 * call site is a reason that drifts from the mark it claims to quote.
 */
const RESURFACE_MARKS: Readonly<Partial<Record<SignalType, string>>> = {
  'resurface-refresher': 'you asked to come back to this as a refresher',
  'resurface-deeper': 'you asked to go deeper on this',
  /**
   * SB-61 — *"This run, the IAM topic is prioritised."*
   *
   * The still-shaky tap belongs here rather than in a mechanic of its own,
   * because it is the same statement SB-62's refresher mark makes, made at a
   * different moment: the learner has read something and told the product they
   * are not there yet. The register half of the story is the comfort model's
   * and needs nothing here; this is the priority half, and the reason line is
   * what keeps the promise visible when it fires.
   *
   * `quick-take-got-it` is deliberately absent. The nightly still decides what
   * to do with the topic — verify, deepen, or leave it — but treating "I have
   * this" as a request to bring it back would make the honest answer the one
   * that buys the learner more of the same material.
   */
  'quick-take-still-shaky': 'you said this one was still shaky when you read it',
};

/**
 * The most recent live mark the last lesson has not already answered.
 *
 * Marks made *before* the topic was last taught have had their answer: the
 * learner asked for it back, it came back, and leaving the mark standing would
 * put the same section in front of them every night until they stopped opening
 * the panel. Invalidated marks are skipped for the same reason every other read
 * of the ledger skips them — a withdrawn signal is not evidence of anything.
 */
function resurfaceAsk(
  topicId: TopicId, signals: readonly Signal[], lastExposed: string | null,
): GardenDecision | null {
  const since = lastExposed ? Date.parse(lastExposed) : -Infinity;
  const marks = signals
    .filter((s) => s.topicId === topicId && !s.invalidated && s.type in RESURFACE_MARKS)
    .filter((s) => Number.isFinite(Date.parse(s.at)) && Date.parse(s.at) > since)
    .sort((a, b) => a.at.localeCompare(b.at));
  const latest = marks[marks.length - 1];
  if (!latest) return null;
  return {
    topicId,
    disposition: 'resurface',
    reason: RESURFACE_MARKS[latest.type] as string,
    // A direct learner request outranks anything the product inferred. The
    // receipt no longer promises an impossible exact slot when several asks
    // compete for a short session, but an ask still belongs at the front of the
    // candidate queue. Above a regression (100) and every ordinary teach (80).
    priority: 110,
  };
}

export function tend(input: GardenInput): readonly GardenDecision[] {
  const { topics, comforts, signals, now } = input;
  const byId = new Map(comforts.map((c) => [c.topicId, c]));
  const commitments = input.commitments ?? [];

  /**
   * A deadline reorders the queue. It does not decide what is in it.
   *
   * Applied to the DERIVED priorities only, and never to the four decisions
   * above them: retired-by-you, the learner's own resurface mark, a regression,
   * and an abandoned pin are all statements — three by a person and one by the
   * ledger — and a date typed into a planner does not outrank any of them. What
   * it moves is the ordinary teaching pool, where the difference between two
   * candidates is arithmetic and a deadline is the better tie-breaker.
   *
   * Bounded at 1.6x by `dueWeight`, so the strongest thing a date can do is win
   * a close call. A typed date is not evidence, and the moment it could promote
   * anything on its own, the product would be teaching to a calendar somebody
   * filled in optimistically.
   *
   * The learner-controlled lineup contract adds the second weight, and it is the same argument in the
   * learner's own voice. A thumbs-up or thumbs-down on the LINEUP is a
   * preference about what was chosen, so it moves candidates within the pool
   * and never into or out of it, and `choiceWeight` clamps at 0.6x/1.4x for the
   * same reason `dueWeight` clamps at 1.6x: the strongest thing taste may do is
   * win a close call. It is applied here, beside the deadline, because these
   * are the two things in the product that reorder derived priorities and
   * neither is evidence about anybody's ability.
   */
  const weigh = (topicId: string, priority: number): number =>
    Math.round(priority
      * dueWeight(topicId, commitments, now, input.timeZone ?? 'UTC')
      * choiceWeight(topicId, signals, now));

  return topics.map((topic): GardenDecision => {
    const c = byId.get(topic.id);
    const idle = daysSince(topic.lastExposedAt ?? topic.createdAt, now);

    // The learner's own decision always wins over anything derived.
    if (topic.retiredByUser) {
      return { topicId: topic.id, disposition: 'hold', reason: 'retired by you', priority: 0 };
    }

    /**
     * The learner-controlled lineup contract — the X on the lineup, honoured for a week.
     *
     * Directly under retirement and above everything else, including a
     * regression, because it is the same KIND of thing as retirement: the
     * learner looked at this topic and said no. It differs in exactly one way,
     * and the reason line says so — it expires. `NOT_NOW_DAYS` is the whole of
     * the difference between "not tonight" and "not ever", and the panel is
     * told the same number so the promise and the ranker cannot disagree.
     *
     * Above the regression check deliberately. A slip the ledger noticed is the
     * most urgent thing this product can spot on its own, and it is still
     * something the product noticed rather than something the learner said. A
     * week is short enough that nothing is lost by waiting, and a topic that
     * came back the night after it was removed would make the X a control that
     * does nothing — which is worse than not offering it.
     */
    const removed = notNowMark(topic.id, signals, now);
    if (removed) {
      const back = Math.max(1, Math.ceil(NOT_NOW_DAYS - daysSince(removed.at, now)));
      return {
        topicId: topic.id, disposition: 'hold',
        reason: back === 1
          ? 'you took this out of a lineup, so it is back tomorrow'
          : `you took this out of a lineup, so it is back in ${back} days`,
        priority: 0,
      };
    }

    // SB-62: the learner's own request, above every machine-derived read. A
    // topic may also satisfy the regression arithmetic; checking the explicit
    // ask first preserves whose decision put it in the queue and lets the
    // lesson say so.
    const asked = resurfaceAsk(topic.id, signals, topic.lastExposedAt);
    if (asked) return asked;

    // SB-36: regression outranks every other derived decision. Losing
    // something you had is the most urgent thing this product can notice for
    // itself, but still sits below a learner explicitly asking for a return.
    if (c?.regressed) {
      return {
        topicId: topic.id, disposition: 'resurface',
        reason: 'you had this, and something recent suggests it has slipped',
        priority: 100,
      };
    }

    // SB-22: pinned once, never engaged, long silence. Ask — do not just delete.
    if ((c?.evidenceCount ?? 0) === 0 && idle >= ABANDONED_AFTER_DAYS) {
      return {
        topicId: topic.id, disposition: 'offer-retire',
        reason: `pinned ${Math.round(idle)} days ago and we have not been back`,
        priority: 5,
      };
    }

    // Absorbed: demonstrated, confident, quiet. Retire without ceremony.
    if ((c?.comfort ?? 0) >= 0.8 && (c?.certainty ?? 0) >= 0.6) {
      if (reviewDue(topic.id, signals, topic.lastExposedAt, now)) {
        return {
          topicId: topic.id, disposition: 'review',
          reason: 'due a quick check so it stays put', priority: weigh(topic.id, 40),
        };
      }
      return { topicId: topic.id, disposition: 'settled', reason: 'you have this', priority: 0 };
    }

    if (reviewDue(topic.id, signals, topic.lastExposedAt, now)) {
      return {
        topicId: topic.id, disposition: 'review', reason: 'due for a check',
        priority: weigh(topic.id, 60),
      };
    }

    // Everything else that has material behind it is teachable. Lower comfort
    // sorts earlier — the struggle is the point.
    const comfort = c?.comfort ?? 0.15;
    /**
     * A struggle is a claim, and it needs evidence to make it.
     *
     * `computeComfort` returns **0.15 with an evidence count of zero** for a
     * topic nothing has ever been recorded about — a cold default, not a
     * measurement. Read through the threshold below it said *"you have been
     * struggling with this"* on a board with no signals at all, which is a
     * statement about the learner assembled out of their having done nothing
     * yet, and it reached them: the sentence was on the Learn hero of a QA
     * board whose signal ledger is empty.
     *
     * SB-33's rule is that nothing infers more than the evidence carries, so
     * the two cases separate. With evidence, the number means what it has
     * always meant. Without it, the honest thing to say is that there is none.
     *
     * The PRIORITY is untouched: an unmet topic should still be taught early,
     * and that was never the part that was lying.
     */
    const measured = (c?.evidenceCount ?? 0) > 0;
    return {
      topicId: topic.id,
      disposition: topic.pinIds.length ? 'teach' : 'hold',
      reason: !measured ? 'nothing has been asked about this yet'
        : comfort < 0.4 ? 'you have been struggling with this' : 'in progress',
      priority: weigh(topic.id, 80 - comfort * 50),
    };
  });
}

/**
 * SB-23: honesty over filler. If there is genuinely not enough, say so and offer
 * revision instead of inventing a lesson to fill the slot. Manufacturing content
 * to look busy is the fastest way to lose a learner permanently.
 */
export interface Pool {
  readonly teach: readonly GardenDecision[];
  readonly offerRetire: readonly GardenDecision[];
  /**
   * SB-23: what the revision offer is built FROM — "a 5-minute refresh on two
   * things from last week".
   *
   * The story calls the fallback mandatory and calls it something that must be
   * *genuinely useful, not a consolation prize*, which means it cannot be the
   * teaching pool with a smaller number on it. It is material the learner has
   * already met: whatever is due a check or has slipped, and then what they have
   * absorbed and not seen for a while. Retired topics never appear — the
   * learner's own decision is honoured here as everywhere (SB-37).
   *
   * Computed on every run and used only when `fallback` says so, so that the
   * decision to offer revision and the material it would use cannot disagree.
   */
  readonly revise: readonly GardenDecision[];
  readonly enough: boolean;
  readonly fallback: 'revision' | null;
}

/** "Two things from last week" — the story's number, and the whole offer. */
export const REVISION_TOPICS = 2;

export function duePool(decisions: readonly GardenDecision[], minTopics = 2): Pool {
  const active = decisions
    .filter((d) => d.disposition === 'teach' || d.disposition === 'review' || d.disposition === 'resurface')
    .sort((a, b) => b.priority - a.priority);

  const reviewable = active.filter((d) => d.disposition !== 'teach');
  const enough = active.length >= minTopics;

  // Due first, then absorbed. `settled` is not in the active pool by design —
  // absorbed material is not owed a lesson — but it is exactly the right thing
  // to spend five minutes on when there is nothing new to teach.
  const revise = [...reviewable, ...decisions.filter((d) => d.disposition === 'settled')]
    .slice(0, REVISION_TOPICS);

  // Revision REPLACES nothing. It is offered when there is nothing new to
  // teach and something worth refreshing — a thin night with one genuinely new
  // topic still teaches that topic, because dropping the learner's new material
  // in favour of a refresh would be the same failure as padding, in the other
  // direction.
  const nothingNew = !active.some((d) => d.disposition === 'teach');

  return {
    teach: active,
    offerRetire: decisions.filter((d) => d.disposition === 'offer-retire'),
    revise,
    enough,
    fallback: !enough && nothingNew && revise.length ? 'revision' : null,
  };
}
