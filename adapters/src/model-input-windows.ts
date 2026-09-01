import type { ModelMode, ModelTier } from '@sb/core';
import { GEMINI_TIERS } from './gemini-llm.js';
import { LOCAL_TIERS } from './ollama-llm.js';

/**
 * HOW MUCH A CONNECTION CAN READ — the half of a size warning that is not ours.
 *
 * The agents have their own caps and they are the ones that bite first: the
 * Marker reads 12,000 characters of work, the Reviewer 6,000 of draft, and both
 * report when they cut. Those are product decisions and they live in `core/`.
 *
 * This is the other number, and it belongs here for the reason the whole seam
 * exists: a context window is a property of a MODEL, `core/` does not know what
 * a Gemini is, and the runner composes receipts without knowing which id its
 * adapters are pinned to. Adapters is the one layer that knows both.
 *
 * `null` is a real answer and the common one. A local model is whatever the
 * operator pulled, a CLI bridge is whatever it is fronting, and inventing a
 * number for either would be worse than saying nothing: the panel falls back to
 * the agent caps above, which are the limits that actually apply.
 */

export interface ModelInputWindow {
  /** The model a call on this connection would go to, where it is pinned. */
  readonly modelId: string | null;
  /** Its input window in tokens, or null where nothing here knows it. */
  readonly maxInputTokens: number | null;
}

/**
 * Input windows for the pinned ids, measured rather than assumed.
 *
 * The Gemini figures are the documented 3.x flash window. The Gemma pair are
 * the numbers `ListModels` returned on this key, recorded beside the tier map in
 * `gemini-llm.ts` at the port: 262,144 in, 32,768 out.
 *
 * A model absent from this table answers `null`, which is why the table can be
 * short and honest instead of long and guessed at.
 */
const INPUT_TOKENS: Readonly<Record<string, number>> = {
  'gemini-3.5-flash-lite': 1_048_576,
  'gemini-3.6-flash': 1_048_576,
  'gemini-3.7-flash': 1_048_576,
  'gemma-4-26b-a4b-it': 262_144,
  'gemma-4-31b-it': 262_144,
};

export const maxInputTokensFor = (modelId: string | null | undefined): number | null =>
  (modelId ? INPUT_TOKENS[modelId] : undefined) ?? null;

const windowFor = (modelId: string | null): ModelInputWindow =>
  ({ modelId, maxInputTokens: maxInputTokensFor(modelId) });

/** The receipt for an operator-pinned model id rather than the adapter default. */
export const modelInputWindowForId = (modelId: string): ModelInputWindow => windowFor(modelId);

/**
 * What one connection would send a call of this tier to, and how much of a
 * paste it could read.
 *
 * The CLI bridge answers both as null on purpose. It fronts whatever the
 * operator started it with, and the endpoint's capability document does not
 * carry a window — so the receipt says "unknown" rather than naming the model
 * this build happens to have been tested against.
 */
export function modelInputWindow(mode: ModelMode, tier: ModelTier): ModelInputWindow {
  if (mode === 'cloud') return windowFor(GEMINI_TIERS[tier]);
  if (mode === 'local') return windowFor(LOCAL_TIERS[tier]);
  return windowFor(null);
}
