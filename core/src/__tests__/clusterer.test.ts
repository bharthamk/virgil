import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cluster, pinClusterText, unframeGist, NAMING_BATCH, NAMING_PROMPT, type ClustererDeps,
} from '../agents/clusterer.js';
import type { Pin, Topic } from '../domain/types.js';
import type { Llm, LlmRequest, LlmResult } from '../ports/llm.js';
import type { Embedder } from '../ports/embedder.js';

/**
 * The clusterer after DEAD_ENDS.md D15: the model no longer decides what goes
 * with what. It names groups whose membership is already fixed, and these tests
 * are mostly about proving it cannot do anything else.
 */

const pin = (id: string, over: Partial<Pin['envelope']> = {}, rest: Partial<Pin> = {}): Pin => ({
  id,
  type: 'interest',
  envelope: {
    selection: 'a passage', parts: [], surroundingText: 'around it',
    headingPath: ['Section'], pageTitle: 'A page', url: 'https://e.com',
    canonicalUrl: null, siteName: 'e.com', contentLanguage: 'en', media: null,
    ...over,
  },
  note: null, capturedAt: '2026-07-01T00:00:00Z', fromSuggestion: false,
  enrichment: null, topicId: null, ...rest,
});

const topic = (id: string, pinIds: readonly string[], over: Partial<Topic> = {}): Topic => ({
  id, label: `label of ${id}`, summary: `summary of ${id}`, pinIds,
  state: 'working', comfort: 0.5, lastExposedAt: null, retiredByUser: false,
  createdAt: '2026-07-01T00:00:00Z', ...over,
});

/** Vectors keyed by pin id, so a test can state the geometry it means. */
const stubEmbedder = (vectors: Record<string, readonly number[]>, ids: readonly string[]): Embedder => ({
  modelId: 'stub-space',
  embed: async (texts) => {
    assert.equal(texts.length, ids.length);
    return ids.map((id) => vectors[id] ?? [0, 0]);
  },
});

const stubLlm = (payload: unknown, onCall?: (req: LlmRequest) => void): Llm => ({
  complete: async () => { throw new Error('not used'); },
  structured: async <T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => {
    onCall?.(req);
    if (payload instanceof Error) throw payload;
    return { value: payload as T, modelId: 'stub', inputTokens: 0, outputTokens: 0 };
  },
});

const THRESHOLD = 0.8;

test('the text embedded is built only from stable fields', () => {
  const p = pin('p1', {
    selection: 'the   selection', headingPath: ['A', 'B'], pageTitle: 'Title',
    siteName: 'stackoverflow.com',
  }, { note: 'why?', capturedAt: '2026-08-19T00:00:00Z' });
  const text = pinClusterText(p);
  assert.match(text, /Title/);
  assert.match(text, /A > B/);
  assert.match(text, /the selection/, 'whitespace is collapsed so formatting cannot move a vector');
  assert.match(text, /note: why\?/);
  assert.doesNotMatch(text, /stackoverflow/, 'two pins are not related by sharing a site');
  assert.doesNotMatch(text, /2026-08-19/, 'when it was pinned says nothing about what it is');
});

test('the same board embeds to the same text every time', () => {
  const p = pin('p1');
  assert.equal(pinClusterText(p), pinClusterText(p));
});

test('a cold board partitions, and only the new topics are named', async () => {
  const ids = ['p1', 'p2', 'p3'];
  const seen: LlmRequest[] = [];
  const deps: ClustererDeps = {
    embedder: stubEmbedder({ p1: [1, 0], p2: [0.99, 0.1], p3: [0, 1] }, ids),
    llm: stubLlm({ names: [
      { group: 'g1', label: 'Delivery semantics', summary: 'What at-least-once costs.' },
      { group: 'g2', label: 'Interval training', summary: 'Hearing distance between notes.' },
    ] }, (r) => seen.push(r)),
  };
  const out = await cluster(deps, {
    pins: ids.map((id) => pin(id)), existingTopics: [], threshold: THRESHOLD,
  });

  assert.equal(out.clusters.length, 2);
  assert.deepEqual(out.clusters[0]?.pinIds, ['p1', 'p2']);
  assert.equal(out.clusters[0]?.label, 'Delivery semantics');
  assert.equal(out.clusters[1]?.label, 'Interval training');
  assert.deepEqual(out.unassigned, []);
  assert.equal(out.embeddingModelId, 'stub-space');

  assert.equal(seen.length, 1, 'one naming call for the whole run, not one per topic');
  assert.equal(seen[0]?.tier, 'fast');
  assert.equal(seen[0]?.reasoning, 'off');
});

test('an existing topic keeps its name; the model is never asked to re-name it', async () => {
  const ids = ['p1', 'p2'];
  let called = false;
  const deps: ClustererDeps = {
    embedder: stubEmbedder({ p1: [1, 0], p2: [0.99, 0.1] }, ids),
    llm: stubLlm({ names: [{ group: 'g1', label: 'SHOULD NOT APPEAR', summary: 'nor this' }] },
      () => { called = true; }),
  };
  const out = await cluster(deps, {
    pins: ids.map((id) => pin(id)),
    existingTopics: [topic('T1', ['p1', 'p2'])],
    threshold: THRESHOLD,
  });
  assert.equal(out.clusters[0]?.label, 'label of T1');
  assert.equal(out.clusters[0]?.summary, 'summary of T1');
  assert.equal(called, false, 'no new topics, so no reason to call a model at all');
});

test('a topic nothing ever named is named once — that is not a rename', async () => {
  /**
   * A signal recorded immediately after pinning needs a topic to hang on, so
   * `topicForOrphan` invented one and named it from the page title, because no
   * model had been asked about it and none was going to be.
   *
   * Then the identity promise — *"an existing topic keeps its name"* — kept it
   * that way **for ever**. That promise exists to protect a topic the learner
   * has been reading for a month from being renamed overnight. It was
   * protecting a provisional stopgap that had never been
   * named by anything.
   *
   * `provisionalName` separates the two. A topic that has never been named is
   * named once, at the first opportunity; the moment it has a name the promise
   * applies in full and nothing renames it again.
   */
  const ids = ['p1', 'p2'];
  let asked = false;
  const deps: ClustererDeps = {
    embedder: stubEmbedder({ p1: [1, 0], p2: [0.99, 0.1] }, ids),
    llm: stubLlm({ names: [{ group: 'g1', label: 'Character in short fiction', summary: 'A real name.' }] },
      () => { asked = true; }),
  };
  const out = await cluster(deps, {
    pins: ids.map((id) => pin(id)),
    existingTopics: [topic('T1', ['p1', 'p2'], {
      label: 'How to write a short story | National', provisionalName: true,
    })],
    threshold: THRESHOLD,
  });
  assert.equal(asked, true, 'a topic with no name is exactly what the naming pass is for');
  assert.equal(out.clusters[0]?.existingTopicId, 'T1', 'naming it is not re-partitioning it');
  assert.equal(out.clusters[0]?.label, 'Character in short fiction');
  assert.equal(out.clusters[0]?.summary, 'A real name.');
  assert.equal(out.clusters[0]?.provisionalName, false, 'it has a name now, so the promise applies');
});

test('a naming failure leaves a provisional topic provisional, to be named next time', async () => {
  // The degraded path must not launder a fallback into a permanent name: that
  // would spend the one naming opportunity on the model being down.
  const ids = ['p1', 'p2'];
  const deps: ClustererDeps = {
    embedder: stubEmbedder({ p1: [1, 0], p2: [0.99, 0.1] }, ids),
    llm: stubLlm(new Error('the model is down')),
  };
  const out = await cluster(deps, {
    pins: ids.map((id) => pin(id)),
    existingTopics: [topic('T1', ['p1', 'p2'], { label: 'A stopgap', provisionalName: true })],
    threshold: THRESHOLD,
  });
  assert.equal(out.clusters[0]?.provisionalName, true, 'still unnamed, so still nameable');
});

test('a topic that HAS a name is never offered to the naming pass', async () => {
  // The promise itself, restated as the other half of the rule above.
  const ids = ['p1', 'p2'];
  let asked = false;
  const deps: ClustererDeps = {
    embedder: stubEmbedder({ p1: [1, 0], p2: [0.99, 0.1] }, ids),
    llm: stubLlm({ names: [{ group: 'g1', label: 'SHOULD NOT APPEAR', summary: 'nor this' }] },
      () => { asked = true; }),
  };
  const out = await cluster(deps, {
    pins: ids.map((id) => pin(id)),
    existingTopics: [topic('T1', ['p1', 'p2'])],   // no `provisionalName` at all
    threshold: THRESHOLD,
  });
  assert.equal(asked, false);
  assert.equal(out.clusters[0]?.label, 'label of T1');
  assert.equal(out.clusters[0]?.provisionalName, false,
    'a stored row with no flag is a named topic — the safe reading for every row that exists today');
});

test('a topic the naming pass could not name is born provisional, not permanently mislabelled', async () => {
  // A cold board whose model call fails falls back to heading-path naming.
  // That label is as provisional as the orphan path's, and was equally stuck.
  const ids = ['p1'];
  const deps: ClustererDeps = {
    embedder: stubEmbedder({ p1: [1, 0] }, ids),
    llm: stubLlm(new Error('the model is down')),
  };
  const out = await cluster(deps, { pins: ids.map((id) => pin(id)), existingTopics: [], threshold: THRESHOLD });
  assert.equal(out.clusters[0]?.existingTopicId, null);
  assert.equal(out.clusters[0]?.provisionalName, true);
});

test('a topic the model named is not provisional', async () => {
  const ids = ['p1'];
  const deps: ClustererDeps = {
    embedder: stubEmbedder({ p1: [1, 0] }, ids),
    llm: stubLlm({ names: [{ group: 'g1', label: 'A real name', summary: 'and a summary' }] }),
  };
  const out = await cluster(deps, { pins: ids.map((id) => pin(id)), existingTopics: [], threshold: THRESHOLD });
  assert.equal(out.clusters[0]?.label, 'A real name');
  assert.equal(out.clusters[0]?.provisionalName, false);
});

test('a re-run over an unchanged board changes nothing', async () => {
  const ids = ['p1', 'p2', 'p3'];
  const vectors = { p1: [1, 0], p2: [0.99, 0.1], p3: [0, 1] };
  const existing = [topic('T1', ['p1', 'p2']), topic('T2', ['p3'])];
  const deps: ClustererDeps = {
    embedder: stubEmbedder(vectors, ids),
    llm: stubLlm(new Error('a model call would itself be the bug here')),
  };
  const out = await cluster(deps, { pins: ids.map((id) => pin(id)), existingTopics: existing, threshold: THRESHOLD });

  assert.deepEqual(out.clusters.map((c) => c.existingTopicId), ['T1', 'T2']);
  assert.deepEqual(out.clusters.map((c) => [...c.pinIds]), [['p1', 'p2'], ['p3']]);
  assert.deepEqual(out.clusters.flatMap((c) => c.attached), [], 'zero reassignments');
});

test('a new pin attaches to an established topic rather than starting a rival one', async () => {
  const ids = ['p1', 'p2', 'p3'];
  const deps: ClustererDeps = {
    embedder: stubEmbedder({ p1: [1, 0], p2: [0.99, 0.1], p3: [0.98, 0.15] }, ids),
    llm: stubLlm({ names: [] }),
  };
  const out = await cluster(deps, {
    pins: ids.map((id) => pin(id)),
    existingTopics: [topic('T1', ['p1', 'p2'])],
    threshold: THRESHOLD,
  });
  assert.equal(out.clusters.length, 1);
  assert.deepEqual(out.clusters[0]?.attached, ['p3']);
});

test('a naming failure costs a label, not a topic', async () => {
  // The partition is already decided by the time the model is asked anything.
  // Propagating a naming failure would throw away a correct partition over a
  // cosmetic problem, and the stage above would report the whole run degraded.
  const ids = ['p1', 'p2'];
  const deps: ClustererDeps = {
    embedder: stubEmbedder({ p1: [1, 0], p2: [0.99, 0.1] }, ids),
    llm: stubLlm(new Error('model unavailable')),
  };
  const out = await cluster(deps, {
    pins: ids.map((id) => pin(id, { headingPath: ['Pub/Sub', 'Ordering messages'] })),
    existingTopics: [], threshold: THRESHOLD,
  });
  assert.equal(out.clusters.length, 1);
  assert.equal(out.clusters[0]?.label, 'Ordering messages');
  assert.deepEqual(out.clusters[0]?.pinIds, ['p1', 'p2']);
});

test('a group the model forgot to name still gets a label', async () => {
  const ids = ['p1', 'p3'];
  const deps: ClustererDeps = {
    embedder: stubEmbedder({ p1: [1, 0], p3: [0, 1] }, ids),
    llm: stubLlm({ names: [{ group: 'g1', label: 'Named one', summary: 's' }] }),
  };
  const out = await cluster(deps, {
    pins: [pin('p1'), pin('p3', { headingPath: ['Sourdough hydration'] })],
    existingTopics: [], threshold: THRESHOLD,
  });
  assert.equal(out.clusters[0]?.label, 'Named one');
  assert.equal(out.clusters[1]?.label, 'Sourdough hydration');
});

// ------------------------------------------------ reading the keys back

/**
 * The group key is the whole of the join between what was asked and what came
 * back. `clusterer.ts` records that this drift already happened once and that
 * every new topic in the run silently took the fallback label; the read-back is
 * tolerant now, and tolerant in exactly one direction — a key that is not
 * certainly one group names none of them.
 */

/** Two groups, named however the caller says, with tellable fallback labels. */
const twoGroups = async (names: unknown) => {
  const ids = ['p1', 'p2'];
  const deps: ClustererDeps = {
    embedder: stubEmbedder({ p1: [1, 0], p2: [0, 1] }, ids),
    llm: stubLlm({ names }),
  };
  const out = await cluster(deps, {
    pins: [pin('p1', { headingPath: ['Fallback one'] }), pin('p2', { headingPath: ['Fallback two'] })],
    existingTopics: [], threshold: THRESHOLD,
  });
  return out.clusters.map((c) => c.label);
};

test('a key with the word group in front of it still names its group', async () => {
  // The recorded drift, exactly: the prompt says `group g1:` and a model that
  // answers in the same words rather than with the key alone used to name
  // nothing at all.
  assert.deepEqual(await twoGroups([
    { group: 'group g1', label: 'Named one', summary: 's' },
    { group: 'Group: G2', label: 'Named two', summary: 's' },
  ]), ['Named one', 'Named two']);
});

test('a key that is just the number, or wears a hash, still names its group', async () => {
  assert.deepEqual(await twoGroups([
    { group: '1', label: 'Named one', summary: 's' },
    { group: '#g2', label: 'Named two', summary: 's' },
  ]), ['Named one', 'Named two']);
});

test('a key quoted or padded is the same key', async () => {
  assert.deepEqual(await twoGroups([
    { group: '"g1"', label: 'Named one', summary: 's' },
    { group: '  g2  ', label: 'Named two', summary: 's' },
  ]), ['Named one', 'Named two']);
});

test('a key that names two groups equally well names neither of them', async () => {
  // The direction that matters more. A label on the wrong group is a topic the
  // learner cannot recognise on their own board, and the fallback — the heading
  // path of a real pin in the group — is honestly worse and honestly theirs.
  assert.deepEqual(await twoGroups([
    { group: 'g1 and g2', label: 'Could be either', summary: 's' },
  ]), ['Fallback one', 'Fallback two']);
});

test('a heading made only of invisible characters falls back to Unfiled', async () => {
  // `|| 'Unfiled'` is the guard, and `.trim()` was what decided whether it
  // fired. A heading of bidi overrides and zero-width spaces survives `.trim()`
  // and is not empty, so the topic reached the board with a name that occupies
  // space in the list and shows nothing at all.
  const ids = ['p1'];
  const deps: ClustererDeps = {
    embedder: stubEmbedder({ p1: [1, 0] }, ids),
    llm: stubLlm({ names: [] }),
  };
  const out = await cluster(deps, {
    pins: [pin('p1', { headingPath: ['​‮­'] })],
    existingTopics: [], threshold: THRESHOLD,
  });
  assert.deepEqual(out.clusters.map((c) => c.label), ['Unfiled']);
});

test('an invisible heading does not stop a real page title being the label', async () => {
  const ids = ['p1'];
  const deps: ClustererDeps = {
    embedder: stubEmbedder({ p1: [1, 0] }, ids),
    llm: stubLlm({ names: [] }),
  };
  const out = await cluster(deps, {
    pins: [pin('p1', { headingPath: [], pageTitle: 'Ordering​ messages' })],
    existingTopics: [], threshold: THRESHOLD,
  });
  assert.deepEqual(out.clusters.map((c) => c.label), ['Ordering messages']);
});

test('a key for a group that was never offered names nothing', async () => {
  assert.deepEqual(await twoGroups([
    { group: 'g9', label: 'Nowhere near', summary: 's' },
    { group: '', label: 'Nor this', summary: 's' },
    { group: 'the first one', label: 'Nor this either', summary: 's' },
  ]), ['Fallback one', 'Fallback two']);
});

test('a second name for a group already named does not overwrite the first', async () => {
  assert.deepEqual(await twoGroups([
    { group: 'g1', label: 'First answer', summary: 's' },
    { group: 'group g1', label: 'Second answer', summary: 's' },
  ]), ['First answer', 'Fallback two']);
});

test('g1 is not read as g10, or g10 as g1', async () => {
  // Ten groups because the boundary only exists once the keys share a prefix.
  // A substring match here would put one topic's name on another's pins.
  const ids = Array.from({ length: 10 }, (_, i) => `p${String(i + 1).padStart(2, '0')}`);
  const vectors = Object.fromEntries(ids.map((id, i) => [
    id, Array.from({ length: 10 }, (_, d) => (d === i ? 1 : 0)),
  ]));
  const deps: ClustererDeps = {
    embedder: stubEmbedder(vectors, ids),
    llm: stubLlm({ names: [{ group: 'group g10', label: 'The tenth', summary: 's' }] }),
  };
  const out = await cluster(deps, {
    pins: ids.map((id, i) => pin(id, { headingPath: [`Fallback ${i + 1}`] })),
    existingTopics: [], threshold: THRESHOLD,
  });

  assert.equal(out.clusters.length, 10);
  assert.equal(out.clusters[9]?.label, 'The tenth');
  assert.equal(out.clusters[0]?.label, 'Fallback 1', 'the tenth group named the first');
});

test('an embedder that returns the wrong number of vectors is refused outright', async () => {
  // Vectors that do not line up with pins would cluster the wrong pin to the
  // wrong material — worse than not clustering at all, and invisible.
  const deps: ClustererDeps = {
    embedder: { modelId: 'short', embed: async () => [[1, 0]] },
    llm: stubLlm({ names: [] }),
  };
  await assert.rejects(
    () => cluster(deps, { pins: [pin('p1'), pin('p2')], existingTopics: [], threshold: THRESHOLD }),
    /1 vectors for 2 pins/,
  );
});

// ------------------------------------------------------- partition strategy

/**
 * `SB_PARTITION` chooses the rule; the clusterer is where the choice becomes
 * two embedder calls instead of one. The evidence for D1 is in
 * `domain/partition-d1.ts`; what these tests hold down is that D1 is what runs
 * wherever a coarse space exists, and that a board
 * with one space still gets the one rule that can run on it, and that asking
 * for the second space without wiring it fails loudly rather than downgrading.
 */

/** Same ids, a second space. Deliberately unrelated numbers to the first. */
const coarseStub = (vectors: Record<string, readonly number[]>, ids: readonly string[]): Embedder => ({
  modelId: 'tfidf-v1',
  embed: async (texts) => {
    assert.equal(texts.length, ids.length);
    return ids.map((id) => vectors[id] ?? [0, 0]);
  },
});

test('a board with one space gets the one rule that can run on it', async () => {
  // No coarse space is wired, so there is no bucket stage to run and nothing to
  // choose between. The point of the test is that this is not a silent
  // downgrade of the default: the rule that ran is reported, and the pipeline
  // prints it (`partitionLine`), so a board partitioned by the older rule says
  // so on the line rather than being inferred from what was not wired.
  const ids = ['p1', 'p2'];
  const deps: ClustererDeps = {
    embedder: stubEmbedder({ p1: [1, 0], p2: [0.99, 0.1] }, ids),
    llm: stubLlm({ names: [] }),
  };
  const out = await cluster(deps, { pins: ids.map((id) => pin(id)), existingTopics: [], threshold: THRESHOLD });
  assert.equal(out.strategy, 'single');
  assert.equal(out.coarseEmbeddingModelId, null);
  assert.equal(out.bucketThreshold, null);
  assert.equal(out.clusters.length, 1, 'and the partition is the one that always shipped');
});

test('a wired coarse space is used by default — D1 is the default rule, not an opt-in', async () => {
  // The flip. Before the D1 partition default was ruled this same wiring produced `single`
  // and the coarse embedder was never called; the caller had to ask for D1 by
  // name. Now the caller has to ask for `single` by name instead.
  const ids = ['p1', 'p2'];
  const fine = { p1: [1, 0], p2: [0.99, 0.1] };
  const coarse = { p1: [1, 0], p2: [0, 1] };
  const deps: ClustererDeps = {
    embedder: stubEmbedder(fine, ids),
    coarseEmbedder: coarseStub(coarse, ids),
    llm: stubLlm({ names: [] }),
  };
  const out = await cluster(deps, { pins: ids.map((id) => pin(id)), existingTopics: [], threshold: THRESHOLD });
  assert.equal(out.strategy, 'd1');
  assert.equal(out.coarseEmbeddingModelId, 'tfidf-v1');
  assert.equal(out.bucketThreshold, 0.08);
  assert.equal(out.clusters.length, 2, 'and the coarse bucket did the splitting the fine space would not');
});

test('a coarse space that is wired can still be refused by name', async () => {
  // `SB_PARTITION=single` is the escape hatch back to the rule that shipped
  // first, and it has to work even on a run whose coarse space is built and
  // ready — otherwise the flip is one-way and a comparison run is impossible.
  const ids = ['p1', 'p2'];
  const deps: ClustererDeps = {
    embedder: stubEmbedder({ p1: [1, 0], p2: [0.99, 0.1] }, ids),
    coarseEmbedder: { modelId: 'tfidf-v1', embed: async () => { throw new Error('the coarse space must not be built'); } },
    llm: stubLlm({ names: [] }),
  };
  const out = await cluster(deps, {
    pins: ids.map((id) => pin(id)), existingTopics: [], threshold: THRESHOLD, strategy: 'single',
  });
  assert.equal(out.strategy, 'single');
  assert.equal(out.coarseEmbeddingModelId, null);
  assert.equal(out.bucketThreshold, null);
  assert.equal(out.clusters.length, 1);
});

test('d1 clusters in two spaces, and the coarse one can split what the fine one welded', async () => {
  const ids = ['p1', 'p2'];
  // One space says these two pins are the same topic; the other says they share
  // no vocabulary at all. D1 requires both.
  const fine = { p1: [1, 0], p2: [0.99, 0.1] };
  const coarse = { p1: [1, 0], p2: [0, 1] };
  const deps: ClustererDeps = {
    embedder: stubEmbedder(fine, ids),
    coarseEmbedder: coarseStub(coarse, ids),
    llm: stubLlm({ names: [] }),
  };
  const pins = ids.map((id) => pin(id));

  const single = await cluster(deps, { pins, existingTopics: [], threshold: THRESHOLD, strategy: 'single' });
  assert.equal(single.clusters.length, 1, 'the control: one topic without the bucket');

  const d1 = await cluster(deps, { pins, existingTopics: [], threshold: THRESHOLD, strategy: 'd1' });
  assert.equal(d1.clusters.length, 2);
  assert.equal(d1.strategy, 'd1');
  assert.equal(d1.coarseEmbeddingModelId, 'tfidf-v1');
  assert.equal(d1.bucketThreshold, 0.08, 'the measured cut for the coarse space, not the fine one');
  assert.equal(d1.threshold, THRESHOLD, 'and the fine cut point is not touched by the bucket stage');
});

test('both spaces are handed the same texts in the same order', async () => {
  // The two vectors for one pin have to be the same pin's. Nothing but the call
  // order guarantees that, so it is asserted rather than assumed.
  const ids = ['p1', 'p2', 'p3'];
  const seen: string[][] = [];
  const record = (modelId: string): Embedder => ({
    modelId,
    embed: async (texts) => { seen.push([...texts]); return texts.map(() => [1, 0]); },
  });
  const deps: ClustererDeps = {
    embedder: record('fine-space'), coarseEmbedder: record('tfidf-v1'), llm: stubLlm({ names: [] }),
  };
  await cluster(deps, {
    // Supplied out of id order on purpose: both calls must see the sorted order.
    pins: [...ids].reverse().map((id) => pin(id, { pageTitle: `title of ${id}` })),
    existingTopics: [], threshold: THRESHOLD, strategy: 'd1',
  });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], seen[1]);
  assert.match(String(seen[0]?.[0]), /title of p1/, 'and that order is by pin id');
});

test('d1 without a coarse embedder is refused rather than quietly downgraded', async () => {
  // Falling back to `single` here would partition a learner's board by a rule
  // nobody selected and report nothing — the same invisible substitution the
  // embedder seam refuses to make.
  const deps: ClustererDeps = {
    embedder: stubEmbedder({ p1: [1, 0] }, ['p1']), llm: stubLlm({ names: [] }),
  };
  await assert.rejects(
    () => cluster(deps, { pins: [pin('p1')], existingTopics: [], threshold: THRESHOLD, strategy: 'd1' }),
    /d1 needs a coarse embedder/,
  );
});

test('a coarse embedder that returns the wrong number of vectors is refused outright', async () => {
  const deps: ClustererDeps = {
    embedder: stubEmbedder({ p1: [1, 0], p2: [1, 0] }, ['p1', 'p2']),
    coarseEmbedder: { modelId: 'tfidf-v1', embed: async () => [[1, 0]] },
    llm: stubLlm({ names: [] }),
  };
  await assert.rejects(
    () => cluster(deps, {
      pins: [pin('p1'), pin('p2')], existingTopics: [], threshold: THRESHOLD, strategy: 'd1',
    }),
    /coarse embedder returned 1 vectors for 2 pins/,
  );
});

test('an empty board is not an error', async () => {
  const deps: ClustererDeps = {
    embedder: { modelId: 'stub-space', embed: async () => [] },
    llm: stubLlm(new Error('nothing to name')),
  };
  const out = await cluster(deps, { pins: [], existingTopics: [] });
  assert.deepEqual(out.clusters, []);
  assert.deepEqual(out.unassigned, []);
});

/**
 * NOBODY READING THEIR OWN STUDY PAGE IS "THE LEARNER".
 *
 * The naming prompt asked for *"one sentence naming what the learner is trying
 * to understand"*, and models do what prompts do. A live board came back with
 * *"The learner is trying to understand the gravitational forces exerted by the
 * sun and moon..."*, which the lineup and the board then showed verbatim to the
 * person it is about.
 *
 * The prompt is fixed, so nothing new should arrive framed. This is for every
 * topic already in a store, which is every topic on every board that exists.
 */
test('the instruction’s own frame is taken off a stored gist', () => {
  assert.equal(
    unframeGist("The learner is trying to understand the gravitational forces exerted by the sun and moon on Earth's oceans."),
    "The gravitational forces exerted by the sun and moon on Earth's oceans.");
});

test('every frame this instruction produces is handled, and the subject is capitalised', () => {
  const framed: readonly [string, string][] = [
    ['The learner is trying to understand how the tides work.', 'How the tides work.'],
    ['The learner wants to understand what at-least-once costs.', 'What at-least-once costs.'],
    ['The learner is trying to learn interval training.', 'Interval training.'],
    ['The learner is trying to grasp recursion.', 'Recursion.'],
    ['The learner is trying to work out why the handshake needs two round trips.',
      'Why the handshake needs two round trips.'],
    ['The learner is trying to figure out the difference between spring and neap tides.',
      'The difference between spring and neap tides.'],
    ['This learner is trying to understand database indexes.', 'Database indexes.'],
    ['The user needs to know the ack deadline.', 'The ack deadline.'],
    ['The student is understanding tidal ranges.', 'Tidal ranges.'],
    // Case is a formatting variation in model output, not a different sentence.
    ['the learner is trying to understand osmosis.', 'Osmosis.'],
  ];
  for (const [raw, want] of framed) assert.equal(unframeGist(raw), want, raw);
});

test('a gist that is not framed is passed through untouched', () => {
  // Rewriting a sentence somebody meant, on a guess, would be a worse defect
  // than the one this fixes.
  for (const raw of [
    'What at-least-once costs.',
    'Hearing distance between notes.',
    'Spring and neap tides as a sun-moon alignment effect',
    'The forces the sun and moon exert on the oceans',
  ]) {
    assert.equal(unframeGist(raw), raw, raw);
  }
});

test('a frame with nothing behind it is not a match', () => {
  // Stripping it would leave the board with an empty sentence where it had a
  // bad one, which is a trade in the wrong direction.
  assert.equal(unframeGist('The learner is trying to understand'),
    'The learner is trying to understand');
  assert.equal(unframeGist('The learner is trying to understand   '),
    'The learner is trying to understand');
});

test('whitespace is flattened and nothing usable is an empty string', () => {
  assert.equal(unframeGist('  The learner is trying to understand\n  the tides.  '),
    'The tides.');
  for (const raw of [undefined, null, '', '   ', 42]) {
    assert.equal(unframeGist(raw as string), '', JSON.stringify(raw));
  }
});

test('the naming prompt no longer asks for the sentence that caused this', () => {
  // The root cause, held where it was fixed. A transformation that repairs
  // stored data while the prompt keeps producing more is a treadmill.
  assert.match(NAMING_PROMPT, /naming the thing being understood/);
  assert.match(NAMING_PROMPT, /never "The learner is trying to understand/);
  assert.doesNotMatch(NAMING_PROMPT, /one sentence naming what the learner is trying to understand/);
});

// -------------------------------------------------------- naming at scale

/**
 * THE NAMING CALL, AT THE SIZE A COURSE DROP PRODUCES.
 *
 * One call for every new topic was fine at the six a normal night makes and is
 * nonsense at the size a semester makes: the request asked for
 * `200 + created.length * 120` output tokens, so thirty new topics asked a
 * fast-tier model for 3,800 tokens of pure labelling with every group's material
 * in one prompt. The reply comes back truncated, `names` is short, and the
 * shortfall lands as heading-path fallback labels on a board nobody sees named.
 * It fails **quietly**, which is the only reason it is worth a test.
 */

/** Every pin its own axis, so the partition makes one group per pin. */
const singletonSpace = (ids: readonly string[]): Embedder => ({
  modelId: 'stub-space',
  embed: async (texts) => {
    assert.equal(texts.length, ids.length);
    return ids.map((_, i) => Array.from({ length: ids.length }, (_, j) => (i === j ? 1 : 0)));
  },
});

test('a semester of new topics is named in chunks, and every group is offered once', async () => {
  const count = NAMING_BATCH * 3 + 1;
  const pins = Array.from({ length: count }, (_, i) => pin(`p${String(i).padStart(3, '0')}`));
  const prompts: string[] = [];
  const deps: ClustererDeps = {
    embedder: singletonSpace(pins.map((p) => p.id)),
    llm: {
      complete: async () => { throw new Error('not used'); },
      structured: async <T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => {
        prompts.push(req.prompt);
        const groups = [...req.prompt.matchAll(/^group (g\d+):$/gm)].map((m) => m[1] as string);
        // The cap has to be respected in what is ASKED FOR as well as in what is
        // sent: the token budget was the half of this that failed silently.
        assert.ok((req.maxOutputTokens ?? 0) <= 200 + NAMING_BATCH * 120,
          `one call asked for ${req.maxOutputTokens} output tokens`);
        return {
          value: { names: groups.map((g) => ({ group: g, label: `Name ${g}`, summary: `About ${g}.` })) } as T,
          modelId: 'stub', inputTokens: 0, outputTokens: 0,
        };
      },
    },
  };

  const out = await cluster(deps, { pins, existingTopics: [], threshold: THRESHOLD });
  assert.equal(out.clusters.length, count, 'the geometry did not make one group per pin');
  assert.equal(prompts.length, Math.ceil(count / NAMING_BATCH),
    'the naming pass was not chunked at the stated size');

  /**
   * Every group key offered exactly once, across the whole run.
   *
   * The thing chunking most easily breaks. A chunk that renumbered its keys from
   * zero would offer `g0` in all four calls and write four different topics'
   * names into one slot — the same drift `keys.ts` exists to prevent, arriving
   * through a new door.
   */
  const offered = prompts.flatMap((p) => [...p.matchAll(/^group (g\d+):$/gm)].map((m) => m[1] as string));
  assert.equal(new Set(offered).size, offered.length, 'a group key was offered by two calls');
  assert.equal(offered.length, count, 'some group was never offered to anything');

  assert.equal(out.clusters.filter((c) => c.provisionalName).length, 0,
    'every new topic was named, across however many calls it took');
  assert.equal(new Set(out.clusters.map((c) => c.label)).size, count,
    'two topics were given the same name, so a key was read back onto the wrong group');
});

test('one chunk failing costs its own labels and not the whole board’s', async () => {
  // The second reason for chunking. One bad call used to cost every new topic on
  // the board its name; now it costs a chunk, and the rest are named.
  const count = NAMING_BATCH * 2;
  const pins = Array.from({ length: count }, (_, i) => pin(`p${String(i).padStart(3, '0')}`));
  let call = 0;
  const deps: ClustererDeps = {
    embedder: singletonSpace(pins.map((p) => p.id)),
    llm: {
      complete: async () => { throw new Error('not used'); },
      structured: async <T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => {
        call += 1;
        if (call === 1) throw new Error('truncated JSON');
        const groups = [...req.prompt.matchAll(/^group (g\d+):$/gm)].map((m) => m[1] as string);
        return {
          value: { names: groups.map((g) => ({ group: g, label: `Name ${g}`, summary: '' })) } as T,
          modelId: 'stub', inputTokens: 0, outputTokens: 0,
        };
      },
    },
  };

  const out = await cluster(deps, { pins, existingTopics: [], threshold: THRESHOLD });
  const named = out.clusters.filter((c) => !c.provisionalName);
  assert.equal(named.length, NAMING_BATCH, 'the surviving chunk was named');
  assert.equal(out.clusters.length - named.length, NAMING_BATCH,
    'and the failed chunk fell back per group, rather than taking the board with it');
  // Fallback is honest degradation, not a placeholder: the heading path is a
  // real description, and a provisional name may be replaced on a later run.
  for (const c of out.clusters.filter((x) => x.provisionalName)) {
    assert.equal(c.label, 'Section');
  }
});
