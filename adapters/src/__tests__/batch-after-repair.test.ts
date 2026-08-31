import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cluster, computeComfort, thresholdFor,
  type ClustererDeps, type Embedder, type Llm, type LlmRequest, type LlmResult,
  type Pin, type Signal, type Topic,
} from '@sb/core';
import { JsonStore } from '../json-store.js';
import { TfIdfEmbedder } from '../tfidf-embedder.js';
import { seedPins, expectOf } from './seed-corpus-fixture.js';

/**
 * What the nightly run does the night after the learner repairs their board.
 *
 * This is the half of split/merge that is easy to get wrong and invisible when
 * you do. Clustering is attach-only (clustering-stability constraint): a pin that already has a
 * topic is never reconsidered, so a run over an unchanged board is a no-op by
 * construction. A repair changes the board — and the guarantee has to survive
 * it. Specifically:
 *
 *  - the retired id must never come back, and must never attract a pin;
 *  - the merged topic's centroid must be its FULL pin set, so a new pin close to
 *    the absorbed material still lands on the survivor;
 *  - after a split, both topics are ordinary topics and compete normally;
 *  - and in both cases, zero reassignments. The learner wakes up to the board
 *    they went to sleep with, plus whatever they pinned.
 *
 * Nothing here calls a model. The embedder is TF-IDF or a stub, and the naming
 * call is only ever reached by a group being created — which is itself part of
 * what is being asserted.
 */

const store = (tag: string): JsonStore =>
  new JsonStore(join(mkdtempSync(join(tmpdir(), `sb-${tag}-`)), 'db.json'));

/** Any call at all is the bug in most of these tests. */
const noLlm = (): Llm => ({
  complete: async () => { throw new Error('a model call would itself be the failure here'); },
  structured: async <T>(_req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => {
    throw new Error('a model call would itself be the failure here');
  },
});

/** Names nothing, so created groups take the heading-path fallback. Used where
 *  a cold partition legitimately creates topics and no model is available. */
const silentLlm = (): Llm => ({
  complete: async () => { throw new Error('not used'); },
  structured: async <T>(): Promise<LlmResult<T>> =>
    ({ value: { names: [] } as T, modelId: 'stub', inputTokens: 0, outputTokens: 0 }),
});

const stubEmbedder = (vectors: Record<string, readonly number[]>): Embedder => ({
  modelId: 'stub-space',
  // The clusterer sorts pins by id before embedding, so keying the vectors by
  // id rather than position is what keeps these tests readable.
  embed: async (texts) => texts.map((t) => vectors[String(t).split('\n')[0] ?? ''] ?? [0, 0]),
});

const stubPin = (id: string, topicId: string | null = null): Pin => ({
  id, type: 'interest',
  envelope: {
    selection: null, parts: [], surroundingText: '', headingPath: [],
    pageTitle: id, url: 'https://e.test', canonicalUrl: null, siteName: null,
    contentLanguage: 'en', media: null,
  },
  note: null, capturedAt: '2026-08-01T00:00:00Z',
  fromSuggestion: false, enrichment: null, topicId,
});

const topic = (id: string, pinIds: readonly string[]): Topic => ({
  id, label: `label of ${id}`, summary: '', pinIds, state: 'working',
  comfort: 0.5, lastExposedAt: null, retiredByUser: false, createdAt: '2026-08-01T00:00:00Z',
});

/** One nightly clustering pass over whatever is in the store. */
async function nightly(s: JsonStore, deps: ClustererDeps, threshold?: number) {
  return cluster(deps, {
    pins: await s.listPins(),
    existingTopics: await s.listTopics(),
    ...(threshold === undefined ? {} : { threshold }),
  });
}

/** Persist a clustering result the way the pipeline does. */
async function persist(s: JsonStore, out: Awaited<ReturnType<typeof cluster>>, prefix = 't'): Promise<void> {
  let n = 0;
  for (const c of out.clusters) {
    const id = c.existingTopicId ?? `${prefix}${n++}`;
    const prior = await s.getTopic(id);
    await s.putTopic({
      id, label: c.label, summary: c.summary, pinIds: c.pinIds,
      state: prior?.state ?? 'working', comfort: prior?.comfort ?? 0.15,
      lastExposedAt: prior?.lastExposedAt ?? null,
      retiredByUser: prior?.retiredByUser ?? false,
      createdAt: prior?.createdAt ?? '2026-08-01T00:00:00Z',
    });
    for (const pid of c.pinIds) {
      const p = await s.getPin(pid);
      if (p && p.topicId !== id) await s.putPin({ ...p, topicId: id });
    }
  }
}

// ----------------------------------------------------- nightly after a merge

const MERGE_VECTORS: Record<string, readonly number[]> = {
  p1: [1, 0], p2: [0.99, 0.1],     // topic A
  p3: [0.2, 0.98], p4: [0.25, 0.97], // topic B, absorbed into A
  p5: [0.22, 0.975],               // a new pin, nearest the absorbed material
};
const MERGE_THRESHOLD = 0.9;

async function mergedBoard(tag: string) {
  const s = store(tag);
  for (const [id, tid] of [['p1', 'A'], ['p2', 'A'], ['p3', 'B'], ['p4', 'B']] as const) {
    await s.putPin(stubPin(id, tid));
  }
  await s.putTopic(topic('A', ['p1', 'p2']));
  await s.putTopic(topic('B', ['p3', 'p4']));
  await s.mergeTopics('A', 'B');
  return s;
}

test('the night after a merge is a no-op, and the retired id does not come back', async () => {
  const s = await mergedBoard('nm');
  const deps: ClustererDeps = { embedder: stubEmbedder(MERGE_VECTORS), llm: noLlm() };
  const out = await nightly(s, deps, MERGE_THRESHOLD);

  assert.equal(out.clusters.length, 1, 'one topic in, one topic out');
  assert.equal(out.clusters[0]?.existingTopicId, 'A');
  assert.deepEqual([...(out.clusters[0]?.pinIds ?? [])], ['p1', 'p2', 'p3', 'p4'],
    'the merged topic is its full pin set');
  assert.deepEqual(out.clusters.flatMap((c) => c.attached), [], 'zero reassignments');
  assert.equal(out.clusters.some((c) => c.existingTopicId === 'B'), false,
    'the retired id is not resurrected');

  await persist(s, out);
  assert.deepEqual((await s.listTopics()).map((t) => t.id), ['A']);
  assert.deepEqual(await s.topicAliases(), { B: 'A' }, 'and the alias survives the run');
});

test('a new pin lands on the survivor, not on a rebuilt version of the retired topic', async () => {
  // The centroid of the merged topic is computed over BOTH pin sets, so material
  // that would have joined the absorbed topic now joins the one that kept it.
  // If the merge had left the two pin sets apart, p5 would have seeded a rival
  // topic that is a copy of the one the learner just merged away.
  const s = await mergedBoard('nm2');
  await s.putPin(stubPin('p5', null));
  const deps: ClustererDeps = { embedder: stubEmbedder(MERGE_VECTORS), llm: noLlm() };
  const out = await nightly(s, deps, 0.6);

  assert.equal(out.clusters.length, 1);
  assert.equal(out.clusters[0]?.existingTopicId, 'A');
  assert.deepEqual([...(out.clusters[0]?.attached ?? [])], ['p5']);
});

test('a merged history is read as one, and the next run does not disturb it', async () => {
  const s = await mergedBoard('nm3');
  const sig = (id: string, topicId: string, direction: Signal['direction']): Signal => ({
    id, topicId, type: direction === 'positive' ? 'answer-correct' : 'answer-wrong',
    direction, at: '2026-08-18T00:00:00Z', sourceEvent: `answer:sess:${id}`, invalidated: false,
  });
  await s.appendSignal(sig('g1', 'A', 'positive'));
  await s.appendSignal(sig('g2', 'B', 'negative'));

  const now = new Date('2026-08-19T03:00:00Z');
  const before = computeComfort('A', await s.listSignals(), now);
  await persist(s, await nightly(s, { embedder: stubEmbedder(MERGE_VECTORS), llm: noLlm() }, MERGE_THRESHOLD));
  const after = computeComfort('A', await s.listSignals(), now);

  assert.equal(before.evidenceCount, 2, 'both histories, before the run');
  assert.deepEqual([after.comfort, after.evidenceCount], [before.comfort, before.evidenceCount],
    'and unchanged by it — a nightly run is not allowed to move a comfort number on its own');
});

// ----------------------------------------------------- nightly after a split

test('the night after a split leaves both topics exactly where the learner put them', async () => {
  const s = store('ns');
  const vectors: Record<string, readonly number[]> = {
    p1: [1, 0], p2: [0.995, 0.05], p3: [0.99, 0.1],
  };
  for (const id of ['p1', 'p2', 'p3']) await s.putPin(stubPin(id, 'A'));
  await s.putTopic(topic('A', ['p1', 'p2', 'p3']));
  const created = await s.splitTopic('A', ['p3'], 'What it is actually about');

  const out = await nightly(s, { embedder: stubEmbedder(vectors), llm: noLlm() }, 0.9);

  assert.equal(out.clusters.length, 2, 'both resulting topics participate as ordinary topics');
  assert.deepEqual(out.clusters.flatMap((c) => c.attached), [],
    'and neither pin is reconsidered, even though they are close enough to merge');
  const byTopic = new Map(out.clusters.map((c) => [c.existingTopicId, [...c.pinIds]]));
  assert.deepEqual(byTopic.get('A'), ['p1', 'p2']);
  assert.deepEqual(byTopic.get(created.id), ['p3']);
  assert.equal(out.clusters.find((c) => c.existingTopicId === created.id)?.label,
    'What it is actually about', 'the model is never asked to rename what the learner named');
});

test('a new pin can attach to a topic the learner split out', async () => {
  const s = store('ns2');
  const vectors: Record<string, readonly number[]> = {
    p1: [1, 0], p2: [0.99, 0.1], p3: [0, 1], p4: [0.05, 0.998],
  };
  for (const id of ['p1', 'p2', 'p3']) await s.putPin(stubPin(id, 'A'));
  await s.putTopic(topic('A', ['p1', 'p2', 'p3']));
  const created = await s.splitTopic('A', ['p3'], 'Its own thing');
  await s.putPin(stubPin('p4', null));

  const out = await nightly(s, { embedder: stubEmbedder(vectors), llm: noLlm() }, 0.9);
  const split = out.clusters.find((c) => c.existingTopicId === created.id);
  assert.deepEqual([...(split?.attached ?? [])], ['p4'],
    'a topic created by the user is a first-class attachment target');
});

// -------------------------------------- the merge clustering-stability constraint left standing, repaired

/**
 * The demonstration.
 *
 * clustering-stability constraint’s resolution ends on this: "reproducible is not correct. Both embedders
 * still merge seventh chords with tritone substitution, which is the same class
 * of error the frontier model made in Run 1." Determinism moved the problem from
 * unstable to stably wrong in one place, and attach-only means the nightly run
 * will never revisit it.
 *
 * So the fix is not an algorithm. It is the learner, using the control this
 * work adds, on the exact board where the error occurs.
 */
test('the seventh-chords / tritone-substitution weld is real on the seeded board', async () => {
  const s = store('demo0');
  for (const p of seedPins()) await s.putPin(p);
  const embedder = new TfIdfEmbedder();
  const out = await nightly(s, { embedder, llm: silentLlm() });

  assert.equal(out.clusters.length, 9);
  const welded = out.clusters.find((c) => c.pinIds.includes('p18'));
  assert.deepEqual([...(welded?.pinIds ?? [])], ['p16', 'p17', 'p18'],
    'two seventh-chord pins and one tritone-substitution pin in one topic');
  assert.deepEqual((welded?.pinIds ?? []).map(expectOf),
    ['seventh-chords', 'seventh-chords', 'tritone-sub']);
  // And the other half of the same error: the second tritone pin is stranded on
  // its own rather than sitting with the first.
  const stranded = out.clusters.find((c) => c.pinIds.includes('p19'));
  assert.deepEqual([...(stranded?.pinIds ?? [])], ['p19']);
  assert.equal(out.threshold, thresholdFor('tfidf-v1'));
});

test('the learner repairs it with a split and a merge, and the nightly run keeps it', async () => {
  const s = store('demo1');
  for (const p of seedPins()) await s.putPin(p);
  const deps: ClustererDeps = { embedder: new TfIdfEmbedder(), llm: silentLlm() };
  await persist(s, await nightly(s, deps));

  const welded = (await s.listTopics()).find((t) => t.pinIds.includes('p18'));
  const stranded = (await s.listTopics()).find((t) => t.pinIds.includes('p19'));
  assert.ok(welded && stranded);

  // History on the welded topic, before anything is repaired. It was earned
  // against material that is mostly about seventh chords, and that is where it
  // has to stay — no signal in it says which of the two subjects it was about.
  for (const [id, direction] of [['g1', 'positive'], ['g2', 'positive'], ['g3', 'negative']] as const) {
    await s.appendSignal({
      id, topicId: welded.id, type: direction === 'positive' ? 'answer-correct' : 'answer-wrong',
      direction, at: '2026-08-18T00:00:00Z', sourceEvent: `answer:sess:${id}`, invalidated: false,
    });
  }
  await s.appendSignal({
    id: 'g4', topicId: stranded.id, type: 'answer-wrong', direction: 'negative',
    at: '2026-08-18T00:00:00Z', sourceEvent: 'answer:sess:g4', invalidated: false,
  });

  // 1. Split the tritone pin out of the seventh-chords topic, and name it.
  const tritone = await s.splitTopic(welded.id, ['p18'], 'Tritone substitution');
  // 2. Merge the stranded tritone topic into it.
  const kept = await s.mergeTopics(tritone.id, stranded.id);

  assert.deepEqual([...kept.pinIds], ['p18', 'p19'], 'both tritone pins, in one topic');
  assert.equal(kept.label, 'Tritone substitution', 'named by the learner, not by a model');
  assert.deepEqual([...((await s.getTopic(welded.id))?.pinIds ?? [])], ['p16', 'p17'],
    'and the seventh-chords topic is what it should always have been');

  const now = new Date('2026-08-19T03:00:00Z');
  const signals = await s.listSignals();
  assert.equal(computeComfort(welded.id, signals, now).evidenceCount, 3,
    'the history stays with the topic that earned it — a split cannot divide it');
  assert.equal(computeComfort(kept.id, signals, now).evidenceCount, 1,
    'the new topic starts fresh and then inherits only what the merge brought');
  assert.equal(computeComfort(kept.id, signals, now).comfort, 0,
    'one wrong answer, and nothing borrowed from the topic it was split out of');

  // 3. The night after. Nothing moves, nothing is created, no model is called.
  const after = await cluster({ embedder: new TfIdfEmbedder(), llm: noLlm() }, {
    pins: await s.listPins(), existingTopics: await s.listTopics(),
  });
  // Still nine: the split added one and the merge took one away. The count was
  // never the problem — the membership was.
  assert.equal(after.clusters.length, 9);
  assert.deepEqual(after.clusters.flatMap((c) => c.attached), [], 'zero reassignments');
  assert.equal(after.clusters.every((c) => c.existingTopicId !== null), true,
    'nothing new was created, so the naming call was never reached');
  const stillTogether = after.clusters.find((c) => c.existingTopicId === kept.id);
  assert.deepEqual([...(stillTogether?.pinIds ?? [])], ['p18', 'p19']);
  assert.equal(after.clusters.some((c) => c.existingTopicId === stranded.id), false,
    'and the id the learner merged away never reappears');
});

test('a second nightly run after the repair is identical to the first', async () => {
  // The property clustering-stability constraint bought and this work must not spend: a run over an
  // unchanged board is a no-op, repaired boards included.
  const s = store('demo2');
  for (const p of seedPins()) await s.putPin(p);
  const deps: ClustererDeps = { embedder: new TfIdfEmbedder(), llm: silentLlm() };
  await persist(s, await nightly(s, deps));
  const welded = (await s.listTopics()).find((t) => t.pinIds.includes('p18'))!;
  const stranded = (await s.listTopics()).find((t) => t.pinIds.includes('p19'))!;
  const tritone = await s.splitTopic(welded.id, ['p18'], 'Tritone substitution');
  await s.mergeTopics(tritone.id, stranded.id);

  const quiet: ClustererDeps = { embedder: new TfIdfEmbedder(), llm: noLlm() };
  const first = await nightly(s, quiet);
  await persist(s, first);
  const second = await nightly(s, quiet);

  const shape = (out: typeof first) => JSON.stringify(
    out.clusters.map((c) => [c.existingTopicId, [...c.pinIds], c.label, [...c.attached]]));
  assert.equal(shape(second), shape(first), 'asserted char-for-char, as clustering-stability constraint asked for');
});
