import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compose, REVISION_MINUTES } from '../agents/composer.js';
import type { PureDeps } from '../agents/deps.js';
import type { Llm, LlmRequest, LlmResult } from '../ports/llm.js';
import type { Pin, Topic } from '../domain/types.js';
import type { ComfortResult } from '../agents/registrar.js';
import type { Disposition, GardenDecision } from '../agents/gardener.js';

/**
 * SB-23 — the fallback offer, which the Gardener computed and nothing composed.
 *
 * "Not enough new to build a proper session. Want a 5-minute refresh on two
 * things from last week instead?" was a field called `Pool.fallback` set to
 * `'revision'` and read by no one, while the panel said "Nothing ready yet".
 * The story calls the offer mandatory and calls it something that must be
 * *genuinely useful, not a consolation prize* — so it is a real session, over
 * material the learner has already met, written to the story's five minutes.
 */

const clock = { now: () => new Date('2026-08-19T03:00:00Z') };

const stub = (): { deps: PureDeps; prompts: string[] } => {
  const prompts: string[] = [];
  const llm: Llm = {
    complete: async () => { throw new Error('the composer does not use complete()'); },
    structured: async <T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => {
      prompts.push(req.prompt);
      // One section per topic the brief actually asked for, which is what makes
      // the section count a statement about the brief rather than about a stub.
      const sections = [...req.prompt.matchAll(/^TOPIC (\S+):/gm)].map((m) => ({
        topicId: m[1], heading: `on ${m[1]}`, body: 'a few sentences of prose about it',
        estimatedMinutes: 2, question: null, sourceIds: [], mediumWarning: null,
      }));
      return {
        value: { sections, closingNote: 'one, another, a third' } as T,
        modelId: 'stub', inputTokens: 0, outputTokens: 0,
      };
    },
  };
  return { deps: { llm, clock }, prompts };
};

const topic = (id: string): Topic => ({
  id, label: `label of ${id}`, summary: '', pinIds: [`pin-${id}`],
  state: 'settled', comfort: 0.9, lastExposedAt: '2026-08-12T09:00:00Z',
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
  topicId, comfort: 0.9, regressed: false, evidenceCount: 4, demonstrationCount: 2, certainty: 0.9,
  evidenceSignalIds: [`s-${topicId}`],
});

const decision = (topicId: string, disposition: Disposition = 'settled'): GardenDecision =>
  ({ topicId, disposition, reason: 'you have this', priority: disposition === 'settled' ? 0 : 60 });

const input = (ids: readonly string[], fallback: 'revision' | null) => ({
  topics: ids.map(topic),
  pins: ids.map(pin),
  comforts: ids.map(comfort),
  decisions: ids.map((id) => decision(id)),
  observations: [],
  knownAboutLearner: [],
  targetMinutes: 15,
  interfaceLanguage: 'en',
  fallback,
});

test('SB-23: the revision offer is composed, where before it was computed and dropped', async () => {
  const { deps, prompts } = stub();
  const out = await compose(deps, input(['firestore', 'iam'], 'revision'));

  assert.equal(out.insufficient, false, 'this is a session, not an empty card');
  assert.equal(out.revision, true, 'and it says which kind of night it is');
  assert.equal(out.sections.length, 2, 'two things from last week');
  assert.match(prompts[0] ?? '', /REVISION REFRESH, NOT A NEW LESSON/,
    'the model is told what it is writing, or it writes a short lesson instead');
});

test('SB-23: the refresh is written to five minutes, not to the session budget', async () => {
  // The learner's target is 15 minutes. A refresh that quietly spends it would
  // be a session pretending to be an offer.
  const { deps, prompts } = stub();
  const out = await compose(deps, input(['firestore', 'iam'], 'revision'));
  assert.equal(out.targetMinutes, REVISION_MINUTES);
  assert.match(prompts[0] ?? '', /Session budget: 5 minutes/,
    'the budget the model is given is the budget the learner was offered');
});

test('SB-23: absorbed material is admitted on this path and on no other', async () => {
  // A `settled` topic is one the product has no business teaching again, which
  // is why the Composer drops it on an ordinary night. It is also exactly the
  // right thing to spend five minutes on when there is nothing new.
  const ordinary = await compose(stub().deps, input(['firestore', 'iam'], null));
  assert.equal(ordinary.insufficient, true, 'unchanged: settled is not teaching material');
  assert.equal(ordinary.revision, false);

  const refresh = await compose(stub().deps, input(['firestore', 'iam'], 'revision'));
  assert.equal(refresh.sections.length, 2);
});

test('SB-23: the offer is capped at two things, however much is on the shelf', async () => {
  const { deps } = stub();
  const out = await compose(deps, input(['a-topic', 'b-topic', 'c-topic', 'd-topic'], 'revision'));
  assert.equal(out.sections.length, 2, 'a refresh that grows into a session is a padded session');
});

test('SB-23: an empty board offers no refresh, and the honest empty state survives', async () => {
  const { deps } = stub();
  const out = await compose(deps, input([], 'revision'));

  assert.equal(out.insufficient, true);
  assert.equal(out.revision, false, 'nothing to revise is not a revision session');
  assert.deepEqual([...out.sections], []);
});

test('an ordinary session is unchanged, and says it is not a refresh', async () => {
  const { deps } = stub();
  const teaching = {
    ...input(['firestore', 'iam'], null),
    decisions: ['firestore', 'iam'].map((id) => decision(id, 'teach')),
  };
  const out = await compose(deps, teaching);

  assert.equal(out.revision, false);
  assert.equal(out.targetMinutes, 15, 'the session budget is untouched on a normal night');
  assert.equal(out.sections.length, 2);
});
