import type { DepthRegister, Session, Signal, Topic, TopicId } from '../domain/types.js';

/**
 * UX_SPEC §5a — the honest progression system, as types.
 *
 * Every shape here carries its own evidence, because that is the whole design:
 * a milestone is a ledger transition *worded as what produced it*, and a badge
 * is a fact with the evidence attached rather than confetti over a claim the
 * ledger cannot defend. A field called `points` would have nowhere to come
 * from, which is the intended property.
 *
 * What is deliberately absent, and must stay absent (SB-67): any count of
 * activity. No pins made, no sessions completed, no minutes spent, no global
 * anything. Volume badges pay for padding, which the Gardener exists to refuse.
 */

/** The four, and only these four. Named as a value so a test can hold the set. */
export const BADGE_KINDS = [
  'closure', 'regression-conquered', 'comeback', 'medium-follow-through',
] as const;

export type BadgeKind = (typeof BADGE_KINDS)[number];

interface AboutATopic {
  readonly topicId: TopicId;
  readonly topicLabel: string;
  /** When the ledger says it happened — never when it was rendered. */
  readonly at: string;
  /** One sentence, computed from the ledger. Never a template of praise. */
  readonly evidence: string;
}

/**
 * SB-65 — a comfort-ledger register transition, stated as a fact.
 *
 * Only advances. A slip is not a milestone, and dressing one up as "movement"
 * would be the first lie this system told.
 */
export interface Milestone extends AboutATopic {
  readonly kind: 'milestone';
  readonly from: DepthRegister;
  readonly to: DepthRegister;
  readonly demonstrations: number;
  readonly spanDays: number;
}

/**
 * SB-66 — a per-topic run of demonstrated recalls across expanding intervals.
 *
 * `length` is the displayed number and it only ever goes up or stands still.
 * There is no global chain and there is nothing here to sum: the type is about
 * one topic, and a caller that added two of these together would be inventing a
 * quantity the story bans.
 */
export interface Chain extends AboutATopic {
  readonly kind: 'chain';
  readonly length: number;
  /**
   *  - `active` — the run is inside its own rhythm.
   *  - `paused` — longer has passed than the chain's own spacing. Absence, not
   *    failure; the number stands.
   *  - `held`   — a miss landed after the last link. The number stands and the
   *    next recall is owed sooner. SB-66: no zero is ever displayed as a
   *    punishment, and a wrong answer must never cost more than the absence of
   *    a right one.
   */
  readonly state: 'active' | 'paused' | 'held';
  /** Days between the links, oldest first. The expansion, shown rather than claimed. */
  readonly intervals: readonly number[];
}

/** SB-67 — closure and courage, never volume. */
export interface Badge extends AboutATopic {
  readonly kind: 'badge';
  readonly badge: BadgeKind;
}

export type ProgressionEvent = Milestone | Chain | Badge;

/**
 * A rule that could not read its input, kept where the operator can see it.
 *
 * §3a's first defect class is the fail-open safety path: *a check that cannot
 * read its input decides everything is fine*. The progression equivalent is a
 * rule that cannot find its evidence and awards anyway, which would put a
 * congratulation the ledger cannot defend in front of a learner. So every rule
 * here fails closed — no award — and says so internally rather than silently.
 *
 * Never rendered to the learner. There is nothing here they could act on, and a
 * surface that explained its own near-misses would be manufacturing the
 * anticipation the whole design refuses.
 */
export interface SkippedRule {
  readonly rule: string;
  readonly topicId: TopicId | null;
  readonly why: string;
}

export interface ProgressionInput {
  readonly topics: readonly Topic[];
  readonly signals: readonly Signal[];
  /** Read for the medium warning only. Never for a count of them. */
  readonly sessions: readonly Session[];
  readonly now: Date;
}

export interface ProgressionProjection {
  /** Milestones and badges, newest first. Chains are not events until they are
   *  notable — see `stripFrom`. */
  readonly events: readonly ProgressionEvent[];
  /** Every live chain, per topic. For a topic surface, not for a total. */
  readonly chains: readonly Chain[];
  readonly skipped: readonly SkippedRule[];
}
