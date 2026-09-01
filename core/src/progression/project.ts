import { badgesFor } from './badges.js';
import { chainFor, NOTABLE_CHAIN } from './chains.js';
import { ledgerHistory } from './ledger.js';
import { milestonesFor } from './milestones.js';
import type {
  Chain, ProgressionEvent, ProgressionInput, ProgressionProjection, SkippedRule,
} from './types.js';

/**
 * UX_SPEC §5a, assembled — and the one entry point anything outside gets.
 *
 * Deterministic, and zero model calls: §7 says the progression system is a
 * ruleset over ledger events and adds nothing to the fleet, so there is no
 * `Deps` here, no `Llm`, and nothing to inject. It takes plain arrays and
 * returns plain data, which is also what makes the read-only law cheap to
 * enforce — there is no handle here that could be written through.
 *
 * The input arrays are never mutated. Every sort in this module is on a copy;
 * a projection that sorted the caller's signal ledger in place would be
 * rewriting history for whatever read it next, without a write method anywhere
 * in sight, and `progression-purity.test.ts` freezes them to prove it does not.
 */
export function projectProgression(input: ProgressionInput): ProgressionProjection {
  const { topics, signals, sessions, now } = input;

  const events: ProgressionEvent[] = [];
  const chains: Chain[] = [];
  const skipped: SkippedRule[] = [];

  for (const topic of topics) {
    const history = ledgerHistory(topic.id, signals);

    const milestones = milestonesFor(topic, history);
    events.push(...milestones.milestones);
    skipped.push(...milestones.skipped);

    const badges = badgesFor(topic, history, signals, sessions);
    events.push(...badges.badges);
    skipped.push(...badges.skipped);

    const chain = chainFor(topic, signals, now);
    if (chain.chain) chains.push(chain.chain);
    skipped.push(...chain.skipped);
  }

  return { events: newestFirst(events), chains: newestFirst(chains), skipped };
}

/** Newest first, with the tie broken by topic so two events on one instant do
 *  not shuffle between reads of the same ledger. */
const newestFirst = <T extends { at: string; topicId: string }>(xs: readonly T[]): T[] =>
  xs.slice().sort((a, b) => b.at.localeCompare(a.at) || a.topicId.localeCompare(b.topicId));

/**
 * Zone 2 — the momentum strip. At most three items, newest first.
 *
 * §5: *"Empty when nothing happened; the strip never invents content to fill
 * itself."* That is the whole of this function's contract and it is why there
 * is no floor, no filler and no "nothing yet, keep going" item — an empty strip
 * renders as nothing at all, and the panel is tested on exactly that.
 *
 * Chains join only at a notable length, because a chain of one is a fact about
 * a topic and not a piece of momentum.
 */
export const STRIP_ITEMS = 3;

export function stripFrom(projection: ProgressionProjection): readonly ProgressionEvent[] {
  const seenMoves = new Set<string>();
  return newestFirst([...projection.events, ...notableChains(projection)])
    .filter((event) => {
      // A learner can genuinely fall below a register and earn the same move
      // again. Keep both events in immutable history and in their session-close
      // awards, but do not spend two of the compact strip's three lines saying
      // the identical topic movement with different cumulative totals. Newest
      // evidence is first, so it is the one the arrival screen retains.
      if (event.kind !== 'milestone') return true;
      const move = `${event.topicId}\u0000${event.from}\u0000${event.to}`;
      if (seenMoves.has(move)) return false;
      seenMoves.add(move);
      return true;
    })
    .slice(0, STRIP_ITEMS);
}

/**
 * A chain worth saying out loud.
 *
 * Long enough to be momentum, and not paused — a paused chain is a true fact
 * about a topic and is not news. One definition, used by both surfaces, so the
 * strip cannot echo a chain the session close never showed.
 */
const notableChains = (p: ProgressionProjection): readonly Chain[] =>
  p.chains.filter((c) => c.length >= NOTABLE_CHAIN && c.state !== 'paused');

/**
 * The award moment — session end, where it was earned.
 *
 * §5: *"the award moment for §5a events is the session close screen — earned
 * where it happened — not a lobby the learner walks through. The main page's
 * strip only echoes what session-end already showed."*
 *
 * So the strip is not a second source. Both surfaces read one projection: this
 * returns the events a given session's work produced, and `stripFrom` returns
 * the most recent of the same events. An award the strip could show and the
 * session close could not would mean the panel was celebrating something the
 * learner never saw happen.
 */
export function awardsForSession(
  projection: ProgressionProjection, builtAt: string,
): readonly ProgressionEvent[] {
  const from = Date.parse(builtAt);
  // A session with an unreadable build time earns nothing rather than
  // everything. `Date.parse` answering NaN makes every comparison false, which
  // would quietly hand back the entire history as this run's winnings.
  if (!Number.isFinite(from)) return [];
  // Chains included, on the same terms the strip uses: SB-66's walkthrough
  // shows the chain of three at session end and then on the main page, and a
  // strip carrying something the close screen did not would make the echo a
  // second source.
  const earned = [...projection.events, ...notableChains(projection)];
  return newestFirst(earned.filter((e) => Date.parse(e.at) >= from));
}
