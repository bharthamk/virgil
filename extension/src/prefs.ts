/**
 * Pause and exclusions (SB-40/41), and the cache that makes them enforceable.
 *
 * ## One authority, one cache
 *
 * There used to be two preference stores. The service owns `LearnerPrefs` —
 * eleven banking, health, webmail and password-manager domains, shipped by
 * default and tested — and the extension enforced `chrome.storage.local.sb_prefs`,
 * a key that nothing in the repository had ever written. Both halves were
 * individually correct and they had never been introduced, so the detector,
 * which now runs on every http(s) page, was checking an empty object against a
 * list it could not see.
 *
 * The service is the authority: it is where the tested list lives and where the
 * panel writes. `sb_prefs` is a CACHE of it, refreshed by the service worker,
 * and everything the extension enforces is read from that one copy.
 *
 * ## Why the cache is stamped, and why an unstamped one is worthless
 *
 * A cache is only a safety control if you can tell a current copy from a copy
 * left over from a fortnight ago, so it carries the time it was written and
 * `isFresh` is the first question every predicate here asks. An absent copy, an
 * unstamped copy and an old copy are the same fact — *we do not know what the
 * learner has excluded* — and they get the same answer.
 *
 * ## Which way this fails
 *
 * Deliberately the opposite way round from `isPaused` alone. Not knowing whether
 * a site is excluded means not observing it: the trust guarantee is that the
 * detector does not watch what the learner has put off limits, and a guarantee
 * that lapses when a fetch fails is not one. A detector that goes quiet when it
 * cannot check has missed a suggestion; one that keeps watching has broken the
 * only promise that makes it acceptable to ship at all.
 */
import { detectorQuieted } from './reread-core.js';

/** The cache key. The service worker writes it; nothing else ever should. */
export const PREFS_KEY = 'sb_prefs';

/**
 * How often the worker re-reads the service, and how old a copy may get.
 *
 * Five minutes is well inside the alarm floor MV3 allows and costs one loopback
 * request; thirty minutes is six consecutive failures, which is no longer a
 * blip. The bound is not tighter because the detector going dark is a real cost
 * and a service that has been down for ten seconds should not cause it — and it
 * is not looser because a pause the learner set is honoured immediately through
 * the panel's push, so the bound only ever governs a worker that cannot reach
 * the service at all.
 */
export const PREFS_REFRESH_MINUTES = 5;
export const PREFS_MAX_AGE_MS = 30 * 60 * 1000;

/** Panel → worker: prefs changed, re-read them now rather than at the alarm. */
export const PREFS_CHANGED = 'sb-prefs-changed';

/**
 * The subset of `LearnerPrefs` the extension enforces, plus the stamp.
 *
 * Every field is optional because this is parsed from whatever the service
 * actually returned, and a field that is missing must not read as permission.
 */
export interface CachedPrefs {
  pausedUntil?: string | null;
  excludedDomains?: readonly string[];
  /** SB-16, riding the same copy: the per-origin rejection counts. */
  rejectedOrigins?: Readonly<Record<string, number>>;
  /** Epoch ms. Written by the worker at the moment the service answered. */
  writtenAt?: number;
}

/** Hostname, or '' for anything that will not parse. */
export function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** An unparseable or absent `pausedUntil` is not a pause — it must not be able
 *  to jam collection off forever by accident. */
export function isPaused(prefs: CachedPrefs | undefined | null, now: number): boolean {
  if (!prefs?.pausedUntil) return false;
  return Date.parse(prefs.pausedUntil) > now;
}

/** Exclusion covers subdomains: excluding `bank.com` excludes `secure.bank.com`. */
export function isDomainExcluded(host: string, domains: readonly string[] | undefined): boolean {
  return (domains ?? []).some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * Whether this copy of the prefs can be relied on to answer anything.
 *
 * A stamp in the future is refused as well as one too far in the past. It means
 * the clock moved, and a copy written by a clock we cannot trust is a copy whose
 * age we cannot read.
 */
export function isFresh(prefs: CachedPrefs | undefined | null, now: number): boolean {
  const at = prefs?.writtenAt;
  if (typeof at !== 'number' || !Number.isFinite(at)) return false;
  const age = now - at;
  return age >= 0 && age <= PREFS_MAX_AGE_MS;
}

/**
 * The one question the detector asks before it observes anything.
 *
 * Five ways to say no and one to say yes. The url is the page's origin when the
 * detector asks; it is a full url when anything else does, and `hostOf` reads
 * both the same way.
 */
export function mayObserve(
  prefs: CachedPrefs | undefined | null, url: string | undefined, now: number,
): boolean {
  if (!isFresh(prefs, now)) return false;          // absent, unstamped or stale
  if (isPaused(prefs, now)) return false;          // SB-40
  const host = hostOf(url ?? '');
  if (!host) return false;                          // a page we cannot name
  return !isDomainExcluded(host, prefs?.excludedDomains); // SB-41
}

/**
 * The same question with SB-16 folded in, which is the whole of what the worker
 * has to decide when the content script asks.
 *
 * The rejection counts are the service's and they now arrive in the same cached
 * copy as the exclusions, so there is exactly one read and exactly one age to
 * reason about rather than a local check followed by a live fetch.
 */
export function detectorMayObserve(
  prefs: CachedPrefs | undefined | null, origin: string, now: number,
): boolean {
  if (!mayObserve(prefs, origin, now)) return false;
  return !detectorQuieted(prefs?.rejectedOrigins, origin);
}

/**
 * Manual capture, and the one thing that stops it.
 *
 * The deliberate-capture precedence's spirit is that manual is the trusted spine, and a deliberate
 * gesture on a page the learner chose to be on outranks a background list they
 * set once. So neither the exclusion list nor a pause gates a pin: the list says
 * *do not watch me here*, the pause says *stop watching me for a while*, and
 * pressing Alt+P is not something being done to them. A tab with no url is still
 * refused — that is not a policy, it is a page we cannot identify.
 *
 * The consequence is stated rather than hidden: the off-limits screen tells the
 * learner in as many words that pinning by hand still works on these sites.
 *
 * What IS refused is a page nothing can read. `file://` is the refusal that
 * costs something real — a paper opened from disk is a file url, and SB-11 is
 * about papers — and it is still the honest answer: scripting one needs "Allow
 * access to file URLs", which is off by default and which this extension does
 * not ask for, so a file pin would work on one machine and silently not on the
 * next.
 */
export function capturePermitted(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  // An allow-list, for the reason every allow-list in this repo is one: the set
  // of schemes a browser will not let an extension script is not fixed, is not
  // published as a list, and grows. `chrome:`, `devtools:`, `about:`,
  // `view-source:`, another extension's pages — the refusal used to be implicit
  // (the injection rejects, the catch shrugs) and it arrived by accident of
  // Chrome's rather than by decision of ours, on a path that also swallows real
  // failures. The toolbar capture contract puts a capture affordance on the toolbar button,
  // which is present on every one of those pages.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return !isWebStore(parsed);
}

/**
 * The same question, asked where not knowing is not a refusal.
 *
 * `capturePermitted` answers "may we script this page", and it reads a missing
 * url as no. That is right for `pin`: a pin with no url is one nobody could
 * attribute, and there is a test that says so. It is wrong for *opening the
 * picker*, which captures nothing — the picker draws a UI and every pick made
 * in it goes through the ordinary capture path afterwards.
 *
 * And the url really can be missing. This extension asks for no `tabs`
 * permission, deliberately, so `chrome.tabs.get` returns a tab with no `url`
 * unless `activeTab` has been granted — `probe-popup.mjs` shows exactly that
 * on a page the manifest has no host permission for. Reading that absence as
 * "not permitted" would make the toolbar button's picker do **nothing at all,
 * silently**, on every page, the moment that grant was not there.
 *
 * **Stated honestly: this is defensive rather than measured.** Whether a real
 * toolbar click carries the grant cannot be tested from CDP, which cannot press
 * a toolbar button. What is measured is that the picker arrives when the url IS
 * readable, and that nothing breaks when it is not. So: refuse only what is
 * known to be off-limits, and let Chrome refuse the injection otherwise, which
 * it does harmlessly.
 */
export function mayScript(url: string | undefined): boolean {
  return url === undefined || capturePermitted(url);
}

/**
 * The one http(s) carve-out, and it is the browser's rather than ours: no
 * extension is scripted onto the store that installs it. Named here so the
 * refusal reads as a fact about Chrome instead of as a page that happened not
 * to work.
 */
function isWebStore(url: URL): boolean {
  // Written as a host suffix plus one of two shapes rather than as two exact
  // hostnames, because the older of them begins with the word this file is full
  // of and would read to anything scanning the source as a `chrome.` namespace.
  // It also costs nothing: refusing to pin a Google page filed under /webstore
  // is not a page anybody is trying to learn from.
  if (!url.hostname.endsWith('google.com')) return false;
  return url.hostname.startsWith('chromewebstore.') || url.pathname.startsWith('/webstore');
}

/**
 * A `GET /prefs` body, turned into a cache entry — or refused.
 *
 * Refusing matters as much as accepting. A 200 whose body is not prefs would
 * otherwise be cached as "nothing is excluded", freshly stamped, and would read
 * as permission for the next half hour. Returning null leaves the previous copy
 * in place to age out on its own, which fails in the direction this whole file
 * fails in.
 */
export function cacheFrom(body: unknown, now: number): CachedPrefs | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const p = body as Record<string, unknown>;
  // The exclusion list is the load-bearing field, so its absence is what makes a
  // body unrecognisable. An empty array is fine: a learner may clear the list.
  if (!Array.isArray(p['excludedDomains'])) return null;
  const counts = p['rejectedOrigins'];
  return {
    pausedUntil: typeof p['pausedUntil'] === 'string' ? p['pausedUntil'] : null,
    excludedDomains: (p['excludedDomains'] as unknown[]).filter((d): d is string => typeof d === 'string'),
    rejectedOrigins: counts !== null && typeof counts === 'object' && !Array.isArray(counts)
      ? Object.fromEntries(Object.entries(counts as Record<string, unknown>)
        .filter((e): e is [string, number] => typeof e[1] === 'number'))
      : {},
    writtenAt: now,
  };
}

export interface PrefsStorage {
  read(): Promise<CachedPrefs | undefined>;
  write(prefs: CachedPrefs): Promise<void>;
}

/** `chrome.storage.local` as a PrefsStorage. The only chrome-shaped thing here. */
export function chromePrefsStorage(
  local: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> },
  key: string = PREFS_KEY,
): PrefsStorage {
  return {
    async read(): Promise<CachedPrefs | undefined> {
      const got = await local.get(key);
      const v = got[key];
      return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as CachedPrefs : undefined;
    },
    async write(prefs: CachedPrefs): Promise<void> {
      await local.set({ [key]: prefs });
    },
  };
}
