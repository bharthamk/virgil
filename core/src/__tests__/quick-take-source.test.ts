import { test } from 'node:test';
import assert from 'node:assert/strict';

import { quickTakeMaterialFor, quickTakeSourceWords } from '../domain/quick-take.js';
import type { Pin } from '../domain/types.js';

test('a selection inside its context is counted once without presentation labels', () => {
  const selection = 'lower opportunity cost creates a comparative advantage for a producer';
  const surroundingText = `Trade can help when ${selection}, even if another producer is faster.`;
  const pin = {
    envelope: { selection, surroundingText },
  } as unknown as Pin;
  const material = quickTakeMaterialFor(pin);
  assert.equal(material, surroundingText);
  assert.equal(quickTakeSourceWords(material), surroundingText.split(/\s+/).length);
});
