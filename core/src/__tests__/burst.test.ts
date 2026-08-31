import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BURST_COOLDOWN_MS, planBurst } from '../domain/burst.js';
import type { Signal, Topic } from '../domain/types.js';

const topic = (id: string): Topic => ({
  id, label: 'TLS', summary: 'TLS protects data in transit.', pinIds: ['p1'],
  state: 'working', comfort: 0.4, lastExposedAt: null, retiredByUser: false,
  createdAt: '2026-08-01T00:00:00.000Z',
});

const burstSignal = (at: string): Signal => ({
  id: 's1', topicId: 'A', type: 'recall-check', direction: 'negative', at,
  sourceEvent: 'burst', invalidated: false,
});

test('a topic just answered in a burst is not offered again on the return screen', () => {
  const at = '2026-08-26T10:00:00.000Z';
  assert.deepEqual(planBurst([topic('A')], [burstSignal(at)], new Date('2026-08-26T10:01:00.000Z')), []);
});

test('a negative burst answer returns after the cooldown rather than disappearing', () => {
  const at = Date.parse('2026-08-26T10:00:00.000Z');
  const items = planBurst([topic('A')], [burstSignal(new Date(at).toISOString())],
    new Date(at + BURST_COOLDOWN_MS + 1));
  assert.equal(items[0]?.topicId, 'A');
  assert.match(items[0]?.prompt ?? '', /explain TLS in your own words/);
});
