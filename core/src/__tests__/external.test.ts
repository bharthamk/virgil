import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  admitExternalMethods, externalMarkSignalType, externalNewestFirst, externalSourceEvent,
  isExternalDestination, isExternalKind, isExternalMark,
  EXTERNAL_DESTINATIONS, EXTERNAL_MARKS, EXTERNAL_MARK_WRITES, EXTERNAL_METHODS,
  EXTERNAL_METHOD_MODALITY,
  MODALITY_ASSESSED_TYPES, MODALITY_KINDS, NOT_NOW_DAYS,
  QUICK_TAKE_MARKS, SIGNAL_WEIGHT, isPreferenceSignal,
  type ExternalEntry,
} from '../index.js';

/**
 * THE EXTERNAL LOOP'S DOMAIN RULES, WHICH ARE MOSTLY RULES ABOUT WHAT IT DOES
 * NOT DO.
 *
 * The feature's whole safety argument is that it adds a surface and adds no
 * vocabulary. Everything below is that sentence made checkable: the marks are
 * marks that already existed, they land where those marks already land, and the
 * one field that looks like a claim about how somebody learns is wired to
 * nothing.
 */

// ------------------------------------------------------- no new vocabulary

test('every mark resolves to a mark the quick take already writes', () => {
  // Identity, not equality. A copy of the table would drift the first time one
  // of them changed, and then two surfaces would mean different things by the
  // same word.
  assert.equal(EXTERNAL_MARK_WRITES.easy, QUICK_TAKE_MARKS['got-it']);
  assert.equal(EXTERNAL_MARK_WRITES.hard, QUICK_TAKE_MARKS['still-shaky']);
  assert.equal(EXTERNAL_MARK_WRITES.skipped, QUICK_TAKE_MARKS['not-now']);
  // Done is the honest lesser fact: the same comfort mark as easy, because an
  // out-of-band finish saw no question and no marking.
  assert.equal(EXTERNAL_MARK_WRITES.done, QUICK_TAKE_MARKS['got-it']);
});

test('no mark on an entry is a completion, and none is a demonstration', () => {
  const written = EXTERNAL_MARKS.map(externalMarkSignalType);
  assert.ok(!written.includes('section-completed'), 'attendance is being claimed from outside');
  assert.ok(!written.includes('answer-correct'), 'a marked answer is being claimed from outside');
  assert.ok(!written.includes('recall-check'));
});

test('skipped is the deferral the board already has, with the window it promises', () => {
  assert.equal(EXTERNAL_MARK_WRITES.skipped.type, 'lineup-not-now');
  assert.equal(EXTERNAL_MARK_WRITES.skipped.backAfterDays, NOT_NOW_DAYS);
  // A preference, and the comfort model may not read one. Held by type rather
  // than by discipline, which is what `SIGNAL_WEIGHT`'s key set is for.
  assert.ok(isPreferenceSignal('lineup-not-now'));
  assert.ok(!Object.keys(SIGNAL_WEIGHT).includes('lineup-not-now'));
});

test('the comfort marks are weighted exactly as declared comfort already is', () => {
  assert.equal(SIGNAL_WEIGHT['quick-take-got-it'], SIGNAL_WEIGHT['quick-take-still-shaky']);
  assert.ok(SIGNAL_WEIGHT['quick-take-got-it'] < SIGNAL_WEIGHT['answer-correct'],
    'a report from another surface outweighs somebody checking');
});

// ------------------------------------------------------- the modality wall

test('nothing an entry records can reach the claim about how somebody learns', () => {
  for (const mark of EXTERNAL_MARKS) {
    assert.ok(!MODALITY_ASSESSED_TYPES.includes(externalMarkSignalType(mark)),
      `${mark} writes a kind the modality contrast counts`);
  }
});

test('a declared method is not a modality kind, and three of the four are not one at all', () => {
  /**
   * The finding, written down. `MODALITY_KINDS` describes what MATERIAL demands;
   * these four describe how the learner took it in. A page of formulas can be
   * read, watched or listened to and is notation heavy in all three cases, so
   * the only honest correspondence is the one that names the same act.
   */
  assert.deepEqual(EXTERNAL_METHODS.filter((m) => EXTERNAL_METHOD_MODALITY[m] !== null),
    ['hands-on']);
  for (const method of EXTERNAL_METHODS) {
    const kind = EXTERNAL_METHOD_MODALITY[method];
    if (kind) assert.ok(MODALITY_KINDS.includes(kind), 'a kind outside the closed vocabulary');
  }
});

test('the methods are a closed set, admitted rather than repaired', () => {
  assert.deepEqual(admitExternalMethods(['hands-on', 'read', 'osmosis', 'read']),
    ['read', 'hands-on'], 'vocabulary order, duplicates collapsed, invention dropped');
  assert.deepEqual(admitExternalMethods('read'), []);
  assert.deepEqual(admitExternalMethods(undefined), []);
});

// ------------------------------------------------------------ the plumbing

test('the source event names the entry, in the shape the other marks use', () => {
  assert.equal(externalSourceEvent('e-1'), 'external:e-1');
});

test('the history is ordered by when it left, with a stable tie break', () => {
  const at = (id: string, sentAt: string): ExternalEntry =>
    ({ id, kind: 'manual', label: id, destination: 'manual', sentAt });
  const ordered = externalNewestFirst([
    at('b', '2026-08-29T10:00:00.000Z'),
    at('c', '2026-08-29T12:00:00.000Z'),
    at('a', '2026-08-29T10:00:00.000Z'),
  ]);
  assert.deepEqual(ordered.map((e) => e.id), ['c', 'a', 'b']);
});

test('the narrowings answer for what a client can actually send', () => {
  assert.ok(isExternalKind('lesson'));
  assert.ok(!isExternalKind('homework'));
  for (const destination of EXTERNAL_DESTINATIONS) assert.ok(isExternalDestination(destination));
  assert.ok(!isExternalDestination('telegram'));
  assert.ok(isExternalMark('skipped'));
  assert.ok(!isExternalMark('remove'), 'removal is not a mark: it writes nothing');
});
