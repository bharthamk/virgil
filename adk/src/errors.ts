/**
 * The failure classifier, which now lives in `core`.
 *
 * It was defined here, and that put it out of reach of `runner/src/pipeline.ts`
 * — the plain nightly, which is the thing that most needed to know a daily cap
 * had been met. `adk-seam.test.ts` rightly refuses to let the pipeline import
 * this layer at all: whether the nightly runs under a framework is a
 * composition-root decision, not an import.
 *
 * So the classifier moved to `core/src/domain/provider-failure.ts`, where it
 * always belonged — it is pure, it imports nothing, and nothing about it is
 * ADK's. This file keeps the names it exported so the host and its tests read
 * the same as they did.
 */
export {
  classify, isTerminalForSeam, messageOf,
  type Directive, type DegradeReason,
} from '@sb/core';
