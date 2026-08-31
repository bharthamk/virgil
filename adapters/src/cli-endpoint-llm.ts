import { LlmCredentialMissing } from '@sb/core';
import type { Llm, LlmRequest, LlmResult, ModelTier } from '@sb/core';
import { DEFAULT_OUTPUT_TOKENS, runStructuredLadder } from './structured-ladder.js';

export interface CliEndpointOptions {
  readonly endpoint: string;
  /** Service-owned secret. Never accepted from or returned to the browser. */
  readonly token: string;
  readonly tiers?: Readonly<Record<ModelTier, string>>;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export const CLI_TIERS: Readonly<Record<ModelTier, string>> = {
  fast: 'cli-fast',
  deep: 'cli-deep',
};

export class CliEndpointError extends Error {
  readonly retryable: boolean;
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'CliEndpointError';
    this.retryable = status === undefined || status === 408 || status === 429 || status >= 500;
  }
}

export class CliEndpointLlm implements Llm {
  private readonly endpoint: string;
  private readonly tiers: Readonly<Record<ModelTier, string>>;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly opts: CliEndpointOptions) {
    const url = new URL(opts.endpoint);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('CLI endpoint must use http or https');
    // A refusal, not a fault: nothing was sent, and the fix is a bridge nobody
    // started rather than anything that went wrong. See `LlmCredentialMissing`.
    if (!opts.token.trim()) {
      throw new LlmCredentialMissing('cli', 'CLI endpoint requires an operator-configured token');
    }
    this.endpoint = url.toString().replace(/\/$/, '');
    this.tiers = opts.tiers ?? CLI_TIERS;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxResponseBytes = opts.maxResponseBytes ?? 1_048_576;
  }

  complete(req: LlmRequest): Promise<LlmResult<string>> { return this.call(req, false); }

  structured<T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> {
    return runStructuredLadder<T>(req, (attempt) => this.call(attempt, true));
  }

  private async call(req: LlmRequest, structured: boolean): Promise<LlmResult<string>> {
    const budget = Math.max(this.timeoutMs, 30_000 + (req.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS) * 120);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), budget);
    try {
      let response: Response;
      try {
        response = await fetch(`${this.endpoint}/v1/complete`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.opts.token}`,
          },
          body: JSON.stringify({
            model: this.tiers[req.tier], structured,
            reasoning: req.reasoning ?? 'on',
            system: req.system, prompt: req.prompt, media: req.media ?? [],
            ...(req.schema === undefined ? {} : { schema: req.schema }),
            maxOutputTokens: req.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS,
          }),
          signal: ctrl.signal,
        });
      } catch (error) {
        throw new CliEndpointError(`CLI endpoint could not be reached: ${String(error)}`);
      }
      if (!response.ok) {
        const detail = (await boundedText(response, this.maxResponseBytes)).slice(0, 1_000);
        throw new CliEndpointError(`CLI endpoint ${response.status}${detail ? `: ${detail}` : ''}`, response.status);
      }
      const text = await boundedText(response, this.maxResponseBytes);
      let body: Record<string, unknown>;
      try { body = JSON.parse(text) as Record<string, unknown>; }
      catch { throw new CliEndpointError('CLI endpoint returned invalid JSON'); }
      if (typeof body.value !== 'string' || typeof body.modelId !== 'string'
        || typeof body.inputTokens !== 'number' || !Number.isFinite(body.inputTokens)
        || typeof body.outputTokens !== 'number' || !Number.isFinite(body.outputTokens)) {
        throw new CliEndpointError('CLI endpoint returned an invalid result envelope');
      }
      return {
        value: body.value,
        modelId: body.modelId,
        inputTokens: Math.max(0, body.inputTokens),
        outputTokens: Math.max(0, body.outputTokens),
      };
    } finally { clearTimeout(timer); }
  }
}

async function boundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > limit) { await reader.cancel(); throw new CliEndpointError(`CLI endpoint exceeded ${limit} response bytes`); }
    text += decoder.decode(part.value, { stream: true });
  }
  return text + decoder.decode();
}
