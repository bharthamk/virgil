import test from 'node:test';
import assert from 'node:assert/strict';

import { LocalTransport } from '../local-transport.js';
import type { MessageHandler } from '../transport.js';
import type { BatchRunMessage } from '../message.js';
import { runHandlerContract, type BoundTransport, type TransportHarness } from './handler-contract.js';

/**
 * The control: the whole contract, against no dependency at all.
 *
 * This file is what makes the assertions in `handler-contract.ts` *Virgil's
 * rules* rather than observations about Google's client. It is also the fallback
 * if the dependency is declined, and — because a hand-written queue can be told
 * to do things no broker can be asked for — it is the only place the
 * after-the-ack redelivery case is reachable at all.
 *
 * Every publish time is stamped from an injected clock that advances by an hour
 * per message, deliberately: if the night key were ever derived from receipt
 * rather than from the message, a redelivery an hour later would name a
 * different night and the contract's redelivery test would fail here first.
 */

class LocalHarness implements TransportHarness {
  readonly kind = 'local';

  async create(): Promise<BoundTransport> {
    let tick = 0;
    const transport = new LocalTransport({
      now: () => new Date(Date.parse('2026-08-20T03:00:00.000Z') + tick++ * 3_600_000),
      redeliverLimit: 6,
    });
    let started = false;

    const drainIfStarted = async (): Promise<void> => { if (started) await transport.drain(); };

    return {
      publish: async (m: BatchRunMessage): Promise<string> => {
        const id = transport.enqueueNew(m);
        await drainIfStarted();
        return id;
      },
      publishRaw: async (data: Uint8Array, attributes: Record<string, string> = {}): Promise<string> => {
        const id = transport.enqueueRaw(data, attributes);
        await drainIfStarted();
        return id;
      },
      start: async (handler: MessageHandler): Promise<void> => {
        await transport.subscribe(handler);
        started = true;
      },
      // Delivery is synchronous here, so settling is drain-to-empty. The count
      // is not waited on: if it has not happened by now it is not going to, and
      // a test that hangs waiting says less than one that fails an assertion.
      settle: async (): Promise<void> => { await drainIfStarted(); },
      forceRedeliver: async (messageId: string): Promise<void> => {
        transport.redeliver(messageId);
        await drainIfStarted();
      },
      close: async (): Promise<void> => {},
    };
  }
}

runHandlerContract(new LocalHarness());

// ------------------------------------------- the queue's own laws, asserted once

test('the queue really is at-least-once — a nack puts the message back', async () => {
  // The contract leans on this. A queue that quietly dropped nacked messages
  // would make the crash test pass for the wrong reason.
  const t = new LocalTransport({ redeliverLimit: 3 });
  let seen = 0;
  await t.subscribe(async () => { seen += 1; return seen < 3 ? 'nack' : 'ack'; });
  t.enqueueNew({ v: 1, kind: 'nightly-run' });
  const records = await t.drain();

  assert.equal(seen, 3);
  assert.deepEqual(records.map((r) => r.decision), ['nack', 'nack', 'ack']);
  assert.deepEqual(records.map((r) => r.attempt), [1, 2, 3]);
  assert.equal(t.pending, 0);
});

test('a handler that throws is the transport’s problem, and counts as not-acked', async () => {
  const t = new LocalTransport({ redeliverLimit: 2 });
  let calls = 0;
  await t.subscribe(async () => { calls += 1; throw new Error('boom'); });
  t.enqueueNew({ v: 1, kind: 'nightly-run' });
  const records = await t.drain();

  assert.equal(calls, 2, 'redelivered up to the limit');
  assert.deepEqual(records.map((r) => r.decision), ['threw', 'threw']);
});

test('publish time is stamped once and repeated on every redelivery', async () => {
  /**
   * The property the night key rests on, checked at the queue rather than
   * inferred from the key. A queue that restamped on the way out would give a
   * redelivered message a new night and nothing else here would say why.
   */
  let tick = 0;
  const t = new LocalTransport({ now: () => new Date(1_000_000 + tick++ * 60_000) });
  const stamps: number[] = [];
  await t.subscribe(async (m) => { stamps.push(m.publishTime.getTime()); return 'ack'; });
  const id = t.enqueueNew({ v: 1, kind: 'nightly-run' });
  await t.drain();
  t.redeliver(id);
  await t.drain();

  assert.equal(stamps.length, 2);
  assert.equal(stamps[0], stamps[1], 'the same instant, twice');
});

test('delivery attempt can be withheld, the way a subscription without a DLQ withholds it', async () => {
  // Pub/Sub stamps `delivery_attempt` only when a dead-letter policy exists, so
  // the absent case has to be reachable or the guard's "unknown is not zero"
  // rule is untested.
  const t = new LocalTransport({ reportDeliveryAttempt: false, redeliverLimit: 2 });
  const attempts: (number | null)[] = [];
  await t.subscribe(async (m) => { attempts.push(m.deliveryAttempt); return 'nack'; });
  t.enqueueNew({ v: 1, kind: 'nightly-run' });
  await t.drain();

  assert.deepEqual(attempts, [null, null]);
});
