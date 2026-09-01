import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts/package-source-release.mjs');

function assertCleanSnapshot(out: string, allowInstalledDependencies = false) {
  assert.ok(existsSync(join(out, 'INSTALL.md')));
  assert.ok(existsSync(join(out, 'runner/src/service.ts')));
  assert.ok(existsSync(join(out, '.github/workflows/verify.yml')));
  assert.ok(!existsSync(join(out, '.git')));
  assert.ok(!existsSync(join(out, '.firebaserc')));
  assert.ok(!existsSync(join(out, '.data/.virgil-secrets')));
  if (!allowInstalledDependencies) assert.ok(!existsSync(join(out, 'node_modules')));

  const receipt = JSON.parse(readFileSync(join(out, 'virgil-source-package.json'), 'utf8'));
  assert.equal(receipt.schema, 'virgil-source-package-v2');
  assert.equal(receipt.historyIncluded, false);
  assert.match(receipt.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(receipt.sourceTree, /^[a-f0-9]{40}$/);
  assert.equal(typeof receipt.sourceDirty, 'boolean');
  assert.ok(receipt.fileCount > 400);
  assert.equal(receipt.files.length, receipt.fileCount);
  assert.ok(receipt.files.every((entry: { path?: unknown; sha256?: unknown }) =>
    typeof entry.path === 'string' && /^[a-f0-9]{64}$/.test(String(entry.sha256))));
  assert.ok(receipt.runtimeFiles.some((entry: { path: string }) => entry.path === 'runner/src/service.ts'));
}

test('the public-source package is a clean snapshot without private history or runtime state', () => {
  // The release artifact deliberately has no .git directory. When its own test
  // suite runs after download, validate that artifact in place rather than
  // asking a Git-backed packager to package it again.
  if (!existsSync(join(ROOT, '.git')) && existsSync(join(ROOT, 'virgil-source-package.json'))) {
    assertCleanSnapshot(ROOT, true);
    execFileSync(process.execPath, [join(ROOT, 'scripts/check-public-release.mjs')], {
      cwd: ROOT, stdio: 'pipe',
    });
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'virgil-source-package-'));
  const out = join(root, 'source');
  execFileSync(process.execPath, [SCRIPT, '--out', out, '--allow-dirty'], { cwd: ROOT, stdio: 'pipe' });
  assertCleanSnapshot(out);
  execFileSync(process.execPath, [join(out, 'scripts/check-public-release.mjs')], {
    cwd: out, stdio: 'pipe',
  });
  execFileSync(process.execPath, [SCRIPT, '--out', out, '--allow-dirty'], { cwd: ROOT, stdio: 'pipe' });
  assertCleanSnapshot(out);
});

test('the public-source packager refuses a repository output root', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--out', ROOT, '--allow-dirty'], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside the repository|ignored release/);
});

test('the public-source packager never replaces an unrelated existing directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'virgil-source-package-existing-'));
  writeFileSync(join(root, 'keep.txt'), 'not Virgil');
  writeFileSync(join(root, 'virgil-source-package.json'), JSON.stringify({
    schema: 'virgil-source-package-v1', historyIncluded: false, fileCount: 0, files: [],
  }));
  const result = spawnSync(process.execPath, [SCRIPT, '--out', root, '--allow-dirty'], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not an intact Virgil source package/);
  assert.equal(readFileSync(join(root, 'keep.txt'), 'utf8'), 'not Virgil');
});

test('release packaging refuses a dirty tree unless development mode is explicit', (t) => {
  if (!existsSync(join(ROOT, '.git'))) return;
  const marker = join(ROOT, 'judge-packager-dirty-marker.tmp');
  writeFileSync(marker, 'test-only');
  t.after(() => rmSync(marker, { force: true }));
  const out = join(mkdtempSync(join(tmpdir(), 'virgil-source-dirty-')), 'source');
  const result = spawnSync(process.execPath, [SCRIPT, '--out', out], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dirty tree/);
});

test('a v2 source receipt refuses replacement after packaged bytes change', () => {
  const root = mkdtempSync(join(tmpdir(), 'virgil-source-tamper-'));
  const out = join(root, 'source');
  execFileSync(process.execPath, [SCRIPT, '--out', out, '--allow-dirty'], { cwd: ROOT, stdio: 'pipe' });
  writeFileSync(join(out, 'README.md'), 'changed after packaging\n');
  const result = spawnSync(process.execPath,
    [SCRIPT, '--out', out, '--allow-dirty'], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not an intact Virgil source package/);
});

test('public CI uses the release Node and repeats every local release gate', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/verify.yml'), 'utf8');
  assert.match(workflow, /node-version:\s*24\b/);
  for (const command of ['npm run check:public', 'npm test', 'npm run check:seam', 'npm run check:d1']) {
    assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `CI does not repeat ${command}`);
  }
});
