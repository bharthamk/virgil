/**
 * The selection memory, as a declared content script.
 *
 * ## Why this is hand-written JavaScript at the root, and not an import
 *
 * It was an import of the compiled `dist/selection-memory.js`, reached the way
 * `reread-content.js` reaches its modules, and it was changed on a theory
 * about Content-Security-Policy that turned out to be **wrong**. The theory
 * was that a content script's dynamic `import()` is checked against the page's
 * CSP, and that Udacity's `script-src 'self' 'unsafe-inline' 'unsafe-eval' *
 * blob:` therefore refused it. `scripts/probe-selection.mjs` asked Chrome
 * directly, on a page served with that exact header, and the import succeeded.
 *
 * The change stands anyway, on its own smaller merits: no import to fail, no
 * loader to swallow a failure, and `document_start` instead of
 * `document_idle`, which matters because the thing being beaten is a mousedown
 * a learner can make as soon as they can see the page. It is simply not the
 * fix it was committed as, and the real one was elsewhere: a content script
 * does not enter a tab that was already open, so on such a page nothing was
 * ever listening. The worker now repairs that at pin time.
 *
 * ## The split, and what keeps the two halves honest
 *
 * The rule that reads this — "if there was a selection when the menu was
 * summoned and what survives is shorter, the shorter one is the browser's
 * doing" — lives in `src/selection-memory.ts` where it is tested without a
 * browser, and is spelled out again in `capture` for the same reason
 * everything there is spelled out (reviewer-boundary constraint: injected functions are serialised and
 * can hold no imports). This file holds only the listeners.
 *
 * Three constants are shared by all three copies and by nothing else: the key,
 * the button number and the window. `selection-memory.test.ts` reads this file
 * and asserts they still agree.
 *
 * ## Why `document_start`
 *
 * Later is a page a learner can already be reading and right-clicking on. The
 * detector next door runs at `document_idle` because it is a background
 * nicety; this is the thing that makes a deliberate gesture accurate, and a
 * pin outranks what watches ( the learner-confirmation contract).
 */
void (() => {
  const KEY = '__sbSelectionMemory';
  const RIGHT_BUTTON = 2;
  /** Only ever set by `contextmenu` when no mousedown beat it here. */
  const MOUSE_FIRST_MS = 1000;

  if (globalThis[KEY]) return;
  const memory = { atMenu: null };
  globalThis[KEY] = memory;

  const hold = () => {
    const sel = document.getSelection();
    const text = sel ? sel.toString() : '';
    if (!text.trim() || !sel || sel.rangeCount === 0) { memory.atMenu = null; return; }
    memory.atMenu = {
      text,
      range: sel.getRangeAt(0).cloneRange(),
      at: Date.now(),
      collapsedAtMenu: false,
      afterMenuText: text.trim(),
    };
  };

  // Capture phase, right button. The collapse is this event's default action,
  // so this runs first and sees the selection the learner still had. Nothing
  // is prevented: the menu must open exactly as it always does.
  document.addEventListener('mousedown', (e) => {
    if (e.button === RIGHT_BUTTON) hold();
    // Any other button clears it, so a menu summoned later somewhere else
    // cannot recover a highlight the learner has since dismissed.
    else memory.atMenu = null;
  }, true);

  // The keyboard route to the same menu, which has no mousedown at all. A menu
  // key does not collapse a selection, so what it sees is what they had.
  document.addEventListener('contextmenu', () => {
    if (memory.atMenu && Date.now() - memory.atMenu.at < MOUSE_FIRST_MS) {
      const before = memory.atMenu.text.trim();
      const after = (document.getSelection()?.toString() ?? '').trim();
      memory.atMenu = {
        ...memory.atMenu,
        collapsedAtMenu: before.length > after.length,
        afterMenuText: after,
      };
      return;
    }
    hold();
  }, true);
})();
