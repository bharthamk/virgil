import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXIT_CONFIG, EXIT_INFRA, EXIT_PROCESSED,
  EVERY_INTERFACE, LOOPBACK,
  SHARED_SECRET_HEADER, SHARED_SECRET_MIN_LENGTH, SharedSecretError,
  StoreSpecError,
  bindHost, exitCodeFor, gracefulClose, memoryFs,
  sharedSecret, storeChoice, warmupWanted,
} from '../runtime.js';

/**
 * The container contract, as functions.
 *
 * Everything Cloud Run requires of a container that this repository can decide
 * without a container — which port to listen on, which interface, what an exit
 * code means, which store an image was pointed at — is a pure function here and
 * is asserted here. That split is the whole reason a deploy can be prepared on
 * a machine with no GCP project: the parts that need Google are IAM, scheduling
 * and the network, and none of those are decisions this code makes.
 *
 * Sources for every constant asserted below are in `deploy/CLOUD_RUN.md` §2,
 * with the doc URL beside each one.
 */

// --- which interface to bind ------------------------------------------------

test('a service in Cloud Run binds every interface, because the platform requires it', () => {
  // https://docs.cloud.google.com/run/docs/container-contract — "The ingress
  // container within an instance must listen for requests on 0.0.0.0". A
  // service that binds loopback inside a Cloud Run instance answers nothing:
  // the request never reaches it, and the failure looks like a cold-start
  // timeout rather than a bind address.
  assert.equal(bindHost(undefined, 'virgil-service'), EVERY_INTERFACE);
});

test('a service outside Cloud Run stays on loopback, which is a safety property and not a default', () => {
  // The service has no authentication of any kind and `DELETE /everything` is
  // one of its routes. Binding every interface on a laptop puts the learner's
  // whole board on the local network. So the widening is conditional on being
  // in the one place that both requires it and puts an IAM boundary in front.
  assert.equal(bindHost(undefined, undefined), LOOPBACK);
});

test('an explicit host wins over both, so neither guess is a trap', () => {
  assert.equal(bindHost('0.0.0.0', undefined), EVERY_INTERFACE);
  assert.equal(bindHost('127.0.0.1', 'virgil-service'), LOOPBACK);
});

test('an explicit host that is only whitespace is not a host', () => {
  // `SB_HOST=` in a YAML env block is an empty string, not an absent variable,
  // and binding to '' is not the same as binding to the default.
  assert.equal(bindHost('', 'virgil-service'), EVERY_INTERFACE);
  assert.equal(bindHost('   ', undefined), LOOPBACK);
});

// --- who may knock on the door (the service-protection contract) ----------------------------------

const LONG = 'a-secret-long-enough-to-be-one';

test('a service on loopback needs no secret, so a laptop is unchanged byte for byte', () => {
  // The whole of the local-friction argument. Nothing in the README, the
  // scripts or a learner's own extension gains a variable, because on loopback
  // the reachable set is already one machine.
  assert.equal(sharedSecret(undefined, LOOPBACK), null);
});

test('a service that binds every interface must have one, or it does not start', () => {
  /**
   * The service-protection contract, and the reason it is keyed on the **bind** rather than on
   * `K_SERVICE`.
   *
   * `bindHost` widens for Cloud Run and also for anyone who sets `SB_HOST`, and
   * the second case is the same exposure with none of the platform's IAM in
   * front of it. Tying the requirement to the marker would have left a laptop
   * on `SB_HOST=0.0.0.0` serving `DELETE /everything` to the local network,
   * which is precisely what CLOUD_RUN.md S9 warns about.
   */
  assert.throws(() => sharedSecret(undefined, EVERY_INTERFACE), SharedSecretError);
  assert.throws(() => sharedSecret('   ', EVERY_INTERFACE), SharedSecretError);
});

test('verified learner identity replaces the operator secret on an exposed multi-user service', () => {
  assert.equal(sharedSecret(undefined, EVERY_INTERFACE, true), null);
  // An explicitly configured secret is still validated rather than ignored.
  assert.equal(sharedSecret(LONG, EVERY_INTERFACE, true), LONG);
  assert.throws(() => sharedSecret('short', EVERY_INTERFACE, true), SharedSecretError);
});

test('the refusal names the variable and the header, so it is a decision and not an obstacle', () => {
  assert.throws(() => sharedSecret(undefined, EVERY_INTERFACE), (err: unknown) => {
    const message = String(err);
    assert.match(message, /SB_SHARED_SECRET/);
    assert.match(message, new RegExp(SHARED_SECRET_HEADER));
    return true;
  });
});

test('a secret short enough to guess is not one', () => {
  // A floor rather than a shape: this is checked at startup, where the only
  // thing that can be known about a string is how much of it there is.
  assert.throws(() => sharedSecret('short', EVERY_INTERFACE), SharedSecretError);
  assert.equal('short'.length < SHARED_SECRET_MIN_LENGTH, true);
  assert.equal(sharedSecret(LONG, EVERY_INTERFACE), LONG);
});

test('a secret set on loopback is honoured, because closing a door nobody asked about is still closing it', () => {
  // The local rehearsal path: run the laptop service the way the deployment
  // runs, header and all, without deploying anything.
  assert.equal(sharedSecret(LONG, LOOPBACK), LONG);
  // And a short one is refused wherever it is set. A rehearsal that accepted a
  // secret production will not is a rehearsal of something else.
  assert.throws(() => sharedSecret('short', LOOPBACK), SharedSecretError);
});

test('the surrounding whitespace a YAML block adds is not part of the secret', () => {
  assert.equal(sharedSecret(`  ${LONG}\n`, EVERY_INTERFACE), LONG);
});

// --- which store an image was pointed at ------------------------------------

test('nothing set is the local json board, so the image runs unchanged on a laptop', () => {
  assert.deepEqual(storeChoice(undefined, '.data/store.json'), { kind: 'json', path: '.data/store.json' });
});

test('a bare path is a json board, because that is what SB_DB always meant', () => {
  assert.deepEqual(storeChoice('json:/tmp/board.json', '.data/store.json'),
    { kind: 'json', path: '/tmp/board.json' });
});

test('memory is a real choice, so a container can be smoke-tested with no disk and no database', () => {
  assert.deepEqual(storeChoice('memory', '.data/store.json'), { kind: 'memory' });
});

test('firestore carries the board id, which is the thing that names one learner', () => {
  // The Firestore lane maps `boards/{boardId}` onto what `new JsonStore(path)`
  // names. The spec carries that id so the same image serves either.
  assert.deepEqual(storeChoice('firestore:demo-learner', '.data/store.json'),
    { kind: 'firestore', boardId: 'demo-learner' });
});

test('a firestore spec may name the project, which is the difference between an emulator and a bill', () => {
  // The slash is the whole grammar addition. It exists because `boards/{id}`
  // says which board and nothing at all says which Google Cloud project, and
  // the adapter's default for that is `virgil-emulator` — a safe default and
  // not a real project. Authorisation without a named project is refused
  // elsewhere; being able to *say* it is this.
  assert.deepEqual(storeChoice('firestore:virgil-prod/demo-learner', '.data/store.json'),
    { kind: 'firestore', boardId: 'demo-learner', projectId: 'virgil-prod' });
  assert.throws(() => storeChoice('firestore:proj/a/b', '.data/store.json'), StoreSpecError,
    'a board id may contain a slash, so a two-slash spec is ambiguous rather than merely unusual');
});

test('an unknown store spec is refused by name rather than silently becoming the default', () => {
  // The failure this prevents: `SB_STORE=firestor:demo` deploying happily onto
  // a container filesystem, running one night, and losing it when the instance
  // goes away — with a green execution in the console to say it worked.
  assert.throws(() => storeChoice('postgres://nope', '.data/store.json'), StoreSpecError);
  assert.throws(() => storeChoice('firestore:', '.data/store.json'), StoreSpecError,
    'a firestore spec with no board id names no board');
  assert.throws(() => storeChoice('json:', '.data/store.json'), StoreSpecError);
});

test('the memory store is a real Store, and it forgets when the process does', async () => {
  const fs = memoryFs();
  await fs.mkdir('/x', { recursive: true });
  await fs.writeFile('/x/tmp', '{"pins":[]}', 'utf8');
  await fs.rename('/x/tmp', '/x/board.json');
  assert.equal(await fs.readFile('/x/board.json', 'utf8'), '{"pins":[]}');
  await assert.rejects(fs.readFile('/x/tmp', 'utf8'), /ENOENT/,
    'rename moves rather than copies, which is the durability shape JsonStore relies on');

  const missing = await fs.readFile('/nope', 'utf8').catch((e: NodeJS.ErrnoException) => e.code);
  assert.equal(missing, 'ENOENT',
    'a cold board must read as absent — JsonStore treats any other error as a store it must not overwrite');
});

// --- what an exit code means ------------------------------------------------

test('a composed session is a processed night', () => {
  assert.equal(exitCodeFor({ kind: 'session' }), EXIT_PROCESSED);
});

test('a night that honestly produced nothing is a processed night, not a failed one', () => {
  // the delivery-safety contract and withheld-content contract, and the same judgement the Pub/Sub lane's ack policy
  // reaches from the other side: failure to produce is not failure to process.
  // A Job that exited non-zero here would be retried by the platform, and the
  // retry would spend the fleet's model calls arriving at the same true answer.
  assert.equal(exitCodeFor({ kind: 'no-session', reason: 'nothing-to-teach' }), EXIT_PROCESSED);
  assert.equal(exitCodeFor({ kind: 'no-session', reason: 'model-failed' }), EXIT_PROCESSED);
  assert.equal(exitCodeFor({ kind: 'no-session', reason: 'learner-context-changed' }), EXIT_PROCESSED);
});

test('a quota-degraded night is processed, because retrying a spent daily cap is the storm the quota-retry policy forbids', () => {
  // the transport contract §9 the quota-retry policy: a daily cap degrades
  // and is terminal for the seam. A non-zero exit would hand that decision to
  // Cloud Run's retry, which knows nothing about quota.
  assert.equal(exitCodeFor({ kind: 'quota-degraded' }), EXIT_PROCESSED);
});

test('an infrastructure failure is the one thing a retry can fix, and is the only thing that reports failure', () => {
  // https://docs.cloud.google.com/run/docs/container-contract — "the container
  // must exit with exit code 0 when the job has successfully completed, and
  // exit with a non-zero exit code when the job has failed."
  assert.equal(exitCodeFor({ kind: 'infra-failure', detail: 'the store could not be read' }), EXIT_INFRA);
  assert.notEqual(EXIT_INFRA, EXIT_PROCESSED);
});

test('a container started with env that cannot describe a run says so with its own code', () => {
  assert.equal(exitCodeFor({ kind: 'config-failure', detail: 'SB_STORE=postgres://nope' }), EXIT_CONFIG);
  assert.notEqual(EXIT_CONFIG, EXIT_PROCESSED);
  assert.notEqual(EXIT_CONFIG, EXIT_INFRA);
});

test('every non-processed code is non-zero, because Cloud Run reads only that distinction', () => {
  // The two codes are for whoever reads the log. Cloud Run itself retries on
  // any non-zero, so the contract that matters is zero versus not.
  for (const outcome of [
    { kind: 'infra-failure', detail: 'x' },
    { kind: 'config-failure', detail: 'x' },
  ] as const) {
    assert.notEqual(exitCodeFor(outcome), 0);
  }
});

// --- the boot warm-up, which costs a model call ------------------------------

test('the boot warm-up is off in Cloud Run, because a cold start would buy a model call', () => {
  // The warm-up exists to move a 2135ms model load off the learner's first pin
  // on a laptop. In Cloud Run with min-instances 0 every cold start would spend
  // one call against a free tier of twenty a day, on a service that may then
  // serve no request at all.
  assert.equal(warmupWanted(undefined, 'virgil-service'), false);
});

test('the boot warm-up stays on locally, where it was measured and where it is free', () => {
  assert.equal(warmupWanted(undefined, undefined), true);
});

test('the warm-up can be forced on or off explicitly', () => {
  assert.equal(warmupWanted('1', 'virgil-service'), true);
  assert.equal(warmupWanted('0', undefined), false);
});

// --- shutting down on SIGTERM ------------------------------------------------

/** A server that records what was asked of it and closes when told. */
function fakeServer(): {
  server: Parameters<typeof gracefulClose>[0];
  finish: (err?: Error) => void;
  closed: () => number;
  idled: () => number;
} {
  let pending: ((err?: Error) => void) | null = null;
  let closes = 0;
  let idles = 0;
  return {
    server: {
      close(cb): void { closes++; pending = cb; },
      closeIdleConnections(): void { idles++; },
    },
    finish: (err) => pending?.(err),
    closed: () => closes,
    idled: () => idles,
  };
}

test('SIGTERM stops the server taking new connections and waits for the ones in flight', async () => {
  const f = fakeServer();
  const done = gracefulClose(f.server, 10_000);
  assert.equal(f.closed(), 1, 'the listener is closed first, so no new request arrives during the drain');
  assert.equal(f.idled(), 1, 'keep-alive sockets holding no request are let go rather than drained');
  f.finish();
  assert.equal(await done, 'drained');
});

test('a drain that outlives the grace period gives up rather than waiting for SIGKILL', async () => {
  // https://docs.cloud.google.com/run/docs/container-contract — a service gets
  // "a 10 second period before the actual shutdown occurs, at which point Cloud
  // Run sends a SIGKILL signal". Exiting a moment early is a clean shutdown in
  // the log; being killed is an instance that looks like it crashed.
  const f = fakeServer();
  assert.equal(await gracefulClose(f.server, 1), 'timed-out');
});

test('a close that errors is reported rather than hanging the shutdown', async () => {
  const f = fakeServer();
  const done = gracefulClose(f.server, 10_000);
  f.finish(new Error('not running'));
  assert.equal(await done, 'drained', 'a listener that was not open is still a listener that is now shut');
});
