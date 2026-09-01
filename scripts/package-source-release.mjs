#!/usr/bin/env node
/**
 * Build a clean public-source snapshot from the exact release-candidate tree.
 * Git history is deliberately absent: private evaluation data existed in older
 * commits, so publishing this working repository's history would undo the scrub.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const allowDirty = process.argv.includes('--allow-dirty');
const sourceRefAt = process.argv.indexOf('--source-ref');
const sourceRef = sourceRefAt >= 0 ? process.argv[sourceRefAt + 1] : null;
if (sourceRefAt >= 0 && (!sourceRef || sourceRef.startsWith('--'))) {
  throw new Error('--source-ref needs a ref');
}
if (allowDirty && sourceRef) throw new Error('--allow-dirty and --source-ref cannot be combined');
const at = process.argv.indexOf('--out');
const value = at >= 0 ? process.argv[at + 1] : null;
if (!value) throw new Error('Usage: npm run package:source -- --out PATH [--source-ref REF | --allow-dirty]');

const sourceCommit = git(['rev-parse', '--verify', 'HEAD']);
const sourceTree = git(['rev-parse', 'HEAD^{tree}']);
const dirtyLines = git(['status', '--porcelain=v1', '--untracked-files=all'])
  .split('\n').filter(Boolean);
if (dirtyLines.length && !allowDirty) {
  throw new Error('Refusing release packaging from a dirty tree; use a clean worktree/ref or --allow-dirty for an explicitly non-release snapshot');
}
if (sourceRef) {
  const requestedCommit = git(['rev-parse', '--verify', `${sourceRef}^{commit}`]);
  if (requestedCommit !== sourceCommit) {
    throw new Error(`--source-ref resolves to ${requestedCommit}, not checked-out HEAD ${sourceCommit}`);
  }
}

const out = resolve(value);
const releaseRoot = join(repo, 'release');
if (out === parse(out).root || out === repo || repo.startsWith(`${out}${sep}`)
  || (out.startsWith(`${repo}${sep}`) && !out.startsWith(`${releaseRoot}${sep}`))) {
  throw new Error('--out must be outside the repository or under its ignored release/ directory');
}

let replaceExisting = false;
if (existsSync(out)) {
  try { validateExistingPackage(out); }
  catch { throw new Error('--out already exists and is not an intact Virgil source package'); }
  replaceExisting = true;
}

execFileSync(process.execPath, [join(repo, 'scripts/check-public-release.mjs')], {
  cwd: repo, stdio: 'inherit',
});
const files = execFileSync(
  'git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: repo, encoding: 'utf8' },
).split('\0').filter(Boolean)
  .filter((file) => file !== 'virgil-source-package.json')
  .filter((file) => existsSync(join(repo, file)));

mkdirSync(dirname(out), { recursive: true });
const stage = mkdtempSync(join(dirname(out), '.virgil-source-'));
try {
  for (const file of files) {
    const target = join(stage, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(repo, file), target);
  }
  const fileReceipts = files.map((file) => fileReceipt(stage, file));
  const runtimePaths = [
    'runner/src/service.ts', 'runner/src/hosted-nightly.ts', 'extension/manifest.json',
    'deploy/Dockerfile', 'package-lock.json', 'scripts/package-extension.mjs',
  ].filter((file) => existsSync(join(stage, file)));
  const metadata = {
    schema: 'virgil-source-package-v2',
    fileCount: files.length,
    // The package has no Git directory by design. Keep the exact candidate
    // universe and its bytes in the receipt so the public-boundary checker can
    // validate the delivered artifact without pretending history is present.
    files: fileReceipts,
    baseCommit: sourceCommit,
    sourceCommit,
    sourceTree,
    sourceRef,
    sourceDirty: dirtyLines.length > 0,
    runtimeFiles: runtimePaths.map((file) => fileReceipt(stage, file)),
    historyIncluded: false,
  };
  writeFileSync(join(stage, 'virgil-source-package.json'), `${JSON.stringify(metadata, null, 2)}\n`);

  for (const forbidden of ['.git', '.firebaserc', 'node_modules', 'release']) {
    if (existsSync(join(stage, forbidden))) throw new Error(`source package carried ${forbidden}`);
  }
  if (existsSync(join(stage, '.data', '.virgil-secrets'))) {
    throw new Error('source package carried local credentials');
  }
  const manifest = JSON.parse(readFileSync(join(stage, 'virgil-source-package.json'), 'utf8'));
  if (manifest.fileCount !== files.length || manifest.files?.length !== files.length
      || manifest.historyIncluded !== false || manifest.sourceCommit !== sourceCommit
      || manifest.sourceTree !== sourceTree || manifest.sourceDirty !== (dirtyLines.length > 0)) {
    throw new Error('source package receipt is inconsistent');
  }

  if (replaceExisting) rmSync(out, { recursive: true });
  renameSync(stage, out);
} catch (error) {
  rmSync(stage, { recursive: true, force: true });
  throw error;
}

console.log(`Virgil public-source snapshot: ${out}`);
console.log(`${files.length} ${dirtyLines.length ? 'development-snapshot' : 'release-candidate'} files; Git history excluded`);
console.log(`Source: ${sourceCommit} (${sourceTree})${dirtyLines.length ? ' DIRTY' : ''}`);

/** A receipt authorises replacement only while every byte and path still agrees. */
function validateExistingPackage(root) {
  const receipt = JSON.parse(readFileSync(join(root, 'virgil-source-package.json'), 'utf8'));
  if (!['virgil-source-package-v1', 'virgil-source-package-v2'].includes(receipt.schema)
      || receipt.historyIncluded !== false
      || !Array.isArray(receipt.files) || receipt.fileCount !== receipt.files.length
      || receipt.fileCount < 1) throw new Error('bad receipt');

  const expectedFiles = new Set(['virgil-source-package.json']);
  const expectedDirectories = new Set();
  for (const entry of receipt.files) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') {
      throw new Error('bad receipt entry');
    }
    const target = resolve(root, entry.path);
    if (target === root || !target.startsWith(`${root}${sep}`) || expectedFiles.has(entry.path)) {
      throw new Error('unsafe or duplicate receipt path');
    }
    const bytes = readFileSync(target);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== entry.sha256
        || (receipt.schema === 'virgil-source-package-v2' && bytes.byteLength !== entry.bytes)) {
      throw new Error('package bytes changed');
    }
    expectedFiles.add(entry.path);
    let parent = dirname(entry.path);
    while (parent !== '.') {
      expectedDirectories.add(parent);
      parent = dirname(parent);
    }
  }

  const actualFiles = [];
  const actualDirectories = [];
  const walk = (relativeDirectory = '') => {
    for (const entry of readdirSync(join(root, relativeDirectory), { withFileTypes: true })) {
      const relativePath = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name;
      if (entry.isSymbolicLink()) throw new Error('package gained a symbolic link');
      if (entry.isDirectory()) {
        actualDirectories.push(relativePath);
        walk(relativePath);
      } else actualFiles.push(relativePath);
    }
  };
  walk();
  if (JSON.stringify(actualFiles.sort()) !== JSON.stringify([...expectedFiles].sort())
      || JSON.stringify(actualDirectories.sort()) !== JSON.stringify([...expectedDirectories].sort())) {
    throw new Error('package inventory changed');
  }
}

function git(args) {
  return execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fileReceipt(root, file) {
  const bytes = readFileSync(join(root, file));
  return { path: file, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}
