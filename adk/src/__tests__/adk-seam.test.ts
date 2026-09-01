import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The seam law, extended to cover the workspace that did not exist when it was
 * written — rather than the workspace quietly sitting outside it.
 *
 * `runner/src/__tests__/seam-purity.test.ts` checks that no workspace has taken
 * on a third-party runtime dependency, and it names four: `core`, `adapters`,
 * `runner`, `extension`. `adk` is a fifth. That test loops over a literal list,
 * so adding a workspace with a vendor dependency in it would pass every
 * assertion there while contradicting the sentence the test is built around:
 * *"A vendor SDK arriving before that decision is made — in any workspace, not
 * only core — is the thing that turns 'two adapters' into a negotiation."*
 *
 * Satisfying the letter of a guard while breaking its stated intent is the exact
 * erosion that file exists to prevent, so the guard is left untouched and the
 * rule is extended here instead. Two consequences, both deliberate:
 *
 *  1. This workspace declares no vendor dependency either. `@google/adk` is
 *     loaded dynamically, is not in `package.json`, and is opt-in — so merging
 *     this branch costs nobody 605 transitive packages, and promoting it to a
 *     real dependency stays a decision made deliberately, by someone who meant
 *     it, in the commit that makes it.
 *  2. The seam itself is untouched. `core/` is still a closed graph, `Llm` is
 *     still the only door to a model, and nothing here constructs an adapter.
 *     ADK sits ABOVE the seam — it sequences stages, it does not call models.
 */

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
  /**
   * **The orchestration dependency boundary, discharged.** This test used to say "no third-party dependency,
   * full stop", and the reason was that whether the product takes on 603
   * packages was the build owner's decision to make *"in the commit where the
   * ADK host becomes the nightly's real Cloud Run entrypoint"*. `deploy/job.yaml`
   * now sets `SB_ORCHESTRATOR=adk`, so this is that commit, and the guard
   * records the decision instead of forbidding it.
   *
   * What it does not become is a door. Exactly one name may be here, it must be
   * the module `adk-binding.ts` loads and the version that binding was proven
   * against, and everything else in this workspace is still held to `@sb/`. A
   * second vendor arriving in the orchestration layer is still an argument
   * somebody has to have.
   */
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
  // `runner` reaches this layer since the declaration commit, so the arrow that
  // used to point back — `adk` -> `runner`, declared and never actually used —
  // is now a cycle `tsc -b` refuses to build. Removed rather than worked around,
  // because the direction is the design: the composition root composes, and the
  // orchestration layer is a library that does not know who hosts what.
  const pkg = JSON.parse(read(at('adk/package.json'))) as { dependencies?: Record<string, string> };
  assert.ok(!('@sb/runner' in (pkg.dependencies ?? {})), 'adk depends on runner, which depends on adk');
  const refs = JSON.parse(read(at('adk/tsconfig.json'))) as { references?: { path: string }[] };
  assert.deepEqual(refs.references, [{ path: '../core' }]);
});

test('the standing seam guard still names the four workspaces it always did', () => {
  // If this branch had needed to edit that list to make room, that edit would be
  // the thing to argue about — so this asserts it was not edited. The two guards
  // are complementary and neither has been widened to accommodate the other.
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
   * **This test used to say "wired into nothing", and its own comment said what
   * would end that:** *"The day the nightly moves onto ADK, this test is edited
   * in the same commit that moves it, and the edit is the record."* This is that
   * edit.
   *
   * What it enforced is not abandoned, it is narrowed to the thing that was
   * actually load-bearing. The rule was never "no file may import this layer" —
   * it was that whether the nightly runs under a framework is a decision made
   * deliberately in a composition root by someone who meant it, rather than by
   * an import that happened to land. So:
   *
   *  - `runner/src/cli.ts` may reach it. That is the composition root the Job
   *    runs, and `SB_ORCHESTRATOR` is where the decision is written down.
   *  - Nothing else may. `core/` and `adapters/` are below the seam and an
   *    orchestration import there would invert the architecture; `service.ts`
   *    runs no nightly; the extension is a browser artefact.
   *  - `adkHost` and `AdkSequentialHost` may still be named nowhere outside this
   *    workspace. The root asks for a host *by name* and `select.ts` decides
   *    what that means — a root that imported the binding directly would be a
   *    second file pinning the framework, which is what the whole one-door
   *    design exists to prevent.
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
    + 'and the orchestration dependency boundary says the dependency leaves with it');
});
