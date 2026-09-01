import type { Observation, Pin, Signal, Statement, TopicId } from '@sb/core';
import { isUnansweredModality } from '@sb/core';

/**
 * WHOSE WORDS GOVERN, WHEN THE NIGHT TEACHES.
 *
 * Lifted out of `pipeline.ts` unchanged so that the stage bodies which depend on
 * it can live in modules of their own without importing the pipeline back. It is
 * the same rule it has always been, in the same words, and `pipeline.ts` still
 * re-exports both functions so nothing that reads them had to move.
 */

export interface SessionLearnerContext {
  /** The learner's own words. These govern every derived read below them. */
  readonly corrections: readonly string[];
  /** Machine-written reads that are demonstrably outside a corrected scope. */
  readonly derived: readonly string[];
  /** Topic scopes governed by a correction. */
  readonly correctedTopicIds: readonly TopicId[];
  /** True when the correction cannot honestly be confined to one topic. */
  readonly globalCorrection: boolean;
}

/**
 * The learner model that is allowed into a teaching brief.
 *
 * Persisting an edit was only half of SB-42. The statements stage correctly
 * kept user-edited rows, but it also wrote a fresh derived read beside them and
 * the pipeline handed both sentences to the Composer and Verifier as equals.
 * A correction could therefore survive in storage and still lose in the next
 * lesson — the exact opposite of the collaborative-model promise.
 *
 * Scope comes from the statement's explicit topic where one exists, otherwise
 * from the evidence signals already attached to it. A derived line is retained
 * only when its scope is known and disjoint from every correction. An unscoped
 * correction governs the whole read; an unscoped derived line is not allowed
 * to guess that it is unrelated. This is deliberately conservative: omitting
 * one machine inference costs less than teaching against the learner's words.
 *
 * SB-282 adds one exclusion above all of that, and it is a law rather than a
 * preference. A modality question the learner has not answered is not a read of
 * them: it is a sentence ending in a question mark, and PRODUCT_SHAPE.md
 * forbids modality profiling existing in any form other than one a person has
 * confirmed. Letting it into the derived list would hand the Composer and the
 * Verifier a claim about how somebody learns that nobody has agreed to, which
 * is the silent profile with an extra step. Once confirmed it is an ordinary
 * statement here, like any other.
 */
export function sessionLearnerContext(
  input: readonly Statement[], signals: readonly Signal[],
): SessionLearnerContext {
  const statements = input.filter((statement) => !isUnansweredModality(statement));
  const topicBySignal = new Map(signals.map((signal) => [signal.id, signal.topicId]));
  const scopeOf = (statement: Statement): ReadonlySet<TopicId> => {
    const scope = new Set<TopicId>();
    if (statement.topicId) scope.add(statement.topicId);
    for (const id of statement.evidenceSignalIds) {
      const topicId = topicBySignal.get(id);
      if (topicId) scope.add(topicId);
    }
    return scope;
  };

  const corrected = statements.filter((statement) => statement.userEdited && !statement.rejected);
  if (!corrected.length) {
    return {
      corrections: [], derived: statements.filter((statement) => !statement.rejected)
        .map((statement) => statement.text),
      correctedTopicIds: [], globalCorrection: false,
    };
  }

  const correctedTopics = new Set<TopicId>();
  let globalCorrection = false;
  for (const statement of corrected) {
    const scope = scopeOf(statement);
    if (!scope.size) globalCorrection = true;
    for (const topicId of scope) correctedTopics.add(topicId);
  }

  const derived = statements
    .filter((statement) => !statement.userEdited && !statement.rejected)
    .filter((statement) => {
      if (globalCorrection) return false;
      const scope = scopeOf(statement);
      if (!scope.size) return false;
      return [...scope].every((topicId) => !correctedTopics.has(topicId));
    })
    .map((statement) => statement.text);

  return {
    corrections: corrected.map((statement) => statement.text),
    derived,
    correctedTopicIds: [...correctedTopics],
    globalCorrection,
  };
}

/** Machine observations permitted to shape the lesson after a correction. */
export function sessionObservations(
  context: SessionLearnerContext,
  observations: readonly Observation[],
  pins: readonly Pin[],
): readonly Observation[] {
  if (!context.corrections.length) return observations;
  if (context.globalCorrection) return [];
  const correctedTopics = new Set(context.correctedTopicIds);
  const topicByPin = new Map(pins.map((pin) => [pin.id, pin.topicId]));
  return observations.filter((observation) => {
    const scopes = observation.evidencePinIds
      .map((pinId) => topicByPin.get(pinId))
      .filter((topicId): topicId is TopicId => topicId !== null && topicId !== undefined);
    return scopes.length > 0 && scopes.every((topicId) => !correctedTopics.has(topicId));
  });
}
