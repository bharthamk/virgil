import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Session, SessionSection, Signal, SignalType, Topic } from '../domain/types.js';
import {
  awardsForSession, BADGE_KINDS, chainFor, ledgerHistory,
  NOTABLE_CHAIN, projectProgression, SHAKY_MARK_TYPES, stripFrom, STRIP_ITEMS,
  type Badge, type Chain, type Milestone, type ProgressionEvent,
} from '../progression/index.js';

/**
 * UX_SPEC §5a — the honest progression system.
 *
 * The mechanics are arithmetic over the signal ledger, so these are fixtures of
 * signals with the comfort model left to do what it does. Nothing here stubs
 * `computeComfort`: the entire claim of the design is that a milestone is a
 * transition the learner model *actually made*, and a test that told the model
 * what to say would be checking the celebration rather than the earning.
 *
 * The refusals get as much room as the awards, deliberately. Half of what this
 * module has to be trusted about is what it declines to celebrate.
 */

const DAY = 86_400_000;
const EPOCH = Date.parse('2026-06-01T09:00:00.000Z');
const day = (n: number): string => new Date(EPOCH + n * DAY).toISOString();
const NOW = new Date(EPOCH + 30 * DAY);

let n = 0;
const sig = (
  topicId: string, type: SignalType, direction: Signal['direction'], onDay: number,
  over: Partial<Signal> = {},
): Signal => ({
  id: `sig${n += 1}`, topicId, type, direction, at: day(onDay),
  sourceEvent: `event:${topicId}`, invalidated: false, ...over,
});

const right = (topicId: string, onDay: number): Signal => sig(topicId, 'answer-correct', 'positive', onDay);
const wrong = (topicId: string, onDay: number): Signal => sig(topicId, 'answer-wrong', 'negative', onDay);

const topic = (id: string, over: Partial<Topic> = {}): Topic => ({
  id, label: `label of ${id}`, summary: '', pinIds: ['p1'], state: 'working',
  comfort: 0.5, lastExposedAt: null, retiredByUser: false, createdAt: day(-1), ...over,
});

const section = (topicId: string, over: Partial<SessionSection> = {}): SessionSection => ({
  topicId, heading: `heading for ${topicId}`, body: 'prose', depth: 'building',
  estimatedMinutes: 5, question: null, sourceIds: [], completed: false, ...over,
});

const session = (id: string, builtOnDay: number, sections: readonly SessionSection[]): Session => ({
  id, builtAt: day(builtOnDay), fromPinCount: sections.length, targetMinutes: 15,
  estimatedMinutes: 5 * sections.length, sections, currentSectionIndex: 0, closingNote: null,
});

const project = (
  topics: readonly Topic[], signals: readonly Signal[], sessions: readonly Session[] = [], now = NOW,
) => projectProgression({ topics, signals, sessions, now });

const milestones = (events: readonly ProgressionEvent[]): Milestone[] =>
  events.filter((e): e is Milestone => e.kind === 'milestone');
const badges = (events: readonly ProgressionEvent[]): Badge[] =>
  events.filter((e): e is Badge => e.kind === 'badge');

/**
 * One wrong answer and then three right ones, a week apart.
 *
 * Chosen because it walks the whole ladder: the ledger reads from-nothing after
 * the miss, building once a right answer outweighs it, and fluent once three
 * do — which is  own example, arrived at rather than asserted.
 */
const LADDER = (id = 'iam'): Signal[] => [wrong(id, 0), right(id, 7), right(id, 14), right(id, 21)];

/** The same ladder without the early miss, which is what it takes for the
 *  learner model to settle a topic — comfort held, on evidence it trusts. */
const HELD = (id = 'iam'): Signal[] => [right(id, 0), right(id, 7), right(id, 14)];

// ------------------------------------------------------------- milestones

test('a milestone is a register transition the ledger actually made', () => {
  const events = project([topic('iam')], LADDER()).events;
  const advance = milestones(events).find((m) => m.to === 'fluent');

  assert.ok(advance, 'three demonstrations across three weeks is the transition the model makes');
  assert.equal(advance.from, 'building');
  assert.equal(advance.topicLabel, 'label of iam');
  assert.equal(advance.at, day(21), 'dated when it happened, not when it was rendered');
});

test('the wording is evidence off the ledger, not a template of praise', () => {
  const advance = milestones(project([topic('iam')], LADDER()).events).find((m) => m.to === 'fluent');

  assert.equal(advance?.demonstrations, 3);
  assert.equal(advance?.evidence, 'Demonstrated 3 times across 2 weeks.');
  // The two numbers are the sentence. A milestone that could be written without
  // reading the ledger is a milestone that could be written about anybody.
  for (const word of ['Well done', 'Great', 'keep it up', 'amazing']) {
    assert.ok(!(advance?.evidence ?? '').toLowerCase().includes(word.toLowerCase()));
  }
});

test('one demonstrated answer cannot mint a fluent milestone', () => {
  const firstSitting = [
    sig('web-accessibility', 'quick-take-got-it', 'positive', 0),
    right('web-accessibility', 0),
    sig('web-accessibility', 'section-completed', 'positive', 0),
  ];
  const afterOne = milestones(project([topic('web-accessibility')], firstSitting).events);

  assert.deepEqual(afterOne.map((m) => `${m.from}->${m.to}`), ['from-nothing->building']);
  assert.equal(afterOne[0]?.demonstrations, 1);

  const afterTwo = milestones(project(
    [topic('web-accessibility')], [...firstSitting, right('web-accessibility', 7)],
  ).events);
  assert.ok(afterTwo.some((m) => m.from === 'building' && m.to === 'fluent'));
});

test('a slip is not a milestone in the other direction', () => {
  const events = project([topic('iam')], [...LADDER(), wrong('iam', 22), wrong('iam', 23)]).events;
  // Newest first, which is the order every §5a surface reads in.
  assert.deepEqual(milestones(events).map((m) => `${m.from}->${m.to}`),
    ['building->fluent', 'from-nothing->building'],
    'going down mints nothing — there is a badge for coming back, not a prize for falling');
});

test('a transition with nothing demonstrated behind it mints nothing and says so', () => {
  // Comfort moves on weaker evidence than a demonstration, so this transition
  // is real and its sentence would have to be invented. Fail closed: no award,
  // and the reason kept where an operator can find it (§3a, fail-open paths).
  const soft = [
    sig('bread', 'reread-confirmed', 'positive', 0),
    sig('bread', 'section-completed', 'positive', 3),
    sig('bread', 'depth-deeper', 'positive', 6),
    sig('bread', 'self-skip', 'positive', 9),
  ];
  const out = project([topic('bread')], soft);

  assert.deepEqual(milestones(out.events), []);
  assert.ok(out.skipped.some((s) => s.rule === 'milestone' && s.topicId === 'bread'),
    'the refusal is recorded internally rather than happening silently');
});

// ----------------------------------------------------------------- chains

test('a chain counts demonstrated recalls on one topic, at day 2, 5 and 12', () => {
  const t = topic('tritone');
  const { chain } = chainFor(t, [right('tritone', 2), right('tritone', 5), right('tritone', 12)], new Date(EPOCH + 13 * DAY));

  assert.equal(chain?.length, 3);
  assert.deepEqual([...chain?.intervals ?? []], [3, 7], 'the widening gaps are shown, not claimed');
  assert.equal(chain?.state, 'active');
});

test('answering the same topic twice in one day cannot extend a chain', () => {
  const sameDay = [
    right('tritone', 2),
    { ...right('tritone', 2), id: 'again', at: new Date(EPOCH + 2 * DAY + 3600_000).toISOString() },
    right('tritone', 5),
  ];
  const { chain } = chainFor(topic('tritone'), sameDay, new Date(EPOCH + 6 * DAY));
  assert.equal(chain?.length, 2, 'interval-gated: re-answering this evening is not a second recall');
});

test('a fortnight away pauses the chain and leaves the number where it was', () => {
  const away = new Date(EPOCH + 26 * DAY);
  const { chain } = chainFor(topic('tritone'), [right('tritone', 2), right('tritone', 5), right('tritone', 12)], away);

  assert.equal(chain?.length, 3, 'absence is not punishment');
  assert.equal(chain?.state, 'paused');
  assert.match(chain?.evidence ?? '', /Paused/);
});

test('a miss holds the chain, never resets it, and pulls the next recall in', () => {
  const missed = [right('tritone', 2), right('tritone', 5), right('tritone', 12), wrong('tritone', 14)];
  const { chain } = chainFor(topic('tritone'), missed, new Date(EPOCH + 15 * DAY));

  assert.equal(chain?.length, 3, 'the chain holds at three');
  assert.equal(chain?.state, 'held');
  assert.match(chain?.evidence ?? '', /The run stands/);
  //  hardest demand, checked as arithmetic rather than as copy: a wrong
  // answer must never cost more than the absence of a right one.
  const absent = chainFor(topic('tritone'), missed.slice(0, 3), new Date(EPOCH + 15 * DAY)).chain;
  assert.equal(chain?.length, absent?.length,
    'attempting a shaky topic and being wrong must never be worse than not attempting it');
});

test('nothing anywhere adds two chains together', () => {
  // The global chain is banned by the product contract, and the cheapest way to keep it
  // banned is to have nowhere to build one. Two topics, two chains, no total.
  const out = project(
    [topic('a'), topic('b')],
    [right('a', 2), right('a', 5), right('b', 3), right('b', 9)],
  );
  assert.deepEqual(out.chains.map((c) => c.length).sort(), [2, 2]);
  assert.equal((out as unknown as Record<string, unknown>)['total'], undefined);
  assert.ok(out.chains.every((c) => c.topicId), 'every chain is about one topic');
});

test('a topic with no demonstrations has no chain at all, rather than a chain of zero', () => {
  const out = project([topic('bread')], [sig('bread', 'self-skip', 'positive', 1)]);
  assert.deepEqual(out.chains, [], 'a displayed zero is exactly what  refuses');
});

test('a quick-take tap cannot extend a chain, however often it is tapped', () => {
  /**
   * The farming door the quick take opened, closed and watched.
   *
   * A chain is *demonstrated recalls* — something somebody checked. *Got it* is
   * the learner's own read at first contact, and it is a button. A chain a
   * self-report could extend is a chain the tap farms, on expanding intervals
   * the learner controls entirely, which is the  failure arriving through
   * a door  had to open to exist at all.
   *
   * `DEMONSTRATED_TYPES` is what keeps it shut; this is the test that fails the
   * day somebody adds a third entry to that list without meaning to.
   */
  const tapped = [
    sig('iam', 'quick-take-got-it', 'positive', 1),
    sig('iam', 'quick-take-got-it', 'positive', 6),
    sig('iam', 'quick-take-got-it', 'positive', 14),
  ];
  assert.deepEqual(project([topic('iam')], tapped).chains, []);

  // And it does not lengthen one that is real either — the run is the two
  // answers somebody marked, not the three taps beside them.
  const mixed = [...tapped, right('iam', 3), right('iam', 10)];
  assert.equal(project([topic('iam')], mixed).chains[0]?.length, 2);
});

test('out-of-order signals chain the same as the sorted ones would', () => {
  // The store makes no ordering promise; a chain that trusted array order
  // would answer differently depending on how the caller happened to hand the
  // signals over, which is not a fact about the learner's recall.
  const sorted = [right('tritone', 2), right('tritone', 5), right('tritone', 12)];
  const shuffled = [sorted[2] as Signal, sorted[0] as Signal, sorted[1] as Signal];

  const a = chainFor(topic('tritone'), sorted, new Date(EPOCH + 13 * DAY)).chain;
  const b = chainFor(topic('tritone'), shuffled, new Date(EPOCH + 13 * DAY)).chain;
  assert.deepEqual(b, a, 'array order is not evidence');
});

test('a chain never crashes and never extends on a farm of hostile signals', () => {
  // The whole attack list in one fixture: same-day repeats (already a demo
  // above), a duplicate of an existing signal by id, an out-of-order arrival,
  // a signal dated after `now`, and a signal whose timestamp does not parse at
  // all. None of it may throw, and none of it may buy the chain a link it did
  // not earn.
  const clean = [right('tritone', 2), right('tritone', 5), right('tritone', 12)];
  const farmed: Signal[] = [
    ...clean,
    clean[1] as Signal,                                           // exact duplicate row
    { ...right('tritone', 12), id: 'future', at: new Date(EPOCH + 90 * DAY).toISOString() },
    { ...right('tritone', 1), id: 'unparseable', at: 'not a timestamp' },
    right('tritone', 30),                                          // out of chronological order
  ];
  const shuffled = [farmed[5] as Signal, farmed[0] as Signal, farmed[4] as Signal,
    farmed[1] as Signal, farmed[3] as Signal, farmed[2] as Signal];

  assert.doesNotThrow(() => chainFor(topic('tritone'), shuffled, new Date(EPOCH + 31 * DAY)));
  const { chain } = chainFor(topic('tritone'), shuffled, new Date(EPOCH + 31 * DAY));
  // Links: day 2, day 5, day 12 (the duplicate lands on the same day as an
  // existing link and cannot add one), day 30, and the future-dated row — five
  // distinct calendar days, at most. A farm cannot buy more than the real
  // calendar days it actually spans.
  assert.ok((chain?.length ?? 0) <= 5, `farmed to length ${chain?.length}`);
});

test('a miss on a farmed ledger still never costs more than the absence of a right one', () => {
  const clean = [right('tritone', 2), right('tritone', 5), right('tritone', 12)];
  const withMiss = [...clean, wrong('tritone', 14),
    { ...wrong('tritone', 1), id: 'bad-at', at: 'whenever' }];
  const without = clean;

  const missed = chainFor(topic('tritone'), withMiss, new Date(EPOCH + 15 * DAY)).chain;
  const clear = chainFor(topic('tritone'), without, new Date(EPOCH + 15 * DAY)).chain;
  assert.equal(missed?.length, clear?.length, 'a wrong answer is never worse than not answering');
  assert.equal(missed?.state, 'held');
});

// ----------------------------------------------------------------- badges

test('the badge set is the four, and adding a fifth is a decision not an accident', () => {
  assert.deepEqual([...BADGE_KINDS],
    ['closure', 'regression-conquered', 'comeback', 'medium-follow-through']);
});

test('closure is the comfort threshold — a topic retired as learned', () => {
  const out = project([topic('iam')], HELD());
  const closure = badges(out.events).find((b) => b.badge === 'closure');
  assert.ok(closure, 'comfort held on enough evidence for the learner model to settle it');
  // Two, not three: closure is dated at the step the model *first* settled it,
  // and the sentence counts what had been demonstrated by then rather than
  // everything that happened afterwards.
  assert.match(closure.evidence, /recalled 2 times/i);
  assert.equal(closure.at, day(7));
});

test('comfort that settled on attendance alone closes nothing', () => {
  /**
   * Found red-first, by the volume fixture below.
   *
   * `section-completed` and `pin-interest` are attendance and attention, and a
   * long enough run of them settles comfort on its own — so closure fired,
   * reading "recalled 0 times, and it held". A volume badge minted by the rule
   * whose entire job is to refuse volume. Closure costs a demonstration now.
   */
  const turnedUp = Array.from({ length: 20 }, (_, i) => sig('busy', 'section-completed', 'positive', i));
  const out = project([topic('busy')], turnedUp, [], new Date(EPOCH + 21 * DAY));

  assert.deepEqual(badges(out.events), []);
  assert.ok(out.skipped.some((s) => s.rule === 'closure' && /nothing ever demonstrated/.test(s.why)));
});

test('pure re-read noise settles comfort on its own and still closes nothing', () => {
  // The same fixture as the section-completed farm above, with the other
  // attendance signal named in the attack list: a learner who re-read a
  // passage twenty times has demonstrated nothing, however settled the
  // arithmetic reads.
  const rereading = Array.from({ length: 20 }, (_, i) => sig('bread', 'reread-confirmed', 'positive', i));
  const out = project([topic('bread')], rereading, [], new Date(EPOCH + 21 * DAY));

  assert.deepEqual(badges(out.events), []);
  assert.deepEqual(out.chains, [], 'no demonstration means no chain either');
  assert.ok(out.skipped.some((s) => s.rule === 'closure' && /nothing ever demonstrated/.test(s.why)));
});

test('a topic the learner retired by hand earns no closure', () => {
  // Deciding you are done with something is your right, and it is not the same
  // as having learned it. This is the one place the rule could have been
  // written to fire more often, and it is the one place it must not be.
  const out = project([topic('iam', { retiredByUser: true })], HELD());

  assert.deepEqual(badges(out.events).filter((b) => b.badge === 'closure'), []);
  assert.ok(out.skipped.some((s) => s.rule === 'closure'));
});

test('the comeback fires when a topic the learner flagged is carried past where it was', () => {
  const flagged = [
    wrong('iam', 0), right('iam', 7), right('iam', 14),
    sig('iam', 'resurface-refresher', 'negative', 15),
    right('iam', 21), right('iam', 28),
  ];
  const comeback = badges(project([topic('iam')], flagged, [], new Date(EPOCH + 29 * DAY)).events)
    .find((b) => b.badge === 'comeback');

  assert.ok(comeback, 'admitting weakness and closing it is the rewarded move');
  assert.match(comeback.evidence, /called this shaky/i);
});

test('asking to go DEEPER is not an admission of weakness and mints no comeback', () => {
  // The two nuances of the resurface mark are opposite statements about the
  // register. A comeback for "teach me more of this" would reward the learner
  // for the opposite of what they said.
  assert.ok(!([...SHAKY_MARK_TYPES] as readonly string[]).includes('resurface-deeper'));

  const deeper = [
    wrong('iam', 0), right('iam', 7), right('iam', 14),
    sig('iam', 'resurface-deeper', 'positive', 15),
    right('iam', 21), right('iam', 28),
  ];
  const out = project([topic('iam')], deeper, [], new Date(EPOCH + 29 * DAY));
  assert.deepEqual(badges(out.events).filter((b) => b.badge === 'comeback'), []);
});

test('a slip re-earned is regression conquered', () => {
  const slipped = [right('slip', 0), right('slip', 5), wrong('slip', 40), right('slip', 45), right('slip', 62)];
  const out = project([topic('slip')], slipped, [], new Date(EPOCH + 63 * DAY));
  const conquered = badges(out.events).find((b) => b.badge === 'regression-conquered');

  assert.ok(conquered, 'the learner had this, lost it, and has it again');
  assert.match(conquered.evidence, /earned it back/i);
});

test('a slip still open is not celebrated, and the refusal is recorded', () => {
  const stillDown = [right('slip', 0), right('slip', 5), wrong('slip', 40)];
  const out = project([topic('slip')], stillDown, [], new Date(EPOCH + 41 * DAY));

  assert.deepEqual(badges(out.events).filter((b) => b.badge === 'regression-conquered'), []);
  assert.ok(out.skipped.some((s) => s.rule === 'regression-conquered'));
});

test('medium follow-through needs the doing, not the reading', () => {
  const warned = session('s1', 3, [section('ear', { mediumWarning: 'You cannot read your way to hearing this.' })]);

  // Finishing the section is not acting on the warning. This is the volume
  // badge trying to get in through the back door, and it does not.
  const readOnly = project([topic('ear')], [sig('ear', 'section-completed', 'positive', 4)], [warned]);
  assert.deepEqual(badges(readOnly.events).filter((b) => b.badge === 'medium-follow-through'), []);
  assert.ok(readOnly.skipped.some((s) => s.rule === 'medium-follow-through'));

  const wentAndDid = project([topic('ear')], [right('ear', 10)], [warned]);
  const badge = badges(wentAndDid.events).find((b) => b.badge === 'medium-follow-through');
  assert.ok(badge, 'the badge nobody else can ship');
  assert.equal(badge.at, day(10), 'awarded at the demonstration, not at the warning');
});

test('a demonstration BEFORE the warning is not follow-through', () => {
  const warned = session('s1', 20, [section('ear', { mediumWarning: 'go and play it' })]);
  const out = project([topic('ear')], [right('ear', 3)], [warned]);
  assert.deepEqual(badges(out.events).filter((b) => b.badge === 'medium-follow-through'), []);
});

// ------------------------------------------------------- the banned mechanics

test('volume earns nothing — the whole of it', () => {
  /**
   * The explicit ban, as a fixture rather than as a comment: pins made,
   * sessions completed, minutes spent. A learner who has turned up sixty times
   * and demonstrated nothing has earned nothing, and that is the design working
   * rather than the design being harsh — volume badges pay for padding, which
   * is the behaviour the Gardener exists to refuse.
   */
  const busy: Signal[] = [];
  const sessions: Session[] = [];
  for (let i = 0; i < 60; i += 1) {
    busy.push(sig('busy', 'section-completed', 'positive', i));
    busy.push(sig('busy', 'pin-interest', 'positive', i));
    sessions.push(session(`s${i}`, i, [section('busy', { completed: true })]));
  }

  const out = project([topic('busy')], busy, sessions, new Date(EPOCH + 61 * DAY));
  assert.deepEqual(out.events, []);
  assert.deepEqual(out.chains, []);
});

test('nothing in the projection is named after a total, a score or a streak', () => {
  // A name is where a volume metric would arrive: `sessionsCompleted` reads as
  // harmless the day somebody adds it, and reads as a leaderboard a month
  // later. The banned words are refused at the surface, in both directions.
  const surface = JSON.stringify(project([topic('iam')], LADDER()));
  for (const banned of ['points', 'score', 'leaderboard', 'total']) {
    assert.ok(!surface.toLowerCase().includes(banned), `the projection exposes "${banned}"`);
  }
});

test('the two words this product may never say do not appear in the source', async () => {
  /**
   * **no day-streaks anywhere in the product** — attendance is not
   * learning. The ban is on the mechanic, but the phrase is how the mechanic
   * arrives: somebody names a variable after it, and a week later something is
   * counting consecutive days.
   *
   * The needle is assembled rather than written out, so this test does not
   * fail on itself — which is the sort of thing that gets a guard deleted
   * instead of fixed.
   */
  const { readdirSync, statSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const needles = [['day', 'streak'].join(' '), ['day', 'streak'].join('-'), ['daily', 'streak'].join(' ')];
  const self = fileURLToPath(import.meta.url).replace('/dist/', '/src/').replace(/\.js$/, '.ts');

  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(ts|js|css|html|json|md)$/.test(p) || p === self) continue;
      const text = readFileSync(p, 'utf8').toLowerCase();
      for (const needle of needles) if (text.includes(needle)) found.push(`${p}: ${needle}`);
    }
  };
  for (const ws of ['core', 'adapters', 'runner', 'extension', 'scripts']) walk(join(root, ws));

  assert.deepEqual(found, [], 'attendance is not learning, and the vocabulary goes with the mechanic');
});

test('the still-shaky tap is a shaky mark, and got-it is not', () => {
  /**
   * The exclusion is the load-bearing half, exactly as it is for
   * `resurface-deeper`: *got it* is the learner saying they have this, and
   * counting it as an admission of weakness would award the comeback for the
   * opposite of what they said.
   */
  const live: readonly string[] = [...SHAKY_MARK_TYPES];
  assert.ok(live.includes('quick-take-still-shaky'),
    'the tap  opens on has to be one of the flags the comeback is measured from');
  assert.ok(!live.includes('quick-take-got-it'),
    'a learner who said they had it has not admitted anything to come back from');
});

test('the comeback is earned from a still-shaky tap at first contact', () => {
  // the product contract's own walkthrough, end to end: the tap goes in on day zero, the
  // learner keeps at it, and the badge fires on the demonstration that takes
  // them past where they were — not on the tap, and not on turning up.
  const flagged = [
    sig('iam', 'quick-take-still-shaky', 'negative', 1),
    sig('iam', 'answer-correct', 'positive', 8),
    sig('iam', 'answer-correct', 'positive', 15),
    sig('iam', 'recall-check', 'positive', 22),
  ];
  const earned = badges(project([topic('iam')], flagged).events);

  assert.ok(earned.some((b) => b.badge === 'comeback'),
    'you called this shaky, kept at it, and came back past where you were');
});

test('got it at first contact mints nothing, however well it goes afterwards', () => {
  const confident = [
    sig('iam', 'quick-take-got-it', 'positive', 1),
    sig('iam', 'answer-correct', 'positive', 8),
    sig('iam', 'answer-correct', 'positive', 15),
    sig('iam', 'recall-check', 'positive', 22),
  ];
  const earned = badges(project([topic('iam')], confident).events);

  assert.ok(!earned.some((b) => b.badge === 'comeback'),
    'there is no comeback from a topic the learner never said they had lost');
});

// ------------------------------------------------- the strip and the awards

test('§5: the strip is at most three, newest first', () => {
  const out = project(
    [topic('a'), topic('b'), topic('c')],
    [...LADDER('a'), ...LADDER('b'), ...LADDER('c')],
  );
  const strip = stripFrom(out);

  assert.ok(strip.length <= STRIP_ITEMS, `strip carried ${strip.length}`);
  const dates = strip.map((e) => e.at);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

test('the compact strip keeps only the newest repeat of one exact milestone move', () => {
  const id = 'web-accessibility';
  const repeatedAdvance = [
    sig(id, 'quick-take-got-it', 'positive', 0),
    right(id, 1),
    wrong(id, 2),
    wrong(id, 3),
    right(id, 4),
  ];
  const out = project([topic(id)], repeatedAdvance);
  const all = milestones(out.events)
    .filter((m) => m.from === 'from-nothing' && m.to === 'building');

  assert.equal(all.length, 2, 'the immutable history retains both real advances');
  const strip = stripFrom(out);
  const shown = milestones(strip)
    .filter((m) => m.topicId === id && m.from === 'from-nothing' && m.to === 'building');
  assert.equal(shown.length, 1, 'one compact What moved strip cannot repeat the same move');
  assert.equal(shown[0]?.at, all[0]?.at, 'the newest evidence owns the visible move');
  assert.equal(shown[0]?.demonstrations, 2, 'the current cumulative evidence wins');
});

test('§5: the strip renders empty as empty and never invents content to fill itself', () => {
  assert.deepEqual(stripFrom(project([topic('quiet')], [])), []);
  assert.deepEqual(stripFrom(project([], [])), []);
});

test('§5: a chain joins the strip only once it is worth mentioning', () => {
  const short = project([topic('a')], [right('a', 26), right('a', 28)], [], NOW);
  assert.equal(short.chains[0]?.length, 2);
  assert.deepEqual(stripFrom(short).filter((e): e is Chain => e.kind === 'chain'), [],
    `below ${NOTABLE_CHAIN} it is a fact about a topic, not momentum`);
});

test('§5: the award moment is session end, and the strip only echoes it', () => {
  const out = project([topic('iam')], LADDER());
  const awarded = awardsForSession(out, day(20));

  assert.ok(awarded.length > 0, 'the night the transition happened is the night it is shown');
  // The law, checked rather than asserted in prose: the strip cannot carry an
  // event the session close would not have shown, because both read one
  // projection rather than each computing their own.
  for (const item of stripFrom(out)) {
    if (item.kind === 'chain') continue;
    assert.ok(out.events.includes(item), 'the strip is an echo, not a second source');
  }
});

test('a session whose build time cannot be read is awarded nothing, not everything', () => {
  // §3a, first class: a check that cannot read its input decides everything is
  // fine. Here that would mean handing a learner their entire history as one
  // night's winnings.
  const out = project([topic('iam')], LADDER());
  assert.deepEqual(awardsForSession(out, 'not a date'), []);
  assert.deepEqual(awardsForSession(out, ''), []);
});

// ------------------------------------------------------------- the replay

test('a withdrawn signal is not evidence of anything, here as everywhere', () => {
  const contested = LADDER().map((s) => s.type === 'answer-correct' ? { ...s, invalidated: true } : s);
  const out = project([topic('iam')], contested);

  assert.deepEqual(out.events, [], ': a conceded marking stops counting, including towards a badge');
  assert.deepEqual(ledgerHistory('iam', contested).map((s) => s.signal.type), ['answer-wrong']);
});

test('a signal with an unreadable timestamp is dropped rather than sorted to the dawn of time', () => {
  const broken = [...LADDER(), sig('iam', 'answer-correct', 'positive', 0, { at: 'whenever' })];
  const history = ledgerHistory('iam', broken);
  assert.ok(history.every((s) => Number.isFinite(Date.parse(s.at))));
  assert.equal(history.length, 4);
});
