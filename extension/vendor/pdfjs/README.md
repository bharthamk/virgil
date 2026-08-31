# pdf.js, vendored

This directory is the extension's **only** third-party runtime code. It is
committed rather than installed, and read rather than trusted.

## What is here, and where it came from

| file | bytes | sha256 |
| --- | --- | --- |
| `pdf.mjs` | 853,537 | `487bde1bcf89e041f791173d0509a1dc18d0feb6655d78395e1611f9da0de17d` |
| `pdf.worker.mjs` | 2,222,991 | `1a7607f28cfbc63f0e4e0a41927c89f991e353e4f3fb4565ecfd621ac5975089` |
| `standard_fonts/` (16 files, ~800K) | | copied whole from `node_modules/pdfjs-dist/standard_fonts/` |
| `LICENSE` | | Apache-2.0, as shipped in the package |

- **Package:** [`pdfjs-dist`](https://www.npmjs.com/package/pdfjs-dist)
- **Version:** `6.2.108`
- **Upstream:** <https://github.com/mozilla/pdf.js>
- **Licence:** Apache-2.0
- **Vendored:** 2026-08-24
- **Provenance:** copied byte-for-byte out of `node_modules/pdfjs-dist/build/`
  after `npm install -D pdfjs-dist@6.2.108 -w extension`. Nothing was edited,
  minified or re-bundled. `pdf.mjs` still carries its trailing
  `//# sourceMappingURL=pdf.mjs.map` comment; the map itself is 2MB of no use
  without the upstream sources and is deliberately not committed, so devtools
  will log one 404 for it if it is opened on this page. The generic
  (non-minified) build is vendored on purpose: a committed dependency should be
  a file a reviewer can read.

## To update it

```sh
npm install -D pdfjs-dist@<version> -w extension
cp node_modules/pdfjs-dist/build/pdf.mjs        extension/vendor/pdfjs/
cp node_modules/pdfjs-dist/build/pdf.worker.mjs extension/vendor/pdfjs/
cp -R node_modules/pdfjs-dist/standard_fonts    extension/vendor/pdfjs/
cp node_modules/pdfjs-dist/LICENSE              extension/vendor/pdfjs/
shasum -a 256 extension/vendor/pdfjs/pdf*.mjs   # then update the table above
```

`pdfjs-dist` is a **devDependency of `extension/`**. It exists so these two
files can be copied out of it. Nothing in `src/` imports the package, and the
build does not read it.

## Why it is not in `dist/`

`dist/` is gitignored and rewritten by every `tsc -b`. A committed vendor file
in there is one build away from being deleted, and the first anybody would hear
of it is a learner dropping a PDF onto a screen that suddenly cannot read one.
`manifest-paths.test.ts` asserts both of these files exist and that neither
path starts with `dist/`.

## How it is used, and what is deliberately not used

`src/upload.ts` loads `pdf.mjs` **lazily** — the import happens the first time
somebody actually drops a PDF, and never when the Check room draws. A 3MB
parser paid for on every render would be a worse product than one that cannot
read PDFs at all.

Only text extraction is used: `getDocument`, `numPages`, `getPage`,
`getTextContent`. There is no rendering, no canvas, no wasm and no `cMapUrl`.

`standard_fonts/` is the one exception to "text needs no fonts", and it was
found live rather than reasoned about: a PDF that uses a base-14 font without
embedding it — most PDFs typed straight into a generator — makes pdf.js load
that font's glyph maps even for `getTextContent`, and with nowhere to load
them from the **whole document** is refused as unreadable. The directory is
vendored and addressed through `chrome.runtime.getURL()`, the same self-fetch
as the worker, so nothing below changes.

That restraint is what keeps the extension's surface unchanged:

- **No manifest CSP change.** `getDocument` is called with
  `isEvalSupported: false`, which is what MV3's policy requires.
- **No host permission and no remote URL.** Both files are addressed through
  `chrome.runtime.getURL()`, so `extension-surface.test.ts` stays green.
- **No `web_accessible_resources` entry.** The side panel is an extension page
  at the extension's own origin and can import its own files. Listing these
  would expose them to every page the learner visits, in exchange for nothing.

A PDF whose pages are images parses fine and yields no text. That is reported
as its own outcome and gets its own sentence, rather than being reported as a
file that could not be opened.
