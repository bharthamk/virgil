import type { SourceRef } from './courses.js';
import type { Signal, SignalDirection, SignalType, TopicId } from './types.js';

export type OutcomeKind =
  | 'grade'
  | 'rubric'
  | 'teacher-feedback'
  | 'self-assessment'
  | 'real-world';

export interface CriterionOutcome {
  readonly criterionId: string | null;
  readonly label: string;
  readonly score: number | null;
  readonly maxScore: number | null;
  readonly verdict: 'strong' | 'mixed' | 'gap' | null;
  readonly feedback: string;
  readonly topicIds: readonly TopicId[];
}

/** Durable receipt for evidence that happened outside Virgil. */
export interface LearningOutcome {
  readonly id: string;
  readonly kind: OutcomeKind;
  readonly courseId: string | null;
  readonly commitmentId: string | null;
  readonly topicIds: readonly TopicId[];
  readonly title: string;
  readonly score: number | null;
  readonly maxScore: number | null;
  readonly summary: string;
  readonly feedback: string;
  readonly criteria: readonly CriterionOutcome[];
  readonly source: SourceRef | null;
  readonly recordedAt: string;
  readonly supersedesId: string | null;
  readonly deletedAt: string | null;
}

export interface OutcomeSignalSeed {
  readonly topicId: TopicId;
  readonly type: SignalType;
  readonly direction: SignalDirection;
  readonly sourceEvent: string;
}

const directionFor = (
  score: number | null, maxScore: number | null, verdict: CriterionOutcome['verdict'],
): SignalDirection | null => {
  if (verdict === 'strong') return 'positive';
  if (verdict === 'gap') return 'negative';
  if (verdict === 'mixed') return null;
  if (score === null || maxScore === null || maxScore <= 0) return null;
  const ratio = score / maxScore;
  if (ratio >= 0.8) return 'positive';
  if (ratio <= 0.6) return 'negative';
  return null;
};

/**
 * Convert assessed reality into causal signal seeds.
 *
 * Self-assessment is deliberately excluded here: it is useful context, but it
 * is not stronger evidence than the answer and struggle signals already on the
 * board. Completion is absent from the outcome model altogether.
 */
export function outcomeSignalSeeds(outcome: LearningOutcome): readonly OutcomeSignalSeed[] {
  if (outcome.deletedAt || outcome.kind === 'self-assessment') return [];
  const byTopic = new Map<TopicId, SignalDirection>();
  for (const c of outcome.criteria) {
    const direction = directionFor(c.score, c.maxScore, c.verdict);
    if (!direction) continue;
    for (const topicId of c.topicIds) byTopic.set(topicId, direction);
  }
  const overall = directionFor(outcome.score, outcome.maxScore, null);
  if (overall) for (const topicId of outcome.topicIds) if (!byTopic.has(topicId)) byTopic.set(topicId, overall);
  return [...byTopic].map(([topicId, direction]) => ({
    topicId,
    type: direction === 'positive' ? 'assessed-strong' : 'assessed-gap',
    direction,
    sourceEvent: `outcome:${outcome.id}`,
  }));
}

export function signalsForOutcome(
  outcome: LearningOutcome, ids: readonly string[], at = outcome.recordedAt,
): readonly Signal[] {
  return outcomeSignalSeeds(outcome).map((seed, index) => ({
    id: ids[index]!, topicId: seed.topicId, type: seed.type,
    direction: seed.direction, at, sourceEvent: seed.sourceEvent, invalidated: false,
  }));
}
