import { test } from 'node:test';
import assert from 'node:assert/strict';

import { subjectForTopic } from '../domain/subjects.js';
import type { Course } from '../domain/courses.js';
import type { Commitment } from '../domain/commitments.js';

/**
 * WHICH SUBJECT A TOPIC BELONGS TO, AND WHAT THE BOARD REFUSES TO GUESS.
 *
 * The board has two fields which look
 * like the answer and are both empty in every store: `Course.topicIds` and
 * `Material.pinIds` are declared, read, and written `[]` at every creation
 * site. The one real link runs through the commitment, which has both a course
 * and a validated list of topics under the topic-relationship contract.
 *
 * So these tests are as much about the refusals as about the joins. A label on
 * a row is a door, and a door that opens onto a course the learner never
 * connected to this topic is worse than no door.
 */

const course = (id: string, title: string, over: Partial<Course> = {}): Course => ({
  id, title, provider: '', url: '', material: [], topicIds: [],
  archivedAt: null, createdAt: '2026-08-01T00:00:00.000Z', ...over,
});

const commitment = (over: Partial<Commitment> = {}): Commitment => ({
  id: 'c1', title: 'Problem set 3', kind: 'assignment', courseId: null, topicIds: [],
  dueAt: '2026-08-30T00:00:00.000Z', plannedFor: null, estimateMinutes: null,
  notes: '', doneAt: null, createdAt: '2026-08-01T00:00:00.000Z', ...over,
});

test('a course that names the topic is the subject, said in the course’s own title', () => {
  const found = subjectForTopic('t1', [course('c1', 'Networks and Security', { topicIds: ['t1'] })], []);
  assert.deepEqual(found, { courseId: 'c1', title: 'Networks and Security' });
});

test('the link that actually exists is the commitment, and it is honoured', () => {
  // `Course.topicIds` is written `[]` everywhere a course is created, so this
  // is the join that answers on a real board.
  const found = subjectForTopic('t1',
    [course('c1', 'Networks and Security')],
    [commitment({ courseId: 'c1', topicIds: ['t1'] })]);
  assert.deepEqual(found, { courseId: 'c1', title: 'Networks and Security' });
});

test('a topic nothing links to a course has no subject', () => {
  assert.equal(subjectForTopic('t1', [course('c1', 'Networks')], []), null);
  assert.equal(
    subjectForTopic('t1', [course('c1', 'Networks')], [commitment({ courseId: 'c1' })]),
    null, 'a commitment that does not name the topic says nothing about it');
  assert.equal(
    subjectForTopic('t1', [course('c1', 'Networks')], [commitment({ topicIds: ['t1'] })]),
    null, 'a commitment with no course says nothing about which course');
});

test('a commitment naming a course that is gone or archived is not a subject', () => {
  // The label is a door, and a door has to open onto something.
  assert.equal(
    subjectForTopic('t1', [], [commitment({ courseId: 'c1', topicIds: ['t1'] })]),
    null);
  assert.equal(
    subjectForTopic('t1',
      [course('c1', 'Networks', { archivedAt: '2026-08-10T00:00:00.000Z' })],
      [commitment({ courseId: 'c1', topicIds: ['t1'] })]),
    null);
});

test('the course’s own claim outranks the one a commitment implies', () => {
  // A course that names a topic is the course saying so; a commitment is the
  // learner saying two things that imply it.
  const found = subjectForTopic('t1',
    [course('c1', 'Implied'), course('c2', 'Direct', { topicIds: ['t1'] })],
    [commitment({ courseId: 'c1', topicIds: ['t1'] })]);
  assert.equal(found?.title, 'Direct');
});

test('an open obligation outranks one that is already handed in', () => {
  const found = subjectForTopic('t1',
    [course('c1', 'Finished'), course('c2', 'Live')],
    [
      commitment({ id: 'a', courseId: 'c1', topicIds: ['t1'], doneAt: '2026-08-05T00:00:00.000Z' }),
      commitment({ id: 'b', courseId: 'c2', topicIds: ['t1'] }),
    ]);
  assert.equal(found?.title, 'Live');
});

test('a closed obligation is still a subject when it is the only link', () => {
  // A topic whose only connection is an assignment handed in last month still
  // belongs to that subject. Filtering closed commitments away would lose the
  // label on exactly the topics a learner has been at longest.
  const found = subjectForTopic('t1',
    [course('c1', 'Networks')],
    [commitment({ courseId: 'c1', topicIds: ['t1'], doneAt: '2026-08-05T00:00:00.000Z' })]);
  assert.equal(found?.title, 'Networks');
});

test('a topic linked to two courses answers the same way on every render', () => {
  // An arbitrary answer that changed between paints would be worse than none.
  const courses = [course('c1', 'Earlier'), course('c2', 'Later')];
  const commitments = [
    commitment({ id: 'b', courseId: 'c2', topicIds: ['t1'], dueAt: '2026-09-30T00:00:00.000Z' }),
    commitment({ id: 'a', courseId: 'c1', topicIds: ['t1'], dueAt: '2026-08-30T00:00:00.000Z' }),
  ];
  assert.equal(subjectForTopic('t1', courses, commitments)?.title, 'Earlier');
  assert.equal(subjectForTopic('t1', courses, [...commitments].reverse())?.title, 'Earlier');
});

test('it reaches no model and no store: it is a join over two lists', () => {
  // The rule the whole selection path is held to. A subject label that cost a
  // model call per row per paint would be the most expensive label in the
  // product, on the least important sentence on the screen.
  assert.equal(subjectForTopic.length, 3);
});
