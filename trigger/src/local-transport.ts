/**
 * At-least-once delivery, in memory, with no dependency at all — the control.
 *
 * This is the same move `adk/src/host.ts`'s `LocalSequentialHost` makes: the
 * contract in `__tests__/handler-contract.ts` runs against this AND against the
 * real Pub/Sub emulator, so every rule it asserts is demonstrably **Virgil's
 * rule** rather than a behaviour of Google's client that was observed once and
 * written down afterwards as though it had been a decision.
 *
 * It also does something the emulator cannot: it produces the awkward deliveries
 * on demand. A queue can be told to deliver a message a second time *after it
 * was acked* — which is exactly what at-least-once permits and what no real
 * broker can be asked for. The emulator proves the wiring is real; this proves
 * the policy survives the cases the wiring is unlikely to produce on a laptop in
 * eight seconds.
 *
 * Deliberately timer-free. Delivery happens when a test calls `drain()`, so
 * every assertion is about an ordering the test chose rather than a race it
 * hoped for.
 */

import { encode, type DeliveredMessage, type BatchRunMessage } from './message.js';
import type {
  AckDecision, MessageHandler, TriggerPublisher, TriggerSubscription, TriggerTransport,
} from './transport.js';

interface Queued {
  readonly delivered: DeliveredMessage;
  attempts: number;
}

export interface LocalTransportOptions {
  /** Publish time stamped onto each message. Injected, never ambient. */
  readonly now?: () => Date;
  /**
   * How many times a nacked message is put back before the queue gives up.
   *
   * A real subscription bounds this with a dead-letter policy; a test needs it
   * bounded or a handler that always nacks is an infinite loop rather than a
   * failing assertion.
   */
  readonly redeliverLimit?: number;
  /** Whether `deliveryAttempt` is reported. Pub/Sub only stamps it when the
   *  subscription has a dead-letter policy, so both cases must be testable. */
  readonly reportDeliveryAttempt?: boolean;
}

export interface DeliveryRecord {
  readonly messageId: string;
  readonly attempt: number;
  readonly decision: AckDecision | 'threw';
}

export class LocalTransport implements TriggerTransport {
  readonly kind = 'local';

  private readonly now: () => Date;
  private readonly redeliverLimit: number;
  private readonly reportAttempt: boolean;
  private readonly queue: Queued[] = [];
  private readonly published = new Map<string, DeliveredMessage>();
  private handler: MessageHandler | null = null;
  private seq = 0;
  private closed = false;

  /** Every delivery this queue has made, in order. The test's observation window. */
  readonly deliveries: DeliveryRecord[] = [];

  constructor(opts: LocalTransportOptions = {}) {
    this.now = opts.now ?? ((): Date => new Date());
    this.redeliverLimit = opts.redeliverLimit ?? 5;
    this.reportAttempt = opts.reportDeliveryAttempt ?? true;
  }

  async publisher(): Promise<TriggerPublisher> {
    return {
      publish: async (message: BatchRunMessage): Promise<string> => this.enqueueNew(message),
      close: async (): Promise<void> => {},
    };
  }

  async subscribe(handler: MessageHandler): Promise<TriggerSubscription> {
    this.handler = handler;
    return {
      close: async (): Promise<void> => { this.closed = true; this.handler = null; },
    };
  }

  /** Publish without a subscriber, for tests that queue before they consume. */
  enqueueNew(message: BatchRunMessage): string {
    const { data, attributes } = encode(message);
    return this.enqueueRaw(data, attributes);
  }

  /** The poison path: bytes that were never a valid message. */
  enqueueRaw(data: Uint8Array, attributes: Record<string, string> = {}): string {
    const id = `local-${++this.seq}`;
    const delivered: DeliveredMessage = {
      id,
      data,
      attributes,
      // Stamped once, here. Every redelivery of this message repeats it — which
      // is the property the night key depends on, so the queue models it
      // explicitly rather than restamping on the way out.
      publishTime: this.now(),
      deliveryAttempt: null,
    };
    this.published.set(id, delivered);
    this.queue.push({ delivered, attempts: 0 });
    return id;
  }

  /**
   * Deliver an already-delivered message again.
   *
   * At-least-once permits this even after an ack — an ack is a request not to
   * redeliver, not a guarantee. No broker can be asked to demonstrate it, which
   * is the whole reason this method exists.
   */
  redeliver(messageId: string): void {
    const delivered = this.published.get(messageId);
    if (!delivered) throw new Error(`no such message: ${messageId}`);
    this.queue.push({ delivered, attempts: 0 });
  }

  /** Runs the queue to empty. Returns what the handler decided, in order. */
  async drain(): Promise<readonly DeliveryRecord[]> {
    const handler = this.handler;
    if (!handler) throw new Error('nothing is subscribed');
    const from = this.deliveries.length;

    while (this.queue.length && !this.closed) {
      const item = this.queue.shift() as Queued;
      item.attempts += 1;
      const delivered: DeliveredMessage = this.reportAttempt
        ? { ...item.delivered, deliveryAttempt: item.attempts }
        : item.delivered;

      let decision: AckDecision | 'threw';
      try {
        decision = await handler(delivered);
      } catch {
        // The transport's obligation, not the handler's: a handler that threw
        // did not decide anything, so the message stays undelivered-with.
        decision = 'threw';
      }
      this.deliveries.push({ messageId: delivered.id, attempt: item.attempts, decision });

      if (decision !== 'ack' && item.attempts < this.redeliverLimit) {
        this.queue.push(item);
      }
    }
    return this.deliveries.slice(from);
  }

  /** Messages still waiting. Zero after a clean drain. */
  get pending(): number { return this.queue.length; }
}
