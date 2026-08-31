/**
 * Background work runs only when explicitly requested or when new material
 * reaches the configured threshold. Topic decay alone never spends unasked.
 */

import { PROSPECT_MAX_MODEL_CALLS } from './prospect.js';

/** What is actually waiting, counted without asking a model anything. */
export interface BatchInput {
  /** Pins the clusterer has never filed. The real "something new" signal. */
  readonly unprocessedPins: number;
  /** Topics whose comfort has decayed far enough to be worth revisiting. */
  readonly dueForRevision: number;
  /** The learner pressed Process. Outranks everything. */
  readonly asked?: boolean;
  /** Collection is paused. Nothing runs, asked or not. */
  readonly paused?: boolean;
  /**
   * Process automatically once this many things have piled up, or `null` for
   * never — which is the default, because a learner who has not asked for
   * automatic anything should not be charged for it.
   */
  readonly autoAfter?: number | null;
}

export type BatchBecause =
  | 'asked'
  | 'enough-piled-up'
  /** There is genuinely nothing unprocessed. The money question. */
  | 'nothing-new'
  /** Material is waiting and automatic is switched off. Told apart from
   *  `nothing-new` because they are different facts about somebody's board,
   *  and the first draft reported four waiting pins as "nothing-new" — a
   *  reason code contradicting the sentence printed beside it. */
  | 'manual-only'
  /** Automatic is on and the pile has not reached the threshold. */
  | 'waiting-for-more'
  | 'paused';

export interface BatchDecision {
  readonly run: boolean;
  readonly because: BatchBecause;
  /** What a learner is told, on the board, next to the button. */
  readonly line: string;
}

/** Never automatic below this, whatever a learner sets. One pin is not a batch,
 *  and processing it alone is the per-pin model call batching exists to avoid. */
export const AUTO_FLOOR = 3;

export function planBatch(input: BatchInput): BatchDecision {
  const { unprocessedPins, dueForRevision } = input;

  if (input.paused) {
    return { run: false, because: 'paused', line: 'Collection is paused, so nothing is being processed.' };
  }

  // A person outranks every rule here, including "nothing new" — somebody who
  // presses the button having pinned nothing gets the revision session they
  // are asking for, and it is theirs to ask for.
  if (input.asked) {
    return { run: true, because: 'asked', line: 'Processing what is on your board.' };
  }

  if (unprocessedPins === 0) {
    // The whole point. Nothing was added, so nothing is bought.
    return {
      run: false,
      because: 'nothing-new',
      line: dueForRevision > 0
        // Offered rather than bought. Decay is worth mentioning and is not
        // worth spending somebody's money on without being asked.
        ? `Nothing new to process. ${describeDue(dueForRevision)} due for a refresh whenever you want one.`
        : 'Nothing new to process.',
    };
  }

  const threshold = autoThreshold(input.autoAfter);
  if (threshold !== null && unprocessedPins >= threshold) {
    return {
      run: true,
      because: 'enough-piled-up',
      line: `Processing ${describeThings(unprocessedPins)} you pinned.`,
    };
  }

  return {
    run: false,
    because: threshold === null ? 'manual-only' : 'waiting-for-more',
    line: `${describeThings(unprocessedPins)} waiting.`,
  };
}

/** `null` means never automatic. Anything below the floor is raised to it. */
export function autoThreshold(autoAfter: number | null | undefined): number | null {
  if (autoAfter === null || autoAfter === undefined) return null;
  if (!Number.isFinite(autoAfter) || autoAfter <= 0) return null;
  return Math.max(AUTO_FLOOR, Math.floor(autoAfter));
}

const describeThings = (n: number): string => `${n} thing${n === 1 ? '' : 's'}`;
const describeDue = (n: number): string => `${n} topic${n === 1 ? ' is' : 's are'}`;

/** Estimates the visible model-call cost from the distinct scaling terms. */

/**
 * How many pins the Forager asks about in one call.
 *
 * Here rather than in `agents/forager.ts` because the estimate below has to
 * know it, and `domain/` does not import `agents/` — that direction is the
 * seam. The agent imports it from here.
 *
 * Five is a bound on two things that both get worse as a chunk grows: the
 * blast radius of one page's hostile text sitting beside another's, and the
 * cost of a failed call, which is now a chunk rather than a pin.
 */
export const FORAGE_BATCH = 5;

/**
 * The smallest board on which a prerequisite ordering can say anything.
 *
 * Three, because two topics admit exactly one possible edge and the ordering
 * is a no-op on it either way. At three the graph can express something
 * arithmetic cannot — that one topic gates two others.
 */
export const SURVEY_FLOOR = 3;

/**
 * The stages that call a model exactly once per run, whatever the board:
 * clusterer naming, analyst, registrar (statements), composer, and one
 * verifier call for the first section. The Surveyor is NOT among them — it is
 * skipped below `SURVEY_FLOOR` — and is added by the estimate when it applies.
 */
export const STAGE_CALLS = 5;

export interface CallEstimateInput {
  /** Pins the forage stage is owed an attempt at, asked about in chunks. */
  readonly owedEnrichment: number;
  /** Topics on the board now. Each one taught is another verifier call. */
  readonly topics: number;
  /** Whether the partition will run at all, which costs one embedding call. */
  readonly hasPins: boolean;
  /** Whether learner authority makes Analyst and Registrar output inadmissible. */
  readonly globalLearnerCorrection?: boolean;
  /**
   * Whether the night scout may run, and therefore whether to quote it.
   *
   * Absent is false, and that is a statement about callers rather than about
   * the stage: a caller that has not read the preference cannot know, and a
   * quote that assumed the stage was on would price a run nobody is buying.
   * The one caller that has read it passes it, and pays the cap rather than the
   * likely cost. Two is the most this stage can ever spend, an unanswered gap
   * is what decides whether it spends anything at all, and that is not knowable
   * before the run without recomputing the gap list.
   */
  readonly prospect?: boolean;
  /**
   * Whether the Analyst may buy a second ask, and therefore whether to quote it.
   *
   * The same shape as `prospect` above and for the same reason: the first call
   * decides whether there is a second, so it cannot be known before the run. It
   * is quoted at its cap — one extra deep call on a board carrying enough
   * material for `analyseWithSecondAsk` to re-ask an empty answer — so a night
   * whose first ask comes back full comes in under the number rather than over
   * it. Absent is false, which is what a caller that has not read the board is
   * entitled to say.
   */
  readonly analyseSecondAsk?: boolean;
  /** The visible 1/3/5-minute session choice, when the caller has read prefs. */
  readonly sessionMinutes?: number;
}

export function estimateCalls(input: CallEstimateInput): number {
  const owed = Math.max(0, input.owedEnrichment);
  const topics = Math.max(0, input.topics);
  // One call per pin owed. `FORAGE_BATCH` exists and is measured; nothing in
  // the product calls it, so charging for it here would be quoting a price the
  // run does not pay. See the hold recorded in `pipeline.ts` and.
  const forage = owed;
  // `- 1` because STAGE_CALLS already carries the first section's check. A
  // caller that knows the visible session window can quote only the sections
  // the Composer can actually choose; old callers retain the conservative
  // topic-count estimate.
  const sectionCapacity = input.sessionMinutes === undefined
    ? topics
    : Math.max(1, Math.floor(Math.max(0, input.sessionMinutes) / 5));
  const extraSections = Math.max(0, Math.min(topics, sectionCapacity) - 1);
  const survey = topics >= SURVEY_FLOOR ? 1 : 0;
  // Analyst and Registrar are two of STAGE_CALLS. A global learner correction
  // makes every new line either could write inadmissible, and the pipeline now
  // skips both before the model boundary. Quote the run that actually happens.
  const correctionSkips = input.globalLearnerCorrection ? 2 : 0;
  // Quoted at its cap. The estimate above is an estimate and says so; this one
  // term is a genuine ceiling, so a run that finds no gap comes in under the
  // number rather than over it.
  const prospect = input.prospect ? PROSPECT_MAX_MODEL_CALLS : 0;
  // Conditional on the Analyst running at all: a global correction skips it
  // before the model boundary, and a stage that is not asked once cannot be
  // asked twice.
  const secondAsk = input.analyseSecondAsk && !input.globalLearnerCorrection ? 1 : 0;
  return STAGE_CALLS - correctionSkips + forage + survey + extraSections
    + prospect + secondAsk + (input.hasPins ? 1 : 0);
}

/** Bounds one run by item count; the separate spend limit controls money. */
export interface WorkPacing {
  /** How many of the waiting items this run takes. */
  readonly take: number;
  /** How many are left for the next one. Never negative, never invented. */
  readonly remaining: number;
  /** True when the cap actually bit. A run that took everything was not paced. */
  readonly paced: boolean;
}

/** Large imports are paced while ordinary boards remain below the cap. */
export const DEFAULT_WORK_CAP = 50;

/**
 * The smallest cap that may be set.
 *
 * A cap of zero is a queue that never drains, and a cap of one is a per-item
 * model call — the thing batching exists to avoid, arrived at from the other
 * direction. `AUTO_FLOOR` refuses to call one pin a batch for the same reason.
 */
export const WORK_CAP_FLOOR = 5;

/** `null` means no cap at all: take the lot. Anything below the floor is raised
 *  to it, and anything unreadable is the default rather than an error, because
 *  an operator's typo in a YAML file must not stop a night. */
export function workCapFrom(value: unknown): number | null {
  if (value === null) return null;
  if (value === undefined || value === '') return DEFAULT_WORK_CAP;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) return DEFAULT_WORK_CAP;
  if (n <= 0) return null;
  return Math.max(WORK_CAP_FLOOR, Math.floor(n));
}

export function paceWork(input: { waiting: number; cap: number | null }): WorkPacing {
  const waiting = Math.max(0, Math.floor(input.waiting));
  const cap = input.cap;
  if (cap === null || waiting <= cap) return { take: waiting, remaining: 0, paced: false };
  return { take: cap, remaining: waiting - cap, paced: true };
}

/**
 * The stage line's own count, so every paced stage says the same thing.
 *
 * The receipts are the raw material for a morning report, and a morning report
 * built from six stages each phrasing "and there is more tomorrow" its own way
 * is a report that cannot be read. `remaining` is stated even at zero when the
 * stage was paced at all, because *"none left"* is the fact somebody waiting on
 * a semester most wants and an absent clause is not it.
 */
export function pacingLine(pacing: WorkPacing): string {
  if (!pacing.paced) return '';
  return `, ${pacing.remaining} left for the next run (capped at ${pacing.take})`;
}

// ------------------------------------------------------------- a lean night

/** What a finished run has to show for itself, in the three counts that matter. */
export interface NightYield {
  /** Observations the Analyst produced, after validation. */
  readonly observations: number;
  /** Sentences the statements stage actually wrote. */
  readonly statements: number;
  /** Proposals the night scout actually raised. */
  readonly proposals: number;
}

export const leanNight = (night: NightYield): boolean =>
  night.observations === 0 && night.statements === 0 && night.proposals === 0;
