import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capturePermitted, hostOf, isDomainExcluded, isPaused, mayObserve } from '../prefs.js';
import { buildPinBody, captureRefusal, finalToastText, initialToastText } from '../pin-body.js';
import type { CapturedEnvelope } from '../capture.js';

/**
 * The two decisions either side of a capture: whether to take it at all
 * , and what the toast says about it (, , ).
 */

const NOW = Date.parse('2026-08-19T21:00:00.000Z');
const fresh = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ excludedDomains: [], rejectedOrigins: {}, pausedUntil: null, writtenAt: NOW, ...over });

// -------------------------------------------------------- the pure predicates

test('a pause that has not expired is a pause', () => {
  assert.equal(isPaused({ pausedUntil: '2026-08-19T22:00:00.000Z' }, NOW), true);
});

test('a pause that has run out stops nothing', () => {
  assert.equal(isPaused({ pausedUntil: '2026-08-19T20:59:59.000Z' }, NOW), false);
});

test('a pause timestamp that will not parse is not a pause', () => {
  // This one predicate fails towards collecting on purpose: a malformed
  // timestamp must not be able to jam the detector off forever by accident. The
  // decision that a *missing or stale copy* of the prefs stops everything is
  // made one level up, in `mayObserve`.
  assert.equal(isPaused({ pausedUntil: 'sometime next week' }, NOW), false);
  assert.equal(isPaused(undefined, NOW), false);
});

test('an excluded domain covers its subdomains', () => {
  assert.equal(isDomainExcluded('bank.test', ['bank.test']), true);
  assert.equal(isDomainExcluded('secure.bank.test', ['bank.test']), true);
});

test('an excluded domain does not catch a lookalike', () => {
  assert.equal(isDomainExcluded('notbank.test', ['bank.test']), false,
    'suffix matching has to stop at the dot or it excludes strangers');
  assert.equal(isDomainExcluded('bank.test.example.com', ['bank.test']), false);
});

test('a url that will not parse has no host', () => {
  assert.equal(hostOf('not a url'), '');
});

// ------------------------------------- what pause and exclusions do NOT gate

test('a deliberate pin on an off-limits site still lands, and the detector still does not watch it ( the learner-confirmation contract)', () => {
  // The contract, stated where it can be read: the exclusion list says "do not
  // watch me here", and pressing Alt+P is not something being done to the
  // learner. A gesture on a page they chose outranks a list they set once.
  const prefs = fresh({ excludedDomains: ['bank.test'] });
  assert.equal(capturePermitted('https://secure.bank.test/accounts'), true);
  assert.equal(mayObserve(prefs, 'https://secure.bank.test/accounts', NOW), false,
    'the background observation is the thing the list governs, and it is off');
});

test('a pause silences the detector and not the pin the learner just asked for ()', () => {
  const prefs = fresh({ pausedUntil: '2026-08-19T22:00:00.000Z' });
  assert.equal(mayObserve(prefs, 'https://example.test/x', NOW), false);
  assert.equal(capturePermitted('https://example.test/x'), true,
    'pause means stop watching me, not refuse what I hand you');
});

test('a tab with no url is still never captured from', () => {
  // Not a policy — a page we cannot identify is a pin we cannot attribute.
  assert.equal(capturePermitted(undefined), false);
  assert.equal(capturePermitted(''), false);
});

test('a page no extension may script is refused here rather than by the injection failing', () => {
  for (const url of [
    'chrome://settings',
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/panel.html',
    'devtools://devtools/bundled/inspector.html',
    'about:blank',
    'edge://extensions',
    'view-source:https://example.test/',
    'javascript:alert(1)',
    'data:text/html,<b>hello',
  ]) {
    assert.equal(capturePermitted(url), false, `${url} was offered as a page to pin from`);
  }
});

test('the Web Store is refused too, because Chrome refuses it whatever we think', () => {
  // A hard-coded carve-out in the browser, not a policy of ours: no extension
  // is scripted onto the store that installs it. Named so the refusal reads as
  // a fact rather than as a page that happened not to work.
  assert.equal(capturePermitted('https://chromewebstore.google.com/detail/x'), false);
  assert.equal(capturePermitted('https://chrome.google.com/webstore/detail/x'), false);
  assert.equal(capturePermitted('https://chrome.google.com/anything-else'), true,
    'the carve-out is the store, not the host');
});

test('an ordinary page, and a local file, are the two answers that are not obvious', () => {
  assert.equal(capturePermitted('https://example.test/adk/sessions'), true);
  assert.equal(capturePermitted('http://localhost:3000/notes'), true);
  // `file://` is refused, and it is the one refusal that costs something real:
  // a PDF opened from disk  is a file url. Scripting one needs "Allow
  // access to file URLs", which is off by default and which this extension does
  // not ask for, so the honest answer is that we cannot read it — rather than
  // an injection that fails on some machines and not others.
  assert.equal(capturePermitted('file:///private/example/paper.pdf'), false);
});

// ---------------------------------------------------------------------- toast

test('the toast says which kind of pin it was before the service answers ()', () => {
  assert.equal(initialToastText('interest'), 'Pinned, working it out…');
  assert.equal(initialToastText('struggle'), 'Noted, working it out…');
});

test('the label lands in the toast, and a struggle is answered differently', () => {
  const named = { ok: true, label: 'ADK session state' };
  assert.equal(finalToastText('interest', named), 'Pinned: ADK session state');
  assert.equal(
    finalToastText('struggle', named),
    'Noted: ADK session state. I’ll start from the bottom on this one.',
  );
});

test('a pin that did not reach the service is a promise rather than an error ()', () => {
  const offline = 'Pinned. I’ll sort it once I’m back online';
  assert.equal(finalToastText('interest', { ok: false, label: null }), offline);
  assert.equal(finalToastText('struggle', { ok: false, label: null }), offline);
});

test('a pin the service took but did not name is not told it is waiting to sync', () => {
  // The middle outcome, which the copy did not have: a 200 with no label in it
  // said "I’ll sort it once I’m back online" about a pin that was already
  // sorted. The drain has distinguished the two since it stopped resending
  // label-less successes forever; the toast now does too.
  assert.equal(finalToastText('interest', { ok: true, label: null }), 'Pinned');
  assert.equal(finalToastText('interest', { ok: true, label: '' }), 'Pinned',
    'an empty label is no label');
  assert.equal(finalToastText('struggle', { ok: true, label: null }),
    'Noted. I’ll start from the bottom on this one.');
});

// --------------------------------------------------------------------- envelope

const envelope: CapturedEnvelope = {
  selection: 'Session state is held per user.',
  parts: [{ role: 'passage', text: 'Session state is held per user. It persists between turns.' }],
  surroundingText: 'Session state is held per user. It persists between turns.',
  headingPath: ['ADK', 'Sessions'],
  pageTitle: 'ADK — Sessions',
  url: 'https://example.test/adk/sessions',
  canonicalUrl: 'https://example.test/adk/sessions',
  siteName: 'Example Docs',
  contentLanguage: 'en',
  videoMoment: null,
  documentKind: 'html',
  pdfPage: null,
};

test('the posted body carries the envelope through untouched', () => {
  const body = buildPinBody('struggle', envelope, '2026-08-19T21:00:00.000Z');
  assert.equal(body.type, 'struggle');
  assert.equal(body.capturedAt, '2026-08-19T21:00:00.000Z');
  for (const [key, value] of Object.entries(envelope)) {
    assert.deepEqual(body.envelope[key as keyof CapturedEnvelope], value, `${key} survived`);
  }
  assert.equal(body.envelope.contentLanguage, 'en', 'capture-envelope constraint: the re-fetch has nothing to check against without it');
});

test('building a body does not mutate the envelope it was given', () => {
  const original = { ...envelope };
  buildPinBody('interest', envelope, 'when');
  assert.deepEqual(envelope, original);
});

// -------------------------------------------------- the PDF that refuses

/**
 * The one refusal in the capture path, and why it is only one.
 *
 * Chrome's built-in PDF viewer hands a content script the document's identity
 * and nothing else: the text layer, the selection and the page indicator all
 * live in a frame belonging to another extension. A pin made there would carry
 * a title, a url and no material at all — a pin that looks like a pin on the
 * board, produces nothing overnight, and tells the learner nothing went wrong.
 *
 * So it is refused out loud. Narrowly: an HTML page with nothing in it is a
 * whole-page pin of a thin page, which  says is legitimate and which the
 * Forager can re-fetch. A PDF we cannot read now is a PDF nothing can read
 * later either.
 */

const pdf = (over: Partial<CapturedEnvelope> = {}): CapturedEnvelope => ({
  ...envelope,
  documentKind: 'pdf',
  selection: null,
  parts: [],
  surroundingText: '',
  pageTitle: 'attention-is-all-you-need.pdf',
  url: 'https://example.test/papers/attention.pdf',
  ...over,
});

test('a PDF that hands over no text at all is refused, and says so', () => {
  assert.equal(captureRefusal(pdf()), 'Can’t pin this PDF. Chrome won’t let me read it.');
});

test('a PDF whose viewer does give us the passage is pinned like anything else', () => {
  assert.equal(captureRefusal(pdf({ selection: 'Attention weights are computed' })), null);
  assert.equal(captureRefusal(pdf({ surroundingText: 'A paragraph of the paper, long enough to teach from.' })), null);
});

test('a PDF that hands over a scrap of chrome rather than a passage is still a refusal', () => {
  // The viewer's own furniture — a filename, a page count, a toolbar label —
  // is text, and it is not the paper. A pin built from it would be worse than
  // the refusal because it would look like it had worked.
  assert.equal(captureRefusal(pdf({ surroundingText: '1 / 12' })), 'Can’t pin this PDF. Chrome won’t let me read it.');
  assert.equal(captureRefusal(pdf({ surroundingText: '   \n  ' })), 'Can’t pin this PDF. Chrome won’t let me read it.');
});

test('an ordinary page is never refused, however thin it is', () => {
  // whole-page pins are legitimate and common, and the Forager re-fetches
  // the page overnight. A thin HTML pin is a pin that gets better later; the
  // PDF is the one that cannot.
  assert.equal(captureRefusal({ ...envelope, selection: null, surroundingText: '', parts: [] }), null);
});
