import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compose } from '../agents/composer.js';
import type { PureDeps } from '../agents/deps.js';
import type { Llm, LlmRequest, LlmResult } from '../ports/llm.js';
import type { Pin, Topic } from '../domain/types.js';
import type { ComfortResult } from '../agents/registrar.js';
import type { GardenDecision } from '../agents/gardener.js';

/**
 * SB-32 — I finish and see what changed.
 *
 * "Three lines. No dashboard, no percentage, no chart." The closing note is
 * contracted in the Composer's schema and rendered by the panel, and nothing
 * asserted that a composed session actually carries one — so the one artefact
 * that makes the effort look like it compounded was a field that could quietly
 * stop arriving without a single test going red.
 *
 * The absence of a metrics surface is the story's real demand and is the harder
 * thing to keep: a closing note is one string, and a dashboard is what gets
 * added to it. So what is asserted here is that the session's summary is a
 * sentence and that there is nowhere else on a session for a number to live.
 */

const clock = { now: () => new Date('2026-08-20T03:00:00Z') };

const stub = (closingNote: unknown): { deps: PureDeps; calls: LlmRequest[] } => {
  const calls: LlmRequest[] = [];
  const llm: Llm = {
    complete: async () => { throw new Error('the composer does not use complete()'); },
    structured: async <T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => {
      calls.push(req);
      const sections = [...req.prompt.matchAll(/^TOPIC (\S+):/gm)].map((m) => ({
        topicId: m[1], heading: `on ${m[1]}`, body: 'a few sentences of prose about it',
        estimatedMinutes: 2, question: null, sourceIds: [], mediumWarning: null,
      }));
      return {
        value: { sections, ...(closingNote === undefined ? {} : { closingNote }) } as T,
        modelId: 'stub', inputTokens: 0, outputTokens: 0,
      };
    },
  };
  return { deps: { llm, clock }, calls };
};

const topic = (id: string): Topic => ({
  id, label: `label of ${id}`, summary: '', pinIds: [`pin-${id}`],
  state: 'working', comfort: 0.4, lastExposedAt: null,
  retiredByUser: false, createdAt: '2026-07-01T00:00:00Z',
});

const pin = (topicId: string): Pin => ({
  id: `pin-${topicId}`,
  type: 'interest',
  envelope: {
    selection: `what they read about ${topicId}`,
    parts: [], surroundingText: 'ordinary prose around it', headingPath: ['Docs'],
    pageTitle: 'a page', url: 'https://example.test/doc', canonicalUrl: null,
    siteName: null, contentLanguage: 'en', media: null,
  },
  note: null, capturedAt: '2026-07-02T00:00:00Z', fromSuggestion: false,
  enrichment: null, topicId,
});

const comfort = (topicId: string): ComfortResult => ({
  topicId, comfort: 0.4, regressed: false, evidenceCount: 3, demonstrationCount: 2, certainty: 0.7,
  evidenceSignalIds: [`s-${topicId}`],
});

const decision = (topicId: string): GardenDecision =>
  ({ topicId, disposition: 'teach', reason: 'you have been struggling with this', priority: 70 });

const input = (ids: readonly string[]) => ({
  topics: ids.map(topic),
  pins: ids.map(pin),
  comforts: ids.map(comfort),
  decisions: ids.map(decision),
  observations: [],
  knownAboutLearner: [],
  targetMinutes: 15,
  interfaceLanguage: 'en',
  fallback: null,
});

const CLOSING = 'IAM conditions — from nothing to workable. Pub/Sub ordering — confirmed. Cloud Run — one gap left.';

test('SB-32: a finished session carries the three clauses the panel closes on', async () => {
  const { deps } = stub(CLOSING);
  const out = await compose(deps, input(['iam', 'pubsub']));
  assert.equal(out.closingNote, CLOSING);
});

test('SB-32: the model is told what closure is, and what it must not become', async () => {
  // The instruction is the control. Naming the remaining gap is what makes the
  // next session feel earned; a percentage is what invites gaming it.
  const { deps, calls } = stub(CLOSING);
  await compose(deps, input(['iam', 'pubsub']));
  assert.match(calls[0]!.system, /closingNote: three short clauses naming what moved and what is still open/);
  assert.match(calls[0]!.system, /No score, no percentage/);
});

test('SB-32: a session with no closing note says none rather than undefined', async () => {
  const { deps } = stub(undefined);
  const out = await compose(deps, input(['iam']));
  assert.equal(out.closingNote, null, 'the panel renders nothing, rather than the word undefined');
});

test('SB-32: a night with nothing to teach closes on nothing at all', async () => {
  const { deps } = stub(CLOSING);
  const out = await compose(deps, input([]));
  assert.equal(out.insufficient, true);
  assert.equal(out.closingNote, null, 'an empty state must not be handed a summary of what moved');
});

test('SB-32: there is nowhere on a session for a score to live', async () => {
  // Metrics dashboards are the wrong instinct for an adult learning tool, and
  // the way one arrives is a field, not a decision. A session carries minutes,
  // a register per section and a sentence — no percentage, no streak, no total.
  const { deps } = stub(CLOSING);
  const out = await compose(deps, input(['iam', 'pubsub']));
  const forbidden = ['score', 'percent', 'streak', 'points', 'grade', 'accuracy', 'progress'];
  for (const key of Object.keys(out)) {
    for (const word of forbidden) {
      assert.ok(!key.toLowerCase().includes(word), `a session must not carry a "${key}"`);
    }
  }
  for (const section of out.sections) {
    for (const key of Object.keys(section)) {
      for (const word of forbidden) {
        assert.ok(!key.toLowerCase().includes(word), `a section must not carry a "${key}"`);
      }
    }
  }
});
