import type { Llm, LlmRequest, LlmResult, ModelTier } from '@sb/core';
import { DEFAULT_OUTPUT_TOKENS, runStructuredLadder } from './structured-ladder.js';

/**
 * Local model adapter — Ollama.
 *
 * The tier map is the whole point of `ModelTier`. Agents ask for the kind of
 * thinking they need; this decides what serves it. At port, only the deep tier
 * changes: Scout's `fast` tier is Gemma here and Gemma on Vertex, same family
 * either side of the seam.
 */
export const LOCAL_TIERS: Readonly<Record<ModelTier, string>> = {
  fast: 'gemma4:12b-mlx',
  deep: 'qwen3.8:27b-mlx',
};

const VISION_MODEL = 'qwen3-vl:8b';

/**
 * Which installed local models can read an image.
 *
 * The cloud adapter's rule, stated the other way round, because the local
 * answer is the opposite one. `gemini-3.7-flash` is multimodal, so a deep
 * request with pages stays on the deep model there. NEITHER model in
 * `LOCAL_TIERS` is: `gemma4:12b-mlx` and `qwen3.8:27b-mlx` are the text builds
 * that are actually pulled on this machine, and handing either an `images`
 * array gets the images ignored rather than an error — which is the failure
 * mode worth caring about, since the reply comes back looking fine and is a
 * verdict on nothing.
 *
 * So on the local stack, media still means `qwen3-vl:8b` on both tiers. That is
 * a downgrade for a deep call and it is the honest one available: it is the
 * strongest vision model installed here, and the alternative is a mark on pages
 * the model never saw. The choice is visible rather than silent — `modelId` in
 * the result is the model that answered, and the Check screen reads it.
 *
 * Matched by name rather than listed, so an operator who pulls a vision build
 * and points a tier at it gets their tier honoured instead of inheriting a
 * hardcoded exception written before their model existed.
 */
const SEES_IMAGES = /(^|[:/_-])(vl|vision|llava|moondream)([:._-]|\d|$)/i;

interface OllamaResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface OllamaOptions {
  readonly host?: string;
  readonly tiers?: Readonly<Record<ModelTier, string>>;
  readonly timeoutMs?: number;
}

export class OllamaLlm implements Llm {
  private readonly host: string;
  private readonly tiers: Readonly<Record<ModelTier, string>>;
  private readonly timeoutMs: number;

  constructor(opts: OllamaOptions = {}) {
    this.host = opts.host ?? 'http://127.0.0.1:11434';
    this.tiers = opts.tiers ?? LOCAL_TIERS;
    // Floor, not ceiling — see the per-request budget in call().
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async complete(req: LlmRequest): Promise<LlmResult<string>> {
    return this.call(req, false);
  }

  /**
   * Structured output, on the shared escalation ladder in `structured-ladder.ts`.
   *
   * The ladder — headroom, then no thinking, never a retry of a dead transport —
   * is a property of asking a language model for JSON and not of this provider,
   * so it lives once and both adapters run it. What is local is the layering
   * underneath, and each layer catches something the next cannot:
   *
   *   `format: 'json'`      — Ollama constrains the sampler to well-formed JSON.
   *   `firstBalancedObject` — belt and braces: fences and stray preamble still
   *                           get through on some models, so the first balanced
   *                           object is extracted rather than trusted.
   *   `validateSchema`      — the port promises the schema is ENFORCED. Well-
   *                           formed JSON of the wrong shape used to pass
   *                           silently; it now fails and the violations are
   *                           handed back to the model as a repair instruction.
   *
   * At port the first and third layers collapse into Gemini's native
   * `responseSchema`; the extractor stays, because it costs nothing.
   */
  async structured<T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> {
    return runStructuredLadder<T>(req, (attempt) => this.call(attempt, true));
  }

  private async call(req: LlmRequest, json: boolean): Promise<LlmResult<string>> {
    // A request with images goes to the model that can see them, which on this
    // stack is never the tier model. See `SEES_IMAGES` for why that is stated
    // as a capability rather than as "media means vision".
    const tierModel = this.tiers[req.tier];
    const model = req.media?.length && !SEES_IMAGES.test(tierModel) ? VISION_MODEL : tierModel;
    const images = req.media?.map((m) => stripDataUri(m.ref));

    // Streamed, deliberately.
    //
    // A non-streaming request sits silent while the model generates, and Node's
    // built-in fetch (undici) applies its OWN body timeout of ~300s that an
    // AbortController does not override. A long Composer call died with a bare
    // "TypeError: fetch failed" at 558s despite a 750s abort budget. Streaming
    // keeps bytes arriving, so the only timeout that applies is ours.
    const body = {
      model,
      stream: true,
      // Measured: disabling the thinking pass takes a Scout label from ~5000ms
      // to ~420ms. Foreground agents depend on this; background agents want the
      // reasoning and can afford it.
      think: (req.reasoning ?? 'on') === 'on',
      ...(json ? { format: isJsonSchema(req.schema) ? req.schema : 'json' as const } : {}),
      options: { num_predict: req.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS },
      messages: [
        { role: 'system', content: req.system },
        {
          role: 'user',
          content: json ? `${req.prompt}\n\nReturn JSON matching:\n${JSON.stringify(req.schema)}` : req.prompt,
          ...(images?.length ? { images } : {}),
        },
      ],
    };

    // Timeout scales with how much we asked for. A flat cap aborted the
    // Composer at 300s while it was legitimately still writing three long
    // sections, and the escalating retry then multiplied the wasted time into a
    // 499s failure. Local generation runs on the order of 100ms/token, so the
    // budget has to follow the request rather than sit at a constant.
    const budget = Math.max(this.timeoutMs, 30_000 + (req.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS) * 120);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), budget);
    try {
      const r = await fetch(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`ollama ${r.status}: ${await r.text()}`);
      if (!r.body) throw new Error('ollama returned no body');

      // NDJSON: one object per chunk, the last carrying the token counts.
      let content = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let buffer = '';
      const decoder = new TextDecoder();

      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          try {
            const part = JSON.parse(line) as OllamaResponse;
            content += part.message?.content ?? '';
            if (part.prompt_eval_count) inputTokens = part.prompt_eval_count;
            if (part.eval_count) outputTokens = part.eval_count;
          } catch {
            // A partial line mid-chunk is normal; the next chunk completes it.
          }
        }
      }

      return { value: content, modelId: model, inputTokens, outputTokens };
    } finally {
      clearTimeout(timer);
    }
  }
}

const isJsonSchema = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stripDataUri = (ref: string): string => {
  const m = /^data:[^;]+;base64,(.*)$/.exec(ref);
  return m?.[1] ?? ref;
};
