import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FLAGGED_ROWS, FLAG_WINDOW_DAYS, flaggedRows, sessionCard,
  type TopicReason,
} from '../domain/main-page.js';
import { tend } from '../agents/gardener.js';
import type { Session, SessionSection, Signal, SignalType, Topic } from '../domain/types.js';

/**
 * UX_SPEC §5 — the four zones, at the level of what they are allowed to claim.
 *
 * The order of the zones is a fact about the panel and is asserted there. What
 * is asserted here is the honesty of each one: that the session card names the
 * withhold instead of calling it nothing, that the why-line is the scheduler's
 * own sentence rather than a second opinion, and that the flagged list says who
 * flagged each row.
 */

const DAY = 86_400_000;
const EPOCH = Date.parse('2026-08-01T21:00:00.000Z');
const day = (n: number): string => new Date(EPOCH + n * DAY).toISOString();
const NOW = new Date(EPOCH + 30 * DAY);

const topic = (id: string, over: Partial<Topic> = {}): Topic => ({
  id, label: `label of ${id}`, summary: '', pinIds: ['p1'], state: 'working',
  comfort: 0.5, lastExposedAt: day(28), retiredByUser: false, createdAt: day(0), ...over,
});

const section = (topicId: string, over: Partial<SessionSection> = {}): SessionSection => ({
  topicId, heading: `Why ${topicId} is not what you think`, body: 'prose', depth: 'building',
  estimatedMinutes: 5, question: null, sourceIds: [], completed: false, ...over,
});

const session = (sections: readonly SessionSection[], over: Partial<Session> = {}): Session => ({
  id: 's1', builtAt: day(29), fromPinCount: 4, targetMinutes: 15,
  estimatedMinutes: 5 * sections.length, sections, currentSectionIndex: 0,
  closingNote: null, ...over,
});

const reason = (topicId: string, over: Partial<TopicReason> = {}): TopicReason =>
  ({ topicId, disposition: 'teach', reason: 'you have been struggling with this', priority: 70, ...over });

let n = 0;
const sig = (topicId: string, type: SignalType, onDay: number, over: Partial<Signal> = {}): Signal => ({
  id: `f${n += 1}`, topicId, type, direction: 'negative', at: day(onDay),
  sourceEvent: 'x', invalidated: false, ...over,
});

// ------------------------------------------------------------------ zone 1

test('§5: a ready card names the session, its computed length and the registers in it', () => {
  const card = sessionCard({
    session: session([
      section('a', { depth: 'from-nothing', estimatedMinutes: 6 }),
      section('b', { depth: 'fluent', estimatedMinutes: 4 }),
    ]),
    topics: [topic('a'), topic('b')],
    decisions: [reason('a'), reason('b')],
    pinsWaiting: 0,
  });

  assert.equal(card.state, 'ready');
  assert.equal(card.title, 'Why a is not what you think');
  assert.equal(card.minutes, 10);
  assert.deepEqual([...card.registers], ['from-nothing', 'fluent'],
    'in ladder order, whatever order the sections came in');
});

test('§5: the length counts what is left, not what was built', () => {
  const card = sessionCard({
    session: session([
      section('a', { estimatedMinutes: 6, completed: true }),
      section('b', { estimatedMinutes: 4 }),
    ]),
    topics: [topic('a'), topic('b')], decisions: [], pinsWaiting: 0,
  });
  assert.equal(card.minutes, 4);
});

test('§5: the why-line is the Gardener\'s own sentence, for the topic that drove the night', () => {
  // Not a second opinion written on this screen. The line the scheduler
  // recorded when it chose the topic, verbatim, so the panel and the run can
  // never give two different accounts of the same decision.
  const decisions = tend({
    topics: [topic('slipped', { comfort: 0.7 }), topic('new', { comfort: 0.2 })],
    comforts: [
      { topicId: 'slipped', comfort: 0.7, regressed: true, evidenceCount: 4, demonstrationCount: 2, certainty: 0.8, evidenceSignalIds: [] },
      { topicId: 'new', comfort: 0.2, regressed: false, evidenceCount: 2, demonstrationCount: 1, certainty: 0.5, evidenceSignalIds: [] },
    ],
    signals: [], now: NOW,
  });

  const card = sessionCard({
    session: session([section('new'), section('slipped')]),
    topics: [topic('slipped'), topic('new')],
    decisions,
    pinsWaiting: 0,
  });

  // A colon, not a dash. The learner-lineup contract’s copy law bans the em-dash and the
  // en-dash from everything a learner reads, and this line put one on the
  // front door.
  assert.equal(card.why, 'label of slipped: you had this, and something recent suggests it has slipped',
    'regression outranks everything, and the card says so in the scheduler\'s words');
});

test('§5: a night whose sections were all withheld says so, and is not embarrassed about it', () => {
  /**
   * The state this file exists for. The nightly composed, the Verifier
   * refused, and the store held a session with no sections — which the panel
   * rendered as "Nothing ready yet": true about the screen, false about the
   * night, and §3a's last row exactly.
   */
  const card = sessionCard({
    session: session([], {
      withheld: [
        { topicId: 'a', heading: 'How IAM conditions evaluate', reason: 'defective' },
        { topicId: 'b', heading: 'Composite index limits', reason: 'unverified' },
      ],
    }),
    topics: [topic('a'), topic('b')],
    decisions: [reason('a')],
    pinsWaiting: 3,
  });

  assert.equal(card.state, 'withheld', 'and it outranks "building", which would have been the softer lie');
  assert.equal(card.title, 'How IAM conditions evaluate');
  assert.deepEqual(card.withheld.map((w) => w.reason), ['defective', 'unverified']);
  assert.equal(card.reason,
    '1 section failed the check and 1 could not be checked, so they were held back rather than taught.');
});

test('§5: material waiting is stated as waiting, and no run is promised for it', () => {
  // There is no run state anywhere in the store, so a card claiming a run is
  // happening right now would be inventing a fact about a process it cannot
  // see. What it can see is pins that arrived after the last session was built.
  const card = sessionCard({
    session: session([]), topics: [topic('a')], decisions: [reason('a')], pinsWaiting: 2,
  });

  assert.equal(card.state, 'building');
  assert.match(card.reason ?? '', /2 things on your board/);
  assert.ok(!/building it now|working on it/i.test(card.reason ?? ''));
  // The manual-processing contract: and no run is promised for them either, because nothing picks
  // them up on its own.
  assert.ok(!/next run|this run|overnight/i.test(card.reason ?? ''), card.reason ?? '');
});

test('§5: the three empty states are told apart, because they ask different things', () => {
  const nothingPinned = sessionCard({ session: null, topics: [], decisions: [], pinsWaiting: 0 });
  assert.equal(nothingPinned.state, 'nothing-ready');
  assert.match(nothingPinned.reason ?? '', /Nothing pinned yet/);

  const caughtUp = sessionCard({
    session: null,
    topics: [topic('a', { state: 'settled' })],
    decisions: [reason('a', { disposition: 'settled', reason: 'you have this', priority: 0 })],
    pinsWaiting: 0,
  });
  assert.equal(caughtUp.state, 'nothing-ready');
  assert.match(caughtUp.reason ?? '', /caught-up/);

  const thin = sessionCard({
    session: null, topics: [topic('a')], decisions: [reason('a')], pinsWaiting: 0,
  });
  assert.match(thin.reason ?? '', /Not enough new material/);
});

test('a session-shaped answer with no sections array does not take the card down', () => {
  // The same guard `hasSomethingReady` carries, for the same reason: this comes
  // off the wire, and a learner cannot tell a blank panel from a broken
  // extension.
  const broken = { sections: null } as unknown as Session;
  const card = sessionCard({ session: broken, topics: [], decisions: [], pinsWaiting: 0 });
  assert.equal(card.state, 'nothing-ready');
});

// ------------------------------------------------------------------ zone 3

test('§5: every flagged row names its source', () => {
  const rows = flaggedRows({
    topics: [topic('a'), topic('b')],
    signals: [sig('a', 'resurface-refresher', 20), sig('b', 'resurface-deeper', 25)],
    comforts: [{ topicId: 'a', regressed: false }, { topicId: 'b', regressed: false }],
    now: NOW,
  });

  assert.deepEqual(rows.map((r) => `${r.topicLabel}:${r.source}`),
    ['label of b:resurface-deeper', 'label of a:resurface-refresher'],
    'newest first, and each row can say who put it there');
});

test('§5: the model\'s own regression flags sit beside the learner\'s marks', () => {
  const rows = flaggedRows({
    topics: [topic('slipped', { lastExposedAt: day(27) })],
    signals: [],
    comforts: [{ topicId: 'slipped', regressed: true }],
    now: NOW,
  });
  assert.deepEqual(rows.map((r) => r.source), ['regression']);
  assert.equal(rows[0]?.at, day(27));
});

test('the still-shaky tap joins the list it was always going to join', () => {
  // §5 zone 3 is "still-shaky taps , resurface marks , regression
  // flags" — the tap was named there before the quick take existed and the
  // comment in `main-page.ts` said it was absent rather than faked. This is the
  // day it stops being absent.
  const rows = flaggedRows({
    topics: [topic('iam')],
    signals: [sig('iam', 'quick-take-still-shaky', 20)],
    comforts: [], now: NOW,
  });
  assert.deepEqual(rows.map((r) => r.source), ['quick-take-still-shaky']);
});

test('got it is not a flag — the list is what the learner asked for back', () => {
  // §5: "a count of things the learner asked for, which is the one count that
  // is not guilt". A topic the learner said they had, sitting on a list headed
  // "come back to", would be the product arguing with them.
  const rows = flaggedRows({
    topics: [topic('iam')],
    signals: [sig('iam', 'quick-take-got-it', 20)],
    comforts: [], now: NOW,
  });
  assert.deepEqual(rows, []);
});

test('a withdrawn mark leaves the flagged list, like every other read of the ledger', () => {
  const rows = flaggedRows({
    topics: [topic('a')],
    signals: [sig('a', 'resurface-refresher', 20, { invalidated: true })],
    comforts: [], now: NOW,
  });
  assert.deepEqual(rows, []);
});

test('a mark on a topic that no longer exists is dropped, not rendered against a blank name', () => {
  // The provenance join, made rather than assumed — §3a's fourth class. A merge
  // or a delete leaves signals whose topic id resolves to nothing.
  const rows = flaggedRows({
    topics: [], signals: [sig('ghost', 'resurface-refresher', 20)], comforts: [], now: NOW,
  });
  assert.deepEqual(rows, []);
});

test('tapping the same mark twice is one row — they asked once', () => {
  const rows = flaggedRows({
    topics: [topic('a')],
    signals: [sig('a', 'resurface-refresher', 20), sig('a', 'resurface-refresher', 21)],
    comforts: [], now: NOW,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.at, day(21), 'and it is the most recent one that stands');
});

test('a flag older than the window stops being a list item', () => {
  const stale = flaggedRows({
    topics: [topic('a')],
    signals: [sig('a', 'resurface-refresher', 30 - FLAG_WINDOW_DAYS - 1)],
    comforts: [], now: NOW,
  });
  assert.deepEqual(stale, [], 'a flag old enough to have become a reproach is not a flag');
});

test('the list is capped for display, and the cap is a small number', () => {
  // §5: "capped with a plain and-N-more". The cap itself is asserted because a
  // list long enough to scroll is a pile, and the pile is the thing this
  // product refuses to be.
  assert.ok(FLAGGED_ROWS >= 3 && FLAGGED_ROWS <= 6, `${FLAGGED_ROWS} rows is not a short list`);
});
