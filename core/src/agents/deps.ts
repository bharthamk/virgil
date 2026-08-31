import type { Llm } from '../ports/llm.js';
import type { Store } from '../ports/store.js';
import type { Research } from '../ports/research.js';
import type { Clock } from '../ports/clock.js';
import type { Embedder } from '../ports/embedder.js';

/**
 * Every agent is a pure function of (deps, input) -> output.
 *
 * Agents receive capabilities, never construct them. That is what keeps `core/`
 * vendor-free, makes each agent testable against a stub, and reduces the port
 * to swapping which implementations get passed in here.
 */
export interface Deps {
  readonly llm: Llm;
  readonly store: Store;
  readonly research: Research;
  readonly clock: Clock;
  /**
   * The clustering partition's only input. Separate from `Llm` on purpose: it
   * is the seam that took the partition decision away from the model, and a
   * provider having a chat model says nothing about whether it has an
   * embedding one. See `ports/embedder.ts` and clustering-stability constraint.
   */
  readonly embedder: Embedder;
  /**
   * The COARSE space, supplied only when a two-space partition strategy is
   * selected (`SB_PARTITION=d1`). Optional because the default strategy has no
   * use for it and a run must not be gated on wiring it up.
   *
   * Two embedders rather than one embedder with a mode, because they are two
   * spaces: their vectors are not comparable, their cut points are different
   * constants measured separately, and `domain/partition-d1.ts` keeps them apart
   * by construction. Composition happens here, in the runner, so `core/` still
   * receives embed functions and never constructs an adapter.
   */
  readonly coarseEmbedder?: Embedder;
}

/** Deps for agents that must not touch storage — enforced by the type. */
export type PureDeps = Pick<Deps, 'llm' | 'clock'>;
