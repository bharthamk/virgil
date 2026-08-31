import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import {
  DOCUMENT_CAPS, DOCUMENT_TEXT_CHARS, SERVER_PARSE_COVERAGE,
  describeExtraction, docxDocumentXml, docxText, documentFormatOf,
  extractDocumentText, htmlToText, htmlTitle, parseSiteFor, tidyText,
  unescapeEntities,
} from '../domain/documents.js';
import { buildDeterministicIntake } from '../domain/intake.js';

/**
 * WHAT THE SERVER CAN READ, PROVEN RATHER THAN CLAIMED.
 *
 * The parse-coverage table is a promise made to somebody about to upload a
 * course folder, and a table that says `docx: server` beside a parser that
 * throws on every real docx would be the worst kind of documentation. So every
 * row is exercised against bytes built here, including the zip, which is
 * assembled by hand because the point is the walk and not the library.
 */

// --------------------------------------------------------------- the format

test('the format is decided by name first and by the declared type second', () => {
  // A `.md` arrives as `text/markdown`, `text/plain` or an empty string
  // depending on who is sending, and the name is the thing a person can see.
  assert.equal(documentFormatOf('week3.md'), 'text');
  assert.equal(documentFormatOf('week3.md', 'application/octet-stream'), 'text');
  assert.equal(documentFormatOf('outline.html'), 'html');
  assert.equal(documentFormatOf('brief.docx'), 'docx');
  assert.equal(documentFormatOf('paper.pdf'), 'pdf');

  // No usable name: the declared type is allowed to decide.
  assert.equal(documentFormatOf('blob', 'text/html; charset=utf-8'), 'html');
  assert.equal(documentFormatOf('blob', 'application/pdf'), 'pdf');

  // And a format nothing here names is refused rather than sniffed.
  assert.equal(documentFormatOf('notes.pages'), null);
  assert.equal(documentFormatOf('essay.doc'), null, 'a legacy .doc is not half-read as a zip');
});

test('every format in the coverage table can be looked up, and the table is the parser’s', () => {
  for (const row of SERVER_PARSE_COVERAGE) {
    assert.equal(parseSiteFor(row.format), row);
    assert.ok(row.note.trim().length > 0, `${row.format} claims a site and gives no reason`);
    for (const ext of row.extensions) {
      assert.equal(documentFormatOf(`file${ext}`), row.format,
        `${ext} is in the table for ${row.format} and the parser disagrees`);
    }
    for (const mime of row.mimes) {
      assert.equal(documentFormatOf('blob', mime), row.format);
    }
  }
});

// ----------------------------------------------------------------- the html

test('html keeps its block structure, because the deadline reader works on lines', () => {
  /**
   * The defect this function exists to prevent, in one assertion.
   *
   * `LocalResearch`'s own html-to-text collapses every run of whitespace, which
   * is right for a Forager that slices a window of prose and catastrophic for
   * `buildDeterministicIntake`, which finds an assessment table by reading
   * lines. Flattened, the extraction succeeds perfectly and finds nothing.
   */
  const html = '<h1>Course: Tides</h1><h2>Assessment</h2><ul>'
    + '<li>Lab report due 12 October 2026</li><li>Essay due 2026-11-20</li></ul>';
  const lines = htmlToText(html).split('\n');
  assert.deepEqual(lines, [
    'Course: Tides', 'Assessment', 'Lab report due 12 October 2026', 'Essay due 2026-11-20',
  ]);
});

test('a table row is a line, because an assessment table is where the deadlines are', () => {
  const html = '<table><tr><th>Item</th><th>Due</th></tr>'
    + '<tr><td>Lab report (25%)</td><td>due 9 September 2026</td></tr></table>';
  assert.equal(htmlToText(html), 'Item Due\nLab report (25%) due 9 September 2026');
});

test('script and style bodies are code and never become text', () => {
  const html = '<p>Real</p><script>var due = "never";</script><style>p{color:red}</style>';
  const text = htmlToText(html);
  assert.equal(text, 'Real');
  assert.ok(!text.includes('never'));
  assert.ok(!text.includes('color'));
});

test('entities are decoded, and an unknown one is left as it was written', () => {
  assert.equal(unescapeEntities('R&amp;D &lt;tag&gt; &#65; &#x42; &rsquo;'), 'R&D <tag> A B ’');
  assert.equal(unescapeEntities('&notareal;'), '&notareal;',
    'inventing a character for an entity nobody defined would be worse than leaving it');
});

test('the page title is read where there is one', () => {
  assert.equal(htmlTitle('<html><head><title>  PHY100  outline </title></head></html>'), 'PHY100 outline');
  assert.equal(htmlTitle('<html><body>no head</body></html>'), null);
  assert.equal(htmlTitle('<title>   </title>'), null, 'a blank title is not a title');
});

// ----------------------------------------------------------------- the docx

/**
 * A real zip with one entry, built byte by byte.
 *
 * Not a fixture file, and deliberately: the walk this exercises reads the
 * central directory rather than the local header, so a test wants to be able to
 * write a directory that disagrees with the header — which is exactly what Word
 * writes when it streams — and to write zip64 sentinels and encryption flags on
 * purpose. A committed `.docx` can do none of that.
 */
function zipWith(
  entries: readonly { name: string; body: Buffer; method?: 0 | 8; flags?: number }[],
): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 8;
    const name = Buffer.from(entry.name, 'utf8');
    const payload = method === 8 ? deflateRawSync(entry.body) : entry.body;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localBlock = Buffer.concat([local, name, payload]);
    locals.push(localBlock);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(entry.flags ?? 0, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(payload.length, 20);
    dir.writeUInt32LE(entry.body.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([dir, name]));
    offset += localBlock.length;
  }
  const centralBlock = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, centralBlock, eocd]));
}

const inflateRaw = async (data: Uint8Array): Promise<Uint8Array> => {
  const stream = new Blob([data as BlobPart]).stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const WORD_XML = '<?xml version="1.0"?><w:document><w:body>'
  + '<w:p><w:r><w:t>Course: Cognitive Psychology</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t>Assessment</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t>Lab report</w:t></w:r><w:tab/><w:r><w:t>due 9 September 2026</w:t></w:r></w:p>'
  + '<w:p><w:r><w:instrText>PAGEREF _Toc1</w:instrText></w:r></w:p>'
  + '<w:p><w:r><w:t>Essay &amp; presentation</w:t></w:r></w:p>'
  + '</w:body></w:document>';

test('a deflated docx gives up the text a person wrote, one paragraph per line', async () => {
  const bytes = zipWith([
    { name: '[Content_Types].xml', body: Buffer.from('<Types/>') },
    { name: 'word/document.xml', body: Buffer.from(WORD_XML, 'utf8') },
  ]);
  const xml = await docxDocumentXml(bytes, inflateRaw);
  assert.deepEqual(docxText(xml).split('\n'), [
    'Course: Cognitive Psychology',
    'Assessment',
    'Lab report\tdue 9 September 2026',
    // The field-code paragraph left a blank line where its text would have been,
    // and a blank line is the right answer: the paragraph existed and held
    // nothing a reader would see. Closing it up would join two lines the author
    // wrote apart, which is what the deadline reader would then read as one.
    '',
    'Essay & presentation',
  ]);
});

test('a stored entry needs no decompressor at all', async () => {
  const bytes = zipWith([{ name: 'word/document.xml', body: Buffer.from(WORD_XML, 'utf8'), method: 0 }]);
  const xml = await docxDocumentXml(bytes, async () => { throw new Error('not needed'); });
  assert.ok(xml.includes('Cognitive Psychology'));
});

test('a field code is not text, even though it sits between the paragraphs', () => {
  // The failure a naive `replace(/<[^>]+>/g, '')` makes: it empties field codes,
  // deleted revisions and comment bodies into the middle of the sentences.
  assert.ok(!docxText(WORD_XML).includes('PAGEREF'));
});

test('everything the walk does not understand throws rather than half-reading', async () => {
  const encrypted = zipWith([{ name: 'word/document.xml', body: Buffer.from(WORD_XML), flags: 0x1 }]);
  await assert.rejects(() => docxDocumentXml(encrypted, inflateRaw), /encrypted/);

  const wrongEntries = zipWith([{ name: 'word/other.xml', body: Buffer.from('<x/>') }]);
  await assert.rejects(() => docxDocumentXml(wrongEntries, inflateRaw), /word\/document\.xml/);

  await assert.rejects(() => docxDocumentXml(new Uint8Array([1, 2, 3]), inflateRaw), /not a zip/);
});

// ------------------------------------------------------------- the one door

test('a document the server cannot read reports where it can be read instead', async () => {
  const out = await extractDocumentText({ name: 'lecture.pdf', bytes: new Uint8Array([37, 80]) });
  assert.equal(out.kind, 'elsewhere');
  if (out.kind !== 'elsewhere') return;
  assert.equal(out.where, 'extension');
  // `elsewhere` and `unsupported` are different facts and lead to different
  // repairs. Telling somebody a PDF cannot be read would be false about a
  // product that reads PDFs on the other side of the seam every day.
  assert.match(describeExtraction(out), /extension/i);

  const nothing = await extractDocumentText({ name: 'notes.pages', bytes: new Uint8Array([1]) });
  assert.equal(nothing.kind, 'unsupported');
});

test('a PDF whose text the sender already has is read, and never touches the parser', async () => {
  // The repair the `elsewhere` receipt names. The panel runs pdf.js and sends
  // what it read; the server never sees a PDF.
  const out = await extractDocumentText({ name: 'lecture.pdf', text: 'Week 4: boundary layers' });
  assert.equal(out.kind, 'text');
  if (out.kind !== 'text') return;
  assert.equal(out.text, 'Week 4: boundary layers');
});

test('a docx with no decompressor is honest about why, rather than crashing', async () => {
  const bytes = zipWith([{ name: 'word/document.xml', body: Buffer.from(WORD_XML) }]);
  const out = await extractDocumentText({ name: 'brief.docx', bytes });
  assert.equal(out.kind, 'unreadable');
  if (out.kind !== 'unreadable') return;
  assert.match(out.detail, /decompressor/);
});

test('an oversized document is refused before anything is inflated', async () => {
  const out = await extractDocumentText({
    name: 'huge.txt', bytes: new Uint8Array(DOCUMENT_CAPS.textBytes + 1),
  });
  assert.equal(out.kind, 'too-big');
  if (out.kind !== 'too-big') return;
  assert.equal(out.capBytes, DOCUMENT_CAPS.textBytes);
  assert.match(describeExtraction(out), /limit/);
});

test('a document that parsed and held nothing says so, and is not called unreadable', async () => {
  const empty = zipWith([{ name: 'word/document.xml', body: Buffer.from('<w:document><w:body/></w:document>') }]);
  const out = await extractDocumentText({ name: 'pictures.docx', bytes: empty }, { inflateRaw });
  assert.equal(out.kind, 'no-text');
  assert.match(describeExtraction(out), /no text in it/);
});

test('a very long document is cut, and the receipt says it was cut', async () => {
  const out = await extractDocumentText({ name: 'book.txt', text: 'a\n'.repeat(DOCUMENT_TEXT_CHARS) });
  assert.equal(out.kind, 'text');
  if (out.kind !== 'text') return;
  assert.equal(out.truncated, true);
  assert.equal(out.text.length, DOCUMENT_TEXT_CHARS);
  assert.match(describeExtraction(out), /cut at/);
});

test('the document text boundary counts Unicode characters and never cuts one apart', async () => {
  const exactText = '😀'.repeat(DOCUMENT_TEXT_CHARS);
  const exact = await extractDocumentText({ name: 'emoji.txt', text: exactText });
  assert.equal(exact.kind, 'text');
  if (exact.kind !== 'text') return;
  assert.equal(exact.truncated, false);
  assert.equal(exact.text, exactText);

  const over = await extractDocumentText({ name: 'emoji.txt', text: `${exactText}🧠` });
  assert.equal(over.kind, 'text');
  if (over.kind !== 'text') return;
  assert.equal(over.truncated, true);
  assert.equal(Array.from(over.text).length, DOCUMENT_TEXT_CHARS);
  assert.equal(over.text, exactText);
  assert.ok(!over.text.includes('\uFFFD'));
});

test('tidying leaves one blank line between blocks and none at either end', () => {
  assert.equal(tidyText('\n\n a  \t\n\n\n\nb   \n\n'), 'a\n\nb');
});

// ------------------------------------------------- the join that is the point

test('a docx syllabus reaches the deadline extractor with its lines intact', async () => {
  /**
   * The end-to-end claim, at the seam where the two halves meet.
   *
   * Everything above is about turning bytes into characters. This is the only
   * reason any of it exists: `buildDeterministicIntake` reads a syllabus line by
   * line, so a reader that produced correct characters in one paragraph would
   * pass every assertion above and still find no deadlines at all.
   */
  const bytes = zipWith([{ name: 'word/document.xml', body: Buffer.from(WORD_XML, 'utf8') }]);
  const out = await extractDocumentText({ name: 'PSY201.docx', bytes }, { inflateRaw });
  assert.equal(out.kind, 'text');
  if (out.kind !== 'text') return;

  const draft = buildDeterministicIntake({
    draftId: 'd', sourceId: 's', sourceKind: 'syllabus', sourceTitle: 'PSY201.docx',
    text: out.text, now: '2026-08-25T00:00:00.000Z', id: () => 'x', digest: 'sha256:0',
  });
  assert.equal(draft.title, 'Cognitive Psychology', 'the `Course:` field was on its own line');
  const lab = draft.commitments.find((c) => c.title.includes('Lab report'));
  assert.ok(lab, 'the assessment row did not survive as a line');
  assert.equal(lab.dueAt, '2026-09-09T23:59:00.000Z');
});
