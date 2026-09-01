import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The seam law, extended to a sixth workspace — rather than the sixth workspace
 * quietly sitting outside it.
 *
 * `runner/src/__tests__/seam-purity.test.ts` checks that no workspace has taken
 * on a third-party runtime dependency, and it names four: `core`, `adapters`,
 * `runner`, `extension`. `adk/src/__tests__/adk-seam.test.ts` extended that rule
 * to the fifth without editing the fourth, and asserted it had not edited it.
 * This file does the same for the sixth, and asserts that **both** of the
 * earlier guards are still intact — because the erosion this family of files
 * exists to prevent is precisely somebody widening an old guard to make room for
 * a new workspace and calling it housekeeping.
 *
 * Two rules here that the ADK guard has no reason to make, and that this layer
 * lives or dies on:
 *
 *  1. **Nothing here reads a clock.** The night key must come off the message,
 *     because Pub/Sub is at-least-once and a key derived from receipt time gives
 *     a redelivered trigger a night of its own. That is a property somebody can
 *     break with one convenient `Date.now()`, so it is guarded the way `core/`'s
 *     purity is guarded rather than left to review.
 *  2. **Nothing here runs the nightly.** The night is injected as a function.
 *     A workspace that imported `runBatch` would have decided where the job
 *     entrypoint lives, and `adk/DESIGN.md` §5a is explicit that this is still
 *     open.
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

const TRIGGER = sources('trigger/src');

test('the guard is reading the real workspace', () => {
  assert.ok(TRIGGER.length >= 6, `expected trigger/src, found ${TRIGGER.length} files`);
  assert.ok(TRIGGER.some((p) => p.endsWith('pubsub-binding.ts')), 'the binding is not being read');
  assert.ok(TRIGGER.some((p) => p.endsWith('batch-key.ts')), 'the night key is not being read');
  assert.ok(TRIGGER.some((p) => p.endsWith('handler.ts')), 'the handler is not being read');
});

test('the trigger workspace declares no third-party dependency', () => {
  /**
   * The orchestration dependency boundary's convention, applied to the second infra dependency of the port.
   * Recorded honestly: unlike `@google/adk`, `@google-cloud/pubsub` is
   * *runtime-required* for a deployed nightly rather than an architectural
   * choice, and at 73 transitive packages it is a tenth of ADK's cost — so it is
   * a better candidate for declaring. Declaring it is still the deploy commit's
   * decision, and this branch deploys nothing.
   */
  const pkg = JSON.parse(read(at('trigger/package.json'))) as Record<string, Record<string, string> | undefined>;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      assert.ok(dep.startsWith('@sb/'),
        `trigger/package.json ${field} declares ${dep} — the infra dependency is the deploy commit’s decision`);
    }
  }
});

test('neither earlier seam guard was widened to make room for this workspace', () => {
  const guard = read(at('runner/src/__tests__/seam-purity.test.ts'));
  assert.match(guard, /\['core', 'adapters', 'runner', 'extension'\]/,
    'seam-purity.test.ts’s workspace list has changed — was the guard edited to make room?');
  assert.match(guard, /core imports nothing but itself/, 'the closed-graph check is gone');

  const adk = read(at('adk/src/__tests__/adk-seam.test.ts'));
  assert.match(adk, /exactly one file names the framework package/,
    'the ADK workspace’s own guard has changed — this lane does not touch it');
});

test('exactly one file names the Pub/Sub package', () => {
  // The whole dependency arrives through one door, and the door has a name on
  // it. A second file naming it is a second place the version is pinned and a
  // second place that breaks when 7.0 lands.
  const naming = TRIGGER.filter((f) => /@google-cloud\/pubsub/.test(stripComments(read(f)))).map(show);
  assert.deepEqual(naming, ['trigger/src/pubsub-binding.ts']);
});

test('the client is never imported statically', () => {
  const strays: string[] = [];
  for (const file of TRIGGER) {
    for (const spec of imports(read(file))) {
      if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('@sb/')) continue;
      if (spec.startsWith('node:')) continue;
      strays.push(`${show(file)} imports ${spec}`);
    }
  }
  assert.deepEqual(strays, [],
    'the client is loaded by name at runtime, not imported at build time');
});

test('importing the workspace index cannot pull the client in', () => {
  const index = stripComments(read(at('trigger/src/index.ts')));
  assert.ok(!/pubsub-binding/.test(index),
    'index.ts re-exports the binding — importing the layer would now load the client');
});

test('nothing here reads a clock, so a redelivered trigger cannot become a new night', () => {
  /**
   * The load-bearing property of the whole design, guarded rather than
   * remembered. The night key is derived from an instant the *message* carries;
   * one `Date.now()` in the wrong place and every redelivery builds a night of
   * its own, which is the exact failure at-least-once delivery makes inevitable.
   *
   * The exemption is a list of one that has to be edited to grow — the same
   * shape `seam-purity.test.ts` uses for `ports/clock.ts`.
   */
  const AMBIENT: readonly [RegExp, string][] = [
    [/\bDate\.now\s*\(/, 'Date.now()'],
    [/\bnew Date\s*\(\s*\)/, 'new Date() with no argument'],
    [/\bMath\.random\s*\(/, 'Math.random()'],
  ];
  const EXEMPT: Readonly<Record<string, readonly string[]>> = {
    // The in-memory queue stamps a publish time, which is what a broker does.
    // It is injectable and every test injects it; the default exists so a
    // caller that does not care is not forced to.
    'trigger/src/local-transport.ts': ['new Date() with no argument'],
  };

  const found: string[] = [];
  for (const file of TRIGGER) {
    const code = stripComments(read(file));
    const allowed = EXEMPT[show(file)] ?? [];
    for (const [re, what] of AMBIENT) {
      if (allowed.includes(what)) continue;
      if (re.test(code)) found.push(`${show(file)} uses ${what}`);
    }
  }
  assert.deepEqual(found, [],
    'a night key derived from the moment of receipt is a night per delivery');
});

test('the layer reaches no ambient network of its own', () => {
  // The client may open a socket; this workspace may not. Anything fetching
  // here would be a trigger layer that had started talking to a service
  // directly.
  const found: string[] = [];
  for (const file of TRIGGER) {
    const code = stripComments(read(file));
    for (const [re, what] of [[/\bfetch\s*\(/, 'fetch()'], [/\bXMLHttpRequest\b/, 'XMLHttpRequest']] as const) {
      if (re.test(code)) found.push(`${show(file)} uses ${what}`);
    }
  }
  assert.deepEqual(found, []);
});

test('nothing here calls a model, runs the nightly, or names an adapter', () => {
  /**
   * The trigger decides whether a night may run. It does not run one — the
   * night is injected as a `NightRunner`, so the same handler composes with
   * `runBatch` directly or with the ADK host wrapping it, and neither choice
   * is made here.
   */
  const strays: string[] = [];
  for (const file of TRIGGER) {
    const code = stripComments(read(file));
    for (const m of code.matchAll(/([A-Za-z_$][\w$.]*)\.(complete|structured)\s*[(<]/g)) {
      strays.push(`${show(file)}: ${m[1]}.${m[2]}(`);
    }
    for (const name of ['runBatch', 'GeminiLlm', 'OllamaLlm', 'JsonStore', 'LocalResearch']) {
      if (new RegExp(`\\b${name}\\b`).test(code)) strays.push(`${show(file)} names ${name}`);
    }
  }
  assert.deepEqual(strays, [],
    'the trigger decides whether a night may run — it does not run one, and it picks no provider');
});

test('the workspace is wired into nothing', () => {
  /**
   * The same rule the Gemini adapter and the ADK host live under. Whether the
   * nightly is triggered by a message queue is a decision about how the product
   * is deployed, and a decision is made deliberately in a composition root by
   * someone who meant it — not by an import that happened to land.
   *
   * The day the nightly moves onto Pub/Sub, this test is edited in the same
   * commit that moves it, and the edit is the record.
   */
  const strays: string[] = [];
  for (const dir of ['core/src', 'adapters/src', 'runner/src', 'extension/src', 'adk/src']) {
    for (const file of sources(dir)) {
      const code = stripComments(read(file));
      if (/@sb\/trigger|PubSubTransport|nightlyTriggerHandler/.test(code)) {
        strays.push(`${show(file)} reaches the trigger layer`);
      }
    }
  }
  assert.deepEqual(strays, [],
    'whether the nightly is triggered by a queue is a composition-root decision, not an import');
});
