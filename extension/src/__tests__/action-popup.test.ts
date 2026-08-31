import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { installPanelDom, click, text, type El } from './panel-dom.js';

/**
 * Each choice is a button carrying its label AND the line explaining it, so
 * `panel-dom`'s exact-text `button()` does not find it. Matched on the label
 * it leads with, which is what a learner reads first.
 */
const choice = (root: El, label: string): El => {
  const hit = root.querySelectorAll('button').find((b) => text(b).startsWith(label));
  if (!hit) throw new Error(`no choice labelled "${label}" — screen offers: `
    + JSON.stringify(root.querySelectorAll('button').map((b) => text(b))));
  return hit;
};
import {
  ACCOUNT_SETTINGS_HEADING, SIGNED_IN_ACCOUNT_NOTE, SIGNED_OUT_ACCOUNT_NOTE,
  BOARD_LABEL, BOARD_NOTE, PANEL_LABEL, PICK_LABEL, MANUAL_ADD_LABEL, POPUP_HEADING, PICK_UNAVAILABLE,
  QUEUE_HEADING, SETTINGS_LABEL, SIGN_IN_LABEL, SIGN_OUT_LABEL, SWITCH_USER_LABEL, THEME_LABEL,
  buildActionPopup, canPickOn,
} from '../action-popup.js';
import type { PendingPinView, RetryPendingResult } from '../queue.js';
import type { Theme } from '../panel-core.js';
import { mainPageHash, mainPageRoute } from '../surfaces.js';
import { applyDocumentTheme, THEME_KEY } from '../theme.js';


const popup = (t: { after: (f: () => void) => void }, opts: {
  onBoard?: () => void; onPanel?: () => void; onPick?: () => void; onManualAdd?: () => void;
  onAccount?: () => void; onSwitchUser?: () => Promise<string | null>;
  onSignOut?: () => Promise<void>; onSettings?: () => void;
  onTheme?: (theme: Theme) => void; theme?: Theme; accountName?: string | null;
  pendingPins?: readonly PendingPinView[];
  onRetry?: (id: string) => Promise<RetryPendingResult>;
  onRemove?: (id: string) => Promise<boolean>;
  canPick?: boolean; signedIn?: boolean;
} = {}) => {
  const dom = installPanelDom();
  t.after(() => { dom.uninstall(); });
  const built = buildActionPopup(globalThis.document as unknown as Document, {
    canPick: opts.canPick ?? true,
    signedIn: opts.signedIn ?? false,
    accountName: opts.accountName ?? null,
    openBoard: opts.onBoard ?? (() => {}),
    openPanel: opts.onPanel ?? (() => {}),
    pickFromPage: opts.onPick ?? (() => {}),
    openManualAdd: opts.onManualAdd ?? (() => {}),
    openAccount: opts.onAccount ?? (() => {}),
    switchUser: opts.onSwitchUser ?? (async () => null),
    signOut: opts.onSignOut ?? (async () => {}),
    openSettings: opts.onSettings ?? (() => {}),
    theme: opts.theme ?? 'system',
    setTheme: opts.onTheme ?? (() => {}),
    pendingPins: opts.pendingPins ?? [],
    retryPending: opts.onRetry ?? (async () => 'missing'),
    removePending: opts.onRemove ?? (async () => false),
  });
  return built.root as unknown as El;
};

test('the button asks; it does not capture', (t) => {
  const root = popup(t);
  for (const label of [BOARD_LABEL, PANEL_LABEL, PICK_LABEL]) choice(root, label);
  assert.ok(!/pin|snapshot|saved/i.test(POPUP_HEADING),
    'the heading is a question, not an announcement that something was taken');
});

test('the popup is written on the same board as the panel, in the stored theme', (t) => {
  const dom = installPanelDom();
  t.after(() => dom.uninstall());
  assert.equal(THEME_KEY, 'sb_theme');
  assert.equal(applyDocumentTheme(globalThis.document as unknown as Document, 'dark'), 'dark');
  assert.equal(dom.root.attrs.get('data-theme'), 'dark');
  assert.equal(applyDocumentTheme(globalThis.document as unknown as Document, 'unknown'), 'system');
  assert.equal(dom.root.attrs.has('data-theme'), false);

  const css = readFileSync(fileURLToPath(new URL('../../action-popup.css', import.meta.url)), 'utf8');
  assert.match(css, /background-color:\s*var\(--board\)/);
  assert.match(css, /font-family:\s*var\(--hand\)/);
  assert.match(css, /\.popup-choice-label::after/,
    'the actions lost the marker/chalk underline shared with the panel tools');
  assert.doesNotMatch(css, /\.popup-choice\s*\{[^}]*background:\s*var\(--card\)/s,
    'the top-level choices went back to generic cards');
});

test('the board describes the full Virgil space rather than an internal page', (t) => {
  const root = popup(t);
  assert.match(text(choice(root, BOARD_LABEL)), /new tab.*what's next.*plan.*saved/i);
  assert.equal(BOARD_NOTE,
    "Your full Virgil space in a new tab: what's next, your plan and everything you've saved.");
});

test('Open Virgil always targets Learn; the hosted app owns sign-in', () => {
  const main = readFileSync(
    fileURLToPath(new URL('../../src/action-popup-main.ts', import.meta.url)), 'utf8');
  const handler = main.match(/openBoard:\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\},\n\s*openPanel:/)?.[1] ?? '';
  assert.match(handler, /boardPageUrl\('home'\)/);
  assert.doesNotMatch(handler, /signedIn|config|account/,
    'a stale extension session must not change the requested destination');
});

test('the board and the panel are two destinations, not one', async (t) => {

  let board = 0, panel = 0, pick = 0;
  const root = popup(t, {
    onBoard: () => { board++; }, onPanel: () => { panel++; }, onPick: () => { pick++; },
  });

  await click(choice(root, BOARD_LABEL));
  assert.deepEqual([board, panel, pick], [1, 0, 0], 'the board is the page, in a tab');

  await click(choice(root, PANEL_LABEL));
  assert.deepEqual([board, panel, pick], [1, 1, 0], 'and the panel is the panel');
});

test('choosing to pick opens the picker and pins nothing by itself', async (t) => {
  let board = 0, panel = 0, pick = 0;
  const root = popup(t, {
    onBoard: () => { board++; }, onPanel: () => { panel++; }, onPick: () => { pick++; },
  });
  await click(choice(root, PICK_LABEL));
  assert.deepEqual([board, panel, pick], [0, 0, 1]);
});

test('Account & settings is a separate utility section and both doors lead', async (t) => {
  let account = 0, settings = 0;
  const root = popup(t, {
    onAccount: () => { account++; }, onSettings: () => { settings++; },
  });
  assert.match(text(root), new RegExp(`${ACCOUNT_SETTINGS_HEADING}.*${SIGNED_OUT_ACCOUNT_NOTE}`));
  await click(choice(root, SIGN_IN_LABEL));
  await click(choice(root, SETTINGS_LABEL));
  assert.deepEqual([account, settings], [1, 1]);
});

test('a signed-in popup names the account and offers both ways to leave it', async (t) => {
  let switches = 0, outs = 0;
  const root = popup(t, {
    signedIn: true,
    accountName: 'alice@example.com',
    onSwitchUser: async () => { switches++; return null; },
    onSignOut: async () => { outs++; },
  });
  assert.match(text(root), new RegExp(SIGNED_IN_ACCOUNT_NOTE));
  assert.match(text(root), /alice@example\.com/);
  assert.ok(!text(root).includes(SIGNED_OUT_ACCOUNT_NOTE));
  assert.ok(!text(root).includes(SIGN_IN_LABEL));
  await click(choice(root, SWITCH_USER_LABEL));
  await click(choice(root, SIGN_OUT_LABEL));
  assert.deepEqual([switches, outs], [1, 1]);
});

test('a switch page that cannot open is said and leaves every other control present', async (t) => {
  const refusal = 'I could not open your Virgil account page. Nothing was changed.';
  const root = popup(t, {
    signedIn: true,
    onSwitchUser: async () => refusal,
  });
  await click(choice(root, SWITCH_USER_LABEL));
  assert.match(text(root), new RegExp(refusal.replaceAll('.', '\\.')));
  choice(root, SIGN_OUT_LABEL);
  choice(root, SETTINGS_LABEL);
});

test('the bottom theme selector offers every board and changes this popup immediately', async (t) => {
  const selected: Theme[] = [];
  const root = popup(t, { theme: 'light', onTheme: (theme) => { selected.push(theme); } });
  const theme = root.querySelector('.popup-theme');
  if (!theme) throw new Error('no theme selector');
  assert.equal(theme.getAttribute('aria-label'), THEME_LABEL);
  assert.equal(theme.value, 'light');
  assert.match(text(theme), /Match my system.*Whiteboard.*Blackboard/);
  theme.value = 'dark';
  await theme.fireEvent('change');
  assert.deepEqual(selected, ['dark']);
});

test('full-page route fragments are stable and unknown ones fail home', () => {
  assert.equal(mainPageRoute('#learn'), 'home');
  assert.equal(mainPageRoute('#plan'), 'plan');
  assert.equal(mainPageRoute('#studies'), 'courses');
  assert.equal(mainPageRoute('#add-source'), 'add-source');
  assert.equal(mainPageRoute('#demo'), 'home');
  assert.equal(mainPageRoute('#check'), 'check');
  assert.equal(mainPageRoute('#insights'), 'insights');
  assert.equal(mainPageRoute('#account'), 'account');
  assert.equal(mainPageRoute('#switch-user'), 'switch-user');
  assert.equal(mainPageRoute('#sign-out'), 'sign-out');
  assert.equal(mainPageRoute('#settings'), 'settings');
  assert.equal(mainPageRoute('#models'), 'models');
  assert.equal(mainPageRoute('#privacy'), 'privacy');
  assert.equal(mainPageRoute('#connections'), 'connections');
  // Backup, restore and deletion: a settings section since 2026-08-29, and
  // addressable like every other one.
  assert.equal(mainPageRoute('#data'), 'data');
  assert.equal(mainPageRoute('#from-an-older-build'), 'home');
  for (const route of ['home', 'plan', 'courses', 'add-source', 'check', 'insights', 'account', 'switch-user',
    'sign-out', 'settings', 'models', 'privacy', 'connections', 'data'] as const) {
    assert.equal(mainPageRoute(mainPageHash(route)), route);
  }
});

test('SB-114: a page the extension may not touch opens the reviewed manual route', async (t) => {
  /**
   * `chrome://`, the Web Store, a PDF viewer: `capturePermitted` refuses all
   * of them, and the button is on the toolbar of every one. The old behaviour
   * on those pages was a click that did precisely nothing — no toast, because
   * the toast is injected too. A popup can at least say why.
   */
  let pick = 0;
  let manual = 0;
  const root = popup(t, {
    canPick: false, onPick: () => { pick++; }, onManualAdd: () => { manual++; },
  });
  const fallback = choice(root, MANUAL_ADD_LABEL);
  assert.equal(fallback.disabled, false, 'the refusal is still a dead control');
  await click(fallback);
  assert.equal(pick, 0, 'and it does not fire');
  assert.equal(manual, 1, 'the existing paste/upload route did not open');
  assert.ok(text(root).includes(PICK_UNAVAILABLE),
    'the alternative hid why direct capture is unavailable');
  choice(root, BOARD_LABEL);  // the board is a hosted page and remains reachable
  choice(root, PANEL_LABEL);  // the panel is an extension surface and also remains reachable
});

test('an unknown url is not a refusal', () => {
  /**
   * The popup reads the active tab through `chrome.tabs.query`, and this
   * extension asks for no `tabs` permission — deliberately, because a study
   * tool that can read every tab's address is a different product with the
   * same name. So `tab.url` arrives **only** under the `activeTab` grant the
   * click is supposed to carry.
   *
   * If that grant is ever absent, the url is `undefined`, and judging
   * `undefined` as "not permitted" would put the refusal line on every
   * ordinary page — turning a privacy decision into a product that does not
   * work. So the refusal is said only when the url is known and known to be
   * off-limits. Unknown means offer it and let the worker's own
   * `capturePermitted` make the real decision, which it does under the grant.
   */
  assert.equal(canPickOn(undefined), true, 'not knowing is not the same as knowing it is refused');
  assert.equal(canPickOn('https://example.test/x'), true);
  assert.equal(canPickOn('chrome://settings'), false, 'known, and known to be off-limits');
  assert.equal(canPickOn('https://chromewebstore.google.com/detail/x'), false);
});

const waiting = (id: string, title: string): PendingPinView => ({
  id, title, source: 'Example course', kind: 'Saved to learn',
  capturedAt: '2026-08-26T08:30:00.000Z', lastAttemptAt: '2026-08-26T08:30:00.000Z',
});

test('the popup stays quiet when every capture has reached the board', (t) => {
  const root = popup(t);
  assert.ok(!text(root).includes(QUEUE_HEADING));
});

test('waiting captures are visible by name and count, not as an anonymous sync promise', (t) => {
  const root = popup(t, { pendingPins: [waiting('a', 'How do you hold drumsticks?'), waiting('b', 'Bart Robley')] });
  assert.match(text(root), /Waiting to sync.*2.*How do you hold drumsticks\?.*Bart Robley/);
  assert.equal(root.querySelectorAll('.popup-queue-item').length, 2);
});

test('Retry addresses one capture and removes it only when the service accepts it', async (t) => {
  const tried: string[] = [];
  const root = popup(t, {
    pendingPins: [waiting('a', 'First capture'), waiting('b', 'Second capture')],
    onRetry: async (id) => { tried.push(id); return id === 'a' ? 'sent' : 'waiting'; },
  });
  const retry = root.querySelectorAll('.popup-queue-retry');
  await click(retry[0]!);
  assert.deepEqual(tried, ['a']);
  assert.doesNotMatch(text(root), /First capture/);
  assert.match(text(root), /Second capture/);
  assert.match(text(root), /Synced\. It is on your board\./);
  await click(root.querySelectorAll('.popup-queue-retry')[0]!);
  assert.deepEqual(tried, ['a', 'b']);
  assert.match(text(root), /Still waiting\. Virgil will keep trying\./);
  assert.match(text(root), /Second capture/);
  assert.match(text(root), /Last tried/, 'the failed manual attempt remains visible on the item');
});

test('Remove is confirmed in place; Keep restores the exact launcher', async (t) => {
  let removed = 0;
  const root = popup(t, {
    pendingPins: [waiting('a', 'Accidental capture')],
    onRemove: async () => { removed++; return true; },
  });
  const launcher = root.querySelector('.popup-queue-remove');
  if (!launcher) throw new Error('no Remove control');
  await click(launcher);
  assert.match(text(root), /Remove this waiting pin\? It has not reached your board\./);
  const keep = root.querySelector('.popup-queue-keep');
  if (!keep) throw new Error('no Keep pin control');
  await click(keep);
  assert.equal(removed, 0);
  assert.equal((globalThis.document as unknown as { activeElement: unknown }).activeElement, launcher);
  assert.match(text(root), /Accidental capture/);
});

test('confirmed Remove deletes only that waiting capture and announces it', async (t) => {
  const removed: string[] = [];
  const root = popup(t, {
    pendingPins: [waiting('a', 'Accidental capture'), waiting('b', 'Keep this')],
    onRemove: async (id) => { removed.push(id); return true; },
  });
  await click(root.querySelectorAll('.popup-queue-remove')[0]!);
  const confirm = root.querySelector('.popup-queue-confirm-remove');
  if (!confirm) throw new Error('no confirmed Remove pin control');
  assert.equal((globalThis.document as unknown as { activeElement: unknown }).activeElement, confirm);
  await click(confirm);
  assert.deepEqual(removed, ['a']);
  assert.doesNotMatch(text(root), /Accidental capture/);
  assert.match(text(root), /Keep this/);
  const status = root.querySelector('.popup-queue-status');
  assert.equal(status?.getAttribute('role'), 'status');
  assert.match(text(status!), /Removed\. It will not be sent\./);
});
