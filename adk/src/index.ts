/**
 * Public orchestration contracts. The Google ADK binding is intentionally not
 * re-exported: composition roots select it explicitly, so importing this index
 * cannot add framework runtime behavior as a side effect.
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
