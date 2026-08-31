/**
 * What it means to host the nightly in an agent framework.
 *
 * ## Why there is an interface here at all
 *
 * The same reason `adapters/src/__tests__/llm-contract.ts` exists. "We wrapped
 * the fleet in ADK" is a claim about behaviour, and a claim about behaviour that
 * only one implementation has ever been checked against is a claim about that
 * implementation. So the requirements are written once, as a contract, and run
 * against two hosts: a reference host in this file that uses no framework at
 * all, and the real ADK host in `adk-binding.ts`.
 *
 * The reference host is not a mock. It is a complete, correct implementation of
 * the sequencing rules — it is what proves the rules are *implementable without*
 * ADK, which is what makes the contract a specification of Virgil's behaviour
 * rather than a transcription of ADK's. If the two hosts disagree, one of them
 * is wrong and the contract says which requirement they disagreed about.
 *
 * ## What a host is not allowed to be
 *
 * A host sequences stages. It does not call a model, own a prompt, hold a
 * credential, or decide what a stage does. Every stage body is a `core/` agent
 * reached through the injected `Deps`, which is why hosting the fleet in a
 * framework costs no prompt changes and no re-evaluation: the framework is above
 * the seam, and the seam is where the model lives.
 */

import type { AdkStageSpec } from './stages.js';
import type { AdkConfig } from './config.js';
import { classify, isTerminalForSeam, type Directive } from './errors.js';

/**
 * One stage, ready to run.
 *
 * `run` returns the detail line the run report prints and throws to fail, which
 * is exactly the shape `runBatch`'s `timed()` helper already expects. Chosen
 * so that hosting a stage requires no change to the stage.
 */
export interface StageWork {
  readonly spec: AdkStageSpec;
  run(): Promise<string>;
}

/**
 * A node in the agent tree the host built, as the host itself describes it.
 *
 * `primitive` is the framework's own class name — `SequentialAgent`,
 * `BaseAgent`, or `local` for the reference host. It is here because it is the
 * one thing the writeup actually wants to claim: that the fleet is expressed in
 * *the framework's* primitives and not in a wrapper that merely imports it.
 * A test can read this; a reader of prose cannot.
 */
export interface HostedNode {
  readonly name: string;
  readonly description: string;
  readonly primitive: string;
  readonly children: readonly HostedNode[];
}

export interface HostStageReport {
  readonly stage: string;
  readonly ms: number;
  readonly detail: string;
  readonly failed: boolean;
  /** What the host decided about the failure. Null when the stage succeeded. */
  readonly directive: Directive | null;
}

export interface HostRunResult {
  readonly framework: string;
  readonly reports: readonly HostStageReport[];
}

export interface RunOptions {
  readonly onStage?: (r: HostStageReport) => void;
  /**
   * Injected so a run's durations are a fact about the run rather than about
   * the machine. Defaults to the wall clock in the composition root.
   */
  readonly now?: () => number;
}

export interface OrchestrationHost {
  /** `'adk'` or `'local'`. Printed in the run report and asserted on. */
  readonly framework: string;
  /** The agent tree, root first. Built at construction, not at run time. */
  describe(): HostedNode;
  run(opts?: RunOptions): Promise<HostRunResult>;
}

/**
 * How a host is built. Async because the real one dynamically imports a package
 * that may not be installed, and a factory that can fail for that reason has to
 * be able to say so before anything is run.
 */
export type HostFactory = (
  stages: readonly StageWork[],
  config: AdkConfig,
) => Promise<OrchestrationHost>;

/**
 * The message a seam stage carries when the account is out of capacity.
 *
 * A constant rather than a literal in two files, because the contract asserts on
 * it and a host that produced a differently-worded version of the same fact
 * would pass every other assertion while making the run report unreadable.
 */
export const NOT_ATTEMPTED = 'not attempted — the model is out of capacity for the period';

/**
 * The sequencing rules, in one place, used by every host.
 *
 * Extracted rather than reimplemented per host on purpose. If each host wrote
 * its own version of "degrade, but stop attempting seam stages once the quota is
 * spent", the contract would be checking that two people had the same idea twice
 * rather than that one rule holds. The framework's job is to *sequence*; this is
 * what happens between the sequencing, and it is identical either way.
 */
export class StagePolicyRunner {
  /** Set once a failure means every later seam stage is pointless. */
  private seamIsSpent = false;

  constructor(private readonly now: () => number) {}

  /** True when this stage should not even be attempted. */
  skipped(spec: AdkStageSpec): boolean {
    return this.seamIsSpent && spec.kind === 'seam';
  }

  /**
   * Run one stage under the policy. Never throws: a host that could throw
   * mid-sequence would lose every report before it, and the reports are the only
   * evidence the run happened.
   */
  async execute(work: StageWork): Promise<HostStageReport> {
    const { spec } = work;

    if (this.skipped(spec)) {
      // Reported honestly as not-attempted rather than as a failure. A stage
      // that was never run did not fail, and a report that says it did is five
      // fabricated attempts on a night the account was simply out of quota.
      return { stage: spec.name, ms: 0, detail: NOT_ATTEMPTED, failed: true, directive: null };
    }

    const started = this.now();
    try {
      const detail = await work.run();
      return { stage: spec.name, ms: this.now() - started, detail, failed: false, directive: null };
    } catch (err) {
      const directive = classify(err);
      if (isTerminalForSeam(directive)) this.seamIsSpent = true;
      return {
        stage: spec.name,
        ms: this.now() - started,
        detail: directive.note,
        failed: true,
        directive,
      };
    }
  }
}

/**
 * The framework-free host. The contract's control.
 *
 * This is also the honest fallback: if the ADK dependency is ever declined, or a
 * version of it breaks, the nightly still has a host that satisfies every
 * requirement in the contract. That is worth having on a deadline, and it is the
 * reason the ADK binding is a strategy rather than a rewrite of `pipeline.ts`.
 */
export class LocalSequentialHost implements OrchestrationHost {
  readonly framework = 'local';

  constructor(
    private readonly stages: readonly StageWork[],
    private readonly config: AdkConfig,
  ) {}

  describe(): HostedNode {
    return {
      name: this.config.appName,
      description: 'The nightly, sequenced without a framework.',
      primitive: 'local',
      children: this.stages.map((s) => ({
        name: s.spec.name,
        description: s.spec.description,
        primitive: 'local',
        children: [],
      })),
    };
  }

  async run(opts: RunOptions = {}): Promise<HostRunResult> {
    const now = opts.now ?? (() => Date.now());
    const policy = new StagePolicyRunner(now);
    const reports: HostStageReport[] = [];
    for (const work of this.stages) {
      const report = await policy.execute(work);
      reports.push(report);
      opts.onStage?.(report);
    }
    return { framework: this.framework, reports };
  }
}

export const localHost: HostFactory = async (stages, config) =>
  new LocalSequentialHost(stages, config);
