import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bodyBlocks } from '../panel-core.js';

/**
 * A section body, split into the blocks it was written as.
 *
 * `PROSE_STYLE` tells the Composer to separate paragraphs with a blank line and
 * forbids markdown, so an indented run of lines is the only way it has to show
 * code — and it uses it. The whole body was one `white-space: pre-wrap` text
 * node, so on the first real session screen this:
 *
 *   where('status', '==', 'active').orderBy('createdAt', 'desc')
 *
 * rendered in the same proportional face as the sentences around it. On a
 * product whose material is largely technical that is a real cost, and it is
 * invisible in a screenshot until somebody tries to read the line.
 */

const REAL = `Start from the failure. Your query was, in effect:

  where('status', '==', 'active').orderBy('createdAt', 'desc')

Firestore rejected it because no existing index could serve both.`;

test('an indented run between paragraphs is code, and the paragraphs are not', () => {
  const blocks = bodyBlocks(REAL);
  assert.deepEqual(blocks.map((b) => b.kind), ['prose', 'code', 'prose']);
  assert.equal(blocks[1]?.text, "where('status', '==', 'active').orderBy('createdAt', 'desc')");
});

test('the marking indent is removed, and relative structure inside is kept', () => {
  const blocks = bodyBlocks('  first line\n    nested line\n  last line');
  assert.equal(blocks[0]?.kind, 'code');
  assert.equal(blocks[0]?.text, 'first line\n  nested line\nlast line');
});

test('a paragraph is prose however long it runs', () => {
  const blocks = bodyBlocks('One sentence. Another one.\n\nA second paragraph.');
  assert.deepEqual(blocks.map((b) => b.kind), ['prose', 'prose']);
  assert.equal(blocks[1]?.text, 'A second paragraph.');
});

test('a block is code only when EVERY line in it is indented', () => {
  // A paragraph whose second line happens to be indented is still a paragraph.
  // Getting this wrong would put ordinary prose in a monospace box.
  const blocks = bodyBlocks('The rule is this:\n  and this part is indented');
  assert.deepEqual(blocks.map((b) => b.kind), ['prose']);
});

test('a single indented space is not a code block', () => {
  assert.equal(bodyBlocks(' barely indented')[0]?.kind, 'prose');
});

test('empty and whitespace bodies produce nothing rather than an empty box', () => {
  for (const empty of ['', '   ', '\n\n\n']) assert.deepEqual(bodyBlocks(empty), []);
});

test('trailing blank lines do not become an empty paragraph', () => {
  assert.deepEqual(bodyBlocks('One.\n\n\n').map((b) => b.text), ['One.']);
});
