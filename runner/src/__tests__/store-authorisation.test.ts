import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FirestoreStore } from '@sb/adapters';
import {
  EXIT_CONFIG, PRODUCTION_OPT_IN, PRODUCTION_OPT_IN_VALUE, StoreSpecError,
  firestoreWiring, storeChoice,
} from '../runtime.js';

/**
 * Whether a run may reach a real Google Cloud project, decided at startup.
 *
 * The adapter already refuses — `FirestoreStore` will not construct a client
 * with no `FIRESTORE_EMULATOR_HOST` unless `allowProduction: true` is passed —
 * and that refusal is right. What was wrong is *when* it arrives. The adapter
 * connects lazily, on first access, so a Job wired without the authorisation
 * clears startup, begins a night, and dies partway through it with
 * `production-not-authorised`: at 3am, under `EXIT_INFRA`, which tells the
 * platform to retry a condition no retry can change. Cloud Run then reproduces
 * it identically twice more and the board is left with a partial night.
 *
 * So the question is asked before any night work exists. Everything below holds
 * that: the decision is a pure function over the spec and two variables, and it
 * is settled in the same breath as the spec rather than at first read.
 *
 * The two halves fail for different reasons and both are asserted:
 *
 *  - **No opt-in.** A laptop with a stray `gcloud auth` must not be one export
 *    away from the real board.
 *  - **No project.** The subtler half. The adapter defaults `projectId` to
 *    `virgil-emulator`, so an authorised run that names no project opens a
 *    client against a name for nothing and fails on credentials — a message
 *    that would never have said which variable was missing.
 *
 * No network, no emulator, no SDK. The CLI assertions never get past startup,
 * which is the property they exist to prove.
 */

/** The env `firestoreWiring` reads, with both variables absent by default. */
const env = (over: Record<string, string | undefined> = {}) => ({
  FIRESTORE_EMULATOR_HOST: undefined,
  VIRGIL_ALLOW_PRODUCTION: undefined,
  ...over,
});

const EMULATOR = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' };
const AUTHORISED = { VIRGIL_ALLOW_PRODUCTION: PRODUCTION_OPT_IN_VALUE };

// --- the spec grammar that carries a project --------------------------------

test('a project-qualified spec names both halves, and the slash is the whole addition', () => {
  // The project is the difference between an emulator and a bill, and nothing
  // in `firestore:<boardId>` could ever have carried it.
  assert.deepEqual(storeChoice('firestore:virgil-prod/demo-learner', '.data/store.json'),
    { kind: 'firestore', boardId: 'demo-learner', projectId: 'virgil-prod' });
});

test('an unqualified spec is unchanged, so the emulator path costs no new configuration', () => {
  // Every existing invocation, every gated test and `deploy/smoke.sh`'s own
  // line pass a bare board id. A choice that gained a `projectId: undefined`
  // key would still deep-equal wrong here, which is the point of asserting it.
  assert.deepEqual(storeChoice('firestore:demo-learner', '.data/store.json'),
    { kind: 'firestore', boardId: 'demo-learner' });
});

test('a two-slash spec is ambiguous about which half is the project, and is refused rather than guessed', () => {
  // `docId()` escapes a `/`, so a board id may legitimately contain one and
  // there is no rule that recovers the split. Guessing puts a night on the
  // wrong board and reports success. Such a board cannot be named in a
  // project-qualified spec, and that is a stated limit rather than a silent one.
  assert.throws(() => storeChoice('firestore:proj/a/b', '.data/store.json'), StoreSpecError);
});

test('a slash with nothing on one side of it names no project and no board', () => {
  assert.throws(() => storeChoice('firestore:/demo-learner', '.data/store.json'), StoreSpecError);
  assert.throws(() => storeChoice('firestore:virgil-prod/', '.data/store.json'), StoreSpecError);
  assert.throws(() => storeChoice('firestore:  /demo-learner', '.data/store.json'), StoreSpecError);
});

test('the refusal for an unknown scheme lists the qualified form, so the grammar is discoverable', () => {
  assert.throws(() => storeChoice('postgres://nope', '.data/store.json'),
    /firestore:<projectId>\/<boardId>/);
});

// --- the emulator path, unconfigured ----------------------------------------

test('the emulator needs no opt-in, because it cannot route a client to a billed project', () => {
  // `FIRESTORE_EMULATOR_HOST` is Google's own emulator-selection variable and
  // its presence is the whole safety argument — the same one every gated test
  // in this tree already rests on.
  assert.deepEqual(
    firestoreWiring({ boardId: 'demo-learner' }, env(EMULATOR)),
    { boardId: 'demo-learner' });
});

test('an emulator run that names a project keeps it, and is still not a production run', () => {
  // `allowProduction` is absent rather than false: the flag authorises leaving
  // the emulator, and this run is not leaving it.
  assert.deepEqual(
    firestoreWiring({ boardId: 'demo-learner', projectId: 'virgil-prod' }, env(EMULATOR)),
    { boardId: 'demo-learner', projectId: 'virgil-prod' });
});

test('an emulator host that is only whitespace is not a host', () => {
  // `FIRESTORE_EMULATOR_HOST=` in a YAML env block is an empty string, not an
  // absent variable, and the SDK would not treat it as the emulator either.
  assert.throws(() => firestoreWiring({ boardId: 'b' }, env({ FIRESTORE_EMULATOR_HOST: '   ' })),
    StoreSpecError);
});

// --- the opt-in -------------------------------------------------------------

test('no opt-in refuses, and the message names the variable rather than the adapter', () => {
  // The fix for this failure is in a YAML file, so the log has to say which one
  // and which key. An adapter-shaped message sends the reader to this repository.
  assert.throws(
    () => firestoreWiring({ boardId: 'demo-learner', projectId: 'virgil-prod' }, env()),
    (err: unknown) => {
      assert.ok(err instanceof StoreSpecError);
      assert.match(err.message, /VIRGIL_ALLOW_PRODUCTION/);
      assert.match(err.message, /FIRESTORE_EMULATOR_HOST/);
      assert.match(err.message, /deploy\/job\.yaml/);
      return true;
    });
});

test('a variable that is set is not a decision', () => {
  // Deliberately the same shape as `deploy/config.sh`'s `VIRGIL_DEPLOY=yes`: an
  // exact word, not a truthiness test. The failure this guards is somebody
  // exporting something in a shell, and `=0` and `=false` are the two ways a
  // truthiness test would have read a refusal as consent.
  for (const value of ['0', 'false', 'maybe', '', '   ', 'YES', 'Yes', 'true', '1']) {
    assert.throws(
      () => firestoreWiring({ boardId: 'b', projectId: 'p' }, env({ VIRGIL_ALLOW_PRODUCTION: value })),
      StoreSpecError, `VIRGIL_ALLOW_PRODUCTION=${JSON.stringify(value)} is not the opt-in`);
  }
});

test('the opt-in survives the whitespace a YAML block adds around it', () => {
  assert.deepEqual(
    firestoreWiring({ boardId: 'b', projectId: 'p' }, env({ VIRGIL_ALLOW_PRODUCTION: ' yes ' })),
    { boardId: 'b', projectId: 'p', allowProduction: true });
});

test('the opt-in name and value are exported, so the estate and the runtime cannot drift apart', () => {
  assert.equal(PRODUCTION_OPT_IN, 'VIRGIL_ALLOW_PRODUCTION');
  assert.equal(PRODUCTION_OPT_IN_VALUE, 'yes');
});

// --- authorisation without a project ----------------------------------------

test('an authorised run that names no project is refused, because the default is a name for nothing', () => {
  // The half no error message would ever have reported. Authorised against the
  // adapter's `virgil-emulator` default, the SDK fails on credentials for a
  // project nobody owns — and the reader is sent to IAM rather than to `SB_STORE`.
  assert.throws(
    () => firestoreWiring({ boardId: 'demo-learner' }, env(AUTHORISED)),
    (err: unknown) => {
      assert.ok(err instanceof StoreSpecError);
      assert.match(err.message, /SB_STORE=firestore:<projectId>\/<boardId>/);
      return true;
    });
});

test('an authorised, project-qualified run is the only shape that reaches a real project', () => {
  assert.deepEqual(
    firestoreWiring({ boardId: 'demo-learner', projectId: 'virgil-prod' }, env(AUTHORISED)),
    { boardId: 'demo-learner', projectId: 'virgil-prod', allowProduction: true });
});

test('the flag is never set for a run that did not ask for it, so a hard-coded true has nowhere to hide', () => {
  // A composition root that passed `allowProduction: true` unconditionally
  // would authorise the *build* rather than the deployment, and the same image
  // on a laptop with a stray `gcloud auth` would write to the real board.
  const emulator = firestoreWiring({ boardId: 'b', projectId: 'p' }, env(EMULATOR));
  assert.equal('allowProduction' in emulator, false);
});

// --- the Job, at startup ----------------------------------------------------

/**
 * The real CLI, run for its exit code.
 *
 * `nightly` is the command the Cloud Run Job is given (`deploy/job.yaml`), and
 * it is the one used here on purpose: the assertion is that it never begins.
 * The store is opened while `deps` is built, above the command dispatch, so a
 * spec this process may not open ends the process before any night exists —
 * and no model is reached, because nothing gets that far.
 */
const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

function job(over: Record<string, string | undefined>) {
  // Every variable this decision reads is set explicitly, including to
  // `undefined`: a developer with the emulator running would otherwise inherit
  // `FIRESTORE_EMULATOR_HOST` and turn the refusal assertions green for the
  // wrong reason.
  const vars: Record<string, string | undefined> = {
    ...process.env,
    FIRESTORE_EMULATOR_HOST: undefined,
    VIRGIL_ALLOW_PRODUCTION: undefined,
    SB_DB: join(mkdtempSync(join(tmpdir(), 'sb-auth-')), 'store.json'),
    ...over,
  };
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete vars[k];
  return spawnSync(process.execPath, [CLI, 'nightly'], { env: vars, encoding: 'utf8', timeout: 60_000 });
}

test('an unauthorised Job exits EXIT_CONFIG at startup, and the night never begins', () => {
  const run = job({ SB_STORE: 'firestore:virgil-prod/demo-learner' });

  assert.equal(run.status, EXIT_CONFIG,
    'EXIT_INFRA here would ask Cloud Run to retry a condition no retry can change');
  assert.match(run.stderr, /VIRGIL_ALLOW_PRODUCTION/);
  assert.doesNotMatch(run.stdout, /batch-outcome/,
    'a night that reports an outcome is a night that ran');
});

test('the authorisation gate is the only thing standing in front of a real board', () => {
  /**
   * The ordering IS the fix, and this is the day it had to be right. Before it,
   * the only thing between an unauthorised Job and a real board was
   * `FirestoreStore` being absent from the adapters barrel — so the day ruling
   * 26's commit exported it, a Job that had been exiting 2 on a missing adapter
   * would have started cleanly and failed mid-night instead.
   *
   * The barrel exports it now. The adapter-missing branch is gone rather than
   * merely unreached, so this asserts the sentence has not come back AND that
   * what refused was the gate.
   */
  const run = job({ SB_STORE: 'firestore:virgil-prod/demo-learner' });

  // Matched loosely on purpose: the adapter-missing sentence has been reworded
  // before, and a test that only rejects today's wording would go quiet the
  // next time it is.
  assert.doesNotMatch(run.stderr, /has no Firestore/i,
    'an adapter-missing branch answered first, which means the gate is downstream of it again');
  assert.match(run.stderr, /VIRGIL_ALLOW_PRODUCTION/);
});

/**
 * **The two tests below deliberately stopped spawning the CLI, and that is a
 * safety property rather than a simplification.**
 *
 * Both used to assert that a spec got *past* the gate, and both proved it by
 * reading the next refusal — "this build has no Firestore store" — which was
 * the adapter's absence from the barrel answering. That absence is what made
 * spawning safe: nothing was ever constructed, so nothing ever opened a client.
 *
 * The barrel exports the adapter now. A spawned `nightly` that clears the gate
 * builds a real `FirestoreStore` and starts a night, and the second of these
 * carries `VIRGIL_ALLOW_PRODUCTION=yes` with a project-qualified spec — so it
 * would reach for Application Default Credentials and a real Google Cloud
 * project, from a suite whose standing rule is that it runs offline
 * (`GCP_SETUP_2026-08-20.md`: nothing is deployed before credits arrive). The
 * assertion each one was making is about the *wiring handed to the adapter*,
 * which is a pure function, so it is made against that and against a
 * constructed-but-unconnected store instead. Nothing here opens a client.
 */

test('an emulator Job gets past the gate, so the refusal is not a blanket one', () => {
  const choice = storeChoice('firestore:demo-learner', '.data/store.json');
  assert.equal(choice.kind, 'firestore');
  const wiring = firestoreWiring(choice as { boardId: string }, env(EMULATOR));

  assert.deepEqual(wiring, { boardId: 'demo-learner' },
    'the emulator path must stay unconfigured — no opt-in, and no project to bill');
  // And the adapter the composition root would reach off the barrel really is
  // constructible from it. Construction only: `FirestoreStore` connects on first
  // access, and no test in this file ever makes one.
  assert.ok(new FirestoreStore(wiring) instanceof FirestoreStore);
});

test('an authorised, project-qualified Job gets past the gate too', () => {
  const choice = storeChoice('firestore:virgil-prod/demo-learner', '.data/store.json');
  const wiring = firestoreWiring(choice as { boardId: string; projectId: string },
    env(AUTHORISED));

  assert.deepEqual(wiring,
    { boardId: 'demo-learner', projectId: 'virgil-prod', allowProduction: true },
    'a production run says which project it means, and says it authorised the reach');
  assert.ok(new FirestoreStore(wiring) instanceof FirestoreStore);
});

test('an authorised Job that names no project is refused by name, not by credentials', () => {
  const run = job({
    SB_STORE: 'firestore:demo-learner',
    VIRGIL_ALLOW_PRODUCTION: PRODUCTION_OPT_IN_VALUE,
  });

  assert.equal(run.status, EXIT_CONFIG);
  assert.match(run.stderr, /SB_STORE=firestore:<projectId>\/<boardId>/);
});
