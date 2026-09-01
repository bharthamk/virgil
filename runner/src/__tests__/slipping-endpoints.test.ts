import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Commitment, Course, Signal } from '@sb/core';

import { NOW, noLlm, startService, type Harness } from './service-harness.js';

/**
 * WHAT KEEPS SLIPPING, THROUGH THE DOORS IT ACTUALLY USES.
 *
 * The arithmetic is proved pure in `core/src/__tests__/avoidance.test.ts`. What
 * is proved here is the wiring, and it is three separate claims that a pure
 * test cannot make: that the Insights read carries the rows with their numbers,
 * that the learner's deferral is honoured by the RANKER and not only by the
 * screen, and that the forward-only ledger refuses a mark that is not a pass
 * over.
 *
 * A real service over a real `JsonStore`, with no model reachable, because
 * nothing on this path is allowed to make a model call.
 */

const ago = (days: number): string =>
  new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

const course = (): Course => ({
  id: 'k1', title: 'Systems', provider: '', url: '', topicIds: [],
  material: [{
    id: 'm1', title: 'Agent lecture', url: 'https://example.test/lecture', kind: 'reading',
    minutes: 30, doneAt: null, pinIds: [], addedAt: ago(40),
  }],
  archivedAt: null, createdAt: ago(60),
});

const overdue = (): Commitment => ({
  id: 'late-1', title: 'Stats problem set 3', kind: 'assignment', courseId: 'k1',
  topicIds: [], dueAt: ago(12), plannedFor: null, estimateMinutes: null, notes: '',
  doneAt: null, createdAt: ago(40),
});

/** Nine finished things, on a topic none of the slipping items is about. */
const busyElsewhere = (): readonly Signal[] =>
  Array.from({ length: 9 }, (_, index) => ({
    id: `s${index}`, topicId: 'unrelated', type: 'section-completed' as const,
    direction: 'positive' as const, at: ago(index + 1),
    sourceEvent: 'test', invalidated: false,
  }));

/** A board where one overdue assignment and one course reading have both stood
 *  untouched since the day they arrived, while nine other things were finished
 *  in the same window. */
async function slippingBoard(tag: string): Promise<Harness> {
  const h = await startService(tag, { llm: noLlm() });
  await h.store.putCourse(course());
  await h.store.putCommitment(overdue());
  for (const signal of busyElsewhere()) await h.store.appendSignal(signal);
  return h;
}

test('Insights carries the slipping rows, with the evidence as numbers', async (t) => {
  const h = await slippingBoard('slipping-read');
  t.after(() => h.close());

  const read = await h.call('GET', '/model', undefined, { 'x-virgil-timezone': 'UTC' });
  assert.equal(read.status, 200);
  const rows = read.body.slipping as readonly Record<string, string>[];
  assert.ok(rows.length >= 1 && rows.length <= 3, 'three at most ever leave');
  const row = rows.find((candidate) => candidate.key === 'commitment:late-1');
  assert.equal(row?.title, 'Stats problem set 3');
  assert.equal(row?.standingLine, 'Past its date, and you have not touched it for 40 days.',
    'the assignment has been on the board untouched since the day it was created');
  assert.equal(row?.elsewhereLine, 'In that time you finished 9 other things on your board.');
  assert.equal(row?.activationLine, '1 minute of it counts.');
  assert.equal(row?.passedOverLine, null, 'a ledger with nothing in it makes no claim');
  assert.doesNotMatch(JSON.stringify(read.body.slipping), /avoid/i,
    'the word this is organised under is never rendered');
});

test('a quiet board says nothing rather than saying well done', async (t) => {
  const h = await startService('slipping-quiet', { llm: noLlm() });
  t.after(() => h.close());
  await h.store.putCommitment(overdue());
  const read = await h.call('GET', '/model');
  assert.deepEqual(read.body.slipping, [],
    'silence with no work beside it is a busy fortnight, and there is no praise line either');
});

test('setting one aside is honoured by the screen and by the ranker, for a fortnight', async (t) => {
  const h = await slippingBoard('slipping-set-aside');
  t.after(() => h.close());

  const done = await h.call('POST', '/model/slipping/set-aside', { key: 'commitment:late-1' });
  assert.equal(done.status, 200);
  assert.equal((await h.store.getPrefs()).setAside?.['commitment:late-1'], NOW);

  const after = (await h.call('GET', '/model')).body.slipping as readonly { key: string }[];
  assert.equal(after.some((row) => row.key === 'commitment:late-1'), false);

  const today = await h.call('GET', '/today?minutes=1');
  const options = [today.body.next.primary, ...today.body.next.alternatives];
  assert.equal(
    options.some((option: { reasons?: { code: string }[] }) =>
      option.reasons?.some((reason) => reason.code === 'slipping')
      && option === today.body.next.primary && today.body.next.primary.id === 'commitment:late-1'),
    false,
    'the deferral removes the nudge as well as the row',
  );
});

test('a deferral cannot be written or cleared through the preferences door', async (t) => {
  const h = await slippingBoard('slipping-prefs-door');
  t.after(() => h.close());
  await h.call('POST', '/model/slipping/set-aside', { key: 'commitment:late-1' });

  const forged = await h.call('PUT', '/prefs', { setAside: {}, targetMinutes: 15 });
  assert.equal(forged.status, 200);
  assert.equal((await h.store.getPrefs()).setAside?.['commitment:late-1'], NOW,
    'the patch validator does not name the field, so a client cannot reach it');
});

test('a key that names nothing on the board is refused before it becomes a record', async (t) => {
  const h = await slippingBoard('slipping-bad-key');
  t.after(() => h.close());
  for (const key of ['', 'nonsense', 'topic:t1', `material:${'x'.repeat(400)}`]) {
    assert.equal((await h.call('POST', '/model/slipping/set-aside', { key })).status, 400);
  }
  assert.equal((await h.store.getPrefs()).setAside, undefined);
});

test('the passed-over ledger takes a real pass over and refuses everything else', async (t) => {
  const h = await slippingBoard('slipping-ledger');
  t.after(() => h.close());

  const same = await h.call('POST', '/model/slipping/passed-over', {
    offeredId: 'commitment:late-1', chosenId: 'commitment:late-1', offeredReason: 'deadline',
  });
  assert.equal(same.status, 400, 'pressing the thing that was offered is not passing it over');
  assert.equal((await h.store.getPassedOverLedger()).marks.length, 0);

  assert.equal((await h.call('POST', '/model/slipping/passed-over', {
    offeredId: 'commitment:late-1', chosenId: 'material:k1:m1', offeredReason: 'deadline',
  })).status, 200);
  const ledger = await h.store.getPassedOverLedger();
  assert.equal(ledger.marks.length, 1);
  assert.equal(ledger.startedAt, NOW);

  const row = ((await h.call('GET', '/model')).body.slipping as readonly Record<string, string>[])
    .find((candidate) => candidate.key === 'commitment:late-1');
  assert.equal(row?.passedOverLine, 'Offered and passed over once since 19 August 2026.');
});

test('the one-minute block is nudged toward what is slipping, and no other window is', async (t) => {
  const h = await slippingBoard('slipping-nudge');
  t.after(() => h.close());

  const nudged = await h.call('GET', '/today?minutes=1', undefined, { 'x-virgil-timezone': 'UTC' });
  const material = [nudged.body.next.primary, ...nudged.body.next.alternatives]
    .find((option: { id: string }) => option.id === 'material:k1:m1');
  assert.ok(material, 'the reading is still on offer');
  assert.equal(material.reasons[0].code, 'slipping');
  assert.equal(material.reasons[0].text, 'This keeps slipping. 1 minute of it counts.');

  const ordinary = await h.call('GET', '/today?minutes=5', undefined, { 'x-virgil-timezone': 'UTC' });
  const plain = [ordinary.body.next.primary, ...ordinary.body.next.alternatives]
    .find((option: { id: string }) => option.id === 'material:k1:m1');
  assert.equal(
    plain?.reasons?.some((reason: { code: string }) => reason.code === 'slipping'), false,
    'three and five minutes are windows for the work the learner came to do',
  );
});

test('what is due today still leads, however long something else has been slipping', async (t) => {
  const h = await slippingBoard('slipping-vs-deadline');
  t.after(() => h.close());
  await h.store.putCommitment({
    ...overdue(), id: 'due-today', title: 'Lab writeup', courseId: null,
    dueAt: NOW.slice(0, 10), createdAt: NOW,
  });

  const today = await h.call('GET', '/today?minutes=1', undefined, { 'x-virgil-timezone': 'UTC' });
  assert.equal(today.body.next.primary.id, 'commitment:late-1',
    'the overdue one leads, because late outranks due today and both outrank a nudge');
  const options = [today.body.next.primary, ...today.body.next.alternatives];
  const nudged = options.find((option: { id: string }) => option.id === 'material:k1:m1');
  assert.ok(!nudged || nudged.rank < 860, 'a nudged item never reaches what is due today');
  const leader = options.find((option: { id: string }) => option.id === 'commitment:late-1');
  assert.equal(leader.rank, 925,
    'and the nudge never demotes the overdue work it is about, either');
});
