import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Signal, SignalType, Topic } from '../domain/types.js';
import {
  QUICK_TAKE_MARKS, QUICK_TAKE_VERDICTS, SIGNAL_WEIGHT, isEvidence, isPreferenceSignal,
  notNowMark, NOT_NOW_DAYS,
} from '../domain/signals.js';
import { MODALITY_ASSESSED_TYPES, modalityTallies } from '../domain/modality.js';
import { prospectGaps, PROSPECT_MIN_AVOIDANCE } from '../domain/prospect.js';

/**
 *  — WHAT THE QUICK TAKE'S CLOSE WRITES, AND EVERYWHERE IT MAY AND MAY
 * NOT REACH.
 *
 * The walkthrough finding was that a quick take could be read and left with
 * the board learning nothing, which breaks the one clause `PRODUCT_SHAPE.md`
 * calls the moat: *one learner model that every surface feeds*. The fix is a
 * three-control close, and the risk in a fix like that is not the controls. It
 * is that a self-reported tap quietly becomes evidence somewhere it was never
 * entitled to be.
 *
 * So this file is the boundary rather than the button. The panel's own tests
 * assert the three labels, the one tap and the walk-away; these assert that
 * the marks behind them are marks the ledger already carried, that they reach
 * the consumers that were always allowed to read them, and that
 * exclusion survives a new writer arriving on the same types.
 */

const NOW = new Date('2026-08-29T09:00:00.000Z');
const DAY_MS = 86_400_000;
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY_MS).toISOString();

const topic = (id: string, over: Partial<Topic> = {}): Topic => ({
  id, label: `Topic ${id}`, summary: '', pinIds: [], state: 'working', comfort: 0.9,
  lastExposedAt: null, retiredByUser: false, createdAt: ago(200), ...over,
});

/** One tap, exactly as the service writes it: the type and direction the mark
 *  table names, under the take's own source event. */
const tap = (
  id: string, topicId: string, verdict: typeof QUICK_TAKE_VERDICTS[number], days = 1,
): Signal => ({
  id,
  topicId,
  type: QUICK_TAKE_MARKS[verdict].type,
  direction: QUICK_TAKE_MARKS[verdict].direction,
  at: ago(days),
  sourceEvent: `quick-take:${id}`,
  invalidated: false,
});

// --------------------------------------------- nothing new was minted for this

test('the three answers write three kinds the ledger already carried', () => {
  assert.deepEqual([...QUICK_TAKE_VERDICTS], ['got-it', 'still-shaky', 'not-now']);
  assert.deepEqual(QUICK_TAKE_VERDICTS.map((v) => QUICK_TAKE_MARKS[v].type),
    ['quick-take-got-it', 'quick-take-still-shaky', 'lineup-not-now']);
  // A deferral is a statement about timing. It is not a claim that the topic
  // is bad and it is emphatically not a claim about what the learner knows,
  // which is what neutral means here and why the weight table has no entry.
  assert.deepEqual(QUICK_TAKE_VERDICTS.map((v) => QUICK_TAKE_MARKS[v].direction),
    ['positive', 'negative', 'neutral']);
  assert.equal(QUICK_TAKE_MARKS['not-now'].backAfterDays, NOT_NOW_DAYS,
    'the window the panel promises is the window the Gardener applies');
  assert.equal(QUICK_TAKE_MARKS['got-it'].backAfterDays, undefined);
  assert.equal(QUICK_TAKE_MARKS['still-shaky'].backAfterDays, undefined);
});

test('the two readings are evidence and the deferral is taste, by type', () => {
  // The learner-lineup contract’s separation, enforced structurally. `SIGNAL_WEIGHT` is keyed
  // on the evidence types, so there is no entry a preference could be read
  // through and no fallback that could invent one.
  assert.equal(isEvidence(tap('a', 't1', 'got-it')), true);
  assert.equal(isEvidence(tap('b', 't1', 'still-shaky')), true);
  assert.equal(isEvidence(tap('c', 't1', 'not-now')), false);
  assert.equal(isPreferenceSignal(QUICK_TAKE_MARKS['not-now'].type), true);
  assert.equal(SIGNAL_WEIGHT[QUICK_TAKE_MARKS['got-it'].type as 'quick-take-got-it'], 0.5);
  assert.equal(SIGNAL_WEIGHT[QUICK_TAKE_MARKS['still-shaky'].type as 'quick-take-still-shaky'], 0.5);
});

// -------------------------------------------------  exclusion survives

test('no closing tap reaches the modality tallies, whatever it says', () => {
  /**
   * The rule this slice was most able to break. A sentence that told somebody
   * notation-heavy material goes badly for them, partly because they said so
   * after reading a take, is the product asking them to confirm their own
   * report back to themselves.  excluded the two taps by type; the third
   * arrives on `lineup-not-now`, which was never in that set either, and this
   * pins that the new writer did not change the answer.
   */
  const signals = [
    tap('t-1', 't1', 'got-it'),
    tap('t-2', 't1', 'still-shaky'),
    tap('t-3', 't1', 'not-now'),
  ];
  assert.deepEqual(modalityTallies([topic('t1')], signals, NOW), [],
    'a board whose only marks are self-reported has nothing checked to compare');

  for (const verdict of QUICK_TAKE_VERDICTS) {
    assert.equal(MODALITY_ASSESSED_TYPES.includes(QUICK_TAKE_MARKS[verdict].type as SignalType),
      false, `${verdict} became a checked outcome`);
  }

  // And it is an exclusion rather than an empty board: one real check on the
  // same topic tallies, and the three taps beside it still do not.
  const checked: Signal = {
    id: 'c-1', topicId: 't1', type: 'answer-correct', direction: 'positive',
    at: ago(2), sourceEvent: 'section:1', invalidated: false,
  };
  const rows = modalityTallies([topic('t1')], [...signals, checked], NOW);
  assert.deepEqual(rows.map((row) => [row.checked, row.wentWell]), [[1, 1]]);
  assert.deepEqual(rows[0]?.signalIds, ['c-1'], 'a self-reported tap was counted as a check');
});

// ------------------------------------ the consumers that were always allowed to

test('a not now from a take is what the avoided-topic gap is looking for', () => {
  /**
   *  fourth gap kind reads marks the learner MADE: offered, and
   * stepped around. A quick take is an offer, and *Not now* is stepping around
   * it, so the night scout needs no new input to see one. Nothing here was
   * built for this test: `AVOIDANCE_TYPES` already listed `lineup-not-now`,
   * and the only change is that a second surface can now produce it.
   */
  const gaps = prospectGaps({
    statements: [],
    topics: [topic('t1'), topic('t2')],
    signals: [
      tap('n-1', 't1', 'not-now', 9),
      tap('n-2', 't1', 'not-now', 3),
      // One deferral is late, not avoided. The floor is the claim.
      tap('n-3', 't2', 'not-now', 4),
    ],
    pins: [],
  });
  assert.deepEqual(gaps.map((gap) => gap.key), ['avoided:t1']);
  assert.equal(gaps[0]?.kind, 'avoided-topic');
  assert.match(gaps[0]?.detail ?? '', new RegExp(`aside ${PROSPECT_MIN_AVOIDANCE} times`));
});

test('a not now from a take holds the topic for the window it promised', () => {
  // The Gardener's own read, which is what makes the receipt true. The same
  // function the session X already went through, so a deferral said on a take
  // and a deferral said on a lineup are one decision rather than two.
  const marks = [tap('n-1', 't1', 'not-now', 1)];
  assert.equal(notNowMark('t1', marks, NOW)?.id, 'n-1');
  assert.equal(notNowMark('t1', marks, new Date(NOW.getTime() + NOT_NOW_DAYS * DAY_MS)), null,
    'the hold outlived the window the learner was told about');
  assert.equal(notNowMark('t1', [tap('g-1', 't1', 'got-it')], NOW), null,
    'a reading of the take was read as a refusal of it');
});
