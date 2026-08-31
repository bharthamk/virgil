/**
 * A stand-in for `vendor/pdfjs/pdf.mjs`, reached the way the real one is.
 *
 * `upload.ts` loads the parser through `import(chrome.runtime.getURL(...))`,
 * which is a runtime specifier by design: `tsc` cannot resolve a
 * `chrome-extension://` url and must not try. That makes the lazy import the
 * one seam in the file with no dependency-injection hole in it, and the panel
 * calls `readUpload`/`readPages` with no deps at all.
 *
 * So the wiring tests point `chrome.runtime.getURL` at this directory instead.
 * Importing the real vendor build here would make every run of the suite depend
 * on a 3MB third-party parser starting a worker, which is a slower suite and a
 * worse signal: what the wiring tests are about is which route a dropped file
 * takes and what ends up on the screen, not whether Mozilla can read a PDF.
 *
 * The document is described by the file's own bytes, as JSON, so a test writes
 * the PDF it wants:
 *
 *   {"pages": 4}                  four pages, no text in them (a scan)
 *   {"pages": 2, "text": "..."}   two pages, that text on the first
 *   {"pages": 3, "failOn": 2}     page 2 will not draw
 *   {"pages": 3, "openFails": 1}  the document itself will not open
 */

const decoder = new TextDecoder();

const describe = (data) => {
  try {
    const parsed = JSON.parse(decoder.decode(data));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

export const GlobalWorkerOptions = { workerSrc: '' };

export function getDocument(source) {
  const spec = describe(source.data);
  let destroyed = false;
  return {
    promise: spec.openFails
      ? Promise.reject(new Error('this document will not open'))
      : Promise.resolve({
        numPages: spec.pages ?? 1,
        getPage: async (n) => ({
          getTextContent: async () => ({
            items: n === 1 && spec.text
              ? String(spec.text).split('\n').map((str) => ({ str, hasEOL: true }))
              : [],
          }),
          getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale }),
          render: () => ({
            promise: spec.failOn === n
              ? Promise.reject(new Error('this page will not draw'))
              : Promise.resolve(),
          }),
        }),
      }),
    destroy: async () => { destroyed = true; return destroyed; },
  };
}
