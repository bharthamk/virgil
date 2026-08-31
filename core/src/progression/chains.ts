import type { Signal, Topic } from '../domain/types.js';
import { daysBetween, isDemonstration, isMiss, MAX_REPLAY_SIGNALS } from './ledger.js';
import type { Chain, SkippedRule } from './types.js';

/**
 * SB-66 — a chain that pauses instead of breaking.
 *
 * A correct-answer streak with four explicit properties, each of which is
 * a refusal of something another product does:
 *
 *  - **Per topic.** There is no global number, so there is no number to
 *    protect, so attempting a shaky topic is never the risky move.
 *  - **Interval-gated.** Two demonstrations on the same calendar day are one
 *    link. Re-answering this run what you answered this morning cannot extend
 *    anything, which is the whole difference between spaced repetition made
 *    visible and a counter.
 *  - **It pauses; it does not break.** Absence shows as `paused` with the
 *    number intact.
 *  - **A miss holds it.** The number stands, the state says `held`, and the
 *    next recall is owed sooner. No zero is ever displayed as a punishment, and
 *    a wrong answer costs no more than the absence of a right one.
 *
 * There is deliberately no function here that takes more than one topic's
 * signals, and nothing that returns a sum. The story bans the global chain, and
 * the cheapest way to keep it banned is to have nowhere to build one.
 *
 * ### The day boundary
 *
 * UTC, from the ISO timestamp, because that is the only clock this product has:
 * signals are stored as instants and there is no timezone anywhere in the
 * domain. A learner answering either side of midnight local time can therefore
 * fall either way at the boundary. Stated rather than hidden — the alternative
 * is inventing a timezone the store does not hold.
 */

/** The gate: strictly later day than the previous link. */
const dayOf = (iso: string): string => iso.slice(0, 10);

/**
 * How long a chain is before the momentum strip will carry it.
 *
 * SB-66's walkthrough is the source: *day 2, day 5, day 12 — a chain of three,
 * shown on the topic and in the momentum strip*. Below that it is on the topic
 * and nowhere else; a strip announcing a chain of one would be inventing
 * content to fill itself, which §5 forbids by name.
 */
export const NOTABLE_CHAIN = 3;

export interface ChainOutcome {
  readonly chain: Chain | null;
  readonly skipped: readonly SkippedRule[];
}

export function chainFor(
  topic: Topic, signals: readonly Signal[], now: Date,
): ChainOutcome {
  const live = signals
    .filter((s) => s.topicId === topic.id && Number.isFinite(Date.parse(s.at)))
    .slice()
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-MAX_REPLAY_SIGNALS);

  const links: Signal[] = [];
  for (const s of live) {
    if (!isDemonstration(s)) continue;
    const previous = links[links.length - 1];
    // Interval-gated. The same day is the same link, not a longer chain.
    if (previous && dayOf(previous.at) === dayOf(s.at)) continue;
    links.push(s);
  }
  if (!links.length) return { chain: null, skipped: [] };

  const last = links[links.length - 1] as Signal;
  const intervals = links.slice(1).map((s, i) => Math.round(daysBetween((links[i] as Signal).at, s.at)));

  // A miss after the last link holds the chain and pulls the next recall in.
  const missed = live.some((s) => isMiss(s) && s.at.localeCompare(last.at) > 0);

  /**
   * Paused by its own rhythm.
   *
   * The chain is compared to the spacing it established rather than to the
   * Gardener's review ladder, deliberately: reading the scheduler's intervals
   * here would make a display surface depend on the thing that decides what to
   * teach, and §5a's law is that the arrow only points one way. A chain of one
   * has no rhythm yet, so a day is used — the shortest interval the Gardener
   * itself ever schedules.
   */
  const rhythm = intervals.length ? (intervals[intervals.length - 1] as number) : 1;
  const idle = daysBetween(last.at, now.toISOString());

  const state: Chain['state'] = missed ? 'held' : idle > Math.max(1, rhythm) ? 'paused' : 'active';

  return {
    chain: {
      kind: 'chain',
      topicId: topic.id,
      topicLabel: topic.label,
      at: last.at,
      length: links.length,
      state,
      intervals,
      evidence: evidenceFor(links.length, state),
    },
    skipped: [],
  };
}

/**
 * What the chain says about itself.
 *
 * The `held` line is the one that carries the design. It has to say the number
 * survived and that the answer is coming back sooner, without once suggesting
 * the learner lost something — because the moment a miss reads as a loss, the
 * safe move is to stop attempting the topic, which is the failure mode this
 * whole mechanic was reshaped to avoid.
 */
function evidenceFor(length: number, state: Chain['state']): string {
  const run = `Recalled ${length} time${length === 1 ? '' : 's'} across widening gaps.`;
  if (state === 'held') return `${run} One went wrong, so it comes back sooner. The run stands.`;
  if (state === 'paused') return `${run} Paused, waiting for you.`;
  return run;
}
