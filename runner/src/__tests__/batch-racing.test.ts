import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonStore } from '@sb/adapters';
import { runBatch } from '../pipeline.js';
import { bench, generateBoard, sessionCount, shapeOf, storeAt } from './batch-harness.js';

/**
 * Two nightly runs racing on one store.
 *
 * The concurrency inside a run is cooperative — every stage yields only at a
 * model call — so the existing suite covers one run against a store that is
 * being written underneath it, and stops there. It does not cover two runs. The
 * platform can produce two: the nightly is the local stand-in for a Cloud Run
 * Job, and a Job the platform retries before the first attempt has actually died
 * is two attempts against one store, not one.
 *
 * The model call is still the only place a stage yields, so it is still the only
 * place an interleaving can be scheduled. `Lockstep` below turns that into a
 * real race with no clock in it: neither run passes a model call until the other
 * has reached one too, so the two runs advance in strict alternation through
 * every stage they share.
 *
 * What comes out of it is worth stating plainly, because half of it is a
 * guarantee and half of it is not:
 *
 *  - Nothing the learner saved is lost, and nothing the ledger recorded is
 *    rewritten. Those hold.
 *  - The board stays internally consistent: no pin points at a topic that is not
 *    there, no topic claims a pin that is not there.
 *  - Two runs produce two sessions and two rounds of enrichment. That is not a
 *    bug being tolerated; it is the absence of a claim. Nothing in the pipeline
 *    or the store makes a run exclusive, and the store cannot make it so — a
 *    lease belongs to whatever schedules the job.
 *  - Two long-lived HANDLES over one file is the case that does lose data, and
 *    it loses all of it. `load` memoises per handle, so the second handle never
 *    learns the first exists and the last flush overwrites the other's whole
 *    board. Pinned here so it reads as a rule about handles rather than a
 *    surprise about runs.
 */

const RUN = { concurrency: 2 } as const;

/**
 * A meeting point at model calls. Nobody passes one until everybody has reached
 * one, and a runner that finishes releases whoever is still waiting — so a run
 * with fewer model calls than the other cannot hang the test.
 */
class Lockstep {
  private parked: (() => void)[] = [];
  private live: number;
  readonly meetings: number[] = [];

  constructor(runners: number) { this.live = runners; }

  async arrive(): Promise<void> {
    if (this.live <= 1) return;
    if (this.parked.length + 1 >= this.live) {
      this.meetings.push(this.parked.length + 1);
      for (const release of this.parked.splice(0)) release();
      return;
    }
    await new Promise<void>((resolve) => { this.parked.push(resolve); });
  }

  retire(): void {
    this.live -= 1;
    for (const release of this.parked.splice(0)) release();
  }
}

/** How many topics claim each pin. One is a partition; anything else is not. */
const claimCounts = (topics: readonly { pinIds: readonly string[] }[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const t of topics) for (const p of t.pinIds) counts.set(p, (counts.get(p) ?? 0) + 1);
  return counts;
};

// ------------------------------------------------- one store, two runs

test('two runs racing on one store lose no pin and rewrite no signal', async () => {
  const pins = generateBoard(6, 3);
  const store = storeAt('race-one-handle');
  const step = new Lockstep(2);
  const a = await bench('race-a', pins, { store, before: () => step.arrive() });
  const b = await bench('race-b', [], { store, before: () => step.arrive() });

  const [ra, rb] = await Promise.all([
    runBatch(a.deps, RUN).finally(() => step.retire()),
    runBatch(b.deps, RUN).finally(() => step.retire()),
  ]);

  assert.ok(step.meetings.length > 0, 'the two runs never actually met at a model call');

  const shape = await shapeOf(store);
  assert.equal(shape.pins, pins.length, 'no pin the learner saved was lost to the race');
  assert.deepEqual([...shape.orphanPins], [], 'no pin points at a topic that is not on the board');
  assert.deepEqual([...shape.danglingTopicPins], [], 'no topic claims a pin that is not in the store');
  assert.ok(ra.reports.length > 0 && rb.reports.length > 0, 'both runs ran');
});

test('NOT PROMISED: two racing runs duplicate the partition rather than corrupting it', async () => {
  // The concrete shape of "no exclusivity", measured rather than described. Both
  // runs read a board with no topics on it, both mint fresh ids for the same
  // groups, and both write. What comes out is every group twice: eight topics
  // over eight pins where one run alone builds four.
  //
  // The failure mode matters as much as the count. Nothing is torn — every pin
  // is claimed, every claim resolves, every pin's own `topicId` names exactly one
  // live topic — so the learner sees each subject listed twice rather than a
  // broken board, and the next single run's clusterer sees the duplicates as
  // existing topics to merge into. Duplication is recoverable; a torn board is
  // not, and this is the line the store does hold.
  const pins = generateBoard(8, 4);
  const store = storeAt('race-partition');
  const step = new Lockstep(2);
  const a = await bench('race-p-a', pins, { store, before: () => step.arrive() });
  const b = await bench('race-p-b', [], { store, before: () => step.arrive() });

  await Promise.all([
    runBatch(a.deps, RUN).finally(() => step.retire()),
    runBatch(b.deps, RUN).finally(() => step.retire()),
  ]);

  const topics = await store.listTopics();
  assert.equal(topics.length, 8, 'each of the four groups was built by each of the two runs');
  assert.deepEqual([...new Set(claimCounts(topics).values())], [2],
    'every pin is claimed exactly twice — not once, and not zero times');

  // The half that IS promised.
  const stored = await store.listPins();
  const live = new Set(topics.map((t) => t.id));
  assert.equal(stored.length, pins.length, 'no pin was lost between two writers');
  assert.ok(stored.every((p) => p.topicId !== null && live.has(p.topicId)),
    'and every pin\'s own membership names a topic that is on the board');
});

test('a pin deleted while its enrichment is in flight is not written back', async () => {
  // The narrowest form of the defect the delete storm found. The forage stage
  // holds a pin across the longest await in the run and then upserts it, so a
  // delete landing in that window used to be undone — the pin reappeared, with
  // an enrichment attached, on a board it had already been cascaded off.
  //
  // The existing mid-run deletion cover in `batch-integrity.test.ts` deletes
  // at `analyse`, which is after forage has finished, so it could not see this.
  //
  // The re-read closes the window down to the two awaits between `getPin` and
  // `putPin`; the store has no compare-and-set, so it cannot be closed further
  // from here.
  const pins = generateBoard(4, 2);
  const store = storeAt('race-enrich-delete');
  let deleted = false;
  const b = await bench('race-e', pins, {
    store,
    before: async (stage) => {
      if (stage !== 'forage' || deleted) return;
      deleted = true;
      await store.deletePin('p0');
    },
  });

  await runBatch(b.deps, RUN);

  assert.ok(deleted, 'the delete never landed, so this proved nothing');
  assert.equal(await store.getPin('p0'), null, 'an enrichment resurrected a deleted pin');
  const shape = await shapeOf(store);
  assert.equal(shape.pins, 3);
  assert.deepEqual([...shape.danglingTopicPins], []);
  assert.deepEqual([...shape.orphanPins], []);
});

test('a nightly run racing a delete storm leaves a board with no dangling reference', async () => {
  // The two reports meeting each other: a run in flight while the learner is
  // deleting. Every model call is a chance for a delete to land mid-stage, and
  // the delete cascade rewrites exactly the collections the run is reading.
  const pins = generateBoard(8, 4);
  const store = storeAt('race-delete');
  const doomed = ['p0', 'p3', 'p5'];
  let next = 0;

  const b = await bench('race-d', pins, {
    store,
    before: async () => {
      const id = doomed[next++];
      if (id !== undefined) await store.deletePin(id);
    },
  });
  await runBatch(b.deps, RUN);

  const shape = await shapeOf(store);
  assert.equal(shape.pins, pins.length - doomed.length, 'a pin deleted mid-run stays deleted');
  assert.deepEqual([...shape.orphanPins], [], 'no pin survived pointing at a topic that is gone');
  assert.deepEqual([...shape.danglingTopicPins], [],
    'SB-43: no topic still claims a pin the learner deleted while the run was reading it');
  const session = await store.latestSession();
  const liveTopics = new Set((await store.listTopics()).map((t) => t.id));
  for (const section of session?.sections ?? []) {
    assert.ok(liveTopics.has(section.topicId),
      'and the session the learner is shown does not cite a topic the storm took');
  }
});

test('the signal ledger only ever grows under a race', async () => {
  const pins = generateBoard(6, 3);
  const store = storeAt('race-ledger');
  const before = await store.listSignals();

  const step = new Lockstep(2);
  const a = await bench('race-l-a', pins, { store, before: () => step.arrive() });
  const b = await bench('race-l-b', [], { store, before: () => step.arrive() });
  await Promise.all([
    runBatch(a.deps, RUN).finally(() => step.retire()),
    runBatch(b.deps, RUN).finally(() => step.retire()),
  ]);

  const after = await store.listSignals();
  assert.ok(after.length >= before.length, 'the ledger is append-only, race or no race');
  assert.equal(new Set(after.map((s) => s.id)).size, after.length,
    'and no row was written twice under one id');
});

test('NOT PROMISED: two racing runs build two sessions and enrich twice', async () => {
  // Stated as an absence rather than asserted as a guarantee. Neither the store
  // nor the pipeline holds a lease, so two runs do the same work twice: the
  // learner would get two sessions for one night, and every pin would be sent
  // to the model twice. Whatever stops that has to be the thing that starts the
  // job, and this test is the record of why it is needed.
  const pins = generateBoard(4, 2);
  const store = storeAt('race-sessions');
  const step = new Lockstep(2);
  const a = await bench('race-s-a', pins, { store, before: () => step.arrive() });
  const b = await bench('race-s-b', [], { store, before: () => step.arrive() });

  await Promise.all([
    runBatch(a.deps, RUN).finally(() => step.retire()),
    runBatch(b.deps, RUN).finally(() => step.retire()),
  ]);

  assert.equal(await sessionCount(store), 2,
    'two runs, two sessions — exclusivity is not something this store can offer');
  assert.equal(a.llm.foragedPins() + b.llm.foragedPins(), pins.length * 2,
    'and every pin was enriched once per run, not once');
  // The learner is at least shown one of them rather than a merge of both.
  const latest = await store.latestSession();
  assert.ok(latest, 'and one whole session is what the panel reads');
  assert.ok(latest.sections.length > 0);
});

// ------------------------------------------------ one file, two handles

test('NOT PROMISED: two runs on two handles over one file, and the last flush wins', async () => {
  // The case the nightly lane suspected, and it is worse than a race inside one
  // handle: nothing is interleaved at all. Each handle loaded the file once and
  // never looks again, so the two runs build two whole boards and the file ends
  // as whichever finished last. Everything the other run did is gone — not
  // corrupted, not merged, gone.
  const file = join(mkdtempSync(join(tmpdir(), 'sb-race-file-')), 'db.json');
  const pins = generateBoard(4, 2);
  const seed = new JsonStore(file);
  for (const p of pins) await seed.putPin(p);

  const step = new Lockstep(2);
  const a = await bench('race-f-a', [], { store: new JsonStore(file), before: () => step.arrive() });
  const b = await bench('race-f-b', [], { store: new JsonStore(file), before: () => step.arrive() });

  await Promise.all([
    runBatch(a.deps, RUN).finally(() => step.retire()),
    runBatch(b.deps, RUN).finally(() => step.retire()),
  ]);

  // The file is still a store, and still a coherent one — the temp-file-per-
  // handle rule is what keeps that true while two handles write at once.
  const reopened = new JsonStore(file);
  const shape = await shapeOf(reopened);
  assert.equal(shape.pins, pins.length, 'the pins survive: both runs wrote all of them');
  assert.deepEqual([...shape.orphanPins], [], 'and the surviving board is internally consistent');
  assert.deepEqual([...shape.danglingTopicPins], []);
  assert.deepEqual([...new Set(claimCounts(await reopened.listTopics()).values())], [1],
    'the surviving board is a clean partition — one run\'s work, whole');

  // One session, not two: the loser's session went with the loser's whole board.
  assert.equal(await sessionCount(reopened), 1,
    'a whole run\'s work is discarded by the other handle\'s flush — two handles is not two writers');
});
