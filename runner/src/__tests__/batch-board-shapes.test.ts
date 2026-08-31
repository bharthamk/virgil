import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VERIFIER_CHARS_PER_PIN, runBatch } from '../pipeline.js';
import {
  bench, generateBoard, groupEmbedder, identityEmbedder, makePin, shapeOf,
} from './batch-harness.js';

/**
 * Boards the seed corpus does not contain.
 *
 * Every clustering number in this repo is measured on boards that look like
 * boards: twenty-one or eighty pins, several subjects, a handful of pins each.
 * A learner's actual first week is one pin. A learner who pastes a chapter in
 * is one topic with a hundred. A learner reading in two languages is a board
 * whose text has nothing lexically in common with itself.
 *
 * None of those are exotic and none of them are tested anywhere. What is
 * asserted here is not quality — a partition over one pin has no quality to
 * measure — but that the run completes, sizes itself honestly, and leaves a
 * coherent store. A crash on the empty board is a learner who installs the
 * extension and never sees it work.
 */

const RUN = { concurrency: 2, compositionMinutes: 15 } as const;

const stages = (reports: readonly { stage: string; failed: boolean }[]): string[] =>
  reports.filter((r) => r.failed).map((r) => r.stage);

// ---------------------------------------------------------------- degenerate

test('an empty board runs every stage and produces an honest empty session', async () => {
  const b = await bench('shape-empty', []);
  const { reports, session } = await runBatch(b.deps, RUN);

  assert.deepEqual(stages(reports), [], 'nothing failed — there was simply nothing there');
  assert.equal(reports.find((r) => r.stage === 'forage')?.detail, 'nothing new to enrich');
  assert.match(String(reports.find((r) => r.stage === 'cluster')?.detail), /^0 topics from 0 pins/);
  assert.match(String(reports.find((r) => r.stage === 'garden')?.detail), /NOT ENOUGH for a session/);
  assert.equal(session?.insufficient, true, ': the empty card, not a manufactured lesson');
  assert.equal((await shapeOf(b.store)).sessions, 0, 'and nothing is persisted for the panel to show');
  assert.equal(b.llm.countOf('compose'), 0, 'the model is never asked to write a session out of nothing');
});

test('a board of one pin makes one topic and teaches it', async () => {
  const b = await bench('shape-one', [makePin('only', 'k0')]);
  const { reports, session, topics } = await runBatch(b.deps, RUN);

  assert.deepEqual(stages(reports), []);
  assert.equal(topics.length, 1, 'one pin is a topic — it is the learner\'s only material');
  assert.deepEqual([...topics[0]!.pinIds], ['only']);
  assert.equal(b.llm.countOf('analyse'), 0, 'the Analyst declines below four pins rather than guessing');
  assert.equal(session?.insufficient, false);
  assert.equal(session?.sections.length, 1,
    'a thin night with one genuinely new topic still teaches it — dropping the '
    + 'learner\'s only material would be padding in the other direction');
});

test('the garden line says NOT ENOUGH on a night the run then teaches — the line is about the pool', async () => {
  // Worth pinning down rather than leaving to be rediscovered. `enough` is a
  // property of the candidate pool (two or more), and the run deliberately
  // teaches a single-topic pool anyway (, and the Gardener's own note on
  // it). So the stage line and the session disagree by design, and anyone
  // reading a nightly log has to know that before they treat the line as a
  // report of what happened.
  const b = await bench('shape-thin', [makePin('only', 'k0')]);
  const { reports, session } = await runBatch(b.deps, RUN);

  assert.match(String(reports.find((r) => r.stage === 'garden')?.detail),
    /1 to teach, 0 to offer retiring — NOT ENOUGH for a session/);
  assert.equal(session?.insufficient, false, 'and a session was built regardless');
  assert.equal(session?.revision, false, 'not as a revision offer either — this is new material');
});

test('two pins are enough for a session, which is where the honest empty state stops', async () => {
  const b = await bench('shape-two', generateBoard(2, 2));
  const { session } = await runBatch(b.deps, RUN);
  assert.equal(session?.insufficient, false, 'the minimum pool is two topics, and this is two');
  assert.equal(session?.sections.length, 2);
});

test('a night whose every section named a topic nobody offered persists nothing', async () => {
  const b = await bench('shape-misaddressed', generateBoard(4, 2), {
    answer: (stage) => (stage === 'compose'
      ? {
        sections: [{
          topicId: 'a-topic-nobody-offered',
          heading: 'Section', body: 'A paragraph long enough to estimate from. '.repeat(6),
          estimatedMinutes: 5, question: null, sourceIds: [], mediumWarning: null,
        }],
        closingNote: 'one thing moved; one thing still open',
      }
      : undefined),
  });
  const { reports, session } = await runBatch(b.deps, RUN);

  assert.equal(session?.outcome, 'model-failed');
  assert.equal(session?.insufficient, false, 'the board had material — this is not the empty card');
  assert.equal(session?.sections.length, 0);
  assert.equal((await shapeOf(b.store)).sessions, 0, 'and nothing is persisted for the panel to show');
  assert.equal(b.llm.countOf('verify'), 0, 'nothing was checked, because there was nothing to check');
  assert.match(String(reports.find((r) => r.stage === 'compose')?.detail), /MODEL-FAILED/);
});

test('a night with nothing to teach is still the empty card, not a model failure', async () => {
  // The control for the test above: the same zero sections, a different reason,
  // and the two must not converge. The empty board never reaches the model at
  // all, so there is nothing to blame it for.
  const b = await bench('shape-none', []);
  const { reports, session } = await runBatch(b.deps, RUN);
  assert.equal(session?.outcome, 'nothing-to-teach');
  assert.equal(session?.insufficient, true);
  assert.doesNotMatch(String(reports.find((r) => r.stage === 'compose')?.detail), /MODEL-FAILED/);
});

// ------------------------------------------------------------- pathological

test('a board of identical pins collapses to one topic rather than one topic per pin', async () => {
  const pins = Array.from({ length: 20 }, (_, i) => makePin(`same${i}`, 'k0'));
  const b = await bench('shape-identical', pins);
  const { reports, topics } = await runBatch(b.deps, RUN);

  assert.deepEqual(stages(reports), []);
  assert.equal(topics.length, 1, 'twenty copies of one thing is one thing');
  assert.equal(topics[0]!.pinIds.length, 20);
  assert.equal(b.llm.countOf('cluster'), 1, 'and one naming call, not twenty');
});

test('a board of unrelated singletons makes one topic each and does not blow the session open', async () => {
  const b = await bench('shape-singletons', generateBoard(30, 30), { embedder: identityEmbedder() });
  const { reports, session, topics } = await runBatch(b.deps, RUN);

  assert.deepEqual(stages(reports), []);
  assert.equal(topics.length, 30, 'nothing is welded that does not belong together');
  assert.equal(session?.sections.length, 3,
    'and the session is still budgeted at three sections — 15 minutes buys three, not thirty');
  assert.deepEqual((await shapeOf(b.store)).orphanPins, []);
});

test('one giant topic of 120 pins is one section, and the brief is bounded', async () => {
  const pins = Array.from({ length: 120 }, (_, i) => makePin(`g${String(i).padStart(3, '0')}`, 'k0'));
  const b = await bench('shape-giant', pins);
  const { reports, session, topics } = await runBatch(b.deps, RUN);

  assert.deepEqual(stages(reports), []);
  assert.equal(topics.length, 1);
  assert.equal(topics[0]!.pinIds.length, 120, 'every pin is accounted for');
  assert.equal(session?.sections.length, 1, 'one topic is one section, however much is behind it');

  // The part that actually costs money in production. Nothing caps the number
  // of pins on a topic, so the per-pin slice is the only thing between a fat
  // topic and a prompt that will not fit — assert it is doing its job.
  const composePrompt = b.llm.calls.find((c) => c.stage === 'compose')!.prompt;
  assert.ok(composePrompt.length < 120 * 900,
    `the compose brief grows with the topic and is sliced per pin: ${composePrompt.length} chars`);
});

test('an enormous pin cannot make an unbounded prompt', async () => {
  // A learner selecting a whole chapter. The Verifier is the most generous cap
  // in the fleet and is therefore the one worth measuring: 1,500 characters per
  // pin, deliberately, so a fat first pin cannot evict the rest of the topic.
  const huge = 'x'.repeat(400_000);
  const pins = [
    makePin('big1', 'k0', { envelope: { ...makePin('big1', 'k0').envelope, selection: huge } }),
    makePin('big2', 'k0', { envelope: { ...makePin('big2', 'k0').envelope, selection: huge } }),
    makePin('small', 'k1'),
    makePin('small2', 'k1'),
  ];
  const b = await bench('shape-huge', pins);
  const { reports, session } = await runBatch(b.deps, RUN);

  assert.deepEqual(stages(reports), []);
  assert.ok(session, 'a 800KB board still produces a session');

  const verify = b.llm.calls.filter((c) => c.stage === 'verify');
  assert.ok(verify.length > 0);
  for (const call of verify) {
    assert.ok(call.prompt.length < 2 * VERIFIER_CHARS_PER_PIN + 4000,
      `the verify prompt is capped per pin, not by the selection: ${call.prompt.length} chars`);
  }
  const forage = b.llm.calls.filter((c) => c.stage === 'forage');
  for (const call of forage) {
    assert.ok(call.prompt.length < 20_000, `forage slices too: ${call.prompt.length} chars`);
  }
  const clusterCall = b.llm.calls.find((c) => c.stage === 'cluster')!;
  assert.ok(clusterCall.prompt.length < 20_000,
    `and the naming brief is a gist per pin, not the pin: ${clusterCall.prompt.length} chars`);
});

test('a mixed-language board partitions on meaning, not on script', async () => {
  // The embedder is what decides this, and swapping it is a one-line change —
  // so what the run has to promise is that nothing between the embedder and the
  // store cares what alphabet the material is in.
  const pins = [
    makePin('en1', 'k0', { envelope: { ...makePin('en1', 'k0').envelope, selection: 'The acknowledgement deadline is how long a subscriber has.', contentLanguage: 'en' } }),
    makePin('ja1', 'k0', { envelope: { ...makePin('ja1', 'k0').envelope, selection: '確認応答期限とは、サブスクライバーが応答するまでの時間です。', contentLanguage: 'ja' } }),
    makePin('de1', 'k1', { envelope: { ...makePin('de1', 'k1').envelope, selection: 'Eine Bedingung schränkt ein, wann eine Rollenbindung Zugriff gewährt.', contentLanguage: 'de' } }),
    makePin('ar1', 'k1', { envelope: { ...makePin('ar1', 'k1').envelope, selection: 'يقيد الشرط متى يمنح ربط الدور حق الوصول.', contentLanguage: 'ar' } }),
  ];
  const b = await bench('shape-langs', pins);
  const { reports, topics, session } = await runBatch(b.deps, RUN);

  assert.deepEqual(stages(reports), []);
  assert.equal(topics.length, 2, 'the two subjects, each with both of its languages');
  assert.deepEqual(
    topics.map((t) => [...t.pinIds].sort()).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [['ar1', 'de1'], ['en1', 'ja1']]);
  assert.equal(session?.sections.length, 2);
  assert.deepEqual((await shapeOf(b.store)).orphanPins, []);
});

test('a pin whose envelope is empty in every field still reaches a topic', async () => {
  // The worst envelope the boundary will accept. Nothing here is a crash, and
  // the pin must not vanish: a pin the learner saved that is never taught is
  // the one failure this product cannot recover from.
  const bare = makePin('bare', 'k0', {
    envelope: {
      selection: null, parts: [], surroundingText: '', headingPath: [],
      pageTitle: '', url: '', canonicalUrl: null, siteName: null,
      contentLanguage: null, media: null,
    },
  });
  const b = await bench('shape-bare', [bare, ...generateBoard(3, 1)], { embedder: groupEmbedder() });
  const { reports, topics } = await runBatch(b.deps, RUN);

  assert.deepEqual(stages(reports), []);
  assert.equal(topics.flatMap((t) => t.pinIds).includes('bare'), true, 'the empty pin is on the board');
  for (const t of topics) assert.ok(t.label.trim().length > 0, 'and no topic is left nameless by it');
  assert.deepEqual((await shapeOf(b.store)).orphanPins, []);
});

test('the pathological shapes are all idempotent too', async () => {
  // The property that matters most for an unattended job, checked on the boards
  // most likely to break it rather than only on the tidy one.
  for (const [tag, pins, embedder] of [
    ['empty', [], groupEmbedder()],
    ['one', [makePin('only', 'k0')], groupEmbedder()],
    ['identical', Array.from({ length: 12 }, (_, i) => makePin(`s${i}`, 'k0')), groupEmbedder()],
    ['singletons', generateBoard(12, 12), identityEmbedder()],
  ] as const) {
    const b = await bench(`shape-idem-${tag}`, pins, { embedder });
    await runBatch(b.deps, RUN);
    const first = await shapeOf(b.store);
    await runBatch(b.deps, RUN);
    const second = await shapeOf(b.store);
    assert.deepEqual(second.topics, first.topics, `${tag}: the second run moved the board`);
    assert.equal(second.pins, first.pins, `${tag}: the second run changed the pin count`);
  }
});
