import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TfIdfEmbedder, tokenize } from '../tfidf-embedder.js';
import { cosine, agglomerate } from '@sb/core';

/**
 * The no-model path. Every other stage in the fleet can degrade to something
 * smaller; clustering could not degrade at all, because without a partition
 * there is no board. This is what makes it degrade.
 *
 * Determinism matters more here than accuracy: an unstable fallback is worse
 * than no fallback, because it looks like it is working.
 */

const CORPUS = [
  'Choose a subscription type\nPub/Sub > Subscriptions\nWith pull delivery your subscriber requests messages; with push delivery Pub/Sub sends each message as an HTTP request.',
  'Why are my Pub/Sub messages redelivered?\nQuestions\nIf you do not acknowledge within the ack deadline the message is redelivered.',
  'Intervals\nEar training\nA perfect fifth spans seven semitones; a tritone spans six.',
];

test('the same texts embed to the same numbers', async () => {
  const e = new TfIdfEmbedder();
  assert.deepEqual(await e.embed(CORPUS), await e.embed(CORPUS));
});

test('two separate instances agree', async () => {
  // Nothing may be carried in instance state — a second nightly process must
  // produce the same space as the first.
  assert.deepEqual(await new TfIdfEmbedder().embed(CORPUS), await new TfIdfEmbedder().embed(CORPUS));
});

test('every vector has the same width, and it is the batch vocabulary', async () => {
  const vecs = await new TfIdfEmbedder().embed(CORPUS);
  const width = vecs[0]?.length ?? 0;
  assert.ok(width > 0);
  for (const v of vecs) assert.equal(v.length, width);
});

test('vectors are unit length, so cosine is a dot product downstream', async () => {
  for (const v of await new TfIdfEmbedder().embed(CORPUS)) {
    const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
    assert.ok(Math.abs(norm - 1) < 1e-9, `expected unit length, got ${norm}`);
  }
});

test('two pins about the same thing are closer than two about different things', async () => {
  const [a, b, c] = await new TfIdfEmbedder().embed(CORPUS);
  assert.ok(cosine(a!, b!) > cosine(a!, c!));
});

test('empty text is an honest zero vector, not a NaN', async () => {
  const [v] = await new TfIdfEmbedder().embed(['']);
  assert.ok(v!.every((x) => x === 0));
  assert.equal(cosine(v!, v!), 0);
});

test('an empty batch is an empty result', async () => {
  assert.deepEqual(await new TfIdfEmbedder().embed([]), []);
});

test('the tokeniser splits identifiers and folds simple plurals', () => {
  assert.deepEqual([...tokenize('maxExtension')], ['max', 'extension']);
  assert.deepEqual([...tokenize('messages message')], ['message', 'message']);
  assert.deepEqual([...tokenize('queries')], ['query']);
  assert.deepEqual([...tokenize('ordering')], ['order']);
});

test('scope-qualifier words survive the stop list', () => {
  // The learner's recurring failure is reading a guarantee and missing its
  // scope. Stripping "not", "only" and "within" as noise would delete exactly
  // the words that distinguish those passages from each other.
  const t = tokenize('the message is not redelivered only within a single region');
  for (const word of ['not', 'only', 'within', 'single', 'region']) assert.ok(t.includes(word), word);
});

test('clustering over TF-IDF vectors is stable across three cold runs', async () => {
  // The same assertion the eval harness makes against the real corpus, kept in
  // the suite so a regression fails the build rather than a nightly run.
  const shapes = [];
  for (let i = 0; i < 3; i++) {
    const vecs = await new TfIdfEmbedder().embed(CORPUS);
    const items = CORPUS.map((_, j) => ({ id: `p${j}`, vector: vecs[j]! }));
    shapes.push(agglomerate(items, 0.1).map((g) => g.join(',')).join('|'));
  }
  assert.equal(new Set(shapes).size, 1, shapes.join(' vs '));
});
