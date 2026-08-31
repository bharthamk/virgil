import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  forage, fixedClock,
  type ComposedSection, type Deps, type Llm, type LlmRequest, type LlmResult,
  type Pin, type Research,
} from '@sb/core';
import { JsonStore, TfIdfEmbedder } from '@sb/adapters';

import { runBatch, verifySections } from '../pipeline.js';

/**
 * What the fleet does when the seam misbehaves.
 *
 * The adapter contract in `adapters/src/__tests__/llm-contract.ts` says what an
 * adapter must do. This says what everything downstream must do when an adapter
 * does it — because the port introduces a new adapter against new API shapes,
 * and the honest expectation is that it will misbehave in ways nobody predicted
 * before it misbehaves in production.
 *
 * The faults below are not invented. They are the shapes this project has
 * already been bitten by, plus the ones a hosted API adds: a deadline firing, a
 * 429, a 5xx, a socket dying, JSON truncated by a token budget (graceful-degradation constraint), a reply
 * that parsed but did not conform, and — the one that matters most — a reply of
 * the wrong shape arriving anyway, because a new adapter's schema enforcement
 * is exactly the thing most likely to be subtly wrong on day one.
 *
 * The rule being checked throughout is graceful-degradation constraint’s: one agent's bad night must not
 * become the learner's. And its companion, from the Verifier: a safety check
 * that fails open is worse than no safety check, because it manufactures the
 * confidence.
 *
 * No model is called anywhere in this file.
 */

const NOW = '2026-08-19T03:00:00.000Z';

// ------------------------------------------------------------ the fault catalogue

/** What a structured call can do to its caller other than answer it. */
interface Fault {
  readonly name: string;
  readonly throw?: () => unknown;
  /** A reply the adapter should never have let through. */
  readonly value?: unknown;
}

/** Faults the adapter itself surfaces as a rejection. */
const REJECTIONS: readonly Fault[] = [
  { name: 'a fired deadline', throw: () => new DOMException('This operation was aborted', 'AbortError') },
  { name: 'a 429 from the provider', throw: () => new Error('gemini 429: resource exhausted') },
  { name: 'a 5xx from the provider', throw: () => new Error('gemini 503: backend unavailable') },
  { name: 'a dead socket', throw: () => new TypeError('fetch failed') },
  {
    name: 'JSON truncated past repair',
    throw: () => new Error('structured output did not conform after 3 attempts: '
      + 'SyntaxError: Unexpected end of JSON input'),
  },
  {
    name: 'schema drift past repair',
    throw: () => new Error('structured output did not conform after 3 attempts: '
      + 'schema drift — $.sections: expected array, got string'),
  },
];

/**
 * Faults a *lax adapter* surfaces as a successful reply.
 *
 * These are the ones the contract suite exists to make impossible, and the ones
 * that will happen anyway if the next adapter's enforcement has a hole in it.
 * Nothing downstream may treat any of them as an answer.
 */
const LAX_REPLIES: readonly Fault[] = [
  { name: 'prose where an object was required', value: 'I was not able to check that section.' },
  { name: 'an object with none of the required fields', value: {} },
  { name: 'null', value: null },
  { name: 'the required list arriving as a string', value: { defects: 'none', sections: 'none', assumedConcepts: 'none' } },
  { name: 'the required list arriving as an object', value: { defects: { kind: 'unsupported' }, sections: {} } },
];

// -------------------------------------------------------------------- the fleet

type AgentName = 'forage' | 'cluster' | 'survey' | 'analyse' | 'statements' | 'compose' | 'verify';

const AGENTS: readonly AgentName[] =
  ['forage', 'cluster', 'survey', 'analyse', 'statements', 'compose', 'verify'];

/**
 * Which agent is on the other end of this call.
 *
 * Read off the schema's own required fields, so it cannot drift from what the
 * agents actually ask for: change an agent's schema and this stops recognising
 * it loudly rather than silently faulting the wrong stage.
 */
function agentOf(req: LlmRequest): AgentName {
  const required = (req.schema as { required?: readonly string[] } | undefined)?.required ?? [];
  if (required.includes('assumedConcepts')) return 'forage';
  if (required.includes('names')) return 'cluster';
  if (required.includes('edges')) return 'survey';
  if (required.includes('observations')) return 'analyse';
  if (required.includes('statements')) return 'statements';
  if (required.includes('sections')) return 'compose';
  if (required.includes('defects')) return 'verify';
  throw new Error(`unrecognised agent at the seam: required=${JSON.stringify(required)}`);
}

const topicIdsIn = (prompt: string): string[] =>
  [...prompt.matchAll(/^TOPIC (\S+):/gm)].map((m) => m[1] as string);

const sourceIdsIn = (prompt: string): string[] =>
  [...prompt.matchAll(/^\s*- \[([^\]]+)\]/gm)].flatMap((m) => (m[1] as string).split(',').map((s) => s.trim()));

/** A reply each agent is happy with, built from what it was actually asked. */
function healthy(agent: AgentName, req: LlmRequest): unknown {
  switch (agent) {
    case 'forage': return { assumedConcepts: ['the ack deadline'], mediaDescription: null };
    // The partition is decided in code; naming degrades to heading paths.
    case 'cluster': return { names: [] };
    case 'survey': return { edges: [] };
    case 'analyse': return { observations: [] };
    case 'statements': return { statements: [] };
    case 'compose': return {
      sections: topicIdsIn(req.prompt).map((id) => ({
        topicId: id,
        heading: 'What this is about',
        body: 'A paragraph of teaching prose about the pinned material, long enough to be a section. '.repeat(6),
        estimatedMinutes: 4,
        question: null,
        sourceIds: sourceIdsIn(req.prompt).slice(0, 1),
        mediumWarning: null,
      })),
      closingNote: null,
    };
    case 'verify': return { defects: [] };
  }
}

/**
 * An `Llm` that answers every agent well except the one under test.
 *
 * It stands where a real adapter stands, so nothing downstream can tell the
 * difference between this and a Gemini adapter having a bad night.
 */
function seamWith(faulted: AgentName | null, fault: Fault | null): Llm {
  return {
    complete: async () => ({ value: '', modelId: 'injected', inputTokens: 0, outputTokens: 0 }),
    structured: async <T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => {
      const agent = agentOf(req);
      const value = agent === faulted && fault
        ? (() => { if (fault.throw) throw fault.throw(); return fault.value; })()
        : healthy(agent, req);
      return { value: value as T, modelId: 'injected', inputTokens: 1, outputTokens: 1 };
    },
  };
}

// -------------------------------------------------------------------- the board

const noResearch: Research = { fetchPage: async () => null, findReferences: async () => [], hasGrounding: false };

const pin = (id: string, subject: string, selection: string): Pin => ({
  id, type: 'interest',
  envelope: {
    selection,
    parts: [], surroundingText: selection,
    headingPath: [subject], pageTitle: subject, url: `https://example.test/${id}`,
    canonicalUrl: null, siteName: null, contentLanguage: 'en', media: null,
  },
  note: null, capturedAt: '2026-08-01T00:00:00.000Z', fromSuggestion: false,
  enrichment: null, topicId: null,
});

/**
 * Four pins over two subjects with no shared vocabulary between them.
 *
 * Deliberately chosen so the TF-IDF partition lands on more than one topic:
 * the Surveyor returns early on a board with fewer than two, and a stage that
 * never reaches the seam cannot be shown to survive it. The corpus is the same
 * shape as single-next-move constraint’s fix — a subject nothing else on the board can absorb.
 */
async function board(tag: string, llm: Llm): Promise<{ store: JsonStore; deps: Deps }> {
  const store = new JsonStore(join(mkdtempSync(join(tmpdir(), `sb-inject-${tag}-`)), 'db.json'));
  await store.putPin(pin('p1', 'Pull subscriptions',
    'A pull subscription uses a subscriber client that opens a streaming connection and receives '
    + 'messages from the broker until it closes.'));
  await store.putPin(pin('p2', 'Acknowledgement deadlines',
    'The acknowledgement deadline is the window in which a subscriber client must acknowledge a '
    + 'delivered message before the broker redelivers it.'));
  await store.putPin(pin('p3', 'Sourdough hydration',
    'Sourdough hydration is the ratio of water to flour by weight in a bread dough, and higher '
    + 'hydration gives an opener crumb.'));
  await store.putPin(pin('p4', 'Proving times',
    'Proving time for a loaf depends on the temperature of the kitchen and the strength of the '
    + 'starter culture in the dough.'));
  return {
    store,
    deps: { llm, store, research: noResearch, clock: fixedClock(NOW), embedder: new TfIdfEmbedder() },
  };
}

// ----------------------------------------------------------------- the verifier

const section = (over: Partial<ComposedSection> = {}): ComposedSection => ({
  topicId: 't1', heading: 'Pull subscriptions', body: 'A claim the material does not support.',
  depth: 'building', estimatedMinutes: 4, question: null, sourceIds: [], mediumWarning: null, ...over,
});

const verifyDeps = (llm: Llm) => ({ llm, clock: fixedClock(NOW) });

for (const fault of REJECTIONS) {
  test(`the verifier withholds rather than ships when the seam gives it ${fault.name}`, async () => {
    const out = await verifySections(verifyDeps(seamWith('verify', fault)), {
      sections: [section()], pins: [], knownAboutLearner: [],
    });
    assert.deepEqual([...out.kept], [], 'an unchecked section reached the learner');
    assert.equal(out.withheld[0]?.reason, 'unverified',
      'a section the check never ran on is neither verified nor defective, and must say so');
    assert.match(out.detail, /UNVERIFIED/,
      'the run has to be able to say the safety check stopped working');
  });
}

for (const fault of LAX_REPLIES) {
  test(`the verifier withholds rather than ships when a lax adapter returns ${fault.name}`, async () => {
    // The dangerous direction. A rejection is loud; a reply of the wrong shape
    // reads as "no defects found", and no defects found is how a clean section
    // looks. This is the exact shape of single-next-move constraint/capture-envelope constraint/provider-configuration constraint — the plumbing was wrong and
    // the output looked like a verdict.
    const out = await verifySections(verifyDeps(seamWith('verify', fault)), {
      sections: [section()], pins: [], knownAboutLearner: [],
    });
    assert.deepEqual([...out.kept], [],
      'a reply that never contained a verdict was read as a clean bill of health');
    assert.equal(out.withheld[0]?.reason, 'unverified');
  });
}

test('a verifier reply that really is clean still ships the section', async () => {
  // The counterweight. A withhold-everything verifier would pass every test
  // above and deliver nothing, for ever.
  const out = await verifySections(verifyDeps(seamWith(null, null)), {
    sections: [section()], pins: [], knownAboutLearner: [],
  });
  assert.equal(out.kept.length, 1);
  assert.deepEqual([...out.withheld], []);
});

// ------------------------------------------------------------------ the forager

for (const fault of [...REJECTIONS, ...LAX_REPLIES]) {
  test(`the forager degrades observably when the seam gives it ${fault.name}`, async () => {
    const deps = {
      llm: seamWith('forage', fault), clock: fixedClock(NOW), research: noResearch,
      store: new Proxy({}, { get: () => () => { throw new Error('forage must not touch the store'); } }),
      embedder: { modelId: 'unused', embed: async () => { throw new Error('forage must not embed'); } },
    } as unknown as Deps;

    const enrichment = await forage(deps, { pin: pin('p1', 'Pull subscriptions', 'A pull subscription uses a subscriber client.') });
    assert.equal(enrichment.outcome, 'model-failed',
      'a swallowed failure that looks identical to "this passage needed nothing" is how 19 of 21 '
      + 'failed calls were once reported as a healthy run');
    assert.deepEqual([...enrichment.assumedConcepts], [],
      'nothing may be asserted about a passage the model never read');
    assert.equal(enrichment.confidence, 'reduced');
  });
}

test('the forager records a real answer as a real answer', async () => {
  const deps = {
    llm: seamWith(null, null), clock: fixedClock(NOW), research: noResearch,
    store: null, embedder: null,
  } as unknown as Deps;
  const enrichment = await forage(deps, { pin: pin('p1', 'Pull subscriptions', 'A pull subscription uses a subscriber client.') });
  assert.equal(enrichment.outcome, 'enriched');
});

// ------------------------------------------------------------- the nightly run

test('no fault at any stage stops the nightly run', async () => {
  // graceful-degradation constraint: the Analyst returned truncated JSON, the parse threw, and nine minutes
  // of good work was thrown away. Every stage is now independently
  // failure-tolerant — which is a claim about seven stages and every way the
  // seam can fail, so it is checked as the matrix it is.
  for (const agent of AGENTS) {
    for (const fault of [...REJECTIONS, ...LAX_REPLIES]) {
      const { deps } = await board(`${agent}-x`, seamWith(agent, fault));
      const result = await runBatch(deps, { concurrency: 2 });
      const stages = result.reports.map((r) => r.stage);
      for (const expected of ['forage', 'cluster', 'survey', 'analyse', 'comfort', 'statements', 'garden']) {
        assert.ok(stages.includes(expected),
          `${agent} + ${fault.name}: the run stopped before ${expected} — one agent's bad night became the learner's`);
      }
    }
  }
});

test('a faulted stage says it failed rather than reporting success', async () => {
  // Degrading is only half of it. A stage that degrades silently is how a run
  // reports "all sections clear" on a night the checking did not happen.
  for (const agent of ['survey', 'analyse', 'compose'] as const) {
    const { deps } = await board(`${agent}-loud`, seamWith(agent, REJECTIONS[1] as Fault));
    const { reports } = await runBatch(deps, { concurrency: 2 });
    const report = reports.find((r) => r.stage === agent);
    assert.equal(report?.failed, true, `the ${agent} stage failed and did not say so`);
    assert.match(report?.detail ?? '', /FAILED/);
  }
});

test('a run whose composer failed writes no session at all', async () => {
  const { store, deps } = await board('compose-none', seamWith('compose', REJECTIONS[4] as Fault));
  const result = await runBatch(deps, { concurrency: 2 });
  assert.equal(result.session, null, 'a session built from nothing is worse than no session');
  assert.equal(await store.latestSession(), null, 'a failed compose must not leave a session behind');
});

test('a run whose verifier failed ships nothing and says why', async () => {
  const { store, deps } = await board('verify-none', seamWith('verify', REJECTIONS[0] as Fault));
  const result = await runBatch(deps, { concurrency: 2 });
  assert.ok(result.withheld.length > 0, 'the composer produced sections and none were withheld');
  assert.ok(result.withheld.every((w) => w.reason === 'unverified'));
  assert.deepEqual([...result.session?.sections ?? []], [],
    'an unverified section reached the stored session');
  const stored = await store.latestSession();
  assert.deepEqual([...stored?.sections ?? []], []);
});

test('a healthy run really does produce a verified session', async () => {
  // Without this, every assertion above could be satisfied by a pipeline that
  // never builds anything.
  const { store, deps } = await board('healthy', seamWith(null, null));
  const result = await runBatch(deps, { concurrency: 2 });
  assert.ok(result.session, 'the harness stopped being able to build a session');
  assert.ok((result.session?.sections.length ?? 0) > 0);
  assert.deepEqual([...result.withheld], []);
  assert.ok(await store.latestSession());
});

// --------------------------------------------------------- hallucinated ids

test('a section for a topic that does not exist is not taught', async () => {
  // A model naming an id it was never offered is the most ordinary hallucination
  // there is, and the Composer already checks SOURCE ids against what it
  // offered. The topic id is the one that decides which pins the Verifier reads
  // and which topic goes back into the pool, and a section attached to
  // nothing silently starves both.
  const inventing: Llm = {
    complete: async () => ({ value: '', modelId: 'injected', inputTokens: 0, outputTokens: 0 }),
    structured: async <T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => {
      const agent = agentOf(req);
      if (agent !== 'compose') {
        return { value: healthy(agent, req) as T, modelId: 'injected', inputTokens: 1, outputTokens: 1 };
      }
      const real = healthy('compose', req) as { sections: unknown[]; closingNote: null };
      return {
        value: {
          sections: [
            ...real.sections,
            {
              topicId: 'topic-the-model-made-up', heading: 'Something else entirely',
              body: 'Prose about a topic that is not on this board at all. '.repeat(8),
              estimatedMinutes: 4, question: null, sourceIds: [], mediumWarning: null,
            },
          ],
          closingNote: null,
        } as T,
        modelId: 'injected', inputTokens: 1, outputTokens: 1,
      };
    },
  };

  const { deps } = await board('hallucinated', inventing);
  const result = await runBatch(deps, { concurrency: 2 });
  const taught = [...result.session?.sections ?? [], ...result.withheld].map((s) => s.topicId);
  assert.ok(!taught.includes('topic-the-model-made-up'),
    'a section was built for a topic id the Composer was never offered');
});
