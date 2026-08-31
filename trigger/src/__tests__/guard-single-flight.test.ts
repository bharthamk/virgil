import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStore } from '@sb/adapters/dist/__tests__/memory-store.js';
import type { Session, SessionId } from '@sb/core';

import { StoreBatchGuard } from '../guard.js';
import { sessionIdForBatch, type BatchKey } from '../batch-key.js';

/**
 * **The single-flight claim, held to the promise the guard's own header makes.**
 *
 * `guard.ts` says, of two processes racing on one night, that "within one
 * process the single-flight map below closes it". That sentence was false for
 * as long as it had been written. The claim was added *after* `builtBatchKey`
 * had been awaited, and `begin` is async, so the store read is a suspension
 * point: two Pub/Sub deliveries of one night arriving in the same tick both
 * passed the `has` check, both suspended inside the read, both saw no session
 * and both were told to run. Two full nightlies for one night — eleven model
 * calls and eight minutes apiece — with every existing test green, because
 * every existing test delivered its messages one after another and the map was
 * never asked to do the one thing it was there for.
 *
 * The contract file next door proves the *sequential* rules of the trigger
 * against real transports. This file proves the concurrent one, and it is
 * separate because it needs something no transport will give it: a store read
 * that can be held open while a second delivery walks into it. `LatchedStore`
 * is `MemoryStore` — the same oracle the rest of the trigger suite reads
 * through — with a gate in front of `listSessions`, so nothing about the domain
 * is faked and only the timing is authored.
 *
 * The other half of the fix is release. A claim taken before the decision has
 * to be given back on every path that does not hand it to a run, or an
 * `already-built` night is marked in-flight for the life of the process and
 * every later delivery is answered with a lie about work that is not
 * happening. Three of the tests below are about the giving back.
 */

const SCHEDULED = '2026-08-20T03:00:00.000Z';
const KEY: BatchKey = '2026-08-19';

/** A minimal real `Session`, built to the domain type so a change to it fails
 *  here rather than passing on a cast. Same shape the handler contract uses. */
function sessionRow(id: string, batchKey: BatchKey): Session {
  return {
    id,
    builtAt: SCHEDULED,
    batchKey,
    fromPinCount: 0,
    targetMinutes: 15,
    estimatedMinutes: 0,
    sections: [],
    currentSectionIndex: 0,
    closingNote: null,
  };
}

/**
 * `MemoryStore` with a hand on the tap.
 *
 * `hold()` makes the next reads block until `release()`; every read that
 * arrives while the tap is shut is counted, which is how the tests below know
 * both deliveries really were inside the read together rather than merely
 * appearing to be. `failNextRead` covers the path where the store falls over
 * mid-decision — a claim has been taken by then, and a throw must not keep it.
 */
class LatchedStore extends MemoryStore {
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;
  /** How many reads have entered the shut tap. */
  arrivals = 0;
  failNextRead = false;

  hold(): void {
    this.gate = new Promise<void>((resolve) => { this.open = resolve; });
  }

  release(): void {
    this.open?.();
    this.gate = null;
    this.open = null;
  }

  private async pause(): Promise<void> {
    if (this.gate === null) return;
    this.arrivals += 1;
    await this.gate;
  }

  override async getSession(id: SessionId): Promise<Session | null> {
    await this.pause();
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new Error('the store fell over');
    }
    return super.getSession(id);
  }

  override async listSessions(): Promise<readonly Session[]> {
    await this.pause();
    return super.listSessions();
  }
}

test('two deliveries of one night that race inside the store read produce exactly one run', async () => {
  /**
   * The defect, reproduced at the only moment it exists. The tap is shut before
   * either `begin`, so both are parked inside the store read at the same time —
   * which is the state the old ordering could not survive and the state a
   * redelivered Pub/Sub message reaches routinely, since Pub/Sub delivers
   * concurrently by default and a nightly is minutes long.
   */
  const store = new LatchedStore();
  const guard = new StoreBatchGuard(store);

  store.hold();
  const first = guard.begin(KEY, 1);
  const second = guard.begin(KEY, 1);
  await Promise.resolve();
  store.release();

  const verdicts = (await Promise.all([first, second])).map((d) => d.verdict).sort();
  assert.deepEqual(verdicts, ['in-flight', 'run'],
    'one delivery runs the night; the other is told the night is already running');
  assert.ok(store.arrivals >= 1, 'this test is meaningless unless a read really was held open — it was not');
});

test('the claim is taken before the store read, not after it', async () => {
  /**
   * The mutation check on the test above, asserted at the seam rather than
   * through it. A guard that claimed after the read would let the second
   * `begin` return before the tap ever opened only by not reading at all; here
   * the second delivery answers `in-flight` **while the first is still parked**,
   * which is only possible if the claim was recorded before the suspension.
   */
  const store = new LatchedStore();
  const guard = new StoreBatchGuard(store);

  store.hold();
  const first = guard.begin(KEY, 1);
  await Promise.resolve();
  const second = await guard.begin(KEY, 1);

  assert.equal(second.verdict, 'in-flight', 'answered without waiting for the first to finish deciding');
  store.release();
  assert.equal((await first).verdict, 'run');
});

test('an already-built night gives the claim back instead of wedging the key', async () => {
  /**
   * The cost of claiming early, paid. This night is built, so the correct
   * answer to every delivery of it is `already-built` — for ever, and from a
   * store read, not from a stale in-process flag. A guard that kept the claim
   * would answer the second delivery `in-flight` and report a night as running
   * when nothing is running at all.
   */
  const store = new LatchedStore();
  await store.putSession(sessionRow(sessionIdForBatch(KEY), KEY));
  const guard = new StoreBatchGuard(store);

  const first = await guard.begin(KEY, 1);
  const second = await guard.begin(KEY, 1);

  assert.equal(first.verdict, 'already-built');
  assert.equal(second.verdict, 'already-built', 'and not "in-flight" — the first delivery left no claim behind');
});

test('an abandoned night gives the claim back too', async () => {
  // The cap is reached before the store is ever read, so this is the early
  // return that a per-branch delete is likeliest to miss. It reports the cap
  // rather than a phantom run, on this delivery and on the next one.
  const store = new LatchedStore();
  const guard = new StoreBatchGuard(store, { maxAttempts: 2 });

  const first = await guard.begin(KEY, 5);
  const second = await guard.begin(KEY, 5);

  assert.equal(first.verdict, 'abandoned');
  assert.equal(second.verdict, 'abandoned', 'still the truth on the second ask');
});

test('a store that throws mid-decision does not leave the night claimed for ever', async () => {
  /**
   * The path that has no branch to hang a delete on. An infrastructure failure
   * inside the read is exactly the case the handler nacks and the platform
   * redelivers — so the redelivery must find the night runnable, not held by a
   * claim belonging to a delivery that died.
   */
  const store = new LatchedStore();
  const guard = new StoreBatchGuard(store);

  store.failNextRead = true;
  await assert.rejects(guard.begin(KEY, 1), /the store fell over/);

  const retry = await guard.begin(KEY, 2);
  assert.equal(retry.verdict, 'run', 'the redelivery can still build the night');
});

test('a run keeps its claim until finish() or fail() returns it', async () => {
  // The hand-off `handler.ts` depends on, in both directions. Without it the
  // early claim would be a lock nobody ever unlocks.
  const store = new LatchedStore();
  const guard = new StoreBatchGuard(store);

  assert.equal((await guard.begin(KEY, 1)).verdict, 'run');
  assert.equal((await guard.begin(KEY, 1)).verdict, 'in-flight', 'while the night is running');

  guard.finish(KEY);
  assert.equal((await guard.begin(KEY, 1)).verdict, 'run', 'and the key is free again afterwards');

  guard.fail(KEY);
  assert.equal((await guard.begin(KEY, 1)).verdict, 'run', 'a failed night releases it the same way');
});

test('two different nights do not block each other', async () => {
  // The claim is per night, and a guard that claimed globally would pass every
  // assertion above.
  const store = new LatchedStore();
  const guard = new StoreBatchGuard(store);

  store.hold();
  const a = guard.begin('2026-08-19', 1);
  const b = guard.begin('2026-08-20', 1);
  await Promise.resolve();
  store.release();

  assert.deepEqual((await Promise.all([a, b])).map((d) => d.verdict), ['run', 'run']);
});
