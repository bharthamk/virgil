import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_NIGHT_KEY_RULE, NightKeyError, isBatchKey, batchKeyFor, sessionIdForBatch,
} from '../batch-key.js';

/**
 * The night key, on its own.
 *
 * Pure, so it can be asserted exhaustively and cheaply — and it is worth
 * asserting exhaustively, because everything downstream of it is one boolean:
 * *has this night already been built*. A key that is wrong by a day is a night
 * that runs twice, and nothing else in the system would say so.
 */

test('the same instant always gives the same key, however it is spelled', () => {
  const a = batchKeyFor('2026-08-20T03:00:00.000Z');
  const b = batchKeyFor(new Date('2026-08-20T03:00:00.000Z'));
  const c = batchKeyFor('2026-08-20T05:00:00.000+02:00');
  assert.equal(a, b);
  assert.equal(a, c, 'an offset is a spelling of an instant, not a different one');
});

test('a 03:00 run belongs to the night before, not to the morning it lands in', () => {
  // The default boundary is six hours, so everything from 06:00 to 06:00 is one
  // night. A nightly firing at 03:00 on the 20th is the night of the 19th.
  assert.equal(batchKeyFor('2026-08-20T03:00:00Z'), '2026-08-19');
  assert.equal(batchKeyFor('2026-08-20T05:59:59Z'), '2026-08-19');
  assert.equal(batchKeyFor('2026-08-20T06:00:00Z'), '2026-08-20', 'and the boundary is where it says it is');
});

test('schedule drift across midnight does not rename the night', () => {
  /**
   * Why the boundary offset exists at all. A schedule that slips from 02:55 to
   * 03:05 crosses no boundary; one keyed on the plain calendar date and firing
   * near midnight would cross one every time it slipped, and two firings ten
   * minutes apart would build two nights.
   */
  const early = batchKeyFor('2026-08-20T02:55:00Z');
  const late = batchKeyFor('2026-08-20T03:05:00Z');
  assert.equal(early, late);

  const plain = { timeZone: 'UTC', boundaryHours: 0 };
  assert.notEqual(
    batchKeyFor('2026-08-19T23:55:00Z', plain),
    batchKeyFor('2026-08-20T00:05:00Z', plain),
    'the un-shifted rule is the one that splits, which is what the shift is for');
});

test('the zone is the deployment’s, and moving it moves the night', () => {
  // 2026-08-20T03:00Z is 2026-08-19 20:00 in Los Angeles. Shifted back six
  // hours that is 14:00 on the 19th, so the night is the 19th either way here —
  // and the point is that the two rules are genuinely different, checked on an
  // instant where they disagree.
  assert.equal(batchKeyFor('2026-08-20T10:00:00Z', { timeZone: 'UTC', boundaryHours: 6 }), '2026-08-20');
  assert.equal(batchKeyFor('2026-08-20T10:00:00Z', { timeZone: 'America/Los_Angeles', boundaryHours: 6 }), '2026-08-19');
});

test('a daylight-saving transition does not produce a day with two keys or none', () => {
  /**
   * The reason this uses `Intl` rather than arithmetic on a `Date`. US DST
   * moves at 02:00 local on 2026-11-01, inside the hours a nightly runs.
   * Hand-rolled offset arithmetic is wrong twice a year in exactly this window.
   */
  const tz = { timeZone: 'America/New_York', boundaryHours: 6 };
  const keys = [
    batchKeyFor('2026-11-01T05:30:00Z', tz), // 01:30 EDT
    batchKeyFor('2026-11-01T06:30:00Z', tz), // 01:30 EST, the repeated hour
    batchKeyFor('2026-11-01T07:30:00Z', tz), // 02:30 EST
  ];
  assert.deepEqual(keys, ['2026-10-31', '2026-10-31', '2026-10-31'],
    'the repeated hour is still the same night');
});

test('an instant that is not an instant is refused rather than keyed', () => {
  /**
   * A key derived from `NaN` would be perfectly stable across redeliveries and
   * perfectly useless — and it would collide every malformed trigger onto one
   * shared idempotency key, so the first bad message would suppress every other
   * bad message's night for ever.
   */
  assert.throws(() => batchKeyFor('not a date'), NightKeyError);
  assert.throws(() => batchKeyFor(new Date(NaN)), NightKeyError);
});

test('the key shape is checkable, and the session id is derived from it', () => {
  assert.ok(isBatchKey('2026-08-19'));
  assert.ok(!isBatchKey('2026-8-9'));
  assert.ok(!isBatchKey(''));
  assert.equal(sessionIdForBatch('2026-08-19'), 'night-2026-08-19');
});

test('the default rule is UTC, so nothing reads the machine’s locale', () => {
  // A zone guessed from the process locale is how a run silently changes which
  // night it belongs to when the job moves region.
  assert.equal(DEFAULT_NIGHT_KEY_RULE.timeZone, 'UTC');
  assert.equal(DEFAULT_NIGHT_KEY_RULE.boundaryHours, 6);
});
