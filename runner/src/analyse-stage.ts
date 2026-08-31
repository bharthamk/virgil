import {
  analyseWithSecondAsk, type AnalysisResult, type Deps,
} from '@sb/core';
import { sessionLearnerContext } from './session-learner-context.js';

/**
 * THE OBSERVATIONS, SEQUENCED — and the one stage in the night allowed a second
 * ask.
 *
 * In its own module for the ordinary reason the night scout and the modality
 * question are: `runBatch` is a capped function and a stage that grows cannot be
 * paid for by growing it. What lives here is the sequencing and the sentence the
 * receipt carries; the guard and the second call itself are in
 * `core/src/agents/analyst.ts`, where the reason only this stage gets one is
 * written out in full.
 *
 * The short version of that reason, because it is why this file reads the way
 * it does: the stages below this one are all-or-nothing and they all eat from
 * this one plate. The Registrar writes nothing without evidence or an
 * observation, the scout finds nothing new to look for once the Registrar wrote
 * nothing, and the learner model the Composer teaches against is what those two
 * produced. One empty answer here is three surfaces going quiet at once, which
 * is what happened on 2026-08-28, silently.
 *
 * Three things this stage does NOT do, and they are the boundaries of the
 * repair rather than omissions:
 *
 *  1. **It does not catch anything.** `LlmRefused` from either the first ask or
 *     the second leaves this stage exactly as it always did and ends the run;
 *     an ordinary provider failure degrades the stage exactly as it always did.
 *     The second ask happens only after a call that SUCCEEDED and returned
 *     nothing.
 *  2. **It does not ask a third time.** Once, and only on an empty result, and
 *     only on a board that plainly had material.
 *  3. **It does not hide either answer.** A run that asked twice says so in its
 *     receipt, in both directions: "0 observations after a second ask" is a
 *     different fact about the night from "0 observations", and the silent
 *     version of it is the thing this story was written about.
 */

export interface AnalyseStageInput {
  /** Prose for the receipt, and the observations the later stages read. */
  readonly onObservations: (result: AnalysisResult) => void;
}

export async function runAnalyseStage(
  deps: Deps, input: AnalyseStageInput,
): Promise<string> {
  const correctionContext = sessionLearnerContext(
    await deps.store.listStatements(), await deps.store.listSignals(),
  );
  if (correctionContext.globalCorrection) {
    return '0 observations — learner correction governs every topic, so no machine pattern was asked for';
  }
  const correctedTopics = new Set(correctionContext.correctedTopicIds);
  const allPins = await deps.store.listPins();
  const allTopics = await deps.store.listTopics();
  // A corrected topic and an unfiled pin cannot produce an observation that
  // sessionObservations is allowed to admit. Do not ask the model for prose
  // the learner's precedence rule will deterministically throw away.
  const pins = correctionContext.corrections.length
    ? allPins.filter((pin) => pin.topicId !== null && !correctedTopics.has(pin.topicId))
    : allPins;
  const topics = correctionContext.corrections.length
    ? allTopics.filter((topic) => !correctedTopics.has(topic.id))
    : allTopics;
  const result = await analyseWithSecondAsk(deps, { pins, topics });
  input.onObservations(result);
  const { observations } = result;
  const mm = observations.filter((o) => o.mediumMismatch).length;
  // The count first, then whether it took two asks to reach it. In that order
  // because a morning report reads the number and a person reads the sentence,
  // and "0 observations after a second ask" has to be legible as both.
  return `${observations.length} observations${result.reasked ? ' after a second ask' : ''}`
    + (mm ? `, ${mm} medium-mismatch` : '')
    + (correctionContext.corrections.length
      ? ` — ${allPins.length - pins.length} pin(s) governed by learner correction were not sent`
      : '');
}
