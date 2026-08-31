import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LlmRefused, MODALITY_DENIED_DAYS,
  type Deps, type Llm, type LlmRequest, type LlmResult, type Signal, type Topic,
} from '@sb/core';

import { notebookDocs } from '@sb/core';
import { runBatch, sessionLearnerContext } from '../pipeline.js';
import { runModalityStage } from '../modality-stage.js';
import { readNotebookInput } from '../notebook-export.js';
import { bench, generateBoard, NOW, stageOf, type Bench } from './batch-harness.js';

/**
 * SB-282 — THE QUESTION, IN A NIGHT.
 *
 * The arithmetic is proved without a model in `core/src/__tests__/modality.test.ts`.
 * What is proved here is the part a pure test cannot reach: that the stage
 * spends nothing when it cannot possibly ask, that exactly one call is bought
 * when it can, that neither a refusal nor a failure costs the statements the
 * same stage wrote a moment earlier, and that a learner's no is honoured by the
 * stage and not only by the screen.
 *
 * A real `JsonStore` and a scripted model, so what is asserted is a night.
 */

const DAY_MS = 86_400_000;
const ago = (days: number): string => new Date(Date.parse(NOW) - days * DAY_MS).toISOString();

const topic = (id: string, label: string): Topic => ({
  id, label, summary: '', pinIds: [], state: 'working', comfort: 0.5,
  lastExposedAt: null, retiredByUser: false, createdAt: ago(120),
});

let counter = 0;
const marks = (topicId: string, n: number, well: number): Signal[] =>
  Array.from({ length: n }, (_, index) => ({
    id: `m-${++counter}`, topicId, type: index < well ? 'answer-correct' as const : 'answer-wrong' as const,
    direction: index < well ? 'positive' as const : 'negative' as const,
    at: ago(index + 1), sourceEvent: 'test', invalidated: false,
  }));

/**
 * A board with two topics that have been checked, and a contrast between them:
 * one of five went well on the first, five of six on the second.
 */
async function contrastingBoard(tag: string, opts: Record<string, unknown> = {}): Promise<Bench> {
  const b = await bench(tag, [], opts);
  await b.store.putTopic(topic('t-notation', 'Laplace transforms'));
  await b.store.putTopic(topic('t-logic', 'Consensus protocols'));
  for (const signal of [...marks('t-notation', 5, 1), ...marks('t-logic', 6, 5)]) {
    await b.store.appendSignal(signal);
  }
  return b;
}

/** The classification answer this test wants, with everything else untouched. */
const withKinds = (b: Bench, answer: (req: LlmRequest) => unknown): Llm => ({
  complete: () => b.llm.complete(),
  structured: async <T,>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => {
    if (stageOf(req) !== 'modality') return b.llm.structured<T>(req);
    const value = answer(req);
    if (value instanceof Error) throw value;
    return { value: value as T, modelId: 'stub', inputTokens: 0, outputTokens: 0 };
  },
});

/** Notation heavy on the first topic, logic on the second, by key order. */
const TWO_KINDS = (req: LlmRequest): unknown => ({
  topics: [...req.prompt.matchAll(/^(k\d+): (.*)$/gm)].map((m) => ({
    topic: String(m[1]),
    kind: String(m[2]).includes('Laplace') ? 'notation-heavy' : 'logic-structure',
  })),
});

const deps = (b: Bench, llm: Llm): Deps => ({ ...b.deps, llm });
const at = (): Date => new Date(NOW);

// -------------------------------------------------------- when nothing is spent

test('a board that cannot produce a contrast buys no call at all', async () => {
  const b = await bench('modality-quiet', []);
  await b.store.putTopic(topic('t-1', 'Laplace transforms'));
  for (const signal of marks('t-1', 9, 1)) await b.store.appendSignal(signal);
  const llm = withKinds(b, () => { throw new Error('the stage must not reach a model'); });

  const line = await runModalityStage(deps(b, llm), { now: at() });
  assert.match(line, /fewer than 6 checked outcomes/,
    'nine checks on one topic cannot be three in each of two kinds, and no answer could change that');
  assert.deepEqual(await b.store.listStatements(), []);
});

test('a learner who said no is not asked again inside the window, and is after it', async () => {
  const b = await contrastingBoard('modality-denied');
  const llm = withKinds(b, () => { throw new Error('the stage must not reach a model'); });
  await b.store.putPrefs({
    ...await b.store.getPrefs(),
    modalityDenied: { key: 'notation-heavy|logic-structure', at: ago(MODALITY_DENIED_DAYS - 1) },
  });

  const line = await runModalityStage(deps(b, llm), { now: at() });
  assert.match(line, new RegExp(`you said no to one inside the last ${MODALITY_DENIED_DAYS} days`));
  assert.deepEqual(await b.store.listStatements(), [], 'and nothing was written');

  await b.store.putPrefs({
    ...await b.store.getPrefs(),
    modalityDenied: { key: 'notation-heavy|logic-structure', at: ago(MODALITY_DENIED_DAYS) },
  });
  const after = await runModalityStage(deps(b, withKinds(b, TWO_KINDS)), { now: at() });
  assert.match(after, /1 modality question asked/, 'a month later it may be asked once more');
});

test('one is asked at a time, however much evidence arrives', async () => {
  const b = await contrastingBoard('modality-one-at-a-time');
  const first = await runModalityStage(deps(b, withKinds(b, TWO_KINDS)), { now: at() });
  assert.match(first, /1 modality question asked/);

  const llm = withKinds(b, () => { throw new Error('the stage must not reach a model'); });
  const second = await runModalityStage(deps(b, llm), { now: at() });
  assert.match(second, /one is already standing/);
  assert.equal((await b.store.listStatements()).length, 1);
});

// ------------------------------------------------------------ when it is asked

test('the question is stored unanswered, with its counts in the sentence', async () => {
  const b = await contrastingBoard('modality-asked');
  const line = await runModalityStage(deps(b, withKinds(b, TWO_KINDS)), { now: at() });
  assert.match(line, /1 modality question asked, notation-heavy\|logic-structure/);

  const [statement] = await b.store.listStatements();
  assert.equal(statement?.text,
    'Recent checks suggest notation heavy material goes less smoothly for you than'
    + ' logic and structure work: 1 of 5 checks went well on notation heavy material,'
    + ' against 5 of 6 on logic and structure work. Does that match how it feels?');
  assert.equal(statement?.modality?.confirmedAt, null, 'a question until a person answers it');
  assert.equal(statement?.userEdited, false);
  assert.equal(statement?.topicId, null, 'it is about a kind of material, not one topic');
  assert.equal(statement?.evidenceSignalIds.length, 11,
    'both sides of the comparison are pointed at');
});

test('exactly one call is bought, and the model is shown labels and nothing else', async () => {
  const b = await contrastingBoard('modality-one-call');
  const seen: LlmRequest[] = [];
  const llm = withKinds(b, (req) => { seen.push(req); return TWO_KINDS(req); });
  await runModalityStage(deps(b, llm), { now: at() });

  assert.equal(seen.length, 1, 'the classification is one call, and the cap is one');
  const prompt = seen[0]?.prompt ?? '';
  assert.match(prompt, /Laplace transforms/);
  assert.doesNotMatch(prompt, /answer-correct|answer-wrong|m-\d|t-notation|0\.5/,
    'no ledger id, no mark type and no number about the learner reaches the model');
});

// --------------------------------------------------- when the model does not

test('a classification that fails costs no statement and no night', async () => {
  const b = await contrastingBoard('modality-failed');
  const line = await runModalityStage(
    deps(b, withKinds(b, () => new Error('the provider fell over'))), { now: at() },
  );
  assert.match(line, /kinds MODEL-FAILED and no statement was lost/);
  assert.deepEqual(await b.store.listStatements(), []);
});

test('a refusal is declined here rather than carried out of the statements stage', async () => {
  /**
   * The same deliberate exception the night scout makes, and for a sharper
   * reason. This call happens inside `statements`, AFTER the sentences that
   * stage exists for have already been written. Letting the refusal out would
   * mark a stage failed whose actual work succeeded, over an optional question.
   */
  const b = await contrastingBoard('modality-refused');
  const line = await runModalityStage(
    deps(b, withKinds(b, () => new LlmRefused('your budget stopped this before anything was sent'))),
    { now: at() },
  );
  assert.match(line, /nothing was sent/);
  assert.deepEqual(await b.store.listStatements(), []);
});

test('kinds outside the vocabulary are dropped, and a contrast is not built from them', async () => {
  const b = await contrastingBoard('modality-invented');
  const line = await runModalityStage(deps(b, withKinds(b, (req) => ({
    topics: [...req.prompt.matchAll(/^(k\d+): /gm)].map((m, index) => ({
      topic: String(m[1]), kind: index === 0 ? 'symbolic-reasoning' : 'logic-structure',
    })),
  }))), { now: at() });

  assert.match(line, /no contrast of 0\.4 across 1 classified topic\(s\)/);
  assert.match(line, /1 outside the vocabulary/);
  assert.deepEqual(await b.store.listStatements(), [],
    'a fifth kind the model invented never becomes half of a claim about somebody');
});

// -------------------------------------------------------------- inside a night

test('the night asks it inside the statements stage, and never as a stage of its own', async () => {
  const b = await contrastingBoard('modality-in-a-night', {
    answer: (stage: string | null, req: LlmRequest) =>
      stage === 'modality' ? TWO_KINDS(req) : undefined,
  });
  const { reports } = await runBatch(b.deps);

  assert.equal(reports.some((report) => report.stage === 'modality'), false,
    'it is not a stage: the claim it makes is a statement and is answered as one');
  const statements = reports.find((report) => report.stage === 'statements');
  assert.equal(statements?.failed, false);
  assert.match(statements?.detail ?? '', /1 modality question asked/);
  assert.equal(b.llm.countOf('modality'), 1, 'one extra call a night, and only when it can ask');

  const rows = await b.store.listStatements();
  assert.equal(rows.filter((row) => row.modality).length, 1);
  assert.ok(rows.some((row) => !row.modality), 'the ordinary statements were written too');
});

test('a quiet night buys no classification call', async () => {
  const b = await bench('modality-night-quiet', generateBoard(4, 2));
  await runBatch(b.deps);
  assert.equal(b.llm.countOf('modality'), 0,
    'a board with no checked outcomes is told so by arithmetic, not by a model');
});

test('the nightly replace leaves the question and its answer alone', async () => {
  const b = await contrastingBoard('modality-survives', {
    answer: (stage: string | null, req: LlmRequest) =>
      stage === 'modality' ? TWO_KINDS(req) : undefined,
  });
  await runBatch(b.deps);
  const asked = (await b.store.listStatements()).find((row) => row.modality);
  assert.ok(asked, 'the question was asked on the first night');

  await runBatch(b.deps);
  const after = (await b.store.listStatements()).filter((row) => row.modality);
  assert.deepEqual(after.map((row) => row.id), [asked.id],
    'the second night did not delete it, ask it again, or leave two of them');
  assert.equal(b.llm.countOf('modality'), 1,
    'and it did not pay to classify a board it already has a question standing on');
});

// ------------------------------------------------- the claim-discipline law

test('an unanswered question reaches no teaching brief, and a confirmed one does', async () => {
  /**
   * The one enforcement point the whole feature stands on.
   *
   * `sessionLearnerContext` is what the Composer and the Verifier are handed as
   * things known about the learner. PRODUCT_SHAPE.md forbids modality
   * profiling existing in any form a person has not confirmed, so a question
   * must be invisible here and become ordinary the moment it is answered.
   */
  const b = await contrastingBoard('modality-brief');
  await runModalityStage(deps(b, withKinds(b, TWO_KINDS)), { now: at() });
  const [asked] = await b.store.listStatements();
  const signals = await b.store.listSignals();

  const before = sessionLearnerContext(await b.store.listStatements(), signals);
  assert.deepEqual(before.derived, [],
    'a sentence ending in a question mark is not something known about anybody');

  await b.store.putStatement({
    ...asked!, modality: { ...asked!.modality!, confirmedAt: NOW },
  });
  const after = sessionLearnerContext(await b.store.listStatements(), signals);
  assert.deepEqual(after.derived, [asked!.text],
    'confirmed, it is an ordinary read and is used like one');
});

test('a question is never handed over to another tool as a belief about the learner', async () => {
  const b = await contrastingBoard('modality-handover');
  await runModalityStage(deps(b, withKinds(b, TWO_KINDS)), { now: at() });
  const [asked] = await b.store.listStatements();

  const docs = notebookDocs(await readNotebookInput(b.store, b.deps.clock));
  const belief = docs.find((doc) => doc.body.includes('come to believe about how you learn'));
  assert.ok(belief, 'the handover still carries the learner model');
  assert.doesNotMatch(belief.body, /Does that match how it feels/,
    'a handover is where an unconfirmed claim would harden into a fact nobody can trace');

  await b.store.putStatement({
    ...asked!, modality: { ...asked!.modality!, confirmedAt: NOW },
  });
  const confirmed = notebookDocs(await readNotebookInput(b.store, b.deps.clock))
    .find((doc) => doc.body.includes('come to believe about how you learn'));
  assert.match(confirmed?.body ?? '', /notation heavy material/,
    'and once they have agreed with it, it travels like anything else they agreed with');
});
