/**
 * The nightly trigger, on Google Cloud Pub/Sub.
 *
 * **This is the only file in the repository that names `@google-cloud/pubsub`,
 * and it is the only one that ever should be.** Everything else in this
 * workspace — the message schema, the night key, the ack policy, the guard, the
 * contract — is transport-neutral and is what the contract test runs against
 * `LocalTransport` as a control.
 *
 * ## Why the dependency is not declared
 *
 * The orchestration dependency boundary, applied to the second infra dependency of the port: `@google/adk`
 * is declared *in the commit where the ADK host becomes the nightly's real
 * entrypoint*, and until then it is opt-in via `--no-save`. The same reasoning
 * holds here and the same rule is applied, with one honest difference recorded
 * rather than hidden: this package is **73 transitive packages**, not 605, and
 * unlike ADK it is genuinely *runtime-required* for a deployed nightly rather
 * than an architectural choice. That makes it a better candidate for declaring —
 * and declaring it is still a decision that belongs to the deploy commit, not to
 * a preparation branch that deploys nothing. So:
 *
 *     npm install --no-save @google-cloud/pubsub@6.0.1   # opt in
 *     npm test                                            # the gated tests run
 *
 * Without it, and without a running emulator, the emulator suite skips and says
 * so. The offline suite is green either way and nobody pays for the install.
 *
 * ## Version facts, checked rather than remembered
 *
 * - `@google-cloud/pubsub` **6.0.1**, published 2026-08-12.
 * - **6.x requires Node >= 22** (5.3.1 was >= 18). A breaking jump.
 * - `github.com/googleapis/nodejs-pubsub` is **archived** and frozen at 5.3.1.
 *   Live source is `googleapis/google-cloud-node/tree/main/handwritten/pubsub`.
 *   Anyone reading the old repo will conclude 5.x is current; it is not.
 * - `maxExtension` no longer exists. It is **`maxExtensionTime`, a `Duration`**.
 *   `ackDeadline` has been dropped from the TypeScript `SubscriberOptions`; the
 *   JSDoc says new code should set `minAckDeadline`/`maxAckDeadline` directly.
 *
 * ## Nothing here holds a credential
 *
 * Against the emulator there is nothing to authenticate to: `PUBSUB_EMULATOR_HOST`
 * makes the client skip auth entirely. In production the client takes the job's
 * service account through Application Default Credentials, which is ambient to
 * the runtime and never a value this process reads. `config.test.ts` scans this
 * layer's sources for credential-shaped names.
 *
 * And it fails **closed**: constructing this transport without an emulator host
 * requires an explicit `allowProduction`, so a laptop with a stale
 * `GOOGLE_CLOUD_PROJECT` exported cannot reach a real project by accident. Same
 * instinct as `adk/src/config.ts`'s `allowNetwork`.
 */

import type { TriggerConfig } from './config.js';
import { encode, type DeliveredMessage, type BatchRunMessage } from './message.js';
import type {
  AckDecision, MessageHandler, TriggerPublisher, TriggerSubscription, TriggerTransport,
} from './transport.js';

/** Typed as `string` so `tsc` does not resolve the module at build time — the
 *  package is absent most of the time. Exported so the seam guard can assert
 *  exactly one file mentions it. */
export const PUBSUB_MODULE: string = '@google-cloud/pubsub';

/** The version this binding was written and proven against. */
export const PUBSUB_PINNED_VERSION = '6.0.1';

// ------------------------------------------------------------ the client surface

/**
 * The slice of the client this binding uses, transcribed from the installed
 * 6.0.1 declarations.
 *
 * Hand-written because the package is not a declared dependency — a real cost,
 * since a copy can go stale, which is why `pubsub-emulator.test.ts` checks every
 * name on it against the installed package when one is present. A structural
 * type nobody verifies is a guess.
 */
interface PubSubMessage {
  readonly id: string;
  readonly data: Buffer;
  readonly attributes: Record<string, string>;
  readonly publishTime: Date;
  readonly deliveryAttempt: number;
  ack(): void;
  nack(): void;
}

interface PubSubSubscription {
  on(event: 'message', cb: (m: PubSubMessage) => void): unknown;
  on(event: 'error', cb: (e: Error) => void): unknown;
  removeAllListeners(): unknown;
  close(): Promise<void>;
  exists(): Promise<[boolean]>;
}

interface PubSubTopic {
  exists(): Promise<[boolean]>;
  create(): Promise<unknown>;
  createSubscription(name: string, options: Record<string, unknown>): Promise<unknown>;
  publishMessage(m: { data: Buffer; attributes: Record<string, string> }): Promise<string>;
  subscription(name: string, options?: Record<string, unknown>): PubSubSubscription;
}

interface PubSubClient {
  topic(name: string): PubSubTopic;
  subscription(name: string, options?: Record<string, unknown>): PubSubSubscription;
  close(): Promise<void>;
}

interface DurationCtor {
  from(spec: { seconds?: number; minutes?: number }): unknown;
}

interface PubSubModule {
  readonly PubSub: new (opts: Record<string, unknown>) => PubSubClient;
  readonly Duration: DurationCtor;
  readonly Message: unknown;
}

/** Every export this binding depends on. Asserted one by one by the gated test. */
export const REQUIRED_PUBSUB_EXPORTS: readonly string[] = ['PubSub', 'Duration', 'Message'];

export class PubSubUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super(
      `${PUBSUB_MODULE} is not installed. The Pub/Sub transport is an opt-in dependency; `
      + `run \`npm install --no-save ${PUBSUB_MODULE}@${PUBSUB_PINNED_VERSION}\` to build it.`,
    );
    this.name = 'PubSubUnavailableError';
  }
}

export class ProductionNotPermittedError extends Error {
  constructor() {
    super(
      'the Pub/Sub transport was asked for a real project with no PUBSUB_EMULATOR_HOST set. '
      + 'Pass allowProduction: true in the composition root that means it — an exported '
      + 'GOOGLE_CLOUD_PROJECT is not a decision to talk to Google Cloud.',
    );
    this.name = 'ProductionNotPermittedError';
  }
}

export async function pubsubAvailable(): Promise<boolean> {
  try {
    await import(PUBSUB_MODULE);
    return true;
  } catch {
    return false;
  }
}

async function loadPubSub(): Promise<PubSubModule> {
  let mod: Record<string, unknown>;
  try {
    mod = await import(PUBSUB_MODULE) as Record<string, unknown>;
  } catch (err) {
    throw new PubSubUnavailableError(err);
  }
  const missing = REQUIRED_PUBSUB_EXPORTS.filter((n) => mod[n] === undefined);
  if (missing.length) {
    // Version skew said here rather than discovered later as `undefined is not
    // a constructor`. `Duration` is exactly the shape of export that a major
    // version moves, and 6.0.0 was a breaking release.
    throw new Error(
      `${PUBSUB_MODULE} is installed but does not export ${missing.join(', ')} — `
      + `this binding was written against ${PUBSUB_PINNED_VERSION}`,
    );
  }
  return mod as unknown as PubSubModule;
}

// -------------------------------------------------------------------- the binding

export interface PubSubTransportOptions {
  /** Required to reach anything that is not an emulator. Fails closed. */
  readonly allowProduction?: boolean;
}

export class PubSubTransport implements TriggerTransport {
  readonly kind = 'pubsub';

  private readonly subscriptions: PubSubSubscription[] = [];
  private readonly publishers: PubSubClient[] = [];

  private constructor(
    private readonly mod: PubSubModule,
    private readonly client: PubSubClient,
    private readonly config: TriggerConfig,
  ) {}

  static async create(config: TriggerConfig, opts: PubSubTransportOptions = {}): Promise<PubSubTransport> {
    if (config.emulatorHost === null && opts.allowProduction !== true) {
      throw new ProductionNotPermittedError();
    }
    const mod = await loadPubSub();
    /**
     * `projectId` only. The emulator is selected by `PUBSUB_EMULATOR_HOST`,
     * which is the client's own documented mechanism and the thing that makes
     * it skip authentication — passing `apiEndpoint` instead would point the
     * transport at the emulator while leaving the auth path live, which is a
     * request for credentials nobody has.
     *
     * <https://docs.cloud.google.com/pubsub/docs/emulator>
     */
    const client = new mod.PubSub({ projectId: config.projectId });
    return new PubSubTransport(mod, client, config);
  }

  /**
   * Creates the topic and the subscription if they are not there.
   *
   * Separate from `create` and idempotent, because it is the one operation that
   * is a *deployment* step in production — `gcloud pubsub topics create` in the
   * deploy commit, with IAM behind it — and a convenience only against the
   * emulator, which starts empty every time. Calling it in production is
   * harmless (it checks first) but it is not how the estate should be built.
   */
  async ensure(): Promise<{ topic: string; subscription: string }> {
    const topic = this.client.topic(this.config.topic);
    const [topicExists] = await topic.exists();
    if (!topicExists) await topic.create();

    const sub = this.client.subscription(this.config.subscription);
    const [subExists] = await sub.exists();
    if (!subExists) {
      await topic.createSubscription(this.config.subscription, {
        /**
         * The subscription-side half of holding an eight-minute job.
         *
         * 600s is the server maximum for a single ack deadline
         * (<https://docs.cloud.google.com/pubsub/docs/subscription-properties>),
         * so it cannot cover eight minutes with any margin on its own — the
         * client's lease management is what actually holds the message, and
         * this is the deadline it extends *from*. Set high anyway so that a
         * subscriber which dies mid-run does not release the message in ten
         * seconds and start a second night while the first is still shutting
         * down.
         */
        ackDeadlineSeconds: this.config.lease.ackDeadlineSeconds,
      });
    }
    return { topic: this.config.topic, subscription: this.config.subscription };
  }

  async publisher(): Promise<TriggerPublisher> {
    const topic = this.client.topic(this.config.topic);
    return {
      publish: async (message: BatchRunMessage): Promise<string> => {
        const { data, attributes } = encode(message);
        return topic.publishMessage({ data: Buffer.from(data), attributes });
      },
      close: async (): Promise<void> => {},
    };
  }

  async subscribe(handler: MessageHandler): Promise<TriggerSubscription> {
    const { Duration } = this.mod;
    const sub = this.client.subscription(this.config.subscription, {
      /**
       * Lease management, which is how an eight-minute job keeps one message.
       *
       * `maxAckDeadline` clamps each individual modack at the server's 600s
       * ceiling; `maxExtensionTime` is the total the client will keep extending
       * for. Both are `Duration`s in 6.x — `maxExtension` (a number) is gone.
       *
       * <https://docs.cloud.google.com/pubsub/docs/lease-management>
       *
       * `maxMessages: 1`: this consumer is a job process that runs one nightly
       * at a time, and leasing a second eight-minute message it cannot start is
       * a lease it will struggle to keep.
       */
      maxAckDeadline: Duration.from({ seconds: this.config.lease.ackDeadlineSeconds }),
      maxExtensionTime: Duration.from({ minutes: this.config.lease.maxExtensionMinutes }),
      flowControl: { maxMessages: this.config.lease.maxMessages },
    });
    this.subscriptions.push(sub);

    const errors: Error[] = [];
    sub.on('error', (e) => { errors.push(e); });

    sub.on('message', (m: PubSubMessage) => {
      void (async (): Promise<void> => {
        let decision: AckDecision;
        try {
          decision = await handler(toDelivered(m));
        } catch {
          // The transport's obligation. A handler that threw decided nothing,
          // so the message must stay undelivered-with.
          decision = 'nack';
        }
        if (decision === 'ack') m.ack(); else m.nack();
      })();
    });

    return {
      close: async (): Promise<void> => {
        sub.removeAllListeners();
        await sub.close();
      },
    };
  }

  async close(): Promise<void> {
    for (const s of this.subscriptions) {
      s.removeAllListeners();
      await s.close();
    }
    for (const p of this.publishers) await p.close();
    await this.client.close();
  }
}

/**
 * A Pub/Sub message reduced to the facts the handler is allowed to see.
 *
 * `deliveryAttempt` is 0 unless the subscription has a dead-letter policy, so a
 * 0 is reported as **null — "not known"** rather than as "first delivery". The
 * difference matters: the guard's attempt cap reads it, and treating "unknown"
 * as 0 would silently disable the cap on every subscription without a DLQ.
 */
export function toDelivered(m: PubSubMessage): DeliveredMessage {
  return {
    id: m.id,
    data: new Uint8Array(m.data),
    attributes: m.attributes,
    publishTime: new Date(m.publishTime.getTime()),
    deliveryAttempt: m.deliveryAttempt > 0 ? m.deliveryAttempt : null,
  };
}
