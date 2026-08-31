/**
 * Time is injected, never read from the ambient environment.
 *
 * Decay curves, spacing intervals and regression detection are all functions of
 * elapsed time (SB-22, SB-28, SB-36). Injecting the clock is what makes the
 * seeded learner's fabricated six-week history testable, and what lets the
 * nightly pipeline be replayed deterministically.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export const fixedClock = (iso: string): Clock => ({ now: () => new Date(iso) });
