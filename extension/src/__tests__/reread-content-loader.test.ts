import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installChrome, freshImport, settle, jsonResponse, type ChromeStub } from './chrome-stub.js';
import { PREFS_KEY } from '../prefs.js';
import { RESCAN_THROTTLE_MS } from '../reread.js';

/**
 * The content script, loaded the way Chrome loads it, talking to the worker.
 *
 * Three files meet here and none of them had ever been executed together:
 * `reread-content.js` (the classic-script loader, which cannot be compiled and
 * so cannot even be type-checked), `reread.ts` (the DOM half of the detector),
 * and the worker's message listener. Everything between them was tested with
 * hand-written doubles on both sides — a fake `send` in `reread-bridge.test.ts`,
 * a fake message in nothing at all — so the two halves had never had to agree
 * about anything for real.
 *
 * The loader is run through `Function(source)` with `chrome` and `location` as
 * globals, which is exactly the shape it arrives in: a classic script, no module
 * scope, pulling the real `dist/` modules in through `chrome.runtime.getURL`.
 * The modules it imports are the shipped ones. What is faked is the page around
 * them — elements, the two observers, and the clock — because a re-read takes
 * half a minute of a learner's time and a test cannot wait for it.
 *
 * Still browser-only after this: that Chrome injects the script at all, that
 * `document_idle` is the right moment, that a real `IntersectionObserver` fires
 * with the ratios assumed here, and that the page's own CSP does not refuse the
 * import.
 */

const loaderSource = readFileSync(
  fileURLToPath(new URL('../../reread-content.js', import.meta.url)), 'utf8',
);

// ------------------------------------------------------------------ the page

interface Block {
  tagName: string;
  textContent: string;
  previousElementSibling: Block | null;
  parentElement: Block | null;
}

const block = (text: string, tagName = 'P'): Block =>
  ({ tagName, textContent: text, previousElementSibling: null, parentElement: null });

/** Long enough that the detector will watch it; the floor is 120 characters. */
const passage = (seed: string): Block => block(`${seed} `.repeat(40).trim());

interface FakeObserver {
  callback: (entries: unknown[]) => void;
  observed: unknown[];
  disconnected: boolean;
}

interface Page {
  observers: FakeObserver[];
  mutations: FakeObserver[];
  readonly queryCount: () => number;
  /** Move the fake clock, which is the only way a dwell of seconds is testable. */
  at(ms: number): void;
  hide(): void;
  restore(): void;
}

function installPage(blocks: Block[], origin = 'https://docs.test'): Page {
  const observers: FakeObserver[] = [];
  const mutations: FakeObserver[] = [];
  let clock = 1_700_000_000_000;
  let queries = 0;
  let pagehide: (() => void) | null = null;

  class FakeIntersectionObserver {
    constructor(callback: (entries: unknown[]) => void) {
      observers.push({ callback, observed: [], disconnected: false });
    }
    observe(el: unknown): void { observers[observers.length - 1]!.observed.push(el); }
    disconnect(): void { observers[observers.length - 1]!.disconnected = true; }
  }
  class FakeMutationObserver {
    constructor(callback: (entries: unknown[]) => void) {
      mutations.push({ callback, observed: [], disconnected: false });
    }
    observe(el: unknown): void { mutations[mutations.length - 1]!.observed.push(el); }
    disconnect(): void { mutations[mutations.length - 1]!.disconnected = true; }
  }

  const body = block('', 'BODY');
  const previous = {
    document: (globalThis as Record<string, unknown>)['document'],
    location: (globalThis as Record<string, unknown>)['location'],
    IntersectionObserver: (globalThis as Record<string, unknown>)['IntersectionObserver'],
    MutationObserver: (globalThis as Record<string, unknown>)['MutationObserver'],
    addEventListener: (globalThis as Record<string, unknown>)['addEventListener'],
    now: Date.now,
  };

  Object.assign(globalThis, {
    document: {
      title: 'ADK — Sessions',
      body,
      querySelectorAll: (selector: string) => {
        queries += 1;
        return selector === 'p, li, pre, blockquote' ? blocks : [];
      },
    },
    location: { origin, href: `${origin}/adk/sessions` },
    IntersectionObserver: FakeIntersectionObserver,
    MutationObserver: FakeMutationObserver,
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'pagehide') pagehide = listener;
    },
  });
  Date.now = () => clock;

  return {
    observers,
    mutations,
    queryCount: () => queries,
    at: (ms: number) => { clock = 1_700_000_000_000 + ms; },
    hide: () => { pagehide?.(); pagehide = null; },
    restore: () => { Object.assign(globalThis, previous); Date.now = previous.now; },
  };
}

/** Run the shipped loader as a classic script, the way an injected one runs. */
function runLoader(): void {
  Function(loaderSource)();
}

/** Give the loader's imports and its round trip to the worker time to land. */
async function loaded(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await settle(4);
}

const prefsBody = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ excludedDomains: [], rejectedOrigins: {}, pausedUntil: null, ...over });

/** A worker awake, holding the prefs the test cares about. */
async function worker(t: TestContext, prefs: Record<string, unknown> = {}): Promise<ChromeStub> {
  const c = installChrome();
  t.after(() => { c.uninstall(); });
  c.fetchHandler = (url) => (url.endsWith('/suggestions') ? jsonResponse({ id: 's1' }) : jsonResponse(prefsBody(prefs)));
  await freshImport('../background.js');
  await settle();
  return c;
}

/**
 * Read a passage, leave it, come back — four times, which is three returns.
 *
 * The numbers are the detector's own: a return only counts after 1.5s away, and
 * the dwell has to reach four seconds inside a ten-minute window.
 */
function reReadFourTimes(page: Page, target: Block): void {
  const io = page.observers[0]!;
  for (let visit = 0; visit < 4; visit += 1) {
    page.at(visit * 10_000);
    io.callback([{ target, isIntersecting: true, intersectionRatio: 0.9 }]);
    page.at(visit * 10_000 + 5_000);
    io.callback([{ target, isIntersecting: false, intersectionRatio: 0 }]);
  }
}

// ---------------------------------------------------------------- the happy path

test('the loader boots the detector, and a re-read reaches the service as a suggestion', async (t) => {
  const c = await worker(t);
  const target = passage('Session state is held per user.');
  const page = installPage([target, passage('Something else entirely.')]);
  t.after(() => { page.restore(); });

  runLoader();
  await loaded();

  assert.equal(page.observers.length, 1, 'the detector is watching');
  assert.equal(page.observers[0]?.observed.length, 2, 'both long passages, and nothing shorter');
  assert.equal(page.mutations.length, 1, 'and it keeps up with content added as you scroll');

  reReadFourTimes(page, target);
  await loaded();

  const suggestions = c.requests.filter((r) => r.url.endsWith('/suggestions'));
  assert.equal(suggestions.length, 1, 'one candidate, from the passage that was returned to');
  const body = suggestions[0]?.body as Record<string, unknown>;
  assert.match(String(body['passage']), /Session state is held per user\./);
  assert.equal(body['url'], 'https://docs.test/adk/sessions');
  assert.equal(body['pageTitle'], 'ADK — Sessions');
  assert.equal(body['reason'], 'You came back to this 3 times.');
});

test('a candidate is a suggestion and never a pin, and nothing is written anywhere (SB-15)', async (t) => {
  const c = await worker(t);
  const target = passage('Session state is held per user.');
  const page = installPage([target]);
  t.after(() => { page.restore(); });

  runLoader();
  await loaded();
  reReadFourTimes(page, target);
  await loaded();

  assert.equal(c.requests.filter((r) => r.url.endsWith('/pins')).length, 0, 'the detector cannot pin');
  assert.deepEqual(Object.keys(c.store), [PREFS_KEY], 'and it has no store of its own on this machine');
});

test('the same passage is raised once, however long the learner keeps at it', async (t) => {
  const c = await worker(t);
  const target = passage('Session state is held per user.');
  const page = installPage([target]);
  t.after(() => { page.restore(); });

  runLoader();
  await loaded();
  reReadFourTimes(page, target);
  await loaded();
  // Four more visits, well inside the window.
  const io = page.observers[0]!;
  for (let visit = 4; visit < 8; visit += 1) {
    page.at(visit * 10_000);
    io.callback([{ target, isIntersecting: true, intersectionRatio: 0.9 }]);
    page.at(visit * 10_000 + 5_000);
    io.callback([{ target, isIntersecting: false, intersectionRatio: 0 }]);
  }
  await loaded();
  assert.equal(c.requests.filter((r) => r.url.endsWith('/suggestions')).length, 1);
});

test('reading straight through raises nothing, which is most of what reading is', async (t) => {
  const c = await worker(t);
  const blocks = [passage('One.'), passage('Two.'), passage('Three.')];
  const page = installPage(blocks);
  t.after(() => { page.restore(); });

  runLoader();
  await loaded();
  const io = page.observers[0]!;
  blocks.forEach((target, i) => {
    page.at(i * 8_000);
    io.callback([{ target, isIntersecting: true, intersectionRatio: 0.9 }]);
    page.at(i * 8_000 + 7_000);
    io.callback([{ target, isIntersecting: false, intersectionRatio: 0 }]);
  });
  await loaded();
  assert.equal(c.requests.filter((r) => r.url.endsWith('/suggestions')).length, 0);
});

test('a dynamic page coalesces mutation bursts and observes each passage once', async (t) => {
  await worker(t);
  const first = passage('The first rendered explanation.');
  const blocks = [first];
  const page = installPage(blocks);
  t.after(() => { page.restore(); });

  runLoader();
  await loaded();
  const io = page.observers[0]!;
  const mutations = page.mutations[0]!;
  assert.deepEqual(io.observed, [first]);
  const afterBoot = page.queryCount();

  const later = passage('A lesson block rendered after scrolling.');
  blocks.push(later);
  for (let i = 0; i < 100; i += 1) mutations.callback([]);
  assert.equal(page.queryCount(), afterBoot, 'the mutation burst rescanned synchronously');
  await new Promise((resolve) => { setTimeout(resolve, RESCAN_THROTTLE_MS + 30); });

  assert.equal(page.queryCount(), afterBoot + 1, 'one mutation burst caused more than one document scan');
  assert.deepEqual(io.observed, [first, later], 'an existing passage was observed more than once');
});

test('pagehide tears down both observers and cancels pending scan work', async (t) => {
  await worker(t);
  const blocks = [passage('The first rendered explanation.')];
  const page = installPage(blocks);
  t.after(() => { page.restore(); });

  runLoader();
  await loaded();
  const io = page.observers[0]!;
  const mutations = page.mutations[0]!;
  const afterBoot = page.queryCount();

  blocks.push(passage('A lesson block rendered just before navigation.'));
  mutations.callback([]);
  page.hide();

  assert.equal(io.disconnected, true, 'the passage observer outlived its page');
  assert.equal(mutations.disconnected, true, 'the mutation observer outlived its page');
  await new Promise((resolve) => { setTimeout(resolve, RESCAN_THROTTLE_MS + 30); });
  assert.equal(page.queryCount(), afterBoot, 'a pending rescan ran after pagehide');
});

// ------------------------------------------------------- the reasons to stay off

test('a site the learner has turned down twice is not watched at all (SB-16)', async (t) => {
  const c = await worker(t, { rejectedOrigins: { 'https://docs.test': 2 } });
  const target = passage('Session state is held per user.');
  const page = installPage([target]);
  t.after(() => { page.restore(); });

  runLoader();
  await loaded();

  assert.deepEqual(page.observers, [], 'quieted means nothing is observed, not that output is filtered later');
  assert.deepEqual(page.mutations, []);
  assert.equal(c.requests.filter((r) => r.url.endsWith('/suggestions')).length, 0);
});

test('an off-limits site is not watched, and neither is a paused learner (SB-40/41)', async (t) => {
  for (const prefs of [
    { excludedDomains: ['docs.test'] },
    { pausedUntil: new Date(Date.now() + 3_600_000).toISOString() },
  ]) {
    const c = await worker(t, prefs);
    const page = installPage([passage('Session state is held per user.')]);
    runLoader();
    await loaded();
    assert.deepEqual(page.observers, [], `${JSON.stringify(prefs)} should have kept the detector off`);
    page.restore();
    c.uninstall();
  }
});

test('a worker that never answers leaves the detector silent, not loud', async (t) => {
  // No worker at all: `chrome.runtime.sendMessage` rejects the way it does when
  // MV3 has killed the service worker and it has not woken yet. The detector
  // cannot know whether this site is off limits, so it does not watch it.
  const c = installChrome();
  t.after(() => { c.uninstall(); });
  const page = installPage([passage('Session state is held per user.')]);
  t.after(() => { page.restore(); });

  runLoader();
  await loaded();
  assert.deepEqual(page.observers, []);
});

test('a page whose modules will not import gets no detector and no error', async (t) => {
  const c = installChrome({ baseUrl: 'file:///nowhere/at/all/' });
  t.after(() => { c.uninstall(); });
  const page = installPage([passage('Session state is held per user.')]);
  t.after(() => { page.restore(); });

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => { process.off('unhandledRejection', onUnhandled); });

  assert.doesNotThrow(() => { runLoader(); });
  await loaded();
  assert.deepEqual(unhandled, [], 'a background nicety must never be why a page looks broken');
  assert.deepEqual(page.observers, []);
});

test('the suggestion the service refuses is dropped where it was raised', async (t) => {
  const c = await worker(t);
  c.fetchHandler = (url) => (url.endsWith('/suggestions') ? jsonResponse({}, 503) : jsonResponse(prefsBody()));
  const target = passage('Session state is held per user.');
  const page = installPage([target]);
  t.after(() => { page.restore(); });

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => { process.off('unhandledRejection', onUnhandled); });

  runLoader();
  await loaded();
  reReadFourTimes(page, target);
  await loaded();

  assert.equal(c.requests.filter((r) => r.url.endsWith('/suggestions')).length, 1);
  assert.deepEqual(unhandled, [], 'the page is not told, and is not broken either');
});
