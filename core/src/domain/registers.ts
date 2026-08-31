import type { DepthRegister } from './types.js';


/**
 * The part of a comfort reading a register depends on.
 *
 * Structural rather than `ComfortResult` itself: the Registrar is an agent, the
 * domain is underneath the agents, and a domain file importing an agent would
 * invert the layering the seam test enforces. Every `ComfortResult` satisfies
 * this, so no caller has to convert anything.
 */
export interface ComfortRead {
  readonly comfort: number;
  readonly certainty: number;
  readonly evidenceCount: number;
  /** Marked answers or recalls, excluding attendance and self-report. */
  readonly demonstrationCount: number;
}

/**
 * Register is derived here, deterministically, rather than left to the model.
 * The model is good at *writing* at a register and unreliable at *choosing* one
 * consistently across a long output, so the choice is made in code and handed
 * over as an instruction.
 */
export function registerFor(c: ComfortRead | undefined): DepthRegister {
  if (!c || c.evidenceCount === 0 || c.certainty < 0.3) return 'from-nothing';
  if (c.comfort < 0.45) return 'from-nothing';
  if (c.comfort < 0.75) return 'building';
  // one answer can show that learning has started. It cannot establish
  // fluency, however much self-report or attendance happens beside it.
  if (c.demonstrationCount < 2) return 'building';
  return 'fluent';
}

/**
 * The registers in the order they are earned, so "did this move up?" is a
 * comparison rather than a table of pairs somebody has to keep complete.
 */
export const REGISTER_ORDER: readonly DepthRegister[] = ['from-nothing', 'building', 'fluent'];

/** Where a register sits on that ladder. -1 for anything not on it, so an
 *  unknown value can never read as an advance. */
export const registerRank = (r: DepthRegister): number => REGISTER_ORDER.indexOf(r);
