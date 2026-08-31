
import type { AdkConfig } from './config.js';
import {
  StagePolicyRunner,
  type HostFactory, type HostRunResult, type HostStageReport,
  type HostedNode, type OrchestrationHost, type RunOptions, type StageWork,
} from './host.js';

/**
 * Typed as `string` rather than inferred as a literal on purpose: a literal
 * would make `tsc` resolve the module at build time and fail the whole
 * workspace's typecheck whenever the package is absent, which is most of the
 * time. Exported so the workspace's own seam guard can assert that exactly one
 * file mentions it.
 */
export const ADK_MODULE: string = '@google/adk';

/** The version this binding was written and proven against. */
export const ADK_PINNED_VERSION = '2.0.0';

// --------------------------------------------------------------- the ADK surface

/**
 * The slice of ADK this binding uses, transcribed from the real
 * `@google/adk@2.0.0` type declarations.
 *
 * Hand-written rather than imported. That began as a consequence of the package
 * being undeclared and is now a deliberate choice: typing against the SDK's own
 * `.d.ts` would make this file agree with the installed package by construction
 * and prove nothing about it. A copy can go stale, which is the point —
 * `adk-binding.test.ts` checks every name on it against what is actually
 * installed, and that check is what a version bump trips over. A structural type
 * nobody verifies is a guess.
 */
interface AdkAgentConfig {
  name: string;
  description?: string;
  subAgents?: readonly unknown[];
}

interface AdkAgentInstance {
  readonly name: string;
  readonly subAgents: readonly AdkAgentInstance[];
}

type AdkAgentCtor = new (config: AdkAgentConfig) => AdkAgentInstance;

interface AdkEvent {
  author?: string;
  invocationId?: string;
  content?: { role?: string; parts?: readonly { text?: string }[] };
}

interface AdkRunnerInstance {
  runAsync(params: {
    userId: string;
    sessionId: string;
    newMessage: { role: string; parts: readonly { text: string }[] };
  }): AsyncGenerator<AdkEvent, void, undefined>;
}

interface AdkSessionServiceInstance {
  createSession(params: { appName: string; userId: string; sessionId: string }): Promise<unknown>;
}

interface AdkModule {
  readonly BaseAgent: AdkAgentCtor;
  readonly SequentialAgent: AdkAgentCtor;
  readonly Runner: new (cfg: {
    appName: string;
    agent: unknown;
    sessionService: unknown;
  }) => AdkRunnerInstance;
  readonly InMemorySessionService: new () => AdkSessionServiceInstance;
  readonly createEvent: (params: Record<string, unknown>) => AdkEvent;
}

/** Every export this binding depends on. Asserted one by one by the gated test. */
export const REQUIRED_ADK_EXPORTS: readonly string[] = [
  'BaseAgent', 'SequentialAgent', 'Runner', 'InMemorySessionService', 'createEvent',
];

export class AdkUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super(
      `${ADK_MODULE}@${ADK_PINNED_VERSION} is a declared dependency of @sb/adk and did not `
      + `resolve. The install this process was started from is incomplete — run \`npm ci\` `
      + `against the committed lockfile.`,
    );
    this.name = 'AdkUnavailableError';
  }
}

/** Resolvable without building anything, so a caller can choose a host up front. */
export async function adkAvailable(): Promise<boolean> {
  try {
    await import(ADK_MODULE);
    return true;
  } catch {
    return false;
  }
}

async function loadAdk(): Promise<AdkModule> {
  let mod: Record<string, unknown>;
  try {
    mod = await import(ADK_MODULE) as Record<string, unknown>;
  } catch (err) {
    throw new AdkUnavailableError(err);
  }
  const missing = REQUIRED_ADK_EXPORTS.filter((n) => typeof mod[n] !== 'function');
  if (missing.length) {
    // A package that resolved but does not carry what this binding was written
    // against is a version skew, and it is worth saying so here rather than
    // failing later with `undefined is not a constructor`. The graph `Workflow`
    // API that replaces `SequentialAgent` upstream is exactly this shape of
    // change arriving.
    throw new Error(
      `${ADK_MODULE} is installed but does not export ${missing.join(', ')} — `
      + `this binding was written against ${ADK_PINNED_VERSION}`,
    );
  }
  return mod as unknown as AdkModule;
}

// ------------------------------------------------------------------ agent names

/**
 * ADK validates agent names and rejects two cases, both verified against 2.0.0
 * rather than assumed: a name that is not a valid identifier start (`"9bad"`),
 * and the reserved name `"user"`. Hyphens ARE accepted, so `virgil-nightly`
 * passes as-is — which is worth recording, because the obvious defensive guess
 * is that they do not.
 *
 * Sanitising rather than throwing, because the only name that reaches here from
 * outside is `appName`, and a deployment failing at 3am over a hyphen in an
 * environment variable is a worse outcome than a run whose app is called
 * `a_9bad`.
 */
export function safeAgentName(raw: string): string {
  const trimmed = raw.trim();
  const base = trimmed === '' ? 'virgil' : trimmed;
  const prefixed = /^[A-Za-z_$]/.test(base) ? base : `a_${base}`;
  return prefixed === 'user' ? 'user_agent' : prefixed;
}

// ------------------------------------------------------------------- the binding

/**
 * Builds the stage-agent class against the `BaseAgent` from the loaded module.
 *
 * Built inside a function because the base class only exists after the dynamic
 * import. `runAsyncImpl` is the one method ADK requires; `runLiveImpl` is
 * abstract too and delegates, because a batch pipeline has no live mode and
 * refusing to define it would make the class unconstructable.
 */
function makeStageAgentClass(Base: AdkAgentCtor, createEvent: AdkModule['createEvent']) {
  return class StageAgent extends Base {
    constructor(
      config: AdkAgentConfig,
      private readonly work: StageWork,
      private readonly policy: StagePolicyRunner,
      private readonly sink: HostStageReport[],
      private readonly onStage: ((r: HostStageReport) => void) | undefined,
    ) {
      super(config);
    }

    /**
     * The stage runs under the shared policy, and the report is pushed to the
     * host's sink before the event is yielded.
     *
     * It never throws. `SequentialAgent` stops the whole sequence on an
     * exception out of a sub-agent, and a nightly that abandons `compose`
     * because `analyse` had a bad night is precisely the failure graceful-degradation constraint exists to
     * prevent. Degradation is the policy, so degradation is what the framework
     * is handed — the sequencing primitive is not asked to make that judgement.
     */
    async *runAsyncImpl(context: { invocationId?: string }): AsyncGenerator<AdkEvent, void, void> {
      const report = await this.policy.execute(this.work);
      this.sink.push(report);
      this.onStage?.(report);
      yield createEvent({
        author: this.name,
        invocationId: context.invocationId ?? '',
        content: { role: 'model', parts: [{ text: `${report.stage}: ${report.detail}` }] },
      });
    }

    async *runLiveImpl(context: { invocationId?: string }): AsyncGenerator<AdkEvent, void, void> {
      yield* this.runAsyncImpl(context);
    }
  };
}

export class AdkSequentialHost implements OrchestrationHost {
  readonly framework = 'adk';

  private constructor(
    private readonly adk: AdkModule,
    private readonly stages: readonly StageWork[],
    private readonly config: AdkConfig,
    private readonly rootName: string,
  ) {}

  static async create(stages: readonly StageWork[], config: AdkConfig): Promise<AdkSequentialHost> {
    const adk = await loadAdk();
    return new AdkSequentialHost(adk, stages, config, safeAgentName(config.appName));
  }

  /**
   * The tree as ADK actually built it.
   *
   * `primitive` is read off `constructor.name` rather than written down, so this
   * cannot claim a framework primitive the code did not construct. That is the
   * whole reason the method exists: "wrapped the fleet in ADK" is checkable
   * only if something reads the built object.
   */
  describe(): HostedNode {
    const { root } = this.build(new StagePolicyRunner(() => 0), [], undefined);
    const children = root.subAgents.map((child, i) => ({
      name: child.name,
      description: this.stages[i]?.spec.description ?? '',
      primitive: child.constructor.name,
      children: [] as readonly HostedNode[],
    }));
    return {
      name: root.name,
      description: 'The nightly, sequenced by ADK.',
      primitive: root.constructor.name,
      children,
    };
  }

  private build(
    policy: StagePolicyRunner,
    sink: HostStageReport[],
    onStage: ((r: HostStageReport) => void) | undefined,
  ): { root: AdkAgentInstance } {
    const StageAgent = makeStageAgentClass(this.adk.BaseAgent, this.adk.createEvent);
    const subAgents = this.stages.map((work) => new StageAgent(
      { name: safeAgentName(work.spec.name), description: work.spec.description },
      work, policy, sink, onStage,
    ));
    const root = new this.adk.SequentialAgent({
      name: this.rootName,
      description: 'The nightly, sequenced by ADK.',
      subAgents,
    });
    return { root };
  }

  /**
   * Drives the tree through ADK's own `Runner` rather than iterating the agents.
   *
   * Deliberate: calling `runAsync` on the root agent directly would skip the
   * session service, the plugin manager and the event plumbing, and the claim
   * would degrade to "we imported ADK and called a method on it". The run goes
   * through the same entry point a deployed ADK service uses.
   *
   * The reports come back off the sink rather than out of the event stream. ADK
   * events carry text, and parsing a run report back out of prose the framework
   * reformatted is a lossy round trip for data this process already has.
   */
  async run(opts: RunOptions = {}): Promise<HostRunResult> {
    const now = opts.now ?? (() => Date.now());
    const sink: HostStageReport[] = [];
    const { root } = this.build(new StagePolicyRunner(now), sink, opts.onStage);

    const sessionService = new this.adk.InMemorySessionService();
    const appName = this.config.appName;
    // A batch job's session begins and ends with the run, so the id is the run.
    const sessionId = `nightly-${now()}`;
    const userId = 'virgil-nightly';
    await sessionService.createSession({ appName, userId, sessionId });

    const runner = new this.adk.Runner({ appName, agent: root, sessionService });
    for await (const _event of runner.runAsync({
      userId,
      sessionId,
      newMessage: { role: 'user', parts: [{ text: 'run the nightly' }] },
    })) {
      // Consumed to drive the generator. The reports are on the sink.
      void _event;
    }

    return { framework: this.framework, reports: sink };
  }
}

export const adkHost: HostFactory = (stages, config) => AdkSequentialHost.create(stages, config);

// ------------------------------------------------------- the door left unlocked

/**
 * How a stage would call the model through the seam if it ever became a real
 * `LlmAgent`. Written, not wired, and not exported from the workspace index.
 *
 * ADK's `LlmAgent` accepts `model: string | BaseLlm`, and resolves a `BaseLlm`
 * instance directly without touching its model registry — so a subclass of
 * `BaseLlm` that forwards to Virgil's injected `Llm` is a supported way to let
 * ADK orchestrate a model call while the seam remains the only door to the
 * provider. That is the migration path, and it is recorded here so that the day
 * somebody wants ADK tool-use on the Forager, the design question is already
 * answered and the seam is not the thing that gets traded away for it.
 *
 * It is a sketch, not an implementation. Two things are genuinely unresolved and
 * are named rather than papered over:
 *
 *  1. `BaseLlm.connect()` is abstract, not optional, so a non-live model must
 *     implement it. Throwing is the obvious move and is NOT documented anywhere
 *     in ADK's docs; it is a guess until something exercises it.
 *  2. Translating ADK's `LlmRequest` (contents, tool declarations, system
 *     instruction) into Virgil's `LlmRequest` (system, prompt, schema, tier) is
 *     lossy in the tool-declaration direction, which is exactly the direction
 *     somebody would want it for. That translation needs its own contract test
 *     before it carries a single real prompt.
 *
 * Building it now would be building the thing the three reasons at the top of
 * this file say not to build yet.
 */
export const SEAM_LLM_MIGRATION_NOTE = `
An ADK LlmAgent can be handed a BaseLlm instance directly:

    class VirgilSeamLlm extends BaseLlm {
      constructor(private readonly llm: Llm, private readonly tier: ModelTier) {
        super({ model: \`virgil-seam-\${tier}\` });
      }
      async *generateContentAsync(req, stream, signal) {
        // translate ADK LlmRequest -> Virgil LlmRequest, call this.llm, and
        // yield one LlmResponse. Tool declarations are the unsolved part.
      }
      async connect() { throw new Error('the nightly has no live mode'); }
    }

    new LlmAgent({ name: 'forager', model: new VirgilSeamLlm(deps.llm, 'deep') })

This keeps ports/llm.ts the only door to the provider while ADK owns the turn.
Unproven: connect()'s throw, and the tool-declaration translation.
`.trim();
