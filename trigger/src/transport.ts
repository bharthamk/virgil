/**
 * The delivery seam.
 *
 * Everything above this line is Virgil's: which night a message is for, whether
 * a night may run, and whether a message has been dealt with. Everything below
 * it is a queue. The interface exists so that both halves of that sentence can
 * be *proved separately* — the rules run against an in-memory at-least-once
 * transport with no dependency at all (`local-transport.ts`, the control) and
 * against the real Pub/Sub emulator (`pubsub-binding.ts`), bound to one
 * contract.
 *
 * That is the same move `adk/src/host.ts` makes for orchestration, for the same
 * reason: a rule that has only ever been observed under one vendor's client is
 * a description of that client, not a rule.
 */

import type { DeliveredMessage, BatchRunMessage } from './message.js';

/**
 * What a subscriber tells the transport to do with a message.
 *
 * Two values, and the whole ack policy is the question of which one. `ack` says
 * *this message has been dealt with*, which is not the same as *the night
 * produced a session* — the delivery-safety contract and withheld-content contract make a no-session night a legitimate
 * outcome, and a run that honestly produced nothing has still processed its
 * trigger. `nack` is reserved for the case where nothing was decided at all.
 */
export type AckDecision = 'ack' | 'nack';

export interface TriggerPublisher {
  /** Returns the transport's message id. */
  publish(message: BatchRunMessage): Promise<string>;
  close(): Promise<void>;
}

export type MessageHandler = (delivered: DeliveredMessage) => Promise<AckDecision>;

export interface TriggerSubscription {
  /**
   * Stops delivering and releases the transport.
   *
   * Must not ack anything in flight: a message whose handler was still running
   * at shutdown has not been dealt with, and letting the lease lapse is how the
   * next process learns that.
   */
  close(): Promise<void>;
}

export interface TriggerTransport {
  readonly kind: string;
  publisher(): Promise<TriggerPublisher>;
  /**
   * Begins delivering to `handler`.
   *
   * A handler that throws is a nack. That is a transport obligation rather than
   * a handler one, because the case it exists for is the handler failing in a
   * way it did not anticipate — precisely the case where it cannot be trusted
   * to return the right value.
   */
  subscribe(handler: MessageHandler): Promise<TriggerSubscription>;
}
