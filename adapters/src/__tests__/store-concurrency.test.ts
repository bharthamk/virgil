import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../json-store.js';
import type { Pin } from '@sb/core';

/**
 * The forage stage writes at concurrency 3 against one store. An earlier
 * implementation set its `loaded` flag *after* awaiting the file read, so every
 * concurrent caller saw it as false, each built its own db object, and all but
 * one wrote into objects that were then orphaned.
 *
 * Measured before the fix: 60 concurrent writes to a cold store persisted 1.
 */
const store = () => new JsonStore(join(mkdtempSync(join(tmpdir(), 'sb-c-')), 'db.json'));

const pin = (i: number): Pin => ({
  id: `p${i}`, type: 'interest',
  envelope: {
    selection: 'x'.repeat(400), parts: [], surroundingText: 'y'.repeat(1200),
    headingPath: [], pageTitle: `t${i}`, url: 'https://e.com',
    canonicalUrl: null, siteName: null, contentLanguage: 'en', media: null,
  },
  note: null, capturedAt: '2026-08-01T00:00:00Z',
  fromSuggestion: false, enrichment: null, topicId: null,
});

test('concurrent writes to a cold store all persist', async () => {
  const s = store();
  await Promise.all(Array.from({ length: 40 }, (_, i) => s.putPin(pin(i))));
  assert.equal((await s.listPins()).length, 40, 'no pin the learner saved may be lost');
});

test('what is in memory is what is on disk', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'sb-c2-')), 'db.json');
  const s = new JsonStore(path);
  await Promise.all(Array.from({ length: 40 }, (_, i) => s.putPin(pin(i))));
  const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { pins: Pin[] };
  assert.equal(onDisk.pins.length, 40, 'concurrent writeFile must not interleave');
});

test('a fresh reader sees everything a concurrent writer wrote', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'sb-c3-')), 'db.json');
  const writer = new JsonStore(path);
  await Promise.all(Array.from({ length: 25 }, (_, i) => writer.putPin(pin(i))));
  assert.equal((await new JsonStore(path).listPins()).length, 25);
});
