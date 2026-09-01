import { randomUUID } from 'node:crypto';
import {
  forage, cluster, survey, compose, verify, verifyGovernedThinMedium,
  assessmentBeyondSourceBoundary,
  dispositionFor, tierFor, fallbackLabel,
  briefedTextFor,
  computeComfort, applyComfort, renderStatements,
  tend, duePool, orderTopics, stripWithheldTopics,
  type Deps, type PureDeps, type EnrichmentOutcome, type Topic, type TopicId, type Pin,
  type ComfortResult, type Observation, type ComposedSection, type ComposedSession,
  type Defect, type ClustererOutput, type ClusterResult, type PartitionStrategyId, type Statement,
  type Llm, type LlmRequest, type LlmResult,
  SURVEY_FLOOR,
  classify, type DegradeReason,
  LlmRefused,
  type NotebookExport, type WriteReceipt,
  enrichCourseIntake, owesIntakeEnrichment, type CourseIntakeDraft,
  paceWork, pacingLine, DEFAULT_WORK_CAP, type WorkPacing,
  leanNight,
  mutateStoredPin, mutateStoredTopic,
} from '@sb/core';
import type { UsageMeter } from './usage.js';
import { exportNotebookAfterRun } from './notebook-export.js';
import { runAnalyseStage } from './analyse-stage.js';
import { runProspectStage } from './prospect-stage.js';
import { runModalityStage } from './modality-stage.js';
import {
  sessionLearnerContext, sessionObservations, type SessionLearnerContext,
} from './session-learner-context.js';

// Both were lifted into `session-learner-context.ts` so that a stage body can
// depend on them without importing this module back. They are re-exported here
// because this is where every caller in the product already reads them from.
export {
  sessionLearnerContext, sessionObservations, type SessionLearnerContext,
} from './session-learner-context.js';

/**
 * The nightly pipeline — the local stand-in for a Cloud Run Job.
 *
 * Order is load-bearing: each stage genuinely needs the previous one complete.
 * Only Forager fans out; everything after it reasons over the whole board and
 * cannot be parallelised without losing the cross-pin context that is the point.
 *
 * Holds sequencing, not logic. Every stage is a `core/` agent.
 */

export interface StageReport {
  readonly stage: string;
  readonly ms: number;
  readonly detail: string;
  /** True when the stage degraded. The run continues regardless. */
  readonly failed: boolean;
  /**
   * What kind of failure it was, where the provider said enough to tell.
   *
   * Null on a stage that succeeded, and on one that failed for a reason nobody
   * has classified. `exhausted` is the one that changes what the run means:
   * the account is out of capacity until tomorrow, so every later model stage
   * is going to fail the same way and the night is not "nothing to teach", it
   * is "not attempted".
   *
   * Found in the 2026-08-22 audit. `adk/src/errors.ts` decoded this and
   * `runtime.ts` said so in as many words — *"wired into nothing — `runBatch`
   * cannot yet report that a daily cap was met"* — while `BatchOutcome` carried
   * a `quota-degraded` case nothing could produce. The free-tier day cap is
   * twenty requests and a nightly is seven model calls, so this is not a rare
   * shape: it is the one that ended the deep benchmark twice.
   */
  readonly degradeReason?: DegradeReason | null;
  /**
   * What the stage got through, in numbers rather than in a sentence.
   *
   * `detail` is prose and always will be — it is what a person reads in a
   * terminal at three in the morning. This is the same facts in a shape a
   * **morning report** can consume without parsing English, which is what the
   * semester lane needs: *"300 documents read, 50 of them last night, 250 still
   * to go"* is a sentence somebody has to be able to build from a run nobody
   * watched.
   *
   * Present only on the stages that work through a queue, and only where the
   * stage completed. A stage that threw has no counts to report, and inventing
   * zeros for it would say it looked and found nothing to do.
   */
  readonly work?: StageWork | null;
}

/**
 * What one stage got through, and what it left.
 *
 * Four numbers rather than a total, because they answer four different questions
 * and a sum answers none of them. `waiting` is the size of the queue the stage
 * looked at; `worked` is what it took; `remaining` is what the per-run cap
 * deferred; `failed` is what it took and could not finish. The last two are
 * deliberately not added together: an item deferred by the cap and an item whose
 * model call failed are both still there in the morning, and only one of them is
 * a problem.
 */
export interface StageWork {
  /** Items owed work when the stage began. */
  readonly waiting: number;
  /** Items this run actually took. */
  readonly worked: number;
  /** Items the per-run cap deferred to the next run. */
  readonly remaining: number;
  /** Items taken that did not complete, and are owed another attempt. */
  readonly failed: number;
  /** What the work produced, where the stage makes something countable. */
  readonly produced?: number;
  /** True when the cap actually bit. A stage that took everything was not paced. */
  readonly paced: boolean;
}

const workOf = (
  pacing: WorkPacing, waiting: number, failed: number, produced?: number,
): StageWork => ({
  waiting,
  worked: pacing.take,
  remaining: pacing.remaining,
  failed,
  ...(produced === undefined ? {} : { produced }),
  paced: pacing.paced,
});

/** The stage body's answer: prose, or prose and the numbers behind it. */
type StageDetail = string | { readonly detail: string; readonly work: StageWork };

/**
 * Why a section did not ship.
 *
 * The distinction is the whole point. A section the Verifier read and rejected
 * and a section the Verifier never managed to read are different facts about
 * the run, and collapsing them loses the only evidence that the safety check
 * stopped working.
 */
export type WithholdReason =
  /** The Verifier ran and found a fatal defect. Working as designed. */
  | 'defective'
  /** The Verifier could not run. The section is neither verified nor failed. */
  | 'unverified';

export interface WithheldSection {
  readonly heading: string;
  /** Kept so the caller can say which topic came back to the pool. */
  readonly topicId: TopicId;
  readonly reason: WithholdReason;
  /** Empty for 'unverified' — there is no finding, that is the problem. */
  readonly defects: readonly Defect[];
  /** Why the check could not run. Null for 'defective'. */
  readonly error: string | null;
}

export interface BatchResult {
  readonly reports: readonly StageReport[];
  readonly session: ComposedSession | null;
  readonly observations: readonly Observation[];
  readonly topics: readonly Topic[];
  /** Sections the Verifier did not clear, with why. */
  readonly withheld: readonly WithheldSection[];
  /**
   * The provider said its capacity for the period is spent.
   *
   * Read off the stage reports rather than tracked separately, so it cannot
   * disagree with them. It is what turns an empty night from "there was
   * nothing to teach" into "we were not able to try", which are different
   * facts and lead to different repairs — and, on a metered account, to a
   * different decision about whether to run again today.
   */
  readonly quotaExhausted: boolean;
  /**
   * The learner model admitted to Composer/Verifier changed before the checked
   * draft could be persisted. No session or exposure write is allowed in this
   * state; the next run must compose from the current authority.
   */
  readonly learnerContextChanged: boolean;
  /**
   * What happened to the notebook export, or null when it is not configured.
   *
   * `NOTEBOOK_SEAM_V2.md` §9. Null and "every document written" are genuinely
   * different facts and the caller acts on them differently: the first is a
   * feature that is off, which is the default and is not a problem, and the
   * second is a feature that worked. Folding them together would make an
   * unconfigured export indistinguishable from a silent one.
   *
   * A failed export never turns a successful night into a failed one, so this
   * field is a report and never an outcome: `outcomeOf` does not read it.
   */
  readonly notebook: WriteReceipt | null;
  /**
   * How much work this run deliberately left for the next one.
   *
   * **Read off the stage reports rather than tracked separately**, exactly as
   * `quotaExhausted` is and for the same reason: a second counter is a second
   * thing that can disagree with the lines printed beside it. A semester dropped
   * in one gesture is worked through over several nights, and this is the number
   * that makes that a promise rather than a hope — zero means the pile is
   * genuinely empty, and any other number means there is a next run with
   * something in it.
   *
   * It counts only what the **cap** deferred. An item whose model call failed is
   * owed another attempt and is reported as `failed` on its own stage; folding
   * the two together would make a night of provider errors look like a night
   * that was pacing itself.
   */
  readonly remaining: number;
  /**
   * The night read the board and came back with nothing to say about it.
   *
   * Zero observations, zero statements written and zero proposals raised, which
   * is the exact conjunction `leanNight` defines and the exact shape of the run
   * on 2026-08-28: a board that had produced observation-rich output the night
   * before went quiet, every stage reported lawfully, and nothing anywhere told
   * the learner the night had been thin.
   *
   * It is a fact about what the run produced and not a diagnosis. A stage that
   * degraded already has its own line, and the surface rendering this one is
   * where the two are reconciled.
   */
  readonly lean: boolean;
}

/** A framework host can own a stage boundary without owning the stage body. */
export interface BatchStageExecutor {
  execute(stage: string, run: () => Promise<string>): Promise<StageReport>;
}

export interface BatchRunOptions {
  concurrency?: number;
  onStage?: (r: StageReport) => void;
  /** Fires immediately before a stage begins, for truthful live receipts. */
  onStageStart?: (stage: string) => void;
  /** Fires with the exact learner corrections admitted to the teaching brief. */
  onLearnerContext?: (corrections: number) => void;
  usage?: UsageMeter;
  partitionStrategy?: PartitionStrategyId;
  batchKey?: string;
  /** Internal composition seam used by the real stage-level orchestration host. */
  stageExecutor?: BatchStageExecutor;
  /**
   * Engine-evaluation seam for exercising multi-section ordering, deadline
   * displacement and withholding after the learner-facing product moved to
   * 1/3/5-minute sessions. Normal composition roots never pass this; service
   * and CLI always read the visible learner preference.
   */
  compositionMinutes?: number;
  /**
   * Where to publish the learner's own documents when the night is over.
   *
   * Absent is the default and means the feature is off, which is not a failure
   * and produces no error, no warning and no empty receipt. A composition root
   * that read no configuration for it passes nothing, and the night is exactly
   * the night it was before this existed.
   *
   * On `BatchRunOptions` rather than on `Deps` deliberately. `Deps` is what the
   * agents are handed, and no agent has any business knowing that an export
   * exists; this is a thing the run does after the agents have finished.
   */
  notebook?: NotebookExport;
  /**
   * How many queued items one run may work through, or `null` for no limit.
   *
   * **Absent is the cap, not the absence of one.** Every other option on this
   * interface defaults to off, and this one deliberately does not: a protection
   * that has to be remembered by each composition root is a protection that is
   * missing from the root somebody adds next. `DEFAULT_WORK_CAP` and the reasons
   * for its size live in `core/domain/batch.ts`.
   *
   * `null` is how a caller says *measure the unpaced shape* — the scale tests
   * that assert the cost of a run is linear in new pins pass it, because that
   * claim is about the growth law and a cap would flatten the very thing being
   * measured. It is not a thing a product surface passes.
   */
  workCap?: number | null;
}

/**
 * The order a paced stage takes its queue in.
 *
 * Oldest first, and every tie broken by id. Both halves are load-bearing:
 * oldest-first is the only fair answer to *"which fifty of my three hundred
 * tonight"*, and the id tie-break is what makes the slice the cap takes
 * reproducible — a store returning rows in a different order on a different
 * machine would otherwise pace a different fifty and make "resume where you left
 * off" unfalsifiable. Neither list is long enough for the sort to cost anything
 * worth measuring beside the model calls behind it.
 */
const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byCapturedThenId = (a: Pin, b: Pin): number =>
  byString(a.capturedAt, b.capturedAt) || byString(a.id, b.id);
const byCreatedThenId = (a: CourseIntakeDraft, b: CourseIntakeDraft): number =>
  byString(a.createdAt, b.createdAt) || byString(a.id, b.id);

/** The exact prose admitted to Composer and Verifier, compared at commit. */
const sameTeachingBriefContext = (
  before: SessionLearnerContext, after: SessionLearnerContext,
): boolean => {
  const same = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((line, index) => line === b[index]);
  return same(before.corrections, after.corrections)
    && same(before.derived, after.derived);
};

/** A rejected machine read may return only after its evidence changes. The
 * wording is deliberately irrelevant: a paraphrase built from the same ledger
 * is the same rejected read, while one new signal makes it reviewable again. */
export function rejectedByExistingEvidence(
  candidate: Statement, rejections: readonly Statement[],
): boolean {
  return rejections.some((rejected) => {
    if (!rejected.rejected) return false;
    if (!rejected.evidenceSignalIds.length) {
      return rejected.text.trim().toLocaleLowerCase() === candidate.text.trim().toLocaleLowerCase();
    }
    const evidence = new Set(rejected.evidenceSignalIds);
    return candidate.evidenceSignalIds.length > 0
      && candidate.evidenceSignalIds.every((id) => evidence.has(id));
  });
}

/**
 * A statement the `statements` stage owns, and may therefore replace.
 *
 * The stage regenerates the current machine read every night and deletes what
 * it wrote last night, which is right for the eight sentences it produces and
 * wrong for anything else that lives in the same collection. Learner words are
 * excluded because an edit outranks a derived read (SB-42); a rejection is
 * excluded because it is an invisible evidence receipt rather than a sentence.
 *
 * SB-282 adds the third. A modality row is not this stage's prose: it is one
 * question built in arithmetic and answered by a person, and deleting it
 * nightly would either ask somebody the same question every morning or throw
 * away the answer they gave. Its own lifecycle is in `modality-stage.ts`.
 *
 * The fourth is the same argument without the question. A read the learner has
 * agreed with is a sentence somebody answered, and replacing it overnight would
 * throw away that answer while leaving the wording it was given about. It is
 * still Virgil's prose and still correctable and rejectable; it is simply not
 * this stage's to overwrite any more.
 */
const stageOwnedRead = (statement: Statement): boolean =>
  !statement.userEdited && !statement.rejected && !statement.modality
  && statement.confirmedAt == null;

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length) as R[];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      const item = items[i];
      if (item === undefined) return;
      out[i] = await fn(item);
    }
  }));
  return out;
}

/**
 * Reuse one model answer only when the complete request is byte-identical.
 *
 * This is deliberately not batching. The Forager's one-pin isolation is a
 * trust boundary: the measured batch experiment let one passage influence
 * another and lost real prerequisites. Duplicate captures are a different
 * fact. Two independently prepared pins can produce the exact same system,
 * prompt, schema, tier, reasoning, media and output budget; sending that same
 * request twice buys no additional isolation or information.
 *
 * The promise is cached before it is awaited, so duplicates already in flight
 * collapse as well as duplicates reached by a later worker. Rejections are
 * shared too: a transport failure leaves every identical pin owed another
 * attempt, while an `LlmRefused` still escapes the stage and stops the run.
 * The cache lives for one stage only and retains no learner material after it.
 */
function reuseExactLlmRequests(inner: Llm): { readonly llm: Llm; readonly reused: () => number } {
  const structured = new Map<string, Promise<LlmResult<unknown>>>();
  let hits = 0;
  const keyOf = (req: LlmRequest & { schema: unknown }): string => JSON.stringify(req);
  const memo = <T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => {
    const key = keyOf(req);
    const found = structured.get(key) as Promise<LlmResult<T>> | undefined;
    if (found) { hits++; return found; }
    const pending = inner.structured<T>(req);
    structured.set(key, pending as Promise<LlmResult<unknown>>);
    return pending;
  };
  return {
    llm: {
      // Forager has no completion path. Leave this transparent so the wrapper
      // cannot accidentally grow into a broader cache than the stage needs.
      complete: (req) => inner.complete(req),
      structured: <T>(req: LlmRequest & { schema: unknown }) => memo<T>(req),
    },
    reused: () => hits,
  };
}

/**
 * Every stage is independently failure-tolerant.
 *
 * Learned the hard way: one truncated JSON response from the Analyst aborted
 * the entire nightly run, which in production means the learner wakes up to
 * nothing because one agent had a bad night. The pipeline degrades stage by
 * stage instead — a session built without observations is worth far more than
 * no session at all.
 *
 * Stages that genuinely cannot proceed without a predecessor guard on their own
 * inputs; they do not rely on the run aborting.
 */
const timed = async (stage: string, fn: () => Promise<string>, usage?: UsageMeter): Promise<StageReport> => {
  // Attribute every model call made inside this stage to this stage. Stages are
  // strictly sequential, so a marker is sufficient and no call can be
  // misattributed — including inside the two stages that fan out internally.
  usage?.enter(stage);
  const t = Date.now();
  // Await BEFORE building the object: properties evaluate in source order, so
  // `ms: Date.now() - t` inline with `detail: await fn()` measures zero every
  // time. Every stage reported 0.0s until this was split out.
  try {
    const detail = await fn();
    return { stage, ms: Date.now() - t, detail, failed: false };
  } catch (err) {
    // A refusal ends the run rather than degrading a stage.
    //
    // Stage-by-stage tolerance is the right answer to a bad night: one agent's
    // truncated JSON must not cost the learner the other eight. A stop is not a
    // bad night. Nothing was sent, nothing will be sent, and every remaining
    // stage would go and rediscover the same refusal — a run reported as "six
    // stages degraded" over one limit, with the cause named nowhere. `cli.ts`
    // already prints `batch-outcome budget-stopped` for exactly this and could
    // never reach it, because the run it was waiting on always came back green
    // enough to look like a night.
    if (err instanceof LlmRefused) throw err;
    // Classified rather than only stringified. The classifier duck-types the
    // seam's promised properties, so this stays provider-agnostic: it reads
    // `exhaustedForPeriod` and friends off whatever was thrown.
    const directive = classify(err);
    const reason: DegradeReason | null = directive.kind === 'degrade' ? directive.reason : null;
    return {
      stage,
      ms: Date.now() - t,
      detail: `FAILED — ${String(err).slice(0, 160)}`,
      failed: true,
      degradeReason: reason,
    };
  }
};

/**
 * How much of each pin the Verifier is shown, in characters.
 *
 * Every other agent slices the material it puts in a prompt — the Composer at
 * 700 characters per pin, the Analyst at 300, the Clusterer at 260 — and this
 * stage did not: it joined whole selections for every pin on the topic. A live
 * run put 2,276 characters into one verify prompt, and nothing bounds it in
 * principle. The Verifier's own material window is 6,000 characters, so an
 * unbounded first pin does not merely inflate the prompt, it evicts every other
 * pin on the topic from the window — and the sections built from the most
 * material are exactly the ones most worth checking.
 *
 * Deliberately the most generous cap in the fleet. The Verifier checks claims
 * AGAINST this text, so material it cannot see reads as material that does not
 * exist, and a stingy cap manufactures 'unsupported' defects that withhold
 * sound sections. 1,500 is roughly two screens of prose per pin.
 */
export const VERIFIER_CHARS_PER_PIN = 1500;

export interface VerifyOutcome {
  readonly kept: readonly ComposedSection[];
  readonly withheld: readonly WithheldSection[];
  /** The stage line, with defective and unverified counted separately. */
  readonly detail: string;
}

/**
 * The adversarial pass, as its own unit.
 *
 * A section whose verification CALL failed is not a verified section. It is not
 * a failed section either — nothing was found, because nothing ran — so it is
 * withheld under its own reason rather than shipped or reported as defective.
 *
 * This reverses the earlier behaviour, which kept such a section and set a
 * `degraded` flag that no caller ever read: on a live run one of three verify
 * calls failed, its section shipped, and the run reported "all sections clear".
 * A safety check that fails open is worse than no safety check, because it
 * manufactures the confidence — the same argument the Verifier's own
 * `reasoning: 'on'` is nailed down by, and the same argument that made an
 * exact-match defect filter a bug rather than a nicety.
 *
 * Withholding is also what returns the topic to the pool: an unshipped
 * section never advances `lastExposedAt`, so the Gardener still sees the topic
 * as owed. Keeping the section was what took it out of circulation while the
 * check that should have cleared it had not run.
 */
export async function verifySections(
  deps: PureDeps,
  input: {
    readonly sections: readonly ComposedSection[];
    readonly pins: readonly Pin[];
    readonly knownAboutLearner: readonly string[];
    readonly learnerCorrections?: readonly string[];
    readonly concurrency?: number;
  },
): Promise<VerifyOutcome> {
  const checked = await mapLimit(input.sections, input.concurrency ?? 3, async (section) => {
    const material = input.pins
      .filter((p) => p.topicId === section.topicId)
      // The same evidence view the Composer wrote from. A selected phrase is
      // intent, not enough context to verify a procedure against on its own.
      .map((p) => briefedTextFor(p, VERIFIER_CHARS_PER_PIN))
      .join('\n\n');
    const exactGoverned = verifyGovernedThinMedium(section, material);
    const governedDefects = exactGoverned ?? assessmentBeyondSourceBoundary(section);
    if (exactGoverned !== null || governedDefects.length) {
      const reason: WithholdReason | null = dispositionFor(governedDefects) === 'keep' ? null : 'defective';
      return {
        section, tier: null, defects: governedDefects, reason,
        error: null as string | null, governed: true,
      };
    }
    // Outside the try: it is pure, and the tier a section was DUE stays true
    // even when the call for it failed. Reporting a failed deep section as
    // 'fast' understated the scope of the checking that actually happened.
    const tier = tierFor(section);
    try {
      const defects = await verify(deps, {
        section, sourceMaterial: material,
        knownAboutLearner: input.knownAboutLearner,
        ...(input.learnerCorrections ? { learnerCorrections: input.learnerCorrections } : {}),
        tier,
      });
      const reason: WithholdReason | null = dispositionFor(defects) === 'keep' ? null : 'defective';
      return { section, tier, defects, reason, error: null as string | null, governed: false };
    } catch (err) {
      // A refusal is not a failure. `unverified` says the check did not run and
      // withholds the section, which is the safe reading of a verify call that
      // failed; it is the wrong reading of a call nothing issued, and it would
      // withhold every section in the run one refusal at a time.
      if (err instanceof LlmRefused) throw err;
      return {
        section, tier, defects: [] as readonly Defect[],
        reason: 'unverified' as WithholdReason | null,
        error: String(err).slice(0, 160) as string | null,
        governed: false,
      };
    }
  });

  const kept = checked.filter((c) => c.reason === null).map((c) => c.section);
  const withheld: WithheldSection[] = checked
    .filter((c) => c.reason !== null)
    .map((c) => ({
      heading: c.section.heading,
      topicId: c.section.topicId,
      reason: c.reason as WithholdReason,
      defects: c.defects,
      error: c.error,
    }));

  const defective = withheld.filter((w) => w.reason === 'defective').length;
  const unverified = withheld.length - defective;
  const weak = checked.reduce((n, c) => n + c.defects.filter((d) => d.severity === 'weak').length, 0);
  const governed = checked.filter((c) => c.governed).length;
  const modelChecked = checked.length - governed;
  const deep = checked.filter((c) => c.tier === 'deep').length;
  const scope = `${governed} governed / ${deep} deep / ${modelChecked - deep} fast`;

  // Counted apart, and named apart. Folding the unverified into the withheld
  // total would hide the failure inside a number that looks like the Verifier
  // working; folding it into the degraded-stage count would hide it inside a
  // number that says a stage did not run, which is not what happened either.
  const parts = [
    defective ? `${defective} withheld` : null,
    unverified ? `${unverified} UNVERIFIED — check did not run, not shipped` : null,
    weak ? `${weak} weak defect(s)` : null,
  ].filter((x): x is string => x !== null);

  return { kept, withheld, detail: parts.length ? `${scope} — ${parts.join(', ')}` : `${scope} — all sections clear` };
}

/**
 * The partition rule, named in the stage line.
 *
 * Which rule decided a board's topics is provenance, not decoration: two runs
 * of the same board under two strategies produce different topics, and a log
 * line that does not say which one ran cannot be read six weeks later. The
 * coarse space and its bucket cut are named for the same reason the fine space
 * and its cut always have been.
 */
function partitionLine(out: ClustererOutput): string {
  return out.strategy === 'd1'
    ? `partition d1 — ${out.coarseEmbeddingModelId} bucket @ ${out.bucketThreshold}`
      + ` then ${out.embeddingModelId} @ ${out.threshold}`
    : `partition single — ${out.embeddingModelId} @ ${out.threshold}`;
}

/** Merge a nightly attachment without undoing a learner split made mid-stage. */
async function mergeExistingClusterTopic(
  store: Deps['store'], prior: Topic, clusterResult: ClusterResult,
  keptPins: readonly string[],
): Promise<Topic | null> {
  return await mutateStoredTopic(store, prior.id, (current) => {
    const removedByLearner = new Set(
      prior.pinIds.filter((pinId) => !current.pinIds.includes(pinId)),
    );
    const additions = keptPins.filter((pinId) => !removedByLearner.has(pinId));
    return {
      ...current,
      label: current.provisionalName ? clusterResult.label : current.label,
      summary: current.provisionalName ? clusterResult.summary : current.summary,
      pinIds: [...new Set([...current.pinIds, ...additions])],
      ...(current.provisionalName
        ? { provisionalName: clusterResult.provisionalName ?? false } : {}),
    };
  });
}

export async function runBatch(
  deps: Deps,
  opts: BatchRunOptions = {},
): Promise<BatchResult> {
  const reports: StageReport[] = [];
  const usage = opts.usage;
  const note = (r: StageReport) => { reports.push(r); opts.onStage?.(r); };
  const now = deps.clock.now();
  // Verbatim when it was given. A key "corrected" against this process's clock
  // would be the inference the field exists to remove, one layer further in.
  const batchKey = opts.batchKey ?? now.toISOString().slice(0, 10);
  // Absent means the default cap, not no cap. See `BatchRunOptions.workCap`.
  const workCap = opts.workCap === undefined ? DEFAULT_WORK_CAP : opts.workCap;
  const execute = async (
    stage: string, stageBody: () => Promise<StageDetail>, pure = false,
  ): Promise<StageReport> => {
    opts.onStageStart?.(stage);
    /**
     * The counts, caught on the way past.
     *
     * The stage bodies below answer with prose, and the two that work a queue
     * answer with prose and numbers. Splitting them here rather than widening
     * every seam this passes through is what keeps `BatchStageExecutor` — the
     * boundary a framework host owns — a function from a name to a string.
     * A host has no business knowing this product has queues in it.
     */
    let work: StageWork | null = null;
    const body = async (): Promise<string> => {
      const answered = await stageBody();
      if (typeof answered === 'string') return answered;
      work = answered.work;
      return answered.detail;
    };
    const report = await runStage();
    // Only on a stage that completed. A throw never reaches the assignment
    // above, so a failed stage carries no counts rather than zeros.
    return work === null ? report : { ...report, work };

    async function runStage(): Promise<StageReport> {
    if (opts.stageExecutor) {
      /**
       * The hosted lane, where the run must NOT be aborted from here.
       *
       * The framework owns the sequence and this pipeline feeds it: every stage
       * the host is about to run is a stage this function has yet to yield.
       * Throwing out of `runBatch` mid-sequence would leave the next child
       * waiting on a stage nobody will ever hand it — a deadlock, in place of a
       * run that stops.
       *
       * So the refusal is carried by `HostedNightly` instead, which sees the
       * same throw on its way to the host and raises it from `result()` once
       * the sequence is over. Nothing is spent in the meantime: the gate that
       * refused the first call refuses every later one before it is issued.
       */
      return opts.stageExecutor.execute(stage, async () => { usage?.enter(stage); return body(); });
    }
    if (!pure) return timed(stage, body, usage);
    // Preserve the original infrastructure boundary: arithmetic/model-free
    // stages cannot degrade. A failure here is the store, and a Cloud Run retry
    // needs to see it rather than a green-but-partial night.
    usage?.enter(stage);
    const started = Date.now();
    const detail = await body();
    return { stage, ms: Date.now() - started, detail, failed: false };
    }
  };

  /**
   * 1. Intake — the semester the learner dropped, turned into plan proposals.
   *
   * **The stage the course-drop lane exists for, and the first the night runs.**
   * A drop lands as a pile of documents: every one of them becomes material on
   * the board immediately and the syllabus-shaped ones become intake drafts,
   * parsed deterministically at the door because that costs nothing. What is
   * expensive is the specialist — `deep`, reasoning on, one call per document —
   * and it is deliberately NOT run at the door. Three hundred documents arriving
   * in one gesture must not become three hundred model calls inside one HTTP
   * request; they become a queue, and this is the stage that works through it,
   * `workCap` documents a night, for however many nights that takes.
   *
   * First in the order because what it produces is what the learner most wants
   * in the morning: deadlines. Nothing later depends on it — a draft is a
   * proposal and touches no topic, no comfort score and no session — so it is
   * first for the person rather than for the sequence.
   *
   * **It writes nothing authoritative and cannot.** `enrichCourseIntake` adds
   * objectives, commitments and clarifying questions *to a draft*, every one of
   * them carrying an exact quote from the source, and every date recomputed from
   * that quote by `unambiguousDate` rather than taken from the model. A deadline
   * the source did not state unambiguously becomes a blocking question and the
   * draft cannot be applied until a person answers it. That boundary is
   * `intake.ts`'s and this stage does not widen it: a semester processed
   * overnight is still a semester the learner reviews.
   */
  note(await execute('intake', async () => {
    const drafts = await deps.store.listIntakeDrafts();
    // Oldest first, then by id. The order the documents were dropped in is the
    // order they are planned in, and the tie-break makes the slice the cap takes
    // the same slice on every machine — without which "resume where you left
    // off" would mean a different fifty pages each night.
    const owed = drafts.filter(owesIntakeEnrichment).sort(byCreatedThenId);
    if (!owed.length) return 'nothing new to plan';
    const pacing = paceWork({ waiting: owed.length, cap: workCap });
    const taken = owed.slice(0, pacing.take);

    let enriched = 0, nothing = 0, modelFailed = 0, threw = 0, raced = 0;
    let commitments = 0, questions = 0;
    for (const draft of taken) {
      let result: Awaited<ReturnType<typeof enrichCourseIntake>>;
      try {
        result = await enrichCourseIntake(deps, draft, randomUUID);
      } catch (err) {
        // A refusal is not a failure, and here it is loudest: one stop would
        // otherwise be counted once per queued document and reported as "N did
        // not complete" on a night where nothing was sent at all.
        if (err instanceof LlmRefused) throw err;
        threw++;
        continue;
      }
      /**
       * Re-read before writing back, and refuse the write if it moved.
       *
       * The same window the forage stage narrows one stage down, and it matters
       * more here: a model call is the longest await in the run, and what is on
       * the other side of it is a document the learner may be sitting in front
       * of, correcting a date. `putIntakeDraft` is an upsert, so writing the
       * enriched copy over an edited one silently undoes the correction — the
       * exact failure SB-42 forbids for statements, arriving at the drafts.
       *
       * The store has no compare-and-set, so the comparison is made here: if the
       * draft is not byte-identical to the one that went to the model, nothing is
       * written and the document stays owed. It is picked up on the next run,
       * against whatever the learner left. Deferring work is cheap; overwriting
       * somebody's correction is not.
       */
      const current = await deps.store.getIntakeDraft(draft.id);
      if (!current || current.status !== 'draft'
        || JSON.stringify(current) !== JSON.stringify(draft)) { raced++; continue; }
      const next: CourseIntakeDraft = {
        ...result.draft,
        enrichment: {
          outcome: result.outcome,
          attemptedAt: now.toISOString(),
          added: result.added,
        },
      };
      await deps.store.putIntakeDraft(next);
      if (result.outcome === 'enriched') enriched++;
      else if (result.outcome === 'nothing-added') nothing++;
      else modelFailed++;
      commitments += result.added.commitments;
      questions += result.added.questions;
    }

    const detail = `${taken.length} of ${owed.length} course sources planned`
      + ` — ${enriched} enriched, ${nothing} nothing-added`
      + (modelFailed ? `, ${modelFailed} MODEL-FAILED — retried next run` : '')
      + (threw ? `, ${threw} did not complete` : '')
      + (raced ? `, ${raced} edited mid-stage and left alone` : '')
      + ` (${commitments} deadline(s) and ${questions} question(s) proposed, all still drafts)`
      + pacingLine(pacing);
    return { detail, work: workOf(pacing, owed.length, modelFailed + threw + raced, commitments) };
  }));

  // 2. Forage — the only stage that fans out.
  //
  // The stage line splits the outcomes because the old one could not. It read
  // "21 pins, 19 from capture envelope only, 0 failed" on a run where 19 of 21
  // model calls had failed: Forager degrades honestly per pin and swallows the
  // error, so `failed` only ever counted pins that threw all the way out, and
  // every swallowed failure looked like a passage that needed nothing.
  note(await execute('forage', async () => {
    const owed = await deps.store.listPins({ unenrichedOnly: true });
    if (!owed.length) return 'nothing new to enrich';
    /**
     * The queue, paced.
     *
     * This is the term `estimateCalls` names as the only one that grows with the
     * board, and a course drop is what makes it grow by three hundred in one
     * gesture. Capping it is what stops one drag-and-drop from becoming the
     * largest charge this product can make, on a free tier whose day cap is
     * twenty requests. The reasoning for the number is in `domain/batch.ts`.
     *
     * Deferred is not dropped and cannot be: a pin is owed an attempt until it
     * gets one, `unenrichedOnly` is the store's own reading of that, and the
     * remainder is exactly what this list holds next time. Sorted so the slice
     * is the same slice on every machine, oldest capture first — the pins that
     * have been waiting longest go first, which is what somebody who dropped a
     * semester on Monday would expect on Wednesday.
     */
    const pacing = paceWork({ waiting: owed.length, cap: workCap });
    const pins = [...owed].sort(byCapturedThenId).slice(0, pacing.take);
    const exact = reuseExactLlmRequests(deps.llm);
    const forageDeps = { ...deps, llm: exact.llm };
    let reduced = 0, threw = 0;
    const outcomes: Record<EnrichmentOutcome, number> = {
      'enriched': 0, 'nothing-found': 0, 'model-failed': 0,
    };
    /** Keep one pin per call so concepts cannot bleed between passages. */
    await mapLimit(pins, opts.concurrency ?? 3, async (pin) => {
      try {
        const enrichment = await forage(forageDeps, { pin });
        if (enrichment.confidence === 'reduced') reduced++;
        outcomes[enrichment.outcome]++;
        // Re-read rather than write back the record this stage started with.
        // A model call is the longest await in the run and `putPin` is an
        // upsert, so a pin the learner deleted while it was being enriched
        // would be written straight back onto the board — cascaded off its
        // topic, off the ledger and out of session provenance, and then
        // resurrected with an enrichment attached. SB-43 says delete means
        // delete, and this is the stage where a delete is most likely to land.
        await mutateStoredPin(deps.store, pin.id, (current) => ({ ...current, enrichment }));
      } catch (err) {
        // A refusal is not a failure, and this is the stage where the
        // difference is loudest: one stop would otherwise be counted once per
        // pin on the board and reported as "N did not complete".
        if (err instanceof LlmRefused) throw err;
        // Nothing was written, so the pin stays unenriched and is owed an
        // attempt tomorrow by the same rule a model failure is.
        threw++;
      }
    });
    const detail = `${pins.length} pins — ${outcomes.enriched} enriched, ${outcomes['nothing-found']} nothing-found`
      + (outcomes['model-failed'] ? `, ${outcomes['model-failed']} MODEL-FAILED — retried tomorrow` : '')
      + (threw ? `, ${threw} did not complete` : '')
      + (exact.reused() ? `, ${exact.reused()} identical passage${exact.reused() === 1 ? '' : 's'} reused without another model call` : '')
      + ` (${reduced} from capture envelope only)`
      + pacingLine(pacing);
    return {
      detail,
      work: workOf(pacing, owed.length, outcomes['model-failed'] + threw, outcomes.enriched),
    };
  }));

  // 2. Cluster — pins become topics.
  //
  // The partition is computed in `core/` from embeddings, not asked of a model
  // (DEAD_ENDS.md D15). A run over an unchanged board is therefore a no-op:
  // every pin is already assigned, nothing is decided, and no signal history
  // can be detached from the topic it was about.
  note(await execute('cluster', async () => {
    const pins = await deps.store.listPins();
    const existing = await deps.store.listTopics();
    const out = await cluster(deps, {
      pins, existingTopics: existing,
      // Present only when the caller chose one: under `exactOptionalPropertyTypes`
      // an explicit `undefined` is a different thing from an absent field, and
      // "absent" is what means "the clusterer decides from the wiring".
      ...(opts.partitionStrategy ? { strategy: opts.partitionStrategy } : {}),
    });
    const byId = new Map(existing.map((t) => [t.id, t]));

    /**
     * **SB-43, at the other end of the stage.**
     *
     * The partition was computed over the pins read at the top of this stage,
     * and the naming call between then and here is a window a delete can land
     * in. A topic written with a deleted pin's id in `pinIds` is a dangling
     * reference on the learner's board — the exact thing the delete cascade
     * exists to prevent — and nothing downstream removes it.
     *
     * This was always true and was hidden by arithmetic: the delete-storm test
     * fires one delete per model call, and while the Forager made one call per
     * pin every delete had landed before this stage began. Batching the
     * Forager removed those calls, the storm reached the naming window, and a
     * topic came out claiming `p5`. **The race did not arrive with the batch;
     * the batch stopped the old call count from hiding it.**
     *
     * Re-read rather than reasoned about, exactly as the forage stage re-reads
     * before its upsert. It narrows the window to the writes below; the store
     * has no compare-and-set, so it cannot be closed from here.
     */
    const live = new Set((await deps.store.listPins()).map((p) => p.id));

    let attached = 0, fresh = 0, vanished = 0;
    for (const c of out.clusters) {
      const prior = c.existingTopicId ? byId.get(c.existingTopicId) : undefined;
      attached += c.attached.length;
      if (!prior) fresh++;
      const keptPins = c.pinIds.filter((id) => live.has(id));
      vanished += c.pinIds.length - keptPins.length;
      const proposed: Topic = {
        id: prior?.id ?? randomUUID(),
        // An existing topic keeps its name. The clusterer does not regenerate
        // it and the pipeline must not either — a topic the learner has been
        // reading for a month being renamed overnight is the same broken
        // promise as it being re-partitioned overnight.
        //
        // A topic that has never *had* a name is the one exception, and the
        // clusterer has already decided that: it hands back the name it just
        // made, with `provisionalName` cleared. Reading `c` rather than `prior`
        // here would rename everything; reading `prior` unconditionally would
        // preserve a provisional stopgap indefinitely.
        label: prior && !prior.provisionalName ? prior.label : c.label,
        summary: prior && !prior.provisionalName ? prior.summary : c.summary,
        pinIds: keptPins,
        state: prior?.state ?? 'waiting',
        comfort: prior?.comfort ?? 0.15,
        lastExposedAt: prior?.lastExposedAt ?? null,
        retiredByUser: prior?.retiredByUser ?? false,
        createdAt: prior?.createdAt ?? now.toISOString(),
        provisionalName: c.provisionalName,
      };
      let topic: Topic | null;
      if (!prior) {
        await deps.store.putTopic(proposed);
        topic = proposed;
      } else {
        topic = await mergeExistingClusterTopic(deps.store, prior, c, keptPins);
      }
      if (!topic) continue;
      for (const pid of c.pinIds.filter((pinId) => topic!.pinIds.includes(pinId))) {
        await mutateStoredPin(deps.store, pid, (pin) =>
          pin.topicId === topic.id || (pin.topicId !== null && pin.topicId !== prior?.id)
            ? pin : { ...pin, topicId: topic!.id });
      }
    }
    // A pin the clusterer dropped is silent data loss: the learner saved it,
    // it survived enrichment, and it would simply never be taught. Rather than
    // retry (which can loop) or leave it pending (which can loop for ever),
    // give it a topic of its own. A slightly redundant topic is recoverable on
    // the next run when the clusterer sees it as an existing topic to merge
    // into; a lost pin is not recoverable at all.
    let rescued = 0;
    for (const pid of out.unassigned) {
      const pin = await deps.store.getPin(pid);
      if (!pin) continue;
      const e = pin.envelope;
      const id = randomUUID();
      await deps.store.putTopic({
        id,
        // `fallbackLabel`, not a third copy of the same decision. This line
        // was `headingPath.at(-1)?.slice(0, 40) ?? pageTitle.slice(0, 40)`,
        // which cuts through words and keeps the masthead — both already fixed
        // in the one place that is supposed to own this.
        label: fallbackLabel(e) || 'Unfiled',
        summary: (e.selection ?? e.surroundingText).replace(/\s+/g, ' ').slice(0, 160),
        pinIds: [pid],
        state: 'waiting', comfort: 0.15, lastExposedAt: null,
        retiredByUser: false, createdAt: now.toISOString(),
        // Same reasoning as the orphan path in `service.ts`: a rescue label is
        // a stopgap, and the next run may name it.
        provisionalName: true,
      });
      const moved = await mutateStoredPin(deps.store, pid, (current) => ({ ...current, topicId: id }));
      if (moved) rescued++;
    }

    const detail = `${out.clusters.length} topics from ${pins.length} pins`
      + ` (${fresh} new, ${attached} attached, ${partitionLine(out)})`
      + (rescued ? `, ${rescued} rescued into own topic` : '')
      // Said out loud rather than silently absorbed: a pin deleted while this
      // stage was running is a fact about the run, and a stage line that hides
      // it is how a delete race goes unnoticed for a second time.
      + (vanished ? `, ${vanished} deleted mid-stage and dropped from membership` : '');
    /**
     * Counted, and deliberately never paced.
     *
     * A partition is a statement about the **whole** board — attach-only or not,
     * every new pin is compared against every existing centroid — so a cap here
     * would not defer work, it would produce a different and worse answer:
     * topics forked from pins that should have joined them, permanently, because
     * nothing merges topics afterwards. Pacing belongs on the stages that are a
     * queue of independent items, which are the two that call a model per item.
     *
     * So `remaining` is zero here and `paced` is false, and both are stated
     * rather than left out: a morning report reading these counts needs to know
     * that everything dropped last night is already filed, even though only
     * `workCap` of it has been enriched.
     */
    return {
      detail,
      work: workOf(
        { take: pins.length, remaining: 0, paced: false },
        pins.length, vanished, out.clusters.length + rescued,
      ),
    };
  }));

  // 3. Survey — prerequisite graph.
  note(await execute('survey', async () => {
    /**
     * A prerequisite graph needs something to draw an arrow between.
     *
     * `SURVEY_FLOOR` is the smallest board on which the answer can be more
     * than trivial. Below it there is nothing for a model to decide that
     * arithmetic has not already decided, and the run keeps whatever edges it
     * had rather than paying to be told there are none.
     */
    const topics = await deps.store.listTopics();
    if (topics.length < SURVEY_FLOOR) {
      return `${topics.length} topics — too few for an ordering to mean anything, so nothing was asked`;
    }
    const edges = await survey(deps, { topics });
    await deps.store.putEdges(edges);
    return `${edges.length} prerequisite edges`;
  }));

  // 4. Analyse — the observations, and the product's core value. The body, and
  // the one bounded second ask in the night, are in `analyse-stage.ts`.
  let observations: readonly Observation[] = [];
  note(await execute('analyse', () => runAnalyseStage(deps, {
    onObservations: (result) => { observations = result.observations; },
  })));

  // 5a. Comfort — pure arithmetic, cannot fail, so it is NOT in the same
  // failure unit as the model call below it. An earlier version wrapped both
  // together and threw away perfectly good comfort scores because the prose
  // rendering ran out of tokens. Deterministic work lands first.
  let signals = await deps.store.listSignals();
  let topicsForComfort = await deps.store.listTopics();
  let comforts: readonly ComfortResult[] = [];
  note(await execute('comfort', async () => {
    signals = await deps.store.listSignals();
    topicsForComfort = await deps.store.listTopics();
    comforts = topicsForComfort.map((t) => computeComfort(t.id, signals, now));
    for (const t of applyComfort(topicsForComfort, signals, now)) await deps.store.putTopic(t);
    const regressed = comforts.filter((c) => c.regressed).length;
    return `${comforts.length} topics scored${regressed ? `, ${regressed} regressed` : ''}`;
  }, true));

  // 5b. The prose the learner reads and edits (SB-42). Best-effort: losing it
  // costs one panel screen, not the session.
  let statementsWritten = 0;
  note(await execute('statements', async () => {
    const existing = await deps.store.listStatements();
    const statementContext = sessionLearnerContext(existing, await deps.store.listSignals());
    const safeExisting = new Set(statementContext.derived);
    let removed = 0;
    // Remove only reads already proven incompatible before the model boundary.
    // Safe prior reads remain if a later call fails; a learner correction never
    // has to coexist with a contradiction while waiting for that retry.
    for (const old of existing) {
      if (stageOwnedRead(old) && !safeExisting.has(old.text)) {
        await deps.store.deleteStatement(old.id);
        removed++;
      }
    }
    if (statementContext.globalCorrection) {
      return `0 statements — learner correction governs every topic, so no new machine read was asked for`
        + (removed ? `; ${removed} incompatible prior read(s) removed` : '');
    }

    const correctedTopics = new Set(statementContext.correctedTopicIds);
    const eligibleTopics = statementContext.corrections.length
      ? topicsForComfort.filter((topic) => !correctedTopics.has(topic.id))
      : topicsForComfort;
    const eligibleComforts = statementContext.corrections.length
      ? comforts.filter((comfort) => !correctedTopics.has(comfort.topicId))
      : comforts;
    const eligibleObservations = sessionObservations(
      statementContext, observations, await deps.store.listPins(),
    );
    const statements = await renderStatements(
      deps, eligibleTopics, eligibleComforts, eligibleObservations.map((o) => o.claim),
    );
    // SB-282, after the prose and never before it: a classification that fails
    // must not cost the sentences this stage has already produced.
    const modality = `; ${await runModalityStage(deps, { now })}`;
    if (!statements.length) {
      return (statementContext.corrections.length
        ? `none produced — learner correction left no safe new machine read; previous compatible reads kept`
        : 'none produced — previous kept') + modality;
    }

    // Replace rather than append. These are the current read on the learner,
    // not a log of every read we have ever had; two runs produced fourteen
    // statements against a stated maximum of eight, and the panel would have
    // shown a growing pile of near-duplicates.
    //
    // User-edited lines survive: SB-42 says an edit outranks derived state
    // until new evidence contradicts it, so regenerating over the top of one
    // would silently undo the correction the learner made.
    for (const old of existing) {
      if (stageOwnedRead(old)) await deps.store.deleteStatement(old.id);
    }
    const candidates: Statement[] = statements.map((statement, index) => ({
      ...statement, id: `candidate-${index}`, updatedAt: now.toISOString(),
    }));
    const safeDerived = new Set(sessionLearnerContext(
      [...existing.filter((statement) => statement.userEdited), ...candidates],
      await deps.store.listSignals(),
    ).derived);
    const rejections = existing.filter((statement) => statement.rejected && !statement.modality);
    const admitted = candidates.filter((statement) => safeDerived.has(statement.text))
      .filter((statement) => !rejectedByExistingEvidence(statement, rejections));
    for (const s of admitted) {
      await deps.store.putStatement({ ...s, id: randomUUID(), updatedAt: now.toISOString() });
    }
    const withheld = candidates.length - admitted.length;
    statementsWritten = admitted.length;
    return `${admitted.length} statements${modality}`
      + (withheld ? `, ${withheld} incompatible machine read(s) withheld after learner correction` : '')
      + (removed ? `; ${removed} incompatible prior read(s) removed before model work` : '');
  }));

  /**
   * 5c. Prospect — the night scout, and the only stage that looks outward.
   *
   * Here for two reasons, both of which are about what it may touch. It needs
   * the survey, the observations and the statements above it, because the gaps
   * it reads are what those stages produced. And it must land BEFORE nothing:
   * the Composer's brief is built below out of topics, comforts and
   * observations, none of which this stage writes, so tonight's lesson is
   * exactly the lesson it would have been. A proposal is for the morning and
   * for a person, and it does not get to shape what it was proposed about.
   *
   * The body is in `prospect-stage.ts`, with every way out of it named.
   */
  note(await execute('prospect', () => runProspectStage(deps, {
    now, batchKey, comforts, signals,
  })));
  // What the scout raised tonight, read off the board rather than counted a
  // second time — the same rule `quotaExhausted` and `remaining` are written
  // under. `raisedAt` is this run's own clock instant, so a proposal an earlier
  // run left on the same batch key is not miscounted as tonight's.
  const proposalsRaised = (await deps.store.listProspectProposals())
    .filter((proposal) => proposal.raisedAt >= now.toISOString()).length;

  // 6. Garden — what gets taught, reviewed, resurfaced, retired.
  //
  // The commitments go in with the topics. `dueWeight` is the capability the
  // whole commitment layer exists to unlock — an assignment on Friday makes the
  // topics it leans on the ones worth spending tonight on — and this call was
  // the one place in the product that left them out, so the weight shaped the
  // board reads `/board` and `/today` do and shaped nothing the learner was
  // actually taught. Acceptance clause 6, made true where the session is built.
  let topicsNow = await deps.store.listTopics();
  let edges = await deps.store.listEdges();
  let commitments = await deps.store.listCommitments();
  let decisions = tend({ topics: topicsNow, comforts, signals, now, commitments });
  let pool = duePool(decisions);
  note(await execute('garden', async () => {
    topicsNow = await deps.store.listTopics();
    edges = await deps.store.listEdges();
    commitments = await deps.store.listCommitments();
    decisions = tend({ topics: topicsNow, comforts, signals, now, commitments });
    pool = duePool(decisions);
    return `${pool.teach.length} to teach, ${pool.offerRetire.length} to offer retiring`
      + (pool.enough ? '' : ' — NOT ENOUGH for a session');
  }, true));

  // 7. Compose — the one ready session.
  let session: ComposedSession | null = null;
  const learnerContext = sessionLearnerContext(
    await deps.store.listStatements(), await deps.store.listSignals(),
  );
  opts.onLearnerContext?.(learnerContext.corrections.length);
  const observationsForSession = sessionObservations(
    learnerContext, observations, await deps.store.listPins(),
  );
  note(await execute('compose', async () => {
    const prefs = await deps.store.getPrefs();
    // Prerequisite order decides what leads; the Gardener decides what is in.
    const ordered = orderTopics(topicsNow, edges);
    const rank = new Map(ordered.map((t, i) => [t.id, i]));
    // SB-23: on a night with nothing new to teach and something worth
    // refreshing, the session IS the revision offer — "a 5-minute refresh on
    // two things from last week" — built from what the Gardener set aside for
    // it. The pool computed this and nothing read it, so the panel said
    // "Nothing ready yet" on exactly the night the story promises an offer.
    const forSession = pool.fallback === 'revision' ? pool.revise : pool.teach;
    const decisionsInOrder = [...forSession].sort(
      (a, b) => (rank.get(a.topicId) ?? 0) - (rank.get(b.topicId) ?? 0));

    session = await compose(deps, {
      topics: topicsNow,
      pins: await deps.store.listPins(),
      comforts,
      decisions: decisionsInOrder,
      observations: observationsForSession,
      // A deadline already shaped which topic won. Its learner-owned words now
      // shape the practice step too, without becoming source evidence.
      commitments,
      // The Composer may assert nothing about the learner beyond this.
      knownAboutLearner: learnerContext.derived,
      learnerCorrections: learnerContext.corrections,
      // The flash-time duration policy superseded the old 5/15/45 session preference:
      // the learner-facing 1/3/5 choice is the session model. Reading the stale
      // hidden field here produced an eight-minute lesson for a learner who had
      // chosen five, then paid to verify all three sections. Existing stores
      // may predate the visible field, so three is the shipped flash default.
      targetMinutes: opts.compositionMinutes ?? prefs.availableMinutes ?? 3,
      interfaceLanguage: prefs.interfaceLanguage,
      // The Gardener owns the call; the Composer is told which night this is.
      fallback: pool.fallback,
    });
    if (session.outcome === 'nothing-to-teach') {
      return 'nothing to teach and nothing to revise — honest empty state (SB-23)';
    }
    // The third state (the three-state batch-result contract). Topics were chosen and the model was
    // asked; nothing it returned could be attached to any of them. Said in the
    // same shape and the same capitals as the Forager's MODEL-FAILED, because
    // it is the same fact about the same kind of night — and said here or
    // nowhere, since the stages after this one are about to do nothing.
    if (session.outcome === 'model-failed') {
      return `MODEL-FAILED — ${decisionsInOrder.length} topic(s) went to the model and no section came`
        + ' back attached to any of them; nothing is persisted, and the topics are owed a night';
    }
    // Provenance that did not survive checking is reported here or nowhere. A
    // section still ships with a source dropped — the Verifier decides whether
    // a section is sound — but a run dropping most of its ids means the brief
    // and the model have stopped agreeing about what an id is.
    const { sourceIdRepairs: fixed, sourceIdDrops: lost } = session;
    return (session.revision ? 'revision offer — ' : '')
      + `${session.sections.length} sections, ~${session.estimatedMinutes.toFixed(1)}min of ${session.targetMinutes} budgeted`
      + (fixed ? `, ${fixed} source id(s) repaired` : '')
      + (lost ? `, ${lost} source id(s) DROPPED — resolved to nothing offered` : '');
  }));

  // 8. Verify — adversarial pass before the learner sees any of it.
  //
  // Runs per section and in parallel: each check is independent, and a section
  // that fails must not delay the others. A section with a fatal defect is
  // withheld rather than patched — patching risks a second wrong answer from
  // the model that produced the first, and a missing section is recoverable
  // tomorrow where a week of practising the wrong thing is not.
  //
  // Gated on the one good outcome rather than on the absence of a bad one: a
  // fourth state added later is not verified and not persisted until somebody
  // says it should be, which is the direction this mistake should fall in. It
  // fell the other way once already — `!insufficient` let a session the model
  // had emptied through both stages (the three-state batch-result contract).
  const withheld: WithheldSection[] = [];
  let learnerContextChanged = false;
  note(await execute('verify', async () => {
    if (!session || (session as ComposedSession).outcome !== 'composed') {
      return 'not needed — no composed session to verify';
    }
    const built = session as ComposedSession;
    const pins = await deps.store.listPins();
    const outcome = await verifySections(deps, {
      sections: built.sections, pins,
      knownAboutLearner: learnerContext.derived,
      learnerCorrections: learnerContext.corrections,
    });
    withheld.push(...outcome.withheld);

    /**
     * The verifier-withholding contract — the note is rewritten to the session that actually shipped.
     *
     * The Composer wrote the closing note over every section it composed,
     * and the two lines above have just removed some of them. Left alone the
     * note names sections the learner will never see, which is what the
     * 2026-08-20 benchmark measured: the safety check working, and the one
     * artefact that says what the night was about still claiming the
     * material it removed.
     *
     * Done HERE rather than in `verifySections` because this is where the
     * session is rebuilt — the note belongs to the session, not to the
     * checking — and because a strip that ran anywhere downstream of the
     * store would be a patch on the way out rather than a fact about what
     * was stored. `stripWithheldTopics` is pure and takes no `deps`: no
     * model call on this path, which is the ruling.
     *
     * Both label fields are handed over. The note may use the Composer's
     * heading or the Clusterer's topic label, and a topic matched on neither
     * is one the strip cannot clear — it drops the note instead.
     */
    const closing = stripWithheldTopics(built.closingNote, outcome.withheld.map((w) => ({
      topicId: w.topicId,
      heading: w.heading,
      label: topicsNow.find((t) => t.id === w.topicId)?.label ?? null,
    })));

    session = {
      ...built, sections: outcome.kept, closingNote: closing.note,
      estimatedMinutes: Math.round(outcome.kept.reduce((a, s) => a + s.estimatedMinutes, 0) * 10) / 10,
    };
    // Said only when something happened to it. A note the learner was going
    // to read and now will not is not a silent edit; a note nothing touched
    // does not need a line about it.
    return closing.outcome === 'untouched' || closing.outcome === 'no-note'
      ? outcome.detail
      : `${outcome.detail} — ${closing.detail}`;
  }));

  // Same gate, and deliberately re-read rather than carried down from the
  // verify block: the verify stage rewrites `session`, so what is persisted is
  // asked about the object that will actually be written.
  if (session && (session as ComposedSession).outcome === 'composed') {
    /**
     * The learner model is authority, not a preference that waits until
     * tomorrow. Composer and Verifier can run for minutes; during that time a
     * learner can add, edit, delete or reject an Insight. Publishing the old
     * draft afterwards would make `Your words outrank my read` false at the
     * only boundary where it matters. Re-read immediately before the first
     * durable session/exposure write and fail closed if either the authoritative
     * corrections or the compatible machine reads changed.
     */
    const currentLearnerContext = sessionLearnerContext(
      await deps.store.listStatements(), await deps.store.listSignals(),
    );
    learnerContextChanged = !sameTeachingBriefContext(learnerContext, currentLearnerContext);
    if (learnerContextChanged) {
      session = null;
    } else {
      const finished = session as ComposedSession;
      await deps.store.putSession({
        ...finished, id: randomUUID(),
        // The persisted batch-identity contract. `builtAt` is when this finished; this is which night it was
        // for, and the two differ exactly when a retry crosses midnight UTC. The
        // store names the row from this, so that case stops being expressible.
        batchKey,
        sections: finished.sections.map((s) => ({ ...s, completed: false })),
        // Kept with the session rather than only in the run log. Without it, a
        // night that withheld everything is stored as a session with no sections
        // and the panel says "nothing ready yet" — true about the screen, false
        // about the night, and the learner never finds out something was checked.
        withheld: withheld.map((w) => ({ topicId: w.topicId, heading: w.heading, reason: w.reason })),
      });

    /**
     * A return request is answered by a checked section that actually reaches
     * the learner, not by the Composer merely attempting one.
     *
     * `resurfaceAsk` deliberately ignores marks at or before
     * `lastExposedAt`. Until this write existed, that rule had no successful
     * pipeline path: a verified session was stored, but every topic retained
     * its old exposure time, so "bring this back" could put the same topic in
     * every later session forever. The long-standing verifier contract already
     * states the inverse — a withheld section must *not* advance exposure — so
     * the kept section ids are the exact write boundary.
     *
     * Session first, topics second. If persistence stops between them, the
     * learner still has the checked lesson and a scheduler retry can repair the
     * derived exposure; reversing the order could consume the request while
     * losing the lesson that was meant to answer it. Re-read each topic before
     * writing so a learner-owned edit made during a long model run is not
     * overwritten by the Gardener's earlier snapshot.
     */
      const exposedAt = finished.builtAt;
      for (const topicId of new Set(finished.sections.map((section) => section.topicId))) {
        const topic = await deps.store.getTopic(topicId);
        if (!topic) continue;
        const prior = topic.lastExposedAt ? Date.parse(topic.lastExposedAt) : -Infinity;
        if (Number.isFinite(prior) && prior >= Date.parse(exposedAt)) continue;
        await deps.store.putTopic({ ...topic, lastExposedAt: exposedAt });
      }
    }
  }

  /**
   * The learner's own documents, rewritten, after everything else is persisted.
   *
   * **Last on purpose, and after the session is in the store.** These documents
   * describe the board, and the board is not finished until the session that
   * was just composed is part of it. Exporting before the write would publish a
   * notebook that is one night behind on the one night it most matters.
   *
   * It runs in both lanes because it is inside `runBatch`, which the hosted
   * (ADK) nightly also drives. It deliberately sits outside the stage machinery
   * rather than being one more stage: a stage is a body a framework host
   * executes and reports on, and this is neither model work nor something a
   * `SequentialAgent` should be able to fail the night with.
   *
   * **A failed export is reported and does not fail the night**, and the two
   * shapes that failure takes now live beside the export itself in
   * `notebook-export.ts`, where the ruling is written out in full. What is left
   * here is the ordering, which is the only part of it this file owns.
   */
  const notebook: WriteReceipt | null = opts.notebook
    ? await exportNotebookAfterRun(deps.store, deps.clock, opts.notebook)
    : null;

  return {
    reports,
    notebook,
    session,
    observations,
    topics: await deps.store.listTopics(),
    withheld,
    learnerContextChanged,
    // Read off the reports, so it cannot disagree with them.
    quotaExhausted: reports.some((r) => r.degradeReason === 'exhausted'),
    // The same rule, one field down. Nothing counts the deferred work a second
    // time; this sums the lines that were printed.
    remaining: reports.reduce((n, r) => n + (r.work?.remaining ?? 0), 0),
    lean: leanNight({
      observations: observations.length,
      statements: statementsWritten,
      proposals: proposalsRaised,
    }),
  };
}
