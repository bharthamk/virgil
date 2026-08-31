import { test } from 'node:test';
import assert from 'node:assert/strict';

import { JsonStore } from '../json-store.js';
import { MemFs, parkAt, settle } from './store-fs-harness.js';
import { aPin, aTopic } from './store-contract.js';
import type { Signal } from '@sb/core';

/**
 * What `JsonStore` actually promises about ordering, and what it does not.
 *
 * Two lanes reported something they could not explain by reading the code: a
 * topic count that dropped once during a long delete sequence, and a suspicion
 * that two nightly runs on one store would race. Both explanations pointed at
 * the same place — the gap between a mutation and the flush that persists it —
 * and neither could be checked, because nothing in the suite said what that gap
 * is. `store-concurrency.test.ts` proves nothing is *lost*; it does not say what
 * is *visible*, to whom, or when.
 *
 * So this file states the model, as tests rather than as a comment, and states
 * the limits with the same weight as the guarantees. A limit that is written
 * down is a design decision; a limit that is only true is a bug waiting to be
 * filed twice.
 *
 * The model, in short:
 *
 *  1. One handle is one in-memory `db`. Every read projects it and every
 *     mutation edits it synchronously, so a write is visible to the next read on
 *     that handle immediately — before the flush, and whether or not the caller
 *     awaited it.
 *  2. Flushes run one at a time through a promise queue, and a slot serialises
 *     the db as it is *when the slot runs*, not when `save()` was called. A
 *     mutation that lands while an earlier flush is still queued rides out in
 *     that earlier flush.
 *  3. Awaiting a mutation means its own slot completed, so it is on disk.
 *  4. A second handle over the same file sees nothing until a flush lands. That
 *     gap is the only read-between-write-and-flush window in the design, and it
 *     is bounded by the writer's own await.
 *  5. A crash before a flush loses exactly the tail that had not flushed. The
 *     file is the state as of the last completed rename, never a mixture.
 */

const PATH = '/store/db.json';
/** Any path the store touches that is not the store file is its temp file. */
const isTmp = (p: string): boolean => p.startsWith(`${PATH}.`);

const bench = (): { fs: MemFs; store: JsonStore } => {
  const fs = new MemFs();
  return { fs, store: new JsonStore(PATH, fs) };
};

/** A handle that has already read the file, so no test is measuring the load. */
const warm = async (): Promise<{ fs: MemFs; store: JsonStore }> => {
  const b = bench();
  await b.store.listPins();
  return b;
};

const onDisk = (fs: MemFs): { pins?: { id: string }[]; topics?: { id: string }[]; signals?: { id: string }[] } => {
  const raw = fs.read(PATH);
  assert.ok(raw !== null, 'the store file is not there at all');
  return JSON.parse(raw) as never;
};

const sig = (id: string, topicId: string): Signal => ({
  id, topicId, type: 'answer-correct', direction: 'positive',
  at: '2026-08-19T03:00:00.000Z', sourceEvent: `sess:${id}`, invalidated: false,
});

// ------------------------------------------------------- 1. in-memory first

test('a mutation is visible to the next read on the same handle before any of it reaches disk', async () => {
  const { fs, store } = await warm();
  const parked = parkAt(fs, 'writeFile');

  const pending = store.putPin(aPin('p1'));
  await parked.arrived;

  assert.equal((await store.getPin('p1'))?.id, 'p1',
    'the read must see the write it followed, flush or no flush');
  assert.equal((await store.listPins()).length, 1);
  assert.equal(fs.read(PATH), null, 'and nothing has reached the store file yet');

  parked.release();
  await pending;
  assert.equal(onDisk(fs).pins?.length, 1);
});

test('a read taken during a pending flush sees the newest state, not the flushing state', async () => {
  const { fs, store } = await warm();
  await store.putPin(aPin('p1'));

  const parked = parkAt(fs, 'writeFile');
  const pending = store.putPin(aPin('p2'));
  await parked.arrived;

  // A third mutation lands while p2's flush is parked. The read that follows it
  // sees all three, because reads never queue behind a flush.
  const alsoPending = store.putTopic(aTopic('t1', ['p1']));
  await settle();
  assert.deepEqual((await store.listPins()).map((p) => p.id), ['p1', 'p2']);
  assert.deepEqual((await store.listTopics()).map((t) => t.id), ['t1']);

  parked.release();
  await Promise.all([pending, alsoPending]);
});

// ------------------------------------------------------------ 2. call order

test('mutations issued without awaiting apply in call order', async () => {
  const { store } = await warm();

  // Nothing is awaited until the end: this is the forage stage's shape, where
  // several writes are in flight against one handle at once.
  await Promise.all([
    store.putPin(aPin('p1')),
    store.appendSignal(sig('s1', 't1')),
    store.putPin(aPin('p2')),
    store.appendSignal(sig('s2', 't1')),
    store.putPin(aPin('p3')),
    store.appendSignal(sig('s3', 't1')),
  ]);

  assert.deepEqual((await store.listPins()).map((p) => p.id), ['p1', 'p2', 'p3']);
  assert.deepEqual((await store.listSignals()).map((s) => s.id), ['s1', 's2', 's3'],
    'the ledger is append-only, so call order IS the order  reads back');
});

test('the same id written twice concurrently keeps the later call, not the later flush', async () => {
  const { store } = await warm();
  await Promise.all([
    store.putPin(aPin('p1', { note: 'first' })),
    store.putPin(aPin('p1', { note: 'second' })),
  ]);
  assert.equal((await store.getPin('p1'))?.note, 'second');
});

// ------------------------------------------------------------ 3. flush model

test('a flush serialises the db as it is when the slot runs, not when the mutation happened', async () => {
  // The surprising half of the model, and the one worth pinning: `save` queues a
  // closure, not a snapshot. A mutation that lands after the flush was queued
  // but before its slot runs is persisted BY that flush.
  const { fs, store } = await warm();
  const parked = parkAt(fs, 'mkdir');

  const first = store.putPin(aPin('p1'));
  await parked.arrived;
  // p2 mutates the db while p1's flush is parked before it has stringified.
  const second = store.putPin(aPin('p2'));
  await settle();
  parked.release();
  await first;

  assert.deepEqual(onDisk(fs).pins?.map((p) => p.id), ['p1', 'p2'],
    'the first flush carried a mutation queued after it — flushes converge, they do not snapshot');
  await second;
});

test('awaiting a mutation means that mutation is on disk', async () => {
  const { fs, store } = await warm();
  await store.putPin(aPin('p1'));
  assert.deepEqual(onDisk(fs).pins?.map((p) => p.id), ['p1']);

  await store.putTopic(aTopic('t1', ['p1']));
  assert.deepEqual(onDisk(fs).topics?.map((t) => t.id), ['t1']);
  assert.equal(fs.strayPaths(PATH).length, 0, 'the temp file is renamed away, never left behind');
});

test('the flush queue writes one file at a time, whatever order the mutations arrived in', async () => {
  const { fs, store } = await warm();
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.putPin(aPin(`p${i}`))));

  // Every write is bracketed by its own rename before the next write starts. A
  // second `writeFile` inside one `writeFile` is the interleaving the temp file
  // cannot survive, so the absence of that pattern IS the serialisation.
  const writes = fs.log.filter((e) => e.point === 'writeFile' || e.point === 'rename');
  for (let i = 0; i < writes.length; i += 2) {
    assert.equal(writes[i]?.point, 'writeFile');
    assert.equal(writes[i + 1]?.point, 'rename');
  }
  assert.equal(onDisk(fs).pins?.length, 8);
});

// ------------------------------------------- 4. the cross-handle read window

test('a second handle over the same file sees nothing until the flush lands', async () => {
  // The only read-between-write-and-flush window in the design. It is not a
  // window on the writing handle at all — it is the file lagging memory, and it
  // closes when the writer's own await resolves.
  const fs = new MemFs();
  const writer = new JsonStore(PATH, fs);
  await writer.listPins();
  await writer.putPin(aPin('p1'));

  const parked = parkAt(fs, 'writeFile', isTmp);
  const pending = writer.putPin(aPin('p2'));
  await parked.arrived;

  const reader = new JsonStore(PATH, fs);
  assert.deepEqual((await reader.listPins()).map((p) => p.id), ['p1'],
    'a handle opened mid-flush reads the last flushed state, never a half-written one');

  parked.release();
  await pending;
  assert.deepEqual((await new JsonStore(PATH, fs).listPins()).map((p) => p.id), ['p1', 'p2'],
    'and once the writer\'s await resolved, a fresh handle sees everything');
});

test('two handles that have both loaded diverge, and the last flush wins outright', async () => {
  // Stated as a limit, not sold as isolation. `load` memoises the promise for
  // the life of the handle, so two long-lived handles over one file never learn
  // about each other and the whole of one handle's board is overwritten by the
  // other. Anything that needs to see another writer has to open a new handle —
  // which is why `deleteEverything` resets `loading` rather than the db alone.
  const fs = new MemFs();
  const a = new JsonStore(PATH, fs);
  const b = new JsonStore(PATH, fs);
  await a.listPins();
  await b.listPins();

  await a.putPin(aPin('p1'));
  await b.putPin(aPin('p2'));

  assert.deepEqual((await a.listPins()).map((p) => p.id), ['p1'], 'handle a never learns about p2');
  assert.deepEqual((await b.listPins()).map((p) => p.id), ['p2'], 'handle b never learns about p1');
  assert.deepEqual(onDisk(fs).pins?.map((p) => p.id), ['p2'], 'and the file is whichever flushed last');
});

// ----------------------------------------------------------- 5. the tail

test('a crash before a flush loses exactly the tail that had not flushed', async () => {
  const fs = new MemFs();
  const store = new JsonStore(PATH, fs);
  await store.putPin(aPin('p1'));
  await store.putPin(aPin('p2'));

  const parked = parkAt(fs, 'writeFile', isTmp);
  void store.putPin(aPin('p3'));
  await parked.arrived;

  // The process dies here: the handle is abandoned mid-flush and never resumed.
  const afterCrash = new JsonStore(PATH, fs);
  assert.deepEqual((await afterCrash.listPins()).map((p) => p.id), ['p1', 'p2'],
    'everything awaited survived, and the one mutation that had not flushed did not');
});

test('a cascade that awaits per step is not one atomic mutation, and does not pretend to be', async () => {
  // `deleteTopic({ deletePins: true })` awaits a `deletePin` — and therefore a
  // full flush — per pin. Between two of them the store yields, and another
  // caller's mutation lands in the middle of the cascade. Nothing is corrupted
  // by that, and nothing about it is transactional either.
  const fs = new MemFs();
  const store = new JsonStore(PATH, fs);
  await store.putPin(aPin('p1', { topicId: 't1' }));
  await store.putPin(aPin('p2', { topicId: 't1' }));
  await store.putTopic(aTopic('t1', ['p1', 'p2']));

  let landed: Promise<void> | null = null;
  fs.hook = (event) => {
    // The second rename of the cascade: p1 is gone, p2 is not yet.
    if (event.point === 'rename' && landed === null && fs.read(PATH)?.includes('"p1"') === false) {
      landed = store.putPin(aPin('interloper'));
    }
  };

  await store.deleteTopic('t1', { deletePins: true });
  await landed;

  assert.deepEqual((await store.listPins()).map((p) => p.id), ['interloper'],
    'a write that arrived mid-cascade is kept, not rolled back with the cascade');
  assert.deepEqual([...await store.listTopics()], []);
  assert.deepEqual(onDisk(fs).pins?.map((p) => p.id), ['interloper']);
});
