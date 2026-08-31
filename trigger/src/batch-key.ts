/**
 * Which night a trigger message is for.
 *
 * This is the single most load-bearing function in the workspace, and it is
 * pure for one reason: **Pub/Sub is at-least-once, so the same message can be
 * delivered more than once, and every delivery has to name the same night.**
 * The moment this reads a clock, a redelivered trigger becomes a second night
 * and the per-night idempotency contract's per-night key stops protecting anything — the store would be
 * asked to make two different rows idempotent, which it cannot.
 *
 * So the key is derived from an instant the *message* carries, never from the
 * instant the message arrived. Two instants qualify and both are intrinsic to
 * the message rather than to the delivery:
 *
 *  - `scheduledAt` in the payload, when a publisher put one there. This is the
 *    local/manual path and the parity path for a future Scheduler that
 *    templates the fire time into the body.
 *  - the message's **publish time**, which Pub/Sub stamps once at publish and
 *    repeats on every redelivery of that message.
 *
 * The second is not a fallback of convenience — it is the production path.
 * Cloud Scheduler's Pub/Sub target sends a **static body configured on the
 * job**; it does not template the execution time into it. So a real Scheduler
 * trigger carries no timestamp of its own, and the only message-intrinsic
 * instant available is the publish time. Deriving from it is what lets the
 * production shape work at all. See `DESIGN.md` §4.
 *
 * ## Why there is a boundary offset
 *
 * A nightly that fires at 03:00 is the night of the *previous* day, and a
 * schedule that drifts across midnight must not rename the night. So the key
 * is the local calendar date of the instant shifted back by
 * `boundaryHours` — six by default, which puts everything from 06:00 to 06:00
 * under one key and leaves a nine-hour margin either side of a 03:00 run.
 *
 * `boundaryHours: 0` is the plain calendar date, and is the right setting if
 * the schedule ever moves to a daytime hour.
 */

export type BatchKey = string;

export interface NightKeyRule {
  /** IANA zone the learner's night is measured in. */
  readonly timeZone: string;
  /** Hours to shift back before taking the local date. 0 = plain calendar date. */
  readonly boundaryHours: number;
}

export const DEFAULT_NIGHT_KEY_RULE: NightKeyRule = {
  // UTC by default, deliberately. A zone is a deployment fact and guessing the
  // learner's from the process locale is how a run silently changes which night
  // it belongs to when the job moves region.
  timeZone: 'UTC',
  boundaryHours: 6,
};

const KEY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a string this module would have produced. */
export const isBatchKey = (value: unknown): value is BatchKey =>
  typeof value === 'string' && KEY_SHAPE.test(value);

/**
 * `YYYY-MM-DD` for an instant, in a named zone.
 *
 * `Intl.DateTimeFormat` with `en-CA` rather than arithmetic on a `Date`:
 * offsets, DST and the zone database are the formatter's problem, and a
 * hand-rolled shift is wrong twice a year in exactly the hours a nightly runs.
 */
function localDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  const at = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${at('year')}-${at('month')}-${at('day')}`;
}

export class NightKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NightKeyError';
  }
}

/**
 * The night an instant belongs to.
 *
 * Throws on an unparseable instant rather than returning a key derived from
 * `NaN`: a night called `NaN-NaN-NaN` would be perfectly stable across
 * redeliveries and perfectly useless, and it would collide every malformed
 * trigger onto one shared idempotency key.
 */
export function batchKeyFor(instant: Date | string, rule: NightKeyRule = DEFAULT_NIGHT_KEY_RULE): BatchKey {
  const d = instant instanceof Date ? instant : new Date(instant);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) {
    throw new NightKeyError(`not an instant: ${String(instant)}`);
  }
  const shifted = new Date(ms - rule.boundaryHours * 3_600_000);
  return localDate(shifted, rule.timeZone);
}

/**
 * The store id a night's session is written under (the per-night idempotency contract).
 *
 * **Cross-lane contract.** The per-night idempotency contract's *write* side belongs to the Firestore
 * lane; this is the *delivery* side reading the same key. If the two disagree
 * about the id, every redelivery re-runs a night that was already built and the
 * idempotency is decorative. This function is the one place the convention is
 * written down on this side, and `DESIGN.md` §6 names it as the thing to
 * reconcile before either lane merges.
 */
export const sessionIdForBatch = (key: BatchKey): string => `night-${key}`;
