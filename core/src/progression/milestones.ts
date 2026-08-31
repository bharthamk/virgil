import type { Topic } from '../domain/types.js';
import { registerRank } from '../domain/registers.js';
import { daysBetween, spanPhrase, timesPhrase, type LedgerStep } from './ledger.js';
import type { Milestone, SkippedRule } from './types.js';

/**
 * SB-65 — "a milestone I actually earned".
 *
 * The comfort model is already a progression system: from-nothing → building →
 * fluent, earned by demonstrated behaviour. A milestone IS the transition,
 * worded as the evidence that produced it. Unfakeable by construction, and it
 * advertises the moat every time it fires.
 *
 * Two rules keep it honest, and both are refusals:
 *
 *  - **Advances only.** A drop is not a milestone. There is a badge for coming
 *    back from one (`regression-conquered`); there is no consolation prize for
 *    going down.
 *  - **No evidence, no milestone.** The sentence is "demonstrated N times
 *    across M" and it is computed, so a transition the ledger reached without a
 *    single demonstration behind it — possible, because comfort also moves on
 *    weaker signals — mints nothing and is recorded as skipped. Awarding it
 *    with the number left out would be the fail-open shape (§3a): the check
 *    could not read its input, so it decided everything was fine.
 */

export interface MilestoneOutcome {
  readonly milestones: readonly Milestone[];
  readonly skipped: readonly SkippedRule[];
}

export function milestonesFor(topic: Topic, history: readonly LedgerStep[]): MilestoneOutcome {
  const milestones: Milestone[] = [];
  const skipped: SkippedRule[] = [];

  for (let i = 1; i < history.length; i += 1) {
    const before = history[i - 1] as LedgerStep;
    const step = history[i] as LedgerStep;
    if (registerRank(step.register) <= registerRank(before.register)) continue;

    if (step.demonstrations === 0 || !step.firstDemonstrationAt) {
      skipped.push({
        rule: 'milestone',
        topicId: topic.id,
        why: `${before.register} → ${step.register} with nothing demonstrated behind it`,
      });
      continue;
    }

    const spanDays = daysBetween(step.firstDemonstrationAt, step.at);
    milestones.push({
      kind: 'milestone',
      topicId: topic.id,
      topicLabel: topic.label,
      at: step.at,
      from: before.register,
      to: step.register,
      demonstrations: step.demonstrations,
      spanDays,
      // The spec's sentence, with both numbers read off the ledger. The
      // registers are said in the learner's own screen vocabulary — the panel
      // renders `from-nothing` as "new to you" (SB-283) — so the two surfaces
      // cannot describe the same transition in two different languages.
      evidence: `Demonstrated ${timesPhrase(step.demonstrations)} across ${spanPhrase(spanDays)}.`,
    });
  }

  return { milestones, skipped };
}
