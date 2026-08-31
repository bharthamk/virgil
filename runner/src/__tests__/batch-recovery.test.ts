import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Deps } from '@sb/core';

import { runBatch } from '../pipeline.js';
import {
  ScriptedLlm, bench, faultyStore, generateBoard, sessionCount, shapeOf,
  type Stage,
} from './batch-harness.js';

/**
 * What the next run inherits from a run that did not finish.
 *
 * The pipeline is stage-by-stage failure-tolerant by design (D10), and every
 * existing test of that reads the stage LINE. That is the wrong half of the
 * claim for a job that will be retried by a scheduler: the line is gone by the
 * time anyone looks, and what is actually inherited is the store. So each test
 * here kills the run at one boundary, reads the store, then runs again clean
 * and asserts the board recovers rather than carrying the damage forward.
 *
 * Two kinds of kill, because they leave different wreckage:
 *
 *  - a model that stops answering, which the stage catches — the stage degrades
 *    and the stages after it still run;
 *  - a store write that fails mid-stage, which nothing catches — the run throws
 *    all the way out, exactly as an evicted container does, and leaves a
 *    partially written collection behind.
 */

const RUN = { concurrency: 2 } as const;

const failing = async (tag: string, stages: readonly Stage[], count = 6) =>
  bench(tag, generateBoard(count, 3), { fail: stages });

/** The same board and store, with a model that answers everything. */
const healed = (deps: Deps): Deps => ({ ...deps, llm: new ScriptedLlm() });

const line = (reports: readonly { stage: string; detail: string }[], stage: string): string =>
  String(reports.find((r) => r.stage === stage)?.detail);

// ---------------------------------------------------- boundary 1: after forage

test('a run whose forage never answered leaves every pin, and the next run enriches them', async () => {
  const b = await failing('rec-forage', ['forage']);
  const first = await runBatch(b.deps, RUN);

  assert.match(line(first.reports, 'forage'), /6 MODEL-FAILED/);
  const mid = await shapeOf(b.store);
  assert.equal(mid.pins, 6, 'a failed enrichment is not a lost pin');
  assert.equal(mid.topics.length, 3, 'and the stages after it still ran — enrichment is not a gate');

  const second = await runBatch(healed(b.deps), RUN);
  assert.match(line(second.reports, 'forage'), /^6 pins — 6 enriched/,
    'all six are still owed an attempt, and the retry night takes it');
  assert.deepEqual((await b.store.listPins({ unenrichedOnly: true })).map((p) => p.id), [],
    'and nothing is left owed afterwards');
  assert.deepEqual((await shapeOf(b.store)).topics.map((t) => t.pins), [2, 2, 2],
    'the board the failed run built is the board the retry keeps');
});

// --------------------------------------------------- boundary 2: after cluster

test('a run whose cluster stage never completed leaves no half-written board', async () => {
  // The store dies on the second topic write. The first topic is on disk, its
  // pins are pointed at it, and nothing else in the stage ever ran.
  const inner = (await bench('rec-cluster-inner', [])).store;
  const b = await bench('rec-cluster', generateBoard(6, 3), { store: inner });
  const deps: Deps = { ...b.deps, store: faultyStore(inner, { method: 'putTopic', after: 1 }) };

  await assert.rejects(runBatch(deps, RUN), /store fault/,
    'a store that stops writing is not something a stage can degrade around');

  const mid = await shapeOf(inner);
  assert.equal(mid.pins, 6, 'no pin was lost by the crash');
  assert.equal(mid.topics.length, 1, 'exactly the one topic that got written');
  assert.deepEqual(mid.danglingTopicPins, [], 'and it does not claim a pin that is not there');

  // The retry, on the same store, with the fault gone.
  await runBatch(b.deps, RUN);
  const after = await shapeOf(inner);
  assert.equal(after.topics.length, 3, 'the two topics the crash cost are built by the next run');
  assert.deepEqual(after.topics.map((t) => t.pins), [2, 2, 2]);
  assert.deepEqual(after.orphanPins, [], 'and every pin points at a topic that exists');
  assert.equal(after.pins, 6);
});

test('the topic the crash did write keeps its id through the retry', async () => {
  // The half-written board is not thrown away and rebuilt. Whatever the crashed
  // run managed to commit is an existing topic to the next one, which is the
  // only reason a signal earned against it survives the retry.
  const inner = (await bench('rec-keep-inner', [])).store;
  const b = await bench('rec-keep', generateBoard(6, 3), { store: inner });
  const deps: Deps = { ...b.deps, store: faultyStore(inner, { method: 'putTopic', after: 1 }) };
  await assert.rejects(runBatch(deps, RUN));
  const survivor = (await inner.listTopics())[0]!;

  await runBatch(b.deps, RUN);
  const after = await inner.getTopic(survivor.id);
  assert.ok(after, 'the committed topic is still there under its own id');
  assert.deepEqual([...after.pinIds], [...survivor.pinIds], 'with the membership it was written with');
  assert.equal(after.label, survivor.label, 'and its name — the retry does not re-name it');
});

test('a naming call that never answered costs a label, not a topic', async () => {
  const b = await failing('rec-naming', ['cluster']);
  await runBatch(b.deps, RUN);

  const topics = await b.store.listTopics();
  assert.equal(topics.length, 3, 'the partition is arithmetic and does not need the model at all');
  for (const t of topics) assert.ok(t.label.trim().length > 0, 'every topic still has a real name');
  assert.equal(topics.every((t) => /^k\d+$/.test(t.label)), true,
    'the heading-path fallback, which is a description rather than a placeholder');

  for (const t of topics) assert.equal(t.provisionalName, true,
    'a heading-path label is a stopgap: nothing chose it, so it is still owed a name');

  /**
   * **This assertion used to say the opposite**, and said so on purpose:
   *
   * > the next run does NOT get a second chance at naming them, because they
   * > are existing topics now. Documented rather than fixed: a clumsy label is
   * > a cosmetic cost, and re-naming a topic the learner has already seen is
   * > the identity break the clusterer refuses to make.
   *
   * The identity promise is right and is untouched. What was wrong is that it
   * was being applied to a topic that had never been named by anything, making
   * the stopgap permanent. `provisionalName` splits the two cases: a topic
   * with no name is named at the first opportunity, and from then on the
   * promise applies in full.
   */
  const healedRun = await runBatch(healed(b.deps), RUN);
  const named = await b.store.listTopics();
  assert.equal(named.every((t) => /^Topic /.test(t.label)), true,
    'the run that could reach the model took the naming chance the failed one lost');
  assert.equal(named.every((t) => t.provisionalName === false), true, 'and it is not owed again');
  assert.equal(healedRun.reports.find((r) => r.stage === 'cluster')?.failed, false);

  // The promise itself: a third run does not rename what the second one named.
  await runBatch(healed(b.deps), RUN);
  assert.deepEqual((await b.store.listTopics()).map((t) => t.label).sort(),
    named.map((t) => t.label).sort(),
    'named once, then never again — that is the identity promise, intact');
});

// ---------------------------------------------------- boundary 3: after survey

test('a survey that never answered leaves the graph empty rather than stale', async () => {
  const b = await bench('rec-survey', generateBoard(6, 3), {
    answer: (stage, req) => (stage === 'survey'
      ? {
        edges: (() => {
          const ids = [...req.prompt.matchAll(/^- (\S+):/gm)].map((m) => String(m[1]));
          return ids.length >= 2
            ? [{ from: ids[0], to: ids[1], confidence: 0.9, justification: 'first before second' }]
            : [];
        })(),
      }
      : undefined),
  });
  await runBatch(b.deps, RUN);
  const built = (await b.store.listEdges()).length;

  const broken = await runBatch({ ...b.deps, llm: new ScriptedLlm({ fail: ['survey'] }) }, RUN);
  assert.equal(broken.reports.find((r) => r.stage === 'survey')?.failed, true);
  assert.equal((await b.store.listEdges()).length, built,
    'the stage failed before `putEdges`, so last night\'s graph is what stands');

  await runBatch(b.deps, RUN);
  assert.equal((await b.store.listEdges()).length, built, 'and the next good night rebuilds it');
});

// --------------------------------------------------- boundary 4: after compose

test('a compose that never answered leaves no session at all, and no orphan', async () => {
  const b = await failing('rec-compose', ['compose']);
  const first = await runBatch(b.deps, RUN);

  assert.equal(first.session, null);
  assert.equal(await sessionCount(b.store), 0, 'nothing half-built is persisted');
  assert.equal(await b.store.latestSession(), null, 'and the panel is told the truth');
  assert.equal((await b.store.listTopics()).length, 3, 'the board the run did build survives');

  const second = await runBatch(healed(b.deps), RUN);
  assert.ok(second.session, 'the next run composes normally');
  assert.equal(await sessionCount(b.store), 1, 'one session, from two runs — the failed one added nothing');
});

test('a store that dies while persisting the session leaves the board intact', async () => {
  const inner = (await bench('rec-put-inner', [])).store;
  const b = await bench('rec-put', generateBoard(6, 3), { store: inner });
  const deps: Deps = { ...b.deps, store: faultyStore(inner, { method: 'putSession', after: 0 }) };

  await assert.rejects(runBatch(deps, RUN), /store fault/);
  assert.equal(await sessionCount(inner), 0);
  const mid = await shapeOf(inner);
  assert.equal(mid.topics.length, 3, 'every stage before the write committed');
  assert.deepEqual(mid.orphanPins, []);

  await runBatch(b.deps, RUN);
  assert.equal(await sessionCount(inner), 1, 'and the retry produces the session that was lost');
  assert.deepEqual((await shapeOf(inner)).topics, mid.topics, 'without rebuilding the board underneath it');
});

// ---------------------------------------------------- boundary 5: after verify

test('a verify that never ran withholds its sections and persists the session without them', async () => {
  const b = await failing('rec-verify', ['verify']);
  const { session, withheld } = await runBatch(b.deps, RUN);

  assert.equal(withheld.length > 0, true, 'the check that did not run is a recorded fact about the run');
  assert.equal(withheld.every((w) => w.reason === 'unverified'), true);
  assert.equal(withheld.every((w) => w.error !== null), true, 'with the reason it could not run');
  assert.deepEqual(session?.sections ?? [], [], 'and nothing unchecked reaches the learner');

  const stored = await b.store.latestSession();
  assert.ok(stored, 'the session row still exists — an empty session is a fact, not an absence');
  assert.deepEqual(stored.sections, []);
});

test('the retry that fixes a withheld session is the one the panel shows', async () => {
  // The defect this test was written to find, and the reason a run-level
  // idempotence pass is worth doing at all.
  //
  // Run one: the Verifier cannot be reached, every section is withheld, and a
  // session with no sections is persisted — which is correct, and is the whole
  // point of failing closed. Run two, the retry, verifies and persists the real
  // session. Both rows carry the same `builtAt`, because every stage in both
  // runs read the same clock.
  //
  // `latestSession` sorted on `builtAt` alone. A stable sort leaves an exact
  // tie in insertion order, so the first row won and the panel kept showing the
  // empty session: the learner was told there was nothing ready on the night
  // the retry succeeded. Fixed in `adapters/src/json-store.ts` by breaking the
  // tie toward the row written last.
  const b = await failing('rec-latest', ['verify']);
  const first = await runBatch(b.deps, RUN);
  assert.deepEqual(first.session?.sections ?? [], []);
  assert.equal((await b.store.latestSession())?.sections.length, 0);

  const second = await runBatch(healed(b.deps), RUN);
  assert.ok((second.session?.sections.length ?? 0) > 0, 'the retry built a real session');
  assert.equal(await sessionCount(b.store), 2, 'and both rows are on disk, with the same builtAt');

  const shown = await b.store.latestSession();
  assert.equal(shown?.sections.length, second.session?.sections.length,
    'the panel shows the retry, not the run that could not check itself');
  assert.notEqual(shown?.sections.length, 0);
  assert.equal(shown?.id, second.session === null ? null : (await b.store.getSession(shown!.id))?.id,
    'and it is a row that is genuinely in the store, not a projection');
});

test('a topic whose section was withheld is still owed a lesson on the next run', async () => {
  // The whole reason withholding is not the same as shipping: an unshipped
  // section never advances `lastExposedAt`, so the Gardener still sees the
  // topic as owed. If the failed run had taken it out of circulation, the
  // learner would lose the material to a check that never happened.
  const b = await failing('rec-verify-pool', ['verify']);
  const first = await runBatch(b.deps, RUN);
  const owed = first.withheld.map((w) => w.topicId).sort();
  assert.ok(owed.length > 0);
  assert.deepEqual(
    (await b.store.listTopics())
      .filter((topic) => owed.includes(topic.id))
      .map((topic) => topic.lastExposedAt),
    owed.map(() => null),
    'attempting and withholding a section does not claim the learner was taught it',
  );

  const second = await runBatch(healed(b.deps), RUN);
  assert.deepEqual((second.session?.sections ?? []).map((s) => s.topicId).sort(), owed,
    'the same topics come back, and this time they ship');
  const shippedAt = second.session?.builtAt;
  assert.ok(shippedAt);
  assert.deepEqual(
    (await b.store.listTopics())
      .filter((topic) => owed.includes(topic.id))
      .map((topic) => topic.lastExposedAt),
    owed.map(() => shippedAt),
    'only the verified sections that reached the stored session consume what was owed',
  );
});

// --------------------------------------------------------- everything at once

test('a run where every model call fails still leaves a coherent board', async () => {
  const b = await failing('rec-total', ['forage', 'cluster', 'survey', 'analyse', 'statements', 'compose', 'verify']);
  const { reports, session } = await runBatch(b.deps, RUN);

  // The partition, the comfort arithmetic and the garden are model-free, so
  // they are the floor a total model outage falls to rather than zero.
  assert.equal(reports.find((r) => r.stage === 'cluster')?.failed, false);
  assert.equal(reports.find((r) => r.stage === 'comfort')?.failed, false);
  assert.equal(reports.find((r) => r.stage === 'compose')?.failed, true);
  assert.equal(session, null);

  const s = await shapeOf(b.store);
  assert.equal(s.pins, 6, 'no pin lost');
  assert.equal(s.topics.length, 3, 'a board, built without a single model answer');
  assert.deepEqual(s.orphanPins, []);
  assert.deepEqual(s.danglingTopicPins, []);
  assert.equal(s.sessions, 0);

  const second = await runBatch(healed(b.deps), RUN);
  assert.ok(second.session, 'and the night the model comes back is an ordinary night');
  assert.deepEqual((await shapeOf(b.store)).topics.map((t) => t.pins), [2, 2, 2]);
});

test('the run reports which stages degraded, so an unattended retry is a decision and not a guess', async () => {
  const b = await failing('rec-report', ['survey', 'compose']);
  const { reports } = await runBatch(b.deps, RUN);
  const failed = reports.filter((r) => r.failed).map((r) => r.stage);

  assert.deepEqual(failed, ['survey', 'compose'],
    'named individually — a scheduler cannot act on "the run failed"');
  for (const r of reports.filter((x) => x.failed)) {
    assert.match(r.detail, /^FAILED — /, 'and each one says so in its own line');
  }
});

test('a failed analyse takes the statement stage down with it, and the line says so honestly', async () => {
  // Not a failure of the statement stage: the Registrar declines to write
  // anything when it has neither evidence nor an observation to write from, and
  // a run whose Analyst went down has neither. The line has to distinguish
  // "the model refused" from "there was nothing to say", because the statements
  // already on the panel are kept in both cases and only one of them is a
  // reason to look at the logs.
  const b = await failing('rec-cascade', ['analyse']);
  const { reports } = await runBatch(b.deps, RUN);

  assert.equal(reports.find((r) => r.stage === 'analyse')?.failed, true);
  const statements = reports.find((r) => r.stage === 'statements');
  assert.equal(statements?.failed, false, 'the stage ran; it simply had nothing to run on');
  // A prefix rather than the whole line: SB-282 appends what the modality
  // question did or did not do to the same line, because it happens inside this
  // stage. What has to survive is the opening, which is the honest reason.
  assert.match(statements?.detail ?? '', /^none produced — previous kept(;|$)/);
  assert.deepEqual(await b.store.listStatements(), [],
    'and it did not delete what it could not replace');
});

test('the statements a failed run could not regenerate are not deleted by it', async () => {
  const b = await bench('rec-keep-statements', generateBoard(6, 3));
  await runBatch(b.deps, RUN);
  const before = (await b.store.listStatements()).map((s) => s.text);
  assert.equal(before.length, 1);

  await runBatch({ ...b.deps, llm: new ScriptedLlm({ fail: ['analyse'] }) }, RUN);
  assert.deepEqual((await b.store.listStatements()).map((s) => s.text), before,
    'the delete-then-write is guarded on having produced something first, so a bad '
    + 'night leaves last night\'s read on the panel rather than an empty one');
});
