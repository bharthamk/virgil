import { test } from 'node:test';
import assert from 'node:assert/strict';
import { materialCheckInPrompt, materialCheckInReceipt } from '../material-check-in.js';

test('a partial block explains its bounded write before confirmation', () => {
  assert.deepEqual(materialCheckInPrompt(3, 0, 10), {
    note: 'This records 3 minutes, not the whole item.',
    recordLabel: 'I did the 3 minutes',
  });
});

test('the last block offers completion and names why', () => {
  assert.deepEqual(materialCheckInPrompt(1, 9, 10), {
    note: 'This block covers what remains of the item.',
    recordLabel: 'I finished it',
  });
});

test('an open material receipt names the service-confirmed remainder', () => {
  assert.equal(
    materialCheckInReceipt(3, 0, 10, { progressMinutes: 3, doneAt: null }),
    'Recorded 3 minutes. 7 of 10 remain.',
  );
});

test('a retry trusts stored progress rather than re-adding the attempted block', () => {
  assert.equal(
    materialCheckInReceipt(3, 0, 10, { progressMinutes: 6, doneAt: null }),
    'Recorded 3 minutes. 4 of 10 remain.',
  );
});

test('a completed item owns one final receipt', () => {
  assert.equal(
    materialCheckInReceipt(3, 7, 10, { progressMinutes: 10, doneAt: '2026-08-28T00:00:00Z' }),
    'Marked covered.',
  );
});

test('legacy material without a total remains honest about being open', () => {
  assert.equal(
    materialCheckInReceipt(3, 0, null, { progressMinutes: 3, doneAt: null }),
    'Recorded 3 minutes. The item is still open.',
  );
});
