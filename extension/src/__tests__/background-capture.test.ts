import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  installChrome, freshImport, settle, jsonResponse, tab,
  type ChromeStub, type ChromeStubOptions, type Injection,
} from './chrome-stub.js';
import { capture, type CapturedEnvelope } from '../capture.js';
import { showToast } from '../toast.js';
import { QUEUE_KEY, queuedPinBody } from '../queue.js';
import { HANDOFF_KEY, HANDOFF_STARTED, LEARN_NOW, pendingTake } from '../learn-now.js';
import { LEARN_NOW_LABEL } from '../pin-body.js';
import { COMPOSE_SAVE } from '../pin-box.js';
import { THEME_KEY } from '../theme.js';
import { PIN_UNDO } from '../toast.js';
import { SELECT_SAVE, SELECT_STATUS } from '../selector.js';
import { OPEN_SELECTOR_ON_PAGE } from '../pin-modes.js';
import {
  CAPTURE_SESSION_ADDED, CAPTURE_SESSION_KEY, CAPTURE_SESSION_REMOVED,
  type CaptureSessionPin,
} from '../capture-session.js';

/**
 * The capture path, from the gesture to the queue.
 *
 * Every piece of this has been tested on its own — what capture collects, what
 * the toast says, how the queue behaves under an interrupted drain. What had
 * never been exercised is the sequence: inject, show, post, queue, finish. That
 * sequence is where a pin is lost, and losing a pin is the one failure
 * says the product must not have.
 *
 * The injected functions are compared by identity here rather than by what they
 * do. `capture-envelope.test.ts` already runs `capture` across a faithful
 * imitation of the `executeScript` boundary; what this file adds is that the
 * worker hands Chrome *that* function, at the right moment, for the right tab.
 */

const SERVICE = 'http://127.0.0.1:8791';

const envelope: CapturedEnvelope = {
  selection: 'Session state is held per user.',
  parts: [{ role: 'passage', text: 'Session state is held per user. It persists between turns.' }],
  surroundingText: 'Session state is held per user. It persists between turns.',
  headingPath: ['ADK', 'Sessions'],
  pageTitle: 'ADK — Sessions',
  url: 'https://example.test/adk/sessions',
  canonicalUrl: null,
  siteName: 'Example Docs',
  contentLanguage: 'en',
  videoMoment: null,
  documentKind: 'html',
  pdfPage: null,
};

const prefsBody = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ excludedDomains: [], rejectedOrigins: {}, pausedUntil: null, ...over });

async function wake(
  t: TestContext, options: ChromeStubOptions = {}, before: (c: ChromeStub) => void = () => {},
): Promise<ChromeStub> {
  const c = installChrome(options);
  t.after(() => { c.uninstall(); });
  c.injectResult = (injection: Injection) => (injection.func === capture ? envelope : undefined);
  before(c);
  await freshImport('../background.js');
  await settle();
  return c;
}

/** The service takes pins and answers with a topic label. */
const serviceIsUp = (c: ChromeStub): void => {
  c.fetchHandler = (url) => (url.endsWith('/pins') ? jsonResponse({ label: 'ADK session state' }) : jsonResponse(prefsBody()));
};
/** Nothing is listening on the loopback port at all. */
const serviceIsDown = (c: ChromeStub): void => {
  c.fetchHandler = (url) => {
    if (url.endsWith('/pins')) throw new TypeError('fetch failed');
    return jsonResponse(prefsBody());
  };
};

const pins = (c: ChromeStub): unknown[] => c.requests.filter((r) => r.url.endsWith('/pins')).map((r) => r.body);
const queuedBodies = (c: ChromeStub): unknown[] =>
  ((c.store[QUEUE_KEY] as unknown[] | undefined) ?? []).map(queuedPinBody);
/**
 * The toast texts, in order.
 *
 * Not every injection with arguments is a toast any more: Standard reaches the
 * page by injecting a stub that imports `dist/pin-box.js`, and its first
 * argument is that module's url. A helper that counted it would report a
 * confirmation for a pin nobody has made yet, which is the exact claim several
 * tests here rest on.
 */
const toastTexts = (c: ChromeStub): string[] =>
  c.injections
    .filter((i) => i.func !== capture && i.args.length > 0 && !/\.js$/.test(String(i.args[0])))
    .map((i) => String(i.args[0]));

// ------------------------------------------------------------- the happy path

test('Alt+P injects the shipped capture, shows the toast, posts the pin and finishes the toast', async (t) => {
  const c = await wake(t, {}, serviceIsUp);
  await c.fire.command('pin-interest', tab());
  await settle();

  assert.equal(c.injections.length, 3, 'capture, toast, finish — in that order and no more');
  assert.equal(c.injections[0]?.func, capture, 'the function Chrome runs is the one the tests exercise');
  assert.equal(c.injections[1]?.func, showToast);
  assert.deepEqual(c.injections.map((i) => i.tabId), [7, 7, 7], 'all three land in the tab the gesture came from');

  assert.deepEqual(toastTexts(c), ['Pinned, working it out…', 'Pinned: ADK session state']);
  assert.equal(pins(c).length, 1);
  const body = pins(c)[0] as { type: string; envelope: Record<string, unknown>; capturedAt: string };
  assert.equal(body.type, 'interest');
  assert.equal(body.envelope['selection'], envelope.selection);
  assert.deepEqual(body.envelope['parts'], envelope.parts);
  assert.equal('media' in body.envelope, false,
    'browser capture is text-only and does not manufacture a media field');
  assert.ok(!Number.isNaN(Date.parse(body.capturedAt)), 'captured at a time the service can read');
  assert.deepEqual(c.store[QUEUE_KEY], undefined, 'a pin the service took is never queued');
});

test('an offline pin offers queue recovery and never a service Undo', async (t) => {
  const c = await wake(t, {}, serviceIsDown);
  await c.fire.command('pin-interest', tab());
  await settle();
  assert.equal(c.injections.at(-1)?.args[3], null);
  assert.equal(c.runtimeMessages.some((message) => (message as { kind?: string }).kind === PIN_UNDO), false);
});

test('the struggle key is a different pin and a different sentence ()', async (t) => {
  const c = await wake(t, {}, serviceIsUp);
  await c.fire.command('pin-struggle', tab());
  await settle();
  assert.equal((pins(c)[0] as { type: string }).type, 'struggle');
  assert.deepEqual(toastTexts(c), [
    'Noted, working it out…',
    'Noted: ADK session state. I’ll start from the bottom on this one.',
  ]);
});

test('capture happens with the panel shut, and does not open it ()', async (t) => {
  const c = await wake(t, {}, serviceIsUp);
  await c.fire.command('pin-interest', tab());
  await settle();
  assert.equal(pins(c).length, 1);
  assert.deepEqual(c.panelBehaviour, [], 'the panel is for consumption; capture never reaches for it');
});

test('a command the extension does not declare does nothing at all', async (t) => {
  const c = await wake(t, {}, serviceIsUp);
  await c.fire.command('pin-everything', tab());
  await settle();
  assert.deepEqual(c.injections, []);
  assert.deepEqual(pins(c), []);
});

// -------------------------------------------------------------- context menus

test('the direct pin menu stores selected text as an interest', async (t) => {
  const c = await wake(t, {}, serviceIsUp);
  await c.fire.menuClick({ menuItemId: 'mode-flash' }, tab());
  await settle();
  assert.equal((pins(c)[0] as { type: string }).type, 'interest',
    'Flash is always an interest pin: a mode whose claim is one gesture cannot also ask a question');
});

test('a menu item from some other extension is not ours to act on', async (t) => {
  const c = await wake(t, {}, serviceIsUp);
  await c.fire.menuClick({ menuItemId: 'translate-selection' }, tab());
  await settle();
  assert.deepEqual(c.injections, []);
});

// --------------------------------------------- the toolbar, retired with reasons


// ------------------------------------------------------- what is never captured

test('a tab we cannot identify is never captured from', async (t) => {
  const c = await wake(t, {}, serviceIsUp);
  for (const t2 of [undefined, tab({ id: undefined }), tab({ url: undefined }), tab({ url: '' })]) {
    await c.fire.command('pin-interest', t2);
  }
  await settle();
  assert.deepEqual(c.injections, [], 'no url is not a policy, it is a pin nobody could attribute');
  assert.deepEqual(pins(c), []);
});

test('a deliberate pin on an off-limits, paused site still lands ( the learner-confirmation contract)', async (t) => {
  const c = await wake(t, {}, (stub) => {
    stub.fetchHandler = (url) => (url.endsWith('/pins')
      ? jsonResponse({ label: 'Statements' })
      : jsonResponse(prefsBody({
        excludedDomains: ['bank.test'],
        pausedUntil: new Date(Date.now() + 3_600_000).toISOString(),
      })));
  });
  await c.fire.command('pin-interest', tab({ url: 'https://secure.bank.test/statements' }));
  await settle();
  assert.equal(pins(c).length, 1, 'the list says do not watch me here; pressing the key is not being watched');
});

test('a page that returns no envelope is not pinned, and is not toasted either', async (t) => {
  const c = await wake(t, {}, serviceIsUp);
  c.injectResult = () => undefined; // an injection that ran but produced nothing
  await c.fire.command('pin-interest', tab());
  await settle();
  assert.equal(c.injections.length, 1, 'nothing to say and nothing to send');
  assert.deepEqual(pins(c), []);
});

// ------------------------------------------------------------- the offline path

test('a pin the service cannot take is queued, and the toast promises rather than fails ()', async (t) => {
  const c = await wake(t, {}, serviceIsDown);
  await c.fire.command('pin-interest', tab());
  await settle();
  const queued = queuedBodies(c) as { type: string }[];
  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.type, 'interest');
  assert.deepEqual(toastTexts(c), ['Pinned, working it out…', 'Pinned. I’ll sort it once I’m back online']);
});

test('a service that answers 500 is the same as a service that is not there', async (t) => {
  const c = await wake(t, {}, (stub) => {
    stub.fetchHandler = (url) => (url.endsWith('/pins') ? jsonResponse({}, 500) : jsonResponse(prefsBody()));
  });
  await c.fire.command('pin-interest', tab());
  await settle();
  assert.equal((c.store[QUEUE_KEY] as unknown[] | undefined)?.length, 1);
});

test('pins queue in the order they were made while the service is away', async (t) => {
  const c = await wake(t, {}, serviceIsDown);
  await c.fire.command('pin-interest', tab());
  await settle();
  await c.fire.command('pin-struggle', tab());
  await settle();
  assert.deepEqual((queuedBodies(c) as { type: string }[]).map((p) => p.type), ['interest', 'struggle']);
});

test('the queue empties on the next drain, with the envelope intact', async (t) => {
  const c = await wake(t, {}, serviceIsDown);
  await c.fire.command('pin-interest', tab());
  await settle();
  serviceIsUp(c);
  await c.fire.alarm('sb-drain');
  await settle();
  assert.deepEqual(c.store[QUEUE_KEY], []);
  const drained = pins(c).at(-1) as { envelope: Record<string, unknown> };
  assert.equal(drained.envelope['selection'], envelope.selection);
  assert.deepEqual(drained.envelope['headingPath'], envelope.headingPath);
});

test('a success with no label is neither queued again nor called offline', async (t) => {
  const c = await wake(t, {}, (stub) => {
    stub.fetchHandler = (url) => (url.endsWith('/pins') ? jsonResponse({}) : jsonResponse(prefsBody()));
  });
  await c.fire.command('pin-interest', tab());
  await settle();
  assert.equal(c.store[QUEUE_KEY], undefined, 'the pin was taken, so nothing is waiting');
  assert.equal(toastTexts(c)[1], 'Pinned', 'a pin that arrived was reported as waiting to sync');
});

// -------------------------------------------------- pages that refuse injection

test('a page that refuses the toast still gets its pin sent', async (t) => {
  // The toast is feedback. Chrome refuses `executeScript` on a tab that
  // navigated, closed, or is a page extensions may not touch, and when the
  // *second* injection was the one that failed the pin was already captured —
  // and was thrown away with the rejection, never posted and never queued.
  const c = await wake(t, {}, serviceIsUp);
  c.injectResult = (injection: Injection) => {
    if (injection.func === showToast) throw new Error('Cannot access contents of the page');
    return injection.func === capture ? envelope : undefined;
  };
  await c.fire.command('pin-interest', tab());
  await settle();
  assert.equal(pins(c).length, 1, 'a pin is not lost because its confirmation could not be drawn');
});

test('a page that refuses capture is a shrug, not an unhandled rejection in the worker', async (t) => {
  const c = await wake(t, {}, serviceIsUp);
  c.injectResult = () => { throw new Error('Cannot access contents of the page'); };
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => { process.off('unhandledRejection', onUnhandled); });

  await c.fire.command('pin-interest', tab());
  await settle();
  await settle();
  assert.deepEqual(unhandled, [], 'the listener returns void, so anything thrown past it has nowhere to go');
  assert.deepEqual(pins(c), []);
});

// ------------------------------------------------------------------ the timer

test('a failed post does not leave its abort timer running behind the worker', async (t) => {
  // The 2.5s abort is a toast budget: it exists so the confirmation is not still
  // saying "working it out…" a minute later. On the failure path it was never
  // cleared, so every offline pin left a timer holding an MV3 worker awake that
  // Chrome would otherwise have suspended — and left this suite waiting for it.
  const c = await wake(t, {}, serviceIsDown);
  await c.fire.command('pin-interest', tab());
  await settle();
  const pending = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  assert.equal(pending, 0, 'the abort timer outlived the request it was guarding');
});

test('the post carries the content type the service parses, and goes to the pins endpoint', async (t) => {
  const c = await wake(t, {}, serviceIsUp);
  await c.fire.command('pin-interest', tab());
  await settle();
  const request = c.requests.find((r) => r.url.endsWith('/pins'));
  assert.equal(request?.url, `${SERVICE}/pins`);
  assert.equal(request?.method, 'POST');
  assert.equal(request?.headers['content-type'], 'application/json');
});

// ------------------------------------------------- , the PDF that refuses

/** What Chrome's own PDF viewer gives a content script: identity, no material. */
const closedPdf: CapturedEnvelope = {
  ...envelope,
  documentKind: 'pdf',
  selection: null,
  parts: [],
  surroundingText: '',
  headingPath: [],
  pageTitle: 'attention-is-all-you-need.pdf',
  url: 'https://example.test/papers/attention.pdf',
};

test('a PDF nothing can read is refused out loud, and not stored as an empty pin', async (t) => {
  const c = await wake(t, {}, serviceIsUp);
  c.injectResult = (injection: Injection) => (injection.func === capture ? closedPdf : undefined);
  await c.fire.command('pin-interest', tab({ url: 'https://example.test/papers/attention.pdf' }));
  await settle();

  assert.deepEqual(pins(c), [], 'a pin with a title and no material is a pin that produces nothing overnight');
  assert.equal(c.store[QUEUE_KEY], undefined, 'and it is not queued to produce nothing later either');
  assert.deepEqual(toastTexts(c), ['Can’t pin this PDF. Chrome won’t let me read it.'],
    'one toast, and it is the refusal — never the promise followed by silence');
});

test('a PDF whose viewer does hand over the passage is pinned, page number and all', async (t) => {
  const c = await wake(t, {}, serviceIsUp);
  c.injectResult = (injection: Injection) => (injection.func === capture
    ? { ...closedPdf, selection: 'Attention weights are computed', surroundingText: 'over the whole sequence at once', pdfPage: 3 }
    : undefined);
  await c.fire.command('pin-interest', tab());
  await settle();

  const body = pins(c)[0] as { envelope: Record<string, unknown> };
  assert.equal(body.envelope['selection'], 'Attention weights are computed');
  assert.equal(body.envelope['pdfPage'], 3);
  assert.equal(body.envelope['pageTitle'], 'attention-is-all-you-need.pdf', 'the document identity travels with it');
  assert.deepEqual(toastTexts(c), ['Pinned, working it out…', 'Pinned: ADK session state']);
});

// ------------------------------------------- the escalation on the toast

/** The service takes pins, names them, and says which id it filed them under —
 *  which is the third thing the toast needs before it can offer a take. */
const serviceNamesTheId = (c: ChromeStub): void => {
  c.fetchHandler = (url) => (url.endsWith('/pins')
    ? jsonResponse({ id: 'p-42', label: 'ADK session state' })
    : jsonResponse(prefsBody()));
};

test('an ordinary online receipt can undo the exact service pin', async (t) => {
  const c = await wake(t, {}, serviceNamesTheId);
  await c.fire.command('pin-interest', tab());
  await settle();
  assert.deepEqual(c.injections.at(-1)?.args[3], {
    label: 'Undo', pinId: 'p-42', ownerUid: null,
  });

  const reply = await c.send({ kind: PIN_UNDO, pinId: 'p-42', ownerUid: null });
  await settle();
  assert.deepEqual(reply, { ok: true });
  assert.deepEqual(c.sessionStore[CAPTURE_SESSION_KEY], [],
    'undo removed the pin but left its dead session shortcut');
  assert.ok(c.runtimeMessages.some((message) =>
    (message as { kind?: string }).kind === CAPTURE_SESSION_REMOVED));
});

/** What the second injection carried beside the toast text. */
const offer = (c: ChromeStub): unknown =>
  c.injections.filter((i) => i.args.length > 1).map((i) => i.args[1]).at(-1);

test('a pin the service filed is offered a take, on the toast, after capture', async (t) => {
  const c = await wake(t, {}, serviceNamesTheId);
  await c.fire.command('pin-interest', tab());
  await settle();

  // Capture is untouched: same three injections, same copy, same order. §2 is
  // explicit that nothing in this spec may add a decision to the capture
  // moment, and the offer rides the confirmation that was already there.
  assert.equal(c.injections.length, 3);
  assert.deepEqual(toastTexts(c), ['Pinned, working it out…', 'Pinned: ADK session state']);
  // `pinLabel` is the label the learner is already reading on this same toast.
  // It rides along so the quick-take screen has a heading while the take is
  // being written; without it the panel opened on an empty one.
  assert.deepEqual(offer(c), { label: LEARN_NOW_LABEL, pinId: 'p-42', pinLabel: 'ADK session state' });
});

test('an offline pin is promised, never offered a take it cannot have', async (t) => {
  //  keeps capture off the network; the take is a live call and cannot
  // follow it into the queue. The learner is told the pin is safe, which is
  // what they need to know, and is not offered something that would fail.
  const c = await wake(t, {}, serviceIsDown);
  await c.fire.command('pin-interest', tab());
  await settle();

  assert.equal((c.store[QUEUE_KEY] as unknown[] | undefined)?.length, 1);
  assert.equal(offer(c), null);
});

test('a pin the service took but did not name an id for is not offered a take', async (t) => {
  const c = await wake(t, {}, (stub) => {
    stub.fetchHandler = (url) => (url.endsWith('/pins')
      ? jsonResponse({ label: 'ADK session state' })
      : jsonResponse(prefsBody()));
  });
  await c.fire.command('pin-interest', tab());
  await settle();

  assert.equal(pins(c).length, 1, 'the pin landed');
  assert.equal(c.store[QUEUE_KEY], undefined, 'and it is not resent');
  assert.equal(offer(c), null, 'but there is no address to ask for a take at');
});

test('the learner-action contract: the take is offered on a paused, off-limits site like the pin is', async (t) => {
  // The exemption, one step further in. A pause governs what is watched; this
  // is a second button on a pin the learner made by hand, and the Scout's
  // label — a model call — has always run on that path paused or not.
  const c = await wake(t, {}, (stub) => {
    stub.fetchHandler = (url) => (url.endsWith('/pins')
      ? jsonResponse({ id: 'p-42', label: 'Statements' })
      : jsonResponse(prefsBody({
        excludedDomains: ['bank.test'],
        pausedUntil: new Date(Date.now() + 3_600_000).toISOString(),
      })));
  });
  await c.fire.command('pin-interest', tab({ url: 'https://secure.bank.test/statements' }));
  await settle();

  assert.deepEqual(offer(c), { label: LEARN_NOW_LABEL, pinId: 'p-42', pinLabel: 'Statements' });
});

test('the tap writes the hand-off first and asks for the panel second', async (t) => {
  // This test is older than the fix and its name was always right about the
  // order — what it could not see was that "second" had become "too late".
  // `gestureBound` is what makes it able to tell the difference; without it
  // this assertion passed for the whole of the time the panel never opened.
  const c = await wake(t, { gestureBound: true }, serviceNamesTheId);
  const reply = await c.send({ kind: LEARN_NOW, pinId: 'p-42', label: 'ADK session state' },
    { tab: { windowId: 3 } });
  await settle();

  assert.deepEqual(reply, { ok: true, opened: true });
  const waiting = pendingTake(c.store[HANDOFF_KEY], Date.now());
  assert.equal(waiting?.pinId, 'p-42');
  assert.equal(waiting?.label, 'ADK session state');
  assert.deepEqual(c.panelOpens, [{ windowId: 3, gesture: true }]);
  assert.deepEqual(c.runtimeMessages.find((message) =>
    (message as { kind?: string }).kind === HANDOFF_STARTED), {
    kind: HANDOFF_STARTED,
    handoff: waiting,
  }, 'an already-open panel was never told to leave its current screen');
});

test('a panel Chrome will not open leaves the take waiting rather than lost', async (t) => {
  // The open is still the half allowed to fail — a build without the API, a
  // message with no window behind it. Where it does, the learner gets their
  // take the moment they open the panel themselves, and the reply says so
  // rather than claiming a panel that is not there.
  const c = await wake(t, { sidePanelFails: true }, serviceNamesTheId);
  const reply = await c.send({ kind: LEARN_NOW, pinId: 'p-42', label: null }, { tab: { windowId: 3 } });
  await settle();

  assert.deepEqual(reply, { ok: true, opened: false });
  assert.equal(pendingTake(c.store[HANDOFF_KEY], Date.now())?.pinId, 'p-42');
});

test('a tap with no pin behind it is not this worker\'s message', async (t) => {
  const c = await wake(t, {}, serviceNamesTheId);
  for (const message of [{ kind: LEARN_NOW }, { kind: LEARN_NOW, pinId: '' }, { kind: LEARN_NOW, pinId: 7 }]) {
    await assert.rejects(() => c.send(message, { tab: { windowId: 3 } }), /Receiving end does not exist/);
  }
  await settle();
  assert.equal(c.store[HANDOFF_KEY], undefined, 'and nothing is written for the panel to act on');
});


test('the struggle signal is still reachable while Standard is being built', async (t) => {
  const c = await wake(t, {}, serviceIsUp);
  await c.fire.command('pin-struggle', tab());
  await settle();
  assert.equal((pins(c)[0] as { type: string }).type, 'struggle');
});

// ------------------------- the Learn it now mode, and its two-part hand-off

/**
 * `mode-learn-now`, which has an ordering problem the toast route does not.
 *
 * The panel can only be opened while the click that authorised it is still a
 * gesture, and the pin id does not exist until the page has been captured and
 * the service has answered. Both cannot be had. So the panel opens first, on a
 * hand-off with no pin in it, and the id is written into the same record when
 * it lands. The panel is waiting for exactly that.
 */
test('the menu route opens the panel first and fills the pin in after', async (t) => {
  const c = await wake(t, { gestureBound: true }, serviceNamesTheId);

  await c.fire.menuClick({ menuItemId: 'mode-learn-now' }, tab());

  // Before anything is awaited: the panel is open and the hand-off says a pin
  // is coming. Asserted here, mid-flight, because "eventually correct" is not
  // the claim — the gesture is spent by the next turn of the event loop.
  assert.deepEqual(c.panelOpens, [{ windowId: 3, gesture: true }],
    'the panel was asked for after the gesture was spent, which Chrome refuses');
  const waiting = c.store[HANDOFF_KEY] as { pinId: string | null } | undefined;
  assert.equal(waiting?.pinId, null, 'the panel has nothing to open onto');

  await settle();
  const started = c.runtimeMessages.find((message) =>
    (message as { kind?: string }).kind === HANDOFF_STARTED) as {
    kind?: string; handoff?: { pinId?: string | null; intent?: string };
  } | undefined;
  assert.deepEqual(started, {
    kind: HANDOFF_STARTED,
    handoff: { pinId: null, label: null, at: (started?.handoff as { at?: number })?.at,
      intent: 'take', failure: null },
  }, 'the menu route opened Chrome but did not redirect a panel that was already alive');

  const filled = pendingTake(c.store[HANDOFF_KEY], Date.now());
  assert.equal(filled?.pinId, 'p-42', 'the id never reached the record the panel is watching');
  assert.equal(filled?.label, 'ADK session state');
  assert.equal(c.requests.filter((r) => r.url.endsWith('/pins')).length, 1, 'and it pinned, once');
});

test('the menu route does not also raise a toast offering the same take', async (t) => {
  // The panel is already open on it. A toast underneath saying "Learn it now?"
  // is the same offer twice, and tapping it would be a second route into a
  // screen the learner is looking at.
  const c = await wake(t, { gestureBound: true }, serviceNamesTheId);
  await c.fire.menuClick({ menuItemId: 'mode-learn-now' }, tab());
  await settle();
  assert.deepEqual(toastTexts(c), [], 'the mode that opens the panel also raised a toast');
  assert.equal((c.sessionStore[CAPTURE_SESSION_KEY] as CaptureSessionPin[])[0]?.pinId, 'p-42',
    'the explicit lesson route disappeared from the session list');
  assert.equal(c.runtimeMessages.some((message) =>
    (message as { kind?: string }).kind === CAPTURE_SESSION_ADDED), false,
    'the session shortcut replaced the lesson the learner explicitly opened');

  // And Flash, which has no panel, still confirms the way it always did.
  const f = await wake(t, {}, serviceNamesTheId);
  await f.fire.menuClick({ menuItemId: 'mode-flash' }, tab());
  await settle();
  assert.deepEqual(toastTexts(f), ['Pinned, working it out…', 'Pinned: ADK session state']);
});

test('a pin the service refuses still ends the panel’s wait', async (t) => {
  // Otherwise the panel sits on a heading until its timeout. The hand-off is
  // left as it was, with no id, and the panel says the honest sentence when it
  // gives up rather than pretending a take is coming.
  const c = await wake(t, { gestureBound: true }, serviceIsDown);
  await c.fire.menuClick({ menuItemId: 'mode-learn-now' }, tab());
  await settle();

  assert.equal((c.store[HANDOFF_KEY] as { pinId: string | null }).pinId, null);
  assert.equal((c.store[QUEUE_KEY] as unknown[] | undefined)?.length, 1,
    'and the pin itself is not lost: it queues like any other ()');
});

// ------------------------------------------- Standard: the box, and its pin

/**
 * `mode-standard`, both halves.
 *
 * The worker captures and puts the box over the page; the box comes back as a
 * message, minutes later if the learner takes minutes, and possibly to a
 * worker that has been killed and restarted since. So the assertions that
 * matter are that nothing is posted until the message arrives, and that the
 * message alone is enough to post from.
 */
test('Standard captures and draws the box, and posts nothing yet', async (t) => {
  const c = await wake(t, {}, serviceNamesTheId);
  const before = c.requests.filter((r) => r.url.endsWith('/pins')).length;

  await c.fire.menuClick({ menuItemId: 'mode-standard' }, tab());
  await settle();

  assert.equal(c.requests.filter((r) => r.url.endsWith('/pins')).length, before,
    'the box had not been answered and a pin was already on the board');
  // Capture first, then the module that draws the box, reached by url because
  // an injected function is serialised and can hold no imports.
  const drawn = c.injections.at(-1)!;
  assert.ok(String(drawn.args[0]).endsWith('dist/pin-box.js'), 'the box module was not the thing injected');
  assert.equal((drawn.args[1] as { pageTitle?: string })?.pageTitle, 'ADK — Sessions',
    'the box was handed no envelope, so it has nothing to show');
  assert.deepEqual(toastTexts(c), [], 'a toast confirmed a pin that has not been made');
});

test('Standard draws the form in the board theme the learner chose', async (t) => {
  const c = await wake(t, { store: { [THEME_KEY]: 'dark' } }, serviceNamesTheId);

  await c.fire.menuClick({ menuItemId: 'mode-standard' }, tab());
  await settle();

  const drawn = c.injections.at(-1)!;
  assert.equal(drawn.args[2], 'dark',
    'the form was injected without the stored blackboard choice');
  assert.match(String(drawn.func), /openPinBox\(e,.*theme/s,
    'the page-side loader read the theme but did not hand it to the form');
  assert.equal(pins(c).length, 0, 'changing presentation saved a pin before the learner pressed Add');
});

test('Standard’s box comes back and becomes an ordinary pin, note and all', async (t) => {
  const c = await wake(t, {}, serviceNamesTheId);
  await c.send({
    kind: COMPOSE_SAVE,
    envelope: { selection: 'edited passage', pageTitle: 'A Page', headingPath: ['Docs'], url: 'https://example.test/' },
    text: 'edited passage',
    note: 'why does field order matter?',
    struggle: false,
  }, { tab: { id: 7, windowId: 3 } });
  await settle();

  const body = pins(c)[0] as { type: string; note: string; envelope: Record<string, unknown> };
  assert.equal(body.type, 'interest');
  assert.equal(body.envelope['selection'], 'edited passage', 'the learner’s edit did not reach the pin');
  assert.equal(body.envelope['pageTitle'], 'A Page',
    'and the rest of the envelope did not survive the trip with it');
  assert.equal(body.note, 'why does field order matter?',
    'the note the service has always accepted and nothing ever sent');
  assert.deepEqual(toastTexts(c), ['Pinned, working it out…', 'Pinned: ADK session state'],
    'the pin is confirmed the way every other pin is');
});

test('right-click and Add details join one browser-session pin list', async (t) => {
  let n = 0;
  const c = await wake(t, {}, (stub) => {
    stub.fetchHandler = (url) => url.endsWith('/pins')
      ? jsonResponse({ id: `p-${++n}`, label: n === 1 ? 'Bobby Robson' : 'Ipswich Rugby Club' })
      : jsonResponse(prefsBody());
  });

  await c.fire.menuClick({ menuItemId: 'mode-flash' }, tab());
  await c.send({
    kind: COMPOSE_SAVE,
    envelope: { selection: 'Ipswich Rugby Club', pageTitle: 'A Page' },
    text: 'Ipswich Rugby Club', note: 'A note', struggle: false,
  }, { tab: { id: 7, windowId: 3 } });
  await settle();

  const held = c.sessionStore[CAPTURE_SESSION_KEY] as CaptureSessionPin[];
  assert.deepEqual(held.map((row) => [row.pinId, row.label]), [
    ['p-2', 'Ipswich Rugby Club'], ['p-1', 'Bobby Robson'],
  ]);
  assert.equal(held.every((row) => row.ownerUid === null), true);
  assert.deepEqual(c.runtimeMessages.filter((message) =>
    (message as { kind?: string }).kind === CAPTURE_SESSION_ADDED).map((message) =>
    (message as { pinId?: string }).pinId), ['p-1', 'p-2']);
});

test('Standard is where the struggle signal lives now', async (t) => {
  const c = await wake(t, {}, serviceNamesTheId);
  await c.send({
    kind: COMPOSE_SAVE,
    envelope: { selection: 'x', pageTitle: 'A Page' },
    text: 'x', note: null, struggle: true,
  }, { tab: { id: 7, windowId: 3 } });
  await settle();
  assert.equal((pins(c)[0] as { type: string }).type, 'struggle');
});

test('Standard’s pin queues when the service is down, like every other pin ()', async (t) => {
  const c = await wake(t, {}, serviceIsDown);
  await c.send({
    kind: COMPOSE_SAVE,
    envelope: { selection: 'x', pageTitle: 'A Page' },
    text: 'x', note: 'kept', struggle: false,
  }, { tab: { id: 7, windowId: 3 } });
  await settle();

  const queued = queuedBodies(c) as { note?: string }[];
  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.note, 'kept', 'the note was dropped on the way into the queue');
});

test('a box that comes back empty makes no pin at all', async (t) => {
  // The button is disabled on an empty passage, so this is a message that
  // could only arrive from a page doing something else. It is refused rather
  // than stored: a pin with no material is one the nightly cannot teach from.
  const c = await wake(t, {}, serviceNamesTheId);
  for (const text of ['', '   ', 42 as unknown as string]) {
    const reply = await c.send({
      kind: COMPOSE_SAVE, envelope: { selection: 'x' }, text, note: null, struggle: false,
    }, { tab: { id: 7, windowId: 3 } });
    assert.deepEqual(reply, { ok: false });
  }
  await settle();
  assert.equal(c.requests.filter((r) => r.url.endsWith('/pins')).length, 0);
});

// ------------------------------------------ the Selector, and its batch of pins

test('the Selector draws the picker and captures nothing itself', async (t) => {
  const c = await wake(t, {}, serviceNamesTheId);
  await c.fire.menuClick({ menuItemId: 'mode-select' }, tab());
  await settle();

  const repaired = c.injections.at(-1)!;
  assert.deepEqual(repaired.files, ['selector-content.js'],
    'a page without the declared listener was not repaired');
  assert.equal(repaired.tabId, 7);
  assert.deepEqual(c.tabMessages.at(-1), {
    tabId: 7, message: { kind: OPEN_SELECTOR_ON_PAGE },
  }, 'the worker did not ask the exact page to draw the picker');

  const loader = readFileSync(fileURLToPath(new URL('../../selector-content.js', import.meta.url)), 'utf8');
  assert.match(loader, /dist\/selector\.js/);
  assert.match(loader, /dist\/capture\.js/,
    'the page listener was not handed the shipped capture, so it would need a second one');
  assert.match(loader, /__sbSelectionMemory/);
  assert.match(loader, /memory\.atMenu = null/,
    'the picker inherited the right-click recovery from the menu that opened it');
  assert.match(loader, /capture\.capture\(false, visibleSelection \?\? null\)/,
    'a fresh picker choice was allowed to recover the earlier menu selection');
  assert.equal(c.requests.filter((r) => r.url.endsWith('/pins')).length, 0);
  assert.deepEqual(toastTexts(c), []);
});

test('every pick becomes its own pin, confirmed once', async (t) => {
  // Two paragraphs about two things are two things to learn. Whether they
  // belong together is the Clusterer's question, not the picker's.
  const c = await wake(t, {}, serviceNamesTheId);
  await c.send({
    kind: SELECT_SAVE,
    envelopes: [
      { selection: 'first thing', pageTitle: 'A Page', headingPath: [] },
      { selection: 'second thing', pageTitle: 'A Page', headingPath: [] },
      { selection: 'third thing', pageTitle: 'A Page', headingPath: [] },
    ],
  }, { tab: { id: 7, windowId: 3 } });
  await settle();

  const made = pins(c) as { type: string; envelope: Record<string, unknown> }[];
  assert.equal(made.length, 3);
  assert.deepEqual(made.map((p) => p.envelope['selection']), ['first thing', 'second thing', 'third thing']);
  assert.ok(made.every((p) => p.type === 'interest'));
  assert.deepEqual(toastTexts(c), ['Pinned, working it out…', 'Pinned 3 things.'],
    'three pins produced three toasts for one decision');
  assert.deepEqual(c.runtimeMessages.filter((m) => (m as { kind?: string }).kind === SELECT_STATUS), [
    { kind: SELECT_STATUS, tabId: 7, state: 'saving', count: 3, queued: 0 },
    { kind: SELECT_STATUS, tabId: 7, state: 'saved', count: 3, queued: 0 },
  ], 'the side panel was left unchanged after the page toast disappeared');
});

test('one picker passage hands its exact saved pin straight to the panel lesson', async (t) => {
  const c = await wake(t, {}, serviceNamesTheId);
  await c.send({
    kind: SELECT_SAVE,
    envelopes: [{ selection: 'one exact passage', pageTitle: 'A Page', headingPath: [] }],
  }, { tab: { id: 7, windowId: 3 } });
  await settle();

  const waiting = pendingTake(c.store[HANDOFF_KEY], Date.now());
  assert.equal(waiting?.pinId, 'p-42');
  assert.equal(waiting?.label, 'ADK session state');
  const status = c.runtimeMessages
    .filter((m) => (m as { kind?: string }).kind === SELECT_STATUS).at(-1) as Record<string, unknown>;
  assert.equal(status['state'], 'saved');
  assert.equal(status['count'], 1);
  assert.equal(status['queued'], 0);
  assert.equal(status['lessonPinId'], 'p-42');
  assert.equal(status['lessonLabel'], 'ADK session state');
  assert.equal(status['lessonAt'], waiting?.at);
});

test('one refused pick costs that pick and not the batch', async (t) => {
  // A PDF frame among four paragraphs.  refuses the one it cannot read
  // and the rest are ordinary pins.
  const c = await wake(t, {}, serviceNamesTheId);
  await c.send({
    kind: SELECT_SAVE,
    envelopes: [
      { selection: 'a real passage', pageTitle: 'A Page', headingPath: [] },
      { selection: null, parts: [], surroundingText: '', documentKind: 'pdf', pageTitle: 'paper.pdf', headingPath: [] },
      { selection: 'another real passage', pageTitle: 'A Page', headingPath: [] },
    ],
  }, { tab: { id: 7, windowId: 3 } });
  await settle();

  assert.equal(pins(c).length, 2);
  assert.deepEqual(toastTexts(c).at(-1), 'Pinned 2 things.');
});

test('a batch where nothing survives says so, and does not congratulate itself', async (t) => {
  const c = await wake(t, {}, serviceNamesTheId);
  await c.send({
    kind: SELECT_SAVE,
    envelopes: [{ selection: null, parts: [], surroundingText: '', documentKind: 'pdf', pageTitle: 'p.pdf', headingPath: [] }],
  }, { tab: { id: 7, windowId: 3 } });
  await settle();
  assert.equal(pins(c).length, 0);
  assert.deepEqual(toastTexts(c).at(-1), 'Nothing could be pinned from that.');
});

test('a batch the service cannot take queues, every one of them ()', async (t) => {
  const c = await wake(t, {}, serviceIsDown);
  await c.send({
    kind: SELECT_SAVE,
    envelopes: [
      { selection: 'one', pageTitle: 'A Page', headingPath: [] },
      { selection: 'two', pageTitle: 'A Page', headingPath: [] },
    ],
  }, { tab: { id: 7, windowId: 3 } });
  await settle();
  assert.equal((c.store[QUEUE_KEY] as unknown[] | undefined)?.length, 2);
  assert.deepEqual(c.runtimeMessages.filter((m) => (m as { kind?: string }).kind === SELECT_STATUS).at(-1),
    { kind: SELECT_STATUS, tabId: 7, state: 'saved', count: 2, queued: 2 });
});

test('an empty batch is not a gesture and makes nothing', async (t) => {
  const c = await wake(t, {}, serviceNamesTheId);
  for (const envelopes of [[], undefined, 'not a list']) {
    const reply = await c.send({ kind: SELECT_SAVE, envelopes }, { tab: { id: 7, windowId: 3 } });
    assert.deepEqual(reply, { ok: false });
  }
  await settle();
  assert.equal(c.requests.filter((r) => r.url.endsWith('/pins')).length, 0);
  assert.deepEqual(toastTexts(c), [], 'a toast for a batch that was never made');
});

// ------------------------------------ the confirmation quotes what it saved

/** The `SavedQuote` the finisher was handed, or null. */
const savedOn = (c: ChromeStub): { quote: string; wholePage: boolean; pageNote: string | null } | null => {
  const finish = c.injections.filter((i) => i.args.length >= 2 && !/\.js$/.test(String(i.args[0]))).at(-1);
  const saved = finish && finish.args.length >= 4 ? finish.args[2] : finish?.args.at(-1);
  return (saved ?? null) as { quote: string; wholePage: boolean; pageNote: string | null } | null;
};

test('the confirmation quotes the passage that was actually saved', async (t) => {
  // The label above it is model output over the material, so it can be
  // perfect while the pin is a single word. This is the line that can tell
  // the difference, and it is the reason the selection recovery is allowed to
  // resolve an ambiguity in favour of the highlight.
  const c = await wake(t, {}, (stub) => {
    serviceNamesTheId(stub);
    stub.injectResult = (injection: Injection) => (injection.func === capture
      ? { ...envelope, selection: 'A composite index covers a query only when its fields match.' }
      : undefined);
  });
  await c.fire.command('pin-interest', tab());
  await settle();

  const saved = savedOn(c);
  assert.equal(saved?.quote, '“A composite index covers a query only when its fields match.”');
  assert.equal(saved?.wholePage, false);
});

test('a recovered right-click selection is confirmed without browser diagnostics', async (t) => {
  const c = await wake(t, {}, (stub) => {
    serviceNamesTheId(stub);
    stub.injectResult = (injection: Injection) => (injection.func === capture
      ? { ...envelope, selectionRecovered: true }
      : undefined);
  });
  await c.fire.menuClick({ menuItemId: 'mode-flash' }, tab());
  await settle();

  assert.equal(savedOn(c)?.pageNote, null);
  const body = pins(c)[0] as { envelope: Record<string, unknown> };
  assert.ok(!('selectionRecovered' in body.envelope), 'browser workaround state reached the learner ledger');
});

test('a shortcut with no selection refuses the hidden whole-page path', async (t) => {
  const c = await wake(t, {}, (stub) => {
    serviceNamesTheId(stub);
    stub.injectResult = (injection: Injection) => (injection.func === capture
      ? { ...envelope, selection: null, surroundingText: 'AI Notice This learning experience may include AI-generated images.' }
      : undefined);
  });
  await c.fire.command('pin-interest', tab());
  await settle();

  assert.equal(pins(c).length, 0);
  assert.deepEqual(toastTexts(c).at(-1), 'Select something first, or use Pick what to pin.');
});

test('the explicit experimental whole-page mode still saves and explains its scope', async (t) => {
  const c = await wake(t, {}, (stub) => {
    serviceNamesTheId(stub);
    stub.injectResult = (injection: Injection) => (injection.func === capture
      ? { ...envelope, selection: null, surroundingText: 'AI Notice This learning experience may include AI-generated images.' }
      : undefined);
  });
  await c.fire.menuClick({ menuItemId: 'mode-page' }, tab());
  await settle();

  const saved = savedOn(c);
  assert.match(String(saved?.quote), /AI Notice This learning experience/);
  assert.equal(saved?.wholePage, true);
  assert.match(String(saved?.pageNote), /Select something first/);
});

test('the batch quotes the first thing that landed, never one that did not', async (t) => {
  const c = await wake(t, {}, serviceNamesTheId);
  await c.send({
    kind: SELECT_SAVE,
    envelopes: [
      { selection: null, parts: [], surroundingText: '', documentKind: 'pdf', pageTitle: 'p.pdf', headingPath: [] },
      { selection: 'the first one that survived', pageTitle: 'A Page', headingPath: [] },
      { selection: 'a later one', pageTitle: 'A Page', headingPath: [] },
    ],
  }, { tab: { id: 7, windowId: 3 } });
  await settle();

  const saved = savedOn(c);
  assert.equal(saved?.quote, '“the first one that survived”');
  assert.equal(saved?.wholePage, false, 'every pick is a selection by construction');
});

test('Standard’s pin quotes the text the learner edited, not the text they were given', async (t) => {
  const c = await wake(t, {}, serviceNamesTheId);
  await c.send({
    kind: COMPOSE_SAVE,
    envelope: { selection: 'what capture found', pageTitle: 'A Page' },
    text: 'what they trimmed it to',
    note: null,
    struggle: false,
  }, { tab: { id: 7, windowId: 3 } });
  await settle();
  assert.equal(savedOn(c)?.quote, '“what they trimmed it to”');
});

test('a pin with no material to quote draws no quotation at all', async (t) => {
  const c = await wake(t, {}, (stub) => {
    serviceNamesTheId(stub);
    stub.injectResult = (injection: Injection) => (injection.func === capture
      ? { ...envelope, selection: null, surroundingText: '   ' }
      : undefined);
  });
  await c.fire.menuClick({ menuItemId: 'mode-page' }, tab());
  await settle();
  assert.equal(savedOn(c)?.quote, '', 'an empty quotation is worse than none');
});

// -------------------------- a page that was open before the extension was


const notWatching = (stub: ChromeStub): void => {
  serviceNamesTheId(stub);
  stub.injectResult = (injection: Injection) => (injection.func === capture
    ? { ...envelope, selection: 'data', selectionWatched: false }
    : undefined);
};

test('a page nothing was watching is repaired with the access the gesture granted', async (t) => {
  // `activeTab` gives host access to this tab because the learner invoked the
  // extension. That is the whole permission this needs, which is why the
  // manifest still asks for no host but the local service.
  const c = await wake(t, {}, notWatching);
  await c.fire.command('pin-interest', tab());
  await settle();

  const installed = c.injections.filter((i) => i.files?.includes('selection-content.js'));
  assert.equal(installed.length, 1, 'the page was left in the state that produced the wrong pin');
});

test('and an exact selected-text confirmation does not narrate watcher state', async (t) => {
  const c = await wake(t, {}, notWatching);
  await c.fire.command('pin-interest', tab());
  await settle();

  const saved = savedOn(c);
  assert.equal(saved?.quote, '“data”', 'the learner is shown the word, which is the point');
  assert.equal(saved?.pageNote, null,
    'an internal recovery diagnostic leaked into a successful pin receipt');
});

test('a watched page is left alone and says nothing about it', async (t) => {
  const c = await wake(t, {}, (stub) => {
    serviceNamesTheId(stub);
    stub.injectResult = (injection: Injection) => (injection.func === capture
      ? { ...envelope, selectionWatched: true }
      : undefined);
  });
  await c.fire.command('pin-interest', tab());
  await settle();

  assert.equal(c.injections.filter((i) => i.files).length, 0,
    'a page that was already fine was injected into anyway');
  assert.equal(savedOn(c)?.pageNote, null, 'an ordinary preserved selection was explained anyway');
});

test('the watching flag is a fact about the browser and never reaches the ledger', async (t) => {
  // The store holds facts about material. This is a fact about this tab at
  // this moment, and a pin carrying it would be a pin that means something
  // different when it is read back tomorrow.
  const c = await wake(t, {}, notWatching);
  await c.fire.command('pin-interest', tab());
  await settle();
  const body = pins(c)[0] as { envelope: Record<string, unknown> };
  assert.ok(!('selectionWatched' in body.envelope), 'it reached the service');
  assert.ok(!('selectionRecovered' in body.envelope), 'the recovery marker reached the service');
});
