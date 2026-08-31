import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardAreaFor } from '../domain/board-areas.js';
import type { Signal, SignalType, Topic } from '../domain/types.js';

const NOW = new Date('2026-08-28T12:00:00.000Z');
const waiting: Topic = {
  id: 'topic-1', label: 'Accessible controls', summary: 'Names and keyboard focus',
  pinIds: ['pin-1'], state: 'waiting', comfort: 0.15, lastExposedAt: null,
  retiredByUser: false, createdAt: '2026-08-28T10:00:00.000Z', provisionalName: true,
};
const answered = (type: SignalType, invalidated = false): Signal => ({
  id: 'signal-1', topicId: waiting.id, type,
  direction: type === 'quick-take-got-it' ? 'positive' : 'negative',
  at: '2026-08-28T11:00:00.000Z', sourceEvent: 'quick-take:pin-1', invalidated,
});

test('an answered quick take projects a waiting topic as currently learning, not unstarted or learnt', () => {
  for (const type of ['quick-take-got-it', 'quick-take-still-shaky'] as const) {
    assert.equal(boardAreaFor(waiting, [answered(type)], NOW), 'learning');
  }
  assert.equal(waiting.state, 'waiting', 'the human projection rewrote Registrar state');
});

test('an invalidated quick-take answer cannot keep a waiting topic in currently learning', () => {
  assert.equal(boardAreaFor(waiting, [answered('quick-take-got-it', true)], NOW), 'get-started');
  assert.equal(boardAreaFor(waiting, [], NOW), 'get-started');
});
