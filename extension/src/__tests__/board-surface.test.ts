
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boardCard, boardColumns, nextTheme, themeLabel, THEME_CHOICES, unfiledArea,
  AUTO_CHOICES, AUTO_FLOOR, autoStateLine, autoThreshold,
  type TopicView,
} from '../panel-core.js';
import {
  AUTO_FLOOR as CORE_AUTO_FLOOR, autoThreshold as coreAutoThreshold,
} from '@sb/core';

const topic = (over: Partial<TopicView> = {}): TopicView => ({
  id: 't1', label: 'Pub/Sub Delivery and Ordering', state: 'working',
  pinIds: ['a', 'b', 'c'], ...over,
});

// ---------------------------------------------------------------- the card

test('a card carries what makes the topic recognisable, not just its name', () => {
  const card = boardCard(topic({
    summary: 'Understanding how Pub/Sub delivers messages, manages acknowledgment '
      + 'deadlines and redelivery, and enforces within-key ordering.',
  }));
  assert.equal(card.label, 'Pub/Sub Delivery and Ordering');
  assert.equal(card.count, '3 things you pinned');
  // The card is coloured by the AREA it is on, and a payload with no `area` on
  // it is an older service, so the old state maps forward.
  assert.equal(card.state, 'learning');
  // The whole reason the board read as a list: the summary was in the payload
  // and on no screen.
  assert.ok(card.gist.startsWith('Understanding how Pub/Sub delivers messages'));
});

test('a gist is cut at a word and never mid-word', () => {
  const long = `${'alpha beta gamma delta '.repeat(20)}end`;
  const card = boardCard(topic({ summary: long }));
  assert.ok(card.gist.length <= 160, `too long: ${card.gist.length}`);
  assert.ok(!card.gist.includes('  '));
  // Cut at a word: the last thing before the ellipsis is a whole one.
  assert.match(card.gist, /\S…$/);
  assert.ok(!/\s…$/.test(card.gist));
});

test('a topic with no summary says nothing rather than inventing a line', () => {
  // A board that predates the Clusterer writing summaries, and a summary that
  // arrived as whitespace. Neither is a reason to draw a placeholder sentence.
  assert.equal(boardCard(topic()).gist, '');
  assert.equal(boardCard(topic({ summary: '   ' })).gist, '');
});

test('one pin is one thing — the board never says "1 things"', () => {
  assert.equal(boardCard(topic({ pinIds: ['only'] })).count, '1 thing you pinned');
});

test('a card never carries a comfort number, and never a score', () => {
  const card = boardCard(topic({ summary: 'A summary.' }));
  const rendered = Object.values(card).join(' ');
  assert.ok(!/\d+\s*%/.test(rendered), rendered);
  // comfort is never shown as a number. The state is a word.
  assert.ok(!Object.keys(card).includes('comfort'));
});

// ------------------------------------------------------------- the columns

test('the board includes Pending, and an empty area is still a place on the board', () => {
  // Different from boardGroups, deliberately. A board with nothing in Learnt
  // still has a Learnt area — that is what makes it a board rather than a
  // list that happens to have headings in it. The heading says what belongs
  // there rather than pretending the area does not exist.
  const cols = boardColumns([
    topic({ id: 'a', area: 'learning' }),
    topic({ id: 'b', area: 'learnt' }),
  ]);
  assert.deepEqual(cols.map((c) => c.key),
    ['pending', 'get-started', 'learning', 'recharging', 'paused', 'learnt']);
  assert.deepEqual(cols.map((c) => c.topics.length), [0, 0, 1, 0, 0, 1]);
  assert.equal(cols[3]!.empty, 'Nothing is due back yet.');
});

test('a source-ready unbuilt topic moves into Pending without changing its stored area', () => {
  const cols = boardColumns([
    topic({ id: 'p', area: 'learning' }),
    topic({ id: 'r', area: 'recharging' }),
  ], new Set(['p']));
  const where = Object.fromEntries(cols.map((c) => [c.key, c.topics.map((t) => t.id)]));
  assert.deepEqual(where, {
    'get-started': [], pending: ['p'], learning: [], recharging: ['r'], paused: [], learnt: [],
  });
});

/**
 * The two areas that are not `TopicState` under another name.
 *
 * `Paused` is `retiredByUser`, which `applyComfort` maps to `settled` — so
 * before this the board filed a topic somebody had put down under a heading
 * claiming they had learnt it. `Recharging` is the spaced-review rule, which
 * `state` cannot carry at all. Both are decided by the service (`boardAreaFor`)
 * and arrive on the payload; the panel groups by what it is told.
 */
test('paused and recharging are areas of their own, not settled wearing a hat', () => {
  const cols = boardColumns([
    topic({ id: 'p', state: 'settled', area: 'paused' }),
    topic({ id: 'r', state: 'settled', area: 'recharging' }),
    topic({ id: 'l', state: 'settled', area: 'learnt' }),
  ]);
  const where = Object.fromEntries(cols.map((c) => [c.key, c.topics.map((t) => t.id)]));
  assert.deepEqual(where, {
    'get-started': [], pending: [], learning: [], recharging: ['r'], paused: ['p'], learnt: ['l'],
  });
});

test('a service too old to say which area a topic is on still puts it somewhere true', () => {
  // A panel is updated by reloading an extension and a service by restarting a
  // process, and those are two acts. In between, `area` is absent.
  const cols = boardColumns([
    topic({ id: 'w', state: 'working' }),
    topic({ id: 'a', state: 'waiting' }),
    topic({ id: 's', state: 'settled' }),
  ]);
  const where = Object.fromEntries(cols.map((c) => [c.key, c.topics.map((t) => t.id)]));
  assert.deepEqual(where, {
    'get-started': ['a'], pending: [], learning: ['w'], recharging: [], paused: [], learnt: ['s'],
  });
});

test('a topic in an area this build does not know about is still on the board', () => {
  const cols = boardColumns([topic({ id: 'x', state: 'invented-later', area: 'invented-later' })]);
  const where = Object.fromEntries(cols.map((c) => [c.key, c.topics.map((t) => t.id)]));
  assert.deepEqual(where['get-started'], ['x']);
  assert.deepEqual(where.pending, []);
});

test('an empty board has areas but says the board is empty, not that it failed', () => {
  const cols = boardColumns([]);
  assert.equal(cols.length, 6);
  assert.ok(cols.every((c) => c.topics.length === 0));
});

// --------------------------------------------------------------- the theme

test('the learner picks the theme, and system is one of the three', () => {
  assert.deepEqual([...THEME_CHOICES], ['system', 'light', 'dark']);
});

test('the theme cycles, and an unknown stored value falls back to system', () => {
  assert.equal(nextTheme('system'), 'light');
  assert.equal(nextTheme('light'), 'dark');
  assert.equal(nextTheme('dark'), 'system');
  assert.equal(nextTheme('whatever-was-in-storage'), 'light');
  assert.equal(nextTheme(null), 'light');
});

test('the control says what it is showing now, not what it will do next', () => {
  // A toggle labelled with its destination is the oldest UI lie there is.
  assert.equal(themeLabel('light'), 'Whiteboard');
  assert.equal(themeLabel('dark'), 'Blackboard');
  assert.equal(themeLabel('system'), 'Match my system');
});

// ------------------------------------------------------------- just pinned

/**
 * The pins that have not been filed yet.
 *
 * Found by signing in as a new learner, pinning one thing, and opening the
 * board: it said *"Nothing here yet."* three times. The board is where every
 * failure screen in this product sends somebody — *"It is saved and it is on
 * your board"* — and a pin does not reach a topic until the nightly Clusterer
 * files it, so a learner's first afternoon shows them an empty board and no
 * evidence their work exists.
 *
 *  says topics are the display unit and pins are the evidence unit, and
 * that confusing them is how this becomes a backlog. This does not confuse
 * them: it is a **bounded, draining** set — everything here is filed by the
 * next run — and it is named for what it is rather than counted as debt.
 */
test('pins with no topic yet belong to Get Started, and say why they are there', () => {
  const area = unfiledArea([
    { id: 'p1', title: 'Firestore indexes', gist: 'A composite index pre-sorts fields.' },
    { id: 'p2', title: 'Pub/Sub', gist: '' },
  ], 2)!;
  // They no longer head an area of their own: "Get Started" is exactly the
  // place for a thing nothing has begun on, and two headings at the top of a
  // board both saying that is a distinction only the machine cares about.
  assert.equal(area.heading, 'Get Started');
  // Not "this run". The learner names their own hour (`domain/schedule.ts`),
  // and fifteen strings promising one were removed the day before this was
  // written — the lint that caught this one is the reason it is worded so.
  assert.equal(area.note, 'Just pinned, and not filed into subjects yet.');
  assert.equal(area.pins.length, 2);
  assert.equal(area.more, null);
});

test('a lot of unfiled pins are capped, and the overflow is a count of their own work', () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ id: `p${i}`, title: `Pin ${i}`, gist: '' }));
  const area = unfiledArea(many, 6)!;
  assert.equal(area.pins.length, 6);
  // "and 8 more" is a count of things they chose. It is never a count of
  // things to clear, and there is no control that clears them.
  assert.equal(area.more, 'and 8 more');
  assert.ok(!/left|remaining|clear|unread/i.test(JSON.stringify(area)));
});

test('nothing unfiled means no note and no pins — the area itself stays', () => {
  // The five areas are the board's furniture and stay whether or not they hold
  // anything. This answers only for the pins inside the first one: no pins, no
  // note, and "Get Started" is left saying what belongs there.
  assert.equal(unfiledArea([], 6), null);
});

test('an unfiled pin with no readable title still says something', () => {
  const area = unfiledArea([{ id: 'p1', title: '', gist: '' }], 6);
  assert.equal(area!.pins[0]!.title, 'Untitled page');
});

// ------------------------------------------------ the automatic threshold

test('the panel and the service agree what a threshold number means', () => {
  // `AUTO_FLOOR` exists in `core/domain/batch.ts` and again here, because the
  // panel must be able to show what it will do without asking. Two copies of a
  // rule is two chances for it to become two rules.
  assert.equal(AUTO_FLOOR, CORE_AUTO_FLOOR);
  for (const v of [null, undefined, 0, -1, 1, 2, 3, 7, 25, Number.NaN]) {
    assert.equal(autoThreshold(v as number | null), coreAutoThreshold(v as number | null), String(v));
  }
});

test('off is the default, and off is said as costing nothing', () => {
  // The whole money argument in one sentence on one screen.
  assert.match(autoStateLine(null), /until you press Process/);
  assert.match(autoStateLine(null), /Nothing is spent/);
  assert.match(autoStateLine(5), /once 5 things have piled up/);
});

test('the choices offer off first, and no choice is below the floor', () => {
  assert.equal(AUTO_CHOICES[0]!.value, null);
  for (const c of AUTO_CHOICES) {
    if (c.value !== null) assert.ok(c.value >= AUTO_FLOOR, String(c.value));
  }
});
