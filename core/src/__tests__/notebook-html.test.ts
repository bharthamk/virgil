import { test } from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, notebookBodyHtml, notebookDocHtml } from '../domain/notebook-html.js';
import { notebookDocs, type NotebookInput } from '../domain/notebook-docs.js';
import type { NotebookDoc, NotebookDocKey } from '../ports/notebook-export.js';
import type { Pin, Session, SessionSection, Topic } from '../domain/types.js';
import type { Commitment } from '../domain/commitments.js';
import type { Course } from '../domain/courses.js';

/**
 * NOTEBOOK_SEAM_V2.md §10.2 — Markdown to minimal HTML.
 *
 * The converter has one consumer and it is a Drive upload nobody in this
 * repository can watch happen, so **the only evidence it works is a test**. The
 * goldens are therefore taken from the real generator rather than hand-written:
 * a fixture written by hand proves the converter handles the constructs the
 * person writing the fixture remembered, which is exactly the set of constructs
 * that were never going to be the problem.
 *
 * The two failure modes worth guarding are the ones with consequences outside
 * this file. A construct that renders as characters gives the learner a Google
 * Doc with `##` in it, in their own Drive, with Virgil's name on it. And a
 * construct that renders as markup when it was learner prose is an injection:
 * these bodies quote what somebody typed at 11pm and what a marker wrote about
 * their work.
 */

const NOW = new Date('2026-08-24T03:00:00.000Z');
const ago = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const topic = (id: string, over: Partial<Topic> = {}): Topic => ({
  id, label: `label of ${id}`, summary: `what ${id} is about`, pinIds: [],
  state: 'working', comfort: 0.5, lastExposedAt: ago(3), retiredByUser: false,
  createdAt: ago(40), ...over,
});

const pin = (id: string, over: Partial<Pin> = {}): Pin => ({
  id,
  type: 'struggle',
  envelope: {
    selection: `the passage behind ${id}`, parts: [], surroundingText: '',
    headingPath: ['Chapter one', 'A section'], pageTitle: `page title for ${id}`,
    url: `https://example.org/${id}`, canonicalUrl: null, siteName: 'Example',
    contentLanguage: 'en', media: null,
  },
  note: `why I kept ${id}`, capturedAt: ago(1), fromSuggestion: false,
  enrichment: null, topicId: 't1', ...over,
});

const section = (over: Partial<SessionSection> = {}): SessionSection => ({
  topicId: 't1', heading: 'A heading', body: 'The body, in full.', depth: 'building',
  estimatedMinutes: 7, question: null, sourceIds: [], completed: false, ...over,
});

const board = (over: Partial<NotebookInput> = {}): NotebookInput => ({
  now: NOW,
  topics: [], pins: [], signals: [], statements: [], courses: [],
  commitments: [], sessions: [], outcomes: [], comforts: [], reasons: [],
  ...over,
});

/** A board with every construct the three documents can emit on it at once. */
const richBoard = (): NotebookInput => board({
  topics: [topic('t1')],
  pins: [pin('p1')],
  courses: [{
    id: 'c1', title: 'A course', provider: 'Somewhere', url: 'https://example.org/course',
    material: [{
      id: 'm1', kind: 'video', title: 'A lecture', url: 'https://example.org/lecture',
      minutes: 30, doneAt: null, addedAt: ago(5), pinIds: [],
    }],
    topicIds: ['t1'], archivedAt: null, createdAt: ago(30),
  } as Course],
  commitments: [{
    id: 'k1', title: 'An assignment', kind: 'assignment', courseId: 'c1', topicIds: ['t1'],
    dueAt: ago(-3), plannedFor: ago(-1), estimateMinutes: 90, notes: 'a note I left myself',
    doneAt: null, createdAt: ago(10),
  } as Commitment],
  sessions: [{
    id: 's1', builtAt: ago(1), fromPinCount: 4, targetMinutes: 15, estimatedMinutes: 14,
    sections: [section({ why: 'it has gone quiet and Friday leans on it' })],
    currentSectionIndex: 0, closingNote: 'a closing note',
  } as Session],
  reasons: [{ topicId: 't1', reason: 'it has gone quiet and Friday leans on it' }],
  comforts: [{ topicId: 't1', regressed: false, certainty: 0.8, evidenceCount: 3 }],
});

const docOf = (key: NotebookDocKey, input: NotebookInput): NotebookDoc =>
  notebookDocs(input).find((d) => d.key === key)!;

// -------------------------------------------------- the constructs, one by one

test('the five constructs render as markup, and nothing else does', () => {
  const html = notebookBodyHtml([
    '# A title',
    '',
    'A paragraph of prose.',
    '',
    '## A section',
    '',
    '- a first fact',
    '- a second fact',
    '  a line hanging off the second',
    '',
    'Open it: [the exact place](https://example.org/a?b=1)',
  ].join('\n'));

  assert.equal(html, [
    '<h1>A title</h1>',
    '<p>A paragraph of prose.</p>',
    '<h2>A section</h2>',
    '<ul>',
    '<li>a first fact</li>',
    '<li>a second fact<br>a line hanging off the second</li>',
    '</ul>',
    '<p>Open it: <a href="https://example.org/a?b=1">the exact place</a></p>',
  ].join('\n'));
});

test('a hash with no space after it is a hash in a sentence, not a heading', () => {
  assert.equal(notebookBodyHtml('#3 in the list'), '<p>#3 in the list</p>');
});

test('a dash inside a sentence does not start a list', () => {
  // `Body.list` writes `- ` at the start of a line. A hyphen anywhere else is a
  // hyphen, and prose quoted from a learner is full of them.
  assert.equal(notebookBodyHtml('a well-formed sentence'), '<p>a well-formed sentence</p>');
});

test('a heading closes the list above it rather than swallowing it', () => {
  assert.equal(notebookBodyHtml('- one\n## Next'), '<ul>\n<li>one</li>\n</ul>\n<h2>Next</h2>');
});

test('consecutive prose lines are one passage, not one paragraph each', () => {
  // A quoted section body arrives as one block with newlines in it. Splitting
  // it into paragraphs would change what the Composer wrote.
  assert.equal(notebookBodyHtml('first line\nsecond line'), '<p>first line<br>second line</p>');
});

test('a blank line ends the block, so two passages stay two', () => {
  assert.equal(notebookBodyHtml('one\n\ntwo'), '<p>one</p>\n<p>two</p>');
});

test('nothing is emitted for nothing', () => {
  assert.equal(notebookBodyHtml(''), '');
  assert.equal(notebookBodyHtml('\n\n\n'), '');
});

// ------------------------------------------------------------- what is escaped

test('markup a learner typed is text, not markup', () => {
  // These bodies quote pinned selections, notes typed at 11pm, and feedback a
  // marker wrote. Every one of them is somebody else's characters.
  const html = notebookBodyHtml('I got stuck on <script>alert(1)</script> & the "quotes" around it');
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
  assert.match(html, /&quot;quotes&quot;/);
});

test('an ampersand in a link target survives as an ampersand', () => {
  const html = notebookBodyHtml('[a page](https://example.org/x?a=1&b=2)');
  assert.equal(html, '<p><a href="https://example.org/x?a=1&amp;b=2">a page</a></p>');
});

test('a link target that is not openable renders as its own words', () => {
  // `isOpenableUrl` is the same gate the engine used before it wrote the link,
  // so an address refused here is one that would not have been linked anyway.
  assert.equal(
    notebookBodyHtml('[press me](javascript:alert)'),
    '<p>press me</p>',
  );
  assert.equal(
    notebookBodyHtml('[press me](https://user:pw@example.org/)'),
    '<p>press me</p>',
  );
});

test('escaping is the four characters that change meaning and no more', () => {
  // An apostrophe is left alone on purpose: nothing here writes a
  // single-quoted attribute, and turning every one in a learner's note into an
  // entity makes the one document a person might open unreadable.
  assert.equal(escapeHtml(`don't & <b> "x"`), `don't &amp; &lt;b&gt; &quot;x&quot;`);
});

// ---------------------------------------------------- against the real generator

test('every construct the real generator emits has a rule here', () => {
  // The golden direction that matters: not "does the converter handle what I
  // thought of", but "is there anything the engine writes that comes out as
  // characters".
  for (const doc of notebookDocs(richBoard())) {
    const html = notebookBodyHtml(doc.body);
    for (const line of html.split('\n')) {
      assert.equal(/^#{1,6} /.test(line), false, `${doc.key} left a heading as text: ${line}`);
      assert.equal(/^- /.test(line), false, `${doc.key} left a bullet as text: ${line}`);
      assert.equal(/\[[^\]]*\]\(http/.test(line), false,
        `${doc.key} left a link as text: ${line}`);
    }
  }
});

test('the real documents come out as headings, lists and anchors', () => {
  const doc = docOf('on-the-board', richBoard());
  const html = notebookBodyHtml(doc.body);
  assert.ok(html.startsWith(`<h1>${escapeHtml(doc.title)}</h1>`),
    'the document opens on its own title, which is what a citation renders as');
  assert.match(html, /^<h1>Virgil: on the board<\/h1>\n<h2>How to use this source<\/h2>\n<ul>/,
    'the source-specific Notebook brief remains the first converted block');
  assert.match(html, /<li>Separate what the learner said or did from what Virgil inferred\.<\/li>/);
  assert.match(html, /<h2>Your courses<\/h2>/);
  assert.match(html, /<h3>A course<\/h3>/);
  assert.match(html, /<h4>Videos<\/h4>/);
  assert.match(html, /<ul>\n<li>/);
  assert.match(html, /<a href="https:\/\/example\.org\/lecture">A lecture<\/a>/);
  // The two-space continuation lines under a commitment bullet stay attached to
  // the bullet they were written under rather than becoming bullets of their own.
  assert.match(html, /<li>An assignment\..*<br>You told me you would do it on /s);
});

test('a saved page keeps its link to the page it came off', () => {
  const html = notebookBodyHtml(docOf('on-the-board', richBoard()).body);
  assert.match(html, /<a href="https:\/\/example\.org\/p1">/);
});

test('the whole file carries the learner-facing title and declares its encoding', () => {
  const doc = docOf('archive', richBoard());
  const file = notebookDocHtml(doc);
  assert.match(file, /^<!DOCTYPE html>/);
  assert.match(file, /<meta charset="utf-8">/);
  assert.ok(file.includes(`<title>${escapeHtml(doc.title)}</title>`),
    'the title is the learner\'s name for the document, and Drive shows it in a source list');
  assert.match(file, /<\/body><\/html>\n$/);
});

test('no styling, no class, no font, no image', () => {
  // §10.2 is a refusal rather than an unfinished job: appearance is Google's
  // converter's business, and anything asserted here would be a claim about
  // somebody else's renderer.
  const file = notebookDocHtml(docOf('on-the-board', richBoard()));
  for (const banned of [/<style/i, /class=/i, /<img/i, /<table/i, /style="(?!font-family)/i]) {
    assert.equal(banned.test(notebookBodyHtml(docOf('on-the-board', richBoard()).body)), false,
      `the converter emitted ${banned}`);
  }
  assert.equal(/<img|<table|<style/i.test(file), false);
});

test('the same document twice is the same bytes', () => {
  // The Drive adapter rewrites three documents every night. A file whose bytes
  // differ for no reason is a file Google re-ingests for no reason, for ever.
  const input = richBoard();
  assert.equal(notebookDocHtml(docOf('learn-now', input)), notebookDocHtml(docOf('learn-now', input)));
});
