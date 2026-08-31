import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStore } from '@sb/adapters/dist/__tests__/memory-store.js';
import type { Session } from '@sb/core';

import { StoreBatchGuard } from '../guard.js';
import { nightlyTriggerHandler, type BatchOutcome, type TriggerReport } from '../handler.js';
import { sessionIdForBatch, type BatchKey } from '../batch-key.js';
import { encode, type BatchRunMessage } from '../message.js';
import type { MessageHandler } from '../transport.js';

/**
 * What must be true of the nightly trigger under **any** at-least-once
 * transport.
 *
 * Bound twice: to `LocalTransport`, which is no dependency at all and is the
 * control, and to the real Pub/Sub emulator. That is the same instrument
 * `adk/src/__tests__/host-contract.ts` is, for the same reason — a rule that has
 * only ever been observed under one vendor's client is a description of that
 * client. Running it against a queue this repo wrote is what makes these
 * Virgil's rules.
 *
 * The store is `MemoryStore` — the `Store` oracle the Firestore adapter will be
 * held to. The guard reads the batch-idempotency contract’s key through it, so the delivery side is
 * tested against the same reference implementation the write side will be.
 */

// ------------------------------------------------------------------- harness

export interface BoundTransport {
  /** Publish a well-formed trigger. Returns the transport's message id. */
  publish(message: BatchRunMessage): Promise<string>;
  /** Publish bytes. The poison path. */
  publishRaw(data: Uint8Array, attributes?: Record<string, string>): Promise<string>;
  /** Begin delivering. */
  start(handler: MessageHandler): Promise<void>;
  /** Resolve once the handler has been invoked at least `n` times in total. */
  settle(n: number): Promise<void>;
  /**
   * Deliver an already-acked message again.
   *
   * At-least-once permits it; no broker can be *asked* for it. Only the local
   * queue can, so the contract skips this case where it is unavailable and says
   * so rather than pretending it was covered.
   */
  forceRedeliver: ((messageId: string) => Promise<void>) | null;
  close(): Promise<void>;
}

export interface TransportHarness {
  readonly kind: string;
  /** A fresh transport with an empty topic and subscription. */
  create(): Promise<BoundTransport>;
}

// ---------------------------------------------------------------- test fixture

const SCHEDULED = '2026-08-20T03:00:00.000Z';
/** boundaryHours 6 puts a 03:00Z run under the previous day. */
const KEY_FOR_SCHEDULED: BatchKey = '2026-08-19';

const trigger = (scheduledAt?: string): BatchRunMessage =>
  scheduledAt === undefined
    ? { v: 1, kind: 'nightly-run' }
    : { v: 1, kind: 'nightly-run', scheduledAt };

/** A minimal real `Session`. The trigger never reads its contents — only
 *  whether a row exists under the night's key — but it is built to the domain
 *  type so a change to that type fails here rather than passing on a cast. */
function sessionRow(id: string): Session {
  return {
    id,
    builtAt: SCHEDULED,
    fromPinCount: 0,
    targetMinutes: 15,
    estimatedMinutes: 0,
    sections: [],
    currentSectionIndex: 0,
    closingNote: null,
  };
}

interface Rig {
  readonly store: MemoryStore;
  readonly reports: TriggerReport[];
  readonly nights: BatchKey[];
  readonly handler: MessageHandler;
}

/**
 * A handler over a night that writes a session under the batch-idempotency contract’s key.
 *
 * `outcome` decides what the night reports; `onRun` can throw to simulate the
 * infrastructure failure. The night is not a real `runBatch` — an eight-minute
 * pipeline inside a delivery test would be testing the pipeline — but it does
 * the one thing the guard reads: it writes the row.
 */
function rig(opts: {
  outcome?: (key: BatchKey) => BatchOutcome;
  onRun?: (key: BatchKey, n: number) => void;
  maxAttempts?: number;
} = {}): Rig {
  const store = new MemoryStore();
  const reports: TriggerReport[] = [];
  const nights: BatchKey[] = [];
  const outcome = opts.outcome ?? ((key: BatchKey): BatchOutcome => ({ kind: 'session', sessionId: sessionIdForBatch(key) }));

  const handler = nightlyTriggerHandler({
    guard: new StoreBatchGuard(store, opts.maxAttempts === undefined ? {} : { maxAttempts: opts.maxAttempts }),
    report: (r) => reports.push(r),
    run: async ({ batchKey }) => {
      nights.push(batchKey);
      opts.onRun?.(batchKey, nights.length);
      const out = outcome(batchKey);
      // The batch-key alignment contract: the night the run was told to build travels with the row it
      // writes. A stub that dropped it would be testing a pipeline this repo no
      // longer has.
      if (out.kind === 'session') await store.putSession({ ...sessionRow(out.sessionId), batchKey });
      return out;
    },
  });

  return { store, reports, nights, handler };
}

const sessionIds = async (store: MemoryStore): Promise<string[]> =>
  (await store.listSessions()).map((s) => s.id).sort();

// ------------------------------------------------------------------- the rules

export function runHandlerContract(harness: TransportHarness): void {
  const name = (s: string): string => `[${harness.kind}] ${s}`;

  test(name('publish -> deliver -> the night runs once and the message is acked'), async () => {
    const r = rig();
    const t = await harness.create();
    try {
      await t.start(r.handler);
      await t.publish(trigger(SCHEDULED));
      await t.settle(1);

      assert.deepEqual(r.nights, [KEY_FOR_SCHEDULED], 'exactly one night, keyed off the message');
      assert.equal(r.reports[0]?.outcome, 'ran-session');
      assert.equal(r.reports[0]?.decision, 'ack');
      assert.deepEqual(await sessionIds(r.store), [sessionIdForBatch(KEY_FOR_SCHEDULED)]);
    } finally { await t.close(); }
  });

  test(name('the night key comes off the message, so a redelivery names the same night'), async () => {
    /**
     * The sentence the whole design turns on, asserted rather than asserted
     * about. The second delivery happens later in wall-clock time than the
     * first — if the key were derived from receipt, this is where it would
     * diverge, and the session count below would be two.
     */
    const r = rig();
    const t = await harness.create();
    try {
      await t.start(r.handler);
      const id = await t.publish(trigger(SCHEDULED));
      await t.settle(1);

      if (!t.forceRedeliver) {
        assert.ok(true, 'forced redelivery is not available on this transport — covered by the local control');
        return;
      }
      await t.forceRedeliver(id);
      await t.settle(2);

      assert.equal(r.reports.length, 2, 'the message was delivered twice');
      assert.equal(r.reports[0]?.batchKey, r.reports[1]?.batchKey, 'and both deliveries named the same night');
      assert.deepEqual(r.nights, [KEY_FOR_SCHEDULED], 'the night ran ONCE');
      assert.equal(r.reports[1]?.outcome, 'skipped-already-built');
      assert.equal(r.reports[1]?.decision, 'ack');
      assert.deepEqual(await sessionIds(r.store), [sessionIdForBatch(KEY_FOR_SCHEDULED)],
        'one night, one session row — the batch-idempotency contract held from the delivery side');
    } finally { await t.close(); }
  });

  test(name('two different messages for the SAME night still run it once'), async () => {
    // The realistic production duplicate: Cloud Scheduler retried and published
    // a second message. Two message ids, one night. This is why the idempotency
    // key is the night and not the message id.
    const r = rig();
    const t = await harness.create();
    try {
      await t.start(r.handler);
      const a = await t.publish(trigger(SCHEDULED));
      await t.settle(1);
      const b = await t.publish(trigger('2026-08-20T03:04:00.000Z'));
      await t.settle(2);

      assert.notEqual(a, b, 'two distinct messages');
      assert.deepEqual(r.nights, [KEY_FOR_SCHEDULED], 'one night');
      assert.equal(r.reports[1]?.outcome, 'skipped-already-built');
      assert.deepEqual(await sessionIds(r.store), [sessionIdForBatch(KEY_FOR_SCHEDULED)]);
    } finally { await t.close(); }
  });

  test(name('a night already in the store is recognised whatever the store named its row'), async () => {
    /**
     * The cross-lane case, and the reason the guard does not key on a session
     * id it invented.
     *
     * The Firestore adapter (`port/firestore`, the batch-idempotency contract) makes the *document
     * name* `batchKeyOf(builtAt)` — the plain UTC date, no prefix — while
     * `getSession(id)` looks the row up **by the `id` field**, which is still a
     * UUID. A guard that asked `getSession('night-2026-08-19')` would get
     * `null` from that adapter every single time, and every redelivery would
     * re-run a night that was already built.
     *
     * So the question is asked of the domain instead: is there a session whose
     * `builtAt` falls inside this night? That is true of `MemoryStore`,
     * `JsonStore` and Firestore alike, because `builtAt` is a field of the
     * domain type rather than a naming convention either lane chose.
     */
    const r = rig();
    // A row that neither lane would name `night-2026-08-19`.
    await r.store.putSession({ ...sessionRow('7f3c1a90-0000-4000-8000-000000000000'), builtAt: SCHEDULED });

    const t = await harness.create();
    try {
      await t.start(r.handler);
      await t.publish(trigger(SCHEDULED));
      await t.settle(1);

      assert.equal(r.reports[0]?.outcome, 'skipped-already-built');
      assert.equal(r.reports[0]?.decision, 'ack');
      assert.deepEqual(r.nights, [], 'the night was NOT re-run');
    } finally { await t.close(); }
  });

  test(name('a night that names itself is recognised by that name, not by the clock it finished on'), async () => {
    /**
     * **The batch-key alignment contract, from the delivery side.**
     *
     * The row below is what a retry across midnight leaves: built at 07:00 —
     * inside the *next* night by the rule in force — and carrying `batchKey`
     * to say which night it was actually for. Before the field existed the
     * guard had only `builtAt`, read it as a different night, and re-ran a
     * night that was already built and paid for: eleven model calls and eight
     * minutes, every delivery, for ever.
     *
     * The field is asked first and `builtAt` is not asked at all. That is the
     * difference between a defect made impossible and a defect made unlikely.
     */
    const r = rig();
    await r.store.putSession({
      ...sessionRow('9c2f5b10-0000-4000-8000-000000000000'),
      builtAt: '2026-08-20T07:00:00.000Z',
      batchKey: KEY_FOR_SCHEDULED,
    });

    const t = await harness.create();
    try {
      await t.start(r.handler);
      await t.publish(trigger(SCHEDULED));
      await t.settle(1);

      assert.equal(r.reports[0]?.outcome, 'skipped-already-built',
        'the night said which night it was, and the guard believed it');
      assert.deepEqual(r.nights, [], 'so nothing was re-run');
    } finally { await t.close(); }
  });

  test(name('a session that names ANOTHER night does not answer for this one'), async () => {
    const r = rig();
    await r.store.putSession({
      ...sessionRow('4d1e7a30-0000-4000-8000-000000000000'),
      // Inside night 2026-08-20 by builtAt; for night 2026-08-19 by its own account.
      builtAt: '2026-08-21T07:00:00.000Z',
      batchKey: KEY_FOR_SCHEDULED,
    });

    const t = await harness.create();
    try {
      await t.start(r.handler);
      await t.publish(trigger('2026-08-21T03:00:00.000Z'));
      await t.settle(1);

      assert.deepEqual(r.nights, ['2026-08-20'],
        'the 20th ran — a row belonging to the 19th does not get to answer for it');
      assert.equal(r.reports[0]?.outcome, 'ran-session');
    } finally { await t.close(); }
  });

  test(name('two DIFFERENT nights are two sessions'), async () => {
    // The mutation check on every assertion above. A guard that collapsed
    // everything onto one night would pass all of them.
    const r = rig();
    const t = await harness.create();
    try {
      await t.start(r.handler);
      await t.publish(trigger(SCHEDULED));
      await t.settle(1);
      await t.publish(trigger('2026-08-21T03:00:00.000Z'));
      await t.settle(2);

      assert.deepEqual(r.nights, ['2026-08-19', '2026-08-20'], 'two nights, in order');
      assert.deepEqual(await sessionIds(r.store), ['night-2026-08-19', 'night-2026-08-20']);
    } finally { await t.close(); }
  });

  test(name('a night that honestly produced nothing is ACKED and not redelivered'), async () => {
    /**
     * the delivery-safety contract and withheld-content contract. `nothing-to-teach` and `model-failed` are runs that
     * happened; failure to produce is not failure to process. Nacking would ask
     * the platform to redeliver so the fleet could spend eleven more model calls
     * arriving at the same true answer.
     */
    const r = rig({ outcome: () => ({ kind: 'no-session', reason: 'nothing-to-teach' }) });
    const t = await harness.create();
    try {
      await t.start(r.handler);
      await t.publish(trigger(SCHEDULED));
      await t.settle(1);

      assert.equal(r.reports[0]?.outcome, 'ran-no-session');
      assert.equal(r.reports[0]?.decision, 'ack');
      assert.deepEqual(await sessionIds(r.store), [], 'and nothing was persisted');

      // The observable half: nothing comes back.
      await new Promise((res) => setTimeout(res, 250));
      assert.equal(r.reports.length, 1, 'an acked message is not redelivered');
      assert.deepEqual(r.nights, [KEY_FOR_SCHEDULED], 'so the night did not run twice');
    } finally { await t.close(); }
  });

  test(name('a quota-degraded night is ACKED — the correction is not undone by a retry'), async () => {
    /**
     * the transport contract the quota-retry policy, as implemented in
     * `adk/src/errors.ts`: a spent daily cap degrades and marks the later stages
     * not-attempted rather than retrying until morning. A degraded night that
     * nacked would hand that decision straight back to the platform, which would
     * redeliver within seconds — the retry storm the correction exists to
     * prevent, arriving through a door the correction does not watch.
     */
    const r = rig({ outcome: () => ({ kind: 'degraded', reason: 'quota-exhausted' }) });
    const t = await harness.create();
    try {
      await t.start(r.handler);
      await t.publish(trigger(SCHEDULED));
      await t.settle(1);

      assert.equal(r.reports[0]?.outcome, 'ran-degraded');
      assert.equal(r.reports[0]?.decision, 'ack');

      await new Promise((res) => setTimeout(res, 250));
      assert.equal(r.nights.length, 1, 'the spent quota was not retried until morning');
    } finally { await t.close(); }
  });

  test(name('a handler that crashes does NOT ack, and the message comes back'), async () => {
    // The one nack. Nothing was decided, so redelivery is the correct answer —
    // and it has to be observable, or "we nack on infrastructure failure" is a
    // sentence with no evidence behind it.
    const r = rig({
      onRun: (_key, n) => { if (n === 1) throw new Error('the store fell over'); },
    });
    const t = await harness.create();
    try {
      await t.start(r.handler);
      await t.publish(trigger(SCHEDULED));
      await t.settle(2);

      assert.equal(r.reports[0]?.outcome, 'infra-failure');
      assert.equal(r.reports[0]?.decision, 'nack', 'nothing was decided, so nothing is acked');
      assert.equal(r.reports[1]?.outcome, 'ran-session', 'the redelivery completed the night');
      assert.equal(r.reports[1]?.batchKey, KEY_FOR_SCHEDULED, 'under the same key it always had');
      assert.deepEqual(await sessionIds(r.store), [sessionIdForBatch(KEY_FOR_SCHEDULED)],
        'one night, one row — the crash cost an attempt and not a duplicate');
    } finally { await t.close(); }
  });

  test(name('a night that keeps crashing is abandoned rather than retried for ever'), async () => {
    /**
     * Production answers this with a dead-letter topic. Nothing guarantees one
     * exists on day one, and eight minutes of model calls per attempt is a bill
     * rather than an inconvenience — so the cap is enforced here too.
     */
    const r = rig({ onRun: () => { throw new Error('deterministically broken'); }, maxAttempts: 2 });
    const t = await harness.create();
    try {
      await t.start(r.handler);
      await t.publish(trigger(SCHEDULED));
      await t.settle(3);

      assert.equal(r.nights.length, 2, 'attempted twice, and the cap is two');
      const last = r.reports[r.reports.length - 1];
      assert.equal(last?.outcome, 'abandoned');
      assert.equal(last?.decision, 'ack', 'abandoning means the message stops coming back');
    } finally { await t.close(); }
  });

  test(name('bytes that are not a trigger are acked and reported, never looped on'), async () => {
    // A message that cannot be decoded will not decode on the ninth delivery
    // either. Without a dead-letter topic there is nowhere for it to go, so the
    // default drops it loudly rather than looping over bytes nobody can read.
    const r = rig();
    const t = await harness.create();
    try {
      await t.start(r.handler);
      await t.publishRaw(new TextEncoder().encode('{not json'));
      await t.settle(1);

      assert.equal(r.reports[0]?.outcome, 'undeliverable');
      assert.equal(r.reports[0]?.decision, 'ack');
      assert.match(String(r.reports[0]?.detail), /unparseable/);
      assert.deepEqual(r.nights, [], 'and no night was run on it');
    } finally { await t.close(); }
  });

  test(name('a message from a newer publisher is named as a version skew'), async () => {
    const r = rig();
    const t = await harness.create();
    try {
      await t.start(r.handler);
      const { data } = encode({ v: 2, kind: 'nightly-run' } as unknown as BatchRunMessage);
      await t.publishRaw(data, { v: '2', kind: 'nightly-run' });
      await t.settle(1);

      assert.equal(r.reports[0]?.outcome, 'undeliverable');
      assert.match(String(r.reports[0]?.detail), /unknown-version/,
        'not "malformed" — a newer publisher is a deployment fact, and the difference is the ack decision');
    } finally { await t.close(); }
  });

  test(name('a trigger with no timestamp is keyed from the message publish time'), async () => {
    /**
     * The production path, not a fallback. Cloud Scheduler's `--message-body` is
     * a static string fixed when the job is created; it does not template the
     * fire time in. So a real Scheduler trigger carries no `scheduledAt` at all,
     * and the publish time — stamped once by Pub/Sub and repeated on every
     * redelivery — is the only message-intrinsic instant there is.
     */
    const r = rig();
    const t = await harness.create();
    try {
      await t.start(r.handler);
      await t.publish(trigger());
      await t.settle(1);

      assert.equal(r.reports[0]?.keySource, 'publishTime');
      assert.match(String(r.reports[0]?.batchKey), /^\d{4}-\d{2}-\d{2}$/, 'a real night, from the broker’s own stamp');
      assert.equal(r.nights.length, 1);
    } finally { await t.close(); }
  });
}
