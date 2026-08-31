import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  awardsForClosing, commitmentState, deadlineDay, dueWeight, DUE_WEIGHT_MAX,
  calendarDateAfterWeeks, hasRecurrence, hasTimedDeadline, orderCommitments,
  resolveLocalDeadline, weeklyDates,
  POINTS_CLOSED, POINTS_KEPT_PROMISE, POINTS_ON_TIME, POINTS_PER_STAR,
  starsFrom, totalPoints, towardNextStar,
  type Award, type Commitment,
} from '../domain/commitments.js';
import type { Topic } from '../domain/types.js';
import type { ComfortResult } from '../agents/registrar.js';

/**
 * The commitment ledger — what the learner is on the hook for.
 *
 * The rules worth testing here are the ones a person would argue with: whether
 * meeting a deadline at the last hour counts as meeting it, whether being late
 * costs anything, and whether a typed-in date can decide what gets taught.
 */

const NOW = new Date('2026-08-23T10:00:00.000Z');

const commitment = (over: Partial<Commitment> = {}): Commitment => ({
  id: 'c1', title: 'Marketing analysis', kind: 'assignment',
  courseId: null, topicIds: [], dueAt: '2026-08-28T23:59:00.000Z',
  plannedFor: null, estimateMinutes: null, notes: '',
  doneAt: null, createdAt: '2026-08-20T09:00:00.000Z', ...over,
});

// ------------------------------------------------------------------- points

test('closing anything scores, and closing it on time scores more', () => {
  const onTime = awardsForClosing(commitment(), '2026-08-27T09:00:00.000Z');
  assert.deepEqual(onTime.map((a) => a.reason), ['closed', 'on-time']);
  assert.equal(onTime.reduce((n, a) => n + a.points, 0), POINTS_CLOSED + POINTS_ON_TIME);
});

test('on time is measured by the day, not by the instant', () => {
  // A deadline of "Friday" met at 23:58 on Friday was met. A product that says
  // otherwise because the stored time was midnight is arguing with the learner
  // about something they are right about.
  const due = commitment({ dueAt: '2026-08-28T00:00:00.000Z' });
  const awards = awardsForClosing(due, '2026-08-28T23:58:00.000Z');
  assert.ok(awards.some((a) => a.reason === 'on-time'), 'the last hour of the day is still the day');
});

test('today and on-time belong to the learner’s zone, not UTC', () => {
  // 00:30 UTC on the 27th is still the 26th in Los Angeles. The learner who
  // closes work due on the 26th has met that date, and Plan must still call it
  // today before they close it.
  const boundary = new Date('2026-08-27T00:30:00.000Z');
  const due = commitment({ dueAt: '2026-08-26T23:59:00.000Z' });
  assert.equal(commitmentState(due, boundary), 'late', 'UTC is already on the 27th');
  assert.equal(commitmentState(due, boundary, 'America/Los_Angeles'), 'today');
  assert.deepEqual(
    awardsForClosing(due, boundary.toISOString(), 'America/Los_Angeles').map((a) => a.reason),
    ['closed', 'on-time'],
  );

  // The teaching weight reads the same calendar boundary as the Plan state.
  const linked = { ...due, topicIds: ['t1'] };
  assert.equal(dueWeight('t1', [linked], boundary, 'America/Los_Angeles'), DUE_WEIGHT_MAX);
});

test('a stated Sydney time remains an instant and expires only after that time', () => {
  const dueAt = resolveLocalDeadline('2026-09-09', '17:00', 'Australia/Sydney');
  assert.equal(dueAt, '2026-09-09T07:00:00.000Z');
  const due = commitment({ dueAt: dueAt!, dueTime: '17:00', dueTimeZone: 'Australia/Sydney' });
  assert.equal(hasTimedDeadline(due), true);
  assert.equal(deadlineDay(due), '2026-09-09');
  assert.equal(commitmentState(due, new Date('2026-09-09T06:59:59.000Z')), 'today');
  assert.equal(commitmentState(due, new Date('2026-09-09T07:00:01.000Z')), 'late');
  assert.deepEqual(
    awardsForClosing(due, '2026-09-09T07:00:00.000Z').map((a) => a.reason),
    ['closed', 'on-time'],
  );
  assert.deepEqual(
    awardsForClosing(due, '2026-09-09T07:00:00.001Z').map((a) => a.reason),
    ['closed'],
  );
});

test('DST gaps are refused and repeated wall times resolve to the later instant', () => {
  assert.equal(resolveLocalDeadline('2026-03-08', '02:30', 'America/Los_Angeles'), null,
    '02:30 never occurs on the spring-forward day');
  assert.equal(resolveLocalDeadline('2026-11-01', '01:30', 'America/Los_Angeles'),
    '2026-11-01T09:30:00.000Z', 'the second 01:30 prevents an early expiry');
});

test('non-hour IANA offsets resolve from the timezone database', () => {
  assert.equal(resolveLocalDeadline('2026-09-09', '17:00', 'Asia/Kathmandu'),
    '2026-09-09T11:15:00.000Z');
});

test('partial timed metadata remains a date-only legacy row', () => {
  const partial = commitment({ dueTime: '17:00' });
  assert.equal(hasTimedDeadline(partial), false);
  assert.equal(deadlineDay(partial), '2026-08-28');
  assert.equal(hasTimedDeadline(commitment({
    dueTime: '99:99', dueTimeZone: 'Australia/Sydney',
  })), false, 'malformed stored clock metadata cannot turn a legacy row into an instant');
});

test('a bounded weekly series uses calendar dates and only complete metadata grants series scope', () => {
  assert.deepEqual(weeklyDates('2026-09-27', 3), [
    '2026-09-27', '2026-10-04', '2026-10-11',
  ]);
  assert.equal(calendarDateAfterWeeks('2026-12-27', 2), '2027-01-10');
  assert.equal(weeklyDates('2026-02-30', 3), null);
  assert.equal(weeklyDates('2026-09-27', 21), null);
  const recurring = commitment({ recurrence: {
    seriesId: 'series_one', index: 1, total: 3, cadence: 'weekly',
    timeZone: 'Australia/Sydney', requestHash: `sha256:${'a'.repeat(64)}`,
  } });
  assert.equal(hasRecurrence(recurring), true);
  assert.equal(hasRecurrence(commitment({ recurrence: {
    ...recurring.recurrence!, index: 3,
  } })), false, 'an impossible position cannot unlock a bulk edit');
});

test('late still scores — there is no punishment anywhere in this ledger', () => {
  // The ledger awards progress and never subtracts points.
  const late = awardsForClosing(commitment(), '2026-09-04T09:00:00.000Z');
  assert.deepEqual(late.map((a) => a.reason), ['closed']);
  assert.equal(late[0]!.points, POINTS_CLOSED);
  assert.ok(late.every((a) => a.points > 0), 'nothing here is ever negative');
});

test('a promise to yourself is scored separately from the deadline', () => {
  // "I will do it Monday" for a thing due Friday. Keeping that is worth
  // something the deadline cannot measure, and missing it costs nothing.
  const planned = commitment({ plannedFor: '2026-08-24T00:00:00.000Z' });
  const kept = awardsForClosing(planned, '2026-08-24T20:00:00.000Z');
  assert.deepEqual(kept.map((a) => a.reason), ['closed', 'on-time', 'kept-promise']);
  assert.equal(kept.reduce((n, a) => n + a.points, 0),
    POINTS_CLOSED + POINTS_ON_TIME + POINTS_KEPT_PROMISE);

  const broken = awardsForClosing(planned, '2026-08-26T20:00:00.000Z');
  assert.deepEqual(broken.map((a) => a.reason), ['closed', 'on-time'],
    'the promise was missed and the deadline was not; only the promise award is absent');
});

test('every award says what it was for, so a total can be explained', () => {
  const awards = awardsForClosing(commitment({ plannedFor: '2026-08-24T00:00:00.000Z' }),
    '2026-08-24T20:00:00.000Z');
  for (const a of awards) {
    assert.equal(a.commitmentId, 'c1');
    assert.ok(a.at, 'an award with no time on it cannot be explained later');
  }
});

// -------------------------------------------------------------------- stars

test('stars are a projection of the points and cannot disagree with them', () => {
  assert.equal(starsFrom(0), 0);
  assert.equal(starsFrom(POINTS_PER_STAR - 1), 0);
  assert.equal(starsFrom(POINTS_PER_STAR), 1);
  assert.equal(starsFrom(POINTS_PER_STAR * 3 + 10), 3);
});

test('a total that somehow went negative reads as no stars, not as an error', () => {
  assert.equal(starsFrom(-40), 0);
  assert.equal(towardNextStar(-40), 0);
});

test('the board can show how close the next star is, without showing a score', () => {
  assert.equal(towardNextStar(0), 0);
  assert.equal(towardNextStar(POINTS_PER_STAR / 2), 0.5);
  assert.equal(towardNextStar(POINTS_PER_STAR), 0);
});

test('the total is the sum of the ledger and is never stored as a counter', () => {
  const awards: Award[] = [
    { id: 'a1', at: NOW.toISOString(), points: 10, reason: 'closed', commitmentId: 'c1', topicId: null },
    { id: 'a2', at: NOW.toISOString(), points: 5, reason: 'on-time', commitmentId: 'c1', topicId: null },
    { id: 'a3', at: NOW.toISOString(), points: 2, reason: 'burst', commitmentId: null, topicId: 't1' },
  ];
  assert.equal(totalPoints(awards), 17);
  assert.equal(totalPoints([]), 0);
});

// ------------------------------------------------------------------- states

test('where a commitment stands, from the day rather than the hour', () => {
  assert.equal(commitmentState(commitment({ doneAt: '2026-08-22T00:00:00.000Z' }), NOW), 'done');
  assert.equal(commitmentState(commitment({ dueAt: '2026-08-20T00:00:00.000Z' }), NOW), 'late');
  assert.equal(commitmentState(commitment({ dueAt: '2026-08-23T01:00:00.000Z' }), NOW), 'today');
  assert.equal(commitmentState(commitment({ dueAt: '2026-08-27T00:00:00.000Z' }), NOW), 'soon');
  assert.equal(commitmentState(commitment({ dueAt: '2026-10-01T00:00:00.000Z' }), NOW), 'later');
});

test('a thing done late is done, not late', () => {
  // The state is about what the learner has to do next. A closed commitment
  // asks nothing of them, whenever it was closed.
  const c = commitment({ dueAt: '2026-08-01T00:00:00.000Z', doneAt: '2026-08-22T00:00:00.000Z' });
  assert.equal(commitmentState(c, NOW), 'done');
});

test('the order is what is late, then today, then by date', () => {
  const order = orderCommitments([
    commitment({ id: 'later', title: 'Later', dueAt: '2026-09-30T00:00:00.000Z' }),
    commitment({ id: 'done', title: 'Done', dueAt: '2026-08-24T00:00:00.000Z', doneAt: NOW.toISOString() }),
    commitment({ id: 'today', title: 'Today', dueAt: '2026-08-23T18:00:00.000Z' }),
    commitment({ id: 'late', title: 'Late', dueAt: '2026-08-19T00:00:00.000Z' }),
    commitment({ id: 'soon', title: 'Soon', dueAt: '2026-08-26T00:00:00.000Z' }),
  ], NOW);
  assert.deepEqual(order.map((c) => c.id), ['late', 'today', 'soon', 'later', 'done']);
});

test('two things due the same day keep a stable order rather than shuffling', () => {
  const same = { dueAt: '2026-08-26T00:00:00.000Z' };
  const order = orderCommitments([
    commitment({ id: 'b', title: 'Beta', ...same }),
    commitment({ id: 'a', title: 'Alpha', ...same }),
  ], NOW);
  assert.deepEqual(order.map((c) => c.id), ['a', 'b']);
});

// ------------------------------------------------------- deadline-aware teaching

/**
 * The capability the commitment layer exists to unlock.
 *
 * The Gardener schedules by decay, which is right when nothing is at stake and
 * wrong the week before an assignment. These tests hold the shape of the help:
 * a weight, never an override.
 */
test('a topic nothing is due on is weighted exactly as it was', () => {
  assert.equal(dueWeight('t1', [], NOW), 1);
  assert.equal(dueWeight('t1', [commitment({ topicIds: ['t2'] })], NOW), 1);
});

test('a deadline pulls the topics it leans on forward, and more as it nears', () => {
  const far = dueWeight('t1', [commitment({ topicIds: ['t1'], dueAt: '2026-08-28T10:00:00.000Z' })], NOW);
  const near = dueWeight('t1', [commitment({ topicIds: ['t1'], dueAt: '2026-08-24T10:00:00.000Z' })], NOW);
  assert.ok(far > 1 && near > far, `${near} should outweigh ${far}`);
  assert.ok(near <= DUE_WEIGHT_MAX);
});

test('a deadline further out than a week does not reach into tonight', () => {
  assert.equal(dueWeight('t1', [commitment({ topicIds: ['t1'], dueAt: '2026-10-01T00:00:00.000Z' })], NOW), 1);
});

test('the weight is bounded, so a date can never decide what is taught on its own', () => {
  // A typed-in date is not evidence. The strongest thing it may do is win a
  // close call between two candidates the Gardener already considered.
  const w = dueWeight('t1', [commitment({ topicIds: ['t1'], dueAt: '2026-08-23T11:00:00.000Z' })], NOW);
  assert.equal(w, DUE_WEIGHT_MAX);
});

test('something three weeks late does not outrank something due tomorrow, for ever', () => {
  const veryLate = dueWeight('t1', [commitment({ topicIds: ['t1'], dueAt: '2026-08-01T00:00:00.000Z' })], NOW);
  const tomorrow = dueWeight('t2', [commitment({ topicIds: ['t2'], dueAt: '2026-08-24T09:00:00.000Z' })], NOW);
  assert.equal(veryLate, DUE_WEIGHT_MAX);
  assert.ok(tomorrow <= veryLate, 'late tops out where due-today tops out, and no higher');
});

test('a closed commitment weighs nothing — the point is what is coming', () => {
  const done = commitment({ topicIds: ['t1'], dueAt: '2026-08-24T00:00:00.000Z', doneAt: NOW.toISOString() });
  assert.equal(dueWeight('t1', [done], NOW), 1);
});

test('the strongest deadline on a topic wins, not the sum of them', () => {
  // Three assignments in the same week must not weight a topic three times as
  // heavily as one — that is how a busy week silently becomes the only thing
  // the product will teach.
  const many = [
    commitment({ id: 'a', topicIds: ['t1'], dueAt: '2026-08-24T00:00:00.000Z' }),
    commitment({ id: 'b', topicIds: ['t1'], dueAt: '2026-08-25T00:00:00.000Z' }),
    commitment({ id: 'c', topicIds: ['t1'], dueAt: '2026-08-26T00:00:00.000Z' }),
  ];
  assert.ok(dueWeight('t1', many, NOW) <= DUE_WEIGHT_MAX);
});

// ------------------------------------------------ the Gardener, with deadlines

/**
 * The link that makes a task manager worth building inside a learning product.
 *
 * These are about what a deadline is ALLOWED to do to teaching: reorder the
 * ordinary pool, and nothing else. Every statement above it in the Gardener's
 * ladder — the learner retiring a topic, a regression, their own resurface
 * mark, an abandoned pin — outranks a date, because three of those are a person
 * speaking and the fourth is the ledger, and a typed date is neither.
 */
test('a deadline moves the teaching pool and leaves the statements alone', async () => {
  const { tend } = await import('../agents/gardener.js');
  const topic = (id: string, over: Record<string, unknown> = {}): Topic => ({
    id, label: id, summary: '', pinIds: ['p1'], state: 'working', comfort: 0.5,
    lastExposedAt: null, retiredByUser: false, createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  } as Topic);
  const comfort = (topicId: string): ComfortResult => ({
    topicId, comfort: 0.5, regressed: false, evidenceCount: 2, demonstrationCount: 2,
    certainty: 0.5, evidenceSignalIds: [],
  });

  const topics = [topic('taught'), topic('retired', { retiredByUser: true })];
  const comforts = [comfort('taught'), comfort('retired')];
  const due = [commitment({ topicIds: ['taught', 'retired'], dueAt: '2026-08-24T00:00:00.000Z' })];

  const without = tend({ topics, comforts, signals: [], now: NOW });
  const withDue = tend({ topics, comforts, signals: [], now: NOW, commitments: due });

  const of = (rows: readonly { topicId: string; priority: number }[], id: string) =>
    rows.find((r) => r.topicId === id)!.priority;

  assert.ok(of(withDue, 'taught') > of(without, 'taught'),
    'the ordinary teaching candidate is pulled forward');
  assert.equal(of(withDue, 'retired'), 0);
  assert.equal(of(without, 'retired'), 0);
});

test('a caller that knows nothing about deadlines gets exactly what it always got', async () => {
  const { tend } = await import('../agents/gardener.js');
  const topics = [{
    id: 't1', label: 't1', summary: '', pinIds: ['p1'], state: 'working', comfort: 0.5,
    lastExposedAt: null, retiredByUser: false, createdAt: '2026-08-01T00:00:00.000Z',
  }] as Topic[];
  const comforts: ComfortResult[] = [{
    topicId: 't1', comfort: 0.5, regressed: false, evidenceCount: 2, demonstrationCount: 2,
    certainty: 0.5, evidenceSignalIds: [],
  }];
  assert.deepEqual(
    tend({ topics, comforts, signals: [], now: NOW }),
    tend({ topics, comforts, signals: [], now: NOW, commitments: [] }),
  );
});
