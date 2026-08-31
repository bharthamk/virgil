/**
 * READING A DOCUMENT ON THE SERVER, WHICH IS A DIFFERENT PROBLEM FROM READING
 * ONE IN THE PANEL.
 *
 * `extension/src/upload.ts` already reads a file a learner drops on the Check
 * screen: one file, chosen deliberately, with a person watching the box it lands
 * in. This is the other case — **a semester arrives at once**. Fifty to three
 * hundred documents go into one course drop, nobody is watching each one, and
 * the only thing that makes that honest is that every item the server cannot
 * read comes back as a named failure rather than as an absence.
 *
 * ## Why this is a second implementation and not an import
 *
 * The extension imports nothing from `@sb/core` and that is deliberate: it ships
 * as an unbundled MV3 extension and every import is a file in the package. So
 * `upload.ts` spells out its own zip walk, and this file spells out its own. The
 * two are held together by the fact that the *formats* are the contract and both
 * are tested against the same bytes, not by a shared module neither side can
 * take.
 *
 * ## What the server can actually read, decided honestly
 *
 *  - **text** (`.txt`, `.md`) — a decode. Free.
 *  - **html** — tags out, block structure kept. Cheap, and the block structure
 *    is the whole point: `domain/intake.ts` reads a syllabus **line by line**,
 *    so an HTML-to-text that flattens a document into one paragraph produces a
 *    course with no objectives, no material and no deadlines while reporting
 *    perfect success. That is the worst failure available here, and it is why
 *    `htmlToText` below is block-aware and `LocalResearch`'s private one — built
 *    for a Forager that only ever slices a window of prose — is not.
 *  - **docx** — a zip with one entry worth having. The central directory is
 *    walked here and the entry is inflated by a function the caller injects,
 *    because `core/` may not do I/O and a decompressor is the caller's to own.
 *    A zip library would be this repository's first runtime dependency for
 *    eighty lines of arithmetic, and `upload.ts` already declined to take it.
 *  - **pdf** — **not here, and said so rather than attempted.** pdf.js is
 *    vendored in the extension at 3MB, targets a browser worker, and hand-rolling
 *    the subset that reads a text operator through a font encoding is not eighty
 *    lines of arithmetic; it is the thing `upload.ts` calls *"the one thing that
 *    genuinely cannot be hand-rolled"*. A course drop containing PDFs therefore
 *    reports them, per item, as readable somewhere else — which is true, because
 *    the panel reads them — instead of dropping them silently or shipping a
 *    half-parser whose failures look like empty documents. `SERVER_PARSE_COVERAGE`
 *    is that table, as data, so a doc page and a test read the same one.
 *
 * Nothing here reads a clock, touches I/O, or knows what a request is.
 */

export type DocumentFormat = 'text' | 'html' | 'docx' | 'pdf';

/**
 * Where a format can be turned into text.
 *
 * `extension` is not a synonym for "unsupported". A PDF in a course drop is a
 * document this product reads every day — on the other side of the seam, with a
 * vendored parser and a canvas — and the learner's repair is to send its text
 * rather than its bytes. Collapsing that into `unsupported` would tell somebody
 * their file cannot be read by a product that is reading files exactly like it.
 */
export type ParseSite = 'server' | 'extension' | 'nowhere';

export interface ParseCoverage {
  readonly format: DocumentFormat;
  readonly extensions: readonly string[];
  readonly mimes: readonly string[];
  readonly where: ParseSite;
  /** One line, and it is what the honest per-item failure says. */
  readonly note: string;
}

export const SERVER_PARSE_COVERAGE: readonly ParseCoverage[] = [
  {
    format: 'text',
    extensions: ['.txt', '.text', '.md', '.markdown'],
    mimes: ['text/plain', 'text/markdown', 'text/x-markdown', 'text/md'],
    where: 'server',
    note: 'Decoded as UTF-8. Line structure is the source’s own.',
  },
  {
    format: 'html',
    extensions: ['.html', '.htm', '.xhtml'],
    mimes: ['text/html', 'application/xhtml+xml'],
    where: 'server',
    note: 'Scripts and styles dropped, block elements kept as lines.',
  },
  {
    format: 'docx',
    extensions: ['.docx'],
    mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    where: 'server',
    note: 'word/document.xml is inflated from the zip; one line per paragraph.',
  },
  {
    format: 'pdf',
    extensions: ['.pdf'],
    mimes: ['application/pdf'],
    where: 'extension',
    note: 'PDFs are read in the extension, where pdf.js is vendored. Send this one’s text, or drop it on Check.',
  },
];

/**
 * What a document may weigh before it is refused unread.
 *
 * Two numbers, for the reason `upload.ts` gives: a megabyte of `.txt` is already
 * far more than any prompt window in the fleet, while several megabytes of
 * `.docx` is an ordinary course handbook. These are the *server's* caps and are
 * deliberately not imported from the panel's — the panel is protecting a render
 * loop and this is protecting a request that may be carrying three hundred of
 * them at once.
 */
export const DOCUMENT_CAPS = {
  /** `.txt`, `.md`, `.html`. */
  textBytes: 1_000_000,
  /** `.docx`, which carries its own overhead. */
  documentBytes: 8_000_000,
} as const;

/**
 * The most text one dropped document contributes.
 *
 * `buildDeterministicIntake` already cuts its source at 60,000 characters, and a
 * pin's material is cut far shorter than that by every agent that reads one. The
 * cap here is about the *store*: three hundred documents at a megabyte each is a
 * board file nobody can open, written by one request.
 */
export const DOCUMENT_TEXT_CHARS = 200_000;

export const capForFormat = (format: DocumentFormat): number =>
  (format === 'docx' || format === 'pdf' ? DOCUMENT_CAPS.documentBytes : DOCUMENT_CAPS.textBytes);

/**
 * What reading one document came to.
 *
 * Five failures rather than one, because they lead to five different repairs and
 * a course drop that reported them all as "failed" would be telling somebody to
 * look at three hundred files to find out which. `no-text` and `unreadable` are
 * kept apart for the reason `upload.ts` keeps them apart: a docx full of images
 * parsed perfectly and contained nothing, and a truncated one did not parse.
 */
export type ExtractionOutcome =
  | { readonly kind: 'text'; readonly format: DocumentFormat; readonly text: string; readonly truncated: boolean }
  /** Not a format this product names at all. Refused by name, never sniffed. */
  | { readonly kind: 'unsupported'; readonly name: string }
  /** A real format, read on the other side of the seam. See `ParseSite`. */
  | { readonly kind: 'elsewhere'; readonly format: DocumentFormat; readonly where: ParseSite; readonly note: string }
  | { readonly kind: 'too-big'; readonly format: DocumentFormat; readonly capBytes: number; readonly bytes: number }
  | { readonly kind: 'no-text'; readonly format: DocumentFormat }
  | { readonly kind: 'unreadable'; readonly format: DocumentFormat; readonly detail: string };

/** One line naming what happened, for a per-item receipt the learner reads. */
export function describeExtraction(outcome: ExtractionOutcome): string {
  switch (outcome.kind) {
    case 'text':
      return outcome.truncated
        ? `read, and cut at ${DOCUMENT_TEXT_CHARS.toLocaleString('en-US')} characters`
        : 'read';
    case 'unsupported': return `“${outcome.name}” is not a document type this can read`;
    case 'elsewhere': return outcome.note;
    case 'too-big':
      return `too big at ${Math.round(outcome.bytes / 1000).toLocaleString('en-US')}kB, against a`
        + ` ${Math.round(outcome.capBytes / 1000).toLocaleString('en-US')}kB limit`;
    case 'no-text': return 'parsed, and there was no text in it';
    case 'unreadable': return `could not be read: ${outcome.detail}`;
  }
}

// ---------------------------------------------------------------- the format

const TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'text/x-markdown', 'text/md']);
const HTML_MIMES = new Set(['text/html', 'application/xhtml+xml']);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Which format this is, or nothing.
 *
 * Extension first and the declared type second, exactly as the panel decides it,
 * and for the same reason: a `.md` arrives as `text/markdown`, `text/plain` or
 * `""` depending on who is sending, and the file name is the thing a person can
 * see. Anything matching neither is refused by name rather than sniffed — a
 * `.pages` half-read as a zip is a worse outcome than a stated no.
 */
export function documentFormatOf(name: string, mime = ''): DocumentFormat | null {
  const lower = name.toLowerCase();
  if (/\.(txt|text|md|markdown)$/.test(lower)) return 'text';
  if (/\.(html?|xhtml)$/.test(lower)) return 'html';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.pdf')) return 'pdf';
  const type = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (TEXT_MIMES.has(type)) return 'text';
  if (HTML_MIMES.has(type)) return 'html';
  if (type === DOCX_MIME) return 'docx';
  if (type === 'application/pdf') return 'pdf';
  return null;
}

export const parseSiteFor = (format: DocumentFormat): ParseCoverage =>
  SERVER_PARSE_COVERAGE.find((c) => c.format === format) as ParseCoverage;

// ------------------------------------------------------------------- tidying

/** Trailing whitespace off every line, no run of more than one blank line, and
 *  nothing at either end. The same shape `upload.ts` settles on, for the same
 *  reason: what is downstream of this is a line-based extractor. */
export function tidyText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------- html

/**
 * The named entities worth decoding, and one reason they are escaped.
 *
 * `ndash` and `mdash` are written as code points rather than as the characters
 * they name. `copy-style.test.ts` walks `core/src/domain` as a directory looking
 * for a dash inside a string literal, because the learner-lineup contract’s offending sentence
 * turned out to be written here rather than in the panel — and a lookup table
 * that decodes a dash is indistinguishable, to a scanner reading source, from a
 * sentence that contains one. Escaping is the honest way to be a table and not a
 * sentence.
 */
const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '\u2013', mdash: '\u2014', hellip: '…', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”',
};

export function unescapeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = Number.parseInt(name.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (name.startsWith('#')) {
      const code = Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name] ?? whole;
  });
}

/**
 * Elements that end a line, because a reader sees them end one.
 *
 * The list is short on purpose. It is not an attempt to model HTML; it is the
 * set of tags a course page actually uses to separate one obligation, one
 * reading or one week from the next. Table rows and cells are handled
 * separately below: rows end lines, while cells stay together on that row.
 */
const BLOCK_TAGS = [
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
  'table', 'tbody', 'tfoot', 'thead', 'ul',
];
const BLOCK_RE = new RegExp(`</?(?:${BLOCK_TAGS.join('|')})(?:\\s[^>]*)?/?>`, 'gi');
const TABLE_CELL_RE = /<\/?(?:td|th)(?:\s[^>]*)?\/?>/gi;
const TABLE_ROW_RE = /<\/?tr(?:\s[^>]*)?\/?>/gi;

/**
 * HTML down to the text a person reads, one block per line.
 *
 * Deliberately not a parser, and deliberately block-aware. `<script>` and
 * `<style>` bodies go first — they are code, and a course page is full of both —
 * then comments, then every block boundary becomes a newline, then what is left
 * of the markup is dropped. The order matters: dropping tags first would weld
 * the assessment table into one line and take the deadlines with it.
 */
export function htmlToText(html: string): string {
  const withoutCode = html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  // A row is one planning fact. Making each cell a line separated “Lab report”
  // from “due 9 September” and created two broken obligations; flattening the
  // whole table loses the boundary between this report and the next one. Keep
  // cell text together with spaces and row boundaries as newlines.
  const withRows = withoutCode
    .replace(TABLE_CELL_RE, ' ')
    .replace(TABLE_ROW_RE, '\n');
  const withBreaks = withRows.replace(BLOCK_RE, '\n');
  const bare = withBreaks.replace(/<[^>]*>/g, ' ');
  // Runs of spaces and tabs collapse; newlines survive, because they are the
  // structure this whole function exists to keep.
  const spaced = unescapeEntities(bare)
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[^\S\n]*\n[^\S\n]*/g, '\n');
  // **One** newline per boundary, not two. Every block contributes a break for
  // its opening tag and another for its closing one, so `</li><li>` arrives here
  // as a blank line between two list items — and a blank line carries nothing a
  // line break has not already carried to the reader downstream, which reads
  // lines. `tidyText` would leave them at one blank line apiece and double the
  // length of every course page for no information.
  return tidyText(spaced.replace(/\n[^\S\n]*\n+/g, '\n'));
}

/** The `<title>`, where there is one. Used as a document's name when the drop
 *  did not give it one. */
export const htmlTitle = (html: string): string | null => {
  const found = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const text = found === undefined ? '' : unescapeEntities(found).replace(/\s+/g, ' ').trim();
  return text || null;
};

// ----------------------------------------------------------------------- zip

const EOCD_SIG = 0x0605_4b50;
const CENTRAL_SIG = 0x0201_4b50;
const LOCAL_SIG = 0x0403_4b50;
/** The sentinel a zip64 archive writes where a 32-bit field would go. */
const ZIP64 = 0xffff_ffff;
const DOCUMENT_ENTRY = 'word/document.xml';

/** Raw-deflate decompression, supplied by whoever owns I/O in this process.
 *  `core/` names the capability and never constructs one. */
export type InflateRaw = (data: Uint8Array) => Promise<Uint8Array>;

/** A document that is the shape it claims and is not readable anyway. Carried
 *  as its own error so the caller can tell it from a bug in this file. */
export class DocumentUnreadable extends Error {
  constructor(readonly detail: string) { super(detail); this.name = 'DocumentUnreadable'; }
}

const utf8 = new TextDecoder('utf-8');

/**
 * `word/document.xml`, out of a docx, without a zip library.
 *
 * The central directory at the end of the archive is authoritative, because the
 * local headers at the front may carry zeroed sizes with the real ones in a data
 * descriptor *after* the payload — which is exactly what Word writes when it
 * streams. So the directory decides the sizes and the local header is read only
 * for where the bytes begin.
 *
 * Anything not understood — zip64, encryption, a compression method that is
 * neither store nor deflate — throws rather than returning a best-effort slice.
 * Half a syllabus read as a whole one is the failure that matters: it produces a
 * course with half its deadlines and nothing anywhere saying so.
 */
export async function docxDocumentXml(bytes: Uint8Array, inflateRaw: InflateRaw): Promise<string> {
  if (bytes.byteLength < 22) throw new DocumentUnreadable('not a zip');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  const entries = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  if (at === ZIP64) throw new DocumentUnreadable('zip64');

  for (let i = 0; i < entries; i += 1) {
    if (at + 46 > bytes.byteLength || view.getUint32(at, true) !== CENTRAL_SIG) {
      throw new DocumentUnreadable('central directory');
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = utf8.decode(bytes.subarray(at + 46, at + 46 + nameLength));

    if (name === DOCUMENT_ENTRY) {
      // Bit 0 is the encryption flag. A password-protected course handbook is a
      // thing somebody genuinely has, and it is not readable here.
      if (flags & 0x1) throw new DocumentUnreadable('encrypted');
      if (compressed === ZIP64 || localAt === ZIP64) throw new DocumentUnreadable('zip64');
      if (localAt + 30 > bytes.byteLength || view.getUint32(localAt, true) !== LOCAL_SIG) {
        throw new DocumentUnreadable('local header');
      }
      const start = localAt + 30
        + view.getUint16(localAt + 26, true)
        + view.getUint16(localAt + 28, true);
      const payload = bytes.subarray(start, start + compressed);
      if (payload.byteLength !== compressed) throw new DocumentUnreadable('truncated');
      if (method === 0) return utf8.decode(payload);
      if (method === 8) return utf8.decode(await inflateRaw(payload));
      throw new DocumentUnreadable(`compression method ${method}`);
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  throw new DocumentUnreadable(`no ${DOCUMENT_ENTRY}`);
}

/** The end-of-central-directory record, found the only way it can be: by
 *  scanning back from the end, because it ends in a variable-length comment. */
function findEocd(view: DataView): number {
  const floor = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let at = view.byteLength - 22; at >= floor; at -= 1) {
    if (view.getUint32(at, true) === EOCD_SIG) return at;
  }
  throw new DocumentUnreadable('not a zip');
}

/**
 * WordprocessingML down to the text a person wrote, one paragraph per line.
 *
 * Three constructs carry every visible character in an ordinary course document
 * — `<w:t>` for text, `<w:tab/>` and `<w:br/>` for the whitespace inside a
 * paragraph — and they are matched **in document order**, which is what a naive
 * `replace(/<[^>]+>/g, '')` gets wrong: it would also empty field codes, deleted
 * revisions and comment bodies into the middle of the sentences.
 *
 * `</w:p>` is the line break, because a paragraph in Word is a line to a reader,
 * and table cells fall out as paragraphs too. That reads as a list rather than a
 * table, which is the right trade when the next reader is a deadline extractor
 * that works on lines.
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
      if (m[1] !== undefined) line += unescapeEntities(m[1]);
      else if (m[0].startsWith('<w:tab')) line += '\t';
      else line += '\n';
      m = runs.exec(paragraph);
    }
    lines.push(line);
  }
  return tidyText(lines.join('\n'));
}

// ------------------------------------------------------------- the one door

export interface DocumentInput {
  /** The file name, which is what decides the format and what a person sees. */
  readonly name: string;
  readonly mimeType?: string | null;
  /** The bytes, when the drop carried them. */
  readonly bytes?: Uint8Array | null;
  /**
   * Already-decoded text, when the sender did the reading.
   *
   * This is the PDF repair and the fetched-page path in one field: whoever
   * already has the text does not have to hand over bytes for this file to
   * re-derive it. A `text` input is trusted for its characters and for nothing
   * else — every downstream reader still fences it as untrusted material.
   */
  readonly text?: string | null;
}

export interface ExtractDeps {
  readonly inflateRaw?: InflateRaw;
}

/**
 * One document, to text or to a named reason. The only door in this file.
 *
 * The order of the checks is the order of the costs: name it, size it, then
 * spend anything. A three-hundred-item drop that inflated every zip before
 * noticing they were over the cap would do all of the work and then refuse it.
 */
export async function extractDocumentText(
  input: DocumentInput, deps: ExtractDeps = {},
): Promise<ExtractionOutcome> {
  const format = documentFormatOf(input.name, input.mimeType ?? '');
  if (format === null) return { kind: 'unsupported', name: input.name };

  /**
   * Text the sender already had beats bytes this would have to parse.
   *
   * `text` means *the characters of this document*, and it skips the **decode**
   * rather than the **format**. For a `.txt` or a `.docx` or a PDF, the
   * characters somebody hands over are already what a reader reads, so they are
   * tidied and taken — and for a PDF that is the whole repair: a panel that has
   * run pdf.js over a paper sends what it read, and the server never sees a PDF.
   *
   * HTML is the case that has to be different, and the first draft of this got
   * it wrong. The characters of an HTML document *are the markup*, so passing
   * them through untouched stored `<h1>Course:...</h1>` as though it were prose
   * — which the deadline extractor then read as one enormous line and found
   * nothing in, while reporting the item as read. Turning markup into text is
   * the format's job whether the markup arrived as bytes or as a string.
   */
  if (typeof input.text === 'string' && input.text.trim()) {
    return capDocumentText(format, format === 'html' ? htmlToText(input.text) : tidyText(input.text));
  }

  const coverage = parseSiteFor(format);
  if (coverage.where !== 'server') {
    return { kind: 'elsewhere', format, where: coverage.where, note: coverage.note };
  }

  const bytes = input.bytes;
  if (!bytes || bytes.byteLength === 0) return { kind: 'no-text', format };
  const cap = capForFormat(format);
  if (bytes.byteLength > cap) {
    return { kind: 'too-big', format, capBytes: cap, bytes: bytes.byteLength };
  }

  try {
    if (format === 'text') return capDocumentText(format, tidyText(utf8.decode(bytes)));
    if (format === 'html') {
      const html = utf8.decode(bytes);
      return capDocumentText(format, htmlToText(html));
    }
    // docx. The one format that needs a capability `core/` will not construct.
    if (!deps.inflateRaw) {
      return { kind: 'unreadable', format, detail: 'no decompressor was supplied to read the zip' };
    }
    return capDocumentText(format, docxText(await docxDocumentXml(bytes, deps.inflateRaw)));
  } catch (err) {
    const detail = err instanceof DocumentUnreadable ? err.detail : String(err).slice(0, 120);
    return { kind: 'unreadable', format, detail };
  }
}

/** Text, or the honest statement that a document parsed and held none. */
export function capDocumentText(format: DocumentFormat, text: string): ExtractionOutcome {
  if (!text.trim()) return { kind: 'no-text', format };
  const chars = Array.from(text);
  return chars.length > DOCUMENT_TEXT_CHARS
    ? { kind: 'text', format, text: chars.slice(0, DOCUMENT_TEXT_CHARS).join(''), truncated: true }
    : { kind: 'text', format, text, truncated: false };
}
