import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalConnectorJob, LocalConnectorStore } from '@sb/core';
import {
  LocalConnectorLlm, createLocalConnectorToken, localConnectorLearnerId,
  localConnectorExecutionRequest, localConnectorTokenHash,
} from '../local-model-connector.js';

test('pairing token carries only the selected learner id and hashes before storage', () => {
  const token = createLocalConnectorToken('learner_123');
  assert.equal(localConnectorLearnerId(token), 'learner_123');
  assert.equal(localConnectorLearnerId(`x${token}`), null);
  assert.match(localConnectorTokenHash(token), /^[a-f0-9]{64}$/);
  assert.equal(localConnectorTokenHash(token).includes(token), false);
});

test('the local worker reserves its stronger model for reasoning-on checks', () => {
  const base = { tier: 'fast' as const, system: 's', prompt: 'p', structured: false };
  assert.equal(localConnectorExecutionRequest(base).tier, 'fast');
  assert.equal(localConnectorExecutionRequest({ ...base, reasoning: 'off' }).tier, 'fast');
  assert.equal(localConnectorExecutionRequest({ ...base, reasoning: 'on' }).tier, 'deep');
});

test('LocalConnectorLlm uses the ordinary Llm contract over its mailbox', async () => {
  const jobs = new Map<string, LocalConnectorJob>();
  const store: LocalConnectorStore = {
    pairLocalConnector: async () => {},
    unpairLocalConnector: async () => {},
    localConnectorPaired: async () => true,
    verifyLocalConnector: async () => true,
    touchLocalConnector: async () => {},
    localConnectorReady: async () => true,
    enqueueLocalConnectorJob: async (job) => {
      jobs.set(job.id, {
        ...job,
        state: 'completed',
        result: { value: 'local answer', modelId: 'gemma4:12b-mlx', inputTokens: 8, outputTokens: 3 },
      });
    },
    claimLocalConnectorJob: async () => null,
    renewLocalConnectorJob: async () => false,
    finishLocalConnectorJob: async () => false,
    readLocalConnectorJob: async (id) => jobs.get(id) ?? null,
    deleteLocalConnectorJob: async (id) => { jobs.delete(id); },
  };
  const result = await new LocalConnectorLlm(store).complete({
    tier: 'fast', reasoning: 'off', system: 'system', prompt: 'prompt', maxOutputTokens: 12,
  });
  assert.deepEqual(result, {
    value: 'local answer', modelId: 'gemma4:12b-mlx', inputTokens: 8, outputTokens: 3,
  });
  assert.equal(jobs.size, 0);
});

test('LocalConnectorLlm refuses before enqueue when no paired worker is polling', async () => {
  let enqueued = false;
  const store = {
    localConnectorReady: async () => false,
    enqueueLocalConnectorJob: async () => { enqueued = true; },
  } as unknown as LocalConnectorStore;
  await assert.rejects(
    new LocalConnectorLlm(store).complete({ tier: 'fast', system: 's', prompt: 'p' }),
    /Local connector is not running/,
  );
  assert.equal(enqueued, false);
});
