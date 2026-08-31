import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RECAP_LINE_CHARS, cleanRecap } from '../agents/composer.js';


test('a line is taken as written when it is already short', () => {
  assert.equal(cleanRecap('What a composite index is, and when a query needs one.'),
    'What a composite index is, and when a query needs one.');
});

test('whitespace and newlines are flattened, because this renders on one line', () => {
  assert.equal(cleanRecap('  What an index  is,\n  and why.  '), 'What an index is, and why.');
});

test('a line longer than the cap is cut at a word, never mid-word', () => {
  // The first live composition wrote about 250 characters and a character-wise
  // cap ended it on "the index definition file deploy…" — the first thing a
  // learner reads coming back days later. Truncation is honest; truncation
  // mid-word looks like a bug.
  const out = cleanRecap(`${'alpha '.repeat(60)}omega`)!;
  assert.ok(out.length <= RECAP_LINE_CHARS + 1, `line was ${out.length} characters`);
  assert.ok(out.endsWith('…'));
  assert.ok(out.slice(0, -1).endsWith('alpha'), `cut mid-word: ${JSON.stringify(out.slice(-12))}`);
});

test('a single unbroken run is still cut, rather than left over the cap', () => {
  // No word boundary to find. The cap wins: a resume is not the place to
  // discover that a model emitted four hundred characters without a space.
  const out = cleanRecap('x'.repeat(400))!;
  assert.ok(out.length <= RECAP_LINE_CHARS + 1, `line was ${out.length} characters`);
  assert.ok(out.endsWith('…'));
});

test('nothing usable is null, so the read side falls back to the heading', () => {
  // Never a blank line where a sentence belongs, and never a second call to
  // repair it.
  for (const raw of [undefined, null, 42, {}, [], '', '   ', '\n\t']) {
    assert.equal(cleanRecap(raw), null, JSON.stringify(raw));
  }
});
