import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CloudRunJobConfigError, CloudRunJobLaunchError, CloudRunJobLauncher,
  cloudRunJobTarget, hostedBatchKey,
} from '../cloud-run-job.js';

const TARGET = cloudRunJobTarget(
  'projects/virgil-test/locations/us-central1/jobs/virgil-nightly')!;
const OP = 'projects/virgil-test/locations/us-central1/operations/op_123';
const RECEIPT = 'receipt_1234567890';

test('the deployment job resource is exact and absence stays off', () => {
  assert.equal(cloudRunJobTarget(undefined), null);
  assert.deepEqual(TARGET, {
    resource: 'projects/virgil-test/locations/us-central1/jobs/virgil-nightly',
    projectId: 'virgil-test', location: 'us-central1', job: 'virgil-nightly',
  });
  for (const bad of [
    'https://run.googleapis.com/v2/projects/p/locations/r/jobs/j',
    'projects/other/locations/us-central1/services/virgil',
    'projects/virgil-test/locations/us-central1/jobs/../other',
  ]) assert.throws(() => cloudRunJobTarget(bad), CloudRunJobConfigError, bad);
});

test('a dispatched learner day is either exact, absent, or refused', () => {
  assert.equal(hostedBatchKey(undefined), null);
  assert.equal(hostedBatchKey(' 2026-08-19 '), '2026-08-19');
  for (const bad of ['2026-02-31', '2026-8-1', 'tomorrow']) {
    assert.throws(() => hostedBatchKey(bad), CloudRunJobConfigError);
  }
});

test('automatic launch overrides only the verified board, batch key and fixed args', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fake: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    if (String(input).includes('metadata')) {
      return new Response(JSON.stringify({ access_token: 'token-token-token-token', expires_in: 3600 }));
    }
    return new Response(JSON.stringify({ name: OP }));
  };
  const launcher = new CloudRunJobLauncher({ target: TARGET, fetch: fake });
  assert.deepEqual(await launcher.launch({
    boardId: 'learner-alice_1', batchKey: '2026-08-19', asked: false, receiptId: RECEIPT,
  }), { operationName: OP });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.init?.headers && (calls[0]!.init!.headers as Record<string, string>)['Metadata-Flavor'], 'Google');
  assert.equal(calls[1]!.url,
    'https://run.googleapis.com/v2/projects/virgil-test/locations/us-central1/jobs/virgil-nightly:run');
  assert.equal((calls[1]!.init!.headers as Record<string, string>).authorization,
    'Bearer token-token-token-token');
  assert.deepEqual(JSON.parse(String(calls[1]!.init!.body)), {
    overrides: {
      containerOverrides: [{
        args: ['runner/dist/cli.js', 'process', '--if-due'],
        env: [
          { name: 'SB_STORE', value: 'firestore:virgil-test/learner-alice_1' },
          { name: 'SB_BATCH_KEY', value: '2026-08-19' },
          { name: 'SB_RUN_RECEIPT_ID', value: RECEIPT },
        ],
      }],
      taskCount: 1,
    },
  });
});

test('manual launch uses the same worker without the automatic due gate', async () => {
  const bodies: unknown[] = [];
  const fake: typeof fetch = async (input, init) => {
    if (String(input).includes('metadata')) {
      return new Response(JSON.stringify({ access_token: 'token-token-token-token', expires_in: 3600 }));
    }
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ name: OP }));
  };
  const launcher = new CloudRunJobLauncher({ target: TARGET, fetch: fake });
  await launcher.launch({
    boardId: 'learner-bob', batchKey: '2026-02-28', asked: true, receiptId: RECEIPT,
  });
  assert.deepEqual((bodies[0] as any).overrides.containerOverrides[0].args,
    ['runner/dist/cli.js', 'process']);
});

test('two launches reuse the metadata token; no Cloud Run read permission is needed', async () => {
  let tokens = 0;
  const fake: typeof fetch = async (input) => {
    if (String(input).includes('metadata')) {
      tokens += 1;
      return new Response(JSON.stringify({ access_token: 'token-token-token-token', expires_in: 3600 }));
    }
    return new Response(JSON.stringify({ name: OP }));
  };
  const launcher = new CloudRunJobLauncher({ target: TARGET, fetch: fake });
  await launcher.launch({
    boardId: 'learner-bob', batchKey: '2026-08-19', asked: false, receiptId: RECEIPT,
  });
  await launcher.launch({
    boardId: 'learner-alice', batchKey: '2026-08-20', asked: true,
    receiptId: 'receipt_0987654321',
  });
  assert.equal(tokens, 1);
});

test('learner board and real day are refused before metadata or API access', async () => {
  let calls = 0;
  const launcher = new CloudRunJobLauncher({
    target: TARGET,
    fetch: (async () => { calls += 1; throw new Error('network'); }) as typeof fetch,
  });
  await assert.rejects(launcher.launch({
    boardId: '../bob', batchKey: '2026-08-19', asked: false, receiptId: RECEIPT,
  }),
    /learner board/);
  await assert.rejects(launcher.launch({
    boardId: 'learner-bob', batchKey: '2026-02-31', asked: false, receiptId: RECEIPT,
  }),
    /real day/);
  await assert.rejects(launcher.launch({
    boardId: 'learner-bob', batchKey: '2026-08-19', asked: false, receiptId: 'short',
  }), /receipt id/);
  assert.equal(calls, 0);
});

test('an operation outside the configured deployment is refused', async () => {
  const fake: typeof fetch = async (input) => String(input).includes('metadata')
    ? new Response(JSON.stringify({ access_token: 'token-token-token-token', expires_in: 3600 }))
    : new Response(JSON.stringify({
      name: 'projects/other-project/locations/us-central1/operations/op_1',
    }));
  const launcher = new CloudRunJobLauncher({ target: TARGET, fetch: fake });
  await assert.rejects(launcher.launch({
    boardId: 'learner-bob', batchKey: '2026-08-19', asked: false, receiptId: RECEIPT,
  }), /no identifiable Job operation/);
});

test('API errors disclose no response body', async () => {
  const fake: typeof fetch = async (input) => String(input).includes('metadata')
    ? new Response(JSON.stringify({ access_token: 'token-token-token-token', expires_in: 3600 }))
    : new Response('project policy and private detail', { status: 403 });
  const launcher = new CloudRunJobLauncher({ target: TARGET, fetch: fake });
  await assert.rejects(
    launcher.launch({
      boardId: 'learner-bob', batchKey: '2026-08-19', asked: false, receiptId: RECEIPT,
    }),
    (err: unknown) => err instanceof CloudRunJobLaunchError && !err.ambiguous
      && /HTTP 403/.test(err.message)
      && !/private detail/.test(err.message));
});

test('a transport loss after the POST begins is classified as ambiguous', async () => {
  const fake: typeof fetch = async (input) => {
    if (String(input).includes('metadata')) {
      return new Response(JSON.stringify({ access_token: 'token-token-token-token', expires_in: 3600 }));
    }
    throw new DOMException('timed out', 'AbortError');
  };
  const launcher = new CloudRunJobLauncher({ target: TARGET, fetch: fake });
  await assert.rejects(launcher.launch({
    boardId: 'learner-bob', batchKey: '2026-08-19', asked: false, receiptId: RECEIPT,
  }), (err: unknown) => err instanceof CloudRunJobLaunchError && err.ambiguous);
});
