import assert from 'node:assert/strict';
import test from 'node:test';
import { coursePulse, type Commitment, type Course, type LearningOutcome } from '../index.js';

const NOW = new Date('2026-08-28T10:00:00.000Z');
const course = (id: string, title: string, done = 0): Course => ({
  id, title, provider: '', url: '', topicIds: [], archivedAt: null, createdAt: NOW.toISOString(),
  material: [0, 1].map((index) => ({
    id: `${id}-m${index}`, title: `Material ${index + 1}`, url: '', kind: 'reading', minutes: 10,
    progressMinutes: index < done ? 10 : 0, doneAt: index < done ? NOW.toISOString() : null,
    pinIds: [], addedAt: NOW.toISOString(),
  })),
});
const commitment = (courseId: string, title: string, dueAt: string): Commitment => ({
  id: `${courseId}-${title}`, title, kind: 'assignment', courseId, topicIds: [], dueAt,
  plannedFor: null, estimateMinutes: 30, notes: '', doneAt: null, createdAt: NOW.toISOString(),
});
const outcome = (courseId: string, id: string, recordedAt: string, supersedesId: string | null = null): LearningOutcome => ({
  id, kind: 'grade', courseId, commitmentId: null, topicIds: [], title: `Result ${id}`,
  score: 72, maxScore: 100, summary: '', feedback: '', criteria: [], source: null,
  recordedAt, supersedesId, deletedAt: null,
});

test('study pulse leads with real urgency and keeps each authority separate', () => {
  const pulses = coursePulse(
    [course('history', 'History', 2), course('systems', 'Systems Design', 1)],
    [commitment('history', 'Essay', '2026-09-20'), commitment('systems', 'CAP exercise', '2026-08-28')],
    [outcome('systems', 'old', '2026-08-20'), outcome('systems', 'new', '2026-08-27', 'old')],
    NOW,
  );
  assert.deepEqual(pulses.map((pulse) => pulse.courseId), ['systems', 'history']);
  assert.deepEqual(pulses[0], {
    courseId: 'systems', title: 'Systems Design', state: 'attention', stateLabel: 'Needs attention',
    materialLine: '1 of 2 materials covered.', workLine: 'CAP exercise is due today.',
    resultLine: 'Latest result: Result new · 72 of 100.',
  });
  assert.equal(pulses[1]?.state, 'active');
  assert.equal(pulses[1]?.materialLine, '2 of 2 materials covered.');
  assert.equal(pulses[1]?.workLine, 'Essay is the next dated piece of work.');
});

test('study pulse excludes archived courses and does not invent a score for an empty course', () => {
  const archived = { ...course('old', 'Old course'), archivedAt: NOW.toISOString() };
  const empty = { ...course('new', 'New course'), material: [] };
  assert.deepEqual(coursePulse([archived, empty], [], [], NOW), [{
    courseId: 'new', title: 'New course', state: 'ready', stateLabel: 'Ready to set up',
    materialLine: null, workLine: null, resultLine: null,
  }]);
});
