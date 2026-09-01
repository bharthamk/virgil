/**
 * The bits of pdf.js this product actually touches, written by hand.
 *
 * `vendor/pdfjs/pdf.mjs` is loaded at runtime through
 * `import(chrome.runtime.getURL(...))`, which is a specifier `tsc` cannot see
 * and must not try to: the file is a committed vendor blob outside `rootDir`,
 * and pointing the compiler at `pdfjs-dist`'s own 400-file `types/` tree would
 * make a build dependency out of a package that exists here only to be copied
 * from. So the seam is typed here instead, and it is deliberately the smallest
 * surface that does the job.
 *
 * Four calls: set the worker url, open a document from bytes, walk the pages,
 * ask each one for its text. No rendering, no canvas, no fonts, no cMaps. A
 * member that appears in this file is a member something in `upload.ts` calls;
 * anything else pdf.js offers is not part of the contract and should not be
 * reachable without a line being added here first.
 */

/** One run of text out of `getTextContent`. pdf.js also returns marked-content
 *  markers in the same array, which carry no `str` and are skipped. */
interface PdfjsTextItem {
  readonly str?: string;
  /** pdf.js's own judgement that a visual line ended here. */
  readonly hasEOL?: boolean;
  /** The text matrix; index 5 is the baseline y, read to catch the line
   *  breaks `hasEOL` does not report. */
  readonly transform?: readonly number[];
}

interface PdfjsTextContent {
  readonly items: readonly PdfjsTextItem[];
}

/** The page box at a given scale, in css pixels. Only the two numbers a canvas
 *  has to be sized to; the matrix pdf.js also carries is its own business. */
interface PdfjsViewport {
  readonly width: number;
  readonly height: number;
}

/** What `page.render` hands back. The task also carries `cancel`, which nothing
 *  here calls: a page render that has to be abandoned is abandoned by the
 *  document being destroyed in the `finally`. */
interface PdfjsRenderTask {
  readonly promise: Promise<void>;
}

interface PdfjsRenderSource {
  /** pdf.js takes `canvas` from `canvasContext.canvas` when it is not given.
   *  It is passed explicitly because an OffscreenCanvas context's `.canvas` is
   *  the OffscreenCanvas, and being explicit is cheaper than relying on that. */
  readonly canvasContext: unknown;
  readonly canvas?: unknown;
  readonly viewport: PdfjsViewport;
  /**
   * `'display'` or `'print'`, and the difference here is not about appearance.
   *
   * A display render advances one chunk per `requestAnimationFrame`, which is
   * the right scheduler for a page being painted into a viewport somebody is
   * looking at. Nothing here is painted into anything: the canvas is off the
   * document and its only future is being serialised to a JPEG. Found live on
   * 2026-08-24 in the QA page, whose tab is hidden while it is driven: a hidden
   * document gets no frames, so a display render never advances past its first
   * chunk and the promise simply never settles.
   *
   * `'print'` is pdf.js's own name for "rasterise this, you are not on screen",
   * and it is the branch that schedules on microtasks instead.
   */
  readonly intent?: 'display' | 'print';
}

interface PdfjsPage {
  getTextContent(): Promise<PdfjsTextContent>;
  /**
   * The second thing this product asks a page for, and the reason the render
   * members below exist at all: a PDF whose pages are pictures has no text to
   * lift out, and the pictures themselves are what a multimodal model reads.
   */
  getViewport(params: { scale: number }): PdfjsViewport;
  render(source: PdfjsRenderSource): PdfjsRenderTask;
}

interface PdfjsDocument {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfjsPage>;
}

interface PdfjsLoadingTask {
  readonly promise: Promise<PdfjsDocument>;
  /** The only teardown there is: the v6 document proxy has no `destroy`. */
  destroy(): Promise<void>;
}

interface PdfjsGetDocumentSource {
  readonly data: Uint8Array;
  /**
   * MV3's content security policy forbids `eval`, and pdf.js uses it for the
   * font/expression fast paths unless it is told not to. Passed on every call
   * rather than left to a default, because the default has changed before.
   */
  readonly isEvalSupported: false;
  readonly disableFontFace?: boolean;
  readonly useSystemFonts?: boolean;
  /**
   * The vendored standard-fonts directory. Without it a page that uses a
   * base-14 font without embedding it is refused outright — even for text
   * extraction — so this is load-bearing for reading, not a rendering nicety.
   */
  readonly standardFontDataUrl?: string;
}

/** The module object `import()` resolves to. */
interface Pdfjs {
  readonly GlobalWorkerOptions: { workerSrc: string };
  getDocument(source: PdfjsGetDocumentSource): PdfjsLoadingTask;
}
