import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  fixedClock,
  type Deps, type Embedder, type Llm, type LlmRequest, type LlmResult,
  type Pin, type Research,
} from '@sb/core';
import { JsonStore } from '@sb/adapters';

import { runBatch } from '../pipeline.js';


const NOW = '2026-08-19T03:00:00.000Z';

/** The forager is the only agent this test wants to reach. */
const foragerOnly = (answer: (selection: string) => unknown): Llm => ({
  complete: async () => { throw new Error('no completion calls in this test'); },
  structured: async <T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => {
    const required = (req.schema as { required?: readonly string[] }).required ?? [];
    if (!required.includes('assumedConcepts')) throw new Error('a later stage, deliberately degraded');
    const match = /Passage:\n(?:.*)?(pin-[a-z]+)/s.exec(req.prompt);
    const a = answer(match?.[1] ?? '');
    if (a === null) throw new Error('the model did not answer for this pin');
    return { value: a as T, modelId: 'stub', inputTokens: 0, outputTokens: 0 };
  },
});

/** Every later stage degrades; this run is about the first one. */
const noEmbedder: Embedder = {
  modelId: 'none',
  embed: async () => { throw new Error('a later stage, deliberately degraded'); },
};

const noResearch: Research = {
  fetchPage: async () => null,
  findReferences: async () => [],
  hasGrounding: false,
};

const pin = (id: string, tag: string): Pin => ({
  id,
  type: 'interest',
  envelope: {
    selection: `the passage for ${tag}`,
    parts: [],
    surroundingText: 'ordinary prose around it',
    headingPath: ['Docs'],
    pageTitle: `page for ${id}`,
    url: 'https://example.test/doc',
    canonicalUrl: null,
    siteName: null,
    contentLanguage: null,
    media: null,
  },
  note: null,
  capturedAt: '2026-08-01T00:00:00Z',
  fromSuggestion: false,
  enrichment: null,
  topicId: null,
});

async function board(tag: string, llm: Llm): Promise<{ store: JsonStore; deps: Deps }> {
  const store = new JsonStore(join(mkdtempSync(join(tmpdir(), `sb-forage-${tag}-`)), 'db.json'));
  await store.putPin(pin('p1', 'pin-alpha'));
  await store.putPin(pin('p2', 'pin-bravo'));
  await store.putPin(pin('p3', 'pin-charlie'));
  return { store, deps: { llm, embedder: noEmbedder, store, research: noResearch, clock: fixedClock(NOW) } };
}

/** The three outcomes, one pin each. */
const oneOfEach = foragerOnly((tag) => {
  if (tag === 'pin-alpha') return { assumedConcepts: ['the ack deadline'], mediaDescription: null };
  if (tag === 'pin-bravo') return { assumedConcepts: [], mediaDescription: null };
  return null;
});

test('the forage line splits the outcomes instead of reporting one number for all three', async () => {
  const { deps } = await board('split', oneOfEach);
  const { reports } = await runBatch(deps, { concurrency: 1 });
  const forage = reports.find((r) => r.stage === 'forage');

  assert.equal(forage?.failed, false, 'the stage itself did not fail — that was always the trap');
  assert.match(String(forage?.detail), /3 pins — 1 enriched, 1 nothing-found/);
  assert.match(String(forage?.detail), /1 MODEL-FAILED/,
    'and the failure is named in the line, not folded into a count that reads as success');
});

test('byte-identical passages share one Forager request while keeping two independent pins', async () => {
  let calls = 0;
  const llm = foragerOnly(() => {
    calls++;
    return { assumedConcepts: ['the ack deadline'], mediaDescription: null };
  });
  const store = new JsonStore(join(mkdtempSync(join(tmpdir(), 'sb-forage-identical-')), 'db.json'));
  const first = pin('duplicate-a', 'pin-alpha');
  // Different record identity, deliberately identical material. The full
  // prepared request — not a fuzzy content signature — is what may be reused.
  const second = { ...first, id: 'duplicate-b' };
  await store.putPin(first);
  await store.putPin(second);
  const deps: Deps = {
    llm, embedder: noEmbedder, store, research: noResearch, clock: fixedClock(NOW),
  };

  const { reports } = await runBatch(deps, { concurrency: 2 });

  assert.equal(calls, 1, 'the same in-flight request was issued once');
  assert.deepEqual(
    (await store.listPins()).map((p) => [p.id, p.enrichment?.outcome]),
    [['duplicate-a', 'enriched'], ['duplicate-b', 'enriched']],
    'both capture records still completed independently',
  );
  assert.match(String(reports.find((r) => r.stage === 'forage')?.detail),
    /1 identical passage reused without another model call/);
});

test('a model failure is not reported as a pin that needed nothing', async () => {
  const { deps } = await board('not-nothing', foragerOnly(() => { throw new Error('down'); }));
  const { reports } = await runBatch(deps, { concurrency: 1 });
  const detail = String(reports.find((r) => r.stage === 'forage')?.detail);

  assert.match(detail, /3 MODEL-FAILED/);
  assert.match(detail, /0 enriched, 0 nothing-found/);
});

test('only the model-failed pin is owed another attempt tomorrow', async () => {
  const { store, deps } = await board('re-eligible', oneOfEach);
  await runBatch(deps, { concurrency: 1 });

  const owed = await store.listPins({ unenrichedOnly: true });
  assert.deepEqual(owed.map((p) => p.id), ['p3'],
    'the enriched and the nothing-found pins are done; the failure is not');

  // And all three still carry an enrichment record, because the degrade to the
  // capture envelope is unchanged — the failed one is simply honest about it.
  const all = await store.listPins();
  assert.deepEqual(all.map((p) => p.enrichment?.outcome),
    ['enriched', 'nothing-found', 'model-failed']);
});

test('the retry night sees only the pin that failed, and clears it', async () => {
  const { store, deps } = await board('retry', oneOfEach);
  await runBatch(deps, { concurrency: 1 });

  const second = {
    ...deps,
    llm: foragerOnly(() => ({ assumedConcepts: ['idempotent handlers'], mediaDescription: null })),
  };
  const { reports } = await runBatch(second, { concurrency: 1 });

  assert.match(String(reports.find((r) => r.stage === 'forage')?.detail), /^1 pins — 1 enriched/,
    'one pin re-enriched, not all three re-run and not none');
  assert.deepEqual((await store.listPins({ unenrichedOnly: true })).map((p) => p.id), []);
  assert.equal((await store.getPin('p3'))?.enrichment?.outcome, 'enriched');
});

test('a third night over a settled board asks the model nothing at all', async () => {
  // `nothing-found` staying out of the queue is the half of the rule that costs
  // money if it is wrong: the model already answered.
  const { store, deps } = await board('settled', foragerOnly(() => ({ assumedConcepts: [], mediaDescription: null })));
  await runBatch(deps, { concurrency: 1 });

  assert.deepEqual((await store.listPins({ unenrichedOnly: true })).map((p) => p.id), []);
  const { reports } = await runBatch({
    ...deps,
    llm: foragerOnly(() => { throw new Error('the model must not be reached on a settled board'); }),
  }, { concurrency: 1 });
  assert.equal(reports.find((r) => r.stage === 'forage')?.detail, 'nothing new to enrich');
});
