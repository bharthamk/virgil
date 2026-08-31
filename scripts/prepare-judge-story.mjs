#!/usr/bin/env node
/** Copy the checked-in, zero-model-spend judge story into an isolated scratch store. */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixture = resolve(repo, '.data/judge-story.json');
const at = process.argv.indexOf('--out');
const value = at >= 0 ? process.argv[at + 1] : null;
if (!value) throw new Error('Usage: node scripts/prepare-judge-story.mjs --out SCRATCH/store.json');
const out = resolve(value);
if (out === resolve(repo, '.data/store.json') || out === fixture) {
  throw new Error('Refusing to overwrite an included demo fixture; choose a scratch path');
}
if (existsSync(out)) throw new Error(`Refusing to overwrite existing scratch data: ${out}`);

const bytes = readFileSync(fixture);
const story = JSON.parse(bytes.toString('utf8'));
mkdirSync(dirname(out), { recursive: true });
copyFileSync(fixture, out);
console.log(JSON.stringify({
  schema: 'virgil-judge-story-copy-v1',
  source: '.data/judge-story.json',
  out,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  counts: {
    pins: story.pins.length, topics: story.topics.length, sessions: story.sessions.length,
    courses: story.courses.length, commitments: story.commitments.length,
    externals: story.externals.length, statements: story.statements.length,
  },
}, null, 2));
