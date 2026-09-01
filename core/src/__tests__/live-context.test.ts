import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MATCH_MATERIAL, TOPIC_DOC_PINS, matchTopics, resolveContext, topicDocument,
} from '../domain/live-context.js';
import { registerFor } from '../domain/registers.js';
import { thresholdFor } from '../domain/clustering.js';
import type { Pin, Topic } from '../domain/types.js';

/**
 * The active path does not wait for the batch.
 *
 * `Pin.topicId` is written only
 * by the nightly Clusterer, every foreground route keyed its comfort read on
 * it, and `registerFor(undefined)` is `from-nothing` — so a learner with a
 * mature topic on a subject was taught it as a beginner every time they pinned
 * something new about it, until a batch ran. Foreground learning must resolve
 * context without waiting for that batch.
 */

const pin = (id: string, text: string, over: Partial<Pin> = {}): Pin => ({
  id,
  type: 'interest',
  envelope: {
    url: `https://example.com/${id}`,
    canonicalUrl: `https://example.com/${id}`,
    pageTitle: 'A page',
    siteName: 'example.com',
    documentKind: 'html',
    contentLanguage: 'en',
    headingPath: [],
    selection: text,
    surroundingText: text,
    parts: [{ role: 'passage', text }],
    pdfPage: null,
    videoMoment: null,
    media: null,
    mediaOmitted: null,
  },
  note: null,
  label: null,
  capturedAt: '2026-08-22T00:00:00.000Z',
  clientRef: null,
  requestedRegister: null,
  requestedMinutes: null,
  fromSuggestion: false,
  enrichment: null,
  topicId: null,
  ...over,
} as Pin);

const topic = (id: string, label: string, summary: string, pinIds: string[]): Topic => ({
  id, label, summary, pinIds,
  state: 'working',
  comfort: 0.8,
  lastExposedAt: null,
  retiredByUser: false,
  createdAt: '2026-08-01T00:00:00.000Z',
});

// A space where the cut is 0.5, so these read as similarities rather than as
// arithmetic. `thresholdFor` on an unknown model gives the default; the tests
// that care about the cut pass it explicitly.
const CUT = { threshold: 0.5 };

test('material the board already knows is matched, and its topic teaches it', () => {
  const matches = matchTopics(
    [1, 0, 0],
    [{ topicId: 't-story', vector: [0.98, 0.2, 0] }, { topicId: 't-firestore', vector: [0, 1, 0] }],
    'stub',
    CUT,
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.topicId, 't-story');

  const context = resolveContext(null, matches);
  assert.equal(context.topicId, 't-story', 'a pin the batch has not reached has no history to teach it');
  assert.equal(context.source, 'live');
});

test('the register comes from a matched topic rather than from nothing', () => {
  // The whole bug, stated as an assertion. A learner fluent in a subject who
  // pins something new about it is not a beginner for the next few hours.
  const comfort = { comfort: 0.82, certainty: 0.9, evidenceCount: 12, demonstrationCount: 2 };
  assert.equal(registerFor(comfort), 'fluent');
  assert.equal(registerFor(undefined), 'from-nothing',
    'the value every foreground route used to compute for freshly pinned material');
});

test('material below the cut matches nothing, and from-nothing is then the truth', () => {
  // The other half of the honesty. Attaching a passage about short stories to a
  // topic about Firestore because it was the nearest would teach it at that
  // topic's comfort, which is worse than knowing nothing.
  const matches = matchTopics([1, 0, 0], [{ topicId: 't-firestore', vector: [0, 1, 0] }], 'stub', CUT);
  assert.deepEqual(matches, []);
  const context = resolveContext(null, matches);
  assert.equal(context.topicId, null);
  assert.equal(context.source, 'none');
  assert.deepEqual(context.related, []);
});

test('what the batch filed wins over what the live match guessed', () => {
  // A read must never override the partition. Once the Clusterer has placed a
  // pin, that placement is the board's answer.
  const matches = matchTopics([1, 0, 0], [{ topicId: 't-live', vector: [1, 0, 0] }], 'stub', CUT);
  const context = resolveContext('t-filed', matches);
  assert.equal(context.topicId, 't-filed');
  assert.equal(context.source, 'filed');
  assert.equal(context.related[0]?.topicId, 't-live', 'the other matches are still worth showing');
});

test('the order is total, so the same board answers the same way twice', () => {
  const tied = matchTopics(
    [1, 0, 0],
    [{ topicId: 't-b', vector: [1, 0, 0] }, { topicId: 't-a', vector: [1, 0, 0] }],
    'stub',
    CUT,
  );
  assert.deepEqual(tied.map((m) => m.topicId), ['t-a', 't-b'],
    'two topics at the same distance swapped between requests');
});

test('an empty material vector matches nothing rather than everything', () => {
  assert.deepEqual(matchTopics([], [{ topicId: 't', vector: [1] }], 'stub', CUT), []);
});

test('a topic is matched on what it is made of, not only on its name', () => {
  const pins = [
    pin('p1', 'The forward pass computes the loss for one batch.'),
    pin('p2', 'Adam keeps a running estimate per weight.'),
  ];
  const doc = topicDocument(topic('t', 'Optimisers', 'How weights get updated.', ['p1', 'p2']), pins);
  assert.match(doc, /Optimisers/);
  assert.match(doc, /How weights get updated\./);
  assert.match(doc, /forward pass/, 'the pins are the evidence and they were left out');
  assert.match(doc, /running estimate/);
});

test('a topic document is bounded, so a big topic cannot cost a fortune to embed', () => {
  const many = Array.from({ length: 40 }, (_, i) => pin(`p${i}`, 'x'.repeat(2_000)));
  const doc = topicDocument(
    topic('t', 'Big', 'A big one.', many.map((p) => p.id)),
    many,
  );
  const contributions = doc.split('\n').length - 2; // label and summary
  assert.equal(contributions, TOPIC_DOC_PINS);
  assert.ok(doc.length < TOPIC_DOC_PINS * 500, `topic document was ${doc.length} characters`);
});

test('a member pin the store no longer holds is skipped rather than thrown over', () => {
  const doc = topicDocument(topic('t', 'Gone', 'A summary.', ['missing']), []);
  assert.equal(doc, 'Gone\nA summary.');
});

test('the match window is the window the take is written from', () => {
  // A register pitched at material the learner never sees is a register pitched
  // at the wrong thing.
  assert.equal(MATCH_MATERIAL, 4_000);
});

test('the default cut is the measured one for the space, not a number picked here', () => {
  assert.equal(
    matchTopics([1, 0], [{ topicId: 't', vector: [1, 0] }], 'nomic-embed-text').length, 1);
  const justUnder = Math.max(0, thresholdFor('nomic-embed-text') - 0.05);
  const angled = [Math.cos(Math.acos(justUnder)), Math.sin(Math.acos(justUnder))];
  assert.deepEqual(matchTopics([1, 0], [{ topicId: 't', vector: angled }], 'nomic-embed-text'), []);
});
