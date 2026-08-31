import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LlmCredentialMissing, LlmRefused } from '@sb/core';

import { GeminiLlm } from '../gemini-llm.js';

test('Gemini resolves a rotated key per request and ListModels performs no generation', async () => {
  let key = '';
  const urls: string[] = [];
  const seenKeys: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    seenKeys.push(new Headers(init?.headers).get('x-goog-api-key') ?? '');
    if (url.endsWith('/models?pageSize=100')) {
      return new Response(JSON.stringify({ models: [{ name: 'models/gemini-test' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    const event = {
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      modelVersion: 'gemini-test',
    };
    return new Response(`data: ${JSON.stringify(event)}\r\n\r\n`, {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;

  try {
    const llm = new GeminiLlm({ endpoint: 'https://stub.invalid/v1beta', apiKey: () => key });
    // A refusal rather than a failure — nothing is sent, and the type is what
    // stops every degrading catch upstream turning it into "the check did not
    // run". See `LlmCredentialMissing` in the seam.
    await assert.rejects(
      llm.complete({ tier: 'fast', system: 's', prompt: 'p' }),
      (err: unknown) => err instanceof LlmCredentialMissing
        && err instanceof LlmRefused
        && err.connection === 'cloud'
        && /no key saved/.test(err.message)
        && /GEMINI_API_KEY/.test(err.detail),
    );
    key = 'rotated-key';
    assert.deepEqual(await llm.checkAccess(), { models: ['gemini-test'] });
    assert.equal((await llm.complete({ tier: 'fast', system: 's', prompt: 'p' })).value, 'ok');
    assert.equal(urls[0], 'https://stub.invalid/v1beta/models?pageSize=100');
    assert.match(urls[1]!, /:streamGenerateContent/);
    assert.deepEqual(seenKeys, ['rotated-key', 'rotated-key']);
  } finally {
    globalThis.fetch = real;
  }
});

test('Gemini can use a rotating Vertex bearer token and project-qualified model address', async () => {
  const real = globalThis.fetch;
  let tokenCalls = 0;
  let seenUrl = '';
  let seenAuthorization = '';
  let seenApiKey: string | null = null;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(input);
    const headers = new Headers(init?.headers);
    seenAuthorization = headers.get('authorization') ?? '';
    seenApiKey = headers.get('x-goog-api-key');
    const event = {
      candidates: [{ content: { parts: [{ text: 'vertex-ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
      modelVersion: 'gemini-2.5-flash-lite',
    };
    return new Response(`data: ${JSON.stringify(event)}\r\n\r\n`, { status: 200 });
  }) as typeof fetch;
  try {
    const llm = new GeminiLlm({
      apiKey: '', tiers: { fast: 'gemini-2.5-flash-lite', deep: 'gemini-2.5-flash' },
      accessToken: async () => `vertex-token-${++tokenCalls}`,
      modelEndpoint: (model) => `https://vertex.invalid/models/${model}:streamGenerateContent`,
    });
    assert.equal((await llm.complete({ tier: 'fast', system: 's', prompt: 'p' })).value, 'vertex-ok');
    assert.equal(seenUrl,
      'https://vertex.invalid/models/gemini-2.5-flash-lite:streamGenerateContent?alt=sse');
    assert.equal(seenAuthorization, 'Bearer vertex-token-1');
    assert.equal(seenApiKey, null);
  } finally {
    globalThis.fetch = real;
  }
});
