import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The adapter seam, checked by a machine rather than by remembering it.
 *
 * The architecture law is that `core/` is a set of pure typed functions, every
 * model call goes through one `Llm` interface, every read and write through one
 * `Store` interface, and `core/` imports no vendor SDK — so the port costs two
 * adapters and not a rewrite. `scripts/check-seam.mjs` has enforced part of that
 * since early on, but it is a separate `npm run` that nothing in the test suite
 * calls, which means the law was only enforced when somebody remembered to
 * enforce it.
 *
 * This is the same idea as `extension/src/__tests__/manifest-paths.test.ts`:
 * deliberately dumb, filesystem-based, and reading the real files that will
 * ship. It cannot prove a design is good. It can prove that the one property
 * the port depends on has not quietly eroded — and erosion is the realistic
 * failure, because every violation starts as one convenient import in one file
 * that nothing complains about.
 */

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const at = (...parts: string[]): string => join(repo, ...parts);

/** Every `.ts` file under a directory, tests excluded — this guards what ships. */
function sources(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) { if (entry !== '__tests__') walk(p); continue; }
      if (p.endsWith('.ts')) out.push(p);
    }
  };
  walk(at(dir));
  return out;
}

const read = (p: string): string => readFileSync(p, 'utf8');
const show = (p: string): string => relative(repo, p);

/**
 * The file with its prose removed: block comments, and lines that are nothing
 * but a `//` comment.
 *
 * Deliberately not a general comment stripper. A trailing `//` after code is
 * left alone because `'https://e.com'` is a string this repo is full of, and a
 * stripper that reached inside strings would silently stop reading the second
 * half of any line containing a url — which is a guard that quietly checks less
 * than it says, the exact failure this file exists to prevent.
 *
 * Every check below already read the source this way. `imports` did not, so a
 * sentence of prose containing the words `from "openai"` counted as an import
 * and failed the seam test on a file that imports nothing of the kind.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Every module specifier a file imports from, static and dynamic. Code only. */
function imports(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  for (const m of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) out.push(m[1] as string);
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1] as string);
  for (const m of code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1] as string);
  return out;
}

test('a module specifier written in prose is not an import', () => {
  // The false positive that actually happened: a comment explaining why a file
  // does NOT import something named the something, and the guard read the
  // sentence as the import it was warning about.
  const src = [
    "// Deliberately not `import OpenAI from 'openai'` — the port waits on",
    '// sign-off.',
    '/**',
    " * And in a block: nothing here may come `from \"@google/generative-ai\"`,",
    " * nor from require('some-vendor-sdk'), nor from await import('another').",
    ' */',
    "import { cluster } from '../agents/clusterer.js';",
  ].join('\n');

  assert.deepEqual(imports(src), ['../agents/clusterer.js'],
    'only the line that is code counts');
});

test('the scanner still catches a real vendor import next to the prose', () => {
  // The mutation check on the fix above. Ignoring comments must not become
  // ignoring the file: the same fixture with one real import added has to fail.
  const src = [
    "// This file must never reach `from 'openai'`.",
    "import OpenAI from 'openai';",
    "const g = await import('@google/generative-ai');",
    "const s = require('some-vendor-sdk');",
    "import { cluster } from '../agents/clusterer.js';",
  ].join('\n');

  assert.deepEqual(imports(src),
    ['openai', '../agents/clusterer.js', '@google/generative-ai', 'some-vendor-sdk']);

  // And through the check that consumes it, rather than only through the parser.
  const strays = imports(src).filter((spec) => !spec.startsWith('./') && !spec.startsWith('../'));
  assert.deepEqual(strays, ['openai', '@google/generative-ai', 'some-vendor-sdk']);
});

test('a trailing comment after real code does not hide the code', () => {
  const src = "import { x } from './x.js'; // not from 'openai'";
  assert.ok(imports(src).includes('./x.js'), 'the code on the line is still read');
});

const CORE = sources('core/src');

test('the guard is reading the real core, not an empty directory', () => {
  // Every check below passes vacuously against nothing. This is the one that
  // fails when the layout moves and the guard stops guarding.
  assert.ok(CORE.length >= 20, `expected the whole of core/src, found ${CORE.length} files`);
  assert.ok(CORE.some((p) => p.endsWith('composer.ts')), 'the agents are not being read');
  assert.ok(CORE.some((p) => p.endsWith('llm.ts')), 'the ports are not being read');
});

test('core imports nothing but itself', () => {
  // Stated as a closed graph rather than as a blocklist of vendor names. A
  // blocklist has to be updated every time somebody picks a new SDK; this
  // cannot be got round, and it says the actual rule: core is a pure module
  // that reaches nothing — no vendor client, no adapter, no node builtin, no
  // sibling workspace.
  const strays: string[] = [];
  for (const file of CORE) {
    for (const spec of imports(read(file))) {
      if (spec.startsWith('./') || spec.startsWith('../')) continue;
      strays.push(`${show(file)} imports ${spec}`);
    }
  }
  assert.deepEqual(strays, [],
    'core/ must be a closed graph — one import here and the port stops being two adapters');
});

test('core reaches no ambient capability either', () => {
  // Imports are not the only door. `fetch` is a global, `process.env` is a
  // global, `chrome` is a global in one half of this repo, and any of them
  // would put I/O inside a function the whole design says is pure.
  const AMBIENT: readonly [RegExp, string][] = [
    [/\bfetch\s*\(/, 'fetch()'],
    [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
    [/\bWebSocket\b/, 'WebSocket'],
    // A PROPERTY access, not a full stop. `\bprocess\s*\.` matched the string
    // "Nothing new to process." in `domain/batch.ts` and reported core as
    // reaching an ambient capability — a sentence ending in the word read as
    // `process.env`. Comments are stripped before this runs; string literals
    // are not, and learner-facing copy lives in them.
    [/\bprocess\s*\.[A-Za-z_$]/, 'process'],
    [/\bglobalThis\s*\./, 'globalThis'],
    [/\blocalStorage\b/, 'localStorage'],
    [/\bchrome\s*\./, 'chrome.*'],
    // Time is injected through `Clock` so the seeded history and the nightly
    // replay are deterministic; reading the ambient clock breaks both.
    [/\bnew Date\s*\(\s*\)/, 'new Date() with no argument'],
    [/\bDate\.now\s*\(/, 'Date.now()'],
    [/\bMath\.random\s*\(/, 'Math.random()'],
    [/\brandomUUID\b/, 'randomUUID'],
  ];
  /**
   * The one exception, named rather than tolerated.
   *
   * `ports/clock.ts` exists so that reading the wall clock happens in exactly
   * one place with a name on it. `systemClock` is that place — it is what the
   * composition root passes in, and having it here is what lets every other
   * file in core be checked this strictly. An exemption list of one, that has
   * to be edited to grow, is the point.
   */
  const EXEMPT: Readonly<Record<string, readonly string[]>> = {
    'core/src/ports/clock.ts': ['new Date() with no argument'],
  };

  const found: string[] = [];
  for (const file of CORE) {
    const src = read(file);
    // Prose in this repo names these things constantly. Only code counts.
    const code = stripComments(src);
    const allowed = EXEMPT[show(file)] ?? [];
    for (const [re, what] of AMBIENT) {
      if (allowed.includes(what)) continue;
      if (re.test(code)) found.push(`${show(file)} uses ${what}`);
    }
  }
  assert.deepEqual(found, [],
    'an agent that reads the world instead of being handed it is not a pure function of its input');
});

test('core declares no dependencies of its own', () => {
  const pkg = JSON.parse(read(at('core/package.json'))) as Record<string, unknown>;
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.equal(pkg[field], undefined,
      `core/package.json declares ${field} — the seam is a property of the manifest too`);
  }
});

/**
 * The vendor dependencies this repository has decided to carry, one line each.
 *
 * The rule below used to be "none, anywhere", and the reason was that the port
 * waited on sign-off and credits: *"A vendor SDK arriving before that decision is
 * made — in any workspace, not only core — is the thing that turns 'two adapters'
 * into a negotiation."* That is still the rule. What has changed is that the
 * decision has now been made, twice, and a guard whose only setting is "no"
 * cannot record a yes — so it is a list rather than a prohibition, and the list
 * is the record.
 *
 * An entry here is a claim about the seam, not a convenience. `@google-cloud/
 * firestore` is the `Store` adapter's driver and `@google/adk` is the
 * orchestration host's framework; both sit at a port, neither is reachable from
 * `core/`, and the checks below still hold `core/` to nothing at all. Adding a
 * third line is a decision somebody has to make in a commit, which is the whole
 * mechanism.
 */
const DECLARED_VENDOR_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  /**
   * The production `Store` driver. Reached by `await import(FIRESTORE_MODULE)`
   * so a build that chose another store never loads it — but a dynamic import
   * is invisible to `npm ci`, and undeclared it was simply absent from the
   * image. `deploy-config.test.ts` is the half that checks it into the lockfile;
   * this is the half that says the repository meant to take it on.
   */
  adapters: ['@google-cloud/firestore'],
};

test('no workspace has taken on an undeclared third-party runtime dependency', () => {
  const strays: string[] = [];
  for (const ws of ['core', 'adapters', 'runner', 'extension']) {
    const allowed = DECLARED_VENDOR_DEPENDENCIES[ws] ?? [];
    const pkg = JSON.parse(read(at(ws, 'package.json'))) as { dependencies?: Record<string, string> };
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!dep.startsWith('@sb/') && !allowed.includes(dep)) strays.push(`${ws} depends on ${dep}`);
    }
  }
  assert.deepEqual(strays, []);
});

test('core is still on the no-vendor side of every one of those decisions', () => {
  // The list above is a door, and this is the wall it is set into. Whatever any
  // other workspace takes on, `core/` takes on nothing — that is what makes the
  // port two adapters rather than a rewrite, and it is why the exemption is
  // keyed by workspace instead of being a flat allowlist of package names.
  assert.equal(DECLARED_VENDOR_DEPENDENCIES['core'], undefined,
    'core has been given a vendor exemption — the adapter seam is what that trades away');
});

test('every model call in core goes through the injected Llm', () => {
  // The interface being the only *declared* seam is not the same as it being
  // the only *used* one. A call on anything other than `deps.llm` — a captured
  // client, a module-level singleton, a second interface someone added — is the
  // port's cost quietly doubling.
  const calls: string[] = [];
  for (const file of CORE) {
    const code = stripComments(read(file));
    for (const m of code.matchAll(/([A-Za-z_$][\w$.]*)\.(complete|structured)\s*[(<]/g)) {
      if (m[1] === 'deps.llm' || m[1] === 'llm') continue;
      calls.push(`${show(file)}: ${m[1]}.${m[2]}(`);
    }
  }
  assert.deepEqual(calls, [], 'a model call that does not come off the injected Llm');

  // And the seam is genuinely load-bearing rather than decorative: the agents
  // really do call it.
  const used = CORE.filter((f) => /deps\.llm\.(complete|structured)/.test(read(f)));
  assert.ok(used.length >= 8, `only ${used.length} agents reach the model — has an agent stopped using the seam?`);
});

test('every agent is handed its capabilities rather than building them', () => {
  const built: string[] = [];
  for (const file of sources('core/src/agents')) {
    const code = stripComments(read(file));
    for (const m of code.matchAll(/\bnew\s+([A-Z][\w$]*)/g)) {
      // Data structures are fine. Anything that could hold a connection is not.
      if (['Map', 'Set', 'Error', 'RegExp', 'Array', 'Intl'].includes(m[1] as string)) continue;
      built.push(`${show(file)} constructs ${m[1]}`);
    }
  }
  assert.deepEqual(built, [], 'agents receive capabilities, never construct them');
});

test('adapters are constructed in executable composition roots and nowhere else', () => {
  // Each executable wires its own capabilities. The service, batch CLI and
  // local connector worker are the three processes this repository ships.
  // `FirestoreStore` joined this list in the declaration commit, and it is the
  // guard that replaces the one it retired. The production store used to be
  // kept out of the adapters barrel, which made it inconvenient to construct and
  // also made it impossible for the composition roots to construct — so the
  // feature was unreachable and the omission was doing the work of a guard
  // without being one. It is exported now, which means the ordinary rule
  // applies: an adapter is built in a composition root, and this is what counts
  // the places.
  // `LocalNotebookExport` joined the list when the notebook seam was built. It
  // is an adapter like the rest: it holds the I/O behind `NotebookExport`, and
  // both composition roots construct one from the same `SB_NOTEBOOK_DIR`. A
  // third place that built one would be a third place the port would have to
  // be found from.
  const ADAPTER =
    /\bnew\s+(CliEndpointLlm|OllamaLlm|OllamaEmbedder|TfIdfEmbedder|JsonStore|LocalResearch|FirestoreStore|LocalNotebookExport)\b/;
  const roots = new Set([
    'runner/src/cli.ts', 'runner/src/service.ts', 'runner/src/local-model-connector-cli.ts',
  ]);
  const strays: string[] = [];
  for (const dir of ['core/src', 'adapters/src', 'runner/src', 'extension/src']) {
    for (const file of sources(dir)) {
      if (roots.has(show(file))) continue;
      const m = ADAPTER.exec(read(file));
      if (m) strays.push(`${show(file)} constructs ${m[1]}`);
    }
  }
  assert.deepEqual(strays, [],
    'an adapter built outside the composition root is a place the port would have to find');
});

test('Cloud, Local and CLI adapters are offered only by both composition roots', () => {
  /**
   * **This test used to say "wired into nothing", and its own comment named what
   * would end that:** *"The day the fleet moves to Gemini, this test is edited in
   * the same commit that moves it, and the edit is the record."* This is that
   * edit, and what it is enforcing has narrowed rather than gone.
   *
   * The argument it was never making, twice over. It was not "this thing has
   * never made a real call" — as of 2026-08-20 it has, against the live service,
   * and `GEMINI_TRANSPORT_PROOF_2026-08-20.md` records what that found. And it
   * was not "the fleet must not run on Gemini" — the model-benchmark boundary's condition
   * (*"Gemini's benchmark-lane role is benchmarking only"*) ends at deploy, and the
   * Job is handed `GEMINI_API_KEY` precisely so that something reads it.
   *
   * What it was making, and still is: **which provider the product runs on is a
   * decision made deliberately, in a composition root, by someone who meant it.**
   * Not by an import, and not by an environment variable that happens to be set
   * on somebody's laptop — which is exactly how a "local only" build starts
   * quietly spending money. So the guard's new job is preventing accidental
   * spend rather than preventing wiring:
   *
   *  - only the two composition roots may name the Cloud and CLI adapters, and both must reach
   *    it through `llmChoice` — a root that constructed it on any other
   *    condition would be a provider chosen by something other than the spec;
   *  - both must construct the Local adapter; Cloud being the product default
   *    must not make either alternate route decorative;
   *  - nothing else, anywhere, may name it.
   *
   * The behaviour behind the source scan is `model-spec.test.ts`, which starts a
   * service with no spec and asserts the boot warm-up reaches no `googleapis`
   * host. A scan proves the shape; that proves the money.
   *
   * Test files stay exempt by construction: `sources()` skips `__tests__`, so
   * the contract binding and the live proof both reach the adapter without
   * reaching the product.
   */
  const ROOTS = ['runner/src/cli.ts', 'runner/src/service.ts'];
  const strays: string[] = [];
  const reached: string[] = [];
  for (const dir of ['core/src', 'adapters/src', 'runner/src', 'extension/src']) {
    for (const file of sources(dir)) {
      if (show(file) === 'adapters/src/gemini-llm.ts') continue;
      if (!/\bGeminiLlm\b/.test(stripComments(read(file)))) continue;
      if (ROOTS.includes(show(file))) { reached.push(show(file)); continue; }
      strays.push(`${show(file)} references GeminiLlm`);
    }
  }
  assert.deepEqual(strays, [],
    'which provider the product runs on is a composition-root decision, not an import');
  assert.deepEqual(reached.sort(), [...ROOTS].sort(),
    'a composition root stopped offering the provider the deployment is configured for');

  const cliStrays: string[] = [];
  const cliReached: string[] = [];
  for (const dir of ['core/src', 'adapters/src', 'runner/src', 'extension/src']) {
    for (const file of sources(dir)) {
      if (show(file) === 'adapters/src/cli-endpoint-llm.ts') continue;
      if (!/\bCliEndpointLlm\b/.test(stripComments(read(file)))) continue;
      if (ROOTS.includes(show(file))) { cliReached.push(show(file)); continue; }
      cliStrays.push(`${show(file)} references CliEndpointLlm`);
    }
  }
  assert.deepEqual(cliStrays, [], 'CLI model transport escaped the composition roots');
  assert.deepEqual(cliReached.sort(), [...ROOTS].sort(),
    'a composition root stopped offering the CLI route');

  for (const root of ROOTS) {
    const code = stripComments(read(at(root)));
    assert.match(code, /\bllmChoice\s*\(/,
      `${root} builds GeminiLlm without going through the spec — the provider would be chosen by `
      + 'something other than the variable the deployment sets');
    assert.match(code, /new OllamaLlm\b/,
      `${root} can no longer build the Local adapter`);
    assert.match(code, /new CliEndpointLlm\b/,
      `${root} can no longer build the CLI adapter`);
  }
});

test('adapters do not import the runner, and the extension imports neither', () => {
  // The dependency arrow points one way: extension -> (HTTP) -> runner ->
  // adapters -> core. An adapter reaching back into the runner would make the
  // pair inseparable, and the extension importing either would put node code in
  // a service worker.
  const wrong: string[] = [];
  for (const file of sources('adapters/src')) {
    for (const spec of imports(read(file))) {
      if (spec.includes('@sb/runner') || spec.includes('/runner/')) wrong.push(`${show(file)} imports ${spec}`);
    }
  }
  for (const file of sources('extension/src')) {
    for (const spec of imports(read(file))) {
      if (spec.startsWith('.')) continue;
      wrong.push(`${show(file)} imports ${spec}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('the standing seam script and this test guard the same directory', () => {
  // The script predates this test and is still the thing CI runs by name. If it
  // is ever pointed somewhere else, the two enforcements have diverged and one
  // of them is lying about what is checked.
  const script = read(at('scripts/check-seam.mjs'));
  assert.match(script, /walk\('core\/src'\)/,
    'check-seam.mjs no longer walks core/src — one of these two guards is not guarding');
});

test('the ambient scan reads a property access, not an English full stop', () => {
  // Written after the scan reported `domain/batch.ts uses process` because a
  // learner-facing string said "Nothing new to process." Comments are stripped
  // before the scan; string literals are not, and copy lives in them.
  //
  // Both directions, so the sharpening did not turn the guard off.
  const ambient = /\bprocess\s*\.[A-Za-z_$]/;
  assert.equal(ambient.test('const line = "Nothing new to process.";'), false);
  assert.equal(ambient.test('press Process. Then wait.'), false);
  // The shape that actually caught it: a sentence ending in the word, followed
  // by a template interpolation.
  assert.equal(ambient.test('`Nothing new to process. ${n} topics due.`'), false);
  assert.equal(ambient.test('const x = process.env.SB_DB;'), true);
  assert.equal(ambient.test('process.argv[2]'), true);
  // The trade, stated: `process . env` with a space after the dot would now be
  // missed. Nobody writes that, and prose ending in the word is everywhere.
  assert.equal(ambient.test('process . env'), false);
});
