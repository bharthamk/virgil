/**
 * The declared content script for the re-read detector (SB-15).
 *
 * Loader only. Every decision it makes is in `reread-bridge.ts`, every threshold
 * is in `reread-core.ts`, and both of those are TypeScript with tests.
 *
 * ## Why this one file is hand-written JavaScript
 *
 * MV3 does not run a declared content script as an ES module, and `reread.js`
 * imports `reread-core.js` — a split that exists precisely so the detector's
 * numbers can be tested without a DOM. So the entry point has to be a classic
 * script that pulls the module graph in through `chrome.runtime.getURL`.
 *
 * Those modules are compiled output and live in `dist/`, which is where `tsc`
 * emits them and where every path here and in `manifest.json` has to point.
 * They are not at the root, and an extension that says they are does not load.
 *
 * It cannot be compiled from TypeScript: this package is `"type": "module"`, so
 * `tsc` emits `export {};` into any file that has no imports of its own, and
 * that one line is enough for Chrome to refuse to inject it. It lives here with
 * `manifest.json`, `panel.html` and `panel.css` — the other files that ship as
 * they are written — rather than in `src/`. `reread-bridge.test.ts` asserts it
 * stays classic and that everything it imports stays web-accessible, which is
 * more than the compiler was giving it.
 *
 * This is deliberately NOT the shape capture uses. Capture is one gesture,
 * injected with `executeScript({ func })` at the moment it happens, serialised
 * across the boundary, and can hold no imports at all (D3). The detector is the
 * opposite: it has to be resident for as long as the page is, which is what a
 * declared content script is for.
 */
void (async () => {
  try {
    const bridge = await import(chrome.runtime.getURL('dist/reread-bridge.js'));
    const detector = await import(chrome.runtime.getURL('dist/reread.js'));
    const stop = await bridge.boot(
      (message) => chrome.runtime.sendMessage(message),
      (onCandidate, opts) => detector.startRereadDetector(onCandidate, opts),
      location.origin,
    );
    globalThis.addEventListener?.('pagehide', stop, { once: true });
  } catch {
    // A page that refuses the import gets no detector and no console noise. This
    // is a background nicety, and it must never be the reason a page looks
    // broken to the person reading it.
  }
})();
