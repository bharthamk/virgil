import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  rejectedByExistingEvidence, runBatch, sessionLearnerContext, sessionObservations,
} from '../pipeline.js';
import {
  bench, generateBoard, makePin, sessionCount, shapeOf, sig,
} from './batch-harness.js';

/**
 * Running the nightly twice on the same board.
 *
 * This is not a hypothetical. The pipeline is the local stand-in for a Cloud
 * Run Job, and a Job that fails after doing most of its work is retried by the
 * platform, not by a person deciding it is safe. So "what does the second run
 * do to the store" is a question the product has to have an answer to before it
 * is ever scheduled, and the answer has to be readable at the store rather than
 * in a stage line — a run can report `2 topics from 6 pins` twice over and have
 * written four topics.
 *
 * What is asserted here is per-collection, deliberately. "The store is the
 * same" is one assertion that fails for six different reasons and names none of
 * them; the point of this file is to say which collections a re-run is safe for
 * and which it is not.
 */

const RUN = { concurrency: 2 } as const;

test('a second run over an unchanged board creates no second set of topics', async () => {
  const b = await bench('idem-topics', generateBoard(6, 3));
  await runBatch(b.deps, RUN);
  const first = await shapeOf(b.store);

  await runBatch(b.deps, RUN);
  const second = await shapeOf(b.store);

  assert.equal(first.topics.length, 3, 'the board partitions into the three sets it was built from');
  assert.deepEqual(second.topics, first.topics,
    'membership, labels, states and comfort are all where the first run left them');
  assert.equal(second.pins, first.pins, 'and no pin was duplicated or dropped');
});

test('topic ids survive the second run — history attaches to them', async () => {
  // The reason the previous test is not enough. Two runs can agree on
  // membership and still have minted new ids for it, which detaches every
  // signal the learner has earned from the thing it was about — the exact
  // failure D15 was fought over, arriving by a different door.
  const b = await bench('idem-ids', generateBoard(6, 3));
  await runBatch(b.deps, RUN);
  const before = (await b.store.listTopics()).map((t) => t.id).sort();

  await runBatch(b.deps, RUN);
  const after = (await b.store.listTopics()).map((t) => t.id).sort();

  assert.deepEqual(after, before, 'the same topics, under the same ids');
});

test('the second run does not re-enrich a pin the first one settled', async () => {
  const b = await bench('idem-forage', generateBoard(4, 2));
  await runBatch(b.deps, RUN);
  // Pins, not calls. The two are the same today and were not during the
  // batching experiment; what has to stay true either way is that a settled
  // pin is never asked about twice.
  const afterFirst = b.llm.foragedPins();
  assert.equal(afterFirst, 4, 'every pin was asked about once');

  await runBatch(b.deps, RUN);
  assert.equal(b.llm.foragedPins(), afterFirst,
    'and not once more — a settled board costs nothing to re-run');
});

test('the second run does not re-name topics that already exist', async () => {
  const b = await bench('idem-naming', generateBoard(6, 3));
  await runBatch(b.deps, RUN);
  const named = b.llm.countOf('cluster');

  await runBatch(b.deps, RUN);
  assert.equal(named, 1, 'one naming call for the three topics the first run created');
  assert.equal(b.llm.countOf('cluster'), named,
    'and none on the second — an existing topic is never renamed');
});

test('the edge set is replaced, not appended to', async () => {
  const b = await bench('idem-edges', generateBoard(6, 3), {
    answer: (stage, req) => (stage === 'survey'
      ? {
        edges: [...req.prompt.matchAll(/^- (\S+):/gm)].slice(0, 2).map((m, i, all) => ({
          from: String(all[0]?.[1]), to: String(all[1]?.[1] ?? all[0]?.[1]),
          confidence: 0.9, justification: 'the first needs the second',
        })).slice(0, 1),
      }
      : undefined),
  });
  await runBatch(b.deps, RUN);
  const first = (await b.store.listEdges()).length;
  await runBatch(b.deps, RUN);

  assert.equal((await b.store.listEdges()).length, first,
    'putEdges is a replace; a run that appended would grow the graph every night');
});

test('statements are replaced, so two runs do not leave two copies', async () => {
  const b = await bench('idem-statements', generateBoard(4, 2));
  await runBatch(b.deps, RUN);
  const first = await b.store.listStatements();
  assert.equal(first.length, 1);

  await runBatch(b.deps, RUN);
  const second = await b.store.listStatements();
  assert.equal(second.length, 1, 'the panel shows the current read, not a log of every read');
  assert.deepEqual(second.map((s) => s.text), first.map((s) => s.text));
  assert.notDeepEqual(second.map((s) => s.id), first.map((s) => s.id),
    'and it is genuinely rewritten rather than left alone');
});

test('a statement the learner edited is not replaced by the second run', async () => {
  const b = await bench('idem-edited', generateBoard(4, 2));
  await runBatch(b.deps, RUN);
  const derived = (await b.store.listStatements())[0]!;
  await b.store.putStatement({
    ...derived, id: 'mine', text: 'I already know this', topicId: null,
    evidenceSignalIds: [], userEdited: true,
  });
  const analyseCalls = b.llm.countOf('analyse');
  const statementCalls = b.llm.countOf('statements');

  const { reports } = await runBatch(b.deps, RUN);
  const after = await b.store.listStatements();
  assert.ok(after.some((s) => s.id === 'mine' && s.text === 'I already know this'),
    'an edit outranks derived state (SB-42) — a re-run must not undo the correction');
  assert.equal(after.length, 1,
    'an unscoped machine read cannot reappear beside the learner correction in Insights');
  assert.equal(b.llm.countOf('analyse'), analyseCalls,
    'a global correction makes every new Analyst observation inadmissible, so no call was spent');
  assert.equal(b.llm.countOf('statements'), statementCalls,
    'a global correction makes every new machine statement inadmissible, so no call was spent');
  assert.match(String(reports.find((r) => r.stage === 'analyse')?.detail), /no machine pattern was asked for/);
  assert.match(String(reports.find((r) => r.stage === 'statements')?.detail), /no new machine read was asked for/);
});

test('a learner correction governs the next teaching brief instead of merely surviving beside a new inference', async () => {
  const scoped = sessionLearnerContext([
    {
      id: 'learner', text: 'I understand topic one; I need practice applying it.',
      topicId: null, userEdited: true, evidenceSignalIds: ['s1'], updatedAt: '2026-08-19T00:00:00Z',
    },
    {
      id: 'same-topic', text: 'You do not understand topic one.',
      topicId: null, userEdited: false, evidenceSignalIds: ['s1'], updatedAt: '2026-08-19T00:00:00Z',
    },
    {
      id: 'other-topic', text: 'You are still building topic two.',
      topicId: null, userEdited: false, evidenceSignalIds: ['s2'], updatedAt: '2026-08-19T00:00:00Z',
    },
    {
      id: 'unscoped', text: 'You usually avoid definitions.',
      topicId: null, userEdited: false, evidenceSignalIds: [], updatedAt: '2026-08-19T00:00:00Z',
    },
  ], [sig('s1', 't1', 'positive'), sig('s2', 't2', 'negative')]);

  assert.deepEqual(scoped.corrections, ['I understand topic one; I need practice applying it.']);
  assert.deepEqual(scoped.derived, ['You are still building topic two.'],
    'same-topic and unscoped machine reads cannot compete with the learner correction');

  const observations = [
    {
      claim: 'You avoid applying topic one.', evidencePinIds: ['p1'],
      implication: 'Explain topic one again.', mediumMismatch: false, confidence: 0.8,
    },
    {
      claim: 'Topic two needs another example.', evidencePinIds: ['p2'],
      implication: 'Give one example.', mediumMismatch: false, confidence: 0.8,
    },
  ];
  assert.deepEqual(
    sessionObservations(scoped, observations, [
      makePin('p1', 'k1', { topicId: 't1' }), makePin('p2', 'k2', { topicId: 't2' }),
    ]).map((observation) => observation.claim),
    ['Topic two needs another example.'],
    'the same precedence applies to Analyst patterns, not just rendered sentences',
  );

  const global = sessionLearnerContext([
    {
      id: 'learner-global', text: 'Do not infer a study habit from when I save things.',
      topicId: null, userEdited: true, evidenceSignalIds: [], updatedAt: '2026-08-19T00:00:00Z',
    },
    {
      id: 'derived', text: 'You study late.', topicId: 't2', userEdited: false,
      evidenceSignalIds: ['s2'], updatedAt: '2026-08-19T00:00:00Z',
    },
  ], [sig('s2', 't2', 'negative')]);
  assert.equal(global.globalCorrection, true);
  assert.deepEqual(global.derived, []);
  assert.deepEqual(sessionObservations(global, observations, []), []);
});

test('a rejected read needs materially new evidence before it can return', () => {
  const rejected = {
    id: 'rejected', text: 'You rush the exceptions.', topicId: 't1', userEdited: false,
    rejected: true, evidenceSignalIds: ['s1', 's2'], updatedAt: '2026-08-19T00:00:00Z',
  };
  const sameEvidence = {
    ...rejected, id: 'candidate', text: 'You tend to skip exceptions.', rejected: false,
  };
  const newEvidence = {
    ...sameEvidence, evidenceSignalIds: ['s1', 's2', 's3'],
  };
  assert.equal(rejectedByExistingEvidence(sameEvidence, [rejected]), true,
    'a paraphrase cannot bypass the rejection');
  assert.equal(rejectedByExistingEvidence(newEvidence, [rejected]), false,
    'new evidence makes a new read reviewable');
  assert.deepEqual(sessionLearnerContext([rejected], []).derived, [],
    'a hidden rejection receipt never enters the teaching brief');
});

test('the next Composer and Verifier prompts carry the learner correction as authority', async () => {
  const b = await bench('idem-correction-brief', generateBoard(4, 2));
  await runBatch(b.deps, RUN);
  const derived = (await b.store.listStatements())[0]!;
  await b.store.putStatement({
    ...derived,
    text: 'I understand the mechanism; I need practice applying it.',
    topicId: null,
    evidenceSignalIds: [],
    userEdited: true,
  });
  const before = b.llm.calls.length;
  let admittedCorrections = -1;

  await runBatch(b.deps, {
    ...RUN, onLearnerContext: (corrections) => { admittedCorrections = corrections; },
  });
  const calls = b.llm.calls.slice(before);
  const composePrompt = calls.find((call) => call.stage === 'compose')?.prompt ?? '';
  const verifyPrompts = calls.filter((call) => call.stage === 'verify').map((call) => call.prompt);

  assert.equal(calls.some((call) => call.stage === 'analyse'), false,
    'the authoritative global correction avoided an Analyst answer that could not enter the brief');
  assert.equal(calls.some((call) => call.stage === 'statements'), false,
    'the authoritative global correction avoided machine prose that could not survive it');
  assert.match(composePrompt, /LEARNER CORRECTIONS — AUTHORITATIVE/);
  assert.equal(admittedCorrections, 1,
    'the learner-facing receipt did not count the exact context admitted to composition');
  assert.match(composePrompt, /I understand the mechanism; I need practice applying it\./);
  assert.doesNotMatch(composePrompt, /You reach for the mechanism before the definition\./,
    'the newly derived contradiction was still allowed into the Composer brief');
  assert.ok(verifyPrompts.length > 0, 'the resulting lesson was checked');
  for (const prompt of verifyPrompts) {
    assert.match(prompt, /LEARNER CORRECTIONS — AUTHORITATIVE/);
    assert.match(prompt, /I understand the mechanism; I need practice applying it\./);
    assert.doesNotMatch(prompt, /You reach for the mechanism before the definition\./);
  }
});

test('the run appends no signals, so comfort cannot be applied twice', async () => {
  // Decay and regression are pure functions of the ledger and the clock. The
  // only way a nightly run could double-apply them is by writing into the
  // ledger itself, so that is what is asserted — the arithmetic downstream
  // needs no protection it does not already have.
  const b = await bench('idem-comfort', generateBoard(6, 3));
  await runBatch(b.deps, RUN);
  const topic = (await b.store.listTopics())[0]!;
  await b.store.appendSignal(sig('s1', topic.id, 'positive'));
  await b.store.appendSignal(sig('s2', topic.id, 'negative'));

  await runBatch(b.deps, RUN);
  const afterOne = (await b.store.getTopic(topic.id))!;
  const signalsAfterOne = (await b.store.listSignals()).length;

  await runBatch(b.deps, RUN);
  const afterTwo = (await b.store.getTopic(topic.id))!;

  assert.equal(signalsAfterOne, 2, 'the run wrote no signal of its own');
  assert.equal((await b.store.listSignals()).length, 2);
  assert.equal(afterTwo.comfort, afterOne.comfort, 'the same evidence, the same number');
  assert.equal(afterTwo.state, afterOne.state);
});

test('a topic the learner retired is not resurrected or re-taught by a re-run', async () => {
  const b = await bench('idem-retired', generateBoard(6, 3));
  await runBatch(b.deps, RUN);
  const topic = (await b.store.listTopics())[0]!;
  await b.store.putTopic({ ...topic, retiredByUser: true });

  await runBatch(b.deps, RUN);
  const after = (await b.store.getTopic(topic.id))!;
  assert.equal(after.retiredByUser, true, 'the run does not clear the learner\'s own decision');
  assert.equal(after.state, 'settled', 'and it stays retired rather than being pulled back to waiting');

  const { session } = await runBatch(b.deps, RUN);
  assert.equal(session?.sections.some((s) => s.topicId === topic.id), false,
    'a retired topic is never a section, however many times the run repeats');
});

// ------------------------------------------------- the incremental second run

test('a re-run after new pins arrive is an increment, not a rebuild', async () => {
  const b = await bench('idem-incremental', generateBoard(6, 3));
  await runBatch(b.deps, RUN);
  const before = await b.store.listTopics();
  const beforeIds = before.map((t) => t.id).sort();

  // Two more pins on an existing set, and two on a set nothing has seen.
  await b.store.putPin(makePin('q1', 'k0'));
  await b.store.putPin(makePin('q2', 'k1'));
  await b.store.putPin(makePin('q3', 'k9'));
  await b.store.putPin(makePin('q4', 'k9'));

  const { reports } = await runBatch(b.deps, RUN);
  const after = await b.store.listTopics();

  assert.match(String(reports.find((r) => r.stage === 'forage')?.detail), /^4 pins/,
    'only the new pins are enriched');
  assert.equal(after.length, 4, 'one new topic for the set that is genuinely new');
  assert.deepEqual(
    after.map((t) => t.id).filter((id) => beforeIds.includes(id)).sort(),
    beforeIds,
    'and every topic the learner already had is still there under its own id');
  const grown = after.find((t) => t.id === before.find((x) => x.pinIds.includes('p0'))?.id);
  assert.ok(grown?.pinIds.includes('q1'), 'the new pin attached rather than seeding a rival topic');
  assert.deepEqual(await shapeOf(b.store).then((s) => s.orphanPins), [],
    'no pin is left pointing at a topic that is not on the board');
});

// --------------------------------------------- what a re-run is NOT safe for

test('a second run in the same night writes a SECOND session row', async () => {
  // Documented rather than asserted away. `putSession` mints a fresh id per run
  // and there is no per-night key, so a retried Cloud Run Job leaves two rows
  // for one night. That is survivable — they are equal in content — but it is a
  // real property of the design and the panel reads `latestSession`, so the
  // tie-break below is the part that actually matters.
  const b = await bench('idem-sessions', generateBoard(6, 3));
  await runBatch(b.deps, RUN);
  assert.equal(await sessionCount(b.store), 1);

  await runBatch(b.deps, RUN);
  assert.equal(await sessionCount(b.store), 2,
    'the nightly run is idempotent for topics, pins, edges, signals and statements — and NOT for sessions');
});

test('the two session rows a retried run leaves are equal in everything but their id', async () => {
  // Which is what makes the duplication survivable rather than a correctness
  // bug: whichever row a reader lands on, the learner is shown the same session.
  const b = await bench('idem-session-equal', generateBoard(6, 3));
  await runBatch(b.deps, RUN);
  await runBatch(b.deps, RUN);

  const rows = (b.store as unknown as { db: { sessions: { id: string }[] } }).db.sessions;
  assert.equal(rows.length, 2);
  const stripped = rows.map((s) => JSON.stringify({ ...s, id: null }));
  assert.equal(stripped[0], stripped[1], 'same sections, same order, same estimate');
});
