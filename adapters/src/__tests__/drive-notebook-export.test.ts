import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fixedClock, allWritten, failedDocs, recreatedDocs, receiptLine,
  type NotebookDoc, type NotebookDocKey,
} from '@sb/core';

import {
  DriveNotebookExport, DRIVE_FOLDER_NAME, driveFolderLink,
  type DriveAuth, type DriveFileIds, type DriveIdStore,
} from '../drive-notebook-export.js';
import { DOC_MIME, FOLDER_MIME, FakeDrive } from './fake-drive.js';

/**
 * NOTEBOOK_SEAM_V2.md §10 — the Drive adapter, against a Drive.
 *
 * Every test here runs against an in-process HTTP server speaking Drive's REST
 * shapes, on an ephemeral loopback port, over real `fetch`. Nothing reaches
 * Google and no credential of any kind exists in this file: the tokens are the
 * strings `access-1` and `access-2`, which are the fake's whole idea of
 * authentication.
 *
 * The tests worth having are the ones about **identity and honesty**, because
 * those are the two properties the design spent itself on. A document written
 * twice must be the same file both times, or a learner re-adds sources every
 * morning. A document that did not get written must be reported, or a notebook
 * answers fluently out of three-week-old sources with no sign at all.
 */

const NOW = '2026-08-24T03:00:00.000Z';
const clock = fixedClock(NOW);

const doc = (key: NotebookDocKey, body: string): NotebookDoc => ({
  key, title: `Virgil: ${key}`, body,
});

const ALL_DOCS: readonly NotebookDoc[] = [
  doc('learn-now', '# Virgil: learn now\n\nThe lesson in front of you.\n'),
  doc('on-the-board', '# Virgil: on the board\n\n- a topic\n'),
  doc('archive', '# Virgil: archive\n\n[a page](https://example.org/p)\n'),
];

/** An id map in memory, and a record of every time it was written, because
 *  "remembered exactly once" is a claim about writes as well as reads. */
class MemoryIds implements DriveIdStore {
  writes = 0;
  constructor(private ids: DriveFileIds = { folderId: null, files: {} }) {}
  async read(): Promise<DriveFileIds> { return this.ids; }
  async write(ids: DriveFileIds): Promise<void> { this.writes += 1; this.ids = ids; }
  get value(): DriveFileIds { return this.ids; }
}

/** A token source that counts refreshes, so "exactly once per request" is
 *  checkable rather than assumed. */
class FakeAuth implements DriveAuth {
  refreshes = 0;
  constructor(private token: string, private readonly onRefresh?: () => string) {}
  async accessToken(opts?: { readonly refresh?: boolean }): Promise<string> {
    if (opts?.refresh) {
      this.refreshes += 1;
      if (!this.onRefresh) throw new Error('Google would not let me back in.');
      this.token = this.onRefresh();
    }
    return this.token;
  }
}

const started = async (): Promise<FakeDrive> => {
  const drive = new FakeDrive();
  await drive.start();
  return drive;
};

const exportTo = (drive: FakeDrive, auth: DriveAuth, ids: DriveIdStore): DriveNotebookExport =>
  new DriveNotebookExport({ auth, ids, clock, apiBase: drive.url });

// ------------------------------------------------------------ the first write

test('the first write makes one folder and three native Docs inside it', async (t) => {
  const drive = await started();
  t.after(() => drive.stop());
  const ids = new MemoryIds();

  const receipt = await exportTo(drive, new FakeAuth('access-1'), ids).writeDocs(ALL_DOCS);

  assert.equal(allWritten(receipt), true);
  assert.equal(receipt.at, NOW, 'the injected clock, never a wall clock');
  assert.match(receipt.target, new RegExp(DRIVE_FOLDER_NAME));

  const folder = drive.folder();
  assert.ok(folder, 'no folder was made');
  assert.equal(folder.mimeType, FOLDER_MIME);
  assert.equal(folder.name, DRIVE_FOLDER_NAME);

  const docs = [...drive.files.values()].filter((f) => f.mimeType === DOC_MIME);
  assert.equal(docs.length, 3);
  // Fact 1: only NATIVE Docs auto-sync. A .md or a text blob in Drive is a
  // document that is correct once and wrong for ever afterwards.
  for (const file of docs) {
    assert.equal(file.mimeType, DOC_MIME);
    assert.deepEqual(file.parents, [folder.id]);
    assert.match(file.content, /^<!DOCTYPE html>/);
  }
});

test('the receipt says where each document landed, and that is a file id', async (t) => {
  const drive = await started();
  t.after(() => drive.stop());
  const ids = new MemoryIds();
  const receipt = await exportTo(drive, new FakeAuth('access-1'), ids).writeDocs(ALL_DOCS);

  for (const row of receipt.docs) {
    assert.ok(row.at, `${row.key} landed nowhere`);
    assert.ok(drive.files.has(row.at), `${row.key} named an id Drive does not have`);
    assert.equal(row.error, null);
    assert.equal(row.bytes, Buffer.byteLength(
      ALL_DOCS.find((d) => d.key === row.key)!.body, 'utf8'));
  }
});

test('the ids are remembered, and the map is written once rather than three times', async (t) => {
  const drive = await started();
  t.after(() => drive.stop());
  const ids = new MemoryIds();
  await exportTo(drive, new FakeAuth('access-1'), ids).writeDocs(ALL_DOCS);

  assert.equal(ids.writes, 1, 'a write per document is three chances to be interrupted half way');
  assert.equal(ids.value.folderId, drive.folder()?.id);
  assert.deepEqual(Object.keys(ids.value.files).sort(),
    ['archive', 'learn-now', 'on-the-board']);
});

// ------------------------------------------------------------- rewriting

test('the second write REPLACES the same three files and creates nothing', async (t) => {
  const drive = await started();
  t.after(() => drive.stop());
  const ids = new MemoryIds();
  const to = exportTo(drive, new FakeAuth('access-1'), ids);

  const first = await to.writeDocs(ALL_DOCS);
  const before = { ...ids.value.files };

  const changed = ALL_DOCS.map((d) => ({ ...d, body: `${d.body}\nand one more line.\n` }));
  const second = await to.writeDocs(changed);

  // §3's law: identity is the file id and the file id must never change. A new
  // file every night is a file the notebook has never heard of, and the old one
  // being removed would silently take the working source with it.
  assert.deepEqual(ids.value.files, before);
  assert.equal([...drive.files.values()].filter((f) => f.mimeType === DOC_MIME).length, 3,
    'a second set of documents appeared beside the first');
  assert.deepEqual(second.docs.map((d) => d.at), first.docs.map((d) => d.at));

  for (const [title, content] of Object.entries(drive.contents())) {
    assert.match(content, /and one more line\./, `${title} was not replaced`);
  }
});

test('nothing this adapter does can reach files.delete', async (t) => {
  const drive = await started();
  t.after(() => drive.stop());
  const ids = new MemoryIds();
  const to = exportTo(drive, new FakeAuth('access-1'), ids);
  await to.writeDocs(ALL_DOCS);
  await to.writeDocs(ALL_DOCS);

  // Fact 2: a file removed from Drive is removed from the notebook. The adapter
  // has no delete path at all, so a bug cannot find one.
  assert.deepEqual(drive.deletes, []);
  assert.equal(drive.calls.some((c) => c.startsWith('DELETE')), false);
});

test('a remembered folder is used again rather than made again', async (t) => {
  const drive = await started();
  t.after(() => drive.stop());
  const ids = new MemoryIds();
  const to = exportTo(drive, new FakeAuth('access-1'), ids);
  await to.writeDocs(ALL_DOCS);
  const folderId = ids.value.folderId;
  await to.writeDocs(ALL_DOCS);

  assert.equal(ids.value.folderId, folderId);
  assert.equal([...drive.files.values()].filter((f) => f.mimeType === FOLDER_MIME).length, 1);
});

test('a folder and its documents are recovered when the local id map is lost', async (t) => {
  const drive = await started();
  t.after(() => drive.stop());
  const first = new MemoryIds();
  await exportTo(drive, new FakeAuth('access-1'), first).writeDocs(ALL_DOCS);

  // The id map was lost. §10.3 says that costs a re-setup, and it should not
  // also cost a second folder called Virgil sitting beside the first.
  const second = new MemoryIds();
  await exportTo(drive, new FakeAuth('access-1'), second).writeDocs(ALL_DOCS);
  assert.equal([...drive.files.values()].filter((f) => f.mimeType === FOLDER_MIME).length, 1);
  assert.equal(second.value.folderId, first.value.folderId);
  assert.equal([...drive.files.values()].filter((f) => f.mimeType === DOC_MIME).length, 3,
    'a lost local id map created a duplicate document set');
  assert.deepEqual(second.value.files, first.value.files,
    'the recovered map did not resume the original documents');
});

test('a remembered id remains authoritative beside a same-named copy', async (t) => {
  const drive = await started();
  t.after(() => drive.stop());
  const original = new MemoryIds();
  await exportTo(drive, new FakeAuth('access-1'), original).writeDocs(ALL_DOCS);
  const oldId = original.value.files['learn-now']!;
  const duplicateId = 'newer-duplicate';
  drive.files.set(duplicateId, {
    id: duplicateId, name: 'Virgil: learn-now', mimeType: DOC_MIME,
    parents: [original.value.folderId!], content: 'wrong copy', trashed: false,
    createdTime: '2026-08-25T03:00:00.000Z',
  });
  const remembered = new MemoryIds({
    folderId: original.value.folderId,
    files: { ...original.value.files },
  });

  await exportTo(drive, new FakeAuth('access-1'), remembered).writeDocs([
    doc('learn-now', '# Virgil: learn now\n\nRecovered exact source.\n'),
  ]);
  assert.equal(remembered.value.files['learn-now'], oldId);
  assert.match(drive.files.get(oldId)!.content, /Recovered exact source/);
  assert.equal(drive.files.get(duplicateId)!.content, 'wrong copy');
});

// -------------------------------------------------- the learner deleted one

test('a document the learner deleted is made again and the receipt says so', async (t) => {
  const drive = await started();
  t.after(() => drive.stop());
  const ids = new MemoryIds();
  const to = exportTo(drive, new FakeAuth('access-1'), ids);
  await to.writeDocs(ALL_DOCS);

  const gone = ids.value.files['on-the-board']!;
  drive.files.delete(gone);

  const receipt = await to.writeDocs(ALL_DOCS);
  assert.equal(allWritten(receipt), true, 'a missing document is a gap the notebook cannot answer from');
  assert.deepEqual(recreatedDocs(receipt).map((d) => d.key), ['on-the-board']);
  assert.notEqual(ids.value.files['on-the-board'], gone, 'the new file kept the dead id');

  // The receipt is the only route this fact has: Virgil cannot see the notebook
  // and cannot add the replacement to it.
  const line = receiptLine(receipt);
  assert.match(line, /no longer in your Drive/);
  assert.match(line, /add that document as a source again/);
  assert.equal(/up to date/i.test(line), false);
});

test('a folder the learner binned is replaced without leaving three identical failures', async (t) => {
  const drive = await started();
  t.after(() => drive.stop());
  const ids = new MemoryIds();
  const to = exportTo(drive, new FakeAuth('access-1'), ids);
  await to.writeDocs(ALL_DOCS);

  const folder = drive.folder()!;
  folder.trashed = true;
  for (const id of Object.values(ids.value.files)) drive.files.delete(id);

  const receipt = await to.writeDocs(ALL_DOCS);
  assert.equal(allWritten(receipt), true);
  assert.notEqual(ids.value.folderId, folder.id);
  assert.equal(recreatedDocs(receipt).length, 3);
});

// ----------------------------------------------------------- partial failure

test('one document refused is one row refused, and the rest still land', async (t) => {
  const drive = await started();
  t.after(() => drive.stop());
  const ids = new MemoryIds();
  drive.failures.set('Virgil: archive', { status: 403, reason: 'storageQuotaExceeded' });

  const receipt = await exportTo(drive, new FakeAuth('access-1'), ids).writeDocs(ALL_DOCS);

  assert.equal(receipt.docs.length, 3, 'one row per document offered, always');
  assert.deepEqual(failedDocs(receipt).map((d) => d.key), ['archive']);
  assert.equal(failedDocs(receipt)[0]?.at, null);
  assert.equal(failedDocs(receipt)[0]?.error,
    'There is no room left in your Google Drive, so I could not write it.');
  assert.equal(Object.keys(ids.value.files).length, 2,
    'an id was remembered for a document that never landed');
  assert.match(receiptLine(receipt), /I rewrote 2 of 3 documents/);
});

test('a failed row never carries an exception, a status line or a body', async (t) => {
  const drive = await started();
  t.after(() => drive.stop());
  drive.failures.set('Virgil: learn-now', { status: 500 });

  const receipt = await exportTo(drive, new FakeAuth('access-1'), new MemoryIds()).writeDocs(ALL_DOCS);
  const row = failedDocs(receipt)[0]!;
  assert.equal(row.error, 'Google Drive was having trouble, so this one did not go through.');
  for (const banned of [/Error:/, /\bhttps?:\/\//, /\{/, /stack/i]) {
    assert.equal(banned.test(row.error ?? ''), false, `the row leaked ${banned}`);
  }
});

test('a document that failed keeps its previous id, so the next night rewrites it', async (t) => {
  const drive = await started();
  t.after(() => drive.stop());
  const ids = new MemoryIds();
  const to = exportTo(drive, new FakeAuth('access-1'), ids);
  await to.writeDocs(ALL_DOCS);
  const before = ids.value.files.archive;

  drive.failures.set('Virgil: archive', { status: 500, times: 1 });
  await to.writeDocs(ALL_DOCS);
  assert.equal(ids.value.files.archive, before, 'a failed write forgot which file it was for');

  const after = await to.writeDocs(ALL_DOCS);
  assert.equal(allWritten(after), true);
  assert.equal(recreatedDocs(after).length, 0, 'a recovered write made a second document');
});

// ------------------------------------------------------------ the 401 dance

test('an expired access token is refreshed once and the write goes through', async (t) => {
  const drive = await started();
  t.after(() => drive.stop());
  drive.accepted = new Set(['access-2']);
  const auth = new FakeAuth('access-1', () => 'access-2');

  const receipt = await exportTo(drive, auth, new MemoryIds()).writeDocs(ALL_DOCS);
  assert.equal(allWritten(receipt), true);
  assert.equal(auth.refreshes, 1,
    'a refresh per request would ask Google for a new token three times a night');
});

test('a 401 that survives a refresh is consent that is gone, and it rejects as a whole', async (t) => {
  const drive = await started();
  t.after(() => drive.stop());
  drive.alwaysUnauthorised = true;
  const auth = new FakeAuth('access-1', () => 'access-2');

  // The port's other shape: not about any one document, so not three identical
  // rows. §13 — the notebook outlives the consent, and Virgil's part is to
  // notice that its writes now fail and say so.
  await assert.rejects(
    () => exportTo(drive, auth, new MemoryIds()).writeDocs(ALL_DOCS),
    /not letting me into your Drive any more/,
  );
});

test('a refresh that Google refuses is the same fact, one step earlier', async (t) => {
  const drive = await started();
  t.after(() => drive.stop());
  drive.accepted = new Set(['nothing-matches']);

  await assert.rejects(
    () => exportTo(drive, new FakeAuth('access-1'), new MemoryIds()).writeDocs(ALL_DOCS),
    /Google would not let me back in\./,
  );
});

test('no credential at all rejects before anything is written', async (t) => {
  const drive = await started();
  t.after(() => drive.stop());
  const auth: DriveAuth = {
    async accessToken(): Promise<string> {
      throw new Error('Google Drive is not connected yet, so there is nowhere to put your documents.');
    },
  };
  await assert.rejects(
    () => exportTo(drive, auth, new MemoryIds()).writeDocs(ALL_DOCS),
    /not connected yet/,
  );
  assert.equal(drive.files.size, 0);
});

// --------------------------------------------------------------- the folder

test('a Drive that will not answer about folders is one problem, not three', async (t) => {
  const drive = await started();
  t.after(() => drive.stop());
  drive.folderStatus = 403;

  await assert.rejects(
    () => exportTo(drive, new FakeAuth('access-1'), new MemoryIds()).writeDocs(ALL_DOCS),
    /Google Drive/,
  );
});

test('the folder link is built from the id and is not stored anywhere', () => {
  assert.equal(driveFolderLink('abc123'), 'https://drive.google.com/drive/folders/abc123');
});

// ----------------------------------------------------------- what is uploaded

test('the media is HTML and the metadata is a native Doc, which is what makes it re-readable', async (t) => {
  const drive = await started();
  t.after(() => drive.stop());
  await exportTo(drive, new FakeAuth('access-1'), new MemoryIds()).writeDocs(ALL_DOCS);

  const archive = [...drive.files.values()].find((f) => f.name === 'Virgil: archive')!;
  assert.equal(archive.mimeType, DOC_MIME);
  assert.match(archive.content, /<h1>Virgil: archive<\/h1>/);
  assert.match(archive.content, /<a href="https:\/\/example\.org\/p">a page<\/a>/);
  assert.equal(archive.content.includes('# Virgil'), false, 'a heading shipped as characters');
});

test('the calls made are the ones the design named, and no others', async (t) => {
  const drive = await started();
  t.after(() => drive.stop());
  const ids = new MemoryIds();
  const to = exportTo(drive, new FakeAuth('access-1'), ids);
  await to.writeDocs(ALL_DOCS);
  await to.writeDocs(ALL_DOCS);

  const allowed = /^(GET|POST) \/drive\/v3\/files|^(POST|PATCH) \/upload\/drive\/v3\/files/;
  for (const call of drive.calls) {
    assert.match(call, allowed, `an unsanctioned call: ${call}`);
  }
});
