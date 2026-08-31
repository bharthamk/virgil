import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maxInputTokensFor, modelInputWindow, modelInputWindowForId,
} from '../model-input-windows.js';

test('known model ids report their input windows', () => {
  assert.equal(maxInputTokensFor('gemini-3.7-flash'), 1_048_576);
  assert.deepEqual(modelInputWindowForId('gemma-4-26b-a4b-it'), {
    modelId: 'gemma-4-26b-a4b-it',
    maxInputTokens: 262_144,
  });
});

test('connection receipts name pinned cloud and local models', () => {
  assert.equal(modelInputWindow('cloud', 'deep').modelId, 'gemini-3.7-flash');
  assert.ok(modelInputWindow('local', 'fast').modelId);
});

test('unknown and delegated models report an unknown window', () => {
  assert.equal(maxInputTokensFor('operator-model'), null);
  assert.deepEqual(modelInputWindow('cli', 'fast'), { modelId: null, maxInputTokens: null });
});
