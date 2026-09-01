/**
 * The `chrome.*` surface the extension actually touches, and nothing else.
 *
 * The extension has never been loaded in a browser. Everything below the shell
 * — thresholds, predicates, copy, the queue — is tested as pure functions, and
 * the shell itself (listeners, injection, messaging, alarms, the cache write)
 * had never executed once: `background.ts` was a file nothing imported.
 *
 * This stub exists so it can. It is deliberately small and deliberately
 * hand-rolled — no jsdom, no sinon-chrome, no dependency at all — and it mocks
 * exactly the members the shipped code calls, listed here so the list can be
 * checked against the source:
 *
 *   storage.local.get/set   runtime.onInstalled/onStartup/onMessage/sendMessage
 *   runtime.getURL          contextMenus.create/onClicked
 *   identity.getAuthToken
 *   commands.onCommand      sidePanel.setPanelBehavior/open
 *   scripting.executeScript alarms.create/onAlarm
 *   action.onClicked        tabs.create
 *
 * And one thing that is not `chrome.*` at all: `navigator.clipboard`. The panel
 * is an extension page rather than a worker, and UX_SPEC §5d's hand-off writes
 * to the clipboard from a click handler. It is installed here because it is the
 * same kind of ambient browser surface as the rest of this file — and because a
 * clipboard that refuses is a case the panel has to have an answer for.
 *
 * Two things are modelled rather than stubbed, because they are where the
 * shell's behaviour lives:
 *
 *  - **Message dispatch.** `sendMessage` walks the registered listeners the way
 *    Chrome does: a listener that returns `true` keeps the reply channel open,
 *    the first `respond` wins, and a message nobody claims rejects with the
 *    "receiving end does not exist" error rather than resolving to undefined.
 *    That last part is the difference between a content script that fails quiet
 *    and one that fails loud, so it must not be papered over.
 *  - **Injection.** `executeScript` records what was injected and returns
 *    whatever the test says the page returned, including a rejection — a real
 *    injection fails whenever the tab navigated, closed, or is a page the
 *    extension may not touch.
 *
 * It cannot tell you the extension loads. It can tell you that the code behind
 * those listeners does what it claims once it is running.
 */

type AnyFn = (...args: never[]) => unknown;

export interface FakeEvent<F extends AnyFn> {
  addListener(fn: F): void;
  removeListener(fn: F): void;
  readonly listeners: F[];
}

function fakeEvent<F extends AnyFn>(): FakeEvent<F> {
  const listeners: F[] = [];
  return {
    addListener: (fn: F) => { listeners.push(fn); },
    removeListener: (fn: F) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    listeners,
  };
}

/** One `executeScript` call, as the shell made it. */
export interface Injection {
  tabId: number | undefined;
  func: AnyFn | undefined;
  args: unknown[];
  /** `executeScript({files})` rather than `{func}`: how the worker back-fills
   *  the selection listener into a page that was open before it was. Modelled
   *  because a test that could not see it could not tell a repaired page from
   *  one left broken. */
  files: string[] | undefined;
}

/** One request the shell made, with the body already parsed back out of JSON. */
export interface Request {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  /** Present on the responses the worker reads as bytes rather than as JSON. */
  headers?: { get(name: string): string | null };
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export function jsonResponse(body: unknown, status = 200): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/**
 * A response the worker will read as an image (SB-09).
 *
 * The capture path fetches the bytes of a pinned diagram itself, so the stub
 * has to be able to answer with something other than JSON. `content-length` is
 * deliberately not set: it is optional in the wild, and the code must not
 * depend on it being there.
 */
export function imageResponse(
  bytes: Uint8Array, type: string | null = 'image/png', status = 200,
): FakeResponse {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => { throw new SyntaxError('not json'); },
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: async () => buffer,
  };
}

/** A 200 whose body is not JSON at all — the shell must survive parsing it. */
export function badJsonResponse(status = 200): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => { throw new SyntaxError('not json'); } };
}

export type FetchHandler = (url: string, init: RequestInit | undefined) => Promise<FakeResponse> | FakeResponse;

export interface ChromeStub {
  /** Everything `chrome.storage.local` holds, readable and writable by the test. */
  readonly store: Record<string, unknown>;
  /** Temporary extension state, cleared when this simulated browser session ends. */
  readonly sessionStore: Record<string, unknown>;
  readonly menus: { id?: string; title?: string; contexts?: readonly string[] }[];
  readonly alarms: { name: string; periodInMinutes?: number }[];
  readonly injections: Injection[];
  readonly requests: Request[];
  readonly panelBehaviour: { openPanelOnActionClick?: boolean }[];
  /**
   * Every `sidePanel.open` the worker asked for, with what it named — and
   * whether the gesture that authorised it was still alive when it asked.
   * `gesture: false` is a call Chrome refuses; see `gestureBound`.
   */
  readonly panelOpens: { windowId?: number; tabId?: number; gesture: boolean }[];
  /** Every tab the panel asked Chrome to open (UX_SPEC §5d). */
  readonly tabsCreated: { url?: string }[];
  /** Known tabs Virgil asked Chrome to restore; no enumeration is involved. */
  readonly tabsUpdated: { id: number; url?: string; active?: boolean }[];
  /** Messages sent to a declared content script on one exact page. */
  readonly tabMessages: { tabId: number; message: unknown }[];
  /** Messages an extension context broadcast to its sibling contexts. */
  readonly runtimeMessages: unknown[];
  /**
   * Every window the panel asked Chrome to open (§6f-i's side-by-side
   * forwarding). Recorded whole rather than by url, because the geometry IS the
   * feature: a popup that opens at the wrong size or on top of the lesson is
   * not side by side, and a test that only read the url would agree with it.
   */
  readonly windowsCreated: PopupWindow[];
  /** Everything written to the clipboard, in order. */
  readonly clipboard: string[];
  /** Set by the test: what the page returned from the n-th injection. */
  injectResult: (injection: Injection, index: number) => unknown;
  /** Set by the test: what the service answered. Defaults to a 200 with prefs. */
  fetchHandler: FetchHandler;
  /** Fire the listeners the shell registered. */
  fire: {
    installed(): Promise<void>;
    startup(): Promise<void>;
    command(name: string, tab?: unknown): Promise<void>;
    menuClick(info: unknown, tab?: unknown): Promise<void>;
    /** The toolbar capture contract: the toolbar button is a capture surface of its own. */
    actionClick(tab?: unknown): Promise<void>;
    alarm(name: string): Promise<void>;
  };
  /** A message from a content script or the panel, answered the way Chrome does. */
  send(message: unknown, sender?: unknown): Promise<unknown>;
  /** How many listeners are registered on each event, for the wiring assertions. */
  readonly counts: () => Record<string, number>;
  uninstall(): void;
}

/** What `chrome.windows.create` was asked for. */
export interface PopupWindow {
  url?: string; type?: string; width?: number; height?: number;
  left?: number; top?: number; focused?: boolean;
}

export interface ChromeStubOptions {
  /** What `chrome.storage.local` already holds when the worker wakes. */
  store?: Record<string, unknown>;
  /** What `chrome.storage.session` already holds in this browser session. */
  sessionStore?: Record<string, unknown>;
  /** Tabs `chrome.tabs.get` can find, by id. Anything else rejects, as Chrome does. */
  tabsById?: Record<number, { id: number; url?: string; windowId?: number }>;
  /** The active tab returned to a side-panel tool. Absent means no ordinary page is active. */
  activeTab?: { id: number; url?: string; windowId?: number };
  /** False models a tab that predates this extension load and has no selector listener yet. */
  selectorContentReady?: boolean;
  /** Where `chrome.runtime.getURL` points. Defaults to the extension directory. */
  baseUrl?: string;
  /** `sidePanel.setPanelBehavior` rejects — an older Chrome, which the shell catches. */
  sidePanelFails?: boolean;
  /**
   * Model Chrome's user-gesture rule on `sidePanel.open`.
   *
   * `sidePanel.open` may only be called while the gesture that reached the
   * worker is still live, and a gesture does not survive an `await`: control
   * returning to the event loop ends it. The stub therefore treats the gesture
   * as alive only for the synchronous body of the `onMessage` listener, which
   * is exactly the window Chrome gives, and rejects anything asked for after
   * it with the message Chrome uses.
   *
   * Off by default so the existing suite is unchanged; every test that stands
   * behind the toast's tap opening the panel must turn it on, because without
   * it a call that Chrome will always refuse looks green.
   */
  gestureBound?: boolean;
  /** Reads and writes throw, the way a storage quota failure does. */
  storageFails?: boolean;
  /** What Google identity returns to an interactive sign-in. */
  googleToken?: string | null;
  /** Google sign-in is dismissed or otherwise does not finish. */
  googleSignInFails?: boolean;
  /** `navigator.clipboard.writeText` rejects — a panel that lost focus, or a
   *  browser refusing the write. §5d's surface must survive it. */
  clipboardFails?: boolean;
  /** `tabs.create` rejects, the way it does when the extension has no window. */
  tabsFail?: boolean;
  /** Where the learner's window is, which is what a side-by-side popup is
   *  placed relative to. Chrome's own defaults are arbitrary; these are not. */
  currentWindow?: { left?: number; top?: number; width?: number; height?: number };
  /** `windows.create` rejects. A real case on a browser with no window to
   *  parent one to, and the branch §6f-i has to answer for. */
  windowsFail?: boolean;
}

/**
 * Install the stub as `globalThis.chrome` and `globalThis.fetch`, and hand back
 * the handle that drives it. Call `uninstall()` in a `finally`.
 */
export function installChrome(options: ChromeStubOptions = {}): ChromeStub {
  const store: Record<string, unknown> = { ...(options.store ?? {}) };
  const sessionStore: Record<string, unknown> = { ...(options.sessionStore ?? {}) };
  const menus: { id?: string; title?: string; contexts?: readonly string[] }[] = [];
  const alarms: { name: string; periodInMinutes?: number }[] = [];
  const injections: Injection[] = [];
  const requests: Request[] = [];
  const panelBehaviour: { openPanelOnActionClick?: boolean }[] = [];
  const panelOpens: { windowId?: number; tabId?: number; gesture: boolean }[] = [];
  const tabsCreated: { url?: string }[] = [];
  const tabsUpdated: { id: number; url?: string; active?: boolean }[] = [];
  const tabMessages: { tabId: number; message: unknown }[] = [];
  const runtimeMessages: unknown[] = [];
  const windowsCreated: PopupWindow[] = [];
  const clipboard: string[] = [];
  const selectorReady = new Set<number>();
  if (options.selectorContentReady !== false) {
    if (options.activeTab?.id !== undefined) selectorReady.add(options.activeTab.id);
    for (const id of Object.keys(options.tabsById ?? {})) selectorReady.add(Number(id));
  }

  const onInstalled = fakeEvent<AnyFn>();
  const onStartup = fakeEvent<AnyFn>();
  const onMessage = fakeEvent<AnyFn>();
  const onCommand = fakeEvent<AnyFn>();
  const onMenuClicked = fakeEvent<AnyFn>();
  const onActionClicked = fakeEvent<AnyFn>();
  const onAlarm = fakeEvent<AnyFn>();
  const onStorageChanged = fakeEvent<AnyFn>();

  const base = options.baseUrl ?? new URL('../../', import.meta.url).href;

  const stub: ChromeStub = {
    store,
    sessionStore,
    menus,
    alarms,
    injections,
    requests,
    panelBehaviour,
    panelOpens,
    tabsCreated,
    tabsUpdated,
    tabMessages,
    runtimeMessages,
    windowsCreated,
    clipboard,
    injectResult: () => undefined,
    fetchHandler: () => jsonResponse({ excludedDomains: [], rejectedOrigins: {}, pausedUntil: null }),
    fire: {
      async installed() { await Promise.all(onInstalled.listeners.map((fn) => (fn as () => unknown)())); },
      async startup() { await Promise.all(onStartup.listeners.map((fn) => (fn as () => unknown)())); },
      // The three that are a person doing something. Each carries a gesture,
      // and each carries it only as far as the synchronous body of its
      // listener — see `gestureBound` and `withGesture`.
      async command(name, tab) {
        await withGesture(() => onCommand.listeners.map((fn) =>
          (fn as unknown as (n: string, t: unknown) => unknown)(name, tab)));
      },
      async menuClick(info, tab) {
        await withGesture(() => onMenuClicked.listeners.map((fn) =>
          (fn as unknown as (i: unknown, t: unknown) => unknown)(info, tab)));
      },
      async actionClick(t) {
        await withGesture(() => onActionClicked.listeners.map((fn) =>
          (fn as unknown as (tab: unknown) => unknown)(t)));
      },
      async alarm(name) {
        await Promise.all(onAlarm.listeners.map((fn) =>
          (fn as unknown as (a: { name: string }) => unknown)({ name })));
      },
    },
    send: (message, sender) => dispatch(message, sender),
    counts: () => ({
      onInstalled: onInstalled.listeners.length,
      onStartup: onStartup.listeners.length,
      onMessage: onMessage.listeners.length,
      onCommand: onCommand.listeners.length,
      onMenuClicked: onMenuClicked.listeners.length,
      onActionClicked: onActionClicked.listeners.length,
      onAlarm: onAlarm.listeners.length,
    }),
    uninstall: () => { Object.assign(globalThis, previous); },
  };

  /**
   * What Chrome does with `runtime.sendMessage`: every listener sees it, one
   * `respond` wins, `true` means an answer is still coming, and a message no
   * listener claims is an error at the sender rather than a silent undefined.
   */
  /**
   * Is the gesture that arrived with the current message still spendable?
   *
   * True only inside the synchronous run of the listeners. See `gestureBound`.
   */
  let gestureLive = false;

  /**
   * Run the synchronous half of a user-initiated dispatch with the gesture
   * alive, then await whatever it started with the gesture already spent.
   */
  async function withGesture(run: () => unknown[]): Promise<void> {
    gestureLive = true;
    let started: unknown[];
    try { started = run(); } finally { gestureLive = false; }
    await Promise.all(started);
  }

  function dispatch(message: unknown, sender: unknown = {}): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let keepOpen = false;
      const respond = (reply: unknown): void => {
        if (settled) return;
        settled = true;
        resolve(reply);
      };
      gestureLive = true;
      try {
        for (const fn of [...onMessage.listeners]) {
          const kept = (fn as unknown as (m: unknown, s: unknown, r: (x: unknown) => void) => unknown)(
            message, sender, respond,
          );
          if (kept === true) keepOpen = true;
        }
      } finally {
        // The listener has returned; anything it kicked off runs from here on
        // in a task of its own, and Chrome's gesture does not reach that far.
        gestureLive = false;
      }
      if (!settled && !keepOpen) {
        reject(new Error('Could not establish connection. Receiving end does not exist.'));
      }
    });
  }

  const writeStorage = (
    target: Record<string, unknown>, items: Record<string, unknown>, area: 'local' | 'session',
  ): void => {
    const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
    for (const [key, value] of Object.entries(items)) {
      changes[key] = {
        ...(key in target ? { oldValue: structuredClone(target[key]) } : {}),
        newValue: structuredClone(value),
      };
    }
    Object.assign(target, structuredClone(items));
    for (const listener of [...onStorageChanged.listeners]) {
      (listener as unknown as (
        changed: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string,
      ) => unknown)(changes, area);
    }
  };

  const storage = {
    onChanged: onStorageChanged,
    local: {
      async get(key: string): Promise<Record<string, unknown>> {
        if (options.storageFails) throw new Error('storage unavailable');
        return key in store ? { [key]: store[key] } : {};
      },
      async set(items: Record<string, unknown>): Promise<void> {
        if (options.storageFails) throw new Error('storage unavailable');
        writeStorage(store, items, 'local');
      },
    },
    session: {
      async get(key: string): Promise<Record<string, unknown>> {
        if (options.storageFails) throw new Error('storage unavailable');
        return key in sessionStore ? { [key]: sessionStore[key] } : {};
      },
      async set(items: Record<string, unknown>): Promise<void> {
        if (options.storageFails) throw new Error('storage unavailable');
        writeStorage(sessionStore, items, 'session');
      },
    },
  };

  const chromeStub = {
    storage,
    identity: {
      getAuthToken: async (): Promise<{ token?: string }> => {
        if (options.googleSignInFails) throw new Error('Google sign-in did not finish');
        const token = options.googleToken === undefined
          ? 'test-google-token'
          : options.googleToken;
        return token === null ? {} : { token };
      },
    },
    runtime: {
      onInstalled,
      onStartup,
      onMessage,
      sendMessage: (message: unknown) => {
        runtimeMessages.push(message);
        return dispatch(message, { id: 'stub' });
      },
      getURL: (path: string) => new URL(path, base).href,
      id: 'stub-extension-id',
    },
    contextMenus: {
      create: (props: { id?: string; title?: string; contexts?: readonly string[] }) => { menus.push(props); },
      // Chrome's own contract: a duplicate id is refused, so what the menu
      // holds after two installs is the question this stub has to be able to
      // answer. Cleared synchronously, then the callback, which is the order
      // the real one guarantees.
      removeAll: (done?: () => void) => { menus.length = 0; done?.(); },
      onClicked: onMenuClicked,
    },
    commands: { onCommand },
    action: { onClicked: onActionClicked },
    sidePanel: {
      setPanelBehavior: async (behaviour: { openPanelOnActionClick?: boolean }) => {
        panelBehaviour.push(behaviour);
        if (options.sidePanelFails) throw new Error('setPanelBehavior is not available');
      },
      open: async (target: { windowId?: number; tabId?: number }) => {
        panelOpens.push({ ...target, gesture: gestureLive });
        if (options.gestureBound && !gestureLive) {
          throw new Error('`sidePanel.open()` may only be called in response to a user gesture.');
        }
        if (options.sidePanelFails) throw new Error('sidePanel.open is not available');
      },
    },
    scripting: {
      executeScript: async (details: {
        target?: { tabId?: number }; func?: AnyFn; args?: unknown[]; files?: string[];
      }) => {
        const injection: Injection = {
          tabId: details.target?.tabId,
          func: details.func,
          args: details.args ?? [],
          files: details.files,
        };
        injections.push(injection);
        if (details.files?.includes('selector-content.js') && details.target?.tabId !== undefined) {
          selectorReady.add(details.target.tabId);
        }
        const result = await stub.injectResult(injection, injections.length - 1);
        return [{ result }];
      },
    },
    alarms: {
      create: (name: string, info: { periodInMinutes?: number }) => {
        alarms.push({ name, ...info });
      },
      onAlarm,
    },
    windows: {
      // Where the learner's window is. §6f-i reads it to place a popup beside
      // the lesson rather than on top of it.
      getCurrent: async () => ({
        id: 1, left: 0, top: 0, width: 1440, height: 900, ...(options.currentWindow ?? {}),
      }),
      create: async (props: PopupWindow) => {
        windowsCreated.push(props);
        if (options.windowsFail) throw new Error('no window to parent a popup to');
        return { id: 7, ...props };
      },
    },
    tabs: {
      create: async (props: { url?: string }) => {
        tabsCreated.push(props);
        if (options.tabsFail) throw new Error('no window to open a tab in');
        return { id: 99, ...props };
      },
      update: async (id: number, props: { url?: string; active?: boolean }) => {
        tabsUpdated.push({ id, ...props });
        if (options.tabsFail) throw new Error(`no tab ${id}`);
        return { id, ...props };
      },
      // What the popup's message turns back into a tab. `url` is deliberately
      // controllable and deliberately allowed to be absent: without the `tabs`
      // permission Chrome omits it unless `activeTab` has been granted, and
      // that absence is the case the worker has to get right.
      get: async (id: number) => {
        const found = options.tabsById?.[id];
        if (!found) throw new Error(`no tab ${id}`);
        return found;
      },
      query: async () => options.activeTab ? [options.activeTab] : [],
      sendMessage: async (tabId: number, message: unknown) => {
        tabMessages.push({ tabId, message });
        if (!selectorReady.has(tabId)) throw new Error('receiving end does not exist');
        return { ok: true };
      },
    },
  };

  const fetchStub = async (input: unknown, init?: RequestInit): Promise<unknown> => {
    const url = String(input);
    const body = init?.body;
    requests.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof body === 'string' ? JSON.parse(body) as unknown : body ?? null,
      headers: (init?.headers as Record<string, string> | undefined) ?? {},
    });
    return stub.fetchHandler(url, init);
  };

  const previous = {
    chrome: (globalThis as Record<string, unknown>)['chrome'],
    fetch: (globalThis as Record<string, unknown>)['fetch'],
  };
  Object.assign(globalThis, { chrome: chromeStub, fetch: fetchStub });

  /**
   * `navigator`, defined rather than assigned.
   *
   * Node ships its own `navigator` as a getter-only own property of the global
   * object, so `Object.assign` throws on it — which would have taken out the
   * whole stub rather than just the clipboard. `defineProperty` replaces it and
   * `uninstall` puts the original descriptor back.
   */
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      clipboard: {
        writeText: async (value: string): Promise<void> => {
          if (options.clipboardFails) throw new Error('the document is not focused');
          clipboard.push(value);
        },
      },
    },
  });
  const restore = stub.uninstall;
  stub.uninstall = (): void => {
    restore();
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete (globalThis as Record<string, unknown>)['navigator'];
  };

  return stub;
}

/**
 * A fresh import of a module that registers listeners when it is evaluated.
 *
 * The service worker is a side effect: importing it *is* installing it, so each
 * test needs its own copy or the second one inherits the first one's listeners,
 * its in-flight refresh and its idea of what time it is. A query string is the
 * only way to get one past the ES module cache, and it is why this helper
 * exists rather than a plain import at the top of the test file.
 */
let generation = 0;
export async function freshImport(specifier: string): Promise<Record<string, unknown>> {
  generation += 1;
  return await import(`${specifier}?stub=${generation}`) as Record<string, unknown>;
}

/** A promise that resolves when the microtask queue has drained a few times. */
export async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}

/** A tab, as the shell receives it from a command, a menu or the toolbar. */
export function tab(
  over: { id?: number | undefined; url?: string | undefined; windowId?: number | undefined } = {},
): unknown {
  return { id: 7, windowId: 3, url: 'https://example.test/page', ...over };
}
