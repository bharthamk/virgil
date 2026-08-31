import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CliEndpointLlm } from '../cli-endpoint-llm.js';

test('CLI endpoint sends the operator token and rejects an oversized response', async () => {
  const real = globalThis.fetch;
  let authorization = '';
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    authorization = new Headers(init.headers).get('authorization') ?? '';
    return new Response('x'.repeat(80));
  }) as typeof fetch;
  try {
    const llm = new CliEndpointLlm({
      endpoint: 'http://127.0.0.1:8798', token: 'operator-only', maxResponseBytes: 32,
    });
    await assert.rejects(() => llm.complete({ tier: 'fast', system: '', prompt: 'x' }), /32 response bytes/);
    assert.equal(authorization, 'Bearer operator-only');
  } finally { globalThis.fetch = real; }
});

test('CLI endpoint cannot be constructed without its service-owned token', () => {
  assert.throws(() => new CliEndpointLlm({ endpoint: 'http://127.0.0.1:8798', token: ' ' }), /token/);
});
