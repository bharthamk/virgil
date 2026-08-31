/**
 * The toolbar popup offers explicit destinations and remains available on
 * browser-owned pages where an injected overlay cannot run. Its DOM builder is
 * pure so the interaction surface can be tested without a browser.
 */

import { THEME_CHOICES, themeLabel, type Theme } from './panel-core.js';
import { mayScript } from './prefs.js';
import type { PendingPinView, RetryPendingResult } from './queue.js';

export const POPUP_HEADING = 'What would you like to do?';
/** The hosted page and side panel are distinct destinations. */
export const BOARD_LABEL = 'Open Virgil';
export const BOARD_NOTE = "Your full Virgil space in a new tab: what's next, your plan and everything you've saved.";
export const PANEL_LABEL = 'Open the side panel';
export const PANEL_NOTE = 'The narrow one, beside whatever you are reading.';
export const PICK_LABEL = 'Pick what to pin';
export const PICK_NOTE = 'Click the parts of this page worth keeping.';
export const MANUAL_ADD_LABEL = 'Add it another way';
export const ACCOUNT_SETTINGS_HEADING = 'Account & settings';
export const SIGNED_OUT_ACCOUNT_NOTE = 'Sign in to open your page and keep your board with you.';
export const SIGNED_IN_ACCOUNT_NOTE = 'Signed in as';
export const SIGN_IN_LABEL = 'Sign in';
export const SWITCH_USER_LABEL = 'Switch user';
export const SIGN_OUT_LABEL = 'Sign out';
export const SETTINGS_LABEL = 'Settings';
export const THEME_LABEL = 'Theme';
export const QUEUE_HEADING = 'Waiting to sync';
/** Said on the pages `capturePermitted` refuses. Never a silent no-op. */
export const PICK_UNAVAILABLE = "Virgil can't read this browser page directly. Paste the words or choose the file instead.";

/**
 * Whether to offer the picker, given whatever the popup could learn about the
 * active tab.
 *
 * This extension asks for no `tabs` permission — deliberately, because a study
 * tool that can read every tab's address is a different product with the same
 * name — so `tab.url` reaches the popup only under the `activeTab` grant the
 * click carries. **An unknown url is therefore not a refusal.** Reading
 * `undefined` as "not permitted" would put the refusal line on every ordinary
 * page the moment that grant was not there, turning a privacy decision into a
 * product that does not work. Say no only when the url is known and known to
 * be off-limits; otherwise offer it and let the worker's own
 * `capturePermitted` decide, which it does with the grant in hand.
 */
export function canPickOn(url: string | undefined): boolean {
  return mayScript(url);
}

export interface ActionPopupDeps {
  /** False only on a page known to be off-limits. The control stays, and says why. */
  readonly canPick: boolean;
  /** The configured Virgil service's `/app/`, in a normal browser tab. */
  readonly openBoard: () => void;
  /** `panel.html`, in the side panel. */
  readonly openPanel: () => void;
  readonly pickFromPage: () => void;
  /** The reviewed paste/upload route when Chrome owns the current page. */
  readonly openManualAdd: () => void;
  /** The popup names the account door before it is pressed. */
  readonly signedIn: boolean;
  readonly accountName: string | null;
  readonly openAccount: () => void;
  /** Null means the chooser completed; a sentence means it did not. */
  readonly switchUser: () => Promise<string | null>;
  readonly signOut: () => Promise<void>;
  readonly openSettings: () => void;
  readonly theme: Theme;
  readonly setTheme: (theme: Theme) => void;
  readonly pendingPins: readonly PendingPinView[];
  readonly retryPending: (clientRef: string) => Promise<RetryPendingResult>;
  readonly removePending: (clientRef: string) => Promise<boolean>;
}

export interface ActionPopupHandles {
  readonly root: HTMLElement;
  readonly board: HTMLButtonElement;
  readonly panel: HTMLButtonElement;
  readonly pick: HTMLButtonElement;
  readonly account: HTMLButtonElement | null;
  readonly switchUser: HTMLButtonElement | null;
  readonly signOut: HTMLButtonElement | null;
  readonly settings: HTMLButtonElement;
  readonly theme: HTMLSelectElement;
  readonly queue: HTMLElement | null;
}

export function buildActionPopup(doc: Document, deps: ActionPopupDeps): ActionPopupHandles {
  const root = doc.createElement('div');
  root.className = 'popup';

  const heading = doc.createElement('h1');
  heading.className = 'popup-heading';
  heading.textContent = POPUP_HEADING;
  root.append(heading);

  // The page leads, because it is the one that was unreachable and because it
  // is the surface the board actually lives on.
  const board = choice(doc, BOARD_LABEL, BOARD_NOTE, true, 'site');
  board.addEventListener('click', () => deps.openBoard());
  root.append(board);

  const panel = choice(doc, PANEL_LABEL, PANEL_NOTE, true, 'panel');
  panel.addEventListener('click', () => deps.openPanel());
  root.append(panel);

  // Chrome-owned pages get a route, not a disabled explanation. Direct
  // capture stays forbidden; the alternative opens the existing reviewed
  // paste/upload sheet and sends nothing merely because it opened.
  const pick = choice(doc, deps.canPick ? PICK_LABEL : MANUAL_ADD_LABEL,
    deps.canPick ? PICK_NOTE : PICK_UNAVAILABLE, true, 'pick');
  pick.addEventListener('click', () => (deps.canPick ? deps.pickFromPage() : deps.openManualAdd()));
  root.append(pick);

  const queue = deps.pendingPins.length ? buildQueue(doc, deps) : null;
  if (queue) root.append(queue);

  const utilities = doc.createElement('section');
  utilities.className = 'popup-utilities';

  const utilityHeading = doc.createElement('h2');
  utilityHeading.className = 'popup-utility-heading';
  utilityHeading.textContent = ACCOUNT_SETTINGS_HEADING;

  const utilityNote = doc.createElement('p');
  utilityNote.className = 'popup-utility-note';
  utilityNote.textContent = deps.signedIn
    ? `${SIGNED_IN_ACCOUNT_NOTE} ${deps.accountName ?? 'your Google account'}.`
    : SIGNED_OUT_ACCOUNT_NOTE;

  const utilityActions = doc.createElement('div');
  utilityActions.className = 'popup-utility-actions';
  const account = deps.signedIn ? null : utility(doc, SIGN_IN_LABEL);
  const switchUser = deps.signedIn ? utility(doc, SWITCH_USER_LABEL) : null;
  const signOut = deps.signedIn ? utility(doc, SIGN_OUT_LABEL) : null;
  const settings = utility(doc, SETTINGS_LABEL);
  account?.addEventListener('click', () => deps.openAccount());
  switchUser?.addEventListener('click', async () => {
    switchUser.disabled = true;
    const refusal = await deps.switchUser();
    switchUser.disabled = false;
    if (refusal !== null) utilityNote.textContent = refusal;
  });
  signOut?.addEventListener('click', async () => {
    signOut.disabled = true;
    utilityNote.textContent = 'Signing out…';
    await deps.signOut();
  });
  settings.addEventListener('click', () => deps.openSettings());
  if (account) utilityActions.append(account);
  if (switchUser) utilityActions.append(switchUser);
  if (signOut) utilityActions.append(signOut);
  utilityActions.append(settings);

  const themeControl = doc.createElement('label');
  themeControl.className = 'popup-theme-control';
  const themeName = doc.createElement('span');
  themeName.textContent = THEME_LABEL;
  const theme = doc.createElement('select');
  theme.className = 'popup-theme';
  theme.setAttribute('aria-label', THEME_LABEL);
  for (const value of THEME_CHOICES) {
    const option = doc.createElement('option');
    option.value = value;
    option.textContent = themeLabel(value);
    theme.append(option);
  }
  theme.value = deps.theme;
  theme.addEventListener('change', () => {
    const next = theme.value;
    if (!(THEME_CHOICES as readonly string[]).includes(next)) return;
    deps.setTheme(next as Theme);
  });
  themeControl.append(themeName, theme);

  utilities.append(utilityHeading, utilityNote, utilityActions, themeControl);
  root.append(utilities);

  return { root, board, panel, pick, account, switchUser, signOut, settings, theme, queue };
}

/** A short-lived recovery surface, not another board or backlog. */
function buildQueue(doc: Document, deps: ActionPopupDeps): HTMLElement {
  const section = doc.createElement('section');
  section.className = 'popup-queue';

  const heading = doc.createElement('h2');
  heading.className = 'popup-queue-heading';

  const note = doc.createElement('p');
  note.className = 'popup-queue-note';
  note.textContent = 'These captures are safe in this browser. Virgil will keep trying.';

  const list = doc.createElement('div');
  list.className = 'popup-queue-list';

  const status = doc.createElement('p');
  status.className = 'popup-queue-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('tabindex', '-1');

  let count = deps.pendingPins.length;
  const updateCount = (): void => {
    heading.textContent = `${QUEUE_HEADING} · ${count}`;
    if (count === 0) note.textContent = 'Nothing is waiting now.';
  };
  updateCount();

  for (const pin of deps.pendingPins) {
    const item = doc.createElement('article');
    item.className = 'popup-queue-item';
    item.setAttribute('data-client-ref', pin.id);

    const title = doc.createElement('h3');
    title.className = 'popup-queue-title';
    title.textContent = pin.title;

    const detail = doc.createElement('p');
    detail.className = 'popup-queue-detail';
    const setAttempt = (at: string | null): void => {
      const attempt = at ? formatAttempt(at) : 'time not recorded';
      detail.textContent = `${pin.kind} · ${pin.source} · Last tried ${attempt}`;
    };
    setAttempt(pin.lastAttemptAt);

    const actions = doc.createElement('div');
    actions.className = 'popup-queue-actions';
    const retry = utility(doc, 'Retry');
    retry.classList.add('popup-queue-retry');
    const remove = utility(doc, 'Remove');
    remove.classList.add('popup-queue-remove');

    const setBusy = (busy: boolean): void => {
      item.setAttribute('aria-busy', String(busy));
      retry.disabled = busy;
      remove.disabled = busy;
    };
    const takeOffList = (message: string): void => {
      item.remove();
      count -= 1;
      updateCount();
      status.textContent = message;
      status.focus();
    };
    const restoreActions = (): void => { actions.replaceChildren(retry, remove); };

    retry.addEventListener('click', async () => {
      setBusy(true);
      status.textContent = `Trying “${pin.title}” again…`;
      let result: RetryPendingResult = 'waiting';
      try { result = await deps.retryPending(pin.id); } catch { /* still waiting */ }
      if (result === 'sent') return takeOffList('Synced. It is on your board.');
      if (result === 'missing') return takeOffList('That pin is no longer waiting.');
      setBusy(false);
      setAttempt(new Date().toISOString());
      status.textContent = 'Still waiting. Virgil will keep trying.';
      retry.focus();
    });

    remove.addEventListener('click', () => {
      const question = doc.createElement('span');
      question.className = 'popup-queue-confirm-copy';
      question.textContent = 'Remove this waiting pin? It has not reached your board.';
      const keep = utility(doc, 'Keep pin');
      keep.classList.add('popup-queue-keep');
      const confirm = utility(doc, 'Remove pin');
      confirm.classList.add('popup-queue-confirm-remove');
      keep.addEventListener('click', () => {
        restoreActions();
        remove.focus();
      });
      confirm.addEventListener('click', async () => {
        keep.disabled = true;
        confirm.disabled = true;
        item.setAttribute('aria-busy', 'true');
        try {
          const removed = await deps.removePending(pin.id);
          return takeOffList(removed ? 'Removed. It will not be sent.' : 'That pin is no longer waiting.');
        } catch {
          item.setAttribute('aria-busy', 'false');
          restoreActions();
          status.textContent = 'I could not remove that pin. It is still safe and waiting.';
          remove.focus();
        }
      });
      actions.replaceChildren(question, keep, confirm);
      confirm.focus();
    });

    actions.append(retry, remove);
    item.append(title, detail, actions);
    list.append(item);
  }

  section.append(heading, note, list, status);
  return section;
}

function formatAttempt(value: string): string {
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return 'time unknown';
  return when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** One choice: what it does, and one line saying what that means. */
function choice(
  doc: Document,
  label: string,
  note: string,
  enabled: boolean,
  tone: 'site' | 'panel' | 'pick',
): HTMLButtonElement {
  const el = doc.createElement('button');
  el.className = `popup-choice popup-choice-${tone}${enabled ? '' : ' is-off'}`;
  el.type = 'button';
  if (!enabled) el.disabled = true;

  const name = doc.createElement('span');
  name.className = 'popup-choice-label';
  name.textContent = label;
  el.append(name);

  const why = doc.createElement('span');
  why.className = 'popup-choice-note';
  why.textContent = note;
  el.append(why);
  return el;
}

function utility(doc: Document, label: string): HTMLButtonElement {
  const el = doc.createElement('button');
  el.className = 'popup-utility';
  el.type = 'button';
  el.textContent = label;
  return el;
}
