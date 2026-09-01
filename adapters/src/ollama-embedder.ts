import type { Embedder } from '@sb/core';

/**
 * Local embedding adapter — Ollama's `/api/embed`.
 *
 * The default is `nomic-embed-text`: 274MB, no thinking pass, no token budget
 * to overrun, and none of the failure modes that make the chat endpoint hard.
 * An embedding call has no reasoning to disable and no JSON to truncate — the
 * two things that produced most of this project's dead ends — which is a large
 * part of why moving the partition here made it stable.
 *
 * At port this is one adapter swap to Vertex's text-embedding endpoint. The
 * threshold moves with it: cut points are per embedding space and are measured,
 * not assumed (see `thresholdFor` in core).
 */

export const DEFAULT_EMBED_MODEL = 'nomic-embed-text';

interface EmbedResponse {
  embeddings?: number[][];
}

export interface OllamaEmbedderOptions {
  readonly host?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  /**
   * Fixed, and fixed deliberately. Batch size is the one thing about this call
   * that could make the same text embed to different numbers on different runs,
   * so it must not vary with how many pins the learner happens to have.
   */
  readonly batchSize?: number;
}

export class OllamaEmbedder implements Embedder {
  readonly modelId: string;
  private readonly host: string;
  private readonly timeoutMs: number;
  private readonly batchSize: number;

  constructor(opts: OllamaEmbedderOptions = {}) {
    this.modelId = opts.model ?? DEFAULT_EMBED_MODEL;
    this.host = opts.host ?? 'http://127.0.0.1:11434';
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.batchSize = opts.batchSize ?? 16;
  }

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (!texts.length) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      out.push(...await this.call(batch));
    }
    if (out.length !== texts.length) {
      // Not recoverable by retrying: a short response means the vectors no
      // longer line up with the pins, and clustering the wrong pin to the wrong
      // vector is worse than not clustering at all.
      throw new Error(`ollama embed returned ${out.length} vectors for ${texts.length} texts`);
    }
    return out;
  }

  private async call(batch: readonly string[]): Promise<number[][]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const r = await fetch(`${this.host}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // An empty string embeds to a zero vector on some models and errors on
        // others. Substituting a single space keeps the response length equal
        // to the request length, which is the invariant everything downstream
        // depends on.
        body: JSON.stringify({ model: this.modelId, input: batch.map((t) => t.trim() || ' ') }),
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`ollama embed ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const body = await r.json() as EmbedResponse;
      const vectors = body.embeddings;
      if (!Array.isArray(vectors)) throw new Error('ollama embed returned no embeddings array');
      return vectors;
    } finally {
      clearTimeout(timer);
    }
  }
}
