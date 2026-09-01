import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  fixedClock, partitionStrategyFrom,
  type Deps, type Embedder, type Llm, type LlmRequest, type LlmResult,
  type Pin, type Research,
} from '@sb/core';
import { JsonStore } from '@sb/adapters';

import { runBatch } from '../pipeline.js';

/**
 * The cluster stage line, and the partition strategy it names.
 *
 * `SB_PARTITION` is read in `cli.ts` beside `SB_EMBEDDER` and threaded here.
 * Which rule decided a board's topics is provenance: two runs of the same board
 * under two strategies produce different topics, and a line that does not say
 * which one ran cannot be read back six weeks later. The evidence for D1 itself
 * is in `core/src/domain/partition-d1.ts`; what this file holds down is that
 * selecting it actually changes the partition, and that selecting it without
 * wiring the second space fails where somebody can see it.
 */

const NOW = '2026-08-19T03:00:00.000Z';

/** Every stage after clustering degrades; this run is about the second one. */
const namingOnly: Llm = {
  complete: async () => { throw new Error('no completion calls in this test'); },
  structured: async <T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => {
    const required = (req.schema as { required?: readonly string[] }).required ?? [];
    if (!required.includes('names')) throw new Error('a later stage, deliberately degraded');
    return { value: { names: [] } as T, modelId: 'stub', inputTokens: 0, outputTokens: 0 };
  },
};

const noResearch: Research = {
  fetchPage: async () => null,
  findReferences: async () => [],
  hasGrounding: false,
};

/** Keyed off the page title, which `pinClusterText` puts in the embedded text. */
const keyed = (modelId: string, vectors: Record<string, readonly number[]>): Embedder => ({
  modelId,
  embed: async (texts) => texts.map((t) => {
    const id = /page (p\d)/.exec(t)?.[1] ?? '';
    return vectors[id] ?? [0, 0];
  }),
});

/**
 * Three pins one space calls one topic and the other splits in two. The fine
 * vectors sit far above the default cut; the coarse ones put p3 in a bucket of
 * its own.
 */
const FINE = keyed('stub-space', { p1: [1, 0], p2: [0.99, 0.1], p3: [0.98, 0.199] });
const COARSE = keyed('tfidf-v1', { p1: [1, 0], p2: [1, 0], p3: [0, 1] });

const pin = (id: string): Pin => ({
  id,
  type: 'interest',
  envelope: {
    selection: `the passage on page ${id}`,
    parts: [],
    surroundingText: 'ordinary prose around it',
    headingPath: ['Docs'],
    pageTitle: `page ${id}`,
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

async function board(tag: string, over: Partial<Deps> = {}): Promise<Deps> {
  const store = new JsonStore(join(mkdtempSync(join(tmpdir(), `sb-cluster-${tag}-`)), 'db.json'));
  for (const id of ['p1', 'p2', 'p3']) await store.putPin(pin(id));
  return {
    llm: namingOnly, embedder: FINE, store, research: noResearch, clock: fixedClock(NOW), ...over,
  };
}

const clusterLine = (reports: readonly { stage: string; detail: string }[]): string =>
  String(reports.find((r) => r.stage === 'cluster')?.detail);

test('a run with one space names the rule that can run on it', async () => {
  const { reports, topics } = await runBatch(await board('default'), { concurrency: 1 });
  assert.match(clusterLine(reports), /partition single — stub-space @ 0\.635/);
  assert.equal(topics.length, 1, 'one space, one topic — the control for the next test');
});

test('a run with a coarse space wired partitions by D1 without being asked', async () => {
  // The CLI builds the coarse space
  // unless `SB_PARTITION=single` says otherwise, so this is the shape of an
  // ordinary nightly now: nothing selected, D1 partitioned, and the line says
  // so with both cuts named.
  const deps = await board('default-d1', { coarseEmbedder: COARSE });
  const { reports, topics } = await runBatch(deps, { concurrency: 1 });
  assert.match(clusterLine(reports), /partition d1 — tfidf-v1 bucket @ 0\.08 then stub-space @ 0\.635/);
  assert.equal(topics.length, 2, 'the coarse bucket split a topic the fine space alone welded');
});

test('SB_PARTITION=d1 reaches the partition, and the line says which rule ran', async () => {
  const deps = await board('d1', { coarseEmbedder: COARSE });
  const { reports, topics } = await runBatch(deps, { concurrency: 1, partitionStrategy: 'd1' });
  assert.match(clusterLine(reports), /partition d1 — tfidf-v1 bucket @ 0\.08 then stub-space @ 0\.635/);
  assert.equal(topics.length, 2, 'the coarse bucket split a topic the fine space alone welded');
});

test('SB_PARTITION=single asks for the older rule by name, and gets it', async () => {
  // The escape hatch has to work on a run whose coarse space is built and
  // ready, or the flip is one-way and the two rules cannot be compared on one
  // board. The coarse embedder here throws if it is called at all.
  const loud: Embedder = {
    modelId: 'tfidf-v1',
    embed: async () => { throw new Error('the coarse space must not be built'); },
  };
  const deps = await board('opt-out', { coarseEmbedder: loud });
  const { reports, topics } = await runBatch(deps, { concurrency: 1, partitionStrategy: 'single' });
  assert.match(clusterLine(reports), /partition single — stub-space @ 0\.635/);
  assert.equal(topics.length, 1);
});

test('an unknown strategy is not silently invented: the default is what runs', async () => {
  // `partitionStrategyFrom` is what the CLI puts here, so a typo in the
  // environment arrives as the default rather than as anything exotic.
  const deps = await board('unknown', { coarseEmbedder: COARSE });
  const { reports } = await runBatch(deps, {
    concurrency: 1, partitionStrategy: partitionStrategyFrom('d2'),
  });
  assert.match(clusterLine(reports), /partition d1/);
});

test('d1 selected without a coarse space fails the stage rather than quietly clustering another way', async () => {
  const { reports, topics } = await runBatch(await board('unwired'), { concurrency: 1, partitionStrategy: 'd1' });
  const stage = reports.find((r) => r.stage === 'cluster');
  assert.equal(stage?.failed, true);
  assert.match(String(stage?.detail), /d1 needs a coarse embedder/);
  assert.equal(topics.length, 0, 'and no board is built by a rule nobody asked for');
});
