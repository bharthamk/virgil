/**
 * The popup, wired to Chrome.
 *
 * Split from `action-popup.ts` the way `panel.ts` is split from the modules it
 * draws with: the shape of the screen is a pure function over a `Document` and
 * is tested without a browser; this file is the part that can only be run by
 * Chrome, and it is kept small enough to read.
 *
 * **The side panel opens from here, not from the worker.** `sidePanel.open`
 * requires the user gesture it is called inside, and a message round-trip to
 * the service worker spends it — the same defect this extension already
 * carries one scar from, in `background.ts`'s `runMode`. The picker has no such
 * constraint, so it goes to the worker, which already owns that injection: a
 * second copy here is how one of the two quietly stops matching the other.
 */
import { buildActionPopup, canPickOn } from './action-popup.js';
import { learnerLabel, readAuthConfig, readSession, signOut } from './identity.js';
import { OPEN_SELECTOR } from './pin-modes.js';
import {
  chromeQueueStorage, pendingPinView, queueItemBelongsTo, QUEUE_REMOVE, QUEUE_RETRY,
  type RetryPendingResult,
} from './queue.js';
import { boardPageUrl } from './service.js';
import { applyDocumentTheme, normaliseTheme, THEME_KEY } from './theme.js';

async function main(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) return;

  const queue = chromeQueueStorage({
    get: (key) => chrome.storage.local.get(key),
    set: (items) => chrome.storage.local.set(items),
  });
  const [[tab], config, session, theme, rawQueue] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    readAuthConfig(),
    readSession(),
    chrome.storage.local.get(THEME_KEY).catch(() => ({})),
    queue.read().catch(() => []),
  ]);
  const currentTheme = applyDocumentTheme(document, (theme as Record<string, unknown>)[THEME_KEY]);

  const signedIn = config !== null && session !== null;
  const pendingPins = rawQueue
    .filter((item) => queueItemBelongsTo(item, config !== null, session?.uid ?? null))
    .map(pendingPinView)
    .filter((item) => item !== null);
  const built = buildActionPopup(document, {
    // Asked before the control is drawn rather than discovered by a click that
    // does nothing. An unknown url is not a refusal: see `canPickOn`.
    canPick: canPickOn(tab?.url),
    signedIn,
    accountName: learnerLabel(session),
    theme: currentTheme,
    // "Open Virgil" names a destination, not an authentication state. Always
    // open the Learn home; the hosted app owns any sign-in interruption it
    // needs to show. Routing a temporarily unsynchronised extension session to
    // Account makes the same signed-in learner land somewhere they did not ask
    // to go.
    openBoard: () => {
      void boardPageUrl('home')
        .then((url) => chrome.tabs.create({ url }))
        .catch(() => {})
        .then(() => window.close());
    },
    openPanel: () => {
      if (tab?.windowId === undefined) return void window.close();
      void chrome.sidePanel.open({ windowId: tab.windowId })
        .catch(() => {})
        .then(() => window.close());
    },
    pickFromPage: () => {
      // Sent, then closed on the acknowledgement: closing a popup tears down
      // its message port, and the picker is injected by the worker on the
      // other side of it.
      chrome.runtime.sendMessage({ kind: OPEN_SELECTOR, tabId: tab?.id }, () => window.close());
    },
    openManualAdd: () => {
      void boardPageUrl('add-source').then((url) => chrome.tabs.create({ url }))
        .catch(() => {})
        .then(() => window.close());
    },
    openAccount: () => {
      void boardPageUrl('account').then((url) => chrome.tabs.create({ url }))
        .catch(() => {})
        .then(() => window.close());
    },
    switchUser: async () => {
      try {
        const url = await boardPageUrl('switch-user');
        await chrome.tabs.create({ url });
        window.close();
        return null;
      } catch {
        return 'I could not open your Virgil account page. Nothing was changed.';
      }
    },
    signOut: async () => {
      // Clear the extension immediately, then let the hosted route clear its
      // own origin storage and publish that same signed-out state back through
      // the session bridge. One half alone can be undone by the other on the
      // next page load.
      await signOut();
      try {
        const url = await boardPageUrl('sign-out');
        await chrome.tabs.create({ url });
      } catch { /* the extension is still signed out if the page is down */ }
      window.close();
    },
    openSettings: () => {
      void boardPageUrl('settings').then((url) => chrome.tabs.create({ url }))
        .catch(() => {})
        .then(() => window.close());
    },
    setTheme: (raw) => {
      const next = normaliseTheme(raw);
      applyDocumentTheme(document, next);
      void chrome.storage.local.set({ [THEME_KEY]: next }).catch(() => {});
    },
    pendingPins,
    retryPending: async (clientRef): Promise<RetryPendingResult> => {
      try {
        const reply = await chrome.runtime.sendMessage({ kind: QUEUE_RETRY, clientRef }) as
          { state?: unknown } | undefined;
        return reply?.state === 'sent' || reply?.state === 'waiting' || reply?.state === 'missing'
          ? reply.state
          : 'waiting';
      } catch { return 'waiting'; }
    },
    removePending: async (clientRef) => {
      try {
        const reply = await chrome.runtime.sendMessage({ kind: QUEUE_REMOVE, clientRef }) as
          { removed?: unknown } | undefined;
        return reply?.removed === true;
      } catch { return false; }
    },
  });
  app.append(built.root);
}

void main();
