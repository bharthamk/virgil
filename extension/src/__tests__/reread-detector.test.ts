import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_DWELL_MS, QUIET_AFTER_REJECTIONS, RETURN_THRESHOLD, WINDOW_MS,
  createRereadTracker, detectorQuieted, headingPathFrom, mapVisitStore,
  type HeadingNode, type VisitState,
} from '../reread-core.js';

/**
 * The re-read detector is the demo's reveal and the only signal the agent
 * raises by itself. Its three numbers — three returns, four seconds of dwell,
 * a ten-minute window — were reasoned about and never measured, so this file is
 * where they are actually held: what fires, what does not, and where the edges
 * are.
 *
 * Time is passed in, never read. Nothing here sleeps.
 */

/** A plausible wall clock. The detector treats a timestamp of 0 as "never
 *  entered", so tests do not start at the epoch any more than the browser does. */
const T0 = 1_763_000_000_000;

interface Raised { key: string; visit: VisitState }

interface Harness {
  enter(key: string, at: number): void;
  exit(key: string, at: number): void;
  raised: Raised[];
}

function tracked(): Harness {
  const raised: Raised[] = [];
  const t = createRereadTracker<string>(mapVisitStore<string>(), (key, visit) => {
    raised.push({ key, visit: { ...visit } });
  });
  return { enter: t.enter, exit: t.exit, raised };
}

/** One read of a passage: in at `at`, out `dwellMs` later. Returns the time it ended. */
function read(t: Harness, key: string, at: number, dwellMs: number): number {
  t.enter(key, at);
  t.exit(key, at + dwellMs);
  return at + dwellMs;
}

/** Four sightings of the same passage — three returns — with real dwell. */
function stuckOn(t: Harness, key: string, from: number): number {
  let at = from;
  for (let i = 0; i < 4; i++) at = read(t, key, at + 3000, 2000);
  return at;
}

test('one long read of a passage raises nothing — that is just reading', () => {
  const t = tracked();
  read(t, 'p1', T0, 60_000);
  assert.equal(t.raised.length, 0);
});

test('the first sighting is not a return, so three returns takes four visits', () => {
  // The counter only moves when a passage is seen again after a real gap.
  // Worth stating out loud: "three returns" is four sightings of the passage,
  // which is what the SB-15 walkthrough actually describes.
  const t = tracked();
  let at = read(t, 'p1', T0, 2000);
  at = read(t, 'p1', at + 5000, 2000);   // return 1
  at = read(t, 'p1', at + 5000, 2000);   // return 2
  assert.equal(t.raised.length, 0, 'two returns is normal reading — people glance back constantly');
  read(t, 'p1', at + 5000, 2000);        // return 3, with 8s of dwell behind it
  assert.equal(t.raised.length, 1);
  assert.equal(t.raised[0]!.visit.count, RETURN_THRESHOLD);
});

test('the candidate carries the count and the dwell that justified it', () => {
  const t = tracked();
  let at = read(t, 'p1', T0, 1500);
  at = read(t, 'p1', at + 3000, 1500);
  at = read(t, 'p1', at + 3000, 1500);
  read(t, 'p1', at + 3000, 1500);
  const raised = t.raised[0]!;
  assert.equal(raised.key, 'p1');
  assert.equal(raised.visit.count, 3);
  assert.equal(raised.visit.dwellMs, 6000, 'dwell is every visit added up, not the last one');
});

test('three returns with too little dwell raises nothing — glancing is not being stuck', () => {
  const t = tracked();
  let at = read(t, 'p1', T0, 500);
  at = read(t, 'p1', at + 3000, 500);
  at = read(t, 'p1', at + 3000, 500);
  read(t, 'p1', at + 3000, 500);
  assert.equal(t.raised.length, 0, `2000ms of dwell is under the ${MIN_DWELL_MS}ms floor`);
});

test('dwell one millisecond under the floor holds, and the floor itself fires', () => {
  const build = (finalDwell: number): Raised[] => {
    const t = tracked();
    let at = read(t, 'p1', T0, 1000);
    at = read(t, 'p1', at + 3000, 1000);
    at = read(t, 'p1', at + 3000, 1000);
    read(t, 'p1', at + 3000, finalDwell);
    return t.raised;
  };
  assert.equal(build(999).length, 0, '3999ms is under the floor');
  assert.equal(build(1000).length, 1, '4000ms is the floor, and the floor fires');
});

test('a passage flickering in and out of view is not a passage being returned to', () => {
  // Sub-gap re-entries are scroll jitter and an observer firing twice around
  // the threshold, not a learner coming back. Dwell here is well over the floor,
  // so the count is the only thing holding it.
  const t = tracked();
  let at = T0;
  for (let i = 0; i < 10; i++) at = read(t, 'p1', at + 900, 500);
  assert.equal(t.raised.length, 0, 'ten sightings 1400ms apart still count as one visit');
});

test('returns spread beyond the window are two sittings, not one struggle', () => {
  const t = tracked();
  let at = read(t, 'p1', T0, 5000);
  at = read(t, 'p1', at + 5000, 5000);
  at = read(t, 'p1', at + 5000, 5000);
  read(t, 'p1', at + WINDOW_MS, 5000);          // came back after lunch
  assert.equal(t.raised.length, 0, 'first sighting to last spanning more than the window disqualifies it');
});

test('the window runs from the first sighting and never resets', () => {
  // Worth knowing: once a passage has been in play longer than the window it is
  // disqualified permanently. The count keeps rising and can never fire again,
  // so a genuine struggle in a second sitting is undetectable without a reload.
  // Current behaviour, asserted so that changing it is a decision.
  const t = tracked();
  let at = read(t, 'p1', T0, 5000);
  at = read(t, 'p1', T0 + WINDOW_MS + 10_000, 5000);
  at = read(t, 'p1', at + 5000, 5000);
  at = read(t, 'p1', at + 5000, 5000);
  read(t, 'p1', at + 5000, 5000);
  assert.equal(t.raised.length, 0, 'tight returns cannot fire once the window has been blown');
});

test('a passage raises a candidate once and then stays quiet', () => {
  const t = tracked();
  let at = stuckOn(t, 'p1', T0);
  assert.equal(t.raised.length, 1);
  for (let i = 0; i < 5; i++) at = read(t, 'p1', at + 3000, 2000);
  assert.equal(t.raised.length, 1, 'never interrupt, and never nag');
});

test('two passages are counted independently', () => {
  const t = tracked();
  let at = T0;
  for (let i = 0; i < 4; i++) {
    at = read(t, 'stuck', at + 2000, 2000);
    at = read(t, 'skimmed', at + 2000, 200);
  }
  assert.deepEqual(t.raised.map((r) => r.key), ['stuck'],
    'the passage they lingered on raises; the one they skimmed does not');
});

test('reading elsewhere and coming back banks the dwell of the passage left behind', () => {
  // There is no explicit exit in normal scrolling: arriving at another passage
  // is what ends the previous one.
  const t = tracked();
  t.enter('p1', T0);
  t.enter('p2', T0 + 3000);
  t.enter('p1', T0 + 6000);        // return 1
  t.enter('p2', T0 + 9000);
  t.enter('p1', T0 + 12_000);      // return 2
  t.enter('p2', T0 + 15_000);
  t.enter('p1', T0 + 18_000);      // return 3
  t.exit('p1', T0 + 21_000);
  assert.deepEqual(t.raised.map((r) => r.key), ['p1']);
  assert.equal(t.raised[0]!.visit.dwellMs, 12_000, 'four separate spells on p1, all counted');
});

test('a candidate is raised on the way out of a passage, never on the way in', () => {
  const t = tracked();
  let at = read(t, 'p1', T0, 2000);
  at = read(t, 'p1', at + 3000, 2000);
  at = read(t, 'p1', at + 3000, 2000);
  t.enter('p1', at + 3000);
  assert.equal(t.raised.length, 0, 'arriving for the fourth time is not yet evidence of dwell');
  t.exit('p1', at + 5000);
  assert.equal(t.raised.length, 1, 'the dwell that completes the case is the one being left');
});

test('an exit for a passage that is not the one being read is ignored', () => {
  const t = tracked();
  t.enter('p1', T0);
  t.exit('p2', T0 + 5000);
  t.exit('p1', T0 + 5000);
  assert.equal(t.raised.length, 0);
});

test('an exit with no entry behind it banks nothing', () => {
  const t = tracked();
  t.exit('never-seen', T0);
  assert.equal(t.raised.length, 0);
});

// ------------------------------------------------------------ SB-16 quieting

/**
 * This block used to assert the opposite.
 *
 * It read: *"the detector has no idea a suggestion was rejected — SB-16 quieting
 * is not built"*, and it was true. Nothing in the state machine could take a
 * rejection, the service flipped a `state` field and the card went away, and the
 * next passage on the same site raised exactly as loudly. The old test existed
 * so that the gap was visible and so that it would fail the day somebody closed
 * it. Somebody closed it, so it fails, so it says the other thing now.
 *
 * What closed it: the service counts a rejection against the origin it came from
 * in `LearnerPrefs.rejectedOrigins`, and the content script reads that count
 * before it observes anything.
 */

test('a rejection reaches the detector, and two of them quiet the site (SB-16)', () => {
  const quiet = (): Harness => {
    const raised: Raised[] = [];
    const t = createRereadTracker<string>(mapVisitStore<string>(), (key, visit) => {
      raised.push({ key, visit: { ...visit } });
    }, { quieted: true });
    return { enter: t.enter, exit: t.exit, raised };
  };

  const loud = tracked();
  let at = stuckOn(loud, 'passage-a', T0);
  stuckOn(loud, 'passage-b', at);
  assert.equal(loud.raised.length, 2, 'unquieted, both passages raise — that is the baseline');

  const quieted = quiet();
  at = stuckOn(quieted, 'passage-a', T0);
  stuckOn(quieted, 'passage-b', at);
  assert.equal(quieted.raised.length, 0,
    'the same behaviour on a site the learner has said no to twice raises nothing');
});

test('the count is per site, and one no is not enough', () => {
  // One rejection is a bad guess about one passage. Quieting a whole site on it
  // would make the detector useless the first time it is wrong.
  assert.equal(QUIET_AFTER_REJECTIONS, 2);
  assert.equal(detectorQuieted({ 'https://docs.example.test': 1 }, 'https://docs.example.test'), false);
  assert.equal(detectorQuieted({ 'https://docs.example.test': 2 }, 'https://docs.example.test'), true);
  assert.equal(detectorQuieted({ 'https://docs.example.test': 9 }, 'https://docs.example.test'), true);
});

test('quieting one site does not quiet another', () => {
  const rejections = { 'https://news.example.test': 4 };
  assert.equal(detectorQuieted(rejections, 'https://news.example.test'), true);
  assert.equal(detectorQuieted(rejections, 'https://docs.example.test'), false,
    'being wrong about a news site says nothing about being wrong in the docs');
  assert.equal(detectorQuieted(rejections, 'http://news.example.test'), false,
    'keyed by origin, so a scheme change is a different site — as the browser has it');
});

test('no counts at all is not quiet — the detector starts loud everywhere', () => {
  assert.equal(detectorQuieted({}, 'https://docs.example.test'), false);
  assert.equal(detectorQuieted(undefined, 'https://docs.example.test'), false);
  assert.equal(detectorQuieted(null, 'https://docs.example.test'), false);
});

// ------------------------------------------------------------------- headings

/** Left to right becomes previous-sibling order; the last node is the passage. */
function siblings(...nodes: readonly { tag: string; text: string }[]): HeadingNode {
  let last: HeadingNode | null = null;
  for (const n of nodes) {
    last = { tagName: n.tag, textContent: n.text, previousElementSibling: last, parentElement: null };
  }
  return last!;
}

test('the heading path walks back up the document (SB-06)', () => {
  const passage = siblings({ tag: 'H1', text: 'Guide' }, { tag: 'H2', text: 'Sessions' }, { tag: 'P', text: 'the text' });
  assert.deepEqual(headingPathFrom(passage), ['Guide', 'Sessions']);
});

test('a heading no shallower than one already taken belongs to a different section', () => {
  const passage = siblings(
    { tag: 'H1', text: 'Guide' },
    { tag: 'H2', text: 'Earlier section' },
    { tag: 'H2', text: 'This section' },
    { tag: 'P', text: 'the text' },
  );
  assert.deepEqual(headingPathFrom(passage), ['Guide', 'This section']);
});

test('a blank heading is dropped rather than left as a hole in the path', () => {
  const passage = siblings({ tag: 'H1', text: '  ' }, { tag: 'H2', text: 'Real' }, { tag: 'P', text: 'x' });
  assert.deepEqual(headingPathFrom(passage), ['Real']);
});

test('a passage with nothing above it has an empty path', () => {
  assert.deepEqual(headingPathFrom(null), []);
  assert.deepEqual(headingPathFrom(siblings({ tag: 'P', text: 'alone' })), []);
});

test('the walk climbs out through parents, not just siblings', () => {
  const inner = siblings({ tag: 'H3', text: 'State' }, { tag: 'P', text: 'the text' });
  const outer = siblings({ tag: 'H1', text: 'ADK' }, { tag: 'DIV', text: '' });
  const passage: HeadingNode = { ...inner, parentElement: outer };
  assert.deepEqual(headingPathFrom(passage), ['ADK', 'State']);
});
