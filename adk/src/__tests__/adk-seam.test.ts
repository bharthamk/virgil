import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';


const repo = fileURLToPath(new URL('../../../', import.meta.url));
const at = (...parts: string[]): string => join(repo, ...parts);

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

/** Prose removed, so a comment discussing a package is not read as importing it. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function imports(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  for (const m of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) out.push(m[1] as string);
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1] as string);
  for (const m of code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1] as string);
  return out;
}

const ADK = sources('adk/src');

test('the guard is reading the real workspace', () => {
  assert.ok(ADK.length >= 5, `expected adk/src, found ${ADK.length} files`);
  assert.ok(ADK.some((p) => p.endsWith('adk-binding.ts')), 'the binding is not being read');
  assert.ok(ADK.some((p) => p.endsWith('host.ts')), 'the host is not being read');
});

test('the orchestration workspace declares exactly one vendor dependency, and it is the framework', () => {
  const pkg = JSON.parse(read(at('adk/package.json'))) as Record<string, Record<string, string> | undefined>;
  const binding = read(at('adk/src/adk-binding.ts'));
  const moduleName = /export const ADK_MODULE: string = '([^']+)'/.exec(binding)?.[1];
  const version = /export const ADK_PINNED_VERSION = '([^']+)'/.exec(binding)?.[1];
  assert.ok(moduleName && version, 'the binding stopped naming its module and version as constants');

  assert.deepEqual(pkg['dependencies'], { '@sb/core': '*', [moduleName]: version },
    'adk/package.json declares something other than core and the pinned framework');
  for (const field of ['devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.equal(pkg[field], undefined, `adk/package.json declares ${field}`);
  }
});

test('the ADK lock closes the known archive-allocation advisory', () => {
  const root = JSON.parse(read(at('package.json'))) as {
    overrides?: Record<string, unknown>;
  };
  const lock = JSON.parse(read(at('package-lock.json'))) as {
    packages?: Record<string, { version?: string }>;
  };
  assert.deepEqual(root.overrides?.['@google/adk@2.0.0'], { 'adm-zip': '0.6.0' },
    'removing the override reintroduces ADK\'s vulnerable adm-zip range');
  assert.equal(lock.packages?.['node_modules/adm-zip']?.version, '0.6.0',
    'the clean-install lock no longer resolves the patched archive reader');
});

test('the workspace does not depend on the one that now depends on it', () => {
  const pkg = JSON.parse(read(at('adk/package.json'))) as { dependencies?: Record<string, string> };
  assert.ok(!('@sb/runner' in (pkg.dependencies ?? {})), 'adk depends on runner, which depends on adk');
  const refs = JSON.parse(read(at('adk/tsconfig.json'))) as { references?: { path: string }[] };
  assert.deepEqual(refs.references, [{ path: '../core' }]);
});

test('the standing seam guard still names the four workspaces it always did', () => {
  const guard = read(at('runner/src/__tests__/seam-purity.test.ts'));
  assert.match(guard, /\['core', 'adapters', 'runner', 'extension'\]/,
    'seam-purity.test.ts’s workspace list has changed — was the guard edited to make room?');
  assert.match(guard, /core imports nothing but itself/, 'the closed-graph check is gone');
});

test('exactly one file names the framework package', () => {
  /**
   * The whole dependency arrives through one door, and the door has a name on
   * it. A second file naming `@google/adk` is a second place the version is
   * pinned and a second place that breaks when the graph `Workflow` API lands.
   */
  const naming = ADK.filter((f) => /@google\/adk/.test(stripComments(read(f)))).map(show);
  assert.deepEqual(naming, ['adk/src/adk-binding.ts']);
});

test('the framework is never imported statically', () => {
  // A static import is loaded whether or not anybody chose ADK, and would make
  // `tsc` fail the workspace whenever the package is absent — which is most of
  // the time. Every import in this workspace is relative or `@sb/`.
  const strays: string[] = [];
  for (const file of ADK) {
    for (const spec of imports(read(file))) {
      if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('@sb/')) continue;
      if (spec.startsWith('node:')) continue;
      strays.push(`${show(file)} imports ${spec}`);
    }
  }
  assert.deepEqual(strays, [],
    'the framework is loaded by name at runtime, not imported at build time');
});

test('importing the workspace index cannot pull the framework in', () => {
  /**
   * `index.ts` deliberately does not re-export the binding, so "does this
   * deployment use ADK" stays a question with a findable answer rather than a
   * side effect of an import somewhere.
   *
   * Checked transitively now, and it had to be: `select.ts` is exported from the
   * index and its whole job is to reach the binding, so a filename check on
   * `index.ts` alone would have gone quiet on exactly the file that could break
   * this. What matters is that nothing *statically* reachable from the index
   * imports the binding — `select.ts` reaches it inside a function, so a run
   * that chose `local` loads no framework at all.
   */
  /**
   * Static only. `imports()` collects dynamic ones too, and a walk that could
   * not tell the two apart would fail on `select.ts` — the one file whose whole
   * design is that its reach is deferred to a function call.
   */
  const staticImports = (src: string): string[] =>
    [...stripComments(src).matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1] as string);

  const seen = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of staticImports(read(file))) {
      if (!spec.startsWith('.')) continue;
      assert.ok(!/adk-binding/.test(spec),
        `${show(file)} statically imports the binding — importing the layer now loads the framework`);
      walk(join(at('adk/src'), spec.replace(/\.js$/, '.ts')));
    }
  };
  walk(at('adk/src/index.ts'));
  assert.ok(seen.size >= 4, `the index reaches only ${seen.size} files — is it still the index?`);
});

test('the one file that can reach the binding reaches it dynamically', () => {
  // The other half of the sentence above, asserted rather than left to the walk
  // finding nothing. A static import here would load 603 packages into every
  // process that touched the layer, including the ones that chose `local`.
  const select = stripComments(read(at('adk/src/select.ts')));
  assert.match(select, /await import\('\.\/adk-binding\.js'\)/,
    'select.ts no longer loads the binding dynamically');
  assert.ok(!/\bfrom\s+['"]\.\/adk-binding\.js['"]/.test(select),
    'select.ts statically imports the binding');
});

test('nothing here calls a model, or knows which provider would answer', () => {
  /**
   * The load-bearing property of the whole design. ADK sequences stages; the
   * model call stays behind `core/src/ports/llm.ts`. A `.complete(` or
   * `.structured(` in this workspace would mean the orchestration layer had
   * become a second door to the provider, and `GeminiLlm` appearing here would
   * mean it had picked one — a composition-root decision either way.
   */
  const strays: string[] = [];
  for (const file of ADK) {
    const code = stripComments(read(file));
    for (const m of code.matchAll(/([A-Za-z_$][\w$.]*)\.(complete|structured)\s*[(<]/g)) {
      strays.push(`${show(file)}: ${m[1]}.${m[2]}(`);
    }
    for (const name of ['GeminiLlm', 'OllamaLlm', 'JsonStore', 'LocalResearch']) {
      if (new RegExp(`\\b${name}\\b`).test(code)) strays.push(`${show(file)} names ${name}`);
    }
  }
  assert.deepEqual(strays, [],
    'the orchestration layer sequences stages — it does not call models or choose providers');
});

test('the layer reaches no ambient network of its own', () => {
  // ADK may open a socket; this workspace may not. Anything fetching here would
  // be an orchestration layer that had started talking to a provider directly.
  const found: string[] = [];
  for (const file of ADK) {
    const code = stripComments(read(file));
    for (const [re, what] of [[/\bfetch\s*\(/, 'fetch()'], [/\bXMLHttpRequest\b/, 'XMLHttpRequest']] as const) {
      if (re.test(code)) found.push(`${show(file)} uses ${what}`);
    }
  }
  assert.deepEqual(found, []);
});

test('the workspace is reached from exactly one composition root, and never below it', () => {
  /**
   * Framework selection belongs in `runner/src/cli.ts`, the composition root
   * for the background Job. Domain code, adapters, the service, and browser
   * code must not import the orchestration workspace. The root selects a host
   * by name and `select.ts` alone resolves that name to a binding.
   */
  const ROOT = 'runner/src/cli.ts';
  const strays: string[] = [];
  let rootReaches = false;
  for (const dir of ['core/src', 'adapters/src', 'runner/src', 'extension/src']) {
    for (const file of sources(dir)) {
      const code = stripComments(read(file));
      if (/AdkSequentialHost|adkHost|@google\/adk/.test(code)) {
        strays.push(`${show(file)} names the binding or the framework itself`);
      }
      if (!/@sb\/adk/.test(code)) continue;
      if (show(file) === ROOT) { rootReaches = true; continue; }
      strays.push(`${show(file)} reaches the ADK layer`);
    }
  }
  assert.deepEqual(strays, [],
    'whether the nightly runs under a framework is a composition-root decision, not an import');
  assert.ok(rootReaches, `${ROOT} no longer reaches the ADK layer — the nightly has left the framework, `
    + 'and the framework-boundary contract says the dependency leaves with it');
});
