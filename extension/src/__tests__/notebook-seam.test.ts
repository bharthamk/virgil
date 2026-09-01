import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { NOTEBOOK_DOC_KEYS } from '@sb/core';
import {
  HOSTED_NOTEBOOK_DOC_KEYS, LEARN_NOW_DOC, NOTEBOOK_HOST, NOTEBOOK_PUSH_LABEL, NOTEBOOK_SETTINGS_ACTION,
  foregroundNotebookDocument,
  hostedNotebookWrittenLine,
  notebookClipboardText, notebookCopiedLine, notebookCopyFailedLine, notebookNotKeptLine,
  notebookPushFailedLine, notebookPushSeamLine, notebookPushedLine, notebookTabFailedLine,
  notebookTarget,
} from '../notebook.js';

/**
 * UX_SPEC §5d — the hand-off to Gemini Notebook, as decisions rather than as
 * markup.
 *
 * Three of that section's laws are the kind that survive review and then quietly
 * stop being true a lane later, so they are checked here by a machine: the host
 * is the app host and nothing deeper, the copy never claims more than a hand-off,
 * and the seam writes nothing to the ledger. The last one has a runtime half in
 * `panel-wiring.test.ts`; this file holds the static half.
 *
 * The clipboard is gone and so are its tests. What replaced it is a push: the
 * press rewrites the learn now document through the export door and then opens
 * Notebook, so the laws that were about *what leaves on the clipboard* are now
 * about *what the copy is allowed to claim about a write*.
 */

// The tests run out of `dist/`, so the sources are two levels up and one over —
// the same walk `extension-surface.test.ts` makes, and for the same reason:
// these checks guard what ships, which is TypeScript rather than output.
const srcDir = new URL('../../src/', import.meta.url);
const shipped = (): string[] =>
  readdirSync(fileURLToPath(srcDir)).filter((f) => f.endsWith('.ts'));
const read = (file: string): string => readFileSync(fileURLToPath(new URL(file, srcDir)), 'utf8');

/** Comments removed the way `progression-purity.test.ts` removes them, and for
 *  the same reason: the module is full of prose naming the things it forbids. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Every sentence this module renders, in one string, so that a law can be
 *  asserted over the copy as a whole rather than one function at a time. */
const everySentence = (): string => [
  NOTEBOOK_PUSH_LABEL, NOTEBOOK_SETTINGS_ACTION, notebookPushSeamLine(),
  hostedNotebookWrittenLine('learner@example.com', []),
  notebookPushedLine('I rewrote 1 document in a folder on your disk.'),
  notebookPushFailedLine(), notebookNotKeptLine(), notebookTabFailedLine(),
].join(' ');

// ------------------------------------------------------------------- the host

test('§5d fact 1: the hand-off targets the app host, over https', () => {
  const url = new URL(NOTEBOOK_HOST);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.host, 'notebook.google.com',
    'the notebooklm hosts are permanent redirects; shipping a link that only survives on '
    + "someone else's redirect is borrowing a guarantee we were not given");
});

test('§5d fact 2: the host root and nothing deeper — there is no create-a-notebook deep link', () => {
  const url = new URL(NOTEBOOK_HOST);
  assert.equal(url.pathname, '/', 'a guessed path is how a learner stops believing every link on the screen');
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  // The constant is already the normalised form, so nothing downstream has to
  // wonder whether it needs a slash on the end.
  assert.equal(NOTEBOOK_HOST, url.href);
});

test('a configured live notebook is used, while every other destination falls back safely', () => {
  const live = 'https://notebook.google.com/notebook/11111111-2222-4333-8444-555555555555';
  assert.equal(notebookTarget(live), live);
  assert.equal(notebookTarget(`${live}?addSource=true`), `${live}?addSource=true`);
  assert.equal(notebookTarget('https://example.com/notebook/stolen'), NOTEBOOK_HOST);
  assert.equal(notebookTarget('javascript:alert(1)'), NOTEBOOK_HOST);
  assert.equal(notebookTarget(null), NOTEBOOK_HOST);
});

test('§5d build gate: the host is written down in exactly one place', () => {
  // §5d's table is dated evidence rather than a constant, and re-checking it on
  // a build day is only worth something if there is one string to amend. A
  // second copy in a template somewhere is the one that goes stale in silence.
  const naming = shipped().filter((f) => /notebook\.google\.com/.test(read(f)));
  assert.deepEqual(naming, ['notebook.ts']);
});

// ------------------------------------------------------- what the press writes

test('the document the press writes is a document the engine actually builds', () => {
  // The scope travels as a string in a fetch body, which is the one place a key
  // is not type-checked against `core/`. This is that check.
  assert.ok(NOTEBOOK_DOC_KEYS.includes(LEARN_NOW_DOC as typeof NOTEBOOK_DOC_KEYS[number]),
    'the panel is asking the service to write a document that does not exist');
  assert.equal(LEARN_NOW_DOC, 'learn-now');
  assert.deepEqual(HOSTED_NOTEBOOK_DOC_KEYS, NOTEBOOK_DOC_KEYS,
    'the hosted setup drifted from the three documents the engine owns');
});

// ------------------------------------------------------------------- the copy

test('the label is the destination, and the sentence it dropped is on the control', () => {

  assert.equal(NOTEBOOK_PUSH_LABEL, 'Google Notebook');
  assert.ok(NOTEBOOK_PUSH_LABEL.length <= 16, 'a label in a row of four is a name, not a sentence');
  // The clipboard version was *Open in Gemini Notebook (sources copied)* and had
  // to be, because on a signed-out browser nothing had gone anywhere. Something
  // really is written here, and the control's sentence is where that is said.
  assert.ok(!/\bopen in\b/i.test(NOTEBOOK_PUSH_LABEL));
  assert.match(notebookPushSeamLine(), /I take this lesson to Gemini Notebook/);
  assert.match(notebookPushSeamLine(), /refreshes its stable Notebook sources/);
  assert.match(notebookPushSeamLine(), /copy this lesson for you to paste/);
});

test('the hosted three-source receipt never claims the Notebook tab opened', () => {
  const created = hostedNotebookWrittenLine('learner@example.com', [...HOSTED_NOTEBOOK_DOC_KEYS]);
  assert.match(created, /Learn now, On the board and Archive/);
  assert.match(created, /Add each one.*once/);
  assert.doesNotMatch(created, /opened Google Notebook/i);

  const refreshed = hostedNotebookWrittenLine('learner@example.com', []);
  assert.match(refreshed, /refreshed Virgil’s three Notebook sources/);
  assert.doesNotMatch(refreshed, /opened/i);
});

test('the surface says what Virgil does and what it cannot see, before it is pressed', () => {
  const line = notebookPushSeamLine();
  assert.match(line, /stable Notebook sources/i, 'it names the things it is about to refresh');
  assert.match(line, /can.t see your notebook/i,
    'an honest description of a lesser thing beats an implied stronger one');
});

test('§5d: no copy anywhere in the seam says integrated, connected, synced or linked', () => {
  // §5d bans the four words that would turn a hand-off into a claim of
  // integration. Read off the module's own source with the comments stripped,
  // because the paragraph above this test names all four of them.
  const code = stripComments(read('notebook.ts')).toLowerCase();
  for (const banned of ['integrated', 'integration', 'connected', 'synced', 'linked']) {
    assert.ok(!code.includes(banned), `the seam's copy says "${banned}" — the hand-off is a hand-off`);
  }
  // And the sentences it actually renders, in case one is ever assembled out of
  // pieces the scan above would not see whole.
  const said = everySentence().toLowerCase();
  for (const banned of ['integrated', 'integration', 'connected', 'synced', 'linked']) {
    assert.ok(!said.includes(banned), `a rendered line says "${banned}"`);
  }
});

test('nothing the seam says claims the notebook itself is current', () => {
  // The failure this seam has that nothing else in the product has: a stale
  // document answers fluently and gives no sign at all. Virgil says what it
  // wrote and when, and never what Google read.
  const said = everySentence().toLowerCase();
  for (const banned of ['up to date', 'up-to-date', 'in sync', 'notebook now has']) {
    assert.ok(!said.includes(banned), `a rendered line claims "${banned}"`);
  }
});

test('the receipt is the service’s own sentence with one fact added', () => {
  const line = notebookPushedLine('I rewrote 1 document in a folder on your disk.');
  assert.ok(line.startsWith('I rewrote 1 document in a folder on your disk.'),
    'the panel does not compose a second description of a write the service already described');
  assert.match(line, /opened Gemini Notebook in a new tab/);
});

test('a write that did not go through says so, and says what that leaves behind', () => {
  const line = notebookPushFailedLine();
  assert.match(line, /couldn’t write/i);
  assert.match(line, /still what I last wrote/i,
    'the consequence is the whole reason this seam reports at all');
  assert.ok(!/error|failed|problem/i.test(line), 'ordinary refusals speak as Virgil, not as a stack');
});

test('a service that keeps no documents is a missing capability, not a fault', () => {
  const line = notebookNotKeptLine();
  assert.match(line, /not keeping documents for a notebook here/i);
  assert.match(line, /copy-and-paste hand-off/i);
  assert.ok(!/error|failed|sorry|wrong/i.test(line),
    'a capability this build has not been given is not a capability that failed');
  assert.equal(NOTEBOOK_SETTINGS_ACTION, 'Set that up'); // retained for older surfaces during rollout
});

test('the hosted Notebook fallback carries the lesson, not its marking rubric', () => {
  const text = notebookClipboardText('Treaties', 'Three kinds of terms.', 'Name the three kinds.');
  assert.equal(text, 'Treaties\n\nThree kinds of terms.\n\nPractice question\nName the three kinds.');
  assert.match(notebookCopiedLine(true), /copied this lesson.*opened Gemini Notebook/i);
  assert.match(notebookCopiedLine(false), /copied this lesson.*couldn’t open/i);
  assert.match(notebookCopyFailedLine(), /Nothing left this page/);
});

test('a foreground lesson becomes the stable Learn now source with its exact visible content', () => {
  const document = foregroundNotebookDocument(
    'Database Systems', 'Composite indexes',
    'An index covers <one> query.\n\nThe field order matters & stays visible.',
    'Which order should you use?',
  );
  assert.equal(document.key, 'learn-now');
  assert.equal(document.title, 'Virgil: learn now');
  assert.match(document.html, /<title>Virgil: learn now<\/title>/);
  assert.match(document.html, /<strong>Subject:<\/strong> Database Systems/);
  assert.match(document.html, /<h3>Composite indexes<\/h3>/);
  assert.match(document.html, /An index covers &lt;one&gt; query\./);
  assert.match(document.html, /field order matters &amp; stays visible/);
  assert.match(document.html, /<h2>Test your knowledge<\/h2>/);
  assert.match(document.html, /Which order should you use\?/);
  assert.doesNotMatch(document.html, /expectedPoints|marking/i);
});

test('a tab that would not open still leaves the learner the address', () => {
  assert.match(notebookTabFailedLine(), /notebook\.google\.com/);
});

// ----------------------------------------------- the law: it writes nothing

/**
 * §5d's ledger law, statically.
 *
 * *"No signal, no comfort update, no certainty update, no progression event, no
 * badge, no chain. Not a reduced signal — none."* §8 is explicit that this is to
 * be a red-first test rather than a comment, because "we did not mean to write
 * one" is precisely the class of claim this project has already caught itself
 * making.
 *
 * The press now makes a POST, which the clipboard version did not, so the
 * static form has moved: the module still holds no vocabulary for reaching the
 * service, and the request the panel makes on its behalf goes to the export
 * door, which writes prose and touches no signal. The runtime half — the
 * affordance actually pressed, with every request it causes inspected — is in
 * `panel-wiring.test.ts`.
 */
test('§5d: the seam cannot reach the service at all', () => {
  const code = stripComments(read('notebook.ts'));
  assert.ok(!/from\s+'\.\/service\.js'/.test(code),
    'the one door every request goes through is not a door this seam has');
  for (const forbidden of [/\bserviceFetch\b/, /\bfetch\s*\(/, /\bmethod\s*:/]) {
    assert.ok(!forbidden.test(code), `the seam names ${forbidden} — it has no business making a request`);
  }
});

test('§5d: and it has no vocabulary for the ledger either', () => {
  const code = stripComments(read('notebook.ts'));
  for (const word of ['appendSignal', 'Signal', 'comfort', 'progression', 'badge', 'chain', 'milestone']) {
    assert.ok(!new RegExp(`\\b${word}\\b`).test(code),
      `the seam names "${word}" — handing a lesson to another product demonstrates intent to go `
      + 'elsewhere, and recording that as comfort would be inventing a reading');
  }
});

test('§5d: the seam is copy and constants, and imports nothing at all', () => {
  // It used to import `safeHref` from `panel-core.js`, because it had a list of
  // urls to decide about. It has no list any more: the document is written in
  // `core/`, which is where the decision about a followable address already
  // lives. A module with no imports cannot acquire a dependency by accident.
  const strays: string[] = [];
  for (const m of stripComments(read('notebook.ts')).matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
    strays.push(m[1] as string);
  }
  assert.deepEqual(strays, []);
});

test('§5d: the seam is banned from capture — nothing on that path knows it exists', () => {
  // §2: the capture moment takes no new decisions, and §5d bans the affordance
  // from the toast explicitly. The cheapest way for that to stop being true is
  // an import, so the import is what is checked — alongside the product name,
  // which is what any copy would have to say.
  for (const file of ['toast.ts', 'capture.ts', 'background.ts', 'learn-now.ts', 'pin-body.ts', 'queue.ts']) {
    const code = stripComments(read(file));
    assert.ok(!/notebook\.js/.test(code) && !/Gemini Notebook/.test(code),
      `${file} is on the capture path and knows about the hand-off`);
  }
});

test('the retired source-list clipboard path stays gone', () => {
  // The hosted fallback deliberately copies the composed lesson. The retired
  // path copied only source URLs and offered a file; none of that machinery may
  // return under the new, bounded fallback.
  const code = stripComments(read('notebook.ts'));
  for (const gone of [/sourceListText/, /sourceListHref/, /Add sources/i, /SOURCE_LIST_FILENAME/]) {
    assert.ok(!gone.test(code), `${gone} outlived the control it belonged to`);
  }
  const panel = stripComments(read('panel.ts'));
  assert.ok(!/notebookUrls|sourceListHref|SOURCE_LIST_FILENAME|virgil-sources\.txt/.test(panel),
    'the panel still reaches for the clipboard hand-off’s machinery');
});
