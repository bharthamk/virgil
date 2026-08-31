/**
 * The embedding seam.
 *
 * Added for one reason, recorded in DEAD_ENDS.md D15: the same 21 pins, the
 * same prompt and the same model produced 6, 6 and 7 topics on three
 * consecutive runs. Asking a language model to partition a set is asking it for
 * the one thing it is worst at — a stable discrete decision — while the parts
 * it is genuinely good at, naming and summarising, do not need to be entangled
 * with the partition at all.
 *
 * So the partition moved into code. This port supplies the only input that
 * decision now takes: a vector per pin. Clustering itself is pure arithmetic in
 * `domain/clustering.ts`, and the model is left with the naming.
 *
 * Two implementations ship, and the second one matters as much as the first:
 * an embedding model over HTTP, and a zero-dependency TF-IDF space that needs
 * no model at all. A learner with nothing installed still gets a board.
 */
export interface Embedder {
  /**
   * Vectors in the same order as `texts`, one per text, all the same length.
   *
   * Must be deterministic: the same input array must yield the same numbers,
   * in this process and in the one that runs tomorrow night. An implementation
   * that samples cannot be used here, because the whole point is a partition
   * that does not move overnight.
   *
   * Batch dependence is the one exception, and it is a real one rather than a
   * loophole: `TfIdfEmbedder` fits its IDF to the batch it is handed, so the
   * same text in different company is different numbers. That is safe only
   * because the clusterer embeds the whole board in one call, and it is safe
   * for nothing else — vectors from two calls to a batch-fitted embedder are
   * vectors from two different spaces and comparing them is meaningless.
   *
   * An implementation therefore declares which it is, and the declaration is
   * checked in both directions by the conformance suite in
   * `adapters/src/__tests__/embedder-contract.ts`. Ordering is never negotiable:
   * a vector must follow its text through any batching the adapter does.
   */
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;

  /**
   * Provenance — which space these vectors live in.
   *
   * Load-bearing, not decorative: the similarity cut point is a property of the
   * embedding space and not of the algorithm, so `thresholdFor(modelId)` reads
   * this to pick the measured threshold. Vectors from two different models are
   * not comparable and must never be mixed inside one board.
   */
  readonly modelId: string;
}
