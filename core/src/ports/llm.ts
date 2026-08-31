import type { ModelMode } from '../domain/types.js';

/**
 * The model seam.
 *
 * Every model call in the product goes through this interface. No agent ever
 * imports a vendor SDK. Two consequences, both deliberate:
 *
 *  1. The port to Gemini is one adapter, not a rewrite (the architecture).
 *  2. Provider choice becomes a *product* capability — local model, cloud CLI,
 *     or hosted API — rather than a hardcoded assumption. Gemini and Google
 *     Cloud are the shipped default; they are not the only thing that works.
 */

/**
 * Tier, not model name. Agents declare what kind of thinking they need and the
 * adapter decides what serves it. Scout wants FAST because it renders inside a
 * 1.5s toast; Composer wants DEEP because it is the differentiator.
 */
export type ModelTier = 'fast' | 'deep';

/**
 * Reasoning is a separate axis from capability, and measurement forced it into
 * the interface: on the local stack, disabling the model's thinking pass took a
 * topic label from 5005ms to 419ms. Latency is not about model size.
 *
 * This maps onto the product's own shape. Foreground agents run `off` because
 * they answer inside a 1.5s toast or a live session. Background agents run `on`
 * because they execute at 3am where latency is free and judgement quality is
 * the only thing that matters. The fleet literally does its thinking in the
 * background.
 */
export type Reasoning = 'on' | 'off';

export interface LlmRequest {
  readonly tier: ModelTier;
  /** Defaults to 'on'. Foreground agents must set 'off' explicitly. */
  readonly reasoning?: Reasoning;
  readonly system: string;
  readonly prompt: string;
  readonly media?: readonly { kind: 'image'; ref: string }[];
  /** JSON Schema. When present the adapter must return conforming JSON. */
  readonly schema?: unknown;
  readonly maxOutputTokens?: number;
}

export interface LlmResult<T = string> {
  readonly value: T;
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface Llm {
  complete(req: LlmRequest): Promise<LlmResult<string>>;
  /** Structured output. The adapter enforces the schema and retries on drift. */
  structured<T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>>;
}

/**
 * A call that was never issued, because this build refused to issue it.
 *
 * Thrown by an `Llm` implementation that decided, before anything went to a
 * provider, that this request must not be sent: a spend limit the learner set
 * themselves, or a policy the service holds. It is deliberately NOT the error
 * an issued call throws when it fails.
 *
 * ## Why the distinction is load-bearing
 *
 * Half this fleet catches a model failure on purpose and degrades, and every
 * one of those catches is right: a mark that says "that check did not run" is
 * worth more than a 500, and a pin that falls back to a plain label is worth
 * more than a lost capture. What each of them then says to the learner is
 * "something on the model side went wrong" — which for a provider outage is
 * true, and for a refusal is a lie with a direction. It sends somebody to check
 * an API key, a network, a credential, a local endpoint. The actual answer is a
 * limit they set, in a panel they own, and the fix is one button.
 *
 * "The model could not answer" and "nothing was ever sent, on your own
 * instruction" are different facts, and a learner acts on them differently.
 *
 * ## The rule this class exists to state
 *
 * **A refusal is not a failure.** Any catch that converts a model error into a
 * degraded outcome — `model-failed`, a fallback label, an empty answer, a
 * withheld section — must let this one through first:
 *
 * ```ts
 * } catch (err) {
 *   if (err instanceof LlmRefused) throw err;
 *   return nothing('model-failed');
 * }
 * ```
 *
 * Every other error keeps the behaviour it already had. This is not a new
 * failure mode being handled; it is one existing failure mode being taken back
 * out of a bucket it was never a member of.
 *
 * ## Why it lives here
 *
 * The seam is the only thing `core/` and the runner already share, and the
 * refusal is a property OF the seam: it is the model port saying it declined.
 * The runner's kill switch subclasses this rather than defining its own type,
 * so no vendor, service, or budget concept crosses into `core/` — an agent
 * knows only that the port refused, never what the limit was or who set it.
 */
export class LlmRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmRefused';
  }
}

/** What the product calls each connection on the surface the learner reads. */
export const CONNECTION_LABELS: Readonly<Record<ModelMode, string>> = Object.freeze({
  cloud: 'Cloud/API', local: 'Local', cli: 'Agent CLI',
});

/**
 * A call that was never issued, because the connection it was routed to has no
 * credential saved.
 *
 * The second instance of the refusal, beside the budget stop, and found the
 * same way. Dev pasted his real marking criteria, pressed "Check it", and got
 * *"That check did not run, so I have not read your work"* back in under a
 * second — while the service's own Settings receipt already said, in as many
 * words, "Google credentials are still needed". Deep work was routed to
 * Cloud/API, Cloud/API had nothing to authenticate with, and the request died
 * before it was built. Nothing failed. Nothing was ever sent.
 *
 * It is `LlmRefused` for exactly the reason the budget stop is: the agents in
 * `core/` catch a model failure and degrade, so a plain `Error` here reached
 * the learner as `model-failed` on every path that ran through one. The fix a
 * `model-failed` prompts — wait, retry, check the network — is the wrong fix,
 * and the right one is two clicks away in a panel the learner owns.
 *
 * `connection` travels with it because the sentence has to name which one is
 * unconfigured: on a board with Local ready and Cloud/API empty, "add a key"
 * is only actionable once you know where. And the fix differs per connection —
 * the Cloud/API key is the learner's to paste and the CLI token is the
 * operator's to start a bridge with, so a single "add one in Settings" would be
 * a true sentence pointed at a field one of them does not have.
 */
const CREDENTIAL_FIX: Readonly<Record<ModelMode, string>> = Object.freeze({
  cloud: 'The Cloud/API connection has no key saved. Add one in Settings → Models.',
  local: 'The Local connector is not running. Start the paired connector from Settings → Models.',
  cli: 'The Agent CLI connection has no token saved. '
    + 'Start an authenticated Agent CLI bridge to use this connection.',
});

export class LlmCredentialMissing extends LlmRefused {
  constructor(
    readonly connection: ModelMode,
    /** For the log and the operator, never for the learner. */
    readonly detail: string,
  ) {
    super(CREDENTIAL_FIX[connection]);
    this.name = 'LlmCredentialMissing';
  }
}

/** Named so the cost model in the architecture has something to count. */
export interface UsageLedger {
  record(agent: string, result: LlmResult<unknown>): void;
}
