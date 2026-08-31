import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Commitment, Course } from '@sb/core';
import { JsonStore } from '../json-store.js';
import { MemFs, deferred, parkAt, settle, type FsPoint } from './store-fs-harness.js';
import { aPin } from './store-contract.js';

/**
 * What is on disk when a write does not finish.
 *
 * `save` writes a temp file and renames it, and the comment above it makes a
 * promise in the learner's terms: a crash mid-write "cannot leave a half-written
 * store — which for this product means losing every pin the learner ever saved".
 * Nothing tested that promise, because nothing could reach the failure. With the
 * fs boundary injectable, each place a write can die is a test rather than an
 * argument.
 *
 * Two things came out of writing them down. The temp file was named per-process,
 * so two handles in one process shared it and one could rename the other's
 * half-written file into place — the exact failure the rename was there to
 * prevent. And a store file that will not parse is read as an empty board, so
 * that half-written file does not surface as an error: it surfaces as a learner
 * whose pins are gone.
 */

const PATH = '/store/db.json';

const board = (fs: MemFs): { pins: string[] } | 'unparseable' | 'absent' => {
  const raw = fs.read(PATH);
  if (raw === null) return 'absent';
  try {
    return { pins: (JSON.parse(raw) as { pins: { id: string }[] }).pins.map((p) => p.id) };
  } catch {
    return 'unparseable';
  }
};

/** Fail the store's fs the first time it reaches `point`. */
const failAt = (fs: MemFs, point: FsPoint, match: (p: string) => boolean = () => true): void => {
  let armed = true;
  fs.hook = (event) => {
    if (!armed || event.point !== point || !match(event.path)) return;
    armed = false;
    throw Object.assign(new Error(`EIO: ${event.point} ${event.path}`), { code: 'EIO' });
  };
};

const aCommitment = (id: string, title = `Commitment ${id}`): Commitment => ({
  id, title, kind: 'assignment', courseId: null, topicIds: [],
  dueAt: '2026-09-01T23:59:00.000Z', plannedFor: null, estimateMinutes: null,
  notes: '', doneAt: null, createdAt: '2026-08-20T09:00:00.000Z',
});

const aCourse = (id: string, title = `Course ${id}`): Course => ({
  id, title, provider: '', url: '', material: [], topicIds: [],
  archivedAt: null, createdAt: '2026-08-20T09:00:00.000Z',
});

// ------------------------------------------------------- the failure matrix

for (const point of ['mkdir', 'writeFile', 'writeFile:half', 'rename'] as const) {
  test(`a write that dies at ${point} leaves the store file readable and whole`, async () => {
    const fs = new MemFs();
    const store = new JsonStore(PATH, fs);
    await store.putPin(aPin('p1'));
    await store.putPin(aPin('p2'));
    assert.deepEqual(board(fs), { pins: ['p1', 'p2'] });

    failAt(fs, point);
    await store.putPin(aPin('p3')).catch(() => {});

    // Either the old state or the new one. `writeFile:half` is the interesting
    // row: the half-written bytes exist, and they are in the temp file, which is
    // not the store.
    const after = board(fs);
    assert.notEqual(after, 'unparseable', `a failure at ${point} left the store file unparseable`);
    assert.notEqual(after, 'absent', `a failure at ${point} left no store file at all`);
    assert.deepEqual(after, { pins: ['p1', 'p2'] },
      'a write that did not complete did not land');

    // And a handle opened afterwards agrees with the file, rather than with the
    // memory of the handle that failed.
    const reopened = new JsonStore(PATH, fs);
    assert.deepEqual((await reopened.listPins()).map((p) => p.id), ['p1', 'p2'],
      'a reopened store loads the old state or the new one, never a mixture');
  });
}

test('a failed flush is reported to the caller rather than swallowed', async () => {
  // The learner is told their pin was saved. If the write failed and the call
  // still resolved, the only place that is visible is the next morning, on a
  // board that is missing something. A rejected promise is what lets the nightly
  // run degrade the stage instead — which is what graceful-degradation constraint already expects of it.
  const fs = new MemFs();
  const store = new JsonStore(PATH, fs);
  await store.putPin(aPin('p1'));

  failAt(fs, 'writeFile');
  await assert.rejects(() => store.putPin(aPin('p2')), /EIO/);

  assert.deepEqual(board(fs), { pins: ['p1'] });
});

test('a failed bounded commitment replacement is absent from disk and the live handle', async () => {
  const fs = new MemFs();
  const store = new JsonStore(PATH, fs);
  await store.putCommitment(aCommitment('c1'));
  await store.putCommitment(aCommitment('c2'));

  failAt(fs, 'writeFile');
  await assert.rejects(() => store.replaceCommitments([
    aCommitment('c2', 'Changed second'), aCommitment('c3'),
  ], ['c1']), /EIO/);

  const live = [...await store.listCommitments()].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(live.map((row) => [row.id, row.title]), [
    ['c1', 'Commitment c1'], ['c2', 'Commitment c2'],
  ], 'a failed series mutation must not leak through the handle that attempted it');

  const reopened = new JsonStore(PATH, fs);
  const disk = [...await reopened.listCommitments()].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(disk.map((row) => [row.id, row.title]), [
    ['c1', 'Commitment c1'], ['c2', 'Commitment c2'],
  ], 'a failed series mutation must not leave a partial replacement on disk');
});

test('a failed two-course replacement is absent from disk and the live handle', async () => {
  const fs = new MemFs();
  const store = new JsonStore(PATH, fs);
  await store.putCourse(aCourse('k1'));
  await store.putCourse(aCourse('k2'));

  failAt(fs, 'writeFile');
  await assert.rejects(() => store.replaceCourses([
    aCourse('k1', 'Changed first'), aCourse('k3'),
  ], ['k2']), /EIO/);

  const live = [...await store.listCourses()].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(live.map((row) => [row.id, row.title]), [
    ['k1', 'Course k1'], ['k2', 'Course k2'],
  ]);

  const reopened = new JsonStore(PATH, fs);
  const disk = [...await reopened.listCourses()].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(disk.map((row) => [row.id, row.title]), [
    ['k1', 'Course k1'], ['k2', 'Course k2'],
  ]);
});

test('one failed flush does not poison the flushes behind it', async () => {
  const fs = new MemFs();
  const store = new JsonStore(PATH, fs);
  await store.putPin(aPin('p1'));

  failAt(fs, 'rename');
  await store.putPin(aPin('p2')).catch(() => {});
  // The queue has to survive its own failure: a rejected `writing` that was
  // never handled would take every later write with it.
  await store.putPin(aPin('p3'));

  assert.deepEqual(board(fs), { pins: ['p1', 'p2', 'p3'] });
});

// --------------------------------------------- two handles, one file, one pid

test('a second handle cannot rename the first handle\'s half-written file into place', async () => {
  const fs = new MemFs();
  const a = new JsonStore(PATH, fs);
  const b = new JsonStore(PATH, fs);
  await a.listPins();
  await b.listPins();

  // b has written its whole temp file and is about to rename it.
  const bAtRename = parkAt(fs, 'rename');
  const bWrite = b.putPin(aPin('from-b'));
  await bAtRename.arrived;

  // a is now half way through writing ITS temp file.
  const aHalf = parkAt(fs, 'writeFile:half');
  const aWrite = a.putPin(aPin('from-a'));
  await aHalf.arrived;

  // b renames. If the two handles share a temp path, this publishes a's half.
  bAtRename.release();
  await bWrite.catch(() => {});
  assert.notEqual(board(fs), 'unparseable',
    'one handle published another handle\'s partial write as the store');

  // And the damage is not theoretical: a handle opening the file in this window
  // reads a broken store as an empty board and would flush that emptiness back.
  assert.deepEqual((await new JsonStore(PATH, fs).listPins()).map((p) => p.id), ['from-b']);

  aHalf.release();
  await aWrite.catch(() => {});
  assert.notEqual(board(fs), 'unparseable');
});

test('concurrent writes from two handles never expose an unparseable store file', async () => {
  // The same hazard without any chosen interleaving: every fs step of both
  // handles is checked as it happens, so any ordering that produces a broken
  // file is caught on the step that produced it.
  const fs = new MemFs();
  const a = new JsonStore(PATH, fs);
  const b = new JsonStore(PATH, fs);
  await a.listPins();
  await b.listPins();

  const seen: string[] = [];
  fs.hook = () => { const b0 = board(fs); if (typeof b0 === 'string') seen.push(b0); };

  await Promise.all([
    ...Array.from({ length: 6 }, (_, i) => a.putPin(aPin(`a${i}`))),
    ...Array.from({ length: 6 }, (_, i) => b.putPin(aPin(`b${i}`))),
  ]);

  assert.deepEqual(seen.filter((s) => s === 'unparseable'), [],
    'the store file was unparseable at some point during two handles writing');
  assert.equal(fs.strayPaths(PATH).length, 0, 'and no temp file was orphaned');
});

// ------------------------------------------------- documented, not endorsed

test('a store file that is not there yet is a first run, and reads as an empty board', async () => {
  const fs = new MemFs();
  const store = new JsonStore(PATH, fs);

  assert.deepEqual([...await store.listPins()], [], 'nothing saved yet is not an error');

  await store.putPin(aPin('p1'));
  assert.deepEqual(board(fs), { pins: ['p1'] });
});

test('a store file that will not parse stops the store rather than reading as empty', async () => {
  const fs = new MemFs();
  fs.files.set(PATH, '{"pins":[{"id":"p1"');
  const store = new JsonStore(PATH, fs);

  await assert.rejects(() => store.listPins(), (e: Error) => {
    assert.match(e.message, /could not be read/);
    assert.ok(e.message.includes(PATH), 'the message names the file a human has to go and look at');
    return true;
  });

  assert.equal(fs.read(PATH), '{"pins":[{"id":"p1"', 'and the wreckage is still on disk, unoverwritten');
});

test('a read that fails for a reason other than absence is not a first run either', async () => {
  const fs = new MemFs();
  fs.files.set(PATH, '{}');
  fs.hook = async (event) => {
    if (event.point === 'readFile') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
  };
  const store = new JsonStore(PATH, fs);

  await assert.rejects(() => store.listPins(), /could not be read/);
});

test('a store that failed to load stays failed rather than quietly becoming empty', async () => {
  // The load promise is memoised. A rejected one that got replaced by a fresh
  // attempt would let a retry succeed onto an empty board, which is the wipe by
  // another route.
  const fs = new MemFs();
  fs.files.set(PATH, 'not json at all');
  const store = new JsonStore(PATH, fs);

  await assert.rejects(() => store.listPins(), /could not be read/);
  await assert.rejects(() => store.putPin(aPin('p2')), /could not be read/);
  assert.equal(fs.read(PATH), 'not json at all');
});

test('DOCUMENTED LIMIT: a flush that never settles blocks every flush behind it', async () => {
  // The queue is strictly serial with no timeout. A boundary that hangs rather
  // than fails leaves every later write pending for ever, and the in-memory
  // board keeps accepting mutations that will never reach disk. Reads stay
  // correct throughout, which is exactly what makes it hard to notice.
  const fs = new MemFs();
  const store = new JsonStore(PATH, fs);
  await store.listPins();
  const stuck = deferred();
  let armed = true;
  fs.hook = async (event) => {
    if (armed && event.point === 'writeFile') { armed = false; await stuck.promise; }
  };

  const first = store.putPin(aPin('p1'));
  const second = store.putPin(aPin('p2'));
  let settled = false;
  void Promise.all([first, second]).then(() => { settled = true; });
  await settle();

  assert.equal(settled, false, 'neither write has completed');
  assert.deepEqual((await store.listPins()).map((p) => p.id), ['p1', 'p2'],
    'and the board reads as if both had');
  assert.equal(board(fs), 'absent');

  stuck.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(board(fs), { pins: ['p1', 'p2'] });
});
