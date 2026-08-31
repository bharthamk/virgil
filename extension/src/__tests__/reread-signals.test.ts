import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchQueryFrom, searchRelatesTo } from '../reread.js';

/**
 * The corroborating half of : they re-read something, then went looking
 * for a simpler explanation of the same thing. This is the part with the
 * sharpest privacy edge in the whole product, so what it does and does not read
 * is worth holding down explicitly — it takes the query out of a search page's
 * URL, which is a navigation fact, and nothing else, ever.
 */

test('a search engine query is read from the url', () => {
  assert.equal(searchQueryFrom('https://www.google.com/search?q=adk+session+state'), 'adk session state');
  assert.equal(searchQueryFrom('https://duckduckgo.com/?q=what+is+a+session'), 'what is a session');
  assert.equal(searchQueryFrom('https://www.bing.com/search?q=session+state'), 'session state');
  assert.equal(searchQueryFrom('https://www.ecosia.org/search?q=session+state'), 'session state');
});

test('country domains are search engines too', () => {
  assert.equal(searchQueryFrom('https://www.google.co.uk/search?q=vertex+ai'), 'vertex ai');
});

test('anything that is not a search page yields nothing', () => {
  assert.equal(searchQueryFrom('https://example.test/search?q=secret'), null);
  assert.equal(searchQueryFrom('https://mail.example.test/?q=from%3Aboss'), null,
    'a q parameter on some other site is not a search query and is not read');
});

test('a site that merely contains a search engine name is not one', () => {
  assert.equal(searchQueryFrom('https://notgoogle.test/search?q=x'), null);
});

test('a search page with no query is nothing to corroborate with', () => {
  assert.equal(searchQueryFrom('https://www.google.com/'), null);
});

test('a url that will not parse is not an error, it is a no', () => {
  assert.equal(searchQueryFrom('not a url at all'), null);
  assert.equal(searchQueryFrom(''), null);
});

test('a search that overlaps the passage corroborates it', () => {
  const passage = 'Session state in ADK is held per user and per application, and persists between turns.';
  assert.equal(searchRelatesTo('adk session state explained simply', passage), true);
});

test('a search about something else does not', () => {
  const passage = 'Session state in ADK is held per user and per application.';
  assert.equal(searchRelatesTo('lunch places near me', passage), false);
});

test('one overlapping word is a coincidence, not corroboration', () => {
  const passage = 'Session state is held per user.';
  assert.equal(searchRelatesTo('session booking restaurant', passage), false);
});

test('common words and short words carry no weight', () => {
  const passage = 'How does the state of it work in a way that is for you.';
  assert.equal(searchRelatesTo('what is it for and how does that do it', passage), false,
    'stripping stopwords and short words leaves nothing to match on');
});

test('matching ignores case', () => {
  assert.equal(searchRelatesTo('SESSION STATE', 'session state is held per user'), true);
});

test('an empty query relates to nothing', () => {
  assert.equal(searchRelatesTo('', 'anything at all'), false);
});
