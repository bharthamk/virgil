/**
 * Reading a file the learner dropped on the Check screen, and nothing else.
 *
 * What comes out of a document is **proposed, never imposed**. Every
 * function here returns text or a reason; nothing here sends anything, and
 * nothing here writes to a box. The panel puts the extracted text into the
 * textarea where the learner can read it, edit it and delete it before the
 * button is ever pressed. A file that was parsed straight into a request would
 * be this product silently submitting words nobody had looked at, on the one
 * screen whose entire promise is that it tells you what it did.
 *
 * There is no learner copy in this module. It answers with a discriminated
 * outcome and `panel-core.ts` turns that into a sentence, on the same split the
 * rest of the extension keeps: this file decides what is true about a file, and
 * the copy module decides how it reads.
 *
 * Three formats, three costs:
 *
 *  - **text** (`.txt`, `.md`, `.markdown`) is a decode and nothing more.
 *  - **docx** is a zip, and a zip with one entry worth having in it. The
 *    central directory is walked here and the entry is inflated with
 *    `DecompressionStream('deflate-raw')`, which the platform has had for
 *    years. A zip library would be this repository's first runtime dependency
 *    for eighty lines of arithmetic.
 *  - **pdf** is the one thing that genuinely cannot be hand-rolled, so
 *    `vendor/pdfjs` is committed and loaded **lazily**: the import happens the
 *    first time somebody drops a PDF and never on a screen that draws one. A
 *    3MB parser paid for on every render of the Check room would be a worse
 *    product than one that cannot read PDFs at all.
 *
 * Fail closed, everywhere. An unreadable file, an empty extraction and an
 * unsupported type all end as a reason and an untouched textarea. The failure
 * this shape exists to prevent is the quiet one: a scanned PDF yielding nothing
 * and the learner pressing the button on an empty box believing their essay is
 * in it.
 */

/** Where the vendored parser lives, relative to the extension root. Named here
 *  because two places need the strings and one of them is a test that checks
 *  the files are really on disk after a build. */
export const PDFJS_MODULE = 'vendor/pdfjs/pdf.mjs';
export const PDFJS_WORKER = 'vendor/pdfjs/pdf.worker.mjs';
export const PDFJS_FONTS = 'vendor/pdfjs/standard_fonts/';

/**
 * What a file may weigh.
 *
 * Two numbers rather than one, because the formats are not comparable: a
 * megabyte of `.txt` is already twice the longest thing the marker will read,
 * while ten megabytes of PDF is an ordinary scanned course handbook. The caps
 * are about not hanging the panel on a file nobody meant to drop; the *content*
 * caps that decide what the model sees are the service's, and the size meter on
 * the screen is where those are said out loud.
 */
export const UPLOAD_CAPS = {
  /** `.txt`, `.md`, `.markdown`. */
  textBytes: 1_000_000,
  /** `.docx` and `.pdf`, which carry their own overhead. */
  documentBytes: 10_000_000,
} as const;

export type UploadFormat = 'text' | 'docx' | 'pdf';
export type PageInputFormat = 'pdf' | 'image';

/**
 * What reading a file came to.
 *
 * `no-text` and `unreadable` are deliberately separate. A PDF of photographs
 * parsed perfectly and contained no text; a truncated docx did not parse at
 * all. Telling a learner "I could not read that" about the first one sends them
 * looking for a corrupt file, when what they need to hear is that the pages are
 * pictures.
 */
export type UploadOutcome =
  | { readonly kind: 'text'; readonly format: UploadFormat; readonly text: string }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'too-big'; readonly format: UploadFormat; readonly capBytes: number }
  | { readonly kind: 'no-text'; readonly format: UploadFormat }
  | { readonly kind: 'unreadable'; readonly format: UploadFormat };

/** The one file member this module needs, so a test can hand it a plain
 *  object and so nothing here depends on the `File` constructor existing. */
export interface UploadFile {
  readonly name: string;
  readonly type?: string;
  readonly size: number;
  /** Present when a browser folder picker supplied the file. Kept optional so
   *  every ordinary single-file surface and its test doubles stay unchanged. */
  readonly webkitRelativePath?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface UploadDeps {
  /** Swapped in tests. In the panel it is the lazy vendor import. */
  readonly loadPdfjs?: () => Promise<Pdfjs>;
  /** The extension url of `pdf.worker.mjs`. */
  readonly pdfWorkerSrc?: string;
  /** The extension url of the vendored standard-fonts directory. */
  readonly pdfFontsUrl?: string;
  /** Where a rendered page is drawn. Swapped in tests, and the reason nothing
   *  in this module names `OffscreenCanvas` outside one function. */
  readonly makeCanvas?: CanvasMaker;
  /** Browser image decode behind a seam so malformed-image and resize behavior
   *  are deterministic under node:test. */
  readonly decodeImage?: (bytes: Uint8Array, mime: 'image/png' | 'image/jpeg') => Promise<DecodedImage>;
}

// --------------------------------------------------------------- the format

const TEXT_MIMES = new Set([
  'text/plain', 'text/markdown', 'text/x-markdown', 'text/md',
]);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Which of the three this is, or nothing.
 *
 * Extension first and the OS's guess second, in that order on purpose: Chrome
 * hands `.md` over as `text/markdown` on one platform, `text/plain` on another
 * and `""` on a third, and the name is the thing the learner can see. A file
 * that matches neither is refused by name rather than sniffed — guessing at a
 * `.doc` or a `.pages` and half-reading it is worse than saying no.
 */
export function formatOf(name: string, mime = ''): UploadFormat | null {
  const lower = name.toLowerCase();
  if (/\.(txt|text|md|markdown)$/.test(lower)) return 'text';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.pdf')) return 'pdf';
  const type = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (TEXT_MIMES.has(type)) return 'text';
  if (type === DOCX_MIME) return 'docx';
  if (type === 'application/pdf') return 'pdf';
  return null;
}

/** The cap that applies to a format. */
export const capFor = (format: UploadFormat): number =>
  (format === 'text' ? UPLOAD_CAPS.textBytes : UPLOAD_CAPS.documentBytes);

/** What the file-picker advertises, so the OS dialog does not show the learner
 *  a folder of things this cannot read. */
export const UPLOAD_ACCEPT = '.txt,.text,.md,.markdown,.docx,.pdf';
/** A picker whose next step deliberately reads pictures through the Images
 * route. Ordinary document and whole-folder readers keep `UPLOAD_ACCEPT`: they
 * must never advertise a picture as locally extractable text. */
export const VISION_UPLOAD_ACCEPT = `${UPLOAD_ACCEPT},.png,.jpg,.jpeg`;

export function pageFormatOf(name: string, mime = ''): PageInputFormat | null {
  if (formatOf(name, mime) === 'pdf') return 'pdf';
  const lower = name.toLowerCase();
  const type = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (/\.(png|jpe?g)$/.test(lower) || type === 'image/png' || type === 'image/jpeg') return 'image';
  return null;
}

// ------------------------------------------------------------------ the zip

const EOCD_SIG = 0x0605_4b50;
const CENTRAL_SIG = 0x0201_4b50;
const LOCAL_SIG = 0x0403_4b50;
/** The sentinel a zip64 archive writes where a 32-bit field would go. */
const ZIP64 = 0xffff_ffff;
const DOCUMENT_ENTRY = 'word/document.xml';
/**
 * Maximum expanded size of the one DOCX member we read. This is deliberately
 * larger than the plain-text upload cap because WordprocessingML carries tags
 * around the learner's words, but small enough that one archive cannot turn a
 * panel into an unbounded decompression job.
 */
export const DOCX_XML_CAP_BYTES = 20_000_000;

class UnreadableFile extends Error {}

const utf8 = new TextDecoder('utf-8');

/** Inflate a raw deflate stream with the platform's own decompressor. */
async function inflateRaw(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  // `Blob(...).stream()` rather than a hand-built ReadableStream: it is the
  // one construction that is identical in the extension and under `node:test`.
  const stream = new Blob([data as BlobPart]).stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new UnreadableFile('expanded document too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}

/**
 * `word/document.xml`, out of a docx, without a zip library.
 *
 * A .docx is an ordinary zip, and the only honest way into one is the central
 * directory at its end: the local headers at the front may carry zeroed sizes
 * with the real ones in a data descriptor *after* the payload, which is exactly
 * the shape Word writes when it streams. So the directory is authoritative for
 * the sizes and the local header is read only for where the bytes start.
 *
 * Anything this does not understand — zip64, an encrypted entry, a compression
 * method that is not store or deflate — throws rather than returning a
 * best-effort slice. Half a document read as a whole one is the failure mode
 * that matters here.
 */
export async function docxXml(
  bytes: Uint8Array,
  maxXmlBytes: number = DOCX_XML_CAP_BYTES,
): Promise<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  const entries = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  if (at === ZIP64) throw new UnreadableFile('zip64');

  for (let i = 0; i < entries; i += 1) {
    if (at + 46 > bytes.byteLength || view.getUint32(at, true) !== CENTRAL_SIG) {
      throw new UnreadableFile('central directory');
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const uncompressed = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = utf8.decode(bytes.subarray(at + 46, at + 46 + nameLength));

    if (name === DOCUMENT_ENTRY) {
      // Bit 0 is the encryption flag. A password-protected assignment is a
      // thing a learner might genuinely have, and it is not readable here.
      if (flags & 0x1) throw new UnreadableFile('encrypted');
      if (compressed === ZIP64 || uncompressed === ZIP64 || localAt === ZIP64) {
        throw new UnreadableFile('zip64');
      }
      if (uncompressed > maxXmlBytes) throw new UnreadableFile('expanded document too large');
      if (localAt + 30 > bytes.byteLength) throw new UnreadableFile('local header');
      if (view.getUint32(localAt, true) !== LOCAL_SIG) throw new UnreadableFile('local header');
      const start = localAt + 30
        + view.getUint16(localAt + 26, true)
        + view.getUint16(localAt + 28, true);
      const payload = bytes.subarray(start, start + compressed);
      if (payload.byteLength !== compressed) throw new UnreadableFile('truncated');
      if (method === 0) {
        if (payload.byteLength !== uncompressed) throw new UnreadableFile('size mismatch');
        return utf8.decode(payload);
      }
      if (method === 8) {
        const expanded = await inflateRaw(payload, maxXmlBytes);
        if (expanded.byteLength !== uncompressed) throw new UnreadableFile('size mismatch');
        return utf8.decode(expanded);
      }
      throw new UnreadableFile(`compression method ${method}`);
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  throw new UnreadableFile(`no ${DOCUMENT_ENTRY}`);
}

/** The end-of-central-directory record, found the only way it can be: by
 *  scanning back from the end, because it ends in a variable-length comment. */
function findEocd(view: DataView): number {
  // 22 bytes of record plus a comment that cannot exceed 65,535.
  const floor = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let at = view.byteLength - 22; at >= floor; at -= 1) {
    if (view.getUint32(at, true) === EOCD_SIG) return at;
  }
  throw new UnreadableFile('not a zip');
}

// ------------------------------------------------------------------ the xml

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

const unescapeXml = (s: string): string => s.replace(
  /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g,
  (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    }
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name] ?? whole;
  },
);

/**
 * WordprocessingML down to the text a person wrote, one paragraph per line.
 *
 * Deliberately not a parser. Three constructs carry every visible character in
 * an ordinary assignment — `<w:t>` for text, `<w:tab/>` and `<w:br/>` for the
 * whitespace inside a paragraph — and they are matched **in document order**,
 * which is the part a naive `replace(/<[^>]+>/g, '')` gets wrong: it would also
 * empty out `<w:instrText>` field codes, deleted revisions and comment bodies
 * into the middle of the learner's sentences.
 *
 * `</w:p>` is the line break, because a paragraph in Word is a line to a
 * reader. Table cells fall out as paragraphs too, which reads as a list rather
 * than a table, and that is the right trade for a box whose next stop is a
 * language model.
 */
export function docxText(xml: string): string {
  const body = /<w:body[^>]*>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  const runs = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*>|<w:br\b[^>]*>|<w:cr\b[^>]*>/g;
  const lines: string[] = [];
  for (const paragraph of body.split(/<\/w:p>/)) {
    let line = '';
    runs.lastIndex = 0;
    let m = runs.exec(paragraph);
    while (m) {
      if (m[1] !== undefined) line += unescapeXml(m[1]);
      else if (m[0].startsWith('<w:tab')) line += '\t';
      else line += '\n';
      m = runs.exec(paragraph);
    }
    lines.push(line);
  }
  return tidy(lines.join('\n'));
}

/** Trailing whitespace off every line, no run of more than one blank line, and
 *  nothing at either end. What a person would have typed. */
export function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ------------------------------------------------------------------ the pdf

/**
 * The text of a PDF, and only the text.
 *
 * `getTextContent` per page and nothing else: no `render`, no canvas, no
 * `cMapUrl`, no wasm. That restraint is why this needs no CSP change in the
 * manifest and no host permission.
 *
 * `standardFontDataUrl` is the one exception, learned live rather than
 * assumed: a page that uses a base-14 font without embedding it — which is
 * most PDFs typed straight into a generator — makes pdf.js load that font's
 * glyph maps even for text extraction, and with nowhere to load them from the
 * whole document is refused as unreadable. The fonts are vendored files, so
 * pointing at them is the same kind of self-fetch as the worker itself, not a
 * network request.
 *
 * A PDF whose pages are photographs of paper parses perfectly and yields
 * nothing, and this returns the empty string for it rather than an error. The
 * caller turns that into the one sentence that actually helps.
 */
export async function pdfText(
  bytes: Uint8Array, pdfjs: Pdfjs, workerSrc?: string, fontsUrl?: string,
): Promise<string> {
  if (workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  const task = pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    // Nothing is drawn, so a font face is a cost with no picture at the end of
    // it. The glyph maps above are about reading, not drawing.
    disableFontFace: true,
    useSystemFonts: false,
    ...(fontsUrl ? { standardFontDataUrl: fontsUrl } : {}),
  });
  const doc = await task.promise;
  try {
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      // `hasEOL` is pdf.js's judgement and it is not always offered: two runs
      // set on different baselines routinely arrive as two items with no EOL
      // between them, and joining those bare would weld "moon." to "Line two".
      // For a rubric that is not cosmetic — the parser reads one criterion per
      // line, and a criteria list welded into one line is one criterion. So a
      // baseline drop is a line break too.
      let lastY: number | undefined;
      for (const item of content.items) {
        if (typeof item?.str !== 'string') continue;
        const y = item.transform?.[5];
        if (y !== undefined && lastY !== undefined && Math.abs(y - lastY) > 1 && text && !text.endsWith('\n')) {
          text += '\n';
        }
        if (y !== undefined) lastY = y;
        text += item.str;
        if (item.hasEOL) text += '\n';
      }
      const trimmed = tidy(text);
      if (trimmed) pages.push(trimmed);
    }
    // A page break is a blank line. Page numbers and running headers come along
    // with it, and stripping those by guesswork would eventually eat a heading.
    return pages.join('\n\n');
  } finally {
    // Teardown lives on the loading task, not the document: the v6 document
    // proxy has no `destroy`, and calling one that is not there would turn
    // every successfully read PDF into "unreadable" on the way out the door.
    await task.destroy().catch(() => {});
  }
}

// ------------------------------------------------------------- the pictures

/**
 * The other way a PDF can arrive, and the default one for the draft box.
 *
 * Everything above this line turns a document into a guess. `getTextContent`
 * gives back runs in the order the producer wrote them, with no columns, no
 * tables, no figures and no handwriting, and a scanned page gives back nothing
 * at all. The model on the other end reads pictures perfectly well. So the
 * pages are drawn, once, and go up as images beside whatever the learner typed.
 *
 * What this deliberately does NOT change:
 *
 *  - `isEvalSupported: false` stays. Drawing is not a reason to hand MV3's CSP
 *    an exception, and pdf.js does not need one to rasterise.
 *  - No `cMapUrl`, and no wasm. A page that needs either fails as a page rather
 *    than as a manifest change: `page-failed` names the page, the panel says so,
 *    and nothing is claimed about a document that did not draw.
 *  - `standardFontDataUrl` stays, and matters more here than it did for text.
 *    An unembedded base-14 font is a page with words missing from the picture,
 *    which is worse than the refusal it used to be.
 *  - The parser is still loaded lazily, by the same `defaultLoad`, so a screen
 *    that draws two textareas still pays nothing for the 3MB behind this.
 */

/** How many pages will be sent. Twenty pictures is already a large request to
 *  put in front of a model; past it the honest answer is the count, not a
 *  silent slice of the front of somebody's dissertation. */
export const MAX_PAGES = 20;

/**
 * The long edge of a rendered page, in pixels.
 *
 * 1568 is the size at which a page of ordinary body text is legible to a vision
 * model without paying for pixels nobody reads. Smaller loses footnotes; larger
 * costs tokens and bytes for glyphs that were already sharp.
 */
export const PAGE_EDGE_PX = 1568;

/** JPEG rather than PNG, because a rendered page is a photograph-shaped thing
 *  and a lossless one is four times the bytes for no readable difference. */
export const PAGE_QUALITY = 0.85;

/** The service's decoded page ceiling. Twenty base64-expanded pages at this
 *  size plus their JSON envelope stay beneath the 28 MiB request boundary. */
export const PAGE_WIRE_BYTES = 1_000_000;

/** Preserve the normal page at 0.85; only unusually dense scans pay a lower
 *  JPEG quality, in bounded steps, rather than discovering a 413 after send. */
const PAGE_QUALITIES = [PAGE_QUALITY, 0.72, 0.6, 0.5] as const;

/** Guards a pathological page box: a 2-point-wide page would otherwise be
 *  blown up by a factor of a thousand and allocate a canvas nobody can hold. */
const MAX_SCALE = 8;

/**
 * The surface a page is drawn on, as the two things this module needs from one.
 *
 * A seam rather than a direct `OffscreenCanvas`, for two reasons that are both
 * real: the panel renders inside a side panel where `OffscreenCanvas` is the
 * right choice and an ordinary `<canvas>` is the fallback, and a test has
 * neither. Nothing below `defaultCanvas` knows which of the three it has.
 */
export interface PageCanvas {
  readonly width: number;
  readonly height: number;
  getContext(kind: '2d'): unknown;
  /** The finished page, as a `data:image/jpeg;base64,...` uri. */
  toDataUri(quality: number): Promise<string>;
}

export type CanvasMaker = (width: number, height: number) => PageCanvas;

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  draw(context: unknown, width: number, height: number): void;
  close?(): void;
}

/**
 * What rendering a PDF came to.
 *
 * The same discipline as `UploadOutcome` and for the same reason: every failure
 * is named, none of them is silence, and `page-failed` carries the page number
 * because "page 7 would not draw" is something a learner can act on and "that
 * did not work" is not.
 */
export type PagesOutcome =
  | { readonly kind: 'pages'; readonly pages: readonly string[] }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'too-big'; readonly format: PageInputFormat; readonly capBytes: number }
  | { readonly kind: 'too-many-pages'; readonly pageCount: number; readonly capPages: number }
  | { readonly kind: 'page-failed'; readonly page: number; readonly pageCount: number }
  | { readonly kind: 'unreadable'; readonly format: PageInputFormat };

const CHUNK = 0x2000 * 3;

/**
 * Bytes to base64, in aligned chunks.
 *
 * `image.ts` learned this the hard way and the lesson transfers verbatim: a
 * spread of a megabyte of arguments overflows a Chrome worker's stack at about
 * 64,000 while Node takes 124,000, so a suite can be green while every page
 * over a certain size throws in the browser. The chunk is a multiple of three
 * so no boundary falls inside a base64 group.
 */
const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return btoa(binary);
};

const imageMime = (file: UploadFile): 'image/png' | 'image/jpeg' => {
  const type = file.type?.split(';')[0]?.trim().toLowerCase();
  if (type === 'image/png' || type === 'image/jpeg') return type;
  return file.name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
};

const defaultDecodeImage = async (
  bytes: Uint8Array, mime: 'image/png' | 'image/jpeg',
): Promise<DecodedImage> => {
  const exact = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const bitmap = await createImageBitmap(new Blob([exact], { type: mime }));
  return {
    width: bitmap.width,
    height: bitmap.height,
    draw: (context, width, height) => {
      (context as CanvasRenderingContext2D).drawImage(bitmap, 0, 0, width, height);
    },
    close: () => bitmap.close(),
  };
};

const canvasDataUri = async (canvas: PageCanvas): Promise<string> => {
  for (const quality of PAGE_QUALITIES) {
    const uri = await canvas.toDataUri(quality);
    const found = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(uri);
    if (!found) throw new UnreadableFile('not an image');
    const encoded = found[2] ?? '';
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    const bytes = Math.floor((encoded.length * 3) / 4) - padding;
    if (bytes <= PAGE_WIRE_BYTES) return uri;
  }
  throw new UnreadableFile('rendered page is too large');
};

async function imagePage(
  bytes: Uint8Array,
  mime: 'image/png' | 'image/jpeg',
  deps: UploadDeps,
): Promise<PagesOutcome> {
  const decoded = await (deps.decodeImage ?? defaultDecodeImage)(bytes, mime);
  try {
    const longest = Math.max(decoded.width, decoded.height);
    if (!Number.isFinite(longest) || longest < 1) throw new UnreadableFile('empty image');
    const scale = Math.min(1, PAGE_EDGE_PX / longest);
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const canvas = (deps.makeCanvas ?? defaultCanvas)(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new UnreadableFile('no 2d context');
    decoded.draw(context, width, height);
    return { kind: 'pages', pages: [await canvasDataUri(canvas)] };
  } finally {
    decoded.close?.();
  }
}

/**
 * The panel's canvas, which is an `OffscreenCanvas` where there is one.
 *
 * Preferred because the side panel is a small document and a rasterised A4 page
 * is a 1568px bitmap: keeping it off the element tree keeps it out of layout
 * and out of the compositor. The fallback is an ordinary detached `<canvas>`,
 * which is what the QA page over http gets if a browser ever lacks the first,
 * and which is why `document.createElement` appears here rather than being
 * assumed away.
 */
export const defaultCanvas: CanvasMaker = (width, height) => {
  const offscreen = (globalThis as { OffscreenCanvas?: new (w: number, h: number) => {
    getContext(kind: string): unknown;
    convertToBlob(options: { type: string; quality: number }): Promise<Blob>;
  } }).OffscreenCanvas;
  if (typeof offscreen === 'function') {
    const canvas = new offscreen(width, height);
    return {
      width,
      height,
      getContext: (kind) => canvas.getContext(kind),
      toDataUri: async (quality) => {
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return `data:image/jpeg;base64,${toBase64(bytes)}`;
      },
    };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return {
    width,
    height,
    getContext: (kind) => canvas.getContext(kind),
    toDataUri: async (quality) => canvas.toDataURL('image/jpeg', quality),
  };
};

/**
 * Every page of a PDF, drawn, as JPEG data uris.
 *
 * The cap is checked against `numPages` BEFORE a single page is drawn, so a
 * hundred-page handbook costs one parse rather than twenty renders and then a
 * refusal. A page that throws stops the whole thing: nineteen pages of an
 * eighteen-page essay marked as if it were all of it is exactly the silent
 * partial this product refuses everywhere else.
 */
export async function pdfPages(
  bytes: Uint8Array,
  pdfjs: Pdfjs,
  deps: {
    workerSrc?: string | undefined;
    fontsUrl?: string | undefined;
    makeCanvas?: CanvasMaker | undefined;
  } = {},
): Promise<PagesOutcome> {
  if (deps.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = deps.workerSrc;
  const make = deps.makeCanvas ?? defaultCanvas;
  const task = pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    // `disableFontFace` is deliberately NOT set here, where `pdfText` sets it:
    // extraction wanted the glyph maps and no font faces, and drawing wants the
    // font faces or the page comes out with the words missing.
    ...(deps.fontsUrl ? { standardFontDataUrl: deps.fontsUrl } : {}),
  });
  const doc = await task.promise;
  try {
    if (doc.numPages > MAX_PAGES) {
      return { kind: 'too-many-pages', pageCount: doc.numPages, capPages: MAX_PAGES };
    }
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      try {
        pages.push(await drawPage(doc, n, make));
      } catch {
        return { kind: 'page-failed', page: n, pageCount: doc.numPages };
      }
    }
    if (!pages.length) return { kind: 'unreadable', format: 'pdf' };
    return { kind: 'pages', pages };
  } finally {
    // Teardown lives on the loading task, exactly as it does for the text path.
    await task.destroy().catch(() => {});
  }
}

async function drawPage(doc: PdfjsDocument, n: number, make: CanvasMaker): Promise<string> {
  const page = await doc.getPage(n);
  const unit = page.getViewport({ scale: 1 });
  const longest = Math.max(unit.width, unit.height);
  // A page box of zero is a document lying about itself. Scale 1 rather than a
  // division by zero, and let the render decide whether it is really a page.
  const scale = longest > 0 ? Math.min(PAGE_EDGE_PX / longest, MAX_SCALE) : 1;
  const viewport = page.getViewport({ scale });
  const canvas = make(Math.max(1, Math.round(viewport.width)), Math.max(1, Math.round(viewport.height)));
  const context = canvas.getContext('2d');
  if (!context) throw new UnreadableFile('no 2d context');
  // `intent: 'print'` is load-bearing and is not about appearance. See
  // `PdfjsRenderSource.intent`: a display render advances one chunk per
  // animation frame, and this canvas is never on screen to have frames. A side
  // panel the learner has tabbed away from is a hidden document, and a hidden
  // document gets no frames at all.
  await page.render({ canvasContext: context, canvas, viewport, intent: 'print' }).promise;
  return canvasDataUri(canvas);
}

/**
 * One file in, its pages out, or a reason.
 *
 * The same check order as `readUpload`, and for the same reason: a type nobody
 * can draw is refused before its size, and a size nobody should open is refused
 * before its bytes. Only a PDF has an as-is route — a .docx is a zip of XML and
 * no provider takes one natively, and a .txt is already the thing it would be
 * a picture of.
 */
export async function readPages(file: UploadFile, deps: UploadDeps = {}): Promise<PagesOutcome> {
  const pageFormat = pageFormatOf(file.name, file.type ?? '');
  if (!pageFormat) return { kind: 'unsupported' };

  const capBytes = capFor('pdf');
  if (file.size > capBytes) return { kind: 'too-big', format: pageFormat, capBytes };

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch { return { kind: 'unreadable', format: pageFormat }; }

  try {
    if (pageFormat === 'image') return await imagePage(bytes, imageMime(file), deps);
    const pdfjs = await (deps.loadPdfjs ?? defaultLoad)();
    return await pdfPages(bytes, pdfjs, {
      workerSrc: deps.pdfWorkerSrc ?? safeWorkerSrc(),
      fontsUrl: deps.pdfFontsUrl ?? safeFontsUrl(),
      makeCanvas: deps.makeCanvas,
    });
  } catch { return { kind: 'unreadable', format: pageFormat }; }
}

/** The lazy vendor import, which is the only reason this file knows about
 *  `chrome` at all. Overridden in tests, where there is no extension. */
const defaultLoad = async (): Promise<Pdfjs> =>
  // A runtime specifier: `tsc` cannot resolve a `chrome-extension://` url and
  // must not try. `pdfjs.d.ts` is the contract instead. There is no bundler in
  // this repository, so this survives to the browser exactly as written.
  (await import(chrome.runtime.getURL(PDFJS_MODULE))) as Pdfjs;

// -------------------------------------------------------------- the reading

/**
 * One file in, text or a reason out.
 *
 * The order is the order the checks have to happen in: a type nobody can read
 * is refused before its size is looked at, and a size nobody should read is
 * refused before the bytes are touched, so a 200MB PDF is never held in memory
 * to find out it is too big.
 */
export async function readUpload(file: UploadFile, deps: UploadDeps = {}): Promise<UploadOutcome> {
  const format = formatOf(file.name, file.type ?? '');
  if (!format) return { kind: 'unsupported' };

  const capBytes = capFor(format);
  if (file.size > capBytes) return { kind: 'too-big', format, capBytes };

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch { return { kind: 'unreadable', format }; }

  let text: string;
  try {
    if (format === 'text') text = tidy(utf8.decode(bytes));
    else if (format === 'docx') text = docxText(await docxXml(bytes));
    else {
      const pdfjs = await (deps.loadPdfjs ?? defaultLoad)();
      text = tidy(await pdfText(
        bytes,
        pdfjs,
        deps.pdfWorkerSrc ?? safeWorkerSrc(),
        deps.pdfFontsUrl ?? safeFontsUrl(),
      ));
    }
  } catch { return { kind: 'unreadable', format }; }

  if (!text) return { kind: 'no-text', format };
  return { kind: 'text', format, text };
}

/** The worker url, when there is an extension to ask. Outside one there is
 *  nothing to say, and pdf.js falls back to its own default. */
function safeWorkerSrc(): string | undefined {
  try { return chrome.runtime.getURL(PDFJS_WORKER); } catch { return undefined; }
}

/** The vendored standard-fonts directory, guarded the same way. */
function safeFontsUrl(): string | undefined {
  try { return chrome.runtime.getURL(PDFJS_FONTS); } catch { return undefined; }
}

/**
 * Where extracted text goes when the box is not empty.
 *
 * Appended behind a blank line rather than replacing what is there. A learner
 * who has typed half a paragraph and then drops the assignment file should not
 * lose the half paragraph, and a product that silently overwrote a box would be
 * doing the thing this whole screen is built not to do.
 */
export function appendText(existing: string, incoming: string): string {
  const before = existing.replace(/\s+$/, '');
  return before ? `${before}\n\n${incoming}` : incoming;
}
