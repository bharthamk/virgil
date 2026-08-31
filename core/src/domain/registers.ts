import type { DepthRegister } from './types.js';

/**
 * Comfort, as one of the three registers.
 *
 * This lived in the Composer, which is where it is used to write a section. It
 * is here because a second reader arrived: the progression projection (§5a)
 * states milestones as *register transitions*, and the whole point of that law
 * is that the projection reads the ledger and is imported by nothing that
 * composes or schedules. A projection that imported the Composer to find out
 * what a register is would have the arrow pointing the wrong way, and a
 * projection that copied the thresholds would drift from them the first time
 * they moved.
 *
 * So the thresholds live once, in the domain, and both readers take them from
 * here. The Composer's behaviour is unchanged, byte for byte.
 */

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
  // SB-224: one answer can show that learning has started. It cannot establish
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
