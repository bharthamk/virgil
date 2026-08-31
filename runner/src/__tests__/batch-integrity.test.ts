import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runBatch } from '../pipeline.js';
import {
  ScriptedLlm, bench, generateBoard, makePin, shapeOf, sig,
  type Stage,
} from './batch-harness.js';

/**
 * The learner is awake while the run is on.
 *
 * The nightly job is scheduled, not triggered — nothing stops a pin arriving,
 * a topic being merged, an answer being contested or a preference changing
 * while it is mid-flight, and the run reads the board a stage at a time rather
 * than out of one snapshot. So each stage sees a slightly different board from
 * the one before it, and the question is which of those interleavings the
 * design actually survives.
 *
 * Both halves are worth writing down. Where the design makes a promise, this
 * file holds it. Where it does not — where the honest answer is "the run keeps
 * going and the next one picks it up" — that is asserted too, in the shape it
 * actually has, so the gap is documented rather than assumed away.
 *
 * The mutation is scheduled by hooking the model call for a stage, which is the
 * only place a test can reliably interleave with a run without a real clock.
 */

const RUN = { concurrency: 2 } as const;

/** Run a mutation the first time `at` reaches the model, before it answers. */
const during = (at: Stage, mutate: () => Promise<void>) => {
  let fired = false;
  return {
    // Awaited by the stub before it answers, so the mutation is fully committed
    // by the time the stage resumes. A fire-and-forget hook would make every
    // assertion below a race with the run rather than a statement about it.
    hook: async (stage: Stage | null) => {
      if (stage !== at || fired) return;
      fired = true;
      await mutate();
    },
    ran: () => { assert.equal(fired, true, `the mutation never ran — no ${at} call to hook`); },
  };
};

// ------------------------------------------------------- a pin arrives mid-run

test('a pin saved after the run has read the board is not lost, and lands on the next run', async () => {
  const b = await bench('mid-pin', generateBoard(6, 3));
  await runBatch(b.deps, RUN);

  // Hooked on `analyse`, which is past the cluster stage's read of the board —
  // the interleaving where the run has already decided this run's partition.
  const late = during('analyse', async () => { await b.store.putPin(makePin('late', 'k0')); });
  const second = await runBatch({ ...b.deps, llm: new ScriptedLlm({ before: late.hook }) }, RUN);
  late.ran();

  // This run cannot see it: the cluster stage read the board before the pin
  // existed, and there is no second pass. That is the design, not a defect —
  // what the design does claim is that the pin is never lost and never left
  // pointing at nothing.
  const mid = await shapeOf(b.store);
  assert.equal(mid.pins, 7, 'the pin is in the store the moment it is saved');
  assert.deepEqual(mid.danglingTopicPins, []);
  assert.equal(second.reports.every((r) => r.stage === 'cluster' ? !r.failed : true), true);

  const third = await runBatch(b.deps, RUN);
  const after = await shapeOf(b.store);
  assert.equal(after.pins, 7);
  assert.deepEqual(after.orphanPins, [], 'and by the next run it is on a topic');
  assert.equal((await b.store.getPin('late'))?.topicId !== null, true);
  assert.equal(after.topics.length, 3, 'attached to the set it belongs to rather than seeding a rival');
  assert.match(String(third.reports.find((r) => r.stage === 'forage')?.detail), /^1 pins/,
    'and it is the only pin the retry night has to enrich');
});

test('a pin saved during compose does not corrupt the session being written', async () => {
  const b = await bench('mid-pin-compose', generateBoard(6, 3));
  await runBatch(b.deps, RUN);

  const late = during('compose', async () => { await b.store.putPin(makePin('late', 'k9')); });
  const { session } = await runBatch({ ...b.deps, llm: new ScriptedLlm({ before: late.hook }) }, RUN);
  late.ran();

  const topicIds = new Set((await b.store.listTopics()).map((t) => t.id));
  for (const s of session?.sections ?? []) {
    assert.ok(topicIds.has(s.topicId), 'every section names a topic that is on the board');
  }
  assert.equal((await b.store.getPin('late'))?.topicId, null,
    'the new pin is untouched by a run that had already decided what this run is');
});

// ----------------------------------------------------- a merge arrives mid-run

test('a merge landing mid-run cannot write a pin back onto the retired topic', async () => {
  // `putPin` resolves through the alias map for exactly this case: the cluster
  // stage read the board before the merge and is writing membership after it.
  const b = await bench('mid-merge-pin', generateBoard(6, 3));
  await runBatch(b.deps, RUN);
  const [keep, absorb] = await b.store.listTopics();
  assert.ok(keep && absorb);

  const merge = during('forage', async () => { await b.store.mergeTopics(keep.id, absorb.id); });
  await b.store.putPin(makePin('late', 'k1'));
  await runBatch({ ...b.deps, llm: new ScriptedLlm({ before: merge.hook }) }, RUN);
  merge.ran();

  const pins = await b.store.listPins();
  assert.equal(pins.some((p) => p.topicId === absorb.id), false,
    'no pin is left on the id the learner merged away');
  assert.deepEqual((await shapeOf(b.store)).orphanPins, [],
    'and none is left pointing at a topic that is no longer on the board');
});

test('a merge landing between the cluster read and the cluster write fails the stage loudly', async () => {
  // `putTopic` throws on an absorbed id rather than resurrecting it. That makes
  // this interleaving a degraded stage, not silent damage — the run keeps going
  // and the board is whatever the merge left, which is the learner's own
  // decision and the right thing to be standing on.
  const b = await bench('mid-merge-write', generateBoard(6, 3));
  await runBatch(b.deps, RUN);
  const before = await b.store.listTopics();
  const [keep, absorb] = before;
  assert.ok(keep && absorb);

  const merge = during('forage', async () => { await b.store.mergeTopics(keep.id, absorb.id); });
  await b.store.putPin(makePin('late', 'k1'));
  const { reports } = await runBatch({ ...b.deps, llm: new ScriptedLlm({ before: merge.hook }) }, RUN);
  merge.ran();

  const cluster = reports.find((r) => r.stage === 'cluster');
  if (cluster?.failed) {
    assert.match(String(cluster.detail), /cannot be written/,
      'and it says which topic and why, rather than failing anonymously');
  }
  const after = await b.store.listTopics();
  assert.equal(after.some((t) => t.id === absorb.id), false, 'the retired id never comes back');
  assert.equal(after.some((t) => t.id === keep.id), true, 'and the survivor is still the survivor');
  assert.deepEqual(await b.store.topicAliases(), { [absorb.id]: keep.id },
    'the alias the merge wrote is intact after the run');

  // The night after: whatever the interleaved run did or did not manage, the
  // board settles and every pin has a topic.
  await runBatch(b.deps, RUN);
  const settled = await shapeOf(b.store);
  assert.deepEqual(settled.orphanPins, []);
  assert.deepEqual(settled.danglingTopicPins, []);
  assert.equal(settled.pins, 7);
});

test('a learner split landing at the cluster write is not folded back into the old topic', async () => {
  const b = await bench('mid-split-write', generateBoard(6, 3));
  await runBatch(b.deps, RUN);
  const original = (await b.store.listTopics()).find((topic) => topic.pinIds.length >= 2)!;
  const movedPin = original.pinIds[0]!;
  const mutateTopic = b.store.mutateTopic!.bind(b.store);
  let created: Awaited<ReturnType<typeof b.store.splitTopic>> | null = null;
  b.store.mutateTopic = async (id, change) => {
    if (id === original.id && !created) {
      created = await b.store.splitTopic(original.id, [movedPin], 'Learner split');
    }
    return mutateTopic(id, change);
  };

  await runBatch(b.deps, RUN);

  assert.ok(created, 'the split did not land in the cluster write window');
  const split = (await b.store.listTopics()).find((topic) => topic.label === 'Learner split')!;
  assert.equal((await b.store.getTopic(original.id))?.pinIds.includes(movedPin), false);
  assert.deepEqual(split.pinIds, [movedPin]);
  assert.equal((await b.store.getPin(movedPin))?.topicId, split.id);
});

test('a merged history is still read as one by a run that started before the merge', async () => {
  const b = await bench('mid-merge-comfort', generateBoard(6, 3));
  await runBatch(b.deps, RUN);
  const [keep, absorb] = await b.store.listTopics();
  assert.ok(keep && absorb);
  await b.store.appendSignal(sig('s1', keep.id, 'positive'));
  await b.store.appendSignal(sig('s2', absorb.id, 'positive'));

  const merge = during('forage', async () => { await b.store.mergeTopics(keep.id, absorb.id); });
  await b.store.putPin(makePin('late', 'k1'));
  await runBatch({ ...b.deps, llm: new ScriptedLlm({ before: merge.hook }) }, RUN);
  merge.ran();

  const signals = await b.store.listSignals(keep.id);
  assert.equal(signals.length, 2, 'both histories resolve onto the survivor');
  assert.equal((await b.store.listSignals()).length, 2, 'and the run appended nothing of its own');
});

// -------------------------------------------------- a contest arrives mid-run

test('signals invalidated mid-run are not counted by the comfort the run then writes', async () => {
  // The contest endpoint invalidates in place. The comfort stage reads the
  // ledger once, after forage and cluster, so a contest that lands before that
  // read must be honoured by the number the run stores.
  const b = await bench('mid-contest', generateBoard(6, 3));
  await runBatch(b.deps, RUN);
  const topic = (await b.store.listTopics())[0]!;
  await b.store.appendSignal(sig('w1', topic.id, 'negative'));
  await b.store.appendSignal(sig('w2', topic.id, 'negative'));

  await runBatch(b.deps, RUN);
  const contested = (await b.store.getTopic(topic.id))!;
  assert.ok(contested.comfort < 0.5, 'two wrong answers, and the number moved');

  const withdraw = during('analyse', async () => {
    await b.store.invalidateSignals('answer:sess:w1');
    await b.store.invalidateSignals('answer:sess:w2');
  });
  await runBatch({ ...b.deps, llm: new ScriptedLlm({ before: withdraw.hook }) }, RUN);
  withdraw.ran();

  const after = (await b.store.getTopic(topic.id))!;
  assert.equal(after.comfort, 0.15, 'withdrawn evidence leaves no mark on the same night it is withdrawn');
  assert.equal(after.state, 'waiting');
  assert.equal((await b.store.listSignals()).length, 2, 'the rows stay — the ledger is append-only');
});

// ------------------------------------------------ a preference changes mid-run

test('the session is built to the budget in force when compose runs, not when the run started', async () => {
  const b = await bench('mid-prefs', generateBoard(12, 6));
  const raise = during('forage', async () => {
    await b.store.putPrefs({ ...(await b.store.getPrefs()), availableMinutes: 5 });
  });
  const { session } = await runBatch({ ...b.deps, llm: new ScriptedLlm({ before: raise.hook }) }, RUN);
  raise.ran();

  assert.equal(session?.targetMinutes, 5, 'the run reads prefs inside the compose stage, on purpose');
  assert.equal(session?.sections.length, 1, 'and a five-minute budget buys one section');
});

test('a preference changed after compose has read it applies to the next run, not this one', async () => {
  // The honest half. There is no snapshot and no lock: a change that lands
  // after the read is simply tomorrow's change. Asserted so the boundary is
  // written down rather than assumed.
  const b = await bench('mid-prefs-late', generateBoard(12, 6));
  const drop = during('verify', async () => {
    await b.store.putPrefs({ ...(await b.store.getPrefs()), availableMinutes: 5 });
  });
  const { session } = await runBatch({ ...b.deps, llm: new ScriptedLlm({ before: drop.hook }) }, RUN);
  drop.ran();

  assert.equal(session?.targetMinutes, 3, 'this run is finished deciding');
  assert.equal((await b.store.getPrefs()).availableMinutes, 5);

  const next = await runBatch(b.deps, RUN);
  assert.equal(next.session?.targetMinutes, 5, 'and the next one honours it');
});

// --------------------------------------- learner authority changes mid-run

test('deleting learner words during verification withholds the stale lesson and every exposure write', async () => {
  const b = await bench('mid-learner-context-delete', generateBoard(6, 3));
  await runBatch(b.deps, RUN);
  const prior = await b.store.latestSession();
  await b.store.putStatement({
    id: 'learner-authority',
    text: 'Show the exact step where my reasoning diverged, then let me retry it.',
    topicId: null,
    userEdited: true,
    evidenceSignalIds: [],
    updatedAt: '2026-08-28T00:00:00.000Z',
  });
  const exposureBefore = new Map((await b.store.listTopics()).map((topic) => [topic.id, topic.lastExposedAt]));
  const remove = during('verify', async () => { await b.store.deleteStatement('learner-authority'); });

  const result = await runBatch({ ...b.deps, llm: new ScriptedLlm({ before: remove.hook }) }, RUN);
  remove.ran();

  assert.equal(result.learnerContextChanged, true);
  assert.equal(result.session, null, 'the checked draft escaped after its governing words were deleted');
  assert.equal((await b.store.latestSession())?.id, prior?.id,
    'a stale session row was persisted behind the learner model');
  assert.deepEqual(
    new Map((await b.store.listTopics()).map((topic) => [topic.id, topic.lastExposedAt])),
    exposureBefore,
    'withheld stale work consumed the topics as though it reached the learner',
  );
});

test('rejecting a machine read during verification also withholds the brief that used it', async () => {
  const b = await bench('mid-derived-context-reject', generateBoard(6, 3));
  await runBatch(b.deps, RUN);
  const prior = await b.store.latestSession();
  const reject = during('verify', async () => {
    const statement = (await b.store.listStatements())
      .find((candidate) => !candidate.userEdited && !candidate.rejected);
    assert.ok(statement, 'the run produced no machine read to reject');
    await b.store.putStatement({ ...statement, rejected: true });
  });

  const result = await runBatch({ ...b.deps, llm: new ScriptedLlm({ before: reject.hook }) }, RUN);
  reject.ran();

  assert.equal(result.learnerContextChanged, true);
  assert.equal(result.session, null);
  assert.equal((await b.store.latestSession())?.id, prior?.id,
    'a lesson shaped by a rejected read was still published');
});

/**
 * A sentence somebody agreed with is not this stage's prose any more.
 *
 * The `statements` stage regenerates the machine read every night and deletes
 * what it wrote last night, which is right for prose nobody has answered and
 * wrong the moment a person has. SB-282 made the same argument for the modality
 * question and exempted it; the Insights room's confirm gesture puts every
 * other machine read on the same footing, so the exemption is the same one.
 */
test('a read the learner agreed with survives the night that would have replaced it', async () => {
  const b = await bench('confirmed-read-survives', generateBoard(6, 3));
  await runBatch(b.deps, RUN);
  const read = (await b.store.listStatements())
    .find((candidate) => !candidate.userEdited && !candidate.rejected && !candidate.modality);
  assert.ok(read, 'the run produced no machine read to agree with');
  await b.store.putStatement({ ...read, confirmedAt: '2026-08-28T00:00:00.000Z' });

  await runBatch(b.deps, RUN);

  const after = (await b.store.listStatements()).find((row) => row.id === read.id);
  assert.ok(after, 'the nightly replace deleted a sentence a person had said was right');
  assert.equal(after?.text, read.text, 'and it is still the sentence they agreed with');
  assert.equal(after?.confirmedAt, '2026-08-28T00:00:00.000Z');
});

// ------------------------------------------------ a deletion arrives mid-run

test('a pin deleted mid-run does not leave the board citing it', async () => {
  const b = await bench('mid-delete', generateBoard(6, 3));
  await runBatch(b.deps, RUN);

  const drop = during('analyse', async () => { await b.store.deletePin('p0'); });
  await runBatch({ ...b.deps, llm: new ScriptedLlm({ before: drop.hook }) }, RUN);
  drop.ran();

  const after = await shapeOf(b.store);
  assert.equal(after.pins, 5);
  assert.deepEqual(after.danglingTopicPins, [],
    'the cascade rewrote topic membership, and the run did not write it back');
  assert.deepEqual(after.orphanPins, []);

  await runBatch(b.deps, RUN);
  const settled = await shapeOf(b.store);
  assert.equal(settled.pins, 5, 'the deletion holds through the next run');
  assert.deepEqual(settled.danglingTopicPins, []);
});

test('a full wipe mid-run leaves an empty store, not a partially rebuilt one', async () => {
  // SB-43 says delete means delete. A run in flight is the hardest case for
  // that promise, because every stage after the wipe is still holding topics
  // it read before it.
  const b = await bench('mid-wipe', generateBoard(6, 3));
  await runBatch(b.deps, RUN);

  const wipe = during('analyse', async () => { await b.store.deleteEverything(); });
  await runBatch({ ...b.deps, llm: new ScriptedLlm({ before: wipe.hook }) }, RUN);
  wipe.ran();

  const after = await shapeOf(b.store);
  assert.equal(after.pins, 0, 'no pin the learner deleted comes back');
  assert.equal(after.topics.length, 0, 'and no topic is rebuilt from what a stage was holding');
  assert.equal(after.signals, 0);
});
