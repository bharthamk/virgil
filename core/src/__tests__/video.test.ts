import { test } from 'node:test';
import assert from 'node:assert/strict';
import { momentHref } from '../domain/video.js';

/**
 *  second half: the link goes back to the moment, or it does not exist.
 *
 * "The session later opens at that moment" is the whole point of capturing a
 * timestamp at all, and a timestamp that only ever renders as text is a number
 * the learner has to scrub for by hand — which is the thing the product contract says they
 * should not have to do.
 *
 * The rule is that a link is only built where the convention is real. There is
 * no general way to seek a video from a url; each site that supports it made
 * one up. So YouTube's is implemented, and everything else answers null and
 * renders as the plain page link it already was. A `?t=` appended to a site
 * that does not read it is not a harmless extra — it is a link the learner
 * follows expecting the moment and lands at the top of, once, after which they
 * stop believing the timestamps.
 */

const at = (seconds: number) => ({ timestampSeconds: seconds, player: 'youtube' as const });

test('a YouTube watch link carries the moment, in the form YouTube reads', () => {
  assert.equal(
    momentHref('https://www.youtube.com/watch?v=abc123', at(754)),
    'https://www.youtube.com/watch?v=abc123&t=754s',
  );
});

test('the short link and the embed each carry it their own way', () => {
  assert.equal(momentHref('https://youtu.be/abc123', at(90)), 'https://youtu.be/abc123?t=90s');
  // `t` does nothing on an embed; `start` is the parameter the player reads.
  assert.equal(
    momentHref('https://www.youtube.com/embed/abc123', at(90)),
    'https://www.youtube.com/embed/abc123?start=90',
  );
});

test('a timestamp already on the link is replaced rather than added beside itself', () => {
  // Two `t` parameters is not an error anywhere; it is a url whose meaning
  // depends on which one the player reads first.
  assert.equal(
    momentHref('https://www.youtube.com/watch?v=abc123&t=30s', at(754)),
    'https://www.youtube.com/watch?v=abc123&t=754s',
  );
});

test('everything the page already carried survives', () => {
  assert.equal(
    momentHref('https://www.youtube.com/watch?v=abc123&list=PL1&index=4', at(12)),
    'https://www.youtube.com/watch?v=abc123&list=PL1&index=4&t=12s',
  );
});

test('a generic HTML5 player gets no link, because there is no convention to use', () => {
  assert.equal(momentHref('https://example.test/talks/1', { timestampSeconds: 754, player: 'html5' }), null);
});

test('a YouTube page that is not a video is not given a timestamp', () => {
  // The player is named from the hostname, so a channel page, the home page and
  // a search result all arrive here claiming to be YouTube. None of them seeks.
  for (const url of [
    'https://www.youtube.com/',
    'https://www.youtube.com/results?search_query=adk',
    'https://www.youtube.com/@someone',
    'https://www.youtube.com/watch',
  ]) {
    assert.equal(momentHref(url, at(30)), null, `${url} was given a timestamp`);
  }
});

test('a moment at zero, or one that is not a whole positive number, is no moment', () => {
  for (const seconds of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(momentHref('https://www.youtube.com/watch?v=abc123', at(seconds)), null,
      `${String(seconds)} was written into a link`);
  }
});

test('no moment at all is no link', () => {
  assert.equal(momentHref('https://www.youtube.com/watch?v=abc123', null), null);
  assert.equal(momentHref('https://www.youtube.com/watch?v=abc123', undefined), null);
});

test('a url that will not parse, or is not a link at all, gets nothing', () => {
  // Same allow-list as `safeHref` in the panel, for the same reason: this
  // string came off a page the learner visited, and it is about to be rendered
  // as an href inside the extension's own origin.
  for (const url of ['not a url', '', 'javascript:alert(1)', 'data:text/html,<b>x']) {
    assert.equal(momentHref(url, at(30)), null, `${url} was turned into a link`);
  }
});

test('a host that merely contains youtube is not YouTube', () => {
  assert.equal(momentHref('https://notyoutube.com/watch?v=abc', at(30)), null);
  assert.equal(momentHref('https://youtube.com.evil.test/watch?v=abc', at(30)), null);
});
