import { LlmCredentialMissing } from '@sb/core';
import type { Llm, LlmRequest, LlmResult, ModelTier } from '@sb/core';
import { DEFAULT_OUTPUT_TOKENS, runStructuredLadder } from './structured-ladder.js';

/**
 * Gemini adapter — WIRED. This talks to the live Generative Language API.
 *
 * It began as a skeleton written to the documented request and response formats
 * and exercised only against invented shapes. That skeleton passed the whole
 * `Llm` contract, 28 assertions, without ever having made a call — which bounded
 * the shape risk and left the transport risk exactly where it was.
 *
 * On 2026-08-20 it was pointed at the real service with a free-tier key. Four of
 * the things it "knew" were wrong, and each one was a hard failure rather than a
 * degradation. They are recorded at the point of the fix rather than in a
 * changelog nobody opens, because every one of them is the same lesson: a mock
 * agrees with whatever you tell it, so the only facts a mock can establish are
 * the ones you already had. See `artifacts/GEMINI_TRANSPORT_PROOF_2026-08-20.md`
 * for the measurements behind each claim below.
 *
 *   1. `responseSchema` is not JSON Schema. A union type — `{"type":
 *      ["string","null"]}` — is a 400 with "Proto field is not repeating".
 *      FIVE of the eleven agents write their optional fields exactly that way,
 *      across eight fields — Scout, Forager, Composer, Reviewer and Tutor — so
 *      the first live Scout call would have failed outright.
 *      `toGeminiSchema` below translates; nothing else in the fleet changes.
 *
 *   2. There is no portable way to say "no thinking". `thinkingBudget: 0` is a
 *      400 on `gemini-3.5-flash-lite`; `thinkingLevel: 'minimal'` is a 400 on
 *      `gemini-3.7-flash`. `REASONING_OFF` therefore maps per model, and unknown
 *      models fall back to the one value every 3.x model accepted.
 *
 *   3. An error is served with `content-type: text/event-stream` and a body that
 *      is plain JSON, not SSE. An adapter that trusted the content type would
 *      find no `data:` lines and return the empty string — turning a 429 into
 *      "the model answered nothing", which the contract calls the worst possible
 *      outcome. Status is checked before the body is read, and stays checked.
 *
 *   4. Thinking tokens are billed as output and are NOT in
 *      `candidatesTokenCount`. A 5-token reply carried 75 thought tokens. The
 *      cost ledger would have under-counted output by 15x on that call.
 *
 * A fifth was added by the Gemma port, and it is the same lesson pointing the
 * other way:
 *
 *   5. A capability is a property of the model, not of the endpoint, and it can
 *      surprise in EITHER direction. `responseSchema` was expected to be absent
 *      on Gemma and is present and exact. `thinkingLevel: 'low'` — the value
 *      chosen above precisely because it was "the only value every model
 *      accepted" — is a hard 400 on both Gemma ids. The generalisation from five
 *      Gemini models did not survive the sixth and seventh, so the fallback is
 *      now per family and the table is the authority. Measurements in
 *      the Gemma transport and contract tests.
 *
 * Read `LOCAL_TIERS` in `ollama-llm.ts` beside `GEMINI_TIERS` below: the tier map
 * is the whole point of `ModelTier`, and it is still the only line an operator
 * should have to think about when the model names move on.
 */

/**
 * The shipped tier map. Both entries are live-verified on the free tier, and
 * both are pinned rather than aliased.
 *
 * Aliases were the obvious choice and are the wrong one. Measured the same day:
 * `gemini-flash-latest` resolves to `gemini-3.7-flash`, `gemini-flash-lite-latest`
 * to `gemini-3.5-flash-lite`, and `gemini-pro-latest` to `gemini-3.1-pro`. That
 * last one matters twice — it is below the 3.5+ floor the entry has to clear, and
 * it is the one model whose free-tier daily token quota was already exhausted. A
 * tier map that moves under a cost ledger is also a cost ledger that cannot be
 * reconciled, so the ids here are exact and change on purpose.
 *
 * `deep` is a Flash model because no Pro model at 3.5 or above is reachable on
 * this key at all. It is the model the quality probe actually measured
 * (`artifacts/GEMINI_FLASH_PROBE_2026-08-20.md`), so it is the honest deep tier
 * today — but it is a ceiling imposed by access, not a judgement that Flash is
 * the right deep tier. The Surveyor's 5x conservatism gap is the open question
 * this cannot answer; revisit the moment a 3.5+ Pro model is reachable.
 */
export const GEMINI_TIERS: Readonly<Record<ModelTier, string>> = {
  fast: 'gemini-3.5-flash-lite',
  deep: 'gemini-3.7-flash',
};

/**
 * The Gemma ids on this key, pinned. Neither has an alias to be trapped by.
 *
 * `ListModels` returned exactly two, both `-it` (instruction-tuned) and both
 * already a version-pinned id — there is no `gemma-latest` to get wrong, which is
 * the one way this family is easier than the Gemini one:
 *
 *   id                     params            context           chosen
 *   gemma-4-26b-a4b-it     26B, 4B active    262,144 / 32,768  yes
 *   gemma-4-31b-it         31B dense         262,144 / 32,768  no
 *
 * `a4b` is the sparse one: 26B of weights with roughly 4B active per token. That
 * is the relevant axis for the Scout, whose whole job is a 2-5 word label inside
 * a 1500ms toast, and it is the reason the SMALLER-active model is chosen over
 * the larger dense one rather than the other way round. Measured head to head on
 * the real Scout prompt they are close enough that latency alone would not
 * settle it (both around 1.0-1.6s); the tie is broken on the axis that will keep
 * being true when the network is not this network.
 *
 * Note what this map does NOT do: it leaves `deep` where `GEMINI_TIERS` put it.
 * "Scout onto Gemma" is a statement about the fast tier, and a Gemma deep tier
 * would be a quality decision nobody has evidence for.
 */
export const GEMMA_SCOUT_TIERS: Readonly<Record<ModelTier, string>> = {
  fast: 'gemma-4-26b-a4b-it',
  deep: GEMINI_TIERS.deep,
};

/**
 * Everything on this key with `gemma` in the name, so a test can iterate the
 * family rather than a hand-copied pair that drifts.
 */
export const GEMMA_MODELS: readonly string[] = ['gemma-4-26b-a4b-it', 'gemma-4-31b-it'];

/**
 * Where a request with images goes when the tier map's own model cannot take
 * one. Also the fast tier, which is not a coincidence: a pinned diagram is not
 * a "fast vs deep" decision (SB-09) and the fast model is the multimodal one.
 */
const VISION_MODEL = 'gemini-3.5-flash-lite';

/**
 * Which model ids on this key cannot read an image.
 *
 * This used to be the wrong question. Media forced `VISION_MODEL` on EVERY
 * request regardless of tier, which was harmless while the only thing that
 * carried an image was a pinned diagram going to the fast tier anyway — and
 * became a silent downgrade the moment the Check screen started sending a
 * learner's coursework as pages. A deep mark quietly answered by the flash-lite
 * model is the worst kind of wrong: nothing fails, the rows come back, and the
 * judgement behind them is the cheap model's.
 *
 * So the rule is a capability question rather than a tier one. Every Gemini 3.x
 * id in `GEMINI_TIERS` is multimodal, `gemini-3.7-flash` included, so a deep
 * request with pages stays on the deep model. The Gemma ids are the exception
 * and are matched by family: `ListModels` offers no capability flag, nothing in
 * this repository has probed either of them with an image, and guessing "yes"
 * on an unprobed model buys a 400 on a live mark. Guessing "no" costs a
 * downgrade the learner can see in `modelId`. That is the asymmetry, and it is
 * why the unknown case falls to the vision model rather than through it.
 *
 * The result already carries `modelId`, so whichever way this goes the ledger
 * and the receipt say which model actually answered.
 */
const TEXT_ONLY_FAMILY = /^gemma[-.]/i;

const seesImages = (model: string): boolean => !TEXT_ONLY_FAMILY.test(model);

/** What Gemini's `thinkingConfig` accepts. The two fields are mutually exclusive. */
interface ThinkingConfig {
  readonly thinkingBudget?: number;
  readonly thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high';
}

/**
 * How each model spells "reasoning off", because they do not agree, and there is
 * no value that both works everywhere and actually means off.
 *
 * Measured against the live service on 2026-08-20 — every cell below is a real
 * response, not documentation:
 *
 *   model                   thinkingBudget: 0   thinkingLevel:'minimal'   thinkingLevel:'low'
 *   gemini-3.7-flash        200, thoughts=54    400 INVALID_ARGUMENT      200, thoughts=55
 *   gemini-3.6-flash        400 INVALID_ARG     200, thoughts=0           200, thoughts=27
 *   gemini-3.5-flash        200, thoughts=0     200, thoughts=0           200, thoughts=27
 *   gemini-3.5-flash-lite   400 INVALID_ARG     200, thoughts=0           200, thoughts=0
 *   gemini-3.1-flash-lite   200, thoughts=0     200, thoughts=0           200, thoughts=26
 *   gemma-4-26b-a4b-it      400 INVALID_ARG     200, thoughts=0           400 INVALID_ARG
 *   gemma-4-31b-it          400 INVALID_ARG     200, thoughts=0           400 INVALID_ARG
 *
 * The last two rows were added by the Gemma port and they are the reason the
 * fallback below is no longer a constant. Both refuse with a message that names
 * the model rather than the value — "Thinking level is not supported for this
 * model", "Thinking budget is not supported for this model" — so Gemma's
 * position is not "a different dialect" but "this control does not exist here,
 * except for the one value that means off". `minimal` is accepted and really is
 * off: thoughts=0, against 24-54 thought tokens for a ONE-token answer when no
 * `thinkingConfig` is sent at all. On Gemma the lever is not an optimisation,
 * it is most of the call.
 *
 * Three things fall out of that table and all three are load-bearing:
 *
 *  1. `thinkingBudget: 0` — what the skeleton sent unconditionally — is a hard
 *     400 on two of the five. Every foreground agent sets `reasoning: 'off'`, so
 *     that is every foreground call failing outright on those models.
 *  2. `thinkingLevel: 'minimal'` is the widest TRUE off: `thoughtsTokenCount: 0`
 *     on all four that accept it. `gemini-3.7-flash` is the lone refusal.
 *  3. On `gemini-3.7-flash` there is NO encoding that zeroes the thinking pass.
 *     `thinkingBudget: 0` is accepted and still bills 54 thought tokens. The
 *     latency lever is real there (5.4s -> 1.9s on the same prompt) but "off" is
 *     a request rather than a guarantee, and D2's 12x figure is a local-model
 *     measurement that does not transfer.
 *
 * So: `minimal` for everything, with one named exception. Entries here are only
 * added once `gemini-live.test.ts` has seen the model accept them — a guessed
 * entry is a 400 on every foreground call to that model, and this table already
 * caught one of its own author's guesses that way.
 */
export const REASONING_OFF: Readonly<Record<string, ThinkingConfig>> = {
  'gemini-3.7-flash': { thinkingBudget: 0 },
  'gemini-3.6-flash': { thinkingLevel: 'minimal' },
  'gemini-3.5-flash': { thinkingLevel: 'minimal' },
  'gemini-3.5-flash-lite': { thinkingLevel: 'minimal' },
  'gemini-3.1-flash-lite': { thinkingLevel: 'minimal' },
  'gemma-4-26b-a4b-it': { thinkingLevel: 'minimal' },
  'gemma-4-31b-it': { thinkingLevel: 'minimal' },
};

/** An id in the Gemma family, which spells this differently from every Gemini one. */
const GEMMA_FAMILY = /^gemma[-.]/i;

/**
 * For a model not in the table — and it is a function now, because the constant
 * it replaces was wrong.
 *
 * It used to be `{ thinkingLevel: 'low' }` on the stated ground that `low` was
 * "the only value every model probed accepted". That was true of the five models
 * probed. It is false of the seventh: `low` is a 400 on both Gemma ids, and so
 * is `thinkingBudget: 0`, leaving `minimal` — the value the Gemini deep tier
 * refuses — as the only encoding Gemma takes. There is no value that works
 * everywhere any more, and picking one would be choosing which family to break.
 *
 * So the guess is made per family, which is the level the evidence actually
 * supports: both Gemma ids agree with each other and disagree with every Gemini
 * id, and the provider's own refusal says "not supported for THIS MODEL" rather
 * than "bad value". A new `gemma-5-*` appearing on `ListModels` inherits the
 * encoding its family has always used instead of inheriting a 400 on every
 * foreground call — which is what the old constant would have handed it, and
 * exactly the 3am failure D10 is named after.
 *
 * This stays a guess either way. An id gets promoted into the table above the
 * moment `gemini-live.test.ts` has watched it accept something, and the guess is
 * only ever the thing that keeps an unseen model degraded rather than broken.
 */
const portableReasoningOff = (model: string): ThinkingConfig =>
  (GEMMA_FAMILY.test(model) ? { thinkingLevel: 'minimal' } : { thinkingLevel: 'low' });

/**
 * Reasoning ON sends no `thinkingConfig` at all, which is the provider's own
 * dynamic default. Naming a level would be this adapter deciding how hard the
 * deep tier should think, which is the model's job and not the seam's.
 */

export interface GeminiOptions {
  /** A resolver is evaluated per call so a self-hosted service can rotate a
   * service-owned key without rebuilding the process. */
  readonly apiKey?: string | (() => string | undefined);
  readonly endpoint?: string;
  /** OAuth token source for Vertex AI. When present it replaces the API-key
   * header; the token is resolved per call so Cloud Run can rotate it. */
  readonly accessToken?: () => Promise<string | undefined>;
  /** Full provider model address, without `?alt=sse`. The Generative Language
   * API path remains the default; Vertex supplies its project-qualified path. */
  readonly modelEndpoint?: (model: string) => string;
  readonly tiers?: Readonly<Record<ModelTier, string>>;
  readonly timeoutMs?: number;
}

/**
 * A failure that reached us from the provider, with the envelope decoded.
 *
 * The contract only requires that the status survives into the message, and the
 * message keeps that shape. The extra fields exist because one of them is not
 * guessable: an invalid API key is a **400 INVALID_ARGUMENT**, not a 401 and not
 * a 403. Anything that wants to tell "your key is wrong" apart from "your request
 * is wrong" has to read `reason`, because the status code cannot distinguish them.
 */
export class GeminiError extends Error {
  constructor(
    readonly status: number,
    readonly providerStatus: string,
    readonly reason: string | undefined,
    message: string,
    /**
     * How long the provider asked us to wait, in ms, when it said so.
     *
     * It does NOT say so in a `Retry-After` header — there is no such header on
     * these responses. The only machine-readable copy is a `google.rpc.RetryInfo`
     * entry in `details`, e.g. `{"retryDelay": "7s"}`. Anything looking for the
     * standard header finds nothing and backs off on a guess.
     */
    readonly retryAfterMs?: number,
    /**
     * Which quota was hit, when one was. The distinction that matters is in the
     * name: `...PerMinute...` is worth waiting out, `...PerDay...` is not.
     */
    readonly quotaId?: string,
  ) {
    super(message);
    this.name = 'GeminiError';
  }

  /** True for the statuses that are about capacity rather than about the request. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }

  /**
   * A daily cap, which waiting will not fix.
   *
   * Free tier on `gemini-3.7-flash` is twenty requests per day. A nightly run is
   * seven model calls, so this is not a theoretical limit — it is two or three
   * runs, and a runner that treats it as "back off and try again" will spin until
   * morning instead of degrading the stage and moving on (D10).
   */
  get exhaustedForPeriod(): boolean {
    return /PerDay/i.test(this.quotaId ?? '');
  }
}

/**
 * The provider refused, over a 200.
 *
 * `GeminiError` above is the decoded *error envelope* — a 4xx or 5xx, a
 * transport-level fact. This is the other kind of failure, and it is the one
 * that is dangerous precisely because it does not look like one: a candidate
 * terminated on the content policy arrives with an ordinary status, ordinary SSE
 * framing, ordinary usage metadata, and no text. §3z of the transport proof left
 * it open rather than guess at it, because "no text" is a legitimate answer
 * everywhere in this fleet — the Forager's `nothing-found`, the Composer's
 * `nothing-to-teach` — and a refusal wearing that costume tells the learner the
 * board was quiet when in fact the model would not teach it.
 *
 * Fail closed: a block is a model
 * failure. It is a rejection rather than a typed result because the port has no
 * other error channel — `LlmResult` carries a value, an id and two token counts,
 * and every other not-an-answer in `llm-contract.ts` rejects. Upstream, a throw
 * out of this seam is already what the agents record as `model-failed`, so this
 * lands in machinery that exists instead of asking eleven agents to learn a
 * second vocabulary. Its own class, rather than a bare `Error`, because a caller
 * that wants to degrade differently for "refused" than for "rate-limited" has to
 * be able to tell them apart without reading the message.
 */
export class GeminiBlockedError extends Error {
  constructor(
    /** The candidate's `finishReason`, when generation started and was stopped. */
    readonly finishReason: string | undefined,
    /** `promptFeedback.blockReason`, when the prompt itself was refused. */
    readonly blockReason: string | undefined,
    /** How much text had already streamed. Never returned — recorded so the log can say. */
    readonly partialLength: number,
  ) {
    super(
      `gemini blocked ${finishReason ?? blockReason ?? 'UNSPECIFIED'}: `
      + `the provider terminated this reply on its own content policy`
      + (partialLength ? ` after ${partialLength} characters` : ' before any text')
      + ' — this is a model failure, not an empty answer',
    );
    this.name = 'GeminiBlockedError';
  }
}

/**
 * The finish reasons that mean "no usable answer", as opposed to "an answer".
 *
 * `STOP` is the ordinary end and an absent reason is a mid-stream event. The one
 * that is deliberately NOT here is `MAX_TOKENS`: truncation is a budget problem
 * with a documented repair — the structured ladder's second rung doubles the
 * headroom and retries — and promoting it to a hard failure would delete D10's
 * fix. Everything else the envelope can carry is a refusal.
 *
 * Unknown reasons are treated as blocks, which is the fail-closed direction
 * the provider-refusal contract asks for: a reason nobody has seen before, arriving with no text,
 * is exactly the case this list exists to stop being read as silence.
 */
const BENIGN_FINISH_REASONS: ReadonlySet<string> = new Set(['STOP', 'MAX_TOKENS']);

interface GeminiPart { text?: string; inlineData?: { mimeType: string; data: string } }
interface GeminiChunk {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  modelVersion?: string;
}

export class GeminiLlm implements Llm {
  private readonly apiKey: () => string;
  private readonly endpoint: string;
  private readonly accessToken: (() => Promise<string | undefined>) | null;
  private readonly modelEndpoint: ((model: string) => string) | null;
  private readonly tiers: Readonly<Record<ModelTier, string>>;
  private readonly timeoutMs: number;

  constructor(opts: GeminiOptions = {}) {
    // The composition root normally reads config and hands it over — that is how
    // `SB_DB` and `SB_PORT` reach the runner. A key is the exception: it is read
    // here so that it has exactly one name in the process and never has to be
    // passed through a call chain that might log it. The file it comes from lives
    // outside the repo at `~/.config/virgil/env`, mode 600.
    const configured = opts.apiKey ?? process.env.GEMINI_API_KEY ?? '';
    this.apiKey = typeof configured === 'function'
      ? () => configured()?.trim() ?? ''
      : () => configured.trim();
    this.endpoint = opts.endpoint ?? 'https://generativelanguage.googleapis.com/v1beta';
    this.accessToken = opts.accessToken ?? null;
    this.modelEndpoint = opts.modelEndpoint ?? null;
    this.tiers = opts.tiers ?? GEMINI_TIERS;
    // Floor, not ceiling — see the per-request budget in call().
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  /**
   * Validate the current credential against ListModels. This reaches the
   * provider but performs no generation and returns no credential material.
   */
  async checkAccess(): Promise<{ readonly models: readonly string[] }> {
    if (this.accessToken && this.modelEndpoint) {
      // Vertex has no API-key ListModels equivalent at this prediction path.
      // A tiny real inference is the only check that proves both IAM and model
      // availability; the caller asked for a connection check, so one call is
      // more honest than returning configured names as though they answered.
      await this.complete({
        tier: 'fast', system: 'Connection check.', prompt: 'Reply READY.',
        reasoning: 'off', maxOutputTokens: 8,
      });
      return { models: [...new Set(Object.values(this.tiers))] };
    }
    const apiKey = this.apiKey();
    if (!apiKey) throw new Error('GeminiLlm has no API key');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(this.timeoutMs, 10_000));
    try {
      const response = await fetch(`${this.endpoint}/models?pageSize=100`, {
        headers: { 'x-goog-api-key': apiKey }, signal: ctrl.signal,
      });
      if (!response.ok) throw await geminiError(response);
      const body = await response.json() as { models?: { name?: unknown }[] };
      const models = (body.models ?? []).flatMap((entry) =>
        typeof entry?.name === 'string' ? [entry.name.replace(/^models\//, '')] : []);
      return { models };
    } finally { clearTimeout(timer); }
  }

  async complete(req: LlmRequest): Promise<LlmResult<string>> {
    return this.call(req, false);
  }

  /**
   * The same escalation ladder the local adapter runs — literally the same code,
   * in `structured-ladder.ts`.
   *
   * The skeleton's note said this would survive the port and it did, but for a
   * reason the skeleton got slightly wrong. It expected native `responseSchema`
   * to take the sampler's role and make rung one stronger than `format: 'json'`.
   * It does — the live service returned conforming JSON on the first attempt in
   * every structured call made against it. What the skeleton did not anticipate
   * is that the schema has to be *translated* before it can be sent at all, and a
   * translator is a thing that can be wrong in ways the model then obeys
   * perfectly. The ladder's third rung — validate what came back against the
   * ORIGINAL JSON Schema, not the translated one — is what catches that, and it
   * is the reason `validateSchema` stays even though the provider claims to
   * enforce the shape itself.
   *
   * ## Gemma, and the fallback that turned out not to be needed
   *
   * The Gemma port was planned around the opposite assumption. Gemma endpoints
   * have historically not carried structured output, so the work was scoped as
   * "wire it, and when `responseSchema` 400s, drop back to JSON-prompting and let
   * the ladder do the enforcing". Probed rather than assumed, and the assumption
   * was wrong: `responseSchema` + `responseMimeType: 'application/json'` is
   * accepted on BOTH Gemma ids and comes back exact, including the `nullable`
   * flag `toGeminiSchema` produces from the Scout's `['string','null']` union.
   *
   * So no rung was added, and the reason for not adding one is worth as much as
   * the finding: a fallback nobody's provider needs is a path nobody's tests
   * cover, and this project has a file named `DEAD_ENDS.md` for a reason. The
   * fallback that would have been built already exists anyway and is not
   * Gemma-specific — `firstBalancedObject` in `structured-ladder.ts` extracts an
   * object out of fences and preamble, and every agent that asks for JSON says
   * "Answer with JSON only" in its system prompt. What a Gemma reply that never
   * parses gets is what any model's does: two more rungs, and then a rejection
   * that Scout's caller turns into `fallbackLabel`.
   *
   * One measured caveat, recorded because it is not obvious: on Gemma, sending
   * `responseSchema` appears to suppress the thinking pass by itself —
   * `thoughtsTokenCount` is absent on a structured call that carries no
   * `thinkingConfig` at all, where the same prompt unstructured spends 46. That
   * is a happy accident and is NOT relied on. `reasoning: 'off'` still sends
   * `thinkingLevel: 'minimal'`, because a behaviour the provider never documented
   * is a behaviour it can withdraw.
   */
  async structured<T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> {
    return runStructuredLadder<T>(req, (attempt) => this.call(attempt, true));
  }

  private async call(req: LlmRequest, json: boolean): Promise<LlmResult<string>> {
    const apiKey = this.apiKey();
    const accessToken = this.accessToken ? (await this.accessToken())?.trim() ?? '' : '';
    if (!apiKey && !accessToken) {
      /*
       * Better here than as a 400 INVALID_ARGUMENT forty milliseconds later. The
       * provider's message for a missing key is "API key not valid", which sends
       * the reader looking at the key they have rather than at the one they never
       * set — D11's rule applied to a config error.
       *
       * `LlmCredentialMissing` rather than `Error`, because the type is what
       * carries the distinction the whole way up. Nothing has been sent and
       * nothing has failed: this is a refusal, and a plain `Error` here was
       * caught by every agent that degrades on a model failure and reached the
       * learner as "that check did not run" — which is the one sentence that
       * cannot be acted on, over a fix that is two clicks away in Settings.
       */
      throw new LlmCredentialMissing(
        'cloud',
        'GeminiLlm has no API key: pass `apiKey` or set GEMINI_API_KEY in the environment',
      );
    }

    const tierModel = this.tiers[req.tier];
    const model = req.media?.length && !seesImages(tierModel) ? VISION_MODEL : tierModel;

    const parts: GeminiPart[] = [{ text: req.prompt }];
    for (const m of req.media ?? []) {
      const { mimeType, data } = splitDataUri(m.ref);
      parts.push({ inlineData: { mimeType, data } });
    }

    const reasoningOff = (req.reasoning ?? 'on') === 'off';
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        maxOutputTokens: req.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS,
        ...(reasoningOff
          ? { thinkingConfig: REASONING_OFF[model] ?? portableReasoningOff(model) }
          : {}),
        ...(json
          ? { responseMimeType: 'application/json', responseSchema: toGeminiSchema(req.schema) }
          : {}),
      },
    };

    // Streamed, for D19's reason and not for the user's: a silent connection is
    // where undici's own body timeout applies instead of ours. Confirmed still
    // true against this service — a 60,000-token prompt came back over 13 SSE
    // events rather than one, so the bytes really do keep arriving.
    const budget = Math.max(this.timeoutMs, 30_000 + (req.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS) * 120);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), budget);
    try {
      const modelAddress = this.modelEndpoint
        ? this.modelEndpoint(model)
        : `${this.endpoint}/models/${model}:streamGenerateContent`;
      const r = await fetch(`${modelAddress}?alt=sse`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(accessToken
            ? { authorization: `Bearer ${accessToken}` }
            : { 'x-goog-api-key': apiKey }),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      // Before the body, always. An error arrives with the streaming content type
      // and a non-streaming body; parsing it as SSE yields nothing and would let
      // a 429 resolve as an empty string.
      if (!r.ok) throw await geminiError(r);
      if (!r.body) throw new Error('gemini returned no body');

      let content = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let modelVersion = '';
      let buffer = '';
      let blockedBy: string | undefined;
      let promptBlockedBy: string | undefined;
      const decoder = new TextDecoder();

      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        // `stream: true` is load-bearing: a multi-byte character split across
        // two chunks is decoded correctly only if the decoder keeps its state.
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          // `trim` also removes the CR: this service frames its events with
          // CRLF, which `indexOf('\n')` alone would leave on the end of the line.
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          // No `[DONE]` sentinel is sent — the stream simply ends. Checked anyway;
          // it costs a comparison and the day it appears nothing breaks.
          if (!payload || payload === '[DONE]') continue;
          try {
            const part = JSON.parse(payload) as GeminiChunk;
            for (const c of part.candidates ?? []) {
              // A part can carry a `thoughtSignature` and no text at all. `?? ''`
              // is what makes that a no-op rather than an "undefined" in the middle
              // of a learner's section.
              for (const p of c.content?.parts ?? []) content += p.text ?? '';
              // Noted, not thrown from here: the stream is drained first so that
              // the token counts are whole and the connection is not left half-read.
              if (c.finishReason && !BENIGN_FINISH_REASONS.has(c.finishReason)) {
                blockedBy ??= c.finishReason;
              }
            }
            // No candidate at all: the prompt was refused before generation, and
            // `promptFeedback` is the only place that says so.
            if (part.promptFeedback?.blockReason) promptBlockedBy ??= part.promptFeedback.blockReason;
            const u = part.usageMetadata;
            if (u?.promptTokenCount) inputTokens = u.promptTokenCount;
            // Thinking tokens are billed as output and are reported separately.
            // Adding them is what makes the ledger match the invoice; the local
            // adapter has no equivalent because Ollama bills nothing.
            if (u?.candidatesTokenCount || u?.thoughtsTokenCount) {
              outputTokens = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
            }
            if (part.modelVersion) modelVersion = part.modelVersion;
          } catch {
            // A partial event mid-chunk is normal; the next chunk completes it.
          }
        }
      }

      // The provider-refusal contract, and the last thing that happens before a result exists: a
      // blocked reply never becomes an `LlmResult`, whether it carried partial
      // text or none. Half a section that reads as a whole one is D10 in a
      // different costume — the learner cannot tell where the model stopped.
      if (blockedBy || promptBlockedBy) {
        throw new GeminiBlockedError(blockedBy, promptBlockedBy, content.length);
      }

      // The version the service says answered, not the id we asked for. They are
      // the same for a pinned id and differ for an alias, and the ledger wants the
      // one that is true.
      return { value: content, modelId: modelVersion || model, inputTokens, outputTokens };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The provider's error envelope, decoded.
 *
 * Shape confirmed live across 400, 404, 429 and 503:
 * `{"error":{"code":N,"message":"...","status":"UPPER_SNAKE","details":[...]}}`.
 * The message keeps the numeric status at the front because that is what every
 * caller greps for, and because a stack trace at 3am is read by eye.
 */
interface ErrorDetail {
  '@type'?: string;
  reason?: string;
  retryDelay?: string;
  violations?: { quotaId?: string; quotaValue?: string }[];
}

async function geminiError(r: Response): Promise<GeminiError> {
  const raw = await r.text().catch(() => '');
  let providerStatus = '';
  let reason: string | undefined;
  let retryAfterMs: number | undefined;
  let quotaId: string | undefined;
  let message = raw.slice(0, 500);
  try {
    const env = JSON.parse(raw) as {
      error?: { message?: string; status?: string; details?: ErrorDetail[] };
    };
    if (env.error) {
      providerStatus = env.error.status ?? '';
      message = env.error.message ?? message;
      const details = env.error.details ?? [];
      reason = details.find((d) => d.reason)?.reason;
      // `"7s"`, `"55.5s"`. A duration string, not a number of seconds.
      const delay = details.find((d) => d.retryDelay)?.retryDelay;
      const seconds = delay ? Number.parseFloat(delay) : Number.NaN;
      if (Number.isFinite(seconds)) retryAfterMs = Math.round(seconds * 1000);
      quotaId = details.flatMap((d) => d.violations ?? []).find((v) => v.quotaId)?.quotaId;
    }
  } catch {
    // A non-JSON error body is possible from a proxy in front of the service;
    // the status is still the fact that matters, so it is not worth failing over.
  }
  const label = [providerStatus, reason].filter(Boolean).join('/');
  return new GeminiError(
    r.status,
    providerStatus,
    reason,
    `gemini ${r.status}${label ? ` ${label}` : ''}: ${message}`,
    retryAfterMs,
    quotaId,
  );
}

/**
 * JSON Schema as the agents write it -> the OpenAPI subset `responseSchema` takes.
 *
 * This function is the single most load-bearing thing the live call taught us.
 * The skeleton passed `req.schema` through untouched, which is a 400 on eight
 * fields across five of the eleven agents:
 *
 *     {"type": ["string", "null"]}
 *     -> 400 Invalid JSON payload received. Unknown name "type" at
 *        'generation_config.response_schema.properties[2].value':
 *        Proto field is not repeating, cannot start list.
 *
 * `responseSchema` is a proto message, so `type` is a single enum value and a
 * union cannot be expressed as a list. Optionality is a sibling flag instead.
 * The translation is small because the subset the agents use is small — the same
 * subset `json-schema.ts` validates, deliberately.
 *
 * What is dropped rather than translated: `additionalProperties`, which no agent
 * schema uses and which the proto has no field for. If one ever does, it will be
 * dropped silently here and still enforced by `validateSchema` on the way back,
 * which is the safe direction to be wrong in.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;

  const node = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    if (key === 'additionalProperties') continue;

    if (key === 'type' && Array.isArray(value)) {
      const types = value as string[];
      const concrete = types.filter((t) => t !== 'null');
      if (types.includes('null')) out.nullable = true;
      // A union of two real types has no proto representation either. The first
      // is sent and `validateSchema` still accepts both on the way back, so the
      // model is told less than the agent will tolerate — never more.
      if (concrete.length > 0) out.type = concrete[0];
      continue;
    }

    if (key === 'properties' && value && typeof value === 'object') {
      const props: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
        props[name] = toGeminiSchema(sub);
      }
      out.properties = props;
      continue;
    }

    if (key === 'items') {
      out.items = toGeminiSchema(value);
      continue;
    }

    out[key] = value;
  }

  return out;
}

/** `inlineData` wants the mime type and the payload apart, not a data URI. */
const splitDataUri = (ref: string): { mimeType: string; data: string } => {
  const m = /^data:([^;]+);base64,(.*)$/.exec(ref);
  return m ? { mimeType: m[1] as string, data: m[2] as string } : { mimeType: 'image/png', data: ref };
};
