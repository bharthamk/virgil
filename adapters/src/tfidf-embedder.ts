import type { Embedder } from '@sb/core';

/**
 * TF-IDF cosine vectors, in plain TypeScript, with no model and no dependency.
 *
 * This is the honest-degradation path for clustering, and it is the reason the
 * board is not gated on having an embedding model installed. Everything else in
 * the fleet degrades when a model is missing — a session without observations
 * is still a session. Clustering could not degrade at all: no partition, no
 * topics, no board, nothing. That was unacceptable for the one stage that
 * decides what the product even contains.
 *
 * It is genuinely worse than a trained embedding space and the difference is
 * exactly where you would expect it: TF-IDF matches words, so two pins about
 * the same idea in different vocabulary look unrelated to it. Measured against
 * the golden key in AGENT_EVAL_LOG.md Run 5.
 *
 * Deterministic by construction: the vocabulary is sorted, the vector is dense
 * over that sorted vocabulary, and nothing consults a clock, a hash seed or an
 * iteration order.
 *
 * One property worth stating plainly, because it looks like a bug: IDF is
 * computed over the batch handed to `embed`, so the same text embeds to
 * different numbers in different batches. That is fine here and only here —
 * the clusterer embeds the whole board in one call, so every comparison it
 * makes is within one consistent space, and attach-only means a shifted space
 * cannot move a pin that already has a topic.
 */

/**
 * A small stop list, not a large one. Aggressive stop-word removal on short
 * technical text deletes real signal — "not", "before", "only" and "within" are
 * doing load-bearing work in a passage about a guarantee's scope, which is
 * precisely what this learner keeps missing.
 */
const STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by',
  'can', 'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'if', 'in',
  'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'them',
  'then', 'there', 'these', 'they', 'this', 'those', 'to', 'was', 'were',
  'what', 'when', 'which', 'will', 'with', 'you', 'your',
]);

/**
 * Suffix stripping, not stemming. Four rules, applied to tokens long enough to
 * survive them. A real stemmer would be a dependency, and Porter's aggressive
 * cases ("ordering" -> "order" is wanted; "queries" -> "queri" is not) do not
 * pay for themselves at this corpus size.
 */
function normalise(token: string): string {
  let t = token;
  if (t.length > 4 && t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && t.endsWith('ing')) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith('ed')) t = t.slice(0, -2);
  // `-es` comes off only after a sibilant — boxes, matches, classes. A blanket
  // `-es` rule takes "messages" to "messag" while "message" stays whole, so the
  // singular and the plural end up in two different dimensions, which is the
  // exact opposite of what stemming is for. Caught by a test, not by reading.
  else if (t.length > 4 && /(?:s|x|z|ch|sh)es$/.test(t)) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  return t;
}

/** Splits on anything that is not a letter or digit. Keeps `pubsub`, splits
 *  `maxExtension` only at the case boundary, which is why camelCase is broken
 *  first — identifiers carry the same terms as the prose around them. */
export function tokenize(text: string): readonly string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(normalise)
    .filter((t) => t.length > 1);
}

export class TfIdfEmbedder implements Embedder {
  readonly modelId = 'tfidf-v1';

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    const docs = texts.map(tokenize);

    // Document frequency over the batch, then a sorted vocabulary. Sorting is
    // what makes the dimension order reproducible across processes — Map
    // insertion order would be reproducible too, but only by accident of how
    // the caller ordered its input.
    const df = new Map<string, number>();
    for (const doc of docs) {
      for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1);
    }
    const vocab = [...df.keys()].sort();
    const index = new Map(vocab.map((t, i) => [t, i]));
    const n = docs.length;

    // Smoothed IDF: log((N + 1) / (df + 1)) + 1. The +1s keep a term that
    // appears in every document at a small positive weight rather than exactly
    // zero, which matters on a 21-document corpus where "delivery" appearing
    // everywhere would otherwise be silently deleted.
    const idf = vocab.map((t) => Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) + 1);

    return docs.map((doc) => {
      const vec = new Array<number>(vocab.length).fill(0);
      for (const term of doc) {
        const i = index.get(term);
        if (i !== undefined) vec[i] = (vec[i] ?? 0) + 1;
      }
      // Sublinear term frequency: a word repeated six times in one selection is
      // not six times as much evidence about what the pin is about.
      let norm = 0;
      for (let i = 0; i < vec.length; i++) {
        const tf = vec[i] ?? 0;
        const w = tf > 0 ? (1 + Math.log(tf)) * (idf[i] ?? 0) : 0;
        vec[i] = w;
        norm += w * w;
      }
      // L2 normalise here so cosine is a dot product downstream, and so an
      // empty document comes back as an honest zero vector rather than NaN.
      if (norm > 0) {
        const len = Math.sqrt(norm);
        for (let i = 0; i < vec.length; i++) vec[i] = (vec[i] ?? 0) / len;
      }
      return vec;
    });
  }
}
