import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fixedClock, failedDocs, notebookDocs,
  type NotebookDoc, type NotebookExport, type WriteReceipt,
} from '@sb/core';
import { LocalNotebookExport } from '@sb/adapters';
import { runBatch } from '../pipeline.js';
import { exportNotebook, readNotebookInput } from '../notebook-export.js';
import { notebookDestination } from '../notebook-targets.js';
import { hostedNotebookUrl } from '../hosted-notebook-routes.js';
import { bench, generateBoard } from './batch-harness.js';
import { NOW, section, session, startService, topic } from './service-harness.js';

/**
 * NOTEBOOK_SEAM_V2.md §9 — the wiring, and the two things it must never do.
 *
 * The seam's whole promise is that nobody clicks anything, so the test that
 * matters most is the one nobody would think to write: **that a service with no
 * destination configured behaves exactly as it did before any of this existed.**
 * A feature nobody switched on must not warn, must not log, must not half-run,
 * and must not answer an endpoint as though it were merely broken.
 *
 * The second is that a failed export never turns a successful night into a
 * failed one. A throw at the last step would ask a Cloud Run Job retry to run
 * nine model stages again to fix a directory permission, which is spending a
 * learner's budget on a filesystem problem.
 */

const clock = fixedClock(NOW);
const LIVE_NOTEBOOK = 'https://notebook.google.com/notebook/11111111-2222-4333-8444-555555555555';
const where = (tag: string): string =>
  join(mkdtempSync(join(tmpdir(), `sb-nbseam-${tag}-`)), 'documents');

const localTo = (directory: string): NotebookExport =>
  new LocalNotebookExport({ directory, clock });

/** A destination that refuses one document, and the shape a real one refuses in:
 *  a receipt with a row saying so, never a rejection. */
const refusesOne = (key: NotebookDoc['key']): NotebookExport => ({
  async writeDocs(docs) {
    return {
      at: NOW,
      target: 'a destination in a test',
      docs: docs.map((d) => d.key === key
        ? { key: d.key, title: d.title, written: false, at: null, bytes: 0, error: 'it would not take it.' }
        : { key: d.key, title: d.title, written: true, at: `at/${d.key}`, bytes: d.body.length, error: null }),
    };
  },
});

/** A destination that is not there at all. The whole-target failure. */
const refusesEverything = (): NotebookExport => ({
  async writeDocs(): Promise<WriteReceipt> { throw new Error('there is no folder'); },
});

// --------------------------------------------------- absent config is off

test('with nowhere configured, the endpoints are not there rather than broken', async (t) => {
  const h = await startService('nb-off');
  t.after(() => h.close());

  // 404 rather than 500 or an empty success: a service with nowhere to put the
  // documents does not have this feature, and both of the other answers would
  // describe an unmade choice as a fault.
  assert.equal((await h.call('POST', '/notebook/export')).status, 404);
  assert.equal((await h.call('GET', '/notebook/export')).status, 404);
});

test('the hosted browser can read the exact document even when no server destination exists', async (t) => {
  const h = await startService('nb-browser-document');
  t.after(() => h.close());

  const response = await h.call('GET', '/notebook/document?key=learn-now');
  assert.equal(response.status, 200);
  assert.equal(response.body.document.key, 'learn-now');
  assert.equal(response.body.document.title, 'Virgil: learn now');
  assert.match(response.body.document.html, /^<!DOCTYPE html>/);
  assert.match(response.body.document.html, /<title>Virgil: learn now<\/title>/);
  assert.equal((await h.call('GET', '/notebook/document?key=sessions')).status, 400);
  assert.equal((await h.call('GET', '/notebook/export')).status, 404,
    'reading the generated document did not pretend the service owns a Drive destination');
});

test('the hosted browser can read all three exact documents in one foreground setup read', async (t) => {
  const h = await startService('nb-browser-documents');
  t.after(() => h.close());

  const response = await h.call('GET', '/notebook/documents');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.documents.map((document: { key: string }) => document.key),
    ['learn-now', 'on-the-board', 'archive']);
  for (const document of response.body.documents as { title: string; html: string }[]) {
    assert.match(document.title, /^Virgil: /);
    assert.match(document.html, /^<!DOCTYPE html>/);
    assert.match(document.html, /How to use this source/);
  }
  assert.equal((await h.call('GET', '/notebook/export')).status, 404,
    'reading the generated documents did not pretend the service owns a Drive destination');
});

test('hosted setup arms and disables background refresh with file ids but no credential', async (t) => {
  const h = await startService('nb-hosted-setup', {}, {
    hostedNotebookDriveAccount: 'notebook-owner@example.com',
    hostedNotebookUrl: LIVE_NOTEBOOK,
  });
  t.after(() => h.close());

  const setup = await h.call('PUT', '/notebook/drive/hosted-setup', {
    account: 'notebook-owner@example.com',
    folderId: 'folder-1',
    files: { 'learn-now': 'doc-1', 'on-the-board': 'doc-2', archive: 'doc-3' },
  }, { 'x-virgil-time-zone': 'Australia/Sydney' });
  assert.equal(setup.status, 200);
  assert.equal(setup.body.connected, true);
  const stored = (await h.store.getPrefs()).notebookDrive;
  assert.deepEqual(stored?.files, {
    'learn-now': 'doc-1', 'on-the-board': 'doc-2', archive: 'doc-3',
  });
  assert.equal((await h.store.getPrefs()).timeZone, 'Australia/Sydney',
    'the unattended writer lost the learner day observed during setup');
  assert.doesNotMatch(JSON.stringify(stored), /token|secret/i);

  const status = await h.call('GET', '/notebook/drive/hosted-setup');
  assert.equal(status.body.connected, true);
  assert.deepEqual(status.body.documents, ['archive', 'learn-now', 'on-the-board']);
  assert.equal(status.body.folderLink, 'https://drive.google.com/drive/folders/folder-1');
  assert.equal(status.body.notebookUrl, LIVE_NOTEBOOK);
  assert.equal(status.body.connectedAt, stored?.connectedAt);
  assert.equal(status.body.lastWriteAt, stored?.lastWriteAt);

  const stopped = await h.call('DELETE', '/notebook/drive/hosted-setup');
  assert.equal(stopped.body.connected, false);
  assert.equal((await h.store.getPrefs()).notebookDrive?.enabled, false);
  assert.deepEqual((await h.store.getPrefs()).notebookDrive?.files, stored?.files,
    'disconnect removed the learner-owned Drive identities');
});

test('the hosted notebook destination accepts only a concrete Google notebook', () => {
  assert.equal(hostedNotebookUrl(LIVE_NOTEBOOK), LIVE_NOTEBOOK);
  assert.equal(hostedNotebookUrl('https://example.com/notebook/other'), null);
  assert.equal(hostedNotebookUrl('https://notebook.google.com/'), null);
  assert.equal(hostedNotebookUrl('javascript:alert(1)'), null);
});

test('an older hosted setup uses its successful connection as the first refresh receipt', async (t) => {
  const h = await startService('nb-hosted-setup-legacy-receipt', {}, {
    hostedNotebookDriveAccount: 'notebook-owner@example.com',
  });
  t.after(() => h.close());
  const prefs = await h.store.getPrefs();
  await h.store.putPrefs({
    ...prefs,
    notebookDrive: {
      enabled: true,
      account: 'notebook-owner@example.com',
      folderId: 'folder-1',
      files: { 'learn-now': 'doc-1', 'on-the-board': 'doc-2', archive: 'doc-3' },
      connectedAt: '2026-08-20T03:04:05.000Z',
    },
  });

  const status = await h.call('GET', '/notebook/drive/hosted-setup');
  assert.equal(status.status, 200);
  assert.equal(status.body.lastWriteAt, '2026-08-20T03:04:05.000Z');
});

test('hosted setup refuses a different account or incomplete three-source set', async (t) => {
  const h = await startService('nb-hosted-setup-refuse', {}, {
    hostedNotebookDriveAccount: 'notebook-owner@example.com',
  });
  t.after(() => h.close());
  assert.equal((await h.call('PUT', '/notebook/drive/hosted-setup', {
    account: 'other@example.com', folderId: 'folder-1',
    files: { 'learn-now': 'doc-1', 'on-the-board': 'doc-2', archive: 'doc-3' },
  })).status, 400);
  assert.equal((await h.call('PUT', '/notebook/drive/hosted-setup', {
    account: 'notebook-owner@example.com', folderId: 'folder-1',
    files: { 'learn-now': 'doc-1', archive: 'doc-3' },
  })).status, 400);
  assert.equal((await h.store.getPrefs()).notebookDrive, undefined);
});

test('with nowhere configured, a night runs exactly as it always did', async () => {
  const b = await bench('nb-off-batch', generateBoard(4, 2));
  const result = await runBatch(b.deps, { concurrency: 2 });
  assert.equal(result.notebook, null,
    'null is "not configured", which is a different fact from "written" and from "failed"');
  assert.equal(result.reports.some((r) => r.failed), false);
});

// ------------------------------------------------------- the export itself

test('the export reads the real board and the documents say what is on it', async (t) => {
  const directory = where('board');
  const h = await startService('nb-board', {}, { notebook: localTo(directory) });
  t.after(() => h.close());

  const made = await h.call('POST', '/pins', {
    type: 'struggle',
    envelope: {
      selection: 'a sentence that would not go in',
      parts: [], surroundingText: '', headingPath: [],
      pageTitle: 'A page about ordering', url: 'https://example.org/ordering',
      canonicalUrl: null, siteName: 'Example', contentLanguage: 'en', media: null,
    },
    note: 'why does this hold?',
  });
  assert.equal(made.status, 201);

  const res = await h.call('POST', '/notebook/export');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.ran, true);
  assert.equal(res.body.docs.length, 3);

  const onTheBoard = readFileSync(join(directory, 'virgil-on-the-board.md'), 'utf8');
  assert.match(onTheBoard, /A page about ordering/);
  assert.match(onTheBoard, /why does this hold\?/);
  assert.match(onTheBoard, /You saved this because it was giving you trouble\./);
});

test('the export is composed from the same reads the board itself uses', async (t) => {
  const h = await startService('nb-input');
  t.after(() => h.close());
  const input = await readNotebookInput(h.deps.store, h.deps.clock);
  assert.equal(input.now.toISOString(), NOW, 'the injected clock, not the wall clock');
  // `comforts` and `reasons` are the Registrar's and the Gardener's own output,
  // asked for rather than described, so a document and a session card cannot
  // tell the learner two different things about the same night.
  assert.deepEqual(input.comforts.map((c) => c.topicId), input.topics.map((t) => t.id));
  assert.ok(Array.isArray(input.reasons));
});

test('notebook input cannot re-export a claim Tutor conceded', async (t) => {
  const h = await startService('nb-conceded-shell');
  t.after(() => h.close());
  await h.deps.store.putTopic(topic('A', ['p1']));
  await h.deps.store.putSession(session('s1', [section('A', {
    heading: 'Direction must match', body: 'The source does not establish it.',
    summary: 'Why direction must match', recap: 'Direction has to match.',
    actionMinutes: 1, estimatedMinutes: 5,
    corrections: [{
      id: 'c1', clientRef: 'nb-c1', claim: 'Direction must match.',
      challenge: 'The source does not say that.',
      reply: 'The source does not establish it.', conceded: true,
      sourceIds: ['p1:origin'], withdrawn: 1, at: NOW,
    }],
  })], { closingNote: 'Direction matching moved into practice.' }));
  const input = await readNotebookInput(h.deps.store, h.deps.clock);
  const safe = input.sessions[0]!;
  assert.equal(safe.sections[0]?.heading, 'label of A');
  assert.equal(safe.sections[0]?.question, null);
  assert.equal(safe.closingNote, null);
  const text = notebookDocs(input).map((doc) => doc.body).join('\n');
  assert.doesNotMatch(text, /Direction must match|Direction matching moved/);
});

test('notebook input withholds a historical source-boundary assessment', async (t) => {
  const h = await startService('nb-source-boundary');
  t.after(() => h.close());
  await h.deps.store.putTopic(topic('A', ['p1']));
  await h.deps.store.putSession(session('s206', [section('A', {
    heading: 'A third range field',
    body: 'The source has reduced confidence, so it does not establish the full field-position algorithm.',
    question: {
      kind: 'free-text',
      prompt: 'Why can the third range field not be appended?',
      expectedPoints: ['Its position is governed by the first range field, so it cannot be a simple append.'],
    },
  })], { closingNote: 'The index lesson landed.' }));

  const input = await readNotebookInput(h.deps.store, h.deps.clock);
  assert.deepEqual(input.sessions[0]?.sections, []);
  assert.equal(input.sessions[0]?.withheld?.[0]?.reason, 'defective');
  assert.equal(input.sessions[0]?.closingNote, null);
  const text = notebookDocs(input).map((doc) => doc.body).join('\n');
  assert.doesNotMatch(text, /cannot be a simple append|The index lesson landed/);
  assert.match(text, /What I held back[\s\S]*label of A/,
    'the notebook hid that a check withheld something rather than teaching it');
  assert.equal((await h.deps.store.getSession('s206'))?.sections.length, 1,
    'the notebook projection rewrote the stored authored row');
});

test('all three documents land, named from their keys', async () => {
  const directory = where('three');
  const h = await startService('nb-three', {}, { notebook: localTo(directory) });
  try {
    await h.call('POST', '/notebook/export');
    assert.deepEqual(readdirSync(directory).sort(), [
      'virgil-archive.md', 'virgil-learn-now.md', 'virgil-on-the-board.md',
    ]);
  } finally { await h.close(); }
});

// ------------------------------------------------------- the honest report

test('before anything has been written, the report says so and does not read as a fault', async (t) => {
  const h = await startService('nb-never', {}, { notebook: localTo(where('never')) });
  t.after(() => h.close());

  const res = await h.call('GET', '/notebook/export');
  assert.equal(res.status, 200, 'a restart has honestly written nothing, which is not an error');
  assert.equal(res.body.ran, false);
  assert.match(res.body.line, /have not written your documents since I started up/);
});

test('the last receipt is what the report returns', async (t) => {
  const h = await startService('nb-last', {}, { notebook: localTo(where('last')) });
  t.after(() => h.close());

  await h.call('POST', '/notebook/export');
  const res = await h.call('GET', '/notebook/export');
  assert.equal(res.body.ran, true);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.at, NOW);
  assert.match(res.body.line, /I rewrote all 3 documents in /);
});

test('a partial failure answers 207 and names what is now out of date', async (t) => {
  const h = await startService('nb-partial', {}, { notebook: refusesOne('archive') });
  t.after(() => h.close());

  const res = await h.call('POST', '/notebook/export');
  // Not 200 and not 500. Two documents were written and one was not, and
  // rounding that to either is the kind of small lie that makes somebody stop
  // reading the status line at all.
  assert.equal(res.status, 207);
  assert.equal(res.body.ok, false);
  assert.deepEqual(res.body.failed, ['archive']);
  assert.match(res.body.line, /I rewrote 2 of 3 documents/);
  assert.match(res.body.line, /what they say is out of date/);
});

test('nothing the seam reports ever claims the notebook itself is current', async (t) => {
  const h = await startService('nb-claims', {}, { notebook: localTo(where('claims')) });
  t.after(() => h.close());

  const body = JSON.stringify((await h.call('POST', '/notebook/export')).body);
  for (const banned of [/up to date/i, /\bsynced\b/i, /\bintegrated\b/i]) {
    assert.equal(banned.test(body), false, `the receipt claimed ${banned}`);
  }
});

// --------------------------------------------------------- the nightly hook

test('the night rewrites the documents after the session is persisted', async () => {
  const directory = where('nightly');
  const b = await bench('nb-nightly', generateBoard(6, 3));
  const result = await runBatch(b.deps, { concurrency: 2, notebook: localTo(directory) });

  assert.notEqual(result.notebook, null);
  assert.equal(result.notebook?.docs.length, 3);
  assert.equal(result.notebook?.docs.every((d) => d.written), true);
  assert.equal(readdirSync(directory).length, 3);

  // Last on purpose: these documents describe the board, and the board is not
  // finished until the session that was just composed is part of it. The
  // nightly is the other writer of the learn now document: a night that built
  // a new session and left yesterday's lesson in the notebook would be the
  // stale-and-confident failure this whole seam exists against.
  const learnNow = readFileSync(join(directory, 'virgil-learn-now.md'), 'utf8');
  const stored = await b.store.latestSession();
  if (stored?.sections.length) {
    assert.match(learnNow, /## The lesson in front of you/);
    assert.match(learnNow, new RegExp(`### ${stored.sections[0]?.heading}`));
  }
});

test('an export that cannot run at all does not fail the night', async () => {
  const b = await bench('nb-nightly-fail', generateBoard(6, 3));
  const result = await runBatch(b.deps, { concurrency: 2, notebook: refusesEverything() });

  // The session is already written and the learner already has it. A throw here
  // would ask a retry to re-run nine model stages to fix a folder.
  assert.equal(result.reports.some((r) => r.failed), false);
  assert.notEqual(result.session, null);

  // A receipt with no rows rather than no receipt: an absent receipt is
  // indistinguishable from the feature being switched off.
  assert.notEqual(result.notebook, null);
  assert.deepEqual(result.notebook?.docs, []);
});

test('a night that could not write one document says which one', async () => {
  const b = await bench('nb-nightly-partial', generateBoard(4, 2));
  const result = await runBatch(b.deps, { concurrency: 2, notebook: refusesOne('archive') });
  const failed = (result.notebook?.docs ?? []).filter((d) => !d.written);
  assert.deepEqual(failed.map((d) => d.key), ['archive']);
  assert.equal(failed[0]?.error, 'it would not take it.');
});

// ------------------------------------------- the notebook and the panel agree

/**
 * ONE NIGHT, TWO SURFACES, AND THEY MAY NOT DISAGREE.
 *
 * The divergence this pairing was written for. `readNotebookInput` recomputes
 * `tend()` at export time, which is the right read for a document about the
 * board as it stands now. Since the learner-lineup contract a session also carries each
 * section's own `why`, written by the run that ranked it, and `GET /session`
 * prefers that. Without the same precedence in the engine, an on-demand export
 * days later quotes whatever the Gardener would say about that topic *today* —
 * honest, different, and read back to the learner by a chat assistant with
 * every appearance of authority.
 *
 * This walks both surfaces over one real board through the real endpoints,
 * because the rule holding in `core/` and the two surfaces agreeing in a running
 * service are different claims, and it is the second one a learner meets.
 */
test('the notebook and the panel tell the same story about the same night', async (t) => {
  const directory = where('pairing');
  const h = await startService('nb-pairing', {}, { notebook: localTo(directory) });
  t.after(() => h.close());

  await h.store.putTopic(topic('t-pair', ['p1'], { label: 'Idempotent handlers' }));
  await h.store.putSession(session('s-pair', [
    section('t-pair', {
      heading: 'Why a handler has to be safe to run twice',
      why: 'an assignment on Friday leans on it and this went quiet last week',
    }),
  ], { batchKey: '2026-08-19' }));

  const panel = await h.call('GET', '/session');
  assert.equal(panel.status, 200);
  const shown: string | null = panel.body.session?.sections?.[0]?.why ?? null;
  assert.ok(shown, 'the panel showed no reason at all, so there was nothing to pair with');

  await h.call('POST', '/notebook/export');
  const document = readFileSync(join(directory, 'virgil-learn-now.md'), 'utf8');

  // Verbatim, and quoted rather than re-worded: the point is that the two
  // cannot drift, and a paraphrase is a drift that has already happened.
  assert.ok(document.includes(shown),
    `the panel says "${shown}" and the notebook does not`);
  assert.match(document, /Why I chose it: an assignment on Friday leans on it/);
});

test('a night with no recorded reason still agrees, on the fallback both use', async (t) => {
  const directory = where('pairing-old');
  const h = await startService('nb-pairing-old', {}, { notebook: localTo(directory) });
  t.after(() => h.close());

  // A session composed before `why` existed. Both surfaces fall back to the
  // Gardener read at read time, which is the only answer either of them has.
  await h.store.putTopic(topic('t-old', ['p1'], { label: 'Retry semantics' }));
  await h.store.putSession(session('s-old', [section('t-old')], { batchKey: '2026-08-19' }));

  const panel = await h.call('GET', '/session');
  const shown: string | null = panel.body.session?.sections?.[0]?.why ?? null;
  await h.call('POST', '/notebook/export');
  const document = readFileSync(join(directory, 'virgil-learn-now.md'), 'utf8');

  if (shown) {
    assert.ok(document.includes(shown), 'the fallback diverged where the stored reason does not');
  } else {
    // No reason on either side is a line that is absent rather than empty.
    assert.equal(document.includes('Why I chose it:'), false);
  }
});

// ------------------------------------------------- where the documents go now

/** A destination that says where it is and writes everything it is offered. */
const writesTo = (target: string, at: (key: string) => string): NotebookExport => ({
  async writeDocs(docs) {
    return {
      at: NOW,
      target,
      docs: docs.map((d) => ({
        key: d.key, title: d.title, written: true, at: at(d.key),
        bytes: Buffer.byteLength(d.body, 'utf8'), error: null,
      })),
    };
  },
});

test('one destination hands its own receipt straight back', async () => {
  const receipt = await notebookDestination({
    local: writesTo('a folder on your disk', (k) => `/tmp/${k}.md`),
    drive: () => null,
  }).writeDocs(notebookDocs(await readNotebookInput(
    (await bench('nb-one-target', generateBoard(2, 1))).store, fixedClock(NOW))));

  assert.equal(receipt.target, 'a folder on your disk');
  assert.equal(receipt.docs[0]?.at, '/tmp/learn-now.md');
});

test('with both destinations on, a row is written only when it landed in both', async () => {
  const b = await bench('nb-both', generateBoard(2, 1));
  const docs = notebookDocs(await readNotebookInput(b.store, fixedClock(NOW)));

  const receipt = await notebookDestination({
    local: writesTo('a folder on your disk', (k) => `/tmp/${k}.md`),
    drive: () => refusesOne('archive'),
  }).writeDocs(docs);

  assert.equal(receipt.docs.length, 3, 'one row per document offered, always');
  assert.deepEqual(failedDocs(receipt).map((d) => d.key), ['archive'],
    'two in a folder and none in Drive is not a night that wrote everything');
  // The Drive file id is the identity the notebook reads; the path is the copy.
  assert.equal(receipt.docs.find((d) => d.key === 'learn-now')?.at, 'at/learn-now');
  assert.match(receipt.target, /, and /);
});

test('with the lane on and nothing connected, the failure is one fact rather than three', async () => {
  const b = await bench('nb-nowhere', generateBoard(2, 1));
  const docs = notebookDocs(await readNotebookInput(b.store, fixedClock(NOW)));
  // The port's whole-target shape: no credential is not about any one document.
  await assert.rejects(
    () => notebookDestination({ local: null, drive: () => null }).writeDocs(docs),
    /is not connected yet/,
  );
});

// ----------------------------------------------------------- costing nothing

test('the export runs on a board with no model available at all', async () => {
  // The engine is pure and makes no model call, so there is nothing here a
  // spend limit or a provider outage could stop. A learner whose budget stopped
  // tonight's session still gets their documents rewritten, which is the right
  // answer: the alternative is a limit that silently also freezes a notebook.
  const directory = where('nomodel');
  const b = await bench('nb-nomodel', generateBoard(2, 1));
  const before = b.llm.calls.length;
  const receipt = await exportNotebook(b.store, fixedClock(NOW), localTo(directory));
  assert.equal(b.llm.calls.length, before, 'the export asked a model for something');
  assert.equal(receipt.docs.length, 3);
});

// ------------------------------------------------------------- the push door

/**
 * THE LESSON'S OWN CONTROL, THROUGH THE ONE DOOR IT HAS.
 *
 * *"Send this lesson to my notebook"* is a scoped export and nothing else. Three
 * things have to be true and none of them is obvious from the endpoint's shape:
 * that one document is written and the other two are left exactly as they were,
 * that the document written says what the board says rather than what the panel
 * said, and that a name the engine does not build is refused rather than
 * generously turned into a full rewrite nobody asked for.
 */

test('the push writes one document and leaves the other two where they were', async (t) => {
  const directory = where('push');
  const h = await startService('nb-push', {}, { notebook: localTo(directory) });
  t.after(() => h.close());

  const all = await h.call('POST', '/notebook/export');
  assert.equal(all.status, 200);
  const boardBefore = readFileSync(join(directory, 'virgil-on-the-board.md'), 'utf8');

  const pushed = await h.call('POST', '/notebook/export', { docs: ['learn-now'] });
  assert.equal(pushed.status, 200);
  assert.equal(pushed.body.ok, true);
  assert.deepEqual((pushed.body.docs as { key: string }[]).map((d) => d.key), ['learn-now']);
  assert.match(pushed.body.line, /I rewrote 1 document in /,
    'a control that promised one document does not report three');

  assert.deepEqual(readdirSync(directory).sort(), [
    'virgil-archive.md', 'virgil-learn-now.md', 'virgil-on-the-board.md',
  ], 'a scoped write is still a rewrite in place and never a fourth file');
  assert.equal(readFileSync(join(directory, 'virgil-on-the-board.md'), 'utf8'), boardBefore,
    'a tap about one lesson rewrote a document it was not about');
});

test('the pushed document renders the session the store holds, not one it was told about', async (t) => {
  const directory = where('push-source');
  const h = await startService('nb-push-source', {}, { notebook: localTo(directory) });
  t.after(() => h.close());

  await h.store.putTopic(topic('t-push', ['p1'], { label: 'Ack deadlines' }));
  await h.store.putSession(session('s-push', [
    section('t-push', { heading: 'Why an ack can arrive after the work' }),
  ], { batchKey: '2026-08-19' }));

  // The body names a document and says nothing at all about which lesson. There
  // is no field here through which a second panel, or a stale tab, could push a
  // lesson the board is not on.
  const pushed = await h.call('POST', '/notebook/export', { docs: ['learn-now'] });
  assert.equal(pushed.status, 200);
  const written = readFileSync(join(directory, 'virgil-learn-now.md'), 'utf8');
  assert.match(written, /### Why an ack can arrive after the work/);
  assert.match(written, /This is about: Ack deadlines\./);
});

test('the push reports a partial failure as one, and does not call it a success', async (t) => {
  const h = await startService('nb-push-partial', {}, { notebook: refusesOne('learn-now') });
  t.after(() => h.close());

  const pushed = await h.call('POST', '/notebook/export', { docs: ['learn-now'] });
  assert.equal(pushed.status, 207);
  assert.equal(pushed.body.ok, false);
  assert.deepEqual(pushed.body.failed, ['learn-now']);
  assert.match(pushed.body.line, /still there, and what they say is out of date/);
});

test('with nowhere configured, the push is a missing capability rather than a fault', async (t) => {
  const h = await startService('nb-push-off');
  t.after(() => h.close());
  const pushed = await h.call('POST', '/notebook/export', { docs: ['learn-now'] });
  assert.equal(pushed.status, 404,
    'a service with nowhere to put the documents does not have this feature');
});

test('a document key the engine does not build is refused rather than widened', async (t) => {
  const directory = where('push-bad');
  const h = await startService('nb-push-bad', {}, { notebook: localTo(directory) });
  t.after(() => h.close());

  for (const bad of [{ docs: ['sessions'] }, { docs: [] }, { docs: 'learn-now' }]) {
    const res = await h.call('POST', '/notebook/export', bad);
    assert.equal(res.status, 400, `${JSON.stringify(bad)} was accepted`);
  }
  assert.equal(existsSync(directory), false,
    'a refused scope reached the adapter and made a folder anyway');
});
