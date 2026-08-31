import test from 'node:test';
import assert from 'node:assert/strict';

import { triggerConfigFromEnv, type TriggerConfig } from '../config.js';
import {
  PUBSUB_MODULE, PUBSUB_PINNED_VERSION, ProductionNotPermittedError, PubSubTransport,
  REQUIRED_PUBSUB_EXPORTS, pubsubAvailable, toDelivered,
} from '../pubsub-binding.js';
import type { MessageHandler } from '../transport.js';
import type { BatchRunMessage } from '../message.js';
import { encode } from '../message.js';
import { runHandlerContract, type BoundTransport, type TransportHarness } from './handler-contract.js';

/**
 * The same contract, against the real thing.
 *
 * ## The gate, and why it is not `LIVE=1`
 *
 * `gemini-live.test.ts` gates on `LIVE=1` because what it needs is *permission
 * to spend money*. Nothing here can spend anything: the only endpoint this file
 * will talk to is a Java process on this laptop, and the binding refuses to
 * construct a transport for a real project without an explicit
 * `allowProduction` (asserted below).
 *
 * So the gate is the thing that is actually required — **`PUBSUB_EMULATOR_HOST`
 * being set, and the package being resolvable.** That variable is Google's own
 * mechanism for selecting the emulator and for making the client skip
 * authentication entirely, so gating on it cannot drift out of step with what
 * the client does. It is also distinct from the Firestore lane's
 * `FIRESTORE_EMULATOR_HOST` by construction, which matters because both
 * emulators may be running side by side.
 *
 *     gcloud components install beta pubsub-emulator
 *     JAVA_HOME=$(brew --prefix openjdk) \
 *       gcloud beta emulators pubsub start --project=virgil-local --host-port=127.0.0.1:8681
 *
 *     npm install --no-save @google-cloud/pubsub@6.0.1
 *     PUBSUB_EMULATOR_HOST=127.0.0.1:8681 PUBSUB_PROJECT_ID=virgil-local npm test
 *
 * Port 8681 rather than the emulator's default `[::1]:8085`, deliberately, for
 * two reasons: the Firestore lane runs its own emulator concurrently, and the
 * documented default binds **IPv6 loopback**, which a client dialling
 * `127.0.0.1` does not reach.
 *
 * Without the gate the file skips and says what it did not check, which is the
 * honest state rather than a file nobody notices.
 *
 * ## What this proves that the local control cannot
 *
 * That the ack policy is expressed in operations a real broker recognises — that
 * `ack()` genuinely stops redelivery, that `nack()` genuinely causes it, and
 * that the publish time the night key is derived from is a real Pub/Sub
 * timestamp rather than one this repo invented. Everything else in the contract
 * is a rule, and rules are proven by the control.
 */

const emulatorHost = process.env['PUBSUB_EMULATOR_HOST'];
const available = await pubsubAvailable();
const enabled = Boolean(emulatorHost) && available;

const why = !emulatorHost
  ? 'PUBSUB_EMULATOR_HOST is not set — start the emulator and point this at it'
  : `${PUBSUB_MODULE} is not installed — npm install --no-save ${PUBSUB_MODULE}@${PUBSUB_PINNED_VERSION}`;

// -------------------------------------------------- unconditional, no emulator

test('the binding refuses to reach a real project by accident', async () => {
  /**
   * Fails closed, the way `adk/src/config.ts`'s `allowNetwork` does. An
   * exported `GOOGLE_CLOUD_PROJECT` on somebody's laptop is not a decision to
   * talk to Google Cloud; local-only behavior is enforced by code.
   */
  const production: TriggerConfig = {
    ...triggerConfigFromEnv({ GOOGLE_CLOUD_PROJECT: 'virgil-prod' }),
    emulatorHost: null,
  };
  await assert.rejects(
    () => PubSubTransport.create(production),
    ProductionNotPermittedError,
  );
});

test('a delivery attempt of zero is reported as unknown, not as a first delivery', () => {
  /**
   * Pub/Sub stamps `delivery_attempt` **only when the subscription has a
   * dead-letter policy**; without one it is 0. Reading that 0 as "attempt
   * number zero" would make every delivery on a DLQ-less subscription look like
   * the first, which silently disables the guard's attempt cap on exactly the
   * subscriptions that have no dead-letter topic to fall back on.
   *
   * <https://docs.cloud.google.com/pubsub/docs/handling-failures>
   */
  const message = {
    id: 'm1',
    data: Buffer.from('{}'),
    attributes: {},
    publishTime: new Date('2026-08-20T03:00:00Z'),
    deliveryAttempt: 0,
    ack: (): void => {},
    nack: (): void => {},
  };
  assert.equal(toDelivered(message).deliveryAttempt, null);
  assert.equal(toDelivered({ ...message, deliveryAttempt: 3 }).deliveryAttempt, 3);
});

test('the emulator suite reports what it did not check', { skip: enabled ? false : why }, () => {
  assert.ok(enabled);
});

// ------------------------------------------------------------------- the harness

interface Module {
  PubSub: new (opts: Record<string, unknown>) => {
    topic(name: string): {
      publishMessage(m: { data: Buffer; attributes: Record<string, string> }): Promise<string>;
    };
    close(): Promise<void>;
  };
}

let seq = 0;

class EmulatorHarness implements TransportHarness {
  readonly kind = 'pubsub-emulator';

  async create(): Promise<BoundTransport> {
    // A fresh topic and subscription per test. The emulator retains messages
    // indefinitely (configurable retention is one of its documented gaps), so a
    // shared topic would leak one test's leftovers into the next.
    const n = ++seq;
    const base = triggerConfigFromEnv(process.env);
    const config: TriggerConfig = {
      ...base,
      topic: `${base.topic}-t${n}`,
      subscription: `${base.subscription}-t${n}`,
      // The contract's crash test needs two deliveries of one message; the
      // abandon test needs three. The emulator redelivers a nacked message
      // promptly, so nothing here waits on a backoff.
      maxAttempts: 2,
    };

    const transport = await PubSubTransport.create(config);
    await transport.ensure();
    const publisher = await transport.publisher();

    const mod = await import(PUBSUB_MODULE) as unknown as Module;
    const rawClient = new mod.PubSub({ projectId: config.projectId });

    let handled = 0;
    let subscription: { close(): Promise<void> } | null = null;

    return {
      publish: (m: BatchRunMessage): Promise<string> => publisher.publish(m),
      publishRaw: async (data: Uint8Array, attributes: Record<string, string> = {}): Promise<string> =>
        rawClient.topic(config.topic).publishMessage({ data: Buffer.from(data), attributes }),
      start: async (handler: MessageHandler): Promise<void> => {
        subscription = await transport.subscribe(async (m) => {
          const decision = await handler(m);
          handled += 1;
          return decision;
        });
      },
      /**
       * Streaming pull is asynchronous, so settling is a poll rather than a
       * drain. Twenty seconds is generous for a loopback broker and is a
       * failure bound, not an expectation — every case here settles in
       * milliseconds when it settles at all.
       */
      settle: async (n: number): Promise<void> => {
        const deadline = Date.now() + 20_000;
        while (handled < n && Date.now() < deadline) {
          await new Promise((res) => setTimeout(res, 25));
        }
        assert.ok(handled >= n, `only ${handled} of ${n} deliveries arrived within 20s`);
      },
      // No broker can be asked to redeliver an acked message. Said rather than
      // faked; the local control covers it.
      forceRedeliver: null,
      close: async (): Promise<void> => {
        await subscription?.close();
        await rawClient.close();
        await transport.close();
      },
    };
  }
}

if (enabled) {
  test('the hand-written client surface matches the installed package', async () => {
    // The cost of not declaring the dependency is that the interface in
    // `pubsub-binding.ts` is a copy, and a copy can go stale. This is what makes
    // it a transcription rather than a guess.
    const mod = await import(PUBSUB_MODULE) as Record<string, unknown>;
    for (const name of REQUIRED_PUBSUB_EXPORTS) {
      assert.notEqual(mod[name], undefined, `${PUBSUB_MODULE} no longer exports ${name}`);
    }
    const pkg = await import(`${PUBSUB_MODULE}/package.json`, { with: { type: 'json' } }) as
      { default: { version: string; engines?: { node?: string } } };
    assert.equal(pkg.default.version, PUBSUB_PINNED_VERSION,
      'the binding is pinned to a version that is not the one installed');
    assert.match(String(pkg.default.engines?.node), />=\s*22/,
      '6.x requires Node >= 22 — a deployment on 20 would fail at install, not at run');
  });

  test('a published message comes back with a real publish time', async () => {
    // The fact the whole night key rests on, taken from the broker rather than
    // from anything this repo wrote.
    const harness = new EmulatorHarness();
    const t = await harness.create();
    try {
      const stamps: Date[] = [];
      await t.start(async (m) => { stamps.push(m.publishTime); return 'ack'; });
      const before = Date.now();
      await t.publish({ v: 1, kind: 'nightly-run' });
      await t.settle(1);

      const stamp = stamps[0] as Date;
      assert.ok(Number.isFinite(stamp.getTime()), 'a real instant');
      assert.ok(Math.abs(stamp.getTime() - before) < 60_000, 'stamped around now, by the broker');
    } finally { await t.close(); }
  });

  test('the encoded body survives the broker byte for byte', async () => {
    const harness = new EmulatorHarness();
    const t = await harness.create();
    try {
      const seen: string[] = [];
      const attrs: Record<string, string>[] = [];
      await t.start(async (m) => {
        seen.push(new TextDecoder().decode(m.data));
        attrs.push({ ...m.attributes });
        return 'ack';
      });
      const message: BatchRunMessage = { v: 1, kind: 'nightly-run', scheduledAt: '2026-08-20T03:00:00.000Z' };
      await t.publish(message);
      await t.settle(1);

      assert.equal(seen[0], new TextDecoder().decode(encode(message).data));
      assert.deepEqual(attrs[0], { v: '1', kind: 'nightly-run' },
        'and the attributes arrive as attributes, which is what a filter would match on');
    } finally { await t.close(); }
  });

  runHandlerContract(new EmulatorHarness());
}
