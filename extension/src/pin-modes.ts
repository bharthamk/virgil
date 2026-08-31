/**
 * The small right-click menu.
 *
 * The first pass made the right-click menu a catalogue of Virgil's internal
 * modes. Once the side panel existed, that became the wrong division of work:
 * the menu is the fast entrance, while deeper teaching choices belong inside
 * Virgil. It now keeps only the four actions that are useful at the moment a
 * learner has highlighted something: pin, add details, learn now, or choose a
 * different part of the page.
 *
 * ## Where the struggle signal went
 *
 * Into Standard's box, by ruling. It is an input to the comfort map and the
 * register the model teaches at, so losing it would have thinned the learner
 * model exactly where it is thinnest, on day one. Flash is always an interest
 * pin because a mode whose whole claim is one gesture cannot also ask a
 * question; Standard is the mode that has already bought a moment of the
 * learner's attention, so it is the one that can afford to ask.
 *
 * ## Why the modes are data
 *
 * Chrome's menu, the click router and the tests all need the same list, and
 * the failure mode of three copies is an item that exists in the menu and is
 * routed nowhere. `background-shell.test.ts` walks this registry and asserts
 * that every id it declares is both created and handled.
 *
 * ## Contexts, and the default
 *
 * A mode that reads a selection is offered only where there is one. With
 * nothing highlighted, the whole page used to be captured silently, and the
 * first real pin anybody made proved what that costs: the material was an AI
 * notice and a navigation list, and the take written from it was exactly as
 * thin as its input. So the no-selection menu leads with the Selector, and
 * pinning a whole page is not part of that default menu. It remains available
 * behind an explicit experimental setting for people working on extraction,
 * while the shipped path asks for a selection or opens the Selector.
 *
 * The Selector is the exception to the first sentence. Chrome's
 * `page` context is not "the page" — it is *only the page*, dropped the moment
 * there is a selection, a link, an image or an editable field under the
 * cursor. Declaring the picker `['page']` therefore hid it from every learner
 * who had already highlighted something, which is what a learner about to pin
 * has done. It is offered on a selection too, because setting the page's
 * selection is the picker's whole mechanism: it is the way *out* of a
 * highlight that came out wrong and the way to take four paragraphs instead of
 * one. And it is on the toolbar button, which is the only surface that is
 * present in every state and cannot be argued about.
 */

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
