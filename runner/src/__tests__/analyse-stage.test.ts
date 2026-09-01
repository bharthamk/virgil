import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LlmRefused, type Llm, type LlmRequest, type LlmResult } from '@sb/core';

import { runBatch } from '../pipeline.js';
import { UsageMeter, meterLlm } from '../usage.js';
import { bench, generateBoard, stageOf, type Bench } from './batch-harness.js';

/**
 * SB-285 — THE ONE STAGE ALLOWED TO ASK TWICE, AND THE NIGHT THAT SAYS SO.
 *
 * On 2026-08-28 a seeded 21-pin board spent 152 seconds in the analyse stage
 * and returned zero observations. Every stage after it then did the lawful
 * thing: the statements stage wrote nothing, the night scout found nothing new
 * to look for, and the run finished green. The identical board on the previous
 * run had produced observation-rich output and eight statements. The delta was
 * model variance, and nothing anywhere told the learner the night had been thin.
 *
 * Two repairs are proved here, in a real `JsonStore` with the scripted model the
 * rest of the nightly tests use, so what is asserted is a night:
 *
 *  1. an empty analyse on a board with material buys exactly one more ask, that
 *     ask is a real metered call, a refusal on it still ends the run, and the
 *     receipt says which of the two answers the night got;
 *  2. a run that produced no observation, no statement and no proposal reports
 *     itself as lean, and one that produced any of the three does not.
 */

/** Six pins over three groups: three topics, all of them carrying read material. */
const BOARD = () => generateBoard(6, 3);

/** An answer the Analyst may give: a value, or a throw. */
type Answer = (prompt: string) => unknown;

/** Nothing found. The shape the observed run came back with, twice over. */
const EMPTY: Answer = () => ({ observations: [] });

/** One observation citing the first pin the brief listed, as the harness does. */
const FOUND: Answer = (prompt) => {
  const first = /^(\S+) \| \d{4}-/m.exec(prompt)?.[1];
  return first ? {
    observations: [{
      claim: 'You reach for the mechanism before the definition.',
      evidencePinIds: [first],
      implication: 'Lead with the mechanism.',
      mediumMismatch: false,
      confidence: 0.8,
    }],
  } : { observations: [] };
};

const REFUSED: Answer = () => new LlmRefused('your budget stopped this before anything was sent');

/**
 * The night, with the Analyst answering from a script and counting its asks.
 *
 * The last answer repeats, so a test that scripts one answer is asserting about
 * a model that always says that — which is what a variance problem looks like.
 */
const analysing = (b: Bench, answers: readonly Answer[]): { llm: Llm; asks: () => number } => {
  let asked = 0;
  return {
    asks: () => asked,
    llm: {
      complete: () => b.llm.complete(),
      structured: async <T,>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => {
        if (stageOf(req) !== 'analyse') return b.llm.structured<T>(req);
        const answer = answers[asked] ?? answers.at(-1) ?? EMPTY;
        asked += 1;
        const value = answer(req.prompt);
        if (value instanceof Error) throw value;
        return { value: value as T, modelId: 'stub', inputTokens: 3, outputTokens: 5 };
      },
    },
  };
};

const lineFor = (reports: readonly { stage: string; detail: string }[], stage: string): string =>
  reports.find((r) => r.stage === stage)?.detail ?? '';

// --------------------------------------------------------------- the second ask

test('an empty answer on a board with material is asked once more, and the receipt says so', async () => {
  const b = await bench('analyse-second-ask', BOARD());
  const model = analysing(b, [EMPTY]);
  const { reports } = await runBatch({ ...b.deps, llm: model.llm });

  assert.equal(model.asks(), 2, 'once more, and only once, however empty the answers keep being');
  assert.equal(lineFor(reports, 'analyse'), '0 observations after a second ask',
    'the silent version of this line is the whole reason the story exists');
  assert.equal(reports.find((r) => r.stage === 'analyse')?.failed, false,
    'a second empty answer is an answer, and the night carries on exactly as before');
});

test('the second ask can be the one that works, and the night keeps what it returns', async () => {
  const b = await bench('analyse-second-ask-lands', BOARD());
  const model = analysing(b, [EMPTY, FOUND]);
  const { reports, observations } = await runBatch({ ...b.deps, llm: model.llm });

  assert.equal(model.asks(), 2);
  assert.equal(lineFor(reports, 'analyse'), '1 observations after a second ask');
  assert.equal(observations.length, 1, 'and the stages below it are fed rather than starved');
});

test('a full first answer is not re-asked, and its line is the line it always was', async () => {
  const b = await bench('analyse-no-retry', BOARD());
  const model = analysing(b, [FOUND]);
  const { reports, lean } = await runBatch({ ...b.deps, llm: model.llm });

  assert.equal(model.asks(), 1);
  assert.equal(lineFor(reports, 'analyse'), '1 observations');
  assert.equal(lean, false, 'the night had something to say about the learner');
});

test('a board with too little material to observe is told once and believed', async () => {
  // One group, so one topic. Below the guard, an empty answer is the board
  // speaking rather than the model missing, and buying a second ask there would
  // be a retry on every quiet night in the product.
  const b = await bench('analyse-thin-board', generateBoard(6, 1));
  const model = analysing(b, [EMPTY]);
  const { reports } = await runBatch({ ...b.deps, llm: model.llm });

  assert.equal(model.asks(), 1);
  assert.equal(lineFor(reports, 'analyse'), '0 observations');
});

test('the second ask is a real call and is metered like any other', async () => {
  const b = await bench('analyse-metered', BOARD());
  const meter = new UsageMeter();
  const model = analysing(b, [EMPTY]);
  await runBatch({ ...b.deps, llm: meterLlm(model.llm, meter, 'runs') }, { usage: meter });

  const analyse = meter.report('2026-08-19T03:00:00.000Z').llm.rows
    .filter((row) => row.stage === 'analyse');
  assert.equal(analyse.reduce((n, row) => n + row.calls, 0), 2,
    'the retry goes through the same port and the same meter, or the budget is a lie');
  assert.equal(analyse.every((row) => row.lane === 'runs'), true);
});

test('a refusal on the second ask ends the run, exactly as one on the first does', async () => {
  const b = await bench('analyse-refused', BOARD());
  const model = analysing(b, [EMPTY, REFUSED]);
  await assert.rejects(
    () => runBatch({ ...b.deps, llm: model.llm }),
    (err: unknown) => err instanceof LlmRefused,
    'stage refusal semantics are unchanged: a stop is a stop, whichever ask met it',
  );
  assert.equal(model.asks(), 2);
});

// ------------------------------------------------------------- the lean night

test('a night that produced nothing for anybody downstream reports itself lean', async () => {
  /**
   * The observed run, reproduced. The Analyst comes back empty twice, so the
   * Registrar has neither evidence nor an observation to write from, so the
   * scout has no gap to look at. Three surfaces quiet at once, out of one empty
   * answer, which is the state this flag exists to name.
   */
  const b = await bench('analyse-lean', BOARD());
  const model = analysing(b, [EMPTY]);
  const result = await runBatch({ ...b.deps, llm: model.llm });

  assert.equal(result.observations.length, 0);
  assert.match(lineFor(result.reports, 'statements'), /^none produced — previous kept/);
  assert.deepEqual(await b.store.listProspectProposals(), []);
  assert.equal(result.lean, true);
  assert.equal(result.reports.some((r) => r.failed), false,
    'and every stage was lawful, which is exactly why nothing used to say this');
});
