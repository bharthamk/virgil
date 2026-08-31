/**
 * The hand-off between the toast and the panel.
 *
 * The gesture and the surface are in two different places. *Learn it now* is
 * tapped on a toast in the page, and the take is read in the side panel, and
 * nothing in Chrome carries an argument from one to the other: `sidePanel.open`
 * takes a window, not a route, and the panel is a fresh document every time it
 * opens.
 *
 * So the tap writes down what it was about and the panel picks it up. One key
 * in `chrome.storage.local`, alongside the prefs cache and the pin queue, which
 * is where everything else this extension has to survive a service-worker death
 * already lives.
 *
 * ## Why it is stamped, and which way it fails
 *
 * Same posture as `prefs.ts`, for a smaller stake. A hand-off left behind by a
 * tap ten minutes ago is not what the learner is opening the panel for now, and
 * a panel that hijacked itself onto a stale take would be taking the front door
 * away from the session — which §5 says is the front door, always. So the
 * record carries the time it was written, `pendingTake` refuses anything it
 * cannot read or anything old, and every refusal lands on the ordinary home
 * screen. The failure mode is a take the learner has to ask for again; the
 * failure mode of the other direction is a panel that will not show them
 * the session.
 *
 * A stamp in the future is refused for the same reason `isFresh` refuses one: a
 * copy written by a clock we cannot trust is an age we cannot read.
 */

/** Page -> worker: the learner tapped the affordance on the toast. */
export const LEARN_NOW = 'sb-learn-now';
export const HANDOFF_STARTED = 'sb-handoff-started';

/** The one key. The worker writes it; the panel reads it once and clears it. */
export const HANDOFF_KEY = 'sb_quick_take';

/**
 * How long a tap stays worth acting on.
 *
 * Long enough that a panel Chrome declined to open for us is still the right
 * screen when the learner opens it themselves a moment later, and short enough
 * that it is never the screen they get for some other reason. Five minutes is
 * well past both.
 */
export const HANDOFF_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Which screen the tap is asking for.
 *
 * `take` is the quick take, which is what this file was built for. `guide` is
 * `mode-guide-me`, added 2026-08-22, and it rides the same rails deliberately:
 * both are a tap on one surface asking the panel to open on one pin, and a
 * second key with a second staleness rule and a second read-once would be two
 * answers to a question that has one.
 */
export type HandoffIntent = 'take' | 'guide';

export interface Handoff {
  /**
   * The pin the take is about, or null while there is not one yet.
   *
   * Null is the menu route (`mode-learn-now`, 2026-08-22). `sidePanel.open`
   * needs the gesture that is still alive in the click handler, and the pin id
   * does not exist until the page has been captured and the service has
   * answered, which is hundreds of milliseconds later. Something has to give,
   * and it cannot be the panel: a learner who picks *Learn it now* and gets no
   * panel has been ignored. So the panel opens first, on a hand-off that says
   * a pin is coming, and the id is written into the same record when it lands.
   */
  readonly pinId: string | null;
  /** What the toast called it, so the panel has a heading before the take
   *  lands. Null when Scout had nothing to say. */
  readonly label: string | null;
  /** Epoch ms, written by the worker at the moment of the tap. */
  readonly at: number;
  /** Which screen. Absent in records written before guides existed, which
   *  `pendingTake` reads as the take they were. */
  readonly intent: HandoffIntent;
  /**
   * Why there is no pin id, when there is not one.
   *
   * `null` while the pin is still on its way. `'post-failed'` when the worker
   * finished and the service never took it, which is a fact the panel cannot
   * work out for itself: without this it waits out its whole timeout and then
   * says the one thing that is definitely untrue, that the model could not
   * write a guide. Nothing ever asked the model.
   *
   * The comment on the writer in `background.ts` promised this record was
   * written on failure and the code wrote it only on success, so the honest
   * sentence was unreachable for the life of both modes.
   */
  readonly failure: HandoffFailure | null;
}

/** Why a hand-off will never get a pin id. One value today; a union because
 *  the next one along should not have to change the shape. */
export type HandoffFailure = 'post-failed';

export function handoffFor(
  pinId: string | null, label: string | null, at: number, intent: HandoffIntent = 'take',
  failure: HandoffFailure | null = null,
): Handoff {
  return { pinId: pinId || null, label: label || null, at, intent, failure };
}

/** The pin did not reach the service. Ends the panel's wait on the truth
 *  rather than on a timeout. */
export const failedHandoff = (label: string | null, at: number, intent: HandoffIntent): Handoff =>
  handoffFor(null, label, at, intent, 'post-failed');

/** A hand-off whose pin is still being made. The panel waits on this one. */
export const pendingHandoff = (label: string | null, at: number, intent: HandoffIntent = 'take'): Handoff =>
  handoffFor(null, label, at, intent);

/** Is this a take that cannot be asked for yet? A hand-off that has given up
 *  is not waiting for anything, so it is not awaiting a pin. */
export const isAwaitingPin = (h: Handoff): boolean => h.pinId === null && h.failure === null;

/**
 * How long the panel waits for a pin id before it gives up on one.
 *
 * The capture, the post and the Scout label all have to happen first, and the
 * post carries a 2.5s budget of its own. Past this the honest answer is that
 * something went wrong that nothing reported, which the panel says rather than
 * sitting on a heading for ever.
 *
 * It should now be rare to reach it. A post that fails writes `failure` and
 * ends the wait immediately; this is what is left when the worker was killed
 * mid-flight, which MV3 is entitled to do at any moment.
 */
export const AWAITING_PIN_TIMEOUT_MS = 12_000;

/**
 * A stored hand-off the panel may act on, or null.
 *
 * Everything is checked because this comes out of storage rather than off a
 * function call: a record written by an older build, a half-written one, a
 * clock that moved. Every one of them is "there is no take waiting", which puts
 * the learner on the screen §5 says they should be on.
 */
export function pendingTake(raw: unknown, now: number): Handoff | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const h = raw as Record<string, unknown>;
  const pinId = h['pinId'];
  const at = h['at'];
  // Present-and-null is a pin on its way; absent or any other type is a record
  // this build cannot read, which is the ordinary home screen.
  if (!('pinId' in h)) return null;
  if (pinId !== null && (typeof pinId !== 'string' || !pinId)) return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  const age = now - at;
  if (age < 0 || age > HANDOFF_MAX_AGE_MS) return null;
  return {
    pinId: (pinId as string | null) || null,
    label: typeof h['label'] === 'string' && h['label'] ? h['label'] : null,
    at,
    // Anything but the one word is the take: a record from an older build has
    // no intent on it, and an intent this build does not know is a screen it
    // cannot draw. Both land on the screen that has always been there.
    intent: h['intent'] === 'guide' ? 'guide' : 'take',
    // Unknown values are read as "still coming", which lands the panel on its
    // wait rather than on a failure screen a future build wrote for a reason
    // this one cannot name.
    failure: h['failure'] === 'post-failed' ? 'post-failed' : null,
  };
}

export interface HandoffStorage {
  read(): Promise<unknown>;
  write(handoff: Handoff): Promise<void>;
  clear(): Promise<void>;
}

/** `chrome.storage.local` as a HandoffStorage. The only chrome-shaped thing
 *  here, and the same shape `queue.ts` and `prefs.ts` use. */
export function chromeHandoffStorage(
  local: {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  },
  key: string = HANDOFF_KEY,
): HandoffStorage {
  return {
    async read(): Promise<unknown> {
      return (await local.get(key))[key];
    },
    async write(handoff: Handoff): Promise<void> {
      await local.set({ [key]: handoff });
    },
    // Written rather than deleted: `storage.local.remove` is a namespace member
    // nothing else in this extension uses, and an absent key and a null one are
    // the same answer to `pendingTake`.
    async clear(): Promise<void> {
      await local.set({ [key]: null });
    },
  };
}
