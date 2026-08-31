import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonStore } from '../json-store.js';
import { computeComfort, renderStatements, type PureDeps, type Signal } from '@sb/core';

/**
 * , across the store seam.
 *
 * The evidence behind a statement is only worth composing if it survives the
 * night — a provenance list that is right in memory and empty on disk is the
 * same failure the field already had, moved one layer down. And the learner's
 * own edit has to survive regeneration with its evidence intact, or tomorrow's
 * run silently re-attributes a sentence they wrote.
 */

const store = () => new JsonStore(join(mkdtempSync(join(tmpdir(), 'sb-')), 'db.json'));

const NOW = new Date('2026-08-19T09:00:00Z');

const signal = (id: string, topicId: string): Signal => ({
  id, topicId, type: 'answer-correct', direction: 'positive',
  at: '2026-08-18T09:00:00Z', sourceEvent: 'answer:sess:p1', invalidated: false,
});

const saying = (...statements: string[]): PureDeps => ({
  clock: { now: () => NOW },
  llm: {
    complete: async () => { throw new Error('unused'); },
    structured: async <T>() => ({
      value: { statements } as T, modelId: 'stub', inputTokens: 0, outputTokens: 0,
    }),
  },
});

const topic = {
  id: 'T1', label: 'Firestore indexes', summary: '', pinIds: ['p1'],
  state: 'working' as const, comfort: 0.5, lastExposedAt: null,
  retiredByUser: false, createdAt: '2026-08-01T00:00:00Z',
};

test('the evidence behind a statement survives the store round-trip', async () => {
  const s = store();
  const signals = [signal('sig-1', 'T1'), signal('sig-2', 'T1')];
  for (const sg of signals) await s.appendSignal(sg);
  await s.putTopic(topic);

  const [composed] = await renderStatements(
    saying('You are getting there with Firestore indexes.'),
    [topic], [computeComfort('T1', signals, NOW)], []);
  assert.ok(composed);
  await s.putStatement({ ...composed, id: 'st1', updatedAt: NOW.toISOString() });

  const [read] = await s.listStatements();
  assert.deepEqual([...(read?.evidenceSignalIds ?? [])], ['sig-1', 'sig-2']);

  const ledger = new Set((await s.listSignals()).map((sg) => sg.id));
  assert.ok((read?.evidenceSignalIds ?? []).every((id) => ledger.has(id)),
    'the ids on disk still name signals on disk');
});

test('regeneration replaces the derived read and leaves an edited line alone', async () => {
  // The nightly rule, re-enacted: `pipeline.ts` deletes every statement the
  // learner has not edited and writes the new set over the top. An edited line
  // keeps its text AND the evidence it was written against — re-attributing a
  // sentence the learner wrote would be the product answering its own question.
  const s = store();
  await s.putStatement({
    id: 'st-mine', text: 'that was one bad fortnight, not a habit', topicId: null,
    userEdited: true, evidenceSignalIds: ['sig-1'], updatedAt: '2026-08-12T00:00:00Z',
  });
  await s.putStatement({
    id: 'st-derived', text: 'you move on before meeting the exceptions', topicId: null,
    userEdited: false, evidenceSignalIds: ['sig-2'], updatedAt: '2026-08-12T00:00:00Z',
  });

  for (const old of await s.listStatements()) {
    if (!old.userEdited) await s.deleteStatement(old.id);
  }
  await s.putStatement({
    id: 'st-new', text: 'you are getting there with Firestore indexes', topicId: null,
    userEdited: false, evidenceSignalIds: ['sig-3'], updatedAt: NOW.toISOString(),
  });

  const after = await s.listStatements();
  const mine = after.find((x) => x.id === 'st-mine');
  assert.deepEqual([...(mine?.evidenceSignalIds ?? [])], ['sig-1'],
    'the edit keeps the evidence it was made against, untouched');
  assert.equal(mine?.text, 'that was one bad fortnight, not a habit');
  assert.deepEqual(after.map((x) => x.id).sort(), ['st-mine', 'st-new']);
});
