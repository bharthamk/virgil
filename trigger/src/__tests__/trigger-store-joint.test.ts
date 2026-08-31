import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import type { Session } from '@sb/core';
import {
  FirestoreStore, FIRESTORE_MODULE, docId, batchKeyOf, type FsFirestore,
} from '@sb/adapters/dist/firestore-store.js';

import { triggerConfigFromEnv, type TriggerConfig } from '../config.js';
import { StoreBatchGuard } from '../guard.js';
import { nightlyTriggerHandler, type BatchOutcome, type TriggerReport } from '../handler.js';
import { batchKeyFor, sessionIdForBatch, type BatchKey, type NightKeyRule } from '../batch-key.js';
import { PUBSUB_MODULE, PubSubTransport, pubsubAvailable } from '../pubsub-binding.js';
import type { BatchRunMessage } from '../message.js';
import type { TriggerSubscription } from '../transport.js';

/**
 * **The two halves of the batch-idempotency contract, running together for the first time.**
 *
 * The batch-idempotency contract has a delivery side and a write side, and until this file they had
 * never met. `port/pubsub` proved the delivery side against `MemoryStore` with a
 * stub night; `port/firestore` proved the write side against the Firestore
 * emulator with no trigger in front of it. Both suites were green, and
 * `trigger/DESIGN.md` §10 says plainly what that was worth:
 *
 * > **Nothing has ever run the two halves of the batch-idempotency contract together.** … The first
 * > time a real nightly writes a real session and a real redelivered trigger
 * > reads it back will be on deployment.
 *
 * That gap has already produced one defect. §6a records it: the guard asked
 * `getSession(sessionIdForBatch(key))` for a name the Firestore adapter never
 * writes — the document is named `batchKeyOf(builtAt)` and `session.id` is still a
 * UUID — so the lookup returned `null` on **every** delivery while both branches
 * stayed green, and every redelivered trigger would have re-run a whole night in
 * production. It was found by reading the other lane's code, not by a test,
 * because no test could see both lanes at once.
 *
 * **This is that test.** Its purpose is not to re-prove either half. It is to
 * make that *class* of defect — the two lanes agreeing in their own suites and
 * disagreeing with each other — impossible to reintroduce silently.
 *
 * ## What runs here
 *
 * A real Pub/Sub broker, a real Firestore, and the real handler between them:
 *
 * ```
 *   PubSubTransport (emulator :8681)
 *        │  publish nightly-run
 *        ▼
 *   nightlyTriggerHandler          ← the real ack policy
 *        │  guard.begin(batchKey)
 *        ▼
 *   StoreBatchGuard                ← the real delivery-side idempotency
 *        │  getSession / listSessions
 *        ▼
 *   FirestoreStore (emulator :8377) ← the real write-side idempotency
 * ```
 *
 * The only stub is the night itself, and it is stubbed for the same reason the
 * Pub/Sub contract stubs it: an eight-minute pipeline inside a delivery test
 * would be testing the pipeline. **Zero model calls, zero Gemini, zero Google
 * Cloud resources.** The stub does the one thing the guard reads — it writes a
 * `Session` through the real adapter — and it writes it the way the real one
 * does: under a `randomUUID()`, because `pipeline.ts` mints a UUID per run and
 * `batch-idempotence.test.ts` says so in as many words, and carrying the
 * `batchKey` it was handed, because the batch-key alignment contract made that the field the row is
 * named from. A stub that wrote the row under `sessionIdForBatch(key)` would
 * take the guard's fast path every time and would prove nothing at all; a stub
 * that dropped the night key would be testing a pipeline this repository no
 * longer has.
 *
 * ## The gate
 *
 * **Both** emulator host variables, and both client packages resolvable. Neither
 * variable can route a client to a billed project — they are Google's own
 * emulator-selection variables — so the gate is also the whole of the safety
 * argument, exactly as it is in each lane's own gated file.
 *
 *     JAVA_HOME=/opt/homebrew/opt/openjdk@21 \
 *       firebase emulators:start --only firestore --project virgil-emulator   # :8377
 *     JAVA_HOME=/opt/homebrew/opt/openjdk@21 gcloud beta emulators pubsub start \
 *       --project=virgil-local --host-port=127.0.0.1:8681
 *     npm install --no-save --no-package-lock \
 *       @google-cloud/pubsub@6.0.1 @google-cloud/firestore@9.0.0
 *     PUBSUB_EMULATOR_HOST=127.0.0.1:8681 PUBSUB_PROJECT_ID=virgil-local \
 *       FIRESTORE_EMULATOR_HOST=127.0.0.1:8377 \
 *       node --test trigger/dist/__tests__/trigger-store-joint.test.js
 *
 * With either emulator down the file skips and says which one, rather than
 * quietly covering nothing. Note that the Pub/Sub emulator's documented default
 * bind is `[::1]:8085` — IPv6 loopback, which a client dialling `127.0.0.1` does
 * not reach — so the port is named explicitly on both sides.
 */

// ------------------------------------------------------------------- the gate

const pubsubHost = process.env['PUBSUB_EMULATOR_HOST'];
const firestoreHost = process.env['FIRESTORE_EMULATOR_HOST'];
const clientsPresent = await pubsubAvailable() && await (async (): Promise<boolean> => {
  try { await import(FIRESTORE_MODULE); return true; } catch { return false; }
})();

const why = !pubsubHost
  ? 'PUBSUB_EMULATOR_HOST is not set — the joint proof needs the Pub/Sub emulator'
  : !firestoreHost
    ? 'FIRESTORE_EMULATOR_HOST is not set — the joint proof needs the Firestore emulator'
    : `${PUBSUB_MODULE} and ${FIRESTORE_MODULE} must both be installed `
      + '(npm install --no-save --no-package-lock @google-cloud/pubsub@6.0.1 @google-cloud/firestore@9.0.0)';

const enabled = Boolean(pubsubHost) && Boolean(firestoreHost) && clientsPresent;
const skip = enabled ? false : why;

test('the joint proof reports what it did not check', { skip }, () => {
  assert.ok(enabled);
});

// ------------------------------------------------- the boundary alignment rule

const ALIGNED: NightKeyRule = { timeZone: 'UTC', boundaryHours: 0 };

/** What `trigger/DESIGN.md` §6b's `gcloud scheduler jobs create` line fires at. */
const PRODUCTION_SCHEDULE_UTC_HOUR = 3;

test('the alignment rule makes the two lanes the SAME partition, not merely a compatible one', () => {
  /**
   * Unconditional — it needs no emulator, because it is arithmetic on the two
   * lanes' own exported functions. That is deliberate: this is the assertion
   * that fails the moment either lane changes how it cuts a night, and it should
   * fail on a laptop with nothing running rather than only in a gated lane
   * somebody skipped.
   *
   * Every instant that could plausibly carry a nightly, including both sides of
   * midnight to the millisecond and both sides of the *other* lane's default
   * six-hour cut.
   */
  const instants = [
    '2026-08-21T03:00:00.000Z',        // the production schedule
    '2026-08-21T02:55:00.000Z',        // schedule drift, early
    '2026-08-21T03:05:00.000Z',        // schedule drift, late
    '2026-08-21T03:08:41.123Z',        // an eight-minute run's builtAt
    '2026-08-21T05:59:59.999Z',        // one ms before the trigger lane's default cut
    '2026-08-21T06:00:00.000Z',        // the trigger lane's default cut
    '2026-08-21T00:00:00.000Z',        // the shared cut, exactly
    '2026-08-20T23:59:59.999Z',        // one ms before it
    '2026-08-21T12:00:00.000Z',        // a daytime run, if the schedule ever moves
    '2026-12-31T23:59:59.999Z',        // a year boundary
    '2027-01-01T00:00:00.000Z',
    '2026-02-28T23:59:59.999Z',        // a month boundary
    '2026-03-29T01:30:00.000Z',        // inside Europe's DST transition, in UTC
  ];

  for (const iso of instants) {
    assert.equal(
      batchKeyFor(iso, ALIGNED), batchKeyOf(iso),
      `the trigger's night key and the Firestore document name disagree at ${iso} — `
      + 'under VIRGIL_TRIGGER_NIGHT_BOUNDARY_H=0 they must be the same string for every instant',
    );
  }
});

test('the default boundary is NOT aligned, and the rule exists because of it', () => {
  /**
   * The mutation check on the test above. If `boundaryHours: 0` were merely one
   * of several settings that happen to agree, the pin would be decoration — so
   * this asserts that the *default* genuinely disagrees, at exactly the
   * production schedule.
   *
   * This is an assertion about current behaviour, not a complaint about it. It
   * is here so that anyone who deletes `VIRGIL_TRIGGER_NIGHT_BOUNDARY_H=0` from
   * the deploy environment because it "looks like a default" finds this line.
   */
  const at3am = '2026-08-21T03:00:00.000Z';
  assert.equal(batchKeyFor(at3am, { timeZone: 'UTC', boundaryHours: 6 }), '2026-08-20');
  assert.equal(batchKeyOf(at3am), '2026-08-21');
  assert.notEqual(
    batchKeyFor(at3am, { timeZone: 'UTC', boundaryHours: 6 }), batchKeyOf(at3am),
    'if these ever agree, the alignment rule has become unnecessary and should be retired deliberately',
  );
});

test('the two night functions, written down, and the exact window where they agree', () => {
  /**
   * **(b) from the Cloud Run lane.** The two lanes compute "which night" with
   * two different functions, and until this assertion existed the difference
   * lived in prose in two design documents that do not reference each other.
   *
   * | lane | function | file |
   * | :--- | :--- | :--- |
   * | `trigger` | UTC date of `(instant − H hours)`, `H = VIRGIL_TRIGGER_NIGHT_BOUNDARY_H`, default **6** | `trigger/src/batch-key.ts` |
   * | `adapters` | UTC date of `builtAt`, i.e. **H = 0**, not configurable | `adapters/src/firestore-store.ts` |
   *
   * So `batchKeyOf` is `batchKeyFor` with `H` pinned to zero, and the two agree on
   * an instant **exactly when that instant's UTC hour is at or after `H`**.
   * Shifting back by `H` only crosses a date boundary when there is less than
   * `H` hours of the day already elapsed.
   *
   * That gives the agreement window in one line, and it is asserted for the
   * whole 24 hours rather than sampled:
   *
   * - `H = 0` → agrees for **all 24 hours**. The functions are identical.
   * - `H = 6` (today's default) → agrees **06:00Z–23:59Z**, disagrees
   *   **00:00Z–05:59Z**.
   *
   * **The production schedule sits inside the disagreement window**, which is
   * the fact that makes the alignment rule mandatory rather than tidy: `0 3 * * *`
   * fires at 03:00Z, and 3 < 6.
   */
  for (const H of [0, 3, 6, 12]) {
    const rule: NightKeyRule = { timeZone: 'UTC', boundaryHours: H };
    for (let hour = 0; hour < 24; hour++) {
      const iso = `2026-08-21T${String(hour).padStart(2, '0')}:30:00.000Z`;
      const agrees = batchKeyFor(iso, rule) === batchKeyOf(iso);
      assert.equal(
        agrees, hour >= H,
        `at H=${H}, ${iso}: the two lanes ${agrees ? 'agree' : 'disagree'} and the rule says `
        + `they should ${hour >= H ? 'agree' : 'disagree'} — the agreement window is "UTC hour >= H"`,
      );
    }
  }

  // The two facts above, stated as the flat claims a reader wants.
  for (let hour = 0; hour < 24; hour++) {
    const iso = `2026-08-21T${String(hour).padStart(2, '0')}:30:00.000Z`;
    assert.equal(batchKeyFor(iso, ALIGNED), batchKeyOf(iso), 'H=0 agrees for every hour of the day');
  }
  assert.notEqual(
    batchKeyFor(`2026-08-21T0${PRODUCTION_SCHEDULE_UTC_HOUR}:00:00.000Z`, { timeZone: 'UTC', boundaryHours: 6 }),
    batchKeyOf(`2026-08-21T0${PRODUCTION_SCHEDULE_UTC_HOUR}:00:00.000Z`),
    'the production schedule fires INSIDE the default boundary’s disagreement window',
  );
});

// ----------------------------------------------------------------- the harness

interface FirestoreModule {
  Firestore: new (settings: Record<string, unknown>) => FsFirestore;
}

/**
 * One Firestore client for the file, one board per test.
 *
 * The same split `firestore-live.test.ts` makes: share the transport, not the
 * state. A board is the unit a learner has, so it is the unit of isolation.
 */
let sharedDb: FsFirestore | null = null;
async function db(): Promise<FsFirestore> {
  if (sharedDb) return sharedDb;
  const mod = await import(FIRESTORE_MODULE) as unknown as FirestoreModule;
  sharedDb = new mod.Firestore({ projectId: 'virgil-emulator' });
  return sharedDb;
}

/**
 * The sessions collection, read **without going through the adapter**.
 *
 * This is the assertion the task of this lane turns on. `listSessions()` is the
 * adapter's own answer, and an adapter that renamed its documents would keep
 * answering it correctly right up until something else read the collection. So
 * every count below is taken twice — once through the adapter and once from the
 * raw collection — and the document **names** are asserted, not just the number
 * of them. A naming regression cannot hide behind a query that was written to
 * tolerate it.
 */
async function rawSessionDocs(boardId: string): Promise<{ names: string[]; ids: string[] }> {
  const snap = await (await db()).collection('boards').doc(docId(boardId)).collection('sessions').get();
  return {
    names: snap.docs.map((d) => d.id).sort(),
    ids: snap.docs.map((d) => String(d.data()['id'])).sort(),
  };
}

let topicSeq = 0;

/**
 * A topic namespace nothing else has ever used — including a previous run of
 * this same file.
 *
 * A per-test counter alone is not isolation, and finding that out cost a
 * debugging pass worth writing down. The Pub/Sub emulator has **no message
 * retention and no subscription expiry** — both are on its own list of
 * unsupported features, and its documentation is explicit that *"all messages
 * are retained indefinitely"*. So a topic named `nightly-run-joint1` is the same
 * topic on every run of this file, and any message a previous process left
 * unacked is still sitting on its subscription waiting for a subscriber. The
 * next run attaches, and receives that backlog on top of what it published:
 * eight deliveries of a night the test published once.
 *
 * The symptom is a suite that passes on a clean emulator and then fails at
 * varying rates for the rest of the day, which is the worst failure mode a proof
 * can have — it reads as flakiness in the thing under test rather than as
 * leakage in the harness, and the honest reading was only available because the
 * test asserts on *how many nights ran* rather than only on how many rows
 * survived. The store stayed correct throughout; it was the fleet's model spend
 * that was being reported wrongly.
 *
 * A UUID per process makes each run's estate unreachable from any other.
 */
const RUN = randomUUID().slice(0, 8);

interface Rig {
  readonly boardId: string;
  readonly store: FirestoreStore;
  readonly reports: TriggerReport[];
  /** Every night key the runner was actually asked to build. */
  readonly nights: BatchKey[];
  publish(message: BatchRunMessage): Promise<string>;
  /** Resolve once the handler has been invoked at least `n` times in total. */
  settle(n: number): Promise<void>;
  dispose(): Promise<void>;
}

interface RigOptions {
  /** The night boundary this composition runs under. Defaults to the rule. */
  readonly rule?: NightKeyRule;
  /**
   * What the night reports. Defaults to a built session.
   *
   * The `sessionId` in the outcome is deliberately NOT what gets written — the
   * runner writes its own UUID, as `pipeline.ts` does — so nothing here can
   * accidentally take the guard's `sessionIdForBatch` fast path.
   */
  readonly outcome?: (key: BatchKey) => BatchOutcome;
  /**
   * Hook, by attempt number, for the crash cases. Runs before the session write.
   *
   * Handed the store, so a test can leave real debris on a real board without
   * needing a reference to a rig that does not exist yet.
   */
  readonly beforeWrite?: (ctx: { key: BatchKey; attempt: number; store: FirestoreStore }) => Promise<void> | void;
  /** Hook, by attempt number, for the crash cases. Runs after the session write. */
  readonly afterWrite?: (ctx: { key: BatchKey; attempt: number; store: FirestoreStore }) => Promise<void> | void;
  /**
   * The instant the night reports as `builtAt`.
   *
   * In production this is the run's own wall clock, a few minutes after the
   * schedule fired. It is injected here because a test that read a clock would
   * be as non-deterministic as the bug the night key exists to prevent — and
   * because the whole point of this file is that `builtAt` is what decides the
   * document name.
   *
   * **It varies by attempt, not only by night**, which is not a convenience: a
   * retried Cloud Run Job task is the *same* night on a *later* clock, and that
   * gap is exactly where the midnight hazard lives. A signature keyed only on
   * the night could not express the case at all.
   */
  readonly builtAt?: (ctx: { key: BatchKey; attempt: number }) => string;
  readonly maxAttempts?: number;
}

/**
 * A `Session` in the shape a real run persists: a UUID id, a real `builtAt`,
 * and the night the run was told to build (the batch-key alignment contract).
 *
 * The two timestamps are separate arguments because in production they are
 * separate facts and the whole midnight hazard lives in the gap between them.
 */
function sessionRow(builtAt: string, batchKey: BatchKey): Session {
  return {
    id: randomUUID(),
    builtAt,
    batchKey,
    fromPinCount: 3,
    targetMinutes: 15,
    estimatedMinutes: 12.5,
    sections: [{
      topicId: 't1', heading: 'Pull subscriptions', body: 'prose', depth: 'building',
      estimatedMinutes: 12.5, question: null, sourceIds: ['p1:0'], completed: false,
    }],
    currentSectionIndex: 0,
    closingNote: null,
  };
}

async function rig(opts: RigOptions = {}): Promise<Rig> {
  const rule = opts.rule ?? ALIGNED;
  const boardId = `joint-${randomUUID()}`;
  const store = new FirestoreStore({ boardId, firestore: await db() });

  // A fresh topic and subscription per test, inside a namespace no other run
  // shares. See `RUN` for why the second half of that sentence is load-bearing.
  const n = ++topicSeq;
  const base = triggerConfigFromEnv(process.env);
  const config: TriggerConfig = {
    ...base,
    topic: `${base.topic}-joint-${RUN}-${n}`,
    subscription: `${base.subscription}-joint-${RUN}-${n}`,
    batchKey: rule,
    maxAttempts: opts.maxAttempts ?? 3,
  };

  const transport = await PubSubTransport.create(config);
  await transport.ensure();
  const publisher = await transport.publisher();

  const reports: TriggerReport[] = [];
  const nights: BatchKey[] = [];
  const attempts = new Map<BatchKey, number>();
  let handled = 0;

  const handler = nightlyTriggerHandler({
    guard: new StoreBatchGuard(store, { maxAttempts: config.maxAttempts }),
    rule,
    report: (r) => reports.push(r),
    run: async ({ batchKey }): Promise<BatchOutcome> => {
      const attempt = (attempts.get(batchKey) ?? 0) + 1;
      attempts.set(batchKey, attempt);
      nights.push(batchKey);

      await opts.beforeWrite?.({ key: batchKey, attempt, store });

      const outcome = opts.outcome?.(batchKey) ?? { kind: 'session', sessionId: 'unused' };
      if (outcome.kind === 'session') {
        const builtAt = opts.builtAt?.({ key: batchKey, attempt }) ?? `${batchKey}T03:08:41.123Z`;
        const row = sessionRow(builtAt, batchKey);
        await store.putSession(row);
        await opts.afterWrite?.({ key: batchKey, attempt, store });
        return { kind: 'session', sessionId: row.id };
      }
      await opts.afterWrite?.({ key: batchKey, attempt, store });
      return outcome;
    },
  });

  let subscription: TriggerSubscription | null = null;
  subscription = await transport.subscribe(async (m) => {
    const decision = await handler(m);
    handled += 1;
    return decision;
  });

  return {
    boardId,
    store,
    reports,
    nights,
    publish: (m) => publisher.publish(m),
    /**
     * Streaming pull is asynchronous, so settling is a poll rather than a drain.
     * Twenty seconds is a failure bound rather than an expectation — every case
     * here settles in milliseconds when it settles at all — and it is deliberately
     * not a latency assertion: an emulator on a loopback socket does not measure
     * anything production will do.
     */
    settle: async (want: number): Promise<void> => {
      const deadline = Date.now() + 20_000;
      while (handled < want && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 25));
      }
      assert.ok(handled >= want, `only ${handled} of ${want} deliveries arrived within 20s`);
    },
    dispose: async (): Promise<void> => {
      await subscription?.close();
      await transport.close();
      // Delete the board rather than empty it, so a leftover row from a failed
      // test cannot be read by the next one as a pass.
      const client = await db();
      await client.recursiveDelete(client.collection('boards').doc(docId(boardId)));
    },
  };
}

/** A well-formed trigger for a given instant. */
const trigger = (scheduledAt: string): BatchRunMessage =>
  ({ v: 1, kind: 'nightly-run', scheduledAt });

/** The instant the production schedule fires on a given date. */
const scheduleOn = (date: string): string =>
  `${date}T0${PRODUCTION_SCHEDULE_UTC_HOUR}:00:00.000Z`;

// ------------------------------------------------------------------ the proof

test('a trigger over the REAL store builds the night and names the document after it', { skip }, async () => {
  /**
   * The composition, once, end to end. Nothing here is new to either lane; what
   * is new is that no `MemoryStore` and no hand-written fake is anywhere in the
   * path. A message goes into a real broker and a document comes out of a real
   * Firestore, and the name on that document is asserted rather than assumed.
   */
  const r = await rig();
  try {
    const at = scheduleOn('2026-08-21');
    await r.publish(trigger(at));
    await r.settle(1);

    const key = batchKeyFor(at, ALIGNED);
    assert.equal(key, '2026-08-21', 'the night the trigger named');
    assert.deepEqual(r.nights, [key], 'the night ran exactly once');
    assert.equal(r.reports[0]?.outcome, 'ran-session');
    assert.equal(r.reports[0]?.decision, 'ack');

    // Through the adapter.
    const listed = await r.store.listSessions();
    assert.equal(listed.length, 1, 'one session on the board');
    assert.equal(listed[0]?.builtAt.slice(0, 10), key);

    // And from the raw collection, which is the half that catches a rename.
    const raw = await rawSessionDocs(r.boardId);
    assert.deepEqual(raw.names, [key],
      'the Firestore document is named after the night the trigger built — '
      + 'this is the assertion the whole alignment rule exists to make true');

    // The domain query finds it, which is what the guard will ask next time.
    const found = await r.store.getSession(String(listed[0]?.id));
    assert.notEqual(found, null, 'getSession finds the row by its id field');
    assert.equal((await r.store.latestSession())?.id, listed[0]?.id);
  } finally { await r.dispose(); }
});

test('THE defect class: a redelivered message finds the night and runs it ZERO extra times', { skip }, async () => {
  const r = await rig({
    afterWrite: ({ attempt }) => {
      if (attempt === 1) throw new Error('the job died after persisting the session');
    },
  });
  try {
    const at = scheduleOn('2026-08-21');
    await r.publish(trigger(at));
    await r.settle(2);

    const key = batchKeyFor(at, ALIGNED);

    // The fast path is genuinely dead against this adapter.
    assert.equal(await r.store.getSession(sessionIdForBatch(key)), null,
      'getSession by the trigger lane’s invented name finds nothing — it never could, '
      + 'and a guard that relied on it would re-run every night in production');

    /**
     * The assertion that names the defect, made **first** and deliberately.
     *
     * Everything else in this test is bookkeeping about deliveries, and if a
     * bookkeeping assertion fires first it reports a delivery count when the
     * fact worth reading is that a whole night was rebuilt. Under the §6a
     * regression this line is the one that goes red, and it says so in the
     * currency that matters: eleven model calls and eight minutes.
     */
    assert.deepEqual(r.nights, [key],
      'the night ran ONCE — a second entry here is a redelivered trigger re-running a night '
      + 'that was already built and paid for, which is exactly the §6a defect');

    assert.equal(r.reports[0]?.outcome, 'infra-failure');
    assert.equal(r.reports[0]?.decision, 'nack', 'nothing was decided, so nothing was acked');
    assert.equal(r.reports[1]?.outcome, 'skipped-already-built',
      'the redelivery recognised the night — through builtAt, not through a name');
    assert.equal(r.reports[1]?.decision, 'ack');
    assert.equal(r.reports[0]?.batchKey, r.reports[1]?.batchKey,
      'and both deliveries named the same night, so the key came off the message');
    assert.equal(r.reports.length, 2, 'the message was delivered exactly twice');

    // Counted twice, and the names asserted.
    assert.equal((await r.store.listSessions()).length, 1, 'one row through the adapter');
    const raw = await rawSessionDocs(r.boardId);
    assert.deepEqual(raw.names, [key], 'one document, named after the night, in the raw collection');
    assert.equal(raw.ids.length, 1);
  } finally { await r.dispose(); }
});

test('two DIFFERENT messages for one night still build it once', { skip }, async () => {
  /**
   * The realistic production duplicate, and the one the emulator can produce
   * without a crash: Cloud Scheduler retried and published a second message.
   * Two message ids, one night — which is why the idempotency key is the night
   * and not the message id, and why the guard's answer has to come from the
   * store rather than from anything held in this process.
   */
  const r = await rig();
  try {
    const a = await r.publish(trigger(scheduleOn('2026-08-21')));
    await r.settle(1);
    const b = await r.publish(trigger('2026-08-21T03:04:00.000Z'));
    await r.settle(2);

    assert.notEqual(a, b, 'two distinct messages');
    assert.deepEqual(r.nights, ['2026-08-21'], 'one night');
    assert.equal(r.reports[1]?.outcome, 'skipped-already-built');
    assert.equal((await r.store.listSessions()).length, 1);
    assert.deepEqual((await rawSessionDocs(r.boardId)).names, ['2026-08-21']);
  } finally { await r.dispose(); }
});

test('a crash after a PARTIAL write is completed by the redelivery, under the same document name', { skip }, async () => {
  /**
   * The other crash shape, and the one that decides whether a retried Cloud Run
   * Job leaves debris.
   *
   * The first attempt writes real rows — a topic and a statement, the kind of
   * thing the nightly persists on its way through — and then dies *before* the
   * session. So the redelivery arrives at a board that is half-built and has no
   * session on it: the guard must say `run`, and the completed night must land
   * on the same document the first attempt would have used.
   *
   * The write side is what makes that safe. The document name is
   * `batchKeyOf(builtAt)`, so the retry's session and the crashed attempt's session
   * are the same path by construction — there is no uniqueness check to forget
   * and no read-before-write to race. This test is the composed evidence for
   * that sentence: two attempts, one row, and the row is the one the retry
   * built.
   */
  const partial: string[] = [];
  const r = await rig({
    beforeWrite: async ({ key, attempt, store }) => {
      if (attempt !== 1) return;
      // Debris from a run that got some way in. A real row through the real
      // adapter, so the redelivery meets a genuinely half-written board.
      await store.putTopic({
        id: 'topic-partial',
        label: 'Pull subscriptions',
        summary: 'a streaming pull holds the message while the job runs',
        pinIds: ['p1'],
        state: 'working',
        comfort: 0.2,
        lastExposedAt: null,
        retiredByUser: false,
        createdAt: `${key}T03:01:00.000Z`,
      });
      partial.push('topic');
      throw new Error('the job died before it composed a session');
    },
  });
  try {
    const at = scheduleOn('2026-08-21');
    await r.publish(trigger(at));
    await r.settle(2);

    const key = batchKeyFor(at, ALIGNED);
    assert.deepEqual(partial, ['topic'], 'the first attempt really did write something');
    assert.equal(r.reports[0]?.outcome, 'infra-failure');
    assert.equal(r.reports[0]?.decision, 'nack');
    assert.equal(r.reports[1]?.outcome, 'ran-session', 'the redelivery COMPLETED the night');
    assert.equal(r.reports[1]?.batchKey, key, 'under the same key it always had');
    assert.deepEqual(r.nights, [key, key], 'attempted twice, which is what a crash costs');

    assert.equal((await r.store.listSessions()).length, 1, 'and left ONE session row');
    assert.deepEqual((await rawSessionDocs(r.boardId)).names, [key],
      'under the same document name the crashed attempt would have used');
    // The debris is still there, which is honest: chunked cascades are not
    // atomic and neither lane claims they are. What matters is that it did not
    // become a second night.
    assert.equal((await r.store.listTopics()).length, 1);
  } finally { await r.dispose(); }
});

test('two different nights are two documents, each named after its own night', { skip }, async () => {
  /**
   * The mutation check on every assertion above: a guard that collapsed
   * everything onto one night, or a store that wrote every session to one
   * document, would pass all of them.
   *
   * It is also half of the batch-idempotency contract’s promise. The other half — "the key collapses
   * a retry, not a history" — is what the progression projection depends on:
   * sessions are how it sees more than this run, so a key that merged two nights
   * would take the follow-through badge with it.
   */
  const r = await rig();
  try {
    await r.publish(trigger(scheduleOn('2026-08-21')));
    await r.settle(1);
    await r.publish(trigger(scheduleOn('2026-08-22')));
    await r.settle(2);

    assert.deepEqual(r.nights, ['2026-08-21', '2026-08-22'], 'two nights, in order');
    assert.equal((await r.store.listSessions()).length, 2);
    assert.deepEqual((await rawSessionDocs(r.boardId)).names, ['2026-08-21', '2026-08-22'],
      'two documents, each named after the night the trigger built');
  } finally { await r.dispose(); }
});

test('a schedule sitting ON the shared boundary still agrees, under the alignment rule', { skip }, async () => {
  /**
   * The boundary case, composed rather than calculated.
   *
   * `boundaryHours: 0` puts the cut at midnight UTC, so the most hostile
   * schedule for this rule is a run that fires a millisecond before it and a run
   * that fires on it. Under the rule they are two nights to the trigger and two
   * documents to Firestore, and the names agree — which is the property that
   * makes the rule worth having: it is not that the current schedule happens to
   * sit far from a boundary, it is that **no** schedule can split the two
   * partitions once they are the same function.
   */
  const r = await rig();
  try {
    const eve = '2026-08-21T23:59:59.999Z';
    const midnight = '2026-08-22T00:00:00.000Z';

    await r.publish(trigger(eve));
    await r.settle(1);
    await r.publish(trigger(midnight));
    await r.settle(2);

    assert.deepEqual(r.nights, ['2026-08-21', '2026-08-22'],
      'a millisecond apart and on opposite sides of the cut — two nights');
    assert.deepEqual((await rawSessionDocs(r.boardId)).names, ['2026-08-21', '2026-08-22'],
      'and two documents, each named exactly what the trigger called its night');
  } finally { await r.dispose(); }
});

test('the two partitions still disagree under the DEFAULT boundary, and the batch-key alignment contract is what stops it costing a night', { skip }, async () => {
  /**
   * **The evidence for the alignment rule, produced rather than argued — and
   * re-read after the batch-key alignment contract.**
   *
   * This is the cross-branch defect this lane was sent to look for, and it was
   * real. With the trigger lane's default `boundaryHours: 6` and the Firestore
   * adapter behind it:
   *
   *  - a trigger at 03:00Z on the 21st is night `2026-08-20` to the guard, and
   *    its session's `builtAt` would have put the document at `2026-08-21`;
   *  - a trigger at 07:00Z the same morning is night `2026-08-21` to the guard —
   *    a *different* night, so the guard correctly says run — and its session's
   *    `builtAt` would have put the document at `2026-08-21` too.
   *
   * That was **two nights, one document, the second silently overwriting the
   * first**, with the batch-idempotency contract’s write side working exactly as designed while it
   * happened: the document name *was* the key, and both rows honestly claimed
   * the same name.
   *
   * The batch-key alignment contract removes the mechanism rather than the mismatch. The document name
   * is now the night the run was told to build, so two nights are two documents
   * however far apart the two lanes cut a night — asserted below, because the
   * claim "the loss is structurally gone" is worth more as behaviour than as
   * prose. What survives is the *label* disagreement: `batchKeyOf(builtAt)` and the
   * guard's key are still different strings under the default, which is
   * confusing to read and is why the estate still pins
   * `VIRGIL_TRIGGER_NIGHT_BOUNDARY_H=0`. A rule that is now about legibility
   * rather than about data loss is a rule worth saying so about.
   *
   * A 07:00 run is not the current schedule. It does not need to be: the
   * schedule is a `gcloud` line somebody can edit without reading either design
   * document, and a system that is safe only while nobody touches the cron is
   * not safe.
   */
  const DEFAULTED: NightKeyRule = { timeZone: 'UTC', boundaryHours: 6 };

  // `builtAt` tracks the run, as it does in production: a few minutes after the
  // trigger fired. Both runs happen on the morning of the 21st — which is the
  // whole point, because the trigger lane calls them different nights and
  // `batchKeyOf` calls them the same day.
  const builtAtByKey: Record<string, string> = {
    '2026-08-20': '2026-08-21T03:08:00.000Z',
    '2026-08-21': '2026-08-21T07:08:00.000Z',
  };

  const r = await rig({
    rule: DEFAULTED,
    builtAt: ({ key }) => builtAtByKey[key] ?? `${key}T03:08:00.000Z`,
  });
  try {
    await r.publish(trigger('2026-08-21T03:00:00.000Z'));
    await r.settle(1);
    await r.publish(trigger('2026-08-21T07:00:00.000Z'));
    await r.settle(2);

    assert.deepEqual(r.nights, ['2026-08-20', '2026-08-21'],
      'the guard saw two distinct nights, and it was right to');

    assert.deepEqual((await rawSessionDocs(r.boardId)).names, ['2026-08-20', '2026-08-21'],
      'and each of them landed on its OWN document — the overwrite needed the name to come '
      + 'from builtAt, and it no longer does');
    assert.equal((await r.store.listSessions()).length, 2, 'two nights built, two rows kept');

    // The label disagreement the alignment rule is now about, stated rather
    // than implied: both rows finished on the 21st by the clock, and one of
    // them is night 2026-08-20.
    const rows = (await r.store.listSessions()) as readonly Session[];
    for (const row of rows) assert.equal(row.builtAt.slice(0, 10), '2026-08-21');
    assert.deepEqual(rows.map((s) => s.batchKey).sort(), ['2026-08-20', '2026-08-21']);

    // And the idempotency holds for both, which is what it did not do before.
    const first = rows.find((s) => s.batchKey === '2026-08-20');
    assert.ok(first, 'night 2026-08-20 is findable under its own key, so a redelivery would not re-run it');

    assert.equal(batchKeyFor(first.builtAt, DEFAULTED), '2026-08-20', 'the guard’s reading');
    assert.equal(batchKeyOf(first.builtAt), '2026-08-21', 'and the reading the document name used to take');
  } finally { await r.dispose(); }
});

// -------------------------------------- the midnight-crossing retry (Cloud Run)

/**
 * A schedule close enough to midnight UTC that an eight-minute run plus a retry
 * lands on the far side of it. Not the current schedule — the point is that
 * nothing enforces the current schedule.
 */
const LATE_TRIGGER = '2026-08-21T23:55:00.000Z';

test('a retry that crosses midnight UTC does not split the night — when the first attempt persisted', { skip }, async () => {
  const r = await rig({
    builtAt: ({ attempt }) => (attempt === 1
      ? '2026-08-21T23:58:00.000Z'      // before midnight
      : '2026-08-22T00:03:00.000Z'),    // the retry, after it
    afterWrite: ({ attempt }) => {
      if (attempt === 1) throw new Error('the Job task died after persisting, just before midnight');
    },
  });
  try {
    await r.publish(trigger(LATE_TRIGGER));
    await r.settle(2);

    const key = batchKeyFor(LATE_TRIGGER, ALIGNED);
    assert.equal(key, '2026-08-21');

    assert.equal(r.reports[0]?.batchKey, key);
    assert.equal(r.reports[1]?.batchKey, key,
      'the retry names the SAME night although its clock is on the next date — '
      + 'the key comes off the message, which is what makes it an anchor at all');
    assert.equal(r.reports[1]?.outcome, 'skipped-already-built',
      'and the guard stopped the retry before it could compute a second document name');

    assert.deepEqual(r.nights, [key], 'the night ran once');
    assert.equal((await r.store.listSessions()).length, 1, 'ONE row through the adapter');
    assert.deepEqual((await rawSessionDocs(r.boardId)).names, ['2026-08-21'],
      'ONE document, named for the night before midnight — the split did not happen');
  } finally { await r.dispose(); }
});

test('a retry that crosses midnight names the row for the night it was FOR, not the night it finished in', { skip }, async () => {
  /**
   * **(a), second shape — the one that was a real defect, and is the regression
   * pin for the batch-key alignment contract.**
   *
   * Change one thing from the test above: the first attempt dies *before* it
   * persists a session, which is the far more likely crash (the session is
   * written at the end of an eight-minute pipeline, so almost all of the window
   * in which a task can die is before the write). Now the guard's pre-check
   * finds nothing — correctly, nothing was built — and the retry runs the night.
   *
   * The retry's clock is past midnight. Under the branch this file was written
   * on, `batchKeyOf(builtAt)` named the document **`2026-08-22`** while the
   * trigger, the guard and both reports called it night **`2026-08-21`** — one
   * row, so the batch-idempotency contract’s "one night, one row" survived the letter of the hazard,
   * and the label did not. The night was then unfindable under its own key, so
   * every further trigger for it rebuilt the whole thing, and the row sat
   * squatting on the *following* night's name.
   *
   * The alignment rule did not touch it — `boundaryHours: 0` is in force
   * throughout this test — because the problem was never which boundary the two
   * lanes use. It was that **the trigger's night key never reached the document
   * name.** The batch-key alignment contract is that it does: `Session.batchKey` carries it and
   * `sessionBatchKey` is what the adapter names the row from, so the retry's clock
   * decides nothing at all.
   *
   * Revert either half and this test reports the row under `2026-08-22` and a
   * third delivery running a night that was already paid for.
   */
  const r = await rig({
    builtAt: ({ attempt }) => (attempt === 1
      ? '2026-08-21T23:58:00.000Z'
      : '2026-08-22T00:03:00.000Z'),
    beforeWrite: ({ attempt }) => {
      if (attempt === 1) throw new Error('the Job task died before composing, just before midnight');
    },
  });
  try {
    await r.publish(trigger(LATE_TRIGGER));
    await r.settle(2);

    const key = batchKeyFor(LATE_TRIGGER, ALIGNED);
    assert.equal(key, '2026-08-21');
    assert.equal(r.reports[1]?.outcome, 'ran-session', 'the retry ran the night, correctly');
    assert.equal(r.reports[1]?.batchKey, key, 'and called it night 2026-08-21');

    assert.equal((await r.store.listSessions()).length, 1, 'one row');
    assert.deepEqual((await rawSessionDocs(r.boardId)).names, ['2026-08-21'],
      'and named for the night it was built FOR — the retry finished on the 22nd and '
      + 'the document does not care');

    // The row's own two facts, which is where the name came from.
    const built = (await r.store.listSessions())[0] as Session;
    assert.equal(built.batchKey, key, 'the session says which night it is for');
    assert.notEqual(batchKeyFor(built.builtAt, ALIGNED), key,
      'and its clock says otherwise, which is the whole case this closes');

    // The night is idempotent again: a further trigger for it finds it.
    await r.publish(trigger('2026-08-21T23:56:00.000Z'));
    await r.settle(3);

    assert.deepEqual(r.nights, [key, key],
      'a third delivery for the SAME night did NOT run it again — this is the spend '
      + 'the guard exists to prevent, and the night key is what let it find the row');
    assert.equal(r.reports[2]?.outcome, 'skipped-already-built');
    assert.deepEqual((await rawSessionDocs(r.boardId)).names, ['2026-08-21'],
      'still one document, and still the right one');
  } finally { await r.dispose(); }
});

test('a retry that crossed midnight does NOT consume the following night', { skip }, async () => {
  const r = await rig({
    builtAt: ({ key, attempt }) => {
      // The late night, whose retry crosses midnight.
      if (key === '2026-08-21') {
        return attempt === 1 ? '2026-08-21T23:58:00.000Z' : '2026-08-22T00:03:00.000Z';
      }
      // The next night, running normally at its own schedule.
      return `${key}T03:08:00.000Z`;
    },
    beforeWrite: ({ key, attempt }) => {
      if (key === '2026-08-21' && attempt === 1) {
        throw new Error('the Job task died before composing, just before midnight');
      }
    },
  });
  try {
    // Night one: crashes, retries across midnight, lands under its own name.
    await r.publish(trigger(LATE_TRIGGER));
    await r.settle(2);
    assert.deepEqual((await rawSessionDocs(r.boardId)).names, ['2026-08-21'],
      'the 21st’s session, named the 21st, although the retry finished on the 22nd');
    const first = ((await r.store.listSessions())[0] as Session).id;

    // Night two: an ordinary trigger, at its own schedule, for a night nothing
    // has built.
    await r.publish(trigger(scheduleOn('2026-08-22')));
    await r.settle(3);

    assert.deepEqual(r.nights, ['2026-08-21', '2026-08-21', '2026-08-22'],
      'THE 22nd RAN — a row belonging to the 21st does not answer for it, whatever '
      + 'clock that row finished on');
    assert.equal(r.reports[2]?.outcome, 'ran-session');

    const rows = await r.store.listSessions();
    assert.equal(rows.length, 2, 'two nights, two rows');
    assert.ok(rows.some((s) => s.id === first), 'the 21st’s session is still there, untouched');
    assert.deepEqual((await rawSessionDocs(r.boardId)).names, ['2026-08-21', '2026-08-22'],
      'and two documents, each named for the night it belongs to');
  } finally { await r.dispose(); }
});

test('the schedule’s margin is no longer what holds the midnight hazard shut', { skip }, async () => {
  const r = await rig();
  try {
    const at = scheduleOn('2026-08-21');
    await r.publish(trigger(at));
    await r.settle(1);

    const key = batchKeyFor(at, ALIGNED);
    const built = ((await r.store.listSessions())[0] as Session).builtAt;
    assert.equal(batchKeyOf(built), key, 'the document and the night agree at the current schedule');

    const midnight = Date.parse('2026-08-22T00:00:00.000Z');
    const marginHours = (midnight - Date.parse(built)) / 3_600_000;
    assert.ok(marginHours > 20,
      `only ${marginHours.toFixed(1)}h of margin to the next UTC midnight — under about 0.2h `
      + 'a Pub/Sub redelivery at the 600s maximum backoff could cross it, and the row would '
      + 'be named for the wrong night');
  } finally { await r.dispose(); }
});

test('a night that honestly produced nothing is ACKED, writes nothing, and does not come back', { skip }, async () => {
  /**
   * the delivery-safety contract and withheld-content contract, over the real store — and the composed behaviour is read
   * from `pipeline.ts` rather than assumed. On `nothing-to-teach` it returns
 * *"nothing to teach and nothing to revise — honest empty state"* and
   * on `model-failed` *"nothing is persisted, and the topics are owed a night"*.
   * Both return **before** `putSession`, so the honest composed answer is that
   * the sessions collection is not merely empty, it does not exist.
   *
   * The ack is the half that costs money if it is wrong. Failure to produce is
   * not failure to process: nacking would ask the platform to redeliver so the
   * fleet could spend eleven more model calls arriving at the same true answer.
   */
  const r = await rig({ outcome: () => ({ kind: 'no-session', reason: 'nothing-to-teach' }) });
  try {
    await r.publish(trigger(scheduleOn('2026-08-21')));
    await r.settle(1);

    assert.equal(r.reports[0]?.outcome, 'ran-no-session');
    assert.equal(r.reports[0]?.decision, 'ack');

    assert.deepEqual(await r.store.listSessions(), [], 'nothing was persisted, through the adapter');
    const raw = await rawSessionDocs(r.boardId);
    assert.deepEqual(raw.names, [], 'and no document exists in the raw collection either');

    // The observable half of the ack: nothing comes back.
    await new Promise((res) => setTimeout(res, 750));
    assert.equal(r.reports.length, 1, 'an acked message is not redelivered');
    assert.deepEqual(r.nights, ['2026-08-21'], 'so the night was not run a second time');
  } finally { await r.dispose(); }
});

test('a quota-degraded night ACKS against the real store — the quota-retry policy is not undone', { skip }, async () => {
  /**
   * The row of the ack policy that costs the most if it is wrong, checked in the
   * composition rather than only against the oracle.
   * the transport contract the quota-retry policy rules that a spent daily
   * cap degrades and marks the later stages not-attempted rather than retrying
   * until morning. A degraded night that nacked would hand that decision back to
   * the platform, which would redeliver within seconds — the retry storm the
   * correction exists to prevent, arriving through a door the correction does not
   * watch.
   */
  const r = await rig({ outcome: () => ({ kind: 'degraded', reason: 'quota-exhausted' }) });
  try {
    await r.publish(trigger(scheduleOn('2026-08-21')));
    await r.settle(1);

    assert.equal(r.reports[0]?.outcome, 'ran-degraded');
    assert.equal(r.reports[0]?.decision, 'ack');
    await new Promise((res) => setTimeout(res, 750));
    assert.equal(r.nights.length, 1, 'the spent quota was not retried until morning');
    assert.deepEqual((await rawSessionDocs(r.boardId)).names, []);
  } finally { await r.dispose(); }
});
