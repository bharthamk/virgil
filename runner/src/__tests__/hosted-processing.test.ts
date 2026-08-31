import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from '@sb/adapters';
import {
  HOSTED_ATTEMPT_LEASE_MS, isFinalHostedAttempt, markHostedFailureOnFinalAttempt,
  hostedProcessingVersion, markHostedProcessing,
} from '../hosted-processing.js';

const RECEIPT = 'receipt_1234567890';
const DAY = '2026-08-27';

const stored = async (path: string, receiptId = RECEIPT): Promise<JsonStore> => {
  const store = new JsonStore(path);
  await store.compareAndSetHostedProcessing(null, {
    receiptId, state: 'queued', batchKey: DAY,
    requestedAt: '2026-08-27T01:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
    checkedAt: '2026-08-27T01:00:00.000Z', asked: false, unprocessedPins: 0,
  });
  return store;
};

test('the worker advances only its exact dispatch receipt and never a newer one', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'virgil-hosted-receipt-')), 'store.json');
  const store = await stored(path);
  assert.equal(await markHostedProcessing(store, 'receipt_from_an_older_run', 'running'), 'stale');
  assert.equal((await store.getPrefs()).hostedProcessing?.state, 'queued');
  const firstAttempt = new Date('2026-08-27T01:01:00Z');
  assert.equal(await markHostedProcessing(store, RECEIPT, 'running', firstAttempt), 'updated');
  assert.equal((await store.getPrefs()).hostedProcessing?.expiresAt,
    new Date(firstAttempt.getTime() + HOSTED_ATTEMPT_LEASE_MS).toISOString());
  const retryAttempt = new Date('2026-08-27T01:31:00Z');
  assert.equal(await markHostedProcessing(store, RECEIPT, 'running', retryAttempt), 'updated');
  assert.equal((await store.getPrefs()).hostedProcessing?.expiresAt,
    new Date(retryAttempt.getTime() + HOSTED_ATTEMPT_LEASE_MS).toISOString(),
    'the platform retry did not receive a fresh attempt-sized lease');
  assert.equal(await markHostedProcessing(
    store, RECEIPT, 'finished', new Date('2026-08-27T01:02:00Z'), {
      outcome: 'no-session', outcomeReason: 'model-failed',
      reports: [{ stage: 'compose', ms: 1200, failed: true, degradeReason: 'transport' }],
      remaining: 2, withheld: 1,
    }), 'updated');
  const finished = (await store.getPrefs()).hostedProcessing!;
  assert.equal(finished.state, 'finished');
  assert.deepEqual(finished.result, {
    outcome: 'no-session', outcomeReason: 'model-failed',
    reports: [{ stage: 'compose', ms: 1200, failed: true, degradeReason: 'transport' }],
    remaining: 2, withheld: 1,
  });
  assert.equal(await markHostedProcessing(store, RECEIPT, 'running'), 'stale');
});

test('only Cloud Run final-attempt failure closes the learner receipt', async () => {
  assert.equal(isFinalHostedAttempt('0', '1'), false);
  assert.equal(isFinalHostedAttempt('1', '1'), true);
  assert.equal(isFinalHostedAttempt(undefined, '1'), false);
  assert.equal(isFinalHostedAttempt('not-a-number', '1'), false);

  const path = join(mkdtempSync(join(tmpdir(), 'virgil-hosted-final-')), 'store.json');
  const store = await stored(path);
  await markHostedProcessing(store, RECEIPT, 'running', new Date('2026-08-27T01:01:00Z'));
  assert.equal(await markHostedFailureOnFinalAttempt(store, RECEIPT, {
    CLOUD_RUN_TASK_ATTEMPT: '0', SB_RUN_MAX_RETRIES: '1',
  }), 'retrying');
  assert.equal((await store.getPrefs()).hostedProcessing?.state, 'running');
  assert.equal(await markHostedFailureOnFinalAttempt(store, RECEIPT, {
    CLOUD_RUN_TASK_ATTEMPT: '1', SB_RUN_MAX_RETRIES: '1',
  }, new Date('2026-08-27T01:32:00Z')), 'updated');
  assert.equal((await store.getPrefs()).hostedProcessing?.state, 'failed');
});

test('a worker that loses the compare-and-set race cannot overwrite a newer dispatch', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'virgil-hosted-cas-')), 'store.json');
  const store = await stored(path);
  const compare = store.compareAndSetHostedProcessing.bind(store);
  let injected = false;
  store.compareAndSetHostedProcessing = async (expected, next) => {
    if (!injected) {
      injected = true;
      const current = (await store.getPrefs()).hostedProcessing!;
      await compare(hostedProcessingVersion(current), {
        ...current, receiptId: 'receipt_newer_123456', state: 'launching',
        checkedAt: '2026-08-27T01:01:30.000Z',
      });
    }
    return compare(expected, next);
  };

  assert.equal(await markHostedProcessing(
    store, RECEIPT, 'finished', new Date('2026-08-27T01:02:00Z'),
  ), 'stale');
  const current = (await store.getPrefs()).hostedProcessing!;
  assert.equal(current.receiptId, 'receipt_newer_123456');
  assert.equal(current.state, 'launching');
});

test('the real Job entrypoint closes a no-work dispatch through the board receipt', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'virgil-hosted-cli-')), 'store.json');
  await stored(path);
  const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
  const run = spawnSync(process.execPath, [cli, 'process', '--if-due'], {
    encoding: 'utf8', timeout: 60_000,
    env: {
      ...process.env, SB_DB: path, SB_BATCH_KEY: DAY, SB_RUN_RECEIPT_ID: RECEIPT,
      SB_EMBEDDER: 'tfidf', SB_ORCHESTRATOR: 'local',
    },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /batch-outcome not-due/);
  const reopened = new JsonStore(path);
  const receipt = (await reopened.getPrefs()).hostedProcessing!;
  assert.equal(receipt.state, 'finished');
  assert.deepEqual(receipt.result, {
    outcome: null, outcomeReason: null, reports: [], remaining: 0, withheld: 0,
  });
});
