import type { Session, Signal, SignalType, Topic } from '../domain/types.js';
import { registerRank } from '../domain/registers.js';
import { isDemonstration, type LedgerStep } from './ledger.js';
import type { Badge, BadgeKind, SkippedRule } from './types.js';

/**
 *  — closure and courage, never volume.
 *
 * Four badges, and the ban is as load-bearing as the four: pins made, sessions
 * completed, minutes spent, or any other count of activity, are out by name.
 * Volume badges pay for padding, which is the exact behaviour the Gardener
 * exists to refuse — so there is no counter in this file that could be turned
 * into one, and the fixtures prove it: a learner with fifty finished sections
 * and nothing demonstrated earns nothing at all.
 *
 * Each badge is a fact with its evidence attached, in the milestone voice.
 * Awarded once per topic per kind, at the moment the ledger can first defend
 * it, and never at all when the evidence is missing.
 */

/**
 * The marks that mean "I said I was shaky on this", for the comeback rule.
 *
 * Three sources: the still-shaky tap on a quick take , the resurface
 * refresher  — the learner asking for a topic back at a lower level —
 * and a regression the model detected, which is the product noticing the same
 * thing the learner would have said.
 *
 * The still-shaky tap is the one  walkthrough actually opens on
 * (a shaky quick-take answer followed by a later demonstration). It was named
 * here as a dormant string for as long as the
 * quick take was unbuilt, with a test standing over the gap; the quick take has
 * shipped, so it is a `SignalType` like the rest and the test asserts the
 * wiring instead of the gap.
 *
 * Two exclusions, and they are the same exclusion twice. `resurface-deeper` is
 * the learner saying the level was *below* them, and `quick-take-got-it` is the
 * learner saying they have it. Counting either as an admission of weakness
 * would award the comeback for the opposite of what they said.
 */
export const SHAKY_MARK_TYPES: readonly SignalType[] = [
  'quick-take-still-shaky', 'guide-stuck', 'resurface-refresher',
];

export interface BadgeOutcome {
  readonly badges: readonly Badge[];
  readonly skipped: readonly SkippedRule[];
}

/** The arithmetic threshold before the repeated-demonstration boundary. Kept
 *  separately so a near-miss remains visible in `skipped` rather than silently
 *  disappearing when the stronger settlement rule refuses it. */
const comfortHeld = (step: LedgerStep): boolean =>
  step.comfort.comfort >= 0.8
  && step.comfort.certainty >= 0.6
  && !step.comfort.regressed;

/** The Registrar's own settled rule, read rather than re-decided: comfort held
 *  across repeated demonstrated evidence, with nothing recent undercutting it. */
const isSettled = (step: LedgerStep): boolean =>
  comfortHeld(step) && step.comfort.demonstrationCount >= 2;

export function badgesFor(
  topic: Topic,
  history: readonly LedgerStep[],
  signals: readonly Signal[],
  sessions: readonly Session[],
): BadgeOutcome {
  const badges: Badge[] = [];
  const skipped: SkippedRule[] = [];

  const award = (badge: BadgeKind, at: string, evidence: string): void => {
    if (badges.some((b) => b.badge === badge)) return;  // once per topic, ever
    badges.push({ kind: 'badge', badge, topicId: topic.id, topicLabel: topic.label, at, evidence });
  };

  if (!history.length) {
    return { badges, skipped };
  }

  // ------------------------------------------------------------- closure
  /**
   * "A topic retired as learned" — the comfort threshold, real completion.
   *
   * Not `retiredByUser`. That is the learner deciding they are done with
   * something, which is their right  and is not the same as having
   * learned it. Awarding closure for it would be the product congratulating
   * someone for giving up, and it is the one place this rule could have been
   * written to fire more often.
   */
  const closed = history.find((s) => isSettled(s) && s.demonstrations >= 2);
  if (closed && !topic.retiredByUser) {
    award('closure', closed.at,
      `Closed out: recalled ${closed.demonstrations} time${closed.demonstrations === 1 ? '' : 's'}, and it held.`);
  } else if (closed && topic.retiredByUser) {
    skipped.push({ rule: 'closure', topicId: topic.id, why: 'retired by the learner, which is not the same as learned' });
  } else if (history.some(comfortHeld)) {
    /**
     * Found red-first, and it is the shape §3a warns about twice over.
     *
     * Comfort settles on *any* run of positive signals, and the weakest ones —
     * `section-completed`, `pin-interest` — are attendance and attention. A
     * learner who turned up sixty times and demonstrated nothing reached the
     * threshold, and closure was awarded reading "recalled 0 times, and it
     * held": a volume badge, minted by the rule that exists to refuse volume,
     * wearing a sentence the ledger could not defend.
     *
     * Closure is *learned*, so it costs at least one demonstration. No award,
     * and the near-miss kept where an operator can see it.
     */
    const demonstrations = Math.max(...history.map((step) => step.demonstrations));
    skipped.push({
      rule: 'closure',
      topicId: topic.id,
      why: demonstrations === 0
        ? 'comfort settled with nothing ever demonstrated'
        : 'comfort held behind only one demonstration; repeated evidence is required',
    });
  }

  // --------------------------------------------- the two recovery badges
  /**
   * A slip, and what came after it.
   *
   * `regression-conquered` is getting back to where you were. `comeback` is
   * getting *past* where you were when you admitted you were lost. They are
   * written together because the difference between them is one comparison,
   * and separating them into two passes is how they would start disagreeing
   * about which step counts as the recovery.
   */
  const flags = shakyFlags(topic, history, signals);

  for (const flag of flags) {
    const after = history.filter((s) => s.at.localeCompare(flag.at) > 0);

    const past = after.find((s) => registerRank(s.register) > flag.rank && isDemonstration(s.signal));
    if (past) {
      award('comeback', past.at,
        `You called this shaky, kept at it, and came back past where you were.`);
    }

    if (flag.kind !== 'regression') continue;
    // Re-earned, not merely recovered. Comfort climbs back on its own as a bad
    // answer ages out of the recency window, and "you have earned it back" for
    // a topic nobody has touched since the slip is the same manufactured
    // confidence the closure rule above had to be stopped from producing.
    const back = after.find((s) =>
      !s.comfort.regressed && registerRank(s.register) >= flag.rank
      && after.some((d) => isDemonstration(d.signal) && d.at.localeCompare(s.at) <= 0));
    if (!back) {
      skipped.push({ rule: 'regression-conquered', topicId: topic.id, why: 'the slip has not been re-earned yet' });
      continue;
    }
    // Precedence, stated once. A recovery that overshot in a single step is one
    // event, and the courage badge is the one  exists for; showing both
    // would be the same fact celebrated twice, which is the confetti the product contract
    // rules out.
    if (past && past.at === back.at) {
      skipped.push({ rule: 'regression-conquered', topicId: topic.id, why: 'the same step is already the comeback' });
      continue;
    }
    award('regression-conquered', back.at, 'You had lost this and you have earned it back.');
  }

  // -------------------------------------------- medium follow-through
  /**
   * "Acted on a medium warning and later demonstrated the skill the reading
   * could not build" — the badge nobody else can ship.
   *
   * The warning is the Composer's, on a section of a session that was built on
   * some earlier night; the follow-through is a demonstration on that topic
   * afterwards. Completing the section is explicitly not enough — reading the
   * warning is not acting on it, and a badge for finishing a section would be
   * the volume badge this file exists to refuse, in disguise.
   */
  const warnedAt = sessions
    .filter((s) => s.sections.some((sec) => sec.topicId === topic.id && (sec.mediumWarning ?? '').trim()))
    .map((s) => s.builtAt)
    .filter((at) => Number.isFinite(Date.parse(at)))
    .sort((a, b) => a.localeCompare(b))[0];

  if (warnedAt) {
    const proof = history.find((s) => isDemonstration(s.signal) && s.at.localeCompare(warnedAt) > 0);
    if (proof) {
      award('medium-follow-through', proof.at,
        'Reading was never going to close this one. Practising it changed what Virgil can know.');
    } else {
      skipped.push({ rule: 'medium-follow-through', topicId: topic.id, why: 'warned, nothing demonstrated since' });
    }
  }

  return { badges, skipped };
}

interface ShakyFlag {
  readonly at: string;
  /** The register held when the flag went up — what "past where you were" means. */
  readonly rank: number;
  readonly kind: 'mark' | 'regression';
}

/**
 * Every moment this topic was flagged as shaky: the marks the learner made
 * (`SHAKY_MARK_TYPES`), and the slips the model noticed.
 *
 * A regression counts from the first step that reports it, not from every step
 * that keeps reporting it — a slip is one event, and treating each subsequent
 * signal as a fresh flag would award a comeback for the same recovery as many
 * times as the ledger happened to be written to.
 */
function shakyFlags(
  topic: Topic, history: readonly LedgerStep[], signals: readonly Signal[],
): readonly ShakyFlag[] {
  const flags: ShakyFlag[] = [];

  const rankAt = (at: string): number => {
    const before = history.filter((s) => s.at.localeCompare(at) <= 0);
    const step = before[before.length - 1];
    return step ? registerRank(step.register) : registerRank('from-nothing');
  };

  for (const s of signals) {
    if (s.topicId !== topic.id || s.invalidated) continue;
    if (!SHAKY_MARK_TYPES.includes(s.type)) continue;
    if (!Number.isFinite(Date.parse(s.at))) continue;
    flags.push({ at: s.at, rank: rankAt(s.at), kind: 'mark' });
  }

  let wasRegressed = false;
  for (const step of history) {
    if (step.comfort.regressed && !wasRegressed) {
      // The register held *before* the slip is what has to be re-earned, so the
      // flag is dated at the slip and ranked at the step in front of it.
      const i = history.indexOf(step);
      const previous = history[i - 1];
      flags.push({ at: step.at, rank: registerRank((previous ?? step).register), kind: 'regression' });
    }
    wasRegressed = step.comfort.regressed;
  }

  return flags.sort((a, b) => a.at.localeCompare(b.at));
}
