/**
 * Whether a night may run — the delivery side of the batch-idempotency contract.
 *
 * The batch-idempotency contract says a per-night session key is added at port so that a retried job
 * does not leave two rows. That is the **write** side, and it belongs to the
 * store (the Firestore lane owns it). It makes duplication *harmless*.
 *
 * It does not make duplication *free*. A redelivered trigger that runs the
 * whole nightly again and then upserts onto the same key has still spent eleven
 * model calls and eight minutes to write a row that already existed. So the
 * delivery side needs its own question, asked before the run rather than after
 * it: **has this night already been built?**
 *
 * The answer is read from the store, through the batch-idempotency contract’s own key, so the two
 * sides cannot drift into two different ideas of what a night is. This is
 * delegation, not a second idempotency mechanism — `sessionIdForBatch` is the
 * only thing either side agrees on, and it lives in `batch-key.ts`.
 *
 * ## What this deliberately does not solve
 *
 * Two *processes* racing on one night. The pre-check is a read, so two job
 * instances that both read "no session" both run. Within one process the
 * single-flight map below closes it; across processes it needs a transactional
 * claim document, which is a Firestore surface this lane does not own and does
 * not fake. `DESIGN.md` §6 states the shape and names it as unbuilt.
 *
 * ## The attempt cap, and why it is here rather than in the retry policy
 *
 * A night that crashes is retried, and it should be — a crash is an
 * infrastructure failure and redelivery is the correct answer to one. But a
 * night that crashes *deterministically* is a message that will be redelivered
 * for ever, and eight minutes of model calls per attempt is a bill rather than
 * an inconvenience. Production answers this with a dead-letter topic; nothing
 * guarantees one exists on day one, so the cap is also enforced here, where it
 * costs nothing and cannot be forgotten. It is the same instinct as the
 * transport contract's the quota-retry policy — *stop, mark it, do not retry until morning* —
 * applied one layer up.
 */

import type { Store } from '@sb/core';
import {
  DEFAULT_NIGHT_KEY_RULE, batchKeyFor, sessionIdForBatch,
  type BatchKey, type NightKeyRule,
} from './batch-key.js';

export type NightDecision =
  /** Nothing has built this night. Run it. */
  | { readonly verdict: 'run' }
  /** A session already exists under this night's key (the batch-idempotency contract). */
  | { readonly verdict: 'already-built'; readonly sessionId: string }
  /** This process is running this night right now. */
  | { readonly verdict: 'in-flight' }
  /** Attempted too many times. Stop asking. */
  | { readonly verdict: 'abandoned'; readonly attempts: number };

export interface NightGuard {
  /**
   * Asked once per delivery, before any work.
   *
   * The rule is handed down rather than held, so there is exactly **one** night
   * rule in the system: the handler derives the key from the message with it,
   * and the guard reads existing sessions with the same one. Two copies of a
   * rule that must agree is a rule that eventually does not.
   */
  begin(key: BatchKey, attemptFromTransport: number | null, rule: NightKeyRule): Promise<NightDecision>;
  /** The run finished — however it finished. */
  finish(key: BatchKey): void;
  /** The run threw. The night stays unbuilt and the attempt is counted. */
  fail(key: BatchKey): void;
}

export interface NightGuardOptions {
  /**
   * How many times one night may be attempted before the trigger is treated as
   * poison. Three, because the failure this protects against is deterministic
   * and the third identical crash is not evidence the fourth will differ.
   */
  readonly maxAttempts?: number;
}

export class StoreBatchGuard implements NightGuard {
  private readonly maxAttempts: number;
  private readonly inFlight = new Set<BatchKey>();
  private readonly attempts = new Map<BatchKey, number>();

  constructor(private readonly store: Store, opts: NightGuardOptions = {}) {
    this.maxAttempts = opts.maxAttempts ?? 3;
  }

  /**
   * Has anything already built this night?
   *
   * **Asked of the domain, not of a naming convention.** The obvious
   * implementation is `getSession(sessionIdForBatch(key))`, and it is wrong
   * against the adapter that actually implements the batch-idempotency contract: `port/firestore`
   * makes the *document name* `batchKeyOf(builtAt)` — the plain UTC date, no
   * prefix — while `getSession(id)` looks the row up **by the `id` field**,
   * which is still a UUID. That lookup returns `null` every time, and every
   * redelivery re-runs a night that was already built, with no test failing on
   * either branch because each is testing its own convention.
   *
   * So the id lookup is kept as a fast path for any store that *does* name a
   * session after its night, and the real answer comes from `builtAt` — a field
   * of the domain type that no lane gets to rename. `MemoryStore`, `JsonStore`
   * and Firestore all agree about it.
   *
   * **The batch-key alignment contract changed which field answers.** A session now carries the night
   * it was built for, and where it does, that is the answer and `builtAt` is
   * not consulted at all. The two disagree exactly when a retry crosses
   * midnight UTC, and reading `builtAt` there produced both halves of the
   * defect: the night became unfindable under its own key and re-ran every
   * delivery, and the *following* night read the same row as its own and never
   * ran. `builtAt` remains the answer for rows written before the field, which
   * is the only thing they carry.
   *
   * The cost is a full read of the sessions collection per delivery. For a
   * trigger that fires once a night that is nothing, and the Firestore adapter's
   * own `latestSession` already reads every row. If it ever stops being
   * nothing, `latestSession()` is the cheap approximation — correct for this run,
   * wrong for a late redelivery of an old trigger.
   */
  private async builtBatchKey(key: BatchKey, rule: NightKeyRule): Promise<string | null> {
    const byId = await this.store.getSession(sessionIdForBatch(key));
    if (byId) return byId.id;

    for (const session of await this.store.listSessions()) {
      if (session.batchKey !== undefined) {
        // It says which night it is for. A row that names another night is not
        // evidence about this one, however its clock reads — `continue` rather
        // than falling through to `builtAt` is the whole of the batch-key alignment contract here.
        if (session.batchKey === key) return session.id;
        continue;
      }
      try {
        if (batchKeyFor(session.builtAt, rule) === key) return session.id;
      } catch {
        // A session whose `builtAt` is not an instant is a bug somewhere else.
        // It is not evidence that this night was built, so it is skipped rather
        // than allowed to suppress a run.
        continue;
      }
    }
    return null;
  }

  async begin(
    key: BatchKey,
    attemptFromTransport: number | null,
    rule: NightKeyRule = DEFAULT_NIGHT_KEY_RULE,
  ): Promise<NightDecision> {
    if (this.inFlight.has(key)) return { verdict: 'in-flight' };

    this.inFlight.add(key);
    let handedToRun = false;
    try {
      /**
       * The transport's own count and this process's are both partial, and in
       * opposite directions, so the cap reads the larger.
       *
       * Pub/Sub stamps `delivery_attempt` only when the subscription has a
       * dead-letter policy, and it counts deliveries of ONE message — two
       * Scheduler retries for one night are two messages, each starting at 1. The
       * in-process count spans messages but not restarts. Neither alone is the
       * number of times this night has been tried.
       *
       * **Both are converted to "attempts already made *before* this delivery"
       * before they are compared**, and that conversion is not cosmetic — it was
       * an off-by-one this file's own contract caught red. `deliveryAttempt` is
       * 1-based (the first delivery reports 1), the in-process counter is a
       * count of completed attempts, and comparing the two directly abandoned a
       * night after one attempt when the cap said two. A cap that silently means
       * one less than it says is worse than no cap: it retires a night on the
       * first infrastructure hiccup and reports that as policy.
       */
      const priorHere = this.attempts.get(key) ?? 0;
      const priorThere = attemptFromTransport === null ? 0 : attemptFromTransport - 1;
      const prior = Math.max(priorHere, priorThere);
      if (prior >= this.maxAttempts) return { verdict: 'abandoned', attempts: prior };

      const sessionId = await this.builtBatchKey(key, rule);
      if (sessionId !== null) return { verdict: 'already-built', sessionId };

      this.attempts.set(key, prior + 1);
      handedToRun = true;
      return { verdict: 'run' };
    } finally {
      if (!handedToRun) this.inFlight.delete(key);
    }
  }

  finish(key: BatchKey): void { this.inFlight.delete(key); }

  fail(key: BatchKey): void { this.inFlight.delete(key); }
}
