
/** What a mode does once the material is in hand. */
export type ModeAction =
  /** Post it, confirm on the toast, and get out of the way. */
  | 'pin'
  /** Open the box over the page, prefilled, and post what comes back. */
  | 'compose'
  /** Post it and put the panel on the take for it. */
  | 'learn'
  /** Post it and open the guided walkthrough. */
  | 'guide'
  /** Draw the picker over the page and pin what is chosen. */
  | 'select';

export interface PinMode {
  /** The context-menu id. Also what the click router switches on. */
  readonly id: string;
  /** What the learner reads in the menu. */
  readonly title: string;
  readonly action: ModeAction;
  /** Chrome contexts this appears in. */
  readonly contexts: readonly `${chrome.contextMenus.ContextType}`[];
  /** Whether the mode needs the page's selection. */
  readonly needsSelection: boolean;
}

/** The registry id that is hidden unless the local experiment is enabled. */
export const WHOLE_PAGE_MODE_ID = 'mode-page';

/**
 * In menu order, which is the order they cost attention.
 *
 * Pin first because it is the fast path. The Selector sits last wherever it
 * appears: it is the way out when the original highlight was not the thing the
 * learner meant, or when several separate passages belong on the board.
 */
export const PIN_MODES: readonly PinMode[] = [
  // Every item here is built and routed. The rule that kept unfinished items out of this
  // list until they worked still stands: a menu item that says "Pick what to
  // pin" and silently flash-pins the page instead is a lie told to a learner in
  // the one place this product asks them to trust it. `extension-surface.
  // test.ts` walks this list, so every id here is asserted to be created and
  // handled.

  {
    id: 'mode-flash',
    title: 'Pin this',
    action: 'pin',
    contexts: ['selection'],
    needsSelection: true,
  },
  {
    id: 'mode-standard',
    title: 'Add details before pinning…',
    action: 'compose',
    contexts: ['selection'],
    needsSelection: true,
  },
  {
    id: 'mode-learn-now',
    title: 'Learn this now',
    action: 'learn',
    contexts: ['selection'],
    needsSelection: true,
  },
  {
    id: 'mode-select',
    title: 'Pick what to pin',
    action: 'select',
    // Everywhere a learner can right-click, plus the button. See the header:
    // `page` alone is the empty-page state and nothing else, and it is not the
    // state anybody is in when they decide to pin.
    contexts: ['page', 'selection', 'link', 'image', 'video', 'audio', 'editable', 'frame', 'action'],
    needsSelection: false,
  },
  {
    id: WHOLE_PAGE_MODE_ID,
    title: 'Pin the whole page',
    action: 'pin',
    contexts: ['page', 'link', 'image', 'video', 'audio', 'editable', 'frame'],
    needsSelection: false,
  },
];

/**
 * Whole-page extraction deliberately lives behind a local experiment.
 *
 * These strings cross the panel/worker boundary, so there is one source for
 * the stored switch, the menu rebuild message and the registry id it gates.
 */
export const EXPERIMENTAL_WHOLE_PAGE_KEY = 'sb_experimental_whole_page';
export const EXPERIMENTAL_CAPTURE_CHANGED = 'sb-experimental-capture-changed';

/** The modes Chrome should expose for this installation. Strict `true` keeps
 * stale or malformed storage from quietly promoting an experiment. */
export const menuModes = (wholePageEnabled: unknown): readonly PinMode[] =>
  PIN_MODES.filter((mode) => mode.id !== WHOLE_PAGE_MODE_ID || wholePageEnabled === true);

/**
 * The popup asking the worker to run the Selector on a tab.
 *
 * Here rather than in `action-popup-main.ts` because the worker's router and
 * the popup both need the same string, and a second copy is a message nothing
 * answers.
 */
export const OPEN_SELECTOR = 'sb-open-selector';

/** Worker to the declared content script on the exact page being picked from. */
export const OPEN_SELECTOR_ON_PAGE = 'sb-open-selector-on-page';

/** The toolbar menu exposes both the hosted page and side-panel destinations. */
export const OPEN_BOARD_ID = 'open-board';
export const OPEN_BOARD_TITLE = 'Open Virgil';
export const OPEN_PANEL_ID = 'open-panel';
export const OPEN_PANEL_TITLE = 'Open the side panel';

export function modeFor(menuItemId: unknown): PinMode | null {
  return PIN_MODES.find((m) => m.id === menuItemId) ?? null;
}
