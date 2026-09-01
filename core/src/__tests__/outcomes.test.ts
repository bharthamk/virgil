import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outcomeSignalSeeds, signalsForOutcome, type LearningOutcome } from '../domain/outcomes.js';

const outcome = (over: Partial<LearningOutcome> = {}): LearningOutcome => ({
  id: 'o1', kind: 'grade', courseId: 'course-1', commitmentId: 'assignment-1',
  topicIds: ['t-overall'], title: 'Assignment 1 result', score: 72, maxScore: 100,
  summary: 'A mixed result', feedback: '', criteria: [], source: null,
  recordedAt: '2026-08-23T10:00:00.000Z', supersedesId: null, deletedAt: null, ...over,
});

test('clear assessed gaps and strengths become strongest causal topic evidence', () => {
  const seeds = outcomeSignalSeeds(outcome({
    criteria: [
      { criterionId: 'r1', label: 'Evidence', score: 9, maxScore: 10, verdict: null, feedback: '', topicIds: ['t1'] },
      { criterionId: 'r2', label: 'Evaluation', score: 4, maxScore: 10, verdict: null, feedback: '', topicIds: ['t2'] },
    ],
  }));
  assert.deepEqual(seeds.map((x) => [x.topicId, x.type, x.direction]), [
    ['t1', 'assessed-strong', 'positive'],
    ['t2', 'assessed-gap', 'negative'],
  ]);
  assert.ok(seeds.every((x) => x.sourceEvent === 'outcome:o1'));
});

test('a middling aggregate grade fabricates no topic conclusion', () => {
  assert.deepEqual(outcomeSignalSeeds(outcome()), []);
});

test('self-assessment is context, not assessed evidence', () => {
  assert.deepEqual(outcomeSignalSeeds(outcome({ kind: 'self-assessment', score: 10, maxScore: 10 })), []);
});

test('deleted outcomes write no new signals and generated rows name their receipt', () => {
  const deleted = outcome({ deletedAt: '2026-08-24T00:00:00.000Z', score: 20 });
  assert.deepEqual(signalsForOutcome(deleted, []), []);
  const live = outcome({ score: 20 });
  const signals = signalsForOutcome(live, ['s1']);
  assert.equal(signals[0]?.id, 's1');
  assert.equal(signals[0]?.sourceEvent, 'outcome:o1');
  assert.equal(signals[0]?.invalidated, false);
});
