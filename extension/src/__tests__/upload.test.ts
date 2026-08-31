import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  appendText, capFor, DOCX_XML_CAP_BYTES, docxText, docxXml, formatOf,
  pageFormatOf, pdfPages, pdfText, readPages, readUpload, tidy,
  MAX_PAGES, PAGE_EDGE_PX, PAGE_QUALITY, PAGE_WIRE_BYTES,
  PDFJS_MODULE, PDFJS_WORKER, UPLOAD_ACCEPT, UPLOAD_CAPS, VISION_UPLOAD_ACCEPT,
  type CanvasMaker, type UploadFile,
} from '../upload.js';

/**
 * Reading a file the learner dropped, checked without a browser.
 *
 * The zip reader and the XML strip are the two pieces here that are genuinely
 * new code rather than wiring, and both are the kind that pass a smoke test and
 * silently mangle a real document: a `<w:instrText>` field code spliced into
 * the middle of a sentence, two runs of one word joined without their space, an
 * entity left as `&amp;`. So the fixture beside this file is a **real .docx**,
 * built byte by byte with the constructs an ordinary assignment contains, and
 * the assertions are about the text a person would say is in it.
 *
 * The PDF path is unit-tested against a stubbed vendor module. A real
 * `pdf.worker.mjs` render in the deterministic suite would make every run of
 * this repository's tests depend on a 3MB third-party parser starting a worker,
 * which is a slower suite and a worse signal: what is this product's to get
 * right is the wrapper — the options it passes, the way it joins pages, and
 * what it does with a PDF that yields nothing.
 */

const FIXTURES = new URL('../../src/__tests__/fixtures/', import.meta.url);
const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(name, FIXTURES))));

const file = (name: string, bytes: Uint8Array | string, type = ''): UploadFile => {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return {
    name,
    type,
    size: data.byteLength,
    arrayBuffer: async () => data.buffer.slice(
      data.byteOffset, data.byteOffset + data.byteLength,
    ) as ArrayBuffer,
  };
};

// ---------------------------------------------------------------- the format

test('the three readable formats are recognised by name first, and by the OS second', () => {
  assert.equal(formatOf('essay.txt'), 'text');
  assert.equal(formatOf('NOTES.MD'), 'text');
  assert.equal(formatOf('readme.markdown'), 'text');
  assert.equal(formatOf('assignment.docx'), 'docx');
  assert.equal(formatOf('brief.pdf'), 'pdf');

  // Chrome hands `.md` over as three different mime types depending on the
  // platform, and sometimes as none at all. The name is the thing the learner
  // can see, so it wins.
  assert.equal(formatOf('notes.md', 'application/octet-stream'), 'text');
  // And with no usable extension, the OS's guess is better than nothing.
  assert.equal(formatOf('download', 'application/pdf'), 'pdf');
  assert.equal(formatOf('download', 'text/plain; charset=utf-8'), 'text');
});

test('a format this cannot read is refused by name rather than half-read', () => {
  // The failure this prevents: opening a `.doc` or a `.pages` as if it were a
  // zip, finding some bytes that decode, and putting mojibake in the box.
  for (const name of ['essay.doc', 'notes.pages', 'sheet.xlsx', 'photo.png', 'archive.zip', 'noextension']) {
    assert.equal(formatOf(name), null, name);
  }
  assert.equal(formatOf(''), null);
});

test('the picker advertises exactly the formats the reader accepts', () => {
  // A dialog offering `.doc` for a reader that refuses it is a refusal the
  // learner meets after choosing rather than before.
  for (const ext of ['.txt', '.md', '.markdown', '.docx', '.pdf']) {
    assert.ok(UPLOAD_ACCEPT.includes(ext), ext);
  }
  for (const ext of UPLOAD_ACCEPT.split(',')) {
    assert.ok(formatOf(`x${ext}`), `${ext} is offered and cannot be read`);
  }
});

test('Check advertises screenshots without teaching the document reader to fake extraction', () => {
  assert.equal(pageFormatOf('diagram.PNG'), 'image');
  assert.equal(pageFormatOf('photo.jpeg'), 'image');
  assert.equal(pageFormatOf('download', 'image/jpeg; charset=binary'), 'image');
  assert.equal(pageFormatOf('brief.pdf'), 'pdf');
  assert.equal(pageFormatOf('notes.docx'), null);

  for (const ext of ['.png', '.jpg', '.jpeg']) assert.ok(VISION_UPLOAD_ACCEPT.includes(ext), ext);
  assert.doesNotMatch(UPLOAD_ACCEPT, /\.(png|jpe?g)/,
    'course and criteria import started advertising pictures as extractable text');
  assert.equal(formatOf('diagram.png'), null,
    'the ordinary document reader silently learned to return made-up image text');
});

test('a document may weigh more than a text file, and both have a ceiling', () => {
  assert.equal(capFor('text'), UPLOAD_CAPS.textBytes);
  assert.equal(capFor('docx'), UPLOAD_CAPS.documentBytes);
  assert.equal(capFor('pdf'), UPLOAD_CAPS.documentBytes);
  assert.ok(UPLOAD_CAPS.documentBytes > UPLOAD_CAPS.textBytes);
});

// ------------------------------------------------------------------ the docx

test('a real .docx is unzipped and read without a zip library', async () => {
  const xml = await docxXml(fixture('assignment.docx'));
  assert.match(xml, /<w:document/, 'word/document.xml did not come out of the archive');
  assert.match(xml, /Retries &amp; ordering/, 'the entry was inflated but not to its own bytes');
});

test('what comes out is the text a person would say is in the document', async () => {
  const text = docxText(await docxXml(fixture('assignment.docx')));

  // Entities are decoded. `&amp;` in the box is the tell that nothing decoded.
  assert.ok(text.includes('Retries & ordering'));
  // Two runs of one sentence are one sentence, with the space that was in the
  // first run's `xml:space="preserve"` still in it.
  assert.ok(text.includes('Once a message is published it will eventually arrive.'), text);
  // A paragraph is a line, because that is what it is to a reader.
  assert.equal(text.split('\n')[0], 'Retries & ordering');
  // `<w:br/>` and `<w:tab/>` are whitespace, in the place they occurred.
  assert.ok(text.includes('Line one\nline two\ttabbed'), JSON.stringify(text));
  // The half a naive tag-strip gets wrong: a field code is not prose, and
  // dropping it into the middle of the learner's writing is worse than a
  // missing page number.
  assert.ok(!text.includes('MERGEFORMAT'), text);
  assert.ok(!/<\/?w:/.test(text), 'markup survived into the box');
});

test('a file that is not a zip, or a zip with no document in it, is an error rather than a guess', async () => {
  await assert.rejects(() => docxXml(new TextEncoder().encode('this is just a sentence')));
  // A real zip whose central directory does not name `word/document.xml`. Half
  // a document read as a whole one is the failure worth being loud about.
  const notWord = fixture('assignment.docx').slice(0, 200);
  await assert.rejects(() => docxXml(notWord));
});

/** Find `word/document.xml`'s central-directory record in the real fixture. */
function documentCentralRecord(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at + 46 <= bytes.byteLength; at += 1) {
    if (view.getUint32(at, true) !== 0x0201_4b50) continue;
    const nameLength = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (name === 'word/document.xml') return at;
  }
  throw new Error('fixture has no document central record');
}

test('a docx declaring an expansion beyond the ceiling is refused before inflation', async () => {
  const bytes = fixture('assignment.docx').slice();
  const central = documentCentralRecord(bytes);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .setUint32(central + 24, DOCX_XML_CAP_BYTES + 1, true);

  await assert.rejects(() => docxXml(bytes), /expanded document too large/);
});

test('a forged small size cannot bypass the streaming expansion ceiling', async () => {
  const bytes = fixture('assignment.docx').slice();
  const central = documentCentralRecord(bytes);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(central + 24, 1, true);

  await assert.rejects(() => docxXml(bytes, 64), /expanded document too large/);
});

test('a docx with no words in it comes back empty rather than as whitespace', () => {
  assert.equal(docxText('<w:document><w:body><w:p/><w:p/></w:body></w:document>'), '');
  assert.equal(docxText('<w:document><w:body></w:body></w:document>'), '');
});

// ------------------------------------------------------------------- tidying

test('what lands in the box is what a person would have typed', () => {
  assert.equal(tidy('  hello  \r\n\r\n\r\n\r\nworld   \n\n'), 'hello\n\nworld');
  assert.equal(tidy('one \t\ntwo'), 'one\ntwo', 'trailing whitespace on a line is not content');
  assert.equal(tidy('\n\n\n'), '');
});

test('a box that already has something in it keeps it', () => {
  // The whole rule, in one function: a learner who typed half a paragraph and
  // then dropped the assignment must not lose the half paragraph.
  assert.equal(appendText('my notes', 'the essay'), 'my notes\n\nthe essay');
  assert.equal(appendText('', 'the essay'), 'the essay');
  assert.equal(appendText('   \n ', 'the essay'), 'the essay');
  assert.equal(appendText('my notes\n\n', 'the essay'), 'my notes\n\nthe essay');
});

// -------------------------------------------------------------------- the pdf

/** The vendor module, reduced to the four members `upload.ts` calls. */
function stubPdfjs(pages: readonly (readonly { str?: string; hasEOL?: boolean; transform?: readonly number[] }[])[]) {
  const seen: { source?: unknown; workerSrc?: string; destroyed: boolean } = { destroyed: false };
  const pdfjs = {
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument(source: unknown) {
      seen.source = source;
      seen.workerSrc = pdfjs.GlobalWorkerOptions.workerSrc;
      return {
        promise: Promise.resolve({
          numPages: pages.length,
          getPage: async (n: number) => ({ getTextContent: async () => ({ items: pages[n - 1] ?? [] }) }),
        }),
        // Teardown is the task's, and only the task's: the real v6 document
        // proxy has no `destroy`, and the first stub here that pretended it did
        // hid a TypeError that turned every readable PDF into "unreadable".
        destroy: async () => { seen.destroyed = true; },
      };
    },
  };
  return { pdfjs: pdfjs as unknown as Pdfjs, seen };
}

test('the PDF reader asks for text and nothing that would need a CSP change', async () => {
  const { pdfjs, seen } = stubPdfjs([[{ str: 'Once a message is published' }]]);
  await pdfText(
    new Uint8Array([1, 2, 3]), pdfjs,
    'chrome-extension://abc/vendor/pdfjs/pdf.worker.mjs',
    'chrome-extension://abc/vendor/pdfjs/standard_fonts/',
  );

  const source = seen.source as Record<string, unknown>;
  // MV3 forbids `eval`, and pdf.js reaches for it unless told not to. Passed
  // explicitly on every call rather than left to a default that has moved
  // before.
  assert.equal(source['isEvalSupported'], false);
  // Nothing is drawn, so a font is a download with no picture at the end of it.
  assert.equal(source['disableFontFace'], true);
  assert.equal(source['useSystemFonts'], false);
  // A cMap url would be a network fetch out of an extension that asks for no
  // host permissions. The standard-fonts url is not: it points at the vendored
  // directory, the same kind of self-fetch as the worker, and without it any
  // PDF using a base-14 font it did not embed is refused outright — found
  // live, not reasoned about.
  assert.ok(!('cMapUrl' in source), 'a cMap url is a fetch this extension may not make');
  assert.equal(source['standardFontDataUrl'], 'chrome-extension://abc/vendor/pdfjs/standard_fonts/',
    'without the vendored fonts, an unembedded base-14 font makes the whole PDF unreadable');

  assert.equal(seen.workerSrc, 'chrome-extension://abc/vendor/pdfjs/pdf.worker.mjs',
    'the worker was not pointed at the vendored copy, so pdf.js would go looking for its own');
  assert.equal(seen.destroyed, true, 'the document was left open');
});

test('a PDF reads as pages of text, and the page break is a blank line', async () => {
  const { pdfjs } = stubPdfjs([
    [{ str: 'Retries are handled ' }, { str: 'by the queue.', hasEOL: true }, { str: 'So it arrives.' }],
    [{ str: 'Page two.' }],
  ]);
  const text = await pdfText(new Uint8Array([1]), pdfjs);
  assert.equal(text, 'Retries are handled by the queue.\nSo it arrives.\n\nPage two.');
});

test('a baseline drop is a line break even when pdf.js does not say so', async () => {
  /**
   * Found live: two runs set on different baselines routinely arrive as two
   * items with no `hasEOL` between them. Welding them would be cosmetic for a
   * draft and structural for a rubric — the parser reads one criterion per
   * line, and a criteria list joined into one line is one criterion.
   */
  const { pdfjs } = stubPdfjs([[
    { str: 'Clarity of argument.', transform: [10, 0, 0, 10, 72, 720] },
    { str: 'Evidence for each claim.', transform: [10, 0, 0, 10, 72, 706] },
    { str: ' Cited.', transform: [10, 0, 0, 10, 190, 706] },
  ]]);
  const text = await pdfText(new Uint8Array([1]), pdfjs);
  assert.equal(text, 'Clarity of argument.\nEvidence for each claim. Cited.');
});

test('a PDF of photographs comes back empty rather than as an error', async () => {
  /**
   * The distinction the whole outcome type exists for. A scanned assignment
   * parses perfectly and contains no text; telling that learner the file could
   * not be opened sends them looking for a corrupt document, when what they
   * need to hear is that the pages are pictures.
   */
  const { pdfjs } = stubPdfjs([[], [{ hasEOL: true }, { str: '   ' }]]);
  assert.equal(await pdfText(new Uint8Array([1]), pdfjs), '');

  const outcome = await readUpload(file('scan.pdf', new Uint8Array([1, 2, 3])), {
    loadPdfjs: async () => pdfjs, pdfWorkerSrc: 'worker',
  });
  assert.deepEqual(outcome, { kind: 'no-text', format: 'pdf' });
});

test('the vendored parser is loaded only when a PDF actually arrives', async () => {
  /**
   * The reason it is worth vendoring at all. 3MB of parser paid for on every
   * render of a screen that draws two textareas would be a worse product than
   * one that cannot read PDFs; paid for by the one person who dropped one, it
   * costs nobody else anything.
   */
  let loads = 0;
  const { pdfjs } = stubPdfjs([[{ str: 'x' }]]);
  const deps = { loadPdfjs: async () => { loads += 1; return pdfjs; } };

  await readUpload(file('essay.txt', 'plain words'), deps);
  await readUpload(file('assignment.docx', fixture('assignment.docx')), deps);
  await readUpload(file('nope.pptx', 'x'), deps);
  // And a PDF over the cap is refused on its size, before a parser is thought
  // about: the bytes are never read, so there is nothing to parse.
  await readUpload({ ...file('huge.pdf', 'x'), size: UPLOAD_CAPS.documentBytes + 1 }, deps);
  assert.equal(loads, 0, 'the parser was pulled in for something that is not a PDF');

  await readUpload(file('brief.pdf', new Uint8Array([1])), deps);
  assert.equal(loads, 1);
});

test('the vendored paths are relative, so nothing here is a remote url', () => {
  for (const path of [PDFJS_MODULE, PDFJS_WORKER]) {
    assert.doesNotMatch(path, /^https?:/);
    assert.ok(path.startsWith('vendor/pdfjs/'), path);
  }
});

// ------------------------------------------------------------- the whole read

test('a text file is read into text', async () => {
  assert.deepEqual(
    await readUpload(file('essay.md', '# Retries\n\nOnce published, it arrives.\n\n\n')),
    { kind: 'text', format: 'text', text: '# Retries\n\nOnce published, it arrives.' },
  );
});

test('a real .docx read end to end lands as its own words', async () => {
  const outcome = await readUpload(file('assignment.docx', fixture('assignment.docx')));
  assert.equal(outcome.kind, 'text');
  assert.ok(outcome.kind === 'text' && outcome.text.startsWith('Retries & ordering'), JSON.stringify(outcome));
});

test('every refusal is a named outcome, and none of them is silence', async () => {
  // Fail closed, in all four directions. What must never happen is an empty
  // return that the screen has nothing to say about, because the learner then
  // presses the button on a box they believe holds their essay.
  assert.deepEqual(await readUpload(file('essay.doc', 'x')), { kind: 'unsupported' });

  assert.deepEqual(
    await readUpload({ ...file('essay.txt', 'x'), size: UPLOAD_CAPS.textBytes + 1 }),
    { kind: 'too-big', format: 'text', capBytes: UPLOAD_CAPS.textBytes },
  );
  assert.deepEqual(
    await readUpload({ ...file('scan.pdf', 'x'), size: UPLOAD_CAPS.documentBytes + 1 }),
    { kind: 'too-big', format: 'pdf', capBytes: UPLOAD_CAPS.documentBytes },
  );

  // A .docx that is not a zip: an error inside the reader is an outcome out
  // here, never a throw into the panel's click handler.
  assert.deepEqual(
    await readUpload(file('assignment.docx', 'this is not a zip')),
    { kind: 'unreadable', format: 'docx' },
  );
  // An empty text file has nothing in it, which is not the same as broken.
  assert.deepEqual(await readUpload(file('empty.txt', '   \n\n ')), { kind: 'no-text', format: 'text' });
});

test('a file that is exactly at its cap is read, not refused', async () => {
  // An off-by-one here refuses the file that fits, which is the one somebody
  // trimmed to fit.
  const outcome = await readUpload({ ...file('essay.txt', 'words'), size: UPLOAD_CAPS.textBytes });
  assert.equal(outcome.kind, 'text');
});

test('a PDF whose parser will not load is a refusal, not a crash', async () => {
  // The vendor directory missing from a build, an import that 404s: the screen
  // has to survive it, because the alternative is a handler that threw and a
  // button that never came back.
  assert.deepEqual(
    await readUpload(file('brief.pdf', new Uint8Array([1])), {
      loadPdfjs: async () => { throw new Error('no such module'); },
    }),
    { kind: 'unreadable', format: 'pdf' },
  );
});

// ------------------------------------------ the pages, drawn (2026-08-24)


interface DrawnPage { width: number; height: number }

/** The vendor module again, this time answering `getViewport` and `render`. */
function stubRenderer(pages: readonly { width: number; height: number; throws?: boolean }[]) {
  const seen: {
    source?: Record<string, unknown>;
    workerSrc?: string;
    destroyed: boolean;
    drawn: DrawnPage[];
    scales: number[];
    quality: number[];
    canvases: number;
    /** Whether pdf.js was handed the canvas as well as its context. */
    canvasPassed: boolean[];
    intents: (string | undefined)[];
  } = { destroyed: false, drawn: [], scales: [], quality: [], canvases: 0, canvasPassed: [], intents: [] };

  const pdfjs = {
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument(source: Record<string, unknown>) {
      seen.source = source;
      seen.workerSrc = pdfjs.GlobalWorkerOptions.workerSrc;
      return {
        promise: Promise.resolve({
          numPages: pages.length,
          getPage: async (n: number) => {
            const page = pages[n - 1] ?? { width: 612, height: 792 };
            return {
              getTextContent: async () => ({ items: [] }),
              getViewport: ({ scale }: { scale: number }) => {
                if (scale !== 1) seen.scales.push(scale);
                return { width: page.width * scale, height: page.height * scale };
              },
              render: (source2: Record<string, unknown>) => ({
                promise: (async () => {
                  seen.canvasPassed.push('canvas' in source2);
                  seen.intents.push(source2['intent'] as string | undefined);
                  if (page.throws) throw new Error('this page will not draw');
                  const viewport = source2['viewport'] as DrawnPage;
                  seen.drawn.push({ width: viewport.width, height: viewport.height });
                })(),
              }),
            };
          },
        }),
        destroy: async () => { seen.destroyed = true; },
      };
    },
  };

  /** A canvas that records rather than draws. `toDataUri` answers a real
   *  `data:image/jpeg;base64,` string so nothing downstream is fooled by a
   *  shape the browser would never produce. */
  const makeCanvas: CanvasMaker = (width, height) => {
    seen.canvases += 1;
    return {
      width,
      height,
      getContext: () => ({ id: '2d' }),
      toDataUri: async (quality) => {
        seen.quality.push(quality);
        return `data:image/jpeg;base64,${btoa(`page-${width}x${height}`)}`;
      },
    };
  };

  return { pdfjs: pdfjs as unknown as Pdfjs, makeCanvas, seen };
}

test('rendering asks for the same restraint the text path does, plus the fonts', async () => {
  const { pdfjs, makeCanvas, seen } = stubRenderer([{ width: 612, height: 792 }]);
  const outcome = await pdfPages(new Uint8Array([1, 2, 3]), pdfjs, {
    workerSrc: 'chrome-extension://abc/vendor/pdfjs/pdf.worker.mjs',
    fontsUrl: 'chrome-extension://abc/vendor/pdfjs/standard_fonts/',
    makeCanvas,
  });
  assert.equal(outcome.kind, 'pages');

  const source = seen.source ?? {};
  // Drawing is not a reason to hand MV3's CSP an exception.
  assert.equal(source['isEvalSupported'], false);
  assert.ok(!('cMapUrl' in source), 'a cMap url is a fetch this extension may not make');
  // And the one thing that is DIFFERENT from the text path, in the direction
  // that matters: extraction wanted the glyph maps and no font faces, drawing
  // wants the font faces or the picture comes out with the words missing.
  assert.ok(!('disableFontFace' in source), 'a rendered page with its fonts disabled is a page missing its words');
  assert.equal(source['standardFontDataUrl'], 'chrome-extension://abc/vendor/pdfjs/standard_fonts/');
  assert.equal(seen.workerSrc, 'chrome-extension://abc/vendor/pdfjs/pdf.worker.mjs');
  assert.equal(seen.destroyed, true, 'the document was left open');
  assert.deepEqual(seen.quality, [PAGE_QUALITY]);
  assert.deepEqual(seen.canvasPassed, [true],
    'pdf.js was left to infer the canvas from the context, which an OffscreenCanvas does differently');
  /*
   * And the option that is not about appearance at all, found live on
   * 2026-08-24 in the QA page: a `display` render advances one chunk per
   * `requestAnimationFrame`, and a hidden document gets no frames. The QA page
   * is driven with its tab in the background and the promise simply never
   * settled; a side panel the learner has tabbed away from is the same document
   * in the same state. Nothing here is painted into a viewport, so `print` is
   * both the honest name for what this is and the branch that schedules on
   * microtasks.
   */
  assert.deepEqual(seen.intents, ['print'],
    'a render scheduled against animation frames never finishes in a hidden document');
});

test('a page is drawn at a size a model can read, scaled by its longest edge', async () => {
  // Portrait, landscape and a poster: the long edge lands on the target in all
  // three, which is what keeps a landscape page from arriving half-legible.
  const { pdfjs, makeCanvas, seen } = stubRenderer([
    { width: 612, height: 792 },
    { width: 1224, height: 612 },
  ]);
  await pdfPages(new Uint8Array([1]), pdfjs, { makeCanvas });

  assert.equal(seen.drawn.length, 2);
  assert.equal(Math.round(Math.max(seen.drawn[0]!.width, seen.drawn[0]!.height)), PAGE_EDGE_PX);
  assert.equal(Math.round(Math.max(seen.drawn[1]!.width, seen.drawn[1]!.height)), PAGE_EDGE_PX);
  // The aspect ratio is not touched. A page squeezed to a square is a page of
  // text nobody can read.
  assert.ok(Math.abs(seen.drawn[0]!.width / seen.drawn[0]!.height - 612 / 792) < 0.01);
});

test('a page box of nothing does not become a scale of infinity', async () => {
  // A document lying about itself must not allocate a canvas nobody can hold.
  const { pdfjs, makeCanvas, seen } = stubRenderer([{ width: 0, height: 0 }]);
  const outcome = await pdfPages(new Uint8Array([1]), pdfjs, { makeCanvas });
  assert.equal(outcome.kind, 'pages');
  assert.deepEqual(seen.drawn, [{ width: 0, height: 0 }]);
  assert.equal(seen.canvases, 1, 'a zero-sized page still gets a canvas of at least one pixel');
});

test('every page comes back as its own jpeg data uri, in order', async () => {
  const { pdfjs, makeCanvas } = stubRenderer([
    { width: 612, height: 792 }, { width: 612, height: 792 }, { width: 612, height: 792 },
  ]);
  const outcome = await pdfPages(new Uint8Array([1]), pdfjs, { makeCanvas });
  assert.equal(outcome.kind, 'pages');
  assert.equal(outcome.kind === 'pages' && outcome.pages.length, 3);
  if (outcome.kind !== 'pages') return;
  for (const page of outcome.pages) assert.match(page, /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/);
});

test('a dense page is recompressed before it can exceed the hosted request boundary', async () => {
  const { pdfjs } = stubRenderer([{ width: 612, height: 792 }]);
  const qualities: number[] = [];
  const outcome = await pdfPages(new Uint8Array([1]), pdfjs, {
    makeCanvas: (width, height) => ({
      width, height, getContext: () => ({}),
      toDataUri: async (quality) => {
        qualities.push(quality);
        const bytes = quality === PAGE_QUALITY ? PAGE_WIRE_BYTES + 1 : 3;
        return `data:image/jpeg;base64,${'A'.repeat(Math.ceil(bytes / 3) * 4)}`;
      },
    }),
  });
  assert.equal(outcome.kind, 'pages');
  assert.deepEqual(qualities, [PAGE_QUALITY, 0.72]);
});

test('a document past the page cap is refused by its count, before a page is drawn', async () => {
  /**
   * The refusal has to name the number, and it has to happen BEFORE the render
   * loop. A silent slice of the front of somebody's dissertation is the
   * alternative, and twenty renders followed by a refusal is the same answer
   * paid for twice.
   */
  const { pdfjs, makeCanvas, seen } = stubRenderer(
    Array.from({ length: MAX_PAGES + 1 }, () => ({ width: 612, height: 792 })),
  );
  const outcome = await pdfPages(new Uint8Array([1]), pdfjs, { makeCanvas });
  assert.deepEqual(outcome, { kind: 'too-many-pages', pageCount: MAX_PAGES + 1, capPages: MAX_PAGES });
  assert.equal(seen.canvases, 0, 'pages were drawn for a document that was about to be refused');
  assert.equal(seen.destroyed, true);
});

test('a document exactly at the cap is drawn, not refused', async () => {
  const { pdfjs, makeCanvas } = stubRenderer(
    Array.from({ length: MAX_PAGES }, () => ({ width: 612, height: 792 })),
  );
  const outcome = await pdfPages(new Uint8Array([1]), pdfjs, { makeCanvas });
  assert.equal(outcome.kind, 'pages');
  assert.equal(outcome.kind === 'pages' && outcome.pages.length, MAX_PAGES);
});

test('one page that will not draw refuses the whole document, and names the page', async () => {
  /**
   * Nineteen pages of a twenty page essay, marked as if it were all of it, is
   * the exact silent partial this product refuses everywhere else. So a page
   * that throws is not skipped and is not a shorter attachment: it is a
   * refusal, and it says which page so the learner can go and look at it.
   */
  const { pdfjs, makeCanvas, seen } = stubRenderer([
    { width: 612, height: 792 },
    { width: 612, height: 792 },
    { width: 612, height: 792, throws: true },
    { width: 612, height: 792 },
  ]);
  const outcome = await pdfPages(new Uint8Array([1]), pdfjs, { makeCanvas });
  assert.deepEqual(outcome, { kind: 'page-failed', page: 3, pageCount: 4 });
  assert.equal(seen.drawn.length, 2, 'the render carried on past a page it could not draw');
  assert.equal(seen.destroyed, true, 'a failed render left the document open');
});

test('a document with no pages at all is unreadable rather than an empty attachment', async () => {
  // An attachment of zero pages would sail past every check downstream and be
  // sent as "the work", which is nothing.
  const { pdfjs, makeCanvas } = stubRenderer([]);
  assert.deepEqual(
    await pdfPages(new Uint8Array([1]), pdfjs, { makeCanvas }),
    { kind: 'unreadable', format: 'pdf' },
  );
});

test('PDFs and screenshots have an as-picture route, and the size cap is checked before the bytes', async () => {
  const { pdfjs, makeCanvas } = stubRenderer([{ width: 612, height: 792 }]);
  const deps = { loadPdfjs: async () => pdfjs, makeCanvas, pdfWorkerSrc: 'worker' };

  // A .docx is a zip of XML and nobody takes one natively, including the cloud
  // provider this ships against. There is no as-is route to offer for one.
  assert.deepEqual(await readPages(file('assignment.docx', 'x'), deps), { kind: 'unsupported' });
  assert.deepEqual(await readPages(file('essay.txt', 'words'), deps), { kind: 'unsupported' });
  assert.deepEqual(
    await readPages({ ...file('huge.pdf', 'x'), size: UPLOAD_CAPS.documentBytes + 1 }, deps),
    { kind: 'too-big', format: 'pdf', capBytes: UPLOAD_CAPS.documentBytes },
  );
  assert.equal((await readPages(file('essay.pdf', new Uint8Array([1])), deps)).kind, 'pages');
});

test('a screenshot is resized without distortion and becomes one model-ready picture', async () => {
  const seen = { canvas: [0, 0], draw: [0, 0], closed: false, loads: 0 };
  const outcome = await readPages(file('architecture.png', new Uint8Array([1, 2]), 'image/png'), {
    loadPdfjs: async () => { seen.loads += 1; throw new Error('image loaded pdf.js'); },
    decodeImage: async () => ({
      width: 3_000,
      height: 1_500,
      draw: (_context, width, height) => { seen.draw = [width, height]; },
      close: () => { seen.closed = true; },
    }),
    makeCanvas: (width, height) => {
      seen.canvas = [width, height];
      return {
        width, height,
        getContext: () => ({ id: '2d' }),
        toDataUri: async () => 'data:image/jpeg;base64,AA==',
      };
    },
  });

  assert.deepEqual(outcome, { kind: 'pages', pages: ['data:image/jpeg;base64,AA=='] });
  assert.deepEqual(seen.canvas, [PAGE_EDGE_PX, PAGE_EDGE_PX / 2]);
  assert.deepEqual(seen.draw, seen.canvas);
  assert.equal(seen.closed, true, 'the decoded bitmap was left in browser memory');
  assert.equal(seen.loads, 0, 'a screenshot paid the PDF parser cost');
});

test('a malformed screenshot is a named refusal rather than a thrown picker', async () => {
  assert.deepEqual(
    await readPages(file('broken.jpg', new Uint8Array([1]), 'image/jpeg'), {
      decodeImage: async () => { throw new Error('decode failed'); },
    }),
    { kind: 'unreadable', format: 'image' },
  );
});

test('the parser is pulled in for a render exactly as lazily as it is for a read', async () => {
  let loads = 0;
  const { pdfjs, makeCanvas } = stubRenderer([{ width: 612, height: 792 }]);
  const deps = { loadPdfjs: async () => { loads += 1; return pdfjs; }, makeCanvas };

  await readPages(file('notes.txt', 'x'), deps);
  await readPages(file('screen.png', new Uint8Array([1]), 'image/png'), {
    ...deps,
    decodeImage: async () => ({ width: 1, height: 1, draw: () => undefined }),
  });
  await readPages({ ...file('huge.pdf', 'x'), size: UPLOAD_CAPS.documentBytes + 1 }, deps);
  assert.equal(loads, 0, 'the parser was pulled in for something that will never be drawn');

  await readPages(file('essay.pdf', new Uint8Array([1])), deps);
  assert.equal(loads, 1);
});

test('a parser that will not load is a refusal here too, not a crash', async () => {
  assert.deepEqual(
    await readPages(file('essay.pdf', new Uint8Array([1])), {
      loadPdfjs: async () => { throw new Error('no such module'); },
    }),
    { kind: 'unreadable', format: 'pdf' },
  );
});

test('a canvas with no 2d context is a page failure rather than a thrown handler', async () => {
  // A side panel under memory pressure returns null from `getContext`. The
  // screen has to survive it: the alternative is a handler that threw and a
  // control that never came back.
  const { pdfjs } = stubRenderer([{ width: 612, height: 792 }]);
  const outcome = await pdfPages(new Uint8Array([1]), pdfjs, {
    makeCanvas: (width, height) => ({
      width, height,
      getContext: () => null,
      toDataUri: async () => 'data:image/jpeg;base64,AA==',
    }),
  });
  assert.deepEqual(outcome, { kind: 'page-failed', page: 1, pageCount: 1 });
});

test('a canvas that hands back something that is not an image is a page failure', async () => {
  // `toDataURL` on a tainted or zero-sized canvas answers `data:,` in some
  // browsers, which would otherwise be attached and sent as a page.
  const { pdfjs } = stubRenderer([{ width: 612, height: 792 }]);
  const outcome = await pdfPages(new Uint8Array([1]), pdfjs, {
    makeCanvas: (width, height) => ({
      width, height,
      getContext: () => ({}),
      toDataUri: async () => 'data:,',
    }),
  });
  assert.deepEqual(outcome, { kind: 'page-failed', page: 1, pageCount: 1 });
});
