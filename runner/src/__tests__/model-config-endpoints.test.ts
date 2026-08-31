import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_CONTEXT_CHARS, MAX_CRITERIA, MAX_CRITERION, MAX_DRAFT_CHARS, MAX_WORK_CHARS,
  MIN_DRAFT_CHARS, MIN_WORK_CHARS,
} from '@sb/core';
import { startService } from './service-harness.js';
import { LocalCloudCredential } from '../model-credentials.js';

const CLI_TOKEN = 'model-config-test-token';
const SERVICE_SECRET = 'model-config-service-secret';

const probe = async () => {
  const server = createServer((req, res) => {
    if (req.url === '/api/tags' || (req.url === '/health' && req.headers.authorization === `Bearer ${CLI_TOKEN}`)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.url === '/v1/capabilities' && req.headers.authorization === `Bearer ${CLI_TOKEN}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        protocol: 'virgil-agent-endpoint', version: 1,
        operations: { complete: { method: 'POST', path: '/v1/complete' } },
      }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { endpoint, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
};

test('model config defaults to the Cloud recommended map and returns a redacted receipt', async (t) => {
  const p = await probe();
  const h = await startService('model-config-default', {}, {
    models: { cloudReady: false, localEndpoint: p.endpoint, cliEndpoint: p.endpoint, cliToken: CLI_TOKEN },
  });
  t.after(async () => { await h.close(); await p.close(); });

  const result = await h.call('GET', '/model-config');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.routes, { quick: 'cloud', deep: 'cloud', images: 'cloud' });
  assert.deepEqual(Object.fromEntries(Object.entries(result.body.providers).map(([mode, value]: [string, any]) =>
    [mode, value.enabled])), { cloud: true, local: false, cli: false });
  assert.deepEqual(Object.keys(result.body.providers), ['cloud', 'local', 'cli']);
  assert.deepEqual(Object.values(result.body.providers).map((provider: any) => provider.readiness),
    ['needs-setup', 'ready', 'ready']);
  // The receipt now carries a token BUDGET per connection, which is a public
  // number and reads to a blanket /token/i scan exactly like a credential. So
  // the size fields are lifted out by name and the credential scan runs on what
  // is left, rather than the scan being weakened to let them through.
  const withoutBudgets = JSON.stringify(result.body).replace(/"maxInputTokens":(?:\d+|null)/g, '');
  assert.doesNotMatch(withoutBudgets, /api.?key|secret|token/i);
  assert.doesNotMatch(JSON.stringify(result.body), new RegExp(`${CLI_TOKEN}|${SERVICE_SECRET}`),
    'and the two real credentials this service was started with are in none of it');
});

test('the receipt says what a paste may be and what the deep route could read', async (t) => {
  // The Check screen has to warn a learner BEFORE they press the button, and it
  // needs two different numbers to do it: the product's own caps, which apply on
  // every connection, and the window of whatever model the deep route is pointed
  // at. Both arrive on the request the panel already makes.
  const p = await probe();
  const h = await startService('model-config-limits', {}, {
    models: { cloudReady: true, localEndpoint: p.endpoint, cliEndpoint: p.endpoint, cliToken: CLI_TOKEN },
  });
  t.after(async () => { await h.close(); await p.close(); });

  const result = await h.call('GET', '/model-config');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.limits, {
    markWorkChars: MAX_WORK_CHARS,
    reviewDraftChars: MAX_DRAFT_CHARS,
    markWorkMinChars: MIN_WORK_CHARS,
    reviewDraftMinChars: MIN_DRAFT_CHARS,
    contextChars: MAX_CONTEXT_CHARS,
    rubricCriteria: MAX_CRITERIA,
    rubricCriterionChars: MAX_CRITERION,
  }, 'the caps are the ones core enforces, not a second copy of the numbers');

  // Sanity on the values themselves, so a limit that silently became zero or a
  // string is caught here rather than as a panel that warns about everything.
  for (const [field, value] of Object.entries(result.body.limits as Record<string, unknown>)) {
    assert.equal(typeof value, 'number', field);
    assert.ok((value as number) > 0, field);
  }

  assert.deepEqual(result.body.providers.cloud.models.deep,
    { modelId: 'gemini-3.7-flash', maxInputTokens: 1_048_576 },
    'the cloud deep route names the pinned id and the window it is documented to have');
  assert.equal(result.body.providers.local.models.deep.modelId, 'qwen3.8:27b-mlx');
  assert.equal(result.body.providers.local.models.deep.maxInputTokens, null,
    'a local model is whatever the operator pulled, and inventing a window would be worse than saying nothing');
  assert.deepEqual(result.body.providers.cli.models.deep, { modelId: null, maxInputTokens: null },
    'the bridge fronts whatever it was started with');
});

test('the receipt names the Cloud model pinned by the deployment composition root', async (t) => {
  const p = await probe();
  const h = await startService('model-config-pinned-cloud-model', {}, {
    models: {
      cloudReady: true,
      cloudDeepModelId: 'gemini-3.6-flash',
      localEndpoint: p.endpoint,
    },
  });
  t.after(async () => { await h.close(); await p.close(); });

  const result = await h.call('GET', '/model-config');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.providers.cloud.models.deep,
    { modelId: 'gemini-3.6-flash', maxInputTokens: 1_048_576 });
});

test('multiple providers can be enabled and each workload has one explicit route', async (t) => {
  const p = await probe();
  const h = await startService('model-config-map', {}, {
    models: { cloudReady: true, localEndpoint: p.endpoint, cliEndpoint: p.endpoint, cliToken: CLI_TOKEN },
  });
  t.after(async () => { await h.close(); await p.close(); });

  const saved = await h.call('PUT', '/model-config', {
    providers: {
      cloud: { enabled: true },
      local: { enabled: true, endpoint: p.endpoint },
      cli: { enabled: true, endpoint: p.endpoint },
    },
    routes: { quick: 'local', deep: 'cli', images: 'cloud' },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.routes, { quick: 'local', deep: 'cli', images: 'cloud' });
  const prefs = await h.store.getPrefs();
  assert.deepEqual(prefs.modelProviders, { cloud: true, local: true, cli: true });
  assert.deepEqual(prefs.modelRoutes, { quick: 'local', deep: 'cli', images: 'cloud' });
  assert.equal(prefs.localModelEndpoint, p.endpoint);
  assert.equal(prefs.cliModelEndpoint, undefined, 'the operator-owned CLI destination was persisted by the browser');
});

test('recommended settings atomically restore Cloud/API without deleting saved endpoints', async (t) => {
  const p = await probe();
  const h = await startService('model-config-recommended', {}, {
    models: { cloudReady: true, localEndpoint: p.endpoint, cliEndpoint: p.endpoint, cliToken: CLI_TOKEN },
  });
  t.after(async () => { await h.close(); await p.close(); });

  await h.call('PUT', '/model-config', {
    providers: { cloud: { enabled: true }, local: { enabled: true, endpoint: p.endpoint }, cli: { enabled: false } },
    routes: { quick: 'local', deep: 'cloud', images: 'cloud' },
  });
  const result = await h.call('PUT', '/model-config', { preset: 'recommended' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.routes, { quick: 'cloud', deep: 'cloud', images: 'cloud' });
  assert.equal(result.body.providers.cloud.enabled, true);
  assert.equal(result.body.providers.local.enabled, false);
  assert.equal(result.body.providers.cli.enabled, false);
  assert.equal((await h.store.getPrefs()).localModelEndpoint, p.endpoint);
});

test('recommended settings cannot replace a working map before Cloud is configured', async (t) => {
  const p = await probe();
  const h = await startService('model-config-recommended-needs-key', {}, {
    models: { cloudReady: false, localEndpoint: p.endpoint },
  });
  t.after(async () => { await h.close(); await p.close(); });

  const working = await h.call('PUT', '/model-config', {
    providers: {
      cloud: { enabled: false },
      local: { enabled: true, endpoint: p.endpoint },
      cli: { enabled: false },
    },
    routes: { quick: 'local', deep: 'local', images: 'local' },
  });
  assert.equal(working.status, 200);
  const before = await h.store.getPrefs();

  const refused = await h.call('PUT', '/model-config', { preset: 'recommended' });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, {
    error: 'Save a Cloud/API credential before using the recommended settings.',
    stoppedBy: 'model-credential', connection: 'cloud', fixAt: 'settings/models',
  });
  assert.deepEqual(await h.store.getPrefs(), before, 'the working Local map changed despite the refusal');
});

test('model config refuses disabled routes, SSRF endpoints and hosted local connections', async (t) => {
  const h = await startService('model-config-refuse', {}, { models: {} });
  const hosted = await startService('model-config-hosted', {}, { models: { hosted: true } });
  t.after(async () => { await h.close(); await hosted.close(); });

  const disabled = await h.call('PUT', '/model-config', {
    providers: { cloud: { enabled: true }, local: { enabled: false }, cli: { enabled: false } },
    routes: { quick: 'local', deep: 'cloud', images: 'cloud' },
  });
  assert.equal(disabled.status, 400);

  for (const endpoint of [
    'http://169.254.169.254/latest/meta-data',
    'file:///tmp/model',
    'http://user:secret@127.0.0.1:8798',
  ]) {
    const response = await h.call('PUT', '/model-config', {
      providers: { cloud: { enabled: true }, local: { enabled: true, endpoint }, cli: { enabled: false } },
      routes: { quick: 'local', deep: 'cloud', images: 'cloud' },
    });
    assert.equal(response.status, 400, endpoint);
  }
  const remoteCli = await h.call('PUT', '/model-config', {
    providers: { cloud: { enabled: true }, local: { enabled: false }, cli: { enabled: true, endpoint: 'https://attacker.example/collect' } },
    routes: { quick: 'cli', deep: 'cloud', images: 'cloud' },
  });
  assert.equal(remoteCli.status, 400);
  const hostedLocal = await hosted.call('PUT', '/model-config', {
    providers: { cloud: { enabled: true }, local: { enabled: true }, cli: { enabled: false } },
    routes: { quick: 'local', deep: 'cloud', images: 'cloud' },
  });
  assert.equal(hostedLocal.status, 400);
});

test('authenticated self-hosted Cloud setup saves, redacts, checks and clears a dynamic credential', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'virgil-model-config-key-'));
  const credential = await LocalCloudCredential.open({ dbPath: join(root, 'board.json'), editable: true });
  const checked: string[] = [];
  const h = await startService('model-config-cloud-key', {}, {
    secret: SERVICE_SECRET,
    models: {
      cloudCredential: credential,
      checkCloud: async () => { checked.push(credential.value()); return { models: ['gemini-test'] }; },
    },
  });
  t.after(() => h.close());
  const auth = { 'x-virgil-secret': SERVICE_SECRET };

  const routed = await h.call('PUT', '/model-config', {
    providers: {
      cloud: { enabled: true },
      local: { enabled: true, endpoint: 'http://127.0.0.1:11434' },
      cli: { enabled: false, endpoint: 'http://127.0.0.1:8798' },
    },
    routes: { quick: 'local', deep: 'cloud', images: 'cloud' },
  }, auth);
  assert.equal(routed.status, 200);

  assert.equal((await h.call('PUT', '/model-connections/cloud/credential', { apiKey: 'learner-key' })).status, 401);
  const saved = await h.call('PUT', '/model-connections/cloud/credential', { apiKey: 'learner-key' }, auth);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.providers.cloud.setup, {
    editable: true, managed: false, credential: 'configured', check: 'available',
  });
  assert.doesNotMatch(JSON.stringify(saved.body), /learner-key/);
  assert.doesNotMatch(JSON.stringify(await h.store.getPrefs()), /learner-key/);

  const check = await h.call('POST', '/model-connections/cloud/check', undefined, auth);
  assert.deepEqual(check.body, {
    provider: 'cloud', ok: true, status: 'ready',
    detail: 'Google accepted the credential and listed 1 model(s); no generation call was made.',
  });
  assert.deepEqual(checked, ['learner-key']);

  const prefsBeforeClear = await h.store.getPrefs();
  const cleared = await h.call('DELETE', '/model-connections/cloud/credential', undefined, auth);
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.providers.cloud.readiness, 'needs-setup');
  assert.equal(cleared.body.providers.cloud.setup.credential, 'missing');
  assert.equal(cleared.body.providers.cloud.enabled, true);
  assert.deepEqual(cleared.body.routes, { quick: 'local', deep: 'cloud', images: 'cloud' });
  assert.deepEqual(await h.store.getPrefs(), prefsBeforeClear,
    'clearing credential custody changed the saved provider or routing map');
  assert.doesNotMatch(JSON.stringify(cleared.body), /learner-key/);
});

test('credential setup requires service authentication and refuses operator-managed keys', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'virgil-model-config-managed-'));
  const editable = await LocalCloudCredential.open({ dbPath: join(root, 'editable.json'), editable: true });
  const managed = await LocalCloudCredential.open({
    dbPath: join(root, 'managed.json'), managedKey: 'operator-key', editable: true,
  });
  const open = await startService('model-config-open-credential', {}, { models: { cloudCredential: editable } });
  const locked = await startService('model-config-managed-credential', {}, {
    secret: SERVICE_SECRET, models: { cloudCredential: managed },
  });
  t.after(async () => { await open.close(); await locked.close(); });

  assert.equal((await open.call('PUT', '/model-connections/cloud/credential', { apiKey: 'key' })).status, 403);
  const refused = await locked.call('PUT', '/model-connections/cloud/credential',
    { apiKey: 'learner-key' }, { 'x-virgil-secret': SERVICE_SECRET });
  assert.equal(refused.status, 403);
  const receipt = await locked.call('GET', '/model-config', undefined, { 'x-virgil-secret': SERVICE_SECRET });
  assert.deepEqual(receipt.body.providers.cloud.setup, {
    editable: false, managed: true, credential: 'configured', check: 'available',
  });
  assert.doesNotMatch(JSON.stringify(receipt.body), /operator-key/);
});

test('the loopback Settings page can configure and check its own model connections without an impossible sign-in', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'virgil-model-config-loopback-'));
  const credential = await LocalCloudCredential.open({
    dbPath: join(root, 'board.json'), editable: true,
  });
  const p = await probe();
  const checked: string[] = [];
  const h = await startService('model-config-loopback-setup', {}, {
    models: {
      setupTrustedLocal: true,
      cloudCredential: credential,
      checkCloud: async () => { checked.push(credential.value()); return { models: ['gemini-test'] }; },
      localEndpoint: p.endpoint,
    },
  });
  t.after(async () => { await h.close(); await p.close(); });

  const before = await h.call('GET', '/model-config');
  assert.equal(before.body.providers.cloud.setup.editable, true,
    'the no-sign-in loopback page hid the only credential setup it can use');
  assert.equal((await h.call('PUT', '/model-connections/cloud/credential', {
    apiKey: 'loopback-learner-key',
  })).status, 200);
  assert.equal((await h.call('POST', '/model-connections/cloud/check')).status, 200);
  assert.deepEqual(checked, ['loopback-learner-key']);
  const local = await h.call('POST', '/model-connections/local/check');
  assert.equal(local.status, 200);
  assert.equal(local.body.ok, true);
});

test('explicit Local and Agent CLI checks validate reachability and the authenticated capabilities contract', async (t) => {
  const p = await probe();
  const h = await startService('model-config-checks', {}, {
    secret: SERVICE_SECRET,
    models: { localEndpoint: p.endpoint, cliEndpoint: p.endpoint, cliToken: CLI_TOKEN },
  });
  t.after(async () => { await h.close(); await p.close(); });
  const auth = { 'x-virgil-secret': SERVICE_SECRET };

  const local = await h.call('POST', '/model-connections/local/check', undefined, auth);
  assert.equal(local.status, 200);
  assert.deepEqual(local.body, {
    provider: 'local', ok: true, status: 'ready',
    detail: 'The Local endpoint answered; no model work was run.',
  });
  const cli = await h.call('POST', '/model-connections/cli/check', undefined, auth);
  assert.equal(cli.status, 200);
  assert.deepEqual(cli.body, {
    provider: 'cli', ok: true, status: 'ready',
    detail: 'The authenticated Agent CLI endpoint presented Virgil model-worker protocol v1; no model work was run.',
  });
});

test('connection checks reject a stored SSRF destination and a CLI endpoint with the wrong contract', async (t) => {
  const wrong = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url === '/v1/capabilities' ? '{"protocol":"not-virgil","version":1}' : '{"ok":true}');
  });
  await new Promise<void>((resolve) => wrong.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(wrong.address() as AddressInfo).port}`;
  const h = await startService('model-config-bad-checks', {}, {
    secret: SERVICE_SECRET, models: { cliEndpoint: endpoint, cliToken: CLI_TOKEN },
  });
  t.after(async () => {
    await h.close();
    await new Promise<void>((resolve) => wrong.close(() => resolve()));
  });
  await h.store.putPrefs({ ...(await h.store.getPrefs()), localModelEndpoint: 'http://169.254.169.254' });
  const auth = { 'x-virgil-secret': SERVICE_SECRET };

  const local = await h.call('POST', '/model-connections/local/check', undefined, auth);
  assert.equal(local.body.status, 'refused');
  const cli = await h.call('POST', '/model-connections/cli/check', undefined, auth);
  assert.deepEqual(cli.body, {
    provider: 'cli', ok: false, status: 'invalid-contract',
    detail: 'The Agent CLI endpoint answered but did not present Virgil model-worker protocol v1.',
  });
});
