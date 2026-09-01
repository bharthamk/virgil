/**
 * What the re-read detector is allowed to do, and how its one output leaves the
 * page (SB-15, SB-16).
 *
 * `reread.ts` has been complete and careful since the day it was written and had
 * never executed once: no `content_scripts` entry, no importer, and nothing
 * anywhere that constructed a `Suggestion`. This file and `reread-content.ts`
 * are the missing half, split so that the decisions are testable and only the
 * loader needs a browser.
 *
 * ## What crosses the network, and what never does
 *
 * The behavioural trace — every scroll return, every dwell — stays in the page's
 * memory and dies with it. Only a raised candidate leaves, and it leaves through
 * the service worker rather than directly: MV3 content scripts do not get the
 * extension's host permissions for cross-origin fetch, so the worker is not an
 * indirection anyone chose, it is the only route. The same message channel
 * answers the SB-16 question on the way in.
 */
import type { RereadCandidate } from './reread.js';

export const REREAD_PREFS = 'sb-reread-prefs';
export const REREAD_CANDIDATE = 'sb-reread-candidate';

export interface RereadPrefsReply {
  /** SB-16: this origin has had enough suggestions turned down. */
  quieted: boolean;
}

export type Send = (message: unknown) => Promise<unknown>;
export type StartDetector = (
  onCandidate: (c: RereadCandidate) => void,
  opts: { quieted: boolean },
) => () => void;

/**
 * Ask the worker whether we are welcome here, then start — or do not start.
 *
 * Fails quiet, in the one direction that matters: if the service is down or the
 * worker is asleep we do not know whether the learner has quieted this site, so
 * we do not raise anything. The alternative is nagging someone who has already
 * said no twice because a fetch timed out, and SB-16 is the story that exists to
 * stop precisely that. A detector that goes silent when it cannot check is a
 * missed suggestion; one that goes loud is a broken promise.
 */
export async function boot(send: Send, start: StartDetector, origin: string): Promise<() => void> {
  let quieted = true;
  try {
    const reply = (await send({ kind: REREAD_PREFS, origin })) as RereadPrefsReply | undefined;
    quieted = reply?.quieted !== false;
  } catch { /* left quieted, deliberately */ }

  return start((candidate) => {
    // Never interrupt (SB-15). The candidate is posted and then nothing happens
    // on this page at all: it waits in the store until the learner opens the
    // panel of their own accord.
    void send({ kind: REREAD_CANDIDATE, candidate });
  }, { quieted });
}
