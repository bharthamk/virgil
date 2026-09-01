import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SCHEDULE, dayKeyFor, hourIn, isZone, localZone, scheduleFrom, shouldBuild,
  type LearningSchedule,
} from '../domain/schedule.js';

/**
 * When a session gets built, which used to be a cron and is now a decision.
 *
 * The old answer was `03:00 Etc/UTC` with no timezone anywhere in the system,
 * so a learner in Sydney got their "nightly" session at one in the afternoon
 * while the product told them it would arrive this run. What is asserted here
 * is mostly the refusals: a schedule that builds when nobody asked is worse
 * than one that never builds, because the learner can always ask.
 */

const SYDNEY = 'Australia/Sydney';
const daily = (hour: number, timeZone = SYDNEY): LearningSchedule => ({ kind: 'daily', hour, timeZone });

/** 2026-08-22T09:00:00Z is 19:00 in Sydney, which is +10 in August. */
const at = (iso: string): Date => new Date(iso);

test('the day is the learner’s, not the server’s', () => {
  // The whole reason a UTC key was wrong: it rolls over mid-afternoon in
  // Sydney, so a learner there gets two sessions on one of their days and
  // none on another.
  assert.equal(dayKeyFor(at('2026-08-22T09:00:00Z'), SYDNEY), '2026-08-22');
  assert.equal(dayKeyFor(at('2026-08-22T15:00:00Z'), SYDNEY), '2026-08-23',
    'still the 22nd in UTC, already the 23rd where the learner is');
  assert.equal(dayKeyFor(at('2026-08-22T09:00:00Z'), 'America/Los_Angeles'), '2026-08-22');
  assert.equal(dayKeyFor(at('2026-08-22T02:00:00Z'), 'America/Los_Angeles'), '2026-08-21',
    'already the 22nd in UTC, still the 21st where the learner is');
});

test('an unresolvable zone counts days in UTC rather than failing the run', () => {
  assert.equal(dayKeyFor(at('2026-08-22T09:00:00Z'), 'Mars/Olympus'), '2026-08-22');
  assert.equal(hourIn(at('2026-08-22T09:00:00Z'), 'Mars/Olympus'), 9);
});

test('the hour is read in the learner’s zone', () => {
  assert.equal(hourIn(at('2026-08-22T09:00:00Z'), SYDNEY), 19);
  assert.equal(hourIn(at('2026-08-22T14:00:00Z'), SYDNEY), 0, 'midnight, not 24');
  assert.equal(hourIn(at('2026-08-22T09:00:00Z'), 'Europe/London'), 10);
});

test('a daily schedule builds once the hour has arrived where they are', () => {
  const d = shouldBuild({ schedule: daily(19), now: at('2026-08-22T09:00:00Z'), lastBuiltDayKey: null });
  assert.deepEqual(d, { build: true, dayKey: '2026-08-22', because: 'due' });
});

test('and not before it', () => {
  const d = shouldBuild({ schedule: daily(21), now: at('2026-08-22T09:00:00Z'), lastBuiltDayKey: null });
  assert.equal(d.build, false);
  assert.equal(d.because, 'too-early');
});

test('a tick that fires late still builds, rather than skipping the day', () => {
  // At-or-past rather than exactly-equal. An hourly sweep that misses an hour,
  // or a platform that runs it eight minutes later, must not cost a session.
  const d = shouldBuild({ schedule: daily(19), now: at('2026-08-22T13:00:00Z'), lastBuiltDayKey: null });
  assert.equal(d.build, true, '23:00 their time, four hours after the moment, still due');
});

test('once a day means once in their day', () => {
  const first = shouldBuild({ schedule: daily(19), now: at('2026-08-22T09:00:00Z'), lastBuiltDayKey: null });
  assert.equal(first.build, true);

  const again = shouldBuild({
    schedule: daily(19), now: at('2026-08-22T11:00:00Z'), lastBuiltDayKey: first.dayKey,
  });
  assert.equal(again.build, false);
  assert.equal(again.because, 'already-built');

  // And the next day is a new one, in their zone: 2026-08-23T09:00Z is 19:00
  // on the 23rd in Sydney.
  const tomorrow = shouldBuild({
    schedule: daily(19), now: at('2026-08-23T09:00:00Z'), lastBuiltDayKey: first.dayKey,
  });
  assert.equal(tomorrow.build, true);
  assert.equal(tomorrow.dayKey, '2026-08-23');
});

test('on-demand builds on no clock at all', () => {
  for (const now of ['2026-08-22T00:00:00Z', '2026-08-22T09:00:00Z', '2026-08-22T23:00:00Z']) {
    const d = shouldBuild({ schedule: { kind: 'on-demand' }, now: at(now), lastBuiltDayKey: null });
    assert.equal(d.build, false);
    assert.equal(d.because, 'on-demand-only');
  }
});

test('asking outranks every schedule, including having had one today', () => {
  // A learner pressing the button has said more than any schedule can.
  const onDemand = shouldBuild({
    schedule: { kind: 'on-demand' }, now: at('2026-08-22T09:00:00Z'), lastBuiltDayKey: null, asked: true,
  });
  assert.deepEqual(onDemand, { build: true, dayKey: '2026-08-22', because: 'asked' });

  const alreadyHad = shouldBuild({
    schedule: daily(19), now: at('2026-08-22T09:00:00Z'), lastBuiltDayKey: '2026-08-22', asked: true,
  });
  assert.equal(alreadyHad.build, true, 'a second session they asked for is a session they asked for');

  const tooEarly = shouldBuild({
    schedule: daily(23), now: at('2026-08-22T09:00:00Z'), lastBuiltDayKey: null, asked: true,
  });
  assert.equal(tooEarly.build, true);
});

test('a schedule this build cannot honour is no schedule, never a guess', () => {
  // The safe direction: a session nobody asked for is worse than no session,
  // and the learner can always ask.
  const refused: unknown[] = [
    null, undefined, 'daily', 42,
    { kind: 'daily', hour: 25, timeZone: SYDNEY },
    { kind: 'daily', hour: -1, timeZone: SYDNEY },
    { kind: 'daily', hour: 19.5, timeZone: SYDNEY },
    { kind: 'daily', hour: '19', timeZone: SYDNEY },
    { kind: 'daily', hour: 19 },
    { kind: 'daily', hour: 19, timeZone: '' },
    { kind: 'daily', hour: 19, timeZone: 'Mars/Olympus' },
    { kind: 'weekly', hour: 19, timeZone: SYDNEY },
  ];
  for (const raw of refused) {
    assert.deepEqual(scheduleFrom(raw), DEFAULT_SCHEDULE, `accepted ${JSON.stringify(raw)}`);
  }
  assert.deepEqual(scheduleFrom({ kind: 'daily', hour: 0, timeZone: SYDNEY }),
    { kind: 'daily', hour: 0, timeZone: SYDNEY }, 'midnight is a legitimate hour');
  assert.deepEqual(scheduleFrom({ kind: 'on-demand' }), { kind: 'on-demand' });
});

test('the default is on-demand, because nobody has said yet', () => {
  assert.deepEqual(DEFAULT_SCHEDULE, { kind: 'on-demand' });
  assert.equal(scheduleFrom({}).kind, 'on-demand');
});

test('a zone is checked before it is trusted', () => {
  assert.equal(isZone(SYDNEY), true);
  assert.equal(isZone('UTC'), true);
  assert.equal(isZone('Mars/Olympus'), false);
  assert.equal(isZone(''), false);
});

test('the local zone is asked where the learner is, or not claimed at all', () => {
  const zone = localZone();
  assert.ok(zone === '' || isZone(zone), 'a zone was returned that nothing can resolve');
});

test('daylight saving is the zone’s problem, and it is handled because it is', () => {
  // Sydney is +11 in January and +10 in August. A cron pinned to one walks
  // across the learner's evening twice a year; a zone does not.
  assert.equal(hourIn(at('2026-01-22T09:00:00Z'), SYDNEY), 20);
  assert.equal(hourIn(at('2026-08-22T09:00:00Z'), SYDNEY), 19);
});
