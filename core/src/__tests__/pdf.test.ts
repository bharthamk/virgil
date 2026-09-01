import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pdfPageHref } from '../domain/pdf.js';

/**
 * SB-11's link, and the same rule as SB-10's: build one only where the
 * convention is real.
 *
 * `#page=N` is the PDF open-parameter convention — Chrome's viewer, Preview,
 * Acrobat and every pdf.js deployment read it — so it is the one deep link in
 * this product that does not depend on a particular site. It is still applied
 * only to a pin that actually came from a PDF: on an HTML page the same
 * fragment is an ordinary anchor and would scroll somewhere arbitrary, or
 * nowhere.
 */

test('a PDF source opens at the page the learner was on', () => {
  assert.equal(
    pdfPageHref('https://example.test/papers/attention.pdf', 3),
    'https://example.test/papers/attention.pdf#page=3',
  );
});

test('a fragment the viewer already carried is replaced, not stacked', () => {
  // Two `#page=` in one url is not an error anywhere; it is a url whose meaning
  // depends on which one the viewer reads.
  assert.equal(
    pdfPageHref('https://example.test/p.pdf#page=1', 9),
    'https://example.test/p.pdf#page=9',
  );
  assert.equal(
    pdfPageHref('https://example.test/p.pdf#zoom=140', 9),
    'https://example.test/p.pdf#page=9',
  );
});

test('a query string is left exactly as it was', () => {
  // Signed urls are how papers are usually served, and a signature is computed
  // over the query. The fragment is never sent to the server, which is why the
  // page number can be added to one of these at all.
  assert.equal(
    pdfPageHref('https://example.test/p.pdf?token=abc123', 4),
    'https://example.test/p.pdf?token=abc123#page=4',
  );
});

test('a page number that is not a page number is no link', () => {
  for (const page of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
    assert.equal(pdfPageHref('https://example.test/p.pdf', page as number | null), null,
      `${String(page)} was written into a link`);
  }
});

test('a url that will not parse, or is not a link at all, gets nothing', () => {
  for (const url of ['', 'not a url', 'javascript:alert(1)', 'data:application/pdf,x']) {
    assert.equal(pdfPageHref(url, 3), null, `${url} was turned into a link`);
  }
});
