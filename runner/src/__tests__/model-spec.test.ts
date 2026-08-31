import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXIT_CONFIG, LlmSpecError, llmChoice } from '../runtime.js';
import type { Deps } from '@sb/core';
import { startService } from '../service.js';
import { StubLlm } from './service-harness.js';

/**
 * Which model answers, named rather than assumed.
 *
 * Both composition roots constructed `OllamaLlm` unconditionally, and
 * `job.yaml` injects `GEMINI_API_KEY` into a container where nothing read it —
 * so a deployed night would have tried to reach Ollama at `127.0.0.1:11434`,
 * which inside the container is the container, and failed at the first model
 * call. RUNBOOK §2.4a: *"Do not discover this from the first night's logs."*
 *
 * The grammar is `SB_STORE`'s, down to the slash:
 *
 *   SB_LLM=cloud                        Google Gemini, also the product default
 *   SB_LLM=local                        the local Ollama-compatible service
 *   SB_LLM=cli                          the operator-started CLI bridge
 *   SB_LLM=gemini                       the adapter's own shipped tier map
 *   SB_LLM=gemini:<fast>/<deep>         an exact pair, pinned in the YAML
 *   SB_LLM=vertex                       Vertex AI with the shipped tier map
 *   SB_LLM=vertex:<fast>/<deep>         an exact Vertex pair
 *
 * Cloud is the product default, but startup must not spend a provider call
 * unless warm-up was explicitly requested. An unrecognised spec stops the process, and
 * `seam-purity.test.ts` still holds that nothing outside the two composition
 * roots may name the adapter at all.
 *
 * Nothing here makes a model call.
 */

test('Cloud is the product default; Local and CLI remain explicit operator choices', () => {
  assert.deepEqual(llmChoice(undefined), { kind: 'gemini' });
  assert.deepEqual(llmChoice(''), { kind: 'gemini' });
  assert.deepEqual(llmChoice('  '), { kind: 'gemini' });
  assert.deepEqual(llmChoice('cloud'), { kind: 'gemini' });
  assert.deepEqual(llmChoice('ollama'), { kind: 'ollama' });
  assert.deepEqual(llmChoice('local'), { kind: 'ollama' });
  assert.deepEqual(llmChoice('cli'), { kind: 'cli' });
});

test('gemini is asked for by name, and its tier map can be left to the adapter', () => {
  // The adapter's `GEMINI_TIERS` is live-verified and pinned, and it is the
  // right default for anyone who has not measured something else. Naming the
  // scheme alone is how a deployment says "the shipped pair".
  assert.deepEqual(llmChoice('gemini'), { kind: 'gemini' });
  assert.deepEqual(llmChoice('  gemini  '), { kind: 'gemini' });
});

test('a tier map in the spec is exact, and both halves of it are named', () => {
  assert.deepEqual(llmChoice('gemini:gemini-3.5-flash-lite/gemini-3.7-flash'),
    { kind: 'gemini', tiers: { fast: 'gemini-3.5-flash-lite', deep: 'gemini-3.7-flash' } });
  assert.deepEqual(llmChoice('vertex:gemini-2.5-flash-lite/gemini-2.5-flash'),
    { kind: 'vertex', tiers: { fast: 'gemini-2.5-flash-lite', deep: 'gemini-2.5-flash' } });
});

test('half a tier map is refused rather than half-applied', () => {
  // `firestore:<board>` means something on its own; `gemini:<one model>` does
  // not — a spec that named one model would leave the other tier on a default
  // the deployment did not choose, which is the cost ledger measuring one model
  // and the run using two.
  for (const bad of [
    'gemini:', 'gemini:only-one', 'gemini:/deep', 'gemini:fast/', 'gemini:a/b/c',
    'vertex:', 'vertex:only-one', 'vertex:/deep', 'vertex:fast/', 'vertex:a/b/c',
  ]) {
    assert.throws(() => llmChoice(bad), LlmSpecError, `SB_LLM=${bad} was accepted`);
  }
});

test('a provider this build cannot reach refuses, and never falls back to the other one', () => {
  // The failure that refuses is worth naming: a typo that fell back to the local
  // model would deploy happily and fail every night at the first model call,
  // with a log line about a connection to 127.0.0.1 and nothing about a
  // variable. The reverse — falling back to Gemini — would spend money nobody
  // authorised. Neither is a default.
  for (const bad of ['openai', 'Gemini', 'gemini-3.7-flash', 'true', '1']) {
    assert.throws(() => llmChoice(bad), LlmSpecError, `SB_LLM=${bad} was accepted`);
  }
  assert.throws(() => llmChoice('openai'), /Known: cloud, local, cli, gemini, vertex, ollama/);
});

// --- the roots, run for real --------------------------------------------------

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

test('a Job started with a spec it cannot read exits 2 before any night begins', () => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    SB_DB: join(mkdtempSync(join(tmpdir(), 'sb-llm-')), 'store.json'),
    SB_LLM: 'openai',
  };
  const run = spawnSync(process.execPath, [CLI, 'nightly'], { env, encoding: 'utf8', timeout: 60_000 });

  assert.equal(run.status, EXIT_CONFIG,
    'EXIT_INFRA here would ask Cloud Run to retry a condition no retry can change');
  assert.match(run.stderr, /SB_LLM=openai/);
  assert.doesNotMatch(run.stdout, /batch-outcome/, 'a night that reports an outcome is a night that ran');
});

/** Deps the service can be started with that reach no network at all. */
const offline = (): Partial<Deps> => ({ llm: new StubLlm() });

test('a service started with a spec it cannot read refuses to bind', async () => {
  await assert.rejects(
    startService({ SB_PORT: '0', SB_STORE: 'memory', SB_LLM: 'openai' }, offline()),
    /SB_LLM=openai/);
});

test('a service with no spec selects Cloud but makes no unasked warm-up call', async () => {
  /**
   * The anti-spend assertion, and it is a behaviour rather than a source scan.
   *
   * The boot warm-up spends one model call on a laptop — that is measured and
   * deliberate — so a service whose composition root had silently acquired
   * Gemini would reach `generativelanguage.googleapis.com` on startup, with a
   * real key in the environment, before serving anything. `fetch` is replaced
   * for the duration and every host it is handed is recorded.
   */
  const realFetch = globalThis.fetch;
  const hosts: string[] = [];
  globalThis.fetch = ((input: unknown) => {
    hosts.push(new URL(String(input)).host);
    throw new Error('no network in this test');
  }) as typeof fetch;
  try {
    const svc = await startService({ SB_PORT: '0', SB_STORE: 'memory' });
    await svc.close();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(hosts, [], 'Cloud default spent a provider call before the learner asked');
});

test('an explicitly requested Cloud warm-up never falls through to Local', async () => {
  let localCalls = 0;
  const local = createServer((_req, res) => { localCalls++; res.writeHead(500); res.end(); });
  await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
  const localEndpoint = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
  try {
    const svc = await startService({
      SB_PORT: '0', SB_STORE: 'memory', SB_WARMUP: '1', SB_LOCAL_ENDPOINT: localEndpoint,
    });
    await svc.close();
  } finally { await new Promise<void>((resolve) => local.close(() => resolve())); }
  assert.equal(localCalls, 0, 'Cloud warm-up silently fell through to the Local adapter');
});
