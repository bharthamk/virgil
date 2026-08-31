import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capture, type CapturedEnvelope } from '../capture.js';
import { acrossExecuteScriptBoundary, installPage, node, type FakeNode } from './dom-stub.js';

/**
 * The capture envelope is the only thing that survives a gated page (SB-46) and
 * the only record of what language the learner actually read (D9). It is also
 * injected into the page, which is the constraint that shapes the whole file:
 * it must be able to run with nothing but globals.
 *
 * Every test here goes through the boundary rather than calling `capture()`
 * directly, because calling it directly is the one way of running it that the
 * product never does.
 */

const injected = (): CapturedEnvelope => acrossExecuteScriptBoundary(capture)();
const injectedWith = (recoverMenuSelection: boolean): CapturedEnvelope =>
  (acrossExecuteScriptBoundary(capture) as unknown as (recover: boolean) => CapturedEnvelope)(recoverMenuSelection);
const injectedPicker = (visibleSelection: string): CapturedEnvelope =>
  (acrossExecuteScriptBoundary(capture) as unknown as
    (recover: boolean, visible: string) => CapturedEnvelope)(false, visibleSelection);

const para = (text: string): FakeNode => node({ tag: 'p', text });

test('capture survives the executeScript boundary — no closure, no module scope', () => {
  // D3, generalised. Chrome serialises the function and evaluates the source in
  // the page. Anything it reaches for outside its own body is gone by then, and
  // the failure is a bare ReferenceError on the user's very first pin.
  const undo = installPage({ body: node({ tag: 'body', children: [para('a paragraph')] }) });
  try {
    assert.doesNotThrow(() => injected(),
      'capture reached for something that does not exist on the other side of the injection');
  } finally { undo(); }
});

test('the exported capture and its serialized browser copy agree on one ordinary page', () => {
  const body = node({
    tag: 'body',
    children: [node({ tag: 'article', children: [para('An ordinary readable paragraph long enough to become captured material.')] })],
  });
  const undo = installPage({ body, title: 'Ordinary page', url: 'https://example.test/ordinary' });
  try {
    assert.deepEqual(capture(), injected());
  } finally { undo(); }
});

test('a whole-page pin is a first-class case, not an error (SB-07)', () => {
  const body = node({
    tag: 'body',
    children: [node({ tag: 'article', children: [para('The readable part of the page.')] })],
  });
  const undo = installPage({ body, title: 'A page', url: 'https://example.test/x' });
  try {
    const env = injected();
    assert.equal(env.selection, null);
    assert.deepEqual(env.headingPath, [], 'no selection means no heading path to walk');
    assert.equal(env.surroundingText, 'The readable part of the page.');
    assert.equal(env.pageTitle, 'A page');
    assert.equal(env.url, 'https://example.test/x');
  } finally { undo(); }
});

test('a whole-page pin prefers the article over the whole body', () => {
  const body = node({
    tag: 'body',
    children: [
      node({ tag: 'nav', text: 'Home About Contact' }),
      node({ tag: 'article', children: [para('Only this is the reading.')] }),
    ],
  });
  const undo = installPage({ body });
  try {
    assert.equal(injected().surroundingText, 'Only this is the reading.');
  } finally { undo(); }
});

test('whitespace is collapsed and the page text is capped at 8000 characters', () => {
  const body = node({ tag: 'body', children: [node({ tag: 'main', text: `  a\n\n   b ${'x'.repeat(9000)}  ` })] });
  const undo = installPage({ body });
  try {
    const env = injected();
    assert.equal(env.surroundingText.length, 8000);
    assert.ok(env.surroundingText.startsWith('a b x'), 'runs of whitespace collapse to one space');
  } finally { undo(); }
});

test('a selection is kept verbatim and its surroundings come from the block it sits in', () => {
  const selected = para('The selected sentence.');
  const body = node({
    tag: 'body',
    children: [node({ tag: 'div', children: [selected, para(' And the one after it.')] })],
  });
  const undo = installPage({
    body,
    selection: { text: 'The selected sentence.', startContainer: selected, commonAncestorContainer: selected },
  });
  try {
    const env = injected();
    assert.equal(env.selection, 'The selected sentence.');
    assert.equal(env.surroundingText, 'The selected sentence. And the one after it.',
      'the surrounding text is the parent of the selected block, not just the block');
  } finally { undo(); }
});

test('a picker capture keeps reader-visible text instead of hidden page CSS', () => {
  const selected = node({
    tag: 'div',
    text: 'Association football club .mw-parser-output .hatnote{font-style:italic}',
  });
  Object.defineProperty(selected, 'innerText', {
    configurable: true, value: 'Association football club in Ipswich, England.',
  });
  const body = node({ tag: 'body', children: [selected] });
  const undo = installPage({
    body,
    selection: {
      text: 'Association football club .mw-parser-output .hatnote{font-style:italic}',
      startContainer: selected,
      commonAncestorContainer: selected,
    },
  });
  try {
    const env = injectedPicker('Association football club in Ipswich, England.');
    assert.equal(env.selection, 'Association football club in Ipswich, England.');
    assert.doesNotMatch(env.selection ?? '', /mw-parser-output|font-style/);
  } finally { undo(); }
});

test('right-click recovery is conditional, visible, and consumed once', () => {
  const selected = para('The full passage the learner highlighted.');
  const body = node({ tag: 'body', children: [node({ tag: 'div', children: [selected] })] });
  const undo = installPage({
    body,
    selection: { text: 'passage', startContainer: selected, commonAncestorContainer: selected },
  });
  const scope = globalThis as unknown as Record<string, unknown>;
  const previous = scope['__sbSelectionMemory'];
  try {
    scope['__sbSelectionMemory'] = {
      atMenu: {
        text: 'The full passage the learner highlighted.',
        range: { startContainer: selected, commonAncestorContainer: selected },
        at: Date.now(), collapsedAtMenu: true, afterMenuText: 'passage',
      },
    };
    const recovered = injectedWith(true);
    assert.equal(recovered.selection, 'The full passage the learner highlighted.');
    assert.equal(recovered.selectionRecovered, true);
    assert.equal((scope['__sbSelectionMemory'] as { atMenu: unknown }).atMenu, null,
      'a later gesture could inherit this workaround');

    scope['__sbSelectionMemory'] = {
      atMenu: {
        text: 'The full passage the learner highlighted.',
        range: { startContainer: selected, commonAncestorContainer: selected },
        at: Date.now(), collapsedAtMenu: true, afterMenuText: 'passage',
      },
    };
    const freshGesture = injectedWith(false);
    assert.equal(freshGesture.selection, 'passage', 'the Selector or hotkey consumed a right-click snapshot');
    assert.equal(freshGesture.selectionRecovered, false);
  } finally {
    scope['__sbSelectionMemory'] = previous;
    undo();
  }
});

test('surrounding text is capped at 4000 characters', () => {
  const selected = para('short selection');
  const body = node({
    tag: 'body',
    children: [node({ tag: 'div', children: [selected, para('y'.repeat(5000))] })],
  });
  const undo = installPage({ body, selection: { text: 'short selection', startContainer: selected } });
  try {
    assert.equal(injected().surroundingText.length, 4000);
  } finally { undo(); }
});

test('a whitespace-only selection is no selection', () => {
  const body = node({ tag: 'body', children: [node({ tag: 'main', text: 'page text' })] });
  const undo = installPage({ body, selection: { text: '   \n  ' } });
  try {
    const env = injected();
    assert.equal(env.selection, null);
    assert.equal(env.surroundingText, 'page text', 'it falls back to the whole-page path');
  } finally { undo(); }
});

// ----------------------------------------------------------------------- parts

/**
 * `parts` is the field the extension never emitted, and the one the Clusterer
 * and the Analyst dereference without a guard. A board built by real pinning
 * produced no topics at all because of it, so what is asserted here is not
 * cosmetic: it is the difference between the engine being reachable from the
 * front door and not.
 */

const LONG = 'Session state is held per user and per app, and it persists between turns.';
const ALSO = 'The runner is what actually reads it back on the next invocation of the agent.';

test('a whole-page pin carries the readable blocks, in document order (SB-06)', () => {
  const body = node({
    tag: 'body',
    children: [node({ tag: 'article', children: [para(LONG), para(ALSO)] })],
  });
  const undo = installPage({ body });
  try {
    assert.deepEqual(injected().parts, [
      { role: 'passage', text: LONG },
      { role: 'passage', text: ALSO },
    ]);
  } finally { undo(); }
});

test('the parts of a selection pin are the blocks around it, matching the surrounding text', () => {
  const selected = para(LONG);
  const body = node({
    tag: 'body',
    children: [node({ tag: 'div', children: [selected, para(ALSO)] })],
  });
  const undo = installPage({ body, selection: { text: LONG, startContainer: selected, commonAncestorContainer: selected } });
  try {
    const env = injected();
    assert.deepEqual(env.parts.map((p) => p.text), [LONG, ALSO]);
    // Nothing new is collected — this is the same text the envelope already
    // carried, with the page's own block boundaries kept rather than flattened.
    assert.equal(env.surroundingText, `${LONG}${ALSO}`);
  } finally { undo(); }
});

test('every part capture emits is a passage, and never a role it cannot know', () => {
  // `my-answer` and `correct-answer` are real roles the Analyst reasons about a
  // delta between (SB-14). Nothing on a page says which half was the learner's,
  // so guessing would be fabricating the evidence. Asserted so that a future
  // multi-part capture affordance is a decision rather than a drift.
  const body = node({ tag: 'body', children: [node({ tag: 'main', children: [para(LONG)] })] });
  const undo = installPage({ body });
  try {
    assert.deepEqual([...new Set(injected().parts.map((p) => p.role))], ['passage']);
  } finally { undo(); }
});

test('a container whose children are blocks is not emitted alongside them', () => {
  // Innermost wins. Emitting the wrapper as well would say the same thing twice
  // and the Clusterer would weigh it twice.
  const body = node({
    tag: 'body',
    children: [node({ tag: 'main', children: [node({ tag: 'blockquote', children: [para(LONG)] })] })],
  });
  const undo = installPage({ body });
  try {
    assert.deepEqual(injected().parts, [{ role: 'passage', text: LONG }]);
  } finally { undo(); }
});

test('navigation-sized scraps are not parts', () => {
  const body = node({
    tag: 'body',
    children: [node({ tag: 'main', children: [para('Home'), para('About'), para(LONG)] })],
  });
  const undo = installPage({ body });
  try {
    assert.deepEqual(injected().parts.map((p) => p.text), [LONG]);
  } finally { undo(); }
});

test('a page with nothing block-shaped on it yields no parts rather than a guess', () => {
  const body = node({ tag: 'body', children: [node({ tag: 'main', text: 'loose text with no blocks in it at all' })] });
  const undo = installPage({ body });
  try {
    assert.deepEqual(injected().parts, [], 'and the consumers must survive that — they do');
  } finally { undo(); }
});

test('parts are capped in number and in length, like every other envelope field', () => {
  const long = 'z'.repeat(900);
  const body = node({
    tag: 'body',
    children: [node({ tag: 'main', children: Array.from({ length: 10 }, () => para(long)) })],
  });
  const undo = installPage({ body });
  try {
    const parts = injected().parts;
    assert.equal(parts.length, 6, 'six blocks is plenty of structure and bounds what the Clusterer reads');
    assert.equal(parts[0]!.text.length, 500);
  } finally { undo(); }
});

// ---------------------------------------------------------------- heading path

test('a selection under headings carries the path down to it (SB-06)', () => {
  const selected = para('Session state is held per user, per app.');
  const body = node({
    tag: 'body',
    children: [
      node({ tag: 'h1', text: 'ADK' }),
      node({
        tag: 'div',
        children: [node({ tag: 'h2', text: 'Sessions' }), node({ tag: 'h3', text: 'State' }), selected],
      }),
    ],
  });
  const undo = installPage({ body, selection: { text: 'Session state', startContainer: selected } });
  try {
    assert.deepEqual(injected().headingPath, ['ADK', 'Sessions', 'State']);
  } finally { undo(); }
});

test('a selection with no headings above it gets an empty path, not a guess', () => {
  const selected = para('A page with no structure at all.');
  const body = node({ tag: 'body', children: [node({ tag: 'div', children: [selected] })] });
  const undo = installPage({ body, selection: { text: 'A page', startContainer: selected } });
  try {
    assert.deepEqual(injected().headingPath, []);
  } finally { undo(); }
});

test('a heading no shallower than one already taken is not added', () => {
  // Two H2s before the passage: the second one is what it sits under, and the
  // first is a different section entirely.
  const selected = para('the passage');
  const body = node({
    tag: 'body',
    children: [
      node({ tag: 'h1', text: 'Guide' }),
      node({ tag: 'h2', text: 'Earlier section' }),
      node({ tag: 'h2', text: 'This section' }),
      selected,
    ],
  });
  const undo = installPage({ body, selection: { text: 'the passage', startContainer: selected } });
  try {
    assert.deepEqual(injected().headingPath, ['Guide', 'This section']);
  } finally { undo(); }
});

test('an empty heading is dropped rather than leaving a hole in the path', () => {
  const selected = para('the passage');
  const body = node({
    tag: 'body',
    children: [node({ tag: 'h1', text: '   ' }), node({ tag: 'h2', text: 'Real heading' }), selected],
  });
  const undo = installPage({ body, selection: { text: 'the passage', startContainer: selected } });
  try {
    assert.deepEqual(injected().headingPath, ['Real heading']);
  } finally { undo(); }
});

// ------------------------------------------------------------------- metadata

test('the content language is captured, because the re-fetch depends on it (D9)', () => {
  const body = node({ tag: 'body', children: [para('Contenido en español.')] });
  const undo = installPage({ body, lang: 'es' });
  try {
    assert.equal(injected().contentLanguage, 'es',
      'Forager re-fetches hours later and has to be able to tell it got the same language back');
  } finally { undo(); }
});

test('a page that declares no language records null rather than a guess', () => {
  const body = node({ tag: 'body', children: [para('No lang attribute here.')] });
  const undo = installPage({ body, lang: '' });
  try {
    assert.equal(injected().contentLanguage, null);
  } finally { undo(); }
});

test('the canonical url is taken when the page offers one', () => {
  const body = node({ tag: 'body', children: [para('text')] });
  const undo = installPage({
    body,
    url: 'https://example.test/page?utm_source=x',
    head: [node({ tag: 'link', attrs: { rel: 'canonical', href: 'https://example.test/page' } })],
  });
  try {
    const env = injected();
    assert.equal(env.canonicalUrl, 'https://example.test/page');
    assert.equal(env.url, 'https://example.test/page?utm_source=x', 'the url actually visited is kept too');
  } finally { undo(); }
});

test('no canonical link is null, not the url over again', () => {
  const undo = installPage({ body: node({ tag: 'body', children: [para('text')] }) });
  try {
    assert.equal(injected().canonicalUrl, null);
  } finally { undo(); }
});

test('the site name comes from og:site_name, and falls back to the hostname', () => {
  const body = node({ tag: 'body', children: [para('text')] });
  const named = installPage({
    body,
    hostname: 'docs.example.test',
    head: [node({ tag: 'meta', attrs: { property: 'og:site_name', content: 'Example Docs' } })],
  });
  try {
    assert.equal(injected().siteName, 'Example Docs');
  } finally { named(); }

  const bare = installPage({ body, hostname: 'docs.example.test' });
  try {
    assert.equal(injected().siteName, 'docs.example.test');
  } finally { bare(); }
});

// ------------------------------------------------ SB-10: a moment in a video

/**
 * "Twelve minutes into a conference talk, the speaker moves fast."
 *
 * The whole of what this adds is a number: where the playhead was when the
 * learner reached for the hotkey. It is captured here rather than reconstructed
 * later for the obvious reason — by the nightly the tab is closed — and it is
 * the only part of the story's step 2 that a content script can honestly get.
 *
 * Everything below is a way of not inventing one. A page with a muted looping
 * hero video is not a page somebody is watching, and a pin that claimed a
 * moment on it would send the learner back to second fourteen of a background
 * animation with a confident "at 0:14" beside it.
 */

const video = (props: Record<string, unknown>): FakeNode =>
  node({ tag: 'video', props: { currentTime: 0, muted: false, loop: false, clientWidth: 640, clientHeight: 360, ...props } });

test('a video the learner was watching is pinned at the moment they were at', () => {
  const body = node({ tag: 'body', children: [video({ currentTime: 754.6 }), para('the talk description')] });
  const undo = installPage({ body, url: 'https://example.test/talks/1', hostname: 'example.test' });
  try {
    assert.deepEqual(injected().videoMoment, { timestampSeconds: 754, player: 'html5' },
      'whole seconds: a link cannot carry a fraction and no player seeks to one');
  } finally { undo(); }
});

test('YouTube is named, because naming the player is what decides if a link can carry the time', () => {
  const body = node({ tag: 'body', children: [video({ currentTime: 12 })] });
  for (const hostname of ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be']) {
    const undo = installPage({ body, hostname, url: `https://${hostname}/watch?v=abc` });
    try {
      assert.equal(injected().videoMoment?.player, 'youtube', `${hostname} was not recognised`);
    } finally { undo(); }
  }
});

test('a lookalike hostname is not YouTube', () => {
  // `notyoutube.com` and `youtube.com.evil.test` both contain the string. The
  // cost of getting this wrong is a link built to a convention the site does
  // not have, which is a link to the top of the wrong video.
  const body = node({ tag: 'body', children: [video({ currentTime: 12 })] });
  for (const hostname of ['notyoutube.com', 'youtube.com.evil.test', 'myyoutu.be']) {
    const undo = installPage({ body, hostname, url: `https://${hostname}/watch?v=abc` });
    try {
      assert.equal(injected().videoMoment?.player, 'html5', `${hostname} was taken for YouTube`);
    } finally { undo(); }
  }
});

test('a video that has not started is not a moment', () => {
  // Nothing has been watched, so there is nothing to come back to. Fail closed:
  // no moment at all rather than a confident "at 0:00".
  const body = node({ tag: 'body', children: [video({ currentTime: 0 })] });
  const undo = installPage({ body });
  try {
    assert.equal(injected().videoMoment, null);
  } finally { undo(); }
});

test('a decorative background loop is not what the learner meant', () => {
  // Muted and looping is the signature of a hero animation, not of something
  // being watched. It is also the video most likely to be playing on a page
  // whose text is the actual pin.
  const body = node({ tag: 'body', children: [video({ currentTime: 3.2, muted: true, loop: true })] });
  const undo = installPage({ body });
  try {
    assert.equal(injected().videoMoment, null);
  } finally { undo(); }
});

test('a player with no size on screen is not the one being watched', () => {
  const body = node({ tag: 'body', children: [video({ currentTime: 40, clientWidth: 0, clientHeight: 0 })] });
  const undo = installPage({ body });
  try {
    assert.equal(injected().videoMoment, null);
  } finally { undo(); }
});

test('the biggest player wins when a page has several', () => {
  const body = node({
    tag: 'body',
    children: [
      video({ currentTime: 8, clientWidth: 160, clientHeight: 90 }),
      video({ currentTime: 754, clientWidth: 1280, clientHeight: 720 }),
    ],
  });
  const undo = installPage({ body });
  try {
    assert.equal(injected().videoMoment?.timestampSeconds, 754,
      'the sidebar preview is not the talk');
  } finally { undo(); }
});

test('a page with no video says so rather than leaving the field out', () => {
  const undo = installPage({ body: node({ tag: 'body', children: [para('ordinary reading')] }) });
  try {
    assert.equal(injected().videoMoment, null);
  } finally { undo(); }
});

test('a player whose time is not a number is not a moment', () => {
  // A live stream, a player mid-teardown, a element the site has stubbed. Any
  // of them can hand back NaN or Infinity, and both survive arithmetic silently.
  for (const currentTime of [Number.NaN, Number.POSITIVE_INFINITY, -4, 'twelve']) {
    const undo = installPage({ body: node({ tag: 'body', children: [video({ currentTime })] }) });
    try {
      assert.equal(injected().videoMoment, null, `${String(currentTime)} was read as a timestamp`);
    } finally { undo(); }
  }
});

// ---------------------------------------------------- SB-11: pinning from a PDF


test('a PDF tab is named as one, by what the document says it is', () => {
  const undo = installPage({
    body: node({ tag: 'body', children: [node({ tag: 'embed', attrs: { type: 'application/pdf' } })] }),
    contentType: 'application/pdf',
    title: 'attention-is-all-you-need.pdf',
    url: 'https://example.test/papers/attention.pdf',
  });
  try {
    const env = injected();
    assert.equal(env.documentKind, 'pdf');
    assert.equal(env.pageTitle, 'attention-is-all-you-need.pdf', 'the document identity is what does survive');
    assert.equal(env.url, 'https://example.test/papers/attention.pdf');
  } finally { undo(); }
});

test('a viewer that does not declare its type is recognised by what it embeds', () => {
  // The content type is the reliable signal and it is not the only one: a page
  // that puts the plugin in an `<embed>` is showing a PDF whatever it claims.
  const undo = installPage({
    body: node({ tag: 'body', children: [node({ tag: 'embed', attrs: { type: 'application/pdf' } })] }),
  });
  try {
    assert.equal(injected().documentKind, 'pdf');
  } finally { undo(); }
});

test('an ordinary page is not a PDF, and says so rather than leaving it out', () => {
  const undo = installPage({ body: node({ tag: 'body', children: [para('ordinary reading')] }) });
  try {
    const env = injected();
    assert.equal(env.documentKind, 'html');
    assert.equal(env.pdfPage, null);
  } finally { undo(); }
});

test('the page number is taken where the viewer puts it, and nowhere else', () => {
  // Chrome's viewer accepts `#page=N` on the way in and does not write one as
  // you scroll, so this is populated for a paper opened at a page and null for
  // one scrolled to it. Reporting the first page as though it were the reader's
  // position would be worse than admitting we do not know.
  const body = node({ tag: 'body', children: [node({ tag: 'embed', attrs: { type: 'application/pdf' } })] });
  const cases: [string, number | null][] = [
    ['https://example.test/p.pdf#page=7', 7],
    ['https://example.test/p.pdf#page=7&zoom=140', 7],
    ['https://example.test/p.pdf#zoom=140&page=12', 12],
    ['https://example.test/p.pdf', null],
    ['https://example.test/p.pdf#page=0', null],
    ['https://example.test/p.pdf#page=-3', null],
    ['https://example.test/p.pdf#page=four', null],
    ['https://example.test/p.pdf#section-2', null],
  ];
  for (const [url, expected] of cases) {
    const undo = installPage({ body, url, contentType: 'application/pdf' });
    try {
      assert.equal(injected().pdfPage, expected, `${url} was read as page ${String(injected().pdfPage)}`);
    } finally { undo(); }
  }
});

test('a page number on an ordinary page is ignored, because it is not one', () => {
  // `#page=2` is a perfectly ordinary anchor on an HTML page and means nothing
  // about a PDF. Read only where the convention exists.
  const undo = installPage({
    body: node({ tag: 'body', children: [para('a paginated blog')] }),
    url: 'https://example.test/posts#page=2',
  });
  try {
    assert.equal(injected().pdfPage, null);
  } finally { undo(); }
});

test('a PDF a viewer does let us read is captured like any other selection', () => {
  // pdf.js renders a real text layer, so the selection, the surrounding block
  // and the heading walk all work exactly as they do on a page. This is the
  // case the story describes, on the viewers that permit it.
  const passage = para('Attention weights are computed over the whole sequence at once.');
  const body = node({ tag: 'body', children: [node({ tag: 'div', children: [passage] })] });
  const undo = installPage({
    body,
    contentType: 'application/pdf',
    title: 'attention.pdf',
    url: 'https://example.test/papers/attention.pdf#page=3',
    selection: { text: 'Attention weights are computed', startContainer: passage, commonAncestorContainer: passage },
  });
  try {
    const env = injected();
    assert.equal(env.documentKind, 'pdf');
    assert.equal(env.selection, 'Attention weights are computed');
    assert.equal(env.pdfPage, 3);
    assert.ok(env.surroundingText.includes('whole sequence'));
  } finally { undo(); }
});

test('a heading in a sibling container is still the heading this sits under', () => {
  // The shape that broke it in the wild. The old walk looked only at each
  // ancestor's previous SIBLINGS, which finds a heading where the markup is
  // written like a document and finds nothing where it is built like an app.
  // On a real course site it found nothing at all: fourteen of the first
  // sixteen pins anybody made carried an empty heading path, and the strongest
  // structural signal the topic model gets was blank.
  const selected = para('Represent data using Python’s data types.');
  const body = node({
    tag: 'body',
    children: [
      node({ tag: 'header', children: [node({ tag: 'h1', text: 'Welcome to Neural Networks' })] }),
      node({
        tag: 'main',
        children: [
          node({ tag: 'section', children: [node({ tag: 'h2', text: 'Prerequisites' })] }),
          node({ tag: 'section', children: [node({ tag: 'div', children: [selected] })] }),
        ],
      }),
    ],
  });
  const undo = installPage({ body, selection: { text: 'Represent data', startContainer: selected } });
  try {
    assert.deepEqual(injected().headingPath, ['Welcome to Neural Networks', 'Prerequisites']);
  } finally { undo(); }
});

test('headings after the passage belong to a later section and are not taken', () => {
  // Document order, and the walk stops at the passage. A heading below it is
  // what comes next, not what this is under.
  const selected = para('the passage');
  const body = node({
    tag: 'body',
    children: [
      node({ tag: 'h1', text: 'Above' }),
      node({ tag: 'div', children: [selected] }),
      node({ tag: 'h2', text: 'Below' }),
      node({ tag: 'div', children: [node({ tag: 'h3', text: 'Further below' })] }),
    ],
  });
  const undo = installPage({ body, selection: { text: 'the passage', startContainer: selected } });
  try {
    assert.deepEqual(injected().headingPath, ['Above']);
  } finally { undo(); }
});

test('a deeper heading after a shallower one nests, across containers', () => {
  const selected = para('the passage');
  const body = node({
    tag: 'body',
    children: [
      node({ tag: 'div', children: [node({ tag: 'h1', text: 'Course' })] }),
      node({ tag: 'div', children: [node({ tag: 'h2', text: 'Lesson' })] }),
      node({ tag: 'div', children: [node({ tag: 'h3', text: 'Part' })] }),
      node({ tag: 'div', children: [selected] }),
    ],
  });
  const undo = installPage({ body, selection: { text: 'the passage', startContainer: selected } });
  try {
    assert.deepEqual(injected().headingPath, ['Course', 'Lesson', 'Part']);
  } finally { undo(); }
});

test('a runaway heading is cut rather than carried whole into every prompt', () => {
  const selected = para('the passage');
  const body = node({
    tag: 'body',
    children: [node({ tag: 'h1', text: 'x'.repeat(500) }), node({ tag: 'div', children: [selected] })],
  });
  const undo = installPage({ body, selection: { text: 'the passage', startContainer: selected } });
  try {
    const path = injected().headingPath;
    assert.equal(path.length, 1);
    assert.equal(path[0]!.length, 120);
  } finally { undo(); }
});
