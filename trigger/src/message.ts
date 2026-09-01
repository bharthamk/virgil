/**
 * The trigger message: what is on the wire, and what a subscriber may assume.
 *
 * Deliberately almost empty. Everything the nightly needs is already in the
 * store; a trigger that carried a board, or a topic list, or a target duration
 * would be a second source of truth for state the run is about to read anyway,
 * and the first time the two disagreed the message would win silently.
 *
 * So the message says one thing — *run the night this instant belongs to* — and
 * carries only what cannot be recovered on the other side:
 *
 *  - `v`      the schema version, so an old subscriber meeting a new message
 *             says so instead of guessing.
 *  - `kind`   the event, so one topic can carry a second one later without a
 *             second decoder having to sniff the shape.
 *  - `scheduledAt` (optional) the instant the night is keyed from, when the
 *             publisher knows it. Absent from a real Cloud Scheduler trigger —
 *             see `batch-key.ts` — in which case the message's publish time is
 *             the instant, and the subscriber supplies it.
 *
 * ## The attributes carry the same two facts
 *
 * Pub/Sub subscription **filters match on attributes only, never on the body**,
 * so a topic that ever carries a second `kind` needs `kind` in the attributes or
 * every subscriber has to receive and decode everything to discard most of it.
 * Putting `v` there too means a version skew is visible before a parse. The body
 * stays authoritative; the attributes are an index of it, and `decode` checks
 * they agree rather than trusting either alone.
 */

export const TRIGGER_SCHEMA_VERSION = 1;

export type TriggerKind = 'nightly-run';

export interface BatchRunMessage {
  readonly v: typeof TRIGGER_SCHEMA_VERSION;
  readonly kind: 'nightly-run';
  /** ISO-8601. Optional: a Scheduler-published trigger has none. */
  readonly scheduledAt?: string;
}

/** What a subscriber sees, framework-neutral — a Pub/Sub message reduced to facts. */
export interface DeliveredMessage {
  /** Stable per message. Two Scheduler retries are two ids for one night. */
  readonly id: string;
  readonly data: Uint8Array;
  readonly attributes: Readonly<Record<string, string>>;
  /** Stamped once at publish and repeated on every redelivery of this message. */
  readonly publishTime: Date;
  /** 1 on first delivery. Not available on every transport; see DESIGN.md §8. */
  readonly deliveryAttempt: number | null;
}

export type DecodeFailure =
  /** Not JSON, or not an object. */
  | 'unparseable'
  /** JSON, but not this schema's shape. */
  | 'malformed'
  /** A version this subscriber was not written against. */
  | 'unknown-version'
  /** A kind this subscriber does not handle. */
  | 'unknown-kind'
  /** Body and attributes disagree about what this message is. */
  | 'attribute-mismatch';

export type DecodeResult =
  | { readonly ok: true; readonly message: BatchRunMessage }
  | { readonly ok: false; readonly failure: DecodeFailure; readonly detail: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The body a publisher puts on the wire. */
export function encode(message: BatchRunMessage): { data: Uint8Array; attributes: Record<string, string> } {
  return {
    data: new TextEncoder().encode(JSON.stringify(message)),
    attributes: { v: String(message.v), kind: message.kind },
  };
}

/**
 * The wire back into a message, or a named reason it is not one.
 *
 * Every failure is *named* rather than collapsed into `null`, because the ack
 * decision differs by name and a handler that cannot tell an unknown version
 * from unparseable bytes has to treat both the same. See `handler.ts`.
 */
export function decode(delivered: Pick<DeliveredMessage, 'data' | 'attributes'>): DecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(delivered.data)) as unknown;
  } catch (err) {
    return { ok: false, failure: 'unparseable', detail: err instanceof Error ? err.message : String(err) };
  }
  if (!isRecord(parsed)) {
    return { ok: false, failure: 'malformed', detail: `body is ${Array.isArray(parsed) ? 'an array' : typeof parsed}` };
  }
  if (typeof parsed['v'] !== 'number') {
    return { ok: false, failure: 'malformed', detail: 'no numeric v' };
  }
  if (parsed['v'] !== TRIGGER_SCHEMA_VERSION) {
    // Not "malformed". A newer publisher is a deployment fact, and the
    // difference decides whether the message is worth keeping for a subscriber
    // that can read it (DESIGN.md §7).
    return { ok: false, failure: 'unknown-version', detail: `v${String(parsed['v'])}, this subscriber reads v${TRIGGER_SCHEMA_VERSION}` };
  }
  if (parsed['kind'] !== 'nightly-run') {
    return { ok: false, failure: 'unknown-kind', detail: `kind ${JSON.stringify(parsed['kind'])}` };
  }
  const scheduledAt = parsed['scheduledAt'];
  if (scheduledAt !== undefined) {
    if (typeof scheduledAt !== 'string' || !Number.isFinite(new Date(scheduledAt).getTime())) {
      return { ok: false, failure: 'malformed', detail: `scheduledAt is not an instant: ${JSON.stringify(scheduledAt)}` };
    }
  }

  // The attributes are an index of the body, so they are checked against it
  // rather than believed. A publisher that sets `kind=pin-created` on a
  // `nightly-run` body has a bug the subscriber can see and nothing else can.
  const attrKind = delivered.attributes['kind'];
  if (attrKind !== undefined && attrKind !== parsed['kind']) {
    return { ok: false, failure: 'attribute-mismatch', detail: `attribute kind=${attrKind}, body kind=${String(parsed['kind'])}` };
  }
  const attrV = delivered.attributes['v'];
  if (attrV !== undefined && attrV !== String(parsed['v'])) {
    return { ok: false, failure: 'attribute-mismatch', detail: `attribute v=${attrV}, body v=${String(parsed['v'])}` };
  }

  return {
    ok: true,
    message: scheduledAt === undefined
      ? { v: TRIGGER_SCHEMA_VERSION, kind: 'nightly-run' }
      : { v: TRIGGER_SCHEMA_VERSION, kind: 'nightly-run', scheduledAt },
  };
}
