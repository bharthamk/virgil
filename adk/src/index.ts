/**
 * The orchestration layer. Above the seam, outside `core/`, wired into nothing.
 *
 * `adk-binding.ts` is deliberately NOT re-exported here. Importing this index
 * must never be what pulls `@google/adk` into a process — the binding is loaded
 * by naming it, which keeps "does this deployment use ADK" a question with a
 * findable answer rather than a side effect of an import.
 */

export {
  NIGHTLY_STAGES, FOREGROUND_AGENTS, FLEET_AGENTS, SEAM_STAGES, stageByName,
  type AdkStageSpec, type StageKind, type StagePolicy,
} from './stages.js';

export { hostFactoryFor, type HostName } from './select.js';

export {
  adkConfigFromEnv, AdkConfigError, CREDENTIAL_PATTERN, DEFAULT_APP_NAME,
  type AdkConfig, type SessionBackend,
} from './config.js';

export {
  classify, isTerminalForSeam, messageOf,
  type Directive, type DegradeReason,
} from './errors.js';

export {
  LocalSequentialHost, StagePolicyRunner, localHost, NOT_ATTEMPTED,
  type HostFactory, type HostRunResult, type HostStageReport, type HostedNode,
  type OrchestrationHost, type RunOptions, type StageWork,
} from './host.js';
