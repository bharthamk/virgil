import type {
  ModalityDenial, ModalityKind, Signal, SignalId, SignalType, Statement, Topic, TopicId,
} from './types.js';

/**
 * WHAT KIND OF DEMAND THIS LEARNER FINDS HARD, ASKED RATHER THAN DECIDED.
 *
 * PRODUCT_SHAPE.md puts learning-style and modality profiling in the third
 * tier: *not built, not claimed*, and if it ever exists it enters "as a
 * learner-confirmed statement with its evidence shown, never as a hidden
 * profile". This module is that entrance, and every rule in it is one half of
 * that sentence made structural.
 *
 * ## The three separations this file exists to hold
 *
 *  1. **Numbers here, kinds from the model, and they never blur.** Everything
 *     below is arithmetic over marks the ledger already holds. The model's only
 *     job is to say which of four fixed kinds a topic's material is, from its
 *     label, and `admitModalityKinds` throws away anything outside that
 *     vocabulary rather than repairing it. The model never sees a number, never
 *     picks a contrast, and never writes a sentence about a person.
 *
 *  2. **A floor before anything is said at all.** Three checked outcomes in
 *     each of two kinds, and a contrast wide enough that one check going the
 *     other way could not have created it. Below that there is nothing to say
 *     and the product says nothing, which is the same discipline the slipping
 *     block keeps by drawing no praise line on a quiet board.
 *
 *  3. **It is a question until a person answers it.** What this module builds
 *     is a sentence ending in a question mark, with its numbers in it. It is
 *     not a profile, it is not read as authority by anything that teaches
 *     (`sessionLearnerContext` excludes it until it is confirmed), and a denial
 *     is stored where the preferences door cannot reach it.
 *
 * ## What this slice deliberately does not do
 *
 * Nothing here changes what gets taught. A confirmed modality statement is a
 * confirmed statement and nothing else: it does not weight the ranker, it does
 * not shape composition, and it does not filter material. Surfacing only. A
 * later slice that wants selection out of this has to argue for it on its own
 * evidence rather than inherit it silently from this one.
 *
 * Pure, like the rest of `domain/`. Board in, data out.
 */

// ------------------------------------------------------------- the vocabulary

/**
 * The four kinds, and the fact that there are exactly four is the point.
 *
 * A model asked to describe how somebody learns will produce an endless supply
 * of plausible categories, and every one of them would arrive on a screen as a
 * claim about a person that no code could check. So the vocabulary is fixed
 * here, small enough that each kind names a real difference in what material
 * demands, and anything outside it is dropped by `admitModalityKinds`.
 *
 * They describe MATERIAL, not people. "Notation heavy" is a property of a page
 * of formulas. It is not a diagnosis, it is not a learning style, and the
 * sentence built from it is about what the checks did rather than about what
 * the learner is.
 */
export const MODALITY_KINDS: readonly ModalityKind[] = [
  'notation-heavy', 'language-recall', 'logic-structure', 'hands-on',
];

/** What each kind is, for the model. One line, no examples from this board. */
export const MODALITY_KIND_MEANINGS: Readonly<Record<ModalityKind, string>> = {
  'notation-heavy': 'symbols and syntax carry the meaning: mathematical notation, dense code, formal proofs',
  'language-recall': 'holding vocabulary, terms or phrases in memory: a foreign language, a taxonomy, named laws',
  'logic-structure': 'following or building an argument, a system or a shape rather than recalling items',
  'hands-on': 'doing the thing: building, configuring, operating, practising a procedure',
};

/** What each kind is called in front of the learner. Plain, and never a label
 *  applied to them: it names the material they were checked on. */
export const MODALITY_KIND_WORDS: Readonly<Record<ModalityKind, string>> = {
  'notation-heavy': 'notation heavy material',
  'language-recall': 'vocabulary and recall work',
  'logic-structure': 'logic and structure work',
  'hands-on': 'hands on practice',
};

const KIND_SET: ReadonlySet<string> = new Set<string>(MODALITY_KINDS);

/** Whether a string the model produced is one of the four kinds on offer. */
export const isModalityKind = (value: unknown): value is ModalityKind =>
  typeof value === 'string' && KIND_SET.has(value);

// ---------------------------------------------------------------- the floor

/**
 * How many checked outcomes a kind needs before it may appear in a contrast.
 *
 * Three, per side. Two is a coin, and a claim about how somebody learns built
 * on two results is exactly the silent profile this whole module exists to
 * refuse.
 */
export const MODALITY_MIN_EVIDENCE = 3;

/**
 * How far apart the two rates have to be, and why this number.
 *
 * Reasoned rather than measured, in the house's own tradition. At the evidence
 * floor a kind can only score 0, 1 of 3, 2 of 3 or 3 of 3, so the differences
 * available are 0, 0.33, 0.67 and 1. A threshold of 0.4 means that at the floor
 * it takes two checks of difference rather than one: a single result going the
 * other way can neither create this claim nor destroy it. That is the property
 * worth buying, because the claim is about a person and it is going to be read
 * out to them.
 */
export const MODALITY_MIN_CONTRAST = 0.4;

/**
 * How far back the checks are read.
 *
 * The sentence says *recently*, so the arithmetic has to mean it. Ninety days
 * is a term: long enough that a board with a few checks a week clears the
 * floor, short enough that the claim is about how the learner is working now
 * rather than about a semester they have finished.
 */
export const MODALITY_WINDOW_DAYS = 90;

/** How long a no lasts. A month, and the learner is told the number. */
export const MODALITY_DENIED_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * The marks that carry a verdict somebody else reached.
 *
 * Deliberately narrower than `SIGNAL_WEIGHT`'s key set, and narrower than the
 * comfort model's. What is counted here is checking: an answer marked, a recall
 * check completed, real marking recorded, a check on the learner's own writing.
 *
 * The two quick-take taps are excluded on purpose even though they are evidence
 * elsewhere. They are the learner's own read of their own reading, and a
 * sentence that told somebody "notation heavy material goes badly for you"
 * partly because they said so is circular. Declared comfort does not get to
 * write the claim it would then be asked to confirm.
 */
export const MODALITY_ASSESSED_TYPES: readonly SignalType[] = [
  'answer-correct', 'answer-wrong', 'recall-check',
  'assessed-strong', 'assessed-gap', 'qc-finding',
];

const ASSESSED_SET: ReadonlySet<string> = new Set<string>(MODALITY_ASSESSED_TYPES);

// -------------------------------------------------------------- the counting

/** One topic's checked outcomes inside the window. Nothing about kinds yet. */
export interface ModalityTopicTally {
  readonly topicId: TopicId;
  readonly label: string;
  /** Checked outcomes with a verdict either way. Neutral marks are not counted. */
  readonly checked: number;
  readonly wentWell: number;
  /** The exact marks counted, so a statement built from this can be contested. */
  readonly signalIds: readonly SignalId[];
}

/**
 * Every topic with a checked outcome in the window, in a fixed order.
 *
 * Sorted by topic id rather than by count: the order reaches the model as the
 * order of the list it classifies, and two runs over an unchanged board must
 * ask the same question in the same order or the classification is not
 * reproducible.
 */
export function modalityTallies(
  topics: readonly Topic[], signals: readonly Signal[], now: Date,
): readonly ModalityTopicTally[] {
  const since = now.getTime() - MODALITY_WINDOW_DAYS * DAY_MS;
  const live = signals.filter((signal) => {
    if (signal.invalidated || !ASSESSED_SET.has(signal.type)) return false;
    if (signal.direction === 'neutral') return false;
    const at = Date.parse(signal.at);
    return Number.isFinite(at) && at >= since && at <= now.getTime();
  });
  const out: ModalityTopicTally[] = [];
  for (const topic of topics) {
    if (topic.retiredByUser) continue;
    const marks = live.filter((signal) => signal.topicId === topic.id);
    if (!marks.length) continue;
    out.push({
      topicId: topic.id,
      label: topic.label,
      checked: marks.length,
      wentWell: marks.filter((signal) => signal.direction === 'positive').length,
      signalIds: marks.map((signal) => signal.id),
    });
  }
  return out.sort((a, b) => (a.topicId < b.topicId ? -1 : a.topicId > b.topicId ? 1 : 0));
}

/**
 * Whether it is worth paying a model call to find out what these topics are.
 *
 * A necessary condition, checked before the call rather than after it. A
 * contrast needs `MODALITY_MIN_EVIDENCE` on each of two kinds, so a board with
 * fewer checked outcomes than twice that, or with them all on one topic, cannot
 * produce one however the classification comes back. Nothing is sent to be told
 * that.
 */
export function modalityWorthAsking(tallies: readonly ModalityTopicTally[]): boolean {
  if (tallies.length < 2) return false;
  const total = tallies.reduce((sum, tally) => sum + tally.checked, 0);
  return total >= MODALITY_MIN_EVIDENCE * 2;
}

// ----------------------------------------------------------- the vocabulary gate

/** One row as the model offers it: a key this code gave it, and a kind. */
export interface ModalityKindClaim {
  /** The offered key, already resolved by the caller, or null when it was not. */
  readonly key: string | null;
  readonly kind: unknown;
}

export interface ModalityKindAdmission {
  /** Offered key to kind, for the claims that survived. */
  readonly kinds: ReadonlyMap<string, ModalityKind>;
  /** A kind that is not one of the four. The rule this module exists under. */
  readonly invented: number;
  /** A key that was never offered, or one offered twice. */
  readonly unknown: number;
  readonly duplicate: number;
}

/**
 * The refusal, in code, over a fixed vocabulary.
 *
 * Same shape and same reason as `admitProspectProposals`: the model is handed a
 * closed list and anything outside it is dropped rather than mapped to the
 * nearest thing. A fifth kind invented in a reply would become a fifth kind on
 * a screen about how somebody learns, and no test anywhere would have seen it.
 */
export function admitModalityKinds(
  claims: readonly ModalityKindClaim[],
  offered: readonly string[],
): ModalityKindAdmission {
  const available = new Set(offered);
  const kinds = new Map<string, ModalityKind>();
  let invented = 0;
  let unknown = 0;
  let duplicate = 0;
  for (const claim of claims) {
    if (!claim.key || !available.has(claim.key)) { unknown += 1; continue; }
    if (!isModalityKind(claim.kind)) { invented += 1; continue; }
    if (kinds.has(claim.key)) { duplicate += 1; continue; }
    kinds.set(claim.key, claim.kind);
  }
  return { kinds, invented, unknown, duplicate };
}

// ------------------------------------------------------------- the contrast

/** One kind's totals, once the topics under it have been added up. */
export interface ModalityKindTally {
  readonly kind: ModalityKind;
  readonly checked: number;
  readonly wentWell: number;
  /** `wentWell / checked`. Exposed for audit and for the tests, never shown. */
  readonly rate: number;
  readonly signalIds: readonly SignalId[];
}

/** The per-kind totals, in vocabulary order, for the kinds that have any. */
export function modalityKindTallies(
  tallies: readonly ModalityTopicTally[],
  kinds: ReadonlyMap<TopicId, ModalityKind>,
): readonly ModalityKindTally[] {
  const out: ModalityKindTally[] = [];
  for (const kind of MODALITY_KINDS) {
    const members = tallies.filter((tally) => kinds.get(tally.topicId) === kind);
    if (!members.length) continue;
    const checked = members.reduce((sum, tally) => sum + tally.checked, 0);
    const wentWell = members.reduce((sum, tally) => sum + tally.wentWell, 0);
    out.push({
      kind,
      checked,
      wentWell,
      rate: checked > 0 ? wentWell / checked : 0,
      signalIds: members.flatMap((tally) => tally.signalIds),
    });
  }
  return out;
}

/** The question, once the floor has been cleared. Never a claim, never stored
 *  as one until somebody has said yes to it. */
export interface ModalityCandidate {
  /** `slower|faster`. Ours, stable, and what a denial is recorded against. */
  readonly key: string;
  readonly slower: ModalityKind;
  readonly faster: ModalityKind;
  readonly text: string;
  /** Every mark the two counts were built from, so the read can be contested. */
  readonly evidenceSignalIds: readonly SignalId[];
}

/**
 * The sentence, with its numbers in it and a question mark on the end.
 *
 * Both kinds are named in full on both sides rather than shortened to "there"
 * or "the other", because the learner is being asked to agree or disagree with
 * a comparison and a pronoun would make them work out which half is which.
 *
 * No score, no percentage, no band, no grade. Two counts out of two totals,
 * which is the same thing the slipping block does and for the same reason: a
 * number somebody can check by looking is not a judgement about them.
 */
export function modalityStatementText(
  slower: ModalityKindTally, faster: ModalityKindTally,
): string {
  const slowerWords = MODALITY_KIND_WORDS[slower.kind];
  const fasterWords = MODALITY_KIND_WORDS[faster.kind];
  return `Recent checks suggest ${slowerWords} goes less smoothly for you than ${fasterWords}: `
    + `${slower.wentWell} of ${slower.checked} checks went well on ${slowerWords}, `
    + `against ${faster.wentWell} of ${faster.checked} on ${fasterWords}. `
    + 'Does that match how it feels?';
}

/**
 * The one contrast worth asking about, or nothing.
 *
 * Every pair of kinds that clears the floor is considered and the widest gap
 * wins, with ties broken by the pair carrying more evidence and then by
 * vocabulary order, so an unchanged board asks an unchanged question. One
 * candidate leaves this function however many pairs qualify: a screen offering
 * a person two theories about how they learn is a screen that has stopped
 * asking and started profiling.
 */
export function modalityCandidate(
  tallies: readonly ModalityTopicTally[],
  kinds: ReadonlyMap<TopicId, ModalityKind>,
): ModalityCandidate | null {
  const byKind = modalityKindTallies(tallies, kinds)
    .filter((tally) => tally.checked >= MODALITY_MIN_EVIDENCE);
  let best: ModalityCandidate | null = null;
  let bestGap = 0;
  let bestEvidence = 0;
  for (const slower of byKind) {
    for (const faster of byKind) {
      if (slower.kind === faster.kind) continue;
      const gap = faster.rate - slower.rate;
      if (gap < MODALITY_MIN_CONTRAST) continue;
      const evidence = slower.checked + faster.checked;
      if (best && (gap < bestGap || (gap === bestGap && evidence <= bestEvidence))) continue;
      bestGap = gap;
      bestEvidence = evidence;
      best = {
        key: `${slower.kind}|${faster.kind}`,
        slower: slower.kind,
        faster: faster.kind,
        text: modalityStatementText(slower, faster),
        evidenceSignalIds: [...slower.signalIds, ...faster.signalIds],
      };
    }
  }
  return best;
}

// ------------------------------------------------------- what is already said

/** A statement that is a modality question or a confirmed modality read. */
export const isModalityStatement = (statement: Statement): boolean =>
  statement.modality !== undefined;

/**
 * A modality question nobody has answered yet.
 *
 * The one predicate the claim-discipline law turns on. Anything that reads
 * statements as truth about the learner filters on this: an unanswered question
 * is not a read, and handing it to a teaching brief would be exactly the silent
 * profile the product shape forbids.
 */
export const isUnansweredModality = (statement: Statement): boolean =>
  statement.modality !== undefined && statement.modality.confirmedAt === null
  && !statement.rejected;

/**
 * Whether this board already has a modality statement standing.
 *
 * Asked and unanswered counts, and so does confirmed. One at a time is the cap,
 * and it is a cap on the whole feature rather than on the asking: a board that
 * has confirmed one contrast does not get quietly given a second theory beside
 * it on the next run.
 */
export const modalityAlreadyLive = (statements: readonly Statement[]): boolean =>
  statements.some((statement) => isModalityStatement(statement) && !statement.rejected);

/**
 * Whether the learner's no is still standing.
 *
 * A malformed or future-dated stamp reads as no denial rather than as an
 * eternal one, exactly as `isSetAside` does, and for the same reason: failing
 * towards asking once too often is better than failing towards a question that
 * can never be asked again.
 */
export function modalityDenialLive(
  denial: ModalityDenial | null | undefined, now: Date,
): boolean {
  const at = Date.parse(denial?.at ?? '');
  if (!Number.isFinite(at)) return false;
  return at <= now.getTime() && now.getTime() - at < MODALITY_DENIED_DAYS * DAY_MS;
}

/** The learner's no, recorded. Any denial suppresses any modality question for
 *  the window: the kinds are four ways of saying one thing about somebody, and
 *  re-asking with the pair swapped would be the product arguing. */
export const recordModalityDenial = (key: string, now: Date): ModalityDenial =>
  ({ key, at: new Date(now.getTime()).toISOString() });
