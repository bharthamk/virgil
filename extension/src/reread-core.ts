/**
 * The re-read state machine, with the DOM taken out of it.
 *
 * The detector is the one agent-initiated capture signal and the single most
 * product-visible set of numbers in the extension — three returns, four seconds
 * of dwell, a ten-minute window. Those numbers were reasoned about, never
 * measured, so they need to be pinned down by something other than a demo.
 *
 * Everything here is deliberately ignorant of elements, observers and clocks:
 * a key is whatever the caller wants to key a passage by, and every transition
 * is given the time it happened at. `reread.ts` is the thin wrapper that turns
 * IntersectionObserver entries into these calls. Behaviour is unchanged from
 * the version that lived inside that observer callback.
 */

/** Three returns to the same passage is the threshold. Two is normal reading —
 *  people glance back constantly. Three with dwell is someone stuck. */
export const RETURN_THRESHOLD = 3;
export const MIN_DWELL_MS = 4000;
/** Returns spread over more than this are probably two separate sittings. */
export const WINDOW_MS = 10 * 60 * 1000;
/** A return only counts if they actually went away and came back. */
export const RETURN_GAP_MS = 1500;

/**
 * How many rejections it takes to stop raising on a site.
 *
 * Two, not one: one rejection is a bad guess about one passage, and quieting a
 * whole site on it would make the detector useless on the first false positive.
 * Two is a pattern — this site is not what they came here to learn — and the
 * story is explicit that repeated rejections must *quiet the detector, not just
 * filter its output*. Deliberately per-site rather than global: being wrong
 * about a news site says nothing about being wrong in the docs.
 */
export const QUIET_AFTER_REJECTIONS = 2;

/**
 * Whether this site has been told no often enough to stop.
 *
 * The counts are the service's — they live in `LearnerPrefs.rejectedOrigins`,
 * server-side, which is where a rejection is recorded when the learner taps
 * "Not this". The content script reads them once, on init.
 */
export function detectorQuieted(
  rejections: Readonly<Record<string, number>> | undefined | null,
  origin: string,
): boolean {
  return (rejections?.[origin] ?? 0) >= QUIET_AFTER_REJECTIONS;
}

export interface VisitState {
  count: number;
  firstAt: number;
  lastAt: number;
  dwellMs: number;
}

/**
 * Where visits live. The content script backs this with a WeakMap/WeakSet over
 * elements so a long-lived page cannot leak; tests back it with a Map.
 */
export interface VisitStore<K> {
  get(key: K): VisitState | undefined;
  set(key: K, visit: VisitState): void;
  hasRaised(key: K): boolean;
  markRaised(key: K): void;
}

export function mapVisitStore<K>(): VisitStore<K> {
  const visits = new Map<K, VisitState>();
  const raised = new Set<K>();
  return {
    get: (k) => visits.get(k),
    set: (k, v) => { visits.set(k, v); },
    hasRaised: (k) => raised.has(k),
    markRaised: (k) => { raised.add(k); },
  };
}

export interface RereadTracker<K> {
  /** The passage came into view at `now`. */
  enter(key: K, now: number): void;
  /** The passage left the viewport at `now`. Ignored unless it is the current one. */
  exit(key: K, now: number): void;
  /** The passage currently being read, if any. Exposed for tests and debugging. */
  currentKey(): K | null;
  visitOf(key: K): VisitState | undefined;
}

export interface TrackerOptions {
  /**
   * the learner has turned this site down enough times. Counting carries
   * on — it costs nothing and the state machine stays simple — but nothing is
   * ever raised, so no suggestion can be made here.
   */
  readonly quieted?: boolean;
}

/**
 * `onRaise` fires at most once per key, and only ever while banking dwell —
 * that is, on the way *out* of a passage, never on the way in. A candidate is
 * raised, never pinned: the learner confirms it.
 */
export function createRereadTracker<K>(
  store: VisitStore<K>,
  onRaise: (key: K, visit: VisitState) => void,
  opts: TrackerOptions = {},
): RereadTracker<K> {
  let current: K | null = null;
  let enteredAt = 0;

  function consider(key: K, v: VisitState): void {
    if (opts.quieted) return;
    if (store.hasRaised(key)) return;
    if (v.count < RETURN_THRESHOLD) return;
    if (v.dwellMs < MIN_DWELL_MS) return;
    if (v.lastAt - v.firstAt > WINDOW_MS) return; // different sitting, not stuck

    store.markRaised(key);
    onRaise(key, v);
  }

  function bank(key: K, now: number): void {
    const v = store.get(key);
    if (!v || !enteredAt) return;
    v.dwellMs += now - enteredAt;
    store.set(key, v);
    enteredAt = now;
    consider(key, v);
  }

  return {
    enter(key: K, now: number): void {
      // Leaving the previous block banks its dwell.
      if (current !== null && current !== key) bank(current, now);
      if (current !== key) { current = key; enteredAt = now; }

      const v = store.get(key) ?? { count: 0, firstAt: now, lastAt: now, dwellMs: 0 };
      if (now - v.lastAt > RETURN_GAP_MS) v.count += 1;
      v.lastAt = now;
      store.set(key, v);
    },
    exit(key: K, now: number): void {
      if (current !== key) return;
      bank(key, now);
      current = null;
    },
    currentKey: () => current,
    visitOf: (key: K) => store.get(key),
  };
}

/**
 * The heading path a passage sits under — the cheapest signal of where it sits
 * inside a body of knowledge.
 *
 * Typed against the shape it actually uses rather than against `Element`, so it
 * can be exercised without a DOM. A real `Element` satisfies it structurally.
 */
export interface HeadingNode {
  readonly tagName: string;
  readonly textContent: string | null;
  readonly previousElementSibling: HeadingNode | null;
  readonly parentElement: HeadingNode | null;
}

export function headingPathFrom(node: HeadingNode | null): string[] {
  const path: string[] = [];
  let el: HeadingNode | null = node;
  let want = 6;
  while (el) {
    let sib: HeadingNode | null = el;
    while ((sib = sib.previousElementSibling)) {
      const m = /^H([1-6])$/.exec(sib.tagName);
      const level = m?.[1] ? Number(m[1]) : 0;
      if (level && level < want) { path.unshift((sib.textContent ?? '').trim()); want = level; }
    }
    el = el.parentElement;
  }
  return path.filter(Boolean);
}
