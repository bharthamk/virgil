import { randomUUID } from 'node:crypto';
import {
  LlmRefused, isZone, prospect, prospectGaps,
  PROSPECT_MAX_MODEL_CALLS, PROSPECT_MAX_PROPOSALS,
  type ComfortResult, type Deps, type LearnerPrefs, type Signal,
} from '@sb/core';
import { readSlippingRecords, slippingFrom } from './today-source.js';

/** The learner's own zone where they have one. A deadline is a fact in theirs,
 *  and the night has no request header to read it off. */
const learnerZone = (prefs: LearnerPrefs): string =>
  typeof prefs.timeZone === 'string' && isZone(prefs.timeZone) ? prefs.timeZone : 'UTC';

/**
 * THE NIGHT SCOUT, SEQUENCED.
 *
 * The stage body for `prospect`, in its own module for two reasons. The first
 * is the ordinary one: `runBatch` is a capped function and an eleventh stage
 * cannot be paid for by growing it. The second is the interesting one, and it is why
 * this file reads like a list of refusals rather than like a stage.
 *
 * Every other stage in the night is *load-bearing*. If Compose does not run
 * there is no lesson; if Verify does not run nothing ships. This one is not.
 * It is the discovery limb, it proposes things nobody asked for, and the whole
 * design question is what it is allowed to cost when it goes wrong. The answer
 * is: nothing at all. Six ways out of this function produce no proposals and no
 * damage, and only one of them is an error.
 *
 *  1. **The learner turned it off.** One preference, on by default, and off
 *     means the stage says it was not wanted and spends nothing.
 *  2. **There are no gaps.** The list is built in code from records the night
 *     has already produced. Empty means the board has nothing to be short of,
 *     and no call is made to be told so.
 *  3. **The model refused.** A budget stop or a missing credential arrives as
 *     `LlmRefused`, which everywhere else in this pipeline ends the run, and
 *     that is right everywhere else. Here it is caught, because this stage sits
 *     *before* Compose: letting an optional discovery stage carry the refusal
 *     out would mean the learner loses tonight's lesson to a stage that was
 *     only ever offering them something extra. The refusal is not swallowed,
 *     only declined by this stage. Whatever refused this call refuses Compose's
 *     a moment later, and the run stops there, named by the stage that actually
 *     matters. This is the one deliberate exception to the fleet rule in
 *     `core/src/ports/llm.ts`, and it is here rather than in the agent: the
 *     agent still lets a refusal through, exactly as every one of its siblings
 *     does.
 *  4. **The model failed.** An ordinary provider error degrades inside the
 *     agent and comes back as an outcome rather than a throw.
 *  5. **The model invented its evidence.** Dropped in the domain, counted, and
 *     said out loud in the stage line.
 *  6. **Everything worked.** At most three proposals are written, each one
 *     pending, each one a proposal.
 *
 * Nothing here writes a course, a commitment, a deadline, a topic or a signal,
 * and nothing it produces reaches tonight's session: the proposals land after
 * Compose has already been given its brief, so what the model reads tonight is
 * exactly what it would have read without this stage. Discovery is offered to
 * the person, never fed back into the machine behind their back.
 */

export interface ProspectStageInput {
  readonly now: Date;
  readonly batchKey: string;
  /** Only for the count the stage line reports. The gap list is read fresh. */
  readonly comforts: readonly ComfortResult[];
  readonly signals: readonly Signal[];
}

/** Said when the learner has switched the stage off. Reads as a fact, not a nag. */
export const PROSPECT_SKIPPED_LINE = 'not looking for new material, by your preference';

/**
 * Whether this board wants the stage at all.
 *
 * Absent is on. Every board written before the preference existed belongs to
 * somebody who never turned it off, and reading absence as off would ship a
 * feature switched off for everyone who already has an account.
 */
export const prospectWanted = (prefs: { readonly prospect?: boolean }): boolean =>
  prefs.prospect !== false;

export async function runProspectStage(
  deps: Deps,
  input: ProspectStageInput,
): Promise<string> {
  const prefs = await deps.store.getPrefs();
  if (!prospectWanted(prefs)) return PROSPECT_SKIPPED_LINE;

  /**
   * The gaps, built in code from what the night has already computed.
   *
   * The topics carry the comfort the Registrar's arithmetic just wrote, so this
   * reads them back from the store rather than being handed a snapshot: the
   * stage two before this one persisted them, and a second copy of the same
   * numbers is a second thing that can disagree with the board.
   */
  const [statements, pins, topics, already, slippingRecords] = await Promise.all([
    deps.store.listStatements(), deps.store.listPins(), deps.store.listTopics(),
    deps.store.listProspectProposals(), readSlippingRecords(deps),
  ]);
  /**
   * What keeps slipping, as one more evidence source.
   *
   * The same read Today and Insights make, so the night proposes material
   * against the same items the learner is already being shown. It is the fifth
   * kind of gap and the last in the order: a topic somebody explicitly stepped
   * around is a stronger claim than one the ledger merely noticed going quiet,
   * and `prospectGaps` drops the second where it already holds the first.
   */
  const slipping = slippingFrom(input.now, learnerZone(prefs), prefs, slippingRecords);
  /**
   * A gap is proposed once, ever.
   *
   * The gap list is recomputed from scratch every run, so a topic somebody has
   * already said no to would come back with the same proposal on it every
   * night until they fixed it, which is a product that nags. Spoken-for
   * includes dismissed on purpose: *not for me* is an answer, and asking again
   * is not respecting it. It also includes pending, so two runs before a person
   * has looked do not leave two copies of one suggestion on the screen.
   */
  const spokenFor = new Set(already.map((proposal) => proposal.evidenceKey));
  const gaps = prospectGaps({ statements, topics, signals: input.signals, pins, slipping })
    .filter((gap) => !spokenFor.has(gap.key));
  if (!gaps.length) {
    return `nothing new to look for across ${input.comforts.length} scored topic(s)`
      + (spokenFor.size ? `, ${spokenFor.size} gap(s) already answered` : '');
  }

  let result: Awaited<ReturnType<typeof prospect>>;
  try {
    result = await prospect(deps, {
      gaps,
      now: input.now.toISOString(),
      batchKey: input.batchKey,
      id: randomUUID,
    });
  } catch (err) {
    // Reason 3 above. Everything that is not a refusal keeps the behaviour it
    // had, which is to leave the stage and be reported as a degraded one.
    if (!(err instanceof LlmRefused)) throw err;
    return `${gaps.length} gap(s) found and nothing was sent`;
  }

  if (result.outcome === 'model-failed') {
    return `${gaps.length} gap(s) found, MODEL-FAILED, nothing proposed and nothing lost`;
  }

  for (const proposal of result.proposals) await deps.store.putProspectProposal(proposal);

  const refusedParts = [
    result.refused.invented ? `${result.refused.invented} cited evidence nobody gave it` : null,
    result.refused.empty ? `${result.refused.empty} came back empty` : null,
    result.refused.duplicate ? `${result.refused.duplicate} doubled up on one gap` : null,
    result.refused.overCap ? `${result.refused.overCap} over the nightly cap of ${PROSPECT_MAX_PROPOSALS}` : null,
  ].filter((part): part is string => part !== null);

  return `${result.proposals.length} proposal(s) from ${gaps.length} gap(s)`
    + ` in ${result.calls} of ${PROSPECT_MAX_MODEL_CALLS} call(s)`
    + (result.leads === 'model-failed' ? ', leads MODEL-FAILED and the proposals stand without them' : '')
    + (refusedParts.length ? ` (dropped: ${refusedParts.join(', ')})` : '')
    + ' (all still proposals, nothing written to the board)';
}
