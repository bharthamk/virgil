import { randomUUID } from 'node:crypto';
import {
  LlmRefused, classifyDemandKinds, modalityAlreadyLive, modalityCandidate,
  modalityDenialLive, modalityTallies, modalityWorthAsking,
  MODALITY_DENIED_DAYS, MODALITY_MIN_CONTRAST, MODALITY_MIN_EVIDENCE,
  type Deps, type Statement,
} from '@sb/core';

/**
 * THE MODALITY QUESTION, SEQUENCED.
 *
 * PRODUCT_SHAPE.md holds modality profiling in the tier that may not be spoken
 * in the present tense, with one door out of it: it may exist as a
 * learner-confirmed statement with its evidence shown, and never as a hidden
 * profile. This is that door, and like the night scout it is written as a list
 * of ways out rather than as a stage, because what it is allowed to cost when
 * it goes wrong is the entire design question.
 *
 * It runs inside the `statements` stage rather than beside it. The claim it
 * produces is a statement, it is answered through the statement doors, and it
 * is subject to the same learner-correction precedence as every other read.
 * A tenth stage would have implied it was a separate kind of thing.
 *
 * Seven ways out, and only one of them writes anything:
 *
 *  1. **The learner said no recently.** One denial suppresses every modality
 *     question for `MODALITY_DENIED_DAYS`, whichever pair of kinds it was
 *     about. The four kinds are four ways of saying one thing about somebody,
 *     and re-asking with the pair swapped would be the product arguing.
 *  2. **One is already standing.** Asked and unanswered, or confirmed. Either
 *     way the board holds one at a time.
 *  3. **There is not enough checked evidence to ask.** Decided by arithmetic,
 *     before any call, so a quiet board costs nothing to be told it is quiet.
 *  4. **The model refused.** Caught here, exactly as `prospect-stage.ts`
 *     catches it and for the same reason: this is an optional read, it sits
 *     inside a stage whose other output has already been written, and letting
 *     it carry the refusal out would cost the learner statements that were
 *     produced successfully a moment earlier. Whatever refused this refuses
 *     Compose shortly afterwards, and the run stops there, named by a stage
 *     that matters.
 *  5. **The model failed.** Degrades inside the agent into an outcome.
 *  6. **The contrast is not there.** The floor is `MODALITY_MIN_EVIDENCE`
 *     checked outcomes in each of two kinds and a gap of at least
 *     `MODALITY_MIN_CONTRAST` between them. Below it, nothing is said.
 *  7. **Everything held.** One statement is written, phrased as a question,
 *     with its counts in the sentence.
 *
 * What it never does, in this slice: change what gets taught. A confirmed
 * modality statement is a confirmed statement and nothing else. It does not
 * reach the ranker, the composer's brief or the material filter, and the
 * acceptance for SB-282 says so in as many words so that a later slice cannot
 * quietly inherit a selection effect this one did not argue for.
 */

export interface ModalityStageInput {
  readonly now: Date;
}

/**
 * The stage line, always. The caller appends it to the statements line rather
 * than reporting a stage of its own, because it is not one.
 */
export async function runModalityStage(deps: Deps, input: ModalityStageInput): Promise<string> {
  const [prefs, statements, topics, signals] = await Promise.all([
    deps.store.getPrefs(), deps.store.listStatements(),
    deps.store.listTopics(), deps.store.listSignals(),
  ]);

  if (modalityDenialLive(prefs.modalityDenied, input.now)) {
    return `no modality question, you said no to one inside the last ${MODALITY_DENIED_DAYS} days`;
  }
  if (modalityAlreadyLive(statements)) {
    return 'no modality question, one is already standing';
  }

  const tallies = modalityTallies(topics, signals, input.now);
  if (!modalityWorthAsking(tallies)) {
    return `no modality question, fewer than ${MODALITY_MIN_EVIDENCE * 2}`
      + ` checked outcomes across ${tallies.length} topic(s)`;
  }

  let classified: Awaited<ReturnType<typeof classifyDemandKinds>>;
  try {
    classified = await classifyDemandKinds(deps, tallies);
  } catch (err) {
    // Way out 4. Everything that is not a refusal keeps the behaviour it had.
    if (!(err instanceof LlmRefused)) throw err;
    return 'no modality question, nothing was sent';
  }
  if (classified.outcome === 'model-failed') {
    return 'no modality question, kinds MODEL-FAILED and no statement was lost';
  }

  const dropped = classified.refused.invented + classified.refused.unknown
    + classified.refused.duplicate;
  const droppedNote = dropped
    ? ` (${classified.refused.invented} outside the vocabulary,`
      + ` ${classified.refused.unknown} unasked-for, ${classified.refused.duplicate} doubled up)`
    : '';

  const candidate = modalityCandidate(tallies, classified.kinds);
  if (!candidate) {
    return `no modality question, no contrast of ${MODALITY_MIN_CONTRAST}`
      + ` across ${classified.kinds.size} classified topic(s)${droppedNote}`;
  }

  const statement: Statement = {
    id: randomUUID(),
    text: candidate.text,
    /**
     * SB-285 looked at every path that writes a statement and fixed the two
     * that were dropping a topic they knew. This is the third, and it keeps
     * null on purpose: a modality contrast is a claim about two KINDS of
     * material across the board, built from at least two topics by
     * construction, so there is no one topic it is about. Deriving one from the
     * first of its evidence signals would scope a board-wide read to whichever
     * topic happened to sort first, which is the guessed scope the field exists
     * to avoid.
     */
    topicId: null,
    userEdited: false,
    evidenceSignalIds: candidate.evidenceSignalIds,
    updatedAt: input.now.toISOString(),
    modality: {
      key: candidate.key,
      slower: candidate.slower,
      faster: candidate.faster,
      askedAt: input.now.toISOString(),
      confirmedAt: null,
    },
  };
  await deps.store.putStatement(statement);
  return `1 modality question asked, ${candidate.key},`
    + ` from ${classified.kinds.size} classified topic(s)${droppedNote}`;
}
