import type { Commitment, CommitmentState } from './commitments.js';
import { commitmentState, orderCommitments } from './commitments.js';
import type { Course } from './courses.js';
import type { LearningOutcome } from './outcomes.js';

export type CoursePulseState = 'attention' | 'active' | 'caught-up' | 'ready';

export interface CoursePulse {
  readonly courseId: string;
  readonly title: string;
  readonly state: CoursePulseState;
  readonly stateLabel: string;
  readonly materialLine: string | null;
  readonly workLine: string | null;
  readonly resultLine: string | null;
}

const currentOutcomes = (outcomes: readonly LearningOutcome[]): readonly LearningOutcome[] => {
  const superseded = new Set(
    outcomes.filter((outcome) => !outcome.deletedAt && outcome.supersedesId)
      .map((outcome) => outcome.supersedesId as string),
  );
  return outcomes.filter((outcome) => !outcome.deletedAt && !superseded.has(outcome.id));
};

const workLine = (commitment: Commitment, state: CommitmentState): string => {
  if (state === 'late') return `${commitment.title} is still open past its date.`;
  if (state === 'today') return `${commitment.title} is due today.`;
  if (state === 'soon') return `${commitment.title} is due within seven days.`;
  return `${commitment.title} is the next dated piece of work.`;
};

const resultLine = (outcome: LearningOutcome | undefined): string | null => {
  if (!outcome) return null;
  if (outcome.score !== null && outcome.maxScore !== null) {
    return `Latest result: ${outcome.title} · ${outcome.score} of ${outcome.maxScore}.`;
  }
  return `Latest result: ${outcome.title}.`;
};

const stateRank: Record<CoursePulseState, number> = {
  attention: 0,
  active: 1,
  ready: 2,
  'caught-up': 3,
};

/**
 * A factual cross-course read for Insights.
 *
 * This deliberately does not manufacture a health score. The three facts have
 * different authority: material coverage is learner-reported, work is dated,
 * and results are external evidence. Keeping them as separate lines lets the
 * learner see why a course is first without asking them to trust an opaque
 * percentage.
 */
export function coursePulse(
  courses: readonly Course[],
  commitments: readonly Commitment[],
  outcomes: readonly LearningOutcome[],
  now: Date,
  timeZone = 'UTC',
): readonly CoursePulse[] {
  const current = currentOutcomes(outcomes);
  return courses.filter((course) => !course.archivedAt).map((course) => {
    const open = orderCommitments(
      commitments.filter((commitment) => commitment.courseId === course.id && !commitment.doneAt),
      now,
      timeZone,
    );
    const next = open[0];
    const nextState = next ? commitmentState(next, now, timeZone) : null;
    const covered = course.material.filter((material) => material.doneAt).length;
    const incompleteMaterial = covered < course.material.length;
    const latest = current.filter((outcome) => outcome.courseId === course.id)
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
    const state: CoursePulseState = nextState && ['late', 'today', 'soon'].includes(nextState)
      ? 'attention'
      : next || incompleteMaterial
        ? 'active'
        : course.material.length > 0
          ? 'caught-up'
          : 'ready';
    const stateLabel: Record<CoursePulseState, string> = {
      attention: 'Needs attention',
      active: 'In progress',
      'caught-up': 'Current material covered',
      ready: 'Ready to set up',
    };
    return {
      courseId: course.id,
      title: course.title,
      state,
      stateLabel: stateLabel[state],
      materialLine: course.material.length
        ? `${covered} of ${course.material.length} ${course.material.length === 1 ? 'material' : 'materials'} covered.`
        : null,
      workLine: next && nextState ? workLine(next, nextState) : null,
      resultLine: resultLine(latest),
    };
  }).sort((a, b) => stateRank[a.state] - stateRank[b.state] || a.title.localeCompare(b.title));
}
