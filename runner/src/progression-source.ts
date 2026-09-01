import type { Clock, ProgressionInput, Store } from '@sb/core';

/**
 * The one place store data becomes a progression input.
 *
 * §5a's law is that gamification is a read-only projection of the ledger, and
 * a law with several doors is a law with several places to get it wrong. So
 * this is the only file in the repository that hands a store's contents to
 * `projectProgression` — asserted, not merely intended, by
 * `progression-purity.test.ts`, which then runs this function against a store
 * whose write methods throw the moment they are *touched*.
 *
 * Four reads and a clock. Nothing here filters, weights or interprets: the
 * projection is the thing that decides, and a gatherer that pre-selected
 * "interesting" signals would be a second, invisible ruleset.
 */

/**
 * How many nights of session history the medium-follow-through badge reads.
 *
 * The sessions table grows by one row per night for ever, and the badge is
 * about a warning the learner has since acted on — a warning from two years ago
 * that they demonstrated last week is a true fact and not momentum. Named here
 * rather than left unbounded, for the reason §3a's third class gives: the
 * problem with an uncapped read is never the first day.
 */
export const SESSION_WINDOW = 180;

export async function progressionSnapshot(store: Store, clock: Clock): Promise<ProgressionInput> {
  const sessions = await store.listSessions();
  return {
    topics: await store.listTopics(),
    signals: await store.listSignals(),
    // Newest first, then capped, so the window is the most recent nights rather
    // than whichever nights happen to be at the front of the file.
    sessions: sessions.slice().sort((a, b) => b.builtAt.localeCompare(a.builtAt)).slice(0, SESSION_WINDOW),
    now: clock.now(),
  };
}
