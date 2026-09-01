import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Deps } from '@sb/core';
import { startService } from '../service.js';
import { outcomeOf } from '../runtime.js';
import {
  classify, isTerminalForSeam, emptyModelSpend, MODEL_BUDGET_UNIT, MODEL_BUDGET_WINDOW,
} from '@sb/core';
import { JsonStore } from '@sb/adapters';
import { NOW, StubLlm, brokenLlm } from './service-harness.js';

/**
 * The service, started the way a container starts it.
 *
 * `createApp` has been reachable from a test since the endpoint suite was
 * written; **`main()` never has been**, and `main()` is the half Cloud Run
 * actually runs. Everything that made the shipped process wrong for the
 * platform lived there and nowhere else — the loopback bind, the port variable
 * the platform does not set, the boot model call, the absence of any answer to
 * SIGTERM. A file nothing could start is a file nothing could check.
 *
 * So `startService` is the entry point with the process pulled out of it: same
 * wiring, same env, same log lines, but it returns a handle instead of running
 * for ever. `main()` is now three lines on top of it.
 *
 * Every test here binds port 0 — the ephemeral port the OS picks — so this
 * suite never collides with the local service on 8791, with a sibling lane's
 * emulator, or with itself under a parallel runner.
 */

const EPHEMERAL = { SB_PORT: '0', SB_STORE: 'memory' } as const;

/**
 * The secret this exposed single-board fixture must have — the exposed-service authentication boundary.
 *
 * `sharedSecret` refuses to start a service that binds anything but loopback
 * without one or verified identity, so every unauthenticated test below that
 * puts the process in Cloud Run carries it. The refusal itself, and what this
 * door does to a request, are `shared-secret.test.ts`.
 */
const SECRET = 'a-secret-long-enough-to-be-one';
const IN_CLOUD_RUN = { ...EPHEMERAL, K_SERVICE: 'virgil-service', SB_SHARED_SECRET: SECRET } as const;
const knock = { 'x-virgil-secret': SECRET } as const;

/** Deps the service can be started with that reach no network at all. */
const offline = (): Partial<Deps> => ({ llm: new StubLlm() });

test('a service in Cloud Run binds every interface and answers from outside the loopback', async () => {
  // The bind address is the single defect that would have made a deployed
  // container fail with nothing in the log naming it.
  const svc = await startService(IN_CLOUD_RUN, offline());
  try {
    assert.equal(svc.host, '0.0.0.0');
    const res = await fetch(`http://127.0.0.1:${svc.port}/health`, { headers: knock });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true, pins: 0,
      compatibility: {
        protocol: 'virgil-browser-service', serviceSchema: 1,
        minClientSchema: 1, maxClientSchema: 1, modelConfigSchema: 1,
      },
    });
  } finally {
    await svc.close();
  }
});

test('a service outside Cloud Run stays on loopback', async () => {
  const svc = await startService(EPHEMERAL, offline());
  try {
    assert.equal(svc.host, '127.0.0.1');
  } finally {
    await svc.close();
  }
});

test('the platform port wins over the local one, because Cloud Run sets PORT and never SB_PORT', async () => {
  // https://docs.cloud.google.com/run/docs/container-contract — "requests are
  // sent to 8080, but you can configure Cloud Run to send requests to the port
  // of your choice", injected as PORT. SB_PORT is this repository's variable and
  // the platform has never heard of it, so an image that only reads SB_PORT
  // listens on the wrong port and fails its startup probe.
  const svc = await startService({ SB_PORT: '8791', PORT: '0', SB_STORE: 'memory' }, offline());
  try {
    assert.notEqual(svc.port, 8791, 'PORT was set, so SB_PORT is not what got bound');
    assert.ok(svc.port > 0);
  } finally {
    await svc.close();
  }
});

test('the boot warm-up does not run in Cloud Run, so a cold start buys no model call', async () => {
  const llm = new StubLlm();
  const svc = await startService(IN_CLOUD_RUN, { llm });
  try {
    assert.equal(svc.warmedUp, false);
    assert.equal(llm.calls.length, 0, 'nothing was asked of the model between boot and the first request');
  } finally {
    await svc.close();
  }
});

test('the boot warm-up still runs for Local on a laptop, where it was measured', async () => {
  const llm = new StubLlm();
  const svc = await startService({ ...EPHEMERAL, SB_LLM: 'local' }, { llm });
  try {
    assert.equal(svc.warmedUp, true);
    assert.equal(llm.calls.length, 1);
  } finally {
    await svc.close();
  }
});

/**
 * THE ONE MODEL CALL THAT NOBODY WAS COUNTING.
 *
 * The warm-up reached for `deps.llm` — the raw model — while the budget gate
 * and the usage meter are both built inside `createApp`. So the single call
 * this service makes with no request in front of it was the single call no
 * limit could refuse and no report could show: on a laptop a rounding error, in
 * Cloud Run with `SB_WARMUP=1` a call on every cold start, against a free tier
 * of twenty a day, by an instance that may then serve nobody. A learner who set
 * a limit precisely so that nothing would be spent without their say-so had it
 * spent at boot, and `GET /usage` said it had not happened.
 *
 * Both halves are asserted here rather than one: a gate with no meter behind it
 * cannot be checked by the person paying, and a meter with no gate is a receipt
 * for something they could not stop.
 */
test('a boot warm-up is refused by a spent budget, like every other call', async () => {
  // `SB_WARMUP=1` and a cloud default, because the limit guards the paid
  // connection and only the paid connection — that is the whole of what a
  // budget is for, and a local warm-up is correctly none of its business.
  const llm = new StubLlm();
  const store = new JsonStore(join(mkdtempSync(join(tmpdir(), 'virgil-warmup-budget-')), 'db.json'));
  await store.putPrefs({
    ...(await store.getPrefs()),
    modelBudget: { limit: 1_000, unit: MODEL_BUDGET_UNIT, window: MODEL_BUDGET_WINDOW, setAt: NOW },
    modelSpend: {
      since: NOW,
      connections: {
        ...emptyModelSpend().connections,
        cloud: { calls: 1, inputTokens: 1_000, outputTokens: 0, issuedNotReturned: 0 },
      },
    },
  });

  const svc = await startService({ ...EPHEMERAL, SB_WARMUP: '1' }, { llm, store });
  try {
    assert.equal(llm.calls.length, 0, 'the spent budget stopped the warm-up before anything was sent');
    assert.equal(svc.warmedUp, false);
    // Cold is not broken. A warm-up is an optimisation, and a refusal must not
    // become a service that will not start.
    assert.equal((await fetch(`http://127.0.0.1:${svc.port}/health`)).status, 200);
  } finally {
    await svc.close();
  }
});

test('SB-250: a warm-up is visible without becoming something the learner pressed', async () => {
  // The warm-up prepares the first pin, but nobody pressed it. Its total must
  // remain visible without manufacturing a learner action in the attribution.
  const llm: Deps['llm'] = {
    complete: async () => ({ value: 'ok', modelId: 'stub', inputTokens: 7, outputTokens: 1 }),
    structured: async () => { throw new Error('a warm-up is a completion, never a structured call'); },
  };
  const svc = await startService({ ...EPHEMERAL, SB_LLM: 'local' }, { llm });
  try {
    assert.equal(svc.warmedUp, true);
    const report = await (await fetch(`http://127.0.0.1:${svc.port}/usage`)).json() as any;
    assert.deepEqual(report.llm.totals, { calls: 1, inputTokens: 7, outputTokens: 1 },
      'the boot call is in the total the learner is shown');
    const [row] = report.llm.rows;
    assert.equal(row.stage, 'warmup', 'named for what it is, not attributed to a tap nobody made');
    assert.equal(row.lane, 'setup');
    assert.deepEqual(report.llm.byLane.taps, { calls: 0, inputTokens: 0, outputTokens: 0 });
    assert.deepEqual(report.llm.byLane.setup, { calls: 1, inputTokens: 7, outputTokens: 1 });
  } finally {
    await svc.close();
  }
});

test('a warm-up the model refuses does not stop the service coming up', async () => {
  // The local adapter talks to Ollama on 127.0.0.1:11434 and a container has no
  // Ollama. Boot must survive that; it is the normal case in a container, not
  // an error.
  const svc = await startService({ ...EPHEMERAL, SB_LLM: 'local' }, { llm: brokenLlm() });
  try {
    assert.equal(svc.warmedUp, false);
    const res = await fetch(`http://127.0.0.1:${svc.port}/health`);
    assert.equal(res.status, 200, 'the service serves even though the model is unreachable');
  } finally {
    await svc.close();
  }
});

test('SB_OLLAMA_HOST points the local adapter somewhere else, which is what lets a container be smoke-tested', async () => {
  // The adapter has always taken its host as a constructor option and the
  // composition roots have always left it at 127.0.0.1:11434 — which inside a
  // container is the container. Without a way to move it, the only model a
  // container image could reach was one that does not exist, and the Job's
  // success path could not be exercised without spending real tokens.
  //
  // Asserted by starting a server that answers Ollama's own NDJSON shape and
  // checking the boot warm-up arrived at it. No network leaves the machine and
  // no provider is involved.
  const hits: string[] = [];
  const stub = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.end(`${JSON.stringify({ message: { content: 'ok' }, eval_count: 1 })}\n`);
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const stubPort = (stub.address() as AddressInfo).port;

  try {
    const svc = await startService({
      ...EPHEMERAL, SB_LLM: 'local', SB_OLLAMA_HOST: `http://127.0.0.1:${stubPort}`,
    });
    try {
      assert.equal(svc.warmedUp, true, 'the warm-up reached a model, so the host was honoured');
      assert.deepEqual(hits, ['/api/chat']);
    } finally {
      await svc.close();
    }
  } finally {
    stub.close();
  }
});

test('SIGTERM drains the service rather than dropping the request in flight', async () => {
  const svc = await startService(EPHEMERAL, offline());
  const before = await fetch(`http://127.0.0.1:${svc.port}/health`);
  assert.equal(before.status, 200);

  assert.equal(await svc.close(), 'drained',
    'the listener closed and the keep-alive socket the fetch left behind was let go');

  await assert.rejects(fetch(`http://127.0.0.1:${svc.port}/health`),
    'the port is no longer served once the drain completes');
});

test('a store spec the build cannot open refuses to start rather than falling back to a disk', async () => {
  // The failure this prevents is silent: a typo deploying onto the container
  // filesystem, running one night, losing it with the instance, and reporting a
  // green execution.
  await assert.rejects(
    startService({ SB_PORT: '0', SB_STORE: 'firestor:demo' }, offline()),
    /SB_STORE=firestor:demo names no store/);
});

test('firestore is asked for by name and the service now builds it, without connecting', async () => {
  /**
   * **This test used to assert the service REFUSED a firestore spec** — "this
   * build has no Firestore store", the orchestration dependency boundary's placeholder — and that refusal
   * was the whole reason the store lane's authorisation gate had never been
   * reached by a deployed process.
   *
   * What it asserts now is the pair of facts that matter together: the service
   * builds the real adapter, and **binds without opening a client**. There is no
   * emulator on 127.0.0.1:8080 in this suite; if the store connected at startup
   * this would hang and then fail, which is exactly the property that lets a
   * revision come up before a database answers. `FirestoreStore` connects on
   * first access, on purpose, and `firestoreWiring` is what asks the dangerous
   * question early instead.
   */
  const svc = await startService({
    SB_PORT: '0', SB_STORE: 'firestore:demo-learner', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
  }, offline());
  assert.ok(svc.port > 0, 'the service did not bind a port');
  assert.equal(await svc.close(), 'drained');
});

test('a service pointed at a real project it may not open refuses to bind, rather than to answer', async () => {
  // The defect this closes for the ingress half. `FirestoreStore` connects on
  // first access, so without this the instance binds its port, passes the
  // startup probe, is reported healthy, and then fails every learner request
  // with `production-not-authorised` — an outage shaped like an incident rather
  // than like the unset variable it is.
  await assert.rejects(
    startService({ SB_PORT: '0', SB_STORE: 'firestore:virgil-prod/demo-learner' }, offline()),
    /VIRGIL_ALLOW_PRODUCTION/);
});

test('the authorisation gate is now the only thing standing in front of a real board', async () => {
  /**
   * The ordering fix, arrived at its destination. While the adapter was absent
   * from the barrel, the adapter-missing branch answered every firestore spec
   * and hid the gate completely; the ordering was written so that the day the
   * barrel exported it, the gate would already be in front. That day is this
   * commit, and the branch behind it is gone — so this asserts both that the
   * gate refuses and that nothing else could have.
   */
  await assert.rejects(
    startService({ SB_PORT: '0', SB_STORE: 'firestore:virgil-prod/demo-learner' }, offline()),
    (err: unknown) => {
      assert.doesNotMatch(String(err), /has no Firestore/i,
        'an adapter-missing branch answered, which means the production store is still unreachable');
      assert.match(String(err), /VIRGIL_ALLOW_PRODUCTION/);
      return true;
    });
});

// --- the night, as the platform reads it ------------------------------------

test('a composed session with sections is a session', () => {
  assert.deepEqual(
    outcomeOf({ session: { outcome: 'composed', sections: [{}] } }),
    { kind: 'session' });
});

test('a composed session the verifier emptied is not a session', () => {
  // `outcome === 'composed'` alone is not enough and the CLI already knew it:
  // a night whose every section was withheld composed something and shipped
  // nothing. The three-state batch-result contract's distinction, read at the exit code.
  assert.deepEqual(
    outcomeOf({ session: { outcome: 'composed', sections: [] } }),
    { kind: 'no-session', reason: 'model-failed' });
});

test('nothing to teach is named as itself, because it is the honest empty night', () => {
  assert.deepEqual(
    outcomeOf({ session: { outcome: 'nothing-to-teach', sections: [] } }),
    { kind: 'no-session', reason: 'nothing-to-teach' });
});

test('a model that addressed nothing is the third state, not the second', () => {
  assert.deepEqual(
    outcomeOf({ session: { outcome: 'model-failed', sections: [] } }),
    { kind: 'no-session', reason: 'model-failed' });
});

test('a night that persisted no session at all is still a processed night', () => {
  assert.deepEqual(outcomeOf({ session: null }), { kind: 'no-session', reason: 'model-failed' });
});

test('a checked draft built from superseded learner context is not a session', () => {
  assert.deepEqual(
    outcomeOf({
      session: null,
      learnerContextChanged: true,
    }),
    { kind: 'no-session', reason: 'learner-context-changed' },
  );
});

// ------------------------------------- the daily cap, reachable at last (audit)

test('a night that spent the account is quota-degraded, not an empty night', () => {
  /**
   * Found in the 2026-08-22 audit. `BatchOutcome` has carried `quota-degraded`
   * since it was written and **nothing could produce it**: the classifier that
   * decodes `exhaustedForPeriod` lived in the ADK layer, which the plain
   * pipeline is forbidden to import, so `runBatch` could not report that a
   * daily cap had been met. `runtime.ts` said so in its own comment.
   *
   * The free-tier day cap is twenty requests and a nightly is seven model
   * calls, so this is not a corner. It is the shape that ended the deep
   * benchmark twice.
   */
  assert.deepEqual(
    outcomeOf({ session: null, quotaExhausted: true }),
    { kind: 'quota-degraded' });
});

test('the cap outranks whatever the run managed to compose before it hit', () => {
  // A night may compose from the stages that ran before the account ran out.
  // Reporting that as an ordinary session hides that the rest was never
  // attempted, and the repairs are opposite: one waits for tomorrow, the other
  // looks at the board.
  assert.deepEqual(
    outcomeOf({ session: { outcome: 'composed', sections: [{}] }, quotaExhausted: true }),
    { kind: 'quota-degraded' });
});

test('a run that did not hit the cap is read exactly as it was before', () => {
  assert.deepEqual(
    outcomeOf({ session: { outcome: 'composed', sections: [{}] }, quotaExhausted: false }),
    { kind: 'session' });
  assert.deepEqual(
    outcomeOf({ session: { outcome: 'composed', sections: [{}] } }),
    { kind: 'session' }, 'a caller that does not know about the flag still works');
});

test('a stage that fails on a spent quota says which failure it was', async () => {
  // The classifier reads the properties the seam promises rather than a class,
  // so a second provider throwing the same two facts degrades the same way.
  const spent = Object.assign(new Error('429'), {
    exhaustedForPeriod: true, retryable: true, quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
  });
  const directive = classify(spent);
  assert.equal(directive.kind, 'degrade');
  assert.equal(directive.kind === 'degrade' && directive.reason, 'exhausted');
  assert.equal(isTerminalForSeam(directive), true, 'later seam stages are not attempted, not degraded');
});
