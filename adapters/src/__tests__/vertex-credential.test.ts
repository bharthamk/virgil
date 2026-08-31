import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlmCredentialMissing } from '@sb/core';
import { VertexCredential, vertexModelEndpoint } from '../vertex-credential.js';

test('Vertex credential reads Cloud Run metadata once and refreshes near expiry', async () => {
  let now = 1_000;
  let calls = 0;
  const seenHeaders: string[] = [];
  const credential = new VertexCredential({
    endpoint: 'http://metadata.invalid/token', now: () => now,
    fetcher: (async (_input, init) => {
      calls += 1;
      seenHeaders.push(new Headers(init?.headers).get('metadata-flavor') ?? '');
      return new Response(JSON.stringify({ access_token: `token-${calls}`, expires_in: 120 }));
    }) as typeof fetch,
  });
  assert.equal(await credential.token(), 'token-1');
  assert.equal(await credential.token(), 'token-1');
  now += 61_000;
  assert.equal(await credential.token(), 'token-2');
  assert.deepEqual(seenHeaders, ['Google', 'Google']);
});

test('concurrent cold Vertex token reads share one metadata request', async () => {
  let calls = 0;
  const credential = new VertexCredential({
    fetcher: (async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ access_token: 'shared', expires_in: 300 }));
    }) as typeof fetch,
  });
  assert.deepEqual(await Promise.all([credential.token(), credential.token()]), ['shared', 'shared']);
  assert.equal(calls, 1);
});

test('Vertex metadata failure is a cloud credential refusal, not a model failure', async () => {
  const credential = new VertexCredential({
    fetcher: (async () => new Response('no', { status: 403 })) as typeof fetch,
  });
  await assert.rejects(credential.token(), (error: unknown) =>
    error instanceof LlmCredentialMissing && error.connection === 'cloud' && /403/.test(error.detail));
});

test('Vertex model endpoints are project and region qualified', () => {
  assert.equal(
    vertexModelEndpoint('virgil-506009', 'us-central1')('gemini-2.5-flash'),
    'https://us-central1-aiplatform.googleapis.com/v1/projects/virgil-506009/locations/'
    + 'us-central1/publishers/google/models/gemini-2.5-flash:streamGenerateContent',
  );
  assert.throws(() => vertexModelEndpoint('', 'us-central1'), /GOOGLE_CLOUD_PROJECT/);
});
