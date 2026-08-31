import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EDGE_CONFIDENCE_FLOOR, MAX_EDGES_PER_TOPIC, orderTopics, survey,
} from '../agents/surveyor.js';
import type { PureDeps } from '../agents/deps.js';
import type { PrereqEdge, Topic } from '../domain/types.js';
import type { Llm, LlmRequest, LlmResult } from '../ports/llm.js';


const clock = { now: () => new Date('2026-08-20T03:00:00Z') };

const spyLlm = (payload: unknown): { llm: Llm; calls: LlmRequest[] } => {
  const calls: LlmRequest[] = [];
  return {
    calls,
    llm: {
      complete: async () => { throw new Error('the surveyor does not use complete()'); },
      structured: async <T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => {
        calls.push(req);
        return { value: payload as T, modelId: 'stub', inputTokens: 0, outputTokens: 0 };
      },
    },
  };
};

const deps = (llm: Llm): PureDeps => ({ llm, clock });

const topic = (id: string, over: Partial<Topic> = {}): Topic => ({
  id,
  label: `label of ${id}`,
  summary: `summary of ${id}`,
  pinIds: [`${id}-p1`],
  state: 'working',
  comfort: 0.5,
  lastExposedAt: null,
  retiredByUser: false,
  createdAt: '2026-07-01T00:00:00Z',
  ...over,
});

const edge = (from: string, to: string, confidence = 0.9): PrereqEdge =>
  ({ from, to, confidence, justification: `${to} builds on ${from}` });

// -------------------------------------------------------- what it will not assert

test('a board with nothing to order is not a model call', async () => {
  const { llm, calls } = spyLlm({ edges: [edge('a', 'b')] });
  assert.deepEqual(await survey(deps(llm), { topics: [] }), []);
  assert.deepEqual(await survey(deps(llm), { topics: [topic('only')] }), []);
  assert.equal(calls.length, 0, 'one topic cannot depend on anything');
});

test('a topic the learner retired is not in the graph, and cannot make the pair', async () => {
  const { llm, calls } = spyLlm({ edges: [edge('live', 'dropped')] });
  const out = await survey(deps(llm), {
    topics: [topic('live'), topic('dropped', { retiredByUser: true })],
  });
  assert.deepEqual(out, [], 'one active topic is not two');
  assert.equal(calls.length, 0);
});

test('an edge the model is not confident about is dropped, because a wrong order is worse than none', async () => {
  const { llm } = spyLlm({
    edges: [
      edge('basics', 'advanced', EDGE_CONFIDENCE_FLOOR),
      edge('basics', 'other', EDGE_CONFIDENCE_FLOOR - 0.01),
    ],
  });
  const out = await survey(deps(llm), {
    topics: [topic('basics'), topic('advanced'), topic('other')],
  });
  assert.deepEqual(out.map((e) => e.to), ['advanced'], 'the floor itself is kept, below it is not');
});

test('an edge naming a topic that is not on the board is dropped rather than followed', async () => {
  // The ids go into the prompt inside the fence and come back out of a model.
  // An id that names nothing is the cheapest hallucination available to it.
  const { llm } = spyLlm({ edges: [edge('basics', 'never-heard-of-it'), edge('ghost', 'advanced')] });
  const out = await survey(deps(llm), { topics: [topic('basics'), topic('advanced')] });
  assert.deepEqual(out, []);
});

test('a topic cannot be its own prerequisite', async () => {
  const { llm } = spyLlm({ edges: [edge('a', 'a'), edge('a', 'b')] });
  const out = await survey(deps(llm), { topics: [topic('a'), topic('b')] });
  assert.deepEqual(out.map((e) => `${e.from}->${e.to}`), ['a->b']);
});

test('the second half of a contradiction is refused, and the confident half survives', async () => {
  const { llm } = spyLlm({ edges: [edge('a', 'b', 0.7), edge('b', 'a', 0.95)] });
  const out = await survey(deps(llm), { topics: [topic('a'), topic('b')] });
  assert.deepEqual(out.map((e) => `${e.from}->${e.to}`), ['b->a'],
    'sorted by confidence first, so the one it believed more is the one that stands');
});

test('one topic cannot become a bottleneck for everything else', async () => {
  const froms = ['f1', 'f2', 'f3', 'f4', 'f5'];
  const { llm } = spyLlm({
    edges: froms.map((f, i) => edge(f, 'hub', 0.95 - i * 0.05)),
  });
  const out = await survey(deps(llm), { topics: [...froms, 'hub'].map((id) => topic(id)) });
  assert.equal(out.length, MAX_EDGES_PER_TOPIC);
  assert.deepEqual(out.map((e) => e.from), ['f1', 'f2', 'f3'],
    'and the ones it kept are the ones it was most confident about');
});

test('an edge carries the one line the ordering could be explained with', async () => {
  const { llm } = spyLlm({
    edges: [{ from: 'basics', to: 'advanced', confidence: 0.9, justification: '  this builds on what we just did  ' }],
  });
  const out = await survey(deps(llm), { topics: [topic('basics'), topic('advanced')] });
  assert.equal(out[0]!.justification, 'this builds on what we just did');
});

test('a missing justification is empty rather than undefined', async () => {
  const { llm } = spyLlm({ edges: [{ from: 'a', to: 'b', confidence: 0.9 }] });
  const out = await survey(deps(llm), { topics: [topic('a'), topic('b')] });
  assert.equal(out[0]!.justification, '');
});

test('a model that answers with nothing at all is an acceptable night', async () => {
  const { llm } = spyLlm({});
  assert.deepEqual(await survey(deps(llm), { topics: [topic('a'), topic('b')] }), []);
});

// ------------------------------------------------------------------ the ordering

test('the advanced pin he made first is taught second', () => {
  // the product contract, exactly: an ordering-key pattern pinned as interest, subscription
  // types struggled with separately, and the dependency recorded between them.
  const ordering = topic('ordering-keys', { comfort: 0.5 });
  const types = topic('subscription-types', { comfort: 0.2 });
  const out = orderTopics([ordering, types], [edge('subscription-types', 'ordering-keys')]);
  assert.deepEqual(out.map((t) => t.id), ['subscription-types', 'ordering-keys']);
});

test('within a tier, the thing they are worst at comes first', () => {
  const out = orderTopics(
    [topic('easy', { comfort: 0.9 }), topic('hard', { comfort: 0.1 }), topic('middle', { comfort: 0.5 })],
    [],
  );
  assert.deepEqual(out.map((t) => t.id), ['hard', 'middle', 'easy']);
});

test('a prerequisite outranks comfort — a topic never leads its own foundation', () => {
  // `foundation` is the most comfortable thing on the board and still goes first.
  const out = orderTopics(
    [topic('depends', { comfort: 0.1 }), topic('foundation', { comfort: 0.95 })],
    [edge('foundation', 'depends')],
  );
  assert.deepEqual(out.map((t) => t.id), ['foundation', 'depends']);
});

test('a chain is walked all the way down before it is taught back up', () => {
  const out = orderTopics(
    [topic('tritones'), topic('sevenths'), topic('intervals')],
    [edge('intervals', 'sevenths'), edge('sevenths', 'tritones')],
  );
  assert.deepEqual(out.map((t) => t.id), ['intervals', 'sevenths', 'tritones']);
});

test('a cycle costs the ordering, never the session', () => {
  // Unordered beats wrongly ordered, and both beat a nightly run that hangs.
  const out = orderTopics(
    [topic('a', { comfort: 0.6 }), topic('b', { comfort: 0.2 }), topic('c', { comfort: 0.4 })],
    [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')],
  );
  assert.deepEqual(out.map((t) => t.id).sort(), ['a', 'b', 'c'], 'every topic, exactly once');
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((t) => t.id), ['b', 'c', 'a'], 'and it degrades to comfort order');
});

test('an edge pointing at a topic that is not in this run\'s pool blocks nothing', () => {
  const out = orderTopics([topic('a'), topic('b')], [edge('not-this run', 'a'), edge('a', 'b')]);
  assert.deepEqual(out.map((t) => t.id), ['a', 'b']);
});

test('the same board and the same edges order the same way twice', () => {
  const topics = [topic('a', { comfort: 0.3 }), topic('b', { comfort: 0.3 }), topic('c', { comfort: 0.7 })];
  const edges = [edge('a', 'c')];
  assert.deepEqual(
    orderTopics(topics, edges).map((t) => t.id),
    orderTopics(topics, edges).map((t) => t.id),
  );
});

test('an empty board orders to an empty session rather than to an error', () => {
  assert.deepEqual(orderTopics([], [edge('a', 'b')]), []);
});
