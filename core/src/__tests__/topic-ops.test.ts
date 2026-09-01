import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_LABEL_LENGTH, planMerge, planSplit, TopicOpError } from '../domain/topic-ops.js';
import type { Pin, Topic } from '../domain/types.js';

/**
 * Validation for the learner's repair control, tested without a filesystem.
 *
 * Every rejection here is a rejection the user will read as a sentence in the
 * panel, so each one has to be a thing that is genuinely wrong rather than a
 * thing that is merely awkward to implement.
 */

const topic = (id: string, pinIds: readonly string[], over: Partial<Topic> = {}): Topic => ({
  id, label: `label of ${id}`, summary: `summary of ${id}`, pinIds,
  state: 'working', comfort: 0.5, lastExposedAt: null, retiredByUser: false,
  createdAt: '2026-07-01T00:00:00Z', ...over,
});

const pin = (id: string, topicId: string | null = null): Pin => ({
  id, type: 'interest',
  envelope: {
    selection: 'x', parts: [], surroundingText: 'y', headingPath: [],
    pageTitle: 't', url: 'https://e.com', canonicalUrl: null, siteName: null,
    contentLanguage: 'en', media: null,
  },
  note: null, capturedAt: '2026-07-01T00:00:00Z',
  fromSuggestion: false, enrichment: null, topicId,
});

const code = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return e instanceof TopicOpError ? e.code : `not-a-topic-op-error:${String(e)}`; }
  return 'no-error';
};

// ------------------------------------------------------------------- merge

test('a merge moves the pins and keeps the survivor’s name', () => {
  const plan = planMerge([topic('A', ['p1', 'p2']), topic('B', ['p3'])], {}, 'A', 'B');
  assert.deepEqual(plan.keep.pinIds, ['p1', 'p2', 'p3']);
  assert.equal(plan.keep.label, 'label of A', 'the topic the learner chose to keep keeps its name');
  assert.equal(plan.keep.summary, 'summary of A');
  assert.equal(plan.retiredTopicId, 'B');
  assert.deepEqual(plan.movedPinIds, ['p3']);
});

test('a merge does not put a comfort number on the board', () => {
  // Comfort is derived from the unioned ledger by the Registrar. Writing a
  // guess here — an average of the two, say — would show the learner a figure
  // that no evidence produced.
  const a = topic('A', ['p1'], { comfort: 0.9 });
  const b = topic('B', ['p2'], { comfort: 0.1 });
  assert.equal(planMerge([a, b], {}, 'A', 'B').keep.comfort, 0.9, 'unchanged, to be recomputed');
});

test('a merged topic counts as taught if either side was taught', () => {
  const never = topic('A', ['p1'], { lastExposedAt: null });
  const taught = topic('B', ['p2'], { lastExposedAt: '2026-08-01T00:00:00Z' });
  assert.equal(planMerge([never, taught], {}, 'A', 'B').keep.lastExposedAt, '2026-08-01T00:00:00Z');
  // And the later of two, so a merge cannot make a topic look overdue.
  const older = topic('C', ['p3'], { lastExposedAt: '2026-06-01T00:00:00Z' });
  assert.equal(planMerge([taught, older], {}, 'B', 'C').keep.lastExposedAt, '2026-08-01T00:00:00Z');
});

test('a pin already in both topics is not duplicated', () => {
  const plan = planMerge([topic('A', ['p1', 'p2']), topic('B', ['p2', 'p3'])], {}, 'A', 'B');
  assert.deepEqual(plan.keep.pinIds, ['p1', 'p2', 'p3']);
  assert.deepEqual(plan.movedPinIds, ['p3']);
});

test('merging a topic into itself is refused, by any route', () => {
  const topics = [topic('A', ['p1']), topic('B', ['p2'])];
  assert.equal(code(() => planMerge(topics, {}, 'A', 'A')), 'self-merge');
  // B was already merged into A. "Merge B into A" again is the same request.
  assert.equal(code(() => planMerge(topics, { B: 'A' }, 'A', 'B')), 'self-merge');
});

test('merging by way of an id that was itself absorbed lands on the live topic', () => {
  // C was merged into B, B into A. "Merge D into C" means "into A".
  const topics = [topic('A', ['p1']), topic('D', ['p4'])];
  const plan = planMerge(topics, { C: 'B', B: 'A' }, 'C', 'D');
  assert.equal(plan.keep.id, 'A');
  assert.equal(plan.retiredTopicId, 'D');
});

test('absorbing an id that has already been absorbed is refused, not redirected', () => {
  // Silently redirecting would retire a topic the user never pointed at. This
  // is a stale panel, and the honest answer is to say so and refresh.
  const topics = [topic('A', ['p1']), topic('X', ['p9'])];
  assert.equal(code(() => planMerge(topics, { B: 'A' }, 'X', 'B')), 'absorbed-topic');
});

test('an unknown topic on either side is refused', () => {
  const topics = [topic('A', ['p1'])];
  assert.equal(code(() => planMerge(topics, {}, 'A', 'nope')), 'unknown-topic');
  assert.equal(code(() => planMerge(topics, {}, 'nope', 'A')), 'unknown-topic');
});

// ------------------------------------------------------------------- split

const NOW = '2026-08-19T03:00:00Z';

test('a split moves the chosen pins into a new topic the user named', () => {
  const original = topic('A', ['p1', 'p2', 'p3']);
  const pins = [pin('p1', 'A'), pin('p2', 'A'), pin('p3', 'A')];
  const plan = planSplit([original], pins, {}, 'A', ['p3'], 'Tritone substitution', 'NEW', NOW);

  assert.deepEqual(plan.original.pinIds, ['p1', 'p2']);
  assert.deepEqual(plan.created.pinIds, ['p3']);
  assert.equal(plan.created.label, 'Tritone substitution');
  assert.equal(plan.created.id, 'NEW');
  assert.equal(plan.created.createdAt, NOW);
});

test('the new topic is honestly empty rather than plausibly furnished', () => {
  const plan = planSplit([topic('A', ['p1', 'p2'])], [pin('p1'), pin('p2')], {},
    'A', ['p2'], 'Voicings', 'NEW', NOW);
  assert.equal(plan.created.summary, '', 'no model wrote a summary the learner never approved');
  assert.equal(plan.created.lastExposedAt, null, 'it has never been taught, because it did not exist');
  assert.equal(plan.created.state, 'waiting');
  assert.equal(plan.created.comfort, 0.15, 'the no-evidence default, not a share of the original’s');
  assert.equal(plan.created.retiredByUser, false);
});

test('the original is untouched apart from losing the pins', () => {
  const original = topic('A', ['p1', 'p2'], {
    comfort: 0.82, lastExposedAt: '2026-08-10T00:00:00Z', summary: 'what I was working on',
  });
  const plan = planSplit([original], [pin('p1'), pin('p2')], {}, 'A', ['p2'], 'Other', 'NEW', NOW);
  assert.equal(plan.original.comfort, 0.82);
  assert.equal(plan.original.lastExposedAt, '2026-08-10T00:00:00Z');
  assert.equal(plan.original.summary, 'what I was working on');
});

test('a split that would empty the original is refused', () => {
  // The original still owns the entire signal ledger. Emptying it would leave a
  // topic with no pins holding all the comfort, and one with all the pins
  // holding none. That is a rename, or a merge — not a split.
  const pins = [pin('p1'), pin('p2')];
  assert.equal(code(() => planSplit([topic('A', ['p1', 'p2'])], pins, {}, 'A', ['p1', 'p2'], 'X', 'NEW', NOW)),
    'empty-split');
});

test('a split of a single-pin topic is refused for the same reason', () => {
  assert.equal(code(() => planSplit([topic('A', ['p1'])], [pin('p1')], {}, 'A', ['p1'], 'X', 'NEW', NOW)),
    'empty-split');
});

test('a split with nothing selected is refused', () => {
  assert.equal(code(() => planSplit([topic('A', ['p1', 'p2'])], [pin('p1'), pin('p2')], {},
    'A', [], 'X', 'NEW', NOW)), 'empty-selection');
});

test('a pin from another topic cannot be dragged in by a split', () => {
  const topics = [topic('A', ['p1', 'p2']), topic('B', ['p9'])];
  const pins = [pin('p1'), pin('p2'), pin('p9')];
  assert.equal(code(() => planSplit(topics, pins, {}, 'A', ['p9'], 'X', 'NEW', NOW)), 'pin-not-in-topic');
});

test('a pin that does not exist is refused before membership is even considered', () => {
  assert.equal(code(() => planSplit([topic('A', ['p1', 'p2'])], [pin('p1'), pin('p2')], {},
    'A', ['ghost'], 'X', 'NEW', NOW)), 'unknown-pin');
});

test('the user has to name it', () => {
  const pins = [pin('p1'), pin('p2')];
  assert.equal(code(() => planSplit([topic('A', ['p1', 'p2'])], pins, {}, 'A', ['p2'], '   ', 'NEW', NOW)),
    'empty-label');
});

test('a learner-named topic is accepted whole or refused at the Unicode boundary', () => {
  const exact = '😀'.repeat(MAX_LABEL_LENGTH);
  const plan = planSplit([topic('A', ['p1', 'p2'])], [pin('p1'), pin('p2')], {},
    'A', ['p2'], `  ${exact}  `, 'NEW', NOW);
  assert.equal(plan.created.label, exact);
  assert.equal(Array.from(plan.created.label).length, MAX_LABEL_LENGTH);
  assert.equal(code(() => planSplit(
    [topic('A', ['p1', 'p2'])], [pin('p1'), pin('p2')], {},
    'A', ['p2'], `${exact}x`, 'NEW', NOW,
  )), 'label-too-long');
});

test('duplicates in the selection do not count twice toward emptying the topic', () => {
  const plan = planSplit([topic('A', ['p1', 'p2'])], [pin('p1'), pin('p2')], {},
    'A', ['p2', 'p2', 'p2'], 'X', 'NEW', NOW);
  assert.deepEqual(plan.created.pinIds, ['p2']);
  assert.deepEqual(plan.original.pinIds, ['p1']);
});

test('splitting by way of an absorbed id splits the topic it was merged into', () => {
  const plan = planSplit([topic('A', ['p1', 'p2'])], [pin('p1'), pin('p2')], { B: 'A' },
    'B', ['p2'], 'X', 'NEW', NOW);
  assert.equal(plan.original.id, 'A');
});

test('splitting an unknown topic is refused', () => {
  assert.equal(code(() => planSplit([], [], {}, 'nope', ['p1'], 'X', 'NEW', NOW)), 'unknown-topic');
});
