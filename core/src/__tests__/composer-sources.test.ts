import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compose, resolveSourceIds } from '../agents/composer.js';
import type { PureDeps } from '../agents/deps.js';
import type { Llm, LlmRequest, LlmResult } from '../ports/llm.js';
import type { Enrichment, Pin, Topic } from '../domain/types.js';
import type { ComfortResult } from '../agents/registrar.js';
import type { GardenDecision } from '../agents/gardener.js';

/**
 *  provenance, checked rather than trusted.
 *
 * Measured on a live run: the brief offered `p-429-1:origin`, the model answered
 * `p-429-1`, and five of six sections shipped with source ids that resolve to
 * nothing. The panel renders `sourceIds.length` as "N sources · why am I seeing
 * this?", so the learner was shown a provenance count over dead references —
 * the one claim in the product they cannot check, made by the feature whose
 * whole job is letting them check things.
 */

// ------------------------------------------------------- the resolver itself

const OFFERED = ['p-429-1:origin', 'p-430-1:origin', 'ref-88'];

test('an id that matches exactly is kept exactly', () => {
  const out = resolveSourceIds(['p-429-1:origin'], OFFERED);
  assert.deepEqual([...out.ids], ['p-429-1:origin']);
  assert.equal(out.repaired, 0);
  assert.equal(out.dropped, 0);
});

test('the measured case — a base id with the fragment dropped — is repaired to the offered id', () => {
  const out = resolveSourceIds(['p-429-1'], OFFERED);
  assert.deepEqual([...out.ids], ['p-429-1:origin'], 'the id the brief actually offered');
  assert.equal(out.repaired, 1);
  assert.equal(out.dropped, 0);
});

test('an id with a fragment the brief did not offer repairs back to the offered id', () => {
  // The same fault in the other direction: the model elaborating on an id
  // rather than truncating one.
  const out = resolveSourceIds(['ref-88:section-2'], OFFERED);
  assert.deepEqual([...out.ids], ['ref-88']);
  assert.equal(out.repaired, 1);
});

test('case alone is a repair, not a drop', () => {
  const out = resolveSourceIds(['P-429-1:ORIGIN'], OFFERED);
  assert.deepEqual([...out.ids], ['p-429-1:origin']);
  assert.equal(out.repaired, 1);
});

test('brackets and stray whitespace around an id are not what makes it unresolvable', () => {
  const out = resolveSourceIds(['[p-430-1:origin]', ' ref-88 '], OFFERED);
  assert.deepEqual([...out.ids], ['p-430-1:origin', 'ref-88']);
  assert.equal(out.dropped, 0);
});

test('an id that names nothing offered is dropped and counted', () => {
  const out = resolveSourceIds(['p-999-9:origin', 'https://example.test/invented'], OFFERED);
  assert.deepEqual([...out.ids], []);
  assert.equal(out.dropped, 2);
  assert.equal(out.repaired, 0);
});

test('an id that could be repaired two ways is dropped, not guessed', () => {
  // Guessing between two candidates fabricates the provenance instead of
  // recovering it, which is the failure this whole check exists to stop.
  const ambiguous = ['p-429-1:origin', 'p-429-1:ref-2'];
  const out = resolveSourceIds(['p-429-1'], ambiguous);
  assert.deepEqual([...out.ids], []);
  assert.equal(out.dropped, 1);
  assert.equal(out.repaired, 0);
});

test('two ids that resolve to the same source are shown once, and that is not a drop', () => {
  const out = resolveSourceIds(['p-429-1', 'p-429-1:origin'], OFFERED);
  assert.deepEqual([...out.ids], ['p-429-1:origin']);
  assert.equal(out.repaired, 1);
  assert.equal(out.dropped, 0);
});

test('order is the order the model gave, so the count and the list agree with the prose', () => {
  const out = resolveSourceIds(['ref-88', 'p-429-1'], OFFERED);
  assert.deepEqual([...out.ids], ['ref-88', 'p-429-1:origin']);
});

test('a missing, empty or non-string sourceIds list never becomes a source', () => {
  assert.deepEqual([...resolveSourceIds(undefined, OFFERED).ids], []);
  assert.deepEqual([...resolveSourceIds('p-429-1:origin', OFFERED).ids], [],
    'a bare string is not the array the schema asked for');
  const junk = resolveSourceIds([null, 42, '   ', {}], OFFERED);
  assert.deepEqual([...junk.ids], []);
  assert.equal(junk.dropped, 4);
});

test('with nothing offered, nothing resolves', () => {
  const out = resolveSourceIds(['p-429-1:origin'], []);
  assert.deepEqual([...out.ids], []);
  assert.equal(out.dropped, 1);
});

// ---------------------------------------------------- and through the agent

const clock = { now: () => new Date('2026-08-19T03:00:00Z') };

const llmReturning = (sections: unknown): { deps: PureDeps; prompts: string[] } => {
  const prompts: string[] = [];
  const llm: Llm = {
    complete: async () => { throw new Error('the composer does not use complete()'); },
    structured: async <T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => {
      prompts.push(req.prompt);
      return {
        value: { sections, closingNote: 'one clause, another, a third' } as T,
        modelId: 'stub', inputTokens: 0, outputTokens: 0,
      };
    },
  };
  return { deps: { llm, clock }, prompts };
};

const enrichment = (refIds: readonly string[]): Enrichment => ({
  refetchedText: null,
  assumedConcepts: [],
  mediaDescription: null,
  references: refIds.map((id) => ({
    id, origin: 'user-pin', url: 'https://example.test/doc', title: 't',
    retrievedAt: '2026-08-01T00:00:00Z', pinId: id.split(':')[0] ?? null,
  })),
  outcome: 'nothing-found',
  confidence: 'full',
  enrichedAt: '2026-08-19T03:00:00.000Z',
});

const pin = (id: string, topicId: string, over: Partial<Pin> = {}): Pin => ({
  id,
  type: 'interest',
  envelope: {
    selection: `the passage behind ${id}`,
    parts: [],
    surroundingText: 'ordinary prose around it',
    headingPath: ['Docs'],
    pageTitle: `page for ${id}`,
    url: 'https://example.test/doc',
    canonicalUrl: null,
    siteName: null,
    contentLanguage: 'en',
    media: null,
  },
  note: null,
  capturedAt: '2026-08-01T00:00:00Z',
  fromSuggestion: false,
  enrichment: null,
  topicId,
  ...over,
});

const topic = (id: string): Topic => ({
  id, label: `label of ${id}`, summary: `summary of ${id}`, pinIds: [],
  state: 'working', comfort: 0.5, lastExposedAt: null,
  retiredByUser: false, createdAt: '2026-08-01T00:00:00Z',
});

const comfort = (topicId: string): ComfortResult =>
  ({
    topicId, comfort: 0.5, regressed: false, evidenceCount: 4, demonstrationCount: 2,
    certainty: 0.8, evidenceSignalIds: [],
  });

const decision = (topicId: string): GardenDecision =>
  ({ topicId, disposition: 'teach', reason: 'never taught', priority: 80 });

const input = (pins: readonly Pin[], topics: readonly Topic[]) => ({
  topics,
  pins,
  comforts: topics.map((t) => comfort(t.id)),
  decisions: topics.map((t) => decision(t.id)),
  observations: [],
  knownAboutLearner: [],
  targetMinutes: 15,
  interfaceLanguage: 'en',
});

test('the session reports every id it repaired and every id it dropped', async () => {
  const { deps } = llmReturning([
    // The measured shape, plus one invention, plus one that is simply right.
    { topicId: 'T1', heading: 'One', body: 'w '.repeat(120), estimatedMinutes: 4, question: null,
      sourceIds: ['p-429-1', 'https://example.test/never-offered'], mediumWarning: null },
    { topicId: 'T2', heading: 'Two', body: 'w '.repeat(120), estimatedMinutes: 4, question: null,
      sourceIds: ['p-430-1:origin'], mediumWarning: null },
  ]);

  const out = await compose(deps, input(
    [pin('p-429-1', 'T1'), pin('p-430-1', 'T2')], [topic('T1'), topic('T2')]));

  assert.deepEqual([...(out.sections[0]?.sourceIds ?? [])], ['p-429-1:origin'],
    'repaired to the id the brief offered, and the invented one is gone');
  assert.deepEqual([...(out.sections[1]?.sourceIds ?? [])], ['p-430-1:origin']);
  assert.equal(out.sourceIdRepairs, 1);
  assert.equal(out.sourceIdDrops, 1);
});

test('the source count the panel renders is a count of sources that resolve', async () => {
  // `sourceIds.length` is what the panel prints. Before this, six sections could
  // print six sources and none of them lead anywhere.
  const { deps } = llmReturning([
    { topicId: 'T1', heading: 'One', body: 'w '.repeat(120), estimatedMinutes: 4, question: null,
      sourceIds: ['nope-1', 'nope-2', 'nope-3'], mediumWarning: null },
  ]);

  const out = await compose(deps, input([pin('p-429-1', 'T1')], [topic('T1')]));
  assert.equal(out.sections[0]?.sourceIds.length, 0, 'no sources is honest; three dead ones is not');
  assert.equal(out.sourceIdDrops, 3);
});

test('an agent-sourced reference is offered and accepted alongside the pin\'s own page', async () => {
  const p = pin('p-429-1', 'T1', { enrichment: enrichment(['p-429-1:origin', 'ref-88']) });
  const { deps, prompts } = llmReturning([
    { topicId: 'T1', heading: 'One', body: 'w '.repeat(120), estimatedMinutes: 4, question: null,
      sourceIds: ['ref-88'], mediumWarning: null },
  ]);

  const out = await compose(deps, input([p], [topic('T1')]));
  assert.match(String(prompts[0]), /p-429-1:origin, ref-88/, 'both were offered in the brief');
  assert.deepEqual([...(out.sections[0]?.sourceIds ?? [])], ['ref-88']);
  assert.equal(out.sourceIdDrops, 0);
});

test('an enriched pin with no references still offers its own page rather than an empty bracket', async () => {
  const p = pin('p-429-1', 'T1', { enrichment: enrichment([]) });
  const { deps, prompts } = llmReturning([
    { topicId: 'T1', heading: 'One', body: 'w '.repeat(120), estimatedMinutes: 4, question: null,
      sourceIds: ['p-429-1:origin'], mediumWarning: null },
  ]);

  const out = await compose(deps, input([p], [topic('T1')]));
  assert.match(String(prompts[0]), /\[p-429-1:origin\]/);
  assert.deepEqual([...(out.sections[0]?.sourceIds ?? [])], ['p-429-1:origin']);
});

test('a session with nothing to teach reports no repairs and no drops', async () => {
  const { deps } = llmReturning([]);
  const out = await compose(deps, {
    ...input([], []),
    decisions: [{ topicId: 'T1', disposition: 'hold', reason: 'not this run', priority: 10 }],
  });
  assert.equal(out.insufficient, true);
  assert.equal(out.sourceIdRepairs, 0);
  assert.equal(out.sourceIdDrops, 0);
});
