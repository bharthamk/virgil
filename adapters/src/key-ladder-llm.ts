import type { Llm, LlmRequest, LlmResult } from '../../core/src/ports/llm.js';
import { GeminiError } from './gemini-llm.js';

/**
 * Two credentials, one connection: the free key first, the paid key when the
 * free tier cannot answer.
 *
 * Only capacity failures (429 or 503) move to the paid credential. Request,
 * authentication, and transport failures remain visible to the caller. The
 * paid arm is budget-wrapped by the composition root, so its gate fires only
 * when fallback actually reaches for paid capacity.
 *
 * Without a free arm the composition root does not build this class at all,
 * preserving single-key behavior.
 */
const RUNG_OUT = (error: unknown): boolean =>
  error instanceof GeminiError && (error.status === 429 || error.status === 503);

export interface KeyLadderOptions {
  /**
   * The kill-switch, fired at the moment of reaching for money and never
   * before. The composition root passes the budget machinery's own stop —
   * armed per request where learners overlap, a direct closure where they
   * cannot — and whatever it throws leaves here untouched.
   */
  readonly beforePaid?: () => void | Promise<void>;
  /** Told which lane answered, for receipts. Never consulted for policy. */
  readonly onLane?: (lane: 'free' | 'paid') => void;
}

export class KeyLadderLlm implements Llm {
  constructor(
    /** The learner's lane: the free-tier key. Metered, never budget-gated. */
    private readonly free: Llm,
    /** The product's lane: the paid key, behind `beforePaid`. */
    private readonly paid: Llm,
    private readonly opts: KeyLadderOptions = {},
  ) {}

  async complete(req: LlmRequest): Promise<LlmResult<string>> {
    try {
      const res = await this.free.complete(req);
      this.opts.onLane?.('free');
      return res;
    } catch (error) {
      if (!RUNG_OUT(error)) throw error;
      await this.opts.beforePaid?.();
      const res = await this.paid.complete(req);
      this.opts.onLane?.('paid');
      return res;
    }
  }

  async structured<T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> {
    try {
      const res = await this.free.structured<T>(req);
      this.opts.onLane?.('free');
      return res;
    } catch (error) {
      if (!RUNG_OUT(error)) throw error;
      await this.opts.beforePaid?.();
      const res = await this.paid.structured<T>(req);
      this.opts.onLane?.('paid');
      return res;
    }
  }
}
