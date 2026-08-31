import { test } from 'node:test';
import assert from 'node:assert/strict';

import { JsonStore } from '../json-store.js';
import { MemFs, parkAt } from './store-fs-harness.js';
import { aPin, aTopic } from './store-contract.js';
import type { Signal } from '@sb/core';

/**
 * The delete storm, and the topic count that dropped once.
 *
 * A sibling lane reported seeing a topic count fall during a long DELETE
 * sequence, could not reproduce it in five targeted attempts in isolation, and
 * guessed at a read taken between a queued write and its flush. The guess is
 * wrong, and `store-serialisation.test.ts` is why: a read on the writing handle
 * always sees the newest in-memory state, so there is no window on that handle
 * for a read to fall into. The count did drop. It dropped for a reason that has
 * nothing to do with timing, which is exactly why isolating the delete that
 * seemed to cause it made it disappear — the cause was a topic somewhere else on
 * the board.
 *
 * `deletePin` rebuilt the whole topic array and filtered it on
 * `pinIds.length > 0 || retiredByUser`, so ANY topic that already had no pins
 * was collected by ANY pin deletion, along with its signals, edges and
 * statements. Its own comment says the cascade is scoped to "a topic this
 * deletion emptied"; the filter was not scoped to anything.
 *
 * That is a real deletion of a learner's history, silent, triggered by deleting
 * an unrelated pin. Under a storm it needs two things to co-occur — a pinless
 * live topic and a delete of something else — which is why it reads as a once.
 */

const PATH = '/store/db.json';

const store = (): { fs: MemFs; store: JsonStore } => {
  const fs = new MemFs();
  return { fs, store: new JsonStore(PATH, fs) };
};

const sig = (id: string, topicId: string, sourceEvent: string): Signal => ({
  id, topicId, type: 'answer-correct', direction: 'positive',
  at: '2026-08-19T03:00:00.000Z', sourceEvent, invalidated: false,
});

/**
 * Ids chosen to break anything that treats an id as a path, a key, or a shell
 * word. `__proto__` and `constructor` are in here because the alias map is a
 * plain object and a merge writes learner-controlled ids into it as keys.
 */
const HOSTILE = [
  '../../etc/passwd',
  '..',
  '.',
  '__proto__',
  'constructor',
  'a b\tc\nd',
  'id"with\'quotes',
  '\\backslash\\',
  'ünïcødé-🧪',
  'x'.repeat(300),
] as const;

// --------------------------------------------------- the anomaly, minimised

test('deleting a pin does not take a topic that was already empty', async () => {
  const { store: s } = store();
  await s.putPin(aPin('p1', { topicId: 't1' }));
  await s.putTopic(aTopic('t1', ['p1']));
  // A live topic with no pins. Legal: `putTopic` accepts it, `listTopics`
  // returns it, and the store's own cascade suite builds one.
  await s.putTopic(aTopic('empty', []));

  await s.deletePin('p1');

  assert.deepEqual((await s.listTopics()).map((t) => t.id), ['empty'],
    'the topic that emptied goes; a topic the deletion never touched stays');
});

test('deleting a pin does not take an untouched topic\'s history with it', async () => {
  const { store: s } = store();
  await s.putPin(aPin('p1', { topicId: 't1' }));
  await s.putTopic(aTopic('t1', ['p1']));
  await s.putTopic(aTopic('empty', []));
  await s.appendSignal(sig('keep', 'empty', 'section:sess1:0'));
  await s.putEdges([{ from: 'empty', to: 't1', confidence: 0.9, justification: 'j' }]);
  await s.putStatement({
    id: 'st1', text: 'you keep coming back to this', topicId: 'empty',
    userEdited: false, evidenceSignalIds: ['keep'], updatedAt: '2026-08-19T03:00:00.000Z',
  });

  await s.deletePin('p1');

  assert.deepEqual((await s.listSignals()).map((x) => x.id), ['keep'],
    'a learner\'s comfort history is not collateral of deleting some other pin');
  assert.deepEqual((await s.listStatements()).map((x) => x.id), ['st1']);
});

test('a retired topic emptied by an earlier delete survives a later unrelated one', async () => {
  // The storm shape at its smallest, and the one case the old filter got right:
  // `|| retiredByUser` kept it. It is here so the fix cannot be a narrowing that
  // loses it.
  const { store: s } = store();
  await s.putPin(aPin('p1', { topicId: 't1' }));
  await s.putPin(aPin('p2', { topicId: 't2' }));
  await s.putTopic(aTopic('t1', ['p1']));
  await s.putTopic(aTopic('t2', ['p2'], { retiredByUser: true }));
  await s.appendSignal(sig('g2', 't2', 'section:sess1:1'));

  await s.deletePin('p2');   // t2 is retired, so it survives with no pins
  await s.deletePin('p1');   // and must still be here afterwards

  assert.deepEqual((await s.listTopics()).map((t) => t.id), ['t2']);
  assert.deepEqual((await s.listSignals()).map((x) => x.id), ['g2'],
    'retirement is the learner\'s decision and an unrelated delete does not overrule it');
});

// ------------------------------------------------------------- the storm

test('a long delete storm over hostile ids only ever loses the topics it emptied', async () => {
  // The reported shape, reconstructed: hostile ids, deletes over both pins and
  // topics, and a read after every single step. Every topic here holds exactly
  // one pin, so the expected count after each delete is arithmetic rather than a
  // judgement — and a drop of two is the anomaly, visible on the step it happens.
  const { store: s } = store();
  for (const [i, id] of HOSTILE.entries()) {
    await s.putPin(aPin(`pin:${id}`, { topicId: `topic:${id}` }));
    await s.putTopic(aTopic(`topic:${id}`, [`pin:${id}`]));
    await s.appendSignal(sig(`g${i}`, `topic:${id}`, `section:sess:${i}`));
  }
  assert.equal((await s.listTopics()).length, HOSTILE.length);

  let expected = HOSTILE.length;
  for (const [i, id] of HOSTILE.entries()) {
    // Alternate the two routes a learner has to delete something, because they
    // reach the cascade differently: one through `deletePin`, one through
    // `deleteTopic`'s per-pin loop.
    if (i % 2 === 0) await s.deletePin(`pin:${id}`);
    else await s.deleteTopic(`topic:${id}`, { deletePins: true });
    expected -= 1;

    const topics = await s.listTopics();
    assert.equal(topics.length, expected,
      `after deleting ${JSON.stringify(id)} the board lost more than the one topic it emptied`);
    assert.equal((await s.listSignals()).length, expected,
      'and the ledger lost exactly the history of the topics that died');
    assert.equal((await s.listPins()).length, expected);
  }
  assert.deepEqual([...await s.listTopics()], []);
});

test('a storm with a pinless topic on the board leaves that topic alone throughout', async () => {
  const { store: s } = store();
  await s.putTopic(aTopic('parked', []));
  await s.appendSignal(sig('parked-history', 'parked', 'section:sess:parked'));
  for (const id of HOSTILE) {
    await s.putPin(aPin(`pin:${id}`, { topicId: `topic:${id}` }));
    await s.putTopic(aTopic(`topic:${id}`, [`pin:${id}`]));
  }

  for (const id of HOSTILE) {
    await s.deletePin(`pin:${id}`);
    assert.ok((await s.listTopics()).some((t) => t.id === 'parked'),
      `deleting pin:${id} took a topic that never held it`);
  }

  assert.deepEqual((await s.listTopics()).map((t) => t.id), ['parked']);
  assert.deepEqual((await s.listSignals()).map((x) => x.id), ['parked-history']);
});

test('un-retiring an emptied merge target does not make it collateral of the next delete', async () => {
  // How a learner reaches a pinless live topic without ever calling `putTopic`
  // themselves: retire a topic, delete its pins (retirement keeps it), then
  // un-retire it. It is now on the board with no pins and two hops of merged
  // history behind it — and under the old filter the next delete of ANY pin
  // anywhere took the topic and both histories, silently.
  const { store: s } = store();
  await s.putPin(aPin('a1', { topicId: 'A' }));
  await s.putPin(aPin('b1', { topicId: 'B' }));
  await s.putPin(aPin('c1', { topicId: 'C' }));
  await s.putTopic(aTopic('A', ['a1'], { retiredByUser: true }));
  await s.putTopic(aTopic('B', ['b1']));
  await s.putTopic(aTopic('C', ['c1']));
  await s.appendSignal(sig('gb', 'B', 'section:sess:b'));
  await s.mergeTopics('A', 'B');          // B retired into A; A now holds a1 + b1
  await s.deletePin('a1');
  await s.deletePin('b1');                // A is retired, so it stays, pinless

  const revived = await s.getTopic('A');
  assert.ok(revived);
  await s.putTopic({ ...revived, retiredByUser: false });   // the learner un-retires it

  await s.deletePin('c1');                // an unrelated delete

  assert.deepEqual((await s.listTopics()).map((t) => t.id), ['A']);
  assert.deepEqual(await s.topicAliases(), { B: 'A' }, 'the alias still terminates at a live topic');
  assert.deepEqual((await s.listSignals()).map((x) => x.id), ['gb'],
    'history two hops back is not collateral of deleting a pin in another topic');
});

// ---------------------------------------- testing the flush-window theory

test('a delete storm read at every flush boundary never shows a transient topic count', async () => {
  // The theory the report offered, tested rather than argued: park the store
  // inside each flush and read the board from the writing handle while it is
  // frozen there. If a read could see a half-applied delete, this is where.
  const { fs, store: s } = store();
  for (const id of ['t1', 't2', 't3']) {
    await s.putPin(aPin(`pin:${id}`, { topicId: id }));
    await s.putTopic(aTopic(id, [`pin:${id}`]));
  }

  const seen: number[] = [];
  for (const [i, id] of ['t1', 't2', 't3'].entries()) {
    const parked = parkAt(fs, 'writeFile', (p) => p !== PATH);
    const pending = s.deletePin(`pin:${id}`);
    await parked.arrived;
    // Mid-flush, from the handle doing the writing: the delete is fully applied
    // in memory and the file still holds the state before it.
    seen.push((await s.listTopics()).length);
    assert.equal(JSON.parse(fs.read(PATH) as string).topics.length, 3 - i,
      'the file lags by exactly one delete while its flush is in flight');
    parked.release();
    await pending;
  }

  assert.deepEqual(seen, [2, 1, 0],
    'every mid-flush read is one whole delete ahead of disk — never half of one');
});
