import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NAMING_BATCH } from '@sb/core';
import { runBatch } from '../pipeline.js';
import { bench, generateBoard, makePin, shapeOf } from './batch-harness.js';

/**
 * The whole run at 150 and 300 pins.
 *
 * `scripts/eval-scale.mjs` takes the partition to 80 pins and is the only scale
 * evidence in the repo — it measures clustering quality, calls no other stage,
 * and is not in the suite. What is untested above 21 pins is the RUN: whether
 * every pin still reaches a topic, whether the session stays the size the
 * learner asked for rather than growing with the board, and whether a second
 * night over 300 pins is still the no-op it is at six.
 *
 * Wall-times are measured and printed, and deliberately not asserted. A
 * threshold in a test here would be a threshold on whatever machine CI happens
 * to run on, and would go red for a reason that has nothing to do with the
 * product. What IS asserted is the shape of the growth: the number of model
 * calls a run makes is a function of new pins and new topics, not of board
 * size, which is the property that decides whether this is affordable at all.
 */

/**
 * `workCap: null` — the unpaced shape, deliberately.
 *
 * These tests are about the **growth law**: whether the cost of a run is a
 * function of new pins and new topics rather than of board size, and whether a
 * settled board is a no-op. A per-run cap is the product's answer to that law
 * being linear, and measuring the law through the cap would measure the cap.
 * `semester-scale.test.ts` is the other half and asserts the cap instead.
 */
const RUN = { concurrency: 4, workCap: null } as const;

/** Printed, not asserted. `--test-reporter=spec` shows it; CI keeps it. */
const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const t = Date.now();
  const out = await fn();
  console.log(`    [scale] ${label}: ${Date.now() - t}ms`);
  return out;
};

const TIERS = [150, 300] as const;

for (const size of TIERS) {
  test(`${size} pins: every pin lands on a topic, and the board is coherent`, async () => {
    const groups = size / 10;
    const b = await bench(`scale-${size}`, generateBoard(size, groups));

    const { reports, topics } = await timed(`${size} cold run`, () => runBatch(b.deps, RUN));

    assert.deepEqual(reports.filter((r) => r.failed).map((r) => r.stage), [],
      'no stage degrades on size alone');
    assert.equal(topics.length, groups, `${groups} sets in, ${groups} topics out`);

    const s = await shapeOf(b.store);
    assert.equal(s.pins, size, 'no pin is lost at scale');
    assert.deepEqual(s.orphanPins, [], 'and none is left pointing at a topic that is not there');
    assert.deepEqual(s.danglingTopicPins, [], 'and no topic claims a pin that is not there');
    assert.equal(
      topics.reduce((a, t) => a + t.pinIds.length, 0), size,
      'the topics partition the board exactly — no pin in two, none in none');
  });

  test(`${size} pins: the session is budgeted, not proportional`, async () => {
    // The property that decides whether this scales as a product rather than
    // as a program. A learner with 300 pins gets the same fifteen minutes as a
    // learner with six; the board grows and the flash-sized move does not.
    const b = await bench(`scale-session-${size}`, generateBoard(size, size / 10));
    const { session } = await runBatch(b.deps, RUN);

    assert.equal(session?.insufficient, false);
    assert.equal(session?.targetMinutes, 3);
    assert.equal(session?.sections.length, 1,
      'one focused section at the default three minutes, whatever is behind it');
  });

  test(`${size} pins: the second night costs no model calls beyond verification`, async () => {
    const b = await bench(`scale-idem-${size}`, generateBoard(size, size / 10));
    await runBatch(b.deps, RUN);
    const first = await shapeOf(b.store);
    const afterFirst = b.llm.calls.length;

    await timed(`${size} warm run`, () => runBatch(b.deps, RUN));
    const second = await shapeOf(b.store);
    const warm = b.llm.calls.length - afterFirst;

    assert.deepEqual(second.topics, first.topics, 'the board did not move');
    assert.equal(second.pins, first.pins);
    assert.equal(b.llm.foragedPins(), size, 'not one pin was re-enriched');
    // The naming pass is chunked at `NAMING_BATCH`, so a cold run over a board
    // with thirty new topics on it costs three calls rather than one. The claim
    // worth holding is not "one call" — it never was — it is that a **settled**
    // board costs none: nothing is renamed on the second night.
    assert.equal(b.llm.countOf('cluster'), Math.ceil((size / 10) / NAMING_BATCH),
      'the cold run named every new topic, in chunks');
    /**
     * A warm run is: survey, analyse, statements, prospect, compose, and the
     * one verify the flash-sized session can need. Fixed, and independent of
     * how many pins are on the board, which is the property this asserts.
     *
     * Six since the night scout. Its one call is here because these boards
     * carry a real gap — every pin's enrichment names the same assumed
     * concept and no topic covers it — and it is ONE call rather than two
     * because the stub proposes nothing, so there is nothing to name a lead
     * for. What matters for scale is unchanged: the gap list is capped at
     * `PROSPECT_MAX_GAPS` and the stage at `PROSPECT_MAX_MODEL_CALLS`, so a
     * 300-pin board and a six-pin one pay the same for it.
     */
    assert.equal(warm, 6, `a settled ${size}-pin board costs six calls, the same as a settled six-pin one`);
  });
}

test('the cold-run cost is linear in new pins and new topics, not quadratic in either', async () => {
  /**
   * Measured rather than reasoned about. Forage is one call per unenriched pin
   * and naming is one call for all new topics, so doubling the board doubles
   * the pins asked about and adds nothing else.
   *
   * `foragedPins()` rather than `countOf('forage')`, because the claim is
   * about pins: it survives whether the Forager asks about them one at a time
   * or in chunks, and it went on holding through a batching experiment that
   * was measured and then held back.
   */
  const small = await bench('scale-cost-150', generateBoard(150, 15));
  await runBatch(small.deps, RUN);
  const big = await bench('scale-cost-300', generateBoard(300, 30));
  await runBatch(big.deps, RUN);

  assert.equal(small.llm.foragedPins(), 150);
  assert.equal(big.llm.foragedPins(), 300);
  assert.equal(small.llm.countOf('cluster'), Math.ceil(15 / NAMING_BATCH));
  assert.equal(big.llm.countOf('cluster'), Math.ceil(30 / NAMING_BATCH),
    'thirty new topics are named in ceil(30/NAMING_BATCH) calls, not one and not thirty');
  const notPerItem = (x: typeof small) =>
    x.llm.calls.length - x.llm.countOf('forage') - x.llm.countOf('cluster');
  assert.equal(notPerItem(big), notPerItem(small),
    'everything that is neither per-pin nor per-new-topic costs the same at 300 pins as at 150');
});

test('a 300-pin board grown 30 pins at a time never reconsiders a pin that already has a topic', async () => {
  // The incremental path at scale, which is how a real board actually arrives.
  // `eval-scale.mjs` asserts this for the partition in isolation; this asserts
  // it for the run, through the store, with every stage in between.
  const b = await bench('scale-incremental', generateBoard(30, 3));
  await runBatch(b.deps, RUN);

  let expected = 30;
  const before = new Map((await b.store.listPins()).map((p) => [p.id, p.topicId]));
  for (let batch = 1; batch <= 9; batch++) {
    for (let i = 0; i < 30; i++) {
      await b.store.putPin(makePin(`b${batch}-${String(i).padStart(2, '0')}`, `k${i % 3}`));
    }
    expected += 30;
    const { reports } = await runBatch(b.deps, RUN);
    assert.match(String(reports.find((r) => r.stage === 'forage')?.detail), /^30 pins/,
      `batch ${batch}: only the new pins are enriched`);
  }

  const after = await b.store.listPins();
  assert.equal(after.length, expected);
  for (const [id, topicId] of before) {
    assert.equal(after.find((p) => p.id === id)?.topicId, topicId,
      `${id} moved topic on a later night — attach-only is what stops a learner's history detaching`);
  }
  assert.equal((await b.store.listTopics()).length, 3,
    'and the three sets stayed three topics through nine nights of growth');
  assert.deepEqual((await shapeOf(b.store)).orphanPins, []);
});
