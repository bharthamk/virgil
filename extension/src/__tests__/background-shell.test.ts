import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  installChrome, freshImport, settle, tab,
  jsonResponse, badJsonResponse, type ChromeStub, type ChromeStubOptions,
} from './chrome-stub.js';
import { PREFS_CHANGED, PREFS_KEY, PREFS_MAX_AGE_MS, PREFS_REFRESH_MINUTES } from '../prefs.js';
import {
  EXPERIMENTAL_CAPTURE_CHANGED, EXPERIMENTAL_WHOLE_PAGE_KEY,
  menuModes, OPEN_BOARD_ID, OPEN_PANEL_ID, OPEN_SELECTOR, OPEN_SELECTOR_ON_PAGE,
  WHOLE_PAGE_MODE_ID,
} from '../pin-modes.js';
import { REREAD_CANDIDATE, REREAD_PREFS } from '../reread-bridge.js';
import {
  CLIENT_SCHEMA_HEADER, CLIENT_SCHEMA_VERSION, SHARED_SECRET_HEADER, SHARED_SECRET_KEY,
} from '../service.js';
import { QUEUE_REMOVE, QUEUE_RETRY, queuedPin } from '../queue.js';
import { PIN_UNDO } from '../toast.js';

/**
 * The service worker, running.
 *
 * `background.ts` is the one file in the extension that nothing imported and no
 * test had ever evaluated: the listeners, the single-flight refresh, the message
 * routing and the alarm branch were all reasoned about and never run. Every
 * decision they make had been extracted into `prefs.ts`, `queue.ts` and
 * `pin-body.ts` and tested there — which is exactly why the wiring *between*
 * them was the part left unchecked. A predicate that is never asked is as
 * broken as one that answers wrongly.
 *
 * So this file imports the worker with a stubbed `chrome` in place and drives it
 * the way Chrome would: a message from the content script, an alarm, a wake with
 * a cache of a particular age. What it cannot do is prove Chrome accepts the
 * manifest, grants the permissions, or delivers the events at all — that is
 * `manifest-paths.test.ts` for the paths and a browser for the rest.
 */

const SERVICE = 'http://127.0.0.1:8791';
/** What the learner puts in `chrome.storage.local` to reach a private service. */
const SECRET = 'a-secret-long-enough-to-be-one';

/** A prefs body as `GET /prefs` returns it. */
const prefsBody = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ excludedDomains: [], rejectedOrigins: {}, pausedUntil: null, ...over });

/** A cache entry as the worker writes it, aged by `ageMs`. */
const cached = (ageMs: number, over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ ...prefsBody(over), writtenAt: Date.now() - ageMs });

/**
 * Wake a worker with this `chrome` in place. `before` runs after the stub is
 * installed and before the worker is imported, which is the only window in
 * which the boot refresh can be pointed anywhere.
 */
async function wake(
  t: TestContext, options: ChromeStubOptions = {}, before: (c: ChromeStub) => void = () => {},
): Promise<ChromeStub> {
  const c = installChrome(options);
  t.after(() => { c.uninstall(); });
  before(c);
  await freshImport('../background.js');
  await settle();
  return c;
}

const prefsRequests = (c: ChromeStub): unknown[] => c.requests.filter((r) => r.url.endsWith('/prefs'));

// --------------------------------------------------------------- the wiring

test('the worker survives being evaluated, which is the whole of what MV3 asks of it first', async (t) => {
  // This is the test that found the defect this file exists for. The eager
  // refresh — "on startup means whenever this file is evaluated" — sat above the
  // `let refreshing` it reads, so evaluating the worker threw a ReferenceError
  // out of the temporal dead zone and every listener declared below the call was
  // never registered: no keyboard capture, no context menus, no answer to the
  // content script, no alarms. A manifest path check cannot see it, a type check
  // cannot see it, and 524 tests did not, because nothing imported this file.
  const c = installChrome();
  t.after(() => { c.uninstall(); });
  await assert.doesNotReject(() => freshImport('../background.js'));
  await settle();
  assert.ok(c.counts()['onMessage']! > 0, 'the listeners below the eager refresh are registered');
  assert.ok(c.alarms.length > 0, 'and so are the alarms at the very bottom of the file');
});

test('the worker registers every listener the manifest promises, and only once each', async (t) => {
  const c = await wake(t);
  assert.deepEqual(c.counts(), {
    onInstalled: 1, onStartup: 1, onMessage: 1, onCommand: 1,
    onMenuClicked: 1, onAlarm: 1,
    // No `onActionClicked`, and its absence is the assertion: the manifest
    // declares `action.default_popup`, so Chrome opens the popup itself and
    // the event can never fire. A listener would be a dead path that reads
    // like a live one — see `action-popup.ts`.
    onActionClicked: 0,
  });
});

test('install builds the reliable text modes and a door to each surface', async (t) => {
  const c = await wake(t);
  await c.fire.installed();
  await settle();
  // From the registry: the menu is built from it, so this asserts the wiring
  // rather than restating the list. Order matters, because it is the order
  // the modes cost attention in.
  assert.deepEqual(c.menus.map((m) => m.id),
    [...menuModes(false).map((m) => m.id), OPEN_BOARD_ID, OPEN_PANEL_ID]);
  assert.equal(c.menus.some((m) => m.id === WHOLE_PAGE_MODE_ID), false,
    'whole-page extraction is not part of the default product menu');
  for (const mode of menuModes(false)) {
    assert.deepEqual(c.menus.find((m) => m.id === mode.id)?.contexts, [...mode.contexts],
      `${mode.id} is offered in contexts the registry does not declare`);
  }
  assert.equal(c.menus.some((m) => m.id === 'pin-image' || m.title === 'Pin this image'), false,
    'image intake belongs on the Virgil page, not in browser capture');
  assert.deepEqual(c.menus.find((m) => m.id === OPEN_PANEL_ID)?.contexts, ['action'],
    'the panel opens from the button it used to open from, one click further in');
  assert.deepEqual(c.menus.find((m) => m.id === OPEN_BOARD_ID)?.contexts, ['action'],
    'the full page remains reachable from the extension action');
});

test('whole-page capture appears only when its local experiment is enabled', async (t) => {
  const c = await wake(t, { store: { [EXPERIMENTAL_WHOLE_PAGE_KEY]: true } });
  await c.fire.installed();
  await settle();
  assert.deepEqual(c.menus.map((m) => m.id),
    [...menuModes(true).map((m) => m.id), OPEN_BOARD_ID, OPEN_PANEL_ID]);
  assert.ok(c.menus.some((m) => m.id === WHOLE_PAGE_MODE_ID));
});

test('changing the experiment rebuilds the live browser menu', async (t) => {
  const c = await wake(t);
  await c.fire.installed();
  c.store[EXPERIMENTAL_WHOLE_PAGE_KEY] = true;
  assert.deepEqual(await c.send({ kind: EXPERIMENTAL_CAPTURE_CHANGED }), { ok: true });
  assert.ok(c.menus.some((m) => m.id === WHOLE_PAGE_MODE_ID));
  c.store[EXPERIMENTAL_WHOLE_PAGE_KEY] = false;
  assert.deepEqual(await c.send({ kind: EXPERIMENTAL_CAPTURE_CHANGED }), { ok: true });
  assert.equal(c.menus.some((m) => m.id === WHOLE_PAGE_MODE_ID), false);
});

test('the board opens as a page from the button, not as a panel', async (t) => {

  const c = await wake(t);
  await c.fire.menuClick({ menuItemId: OPEN_BOARD_ID }, tab());
  await settle();
  assert.equal(c.tabsCreated.length, 1, 'a tab, because a panel is not where the board lives');
  assert.equal(String(c.tabsCreated[0]?.url), 'http://127.0.0.1:8791/app/',
    'and it is the page, resolved through the configured service origin');
  assert.deepEqual(c.panelOpens, [], 'and it is not the panel');
});

test('the Selector is reachable from every ordinary state a learner right-clicks in', async (t) => {

  const c = await wake(t);
  await c.fire.installed();
  await settle();
  const contexts = c.menus.find((m) => m.id === 'mode-select')?.contexts ?? [];
  for (const where of ['page', 'selection', 'link', 'image', 'video', 'audio', 'editable', 'frame', 'action']) {
    assert.ok(contexts.includes(where),
      `the Selector is not offered on "${where}", so a learner in that state cannot reach it`);
  }
});

test('the right-click menu uses learner language and leaves the guide to Virgil', async (t) => {
  const c = await wake(t);
  await c.fire.installed();
  await settle();
  const titles = Object.fromEntries(c.menus.map((m) => [m.id, m.title]));
  assert.equal(titles['mode-flash'], 'Pin this');
  assert.equal(titles['mode-standard'], 'Add details before pinning…');
  assert.equal(titles['mode-learn-now'], 'Learn this now');
  assert.equal(titles['open-board'], 'Open Virgil');
  assert.ok(!('mode-guide-me' in titles), 'a lesson-level guide choice belongs inside Virgil, not its fast menu');
});

test('a right-click with something highlighted offers a way to choose differently', async (t) => {
  // The behavioural half: Chrome only delivers `selection`-context items when
  // there is a selection, so the registry claim above has to be true of the
  // menu Chrome actually builds in the commonest state there is.
  const c = await wake(t);
  await c.fire.installed();
  await settle();
  const withSelection = c.menus.filter((m) => m.contexts?.includes('selection')).map((m) => m.id);
  assert.ok(withSelection.includes('mode-select'),
    'every mode a learner can want after highlighting must be in the highlighted menu');
});

test('reloading the extension rebuilds the menu instead of colliding with the old one', async (t) => {
  /**
   * `onInstalled` fires on update and on every reload of an unpacked
   * extension, and `chrome.contextMenus.create` **refuses a duplicate id** —
   * through `lastError`, which nothing reads. So an install that runs against
   * menu items still standing from the previous version creates nothing and
   * says nothing, and the learner keeps the *old* menu: exactly the failure
   * this window was opened by, with a new item added to the registry and
   * absent from Chrome.
   *
   * The fix is one line and the reason it is worth a test is that it is one
   * line: `removeAll` first, so the menu Chrome holds is always the menu the
   * registry currently declares.
   */
  const c = await wake(t);
  await c.fire.installed();
  await settle();
  await c.fire.installed();
  await settle();
  assert.deepEqual(c.menus.map((m) => m.id),
    [...menuModes(false).map((m) => m.id), OPEN_BOARD_ID, OPEN_PANEL_ID],
    'a second install must leave one menu, not two overlaid or one refused');
});

test('Chrome is never told to open the panel on the click, because the popup has it', async (t) => {

  const c = await wake(t);
  await c.fire.installed();
  await settle();
  assert.deepEqual(c.panelBehaviour, [{ openPanelOnActionClick: false }]);
});

test('the popup asking for the picker gets it, even on a tab whose url it cannot read', async (t) => {
  /**
   * **The failure guarded against here is total silence.** The popup sends one
   * message and closes; the worker turns the tab id back into a tab and injects
   * the picker. `runMode`'s select branch guarded that on
   * `capturePermitted(tab.url)` — and this extension asks for no `tabs`
   * permission, so `tab.url` is present only under the `activeTab` grant.
   * `probe-popup.mjs` shows the url genuinely absent on a page the manifest
   * has no host permission for; when it is, the old guard read `undefined` as
   * "not permitted", returned, and said nothing to anyone.
   *
   * Whether a real toolbar click carries the grant is **not** established —
   * CDP cannot press a toolbar button. This test holds the behaviour that is
   * correct either way.
   *
   * Not knowing is not the same as knowing it is refused. Opening the picker
   * is not a pin — nothing is captured until somebody clicks something — so an
   * unreadable url is a reason to try and let Chrome refuse the injection,
   * which it does harmlessly. `pin` keeps the strict rule, because there a
   * missing url really is a pin nobody could attribute.
   */
  const c = await wake(t, { tabsById: { 7: { id: 7, windowId: 3 } } });   // no url
  await c.send({ kind: 'sb-open-selector', tabId: 7 }, {});
  await settle();
  assert.deepEqual(c.tabMessages, [{ tabId: 7, message: { kind: OPEN_SELECTOR_ON_PAGE } }],
    'the picker is opened by the declared page listener rather than silently declined');
  assert.equal(c.injections.length, 0, 'a current page listener needs no repair injection');
  assert.deepEqual(c.panelOpens, [], 'and asking to pick is not asking for the board');
});

test('the side panel picker acts on the active web page beside it', async (t) => {
  const c = await wake(t, { activeTab: { id: 8, windowId: 3, url: 'https://example.test/lesson' } });
  const reply = await c.send({ kind: OPEN_SELECTOR }, {});
  await settle();

  assert.deepEqual(reply, { ok: true }, 'the panel is told the picker opened');
  assert.deepEqual(c.tabMessages, [{ tabId: 8, message: { kind: OPEN_SELECTOR_ON_PAGE } }],
    'the exact active page received the picker request');
  assert.equal(c.injections.length, 0, 'the declared listener is the ordinary route');
});

test('a page open before the extension reload gets its selector listener repaired once', async (t) => {
  const c = await wake(t, {
    activeTab: { id: 9, windowId: 3, url: 'https://example.test/older-lesson' },
    selectorContentReady: false,
  });
  const reply = await c.send({ kind: OPEN_SELECTOR }, {});
  await settle();

  assert.deepEqual(reply, { ok: true });
  assert.equal(c.injections.length, 1, 'the absent declared listener is repaired');
  assert.deepEqual(c.injections[0]?.files, ['selector-content.js']);
  assert.equal(c.injections[0]?.tabId, 9);
  assert.deepEqual(c.tabMessages, [
    { tabId: 9, message: { kind: OPEN_SELECTOR_ON_PAGE } },
    { tabId: 9, message: { kind: OPEN_SELECTOR_ON_PAGE } },
  ], 'the same page is retried after repair; no other tab is inferred');
});

test('the picker is still declined on a page known to be off-limits', async (t) => {
  const c = await wake(t, { tabsById: { 7: { id: 7, windowId: 3, url: 'chrome://settings' } } });
  await c.send({ kind: 'sb-open-selector', tabId: 7 }, {});
  await settle();
  assert.deepEqual(c.injections, [], 'known, and known to be refused');
});

test('the panel still opens, from the menu on the button', async (t) => {
  const c = await wake(t);
  await c.fire.menuClick({ menuItemId: 'open-panel' }, tab());
  await settle();
  assert.deepEqual(c.panelOpens, [{ windowId: 3, gesture: true }],
    'a window, because a side panel belongs to one — and asked for while the click still authorises it');
  assert.deepEqual(c.injections, [], 'opening the panel is not a capture');
});

test('a Chrome too old for the side panel API does not take the install or the open down with it', async (t) => {
  const c = await wake(t, { sidePanelFails: true });
  await assert.doesNotReject(async () => { await c.fire.installed(); await settle(); });
  assert.equal(c.menus.length, menuModes(false).length + 2,
    'the menus were created before the panel call that failed');
  await assert.doesNotReject(async () => { await c.fire.menuClick({ menuItemId: OPEN_PANEL_ID }, tab()); });
});

test('both alarms are created, and the prefs alarm runs at the interval the staleness bound assumes', async (t) => {
  const c = await wake(t);
  const byName = Object.fromEntries(c.alarms.map((a) => [a.name, a.periodInMinutes]));
  assert.deepEqual(byName, { 'sb-drain': 1, 'sb-prefs': PREFS_REFRESH_MINUTES });
  assert.ok(PREFS_MAX_AGE_MS / (PREFS_REFRESH_MINUTES * 60_000) >= 6,
    'the bound has to be several consecutive failures, not one blip');
});

test('the worker refreshes its cache the moment it is evaluated, because MV3 kills it whenever it likes', async (t) => {
  const c = await wake(t);
  assert.equal(prefsRequests(c).length, 1);
  assert.equal(c.requests[0]?.url, `${SERVICE}/prefs`);
  const written = c.store[PREFS_KEY] as { writtenAt?: number } | undefined;
  assert.ok(typeof written?.writtenAt === 'number', 'the cache is stamped or it is worthless');
});

test('a wake and a startup event do not each fetch on their own timeline', async (t) => {
  const c = await wake(t);
  await c.fire.startup();
  await settle();
  assert.equal(prefsRequests(c).length, 2, 'startup is a real refresh; it is the boot one that already ran');
});

// ------------------------------------------------- the cache the worker keeps

test('a prefs response becomes the cache under the one key the extension reads', async (t) => {
  const c = await wake(t, {}, (stub) => {
    stub.fetchHandler = () => jsonResponse(prefsBody({ excludedDomains: ['bank.test'] }));
  });
  assert.deepEqual(Object.keys(c.store), [PREFS_KEY]);
  assert.deepEqual((c.store[PREFS_KEY] as { excludedDomains: string[] }).excludedDomains, ['bank.test']);
});

test('a 500 writes nothing, so the copy we already had ages out on its own', async (t) => {
  const before = cached(60_000, { excludedDomains: ['bank.test'] });
  const c = await wake(t, { store: { [PREFS_KEY]: before } }, (stub) => {
    stub.fetchHandler = () => jsonResponse({ error: 'nope' }, 500);
  });
  assert.deepEqual(c.store[PREFS_KEY], before, 'a failed refresh must not clear or replace the cache');
});

test('a 200 that is not prefs is refused rather than cached as permission', async (t) => {
  const before = cached(60_000, { excludedDomains: ['bank.test'] });
  const c = await wake(t, { store: { [PREFS_KEY]: before } }, (stub) => {
    stub.fetchHandler = () => jsonResponse({ hello: 'world' });
  });
  assert.deepEqual(c.store[PREFS_KEY], before,
    'a body with no exclusion list in it would otherwise read as "nothing is excluded"');
});

test('a body that is not JSON at all is a failed refresh, not a crash', async (t) => {
  const before = cached(60_000, { excludedDomains: ['bank.test'] });
  const c = await wake(t, { store: { [PREFS_KEY]: before } }, (stub) => {
    stub.fetchHandler = () => badJsonResponse();
  });
  assert.deepEqual(c.store[PREFS_KEY], before);
});

test('a service that is not running leaves the cache alone and raises nothing', async (t) => {
  const before = cached(60_000);
  const c = await wake(t, { store: { [PREFS_KEY]: before } }, (stub) => {
    stub.fetchHandler = () => { throw new TypeError('fetch failed'); };
  });
  assert.deepEqual(c.store[PREFS_KEY], before);
});

test('storage that refuses to be written does not leave the refresh permanently in flight', async (t) => {
  const c = await wake(t, { storageFails: true });
  // The write threw inside the single-flight promise. If that promise never
  // settled, or settled without clearing the flight, every later refresh would
  // be dropped and the worker would be stuck on a cache it cannot read either.
  await c.fire.alarm('sb-prefs');
  await settle();
  assert.equal(prefsRequests(c).length, 2, 'the next refresh still runs after a failed write');
});

// ------------------------------------------------------------- single flight

test('a page load, an alarm and a panel push arriving together make one request', async (t) => {
  let release = (): void => {};
  const c = await wake(t, { store: { [PREFS_KEY]: cached(0) } }, (stub) => {
    stub.fetchHandler = () => new Promise<ReturnType<typeof jsonResponse>>((resolve) => {
      release = (): void => { resolve(jsonResponse(prefsBody())); };
    });
  });
  // The boot refresh is the one in flight. Everything that arrives now should
  // join it rather than start its own.
  const joined = [
    c.send({ kind: PREFS_CHANGED }),
    c.fire.alarm('sb-prefs'),
    c.fire.alarm('sb-prefs'),
  ];
  await settle();
  assert.equal(prefsRequests(c).length, 1, 'three triggers, one request');
  release();
  await Promise.all(joined);
  await settle();
});

test('the flight is released, so the next refresh is a new request rather than an old answer', async (t) => {
  const c = await wake(t);
  await c.fire.alarm('sb-prefs');
  await settle();
  await c.fire.alarm('sb-prefs');
  await settle();
  assert.equal(prefsRequests(c).length, 3, 'boot, then one per alarm');
});

// ---------------------------------------------------- the detector's question

/**
 * Put a cache of a given age in front of a worker that is already awake.
 *
 * Deliberately after `wake` rather than seeded before it: the worker refreshes
 * the moment it is evaluated, so anything sitting in storage beforehand is
 * whatever the boot response says a moment later. That is the real sequence, and
 * it is why a test about a *stale* cache has to write one after the boot.
 */
function holds(c: ChromeStub, entry: Record<string, unknown>): void {
  c.store[PREFS_KEY] = entry;
}

test('a fresh cache answers the detector without going near the service', async (t) => {
  const c = await wake(t);
  holds(c, cached(60_000));
  const boot = prefsRequests(c).length;
  const reply = await c.send({ kind: REREAD_PREFS, origin: 'https://docs.test' });
  assert.deepEqual(reply, { quieted: false });
  assert.equal(prefsRequests(c).length, boot, 'a believable cache is the whole point of having one');
});

test('a cache one millisecond past the bound is refreshed before the detector is answered', async (t) => {
  const c = await wake(t);
  holds(c, cached(PREFS_MAX_AGE_MS + 1));
  const boot = prefsRequests(c).length;
  const reply = await c.send({ kind: REREAD_PREFS, origin: 'https://docs.test' });
  assert.equal(prefsRequests(c).length, boot + 1, 'the read path refreshes; waiting for the alarm would go dark');
  assert.deepEqual(reply, { quieted: false }, 'and then answers from the copy it just fetched');
});

test('a refresh that takes a moment is still believed by the page that waited for it', async (t) => {
  // The defect this pins: the worker read the clock once, before the refresh,
  // and judged the answer against it afterwards. Anything that took a
  // millisecond — which a real loopback request always does — came back stamped
  // later than the question, `isFresh` refused it as future-stamped, and the
  // detector was quieted on the first page after every wake with a stale cache.
  // It showed up as an intermittent failure here before it showed up as one
  // there, which is the only reason it is not still shipping.
  const c = await wake(t);
  holds(c, cached(PREFS_MAX_AGE_MS + 1));
  c.fetchHandler = async () => {
    await new Promise<void>((resolve) => { setTimeout(resolve, 3); });
    return jsonResponse(prefsBody());
  };
  assert.deepEqual(await c.send({ kind: REREAD_PREFS, origin: 'https://docs.test' }), { quieted: false });
});

test('a cache just inside the bound is answered from, not refetched', async (t) => {
  // A second inside, not exactly on it: the copy keeps ageing while the message
  // is in flight, so a test written to the millisecond would be testing its own
  // scheduling. That the bound itself is inclusive is `prefs-cache.test.ts`'s
  // job; what belongs here is that the worker asks the same question at all.
  const c = await wake(t);
  holds(c, cached(PREFS_MAX_AGE_MS - 1000));
  const boot = prefsRequests(c).length;
  await c.send({ kind: REREAD_PREFS, origin: 'https://docs.test' });
  assert.equal(prefsRequests(c).length, boot);
});

test('a cache stamped in the future is refused as firmly as an old one', async (t) => {
  const c = await wake(t);
  holds(c, { ...prefsBody(), writtenAt: Date.now() + 60_000 });
  const boot = prefsRequests(c).length;
  await c.send({ kind: REREAD_PREFS, origin: 'https://docs.test' });
  assert.equal(prefsRequests(c).length, boot + 1, 'a clock we cannot trust is an age we cannot read');
});

test('a cache with no stamp on it, however complete it looks, is not believed', async (t) => {
  const c = await wake(t);
  holds(c, prefsBody({ excludedDomains: ['bank.test'] }));
  const boot = prefsRequests(c).length;
  await c.send({ kind: REREAD_PREFS, origin: 'https://docs.test' });
  assert.equal(prefsRequests(c).length, boot + 1);
});

test('junk under the cache key is refreshed past rather than parsed hopefully', async (t) => {
  for (const junk of ['a string', 42, [1, 2, 3], null, true]) {
    const c = await wake(t);
    c.store[PREFS_KEY] = junk;
    const boot = prefsRequests(c).length;
    const reply = await c.send({ kind: REREAD_PREFS, origin: 'https://docs.test' });
    assert.equal(prefsRequests(c).length, boot + 1, `${JSON.stringify(junk)} is not a cache`);
    assert.deepEqual(reply, { quieted: false }, 'and the answer comes from the copy it fetched instead');
    c.uninstall();
  }
});

test('junk in the cache with the service down quiets the detector rather than reading past it', async (t) => {
  const c = await wake(t);
  c.store[PREFS_KEY] = { excludedDomains: 'bank.test', writtenAt: 'lunchtime' };
  c.fetchHandler = () => { throw new TypeError('fetch failed'); };
  assert.deepEqual(await c.send({ kind: REREAD_PREFS, origin: 'https://docs.test' }), { quieted: true });
});

test('a stale cache the service cannot refresh quiets the detector (fail closed)', async (t) => {
  const c = await wake(t);
  holds(c, cached(PREFS_MAX_AGE_MS + 1));
  c.fetchHandler = () => { throw new TypeError('fetch failed'); };
  assert.deepEqual(await c.send({ kind: REREAD_PREFS, origin: 'https://docs.test' }), { quieted: true },
    'not knowing whether this site is off limits means not watching it');
});

test('an excluded site is quieted, and so is every subdomain of it', async (t) => {
  const c = await wake(t);
  holds(c, cached(0, { excludedDomains: ['bank.test'] }));
  assert.deepEqual(await c.send({ kind: REREAD_PREFS, origin: 'https://bank.test' }), { quieted: true });
  assert.deepEqual(await c.send({ kind: REREAD_PREFS, origin: 'https://secure.bank.test' }), { quieted: true });
  assert.deepEqual(await c.send({ kind: REREAD_PREFS, origin: 'https://notbank.test' }), { quieted: false });
});

test('a pause quiets every site at once', async (t) => {
  const c = await wake(t);
  holds(c, cached(0, { pausedUntil: new Date(Date.now() + 60_000).toISOString() }));
  assert.deepEqual(await c.send({ kind: REREAD_PREFS, origin: 'https://docs.test' }), { quieted: true });
});

test('a pause that has run out lets the detector back on without anyone pressing anything', async (t) => {
  const c = await wake(t);
  holds(c, cached(0, { pausedUntil: new Date(Date.now() - 1).toISOString() }));
  assert.deepEqual(await c.send({ kind: REREAD_PREFS, origin: 'https://docs.test' }), { quieted: false });
});

test('two rejections on a site quiet it, and leave its neighbours alone ()', async (t) => {
  const c = await wake(t);
  holds(c, cached(0, { rejectedOrigins: { 'https://news.test': 2, 'https://docs.test': 1 } }));
  assert.deepEqual(await c.send({ kind: REREAD_PREFS, origin: 'https://news.test' }), { quieted: true });
  assert.deepEqual(await c.send({ kind: REREAD_PREFS, origin: 'https://docs.test' }), { quieted: false },
    'one rejection is a bad guess about one passage');
});

test('a detector that cannot name its origin is quieted without a fetch', async (t) => {
  const c = await wake(t);
  holds(c, cached(0));
  const boot = prefsRequests(c).length;
  assert.deepEqual(await c.send({ kind: REREAD_PREFS }), { quieted: true });
  assert.deepEqual(await c.send({ kind: REREAD_PREFS, origin: '' }), { quieted: true });
  assert.equal(prefsRequests(c).length, boot);
});

test('Virgil never observes its own configured service surface', async (t) => {
  const c = await wake(t);
  holds(c, cached(0));
  const boot = prefsRequests(c).length;
  assert.deepEqual(await c.send({ kind: REREAD_PREFS, origin: SERVICE }), { quieted: true });
  assert.equal(prefsRequests(c).length, boot,
    'recognising the product surface does not need a preference round trip');
});

// ------------------------------------------------- the detector's one output

test('a candidate is posted as a suggestion, never as a pin ()', async (t) => {
  const c = await wake(t, {}, (stub) => {
    stub.fetchHandler = (url) => (url.endsWith('/suggestions')
      ? jsonResponse({ id: 's1' })
      : jsonResponse(prefsBody()));
  });
  const reply = await c.send({
    kind: REREAD_CANDIDATE,
    candidate: {
      passage: 'Session state is held per user.',
      url: 'https://docs.test/sessions',
      pageTitle: 'Sessions',
      headingPath: ['ADK', 'Sessions'],
      returnCount: 3,
      dwellMs: 9000,
      reason: 'You came back to this 3 times.',
    },
  });
  assert.deepEqual(reply, { ok: true });
  const posts = c.requests.filter((r) => r.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.url, `${SERVICE}/suggestions`, 'a suggestion, and nothing that looks like /pins');
});

test('the behavioural trace stays in the page — only what the panel shows leaves it', async (t) => {
  const c = await wake(t, {}, (stub) => {
    stub.fetchHandler = (url) => (url.endsWith('/suggestions') ? jsonResponse({}) : jsonResponse(prefsBody()));
  });
  await c.send({
    kind: REREAD_CANDIDATE,
    candidate: {
      passage: 'p', url: 'https://docs.test/x', pageTitle: 't', headingPath: [],
      returnCount: 3, dwellMs: 9000, reason: 'You came back to this 3 times.',
    },
  });
  const posted = c.requests.find((r) => r.url.endsWith('/suggestions'))?.body as Record<string, unknown>;
  assert.deepEqual(Object.keys(posted).sort(), ['headingPath', 'pageTitle', 'passage', 'reason', 'url']);
  assert.equal('dwellMs' in posted, false, 'how long they stared at it is not the service’s business');
  assert.equal('returnCount' in posted, false, 'the count is in the sentence; the number does not travel');
});

test('a suggestion the service refuses is reported back rather than thrown', async (t) => {
  const c = await wake(t, {}, (stub) => {
    stub.fetchHandler = (url) => (url.endsWith('/suggestions') ? jsonResponse({}, 503) : jsonResponse(prefsBody()));
  });
  assert.deepEqual(
    await c.send({ kind: REREAD_CANDIDATE, candidate: { passage: 'p', url: 'u', reason: 'r' } }),
    { ok: false },
  );
});

test('a suggestion nobody is listening for is a no, not an unhandled rejection', async (t) => {
  const c = await wake(t, {}, (stub) => {
    stub.fetchHandler = (url) => {
      if (url.endsWith('/suggestions')) throw new TypeError('fetch failed');
      return jsonResponse(prefsBody());
    };
  });
  assert.deepEqual(
    await c.send({ kind: REREAD_CANDIDATE, candidate: { passage: 'p', url: 'u', reason: 'r' } }),
    { ok: false },
  );
});

// ------------------------------------------------------- messages and strangers

test('the panel push refreshes the cache before it answers, so a pause lands on the next page', async (t) => {
  const c = await wake(t);
  assert.deepEqual(await c.send({ kind: REREAD_PREFS, origin: 'https://docs.test' }), { quieted: false },
    'nothing is paused yet');

  // The learner presses Pause. The panel writes to the service — the authority —
  // and then tells the worker its copy is out of date.
  c.fetchHandler = () => jsonResponse(prefsBody({ pausedUntil: new Date(Date.now() + 60_000).toISOString() }));
  assert.deepEqual(await c.send({ kind: PREFS_CHANGED }), { ok: true });
  assert.deepEqual(await c.send({ kind: REREAD_PREFS, origin: 'https://docs.test' }), { quieted: true },
    'the pause the learner just pressed is in force without waiting five minutes for the alarm');
});

test('a message the worker does not know is left for someone else, and costs nothing', async (t) => {
  const c = await wake(t);
  const boot = c.requests.length;
  await assert.rejects(
    c.send({ kind: 'something-else' }),
    /Receiving end does not exist/,
    'returning false is how a listener declines; it must not answer for messages it does not own',
  );
  await assert.rejects(c.send({ kind: REREAD_CANDIDATE }), /Receiving end does not exist/);
  await assert.rejects(c.send(null), /Receiving end does not exist/);
  await assert.rejects(c.send('a string'), /Receiving end does not exist/);
  await assert.rejects(c.send(42), /Receiving end does not exist/);
  await settle();
  assert.equal(c.requests.length, boot, 'nothing a stranger sends reaches the service');
});

// ----------------------------------------------- the shared secret (the service-protection contract)

test('every request the worker makes carries the secret, when the learner has set one', async (t) => {
  /**
   * The service-protection contract’s extension half. The deployed service is private and answers 401
   * to anything without `x-virgil-secret`, so a request path that forgot the
   * header would be a feature that works on a laptop and is dead the day the
   * service is exposed — with a 401 the worker shows to nobody, because every
   * one of these paths swallows a failure by design.
   *
   * All three paths are checked rather than one, because they are three
   * separate `fetch` calls and "the pin path carries it" is not the claim.
   */
  const c = await wake(t, { store: { [SHARED_SECRET_KEY]: SECRET, sb_pending_pins: [{ type: 'interest' }] } },
    (stub) => {
      stub.fetchHandler = (url) => (url.endsWith('/prefs')
        ? jsonResponse(prefsBody())
        : jsonResponse({ label: 'Topic', id: 'p1' }));
    });

  await c.fire.alarm('sb-drain');
  await c.send({
    kind: REREAD_CANDIDATE,
    candidate: {
      passage: 'Session state is held per user.', url: 'https://docs.test/s',
      pageTitle: 'S', headingPath: [], returnCount: 3, dwellMs: 9000, reason: 'r',
    },
  });
  await settle();

  const paths = new Set<string>();
  for (const r of c.requests) {
    paths.add(new URL(r.url).pathname);
    assert.equal(r.headers[SHARED_SECRET_HEADER], SECRET, `${r.method} ${r.url} went without the secret`);
    assert.equal(r.headers[CLIENT_SCHEMA_HEADER], String(CLIENT_SCHEMA_VERSION),
      `${r.method} ${r.url} went without the extension compatibility receipt`);
  }
  assert.deepEqual([...paths].sort(), ['/pins', '/prefs', '/suggestions'],
    'all three of the worker’s routes were exercised, or this asserted less than it looks');
});

test('a worker with no secret configured sends no header at all, so the laptop is unchanged', async (t) => {
  // The local service on loopback requires nothing, and a header with an empty
  // value is not "no header" — it is a credential the service would have to
  // decide what to do with.
  const c = await wake(t);
  const boot = c.requests[0];
  assert.ok(boot, 'the worker refreshed prefs at boot');
  assert.equal(SHARED_SECRET_HEADER in boot.headers, false);
  assert.equal(boot.headers[CLIENT_SCHEMA_HEADER], String(CLIENT_SCHEMA_VERSION));
});

test('a secret that is only whitespace is not a secret', async (t) => {
  const c = await wake(t, { store: { [SHARED_SECRET_KEY]: '   ' } });
  assert.equal(SHARED_SECRET_HEADER in (c.requests[0]?.headers ?? {}), false);
});

test('the content type the pin path always sent is still sent alongside it', async (t) => {
  // The header is added to what the call site asked for rather than replacing
  // it. A POST that lost `content-type` is a 400 from `readBody`, and it would
  // have been introduced by the code that closed the door.
  const c = await wake(t, { store: { [SHARED_SECRET_KEY]: SECRET, sb_pending_pins: [{ type: 'interest' }] } },
    (stub) => {
      stub.fetchHandler = (url) => (url.endsWith('/prefs') ? jsonResponse(prefsBody()) : jsonResponse({ label: 'x' }));
    });
  await c.fire.alarm('sb-drain');
  await settle();

  const post = c.requests.find((r) => r.url.endsWith('/pins'));
  assert.equal(post?.headers['content-type'], 'application/json');
  assert.equal(post?.headers[SHARED_SECRET_HEADER], SECRET);
});

// ------------------------------------------------------------------- alarms

test('the prefs alarm refreshes and does not drain, and the drain alarm does not refetch prefs', async (t) => {
  const c = await wake(t, { store: { sb_pending_pins: [{ type: 'interest' }] } }, (stub) => {
    stub.fetchHandler = (url) => (url.endsWith('/pins') ? jsonResponse({ label: 'Topic' }) : jsonResponse(prefsBody()));
  });
  await c.fire.alarm('sb-prefs');
  await settle();
  assert.equal(c.requests.filter((r) => r.url.endsWith('/pins')).length, 0, 'the prefs branch returns early');

  await c.fire.alarm('sb-drain');
  await settle();
  assert.equal(c.requests.filter((r) => r.url.endsWith('/pins')).length, 1);
  assert.deepEqual(c.store['sb_pending_pins'], [], 'what the service took does not stay queued');
  assert.equal(prefsRequests(c).length, 2, 'boot and the prefs alarm — the drain adds none');
});

test('an alarm nobody named does nothing at all', async (t) => {
  const c = await wake(t, { store: { sb_pending_pins: [{ type: 'interest' }] } }, (stub) => {
    stub.fetchHandler = (url) => (url.endsWith('/pins') ? jsonResponse({ label: 'x' }) : jsonResponse(prefsBody()));
  });
  const boot = c.requests.length;
  for (const name of ['sb-something-else', 'sb-drain-later', 'sb-prefs-2', '', 'SB-DRAIN']) {
    await c.fire.alarm(name);
    await settle();
  }
  assert.equal(c.requests.filter((r) => r.url.endsWith('/pins')).length, 0, 'an unknown alarm drained the queue');
  assert.equal(c.requests.length, boot, 'an unknown alarm reached the network');
  assert.deepEqual(c.store['sb_pending_pins'], [{ type: 'interest' }], 'the queue is still there for the real drain');

  // And the alarm that is the drain still is one.
  await c.fire.alarm('sb-drain');
  await settle();
  assert.equal(c.requests.filter((r) => r.url.endsWith('/pins')).length, 1);
});

test('a drain with nothing queued does not touch the network', async (t) => {
  const c = await wake(t);
  const boot = c.requests.length;
  await c.fire.alarm('sb-drain');
  await settle();
  assert.equal(c.requests.length, boot);
});

test('a pin the service still refuses stays queued for the next alarm', async (t) => {
  const c = await wake(t, { store: { sb_pending_pins: [{ type: 'interest', n: 1 }, { type: 'interest', n: 2 }] } },
    (stub) => {
      stub.fetchHandler = (url, init) => {
        if (!url.endsWith('/pins')) return jsonResponse(prefsBody());
        const body = JSON.parse(String(init?.body)) as { n: number };
        return jsonResponse(body.n === 1 ? { label: 'took it' } : {}, body.n === 1 ? 200 : 500);
      };
    });
  await c.fire.alarm('sb-drain');
  await settle();
  assert.deepEqual(c.store['sb_pending_pins'], [{ type: 'interest', n: 2 }]);
});

test('the popup can retry one exact waiting capture through the worker', async (t) => {
  const waiting = [
    { clientRef: 'a', type: 'interest', envelope: { selection: 'first' } },
    { clientRef: 'b', type: 'interest', envelope: { selection: 'second' } },
  ];
  const c = await wake(t, { store: { sb_pending_pins: waiting } }, (stub) => {
    stub.fetchHandler = (url, init) => {
      if (!url.endsWith('/pins')) return jsonResponse(prefsBody());
      const body = JSON.parse(String(init?.body)) as { clientRef: string };
      return body.clientRef === 'b' ? jsonResponse({ label: 'Second', id: 'pin-b' }) : jsonResponse({}, 500);
    };
  });
  assert.deepEqual(await c.send({ kind: QUEUE_RETRY, clientRef: 'b' }), { state: 'sent' });
  assert.deepEqual(c.store['sb_pending_pins'], [waiting[0]]);
  const posts = c.requests.filter((r) => r.url.endsWith('/pins'));
  assert.equal(posts.length, 1);
  assert.equal((posts[0]?.body as { clientRef: string }).clientRef, 'b');
});

test('the popup can remove one exact unsent capture, with malformed messages refused', async (t) => {
  const waiting = [{ clientRef: 'a' }, { clientRef: 'b' }];
  const c = await wake(t, { store: { sb_pending_pins: waiting } });
  assert.deepEqual(await c.send({ kind: QUEUE_REMOVE, clientRef: 'a' }), { removed: true });
  assert.deepEqual(c.store['sb_pending_pins'], [waiting[1]]);
  assert.deepEqual(await c.send({ kind: QUEUE_REMOVE, clientRef: 'missing' }), { removed: false });
  await assert.rejects(c.send({ kind: QUEUE_REMOVE, clientRef: '' }), /Receiving end does not exist/);
  await assert.rejects(c.send({ kind: QUEUE_RETRY, clientRef: 7 }), /Receiving end does not exist/);
});

test('automatic and manual retry cannot send another learner’s waiting pin', async (t) => {
  const body = { clientRef: 'owned-by-a', type: 'interest', envelope: { selection: 'private capture' } };
  const record = queuedPin(body, 'uid-a', '2026-08-26T08:30:00.000Z');
  const c = await wake(t, { store: {
    sb_auth_config: { apiKey: 'public-key', projectId: 'project' },
    sb_session: {
      idToken: 'token-b', refreshToken: 'refresh-b', expiresAt: Date.now() + 3_600_000,
      uid: 'uid-b', email: 'b@example.test',
    },
    sb_pending_pins: [record],
  } }, (stub) => {
    stub.fetchHandler = (url) => url.endsWith('/pins')
      ? jsonResponse({ label: 'should not land', id: 'wrong-board' })
      : jsonResponse(prefsBody());
  });
  await c.fire.alarm('sb-drain');
  assert.deepEqual(await c.send({ kind: QUEUE_RETRY, clientRef: 'owned-by-a' }), { state: 'missing' });
  assert.equal(c.requests.filter((r) => r.url.endsWith('/pins')).length, 0);
  assert.deepEqual(c.store['sb_pending_pins'], [record]);
});

test('online Undo deletes the exact local pin through the existing cascade route', async (t) => {
  const c = await wake(t, {}, (stub) => {
    stub.fetchHandler = (url, init) => url.endsWith('/pins/p-42?keepTopic=true') && init?.method === 'DELETE'
      ? jsonResponse({ ok: true })
      : jsonResponse(prefsBody());
  });
  assert.deepEqual(await c.send({ kind: PIN_UNDO, pinId: 'p-42', ownerUid: null }), { ok: true });
  const deletion = c.requests.find((request) => request.url.endsWith('/pins/p-42?keepTopic=true'));
  assert.equal(deletion?.method, 'DELETE');
});

test('online Undo cannot delete through a different learner identity', async (t) => {
  const c = await wake(t, { store: {
    sb_auth_config: { apiKey: 'public-key', projectId: 'project' },
    sb_session: {
      idToken: 'token-b', refreshToken: 'refresh-b', expiresAt: Date.now() + 3_600_000,
      uid: 'uid-b', email: 'b@example.test',
    },
  } });
  assert.deepEqual(await c.send({ kind: PIN_UNDO, pinId: 'p-42', ownerUid: 'uid-a' }), { ok: false });
  assert.equal(c.requests.filter((request) => request.url.endsWith('/pins/p-42')).length, 0);
});

/**
 * , the half that had never been run: the tap opening the panel.
 *
 * `learn-now.ts` calls the open "best-effort", and the worker's comment says
 * Chrome does not document a gesture surviving the trip from a page's click
 * handler through `runtime.sendMessage`. Both were true; neither was the
 * reason it never worked. The gesture does arrive — what spent it was the
 * worker's own `await` on the storage write before asking. Chrome ends a
 * gesture when control returns to the event loop, so an open asked for after
 * an await is refused every time, and the `.catch(() => {})` around it made
 * the refusal silent. A learner tapped the clause and nothing happened at all.
 *
 * Found by using the product (2026-08-22), not by the suite, because the stub
 * had no notion of a gesture and answered every open the same way.
 *
 * The order these two happen in is the whole fix, and it is load-bearing in
 * both directions: the write must be *dispatched* first, so a panel that opens
 * immediately finds the hand-off already there, and the open must be *called*
 * synchronously, before anything is awaited, or there is no gesture left to
 * spend. Dispatched, not awaited — an `await` between them puts the bug back.
 */
test('the tap opens the panel while the gesture is still alive, and the hand-off is written first', async (t) => {
  const c = await wake(t, { gestureBound: true });
  const reply = await c.send(
    { kind: 'sb-learn-now', pinId: 'p-99', label: 'Neural Network Architectures' },
    { tab: { id: 7, windowId: 3 } },
  );
  await settle();

  assert.equal(c.panelOpens.length, 1, 'the tap never asked for the panel');
  assert.deepEqual(c.panelOpens[0], { windowId: 3, gesture: true },
    'the open was asked for after the gesture was spent — Chrome refuses this, silently');
  const stored = c.store['sb_quick_take'] as { pinId: string; label: string; intent: string };
  assert.equal(stored?.pinId, 'p-99', 'the durable half of the hand-off did not survive');
  assert.equal(stored?.label, 'Neural Network Architectures');
  assert.equal(stored?.intent, 'take', 'the toast offers a take, never a guide');
  assert.deepEqual(reply, { ok: true, opened: true }, 'the page was not told what happened');
});

test('a tap Chrome will not open the panel for still leaves the hand-off, and says so', async (t) => {
  // No `tab` on the sender: a message with no window to open one in. The
  // durable half must be untouched by it — the learner opens the panel
  // themselves and lands on the take, which is the whole point of writing it
  // down rather than passing it as an argument.
  const c = await wake(t, { gestureBound: true, sidePanelFails: true });
  const reply = await c.send(
    { kind: 'sb-learn-now', pinId: 'p-100', label: 'Backpropagation' },
    { tab: { id: 7, windowId: 3 } },
  );
  await settle();

  const stored = c.store['sb_quick_take'] as { pinId: string; label: string } | undefined;
  assert.equal(stored?.pinId, 'p-100', 'a refused open took the hand-off down with it');
  assert.equal(stored?.label, 'Backpropagation');
  assert.deepEqual(reply, { ok: true, opened: false },
    'the page was told the panel opened when it did not');
});
