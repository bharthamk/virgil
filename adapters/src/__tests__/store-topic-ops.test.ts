import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeComfort, TopicOpError, type Pin, type Signal, type Topic } from '@sb/core';
import { JsonStore } from '../json-store.js';

/**
 * Split and merge in the store — the learner's repair control for a wrong
 * grouping, and the only thing that can undo one now that clustering is
 * attach-only (DEAD_ENDS.md D15).
 *
 * The load-bearing property, and the one most of these tests are about: a merge
 * rewrites NO signals. The ledger stays append-only, because history is what
 * makes regression detectable (SB-22), and the union happens when signals are
 * read through the alias map.
 */

const path = (tag: string): string => join(mkdtempSync(join(tmpdir(), `sb-${tag}-`)), 'db.json');
const store = (tag = 'ops'): JsonStore => new JsonStore(path(tag));

const pin = (id: string, topicId: string | null): Pin => ({
  id, type: 'interest',
  envelope: {
    selection: `selection ${id}`, parts: [], surroundingText: 'around it', headingPath: [],
    pageTitle: `page ${id}`, url: 'https://e.com', canonicalUrl: null, siteName: null,
    contentLanguage: 'en', media: null,
  },
  note: null, capturedAt: '2026-08-01T00:00:00Z',
  fromSuggestion: false, enrichment: null, topicId,
});

const topic = (id: string, pinIds: readonly string[], over: Partial<Topic> = {}): Topic => ({
  id, label: `label of ${id}`, summary: `summary of ${id}`, pinIds,
  state: 'working', comfort: 0.5, lastExposedAt: null, retiredByUser: false,
  createdAt: '2026-08-01T00:00:00Z', ...over,
});

const NOW = new Date('2026-08-19T03:00:00Z');

const signal = (id: string, topicId: string, direction: Signal['direction'], at = '2026-08-18T00:00:00Z'): Signal => ({
  id, topicId,
  type: direction === 'positive' ? 'answer-correct' : 'answer-wrong',
  direction, at, sourceEvent: `answer:sess:${id}`, invalidated: false,
});

/** Two topics with pins, and a signal history on each. */
async function twoTopics(s: JsonStore): Promise<void> {
  await s.putPin(pin('p1', 'A'));
  await s.putPin(pin('p2', 'A'));
  await s.putPin(pin('p3', 'B'));
  await s.putTopic(topic('A', ['p1', 'p2']));
  await s.putTopic(topic('B', ['p3']));
}

// ------------------------------------------------------------------- merge

test('a merge moves the pins and retires the absorbed id', async () => {
  const s = store();
  await twoTopics(s);
  const kept = await s.mergeTopics('A', 'B');

  assert.equal(kept.id, 'A');
  assert.deepEqual((await s.listTopics()).map((t) => t.id), ['A']);
  assert.deepEqual((await s.getTopic('A'))?.pinIds, ['p1', 'p2', 'p3']);
  assert.equal((await s.getPin('p3'))?.topicId, 'A', 'the pin moved with its topic');
  assert.deepEqual(await s.topicAliases(), { B: 'A' });
});

test('a merge unions the comfort history, and the arithmetic says so', async () => {
  const s = store();
  await twoTopics(s);
  // A: three correct answers. B: three wrong ones. Same day, same signal type,
  // so recency and weight are identical on both sides and the union is the only
  // thing that can move the number.
  for (const id of ['a1', 'a2', 'a3']) await s.appendSignal(signal(id, 'A', 'positive'));
  for (const id of ['b1', 'b2', 'b3']) await s.appendSignal(signal(id, 'B', 'negative'));

  const before = computeComfort('A', await s.listSignals(), NOW);
  assert.equal(before.comfort, 1, 'three out of three, before the merge');
  assert.equal(before.evidenceCount, 3);

  await s.mergeTopics('A', 'B');

  const after = computeComfort('A', await s.listSignals(), NOW);
  assert.ok(Math.abs(after.comfort - 0.5) < 1e-9, `three right and three wrong is 0.5, got ${after.comfort}`);
  assert.equal(after.evidenceCount, 6, 'every signal from both topics is counted once');
  assert.equal(computeComfort('B', await s.listSignals(), NOW).evidenceCount, 0,
    'nothing is left behind under the retired id');
});

test('the ledger on disk is not rewritten by a merge', async () => {
  // The union is a read projection. If a merge edited the ledger it would be a
  // retroactive edit of the learner's own evidence, and the append-only
  // guarantee that SB-22 regression detection rests on would be gone.
  const p = path('ledger');
  const s = new JsonStore(p);
  await twoTopics(s);
  await s.appendSignal(signal('b1', 'B', 'negative'));
  await s.mergeTopics('A', 'B');

  const raw = JSON.parse(readFileSync(p, 'utf8')) as { signals: Signal[]; aliases: Record<string, string> };
  assert.equal(raw.signals.length, 1);
  assert.equal(raw.signals[0]?.topicId, 'B', 'stored verbatim, under the id it was recorded against');
  assert.deepEqual(raw.aliases, { B: 'A' });

  const read = await s.listSignals();
  assert.equal(read[0]?.topicId, 'A', 'and resolved to the survivor on the way out');
});

test('listSignals filters by the resolved id, from either side of the merge', async () => {
  const s = store();
  await twoTopics(s);
  await s.appendSignal(signal('a1', 'A', 'positive'));
  await s.appendSignal(signal('b1', 'B', 'negative'));
  await s.mergeTopics('A', 'B');

  assert.equal((await s.listSignals('A')).length, 2);
  assert.equal((await s.listSignals('B')).length, 2,
    'asking under the old id gives the same history, not an empty one');
});

test('a signal written under a retired id after the merge still counts', async () => {
  // A session built before the merge posts an answer after it. The signal
  // arrives with the pre-merge topic id and must not fall on the floor.
  const s = store();
  await twoTopics(s);
  await s.mergeTopics('A', 'B');
  await s.appendSignal(signal('late', 'B', 'negative'));
  assert.equal(computeComfort('A', await s.listSignals(), NOW).evidenceCount, 1);
});

test('a chain of merges unions all three histories', async () => {
  const s = store();
  await s.putPin(pin('p1', 'A'));
  await s.putPin(pin('p2', 'B'));
  await s.putPin(pin('p3', 'C'));
  await s.putTopic(topic('A', ['p1']));
  await s.putTopic(topic('B', ['p2']));
  await s.putTopic(topic('C', ['p3']));
  await s.appendSignal(signal('a1', 'A', 'positive'));
  await s.appendSignal(signal('b1', 'B', 'positive'));
  await s.appendSignal(signal('c1', 'C', 'negative'));

  await s.mergeTopics('B', 'C');   // C -> B
  await s.mergeTopics('A', 'B');   // B -> A, so C -> B -> A

  assert.deepEqual(await s.topicAliases(), { C: 'B', B: 'A' }, 'the chain is kept, not compressed');
  assert.equal((await s.listSignals('A')).length, 3);
  assert.equal((await s.listSignals('C')).length, 3, 'the oldest id still finds the whole history');
  assert.deepEqual((await s.getTopic('A'))?.pinIds, ['p1', 'p2', 'p3']);
  assert.deepEqual((await s.listTopics()).map((t) => t.id), ['A']);
});

test('merging into an id that was itself absorbed lands on the live topic', async () => {
  const s = store();
  await twoTopics(s);
  await s.putPin(pin('p4', 'D'));
  await s.putTopic(topic('D', ['p4']));
  await s.mergeTopics('A', 'B');            // B -> A
  const kept = await s.mergeTopics('B', 'D'); // "into B" means into A
  assert.equal(kept.id, 'A');
  assert.deepEqual(kept.pinIds, ['p1', 'p2', 'p3', 'p4']);
});

test('a merge is refused rather than half-applied', async () => {
  const s = store();
  await twoTopics(s);
  await s.putPin(pin('p9', 'X'));
  await s.putTopic(topic('X', ['p9']));

  await assert.rejects(() => s.mergeTopics('A', 'A'), (e) => (e as TopicOpError).code === 'self-merge');
  await assert.rejects(() => s.mergeTopics('A', 'ghost'), (e) => (e as TopicOpError).code === 'unknown-topic');
  await s.mergeTopics('A', 'B');
  // Repeating the same merge is not an error about aliases, it is the same
  // request: A and B are one topic now. The more specific message wins.
  await assert.rejects(() => s.mergeTopics('A', 'B'), (e) => (e as TopicOpError).code === 'self-merge');
  // Absorbing an already-absorbed id into a *different* topic is the stale-panel
  // case, and is refused rather than silently retiring A instead.
  await assert.rejects(() => s.mergeTopics('X', 'B'), (e) => (e as TopicOpError).code === 'absorbed-topic');

  assert.deepEqual(await s.topicAliases(), { B: 'A' }, 'nothing extra was recorded by the failures');
  assert.deepEqual((await s.listTopics()).map((t) => t.id), ['A', 'X']);
});

// ------------------------------------------------------------------- split

test('a split moves the chosen pins and leaves every signal behind', async () => {
  const s = store();
  await s.putPin(pin('p1', 'A'));
  await s.putPin(pin('p2', 'A'));
  await s.putPin(pin('p3', 'A'));
  await s.putTopic(topic('A', ['p1', 'p2', 'p3']));
  for (const id of ['a1', 'a2']) await s.appendSignal(signal(id, 'A', 'positive'));

  const created = await s.splitTopic('A', ['p3'], 'Tritone substitution');

  assert.equal(created.label, 'Tritone substitution');
  assert.deepEqual(created.pinIds, ['p3']);
  assert.equal((await s.getPin('p3'))?.topicId, created.id);
  assert.deepEqual((await s.getTopic('A'))?.pinIds, ['p1', 'p2']);

  // Comfort history is not divisible. No signal in the ledger says which half
  // of the topic a past answer was about, so dividing it would be a guess
  // dressed as evidence.
  assert.equal((await s.listSignals('A')).length, 2, 'the original keeps all of it');
  assert.equal((await s.listSignals(created.id)).length, 0, 'the new topic starts with none');
  assert.equal(computeComfort(created.id, await s.listSignals(), NOW).evidenceCount, 0);
  assert.equal(computeComfort(created.id, await s.listSignals(), NOW).certainty, 0,
    'no evidence means no certainty, which is what stops it being taught as if we knew');
});

test('a split creates no alias — nothing was retired', async () => {
  const s = store();
  await s.putPin(pin('p1', 'A'));
  await s.putPin(pin('p2', 'A'));
  await s.putTopic(topic('A', ['p1', 'p2']));
  await s.splitTopic('A', ['p2'], 'New thing');
  assert.deepEqual(await s.topicAliases(), {});
  assert.equal((await s.listTopics()).length, 2);
});

test('a split that would empty the original is refused and changes nothing', async () => {
  const s = store();
  await s.putPin(pin('p1', 'A'));
  await s.putPin(pin('p2', 'A'));
  await s.putTopic(topic('A', ['p1', 'p2']));
  await assert.rejects(() => s.splitTopic('A', ['p1', 'p2'], 'Everything'),
    (e) => (e as TopicOpError).code === 'empty-split');
  assert.equal((await s.listTopics()).length, 1);
  assert.deepEqual((await s.getTopic('A'))?.pinIds, ['p1', 'p2']);
  assert.equal((await s.getPin('p2'))?.topicId, 'A');
});

test('a split of a topic reached by its pre-merge id splits the survivor', async () => {
  const s = store();
  await twoTopics(s);
  await s.mergeTopics('A', 'B');
  const created = await s.splitTopic('B', ['p3'], 'Back out again');
  assert.deepEqual((await s.getTopic('A'))?.pinIds, ['p1', 'p2']);
  assert.deepEqual(created.pinIds, ['p3']);
});

test('a merge then a split gets the pins back but not the history — and says so', async () => {
  // The honest shape of "undo". Pins are divisible and go back where the user
  // puts them; comfort is not, and stays with the topic that holds the ledger.
  const s = store();
  await twoTopics(s);
  await s.appendSignal(signal('a1', 'A', 'positive'));
  await s.appendSignal(signal('b1', 'B', 'negative'));
  await s.mergeTopics('A', 'B');
  const created = await s.splitTopic('A', ['p3'], 'B again');

  assert.deepEqual(created.pinIds, ['p3']);
  assert.equal((await s.listSignals(created.id)).length, 0);
  assert.equal((await s.listSignals('A')).length, 2, 'both histories stay with the topic that kept them');
});

// ------------------------------------------------- read paths, one by one

test('every read path that carries a topic id resolves it', async () => {
  const s = store('reads');
  await twoTopics(s);
  await s.appendSignal(signal('b1', 'B', 'negative'));
  await s.putStatement({ id: 'st1', text: 'you find this hard', topicId: 'B', userEdited: false,
    evidenceSignalIds: [], updatedAt: '2026-08-02T00:00:00Z' });
  await s.putEdges([
    { from: 'B', to: 'Z', confidence: 0.9, justification: 'j' },
    { from: 'A', to: 'B', confidence: 0.8, justification: 'collapses' },
  ]);
  await s.putSession({
    id: 'S1', builtAt: '2026-08-03T00:00:00Z', fromPinCount: 1, targetMinutes: 15,
    estimatedMinutes: 10, currentSectionIndex: 0, closingNote: null,
    sections: [{ topicId: 'B', heading: 'h', body: 'b', depth: 'building', estimatedMinutes: 10,
      question: null, sourceIds: [], completed: false }],
  });

  await s.mergeTopics('A', 'B');

  assert.equal((await s.getPin('p3'))?.topicId, 'A', 'pin membership');
  assert.equal((await s.listPins()).find((p) => p.id === 'p3')?.topicId, 'A', 'pin membership, listed');
  assert.equal((await s.getTopic('B'))?.id, 'A', 'a stale topic id finds the survivor');
  assert.deepEqual((await s.listTopics()).map((t) => t.id), ['A'], 'the retired id is off the board');
  assert.equal((await s.listSignals())[0]?.topicId, 'A', 'the signal ledger');
  assert.equal((await s.listStatements())[0]?.topicId, 'A', 'the learner model');
  assert.equal((await s.getSession('S1'))?.sections[0]?.topicId, 'A', 'session provenance');
  assert.equal((await s.latestSession())?.sections[0]?.topicId, 'A', 'and the latest-session read');

  const edges = await s.listEdges();
  assert.deepEqual(edges.map((e) => [e.from, e.to]), [['A', 'Z']],
    'the prerequisite graph resolves, and an edge that collapsed onto itself is dropped');
});

test('decay state survives a merge in the direction that keeps D14 honest', async () => {
  const s = store('decay');
  await s.putPin(pin('p1', 'A'));
  await s.putPin(pin('p2', 'B'));
  await s.putTopic(topic('A', ['p1'], { lastExposedAt: null }));
  await s.putTopic(topic('B', ['p2'], { lastExposedAt: '2026-08-15T00:00:00Z' }));
  const kept = await s.mergeTopics('A', 'B');
  assert.equal(kept.lastExposedAt, '2026-08-15T00:00:00Z',
    'the merged topic holds material that was taught, so it is not a never-taught topic');
});

test('writing a topic under a retired id is refused rather than resurrecting it', async () => {
  const s = store();
  await twoTopics(s);
  await s.mergeTopics('A', 'B');
  await assert.rejects(() => s.putTopic(topic('B', ['p3'])),
    (e) => (e as TopicOpError).code === 'absorbed-topic');
  assert.deepEqual((await s.listTopics()).map((t) => t.id), ['A']);
});

test('writing a pin under a retired id quietly lands it on the survivor', async () => {
  // Asymmetric with putTopic on purpose: a pin's topicId is derived membership
  // rather than evidence, so there is nothing to lose by resolving it, and a
  // nightly run that read the board before a merge must not undo the merge.
  const s = store();
  await twoTopics(s);
  await s.mergeTopics('A', 'B');
  await s.putPin(pin('p3', 'B'));
  assert.equal((await s.getPin('p3'))?.topicId, 'A');
});

test('a full wipe takes the alias map with it', async () => {
  const s = store();
  await twoTopics(s);
  await s.mergeTopics('A', 'B');
  await s.deleteEverything();
  assert.deepEqual(await s.topicAliases(), {});
});

// ------------------------------------------------------------ atomicity

test('concurrent repairs against a cold store all land', async () => {
  // Both operations mutate synchronously between two awaits and persist through
  // the same write queue as everything else, so nothing interleaves.
  const p = path('atomic');
  const s = new JsonStore(p);
  await s.putPin(pin('p1', 'A'));
  await s.putPin(pin('p2', 'A'));
  await s.putPin(pin('p3', 'B'));
  await s.putPin(pin('p4', 'C'));
  await s.putTopic(topic('A', ['p1', 'p2']));
  await s.putTopic(topic('B', ['p3']));
  await s.putTopic(topic('C', ['p4']));

  const cold = new JsonStore(p);
  await Promise.all([
    cold.mergeTopics('A', 'B'),
    cold.splitTopic('A', ['p2'], 'Split out'),
  ]);

  const onDisk = JSON.parse(readFileSync(p, 'utf8')) as { topics: Topic[]; aliases: Record<string, string> };
  assert.deepEqual(onDisk.aliases, { B: 'A' });
  assert.equal(onDisk.topics.length, 3, 'A, C and the new one');
  const a = onDisk.topics.find((t) => t.id === 'A');
  assert.deepEqual([...(a?.pinIds ?? [])].sort(), ['p1', 'p3'], 'both operations applied, neither lost');
});
