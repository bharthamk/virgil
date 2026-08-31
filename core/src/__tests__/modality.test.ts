import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  admitModalityKinds, isModalityKind, modalityAlreadyLive, modalityCandidate,
  modalityDenialLive, modalityKindTallies, modalityTallies, modalityWorthAsking,
  recordModalityDenial,
  MODALITY_ASSESSED_TYPES, MODALITY_DENIED_DAYS, MODALITY_KINDS, MODALITY_KIND_MEANINGS,
  MODALITY_KIND_WORDS, MODALITY_MIN_CONTRAST, MODALITY_MIN_EVIDENCE, MODALITY_WINDOW_DAYS,
  type ModalityTopicTally,
} from '../domain/modality.js';
import { hasBannedDash } from '../agents/house-style.js';
import type { ModalityKind, Signal, SignalType, Statement, Topic, TopicId } from '../domain/types.js';

/**
 *  — THE ARITHMETIC BEHIND THE ONE QUESTION THIS PRODUCT ASKS ABOUT A
 * PERSON.
 *
 * PRODUCT_SHAPE.md forbids silent modality profiling outright and allows
 * exactly one alternative: a learner-confirmed statement with its evidence
 * shown. Everything in this file is one half of that permission held in place.
 *
 * Four properties, and each of them is the whole feature if it fails:
 *
 *  1. The numbers are the ledger's, computed here, and no model touches them.
 *  2. The vocabulary is closed, and a kind nobody offered is dropped in code
 *     rather than repaired into the nearest thing.
 *  3. Below the floor there is silence. Not a hedge, not a weaker sentence.
 *  4. A no lasts a month and then stops lasting, exactly.
 */

const NOW = new Date('2026-08-29T09:00:00.000Z');
const DAY_MS = 86_400_000;
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY_MS).toISOString();

const topic = (id: TopicId, label = `Topic ${id}`): Topic => ({
  id, label, summary: '', pinIds: [], state: 'working', comfort: 0.5,
  lastExposedAt: null, retiredByUser: false, createdAt: ago(200),
});

let counter = 0;
const mark = (
  topicId: TopicId, direction: Signal['direction'], over: Partial<Signal> = {},
): Signal => ({
  id: `s-${++counter}`, topicId, type: 'answer-correct' as SignalType, direction,
  at: ago(3), sourceEvent: 'test', invalidated: false, ...over,
});

/** `n` marks on a topic, `well` of which went well. */
const marks = (topicId: TopicId, n: number, well: number, over: Partial<Signal> = {}): Signal[] =>
  Array.from({ length: n }, (_, index) =>
    mark(topicId, index < well ? 'positive' : 'negative', over));

const tally = (
  topicId: TopicId, checked: number, wentWell: number, label = `Topic ${topicId}`,
): ModalityTopicTally => ({ topicId, label, checked, wentWell, signalIds: [`sig-${topicId}`] });

const kindsOf = (rows: readonly (readonly [TopicId, ModalityKind])[]): Map<TopicId, ModalityKind> =>
  new Map(rows);

// ------------------------------------------------------------- the vocabulary

test('the vocabulary is closed, and every kind in it has words on both sides', () => {
  assert.equal(MODALITY_KINDS.length, 4, 'the four kinds are the whole vocabulary');
  for (const kind of MODALITY_KINDS) {
    assert.ok(MODALITY_KIND_MEANINGS[kind], `${kind} has nothing to tell the model`);
    assert.ok(MODALITY_KIND_WORDS[kind], `${kind} has no words for the learner`);
    assert.ok(!hasBannedDash(MODALITY_KIND_WORDS[kind]), `${kind} reads as generated prose`);
  }
  // Both records are keyed on the union, so a fifth kind added to the type is a
  // compile error rather than a silent gap. This checks the other direction:
  // the runtime list the model is offered has not fallen behind the type.
  assert.deepEqual([...MODALITY_KINDS].sort(), Object.keys(MODALITY_KIND_WORDS).sort());
  for (const kind of MODALITY_KINDS) assert.equal(isModalityKind(kind), true);
  assert.equal(isModalityKind('visual-learner'), false, 'a learning style is not a kind of demand');
  assert.equal(isModalityKind(undefined), false);
});

test('a kind nobody offered is dropped, not mapped to the nearest thing', () => {
  const admission = admitModalityKinds([
    { key: 'k1', kind: 'notation-heavy' },
    { key: 'k2', kind: 'visual' },
    { key: 'k2', kind: 'Notation Heavy' },
    { key: 'k3', kind: 'logic-structure' },
    { key: 'k3', kind: 'hands-on' },
    { key: 'k9', kind: 'hands-on' },
    { key: null, kind: 'hands-on' },
  ], ['k1', 'k2', 'k3']);
  assert.deepEqual([...admission.kinds], [['k1', 'notation-heavy'], ['k3', 'logic-structure']]);
  assert.equal(admission.invented, 2, 'a fifth kind and a reworded one are both inventions');
  assert.equal(admission.unknown, 2, 'a key never offered, and one that could not be resolved');
  assert.equal(admission.duplicate, 1, 'the first answer for a topic is the one that counts');
});

// -------------------------------------------------------------- the counting

test('the tallies count checks, in a fixed order, from a bounded window', () => {
  const topics = [topic('b'), topic('a'), topic('retired')];
  const signals: Signal[] = [
    ...marks('a', 4, 3),
    ...marks('b', 3, 0),
    ...marks('retired', 5, 5),
    mark('a', 'positive', { at: ago(MODALITY_WINDOW_DAYS + 1) }),
    mark('a', 'positive', { invalidated: true }),
    mark('a', 'neutral'),
    mark('a', 'positive', { type: 'quick-take-got-it' }),
    mark('a', 'negative', { type: 'self-skip' }),
  ];
  const retired = { ...topic('retired'), retiredByUser: true };
  const rows = modalityTallies([topics[0]!, topics[1]!, retired], signals, NOW);

  assert.deepEqual(rows.map((row) => row.topicId), ['a', 'b'],
    'topic id order, so two runs over one board ask the same question');
  assert.deepEqual(rows.map((row) => [row.checked, row.wentWell]), [[4, 3], [3, 0]],
    'outside the window, invalidated, neutral, self-reported and unchecked marks are all excluded');
  assert.equal(rows.length, 2, 'a topic the learner retired is not evidence about them');
});

test('the self-reported taps are deliberately not counted as checks', () => {
  // A sentence that told somebody notation goes badly for them partly because
  // they said so would be asking them to confirm their own report back.
  for (const type of ['quick-take-got-it', 'quick-take-still-shaky', 'self-skip', 'pin-struggle']) {
    assert.equal(MODALITY_ASSESSED_TYPES.includes(type as SignalType), false,
      `${type} is a learner's own read and must not write the claim they are asked about`);
  }
  assert.ok(MODALITY_ASSESSED_TYPES.includes('answer-wrong'));
  assert.ok(MODALITY_ASSESSED_TYPES.includes('assessed-gap'));
  assert.ok(MODALITY_ASSESSED_TYPES.includes('qc-finding'));
});

test('nothing is sent when no classification could produce a contrast', () => {
  assert.equal(modalityWorthAsking([]), false);
  assert.equal(modalityWorthAsking([tally('a', 9, 1)]), false,
    'one topic cannot be two kinds, so no answer can clear the floor');
  assert.equal(modalityWorthAsking([tally('a', 3, 1), tally('b', 2, 2)]), false,
    'five checks cannot be three in each of two kinds');
  assert.equal(modalityWorthAsking([tally('a', 3, 1), tally('b', 3, 3)]), true);
});

// ---------------------------------------------------------- the contrast floor

test('the contrast floor, as a truth table', () => {
  const cases: readonly {
    readonly what: string;
    readonly rows: readonly ModalityTopicTally[];
    readonly kinds: readonly (readonly [TopicId, ModalityKind])[];
    readonly asks: boolean;
  }[] = [
    {
      what: 'clears both halves: three each side, and two checks of difference',
      rows: [tally('a', 3, 0), tally('b', 3, 2)],
      kinds: [['a', 'notation-heavy'], ['b', 'logic-structure']],
      asks: true,
    },
    {
      what: 'one check of difference at the floor is not a contrast',
      rows: [tally('a', 3, 1), tally('b', 3, 2)],
      kinds: [['a', 'notation-heavy'], ['b', 'logic-structure']],
      asks: false,
    },
    {
      what: 'a wide gap with only two checks on one side stays silent',
      rows: [tally('a', 2, 0), tally('b', 6, 6)],
      kinds: [['a', 'notation-heavy'], ['b', 'logic-structure']],
      asks: false,
    },
    {
      what: 'plenty of evidence, all of it one kind, is not a comparison',
      rows: [tally('a', 5, 0), tally('b', 5, 5)],
      kinds: [['a', 'notation-heavy'], ['b', 'notation-heavy']],
      asks: false,
    },
    {
      what: 'a topic the model did not classify contributes nothing',
      rows: [tally('a', 4, 0), tally('b', 4, 4), tally('c', 9, 0)],
      kinds: [['a', 'notation-heavy'], ['b', 'logic-structure']],
      asks: true,
    },
    {
      what: 'two topics of one kind add up to clear the floor together',
      rows: [tally('a', 2, 0), tally('b', 2, 0), tally('c', 4, 4)],
      kinds: [['a', 'notation-heavy'], ['b', 'notation-heavy'], ['c', 'hands-on']],
      asks: true,
    },
  ];
  for (const item of cases) {
    const found = modalityCandidate(item.rows, kindsOf(item.kinds));
    assert.equal(found !== null, item.asks, item.what);
  }
});

test('the threshold is the number the floor is reasoned from', () => {
  // At the evidence floor a kind can only score 0, 1, 2 or 3 of 3, so the
  // available gaps are 0, 0.33, 0.67 and 1. The threshold sits above 0.33 on
  // purpose: one result going the other way can neither create this claim nor
  // destroy it.
  assert.equal(MODALITY_MIN_EVIDENCE, 3);
  assert.ok(MODALITY_MIN_CONTRAST > 1 / 3 && MODALITY_MIN_CONTRAST <= 2 / 3);
});

test('one contrast leaves, and it is the widest, deterministically', () => {
  const rows = [tally('a', 4, 0), tally('b', 4, 2), tally('c', 4, 4)];
  const kinds = kindsOf([
    ['a', 'notation-heavy'], ['b', 'language-recall'], ['c', 'logic-structure'],
  ]);
  const found = modalityCandidate(rows, kinds);
  assert.equal(found?.key, 'notation-heavy|logic-structure', 'the widest gap wins');
  assert.deepEqual(modalityCandidate(rows, kinds), found, 'twice over one board, one question');
  assert.equal(found?.slower, 'notation-heavy');
  assert.equal(found?.faster, 'logic-structure');
});

test('the sentence shows its numbers, names both kinds, and asks', () => {
  const found = modalityCandidate(
    [tally('a', 5, 1), tally('b', 6, 5)],
    kindsOf([['a', 'notation-heavy'], ['b', 'logic-structure']]),
  );
  assert.equal(
    found?.text,
    'Recent checks suggest notation heavy material goes less smoothly for you than'
    + ' logic and structure work: 1 of 5 checks went well on notation heavy material,'
    + ' against 5 of 6 on logic and structure work. Does that match how it feels?',
  );
  assert.match(found?.text ?? '', /\?$/, 'it is a question until somebody answers it');
  assert.ok(!hasBannedDash(found?.text ?? ''));
  assert.doesNotMatch(found?.text ?? '', /%|score|weak|bad at|you are/i,
    'no score, no grade, and nothing that says what the learner is');
  assert.deepEqual(found?.evidenceSignalIds, ['sig-a', 'sig-b'],
    'both sides of the comparison are pointed at, so the read can be contested');
});

test('the per-kind totals add their topics up in vocabulary order', () => {
  const byKind = modalityKindTallies(
    [tally('a', 2, 1), tally('b', 4, 1), tally('c', 3, 3)],
    kindsOf([['a', 'logic-structure'], ['b', 'notation-heavy'], ['c', 'logic-structure']]),
  );
  assert.deepEqual(byKind.map((row) => row.kind), ['notation-heavy', 'logic-structure']);
  assert.deepEqual(byKind.map((row) => [row.checked, row.wentWell]), [[4, 1], [5, 4]]);
});

// --------------------------------------------------------- one at a time, and no

const statement = (over: Partial<Statement> = {}): Statement => ({
  id: 'st-1', text: 'a read', topicId: null, userEdited: false,
  evidenceSignalIds: [], updatedAt: ago(1), ...over,
});

const asked = (over: Partial<Statement['modality']> = {}): Statement => statement({
  modality: {
    key: 'notation-heavy|logic-structure', slower: 'notation-heavy', faster: 'logic-structure',
    askedAt: ago(1), confirmedAt: null, ...over,
  },
});

test('one modality statement is live at a time, asked or answered', () => {
  assert.equal(modalityAlreadyLive([]), false);
  assert.equal(modalityAlreadyLive([statement()]), false, 'an ordinary read is not one');
  assert.equal(modalityAlreadyLive([asked()]), true, 'an unanswered question holds the slot');
  assert.equal(modalityAlreadyLive([asked({ confirmedAt: ago(0) })]), true,
    'a confirmed one holds it too: a second theory beside the first is a profile');
  assert.equal(modalityAlreadyLive([{ ...asked(), rejected: true }]), false,
    'a denied one is not standing, and the denial record is what keeps it away');
});

test('a no lasts exactly the window it promises, and a broken stamp is no no at all', () => {
  const denial = recordModalityDenial('notation-heavy|logic-structure', NOW);
  assert.equal(denial.at, NOW.toISOString());
  assert.equal(denial.key, 'notation-heavy|logic-structure');

  assert.equal(modalityDenialLive(denial, NOW), true);
  assert.equal(modalityDenialLive(
    { key: 'k', at: ago(MODALITY_DENIED_DAYS - 1) }, NOW), true, 'still standing the day before');
  assert.equal(modalityDenialLive(
    { key: 'k', at: ago(MODALITY_DENIED_DAYS) }, NOW), false, 'and expired on the day');
  assert.equal(modalityDenialLive({ key: 'k', at: 'not a date' }, NOW), false);
  assert.equal(modalityDenialLive({ key: 'k', at: ago(-5) }, NOW), false,
    'a future stamp is a broken record, not a question nobody may ever ask');
  assert.equal(modalityDenialLive(undefined, NOW), false);
  assert.equal(modalityDenialLive(null, NOW), false);
});

test('the denial covers every pair, not only the one that was refused', () => {
  // The four kinds are four ways of saying one thing about somebody. Re-asking
  // with the pair swapped a day later would be the product arguing with them.
  const denial = recordModalityDenial('notation-heavy|logic-structure', NOW);
  assert.equal(modalityDenialLive(denial, NOW), true);
  assert.equal(denial.key, 'notation-heavy|logic-structure',
    'the pair is recorded for the receipt; the window is what the stage reads');
});
