import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cleanSectionBody, stripEmphasisMarkers, stripSourceMarkers } from '../agents/composer.js';

/**
 * Provenance is structural, not prose (SB-44).
 *
 * Found on the first real look at a session screen. The model had written its
 * source ids into the body — "…an orderBy on createdAt [14a110e6]. You had read
 * the rule before … [5186333f] — and filed it as understood." — six times on
 * one screen. Nothing asked for them: the schema carries `sourceIds` as its own
 * field, and the section already has a control that resolves those into titles
 * and links.
 */

test('a marker after a word is removed with the space that preceded it', () => {
  assert.equal(
    stripSourceMarkers('an orderBy on createdAt [14a110e6]. You had read it.'),
    'an orderBy on createdAt. You had read it.');
});

test('a marker mid-sentence does not leave a double space behind it', () => {
  assert.equal(
    stripSourceMarkers('the rule before [5186333f] — and filed it as understood.'),
    'the rule before — and filed it as understood.');
});

test('several on one line all go', () => {
  assert.equal(
    stripSourceMarkers('one [aaaaaaaa] two [bbbbbbbb] three [cccccccc]'),
    'one two three');
});

test('a marker at the end of the body goes', () => {
  assert.equal(stripSourceMarkers('the last claim [4281e80e]'), 'the last claim');
});

test('prose that merely contains brackets is left alone', () => {
  // The strip is narrow on purpose: bracketed lowercase hex, and nothing else.
  for (const kept of [
    'the array [0] is empty',
    'see figure [A] above',
    'the flag [--verbose] turns it on',
    'a range [1..10] of values',
    'where(‘status’, [‘==’], ‘active’)',
    'the set [xyz] is not hex',
  ]) {
    assert.equal(stripSourceMarkers(kept), kept, kept);
  }
});

test('a body with no markers is returned unchanged, character for character', () => {
  const body = 'Start from the failure.\n\n  where("status", "==", "active")\n\nFirestore rejected it.';
  assert.equal(stripSourceMarkers(body), body);
});

// ------------------------------------------------- emphasis (PROSE_STYLE)

test('emphasis markers the style already bans are removed', () => {
  // `PROSE_STYLE`: "no markdown of any kind". The first real session screen
  // carried three of these in one section, read as literal asterisks.
  assert.equal(
    stripEmphasisMarkers('an ordering on a *different* field'),
    'an ordering on a different field');
  assert.equal(
    stripEmphasisMarkers('it does not tell you *whether* you need one; it tells you *which* one'),
    'it does not tell you whether you need one; it tells you which one');
  assert.equal(stripEmphasisMarkers('a **bold** claim'), 'a bold claim');
});

test('multiplication is not emphasis', () => {
  // The guard that makes this safe to run over technical prose.
  for (const kept of ['2 * 3 is six', 'a * b * c', 'the glob *.ts matches', 'trailing star *']) {
    assert.equal(stripEmphasisMarkers(kept), kept, kept);
  }
});

test('both kinds of residue go in one pass, in the order the reader meets them', () => {
  assert.equal(
    cleanSectionBody('it fires on a *different* field [14a110e6]. Always.'),
    'it fires on a different field. Always.');
});

test('a clean body is returned identical, so this can run on every read', () => {
  const body = 'Start from the failure.\n\n  where("status", "==", "active")\n\nFirestore rejected it.';
  assert.equal(cleanSectionBody(body), body);
});
