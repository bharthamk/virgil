import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LearnerPrefs, Llm, LlmRequest, LlmResult } from '@sb/core';
import {
  DEFAULT_CLI_MODEL_ENDPOINT, DEFAULT_LOCAL_MODEL_ENDPOINT, DEFAULT_MODEL_PROVIDERS,
  DEFAULT_MODEL_ROUTES, ModelProviderDisabledError, ModelRouter, effectiveModelProviders,
  effectiveModelRoutes, effectiveRouteMode, isModelProviderToggles, isModelRoutes,
  modelEndpoint, modelRouteFor,
} from '../model-routing.js';

const prefs = (over: Partial<LearnerPrefs> = {}): LearnerPrefs => ({
  targetMinutes: 15,
  interfaceLanguage: 'en',
  pausedUntil: null,
  excludedDomains: [],
  interview: {},
  rejectedOrigins: {},
  ...over,
});

const named = (name: string, calls: string[]): Llm => ({
  complete: async (_req: LlmRequest): Promise<LlmResult<string>> => {
    calls.push(name);
    return { value: name, modelId: name, inputTokens: 0, outputTokens: 0 };
  },
  structured: async <T>(_req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => {
    calls.push(name);
    return { value: { name } as T, modelId: name, inputTokens: 0, outputTokens: 0 };
  },
});

const request: LlmRequest = { tier: 'fast', system: 's', prompt: 'p' };

test('Cloud is the product default, and each persisted choice routes the same seam', async () => {
  let current = prefs();
  const calls: string[] = [];
  const endpoints: string[] = [];
  const router = new ModelRouter({
    store: { getPrefs: async () => current },
    providers: {
      cloud: named('cloud', calls),
      local: (endpoint) => { endpoints.push(`local:${endpoint}`); return named('local', calls); },
      cli: (endpoint) => { endpoints.push(`cli:${endpoint}`); return named('cli', calls); },
    },
  });

  assert.equal((await router.complete(request)).value, 'cloud');
  current = prefs({ modelMode: 'local' });
  assert.equal((await router.complete(request)).value, 'local');
  current = prefs({ modelMode: 'cli' });
  assert.equal((await router.complete(request)).value, 'cli');
  assert.deepEqual(calls, ['cloud', 'local', 'cli']);
  assert.deepEqual(endpoints, [
    `local:${DEFAULT_LOCAL_MODEL_ENDPOINT}`,
    `cli:${DEFAULT_CLI_MODEL_ENDPOINT}`,
  ]);
});

test('the default enables Cloud and sends quick, deep and image work there', () => {
  assert.deepEqual(effectiveModelProviders(prefs()), DEFAULT_MODEL_PROVIDERS);
  assert.deepEqual(effectiveModelRoutes(prefs()), DEFAULT_MODEL_ROUTES);
  assert.equal(effectiveRouteMode(prefs(), request), 'cloud');
  assert.equal(effectiveRouteMode(prefs(), { ...request, tier: 'deep' }), 'cloud');
  assert.equal(effectiveRouteMode(prefs(), {
    ...request, media: [{ kind: 'image', ref: 'data:image/png;base64,AA==' }],
  }), 'cloud');
});

test('quick, deep and images route independently, with media taking precedence over tier', async () => {
  const calls: string[] = [];
  const current = prefs({
    modelProviders: { cloud: true, local: true, cli: true },
    modelRoutes: { quick: 'local', deep: 'cloud', images: 'cli' },
  });
  const router = new ModelRouter({
    store: { getPrefs: async () => current },
    providers: {
      cloud: named('cloud', calls),
      local: () => named('local', calls),
      cli: () => named('cli', calls),
    },
  });

  await router.complete(request);
  await router.complete({ ...request, tier: 'deep' });
  await router.complete({
    ...request,
    tier: 'deep',
    media: [{ kind: 'image', ref: 'data:image/png;base64,AA==' }],
  });
  assert.deepEqual(calls, ['local', 'cloud', 'cli']);
  assert.equal(modelRouteFor({ ...request, tier: 'deep', media: [] }), 'deep');
});

test('legacy modelMode enables and routes all workloads as a migration fallback', () => {
  const legacy = prefs({ modelMode: 'local' });
  assert.deepEqual(effectiveModelProviders(legacy), { cloud: false, local: true, cli: false });
  assert.deepEqual(effectiveModelRoutes(legacy), { quick: 'local', deep: 'local', images: 'local' });
  assert.equal(effectiveRouteMode(legacy, request), 'local');
  assert.equal(effectiveRouteMode(legacy, { ...request, tier: 'deep' }), 'local');
  assert.equal(effectiveRouteMode(legacy, {
    ...request, media: [{ kind: 'image', ref: 'data:image/png;base64,AA==' }],
  }), 'local');
});

test('an assigned disabled provider throws explicitly and never calls another provider', async () => {
  const calls: string[] = [];
  const router = new ModelRouter({
    store: { getPrefs: async () => prefs({
      modelProviders: { cloud: true, local: false, cli: false },
      modelRoutes: { quick: 'local', deep: 'cloud', images: 'cloud' },
    }) },
    providers: {
      cloud: named('cloud', calls),
      local: () => named('local', calls),
      cli: () => named('cli', calls),
    },
  });
  await assert.rejects(router.complete(request), (error) => {
    assert.ok(error instanceof ModelProviderDisabledError);
    assert.equal(error.provider, 'local');
    assert.equal(error.route, 'quick');
    assert.match(error.message, /quick.*disabled provider local/);
    return true;
  });
  assert.deepEqual(calls, []);
});

test('configuration guards accept only complete provider and route objects', () => {
  assert.equal(isModelProviderToggles({ cloud: true, local: false, cli: true }), true);
  assert.equal(isModelProviderToggles({ cloud: true, local: false }), false);
  assert.equal(isModelProviderToggles({ cloud: true, local: false, cli: true, extra: true }), false);
  assert.equal(isModelRoutes({ quick: 'cloud', deep: 'local', images: 'cli' }), true);
  assert.equal(isModelRoutes({ quick: 'cloud', deep: 'local' }), false);
  assert.equal(isModelRoutes({ quick: 'cloud', deep: 'local', images: 'other' }), false);
});

test('a model call re-reads the preference, so a saved switch needs no restart', async () => {
  let current = prefs({ modelMode: 'local' });
  const calls: string[] = [];
  const router = new ModelRouter({
    store: { getPrefs: async () => current },
    providers: {
      cloud: named('cloud', calls),
      local: () => named('local', calls),
      cli: () => named('cli', calls),
    },
  });
  await router.complete(request);
  current = prefs({ modelMode: 'cloud' });
  await router.complete(request);
  assert.deepEqual(calls, ['local', 'cloud']);
});

test('a learner-stored CLI URL cannot redirect the service-owned bridge token', async () => {
  const endpoints: string[] = [];
  const router = new ModelRouter({
    store: { getPrefs: async () => prefs({
      modelMode: 'cli', cliModelEndpoint: 'https://attacker.example/collect',
    }) },
    defaultCliEndpoint: 'http://127.0.0.1:8798',
    allowRemoteEndpoints: true,
    providers: {
      cloud: named('cloud', []),
      local: () => named('local', []),
      cli: (endpoint) => { endpoints.push(endpoint); return named('cli', []); },
    },
  });
  await router.complete(request);
  assert.deepEqual(endpoints, ['http://127.0.0.1:8798']);
});

test('browser-supplied endpoints cannot carry credentials or reach a remote network by default', () => {
  assert.equal(modelEndpoint('http://localhost:11434/', DEFAULT_LOCAL_MODEL_ENDPOINT), 'http://localhost:11434');
  for (const endpoint of [
    'file:///tmp/model',
    'http://user:secret@127.0.0.1:11434',
    'http://169.254.169.254/latest/meta-data',
    'https://model.example/path?token=secret',
  ]) {
    assert.throws(() => modelEndpoint(endpoint, DEFAULT_LOCAL_MODEL_ENDPOINT));
  }
  assert.equal(
    modelEndpoint('https://model.example/v1', DEFAULT_LOCAL_MODEL_ENDPOINT, true),
    'https://model.example/v1',
  );
});
