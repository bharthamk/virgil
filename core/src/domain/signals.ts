import type { Signal, SignalDirection, SignalType, TopicId } from './types.js';

/**
 * The three marks the learner makes on the lineup, kept apart from the ledger's
 * evidence by TYPE rather than by discipline.
 *
 * The learner-controlled lineup contract. Everything else in `SignalType` is something that happened —
 * an answer marked, a passage read, a step nobody could do — and the arithmetic
 * below turns those into a claim about what somebody knows. These three are the
 * learner looking at a list of subjects nobody has taught them yet and saying
 * which ones they want. Weighing that as evidence would let taste rewrite the
 * comfort model, which is SB-29's failure with the sign flipped.
 *
 * `SIGNAL_WEIGHT` is keyed on `EvidenceSignalType`, so there is no entry for
 * any of them and no `?? 0.1` fallback can invent one. Adding a preference
 * signal to the weight table is a compile error, which is the point.
 */
export type PreferenceSignalType = 'lineup-good-call' | 'lineup-bad-call' | 'lineup-not-now';

/** Everything the comfort model is entitled to read. */
export type EvidenceSignalType = Exclude<SignalType, PreferenceSignalType>;

const PREFERENCE_SET: ReadonlySet<string> = new Set<PreferenceSignalType>([
  'lineup-good-call', 'lineup-bad-call', 'lineup-not-now',
]);

/** A signal the comfort model must not read. Written as a narrowing so callers
 *  get the type back rather than a boolean they have to remember to act on. */
export const isPreferenceSignal = (type: SignalType): type is PreferenceSignalType =>
  PREFERENCE_SET.has(type);

export type EvidenceSignal = Signal & { readonly type: EvidenceSignalType };

/** The ledger, with the taste taken out. */
export const isEvidence = (signal: Signal): signal is EvidenceSignal =>
  !PREFERENCE_SET.has(signal.type);

/**
 * Evidence that somebody actually checked, rather than evidence that the
 * learner read, attended, or described their own comfort.
 *
 * This definition is shared by the Registrar and the read-only progression
 * projection. Keeping it in the domain prevents the learner model from
 * calling one thing a demonstration while a milestone counts another.
 */
export const DEMONSTRATED_TYPES: readonly SignalType[] = ['answer-correct', 'recall-check'];

export const isDemonstration = (signal: Signal): boolean =>
  !signal.invalidated
  && signal.direction === 'positive'
  && DEMONSTRATED_TYPES.includes(signal.type);

/**
 * AGENT_REQUIREMENTS.md §4 — evidential weighting.
 *
 * SB-29 is the reason this table exists: if "I know this" counted as much as a
 * correct answer, the skip button becomes a way to lie to yourself and the
 * comfort model quietly degrades. Demonstrated beats declared, always.
 */
export const SIGNAL_WEIGHT: Readonly<Record<EvidenceSignalType, number>> = {
  'answer-correct': 1.0,
  'answer-wrong': 1.0,
  // External assessed reality is the strongest evidence Virgil can receive.
  // It ties an exact receipt to a topic and is invalidated if that receipt is
  // corrected; completing the assignment itself still writes no signal.
  'assessed-strong': 1.0,
  'assessed-gap': 1.0,
  'recall-check': 0.8,
  'qc-finding': 0.8, // evidence-backed: it came from the user's own writing
  'depth-simpler': 0.5,
  'depth-deeper': 0.5,
  // SB-62: the same statement as a depth shift, made deliberately and about a
  // section the learner has finished rather than one they are in the middle of.
  // Weighted the same for that reason — it is a stronger *prior* for what to
  // teach next, which the Gardener acts on, and it is not stronger *evidence*
  // about ability, which is what this table is.
  'resurface-refresher': 0.5,
  'resurface-deeper': 0.5,
  // SB-61: "stronger than declared-only evidence, weaker than repeated
  // demonstrated competence." Both halves are positions in this table.
  //
  // Above `self-skip` (0.25), which is a claim made about material the learner
  // did not open — the quick take was read before the tap landed. Below
  // `recall-check` (0.8) and the two answer types, which are somebody checking.
  // The two taps carry the same weight deliberately: a table that paid more for
  // one of them would be paying for an answer rather than for a reading.
  'quick-take-got-it': 0.5,
  'quick-take-still-shaky': 0.5,
  'pin-struggle': 0.5,
  // `mode-guide-me`: stuck on one step, said in the middle of trying to do it.
  // Above every declared signal and above the quick take's two, because those
  // are the learner's read of their own reading and this is a thing they tried
  // and could not do. Below `recall-check` and the answer types only because
  // those are somebody else checking rather than the learner reporting.
  'guide-stuck': 0.7,
  'self-skip': 0.25,
  'section-completed': 0.2,
  'section-abandoned': 0.15, // ambiguous — could just be life
  'reread-confirmed': 0.2,
  'pin-interest': 0.05, // signals attention, not ability
  'interview-seed': 0.3, // seed only; decays as real evidence accrues
  'user-model-edit': 1.0, // SB-42: wins until contradicted by new evidence
};

/** Seed weight decays as real behavioural evidence accrues. */
export const SEED_HALF_LIFE_SIGNALS = 6;

/** Comfort decays with disuse — SB-36 resurfacing depends on this. */
export const COMFORT_HALF_LIFE_DAYS = 45;

// ------------------------------------------- The learner-controlled lineup contract: taste, as arithmetic

const DAY_MS = 86_400_000;

/**
 * How long "not tonight" lasts.
 *
 * Seven days, and the number is here rather than in the Gardener because the
 * learner is told it: the panel says the topic comes back next week, and a
 * window the copy and the ranker each carried their own copy of is a promise
 * that drifts.
 *
 * Short on purpose. The X is a statement about tonight, not a retirement —
 * `Topic.retiredByUser` is what the learner reaches for when they mean never,
 * and it has no expiry. A suppression long enough to be forgotten would turn a
 * one-tap "not now" into a silent deletion, which is the failure SB-22 names:
 * the board must never quietly drop something somebody chose to keep.
 */
export const NOT_NOW_DAYS = 7;

/**
 * How long a good-call or bad-call keeps steering the ranking.
 *
 * Longer than the removal window because it is a weaker statement with a
 * weaker consequence: it moves a topic within the pool rather than out of it.
 * Bounded rather than decaying-by-halves, because the arithmetic here is a
 * TIE-BREAK and not a model of anything — see `choiceWeight`.
 */
export const CHOICE_WINDOW_DAYS = 30;

/** What one unanswered mark is worth, as a fraction of a topic's priority. */
export const CHOICE_STEP = 0.4;
export const CHOICE_WEIGHT_MIN = 1 - CHOICE_STEP;
export const CHOICE_WEIGHT_MAX = 1 + CHOICE_STEP;

const live = (topicId: TopicId, signals: readonly Signal[]): readonly Signal[] =>
  signals.filter((s) => s.topicId === topicId && !s.invalidated
    && Number.isFinite(Date.parse(s.at)));

/**
 * The learner's standing "not tonight" on this topic, or null.
 *
 * Returns the mark itself rather than a boolean, so the Gardener's reason line
 * can name the day it was made and the panel can say when it comes back. The
 * newest mark wins: tapping X again on a later night extends the window, which
 * is what a second tap plainly means.
 */
export function notNowMark(
  topicId: TopicId, signals: readonly Signal[], now: Date,
): Signal | null {
  const from = now.getTime() - NOT_NOW_DAYS * DAY_MS;
  const marks = live(topicId, signals)
    .filter((s) => s.type === 'lineup-not-now' && Date.parse(s.at) > from)
    .sort((a, b) => a.at.localeCompare(b.at));
  return marks[marks.length - 1] ?? null;
}

/**
 * What the learner's verdicts on this topic's SELECTION are worth, as a
 * bounded multiplier on its derived priority.
 *
 * The same shape as `dueWeight` and for the same reason: it reorders the
 * ordinary teaching pool and can never promote anything on its own. A net of
 * one bad call is 0.6, a net of one good call is 1.4, and everything past that
 * clamps — so a learner who taps thumbs-down four times has said the same thing
 * as a learner who tapped it once, which is the honest reading. Taste that
 * could accumulate without limit would eventually beat the evidence, and then
 * the product would be teaching what is comfortable rather than what is owed.
 *
 * Marks outside `CHOICE_WINDOW_DAYS` count for nothing. A verdict on a lineup
 * from two months ago is a verdict on a different board.
 *
 * Deliberately flat inside the window rather than decayed: this is a preference
 * and not a measurement, and a half-life here would imply a precision the input
 * does not have.
 */
export function choiceWeight(
  topicId: TopicId, signals: readonly Signal[], now: Date,
): number {
  const from = now.getTime() - CHOICE_WINDOW_DAYS * DAY_MS;
  let net = 0;
  for (const s of live(topicId, signals)) {
    if (Date.parse(s.at) <= from) continue;
    if (s.type === 'lineup-good-call') net += 1;
    if (s.type === 'lineup-bad-call') net -= 1;
  }
  const raw = 1 + CHOICE_STEP * net;
  return Math.min(CHOICE_WEIGHT_MAX, Math.max(CHOICE_WEIGHT_MIN, raw));
}

// ------------------------------------- SB-283: closing a quick take, in marks

/**
 * WHAT EACH CLOSING TAP ON A QUICK TAKE WRITES, AND WHY NOTHING NEW WAS MINTED.
 *
 * The walkthrough finding: a quick take wrote nothing back unless the learner
 * happened to answer one of two buttons, and there was no honest third answer
 * for *I read it and I am not doing this now*. PRODUCT_SHAPE.md's surface 2 is
 * *"answer a few questions, in and out"*, and its moat clause is that every
 * surface feeds the one learner model. A screen a learner reads and leaves
 * without a mark is a surface that takes and does not give.
 *
 * Three EXISTING kinds. `quick-take-got-it` and `quick-take-still-shaky` are
 * SB-61's two readings and keep the weight and the direction they were given.
 * *Not now* borrows `lineup-not-now`, the mark the session X already writes,
 * because it is the same statement: a decision about timing, made about a
 * topic, and not a claim about what the learner knows. That is also why the
 * consumers need no work. `notNowMark` already holds the topic out of
 * selection for `NOT_NOW_DAYS`, the night scout already counts it as stepping
 * around a topic, and the slipping read already sees it. A fourth word for
 * "not tonight" would have been a fourth thing every one of them had to learn.
 *
 * The exclusions hold in the same breath. All three are outside
 * `MODALITY_ASSESSED_TYPES`, so none of them can write the claim about how
 * somebody learns that it would then be asked to confirm (SB-282), and
 * `lineup-not-now` is a `PreferenceSignalType`, so `SIGNAL_WEIGHT` has no
 * entry it could be read through.
 */
export const QUICK_TAKE_VERDICTS = ['got-it', 'still-shaky', 'not-now'] as const;
export type QuickTakeVerdict = typeof QUICK_TAKE_VERDICTS[number];

export interface QuickTakeMark {
  readonly type: SignalType;
  readonly direction: SignalDirection;
  /** Stated only by the mark that actually holds the topic back, so the panel
   *  can promise the window rather than carry its own copy of the number. */
  readonly backAfterDays?: number;
}

export const QUICK_TAKE_MARKS: Readonly<Record<QuickTakeVerdict, QuickTakeMark>> = {
  'got-it': { type: 'quick-take-got-it', direction: 'positive' },
  'still-shaky': { type: 'quick-take-still-shaky', direction: 'negative' },
  'not-now': { type: 'lineup-not-now', direction: 'neutral', backAfterDays: NOT_NOW_DAYS },
};
