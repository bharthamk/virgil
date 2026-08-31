import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Commitment } from '../domain/commitments.js';
import type { Course, Material } from '../domain/courses.js';
import type { Pin, PrereqEdge, Signal, Statement, Topic } from '../domain/types.js';
import type { ActionOption } from '../domain/next-action.js';
import {
  avoidanceCandidates, avoidanceKey, avoidanceKeyForActionId, isSetAside,
  passedOverCount, readPassedOverLedger, recordPassedOver, recordSetAside, slippingRows,
  AVOID_ELSEWHERE_MIN, AVOID_IDLE_DAYS, AVOID_LEDGER_MAX, AVOID_MAX_SURFACED,
  AVOID_SNOOZE_DAYS, AVOIDANCE_ACTIVATION_LINE,
  EMPTY_PASSED_OVER_LEDGER,
  type AvoidanceInput, type PassedOverLedger,
} from '../domain/avoidance.js';
import {
  nudgeSlipping, AVOIDANCE_NUDGE_CEILING, AVOIDANCE_NUDGE_REASON, AVOIDANCE_NUDGE_STEP,
} from '../domain/avoidance-nudge.js';

/**
 * WHAT KEEPS SLIPPING, AS A TRUTH TABLE.
 *
 * The detection is four legs joined by AND, so the first block of this file is
 * one test per leg: a board that satisfies everything, then the same board with
 * exactly one leg broken, four times. That shape is deliberate. A predicate
 * asserted only in its passing case is a predicate that will still pass when
 * somebody deletes a clause.
 *
 * The second block is about what the product does with the answer, and every
 * test in it is a bound rather than a behaviour: the cap, the ring, the
 * fortnight, the one-minute window, and the deadline that always wins. Those
 * are the promises; the ordering is only the arithmetic underneath them.
 */

const NOW = new Date('2026-08-29T12:00:00.000Z');
const ago = (days: number): string =>
  new Date(NOW.getTime() - days * 86_400_000).toISOString();

const topic = (id: string, over: Partial<Topic> = {}): Topic => ({
  id,
  label: `Topic ${id}`,
  summary: '',
  pinIds: [`pin-${id}`],
  state: 'working',
  comfort: 0.2,
  lastExposedAt: null,
  retiredByUser: false,
  createdAt: ago(60),
  ...over,
});

const pin = (id: string, topicId: string | null, at: string): Pin => ({
  id,
  type: 'interest',
  envelope: {
    selection: null, parts: [], surroundingText: '', headingPath: [],
    pageTitle: 'A page', url: 'https://example.test/p', canonicalUrl: null,
    siteName: null, contentLanguage: null, media: null,
  },
  note: null,
  capturedAt: at,
  fromSuggestion: false,
  enrichment: null,
  topicId,
});

const signal = (
  id: string, topicId: string, type: Signal['type'], at: string,
): Signal => ({
  id, topicId, type, direction: 'positive', at, sourceEvent: 'test', invalidated: false,
});

const material = (id: string, over: Partial<Material> = {}): Material => ({
  id,
  title: `Material ${id}`,
  url: 'https://example.test/m',
  kind: 'reading',
  minutes: 30,
  doneAt: null,
  pinIds: [],
  addedAt: ago(40),
  ...over,
});

const course = (id: string, materials: readonly Material[]): Course => ({
  id, title: `Course ${id}`, provider: '', url: '',
  material: materials, topicIds: [], archivedAt: null, createdAt: ago(60),
});

const commitment = (id: string, over: Partial<Commitment> = {}): Commitment => ({
  id,
  title: `Work ${id}`,
  kind: 'assignment',
  courseId: 'c1',
  topicIds: [],
  dueAt: ago(3),
  plannedFor: null,
  estimateMinutes: null,
  notes: '',
  doneAt: null,
  createdAt: ago(40),
  ...over,
});

/**
 * A board where exactly one thing is slipping, and it is the overdue
 * assignment: untouched for a month, while nine other things were finished in
 * the same window on topics it has nothing to do with.
 */
const board = (over: Partial<AvoidanceInput> = {}): AvoidanceInput => ({
  now: NOW,
  courses: [],
  commitments: [commitment('late-1', { topicIds: ['t1'] })],
  topics: [topic('t1', { pinIds: [] }), topic('other', { pinIds: [] })],
  pins: [],
  signals: Array.from({ length: 9 }, (_, index) =>
    signal(`s${index}`, 'other', 'section-completed', ago(index + 1))),
  ...over,
});

const keys = (input: AvoidanceInput): readonly string[] =>
  avoidanceCandidates(input).map((candidate) => candidate.key);

// ------------------------------------------------------- the four legs, alone

test('standing, idleness, work elsewhere and something to open: all four, and it shows', () => {
  const found = avoidanceCandidates(board());
  assert.equal(found.length, 1);
  assert.equal(found[0]?.key, 'commitment:late-1');
  assert.equal(found[0]?.standing, 'overdue');
  assert.ok((found[0]?.idleDays ?? 0) >= AVOID_IDLE_DAYS);
  assert.ok((found[0]?.elsewhere ?? 0) >= AVOID_ELSEWHERE_MIN);
});

test('leg one: with no standing it is quiet work, not slipping work', () => {
  // Due in a year, no topics the ledger calls shaky, nothing leaning on it.
  assert.deepEqual(keys(board({
    commitments: [commitment('late-1', {
      topicIds: ['t1'], dueAt: new Date(NOW.getTime() + 365 * 86_400_000).toISOString(),
    })],
    topics: [topic('t1', { pinIds: [], comfort: 0.9 }), topic('other', { pinIds: [] })],
  })), []);
});

test('leg two: touched inside the window, and the whole thing is off the list', () => {
  assert.deepEqual(keys(board({
    signals: [
      ...board().signals,
      signal('touch', 't1', 'section-completed', ago(AVOID_IDLE_DAYS - 1)),
    ],
  })), [], 'any contact at all removes it: that is the whole of the hysteresis');
});

test('leg three: silence with no work beside it is a busy fortnight, not avoidance', () => {
  assert.deepEqual(keys(board({
    signals: board().signals.slice(0, AVOID_ELSEWHERE_MIN - 1),
  })), []);
});

test('leg four: nowhere to go in a minute is nothing to offer', () => {
  assert.deepEqual(keys(board({
    commitments: [commitment('late-1', { topicIds: [], courseId: null })],
  })), [], 'a dated title with no course and no topic is a note, not work');
});

test('one contact is enough, and it is the newest one that counts', () => {
  const touched = board({
    signals: [
      ...board().signals,
      signal('old', 't1', 'section-abandoned', ago(30)),
    ],
  });
  assert.deepEqual(keys(touched), ['commitment:late-1'],
    'a month-old abandonment is not contact inside the window');
});

// --------------------------------------------------------------- the reading

test('a material with a link and a course deadline can slip; one with neither cannot', () => {
  const withLink = board({
    courses: [course('c1', [material('m1')])],
    commitments: [commitment('due-1', { topicIds: [] })],
  });
  assert.ok(keys(withLink).includes('material:m1'));

  const noLink = board({
    courses: [course('c1', [material('m1', { url: '', pinIds: [] })])],
    commitments: [commitment('due-1', { topicIds: [] })],
  });
  assert.ok(!keys(noLink).includes('material:m1'),
    'nothing to open is nothing a one-minute block can honestly start');
});

test('a recall item needs a pin to teach from, and a retired topic is off the board', () => {
  const due = (over: Partial<Topic>): AvoidanceInput => board({
    commitments: [],
    topics: [
      topic('t1', { lastExposedAt: ago(40), pinIds: ['pin-t1'], ...over }),
      topic('other', { pinIds: [] }),
    ],
    pins: [pin('pin-t1', 't1', ago(40))],
    signals: [
      signal('graded', 't1', 'recall-check', ago(40)),
      ...board().signals,
    ],
  });
  assert.deepEqual(keys(due({})), ['recall:t1']);
  assert.deepEqual(keys(due({ pinIds: [] })), []);
  assert.deepEqual(keys(due({ retiredByUser: true })), []);
});

test('a machine read of a shaky topic gives its material standing', () => {
  const statements: readonly Statement[] = [{
    id: 'st1', text: 'They guess at the mechanism.', topicId: 't1',
    userEdited: false, evidenceSignalIds: [], updatedAt: ago(20),
  }];
  const input = board({
    courses: [course('c1', [material('m1', { pinIds: ['pin-t1'] })])],
    commitments: [],
    topics: [topic('t1', { comfort: 0.9, pinIds: ['pin-t1'] }), topic('other', { pinIds: [] })],
    pins: [pin('pin-t1', 't1', ago(40))],
    statements,
  });
  const found = avoidanceCandidates(input);
  assert.equal(found.find((row) => row.key === 'material:m1')?.standing, 'shaky');
});

test('a topic the graph says other work leans on has standing of its own', () => {
  const edges: readonly PrereqEdge[] = [
    { from: 't1', to: 'other', confidence: 0.9, justification: 'named' },
  ];
  const input = board({
    commitments: [],
    topics: [topic('t1', { comfort: 0.9, pinIds: ['pin-t1'] }), topic('other', { pinIds: [] })],
    pins: [pin('pin-t1', 't1', ago(40))],
    edges,
  });
  assert.equal(avoidanceCandidates(input)[0]?.standing, 'prerequisite');
});

test('the same board is read the same way twice, and only three rows ever leave', () => {
  const many = board({
    commitments: Array.from({ length: 6 }, (_, index) =>
      commitment(`late-${index}`, { topicIds: [], dueAt: ago(index + 1) })),
  });
  const first = avoidanceCandidates(many);
  assert.equal(first.length, AVOID_MAX_SURFACED);
  assert.deepEqual(first, avoidanceCandidates(many));
  assert.deepEqual([...first].sort((a, b) => b.score - a.score).map((row) => row.key),
    first.map((row) => row.key), 'ordered by idle days against standing, highest first');
});

test('two items with the same score are broken on the key, not on array order', () => {
  const tied = board({
    commitments: [
      commitment('b-later', { topicIds: [], dueAt: ago(9), createdAt: ago(20) }),
      commitment('a-first', { topicIds: [], dueAt: ago(9), createdAt: ago(20) }),
    ],
  });
  assert.deepEqual(keys(tied), ['commitment:a-first', 'commitment:b-later']);
});

// -------------------------------------------------------- the learner's word

test('setting one aside removes it, and the fortnight is what it lasts', () => {
  const key = avoidanceKey('commitment', 'late-1');
  const just = recordSetAside({}, key, NOW);
  assert.deepEqual(keys(board({ setAside: just })), []);

  const expired = { [key]: ago(AVOID_SNOOZE_DAYS + 1) };
  assert.deepEqual(keys(board({ setAside: expired })), ['commitment:late-1'],
    'the deferral runs out rather than becoming a silent deletion');
});

test('a deferral is honoured until the day it lapses, and never on a broken stamp', () => {
  const key = avoidanceKey('recall', 't1');
  assert.equal(isSetAside({ [key]: ago(AVOID_SNOOZE_DAYS - 1) }, key, NOW), true);
  assert.equal(isSetAside({ [key]: ago(AVOID_SNOOZE_DAYS) }, key, NOW), false);
  assert.equal(isSetAside({ [key]: 'not a date' }, key, NOW), false);
  assert.equal(isSetAside(undefined, key, NOW), false);
});

test('recording one deferral drops the deferrals that have already run out', () => {
  const stale = { 'recall:old': ago(AVOID_SNOOZE_DAYS + 3), 'recall:live': ago(1) };
  const next = recordSetAside(stale, 'material:m1', NOW);
  assert.deepEqual(Object.keys(next).sort(), ['material:m1', 'recall:live']);
});

// ------------------------------------------------------ the forward-only ring

test('the ledger keeps its last two hundred marks and remembers when it started', () => {
  let ledger: PassedOverLedger = EMPTY_PASSED_OVER_LEDGER;
  for (let index = 0; index < AVOID_LEDGER_MAX + 25; index += 1) {
    ledger = recordPassedOver(ledger, {
      offeredId: 'commitment:late-1', offeredReason: 'deadline',
      chosenId: `session:${index}`, at: ago(200 - index),
    });
  }
  assert.equal(ledger.marks.length, AVOID_LEDGER_MAX);
  assert.equal(ledger.startedAt, ago(200), 'the start date survives its own marks being evicted');
  assert.equal(passedOverCount(ledger, 'commitment:late-1'), AVOID_LEDGER_MAX);
});

test('only ids that name exactly one item resolve to a key', () => {
  assert.equal(avoidanceKeyForActionId('commitment:c9'), 'commitment:c9');
  assert.equal(avoidanceKeyForActionId('material:course-1:m9'), 'material:m9');
  assert.equal(avoidanceKeyForActionId('burst:t1,t2,t3'), null,
    'a burst is several topics at once and belongs to none of them');
  assert.equal(avoidanceKeyForActionId('take:pin-1:3'), null);
  assert.equal(avoidanceKeyForActionId('session:s1'), null);
});

test('a stored ledger that is not a ledger reads as empty rather than as evidence', () => {
  assert.deepEqual(readPassedOverLedger(null), EMPTY_PASSED_OVER_LEDGER);
  assert.deepEqual(readPassedOverLedger({ marks: 'nope' }), EMPTY_PASSED_OVER_LEDGER);
  const half = readPassedOverLedger({
    marks: [{ offeredId: 'commitment:c1', chosenId: 'burst:t1', at: ago(2) }, { nonsense: true }],
  });
  assert.equal(half.marks.length, 1);
  assert.equal(half.startedAt, ago(2));
});

// ----------------------------------------------------------------- the lines

test('a row says the standing, the number of days, and what happened instead', () => {
  const rows = slippingRows(avoidanceCandidates(board()));
  assert.equal(rows.length, 1);
  assert.match(rows[0]?.standingLine ?? '', /^Past its date, and you have not touched it for \d+ days\.$/);
  assert.equal(rows[0]?.elsewhereLine, 'In that time you finished 9 other things on your board.');
  assert.equal(rows[0]?.activationLine, AVOIDANCE_ACTIVATION_LINE);
  assert.equal(rows[0]?.passedOverLine, null, 'no ledger, no claim');
});

test('the passed-over line appears only with the ledger behind it, and names its start', () => {
  const ledger = recordPassedOver(EMPTY_PASSED_OVER_LEDGER, {
    offeredId: 'commitment:late-1', offeredReason: 'deadline',
    chosenId: 'burst:t1', at: ago(4),
  });
  const [row] = slippingRows(avoidanceCandidates(board()), ledger);
  assert.equal(row?.passedOverLine, 'Offered and passed over once since 25 August 2026.');

  const [none] = slippingRows(avoidanceCandidates(board()), EMPTY_PASSED_OVER_LEDGER);
  assert.equal(none?.passedOverLine, null);
});

test('nothing slipping renders no row, and there is no praise line to render instead', () => {
  assert.deepEqual(slippingRows(avoidanceCandidates(board({ signals: [] }))), []);
});

// ------------------------------------------------------------------ the nudge

const option = (id: string, rank: number, minutes: 1 | 3 | 5 = 1): ActionOption => ({
  id, kind: 'course-material', targetId: 'c1', title: 'Material m1', detail: '',
  minutes, destination: 'courses', cta: 'Open material', rank, reasons: [],
});

const SLIPPING = new Set(['material:m1']);

test('the nudge lifts a slipping item, and only inside the one-minute window', () => {
  const options = [option('material:c1:m1', 340)];
  const [lifted] = nudgeSlipping(options, SLIPPING, 1);
  assert.equal(lifted?.rank, 340 + AVOIDANCE_NUDGE_STEP);
  assert.equal(lifted?.reasons[0]?.text, AVOIDANCE_NUDGE_REASON);
  assert.equal(lifted?.reasons[0]?.code, 'slipping');

  for (const minutes of [3, 5] as const) {
    assert.deepEqual(nudgeSlipping(options, SLIPPING, minutes), options,
      'three and five minutes are windows for the work they came to do');
  }
});

test('the nudge never reaches what is due today, whatever it started from', () => {
  const [lifted] = nudgeSlipping([option('material:c1:m1', 780)], SLIPPING, 1);
  assert.equal(lifted?.rank, AVOIDANCE_NUDGE_CEILING);
  assert.ok(AVOIDANCE_NUDGE_CEILING < 860,
    'a commitment due today ranks 860, and this ceiling sits under it on purpose');
});

test('something already above the ceiling keeps its rank and gains only the sentence', () => {
  // An overdue assignment with a whole estimate ranks 925 and is very often the
  // thing that has been slipping. A ceiling applied as a plain minimum demoted
  // it to 800, which is a nudge reordering the board against the deadline it is
  // supposed to defer to.
  const [held] = nudgeSlipping([option('commitment:late-1', 925)], new Set(['commitment:late-1']), 1);
  assert.equal(held?.rank, 925);
  assert.equal(held?.reasons[0]?.code, 'slipping');
});

test('an item nobody said was slipping is left exactly as it was', () => {
  const options = [option('material:c1:other', 340), option('session:s1', 950)];
  assert.deepEqual(nudgeSlipping(options, SLIPPING, 1), options);
});

test('a deliberate deferral suppresses the nudge, because it never reaches the keys', () => {
  const key = avoidanceKey('commitment', 'late-1');
  const deferred = board({ setAside: recordSetAside({}, key, NOW) });
  const slippingKeys = new Set(avoidanceCandidates(deferred).map((row) => row.key));
  assert.equal(slippingKeys.size, 0);
  const options = [option('commitment:late-1', 900)];
  assert.deepEqual(nudgeSlipping(options, slippingKeys, 1), options);
});
