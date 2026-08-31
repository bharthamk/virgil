/**
 * A run needs a reason.
 *
 * Scheduling alone is insufficient: the board must contain material that is
 * actually due for work.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_FLOOR, DEFAULT_WORK_CAP, SURVEY_FLOOR, WORK_CAP_FLOOR,
  autoThreshold, estimateCalls, leanNight, paceWork, pacingLine, planBatch, STAGE_CALLS,
  workCapFrom,
} from '../domain/batch.js';

const input = (over: Partial<Parameters<typeof planBatch>[0]> = {}) =>
  planBatch({ unprocessedPins: 0, dueForRevision: 0, ...over });

// ------------------------------------------------------- the money question

test('nothing new means nothing is bought', () => {
  const d = input();
  assert.equal(d.run, false);
  assert.equal(d.because, 'nothing-new');
  assert.match(d.line, /Nothing new to process/);
});

test('a week of pinning nothing costs nothing, however much has decayed', () => {
  // The exact shape of the waste: a learner who pinned nothing for a week
  // bought a session every day of it, because an arrived hour was the whole
  // decision.
  const d = input({ dueForRevision: 9 });
  assert.equal(d.run, false);
  // Decay is worth MENTIONING. It is not worth spending somebody's money on
  // without being asked.
  assert.match(d.line, /due for a refresh whenever you want one/);
});

test('a person outranks the rule, including "nothing new"', () => {
  // Somebody who presses Process having pinned nothing gets the revision run
  // they are asking for. It is theirs to ask for.
  const d = input({ asked: true, dueForRevision: 2 });
  assert.equal(d.run, true);
  assert.equal(d.because, 'asked');
});

test('a pause stops everything, asked or not', () => {
  assert.equal(input({ paused: true, asked: true }).run, false);
  assert.equal(input({ paused: true, unprocessedPins: 50 }).because, 'paused');
});

// -------------------------------------------------------------- the batching

test('automatic is off unless the learner turned it on', () => {
  // A learner who has not asked for automatic anything is not charged for it.
  const d = input({ unprocessedPins: 40 });
  assert.equal(d.run, false);
  assert.match(d.line, /40 things waiting/);
  // Told apart from "nothing new". The first draft reported forty waiting pins
  // as `nothing-new`, which contradicted the sentence printed beside it — found
  // by reading a real payload rather than by a test, because the test checked
  // `run` and the line and not the reason.
  assert.equal(d.because, 'manual-only');
});

test('"nothing is here" and "automatic is off" are different facts', () => {
  assert.equal(input({ unprocessedPins: 0 }).because, 'nothing-new');
  assert.equal(input({ unprocessedPins: 5 }).because, 'manual-only');
  assert.equal(input({ unprocessedPins: 1, autoAfter: 9 }).because, 'waiting-for-more');
});

test('pinning as you go lines things up and processes them in one pass', () => {
  // Pins queue until the configured threshold, then run in one batch.
  assert.equal(input({ unprocessedPins: 4, autoAfter: 5 }).run, false);
  assert.equal(input({ unprocessedPins: 4, autoAfter: 5 }).because, 'waiting-for-more');
  const go = input({ unprocessedPins: 5, autoAfter: 5 });
  assert.equal(go.run, true);
  assert.equal(go.because, 'enough-piled-up');
});

test('one pin is never a batch, whatever the learner sets', () => {
  // Processing one pin alone IS the per-pin model call that batching exists to
  // avoid, so the floor is not negotiable downwards.
  assert.equal(autoThreshold(1), AUTO_FLOOR);
  assert.equal(autoThreshold(2), AUTO_FLOOR);
  assert.equal(autoThreshold(10), 10);
  assert.equal(input({ unprocessedPins: 1, autoAfter: 1 }).run, false);
  assert.equal(input({ unprocessedPins: AUTO_FLOOR, autoAfter: 1 }).run, true);
});

test('a nonsense threshold reads as off rather than as always', () => {
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
    assert.equal(autoThreshold(bad), null, String(bad));
  }
  assert.equal(input({ unprocessedPins: 99, autoAfter: 0 }).run, false);
});

test('the count reads as a count of their own work, never as a debt', () => {
  const lines = [
    input({ unprocessedPins: 1 }).line,
    input({ unprocessedPins: 7 }).line,
    input({ unprocessedPins: 7, autoAfter: 5 }).line,
    input({ dueForRevision: 3 }).line,
  ].join(' ');
  assert.ok(!/left to|remaining|clear|behind|overdue|unread/i.test(lines), lines);
  assert.match(input({ unprocessedPins: 1 }).line, /1 thing waiting/);
});

// ----------------------------------------------------------------- the cost

test('what a run costs is knowable before it is bought', () => {
  /**
   * "Saves money" is a claim a learner should be able to check rather than
   * take, so the number is on the screen next to the button.
   *
   * **It was wrong, and wrong in the one direction that matters.** The old
   * form was `6 + unprocessedPins`, and it said of itself that it was an upper
   * bound — *"costing more is a broken promise"*. Three things made it a
   * floor instead:
   *
   *  - **Verify runs once per composed section**, not once. `verifySections`
   *    fans out over the sections with `mapLimit`, so a session teaching three
   *    topics buys three checks. The old constant counted one.
   *  - **Forage runs on pins owed enrichment, not on unprocessed pins.** Those
   *    are different sets: a pin can have a topic and no enrichment.
   *  - **The partition's embedding call was not counted at all.**
   *
   * The terms are now taken separately, because they scale differently and a
   * single constant hid that from the one person who most needs to see it.
   */
  const fixed = estimateCalls({ owedEnrichment: 0, topics: 0, hasPins: false });
  assert.equal(fixed, STAGE_CALLS, 'an empty board still pays for the stages that always run');

  /**
   * Enrichment is one call per pin owed, and it is the term that grows with
   * the learner. `FORAGE_BATCH` would make it a fifth of that; it is measured
   * and held back rather than shipped, so the estimate charges what the run
   * actually pays. Quoting the cheaper number for a run that does not take it
   * would be the same class of mistake this whole function was fixed for.
   */
  assert.equal(estimateCalls({ owedEnrichment: 5, topics: 0, hasPins: true }),
    STAGE_CALLS + 5 + 1, 'five pins owed, five calls, plus the embedding');

  // Verify is per topic taught. Two topics is two checks, and the old formula
  // charged for one however many there were.
  assert.equal(
    estimateCalls({ owedEnrichment: 0, topics: 4, hasPins: true })
      - estimateCalls({ owedEnrichment: 0, topics: 3, hasPins: true }),
    1, 'each extra topic is another section, and each section is another check');

  // The Surveyor is skipped on a board too small for an ordering to mean
  // anything, so crossing the floor costs a call the board below it does not.
  assert.equal(
    estimateCalls({ owedEnrichment: 0, topics: SURVEY_FLOOR, hasPins: true })
      - estimateCalls({ owedEnrichment: 0, topics: SURVEY_FLOOR - 1, hasPins: true }),
    2, 'one more section to check, and the Surveyor arriving');

  // The embedding call is a model call and is counted as one, cheap as it is.
  assert.equal(
    estimateCalls({ owedEnrichment: 0, topics: 0, hasPins: true })
      - estimateCalls({ owedEnrichment: 0, topics: 0, hasPins: false }),
    1, 'the partition asks an embedder, which is a model');

  /**
   * With nine pins owed enrichment and one topic, nine forage calls, one
   * embedding, and the five stages that always run total
   * **15**, against the 14 the screen used to promise. The Surveyor is the
   * sixth and does not run on a board of one topic, which is the other half of
   * why the number moved.
   *
   * The real run is still a little higher, because clustering eight untopiced
   * pins makes more topics and every one of them is another verifier call.
   * That is the honest limit of any estimate taken before the partition runs,
   * and it is why this is an estimate and no longer claims to be a bound.
   */
  assert.equal(estimateCalls({ owedEnrichment: 9, topics: 1, hasPins: true }), 15,
    'nine to enrich, one embedding, and the five stages that always run');

  assert.equal(estimateCalls({ owedEnrichment: -2, topics: -2, hasPins: false }), STAGE_CALLS,
    'nonsense counts do not make the estimate smaller than the run');

  assert.equal(
    estimateCalls({
      owedEnrichment: 0, topics: 3, hasPins: true, globalLearnerCorrection: true,
    }),
    estimateCalls({ owedEnrichment: 0, topics: 3, hasPins: true }) - 2,
    'a global correction quotes neither the Analyst nor Registrar call the pipeline skips',
  );

  assert.equal(
    estimateCalls({ owedEnrichment: 0, topics: 3, hasPins: true, sessionMinutes: 5 }),
    estimateCalls({ owedEnrichment: 0, topics: 3, hasPins: true }) - 2,
    'a five-minute session quotes one checked section rather than every topic on the board',
  );

  /**
   * SB-285's conditional, quoted the way the night scout's second call is:
   * at its cap on a board that could buy it, and not at all on one that
   * cannot. A run whose first ask comes back full comes in under the number.
   */
  assert.equal(
    estimateCalls({ owedEnrichment: 0, topics: 3, hasPins: true, analyseSecondAsk: true }),
    estimateCalls({ owedEnrichment: 0, topics: 3, hasPins: true }) + 1,
    'a board with material to observe may buy the Analyst one more ask',
  );
  assert.equal(
    estimateCalls({
      owedEnrichment: 0, topics: 3, hasPins: true,
      analyseSecondAsk: true, globalLearnerCorrection: true,
    }),
    estimateCalls({ owedEnrichment: 0, topics: 3, hasPins: true, globalLearnerCorrection: true }),
    'a stage the correction skips before the model boundary cannot be asked twice',
  );
});

// ----------------------------------------------------------- the lean night

test('a lean night is all three counts at zero, and nothing less', () => {
  /**
   * SB-285. The run this exists for made 152 seconds of model calls, produced
   * no observation, wrote no statement and raised no proposal, and every stage
   * line beside it was lawful. The conjunction is the definition: any one of
   * the three producing something means somebody downstream was fed.
   */
  assert.equal(leanNight({ observations: 0, statements: 0, proposals: 0 }), true);
  assert.equal(leanNight({ observations: 2, statements: 0, proposals: 0 }), false,
    'a night that observed and wrote nothing is a night whose observations were withheld');
  assert.equal(leanNight({ observations: 0, statements: 3, proposals: 0 }), false);
  assert.equal(leanNight({ observations: 0, statements: 0, proposals: 1 }), false,
    'the scout found something to offer, so the night was not empty-handed');
});

// -------------------------------------------------------------- the pacing

/**
 * A run needs a reason decided WHETHER to spend. This decides HOW MUCH.
 *
 * The term `estimateCalls` names as the only one that grows with the board is
 * `owedEnrichment`, and a course drop moves it by three hundred in one gesture.
 * These are the tests for the cap that keeps that bounded.
 */

test('a queue smaller than the cap is not paced at all', () => {
  // The property that chose the default: somebody who has not dropped a course
  // must never meet this. Every board in this repository's history is smaller
  // than the cap, so every one of those nights is the night it always was.
  const pacing = paceWork({ waiting: 9, cap: DEFAULT_WORK_CAP });
  assert.deepEqual(pacing, { take: 9, remaining: 0, paced: false });
  assert.equal(pacingLine(pacing), '', 'and nothing is said about pacing that did not happen');
});

test('a queue larger than the cap is cut, and the remainder is stated', () => {
  const pacing = paceWork({ waiting: 300, cap: 50 });
  assert.deepEqual(pacing, { take: 50, remaining: 250, paced: true });
  assert.match(pacingLine(pacing), /250 left for the next run \(capped at 50\)/);
});

test('a queue exactly the size of the cap is finished, not paced', () => {
  // The boundary that decides whether the last night of a semester says "0 left
  // for the next run" or says nothing. Nothing is the honest answer: there is no
  // next run's worth of anything.
  assert.deepEqual(paceWork({ waiting: 50, cap: 50 }), { take: 50, remaining: 0, paced: false });
});

test('no cap takes the lot, and says nothing about it', () => {
  const pacing = paceWork({ waiting: 300, cap: null });
  assert.deepEqual(pacing, { take: 300, remaining: 0, paced: false });
});

test('nonsense counts do not produce a negative remainder', () => {
  assert.deepEqual(paceWork({ waiting: -4, cap: 10 }), { take: 0, remaining: 0, paced: false });
  assert.deepEqual(paceWork({ waiting: 7.6, cap: 3 }), { take: 3, remaining: 4, paced: true });
});

test('an operator can switch the cap off, and cannot switch it off by accident', () => {
  // `0` is a deliberate choice and means no cap — a self-hoster with no metered
  // provider genuinely wants it. Everything else that is not a usable number is
  // the default, because a typo in a YAML file must not silently remove a
  // protection at three in the morning.
  assert.equal(workCapFrom('0'), null);
  assert.equal(workCapFrom(0), null);
  assert.equal(workCapFrom(null), null, 'an explicit null is an explicit choice');

  assert.equal(workCapFrom(undefined), DEFAULT_WORK_CAP);
  assert.equal(workCapFrom(''), DEFAULT_WORK_CAP);
  assert.equal(workCapFrom('fifty'), DEFAULT_WORK_CAP);
  assert.equal(workCapFrom('  120  '), 120, 'and a real number is honoured, whitespace and all');
});

test('a cap below the floor is raised to it, because one item is not a batch', () => {
  // `AUTO_FLOOR` refuses to call one pin a batch. This refuses to call one item
  // a run, and for the same reason: a cap of one is the per-item model call that
  // batching exists to avoid, arrived at from the other direction.
  assert.equal(workCapFrom(1), WORK_CAP_FLOOR);
  assert.equal(workCapFrom(WORK_CAP_FLOOR - 1), WORK_CAP_FLOOR);
  assert.equal(workCapFrom(WORK_CAP_FLOOR), WORK_CAP_FLOOR);
});

test('the cap is far above every board this product has actually been run on', () => {
  // Stated as an assertion rather than as a comment, because the number is only
  // defensible while it stays true. The golden key is 21 pins and the board the
  // 2026-08-22 estimate was found on was 9.
  assert.ok(DEFAULT_WORK_CAP > 21,
    'the cap is inside the size of an ordinary board, so ordinary nights are now paced');
  assert.ok(DEFAULT_WORK_CAP < 120,
    'the cap is above a semester, so the thing it exists for never meets it');
});
