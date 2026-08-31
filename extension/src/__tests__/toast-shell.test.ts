import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PIN_UNDO, showToast, type ToastOffer, type ToastUndo } from '../toast.js';
import { LEARN_NOW } from '../learn-now.js';
import { acrossExecuteScriptBoundary } from './dom-stub.js';

/**
 * The toast, run rather than named.
 *
 * `background-capture.test.ts` proves the worker hands Chrome *this* function,
 * at the right moment, for the right tab — by identity. Nothing ran the body,
 * so nothing could see that the host element it builds was arriving on the page
 * unpositioned: `all: initial` sat at the end of its own declaration block and
 * threw away the `position: fixed` three declarations before it. The toast still
 * appeared and still said the right words, in the document flow at the end of
 * the page, where on anything longer than a screen the learner never saw it.
 *
 *  makes that a real failure and not a cosmetic one: the toast is the
 * entire feedback surface for a capture. A confirmation below the fold is a
 * capture with no confirmation.
 *
 * The rule is one line of CSS cascade — within a single declaration block the
 * last declaration wins, and `all` is a declaration for every property at once —
 * so it is checkable here, without a browser, as long as something actually runs
 * the function and reads what it wrote.
 */

// ------------------------------------------------------------- the fake page

class FakeEl {
  readonly tagName: string;
  readonly style: Record<string, string> = { cssText: '', opacity: '', transform: '' };
  textContent = '';
  readonly children: FakeEl[] = [];
  shadow: FakeEl | null = null;
  removed = false;
  /**  affordance is the first thing in this toast a person can press,
   *  so the fake page has to be able to press it. The capture-feedback contract adds the two
   *  gestures that are not presses — a pointer resting on it and focus landing
   *  on it — so they are dispatched the same way. */
  readonly listeners: Record<string, ((ev?: unknown) => void)[]> = {};

  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  attachShadow(_init: { mode: string }): FakeEl { this.shadow = new FakeEl('#shadow-root'); return this.shadow; }
  append(...nodes: FakeEl[]): void { this.children.push(...nodes); }
  replaceChildren(...nodes: FakeEl[]): void { this.children.splice(0, this.children.length, ...nodes); }
  remove(): void { this.removed = true; }
  addEventListener(type: string, fn: (ev?: unknown) => void): void { (this.listeners[type] ??= []).push(fn); }
  fire(type: string, ev?: unknown): void { for (const fn of [...this.listeners[type] ?? []]) fn(ev); }
  click(): void { this.fire('click'); }
}

interface ToastPage {
  documentElement: FakeEl;
  /** Every pending timer, in the order it was set, so dismissal is a value
   *  this test can inspect rather than 2.6 seconds it has to wait out. */
  timers: { id: number; delay: number; run: () => void; cleared: boolean }[];
  win: Record<string, unknown>;
  /** Everything the toast pushed at the worker, which for the affordance is
   *  the whole of what the tap does from inside the page. */
  sent: unknown[];
  /** Listeners the toast put on the page's own document rather than on itself.
   *  The capture-feedback contract’s explicit dismiss is a key, so it has to be one of these — and
   *  the plain toast has to leave this empty. */
  docListeners: Record<string, ((ev?: unknown) => void)[]>;
  fireDoc: (type: string, ev?: unknown) => void;
  undo: () => void;
}

function installToastPage(options: { chrome?: boolean; reply?: unknown; reduceMotion?: boolean } = {}): ToastPage {
  const documentElement = new FakeEl('html');
  const timers: ToastPage['timers'] = [];
  const win: Record<string, unknown> = {};
  let next = 1;

  const sent: unknown[] = [];
  const previous: Record<string, unknown> = {};
  const g = globalThis as unknown as Record<string, unknown>;
  for (const k of ['document', 'window', 'matchMedia', 'requestAnimationFrame', 'setTimeout', 'clearTimeout', 'chrome']) previous[k] = g[k];
  // Absent unless the test asks for it. A page where `chrome` is not there at
  // all is the case the affordance's guard exists for, and it is exercised.
  if (options.chrome === false || options.chrome === undefined) delete g['chrome'];
  else g['chrome'] = { runtime: { sendMessage: (m: unknown, reply?: (value: unknown) => void) => {
    sent.push(m);
    reply?.(options.reply);
  } } };

  const docListeners: ToastPage['docListeners'] = {};

  Object.assign(g, {
    document: {
      documentElement,
      createElement: (tag: string) => new FakeEl(tag),
      addEventListener: (type: string, fn: (ev?: unknown) => void) => { (docListeners[type] ??= []).push(fn); },
      removeEventListener: (type: string, fn: (ev?: unknown) => void) => {
        const at = (docListeners[type] ??= []).indexOf(fn);
        if (at >= 0) docListeners[type]!.splice(at, 1);
      },
    },
    window: win,
    matchMedia: (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)' && options.reduceMotion === true,
    }),
    requestAnimationFrame: (cb: () => void) => { cb(); return 1; },
    setTimeout: (run: () => void, delay: number) => {
      const id = next++;
      timers.push({ id, delay, run, cleared: false });
      return id;
    },
    clearTimeout: (id: number) => { const t = timers.find((t) => t.id === id); if (t) t.cleared = true; },
  });

  return {
    documentElement, timers, win, sent, docListeners,
    fireDoc: (type: string, ev?: unknown) => { for (const fn of [...docListeners[type] ?? []]) fn(ev); },
    undo: () => {
      Object.assign(g, previous);
      if (previous['chrome'] === undefined) delete g['chrome'];
    },
  };
}

/**
 * The one cascade rule this file exists for. Declarations in a block apply in
 * order and the last one wins; `all` is a declaration for every property at
 * once, so everything written before it is gone by the time the page sees it.
 */
function effective(cssText: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of cssText.split(';')) {
    const at = decl.indexOf(':');
    if (at < 0) continue;
    const prop = decl.slice(0, at).trim().toLowerCase();
    const value = decl.slice(at + 1).trim();
    if (!prop) continue;
    if (prop === 'all') { for (const k of Object.keys(out)) delete out[k]; continue; }
    out[prop] = value;
  }
  return out;
}

/** Chrome serialises `func` and evaluates the source in the page, so the toast
 *  gets no closure and no module scope either (reviewer-boundary constraint). Run it the way it runs. */
const inject = (text: string): void =>
  (acrossExecuteScriptBoundary(showToast as unknown as () => void) as unknown as (t: string) => void)(text);

// ------------------------------------------------------------------- the tests

test('the toast survives the executeScript boundary — no closure, no module scope', () => {
  const page = installToastPage();
  try {
    assert.doesNotThrow(() => inject('Pinned, working it out…'),
      'the toast reached for something that does not exist on the other side of the injection');
  } finally { page.undo(); }
});

test('the toast host is still fixed and on top after its own `all` reset ()', () => {
  const page = installToastPage();
  try {
    inject('Pinned, working it out…');
    const host = page.documentElement.children[0];
    assert.ok(host, 'the toast never reached the document');

    const css = effective(host.style['cssText'] ?? '');
    assert.equal(css['position'], 'fixed',
      '`all` came after `position`, so the toast lands in the page flow instead of over it');
    assert.equal(css['z-index'], '2147483647',
      '`all` came after `z-index`, so the page can paint over the only confirmation a capture gets');
    assert.equal(css['bottom'], '24px');
    assert.equal(css['right'], '24px');
  } finally { page.undo(); }
});

test('the toast still resets the page styles it is escaping', () => {
  // The `all` is not incidental — it is what stops the host inheriting a font,
  // a colour or a transform from whatever page it landed on. Ordering it first
  // has to keep it, not drop it.
  const page = installToastPage();
  try {
    inject('Pinned');
    const host = page.documentElement.children[0]!;
    assert.match(host.style['cssText'] ?? '', /(^|;)\s*all\s*:/,
      'the reset that isolates the toast from the page went missing');
  } finally { page.undo(); }
});

test('reduced motion keeps the toast visible and removes both entrance and exit movement', () => {
  const page = installToastPage({ reduceMotion: true });
  try {
    inject('Pinned, working it out…');
    const host = page.documentElement.children[0]!;
    const bubble = host.shadow!.children[0]!;
    const css = effective(bubble.style['cssText'] ?? '');
    assert.equal(css['opacity'], '1');
    assert.equal(css['transform'], 'none');
    assert.equal(css['transition'], 'none');

    const beforeLeave = page.timers.length;
    page.timers[0]!.run();
    assert.equal(host.removed, true);
    assert.equal(page.timers.length, beforeLeave,
      'reduced motion added a second timer for an exit animation');
  } finally { page.undo(); }
});

test('the finisher rewrites the toast in place and restarts the clock', () => {
  const page = installToastPage();
  try {
    inject('Pinned, working it out…');
    const host = page.documentElement.children[0]!;
    const bubble = host.shadow!.children[0]!;
    assert.equal(bubble.textContent, 'Pinned, working it out…');

    const first = page.timers[0]!;
    assert.equal(first.delay, 2600, 'the un-finished toast has to outlive the request behind it');

    const finish = page.win['__sbFinishToast'] as (t: string) => void;
    assert.equal(typeof finish, 'function',
      'the second injection has no way to reach the first one except through window');
    finish('Pinned: proton gradients');

    assert.equal(bubble.textContent, 'Pinned: proton gradients');
    assert.equal(first.cleared, true, 'the long dismissal has to be cancelled or the toast leaves twice');
    assert.equal(page.timers.at(-1)!.delay, 1500);
  } finally { page.undo(); }
});

test('a second finish is ignored', () => {
  // The drain and the post can both come back. The first answer is the one the
  // learner read; the second must not restart a toast that has already gone.
  const page = installToastPage();
  try {
    inject('Pinned');
    const bubble = page.documentElement.children[0]!.shadow!.children[0]!;
    const finish = page.win['__sbFinishToast'] as (t: string) => void;
    finish('first');
    const after = page.timers.length;
    finish('second');
    assert.equal(bubble.textContent, 'first');
    assert.equal(page.timers.length, after, 'the toast was given a second life');
  } finally { page.undo(); }
});

// ------------------------------------------------- the one affordance

/** The finisher, with the offer, as the worker actually calls it. */
const finishWith = (page: ToastPage, text: string, offer: ToastOffer | null): void =>
  (page.win['__sbFinishToast'] as (t: string, o: ToastOffer | null) => void)(text, offer);

const finishWithUndo = (
  page: ToastPage, text: string, undo: ToastUndo,
): void => (page.win['__sbFinishToast'] as (
  t: string, o: ToastOffer | null, s: Saved | null, u: ToastUndo,
) => void)(text, null, null, undo);

test('the confirmation grows one affordance, and only when there is one', () => {
  const page = installToastPage({ chrome: true });
  try {
    inject('Pinned, working it out…');
    const bubble = page.documentElement.children[0]!.shadow!.children[0]!;
    finishWith(page, 'Pinned: Firestore indexes', { label: 'Learn it now?', pinId: 'p-1', pinLabel: 'Firestore indexes' });

    assert.equal(bubble.textContent, 'Pinned: Firestore indexes',
      'the confirmation the learner already had is untouched');
    assert.equal(bubble.children.length, 1, 'one affordance, not a row of buttons');
    assert.equal(bubble.children[0]?.textContent, ' · Learn it now?');
  } finally { page.undo(); }
});

test('no offer means no affordance at all — not a disabled one', () => {
  const page = installToastPage({ chrome: true });
  try {
    inject('Pinned, working it out…');
    finishWith(page, 'Pinned. I’ll sort it once I’m back online', null);
    const bubble = page.documentElement.children[0]!.shadow!.children[0]!;
    assert.deepEqual(bubble.children, [],
      'a take the service cannot serve must not be offered and then refused');
  } finally { page.undo(); }
});

test('an online pin offers one exact brief Undo', () => {
  const page = installToastPage({ chrome: true });
  try {
    inject('Pinned, working it out…');
    const bubble = page.documentElement.children[0]!.shadow!.children[0]!;
    finishWithUndo(page, 'Pinned: Firestore indexes', {
      label: 'Undo', pinId: 'p-1', ownerUid: 'uid-a',
    });
    assert.deepEqual(bubble.children.map((child) => child.textContent), [' · Undo']);
    assert.equal(page.timers.at(-1)?.delay, 6000, 'an action must remain reachable');
  } finally { page.undo(); }
});

test('Undo sends the exact pin and owner and speaks successful removal', () => {
  const page = installToastPage({ chrome: true, reply: { ok: true } });
  try {
    inject('Pinned, working it out…');
    const bubble = page.documentElement.children[0]!.shadow!.children[0]!;
    finishWithUndo(page, 'Pinned: Firestore indexes', {
      label: 'Undo', pinId: 'p-1', ownerUid: 'uid-a',
    });
    bubble.children[0]!.click();
    assert.deepEqual(page.sent, [{ kind: PIN_UNDO, pinId: 'p-1', ownerUid: 'uid-a' }]);
    assert.equal(bubble.textContent, 'Removed. It is no longer on your board.');
  } finally { page.undo(); }
});

test('a refused Undo leaves the receipt honest', () => {
  const page = installToastPage({ chrome: true, reply: { ok: false } });
  try {
    inject('Pinned, working it out…');
    const bubble = page.documentElement.children[0]!.shadow!.children[0]!;
    finishWithUndo(page, 'Pinned: Firestore indexes', {
      label: 'Undo', pinId: 'p-1', ownerUid: null,
    });
    bubble.children[0]!.click();
    assert.equal(bubble.textContent, 'I could not remove it. It is still on your board.');
  } finally { page.undo(); }
});

// ------------------------------------- the capture-feedback contract: the window a hand can reach


test('the capture-feedback contract: the toast carrying the affordance dwells long enough to be reachable', () => {
  const page = installToastPage({ chrome: true });
  try {
    inject('Pinned, working it out…');
    finishWith(page, 'Pinned: Firestore indexes', { label: 'Learn it now?', pinId: 'p-1', pinLabel: 'Firestore indexes' });
    assert.equal(page.timers.at(-1)!.delay, 6000,
      'the learn-now clause is back inside the 1500ms window no hand can reach');
  } finally { page.undo(); }
});

test('the capture-feedback contract: the plain toast times out exactly as it did', () => {
  // Offline, the  refusal, an unnamed success — every toast with no take
  // behind it. Nothing was wrong with its timing and nothing about it changes;
  // a confirmation that lingered with nothing to offer would be the surface
  // soliciting attention that §3 rules out.
  const page = installToastPage({ chrome: true });
  try {
    inject('Pinned, working it out…');
    assert.equal(page.timers[0]!.delay, 2600, 'the un-finished toast still outlives the request behind it');
    finishWith(page, 'Pinned. I’ll sort it once I’m back online', null);
    assert.equal(page.timers.at(-1)!.delay, 1500);
  } finally { page.undo(); }
});

test('the capture-feedback contract: the plain toast grows no behaviour either — no listeners, on it or on the page', () => {
  // The stronger statement, because timing is only the part that is easy to
  // assert. The dwell-holding and the escape hatch belong to the toast that has
  // something to decide about; the plain one is the build before this one.
  const page = installToastPage({ chrome: true });
  try {
    inject('Pinned, working it out…');
    finishWith(page, 'Pinned: Firestore indexes', null);
    const bubble = page.documentElement.children[0]!.shadow!.children[0]!;
    assert.deepEqual(Object.keys(bubble.listeners), []);
    assert.deepEqual(Object.keys(page.docListeners).filter((t) => page.docListeners[t]!.length), [],
      'a toast with nothing to offer left a listener on somebody else’s page');
  } finally { page.undo(); }
});

test('the capture-feedback contract: a pointer resting on the toast holds it open, and leaving restarts the dwell', () => {
  // A learner reading is a learner deciding. Six seconds is a window, not a
  // ration, and the cheapest way to say so is to stop the clock while they are
  // still looking at it (Material's snackbars behave the same way).
  const page = installToastPage({ chrome: true });
  try {
    inject('Pinned, working it out…');
    finishWith(page, 'Pinned: Firestore indexes', { label: 'Learn it now?', pinId: 'p-1', pinLabel: 'Firestore indexes' });
    const bubble = page.documentElement.children[0]!.shadow!.children[0]!;
    const dwell = page.timers.at(-1)!;

    bubble.fire('mouseenter');
    assert.equal(dwell.cleared, true, 'the toast went out from under the pointer that was reading it');
    assert.equal(page.timers.at(-1)!.id, dwell.id, 'holding it open must not queue a second dismissal');

    bubble.fire('mouseleave');
    const after = page.timers.at(-1)!;
    assert.notEqual(after.id, dwell.id, 'the toast is held, not pinned — it has to leave once they look away');
    assert.equal(after.delay, 6000, 'the whole window again, not the remainder of it');
  } finally { page.undo(); }
});

test('the capture-feedback contract: focus holds it open the same way a pointer does', () => {
  const page = installToastPage({ chrome: true });
  try {
    inject('Pinned, working it out…');
    finishWith(page, 'Pinned: Firestore indexes', { label: 'Learn it now?', pinId: 'p-1', pinLabel: 'Firestore indexes' });
    const bubble = page.documentElement.children[0]!.shadow!.children[0]!;
    const dwell = page.timers.at(-1)!;

    bubble.fire('focusin');
    assert.equal(dwell.cleared, true);
    bubble.fire('focusout');
    assert.equal(page.timers.at(-1)!.delay, 6000);
  } finally { page.undo(); }
});

test('the capture-feedback contract: escape takes it away now, and takes its listener off the page with it', () => {
  // The other direction of the same courtesy: a longer window is only fair if
  // the learner can end it. A key rather than a click on the bubble — the
  // bubble is where the clause is, and a near-miss must not delete the thing
  // they were reaching for.
  const page = installToastPage({ chrome: true });
  try {
    inject('Pinned, working it out…');
    finishWith(page, 'Pinned: Firestore indexes', { label: 'Learn it now?', pinId: 'p-1', pinLabel: 'Firestore indexes' });
    const dwell = page.timers.at(-1)!;

    page.fireDoc('keydown', { key: 'k' });
    assert.equal(page.timers.at(-1)!.id, dwell.id, 'every keystroke on the page is not a dismissal');

    page.fireDoc('keydown', { key: 'Escape' });
    const now = page.timers.at(-1)!;
    assert.equal(now.delay, 0);
    now.run();

    assert.deepEqual(Object.keys(page.docListeners).filter((t) => page.docListeners[t]!.length), [],
      'the toast is gone and its keydown listener is still on the learner’s page');
  } finally { page.undo(); }
});

test('the tap tells the worker which pin, and takes the toast away with it', () => {
  const page = installToastPage({ chrome: true });
  try {
    inject('Pinned, working it out…');
    finishWith(page, 'Pinned: Firestore indexes', { label: 'Learn it now?', pinId: 'p-1', pinLabel: 'Firestore indexes' });
    const before = page.timers.length;
    page.documentElement.children[0]!.shadow!.children[0]!.children[0]!.click();

    assert.deepEqual(page.sent, [{ kind: LEARN_NOW, pinId: 'p-1', label: 'Firestore indexes' }],
      'the kind is spelled out inside an injected function and must still agree with the constant');
    assert.equal(page.timers.length, before + 1, 'the toast goes rather than offering a second tap');
    assert.equal(page.timers.at(-1)!.delay, 0);
  } finally { page.undo(); }
});

test('a page with no extension messaging at all does not throw out of the tap', () => {
  // The guard, exercised. This function is evaluated in a page, and a click
  // handler that threw would leave the learner looking at a dead toast with no
  // idea their tap did nothing.
  const page = installToastPage({ chrome: false });
  try {
    inject('Pinned, working it out…');
    finishWith(page, 'Pinned: Firestore indexes', { label: 'Learn it now?', pinId: 'p-1', pinLabel: 'Firestore indexes' });
    assert.doesNotThrow(() =>
      page.documentElement.children[0]!.shadow!.children[0]!.children[0]!.click());
  } finally { page.undo(); }
});

/**
 * D-2, found by watching the quick-take screen wait for a local model.
 *
 * `learn-now.ts` says the hand-off's label is *"what the toast called it, so
 * the panel has a heading before the take lands"*, and `panel.ts` heads the
 * screen with it. Nothing ever put one there: the tap sent `{kind, pinId}` and
 * `learnNowOffer` threw away the one label it was holding — Scout's, the same
 * one already on the toast — because `ToastOffer.label` is the clause's own
 * words. So the panel opened on an empty `<h2>` over a `…`, for as long as the
 * take took, which on a local model was tens of seconds.
 *
 * Two fields rather than one, because they are two different sentences: `label`
 * is what the learner presses, `pinLabel` is what it is about.
 */
test('the tap carries what the toast called it, so the panel has a heading', () => {
  const page = installToastPage({ chrome: true });
  try {
    inject('Pinned, working it out…');
    finishWith(page, 'Pinned: Firestore indexes', { label: 'Learn it now?', pinId: 'p-1', pinLabel: 'Firestore indexes' });
    page.documentElement.children[0]!.shadow!.children[0]!.children[0]!.click();
    assert.equal((page.sent[0] as { label?: unknown }).label, 'Firestore indexes',
      'the panel heads the quick take with this and had nothing to head it with');
  } finally { page.undo(); }
});

test('a pin the Scout could not name sends no name, rather than an empty one', () => {
  const page = installToastPage({ chrome: true });
  try {
    inject('Pinned, working it out…');
    finishWith(page, 'Pinned', { label: 'Learn it now?', pinId: 'p-1', pinLabel: null });
    page.documentElement.children[0]!.shadow!.children[0]!.children[0]!.click();
    assert.deepEqual(page.sent, [{ kind: LEARN_NOW, pinId: 'p-1', label: null }],
      'an empty label is no label, as it is everywhere else in this extension');
  } finally { page.undo(); }
});


// ------------------------------------ the quotation, and how long it dwells

/** The lines under the confirmation, in order. */
const chosenLines = (bubble: FakeEl): string[] => bubble.children.map((c) => c.textContent);

/** The finisher with the quotation, as the worker actually calls it. */
type Saved = { quote: string; wholePage: boolean; pageNote: string | null };
const finishQuoting = (page: ToastPage, text: string, saved: Saved | null): void =>
  (page.win['__sbFinishToast'] as (t: string, o: ToastOffer | null, s: Saved | null) => void)(
    text, null, saved);

test('the confirmation quotes what was saved, as text and never as markup', () => {
  const page = installToastPage();
  try {
    inject('Pinned, working it out…');
    const bubble = page.documentElement.children[0]!.shadow!.children[0]!;
    finishQuoting(page, 'Pinned: Firestore indexes',
      { quote: '“<img src=x> a passage”', wholePage: false, pageNote: null });

    assert.equal(bubble.textContent, 'Pinned: Firestore indexes');
    // The quotation is its own node under the confirmation, not appended to
    // the sentence: it is a different voice and it is styled as one.
    const lines = bubble.children.map((c) => c.textContent);
    assert.deepEqual(lines, ['“<img src=x> a passage”']);
    // Somebody else's page: set through `textContent`, so the angle brackets
    // are characters rather than an element.
    assert.equal(bubble.children.filter((c) => c.tagName === 'IMG').length, 0);
  } finally { page.undo(); }
});

test('a whole-page pin explains why the quotation looks like that', () => {
  const page = installToastPage();
  try {
    inject('Pinned, working it out…');
    const bubble = page.documentElement.children[0]!.shadow!.children[0]!;
    finishQuoting(page, 'Pinned: A page', {
      quote: '“AI Notice This learning experience…”', wholePage: true,
      pageNote: 'The whole page. Select something first to pin just that.',
    });
    assert.deepEqual(bubble.children.map((c) => c.textContent), [
      '“AI Notice This learning experience…”',
      'The whole page. Select something first to pin just that.',
    ]);
  } finally { page.undo(); }

});

test('a selected-text pin needs no explanatory line beneath the exact quote', () => {
  const chosen = installToastPage();
  try {
    inject('Pinned, working it out…');
    const bubble = chosen.documentElement.children[0]!.shadow!.children[0]!;
    finishQuoting(chosen, 'Pinned: A page', {
      quote: '“a passage they chose”', wholePage: false,
      pageNote: null,
    });
    assert.deepEqual(chosenLines(bubble), ['“a passage they chose”']);
  } finally { chosen.undo(); }
});

test('the capture-feedback contract amended: a toast that quotes dwells long enough to read it', () => {
  // 27 set the plain toast at 1500ms on the grounds that a confirmation with
  // nothing to press needs no longer. That held while it was four words. A
  // line the learner cannot finish before it leaves is the same missing
  // information with a flicker in front of it. Still below the 6000ms of the
  // branch carrying a decision, which keeps 27's ordering intact.
  const page = installToastPage();
  try {
    inject('Pinned, working it out…');
    finishQuoting(page, 'Pinned: Firestore indexes',
      { quote: '“a passage worth reading”', wholePage: false, pageNote: null });
    assert.equal(page.timers.at(-1)!.delay, 4000);
  } finally { page.undo(); }
});

test('the capture-feedback contract unamended: a toast with nothing to read still leaves at 1500ms', () => {
  for (const saved of [null, { quote: '', wholePage: false, pageNote: null }]) {
    const page = installToastPage();
    try {
      inject('Pinned, working it out…');
      finishQuoting(page, 'Pinned: Firestore indexes', saved);
      assert.equal(page.timers.at(-1)!.delay, 1500,
        'an empty quotation bought a longer toast with nothing on it');
    } finally { page.undo(); }
  }
});

test('a quoting toast can be held open by a pointer, and a plain one still cannot', () => {
  const page = installToastPage();
  try {
    inject('Pinned, working it out…');
    const bubble = page.documentElement.children[0]!.shadow!.children[0]!;
    finishQuoting(page, 'Pinned: Firestore indexes',
      { quote: '“a passage worth reading”', wholePage: false, pageNote: null });
    assert.ok((bubble.listeners['mouseenter'] ?? []).length > 0,
      'a learner reading is a learner who has not finished');
  } finally { page.undo(); }
});
