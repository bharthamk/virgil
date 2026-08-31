import { isOpenableUrl } from './courses.js';
import type { NotebookDoc } from '../ports/notebook-export.js';

/**
 * MARKDOWN TO MINIMAL HTML — the one conversion the Drive adapter needs.
 *
 * `NOTEBOOK_SEAM_V2.md` §10.2. The export engine emits Markdown-ish prose so
 * that the local adapter can write a `.md` a person can read and so that every
 * test in `notebook-docs.test.ts` asserts on text rather than on markup. Drive
 * cannot take that: a native Google Doc is made by uploading `text/html` as
 * converting media (§10.1, Route B), and Drive's converter is what turns real
 * headings into real headings and real anchors into real hyperlinks.
 *
 * ## Why this is pure and lives in `core/`
 *
 * The same argument `pdfPageHref` makes. It is a rule about text: it imports
 * nothing, reaches nothing, and its correctness is exactly the kind that wants a
 * test rather than a live document to squint at. Putting it in `adapters/`
 * beside the HTTP calls would make the one part of the Drive path that can be
 * proven offline only reachable through the part that cannot.
 *
 * ## Deliberately tiny
 *
 * Headings, paragraphs, list items and links. **No tables, no images, no
 * styling, no emphasis.** Those are the constructs the three documents actually
 * contain, and every one of them is there because `notebook-docs.ts` emits it:
 * `Body.head` writes `#` through `#####`, `Body.list` writes `- ` lines and
 * two-space continuation lines under them, `link()` writes `[label](url)`, and
 * `Body.say`/`Body.quote` write paragraphs. Anything else in the input is not a
 * construct, it is text, and text is escaped and passed through.
 *
 * That is a deliberate refusal rather than an unfinished job. A converter that
 * guessed at emphasis would have to guess on **learner prose quoted verbatim**,
 * where an asterisk is an asterisk and an underscore is usually a variable name.
 *
 * ## Deterministic, for the same reason the engine is
 *
 * Same in, byte-identical out. The Drive adapter rewrites three documents every
 * night, and a document whose bytes differ for no reason is a document Google
 * re-ingests for no reason, on a schedule nobody controls, for ever.
 */

/** `&`, `<`, `>` and `"`, and nothing else. Single quotes are left alone
 *  because nothing here ever puts text inside a single-quoted attribute, and
 *  turning every apostrophe in a learner's note into `&#39;` makes the HTML
 *  unreadable to the one person likely to look at it. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * `[label](url)` becomes an anchor; everything else becomes escaped text.
 *
 * `isOpenableUrl` is the same gate the engine used when it decided to write the
 * link at all, so an address this refuses is one the engine would not have
 * linked either. A refused address renders as its label and never as a bare
 * `javascript:` string wearing an anchor.
 *
 * The label is escaped, and so is the address. An address is placed inside a
 * double-quoted attribute, so a `"` in it has to stop being one.
 */
function inline(text: string): string {
  let out = '';
  let at = 0;
  const pattern = /\[([^\]\n]*)\]\(([^)\s\n]*)\)/g;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    out += escapeHtml(text.slice(at, m.index));
    const label = escapeHtml(m[1] ?? '');
    const href = m[2] ?? '';
    out += isOpenableUrl(href) ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
    at = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(at));
}

/** `#` through `######`, and the level, or null when the line is not a heading.
 *  A `#` with no space after it is a hash in a sentence, not a heading. */
const headingOf = (line: string): { readonly level: number; readonly text: string } | null => {
  const m = /^(#{1,6}) +(.*)$/.exec(line);
  return m ? { level: Math.min(m[1]!.length, 6), text: m[2]! } : null;
};

/**
 * The body of one document, as HTML.
 *
 * Block rules, in the order they are tried:
 *
 *  - a blank line ends whatever block is open;
 *  - `#`..`######` is a heading, and ends any open list;
 *  - `- ` opens a list if none is open and starts an item;
 *  - a line indented by two or more spaces **while a list item is open** is a
 *    continuation of that item, because that is exactly what
 *    `commitmentLines` and `criterionLines` emit — a fact hanging off the
 *    bullet above it rather than a bullet of its own;
 *  - anything else is a paragraph line, and consecutive paragraph lines join
 *    with a `<br>` rather than becoming separate paragraphs, because a
 *    multi-line quoted section body is one passage and splitting it would
 *    change what the learner wrote.
 */
export function notebookBodyHtml(body: string): string {
  const out: string[] = [];
  let list = false;
  let item: string[] | null = null;
  let para: string[] | null = null;

  const closeItem = (): void => {
    if (!item) return;
    out.push(`<li>${item.join('<br>')}</li>`);
    item = null;
  };
  const closeList = (): void => {
    closeItem();
    if (!list) return;
    out.push('</ul>');
    list = false;
  };
  const closePara = (): void => {
    if (!para) return;
    out.push(`<p>${para.join('<br>')}</p>`);
    para = null;
  };

  for (const raw of body.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line === '') { closeList(); closePara(); continue; }

    const heading = headingOf(line);
    if (heading) {
      closeList();
      closePara();
      out.push(`<h${heading.level}>${inline(heading.text)}</h${heading.level}>`);
      continue;
    }

    const bulletMatch = /^- +(.*)$/.exec(line);
    if (bulletMatch) {
      closePara();
      closeItem();
      if (!list) { out.push('<ul>'); list = true; }
      item = [inline(bulletMatch[1]!)];
      continue;
    }

    // A continuation of the bullet above it. Only meaningful while an item is
    // open; the same indentation in ordinary prose is just prose.
    if (item && /^ {2,}\S/.test(raw)) {
      item.push(inline(line.trim()));
      continue;
    }

    closeList();
    (para ??= []).push(inline(line));
  }

  closeList();
  closePara();
  return out.join('\n');
}

/**
 * One document, as a whole HTML file, ready to be uploaded as converting media.
 *
 * The `<title>` is the document's own title rather than its first heading, so
 * that a conversion which ever stopped reading `<h1>` would still produce a
 * document with the learner's name for it on it. The charset is declared
 * because the bodies carry learner prose in whatever language they wrote it in,
 * and a converter guessing at the encoding of a note somebody typed at 11pm is
 * a converter that will one day guess wrong.
 *
 * No stylesheet, no font, no class. Google's converter decides what a heading
 * looks like, and anything this file asserted about appearance would be a
 * claim about somebody else's renderer.
 */
export function notebookDocHtml(doc: NotebookDoc): string {
  return '<!DOCTYPE html>\n'
    + '<html><head><meta charset="utf-8">\n'
    + `<title>${escapeHtml(doc.title)}</title>\n`
    + '</head><body>\n'
    + `${notebookBodyHtml(doc.body)}\n`
    + '</body></html>\n';
}
