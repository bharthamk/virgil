import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installPanelDom, click, find, text, type El } from './panel-dom.js';
import {
  BOX_HEADING, CANCEL_LABEL, COMPOSE_SAVE, CONTEXT_LABEL,
  EFFORT_CHOICES, EFFORT_DEFAULT, EFFORT_LABEL, EMPTY_PASSAGE_NOTE, NOTE_LABEL,
  PAGE_TEXT_PREFILL, PASSAGE_LABEL, PIN_BOX_STYLE, PIN_NOTE_MAX_CHARS, SAVE_LABEL,
  applyPinBoxTheme, buildPinBox, effortFor, envelopeWithEdits, noteFrom, prefillFor, sourceLine, sourceTitle,
} from '../pin-box.js';

/**
 * Standard's box: the pin you look at before you make it.
 *
 * The form and its one rule are here; whether it renders over a page is a
 * browser's question and the probe's. Same split the panel already uses.
 */

const envelope = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  selection: 'A composite index covers a query only when its fields match.',
  surroundingText: 'A long run of page text about indexes and the queries they cover.',
  headingPath: ['Docs', 'Indexes'],
  pageTitle: 'Firestore index types',
  url: 'https://cloud.example.test/indexes',
  ...over,
});

/** The box, built in the stub DOM. `El` throughout: `buildPinBox` types its
 *  handles as the browser's elements, and the stub is the same shape with far
 *  fewer members. */
function box(t: { after: (f: () => void) => void }, env: Record<string, unknown> = envelope()) {
  const dom = installPanelDom();
  t.after(() => { dom.uninstall(); });
  const built = buildPinBox(globalThis.document as unknown as Document, env);
  return {
    dom,
    root: built.root as unknown as El,
    passage: built.passage as unknown as El,
    note: built.note as unknown as El,
    context: built.context as unknown as El,
    effort: built.effort as unknown as El,
    save: built.save as unknown as El,
    cancel: built.cancel as unknown as El,
    status: built.status as unknown as El,
    commit: built.commit,
    result: built.result,
  };
}

test('the box opens on what was captured, and every field is labelled', (t) => {
  const built = box(t);
  assert.equal(text(find(built.root, '.sb-head')), BOX_HEADING);
  assert.equal(built.passage.value, 'A composite index covers a query only when its fields match.');
  assert.equal(built.note.value, '');
  assert.equal(built.save.textContent, SAVE_LABEL);
  assert.equal(built.cancel.textContent, CANCEL_LABEL);
  assert.equal(built.note.getAttribute('placeholder'), null,
    'the note asks no question: it is a field, not a prompt');
  const labels = built.root.querySelectorAll('.sb-label').map((l) => text(l));
  assert.deepEqual(labels, [PASSAGE_LABEL, CONTEXT_LABEL, NOTE_LABEL, EFFORT_LABEL]);
});

test('the page-side form is the same three-state board as the extension', (t) => {
  const built = box(t);
  const host = built.root;

  assert.equal(applyPinBoxTheme(host as unknown as HTMLElement, 'dark'), 'dark');
  assert.equal(host.getAttribute('data-theme'), 'dark');
  assert.equal(applyPinBoxTheme(host as unknown as HTMLElement, 'light'), 'light');
  assert.equal(host.getAttribute('data-theme'), 'light');
  assert.equal(applyPinBoxTheme(host as unknown as HTMLElement, 'not-a-theme'), 'system');
  assert.equal(host.getAttribute('data-theme'), null,
    'match-system is no attribute, so the media query remains the authority');

  assert.match(PIN_BOX_STYLE, /border:5px solid var\(--sb-frame\)/,
    'the form is not drawn as a physical board');
  assert.match(PIN_BOX_STYLE, /font:700 20px\/1\.2 var\(--sb-hand\)/,
    'the heading does not use Virgil’s written register');
  assert.match(PIN_BOX_STYLE, /\.sb-head::after/,
    'the heading is missing the hand-drawn rule used by the adjacent surfaces');
  assert.match(PIN_BOX_STYLE, /:host\(\[data-theme="dark"\]\)/,
    'a stored blackboard choice cannot reach the page-side form');
  assert.match(PIN_BOX_STYLE, /prefers-color-scheme:dark/,
    'match-system has no dark-board implementation');
});

test('the context is the page title, editable, over the provenance it came from', (t) => {
  // It used to be an unlabelled line of text. It is the strongest hint the
  // topic model gets, so a page about hotels carrying a passage about cooking
  // steak filed the steak under hotels with nothing on screen saying so.
  const built = box(t);
  assert.equal(built.context.value, 'Firestore index types');

  // Facts, not an explanation of the field. The label already says what it is
  // and the input already shows it can be typed in.
  assert.equal(text(find(built.root, '.sb-hint')), 'Page title · under “Indexes” · cloud.example.test');

  built.context.value = 'cooking a steak at home';
  const e = built.result().envelope as Record<string, unknown>;
  assert.equal(e['pageTitle'], 'cooking a steak at home',
    'the correction did not reach the field every agent actually reads');
});

test('the provenance says what each fact is, not just what it says', () => {
  // A breadcrumb of names does not say what any of those names ARE, and the
  // question somebody has when they look at a prefilled box is which part of
  // the page put that text there.
  assert.equal(sourceLine({ siteName: 'Example Docs', headingPath: ['Docs', 'Indexes'] }),
    'Page title · under “Indexes” · Example Docs');
  // A page that named no site of its own falls back to its host, without the
  // `www.` nobody reads and without the query string.
  assert.equal(sourceLine({ url: 'https://www.learn.udacity.com/x?y=1', headingPath: ['Prerequisites'] }),
    'Page title · under “Prerequisites” · learn.udacity.com');
  // Missing parts are dropped rather than shown empty.
  assert.equal(sourceLine({ siteName: 'Example Docs', headingPath: [] }), 'Page title · Example Docs');
  assert.equal(sourceLine({}), 'Page title');
  assert.equal(sourceLine(null), 'Page title');
  assert.equal(sourceLine({ url: 'not a url', headingPath: [' ', 7] }), 'Page title');
});

test('a context wiped to nothing keeps the page’s, because less than the page is not a fix', (t) => {
  const built = box(t);
  built.context.value = '   ';
  assert.equal((built.result().envelope as Record<string, unknown>)['pageTitle'],
    'Firestore index types');
});

test('what the button would send is the passage, the note and the depth', (t) => {
  const built = box(t);
  built.passage.value = '  Composite indexes are ordered.  ';
  built.note.value = '  why does field order matter?  ';
  built.effort.value = 'basics';

  const result = built.result();
  assert.equal(result.kind, COMPOSE_SAVE);
  assert.equal(result.text, 'Composite indexes are ordered.', 'sent untrimmed');
  assert.equal(result.note, 'why does field order matter?');
  assert.equal(result.struggle, true, 'the bottom option is the struggle signal the checkbox carried');
  assert.equal(result.requestedRegister, 'from-nothing');
  assert.equal(result.requestedMinutes, 6);
  // The envelope rides back with the edit on it, and everything else intact:
  // the heading path and the url are what say where this came from, and the
  // learner did not change those by editing the words.
  const e = result.envelope as Record<string, unknown>;
  assert.equal(e['selection'], 'Composite indexes are ordered.');
  assert.equal(e['pageTitle'], 'Firestore index types');
  assert.deepEqual(e['headingPath'], ['Docs', 'Indexes']);
});

test('a pin with no material cannot be made', async (t) => {
  // The nightly cannot teach from an empty pin, so the button is the guard
  // rather than a message after the fact.
  const built = box(t, envelope({ selection: '', surroundingText: '' }));
  assert.equal(built.save.disabled, true);
  assert.equal(text(find(built.root, '.sb-empty')), EMPTY_PASSAGE_NOTE,
    'an empty box with no explanation reads as a broken product rather than a thin page');

  built.passage.value = 'typed by hand';
  await built.passage.fireEvent('input');
  assert.equal(built.save.disabled, false);

  built.passage.value = '   ';
  await built.passage.fireEvent('input');
  assert.equal(built.save.disabled, true, 'whitespace is not material');
});

test('a captured passage draws no empty-state line at all', (t) => {
  const built = box(t);
  assert.equal(text(find(built.root, '.sb-empty')), '');
});

test('an unselected page prefills from the page, cut to something editable', () => {
  const long = `${'word '.repeat(400)}END`;
  const got = prefillFor({ selection: null, surroundingText: long });
  assert.ok(got.length <= PAGE_TEXT_PREFILL);
  assert.ok(!got.includes('END'), 'a whole page in a text box is not something anybody edits');
  // Whitespace collapsed: page text arrives with the markup's newlines in it.
  assert.equal(prefillFor({ selection: null, surroundingText: '  a\n\n  b  ' }), 'a b');
});

test('the selection outranks the page, and nothing outranks nothing', () => {
  assert.equal(prefillFor(envelope()), 'A composite index covers a query only when its fields match.');
  assert.equal(prefillFor({ selection: '   ', surroundingText: 'page text' }), 'page text');
  assert.equal(prefillFor({}), '');
  assert.equal(prefillFor(null), '');
  assert.equal(prefillFor({ selection: 42, surroundingText: [] }), '');
});

test('the source title is collapsed and cut, and absent when there is none', () => {
  assert.equal(sourceTitle({ pageTitle: '  Firestore   index types ' }), 'Firestore index types');
  assert.equal(sourceTitle({ pageTitle: 'x'.repeat(200) }).length, 70);
  assert.ok(sourceTitle({ pageTitle: 'x'.repeat(200) }).endsWith('…'));
  assert.equal(sourceTitle({}), '');
});

test('an empty note is no note, because a note that says nothing reads as one', () => {
  assert.equal(noteFrom('  '), null);
  assert.equal(noteFrom(''), null);
  assert.equal(noteFrom('  kept  '), 'kept');
});

test('the capture note states one Unicode boundary and keeps overflow unsent and editable', async (t) => {
  const built = box(t);
  assert.equal(PIN_NOTE_MAX_CHARS, 1_000);
  assert.equal(text(find(built.root, '.sb-note-limit')),
    'Up to 1,000 characters. I save the whole note.');
  assert.equal(built.note.getAttribute('maxlength'), null,
    'native maxlength counts an emoji as two and hides the refusal');
  built.note.value = '🙂'.repeat(1_001);
  const sent: unknown[] = [];
  assert.equal(built.commit((message: unknown) => sent.push(message)), false);
  assert.equal(sent.length, 0);
  assert.equal(built.note.value, '🙂'.repeat(1_001));
  assert.equal(built.dom.activeElement, built.note);
  assert.equal(text(built.status),
    'That note is 1,001 characters. Keep it to 1,000 so I can save all of it. Nothing was sent.');

  const exact = '🙂'.repeat(1_000);
  built.note.value = exact;
  await built.note.fireEvent('input');
  assert.equal(built.commit((message: unknown) => sent.push(message)), true);
  assert.equal(sent.length, 1);
  assert.equal((sent[0] as { note: string }).note, exact);
});

test('editing the passage does not invent an envelope where there was none', () => {
  assert.deepEqual(envelopeWithEdits(null, 'text'), { selection: 'text' });
  assert.deepEqual(envelopeWithEdits({ url: 'u' }, 'text'), { url: 'u', selection: 'text' });
});

test('the buttons do what they are labelled, and only that', async (t) => {
  const built = box(t);
  const sent: unknown[] = [];
  built.save.addEventListener('click', () => sent.push(built.result()));
  await click(built.save);
  assert.equal(sent.length, 1);

  // Cancel is wired by `openPinBox` rather than here, so what this asserts is
  // that the form itself sends nothing on its own.
  await click(built.cancel);
  assert.equal(sent.length, 1, 'cancel sent a pin');
});


test('the levels read the way somebody would ask for them', (t) => {
  const built = box(t);
  assert.equal(text(built.root.querySelectorAll('.sb-label')[3]!), 'Desired lesson level');
  const options = built.root.querySelectorAll('option').map((o) => text(o));
  assert.deepEqual(options, ['Make it simple', 'Refresher', 'Deep dive', 'Start from basics']);
  assert.equal(built.effort.value, EFFORT_DEFAULT);
});

test('the four levels are two axes, which is why there are four of them', () => {
  // A refresher and a deep dive can assume the same knowledge and be nothing
  // alike: one is a reminder and one is the long version. Folded onto the
  // three registers alone, two of these would be synonyms.
  assert.deepEqual(EFFORT_CHOICES.map((c) => [c.value, c.register, c.minutes, c.struggle]), [
    ['simple', 'from-nothing', 2, false],
    ['refresher', 'fluent', 1, false],
    ['deep', 'building', 6, false],
    ['basics', 'from-nothing', 6, true],
  ]);
  // Two options share a register and differ by length; two share a length and
  // differ by register. Neither pair is a duplicate.
  assert.notEqual(EFFORT_CHOICES[0]!.minutes, EFFORT_CHOICES[3]!.minutes);
  assert.notEqual(EFFORT_CHOICES[2]!.register, EFFORT_CHOICES[3]!.register);
  // Only asking to start from basics says the material is hard for them.
  assert.deepEqual(EFFORT_CHOICES.filter((c) => c.struggle).map((c) => c.value), ['basics']);
});

test('a level this build does not know is the default, never the strongest one', () => {
  assert.equal(effortFor('something-else').value, EFFORT_DEFAULT);
  assert.equal(effortFor('').value, EFFORT_DEFAULT);
  // The options that have been cut along the way are not still reachable.
  assert.equal(effortFor('auto').value, EFFORT_DEFAULT);
  assert.equal(effortFor('scratch').value, EFFORT_DEFAULT);
  assert.notEqual(effortFor('anything').struggle, true, 'an unknown value must not mean "I am struggling"');
});
