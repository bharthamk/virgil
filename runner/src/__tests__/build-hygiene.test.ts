/**
 * A compiled test whose source is gone still runs, and still passes.
 *
 * Found while renaming the nightly vocabulary: `tsc -b` compiles, it does not
 * clean. Renaming `nightly-racing.test.ts` to `batch-racing.test.ts` left
 * `nightly-racing.test.js` in `dist`, so BOTH ran and the suite reported 2,684
 * where the truth was 2,667 — seventeen tests that existed only as build
 * output.
 *
 * That direction is the dangerous one. A stale artefact does not fail; it
 * passes, against code that may no longer exist, and it inflates the number
 * this project quotes in every commit message as evidence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORKSPACES = ['core', 'adapters', 'runner', 'extension', 'adk', 'trigger'];

test('the root build cannot turn a compiler failure into success', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts?: { build?: string };
  };
  const build = pkg.scripts?.build ?? '';
  assert.match(build, /(?:^|&&\s*)tsc -b(?:\s*&&|$)/, 'the root build no longer runs the compiler');
  assert.doesNotMatch(build, /\|\|\s*true\b/,
    'a trailing success branch masks `tsc -b` and lets stale dist load as a successful build');
});

function compiledTests(workspace: string): string[] {
  const dir = join(ROOT, workspace, 'dist', '__tests__');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => join(workspace, f));
}

test('every compiled test still has a source file behind it', () => {
  const orphans: string[] = [];
  for (const workspace of WORKSPACES) {
    for (const compiled of compiledTests(workspace)) {
      const name = compiled.slice(workspace.length + 1).replace(/\.js$/, '.ts');
      const source = join(ROOT, workspace, 'src', '__tests__', name);
      if (!existsSync(source)) orphans.push(compiled);
    }
  }
  assert.deepEqual(orphans, [],
    'these run and pass with no source behind them — delete dist and rebuild, '
    + 'and check the suite count in the last commit message was real');
});

test('every compiled test is at least as new as its source', () => {
  // The other half of the same hazard: a source edited without a rebuild means
  // the suite is testing what the code USED to be. Cheap to check, and this is
  // the only place that would notice.
  const stale: string[] = [];
  for (const workspace of WORKSPACES) {
    for (const compiled of compiledTests(workspace)) {
      const name = compiled.slice(workspace.length + 1).replace(/\.js$/, '.ts');
      const source = join(ROOT, workspace, 'src', '__tests__', name);
      if (!existsSync(source)) continue;
      const out = statSync(join(ROOT, workspace, 'dist', '__tests__', compiled.slice(workspace.length + 1)));
      if (statSync(source).mtimeMs > out.mtimeMs + 1000) stale.push(compiled);
    }
  }
  assert.deepEqual(stale, [], 'the source is newer than what is being run');
});
