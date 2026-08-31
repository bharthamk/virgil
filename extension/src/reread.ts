/**
 * Re-read detection — the one agent-initiated capture signal.
 *
 * Three rules govern this file, and they are what make it acceptable rather
 * than creepy:
 *
 *  1. **Never auto-pin.** It raises a candidate. The learner confirms.
 *  2. **Never interrupt.** Detection is live; surfacing waits until they next
 *     open the panel of their own accord.
 *  3. **Behavioural only.** Scroll position, dwell, and visibility. No
 *     keystrokes, no form contents, no reading of what they type. Ever.
 *
 * Runs entirely in the content script. Only a candidate crosses the network, so
 * the raw behavioural trace never leaves the machine.
 *
 * The counting itself lives in `reread-core.ts`, which has no DOM in it. What
 * is left here is the wiring: observers in, elements keyed weakly, candidate
 * out. Keep it that way — everything with a threshold in it belongs in the core.
 */
import {
  RETURN_THRESHOLD, MIN_DWELL_MS, WINDOW_MS, QUIET_AFTER_REJECTIONS,
  createRereadTracker, detectorQuieted, headingPathFrom,
  type VisitState, type VisitStore,
} from './reread-core.js';

export { RETURN_THRESHOLD, MIN_DWELL_MS, WINDOW_MS, QUIET_AFTER_REJECTIONS, detectorQuieted };

/** Dynamic pages can mutate every frame. Re-reading the entire article more
 * than four times a second would turn a quiet local signal into page jank. */
export const RESCAN_THROTTLE_MS = 250;

export interface RereadCandidate {
  readonly passage: string;
  readonly url: string;
  readonly pageTitle: string;
  readonly headingPath: readonly string[];
  readonly returnCount: number;
  readonly dwellMs: number;
  readonly reason: string;
}

/** What the panel shows when the candidate is surfaced. Deferred, never a popup. */
export function candidateFrom(
  el: Element, visit: VisitState, url: string, pageTitle: string,
): RereadCandidate {
  return {
    passage: (el.textContent ?? '').trim().slice(0, 900),
    url,
    pageTitle,
    headingPath: headingPathFrom(el),
    returnCount: visit.count,
    dwellMs: Math.round(visit.dwellMs),
    reason: `You came back to this ${visit.count} times.`,
  };
}

export interface DetectorOptions {
  /** this site has been told no twice. Do not raise here. */
  readonly quieted?: boolean;
}

export function startRereadDetector(
  onCandidate: (c: RereadCandidate) => void,
  opts: DetectorOptions = {},
): () => void {
  // , the load-bearing half: quieted means nothing is observed at all, not
  // that candidates are raised and then filtered. There is no point watching a
  // page we have already agreed not to interrupt on, and "the detector stops
  // raising there" should be true of the detector, not of the panel.
  if (opts.quieted) return () => {};

  // Weak on purpose: a page that lives for hours must not be held open by the
  // detector's own bookkeeping.
  const visits = new WeakMap<Element, VisitState>();
  const seen = new WeakSet<Element>();
  const store: VisitStore<Element> = {
    get: (el) => visits.get(el),
    set: (el, v) => { visits.set(el, v); },
    hasRaised: (el) => seen.has(el),
    markRaised: (el) => { seen.add(el); },
  };

  const tracker = createRereadTracker(store, (el, visit) => {
    onCandidate(candidateFrom(el, visit, location.href, document.title));
  });

  const blocks = () => Array.from(document.querySelectorAll('p, li, pre, blockquote'))
    .filter((e) => (e.textContent ?? '').trim().length > 120);

  const observer = new IntersectionObserver((entries) => {
    const now = Date.now();
    for (const entry of entries) {
      if (entry.isIntersecting && entry.intersectionRatio > 0.6) tracker.enter(entry.target, now);
      else tracker.exit(entry.target, now);
    }
  }, { threshold: [0, 0.6, 1] });

  const observed = new WeakSet<Element>();
  const observeNewBlocks = (): void => {
    for (const b of blocks()) {
      if (observed.has(b)) continue;
      observed.add(b);
      observer.observe(b);
    }
  };
  observeNewBlocks();

  // Pages that add content as you scroll still need covering. A mutation burst
  // schedules one trailing scan, and a block is handed to IntersectionObserver
  // once for the lifetime of this detector.
  let rescanTimer: ReturnType<typeof setTimeout> | null = null;
  const mo = new MutationObserver(() => {
    if (rescanTimer !== null) return;
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      observeNewBlocks();
    }, RESCAN_THROTTLE_MS);
  });
  mo.observe(document.body, { childList: true, subtree: true });

  return () => {
    observer.disconnect();
    mo.disconnect();
    if (rescanTimer !== null) clearTimeout(rescanTimer);
  };
}

/**
 * The corroborating signal, and the one that makes the suggestion land as
 * insight rather than surveillance: they re-read something, then went looking
 * for a simpler explanation of the same thing.
 *
 * Reads only the search QUERY from the URL of a search results page — a
 * navigation fact, not the contents of anything they typed into a document.
 */
export function searchQueryFrom(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)(google|bing|duckduckgo|ecosia)\.[a-z.]+$/.test(u.hostname)) return null;
    return u.searchParams.get('q');
  } catch { return null; }
}

/** Cheap overlap test — did the search follow the passage they were stuck on? */
export function searchRelatesTo(query: string, passage: string): boolean {
  const stop = new Set(['the','a','an','and','or','of','to','in','is','for','how','what','why','does','do','with','on','it','that']);
  const terms = query.toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !stop.has(w));
  if (terms.length < 2) return false;
  const text = passage.toLowerCase();
  return terms.filter((t) => text.includes(t)).length >= Math.min(2, terms.length);
}
