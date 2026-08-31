/**
 * The progression projection (UX_SPEC §5a).
 *
 * Exported as one door rather than as five files, so the one-way glass has one
 * pane: `progression-purity.test.ts` reads this directory as a unit, and the
 * caller that is allowed to build a projection reaches it through here.
 */
export * from './types.js';
export * from './ledger.js';
export * from './milestones.js';
export * from './chains.js';
export * from './badges.js';
export * from './project.js';
