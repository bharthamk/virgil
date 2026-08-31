import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Every filename the extension ships, checked against the files on disk.
 *
 * This exists because of a defect that nothing else in this repo could see. The
 * manifest named `background.js`, `reread-bridge.js`, `reread.js` and
 * `reread-core.js` at the extension root; `tsc` emits all four into `dist/`.
 * Chrome refused to register the service worker and the extension had never
 * loaded from a clean clone — while the compiler, the type checker and 519
 * tests all passed, because a manifest is a list of strings and nothing was
 * reading it as paths.
 *
 * So the test is deliberately dumb: collect every path the manifest, the
 * content-script loader and `panel.html` reference, and `stat` each one. It
 * runs after `tsc -b`, so `dist/` is populated exactly as it would be for
 * someone who cloned the repo and ran `npm run build` before loading
 * `extension/` unpacked. It cannot start Chrome — a path that exists can still
 * be rejected for reasons only the browser knows — but every failure this class
 * of drift produces begins with a file that is not where it was said to be, and
 * that part is now permanently checked.
 */

const extensionDir = new URL('../../', import.meta.url);
const at = (relative: string): string => fileURLToPath(new URL(relative, extensionDir));
const read = (relative: string): string => readFileSync(at(relative), 'utf8');

interface Manifest {
  background?: { service_worker?: string; type?: string };
  content_scripts?: { js?: string[]; css?: string[] }[];
  web_accessible_resources?: { resources?: string[] }[];
  side_panel?: { default_path?: string };
  action?: { default_popup?: string; default_icon?: string | Record<string, string> };
  icons?: Record<string, string>;
  options_page?: string;
}

const manifest = JSON.parse(read('manifest.json')) as Manifest;

/** Every path the manifest points Chrome at, paired with where it said it. */
function manifestPaths(): { where: string; path: string }[] {
  const found: { where: string; path: string }[] = [];
  const add = (where: string, path: string | undefined): void => {
    // Resource globs are a matching rule, not a filename; there are none today.
    if (path !== undefined && !path.includes('*')) found.push({ where, path });
  };

  add('background.service_worker', manifest.background?.service_worker);
  add('side_panel.default_path', manifest.side_panel?.default_path);
  add('action.default_popup', manifest.action?.default_popup);
  add('options_page', manifest.options_page);

  manifest.content_scripts?.forEach((script, i) => {
    script.js?.forEach((js) => add(`content_scripts[${i}].js`, js));
    script.css?.forEach((css) => add(`content_scripts[${i}].css`, css));
  });
  manifest.web_accessible_resources?.forEach((entry, i) => {
    entry.resources?.forEach((r) => add(`web_accessible_resources[${i}].resources`, r));
  });

  const icon = manifest.action?.default_icon;
  if (typeof icon === 'string') add('action.default_icon', icon);
  else if (icon) for (const [size, path] of Object.entries(icon)) add(`action.default_icon[${size}]`, path);
  for (const [size, path] of Object.entries(manifest.icons ?? {})) add(`icons[${size}]`, path);

  return found;
}

test('every file the manifest names exists after a build', () => {
  const paths = manifestPaths();
  assert.ok(paths.length >= 6, 'the manifest stopped naming files, which means this test stopped reading it');
  for (const { where, path } of paths) {
    assert.ok(existsSync(at(path)),
      `manifest ${where} points at ${path}, and there is no such file — Chrome would refuse to load this`);
  }
});

/**
 * The toolbar icon ( the toolbar-capture contract).
 *
 * Chrome does not refuse an extension with no icon; it draws the first letter
 * of the name on a grey square and the product looks like a placeholder in the
 * one place it is permanently visible. The sizes are not decoration either —
 * Chrome picks per surface and per display density, and a missing size is
 * upscaled from whatever it can find, which is how a toolbar ends up showing a
 * blurred 16px mark on a retina screen.
 */
const ICON_SIZES = ['16', '32', '48', '128'];

/** A PNG's own idea of how big it is: width and height out of the IHDR chunk. */
function pngSize(relative: string): { width: number; height: number } {
  const bytes = readFileSync(at(relative));
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(bytes.subarray(0, 8).equals(signature), `${relative} is named .png and is not one`);
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR', `${relative} has no header chunk`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('the extension ships an icon at every size Chrome asks for', () => {
  assert.deepEqual(Object.keys(manifest.icons ?? {}).sort(), [...ICON_SIZES].sort(),
    'a size Chrome wants and cannot find is upscaled from one it can');
  const action = manifest.action?.default_icon;
  assert.ok(action && typeof action === 'object', 'the toolbar button has no icon of its own');
  assert.deepEqual(Object.keys(action).sort(), [...ICON_SIZES].sort());
});

test('every icon is a real PNG of the size it is filed under', () => {
  // Filed under a size and not that size is the failure this catches: Chrome
  // scales it silently, and the toolbar is the one surface nobody screenshots
  // because it is always there.
  for (const [size, path] of Object.entries(manifest.icons ?? {})) {
    assert.deepEqual(pngSize(path), { width: Number(size), height: Number(size) },
      `icons[${size}] is not ${size}x${size}`);
  }
});

test('every module the content-script loader fetches exists after a build', () => {
  // MV3 will not run a declared content script as a module, so the loader pulls
  // its graph in by URL. Those strings are unreachable to the compiler.
  const loader = read('reread-content.js');
  const fetched = [...loader.matchAll(/chrome\.runtime\.getURL\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]!);
  assert.deepEqual(fetched, ['dist/reread-bridge.js', 'dist/reread.js'],
    'the loader fetches a different set of modules than it used to — check they are still web-accessible');
  for (const path of fetched) {
    assert.ok(existsSync(at(path)), `the loader fetches ${path} at runtime, and there is no such file`);
  }
});

test('everything the loader fetches is also declared web-accessible', () => {
  // Existing on disk is not enough: a page can only import what the manifest
  // exposes, and the two lists drifted apart once already.
  const loader = read('reread-content.js');
  const fetched = [...loader.matchAll(/chrome\.runtime\.getURL\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]!);
  const exposed = (manifest.web_accessible_resources ?? []).flatMap((w) => w.resources ?? []);
  for (const path of fetched) {
    assert.ok(exposed.includes(path), `the loader fetches ${path} and the manifest does not expose it`);
  }
});

for (const page of ['panel.html', 'action-popup.html']) {
  test(`every local asset ${page} asks for exists after a build`, () => {
    // These are the two extension-owned HTML entry points. The full page is
    // service-owned `/app/` and is tested at the service boundary instead.
    const html = read(page);
    const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)]
      .map((m) => m[1]!)
      .filter((r) => !/^(?:https?:)?\/\/|^data:/.test(r));
    assert.ok(refs.length > 0, `${page} references nothing, which means this test stopped reading it`);
    for (const ref of refs) {
      assert.ok(existsSync(at(ref)), `${page} loads ${ref}, and there is no such file`);
    }
  });
}

/**
 * The one file this extension ships that no compiler is watching.
 *
 * `vendor/pdfjs` is a committed third-party build, loaded at runtime through
 * `import(chrome.runtime.getURL(...))` because a `chrome-extension://` url is
 * not a specifier `tsc` can resolve. That is exactly the shape of the defect
 * this whole file exists for: a string that looks like a path, that the type
 * checker cannot follow, and whose first failure is a learner dropping a PDF
 * and getting a refusal for a file that was perfectly readable.
 *
 * `dist/` is gitignored and rebuilt, so the vendor directory is deliberately
 * NOT under it. Nothing else in the extension depends on this working, which is
 * the point of loading it lazily: the parser being absent costs PDFs and no
 * other feature.
 */
test('the vendored PDF reader is where the panel says it is', async () => {
  const { PDFJS_MODULE, PDFJS_WORKER, PDFJS_FONTS } = await import('../upload.js');
  for (const path of [PDFJS_MODULE, PDFJS_WORKER, PDFJS_FONTS]) {
    assert.ok(existsSync(at(path)),
      `the Check screen imports ${path} the first time somebody drops a PDF, and there is no such file`);
    assert.ok(!path.startsWith('dist/'),
      'a committed vendor file under dist/ is one `npm run build` away from being deleted');
  }
  // The fonts are load-bearing for reading, not rendering: without them a PDF
  // using an unembedded base-14 font is refused outright. One known face is
  // enough to prove the directory is populated rather than merely present.
  assert.ok(existsSync(at(`${PDFJS_FONTS}FoxitFixed.pfb`)),
    'the standard-fonts directory exists but the font files are not in it');
  // Provenance, because a vendored blob nobody can date is a supply chain with
  // no record in it.
  const readme = read('vendor/pdfjs/README.md');
  assert.match(readme, /pdfjs-dist/);
  assert.match(readme, /\d+\.\d+\.\d+/, 'the vendored version is not written down');
});

test('the vendored reader is not exposed to every page the learner visits', () => {
  /**
   * `web_accessible_resources` is what a CONTENT SCRIPT and any web page can
   * reach. The side panel is an extension page at the extension's own origin
   * and needs no such grant to import its own files, so listing the parser
   * there would hand 3MB of it to every site on the web in exchange for
   * nothing. The same restraint the host-permission list is held to.
   */
  const exposed = (manifest.web_accessible_resources ?? []).flatMap((w) => w.resources ?? []);
  for (const path of exposed) {
    assert.ok(!path.startsWith('vendor/'), `${path} is exposed to every page and does not need to be`);
  }
});

test('the extension ships no full-page board of its own', () => {
  assert.equal(existsSync(at('main.html')), false,
    'the learner board belongs to the self-hosted service at /app/, not chrome-extension://');
  assert.doesNotMatch(read('panel.html'), /data-surface="page"/);
});

test('the browser QA harness is physically outside the shippable extension', () => {
  assert.equal(existsSync(at('qa.html')), false,
    'a directory-level extension package would carry the fake-auth QA harness');
  const harness = fileURLToPath(new URL('../qa/extension.html', extensionDir));
  assert.ok(existsSync(harness), 'the QA harness was removed rather than isolated');
  const html = readFileSync(harness, 'utf8');
  assert.match(html, /\.\.\/extension\/dist\/panel\.js/,
    'the isolated harness no longer runs the compiled production panel');
  assert.match(html, /qaParams\.get\('service'\)/,
    'an OS-assigned live acceptance service cannot be selected by the QA page');
  assert.match(html, /parsed\.protocol === 'http:'[\s\S]*\['127\.0\.0\.1', 'localhost'\]\.includes\(parsed\.hostname\)/,
    'the QA service override is no longer restricted to loopback HTTP');
  assert.match(html, /new URL\(`\.\.\/extension\/\$\{String\(path\)/,
    'the QA runtime no longer resolves extension assets from the extension root');
  assert.doesNotMatch(html, /new URL\(path, location\.href\)/,
    'a page-relative QA asset URL makes real PDFs look unreadable');
});

test('the service worker is declared as the kind of script it actually is', () => {
  // `background.ts` imports, so `tsc` emits a module, and a module service
  // worker without `"type": "module"` fails on its first import — at
  // registration, in the browser, and nowhere a test would otherwise look.
  const workerPath = manifest.background?.service_worker;
  assert.ok(workerPath, 'no service worker is declared at all');
  const worker = read(workerPath);
  const isModule = worker.split('\n').some((line) => /^\s*(?:import|export)\b/.test(line));
  assert.equal(manifest.background?.type === 'module', isModule,
    isModule
      ? 'the emitted worker is an ES module and the manifest does not say `"type": "module"`'
      : 'the manifest declares a module worker and the emitted file is a classic script');
});
