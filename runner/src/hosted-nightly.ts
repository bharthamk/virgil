import { LlmRefused, type DegradeReason, type Deps } from '@sb/core';
import {
  runBatch,
  type BatchResult,
  type BatchRunOptions,
  type BatchStageExecutor,
  type StageReport,
} from './pipeline.js';

interface PendingStage {
  readonly name: string;
  readonly run: () => Promise<string>;
  resolve(report: StageReport): void;
}

export interface HostedStageSpec {
  readonly name: string;
  readonly kind: 'pure' | 'seam';
  readonly policy: 'degrade' | 'skip';
  readonly agent: string;
  readonly description: string;
}

export interface HostedStageWork {
  readonly spec: HostedStageSpec;
  run(): Promise<string>;
}

export interface HostedStageReport {
  readonly stage: string;
  readonly ms: number;
  readonly detail: string;
  readonly failed: boolean;
  readonly directive: {
    readonly kind: string;
    readonly reason?: DegradeReason;
  } | null;
}

/**
 * Rendezvous between Virgil's stateful nightly and a framework-owned sequence.
 *
 * `runBatch` still owns all data flow between stages. At each boundary it
 * yields the real stage body here. The matching ADK child executes that body,
 * and the host's report releases the pipeline into the next boundary. This is
 * what makes the deployed tree nine real children without copying the nightly
 * or moving prompts and model calls into the framework layer.
 */
export class HostedNightly {
  readonly works: readonly HostedStageWork[];
  private readonly pending = new Map<string, PendingStage>();
  private readonly waiting = new Map<string, (stage: PendingStage) => void>();
  private runPromise: Promise<BatchResult> | null = null;
  private infrastructureFailure: Error | null = null;
  /**
   * A model call this build declined to issue, kept until the sequence is over.
   *
   * The pipeline cannot abort a hosted run from the inside: the framework owns
   * the sequence and every stage it is about to run is one `runBatch` has yet
   * to yield, so throwing mid-sequence leaves a child waiting on a stage nobody
   * will hand it. The refusal is caught here, on its way past to the host, and
   * raised from `result()` — which is the same place `infrastructureFailure`
   * is raised from and for the same reason.
   *
   * Letting the remaining stages run costs nothing. Whatever refused the first
   * call refuses each of the rest before it is issued, so the run finishes
   * against a sequence of instant refusals and the error a caller sees names
   * the one thing that actually happened. `cli.ts` reads it and prints
   * `batch-outcome budget-stopped`.
   *
   * The FIRST one is kept. Every later stage refuses for the same reason, and
   * the last one to be thrown is no more the cause than the first.
   */
  private refusal: LlmRefused | null = null;

  constructor(
    private readonly deps: Deps,
    private readonly specs: readonly HostedStageSpec[],
    private readonly opts: Omit<BatchRunOptions, 'stageExecutor' | 'onStage'> = {},
  ) {
    this.works = specs.map((spec) => ({
      spec,
      run: async () => {
        const pending = await this.take(spec.name);
        try {
          return await pending.run();
        } catch (err) {
          if (err instanceof LlmRefused && !this.refusal) this.refusal = err;
          // Rethrown regardless: the host's own failure decision is the host's,
          // and a stage that refused is not a stage that succeeded.
          throw err;
        }
      },
    }));
  }

  /** Start the pipeline so its first real stage is waiting for the first child. */
  start(): void {
    if (this.runPromise) return;
    const stageExecutor: BatchStageExecutor = {
      execute: (stage, run) => new Promise<StageReport>((resolve, reject) => {
        if (this.pending.has(stage)) {
          reject(new Error(`the nightly yielded ${stage} twice before it was hosted`));
          return;
        }
        const pending: PendingStage = { name: stage, run, resolve };
        this.pending.set(stage, pending);
        const waiter = this.waiting.get(stage);
        if (waiter) {
          this.waiting.delete(stage);
          waiter(pending);
        }
      }),
    };
    this.runPromise = runBatch(this.deps, { ...this.opts, stageExecutor });
    // The run is deliberately awaited later, in `result()`. Without a handler
    // attached now, a rejection between here and there is an unhandled one —
    // which on Node is a process-level event, and would take the run down
    // before the caller could say what happened.
    this.runPromise.catch(() => undefined);
  }

  /** Feed the framework's authoritative timing and failure decision back in. */
  accept(report: HostedStageReport): void {
    const pending = this.pending.get(report.stage);
    if (!pending) throw new Error(`the host reported ${report.stage} before the pipeline yielded it`);
    this.pending.delete(report.stage);
    const spec = this.specs.find((x) => x.name === report.stage);
    if (report.failed && spec?.kind === 'pure' && !this.infrastructureFailure) {
      this.infrastructureFailure = new Error(
        `${report.stage} failed in model-free work; the persistence boundary is unavailable: ${report.detail}`,
      );
    }
    pending.resolve({
      stage: report.stage,
      ms: report.ms,
      detail: report.detail,
      failed: report.failed,
      ...(report.directive?.kind === 'degrade' && report.directive.reason
        ? { degradeReason: report.directive.reason }
        : {}),
    });
  }

  async result(): Promise<BatchResult> {
    if (!this.runPromise) throw new Error('the hosted nightly was not started');
    const result = await this.runPromise;
    // Infrastructure first: a store that is unavailable is a fault somebody has
    // to fix, and a spend limit is not. A budget stop cannot cause a pure-stage
    // failure in any case — those stages call no model — so the order settles a
    // case that should not arise rather than a common one.
    if (this.infrastructureFailure) throw this.infrastructureFailure;
    if (this.refusal) throw this.refusal;
    return result;
  }

  private take(stage: string): Promise<PendingStage> {
    const ready = this.pending.get(stage);
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      if (this.waiting.has(stage)) {
        reject(new Error(`the host attempted ${stage} twice`));
        return;
      }
      this.waiting.set(stage, resolve);
    });
  }
}
