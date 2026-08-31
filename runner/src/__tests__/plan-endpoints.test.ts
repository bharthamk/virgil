import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fixedClock, POINTS_CLOSED, POINTS_ON_TIME, POINTS_KEPT_PROMISE } from '@sb/core';
import { NOW, startService, topic } from './service-harness.js';

/**
 * The plan — commitments, and the points for keeping them.
 *
 * The service clock is fixed at `NOW` (2026-08-19T03:00Z), so every deadline
 * below is a real position relative to it rather than a date that drifts into
 * the past as the repo ages.
 *
 * What is worth testing at this level: that the scoring rules the domain owns
 * actually reach the ledger, that closing twice does not pay twice, and that a
 * date typed into this room cannot reach the signal ledger.
 */

const FUTURE = '2026-08-25';
const PAST = '2026-08-11';

const make = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: 'Marketing analysis', kind: 'assignment', dueAt: FUTURE, ...over,
});

test('a commitment is created, ordered, and comes back with where it stands', async () => {
  const h = await startService('plan-create');
  try {
    const made = await h.call('POST', '/commitments', make());
    assert.equal(made.status, 201);

    const plan = await h.call('GET', '/plan');
    assert.equal(plan.status, 200);
    assert.equal(plan.body.commitments.length, 1);
    assert.equal(plan.body.commitments[0].title, 'Marketing analysis');
    assert.equal(plan.body.commitments[0].state, 'soon');
    // Nothing has been earned yet, and the room says zero rather than nothing.
    assert.equal(plan.body.points, 0);
    assert.equal(plan.body.stars, 0);
  } finally { await h.close(); }
});

test('the browser zone governs Plan state and the award boundary', async () => {
  const boundary = '2026-08-27T00:30:00.000Z';
  const h = await startService('plan-local-day', { clock: fixedClock(boundary) });
  try {
    const made = await h.call('POST', '/commitments', make({ dueAt: '2026-08-26' }));
    const id = made.body.commitment.id;
    const utc = await h.call('GET', '/plan');
    assert.equal(utc.body.commitments[0].state, 'late');
    const utcToday = await h.call('GET', '/today?minutes=5');
    assert.equal(utcToday.body.next.primary.detail, 'Assignment.');
    assert.equal(utcToday.body.next.primary.reasons[0].text, 'This is still open past its date.');

    const local = await h.call('GET', '/plan', undefined, {
      'x-virgil-time-zone': 'America/Los_Angeles',
    });
    assert.equal(local.body.commitments[0].state, 'today');
    const localToday = await h.call('GET', '/today?minutes=5', undefined, {
      'x-virgil-time-zone': 'America/Los_Angeles',
    });
    assert.equal(localToday.body.next.primary.detail, 'Assignment.');
    assert.equal(localToday.body.next.primary.reasons[0].text, 'This is due today.');

    const done = await h.call('POST', `/commitments/${id}/done`, undefined, {
      'x-virgil-time-zone': 'America/Los_Angeles',
    });
    assert.deepEqual(done.body.awarded.map((a: { reason: string }) => a.reason),
      ['closed', 'on-time']);
  } finally { await h.close(); }
});

test('an invalid or absent browser zone falls back to the learner zone without moving the date', async () => {
  const boundary = '2026-08-27T00:30:00.000Z';
  const h = await startService('plan-local-day-fallback', { clock: fixedClock(boundary) });
  try {
    await h.store.putPrefs({
      ...await h.store.getPrefs(), timeZone: 'America/Los_Angeles',
    });
    const made = await h.call('POST', '/commitments', make({
      title: 'Local-day report', dueAt: '2026-08-26',
    }));
    const id = made.body.commitment.id;
    assert.equal(made.body.commitment.dueAt.slice(0, 10), '2026-08-26',
      'a fallback zone cannot reinterpret the learner-entered deadline');

    const invalid = { 'x-virgil-time-zone': 'Mars/Olympus' };
    const invalidPlan = await h.call('GET', '/plan', undefined, invalid);
    assert.equal(invalidPlan.status, 200, 'malformed calendar context is ignored, not a failed read');
    assert.equal(invalidPlan.body.commitments[0].state, 'today');
    const invalidToday = await h.call('GET', '/today?minutes=5', undefined, invalid);
    assert.equal(invalidToday.body.next.primary.detail, 'Assignment.');
    assert.equal(invalidToday.body.next.primary.reasons[0].text, 'This is due today.');

    const absentPlan = await h.call('GET', '/plan');
    assert.equal(absentPlan.body.commitments[0].state, 'today',
      'an absent request zone uses the same stored learner day');

    const done = await h.call('POST', `/commitments/${id}/done`, undefined, invalid);
    assert.deepEqual(done.body.awarded.map((a: { reason: string }) => a.reason),
      ['closed', 'on-time']);
  } finally { await h.close(); }
});

test('an optional deadline time is stored with its browser IANA zone and exact instant', async () => {
  const h = await startService('plan-timed', { clock: fixedClock('2026-09-09T06:59:00.000Z') });
  try {
    const made = await h.call('POST', '/commitments', make({
      dueAt: '2026-09-09', dueTime: '17:00',
    }), { 'x-virgil-time-zone': 'Australia/Sydney' });
    assert.equal(made.status, 201);
    assert.equal(made.body.commitment.dueAt, '2026-09-09T07:00:00.000Z');
    assert.equal(made.body.commitment.dueTime, '17:00');
    assert.equal(made.body.commitment.dueTimeZone, 'Australia/Sydney');
    assert.equal((await h.call('GET', '/plan')).body.commitments[0].state, 'today');

    const done = await h.call('POST', `/commitments/${made.body.commitment.id}/done`);
    assert.deepEqual(done.body.awarded.map((a: { reason: string }) => a.reason),
      ['closed', 'on-time']);
  } finally { await h.close(); }
});

test('a DST gap is refused before write and a repeated deadline uses the later occurrence', async () => {
  const h = await startService('plan-dst');
  const zone = { 'x-virgil-time-zone': 'America/Los_Angeles' };
  try {
    const gap = await h.call('POST', '/commitments', make({
      dueAt: '2026-03-08', dueTime: '02:30',
    }), zone);
    assert.equal(gap.status, 400);
    assert.match(gap.body.error, /does not exist/);
    assert.deepEqual((await h.call('GET', '/plan')).body.commitments, []);

    const repeated = await h.call('POST', '/commitments', make({
      dueAt: '2026-11-01', dueTime: '01:30',
    }), zone);
    assert.equal(repeated.status, 201);
    assert.equal(repeated.body.commitment.dueAt, '2026-11-01T09:30:00.000Z');
  } finally { await h.close(); }
});

test('changing the date of a timed deadline retains its time and zone', async () => {
  const h = await startService('plan-timed-edit');
  const zone = { 'x-virgil-time-zone': 'Asia/Kathmandu' };
  try {
    const made = await h.call('POST', '/commitments', make({
      dueAt: '2026-09-09', dueTime: '17:00',
    }), zone);
    const changed = await h.call('PUT', `/commitments/${made.body.commitment.id}`, {
      dueAt: '2026-09-10',
    }, { 'x-virgil-time-zone': 'Australia/Sydney' });
    assert.equal(changed.body.commitment.dueAt, '2026-09-10T11:15:00.000Z');
    assert.equal(changed.body.commitment.dueTime, '17:00');
    assert.equal(changed.body.commitment.dueTimeZone, 'Asia/Kathmandu');
  } finally { await h.close(); }
});

test('replacing a timed deadline through the legacy ISO API clears its wall-time metadata', async () => {
  const h = await startService('plan-timed-legacy-edit');
  const zone = { 'x-virgil-time-zone': 'Australia/Sydney' };
  try {
    const made = await h.call('POST', '/commitments', make({
      dueAt: '2026-09-09', dueTime: '17:00',
    }), zone);
    const changed = await h.call('PUT', `/commitments/${made.body.commitment.id}`, {
      dueAt: '2026-09-10T02:15:00.000Z',
    }, zone);
    assert.equal(changed.status, 200);
    assert.equal(changed.body.commitment.dueAt, '2026-09-10T02:15:00.000Z');
    assert.equal(changed.body.commitment.dueTime, null);
    assert.equal(changed.body.commitment.dueTimeZone, null);
  } finally { await h.close(); }
});

test('a weekly series previews as materialized rows and retries by stable client identity', async () => {
  const h = await startService('plan-weekly-create');
  const request = make({
    dueAt: '2026-09-01', plannedFor: '2026-08-31', count: 3,
    clientRef: 'weekly-create-001',
  });
  try {
    const made = await h.call('POST', '/commitment-series', request, {
      'x-virgil-time-zone': 'Australia/Sydney',
    });
    assert.equal(made.status, 201);
    assert.equal(made.body.commitments.length, 3);
    assert.deepEqual(made.body.commitments.map((row: { dueAt: string }) => row.dueAt.slice(0, 10)), [
      '2026-09-01', '2026-09-08', '2026-09-15',
    ]);
    assert.deepEqual(made.body.commitments.map((row: { plannedFor: string }) => row.plannedFor.slice(0, 10)), [
      '2026-08-31', '2026-09-07', '2026-09-14',
    ]);
    assert.deepEqual(made.body.commitments.map((row: { recurrence: { index: number } }) =>
      row.recurrence.index), [0, 1, 2]);

    const repeated = await h.call('POST', '/commitment-series', request, {
      'x-virgil-time-zone': 'Australia/Sydney',
    });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.repeated, true);
    assert.deepEqual(repeated.body.commitments.map((row: { id: string }) => row.id),
      made.body.commitments.map((row: { id: string }) => row.id));
    assert.equal((await h.store.listCommitments()).length, 3);

    await h.call('POST', `/commitments/${made.body.commitments[0].id}/done`);
    const afterCompletionRetry = await h.call('POST', '/commitment-series', request, {
      'x-virgil-time-zone': 'Australia/Sydney',
    });
    assert.ok(afterCompletionRetry.body.commitments[0].doneAt,
      'an idempotent create retry cannot reopen a completed occurrence');

    const conflict = await h.call('POST', '/commitment-series', {
      ...request, title: 'Different class',
    }, { 'x-virgil-time-zone': 'Australia/Sydney' });
    assert.equal(conflict.status, 409);
    assert.equal((await h.store.listCommitments()).length, 3);
  } finally { await h.close(); }
});

test('weekly wall times follow their IANA zone and a DST gap writes no series', async () => {
  const h = await startService('plan-weekly-zone');
  try {
    const sydney = await h.call('POST', '/commitment-series', make({
      dueAt: '2026-09-27', dueTime: '17:00', count: 3, clientRef: 'weekly-sydney-001',
    }), { 'x-virgil-time-zone': 'Australia/Sydney' });
    assert.equal(sydney.status, 201);
    assert.deepEqual(sydney.body.commitments.map((row: { dueAt: string }) => row.dueAt), [
      '2026-09-27T07:00:00.000Z',
      '2026-10-04T06:00:00.000Z',
      '2026-10-11T06:00:00.000Z',
    ]);
    assert.ok(sydney.body.commitments.every((row: { dueTime: string; dueTimeZone: string }) =>
      row.dueTime === '17:00' && row.dueTimeZone === 'Australia/Sydney'));

    const gap = await h.call('POST', '/commitment-series', make({
      dueAt: '2026-03-01', dueTime: '02:30', count: 2, clientRef: 'weekly-gap-0001',
    }), { 'x-virgil-time-zone': 'America/Los_Angeles' });
    assert.equal(gap.status, 400);
    assert.match(gap.body.error, /does not exist/);
    assert.equal((await h.store.listCommitments()).length, 3,
      'the refused series wrote none of its dates');
  } finally { await h.close(); }
});

test('remaining-series edits and stops preserve completed history, awards, and planned promises', async () => {
  const h = await startService('plan-weekly-remaining');
  try {
    const made = await h.call('POST', '/commitment-series', make({
      dueAt: '2026-09-01', plannedFor: '2026-08-31', count: 4,
      clientRef: 'weekly-remaining-001',
    }));
    const ids = made.body.commitments.map((row: { id: string }) => row.id) as string[];
    await h.call('POST', `/commitments/${ids[2]}/done`);

    const changed = await h.call('PUT', `/commitments/${ids[1]}?scope=remaining`, {
      dueAt: '2026-09-10',
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.changed, 2);
    assert.equal(changed.body.preservedCompleted, 1);
    const afterEdit = [...await h.store.listCommitments()].sort((a, b) =>
      (a.recurrence?.index ?? 0) - (b.recurrence?.index ?? 0));
    assert.deepEqual(afterEdit.map((row) => row.dueAt.slice(0, 10)), [
      '2026-09-01', '2026-09-10', '2026-09-15', '2026-09-24',
    ]);
    assert.deepEqual(afterEdit.map((row) => row.plannedFor?.slice(0, 10)), [
      '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21',
    ], 'a deadline edit cannot silently move the learner\'s promise');

    const stopped = await h.call('DELETE', `/commitments/${ids[1]}?scope=remaining`);
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.removed, 2);
    assert.equal(stopped.body.preservedCompleted, 1);
    assert.deepEqual((await h.store.listCommitments()).map((row) => row.id).sort(),
      [ids[0], ids[2]].sort());
    assert.ok((await h.store.getCommitment(ids[2]!))?.doneAt);
    assert.ok((await h.store.listAwards()).some((award) => award.commitmentId === ids[2]));
  } finally { await h.close(); }
});

test('a bare date means the END of that day, not the start of it', async () => {
  // A deadline of "the 25th" entered from a date input and stored at midnight
  // would be a deadline that expired before the day began.
  const h = await startService('plan-date');
  try {
    const made = await h.call('POST', '/commitments', make());
    assert.equal(made.body.commitment.dueAt, '2026-08-25T23:59:00.000Z');
  } finally { await h.close(); }
});

test('closing on time pays the base and the on-time award, and says so', async () => {
  const h = await startService('plan-ontime');
  try {
    const made = await h.call('POST', '/commitments', make());
    const done = await h.call('POST', `/commitments/${made.body.commitment.id}/done`);

    assert.equal(done.status, 200);
    assert.deepEqual(done.body.awarded.map((a: { reason: string }) => a.reason), ['closed', 'on-time']);
    assert.equal(done.body.points, POINTS_CLOSED + POINTS_ON_TIME);
    assert.equal(done.body.commitment.doneAt, NOW);
  } finally { await h.close(); }
});

test('closing late still pays — nothing in this ledger punishes', async () => {
  const h = await startService('plan-late');
  try {
    const made = await h.call('POST', '/commitments', make({ dueAt: PAST }));
    const plan = await h.call('GET', '/plan');
    assert.equal(plan.body.commitments[0].state, 'late');

    const done = await h.call('POST', `/commitments/${made.body.commitment.id}/done`);
    assert.deepEqual(done.body.awarded.map((a: { reason: string }) => a.reason), ['closed']);
    assert.equal(done.body.points, POINTS_CLOSED);
    assert.ok(done.body.points > 0, 'late work still scores');
  } finally { await h.close(); }
});

test('keeping a promise to yourself is worth something the deadline cannot measure', async () => {
  const h = await startService('plan-promise');
  try {
    const made = await h.call('POST', '/commitments', make({ plannedFor: '2026-08-20' }));
    const done = await h.call('POST', `/commitments/${made.body.commitment.id}/done`);
    assert.deepEqual(done.body.awarded.map((a: { reason: string }) => a.reason),
      ['closed', 'on-time', 'kept-promise']);
    assert.equal(done.body.points, POINTS_CLOSED + POINTS_ON_TIME + POINTS_KEPT_PROMISE);
  } finally { await h.close(); }
});

test('taking back a planned day keeps the work and deadline and writes no award', async () => {
  const h = await startService('plan-unschedule');
  try {
    const made = await h.call('POST', '/commitments', make({ plannedFor: '2026-08-20' }));
    const before = made.body.commitment;
    const cleared = await h.call('PUT', `/commitments/${before.id}`, { plannedFor: null });

    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.commitment.plannedFor, null);
    assert.equal(cleared.body.commitment.title, before.title);
    assert.equal(cleared.body.commitment.dueAt, before.dueAt);
    assert.equal(cleared.body.commitment.doneAt, null);
    assert.deepEqual(await h.store.listAwards(), []);
    assert.equal((await h.call('GET', '/plan')).body.commitments.length, 1);
  } finally { await h.close(); }
});

test('closing twice does not pay twice', async () => {
  // A double tap, a retried request on a flaky connection, or two tabs open.
  // A total that can be farmed by pressing a button repeatedly is not a total
  // worth showing anybody.
  const h = await startService('plan-idempotent');
  try {
    const made = await h.call('POST', '/commitments', make());
    const first = await h.call('POST', `/commitments/${made.body.commitment.id}/done`);
    const second = await h.call('POST', `/commitments/${made.body.commitment.id}/done`);

    assert.equal(second.status, 200);
    assert.equal(second.body.alreadyDone, true);
    assert.deepEqual(second.body.awarded, []);
    const plan = await h.call('GET', '/plan');
    assert.equal(plan.body.points, first.body.points);
  } finally { await h.close(); }
});

test('re-opening a row corrects the tick and does not rewind the ledger', async () => {
  // The learner must be able to untick a row they ticked by mistake. The award
  // stays: a ledger that rewinds is one somebody can farm by ticking and
  // unticking, and the second close is idempotent, so it pays nothing.
  const h = await startService('plan-reopen');
  try {
    const made = await h.call('POST', '/commitments', make());
    const id = made.body.commitment.id;
    const done = await h.call('POST', `/commitments/${id}/done`);
    const reopened = await h.call('POST', `/commitments/${id}/reopen`);

    assert.equal(reopened.body.commitment.doneAt, null);
    const plan = await h.call('GET', '/plan');
    assert.equal(plan.body.points, done.body.points, 'the award it earned is still in the ledger');
  } finally { await h.close(); }
});

test('repairing study links on completed work preserves completion and every award', async () => {
  const h = await startService('plan-done-link-repair');
  try {
    await h.store.putCourse({
      id: 'c-history', title: 'Modern History', provider: '', url: '',
      material: [], topicIds: [], archivedAt: null, createdAt: NOW,
    });
    await h.store.putTopic(topic('war-causes', ['pin-1']));
    const made = await h.call('POST', '/commitments', make());
    const id = made.body.commitment.id;
    const done = await h.call('POST', `/commitments/${id}/done`);
    const awardsBefore = await h.store.listAwards();

    const repaired = await h.call('PUT', `/commitments/${id}`, {
      courseId: 'c-history', topicIds: ['war-causes'],
    });
    assert.equal(repaired.status, 200);
    assert.equal(repaired.body.commitment.id, id);
    assert.equal(repaired.body.commitment.doneAt, done.body.commitment.doneAt);
    assert.equal(repaired.body.commitment.courseId, 'c-history');
    assert.deepEqual(repaired.body.commitment.topicIds, ['war-causes']);
    assert.deepEqual(await h.store.listAwards(), awardsBefore);
    assert.equal((await h.call('GET', '/plan')).body.points, done.body.points);
  } finally { await h.close(); }
});

test('ticking, reopening and ticking again pays once, because it is one piece of work', async () => {
  /*
   * Ana ticked a reading, reopened it because she had only skimmed it, ticked
   * it again, and her score doubled: 0 → 18 → 18 → 36, with two identical award
   * triples in the ledger for one `commitmentId`. Two commitments and three
   * ticks bought her a star that was a third counterfeit.
   *
   * Both existing rules survive intact. Reopening still takes nothing away, and
   * the second close still pays nothing — what changed is that the second close
   * now reads the ledger rather than the tick, so putting a reopen between the
   * two presses is no longer a way around it.
   */
  const h = await startService('plan-reopen-retick');
  try {
    const made = await h.call('POST', '/commitments', make({ plannedFor: '2026-08-20' }));
    const id = made.body.commitment.id;
    const full = POINTS_CLOSED + POINTS_ON_TIME + POINTS_KEPT_PROMISE;

    const first = await h.call('POST', `/commitments/${id}/done`);
    assert.equal(first.body.points, full);

    await h.call('POST', `/commitments/${id}/reopen`);
    const afterReopen = await h.call('GET', '/plan');
    assert.equal(afterReopen.body.points, full, 'reopening still refunds nothing');

    const second = await h.call('POST', `/commitments/${id}/done`);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.awarded, [], 'this work has already been paid for');
    assert.equal(second.body.points, full);
    assert.equal(second.body.commitment.doneAt, NOW, 'and it is ticked, which is what she asked for');

    const awards = (await h.store.listAwards()).filter((a) => a.commitmentId === id);
    assert.equal(awards.length, 3, 'one award set for one commitment');
    assert.equal(new Set(awards.map((a) => a.reason)).size, 3, 'and no reason paid twice');

    // A third round, because a bug that survives one repetition often survives
    // exactly one.
    await h.call('POST', `/commitments/${id}/reopen`);
    await h.call('POST', `/commitments/${id}/done`);
    const plan = await h.call('GET', '/plan');
    assert.equal(plan.body.points, full);
    assert.equal(plan.body.stars, 0, 'no star is bought by pressing a button');
  } finally { await h.close(); }
});

test('a reopened row closed late cannot earn the on-time award it already missed', async () => {
  // The de-duplication is on the reason, not on the close. Closing late earns
  // `closed` alone; a later close of the same row is still late, and must not
  // become a second chance at a bonus for a deadline that has passed.
  const h = await startService('plan-reopen-late');
  try {
    const made = await h.call('POST', '/commitments', make({ dueAt: PAST }));
    const id = made.body.commitment.id;
    const first = await h.call('POST', `/commitments/${id}/done`);
    assert.deepEqual(first.body.awarded.map((a: { reason: string }) => a.reason), ['closed']);

    await h.call('POST', `/commitments/${id}/reopen`);
    const second = await h.call('POST', `/commitments/${id}/done`);
    assert.deepEqual(second.body.awarded, []);
    assert.equal(second.body.points, POINTS_CLOSED);
  } finally { await h.close(); }
});

test('every award in the ledger names what it was for', async () => {
  const h = await startService('plan-explainable');
  try {
    const made = await h.call('POST', '/commitments', make());
    await h.call('POST', `/commitments/${made.body.commitment.id}/done`);
    const plan = await h.call('GET', '/plan');
    for (const a of plan.body.recentAwards) {
      assert.equal(a.commitmentId, made.body.commitment.id);
      assert.ok(a.reason && a.at, 'an award nobody can explain is a number nobody can trust');
    }
  } finally { await h.close(); }
});

test('nothing the plan does reaches the signal ledger', async () => {
  /*
   * The law this whole layer is built around. Commitments are self-reported —
   * a date is typed, a box is ticked — and if any of it fed comfort, register
   * selection would drift on evidence about diligence rather than about
   * understanding, and the Composer would teach the wrong level to somebody
   * with a tidy calendar.
   */
  const h = await startService('plan-seam');
  try {
    // The topic has to be on the board before a commitment can point at it —
    // a link to something that is not there is refused, not stored.
    await h.store.putTopic(topic('t1', ['p1']));
    const before = (await h.store.listSignals()).length;
    const made = await h.call('POST', '/commitments', make({ topicIds: ['t1'] }));
    await h.call('POST', `/commitments/${made.body.commitment.id}/done`);
    await h.call('POST', `/commitments/${made.body.commitment.id}/reopen`);
    assert.equal((await h.store.listSignals()).length, before);
  } finally { await h.close(); }
});

test('a commitment with no title, or a date nobody can read, is refused plainly', async () => {
  const h = await startService('plan-refusals');
  try {
    const noTitle = await h.call('POST', '/commitments', { kind: 'task', dueAt: FUTURE });
    assert.equal(noTitle.status, 400);
    const badDate = await h.call('POST', '/commitments', make({ dueAt: 'sometime next week' }));
    assert.equal(badDate.status, 400);
    const badKind = await h.call('POST', '/commitments', make({ kind: 'homework' }));
    assert.equal(badKind.status, 400);
  } finally { await h.close(); }
});

/**
 * The link that makes teaching deadline-aware, and what happens when it lies.
 *
 * `topicIds` is the field `dueWeight` reads to pull a subject forward the week
 * an assignment is due. It has been on the wire since the ledger was written
 * and nothing wrote it: the form posted four fields, the card menu offered no
 * way to set it, and every commitment on a live board carried an empty array.
 * So it is writable now, on creation and after it, and an id that names no
 * topic is refused the way an unknown course or commitment already is.
 */
test('a commitment can be linked to board topics, and re-linked afterwards', async () => {
  const h = await startService('plan-topics');
  try {
    await h.store.putTopic(topic('t1', ['p1']));
    await h.store.putTopic(topic('t2', ['p2']));
    const made = await h.call('POST', '/commitments', make({ topicIds: ['t1'] }));
    assert.deepEqual(made.body.commitment.topicIds, ['t1']);

    const id = made.body.commitment.id;
    const relinked = await h.call('PUT', `/commitments/${id}`, { topicIds: ['t1', 't2'] });
    assert.equal(relinked.status, 200);
    assert.deepEqual(relinked.body.commitment.topicIds, ['t1', 't2']);
    // Everything else about it survives a write that was only about topics.
    assert.equal(relinked.body.commitment.title, 'Marketing analysis');
    assert.equal(relinked.body.commitment.dueAt, made.body.commitment.dueAt);

    // And it can be taken back to nothing, which is the only way to say the
    // work does not lean on anything on the board.
    const cleared = await h.call('PUT', `/commitments/${id}`, { topicIds: [] });
    assert.deepEqual(cleared.body.commitment.topicIds, []);
  } finally { await h.close(); }
});

test('a link to a topic the board does not have is refused rather than stored', async () => {
  const h = await startService('plan-topics-unknown');
  try {
    await h.store.putTopic(topic('t1', ['p1']));
    const made = await h.call('POST', '/commitments', make({ topicIds: ['t1', 'invented'] }));
    assert.equal(made.status, 400);
    assert.equal((await h.store.listCommitments()).length, 0, 'a refused link still wrote a row');

    const real = await h.call('POST', '/commitments', make({ topicIds: ['t1'] }));
    const bad = await h.call('PUT', `/commitments/${real.body.commitment.id}`, { topicIds: ['invented'] });
    assert.equal(bad.status, 400);
    const still = await h.store.getCommitment(real.body.commitment.id);
    assert.deepEqual([...still!.topicIds], ['t1'], 'the refused write moved the link anyway');
  } finally { await h.close(); }
});

test('direct course, material and assignment names are accepted whole or refused before storage', async () => {
  const h = await startService('whole-study-names');
  try {
    const exactCourse = '🧭'.repeat(160);
    const exactProvider = '🏫'.repeat(120);
    const made = await h.call('POST', '/courses', {
      title: exactCourse, provider: exactProvider,
    });
    assert.equal(made.status, 201);
    assert.equal(made.body.course.title, exactCourse);
    assert.equal(made.body.course.provider, exactProvider);

    for (const body of [
      { title: '🙂'.repeat(161), provider: 'place' },
      { title: 'Course', provider: '🙂'.repeat(121) },
      { title: 'Course', provider: { coerced: 'never' } },
    ]) assert.equal((await h.call('POST', '/courses', body)).status, 400);
    assert.equal((await h.store.listCourses()).length, 1);

    const courseId = made.body.course.id as string;
    const badCourseEdit = await h.call('PUT', `/courses/${courseId}`, {
      title: '🙂'.repeat(161), provider: 'changed',
    });
    assert.equal(badCourseEdit.status, 400);
    assert.equal((await h.store.getCourse(courseId))?.title, exactCourse);

    const exactMaterial = '📚'.repeat(180);
    const material = await h.call('POST', `/courses/${courseId}/material`, {
      title: exactMaterial, kind: 'reading',
    });
    assert.equal(material.status, 201);
    assert.equal(material.body.course.material[0].title, exactMaterial);
    const tooMuchMaterial = await h.call('POST', `/courses/${courseId}/material`, {
      title: '🙂'.repeat(181), kind: 'reading',
    });
    assert.equal(tooMuchMaterial.status, 400);
    assert.equal((await h.store.getCourse(courseId))?.material.length, 1);

    const exactAssignment = '📝'.repeat(180);
    const commitment = await h.call('POST', '/commitments', make({ title: exactAssignment }));
    assert.equal(commitment.status, 201);
    assert.equal(commitment.body.commitment.title, exactAssignment);
    assert.equal((await h.call('POST', '/commitments', make({
      title: '🙂'.repeat(181),
    }))).status, 400);
    const badCommitmentEdit = await h.call(
      'PUT', `/commitments/${commitment.body.commitment.id}`, { title: '🙂'.repeat(181) },
    );
    assert.equal(badCommitmentEdit.status, 400);
    assert.equal((await h.store.getCommitment(commitment.body.commitment.id))?.title, exactAssignment);

    const series = await h.call('POST', '/commitment-series', make({
      title: exactAssignment, count: 2, clientRef: 'whole-title-series',
    }));
    assert.equal(series.status, 201);
    assert.deepEqual(series.body.commitments.map((row: { title: string }) => row.title),
      [exactAssignment, exactAssignment]);
    const beforeSeriesOverflow = (await h.store.listCommitments()).length;
    assert.equal((await h.call('POST', '/commitment-series', make({
      title: '🙂'.repeat(181), count: 2, clientRef: 'overflow-title-series',
    }))).status, 400);
    assert.equal((await h.store.listCommitments()).length, beforeSeriesOverflow);
  } finally { await h.close(); }
});

test('closing something that is not there is a 404, not a fabricated award', async () => {
  const h = await startService('plan-missing');
  try {
    const r = await h.call('POST', '/commitments/nope/done');
    assert.equal(r.status, 404);
    const plan = await h.call('GET', '/plan');
    assert.equal(plan.body.points, 0);
  } finally { await h.close(); }
});

test('deleting a commitment leaves the awards it earned', async () => {
  const h = await startService('plan-delete');
  try {
    const made = await h.call('POST', '/commitments', make());
    const done = await h.call('POST', `/commitments/${made.body.commitment.id}/done`);
    await h.call('DELETE', `/commitments/${made.body.commitment.id}`);

    const plan = await h.call('GET', '/plan');
    assert.equal(plan.body.commitments.length, 0);
    assert.equal(plan.body.points, done.body.points,
      'deleting the note about an assignment does not undo having handed it in');
  } finally { await h.close(); }
});

// --------------------------------------------------------------- the courses

test('a course keeps two counts and never a percentage', async () => {
  const h = await startService('course-progress');
  try {
    const made = await h.call('POST', '/courses', { title: 'Short story writing', provider: 'NCW' });
    const id = made.body.course.id;
    await h.call('POST', `/courses/${id}/material`, { title: 'Lecture 1', kind: 'video', url: 'https://example.test/1' });
    await h.call('POST', `/courses/${id}/material`, { title: 'Lecture 2', kind: 'video' });

    const listed = await h.call('GET', '/courses');
    const course = listed.body.courses[0];
    assert.equal(course.progress.covered, 0);
    assert.equal(course.progress.materialCount, 2);
    // no combined number. A course percentage is a comfort number with a
    // course's name on it.
    assert.equal(course.progress.percent, undefined);
  } finally { await h.close(); }
});

test('marking material done is a toggle, because the learner is the authority', async () => {
  const h = await startService('course-toggle');
  try {
    const made = await h.call('POST', '/courses', { title: 'Short story writing' });
    const id = made.body.course.id;
    const withOne = await h.call('POST', `/courses/${id}/material`, { title: 'Lecture 1', kind: 'class' });
    const materialId = withOne.body.course.material[0].id;

    const on = await h.call('POST', `/courses/${id}/material/${materialId}/done`);
    assert.equal(on.body.course.material[0].doneAt, NOW);
    const off = await h.call('POST', `/courses/${id}/material/${materialId}/done`);
    assert.equal(off.body.course.material[0].doneAt, null);
  } finally { await h.close(); }
});

test('a learner can add the missing safe link without replacing material truth', async () => {
  const h = await startService('course-material-link');
  try {
    const made = await h.call('POST', '/courses', { title: 'Short story writing' });
    const courseId = made.body.course.id;
    const withOne = await h.call('POST', `/courses/${courseId}/material`, {
      title: 'Lecture 1', kind: 'reading', minutes: 12,
    });
    const before = withOne.body.course.material[0];
    const path = `/courses/${courseId}/material/${before.id}`;

    const unsafe = await h.call('PUT', path, { url: 'javascript:alert(1)' });
    assert.equal(unsafe.status, 400);
    assert.equal((await h.store.getCourse(courseId))?.material[0]?.url, '');

    const saved = await h.call('PUT', path, { url: 'https://example.test/lecture-1' });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.material, { ...before, url: 'https://example.test/lecture-1' });
    assert.deepEqual(saved.body.course.material, [saved.body.material]);
  } finally { await h.close(); }
});

test('material correction changes only learner-editable details', async () => {
  const h = await startService('course-material-correction');
  try {
    const made = await h.call('POST', '/courses', { title: 'Systems Design' });
    const courseId = made.body.course.id;
    const added = await h.call('POST', `/courses/${courseId}/material`, {
      title: 'Cache lecture', kind: 'video', url: 'https://example.test/old', minutes: 12,
    });
    const original = {
      ...added.body.course.material[0], progressMinutes: 5, doneAt: NOW,
      pinIds: ['p1'], source: { sourceId: 's1', quote: 'cache source words' },
    };
    await h.store.putCourse({ ...added.body.course, material: [original] });
    const path = `/courses/${courseId}/material/${original.id}`;

    const changed = await h.call('PUT', path, {
      title: 'Caching fundamentals', url: '', kind: 'reading', minutes: 18,
    });
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.body.material, {
      ...original, title: 'Caching fundamentals', url: '', kind: 'reading', minutes: 18,
    });
    assert.deepEqual((await h.store.getCourse(courseId))?.material, [changed.body.material]);

    assert.equal((await h.call('PUT', path, { id: 'replacement' })).status, 400);
    assert.equal((await h.call('PUT', path, { url: 'javascript:alert(1)' })).status, 400);
    assert.equal((await h.call('PUT', path, { url: ['https://example.test/wrong'] })).status, 400);
    assert.equal((await h.call('PUT', path, { minutes: [9] })).status, 400);
    assert.deepEqual((await h.store.getCourse(courseId))?.material, [changed.body.material]);
  } finally { await h.close(); }
});

test('one material can be removed only from an active course', async () => {
  const h = await startService('course-material-remove');
  try {
    const course = (await h.call('POST', '/courses', { title: 'Systems Design' })).body.course;
    const first = await h.call('POST', `/courses/${course.id}/material`, {
      title: 'Caching fundamentals', kind: 'reading', minutes: 12,
    });
    const second = await h.call('POST', `/courses/${course.id}/material`, {
      title: 'Queues', kind: 'reading', minutes: 8,
    });
    const materialId = first.body.course.material[0].id;
    const path = `/courses/${course.id}/material/${materialId}`;

    await h.call('PUT', `/courses/${course.id}`, { archived: true });
    assert.equal((await h.call('DELETE', path)).status, 400);
    assert.equal((await h.call('PUT', path, { title: 'Changed while archived' })).status, 400);

    await h.call('PUT', `/courses/${course.id}`, { archived: false });
    const removed = await h.call('DELETE', path);
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.deleted, { courseId: course.id, materialId });
    assert.deepEqual((await h.store.getCourse(course.id))?.material.map((row) => row.title), ['Queues']);
    assert.equal((await h.call('DELETE', path)).status, 404);
    assert.equal(second.status, 201);
  } finally { await h.close(); }
});

test('a link that is not a link is refused, not rendered', async () => {
  /*
   * This string becomes an href, and a course can be created from a pasted
   * syllabus — text nobody wrote by hand. `javascript:` is how a bookmark list
   * becomes a script injection.
   */
  const h = await startService('course-hrefs');
  try {
    const made = await h.call('POST', '/courses', { title: 'Course', url: 'javascript:alert(1)' });
    assert.equal(made.body.course.url, '', 'a hostile course link is dropped rather than stored');

    const id = made.body.course.id;
    const bad = await h.call('POST', `/courses/${id}/material`, {
      title: 'Lecture', kind: 'video', url: 'javascript:alert(1)',
    });
    assert.equal(bad.status, 400, 'a hostile material link is refused outright');
  } finally { await h.close(); }
});

test('course repair and archive preserve identity, sources, material and topic links', async () => {
  const h = await startService('course-maintain-metadata');
  try {
    const made = await h.call('POST', '/courses', {
      title: 'Reliable system', provider: 'Udacity', url: 'https://example.test/old',
    });
    const original = made.body.course;
    const withMaterial = await h.call('POST', `/courses/${original.id}/material`, {
      title: 'Failure lecture', kind: 'video', url: 'https://example.test/lecture', minutes: 12,
    });
    await h.store.putCourse({
      ...withMaterial.body.course,
      topicIds: ['t1'],
      objectives: [{ id: 'o1', text: 'Explain retry safety', source: null }],
      sources: [{
        id: 's1', kind: 'syllabus', title: 'Outline', text: 'source words', url: null,
        capturedAt: NOW, digest: 'sha256:one',
      }],
    });

    const changed = await h.call('PUT', `/courses/${original.id}`, {
      title: 'Reliable systems', provider: 'Independent', url: 'https://example.test/new',
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.course.id, original.id);
    assert.equal(changed.body.course.createdAt, original.createdAt);
    assert.equal(changed.body.course.material[0].title, 'Failure lecture');
    assert.deepEqual(changed.body.course.topicIds, ['t1']);
    assert.equal(changed.body.course.sources[0].digest, 'sha256:one');

    const archived = await h.call('PUT', `/courses/${original.id}`, { archived: true });
    assert.equal(archived.body.course.archivedAt, NOW);
    let listed = await h.call('GET', '/courses');
    assert.deepEqual(listed.body.courses, []);
    assert.equal(listed.body.archivedCourses[0].title, 'Reliable systems');
    assert.deepEqual(listed.body.archivedCourses[0].commitments, []);

    const restored = await h.call('PUT', `/courses/${original.id}`, { archived: false });
    assert.equal(restored.body.course.archivedAt, null);
    listed = await h.call('GET', '/courses');
    assert.equal(listed.body.courses[0].title, 'Reliable systems');
    assert.deepEqual(listed.body.archivedCourses, []);
  } finally { await h.close(); }
});

test('moving material transfers the exact receipt once between active courses', async () => {
  const h = await startService('course-maintain-move');
  try {
    const source = (await h.call('POST', '/courses', { title: 'Wrong course' })).body.course;
    const target = (await h.call('POST', '/courses', { title: 'Right course' })).body.course;
    const added = await h.call('POST', `/courses/${source.id}/material`, {
      title: 'Retry lecture', kind: 'video', url: 'https://example.test/retry', minutes: 12,
    });
    const material = {
      ...added.body.course.material[0], progressMinutes: 5, doneAt: NOW,
      pinIds: ['p1'], source: { sourceId: 's1', quote: 'exact source words' },
    };
    await h.store.putCourse({ ...added.body.course, material: [material] });

    const moved = await h.call('POST',
      `/courses/${source.id}/material/${material.id}/move`, { courseId: target.id });
    assert.equal(moved.status, 200);
    assert.deepEqual(moved.body.material, material);
    assert.deepEqual(moved.body.source.material, []);
    assert.deepEqual(moved.body.destination.material, [material]);
    assert.deepEqual((await h.store.getCourse(source.id))?.material, []);
    assert.deepEqual((await h.store.getCourse(target.id))?.material, [material]);

    const again = await h.call('POST',
      `/courses/${source.id}/material/${material.id}/move`, { courseId: target.id });
    assert.equal(again.status, 404, 'a retry must not duplicate a material row already moved');
  } finally { await h.close(); }
});

test('permanent course deletion requires archive and leaves linked history stored', async () => {
  const h = await startService('course-maintain-delete');
  try {
    const course = (await h.call('POST', '/courses', { title: 'Old course' })).body.course;
    const withMaterial = await h.call('POST', `/courses/${course.id}/material`, {
      title: 'Old lecture', kind: 'reading',
    });
    await h.store.putCourse({
      ...withMaterial.body.course,
      objectives: [{ id: 'o1', text: 'Old objective', source: null }],
      sources: [{
        id: 's1', kind: 'syllabus', title: 'Old source', text: 'words', url: null,
        capturedAt: NOW, digest: 'sha256:old',
      }],
    });
    const commitment = (await h.call('POST', '/commitments', make({
      title: 'Historical assignment', courseId: course.id,
    }))).body.commitment;

    assert.equal((await h.call('DELETE', `/courses/${course.id}`)).status, 409);
    await h.call('PUT', `/courses/${course.id}`, { archived: true });
    const removed = await h.call('DELETE', `/courses/${course.id}`);
    assert.deepEqual(removed.body.deleted, {
      courseId: course.id, materialCount: 1, objectiveCount: 1, sourceCount: 1,
    });
    assert.equal(await h.store.getCourse(course.id), null);
    assert.equal((await h.store.getCommitment(commitment.id))?.courseId, course.id,
      'historical work is not silently relinked during course deletion');

    const listed = await h.call('GET', '/courses');
    assert.deepEqual(listed.body.unattached.commitments.map((row: { id: string }) => row.id),
      [commitment.id], 'surviving work with a removed course must remain visible');
  } finally { await h.close(); }
});

// ------------------------------------------------- what a course can now say

/**
 * It could not, and the reason was here rather than in the panel. `GET
 * /courses` answered with courses and nothing else, so a deadline that belonged
 * to a course was only ever visible in the Plan, and the topics a course grew
 * were a number with no words behind it. The join below is additive — every
 * field the room already read is untouched — and it is one more store read
 * rather than one per course.
 */

test("a course comes back with its own deadlines, ordered the way the plan orders them", async () => {
  const h = await startService('course-join-commitments');
  try {
    const made = await h.call('POST', '/courses', { title: 'Short story writing' });
    const id = made.body.course.id;
    const far = await h.call('POST', '/commitments', make({ title: 'Portfolio', dueAt: '2026-09-30', courseId: id }));
    const near = await h.call('POST', '/commitments', make({ title: 'Story draft', dueAt: FUTURE, courseId: id }));
    await h.call('POST', '/commitments', make({ title: 'Nothing to do with it' }));

    const listed = await h.call('GET', '/courses');
    const course = listed.body.courses[0];
    assert.deepEqual(course.commitments.map((c: { id: string }) => c.id),
      [near.body.commitment.id, far.body.commitment.id],
      'a course lists its deadlines in some order other than the one the Plan uses');
    // The same computed field the Plan carries, so "late" means one thing.
    assert.equal(course.commitments[0].state, 'soon');
    // And the existing answer is untouched.
    assert.equal(course.progress.materialCount, 0);
    assert.equal(course.progress.percent, undefined);
  } finally { await h.close(); }
});

test('a closed deadline is not something a course has coming', async () => {
  const h = await startService('course-join-done');
  try {
    const made = await h.call('POST', '/courses', { title: 'Course' });
    const id = made.body.course.id;
    const one = await h.call('POST', '/commitments', make({ courseId: id }));
    await h.call('POST', `/commitments/${one.body.commitment.id}/done`);

    const listed = await h.call('GET', '/courses');
    assert.deepEqual(listed.body.courses[0].commitments, [],
      'work that is behind the learner is still being shown as ahead of them');
  } finally { await h.close(); }
});

test('the topics a course grew come back with the board’s own words on them', async () => {
  const h = await startService('course-join-topics');
  try {
    await h.store.putTopic(topic('t1', [], { label: 'Scene turns', state: 'settled' }));
    await h.store.putTopic(topic('t2', [], { label: 'Dialogue' }));
    const made = await h.call('POST', '/courses', { title: 'Course' });
    const course = made.body.course;
    await h.store.putCourse({ ...course, topicIds: ['t1', 't2', 'gone'] });

    const listed = await h.call('GET', '/courses');
    const back = listed.body.courses[0];
    assert.deepEqual(back.topics, [{ id: 't1', label: 'Scene turns' }, { id: 't2', label: 'Dialogue' }],
      'a topic the board no longer holds is being named anyway');
    // Two counts and never a percentage: naming them does not change either.
    assert.equal(back.progress.topicCount, 3);
    assert.equal(back.progress.learnt, 1);
  } finally { await h.close(); }
});

test('completed course work keeps its linked topic inside that course without rewriting it', async () => {
  /**
   *. The compiled journey linked Web Accessibility to an assignment in
   * Practical Web Accessibility, completed the assignment, and then My
   * studies put the topic under "Not in a course". The commitment still held
   * both sides of the real relationship; `/courses` simply ignored it.
   *
   * This is deliberately a projection test. The course's canonical topic list
   * stays empty, and so does its evidence denominator: linking work to a topic
   * says where the work belongs, not that the course itself produced evidence.
   */
  const h = await startService('course-work-topic-continuity');
  try {
    await h.store.putTopic(topic('t1', [], { label: 'Web Accessibility' }));
    const made = await h.call('POST', '/courses', { title: 'Practical Web Accessibility' });
    const course = made.body.course;
    const work = await h.call('POST', '/commitments', make({
      title: 'Audit one web page', courseId: course.id, topicIds: ['t1'],
    }));
    await h.call('POST', `/commitments/${work.body.commitment.id}/done`);

    const listed = await h.call('GET', '/courses');
    const back = listed.body.courses[0];
    assert.deepEqual(back.topics, [{ id: 't1', label: 'Web Accessibility' }]);
    assert.deepEqual(listed.body.unattached.topics, [],
      'a topic linked to completed work for this course fell into the loose pile');
    assert.deepEqual(back.commitments, [], 'completed work came back as Coming up');
    assert.deepEqual(back.topicIds, [], 'the derived relationship was persisted as curriculum');
    assert.equal(back.progress.topicCount, 0,
      'an assignment link widened the course evidence denominator');
    assert.deepEqual((await h.store.getCourse(course.id))?.topicIds, [],
      'rendering My studies mutated the canonical course');
    assert.deepEqual(listed.body.outcomeContext, {
      courses: [{ id: course.id, title: 'Practical Web Accessibility' }],
      commitments: [{
        id: work.body.commitment.id,
        title: 'Audit one web page',
        courseId: course.id,
      }],
      topics: [{ id: 't1', label: 'Web Accessibility' }],
    }, 'the result form lost the completed assignment while the course already had it in memory');
  } finally { await h.close(); }
});

test('what belongs to no course comes back too, or the room shows a tidy fiction', async () => {
  const h = await startService('course-unattached');
  try {
    await h.store.putTopic(topic('t1', [], { label: 'Scene turns' }));
    await h.store.putTopic(topic('t2', [], { label: 'Borrow checker' }));
    await h.store.putTopic(topic('t3', [], { label: 'Retired', retiredByUser: true }));
    const made = await h.call('POST', '/courses', { title: 'Course' });
    await h.store.putCourse({ ...made.body.course, topicIds: ['t1'] });

    await h.call('POST', '/commitments', make({ title: 'Two hours on Rust', kind: 'study' }));
    await h.call('POST', '/commitments', make({ title: 'Seminar', kind: 'lesson' }));
    // An assignment with no course is the Plan's business, not this room's: it
    // is a piece of assessed work, not a thing somebody is studying.
    await h.call('POST', '/commitments', make({ title: 'Tax return', kind: 'task' }));
    await h.call('POST', '/commitments', make({ title: 'Marketing analysis' }));

    const listed = await h.call('GET', '/courses');
    assert.deepEqual(
      listed.body.unattached.commitments.map((c: { title: string }) => c.title).sort(),
      ['Seminar', 'Two hours on Rust'],
    );
    // A topic in a course is not loose, and a topic the learner retired is not
    // something they are studying.
    assert.deepEqual(listed.body.unattached.topics, [{ id: 't2', label: 'Borrow checker' }]);
  } finally { await h.close(); }
});

test('an archived course takes its deadlines off the screen with it', async () => {
  const h = await startService('course-archived-join');
  try {
    const made = await h.call('POST', '/courses', { title: 'Course' });
    const course = made.body.course;
    await h.call('POST', '/commitments', make({ courseId: course.id }));
    await h.store.putCourse({ ...course, archivedAt: NOW });

    const listed = await h.call('GET', '/courses');
    assert.deepEqual(listed.body.courses, []);
    assert.equal(listed.body.archivedCourses[0].id, course.id);
    // And it does not fall out into the loose pile either: it belongs to a
    // course, and the course is simply put away.
    assert.deepEqual(listed.body.unattached.commitments, []);
  } finally { await h.close(); }
});
