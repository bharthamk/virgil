import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyse, analyseWithSecondAsk, observableMaterial,
  ANALYST_MATERIAL_TOPICS, ANALYST_PIN_FLOOR, type Observation,
} from '../agents/analyst.js';
import { LlmRefused } from '../ports/llm.js';
import type { Enrichment, Pin, Topic } from '../domain/types.js';
import type { Llm, LlmRequest, LlmResult } from '../ports/llm.js';
import { systemClock } from '../ports/clock.js';

/**
 * The Analyst's output contract, which is the loosest in the fleet and the one
 * whose output is read as provenance.
 *
 * An observation is a claim about the learner plus the pins that support it,
 * and the pins are the part the learner can check. Everything here is about the
 * ids being real — a cited id that resolves to nothing is worse than no
 * citation, because it looks like evidence.
 */

const pin = (id: string): Pin => ({
  id,
  type: 'interest',
  envelope: {
    selection: 'a passage', parts: [], surroundingText: 'around it',
    headingPath: ['Section'], pageTitle: 'A page', url: 'https://e.com',
    canonicalUrl: null, siteName: 'e.com', contentLanguage: 'en', media: null,
  },
  note: null, capturedAt: '2026-07-01T00:00:00Z', fromSuggestion: false,
  enrichment: null, topicId: null,
});

const PINS = ['p1', 'p2', 'p3', 'p4', 'p5'].map(pin);

const observation = (over: Partial<Observation> = {}): Observation => ({
  claim: 'They read explanations of things that can only be heard.',
  evidencePinIds: ['p1', 'p2'],
  implication: 'Play it before reading about it.',
  mediumMismatch: true,
  confidence: 0.8,
  ...over,
});

const stubLlm = (observations: unknown): Llm => ({
  complete: async () => { throw new Error('not used'); },
  structured: async <T>(_req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> =>
    ({ value: { observations } as T, modelId: 'stub', inputTokens: 0, outputTokens: 0 }),
});

const run = (observations: unknown): Promise<readonly Observation[]> =>
  analyse({ llm: stubLlm(observations), clock: systemClock }, { pins: PINS, topics: [] });

test('an observation citing pins that exist keeps all of them, in the order given', async () => {
  const out = await run([observation({ evidencePinIds: ['p3', 'p1'] })]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0]?.evidencePinIds, ['p3', 'p1']);
});

test('a pin id nobody was offered is not recorded as evidence', async () => {
  // The defect this test exists for: the ids were taken as given, so an id the
  // model invented became provenance — it reaches the Composer's brief and the
  // learner model, on the one surface whose promise is that the learner can go
  // and check the thing being claimed about them.
  const out = await run([observation({ evidencePinIds: ['p1', 'p99', 'pin-4', ''] })]);
  assert.deepEqual(out[0]?.evidencePinIds, ['p1'], 'an invented id survived into the evidence');
});

test('an observation left citing nothing real is dropped, not shown uncited', async () => {
  const out = await run([
    observation({ claim: 'all invented', evidencePinIds: ['p99', 'p100'] }),
    observation({ claim: 'real', evidencePinIds: ['p2'] }),
  ]);
  assert.deepEqual(out.map((o) => o.claim), ['real']);
});

test('the same id twice is one citation', async () => {
  const out = await run([observation({ evidencePinIds: ['p1', 'p1', 'p1'] })]);
  assert.deepEqual(out[0]?.evidencePinIds, ['p1'], 'one pin was counted as three pieces of evidence');
});

test('an id that names one offered pin imprecisely is repaired to it, not dropped', async () => {
  // The resolver the Composer already uses: a unique match after tidying is a
  // repair, and anything ambiguous is a drop. Never a guess between two.
  const out = await run([observation({ evidencePinIds: ['"p2"', ' p3 '] })]);
  assert.deepEqual(out[0]?.evidencePinIds, ['p2', 'p3']);
});

test('an observation with no implication is dropped', async () => {
  // The prompt requires one — an observation has to say what should CHANGE —
  // and the Composer renders it as an arrow, so a missing one reached the brief
  // as a dangling arrow with nothing after it.
  const out = await run([
    observation({ claim: 'no implication', implication: '' }),
    observation({ claim: 'has one' }),
  ]);
  assert.deepEqual(out.map((o) => o.claim), ['has one']);
});

test('nothing that parsed badly takes the rest of the observations down with it', async () => {
  const out = await run([null, observation({ claim: 'survives' }), { claim: 'no ids' }, 42]);
  assert.deepEqual(out.map((o) => o.claim), ['survives']);
});

test('observations still come back strongest first', async () => {
  const out = await run([
    observation({ claim: 'weak', confidence: 0.2 }),
    observation({ claim: 'strong', confidence: 0.9 }),
    observation({ claim: 'middling', confidence: 0.5 }),
  ]);
  assert.deepEqual(out.map((o) => o.claim), ['strong', 'middling', 'weak']);
});

test('under four pins there is nothing honest to say, and no call is made', async () => {
  let called = false;
  const llm: Llm = {
    complete: async () => { throw new Error('not used'); },
    structured: async () => { called = true; throw new Error('should not be reached'); },
  };
  const out = await analyse({ llm, clock: systemClock }, { pins: PINS.slice(0, 3), topics: [] });
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

// ---------------------------------------------------------- the second ask

/**
 *. On 2026-08-28 a seeded 21-pin board spent 152 seconds here and
 * returned zero observations; the identical board the run before returned
 * observation-rich output and eight statements. The stages under this one are
 * all-or-nothing and all eat from this plate, so one empty answer took the
 * statements, the night scout and the learner model with it, silently.
 *
 * Everything below is about the boundaries of the repair rather than the repair
 * itself: once, only on empty, only where the board plainly had material, and
 * never in place of a refusal.
 */

const READ: Enrichment = {
  refetchedText: null, assumedConcepts: [], mediaDescription: null, references: [],
  outcome: 'enriched', confidence: 'full', enrichedAt: '2026-07-02T00:00:00Z',
};

/** Four read pins over three topics: a board that plainly had something to say. */
const MATERIAL_PINS: Pin[] = ['p1', 'p2', 'p3', 'p4']
  .map((id) => ({ ...pin(id), enrichment: READ }));

const topic = (id: string, pinIds: readonly string[]): Topic => ({
  id, label: `Topic ${id}`, summary: '', pinIds, state: 'working', comfort: 0.4,
  lastExposedAt: null, retiredByUser: false, createdAt: '2026-07-01T00:00:00Z',
});

const MATERIAL_TOPICS = [topic('t1', ['p1']), topic('t2', ['p2']), topic('t3', ['p3', 'p4'])];

/** A model that answers each call from a script, and counts what it was asked. */
const scripted = (answers: readonly unknown[]): { llm: Llm; calls: () => number } => {
  let asked = 0;
  return {
    calls: () => asked,
    llm: {
      complete: async () => { throw new Error('not used'); },
      structured: async <T>(_req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => {
        const answer = answers[asked++] ?? { observations: [] };
        if (answer instanceof Error) throw answer;
        return { value: answer as T, modelId: 'stub', inputTokens: 0, outputTokens: 0 };
      },
    },
  };
};

test('an empty answer on a board with material buys exactly one more ask', async () => {
  const model = scripted([{ observations: [] }, { observations: [observation()] }]);
  const out = await analyseWithSecondAsk(
    { llm: model.llm, clock: systemClock }, { pins: MATERIAL_PINS, topics: MATERIAL_TOPICS },
  );
  assert.equal(model.calls(), 2, 'the second ask is a real call through the same port');
  assert.equal(out.reasked, true);
  assert.deepEqual(out.observations.map((o) => o.claim), [observation().claim]);
});

test('a second empty answer is the answer, and nothing asks a third time', async () => {
  const model = scripted([{ observations: [] }, { observations: [] }, { observations: [observation()] }]);
  const out = await analyseWithSecondAsk(
    { llm: model.llm, clock: systemClock }, { pins: MATERIAL_PINS, topics: MATERIAL_TOPICS },
  );
  assert.equal(model.calls(), 2, 'once, and only once');
  assert.equal(out.reasked, true);
  assert.deepEqual(out.observations, []);
});

test('an answer with something in it is not re-asked', async () => {
  const model = scripted([{ observations: [observation()] }]);
  const out = await analyseWithSecondAsk(
    { llm: model.llm, clock: systemClock }, { pins: MATERIAL_PINS, topics: MATERIAL_TOPICS },
  );
  assert.equal(model.calls(), 1);
  assert.equal(out.reasked, false);
});

test('an answer whose every observation was invented is empty, and is re-asked', async () => {
  // The count that matters is the VALIDATED one. An answer whose citations all
  // resolve to nothing leaves the stages below exactly as empty-handed as an
  // empty array does, and the surface that could tell them apart is this one.
  const model = scripted([
    { observations: [observation({ evidencePinIds: ['p99'] })] },
    { observations: [observation()] },
  ]);
  const out = await analyseWithSecondAsk(
    { llm: model.llm, clock: systemClock }, { pins: MATERIAL_PINS, topics: MATERIAL_TOPICS },
  );
  assert.equal(model.calls(), 2);
  assert.equal(out.observations.length, 1);
});

test('a board without material to observe is told once and believed', async () => {
  const model = scripted([{ observations: [] }, { observations: [observation()] }]);
  const out = await analyseWithSecondAsk(
    { llm: model.llm, clock: systemClock },
    { pins: MATERIAL_PINS, topics: MATERIAL_TOPICS.slice(0, ANALYST_MATERIAL_TOPICS - 1) },
  );
  assert.equal(model.calls(), 1, 'two topics cannot carry a cross-subject pattern');
  assert.equal(out.reasked, false);
});

test('below the pin floor nothing is asked at all, so nothing is asked twice', async () => {
  const model = scripted([{ observations: [observation()] }]);
  const out = await analyseWithSecondAsk(
    { llm: model.llm, clock: systemClock },
    { pins: MATERIAL_PINS.slice(0, ANALYST_PIN_FLOOR - 1), topics: MATERIAL_TOPICS },
  );
  assert.equal(model.calls(), 0, 'a first ask that never happened cannot be a second');
  assert.deepEqual(out, { observations: [], reasked: false });
});

test('a refusal during the second ask is a refusal, exactly as it always was', async () => {
  const model = scripted([{ observations: [] }, new LlmRefused('the spend limit was reached')]);
  await assert.rejects(
    () => analyseWithSecondAsk(
      { llm: model.llm, clock: systemClock }, { pins: MATERIAL_PINS, topics: MATERIAL_TOPICS },
    ),
    LlmRefused,
    'the second ask is an ordinary call and a stop on it stops the run',
  );
  assert.equal(model.calls(), 2);
});

test('material is read off the brief, and an unread pin is not material', async () => {
  assert.equal(observableMaterial({ pins: MATERIAL_PINS, topics: MATERIAL_TOPICS }), true);
  assert.equal(
    observableMaterial({ pins: MATERIAL_PINS.map((p) => ({ ...p, enrichment: null })), topics: MATERIAL_TOPICS }),
    false,
    'a pin the Forager still owes an attempt at has not been read by anything',
  );
  assert.equal(
    observableMaterial({ pins: MATERIAL_PINS, topics: [topic('t1', ['p1', 'p2', 'p3', 'p4'])] }),
    false,
    'one topic is one subject, and the prompt asks for a pattern across unrelated ones',
  );
});
