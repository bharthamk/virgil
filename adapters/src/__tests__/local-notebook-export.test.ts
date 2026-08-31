import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixedClock, allWritten, failedDocs, receiptLine, type NotebookDoc } from '@sb/core';
import { LocalNotebookExport, type ExportFs } from '../local-notebook-export.js';

/**
 * NOTEBOOK_SEAM_V2.md §11 — a document that failed to write is reported,
 * never silently stale.
 *
 * The happy path here is nearly uninteresting: it writes files. What is worth a
 * test is everything around it, because this seam has a failure mode nothing
 * else in the product has. **A stale export looks exactly like a fresh one from
 * where the learner is standing.** There is no blank screen and no error, just
 * a notebook answering confidently out of last month's documents.
 *
 * So the tests that matter are: one document failing does not take the other
 * four with it; the receipt has a row for every document offered, so a missing
 * one is not expressible; and the reason is a sentence rather than a stack
 * frame with somebody's home directory in it.
 */

const NOW = '2026-08-24T03:00:00.000Z';
const clock = fixedClock(NOW);

const doc = (key: NotebookDoc['key'], body = `the body of ${key}`): NotebookDoc =>
  ({ key, title: `Virgil: ${key}`, body });

const ALL: readonly NotebookDoc[] = [
  doc('learn-now'), doc('on-the-board'), doc('archive'),
];

const where = (tag: string): string =>
  join(mkdtempSync(join(tmpdir(), `sb-nb-${tag}-`)), 'documents');

/** A filesystem that works, and records the order it was asked to do things. */
function recordingFs(over: Partial<ExportFs> = {}): ExportFs & { calls: string[] } {
  const calls: string[] = [];
  const files = new Map<string, string>();
  return {
    calls,
    async mkdir(path) { calls.push(`mkdir ${path}`); return undefined; },
    async writeFile(path, data) { calls.push('writeFile'); files.set(path, data); },
    async rename(from, to) { calls.push('rename'); files.set(to, files.get(from) ?? ''); },
    ...over,
  } as ExportFs & { calls: string[] };
}

// ------------------------------------------------------------- the happy path

test('every document lands as a file named from its key', async () => {
  const directory = where('write');
  const receipt = await new LocalNotebookExport({ directory, clock }).writeDocs(ALL);

  assert.equal(allWritten(receipt), true);
  assert.equal(receipt.at, NOW, 'the injected clock, not the wall clock');
  assert.equal(receipt.target, directory);

  assert.deepEqual(readdirSync(directory).sort(), [
    'virgil-archive.md', 'virgil-learn-now.md', 'virgil-on-the-board.md',
  ], 'a filename is built from the key, which is a closed union, and never from a title');

  for (const d of ALL) {
    assert.equal(readFileSync(join(directory, `virgil-${d.key}.md`), 'utf8'), d.body);
  }
});

test('the directory is created rather than required to exist', async () => {
  const directory = join(where('mkdir'), 'nested', 'deeper');
  const receipt = await new LocalNotebookExport({ directory, clock }).writeDocs(ALL);
  assert.equal(allWritten(receipt), true);
  assert.equal(readdirSync(directory).length, 3);
});

test('a rewrite replaces the whole document and leaves nothing else behind', async () => {
  // The identity of a document is its name, and rewriting in place is the whole
  // design: a second file would be a source the notebook has never heard of.
  const directory = where('rewrite');
  const port = new LocalNotebookExport({ directory, clock });
  await port.writeDocs([doc('archive', 'what it said the first time')]);
  await port.writeDocs([doc('archive', 'what it says now')]);

  assert.deepEqual(readdirSync(directory), ['virgil-archive.md']);
  assert.equal(readFileSync(join(directory, 'virgil-archive.md'), 'utf8'), 'what it says now');
});

test('a write is a temp file and then a rename, never an in-place truncate', async () => {
  // A crash half way through must leave the previous document intact. Half a
  // document is worse than an old one: an old one is at least internally
  // consistent and says its own date on line two.
  const fs = recordingFs();
  await new LocalNotebookExport({ directory: where('atomic'), clock, fs })
    .writeDocs([doc('learn-now')]);
  assert.deepEqual(fs.calls.filter((c) => !c.startsWith('mkdir')), ['writeFile', 'rename']);
});

test('the temp file is never the document, so a reader cannot catch a half write', async () => {
  const seen: string[] = [];
  const fs = recordingFs({
    async writeFile(path: string) { seen.push(path); },
  });
  const directory = where('temp');
  await new LocalNotebookExport({ directory, clock, fs }).writeDocs([doc('on-the-board')]);
  assert.equal(seen.length, 1);
  assert.notEqual(seen[0], join(directory, 'virgil-on-the-board.md'));
  assert.match(seen[0] as string, /virgil-on-the-board\.md\./, 'the temp name should still say what it is');
});

// ------------------------------------------------------------ failure honesty

test('a receipt has one row for every document offered, always', async () => {
  const fs = recordingFs({
    async writeFile() { throw Object.assign(new Error('nope'), { code: 'ENOSPC' }); },
  });
  const receipt = await new LocalNotebookExport({ directory: where('rows'), clock, fs })
    .writeDocs(ALL);
  assert.deepEqual(receipt.docs.map((d) => d.key), ALL.map((d) => d.key),
    'a missing row must not be expressible');
  assert.equal(allWritten(receipt), false);
});

test('one document failing does not take the others with it', async () => {
  let n = 0;
  const fs = recordingFs({
    async writeFile(path: string, data: string) {
      n += 1;
      if (n === 3) throw Object.assign(new Error('nope'), { code: 'EACCES' });
      void path; void data;
    },
  });
  const receipt = await new LocalNotebookExport({ directory: where('partial'), clock, fs })
    .writeDocs(ALL);

  const failed = failedDocs(receipt);
  assert.equal(failed.length, 1, 'a throw at the third must not discard the other two');
  assert.equal(failed[0]?.key, 'archive');
  assert.equal(receipt.docs.filter((d) => d.written).length, 2);
});

test('the reason is a sentence, not an exception with a home directory in it', async () => {
  for (const [code, expected] of [
    ['EACCES', /do not have permission/],
    ['ENOSPC', /disk is full/],
    ['ENOENT', /not there any more/],
    ['EROFS', /read only/],
  ] as const) {
    const fs = recordingFs({
      async writeFile() {
        throw Object.assign(new Error(`Error: ${code}, open '/private/example/x'`), { code });
      },
    });
    const receipt = await new LocalNotebookExport({ directory: where(`say-${code}`), clock, fs })
      .writeDocs([doc('learn-now')]);
    const row = receipt.docs[0];
    assert.match(row?.error ?? '', expected);
    assert.equal(row?.error?.includes('/private/example'), false, `${code} leaked a path`);
    assert.equal(row?.written, false);
    assert.equal(row?.at, null, 'there is no honest answer to where it landed');
  }
});

test('an unrecognised failure still says something, and says what it was told', async () => {
  const fs = recordingFs({
    async writeFile() { throw Object.assign(new Error('x'), { code: 'EMFILE' }); },
  });
  const receipt = await new LocalNotebookExport({ directory: where('odd'), clock, fs })
    .writeDocs([doc('learn-now')]);
  assert.match(receipt.docs[0]?.error ?? '', /the system said EMFILE/);
});

test('a failure with no code at all is still reported rather than swallowed', async () => {
  const fs = recordingFs({ async writeFile() { throw new Error('who knows'); } });
  const receipt = await new LocalNotebookExport({ directory: where('bare'), clock, fs })
    .writeDocs([doc('learn-now')]);
  assert.match(receipt.docs[0]?.error ?? '', /did not say why/);
});

test('a target that cannot be made is one problem, and is raised as one', async () => {
  // Not three identical rows. Reporting one problem three times is describing
  // it wrongly, and nothing that follows could have succeeded anyway.
  const fs = recordingFs({ async mkdir() { throw new Error('no such volume'); } });
  await assert.rejects(
    () => new LocalNotebookExport({ directory: where('nodir'), clock, fs }).writeDocs(ALL),
    /no such volume/,
  );
});

// ---------------------------------------------------------------- the receipt

test('the line a surface shows never claims more than a rewrite', async () => {
  const directory = where('line');
  const receipt = await new LocalNotebookExport({ directory, clock }).writeDocs(ALL);
  const line = receiptLine(receipt);
  assert.match(line, /I rewrote all 3 documents in /);
  for (const banned of [/up to date/i, /\bsynced\b/i, /notebook/i]) {
    assert.equal(banned.test(line), false, `the receipt line claimed ${banned}`);
  }
});

test('a partial failure is said as a partial failure and names what is stale', async () => {
  let n = 0;
  const fs = recordingFs({
    async writeFile() { n += 1; if (n > 2) throw Object.assign(new Error('x'), { code: 'ENOSPC' }); },
  });
  const receipt = await new LocalNotebookExport({ directory: where('half'), clock, fs })
    .writeDocs(ALL);
  const line = receiptLine(receipt);
  assert.match(line, /I rewrote 2 of 3 documents/);
  assert.match(line, /Virgil: archive/);
  assert.match(line, /what they say is out of date/);
});

test('everything failing is not rounded to everything working, nor the reverse', async () => {
  const fs = recordingFs({
    async writeFile() { throw Object.assign(new Error('x'), { code: 'EACCES' }); },
  });
  const receipt = await new LocalNotebookExport({ directory: where('none'), clock, fs })
    .writeDocs(ALL);
  assert.match(receiptLine(receipt), /could not write any of your documents/);
});

test('bytes are counted from what was offered, so a failed row still says how big it was', async () => {
  const fs = recordingFs({
    async writeFile() { throw Object.assign(new Error('x'), { code: 'ENOSPC' }); },
  });
  const body = 'a body with a pound sign £ in it';
  const receipt = await new LocalNotebookExport({ directory: where('bytes'), clock, fs })
    .writeDocs([doc('learn-now', body)]);
  assert.equal(receipt.docs[0]?.bytes, Buffer.byteLength(body, 'utf8'));
});

test('nothing offered is nothing written, and says so', async () => {
  const receipt = await new LocalNotebookExport({ directory: where('empty'), clock }).writeDocs([]);
  assert.deepEqual(receipt.docs, []);
  assert.equal(allWritten(receipt), false, 'no documents is not the same as all documents written');
  assert.match(receiptLine(receipt), /nothing to write/);
});
