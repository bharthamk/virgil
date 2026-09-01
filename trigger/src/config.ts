/**
 * Where the trigger runs, and what it may know.
 *
 * Same rule as `adk/src/config.ts`, and it is easier to keep here than there:
 * **no credential reaches this layer, and none is needed.** Against the emulator
 * there is nothing to authenticate to — `PUBSUB_EMULATOR_HOST` makes the client
 * skip auth entirely. In production the client takes the job's own service
 * account through Application Default Credentials, which is ambient to the
 * runtime and never a value this process reads, holds or logs.
 *
 * The prefix is `VIRGIL_TRIGGER_*` so nothing here can collide with a name the
 * Google client reads. Three names are deliberately unprefixed —
 * `GOOGLE_CLOUD_PROJECT`, `PUBSUB_EMULATOR_HOST` and `PUBSUB_PROJECT_ID` — because
 * those are Google's contract with its own library, and renaming them would mean
 * the process and the client disagreed about where they are.
 */

import { DEFAULT_NIGHT_KEY_RULE, type NightKeyRule } from './batch-key.js';
import type { AckDecision } from './transport.js';

export interface TriggerConfig {
  readonly projectId: string;
  readonly topic: string;
  readonly subscription: string;
  /** `host:port` when pointed at an emulator; null in production. */
  readonly emulatorHost: string | null;
  readonly batchKey: NightKeyRule;
  /** Ceiling on how many times one night is attempted before it is abandoned. */
  readonly maxAttempts: number;
  readonly onUndeliverable: AckDecision;
  readonly lease: LeaseConfig;
}

/**
 * Lease settings for a job that takes about eight minutes to process one
 * message. Every number is a doc fact, cited, because getting one of them wrong
 * is a night that runs twice.
 *
 * - **A single ack deadline cannot exceed 600 seconds** (min 10s, max 600s,
 *   default 10s) — <https://docs.cloud.google.com/pubsub/docs/subscription-properties>.
 *   So an eight-minute run *cannot* be covered by the deadline alone with any
 *   safety margin, and must not be attempted that way.
 * - **The client extends the lease for you.** Lease management modacks in the
 *   background and can hold a message "up to an hour"
 *   — <https://docs.cloud.google.com/pubsub/docs/lease-management>.
 * - The Node client's default `maxExtensionTime` is **60 minutes**, and
 *   `maxAckDeadline` defaults to 10 minutes (the server maximum). So the
 *   defaults already cover eight minutes; they are set explicitly anyway,
 *   because a default that happens to be right is not a decision.
 * - `maxMessages: 1`. The consumer is a job process that runs one nightly at a
 *   time; leasing a second eight-minute message it cannot start is a lease it
 *   will struggle to keep.
 *
 * Also from the lease-management page, and the reason `DESIGN.md` §8 does not
 * promise more than it can: *"Acknowledgment deadlines are not guaranteed to be
 * respected unless you enable exactly-once delivery."*
 */
export interface LeaseConfig {
  /** Seconds. Server maximum is 600. */
  readonly ackDeadlineSeconds: number;
  /** Minutes the client may keep extending one message. */
  readonly maxExtensionMinutes: number;
  /** Leased at once. One, for a job that runs one night at a time. */
  readonly maxMessages: number;
}

export const DEFAULT_LEASE: LeaseConfig = {
  ackDeadlineSeconds: 600,
  maxExtensionMinutes: 60,
  maxMessages: 1,
};

export const DEFAULT_TOPIC = 'nightly-run';
export const DEFAULT_SUBSCRIPTION = 'nightly-run-worker';

/** Same pattern as the ADK layer's, and for the same reason: a list of exact
 *  names is a list the next credential is not on. */
export const CREDENTIAL_PATTERN = /(^|_)(API_)?(KEY|SECRET|TOKEN|PASSWORD|CREDENTIALS?)(_|$)/i;

export class TriggerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TriggerConfigError';
  }
}

const read = (env: Readonly<Record<string, string | undefined>>, name: string): string | null => {
  const v = env[name];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
};

const readInt = (
  env: Readonly<Record<string, string | undefined>>, name: string, fallback: number,
): number => {
  const raw = read(env, name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new TriggerConfigError(`${name}=${raw} is not a positive integer`);
  }
  return n;
};

/**
 * The config, from an environment that is handed in rather than read.
 *
 * `projectId` resolution order is the client's own: `PUBSUB_PROJECT_ID` (which
 * the emulator docs use), then `GOOGLE_CLOUD_PROJECT`. There is no default —
 * a trigger publishing to `projects/undefined/topics/nightly-run` is a mistake
 * that should fail at boot rather than at 3am.
 */
export function triggerConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = {},
): TriggerConfig {
  const projectId = read(env, 'PUBSUB_PROJECT_ID') ?? read(env, 'GOOGLE_CLOUD_PROJECT');
  if (projectId === null) {
    throw new TriggerConfigError(
      'no project: set GOOGLE_CLOUD_PROJECT (or PUBSUB_PROJECT_ID against the emulator)',
    );
  }

  const ackDeadlineSeconds = readInt(env, 'VIRGIL_TRIGGER_ACK_DEADLINE_S', DEFAULT_LEASE.ackDeadlineSeconds);
  if (ackDeadlineSeconds < 10 || ackDeadlineSeconds > 600) {
    // Rejected rather than clamped. A deployment that asked for a 30-minute
    // deadline has misunderstood how an eight-minute job is covered, and
    // silently giving it 600 seconds would hide the misunderstanding until the
    // night that ran twice.
    throw new TriggerConfigError(
      `VIRGIL_TRIGGER_ACK_DEADLINE_S=${ackDeadlineSeconds} is outside Pub/Sub's 10–600s range; `
      + 'a long job is covered by lease extension, not by a longer deadline',
    );
  }

  const undeliverable = read(env, 'VIRGIL_TRIGGER_ON_UNDELIVERABLE') ?? 'ack';
  if (undeliverable !== 'ack' && undeliverable !== 'nack') {
    throw new TriggerConfigError(`VIRGIL_TRIGGER_ON_UNDELIVERABLE=${undeliverable} is not ack or nack`);
  }

  const timeZone = read(env, 'VIRGIL_TRIGGER_NIGHT_TZ') ?? DEFAULT_NIGHT_KEY_RULE.timeZone;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
  } catch {
    throw new TriggerConfigError(`VIRGIL_TRIGGER_NIGHT_TZ=${timeZone} is not an IANA time zone`);
  }

  const boundaryRaw = read(env, 'VIRGIL_TRIGGER_NIGHT_BOUNDARY_H');
  const boundaryHours = boundaryRaw === null ? DEFAULT_NIGHT_KEY_RULE.boundaryHours : Number(boundaryRaw);
  if (!Number.isInteger(boundaryHours) || boundaryHours < 0 || boundaryHours > 23) {
    throw new TriggerConfigError(`VIRGIL_TRIGGER_NIGHT_BOUNDARY_H=${String(boundaryRaw)} is not 0–23`);
  }

  return {
    projectId,
    topic: read(env, 'VIRGIL_TRIGGER_TOPIC') ?? DEFAULT_TOPIC,
    subscription: read(env, 'VIRGIL_TRIGGER_SUBSCRIPTION') ?? DEFAULT_SUBSCRIPTION,
    emulatorHost: read(env, 'PUBSUB_EMULATOR_HOST'),
    batchKey: { timeZone, boundaryHours },
    maxAttempts: readInt(env, 'VIRGIL_TRIGGER_MAX_ATTEMPTS', 3),
    onUndeliverable: undeliverable,
    lease: {
      ackDeadlineSeconds,
      maxExtensionMinutes: readInt(env, 'VIRGIL_TRIGGER_MAX_EXTENSION_MIN', DEFAULT_LEASE.maxExtensionMinutes),
      maxMessages: readInt(env, 'VIRGIL_TRIGGER_MAX_MESSAGES', DEFAULT_LEASE.maxMessages),
    },
  };
}
