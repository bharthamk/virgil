import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REGISTER_WEIGHT, wordBudgets, minutesFor } from '../agents/composer.js';
import type { DepthRegister } from '../domain/types.js';

/**
 * Run 2 found the per-section budget was a flat minute split converted at the
 * reading rate, which handed the from-nothing section the FEWEST words — the
 * opposite of what it needs. The budget is now weighted by register.
 */

const WPM: Record<DepthRegister, number> = { 'from-nothing': 110, 'building': 140, 'fluent': 170 };
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/**
 * The session total the weighting normalises against: the word count that reads
 * back as `minutes` once the words are distributed by weight. Written out
 * independently — a test that reuses the implementation's arithmetic proves
 * nothing.
 */
const totalFor = (minutes: number, registers: readonly DepthRegister[]): number => {
  const w = registers.reduce((a, r) => a + REGISTER_WEIGHT[r], 0);
  return (minutes * w) / registers.reduce((a, r) => a + REGISTER_WEIGHT[r] / WPM[r], 0);
};

test('the weighted budgets sum to the session total', () => {
  const registers: DepthRegister[] = ['from-nothing', 'building', 'building', 'fluent'];
  const budgets = wordBudgets(15, registers);
  const total = totalFor(15, registers);
  // Per-section rounding can move the sum by at most half a word each way.
  assert.ok(Math.abs(sum(budgets) - total) <= registers.length / 2,
    `budgets ${JSON.stringify(budgets)} sum to ${sum(budgets)}, expected ~${total.toFixed(1)}`);
});

test('a from-nothing section gets strictly more words than a fluent one', () => {
  const registers: DepthRegister[] = ['from-nothing', 'building', 'fluent'];
  const [fromNothing, building, fluent] = wordBudgets(15, registers) as [number, number, number];
  assert.ok(fromNothing > building, 'starting from nothing costs more than extending what they have');
  assert.ok(building > fluent, 'a dense paragraph for someone fluent is the cheapest section to write');
});

/**
 * The old code divided minutes flatly and multiplied by the reading rate, so
 * from-nothing (110wpm) was budgeted FEWER words than fluent (170wpm) —
 * squeezing exactly the section that needed room. Regression guard.
 */
test('the budget no longer runs backwards against the reading rate', () => {
  const registers: DepthRegister[] = ['from-nothing', 'fluent'];
  const [fromNothing, fluent] = wordBudgets(10, registers) as [number, number];
  const flatOld = [Math.round(5 * WPM['from-nothing']), Math.round(5 * WPM['fluent'])] as const;
  assert.ok(flatOld[1] > flatOld[0], 'the old flat split really did favour fluent');
  assert.ok(fromNothing > fluent, 'the weighted split does not');
});

test('a single section takes the whole budget, whatever its register', () => {
  for (const r of ['from-nothing', 'building', 'fluent'] as const) {
    const [only] = wordBudgets(12, [r]) as [number];
    // Normalisation cancels for one section, so this is the pre-weighting
    // budget exactly: twelve minutes of reading at that register's rate.
    assert.equal(only, Math.round(12 * WPM[r]), `a lone ${r} section should be unchanged by the weighting`);
  }
});

test('sections of equal register split evenly', () => {
  const budgets = wordBudgets(15, ['building', 'building', 'building']);
  assert.deepEqual(budgets, [budgets[0], budgets[0], budgets[0]]);
  assert.equal(sum(budgets), Math.round(15 * WPM['building']),
    'a uniform session budgets exactly as it did before the weighting existed');
});

test('no sections means no budgets', () => {
  assert.deepEqual(wordBudgets(15, []), []);
});

test('a section is never budgeted at zero words', () => {
  const budgets = wordBudgets(0.01, ['from-nothing', 'fluent']);
  assert.ok(budgets.every((b) => b >= 1), 'a budget of zero words is not an instruction');
});

test('the weights are the ones the design calls for', () => {
  assert.deepEqual(REGISTER_WEIGHT, { 'from-nothing': 1.5, 'building': 1.0, 'fluent': 0.7 });
});

/**
 * Words in, minutes out — the direction is load-bearing  and the
 * weighting must not quietly inflate the session. Shifting words toward the
 * slow-reading register costs minutes, so the total is solved for rather than
 * summed; a session written exactly to budget still reads back at the target.
 */
test('a session written to budget still reads back at the target duration', () => {
  const registers: DepthRegister[] = ['from-nothing', 'building', 'fluent'];
  const budgets = wordBudgets(15, registers);
  const minutes = registers.map((r, i) => minutesFor('word '.repeat(budgets[i] as number), r));
  assert.ok(Math.abs(sum(minutes) - 15) <= 0.5,
    `sections read back as ${sum(minutes).toFixed(1)}min against a 15min budget`);
});
