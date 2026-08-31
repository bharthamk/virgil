import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheFrom, chromePrefsStorage, detectorMayObserve, isFresh, mayObserve,
  PREFS_KEY, PREFS_MAX_AGE_MS, PREFS_REFRESH_MINUTES, type CachedPrefs,
} from '../prefs.js';

/**
 * The synced cache, and the direction it fails in (, ).
 *
 * This is the file that closes the gap the re-read detector shipped with. The
 * detector runs on every http(s) page; `isExcluded()` read
 * `chrome.storage.local.sb_prefs`, a key nothing had ever written; and the
 * service's eleven shipped exclusions never reached the extension. So "the
 * detector does not observe on excluded sites" — the condition on which
 * observing at all was judged acceptable — was false, and nothing failed.
 *
 * Every assertion below is one direction of one rule: **an unknown exclusion
 * state means no observation, never the reverse.** They are stated in both
 * directions on purpose. A test suite that only proves the detector stops is
 * satisfied by a detector that never starts, and that would be the same defect
 * wearing the opposite face.
 */

const NOW = Date.parse('2026-08-19T21:00:00.000Z');
const SITE = 'https://docs.example.test';

const cache = (over: Partial<CachedPrefs> = {}): CachedPrefs => ({
  pausedUntil: null, excludedDomains: [], rejectedOrigins: {}, writtenAt: NOW, ...over,
});

// --------------------------------------------------------------- it observes

test('a fresh cache on a site nobody excluded observes', () => {
  // The "yes" case, first, because everything else here is a "no" and a file of
  // nothing but refusals would pass with the detector deleted.
  assert.equal(mayObserve(cache(), SITE, NOW), true);
  assert.equal(detectorMayObserve(cache(), SITE, NOW), true);
});

test('a cache written a minute ago is still fresh, and one written at the bound still counts', () => {
  assert.equal(isFresh(cache({ writtenAt: NOW - 60_000 }), NOW), true);
  assert.equal(isFresh(cache({ writtenAt: NOW - PREFS_MAX_AGE_MS }), NOW), true);
  assert.equal(mayObserve(cache({ writtenAt: NOW - PREFS_MAX_AGE_MS }), SITE, NOW), true);
});

test('the refresh runs often enough that the bound is several failures, not one', () => {
  // The bound is not a number pulled out of the air: it is how long the service
  // has to be unreachable before a missed refresh stops being a blip.
  assert.equal(PREFS_REFRESH_MINUTES, 5);
  assert.equal(PREFS_MAX_AGE_MS / (PREFS_REFRESH_MINUTES * 60_000), 6);
});

// ----------------------------------------------------- it does not observe

test('an absent cache never observes', () => {
  // The defect, as it shipped: nothing had written the key, so this was the
  // state of every page in the browser.
  for (const absent of [undefined, null]) {
    assert.equal(isFresh(absent, NOW), false);
    assert.equal(mayObserve(absent, SITE, NOW), false);
    assert.equal(detectorMayObserve(absent, SITE, NOW), false);
  }
});

test('an unstamped cache never observes, however complete it looks', () => {
  // A copy with no `writtenAt` has no age, and a copy whose age cannot be read
  // cannot be believed. This is also the shape a hand-written `sb_prefs` would
  // have, and it must not be able to grant permission.
  const unstamped = { pausedUntil: null, excludedDomains: [], rejectedOrigins: {} };
  assert.equal(isFresh(unstamped, NOW), false);
  assert.equal(mayObserve(unstamped, SITE, NOW), false);
});

test('a stale cache never observes, even though the site is not on the list', () => {
  const old = cache({ writtenAt: NOW - PREFS_MAX_AGE_MS - 1 });
  assert.equal(isFresh(old, NOW), false);
  assert.equal(mayObserve(old, SITE, NOW), false,
    'not knowing what the learner has excluded is not permission to watch');
  assert.equal(detectorMayObserve(old, SITE, NOW), false);
});

test('a cache stamped in the future never observes', () => {
  // The clock moved. An age we cannot read is an age we do not trust, and the
  // alternative is a skew that grants a fortnight of permission.
  assert.equal(isFresh(cache({ writtenAt: NOW + 60_000 }), NOW), false);
  assert.equal(mayObserve(cache({ writtenAt: NOW + 60_000 }), SITE, NOW), false);
});

test('a stamp that is not a number never observes', () => {
  for (const writtenAt of ['2026-08-19T21:00:00.000Z', NaN, Infinity, null]) {
    assert.equal(isFresh({ writtenAt } as CachedPrefs, NOW), false, `${String(writtenAt)} is not an age`);
  }
});

test('an excluded site never observes, even with a fresh cache', () => {
  const prefs = cache({ excludedDomains: ['bank.test', 'mail.google.com'] });
  assert.equal(mayObserve(prefs, 'https://bank.test', NOW), false);
  assert.equal(mayObserve(prefs, 'https://secure.bank.test', NOW), false, 'subdomains too');
  assert.equal(mayObserve(prefs, 'https://mail.google.com', NOW), false);
  assert.equal(mayObserve(prefs, 'https://notbank.test', NOW), true, 'and not a stranger that ends the same way');
});

test('a paused learner is never observed, on any site', () => {
  const paused = cache({ pausedUntil: '2026-08-19T22:00:00.000Z' });
  assert.equal(mayObserve(paused, SITE, NOW), false);
  assert.equal(mayObserve(paused, 'https://anywhere.example.test', NOW), false);
  assert.equal(detectorMayObserve(paused, SITE, NOW), false);
});

test('a pause that has expired observes again on its own', () => {
  // Every pause the panel offers is bounded, so this is the normal way one ends.
  assert.equal(mayObserve(cache({ pausedUntil: '2026-08-19T20:59:59.000Z' }), SITE, NOW), true);
});

test('a page with no readable host never observes', () => {
  // Inverted from the capture path deliberately. There, an unparseable url was
  // simply not matched against the list; here, a page we cannot name is a page
  // we cannot check against the list, which is the unknown state.
  for (const url of [undefined, '', 'not a url', 'about:blank']) {
    assert.equal(mayObserve(cache(), url, NOW), false, `${String(url)} has no host to check`);
  }
});

// ------------------------------------------------------ , same copy

test('the rejection counts ride the same cache, and two of them silence the site', () => {
  const twice = cache({ rejectedOrigins: { [SITE]: 2 } });
  assert.equal(mayObserve(twice, SITE, NOW), true, ' have no objection');
  assert.equal(detectorMayObserve(twice, SITE, NOW), false, 'and  does');
  assert.equal(detectorMayObserve(cache({ rejectedOrigins: { [SITE]: 1 } }), SITE, NOW), true,
    'one no is a bad guess about one passage, not a verdict on the site');
});

test('a quieted origin does not quiet its neighbours', () => {
  const prefs = cache({ rejectedOrigins: { 'https://news.example.test': 4 } });
  assert.equal(detectorMayObserve(prefs, 'https://news.example.test', NOW), false);
  assert.equal(detectorMayObserve(prefs, SITE, NOW), true);
});

// ------------------------------------------------- what may become a cache

test('a prefs body becomes a stamped cache carrying exactly what is enforced', () => {
  const got = cacheFrom({
    targetMinutes: 15, interfaceLanguage: 'en',
    pausedUntil: '2026-08-19T22:00:00.000Z',
    excludedDomains: ['bank.test'],
    interview: { anything: 'else' },
    rejectedOrigins: { [SITE]: 2 },
  }, NOW);
  assert.deepEqual(got, {
    pausedUntil: '2026-08-19T22:00:00.000Z',
    excludedDomains: ['bank.test'],
    rejectedOrigins: { [SITE]: 2 },
    writtenAt: NOW,
  }, 'the rest of LearnerPrefs is the service’s business and is not copied into the page-facing cache');
});

test('a body that is not prefs is refused rather than cached as permission', () => {
  // This is the one that would have been silent. A 200 with a body we do not
  // recognise, cached, is "nothing is excluded" — freshly stamped, and believed
  // for the next half hour.
  for (const body of [null, undefined, 'ok', 42, [], {}, { excludedDomains: 'bank.test' }]) {
    assert.equal(cacheFrom(body, NOW), null, `${JSON.stringify(body) ?? 'undefined'} is not prefs`);
  }
});

test('an empty exclusion list is a real answer and is cached', () => {
  // A learner may clear the list. That is different from a body that never had
  // one, and only the second is a refusal.
  const got = cacheFrom({ excludedDomains: [] }, NOW);
  assert.deepEqual(got, { pausedUntil: null, excludedDomains: [], rejectedOrigins: {}, writtenAt: NOW });
  assert.equal(mayObserve(got, SITE, NOW), true);
});

test('junk inside the fields is dropped rather than carried into the predicate', () => {
  const got = cacheFrom({
    pausedUntil: 1234, excludedDomains: ['bank.test', 7, null],
    rejectedOrigins: { [SITE]: 'lots', 'https://x.test': 3 },
  }, NOW);
  assert.deepEqual(got, {
    pausedUntil: null, excludedDomains: ['bank.test'],
    rejectedOrigins: { 'https://x.test': 3 }, writtenAt: NOW,
  });
});

// ------------------------------------------------------------ the storage

test('the cache round-trips through chrome.storage under the one key', async () => {
  const items: Record<string, unknown> = {};
  const storage = chromePrefsStorage({
    get: async (key) => (key in items ? { [key]: items[key] } : {}),
    set: async (next) => { Object.assign(items, next); },
  });
  assert.equal(await storage.read(), undefined, 'nothing written yet is not an empty prefs object');
  await storage.write(cache({ excludedDomains: ['bank.test'] }));
  assert.equal(PREFS_KEY, 'sb_prefs', 'the key the extension has always enforced, now actually written');
  assert.deepEqual((await storage.read())?.excludedDomains, ['bank.test']);
});

test('a stored value of the wrong shape reads as nothing stored', async () => {
  for (const stored of ['sb_prefs', 42, [], null]) {
    const storage = chromePrefsStorage({
      get: async () => ({ [PREFS_KEY]: stored }),
      set: async () => {},
    });
    assert.equal(await storage.read(), undefined);
  }
});
