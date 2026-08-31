import { capture, type CapturedEnvelope } from './capture.js';
import { PIN_UNDO, showToast, type SavedQuote, type ToastUndo } from './toast.js';
import {
  cacheFrom, capturePermitted, chromePrefsStorage, detectorMayObserve, isFresh, mayScript,
  PREFS_CHANGED, PREFS_KEY, PREFS_REFRESH_MINUTES, type CachedPrefs,
} from './prefs.js';
import {
  buildPinBody, captureRefusal, finalToastText, initialToastText, learnNowOffer,
  pickedToastText, savedFromPage, savedQuote, WHOLE_PAGE_NOTE,
  type LearnNowOffer, type PinType,
} from './pin-body.js';
import {
  chromeQueueStorage, drainPending, enqueuePin, queueItemBelongsTo, queuedPin, queuedPinBody,
  removePending, retryPending, QUEUE_KEY, QUEUE_REMOVE, QUEUE_RETRY,
} from './queue.js';
import { currentIdentity, readAuthConfig, readSession } from './identity.js';
import {
  chromeHandoffStorage, failedHandoff, handoffFor, HANDOFF_KEY, HANDOFF_STARTED,
  LEARN_NOW, pendingHandoff, type Handoff,
} from './learn-now.js';
import {
  EXPERIMENTAL_CAPTURE_CHANGED, EXPERIMENTAL_WHOLE_PAGE_KEY,
  modeFor, OPEN_BOARD_ID, OPEN_BOARD_TITLE,
  OPEN_PANEL_ID, OPEN_PANEL_TITLE, OPEN_SELECTOR, OPEN_SELECTOR_ON_PAGE, menuModes,
  WHOLE_PAGE_MODE_ID,
  type PinMode,
} from './pin-modes.js';
import { COMPOSE_SAVE, envelopeWithEdits, type ComposeResult } from './pin-box.js';
import { SELECT_SAVE, SELECT_STATUS, type SelectResult, type SelectStatus } from './selector.js';
import { REREAD_CANDIDATE, REREAD_PREFS, type RereadPrefsReply } from './reread-bridge.js';
import { boardPageUrl, serviceBase, serviceFetch, serviceFetchAs } from './service.js';
import { THEME_KEY } from './theme.js';
import type { RereadCandidate } from './reread.js';
import {
  CAPTURE_SESSION_ADDED, CAPTURE_SESSION_KEY, CAPTURE_SESSION_REMOVED,
  dismissCaptureSessionPin, holdCaptureSessionPin, type CaptureSessionPin,
} from './capture-session.js';


const local = {
  get: (key: string) => chrome.storage.local.get(key),
  set: (items: Record<string, unknown>) => chrome.storage.local.set(items),
};
const queue = chromeQueueStorage(local, QUEUE_KEY);
const prefs = chromePrefsStorage(local, PREFS_KEY);
const handoff = chromeHandoffStorage(local, HANDOFF_KEY);

/** Notify an already-open panel after the durable hand-off has landed. */
function announceHandoff(next: Handoff): void {
  void chrome.runtime.sendMessage({ kind: HANDOFF_STARTED, handoff: next }).catch(() => {});
}

/**
 * Keep one successful capture reachable from the panel for this browser
 * session. Failure here never changes whether the pin itself succeeded: the
 * server board is the record and this is only its temporary shortcut list.
 */
const captureSessionLabel = (
  envelope: CapturedEnvelope, serviceLabel: string | null,
): string => {
  const raw = serviceLabel
    || String(envelope.selection ?? '').trim()
    || String(envelope.pageTitle ?? '').trim()
    || String(envelope.surroundingText ?? '').trim()
    || 'Pinned item';
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (compact.length <= 90) return compact;
  const hard = compact.slice(0, 90);
  const space = hard.lastIndexOf(' ');
  return `${(space > 54 ? hard.slice(0, space) : hard).replace(/[\s,;:.]+$/, '')}…`;
};

/** Two fast captures must append in order rather than both rewriting the same
 *  storage snapshot. The lane dies with the worker; the session rows do not. */
let captureSessionLane: Promise<void> = Promise.resolve();
function changeCaptureSession(
  change: (raw: unknown) => CaptureSessionPin[],
): Promise<void> {
  const write = captureSessionLane.then(async () => {
    const got = await chrome.storage.session.get(CAPTURE_SESSION_KEY);
    await chrome.storage.session.set({
      [CAPTURE_SESSION_KEY]: change(got?.[CAPTURE_SESSION_KEY]),
    });
  });
  captureSessionLane = write.catch(() => {});
  return write;
}

async function holdSessionPin(
  sent: { ok: boolean; label: string | null; id: string | null },
  envelope: CapturedEnvelope, ownerUid: string | null, present: boolean,
): Promise<CaptureSessionPin | null> {
  if (!sent.ok || !sent.id || ownerUid === '') return null;
  const pin: CaptureSessionPin = {
    pinId: sent.id,
    label: captureSessionLabel(envelope, sent.label),
    at: Date.now(),
    ownerUid,
  };
  try {
    await changeCaptureSession((raw) => holdCaptureSessionPin(raw, pin));
    if (present) {
      void chrome.runtime.sendMessage({ kind: CAPTURE_SESSION_ADDED, pinId: pin.pinId }).catch(() => {});
    }
    return pin;
  } catch { return null; }
}

async function removeSessionPin(pinId: string, ownerUid: unknown): Promise<void> {
  if (ownerUid !== null && (typeof ownerUid !== 'string' || !ownerUid)) return;
  try {
    await changeCaptureSession((raw) => dismissCaptureSessionPin(
      raw, pinId, ownerUid as string | null,
    ));
    void chrome.runtime.sendMessage({ kind: CAPTURE_SESSION_REMOVED, pinId }).catch(() => {});
  } catch { /* the permanent pin was still removed */ }
}

/** Read before a post can expire the token, so a delayed pin stays with its learner. */
async function queueOwnerUid(): Promise<string | null> {
  const [config, session] = await Promise.all([readAuthConfig(), readSession()]);
  return config === null ? null : session?.uid ?? '';
}

async function keepPending(body: unknown, ownerUid: string | null): Promise<void> {
  await enqueuePin(queue, queuedPin(body, ownerUid, new Date().toISOString()));
}

async function queueScope(): Promise<{ authConfigured: boolean; uid: string | null }> {
  const [config, session] = await Promise.all([readAuthConfig(), readSession()]);
  return { authConfigured: config !== null, uid: session?.uid ?? null };
}

async function postOwnedQueued(item: unknown): Promise<boolean | 'skip'> {
  const config = await readAuthConfig();
  if (config === null) {
    if (!queueItemBelongsTo(item, false, null)) return 'skip';
    return (await postPin(queuedPinBody(item), null)).ok;
  }
  const identity = await currentIdentity();
  if (!identity || !queueItemBelongsTo(item, true, identity.uid)) return 'skip';
  return (await postPin(queuedPinBody(item), identity.token)).ok;
}

const undoFor = (
  sent: { ok: boolean; id: string | null }, ownerUid: string | null,
): ToastUndo | null => sent.ok && sent.id
  ? { label: 'Undo', pinId: sent.id, ownerUid }
  : null;

async function undoSavedPin(pinId: string, ownerUid: unknown): Promise<boolean> {
  const config = await readAuthConfig();
  let token: string | null;
  if (config === null) {
    if (ownerUid !== null) return false;
    token = null;
  } else {
    const identity = await currentIdentity();
    if (!identity || typeof ownerUid !== 'string' || identity.uid !== ownerUid) return false;
    token = identity.token;
  }
  try {
    const response = await serviceFetchAs(
      `/pins/${encodeURIComponent(pinId)}?keepTopic=true`, token, { method: 'DELETE' },
    );
    return response.ok;
  } catch { return false; }
}

chrome.runtime.onInstalled.addListener(() => {
  // Cleared before it is built, because this fires on every update and on
  // every reload of the unpacked extension, and `create` **refuses a duplicate
  // id** — through `lastError`, which nothing reads. Without this, an install
  // that meets the previous version's items still standing creates nothing,
  // says nothing, and leaves the learner on the old menu: a mode added to the
  // registry would simply never appear. Inside the callback, which is where
  // the ordering is guaranteed rather than assumed.
  void rebuildMenu();
  // The toolbar-capture contract. These two cannot both be had: with `openPanelOnActionClick`
  // Chrome handles the click itself and `action.onClicked` never fires. The
  // click goes to capture, because  calls capture the single most
  // important interaction in the product and  says the panel is for
  // consumption; the panel moves one click further in rather than the pin.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  void refreshPrefs();
});

/** The menu, from the registry rather than by hand, so an item cannot exist in
 *  the menu and be routed nowhere. */
function buildMenu(wholePageEnabled: boolean): void {
  for (const mode of menuModes(wholePageEnabled)) {
    chrome.contextMenus.create({
      id: mode.id,
      title: mode.title,
      // Chrome's own types want a non-empty tuple and the registry holds a
      // readonly array; `PIN_MODES` is checked for emptiness by its test.
      contexts: [...mode.contexts] as [chrome.contextMenus.ContextType],
    });
  }
  // Both surfaces, on the button itself, which is where somebody looks for
  // them. The page first: it is where the board lives, and it is the one that
  // had no door at all.
  chrome.contextMenus.create({ id: OPEN_BOARD_ID, title: OPEN_BOARD_TITLE, contexts: ['action'] });
  chrome.contextMenus.create({ id: OPEN_PANEL_ID, title: OPEN_PANEL_TITLE, contexts: ['action'] });
}

/** Rebuild from stored installation state so an extension reload and a live
 * Settings change produce exactly the same menu. */
async function rebuildMenu(): Promise<void> {
  const stored = await local.get(EXPERIMENTAL_WHOLE_PAGE_KEY)
    .catch((): Record<string, unknown> => ({}));
  const enabled = stored[EXPERIMENTAL_WHOLE_PAGE_KEY] === true;
  await new Promise<void>((resolve) => {
    chrome.contextMenus.removeAll(() => {
      buildMenu(enabled);
      resolve();
    });
  });
}

/**
 * The popup asking for the picker.
 *
 * The injection stays here, in the one function that owns it: the popup has no
 * copy of the sequence, so the two cannot drift. The popup opens the side panel
 * itself, because that call needs the gesture a message would spend.
 */
async function askPageForSelector(tabId: number): Promise<boolean> {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { kind: OPEN_SELECTOR_ON_PAGE }) as
      { ok?: boolean } | undefined;
    return reply?.ok === true;
  } catch {
    return false;
  }
}

async function injectSelector(tab: chrome.tabs.Tab | undefined): Promise<boolean> {
  if (!tab?.id || !mayScript(tab.url)) return false;

  // The declared content script is the stable receiving end on an ordinary
  // page. It owns the module import in the same isolated world that will run
  // the picker; the worker no longer serialises an importing function into an
  // arbitrary page at click time.
  if (await askPageForSelector(tab.id)) return true;

  // A tab that was already open when this unpacked extension was reloaded has
  // no listener from the new extension world. Repair that one tab, then ask the
  // same declared route again. The page still has to be one Chrome permits the
  // extension to script, and both failures remain a visible "not available".
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['selector-content.js'],
    });
    return askPageForSelector(tab.id);
  } catch {
    return false;
  }
}

async function openSelectorOn(tabId: number | undefined): Promise<boolean> {
  const tab = tabId === undefined
    ? (await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []))[0]
    : await chrome.tabs.get(tabId).catch(() => undefined);
  return injectSelector(tab);
}
chrome.runtime.onStartup.addListener(() => void refreshPrefs());

chrome.commands.onCommand.addListener((cmd, tab) => {
  if (cmd === 'pin-interest' || cmd === 'pin-struggle') {
    void pin(tab, cmd === 'pin-struggle' ? 'struggle' : 'interest', {
      recoverMenuSelection: false,
    });
  }
});

// The design contract put a pin on this click, and it is off it again: see
// `action-popup.ts` for why. Chrome opens `action.default_popup` itself and
// `action.onClicked` never fires, so there is deliberately no listener here —
// one would be a dead path that reads like a live one.

chrome.contextMenus.onClicked.addListener((info, tab) => {
  // A side panel belongs to a window, and the click carries the tab it came
  // from. Nothing waits on it: `open` needs the user gesture we are inside, and
  // an older Chrome without it must not throw out of a void listener.
  if (info.menuItemId === OPEN_BOARD_ID) {
    return void boardPageUrl().then((url) => chrome.tabs.create({ url })).catch(() => {});
  }

  if (info.menuItemId === OPEN_PANEL_ID && tab?.windowId !== undefined) {
    return void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }

  const mode = modeFor(info.menuItemId);
  if (!mode) return;
  return void runMode(mode, tab);
});

/**
 * One mode, run.
 *
 * The three that open something have to open it **here**, synchronously, while
 * the click that authorised them is still a gesture: `sidePanel.open` is
 * refused a microtask later, which is the defect this file already carries one
 * scar from. Everything after that is ordinary asynchronous work.
 */
function runMode(mode: PinMode, tab: chrome.tabs.Tab | undefined): void {
  if (mode.action === 'learn' || mode.action === 'guide') {
    // The panel first and the pin second, because only one of the two has a
    // deadline. The hand-off it opens onto has no pin id in it yet; `pin`
    // writes one in when the service answers, and the panel is waiting for
    // exactly that. See `learn-now.ts`.
    const at = Date.now();
    const intent = mode.action === 'guide' ? 'guide' : 'take';
    const pending = pendingHandoff(null, at, intent);
    const written = handoff.write(pending);
    if (tab?.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
    void written.then(() => announceHandoff(pending)).catch(() => {});
    void pin(tab, 'interest', {
      announce: false, recoverMenuSelection: true,
    }).then((sent) => {
      void handoff.write(sent?.id
        ? handoffFor(sent.id, sent.label, at, intent)
        : failedHandoff(sent?.label ?? null, at, intent));
    });
    return;
  }

  if (mode.action === 'compose') {
    // Capture now, while the page is certainly still the page they were
    // looking at, then hand the whole envelope to the box. Nothing is held
    // here across the wait: MV3 kills a worker that is waiting for a person,
    // and the box sends everything back in one message when it is done.
    // Start capture immediately so the selection cannot age while storage is
    // read. The theme request travels beside it and changes presentation only.
    const captured = capturedFor(tab);
    const storedTheme: Promise<Record<string, unknown>> = local.get(THEME_KEY)
      .catch((): Record<string, unknown> => ({}));
    void Promise.all([captured, storedTheme]).then(([envelope, stored]) => {
      if (!envelope || !tab?.id) return;
      const refusal = captureRefusal(envelope);
      if (refusal) return void showRefusal(tab.id, refusal);
      void chrome.scripting.executeScript({
        target: { tabId: tab.id },
        // Serialised, so the module is reached by url and the message goes out
        // through the page's own `chrome.runtime`, which the isolated world has.
        func: (url: string, e: unknown, theme: unknown) => {
          void import(url).then((m: {
            openPinBox: (env: unknown, send: (msg: unknown) => void, rawTheme: unknown) => void;
          }) => {
            m.openPinBox(e, (msg) => chrome.runtime.sendMessage(msg), theme);
          });
        },
        args: [chrome.runtime.getURL('dist/pin-box.js'), envelope, stored[THEME_KEY]],
      }).catch(() => {});
    });
    return;
  }

  if (mode.action === 'select') {
    // Nothing is captured here. The picker sets the page's own selection
    // around each thing chosen and calls the shipped `capture` itself, so a
    // pin made this way is the same pin as one made by dragging across the
    // same paragraph, by construction rather than by inspection.
    // `mayScript` rather than `capturePermitted`: the popup reaches this with a
    // tab it may not be able to read the url of, and opening the picker is not
    // a pin. See `prefs.ts`.
    void injectSelector(tab);
    return;
  }

  void pin(tab, 'interest', {
    recoverMenuSelection: true,
    allowWholePage: mode.id === WHOLE_PAGE_MODE_ID,
  });
}

/** What the confirmation quotes, built the same way from every path that
 *  makes a pin. A second copy of this decision is how one of them stops
 *  quoting, or starts quoting the wrong string. */
const quoteOf = (envelope: CapturedEnvelope): SavedQuote => {
  const wholePage = savedFromPage(envelope);
  return {
    quote: savedQuote(envelope),
    wholePage,
    // Exact selected text is its own confirmation. Browser recovery and
    // watcher state are implementation details, not useful learner copy.
    // Whole-page capture remains explicit because it changes what was saved.
    pageNote: wholePage ? WHOLE_PAGE_NOTE : null,
  };
};

/** The capture half of `pin`, on its own, for the modes that do something with
 *  the envelope before anything is posted. */
async function capturedFor(tab: chrome.tabs.Tab | undefined): Promise<CapturedEnvelope | null> {
  if (!tab?.id || !capturePermitted(tab.url)) return null;
  const injected = await chrome.scripting
    .executeScript({ target: { tabId: tab.id }, func: capture, args: [true] })
    .catch(() => []);
  return (injected[0]?.result as CapturedEnvelope | undefined) ?? null;
}

/**  refusal, said the same way from every path that can hit it. */
function showRefusal(tabId: number, refusal: string): void {
  void chrome.scripting.executeScript({
    target: { tabId }, func: showToast, args: [refusal],
  }).catch(() => {});
}

/**
 * Post every pick, then say how many landed.
 *
 * The refusal check runs per envelope rather than over the batch: one PDF
 * frame among four paragraphs should cost that one pick and nothing else.
 */
async function finishSelection(tabId: number, chosen: readonly unknown[]): Promise<void> {
  await announceSelection({ kind: SELECT_STATUS, tabId, state: 'saving', count: chosen.length, queued: 0 });
  await chrome.scripting.executeScript({
    target: { tabId }, func: showToast, args: [initialToastText('interest')],
  }).catch(() => {});

  let landed = 0;
  let queued = 0;
  let first: CapturedEnvelope | null = null;
  let lesson: ReturnType<typeof handoffFor> | null = null;
  let newestSessionPin: CaptureSessionPin | null = null;
  const ownerUid = await queueOwnerUid();
  for (const envelope of chosen) {
    const e = envelope as CapturedEnvelope;
    if (captureRefusal(e)) continue;
    const body = buildPinBody('interest', e, new Date().toISOString());
    const sent = await postPin(body);
    if (!sent.ok) { await keepPending(body, ownerUid); queued += 1; }
    const held = await holdSessionPin(sent, e, ownerUid, false);
    if (held) newestSessionPin = held;
    // One deliberate passage has one unambiguous next screen. A multi-pick
    // does not: choosing one of several pins here would silently discard the
    // learner's decision. A queued pin has no service id to teach from yet.
    if (chosen.length === 1 && sent.ok && sent.id) {
      lesson = handoffFor(sent.id, sent.label, Date.now());
      await handoff.write(lesson);
    }
    landed += 1;
    first ??= e;
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    // No take offered on a batch: the quick take is about one passage, and
    // choosing which of five it should be is a decision this surface has no
    // way to ask about.
    //
    // The quotation is the first thing that landed. The line above it already
    // says how many there were, so it reads as the example it is, and it
    // answers the question the learner actually has after picking, which is
    // whether the picker took the blocks they pointed at. Never marked as a
    // whole-page pin: every pick is a selection by construction.
    func: (t: string, saved: SavedQuote | null) => window.__sbFinishToast?.(t, null, saved),
    args: [
      pickedToastText(landed),
      first ? { quote: savedQuote(first), wholePage: false, pageNote: null } : null,
    ],
  }).catch(() => {});
  await announceSelection({
    kind: SELECT_STATUS, tabId, state: 'saved', count: landed, queued,
    ...(lesson?.pinId ? {
      lessonPinId: lesson.pinId,
      lessonLabel: lesson.label,
      lessonAt: lesson.at,
    } : {}),
  });
  if (newestSessionPin) {
    void chrome.runtime.sendMessage({
      kind: CAPTURE_SESSION_ADDED, pinId: newestSessionPin.pinId,
    }).catch(() => {});
  }
}

/** The web-page toast can disappear while the learner is looking at the side
 *  panel. Send the durable outcome to that panel too. No panel is a normal
 *  case for context-menu picking, so an absent receiver is deliberately quiet. */
async function announceSelection(status: SelectStatus): Promise<void> {
  await chrome.runtime.sendMessage(status).catch(() => {});
}

/**
 * Post what the box came back with, and confirm it the way every pin is
 * confirmed.
 *
 * The toast is raised here rather than in the box because the box is gone by
 * now: it closed on the press, which is the right behaviour for a surface the
 * learner has finished with, and the confirmation belongs to the pin rather
 * than to the form.
 */
async function finishCompose(tabId: number, saved: ComposeResult, text: string): Promise<void> {
  const type: PinType = saved.struggle ? 'struggle' : 'interest';
  // The box has already applied both edits, including any correction to the
  // context. The passage is applied again here anyway, because `text` is the
  // field this function validated and refused to post without, and a body
  // built from an envelope that disagreed with it would store something
  // nobody checked. Idempotent where the box did its job.
  const envelope = envelopeWithEdits(saved.envelope, text) as CapturedEnvelope;
  const body = {
    ...buildPinBody(type, envelope, new Date().toISOString()),
    // The service has accepted a note on every pin since it was written and
    // nothing has ever sent one. This is the first.
    note: saved.note ?? null,
    requestedRegister: saved.requestedRegister ?? null,
    requestedMinutes: saved.requestedMinutes ?? null,
  };

  await chrome.scripting.executeScript({
    target: { tabId }, func: showToast, args: [initialToastText(type)],
  }).catch(() => {});

  const ownerUid = await queueOwnerUid();
  const sent = await postPin(body);
  if (!sent.ok) await keepPending(body, ownerUid);
  await holdSessionPin(sent, envelope, ownerUid, true);

  await chrome.scripting.executeScript({
    target: { tabId },
    func: (t: string, offer: LearnNowOffer | null, saved: SavedQuote | null, undo: ToastUndo | null) =>
      window.__sbFinishToast?.(t, offer, saved, undo),
    args: [finalToastText(type, sent), learnNowOffer(sent), quoteOf(envelope), undoFor(sent, ownerUid)],
  }).catch(() => {});
}

/**
 * Pull the service's prefs into the local cache (, ).
 *
 * Single-flight, so a page load, an alarm and a panel edit arriving together
 * make one request and share one answer rather than three writes racing.
 *
 * A failed or unrecognisable response writes nothing at all. Leaving the old
 * copy in place lets it age past `PREFS_MAX_AGE_MS` and stop being believed on
 * its own, which is the fail-closed path; clearing it here would be the same
 * outcome reached less clearly, and writing an empty one would be the opposite
 * outcome reached by accident.
 */
let refreshing: Promise<void> | null = null;
function refreshPrefs(): Promise<void> {
  refreshing ??= (async () => {
    try {
      const r = await serviceFetch('/prefs');
      if (!r.ok) return;
      const next = cacheFrom(await r.json(), Date.now());
      if (next) await prefs.write(next);
    } catch { /* the copy we have ages out; see mayObserve */ }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// MV3 kills this worker whenever it feels like it, so the honest definition of
// "on startup" is "whenever this file is evaluated".
//
// It has to be *here*, below the declaration it reads. `refreshPrefs` is a
// hoisted function but `refreshing` is a `let`, so calling it from above that
// line threw a ReferenceError while the worker was still being evaluated —
// which in a service worker means the listeners after the call were never
// registered at all. Nothing in the repository could see it: every decision the
// worker makes was already tested as a pure function somewhere else, and this
// file was the one nothing imported. `background-shell.test.ts` imports it now.
void refreshPrefs();

/**
 * The cached prefs, refreshed first if what we hold cannot be believed.
 *
 * The refresh is on the read path because MV3 wakes this worker for the message
 * and may have killed it minutes ago — waiting for the alarm would mean the
 * first page after every wake was answered from a copy we had already decided
 * was too old. If the refresh fails, the copy is still too old, and every
 * predicate downstream says no.
 */
async function readPrefs(now: number): Promise<CachedPrefs | undefined> {
  const cached = await prefs.read();
  if (isFresh(cached, now)) return cached;
  await refreshPrefs();
  return prefs.read();
}

/** What the service said about a pin, or null when there was nothing to send. */
type PinOutcome = { ok: boolean; label: string | null; id: string | null } | null;

async function pin(
  tab: chrome.tabs.Tab | undefined,
  type: PinType,
  opts: {
    /** Suppress the toast. The learn-now mode has already opened the panel,
     *  and a toast offering a take beside a panel already showing one is the
     *  same offer twice. */
    announce?: boolean;
    /** Only a context-menu action may consume the pre-menu selection snapshot. */
    recoverMenuSelection?: boolean;
    /** The opt-in whole-page menu is the only route allowed to save an
     * unselected page. */
    allowWholePage?: boolean;
  } = {},
): Promise<PinOutcome> {
  // The learner-confirmation contract: a pin is a deliberate gesture and outranks both the exclusion
  // list and a pause, which govern what is watched rather than what is asked
  // for. See `capturePermitted`.
  if (!tab?.id || !capturePermitted(tab.url)) return null;

  // Injection fails on more pages than it succeeds on being refused: a tab that
  // navigated or closed between the keystroke and the injection, the Web Store,
  // a `chrome://` page, a PDF viewer. There is nothing to capture on any of
  // them, so this is a shrug — but an uncaught one would reject out of an event
  // listener that returns void, where nothing is waiting to catch it.
  const injected = await chrome.scripting
    .executeScript({
      target: { tabId: tab.id }, func: capture,
      args: [opts.recoverMenuSelection === true],
    })
    .catch(() => []);
  const envelope = injected[0]?.result;
  if (!envelope) return null;

  // the one capture we refuse rather than store. Said before the
  // confirmation rather than after it, so the learner gets one sentence — the
  // refusal — instead of a promise followed by nothing.
  const refusal = captureRefusal(envelope);
  if (refusal) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: showToast, args: [refusal],
    }).catch(() => {});
    return null;
  }

  if (savedFromPage(envelope) && opts.allowWholePage !== true) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: showToast,
      args: ['Select something first, or use Pick what to pin.'],
    }).catch(() => {});
    return null;
  }

  // The toast is the confirmation, not the capture. A page that will not draw it
  // must not also lose the pin behind it — which is what happened while this
  // await was unguarded: the material was already in hand and the rejection
  // threw it away before it could be posted or queued.
  /**
   * Repair the page for next time, with the access this gesture just granted.
   *
   * `activeTab` gives host access to this tab because the learner invoked the
   * extension, which is exactly the permission a back-fill needs and the
   * reason this does not have to ask for host permissions on every site. The
   * script is
   * idempotent: it returns early where it is already installed, so this is a
   * no-op on every page that was loaded normally.
   */
  if (envelope.selectionWatched === false) {
    void chrome.scripting.executeScript({
      target: { tabId: tab.id }, files: ['selection-content.js'],
    }).catch(() => {});
  }

  const announce = opts.announce !== false;
  if (announce) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: showToast,
      args: [initialToastText(type)],
    }).catch(() => {});
  }

  // the bytes, now, while the page the learner is looking at is
  // certainly still serving them. A hotlink stored here is a promise about
  // somebody else's server that the nightly has to collect on hours later, and
  // the field it goes in says in as many words that it is never a hotlink.
  const body = buildPinBody(type, envelope, new Date().toISOString());

  const ownerUid = await queueOwnerUid();
  const sent = await postPin(body);
  if (!sent.ok) await keepPending(body, ownerUid);
  await holdSessionPin(sent, envelope, ownerUid, announce);

  if (announce) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      // the confirmation grows one affordance, and only when there is
      // something behind it, a pin the service took and named an id for. The
      // offer is an argument rather than a closure for the same reason the
      // toast text is: injected functions are serialised, and nothing crosses
      // that boundary except data.
      func: (t: string, offer: LearnNowOffer | null, saved: SavedQuote | null, undo: ToastUndo | null) =>
        window.__sbFinishToast?.(t, offer, saved, undo),
      args: [
        finalToastText(type, sent),
        learnNowOffer(sent),
        quoteOf(envelope),
        undoFor(sent, ownerUid),
      ],
    }).catch(() => {});
  }
  return sent;
}

async function postPin(
  body: unknown, fixedToken?: string | null,
): Promise<{ ok: boolean; label: string | null; id: string | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500); // toast budget, not a network budget
  try {
    const init: RequestInit = {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: ctrl.signal,
    };
    const r = fixedToken === undefined
      ? await serviceFetch('/pins', init)
      : await serviceFetchAs('/pins', fixedToken, init);
    if (!r.ok) throw new Error(String(r.status));
    const answered = (await r.json()) as { label?: string; id?: string };
    return {
      ok: true,
      label: answered.label ?? null,
      // The id is what the quick take is addressed by. A 200 without one is
      // still a pin that landed — the drain must not send it again — and it is
      // not a pin anything can offer a take against.
      id: typeof answered.id === 'string' && answered.id ? answered.id : null,
    };
  } catch {
    return { ok: false, label: null, id: null };
  } finally {
    // In a `finally` because the offline path is the common one and it was the
    // one that never cleared: a pin made with the service down left a 2.5s timer
    // holding a worker awake that Chrome was otherwise free to suspend.
    clearTimeout(timer);
  }
}

/**
 * The re-read detector's only route in and out.
 *
 * MV3 content scripts do not carry the extension's host permissions, so the
 * detector cannot talk to the service itself. Everything it needs goes through
 * here: whether it is welcome on this origin, and the one candidate it raises.
 * The behavioural trace never arrives — it stays in the page and dies with it.
 */
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  const msg = message as {
    kind?: string; origin?: string; candidate?: RereadCandidate;
    pinId?: string; label?: string | null; tabId?: number; clientRef?: unknown; ownerUid?: unknown;
  };
  if (msg?.kind === REREAD_PREFS) {
    void quietedOn(msg.origin ?? '').then((quieted) => respond({ quieted } satisfies RereadPrefsReply));
    return true; // an async reply is coming
  }
  if (msg?.kind === OPEN_SELECTOR) {
    void openSelectorOn(msg.tabId).then((ok) => respond({ ok }));
    return true;
  }
  if (msg?.kind === EXPERIMENTAL_CAPTURE_CHANGED) {
    void rebuildMenu().then(() => respond({ ok: true }), () => respond({ ok: false }));
    return true;
  }
  if (msg?.kind === QUEUE_RETRY && typeof msg.clientRef === 'string' && msg.clientRef) {
    void retryPending(queue, msg.clientRef, postOwnedQueued)
      .then((state) => respond({ state }), () => respond({ state: 'waiting' }));
    return true;
  }
  if (msg?.kind === QUEUE_REMOVE && typeof msg.clientRef === 'string' && msg.clientRef) {
    void queueScope()
      .then((scope) => removePending(queue, msg.clientRef as string,
        (item) => queueItemBelongsTo(item, scope.authConfigured, scope.uid)))
      .then((removed) => respond({ removed }), () => respond({ removed: false }));
    return true;
  }
  if (msg?.kind === PIN_UNDO && typeof msg.pinId === 'string' && msg.pinId) {
    void undoSavedPin(msg.pinId, msg.ownerUid)
      .then(async (ok) => {
        if (ok) await removeSessionPin(msg.pinId as string, msg.ownerUid);
        respond({ ok });
      }, () => respond({ ok: false }));
    return true;
  }
  if (msg?.kind === REREAD_CANDIDATE && msg.candidate) {
    void postSuggestion(msg.candidate).then((ok) => respond({ ok }));
    return true;
  }
  // The panel has just changed something the detector obeys — a pause, the
  // off-limits list, or a rejection that raised an origin's count. Waiting up to
  // five minutes for the alarm would mean a learner can press Pause and watch
  // the next page be observed anyway.
  /**
   *  — the tap on the toast, on its way to the panel.
   *
   * Two halves, and only one of them can fail. The hand-off is the durable
   * one: whenever the panel next opens, it opens on this take. Opening it
   * *now* is best-effort — but best-effort means asking properly and being
   * refused, and for the whole of this feature's life it meant not asking at
   * all. The gesture does survive the trip from the page's click handler
   * through `runtime.sendMessage`; what killed it was this handler awaiting
   * the storage write before it asked. Chrome ends a gesture when control
   * returns to the event loop, so the open was refused every time, and the
   * `.catch(() => {})` made the refusal silent: the learner tapped *Learn it
   * now?* and got nothing whatsoever. Found by using it, 2026-08-22.
   *
   * So both calls are made here, synchronously, in this order and with no
   * `await` between them — the order is the fix and it is load-bearing twice
   * over. The write goes first so a panel that opens at once finds the
   * hand-off already waiting rather than racing it to an ordinary home
   * screen. The open goes second and un-awaited, because a gesture spends the
   * moment this function returns. Anything awaited between them puts the bug
   * straight back, which is what `background-shell.test.ts` now pins.
   *
   * Where Chrome still refuses — no window to open into, a build that does not
   * have the API — the learner gets the take the moment they open the panel
   * themselves, rather than an error about a browser rule they cannot see, and
   * the reply says which of the two happened.
   *
   * No pause check, deliberately: the learner-action contract. A pause stops what is watched, and
   * this is a button the learner pressed on a pin they made by hand.
   */
  if (msg?.kind === LEARN_NOW && typeof msg.pinId === 'string' && msg.pinId) {
    const pinId = msg.pinId;
    const windowId = (_sender as { tab?: { windowId?: number } })?.tab?.windowId;
    const next = handoffFor(pinId, msg.label ?? null, Date.now());
    const written = handoff.write(next);
    const opened: Promise<boolean> = windowId === undefined
      ? Promise.resolve(false)
      : chrome.sidePanel.open({ windowId }).then(() => true, () => false);
    void written.then(() => announceHandoff(next)).catch(() => {});
    void written
      .then(() => opened)
      .then((ok) => respond({ ok: true, opened: ok }))
      .catch(() => respond({ ok: false, opened: false }));
    return true;
  }
  /**
   * Standard's box, coming back with the learner's edits on it.
   *
   * Everything needed is in the message, deliberately: the box may have been
   * open for minutes and this worker may have been killed and restarted in
   * that time, so a pin that depended on anything held here would be lost
   * exactly when somebody had spent the most attention on it.
   *
   * From here it is an ordinary pin. Same body builder, same post, same queue
   * on failure, same toast — a second route with its own copy of that sequence
   * is how one of them quietly stops queueing.
   */
  if (msg?.kind === COMPOSE_SAVE) {
    const saved = message as unknown as ComposeResult;
    const text = typeof saved.text === 'string' ? saved.text.trim() : '';
    const tabId = (_sender as { tab?: { id?: number } })?.tab?.id;
    if (!text || tabId === undefined) { respond({ ok: false }); return true; }
    void finishCompose(tabId, saved, text).then(() => respond({ ok: true }), () => respond({ ok: false }));
    return true;
  }
  /**
   * The picker, coming back with one envelope per thing chosen.
   *
   * Each becomes its own pin: two paragraphs about two things are two things
   * to learn, and whether they belong together is the Clusterer's question
   * rather than the picker's. Posted in order and confirmed once, because five
   * toasts for one gesture is five confirmations of a decision made once.
   */
  if (msg?.kind === SELECT_SAVE) {
    const chosen = (message as unknown as SelectResult).envelopes;
    const tabId = (_sender as { tab?: { id?: number } })?.tab?.id;
    if (!Array.isArray(chosen) || !chosen.length || tabId === undefined) { respond({ ok: false }); return true; }
    void finishSelection(tabId, chosen).then(
      () => respond({ ok: true }),
      () => {
        void announceSelection({ kind: SELECT_STATUS, tabId, state: 'failed', count: 0, queued: 0 });
        respond({ ok: false });
      },
    );
    return true;
  }
  if (msg?.kind === PREFS_CHANGED) {
    void refreshPrefs().then(() => respond({ ok: true }));
    return true;
  }
  return false;
});

/**
 * Three reasons to stay silent, answered from one copy of the prefs.
 *
 *  is the rejection count;  are pause and exclusions. All three now
 * arrive in the same cached read, so there is one age to reason about instead of
 * a local check followed by a live fetch that could disagree with it.
 *
 * The fourth reason is not knowing. A cache that is absent, unstamped or stale
 * means we cannot say whether this site is off limits, and a detector that keeps
 * watching while it cannot check has broken the guarantee that makes it
 * acceptable to run on every page at all.
 */
async function quietedOn(origin: string): Promise<boolean> {
  if (!origin) return true;
  // Virgil is a reader of other pages, never of itself. The hosted page is
  // served from the configured service origin, so a self-hosted installation
  // cannot be named here as a literal. Without this boundary the content
  // script eventually proposed Virgil's own footer warning as learner
  // material every time the Board was opened.
  if (origin === await serviceBase()) return true;
  // Two reads of the clock, deliberately. The first asks whether what we already
  // hold is too old to believe; the second judges what we hold *now*. Using one
  // timestamp for both meant that whenever the read path did refresh, the copy
  // that came back was stamped a millisecond or two after the question was
  // asked — and `isFresh` refuses a stamp from the future, correctly, because a
  // clock it cannot trust is an age it cannot read. So a successful refresh
  // answered "quieted" on the very page it was fetched for: every wake with a
  // stale cache silenced the detector on the first page, for no reason anyone
  // could have found without running the worker.
  const prefs = await readPrefs(Date.now());
  return !detectorMayObserve(prefs, origin, Date.now());
}

/** A candidate, never a pin. The learner confirms it in the panel (). */
async function postSuggestion(candidate: RereadCandidate): Promise<boolean> {
  try {
    const r = await serviceFetch('/suggestions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        passage: candidate.passage,
        url: candidate.url,
        reason: candidate.reason,
        pageTitle: candidate.pageTitle,
        headingPath: candidate.headingPath,
      }),
    });
    return r.ok;
  } catch { return false; }
}

/** Drain the offline queue whenever we get a chance, and keep the prefs current. */
const DRAIN_ALARM = 'sb-drain';
const PREFS_ALARM = 'sb-prefs';

chrome.alarms.create(DRAIN_ALARM, { periodInMinutes: 1 });
chrome.alarms.create(PREFS_ALARM, { periodInMinutes: PREFS_REFRESH_MINUTES });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === PREFS_ALARM) return void refreshPrefs();
  if (alarm.name !== DRAIN_ALARM) return;
  await drainPending(queue, postOwnedQueued);
});
