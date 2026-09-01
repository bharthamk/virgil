import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOSED_COMMITMENT_DAYS, MAX_ARCHIVE_SUBJECTS, MAX_BOARD_TOPICS, MAX_LESSON_SOURCES,
  MAX_OUTCOMES, MAX_QUOTED_SELECTION, MAX_TOPIC_COVERED, MAX_TOPIC_SOURCES,
  OUTCOME_WINDOW_DAYS, SESSION_WINDOW, THIN_CERTAINTY,
  notebookDoc, notebookDocs, notebookDocTitle,
  type NotebookInput,
} from '../domain/notebook-docs.js';
import { NOTEBOOK_DOC_KEYS, type NotebookDoc, type NotebookDocKey } from '../ports/notebook-export.js';
import { hasBannedDash } from '../agents/house-style.js';
import type {
  Pin, Session, SessionSection, Signal, SignalType, Statement, Topic,
} from '../domain/types.js';
import type { Commitment } from '../domain/commitments.js';
import type { Course } from '../domain/courses.js';
import type { LearningOutcome } from '../domain/outcomes.js';

/**
 * NOTEBOOK_SEAM_V2.md §5 — what binds the three documents.
 *
 * These documents leave the product. They land in a learner's own Drive, they
 * are read by a system nobody here controls, and they are quoted back to the
 * learner in somebody else's voice. That is a longer chain than any other
 * learner-facing text in this repository, and it is the reason the house laws
 * are asserted here rather than trusted to the fact that they were written down
 * once in a file header.
 *
 * The tests worth having are the ones somebody would argue with. Nobody argues
 * that a heading should be a heading. What gets argued is whether a comfort
 * score could go in "just for the notebook", whether a document that is empty
 * should be written at all, whether a rolling window can quietly become
 * everything-since-the-beginning because nobody was counting, and — new with
 * the three — whether everything about one topic really has to sit under one
 * heading, given that all of it is in the document somewhere either way.
 *
 * It does. The reader on the other end retrieves a chunk. A fact three headings
 * away from the chunk is a fact it does not have.
 */

const DAY = 86_400_000;
const NOW = new Date('2026-08-24T03:00:00.000Z');
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();
const ahead = (days: number): string => new Date(NOW.getTime() + days * DAY).toISOString();

const topic = (id: string, over: Partial<Topic> = {}): Topic => ({
  id,
  label: `label of ${id}`,
  summary: `what ${id} is about`,
  pinIds: [],
  state: 'working',
  // A distinctive value, so a test can prove it never reaches a page.
  comfort: 0.6180339,
  lastExposedAt: ago(3),
  retiredByUser: false,
  createdAt: ago(40),
  ...over,
});

const comfort = (topicId: string, over: Partial<{
  regressed: boolean; certainty: number; evidenceCount: number;
}> = {}) => ({ topicId, regressed: false, certainty: 0.8, evidenceCount: 4, ...over });

const signal = (id: string, topicId: string, type: SignalType, over: Partial<Signal> = {}): Signal => ({
  id, topicId, type, direction: 'positive', at: ago(2),
  sourceEvent: `event:${id}`, invalidated: false, ...over,
});

const pin = (id: string, over: Partial<Pin> = {}): Pin => ({
  id,
  type: 'interest',
  envelope: {
    selection: `the passage behind ${id}`,
    parts: [],
    surroundingText: '',
    headingPath: ['Chapter one', 'A section'],
    pageTitle: `page title for ${id}`,
    url: `https://example.org/${id}`,
    canonicalUrl: null,
    siteName: 'Example',
    contentLanguage: 'en',
    media: null,
  },
  note: `why I kept ${id}`,
  capturedAt: ago(1),
  fromSuggestion: false,
  enrichment: null,
  topicId: null,
  ...over,
});

const section = (over: Partial<SessionSection> = {}): SessionSection => ({
  topicId: 't1',
  heading: 'A heading',
  body: 'The body of the section, written out in full.',
  depth: 'building',
  estimatedMinutes: 7,
  question: null,
  sourceIds: [],
  completed: false,
  ...over,
});

const session = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  builtAt: ago(1),
  fromPinCount: 6,
  targetMinutes: 15,
  estimatedMinutes: 14,
  sections: [section()],
  currentSectionIndex: 0,
  closingNote: null,
  ...over,
});

const commitment = (id: string, over: Partial<Commitment> = {}): Commitment => ({
  id,
  title: `commitment ${id}`,
  kind: 'assignment',
  courseId: null,
  topicIds: [],
  dueAt: ahead(3),
  plannedFor: null,
  estimateMinutes: null,
  notes: '',
  doneAt: null,
  createdAt: ago(10),
  ...over,
});

const course = (id: string, over: Partial<Course> = {}): Course => ({
  id,
  title: `course ${id}`,
  provider: 'Somewhere',
  url: `https://example.org/course/${id}`,
  material: [],
  topicIds: [],
  archivedAt: null,
  createdAt: ago(30),
  ...over,
});

const outcome = (id: string, over: Partial<LearningOutcome> = {}): LearningOutcome => ({
  id,
  kind: 'rubric',
  courseId: null,
  commitmentId: null,
  topicIds: [],
  title: `outcome ${id}`,
  score: null,
  maxScore: null,
  summary: '',
  feedback: '',
  criteria: [],
  source: null,
  recordedAt: ago(5),
  supersedesId: null,
  deletedAt: null,
  ...over,
});

const statement = (id: string, over: Partial<Statement> = {}): Statement => ({
  id, text: `a sentence about you, ${id}`, topicId: null,
  userEdited: false, evidenceSignalIds: [], updatedAt: ago(4), ...over,
});

const board = (over: Partial<NotebookInput> = {}): NotebookInput => ({
  now: NOW,
  topics: [], pins: [], signals: [], statements: [], courses: [],
  commitments: [], sessions: [], outcomes: [], comforts: [], reasons: [],
  ...over,
});

const bodyOf = (docs: readonly NotebookDoc[], key: NotebookDocKey): string =>
  docs.find((d) => d.key === key)?.body ?? '';

const doc = (input: NotebookInput, key: NotebookDocKey): string =>
  bodyOf(notebookDocs(input), key);

/** A topic the board reads as put down, which is what the archive is made of. */
const paused = (id: string, over: Partial<Topic> = {}): Topic =>
  topic(id, { retiredByUser: true, ...over });

/** What the document says under one topic's heading and before the next one at
 *  the same level. The adjacency claim is only checkable as a slice. */
function under(body: string, heading: string): string {
  const start = body.indexOf(`#### ${heading}\n`);
  if (start < 0) return '';
  const rest = body.slice(start + heading.length + 6);
  const next = rest.search(/^#{1,4} /m);
  return next < 0 ? rest : rest.slice(0, next);
}

// -------------------------------------------------------------- the set

test('the set is exactly the three keys the port publishes, in that order', () => {
  const docs = notebookDocs(board());
  assert.deepEqual(docs.map((d) => d.key), [...NOTEBOOK_DOC_KEYS],
    'the learner adds these once and I can never add a fourth for them afterwards');
  assert.deepEqual(docs.map((d) => d.title),
    ['Virgil: learn now', 'Virgil: on the board', 'Virgil: archive']);
});

test('every document is written even when the board is completely empty', () => {
  const docs = notebookDocs(board());
  assert.equal(docs.length, 3);
  for (const d of docs) {
    assert.ok(d.body.length > 0, `${d.key} was written as nothing`);
    // Skipping an empty document would leave the previously synced version in
    // place, correct-looking and silently out of date, which is the one failure
    // this seam has to be careful about.
    assert.ok(d.body.includes(d.title), `${d.key} lost its own title`);
  }
});

test('a new learner is told there is nothing, rather than shown empty scaffolding', () => {
  const docs = notebookDocs(board());
  assert.match(bodyOf(docs, 'learn-now'), /no lesson waiting for you/);
  assert.match(bodyOf(docs, 'on-the-board'), /nothing live on your board/);
  assert.match(bodyOf(docs, 'archive'), /nothing in here yet/);
});

test('a document asked for on its own is the same document as the one in the set', () => {
  const input = board({ topics: [topic('t1')], comforts: [comfort('t1')] });
  for (const key of NOTEBOOK_DOC_KEYS) {
    assert.deepEqual(notebookDoc(key, input), notebookDocs(input).find((d) => d.key === key));
    assert.equal(notebookDocTitle(key), notebookDoc(key, input).title);
  }
});

// -------------------------------------------------------------- determinism

test('the same board twice produces byte-identical documents', () => {
  // The Drive adapter rewrites these every night. A document whose bytes differ
  // for no reason is a document Google re-ingests for no reason, for ever.
  const input = board({
    topics: [topic('t2'), topic('t1'), paused('t3')],
    comforts: [comfort('t1'), comfort('t2'), comfort('t3')],
    signals: [signal('s1', 't1', 'answer-correct'), signal('s2', 't2', 'pin-struggle')],
    pins: [pin('p2', { topicId: 't2' }), pin('p1', { topicId: 't1' })],
    sessions: [session('sess1')],
    courses: [course('c2'), course('c1')],
    commitments: [commitment('m2'), commitment('m1')],
    outcomes: [outcome('o1')],
    statements: [statement('st1')],
    reasons: [{ topicId: 't1', reason: 'it has gone quiet' }],
  });
  assert.deepEqual(notebookDocs(input), notebookDocs(input));
});

test('the order rows arrive in does not change a single byte', () => {
  const one = board({
    topics: [topic('t1'), topic('t2'), paused('t3')],
    comforts: [comfort('t1'), comfort('t2'), comfort('t3')],
    pins: [pin('p1', { topicId: 't1' }), pin('p2', { topicId: 't2' })],
  });
  const other = board({
    topics: [paused('t3'), topic('t2'), topic('t1')],
    comforts: [comfort('t3'), comfort('t2'), comfort('t1')],
    pins: [pin('p2', { topicId: 't2' }), pin('p1', { topicId: 't1' })],
  });
  assert.deepEqual(notebookDocs(one), notebookDocs(other),
    'a store that returns rows in a different order must not rewrite every file');
});

test('nothing reads a wall clock: the date on the page is the injected one', () => {
  const docs = notebookDocs(board({ now: new Date('2019-03-04T10:00:00.000Z') }));
  for (const d of docs) assert.match(d.body, /I last rewrote it on 2019-03-04\./);
});

test('the rewrite date follows the learner day rather than the Cloud Run UTC day', () => {
  const docs = notebookDocs(board({
    now: new Date('2026-08-29T20:57:23.000Z'),
    timeZone: 'Australia/Sydney',
  }));
  for (const d of docs) assert.match(d.body, /I last rewrote it on 2026-08-30\./);
});

// ------------------------------------------------------------- house laws

test('no document carries a comfort number, a percentage, or a score of mine', () => {
  const docs = notebookDocs(board({
    topics: [topic('t1'), topic('t2', { state: 'settled', retiredByUser: true })],
    comforts: [comfort('t1', { certainty: 0.9123 }), comfort('t2')],
    signals: [signal('s1', 't1', 'answer-correct')],
  }));
  for (const d of docs) {
    // SB-33. The defence is structural first: `NotebookComfort` is not given
    // the number, so there is nowhere for one to come from. This is the check
    // that the structure was not quietly widened.
    assert.equal(d.body.includes('6180339'), false, `${d.key} printed a comfort value`);
    assert.equal(d.body.includes('9123'), false, `${d.key} printed a certainty value`);
    assert.equal(d.body.includes('%'), false, `${d.key} printed a percentage`);
  }
});

test('nothing counts anything: no points, no stars, no badges, no streaks', () => {
  // SB-18, and `commitments.ts`: points never write a signal and are not
  // evidence about learning. A notebook that can answer "how many points do I
  // have" is a scoreboard with a chat interface.
  const docs = notebookDocs(board({
    topics: [topic('t1'), paused('t2')],
    comforts: [comfort('t1'), comfort('t2')],
    commitments: [commitment('m1', { doneAt: ago(2) })],
    sessions: [session('sess1')],
  }));
  for (const d of docs) {
    for (const banned of [/\bpoints\b/i, /\bstars?\b/i, /\bbadges?\b/i, /\bstreaks?\b/i]) {
      assert.equal(banned.test(d.body), false, `${d.key} matched ${banned}`);
    }
  }
});

test('the dash rule reaches these documents, titles included', () => {
  const docs = notebookDocs(board({
    topics: [topic('t1'), paused('t2')], comforts: [comfort('t1'), comfort('t2')],
    courses: [course('c1', { material: [{
      id: 'x', title: 'a video', url: 'https://example.org/v', kind: 'video',
      minutes: 12, doneAt: null, pinIds: [], addedAt: ago(2),
    }] })],
    commitments: [commitment('m1', { plannedFor: ahead(1), topicIds: ['t1'] })],
    sessions: [session('sess1', {
      sections: [section({ sourceIds: ['p1:origin'], recap: 'the recap' })],
      withheld: [{ topicId: 't1', heading: 'h', reason: 'defective' }],
    })],
    outcomes: [outcome('o1', { topicIds: ['t1'], score: 14, maxScore: 20, criteria: [{
      criterionId: 'c', label: 'a criterion', score: null, maxScore: null,
      verdict: 'gap', feedback: 'not enough here', topicIds: ['t1'],
    }] })],
    pins: [pin('p1', { topicId: 't1' })],
    statements: [statement('st1')],
    reasons: [{ topicId: 't1', reason: 'it has gone quiet' }],
  }));
  // `house-style.ts`: "the one rule with no exceptions". The fixtures above
  // carry no dashes of their own, so anything found here is Virgil's.
  for (const d of docs) {
    assert.equal(hasBannedDash(d.title), false, `${d.key}'s title carries a banned dash`);
    assert.equal(hasBannedDash(d.body), false, `${d.key}'s body carries a banned dash`);
  }
});

/**
 * The preamble is the required operating brief and metadata.
 *
 * The reader on the other end needs both the document's purpose and its
 * authority boundary before it retrieves the learner material. The brief is
 * direct because this is the source Notebook is meant to use, but bounded so it
 * cannot turn Virgil's interpretations into learner facts.
 */
test('every document opens by saying what it is, who wrote it, and when', () => {
  for (const d of notebookDocs(board())) {
    assert.match(d.body, /^# /, `${d.key} does not open with its own name`);
    assert.match(d.body, /Virgil wrote this\./);
    assert.match(d.body, /I last rewrote it on \d{4}-\d{2}-\d{2}\./);
    assert.match(d.body, /This document holds/, `${d.key} never says what it is`);
    assert.match(d.body, /"I" means Virgil/);
    assert.match(d.body, /"You" means the person it is about/);
    assert.match(d.body, /anything you type into it will be replaced/);
  }
});

test('each document opens with a source-specific Notebook operating brief', () => {
  const expected: Readonly<Record<NotebookDocKey, readonly string[]>> = {
    'learn-now': [
      'Use this as the learner\'s current Virgil lesson.',
      'When there is a practice question, let the learner answer before you explain it.',
      'Do not infer that they read, understood, completed, or mastered anything unless this source says so.',
    ],
    'on-the-board': [
      'Use this to help the learner choose what to study and answer questions about their current work.',
      'Separate what the learner said or did from what Virgil inferred.',
      'Do not invent progress, ability, confidence, completion, or mastery.',
    ],
    archive: [
      'Use this to find and resume learning the learner previously paused or finished.',
      'Treat paused as put down, not failed, and learnt as prior evidence, not permanent mastery.',
      'If this source does not support an answer, say so instead of filling the gap.',
    ],
  };

  for (const doc of notebookDocs(board())) {
    assert.match(doc.body, /^# .+\n\n## How to use this source\n\n- /,
      `${doc.key} does not put its operating brief at the top`);
    for (const line of expected[doc.key]) assert.ok(doc.body.includes(`- ${line}`), line);
    assert.ok(
      doc.body.indexOf('## How to use this source') < doc.body.indexOf('Virgil wrote this.'),
      `${doc.key} puts metadata ahead of the operating brief`,
    );
  }
});

test('every document says how to tell it is behind, without claiming it is not', () => {
  for (const d of notebookDocs(board())) {
    assert.match(d.body, /looks older than the date above, refresh this source in your notebook/,
      `${d.key} left the reader no way to tell a stale answer from a fresh one`);
  }
});

test('nothing anywhere claims the notebook is up to date', () => {
  const docs = notebookDocs(board({ topics: [topic('t1')], comforts: [comfort('t1')] }));
  for (const d of docs) {
    for (const banned of [/up to date/i, /\bsynced\b/i, /\bintegrated\b/i, /\bconnected to\b/i]) {
      assert.equal(banned.test(d.body), false, `${d.key} claimed more than a rewrite`);
    }
  }
});

test('the three ruled-out phrases never reach a document', () => {
  // The vocabulary ruling. "Your saved pages" and "your sources" are the human
  // forms, and these documents are read aloud by another product, which is the
  // worst possible place for the machine words to survive.
  const docs = notebookDocs(board({
    topics: [topic('t1')], comforts: [comfort('t1')],
    pins: [pin('p1', { topicId: 't1' })],
    sessions: [session('s1', { sections: [section({ sourceIds: ['p1:origin'] })] })],
  }));
  for (const d of docs) {
    for (const banned of [/source-backed/i, /source-shaped/i, /the pinned material/i]) {
      assert.equal(banned.test(d.body), false, `${d.key} used ${banned}`);
    }
  }
});

test('the notebook keeps the no-punishment register the Plan room holds', () => {
  /*
   * The heading read "### Late" — the one word every Plan surface refuses, in
   * the loudest position a document has, inside the learner's own notebook.
   * `late` stays as the internal state name; nothing the learner reads uses it.
   */
  const body = doc(board({
    // A title with none of the words in it, so the sweep below is reading the
    // document's own voice rather than the fixture's.
    commitments: [commitment('l', { title: 'Stats problem set 3', dueAt: ago(4) })],
  }), 'on-the-board');
  assert.doesNotMatch(body, /\b(late|overdue|behind|missed)\b/i,
    'a learner who has missed a date is not told off by their own notebook');
  assert.match(body, /### Past their date/);
});

// -------------------------------------------- what may leave as a claim

test('a statement the learner rejected never travels into the handover', () => {
  const body = doc(board({
    topics: [topic('t1')], comforts: [comfort('t1')],
    statements: [
      statement('kept', { text: 'You reach for an example before a definition' }),
      statement('binned', { text: 'You never finish what you start', rejected: true }),
    ],
  }), 'on-the-board');
  assert.match(body, /You reach for an example before a definition/);
  assert.equal(body.includes('You never finish what you start'), false,
    'a rejected read is an evidence receipt, not a sentence about this person');
});

test('an unanswered modality question does not travel either', () => {
  // SB-282: a question is a question. This document goes to another tool under
  // the heading *what I have come to believe about how you learn*, and a
  // handover is exactly where an unconfirmed claim hardens into a fact.
  const body = doc(board({
    statements: [statement('ask', {
      text: 'Do you take these in better by watching than by reading?',
      modality: {
        key: 'slower|faster',
        slower: 'notation-heavy',
        faster: 'language-recall',
        askedAt: ago(1),
        confirmedAt: null,
      },
    })],
  }), 'on-the-board');
  assert.equal(body.includes('Do you take these in better'), false);
});

// ================================================================ learn now

const lessonBoard = (over: Partial<NotebookInput> = {}): NotebookInput => board({
  topics: [topic('t1', { label: 'Idempotent handlers' })],
  comforts: [comfort('t1')],
  pins: [pin('p1', { topicId: 't1' })],
  sessions: [session('s1', {
    batchKey: '2026-08-23',
    sections: [section({
      heading: 'Why a handler has to be safe to run twice',
      depth: 'from-nothing',
      summary: 'What happens when the same message arrives twice',
      sourceIds: ['p1:origin'],
      why: 'an assignment on Friday leans on it',
    })],
  })],
  ...over,
});

test('learn now is the lesson the store says you are on, with where it sits', () => {
  const body = doc(lessonBoard(), 'learn-now');
  assert.match(body, /### Why a handler has to be safe to run twice/);
  assert.match(body, /This is about: Idempotent handlers\./);
  assert.match(body, /Where it sits on your board: Currently Learning\./);
  // SB-283: the panel's own word for this register, so the two documents a
  // learner reads about one board cannot name it two different things.
  assert.match(body, /I wrote it as new to you, assuming no background\./);
  assert.match(body, /About 7 minutes\./);
  assert.match(body, /Why I chose it: an assignment on Friday leans on it/);
  assert.match(body, /The body of the section, written out in full\./);
});

test('learn now says what the practice asks, and never how it is marked', () => {
  const body = doc(lessonBoard({
    sessions: [session('s1', {
      sections: [section({
        question: {
          kind: 'recall',
          prompt: 'Why can the same message be delivered twice?',
          expectedPoints: ['At-least-once delivery means the ack can be lost after the work.'],
        },
      })],
    })],
  }), 'learn-now');
  assert.match(body, /Why can the same message be delivered twice\?/);
  assert.match(body, /answer it from memory before you go looking/);
  // The mark scheme is the list an answer is checked against. Handing it to
  // somebody through their own notebook is not teaching them, and it makes
  // every answer signal after it worthless as evidence.
  assert.equal(body.includes('At-least-once delivery'), false,
    'the marking scheme travelled into the learner’s notebook');
});

test('a lesson with nothing to answer says so rather than leaving a gap', () => {
  const body = doc(lessonBoard(), 'learn-now');
  assert.match(body, /There is nothing to answer in this one/);
});

test('learn now carries the pages the lesson was built from', () => {
  const body = doc(lessonBoard(), 'learn-now');
  assert.match(body, /## Where this lesson came from/);
  assert.match(body, /### page title for p1/);
  assert.match(body, /You saved this because it interested you\./);
  assert.match(body, /\[https:\/\/example\.org\/p1\]\(https:\/\/example\.org\/p1\)/);
});

test('a page I went and found is not described as one you saved', () => {
  const body = doc(lessonBoard({
    pins: [pin('p1', {
      topicId: 't1',
      enrichment: {
        assumedConcepts: [], outcome: 'enriched', confidence: 'full', enrichedAt: ago(1),
        refetchedText: null, mediaDescription: null,
        references: [{
          id: 'p1:ref-1', origin: 'agent-sourced', url: 'https://example.org/found',
          title: 'A page I went and found', retrievedAt: ago(1), pinId: 'p1',
        }],
      },
    })],
    sessions: [session('s1', { sections: [section({ sourceIds: ['p1:ref-1'] })] })],
  }), 'learn-now');
  assert.match(body, /### A page I went and found/);
  assert.match(body, /I went and found this one while I was reading around what you saved\./);
  assert.equal(body.includes('You saved this because'), false,
    'a page the Forager fetched is not the learner’s own saved page');
});

test('the lesson source cap holds', () => {
  const pins = Array.from({ length: MAX_LESSON_SOURCES + 6 }, (_, i) =>
    pin(`p${i}`, { topicId: 't1', capturedAt: ago(i) }));
  const body = doc(lessonBoard({
    pins,
    sessions: [session('s1', {
      sections: [section({ sourceIds: pins.map((p) => `${p.id}:origin`) })],
    })],
  }), 'learn-now');
  assert.equal([...body.matchAll(/^### page title for /gm)].length, MAX_LESSON_SOURCES);
});

test('a lesson traced back to nothing says so, because that is worth knowing', () => {
  const body = doc(lessonBoard({
    sessions: [session('s1', { sections: [section({ sourceIds: [] })] })],
  }), 'learn-now');
  assert.match(body, /could not trace this one back to a page you saved/);
});

test('a finished session says it is finished rather than showing the last lesson again', () => {
  const body = doc(lessonBoard({
    sessions: [session('s1', {
      sections: [section({ heading: 'The one you already did', completed: true })],
      // What the service writes when the last section closes.
      currentSectionIndex: 1,
    })],
  }), 'learn-now');
  assert.match(body, /## You are at the end of this session/);
  assert.equal(body.includes('## The lesson in front of you'), false);
});

test('what comes after this lesson is listed, and capped', () => {
  const sections = Array.from({ length: 14 }, (_, i) => section({
    heading: `section ${i}`, topicId: 't1',
  }));
  const body = doc(lessonBoard({
    sessions: [session('s1', { sections })],
  }), 'learn-now');
  assert.match(body, /## What comes after it in this session/);
  assert.match(body, /section 1\. About Idempotent handlers/);
  assert.equal(body.includes('section 13'), false, 'the lineup cap did not hold');
});

test('what the check refused is published rather than quietly dropped', () => {
  const body = doc(lessonBoard({
    sessions: [session('s1', {
      sections: [section()],
      withheld: [
        { topicId: 't1', heading: 'the defective one', reason: 'defective' },
        { topicId: 't1', heading: 'the unchecked one', reason: 'unverified' },
      ],
    })],
  }), 'learn-now');
  assert.match(body, /### What I held back/);
  assert.match(body, /my own check found a real problem with it/);
  assert.match(body, /my check could not run on it at all/);
  assert.match(body, /That is not the same as it being wrong/);
});

/**
 * THE RECORDED DIVERGENCE, and the pairing it was fixed by.
 *
 * `runner/src/notebook-export.ts` recomputes `tend()` at export time, which is
 * the right read for a document about the board as it stands now and the wrong
 * one for a document about a night that has already happened. Under the learner-controlled lineup contract,
 * a session carries each section's own `why`, written by the run that ranked it,
 * and `GET /session` reads `sec.why ?? reasons.get(sec.topicId)`. Without the
 * same precedence here, an on-demand export three days later quotes whatever the
 * Gardener would say about that topic *today* — honest, different, and stated to
 * the learner by a chat assistant with every appearance of authority.
 *
 * The runner half of this pairing walks the real endpoint and the real export
 * over one board (`notebook-seam.test.ts`). This half is the rule.
 */
test('the lesson quotes the reason the run recorded, not the reason today would give', () => {
  const body = doc(lessonBoard({
    // The board has moved on. This is what tonight would say about t1 now.
    reasons: [{ topicId: 't1', reason: 'three days of new evidence later' }],
  }), 'learn-now');
  assert.match(body, /Why I chose it: an assignment on Friday leans on it/);
  assert.equal(body.includes('three days of new evidence later'), false,
    'the notebook and the panel just told two different stories about one night');
});

test('a session composed before the field existed falls back to the same read the panel does', () => {
  const body = doc(lessonBoard({
    sessions: [session('s1', { sections: [section()] })],
    reasons: [{ topicId: 't1', reason: 'it has gone quiet' }],
  }), 'learn-now');
  assert.match(body, /Why I chose it: it has gone quiet/);
});

test('with no reason on either side the line is absent rather than empty', () => {
  const body = doc(lessonBoard({
    sessions: [session('s1', { sections: [section()] })],
  }), 'learn-now');
  assert.equal(body.includes('Why I chose it:'), false,
    'a label with nothing after it is a line whose whole content is an absence');
});

test('a session says when it was built and from how many things you saved', () => {
  // SB-18: the background work has to be legible or it may as well not have
  // happened. This is the one count these documents are allowed.
  const body = doc(lessonBoard(), 'learn-now');
  assert.match(body, /Built on 2026-08-23, from 6 things you saved\./);
});

test('one saved thing reads as one thing, not as 1 things', () => {
  const body = doc(lessonBoard({
    sessions: [session('s1', { fromPinCount: 1 })],
  }), 'learn-now');
  assert.match(body, /from 1 thing you saved\./);
});

test('a section the learner contested says so', () => {
  const body = doc(lessonBoard({
    sessions: [session('s1', { sections: [section({ contested: true })] })],
  }), 'learn-now');
  assert.match(body, /Nothing here counts against you/);
});

// ============================================================ on the board

/**
 * THE ADJACENCY CLAIM, which is the whole reason there are three documents.
 *
 * A learner asks their notebook which topic to work on. The reader retrieves a
 * chunk. If a topic's area is under one heading, its evidence under another,
 * its results in a second document and its deadlines in a third, the retrieved
 * chunk has one of the four facts and answers from that. So the test is not
 * that all four facts are in the document somewhere; it is that all four are
 * **between this topic's heading and the next one**.
 */
test('everything about one topic sits under that topic and before the next', () => {
  const body = doc(board({
    topics: [topic('t1', { label: 'Idempotent handlers' }), topic('t2', { label: 'Retry budgets' })],
    comforts: [comfort('t1'), comfort('t2')],
    signals: [signal('s1', 't1', 'answer-correct'), signal('s2', 't1', 'pin-struggle')],
    pins: [pin('p1', { topicId: 't1' })],
    outcomes: [outcome('o1', { title: 'Systems paper 2', topicIds: ['t1'], score: 14, maxScore: 20 })],
    commitments: [commitment('m1', { title: 'Systems problem set', topicIds: ['t1'] })],
    reasons: [{ topicId: 't1', reason: 'an assignment on Friday leans on it' }],
    sessions: [session('s1', {
      batchKey: '2026-08-22',
      sections: [section({ topicId: 't1', recap: 'How an ack can be lost after the work' })],
    })],
    courses: [course('c1', { title: 'Distributed Systems' })],
  }), 'on-the-board');

  const slice = under(body, 'Idempotent handlers');
  assert.ok(slice, 'the topic never got a heading of its own');
  for (const [what, pattern] of [
    ['where it sits', /You are working on this and it has not gone solid yet\./],
    ['what I am going by', /What I am going by: answers you have given me and things you saved because they were hard\./],
    ['why it is up', /Why it is in front of you: an assignment on Friday leans on it/],
    ['what was covered', /How an ack can be lost after the work/],
    ['what the results said', /Systems paper 2\..*The mark you were given: 14 out of 20\./],
    ['what is coming up', /Systems problem set\. This is an assignment, due on /],
    ['the saved pages', /page title for p1/],
  ] as const) {
    assert.match(slice, pattern, `${what} is not under this topic's own heading`);
  }
  // And the neighbour's facts are not in this topic's slice.
  assert.equal(slice.includes('Retry budgets'), false);
});

test('a topic linked to a course through its dated work says which course', () => {
  const body = doc(board({
    topics: [topic('t1')], comforts: [comfort('t1')],
    courses: [course('c1', { title: 'Distributed Systems' })],
    commitments: [commitment('m1', { courseId: 'c1', topicIds: ['t1'] })],
  }), 'on-the-board');
  assert.match(under(body, 'label of t1'), /Part of: Distributed Systems\./);
});

test('the board document holds the live areas and the archive holds the rest', () => {
  const input = board({
    topics: [
      topic('a', { state: 'waiting', label: 'the waiting one' }),
      topic('b', { state: 'working', label: 'the working one' }),
      topic('c', { state: 'settled', retiredByUser: true, label: 'the paused one' }),
      topic('d', { state: 'settled', lastExposedAt: null, label: 'the learnt one' }),
    ],
    comforts: ['a', 'b', 'c', 'd'].map((id) => comfort(id)),
  });
  const live = doc(input, 'on-the-board');
  const archive = doc(input, 'archive');

  for (const heading of ['Get Started', 'Currently Learning']) {
    assert.match(live, new RegExp(`### ${heading}`), `${heading} is missing from the board`);
  }
  assert.match(live, /the waiting one/);
  assert.match(live, /the working one/);
  assert.equal(live.includes('the paused one'), false, 'a topic put down is not a live topic');
  assert.equal(live.includes('the learnt one'), false);

  assert.match(archive, /## Paused/);
  assert.match(archive, /## Learnt/);
  assert.match(archive, /the paused one/);
  assert.match(archive, /the learnt one/);
  assert.equal(archive.includes('the working one'), false,
    'a topic in front of the learner is not something to pick back up');
});

test('the learner model leads the board document, and an edited line says so', () => {
  const body = doc(board({
    topics: [topic('t1')], comforts: [comfort('t1')],
    statements: [
      statement('a', { text: 'You reach for an example before a definition', updatedAt: ago(1) }),
      statement('b', { text: 'You said this one better yourself', userEdited: true, topicId: 't1', updatedAt: ago(2) }),
    ],
  }), 'on-the-board');
  assert.ok(body.indexOf('You reach for an example') < body.indexOf('### Currently Learning'),
    'the highest value paragraphs in the set belong where a retrieval finds them first');
  assert.match(body, /You rewrote this one yourself/);
  assert.match(body, /\(about label of t1\)/);
});

test('with nothing to say about the learner, I say nothing rather than guess', () => {
  const body = doc(board({ topics: [topic('t1')], comforts: [comfort('t1')] }), 'on-the-board');
  assert.match(body, /I would rather say nothing than guess/);
});

test('evidence is described as kinds and never tallied into a score', () => {
  const body = doc(board({
    topics: [topic('t1')],
    comforts: [comfort('t1')],
    signals: [
      signal('s1', 't1', 'answer-correct'),
      signal('s2', 't1', 'answer-wrong', { direction: 'negative' }),
      signal('s3', 't1', 'pin-struggle'),
    ],
  }), 'on-the-board');
  assert.match(body, /What I am going by: /);
  assert.match(body, /answers you have given me/);
  assert.match(body, /things you saved because they were hard/);
  // "two right and one wrong" is a score with the word score taken out.
  assert.equal(/\b\d+ (?:right|wrong|correct)\b/.test(body), false);
});

test('a signal the learner withdrew is not described as evidence', () => {
  const body = doc(board({
    topics: [topic('t1')],
    comforts: [comfort('t1')],
    signals: [signal('s1', 't1', 'guide-stuck', { invalidated: true })],
  }), 'on-the-board');
  assert.equal(body.includes('a step you told me you were stuck on'), false,
    'SB-45: a conceded error withdraws what was read into it, here as well as in the ledger');
});

test('a topic with no evidence says so plainly instead of sounding sure', () => {
  const body = doc(board({
    topics: [topic('t1', { state: 'waiting' })],
    comforts: [comfort('t1', { evidenceCount: 0, certainty: 0 })],
  }), 'on-the-board');
  assert.match(body, /nothing to go on here/);
  assert.match(body, /treat anything I say about it as a guess/);
});

test('a thin reading is marked as thin rather than hedged into sounding confident', () => {
  const body = doc(board({
    topics: [topic('t1')],
    comforts: [comfort('t1', { evidenceCount: 1, certainty: THIN_CERTAINTY - 0.1 })],
    signals: [signal('s1', 't1', 'pin-struggle')],
  }), 'on-the-board');
  assert.match(body, /very little to go on here, so take this one lightly/);
});

test('a regression is named, because that is why it is back in front of them', () => {
  const body = doc(board({
    topics: [topic('t1')],
    comforts: [comfort('t1', { regressed: true })],
  }), 'on-the-board');
  assert.match(body, /had settled, and something recent has undercut it/);
});

test('a topic id never reaches a learner, even when the topic is gone', () => {
  const body = doc(board({
    commitments: [commitment('m1', { topicIds: ['a-topic-that-was-deleted'] })],
  }), 'on-the-board');
  assert.equal(body.includes('a-topic-that-was-deleted'), false);
  assert.match(body, /something no longer on your board/);
});

// --------------------------------------------------------------- retention

test('the board cap holds, keeps the newest touched, and says that it bit', () => {
  const topics = Array.from({ length: MAX_BOARD_TOPICS + 5 }, (_, i) =>
    topic(`t${i}`, { label: `topic number ${i}`, lastExposedAt: ago(i) }));
  const body = doc(board({
    topics, comforts: topics.map((t) => comfort(t.id)),
  }), 'on-the-board');
  assert.equal([...body.matchAll(/^#### topic number /gm)].length, MAX_BOARD_TOPICS);
  assert.match(body, new RegExp(`You have ${MAX_BOARD_TOPICS + 5} of these`),
    'a truncation nobody is told about is a document disagreeing with the board');
  assert.match(body, /#### topic number 0\b/, 'the most recently touched was dropped');
});

test('the archive cap holds and says so too', () => {
  const topics = Array.from({ length: MAX_ARCHIVE_SUBJECTS + 3 }, (_, i) =>
    paused(`t${i}`, { label: `subject number ${i}`, lastExposedAt: ago(i) }));
  const body = doc(board({
    topics, comforts: topics.map((t) => comfort(t.id)),
  }), 'archive');
  assert.equal([...body.matchAll(/^### subject number /gm)].length, MAX_ARCHIVE_SUBJECTS);
  assert.match(body, new RegExp(`You have ${MAX_ARCHIVE_SUBJECTS + 3} of these`));
});

test('the per-topic source cap holds', () => {
  const pins = Array.from({ length: MAX_TOPIC_SOURCES + 6 }, (_, i) =>
    pin(`p${i}`, { topicId: 't1', capturedAt: ago(i) }));
  const body = doc(board({
    topics: [topic('t1')], comforts: [comfort('t1')], pins,
  }), 'on-the-board');
  assert.equal([...body.matchAll(/^##### page title for /gm)].length, MAX_TOPIC_SOURCES);
  assert.match(body, /page title for p0/, 'the newest saved page was dropped');
});

test('the covered window keeps the recent sessions and the cap holds', () => {
  const sessions = Array.from({ length: SESSION_WINDOW + 3 }, (_, i) => session(`s${i}`, {
    builtAt: ago(i),
    sections: [section({ topicId: 't1', recap: `the recap of session ${i}` })],
  }));
  const body = doc(board({
    topics: [topic('t1')], comforts: [comfort('t1')], sessions,
  }), 'on-the-board');
  assert.match(body, /the recap of session 0/);
  assert.equal([...body.matchAll(/the recap of session /g)].length, MAX_TOPIC_COVERED,
    'the per-topic covered cap did not hold');
  assert.equal(body.includes('the recap of session 12'), false, 'the session window did not hold');
});

test('a section with no recap falls back to its heading rather than to nothing', () => {
  const body = doc(board({
    topics: [topic('t1')], comforts: [comfort('t1')],
    sessions: [session('s1', { sections: [section({ heading: 'the older heading' })] })],
  }), 'on-the-board');
  assert.match(under(body, 'label of t1'), /the older heading/);
});

test('a commitment closed inside the window stays and an older one falls off', () => {
  const body = doc(board({
    commitments: [
      commitment('recent', { title: 'closed recently', doneAt: ago(CLOSED_COMMITMENT_DAYS - 1) }),
      commitment('old', { title: 'closed ages ago', doneAt: ago(CLOSED_COMMITMENT_DAYS + 1) }),
    ],
  }), 'on-the-board');
  assert.match(body, /closed recently/);
  assert.equal(body.includes('closed ages ago'), false);
});

test('obligations are grouped by where they stand, the past-their-date ones first', () => {
  const body = doc(board({
    commitments: [
      commitment('l', { title: 'the late one', dueAt: ago(4) }),
      commitment('t', { title: 'the one due today', dueAt: NOW.toISOString() }),
      commitment('s', { title: 'the soon one', dueAt: ahead(2) }),
      commitment('f', { title: 'the far one', dueAt: ahead(60) }),
    ],
  }), 'on-the-board');
  assert.ok(body.indexOf('### Past their date') < body.indexOf('### Due today'));
  assert.ok(body.indexOf('### Due today') < body.indexOf('### Due soon'));
  assert.ok(body.indexOf('### Due soon') < body.indexOf('### Later'));
});

test('the outcome window and the cap both hold', () => {
  const inWindow = Array.from({ length: MAX_OUTCOMES + 5 }, (_, i) =>
    outcome(`recent${i}`, { title: `recent outcome ${i}`, recordedAt: ago(i) }));
  const body = doc(board({
    outcomes: [
      ...inWindow,
      outcome('ancient', { title: 'an ancient result', recordedAt: ago(OUTCOME_WINDOW_DAYS + 1) }),
    ],
  }), 'on-the-board');
  assert.equal(body.includes('an ancient result'), false, 'the window did not hold');
  const shown = [...body.matchAll(/^### recent outcome /gm)].length;
  assert.equal(shown, MAX_OUTCOMES, 'the cap did not hold');
});

test('a corrected result is replaced rather than shown twice', () => {
  const body = doc(board({
    outcomes: [
      outcome('first', { title: 'the first attempt at recording it', recordedAt: ago(9) }),
      outcome('fix', { title: 'the corrected record', recordedAt: ago(2), supersedesId: 'first' }),
    ],
  }), 'on-the-board');
  assert.equal(body.includes('the first attempt at recording it'), false);
  assert.match(body, /the corrected record/);
  // Silently dropping it would let the notebook answer about a corrected mark
  // as though the correction had never happened.
  assert.match(body, /replaced an earlier record of the same work/);
});

test('a deleted result is gone', () => {
  const body = doc(board({
    outcomes: [outcome('gone', { title: 'a deleted result', deletedAt: ago(1) })],
  }), 'on-the-board');
  assert.equal(body.includes('a deleted result'), false);
});

test('a long selection is quoted rather than reproduced whole', () => {
  const long = 'x'.repeat(MAX_QUOTED_SELECTION + 200);
  const body = doc(board({
    pins: [pin('p1', { envelope: { ...pin('p1').envelope, selection: long } })],
  }), 'on-the-board');
  assert.equal(body.includes(long), false);
  assert.match(body, new RegExp(`x{${MAX_QUOTED_SELECTION}}\\.\\.\\.`));
});

// -------------------------------------------------------------- deep links

test('a video pin links back to the moment, and a paper to the page', () => {
  const body = doc(board({
    pins: [
      pin('vid', {
        envelope: {
          ...pin('vid').envelope,
          url: 'https://www.youtube.com/watch?v=abc123',
          videoMoment: { timestampSeconds: 90, player: 'youtube' },
        },
      }),
      pin('paper', {
        envelope: {
          ...pin('paper').envelope,
          url: 'https://example.org/paper.pdf',
          pdfPage: 4,
        },
      }),
    ],
  }), 'on-the-board');
  assert.match(body, /\[the exact place\]\(https:\/\/www\.youtube\.com\/watch\?v=abc123&t=90s\)/);
  assert.match(body, /\[the exact place\]\(https:\/\/example\.org\/paper\.pdf#page=4\)/);
});

test('a page with no real seek convention gets the page and never a guessed fragment', () => {
  const body = doc(board({
    pins: [pin('v', {
      envelope: {
        ...pin('v').envelope,
        url: 'https://vimeo.com/12345',
        videoMoment: { timestampSeconds: 90, player: 'html5' },
      },
    })],
  }), 'on-the-board');
  assert.equal(body.includes('the exact place'), false);
  assert.match(body, /\[https:\/\/vimeo\.com\/12345\]\(https:\/\/vimeo\.com\/12345\)/);
});

test('a link a browser would refuse is not offered as a link', () => {
  const body = doc(board({
    pins: [pin('bad', {
      envelope: { ...pin('bad').envelope, url: 'javascript:alert(1)' },
    })],
  }), 'on-the-board');
  assert.equal(body.includes('javascript:'), false,
    'a course or a page can be created from pasted text, and this is where that reaches a link');
});

test('a saved page with no topic is named as unfiled rather than dropped', () => {
  const body = doc(board({
    topics: [topic('t1')], comforts: [comfort('t1')],
    pins: [pin('loose'), pin('filed', { topicId: 't1' })],
  }), 'on-the-board');
  assert.match(body, /## Saved pages I have not filed under a topic yet/);
  assert.match(body, /page title for loose/);
});

// -------------------------------------------------- what the results say

test('the mark somebody else gave is reported exactly, and never averaged', () => {
  const body = doc(board({
    topics: [topic('t1')], comforts: [comfort('t1')],
    outcomes: [
      outcome('o1', { score: 14, maxScore: 20, recordedAt: ago(3) }),
      outcome('o2', { score: 6, maxScore: 20, recordedAt: ago(2) }),
    ],
  }), 'on-the-board');
  assert.match(body, /The mark you were given: 14 out of 20\./);
  assert.match(body, /The mark you were given: 6 out of 20\./);
  assert.match(body, /I never average them/);
  assert.equal(body.includes('out of 40'), false, 'a total was invented from two marks');
});

test('a criterion is a sentence, with the topics it touches named', () => {
  const body = doc(board({
    topics: [topic('t1', { retiredByUser: true })], comforts: [comfort('t1')],
    outcomes: [outcome('o1', {
      criteria: [
        { criterionId: 'a', label: 'Argument', score: null, maxScore: null, verdict: 'gap', feedback: 'the case is not made', topicIds: ['t1'] },
        { criterionId: 'b', label: 'Evidence', score: 3, maxScore: 4, verdict: 'strong', feedback: 'well sourced', topicIds: [] },
        { criterionId: 'c', label: 'Structure', score: null, maxScore: null, verdict: null, feedback: '', topicIds: [] },
      ],
    })],
  }), 'on-the-board');
  assert.match(body, /- Argument\. This was a gap\./);
  assert.match(body, /the case is not made/);
  assert.match(body, /- Evidence\. You were strong on this\./);
  assert.match(body, /Marked 3 out of 4\./);
  assert.match(body, /- Structure\. Nobody put a verdict on this one\./);
  assert.match(body, /On your board this touches: label of t1\./);
});

test('a self assessment is kept and is not allowed to move anything', () => {
  const body = doc(board({
    outcomes: [outcome('o1', { kind: 'self-assessment', score: 19, maxScore: 20 })],
  }), 'on-the-board');
  assert.match(body, /I do not treat it as marked evidence, so it does not move anything/);
});

test('what a result changed on the board is stated, in the ledger’s own direction', () => {
  const body = doc(board({
    outcomes: [outcome('o1', {
      criteria: [
        { criterionId: 'a', label: 'A', score: null, maxScore: null, verdict: 'gap', feedback: '', topicIds: ['t1'] },
        { criterionId: 'b', label: 'B', score: null, maxScore: null, verdict: 'strong', feedback: '', topicIds: ['t2'] },
      ],
    })],
  }), 'on-the-board');
  assert.match(body, /I recorded this as a gap\./);
  assert.match(body, /I recorded this as strong evidence\./);
});

test('a result attached to a live topic is not repeated in the leftovers', () => {
  const body = doc(board({
    topics: [topic('t1')], comforts: [comfort('t1')],
    outcomes: [outcome('o1', { title: 'Systems paper 2', topicIds: ['t1'] })],
  }), 'on-the-board');
  assert.equal(body.includes('## Other results you recorded'), false,
    'a result that already sits with its topic does not need a second home');
});

// -------------------------------------------------------- what you are on

test('course progress is two counts and never one number', () => {
  const body = doc(board({
    topics: [topic('t1', { state: 'settled' }), topic('t2')],
    comforts: [comfort('t1'), comfort('t2')],
    courses: [course('c1', {
      topicIds: ['t1', 't2'],
      material: [
        { id: 'm1', title: 'first video', url: 'https://example.org/a', kind: 'video', minutes: 10, doneAt: ago(2), pinIds: [], addedAt: ago(9) },
        { id: 'm2', title: 'a reading', url: 'https://example.org/b', kind: 'reading', minutes: null, doneAt: null, pinIds: [], addedAt: ago(8) },
        { id: 'm3', title: 'second video', url: 'https://example.org/c', kind: 'video', minutes: null, doneAt: null, pinIds: [], addedAt: ago(7) },
      ],
    })],
  }), 'on-the-board');
  assert.match(body, /Material you have marked done: 1 of 3\./);
  assert.match(body, /the board calls learnt: 1 of 2\./);
  assert.match(body, /#### Videos/);
  assert.match(body, /#### Readings/);
  assert.match(body, /\[first video\]\(https:\/\/example\.org\/a\)\. About 10 minutes\. You marked this done on /);
  assert.match(body, /\[a reading\]\(https:\/\/example\.org\/b\)\. You have not marked this done\./);
  assert.equal(body.includes('#### Classes'), false, 'an empty group was rendered');
});

test('an archived course is not on the page', () => {
  const body = doc(board({
    courses: [course('c1', { title: 'the archived one', archivedAt: ago(1) })],
  }), 'on-the-board');
  assert.equal(body.includes('the archived one'), false);
});

test('a course with no provider says nothing about a provider', () => {
  // "Where it is from: you did not say." reads as a small reproach for leaving
  // an optional field empty. The line is omitted instead.
  const withNone = doc(board({
    courses: [course('c1', { title: 'Short story writing', provider: '' })],
  }), 'on-the-board');
  assert.equal(withNone.includes('Where it is from'), false);
  assert.equal(withNone.includes('you did not say'), false);

  const withOne = doc(board({
    courses: [course('c2', { title: 'Short story writing', provider: 'NCW' })],
  }), 'on-the-board');
  assert.match(withOne, /Where it is from: NCW\./);
});

// ================================================================= archive

test('the archive says what was covered, when it was last touched, and where it landed', () => {
  const body = doc(board({
    topics: [paused('t1', { label: 'Short story openings', lastExposedAt: ago(90) })],
    comforts: [comfort('t1')],
    sessions: [session('s1', {
      batchKey: '2026-05-20',
      sections: [section({ topicId: 't1', recap: 'How an opening earns the second sentence' })],
    })],
    outcomes: [outcome('o1', {
      title: 'Workshop piece 1', topicIds: ['t1'], score: 68, maxScore: 100, recordedAt: ago(80),
    })],
  }), 'archive');
  assert.match(body, /### Short story openings/);
  assert.match(body, /You last touched this on 2026-05-26\./);
  assert.match(body, /What was covered:/);
  assert.match(body, /How an opening earns the second sentence/);
  assert.match(body, /Where it landed:/);
  assert.match(body, /Workshop piece 1\..*The mark you were given: 68 out of 100\./);
});

test('a subject nobody ever marked says so rather than implying a verdict', () => {
  const body = doc(board({
    topics: [paused('t1')], comforts: [comfort('t1')],
  }), 'archive');
  assert.match(body, /Nothing was ever marked on this one/);
  assert.match(body, /my own reading of it rather than a mark anybody gave you/);
});

test('a paused subject is told how to come back to it', () => {
  const body = doc(board({
    topics: [paused('t1')], comforts: [comfort('t1')],
  }), 'archive');
  assert.match(body, /take it off pause in Virgil and I will start planning it again/);
});

test('a learnt subject is not offered an un-pause it does not need', () => {
  const body = doc(board({
    topics: [topic('t1', { state: 'settled', lastExposedAt: null })], comforts: [comfort('t1')],
  }), 'archive');
  assert.match(body, /## Learnt/);
  assert.equal(body.includes('take it off pause'), false);
});

test('the archive names its pages and leaves the reading to the board document', () => {
  const body = doc(board({
    topics: [paused('t1')], comforts: [comfort('t1')],
    pins: [pin('p1', { topicId: 't1' })],
  }), 'archive');
  assert.match(body, /\[page title for p1\]\(https:\/\/example\.org\/p1\)\. Saved on /);
  assert.equal(body.includes('the passage behind p1'), false,
    'a subject somebody put down six months ago does not need its passages reproduced');
});

test('a subject the learner removed is in neither document, because it is not on the board', () => {
  // Removal is a delete (SB-43) and a deleted topic is not in the store's rows
  // at all, so the archive's promise is kept by the board it is built from
  // rather than by a filter here. This is the check that nothing invented a
  // second source of topics.
  const input = board({
    topics: [paused('kept', { label: 'the one still there' })],
    comforts: [comfort('kept')],
    // The removed topic survives only as a reference on other rows.
    commitments: [commitment('m1', { topicIds: ['ghost-subject'] })],
    signals: [signal('s1', 'ghost-subject', 'answer-correct')],
  });
  for (const key of NOTEBOOK_DOC_KEYS) {
    assert.equal(notebookDoc(key, input).body.includes('ghost-subject'), false,
      `${key} resurrected a subject the learner removed`);
  }
});
