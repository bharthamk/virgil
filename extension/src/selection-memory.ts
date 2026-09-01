

/**
 * How long a snapshot stays worth acting on.
 *
 * A context menu can sit open for a while: reading the items, hovering into a
 * submenu, deciding. Generous enough for that, and short enough that it is
 * never a highlight from some earlier reading session.
 */
export const COLLAPSE_WINDOW_MS = 60_000;

/** One remembered selection. The `Range` is live: it tracks the nodes it was
 *  taken over, which is what lets it outlive the selection itself. */
export interface Remembered {
  readonly text: string;
  readonly range: Range;
  /** Epoch ms at which this became the selection. */
  readonly at: number;
  /** True only after the matching context-menu event proves that this exact
   *  gesture shortened the selection. A pre-menu snapshot alone is not proof. */
  readonly collapsedAtMenu: boolean;
  /** What remained after the menu opened. Diagnostic only; never stored. */
  readonly afterMenuText: string;
}

export interface SelectionMemory {
  /**
   * The selection as it stood when the menu was summoned, taken before the
   * browser had a chance to change it. Null until somebody right-clicks.
   */
  atMenu: Remembered | null;
}

/** Where the memory lives, on the isolated world's global, beside the toast's
 *  finisher. `capture` is serialised across `executeScript` and can hold no
 *  imports, so a global is the only thing both halves can name. */
export const MEMORY_KEY = '__sbSelectionMemory';

/** `compareBoundaryPoints` modes, fixed by the DOM standard. Spelled as
 *  numbers because this rule is tested outside a browser, where the `Range`
 *  global that carries them does not exist. */
export const START_TO_START = 0;
export const END_TO_END = 2;

/**
 * Is `inner` wholly within `outer`?
 *
 * Separated so the rule is testable without a selection. `compareBoundary
 * Points` throws on ranges in different documents, which is a false rather
 * than a crash: two ranges that cannot be compared are not one inside the
 * other.
 */
export function contains(outer: Range, inner: Range): boolean {
  try {
    return outer.compareBoundaryPoints(START_TO_START, inner) <= 0
      && outer.compareBoundaryPoints(END_TO_END, inner) >= 0;
  } catch {
    return false;
  }
}

/** A single token: no internal whitespace. The shape a word collapse has. */
export function isOneToken(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && !/\s/.test(t);
}

/**
 * Should the previous selection be used in place of the live one?
 *
 * All four conditions, in the order they are cheapest to refute.
 */
export function recovers(
  memory: SelectionMemory | null | undefined,
  liveText: string,
  now: number,
): Remembered | null {
  const held = memory?.atMenu;
  if (!held) return null;
  if (!held.collapsedAtMenu) return null;
  const had = held.text.trim();
  if (!had) return null;
  if (now - held.at > COLLAPSE_WINDOW_MS) return null;
  // Shorter is the browser's doing. Equal means nothing was taken away, and
  // longer cannot happen from a collapse, so both are the live selection's.
  if (had.length <= liveText.trim().length) return null;
  return held;
}

/** Record what the browser actually did between the right-button mousedown and
 * the context menu. This makes recovery conditional on one observed collapse
 * instead of treating every remembered selection as a standing workaround. */
export function markMenuResult(memory: SelectionMemory, liveText: string, now: number): void {
  const held = memory.atMenu;
  if (!held || now - held.at > MOUSE_FIRST_MS) return;
  const before = held.text.trim();
  const after = liveText.trim();
  memory.atMenu = {
    ...held,
    collapsedAtMenu: before.length > after.length,
    afterMenuText: after,
  };
}

/**
 * Start remembering, on a page.
 *
 * **This is the reference implementation, not the shipped one.** The shipped
 * listeners are in `selection-content.js`, which is a classic script for the
 * CSP reason above. This exists so the behaviour those listeners implement can
 * be driven and asserted without a browser, and the test that reads that file
 * is what keeps the two from drifting.
 *
 * `selectionchange` rather than `mouseup`: it is the one event that fires for
 * every way a selection can change, including the collapse this exists to
 * survive, and including keyboard selection which `mouseup` never sees.
 *
 * Empty selections are not remembered. Clearing a selection is not a selection,
 * and recording it would push the highlight out of `prev` on the way to the
 * collapse — which is exactly the state this has to hold on to.
 */
export function installSelectionMemory(
  doc: Document = document,
  scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
  now: () => number = () => Date.now(),
): SelectionMemory {
  const existing = scope[MEMORY_KEY] as SelectionMemory | undefined;
  if (existing) return existing;

  const memory: SelectionMemory = { atMenu: null };
  scope[MEMORY_KEY] = memory;

  const hold = (): void => {
    const sel = doc.getSelection();
    const text = sel?.toString() ?? '';
    if (!text.trim() || !sel || sel.rangeCount === 0) { memory.atMenu = null; return; }
    memory.atMenu = {
      text, range: sel.getRangeAt(0).cloneRange(), at: now(),
      collapsedAtMenu: false, afterMenuText: text.trim(),
    };
  };

  // Capture phase, and the right button only. The collapse is this event's
  // default action, so this runs first and sees the selection the learner
  // still had. Nothing is prevented: the menu must open exactly as it does.
  doc.addEventListener('mousedown', (e) => {
    if ((e as MouseEvent).button === RIGHT_BUTTON) hold();
  }, true);

  // The keyboard route to the same menu, which has no mousedown at all. Later
  // than ideal, but a menu key does not collapse a selection, so what it sees
  // is what the learner had. Never allowed to overwrite a fresher snapshot.
  doc.addEventListener('contextmenu', () => {
    if (memory.atMenu && now() - memory.atMenu.at < MOUSE_FIRST_MS) {
      markMenuResult(memory, doc.getSelection()?.toString() ?? '', now());
      return;
    }
    hold();
  }, true);

  // An empty click clears it, so a menu summoned later on a different part of
  // the page cannot recover a highlight the learner has since dismissed.
  doc.addEventListener('mousedown', (e) => {
    if ((e as MouseEvent).button !== RIGHT_BUTTON) memory.atMenu = null;
  }, true);

  return memory;
}

/** `MouseEvent.button` for the secondary button. */
export const RIGHT_BUTTON = 2;

/** How recently a mousedown snapshot must have been taken for the
 *  `contextmenu` listener to leave it alone. */
export const MOUSE_FIRST_MS = 1_000;
