/**
 * The ack policy, which is the whole of this workspace's judgement.
 *
 * One question decides every line below: **what does `ack` mean?** It is
 * tempting to read it as "the night succeeded", and that reading is wrong in a
 * way that costs money. Pub/Sub's ack means *this message has been dealt with
 * and must not be delivered again*. The three-state batch-result and verifier-withholding contracts establish that a night can
 * legitimately produce no session — nothing to teach, or a model that answered
 * and addressed nothing — and both are runs that happened, reported honestly,
 * with a store that reflects them. Nacking those would ask the platform to
 * redeliver a trigger so the fleet can spend eleven more model calls arriving at
 * the same true answer.
 *
 * So: **failure to produce is not failure to process.**
 *
 * `nack` is reserved for the one case where nothing was decided — the run threw
 * before it could report anything. That is an infrastructure failure and
 * redelivery is the correct response to one.
 *
 * The third case has to preserve the measured transport contract. As
 * implemented in `adk/src/errors.ts`, a spent daily quota **degrades and
 * marks the later stages not-attempted rather than retrying until morning.** A
 * quota-degraded night that nacked would hand that decision straight back to the
 * platform, which would redeliver in seconds and produce a night that degrades
 * again — the retry storm this protection exists to prevent, arriving through an
 * unguarded path. A degraded night **acks**.
 */

import { decode, type DeliveredMessage } from './message.js';
import { batchKeyFor, NightKeyError, type BatchKey, type NightKeyRule, DEFAULT_NIGHT_KEY_RULE } from './batch-key.js';
import type { NightGuard } from './guard.js';
import type { AckDecision, MessageHandler } from './transport.js';

/**
 * What a night did, as the trigger needs to know it.
 *
 * Narrower than `BatchResult` on purpose: the trigger's only question is
 * whether the message has been dealt with, and a shape carrying stage reports
 * would invite this layer to start having opinions about stages.
 */
export type BatchOutcome =
  /** A session was built and persisted under the night's key. */
  | { readonly kind: 'session'; readonly sessionId: string }
  /** The run completed and honestly produced nothing (the three-state batch-result and verifier-withholding contracts). */
  | { readonly kind: 'no-session'; readonly reason: 'nothing-to-teach' | 'model-failed' | 'learner-context-changed' }
  /**
   * The run stopped short because the provider's daily cap was spent
   * (the quota-degradation contract). Not a failure, and explicitly not a retry.
   */
  | { readonly kind: 'degraded'; readonly reason: 'quota-exhausted' };

/**
 * The nightly, as this layer is allowed to see it.
 *
 * Injected rather than imported. Whether a night is run by `runBatch`
 * directly or by the ADK host wrapping it is a composition-root decision — the
 * same rule `seam-purity.test.ts` applies to which provider answers a model
 * call — and `adk/DESIGN.md` §5a is explicit that the job entrypoint stays
 * Virgil's own with the ADK host *inside* it. This signature is what makes both
 * compose: the trigger hands a night key to a function and is told what
 * happened.
 */
export type NightRunner = (ctx: { readonly batchKey: BatchKey }) => Promise<BatchOutcome>;

export type TriggerOutcome =
  | 'ran-session'
  | 'ran-no-session'
  | 'ran-degraded'
  | 'skipped-already-built'
  | 'skipped-in-flight'
  | 'abandoned'
  | 'undeliverable'
  | 'infra-failure';

export interface TriggerReport {
  readonly messageId: string;
  /** Null when the message could not be decoded far enough to name a night. */
  readonly batchKey: BatchKey | null;
  /** Which message-intrinsic instant the key came from. Never the receipt time. */
  readonly keySource: 'scheduledAt' | 'publishTime' | null;
  readonly outcome: TriggerOutcome;
  readonly decision: AckDecision;
  readonly detail: string;
}

export interface TriggerHandlerDeps {
  readonly guard: NightGuard;
  readonly run: NightRunner;
  readonly rule?: NightKeyRule;
  /**
   * What to do with a message this subscriber cannot read.
   *
   * `ack` by default, and the default is the conservative one **only because
   * nothing guarantees a dead-letter topic exists.** A message that cannot be
   * decoded will not decode on the ninth delivery either, so nacking it without
   * somewhere for it to go is an unbounded loop over bytes nobody can read.
   *
   * With a dead-letter topic configured, `nack` is the better setting: the
   * message stops being redelivered after `maxDeliveryAttempts` and is kept for
   * a human instead of dropped. `DESIGN.md` §7.
   */
  readonly onUndeliverable?: AckDecision;
  readonly report?: (r: TriggerReport) => void;
}

export function nightlyTriggerHandler(deps: TriggerHandlerDeps): MessageHandler {
  const rule = deps.rule ?? DEFAULT_NIGHT_KEY_RULE;
  const undeliverable = deps.onUndeliverable ?? 'ack';

  const emit = (r: TriggerReport): AckDecision => { deps.report?.(r); return r.decision; };

  return async (delivered: DeliveredMessage): Promise<AckDecision> => {
    const base = { messageId: delivered.id, batchKey: null, keySource: null } as const;

    const read = decode(delivered);
    if (!read.ok) {
      return emit({
        ...base,
        outcome: 'undeliverable',
        // Every decode failure is permanent by construction: a message that is
        // unparseable, malformed, or from an unknown publisher does not improve
        // on redelivery. There used to be a poison-vs-transient split here; the
        // transient side had no members, and a branch that looks like a
        // discrimination but is not one is worse than none.
        decision: undeliverable,
        detail: `${read.failure}: ${read.detail}`,
      });
    }

    /**
     * The key comes off the message, and the message alone.
     *
     * `scheduledAt` when a publisher supplied one; otherwise the publish time,
     * which Pub/Sub stamps once and repeats on every redelivery. Both are
     * properties of the message. Neither is the moment this process happened to
     * receive it — a key derived from receipt time would give a redelivered
     * trigger a different night, and every redelivery would run a night of its
     * own. This is the sentence the whole design turns on.
     */
    const keySource = read.message.scheduledAt === undefined ? 'publishTime' : 'scheduledAt';
    const instant = read.message.scheduledAt ?? delivered.publishTime;

    let batchKey: BatchKey;
    try {
      batchKey = batchKeyFor(instant, rule);
    } catch (err) {
      // Only reachable through a publishTime the transport made up; `decode`
      // already rejects an unparseable `scheduledAt`.
      return emit({
        ...base,
        keySource,
        outcome: 'undeliverable',
        decision: undeliverable,
        detail: err instanceof NightKeyError ? err.message : String(err),
      });
    }

    const at = { messageId: delivered.id, batchKey, keySource } as const;

    // The same rule that produced the key, handed down — so the guard reads
    // existing sessions by exactly the night boundary this key was cut on.
    const decision = await deps.guard.begin(batchKey, delivered.deliveryAttempt, rule);
    if (decision.verdict === 'already-built') {
      // The night exists under the per-night idempotency contract's key. The trigger has been honoured —
      // by an earlier delivery, which is exactly what at-least-once means.
      return emit({ ...at, outcome: 'skipped-already-built', decision: 'ack', detail: `session ${decision.sessionId} already built` });
    }
    if (decision.verdict === 'in-flight') {
      // Another delivery of this night is running in this process right now.
      // Acking is right: the work this message asks for is happening, and the
      // delivery that owns it still owns its own ack.
      return emit({ ...at, outcome: 'skipped-in-flight', decision: 'ack', detail: 'this night is running' });
    }
    if (decision.verdict === 'abandoned') {
      return emit({
        ...at,
        outcome: 'abandoned',
        decision: 'ack',
        detail: `${decision.attempts} attempts on this night — not retried until the next schedule`,
      });
    }

    let outcome: BatchOutcome;
    try {
      outcome = await deps.run({ batchKey });
    } catch (err) {
      deps.guard.fail(batchKey);
      // The one nack. Nothing was decided, so the platform is the right place
      // for the retry to come from.
      return emit({
        ...at,
        outcome: 'infra-failure',
        decision: 'nack',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    deps.guard.finish(batchKey);

    if (outcome.kind === 'session') {
      return emit({ ...at, outcome: 'ran-session', decision: 'ack', detail: `session ${outcome.sessionId}` });
    }
    if (outcome.kind === 'no-session') {
      return emit({ ...at, outcome: 'ran-no-session', decision: 'ack', detail: `${outcome.reason} — the run happened and produced nothing` });
    }
    return emit({ ...at, outcome: 'ran-degraded', decision: 'ack', detail: `${outcome.reason} — degraded, and deliberately not retried` });
  };
}
