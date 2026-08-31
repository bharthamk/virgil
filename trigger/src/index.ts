/**
 * The nightly trigger layer.
 *
 * **`pubsub-binding.ts` is deliberately not re-exported.** Importing this index
 * must never be able to pull in `@google-cloud/pubsub`, so "does this deployment
 * talk to Pub/Sub" stays a question with one findable answer instead of a side
 * effect of an import somewhere. Same rule as `adk/src/index.ts`, and
 * `trigger-seam.test.ts` asserts it.
 */

export {
  DEFAULT_NIGHT_KEY_RULE, NightKeyError, isBatchKey, batchKeyFor, sessionIdForBatch,
  type BatchKey, type NightKeyRule,
} from './batch-key.js';

export {
  TRIGGER_SCHEMA_VERSION, decode, encode,
  type DecodeFailure, type DecodeResult, type DeliveredMessage,
  type BatchRunMessage, type TriggerKind,
} from './message.js';

export {
  StoreBatchGuard,
  type NightDecision, type NightGuard, type NightGuardOptions,
} from './guard.js';

export {
  nightlyTriggerHandler,
  type BatchOutcome, type NightRunner, type TriggerHandlerDeps,
  type TriggerOutcome, type TriggerReport,
} from './handler.js';

export {
  type AckDecision, type MessageHandler, type TriggerPublisher,
  type TriggerSubscription, type TriggerTransport,
} from './transport.js';

export {
  LocalTransport,
  type DeliveryRecord, type LocalTransportOptions,
} from './local-transport.js';

export {
  CREDENTIAL_PATTERN, DEFAULT_LEASE, DEFAULT_SUBSCRIPTION, DEFAULT_TOPIC,
  TriggerConfigError, triggerConfigFromEnv,
  type LeaseConfig, type TriggerConfig,
} from './config.js';
