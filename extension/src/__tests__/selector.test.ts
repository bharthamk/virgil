import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FakeNode } from './dom-stub.js';
import {
  MIN_PICK_CHARS, PICKABLE, SELECT_SAVE, SELECT_STATUS, SELECTOR_HINT, SELECTOR_STYLE, blockFor, overlaps,
  selectorConfirmLabel, selectorHint, selectorStatusLine, textOf, togglePick,
} from '../selector.js';

/**
 * The Selector's rules, without a browser.
 *
 * What is asserted here is what a click means. Whether the overlay draws is a
 * browser's question and the probe's, but "which element did they mean" and
 * "what happens when they pick a thing inside a thing" are decisions, and they
 * are the ones that make this mode either useful or a way to pin a nav bar.
 */

const el = (tag: string, text = '', children: FakeNode[] = []): FakeNode =>
  new FakeNode({ tag, text, children });

const LONG = 'A composite index covers a query only when its fields match it.';
const as = (n: FakeNode): Element => n as unknown as Element;

test('a click inside a paragraph picks the paragraph', () => {
  const link = el('A', 'the docs');
  const para = el('P', '', [el('SPAN', LONG), link]);
  const body = el('BODY', '', [para]);
  assert.equal(blockFor(as(link), as(body)), as(para),
    'clicking a link picked the link, so the pin would be two words and a url');
});

test('page furniture is not pickable, and saying nothing beats pinning a nav bar', () => {
  const short = el('LI', 'Home');
  const nav = el('NAV', '', [short]);
  const body = el('BODY', '', [nav]);
  assert.equal(blockFor(as(short), as(body)), null);
  assert.ok('Home'.length < MIN_PICK_CHARS);
});

test('the walk stops at the root rather than climbing out of the page', () => {
  const orphan = el('SPAN', 'x');
  assert.equal(blockFor(as(orphan), null), null);
  assert.equal(blockFor(null, null), null);
});

test('the innermost block that carries enough text wins', () => {
  // An article containing one long paragraph: the paragraph is the unit
  // somebody pointing at the page means, not the whole article.
  const para = el('P', LONG);
  const article = el('ARTICLE', '', [para]);
  const body = el('BODY', '', [article]);
  assert.equal(blockFor(as(para), as(body)), as(para));
});

test('a headline is pickable, because a heading is a thing worth keeping', () => {
  const h = el('H2', 'Composite indexes and the order of their fields');
  const body = el('BODY', '', [h]);
  assert.equal(blockFor(as(h), as(body)), as(h));
  assert.ok(PICKABLE.includes('H2'));
});

test('picking the same thing twice drops it', () => {
  const a = el('P', LONG);
  const b = el('P', LONG);
  const one = togglePick([], as(a));
  assert.deepEqual(one, [as(a)]);
  const two = togglePick(one, as(b));
  assert.deepEqual(two, [as(a), as(b)]);
  assert.deepEqual(togglePick(two, as(a)), [as(b)], 'a second click did not drop it');
});

test('picking a container replaces what it contains, and never doubles it', () => {
  // Both pinned would teach the same words twice and weigh them twice in the
  // clustering. The newer statement of what they meant wins.
  const para = el('P', LONG);
  const article = el('ARTICLE', '', [para]);
  el('BODY', '', [article]);

  const withPara = togglePick([], as(para));
  assert.deepEqual(togglePick(withPara, as(article)), [as(article)]);
  // And the other way round: picking the inner one after the outer one.
  const withArticle = togglePick([], as(article));
  assert.deepEqual(togglePick(withArticle, as(para)), [as(para)]);
});

test('overlap is containment either way, and identity', () => {
  const para = el('P', LONG);
  const article = el('ARTICLE', '', [para]);
  const other = el('P', LONG);
  el('BODY', '', [article, other]);

  assert.equal(overlaps(as(para), as(para)), true);
  assert.equal(overlaps(as(article), as(para)), true);
  assert.equal(overlaps(as(para), as(article)), true);
  assert.equal(overlaps(as(para), as(other)), false);
});

test('the button says how many, because the count is the whole state', () => {
  assert.equal(selectorConfirmLabel(0), 'Nothing picked yet');
  assert.equal(selectorConfirmLabel(1), 'Pin this one thing');
  assert.equal(selectorConfirmLabel(4), 'Pin these 4 things');
  assert.equal(selectorConfirmLabel(0, true), 'Pin this selection');
});

test('the picker keeps its action labels together and gives narrow pages a deliberate second row', () => {
  const source = readFileSync(fileURLToPath(new URL('../../src/selector.ts', import.meta.url)), 'utf8');
  assert.match(source, /grid-template-columns:minmax\(0,1fr\) auto auto/);
  assert.match(source, /\.sb-bar button\{[^}]*white-space:nowrap/s);
  assert.match(source, /@media\(max-width:659px\)\{[^}]*grid-template-columns:minmax\(0,1fr\) auto/s);
  assert.match(source, /\.sb-lines\{grid-column:1\/-1\}/);
});

test('reduced motion keeps the picker state and removes its geometry tween', () => {
  assert.match(SELECTOR_STYLE, /\.sb-mark\{[^}]*transition:all \.06s ease/s);
  assert.match(SELECTOR_STYLE,
    /@media\(prefers-reduced-motion:reduce\)\{\.sb-mark\{transition:none\}\}/);
});

test('the picker always explains the next action', () => {
  assert.equal(selectorHint(0), SELECTOR_HINT);
  assert.equal(selectorHint(1), '1 part ready. Choose another, or pin it now.');
  assert.equal(selectorHint(4), '4 parts ready. Choose another, or pin them now.');
  assert.equal(selectorHint(0, true), 'Selection ready. Pin it, or select different words.');
});

test('the side panel says what happened after confirmation', () => {
  assert.equal(SELECT_STATUS, 'sb-select-status');
  assert.equal(selectorStatusLine({ state: 'saving', count: 1, queued: 0 }), 'Saving your selection…');
  assert.equal(selectorStatusLine({ state: 'saved', count: 1, queued: 0 }), 'Pinned. It is on your board.');
  assert.equal(selectorStatusLine({ state: 'saved', count: 1, queued: 1 }),
    'Pinned. Saved in this browser and waiting to sync.');
  assert.equal(selectorStatusLine({ state: 'saved', count: 3, queued: 1 }),
    'Pinned 3 parts. 1 is waiting to sync.');
  assert.equal(selectorStatusLine({ state: 'saved', count: 0, queued: 0 }),
    'Nothing was pinned. Try selecting a different part.');
  assert.equal(selectorStatusLine({ state: 'failed', count: 0, queued: 0 }),
    'That pin did not finish. Try again.');
});

test('text is what a reader sees, whitespace and all collapsed', () => {
  assert.equal(textOf(as(el('P', '  a\n\n  b  '))), 'a b');
  const withHiddenCss = el('DIV', 'Visible words .mw-parser-output{display:block}');
  Object.defineProperty(withHiddenCss, 'innerText', {
    configurable: true, value: 'Visible words',
  });
  assert.equal(textOf(as(withHiddenCss)), 'Visible words');
  assert.equal(textOf(null), '');
});

test('the message this mode sends is the one the worker listens for', () => {
  assert.equal(SELECT_SAVE, 'sb-select-save');
});
