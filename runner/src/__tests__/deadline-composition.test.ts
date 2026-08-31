import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Commitment, Topic } from '@sb/core';

import { runBatch } from '../pipeline.js';
import { bench, makePin, NOW } from './batch-harness.js';

/**
 * **What is due changes what tonight teaches.**
 *
 * `dueWeight` is the capability the whole commitment ledger exists to unlock,
 * and `A_PLUS_PRODUCT_CONTRACT.md`'s acceptance clause 6 is the claim it makes:
 * a confirmed deadline affects priority without claiming knowledge. A topic the
 * learner is comfortable with and is examined on in three days outranks a topic
 * that has merely gone quiet. The Gardener has implemented it since the ledger
 * was written, `GET /board` and `GET /today` passed it their commitments, and
 * **the run that actually builds the session did not** — so the weight shaped
 * two read-only surfaces and shaped nothing anybody was ever taught.
 *
 * That is not visible in a gardener unit test, because the gardener was right.
 * It is only visible from the run, which is where this asks it.
 *
 * The board is four subjects with nothing to tell them apart: no signals, no
 * exposure, identical shape, so every topic is worth the same to the Gardener
 * and the composer's budget admits three of the four. Which one is dropped is
 * therefore decided by one thing only, and that is the point of the fixture.
 */

const RUN = { concurrency: 2, compositionMinutes: 15 } as const;
const GROUPS = ['k0', 'k1', 'k2', 'k3'] as const;

/** Two pins per subject, already filed, so the run has nothing to re-partition. */
const board = () => GROUPS.flatMap((g, i) => [
  makePin(`p${i}a`, g, { topicId: `topic-${g}` }),
  makePin(`p${i}b`, g, { topicId: `topic-${g}` }),
]);

const seedTopic = (g: string, i: number): Topic => ({
  id: `topic-${g}`,
  label: `Subject ${g}`,
  summary: `what ${g} is about`,
  pinIds: [`p${i}a`, `p${i}b`],
  state: 'working',
  comfort: 0.5,
  lastExposedAt: null,
  retiredByUser: false,
  createdAt: '2026-08-18T00:00:00.000Z',
});

const commitment = (topicId: string, dueAt: string): Commitment => ({
  id: `c-${topicId}`,
  title: 'Lab report',
  kind: 'assignment',
  courseId: null,
  topicIds: [topicId],
  dueAt,
  plannedFor: null,
  estimateMinutes: 60,
  notes: '',
  doneAt: null,
  createdAt: NOW,
});

/** The run, over the seeded board, with whatever is on the plan. */
async function built(tag: string, commitments: readonly Commitment[]) {
  const b = await bench(tag, board());
  for (const [i, g] of GROUPS.entries()) await b.store.putTopic(seedTopic(g, i));
  for (const c of commitments) await b.store.putCommitment(c);
  const { session } = await runBatch(b.deps, RUN);
  return { b, taught: (session?.sections ?? []).map((s) => s.topicId) };
}

async function taught(tag: string, commitments: readonly Commitment[]): Promise<string[]> {
  return (await built(tag, commitments)).taught;
}

test('with nothing due, the subject the budget drops is the last one on the board', async () => {
  // The control, and the reason the test below means anything: with four equal
  // subjects and room for three, the fourth is dropped on order alone.
  const sections = await taught('due-control', []);
  assert.equal(sections.length, 3, 'the budget admits three of the four subjects');
  assert.ok(!sections.includes('topic-k3'), 'the control is not already teaching it');
});

test('a deadline three days out pulls its subject into the session it would have missed', async () => {
  const sections = await taught('due-weighted', [commitment('topic-k3', '2026-08-22T23:59:00.000Z')]);
  assert.ok(sections.includes('topic-k3'),
    'the commitment ledger reached the board reads and never reached the run');
  assert.equal(sections.length, 3, 'and it earned its place rather than lengthening the night');
});

test('the work that selected a topic also reaches the practice brief as a fenced goal', async () => {
  const due = {
    ...commitment('topic-k3', '2026-08-22T23:59:00.000Z'),
    title: 'Audit one production page',
    notes: 'Use the keyboard from the top of the page.',
    rubricCriteria: [{
      id: 'r1', label: 'Observed evidence', description: 'Name one real control and what happened.',
      topicIds: ['topic-k3'], source: { sourceId: 'outline', quote: 'Observed evidence' },
    }],
  } satisfies Commitment;
  const { b } = await built('due-practice-brief', [due]);
  const prompt = b.llm.calls.find((call) => call.stage === 'compose')?.prompt ?? '';

  assert.match(prompt, /CURRENT LEARNER WORK THIS TOPIC SERVES/);
  assert.match(prompt, /<learner-work>/);
  assert.match(prompt, /Audit one production page/);
  assert.match(prompt, /Use the keyboard from the top of the page/);
  assert.match(prompt, /Observed evidence — Name one real control and what happened/);
  assert.equal(prompt.match(/CURRENT LEARNER WORK THIS TOPIC SERVES/g)?.length, 1);
  assert.ok(prompt.indexOf('CURRENT LEARNER WORK THIS TOPIC SERVES') > prompt.indexOf('TOPIC topic-k3'),
    'the work did not land in the topic brief it is linked to');
});

test('work that is already done weighs nothing, because the point is what is coming', async () => {
  const sections = await taught('due-done', [{
    ...commitment('topic-k3', '2026-08-22T23:59:00.000Z'), doneAt: '2026-08-19T01:00:00.000Z',
  }]);
  assert.ok(!sections.includes('topic-k3'));
});
