/**
 * The stable page-side door for Pick what to pin.
 *
 * The panel names the exact adjacent tab, the worker sends this script one
 * message, and the script opens the existing Selector in its own isolated
 * world. Keeping the imports here avoids serialising a dynamic-import function
 * through `scripting.executeScript`, which Chrome could reject after the panel
 * had already reported a successful click.
 */
void (() => {
  const OPEN = 'sb-open-selector-on-page';
  const INSTALLED = '__virgilSelectorContentV1';
  if (globalThis[INSTALLED]) return;
  globalThis[INSTALLED] = true;

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (!message || message.kind !== OPEN) return undefined;
    void Promise.all([
      import(chrome.runtime.getURL('dist/selector.js')),
      import(chrome.runtime.getURL('dist/capture.js')),
    ]).then(([selector, capture]) => {
      // The Selector is a fresh choice made after the context menu. It must not
      // inherit a collapse snapshot from the highlight that opened that menu.
      // Direct right-click modes consume that snapshot; the picker starts over.
      const memory = globalThis.__sbSelectionMemory;
      if (memory) memory.atMenu = null;
      selector.openSelector(
        (visibleSelection) => capture.capture(false, visibleSelection ?? null),
        (reply) => chrome.runtime.sendMessage(reply),
      );
      respond({ ok: true });
    }).catch(() => respond({ ok: false }));
    return true;
  });
})();
