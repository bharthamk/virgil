import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tend, duePool } from '../agents/gardener.js';
import type { Topic, Signal, SignalType } from '../domain/types.js';
import type { ComfortResult } from '../agents/registrar.js';
import { CHOICE_WINDOW_DAYS, NOT_NOW_DAYS } from '../domain/signals.js';

const NOW = new Date('2026-08-19T09:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const topic = (id: string, over: Partial<Topic> = {}): Topic => ({
  id, label: id, summary: '', pinIds: ['p'], state: 'working', comfort: 0.5,
  lastExposedAt: null, retiredByUser: false, createdAt: daysAgo(30), ...over,
});
const comfort = (topicId: string, over: Partial<ComfortResult> = {}): ComfortResult => ({
  topicId, comfort: 0.5, regressed: false, evidenceCount: 3, demonstrationCount: 2,
  certainty: 0.8, evidenceSignalIds: [], ...over,
});
let n = 0;
const sig = (topicId: string, type: SignalType, direction: Signal['direction'], days: number): Signal => ({
  id: `s${n++}`, topicId, type, direction, at: daysAgo(days), sourceEvent: 't', invalidated: false,
});

test('a struggling topic that has never been taught is taught, not reviewed', () => {
  // Regression test: daysSince(null) is Infinity, which read as maximally
  // overdue and demoted the learner's worst topic below one with no evidence.
  const t = topic('iam', { comfort: 0, lastExposedAt: null });
  const [d] = tend({
    topics: [t],
    comforts: [comfort('iam', { comfort: 0, certainty: 1 })],
    signals: [sig('iam', 'answer-wrong', 'negative', 20), sig('iam', 'answer-wrong', 'negative', 10)],
    now: NOW,
  });
  assert.equal(d?.disposition, 'teach');
});

/**
 * A STRUGGLE IS A CLAIM, AND IT NEEDS EVIDENCE TO MAKE IT.
 *
 * `computeComfort` returns 0.15 for a topic with no recorded evidence. The
 * threshold must not interpret that cold default as a measured struggle.
 */
test('a topic with no evidence is not accused of being a struggle', () => {
  const [d] = tend({
    topics: [topic('os-exec', { createdAt: daysAgo(2) })],
    comforts: [comfort('os-exec', {
      comfort: 0.15, evidenceCount: 0, demonstrationCount: 0, certainty: 0,
    })],
    signals: [], now: NOW,
  });
  assert.equal(d?.disposition, 'teach', 'it is still the thing to teach');
  assert.equal(d?.reason, 'nothing has been asked about this yet');
  // The priority was never the part that was lying: an unmet topic is still
  // taught early, and this is what stops the honesty fix becoming a demotion.
  assert.equal(d?.priority, Math.round(80 - 0.15 * 50));
});

test('a struggle with evidence behind it is still called one', () => {
  const [d] = tend({
    topics: [topic('iam')],
    comforts: [comfort('iam', { comfort: 0.2, evidenceCount: 3, certainty: 0.8 })],
    signals: [sig('iam', 'answer-wrong', 'negative', 3)], now: NOW,
  });
  assert.equal(d?.reason, 'you have been struggling with this');
});

test('the worst-understood topic outranks one with no evidence at all', () => {
  const decisions = tend({
    topics: [topic('iam', { comfort: 0 }), topic('bread', { comfort: 0.15 })],
    comforts: [
      comfort('iam', { comfort: 0, certainty: 1, evidenceCount: 5 }),
      comfort('bread', { comfort: 0.15, certainty: 0, evidenceCount: 0, demonstrationCount: 0 }),
    ],
    signals: [sig('iam', 'answer-wrong', 'negative', 5)],
    now: NOW,
  });
  const pool = duePool(decisions);
  assert.equal(pool.teach[0]?.topicId, 'iam', 'struggle is the point; it must lead');
});

test('regression outranks everything', () => {
  const decisions = tend({
    topics: [topic('a', { comfort: 0 }), topic('b', { comfort: 0.7 })],
    comforts: [comfort('a', { comfort: 0 }), comfort('b', { comfort: 0.7, regressed: true })],
    signals: [], now: NOW,
  });
  assert.equal(duePool(decisions).teach[0]?.topicId, 'b');
});

test('a pinned topic left untouched for a month is offered for retirement, not dropped', () => {
  const [d] = tend({
    topics: [topic('old', { createdAt: daysAgo(40), lastExposedAt: null })],
    comforts: [comfort('old', { evidenceCount: 0, demonstrationCount: 0, certainty: 0 })],
    signals: [], now: NOW,
  });
  assert.equal(d?.disposition, 'offer-retire');
  assert.match(d?.reason ?? '', /pinned \d+ days ago/);
});

test("the learner's own retirement wins over anything derived", () => {
  const [d] = tend({
    topics: [topic('r', { retiredByUser: true, comfort: 0 })],
    comforts: [comfort('r', { comfort: 0, regressed: true })],
    signals: [], now: NOW,
  });
  assert.equal(d?.disposition, 'hold');
});

test('too little to teach reports insufficient rather than padding', () => {
  const pool = duePool(tend({
    topics: [topic('only', { comfort: 0.9 })],
    comforts: [comfort('only', { comfort: 0.9, certainty: 0.9 })],
    signals: [], now: NOW,
  }));
  assert.equal(pool.enough, false);
});

// -------------------------------------------- the fallback is an OFFER

/**
 * `Pool.fallback` was computed correctly and read by nobody, which is the worst
 * of the three states a field can be in: the panel said "Nothing ready yet" on a
 * night when the product contract promises "a 5-minute refresh on two things from last
 * week". These tests fix what the pool must hand the Composer for that offer to
 * be composable at all.
 */

const settled = (id: string) => ({
  topic: topic(id, { comfort: 0.9, lastExposedAt: daysAgo(7) }),
  comfort: comfort(id, { comfort: 0.9, certainty: 0.9 }),
});

test('a night with nothing new to teach offers a refresh, not nothing', () => {
  const a = settled('firestore');
  const b = settled('iam');
  const pool = duePool(tend({
    topics: [a.topic, b.topic], comforts: [a.comfort, b.comfort], signals: [], now: NOW,
  }));

  assert.equal(pool.enough, false, 'absorbed material is not owed a lesson');
  assert.equal(pool.fallback, 'revision');
  assert.deepEqual(pool.revise.map((d) => d.topicId), ['firestore', 'iam'],
    'and the offer has something concrete behind it, which is what made it an offer');
});

test('the refresh is two things, and what is due leads what is absorbed', () => {
  const due = topic('pubsub', { comfort: 0.5, lastExposedAt: daysAgo(10) });
  const a = settled('firestore');
  const b = settled('iam');
  const pool = duePool(tend({
    topics: [due, a.topic, b.topic],
    comforts: [comfort('pubsub', { comfort: 0.5 }), a.comfort, b.comfort],
    signals: [sig('pubsub', 'answer-correct', 'positive', 12)],
    now: NOW,
  }));

  assert.equal(pool.fallback, 'revision');
  assert.equal(pool.revise.length, 2, 'the product contract says two things, not the whole shelf');
  assert.equal(pool.revise[0]?.disposition, 'review', 'due for a check outranks absorbed');
});

test('a retired topic is never revision material either', () => {
  //  is honoured on this path as on every other. A refresh built from
  // something the learner explicitly dropped is worse than no refresh.
  const a = settled('firestore');
  const pool = duePool(tend({
    topics: [topic('dropped', { retiredByUser: true, comfort: 0.9 }), a.topic],
    comforts: [comfort('dropped', { comfort: 0.9, certainty: 0.9 }), a.comfort],
    signals: [], now: NOW,
  }));

  assert.deepEqual(pool.revise.map((d) => d.topicId), ['firestore']);
});

test('one genuinely new topic is still taught, not replaced by a refresh', () => {
  // The fallback replaces nothing. Dropping the learner's new material in
  // favour of revision is the same failure as padding, in the other direction.
  const a = settled('firestore');
  const pool = duePool(tend({
    topics: [topic('new', { comfort: 0.15, createdAt: daysAgo(1) }), a.topic],
    comforts: [comfort('new', { comfort: 0.15, evidenceCount: 1, certainty: 0.2 }), a.comfort],
    signals: [], now: NOW,
  }));

  assert.equal(pool.enough, false);
  assert.equal(pool.fallback, null, 'there IS something new; it gets taught');
  assert.deepEqual(pool.teach.map((d) => d.topicId), ['new']);
});

test('nothing to teach and nothing to refresh stays an honest empty state', () => {
  const pool = duePool(tend({
    topics: [topic('abandoned', { createdAt: daysAgo(40), lastExposedAt: null })],
    comforts: [comfort('abandoned', { evidenceCount: 0, demonstrationCount: 0, certainty: 0 })],
    signals: [], now: NOW,
  }));

  assert.equal(pool.enough, false);
  assert.deepEqual([...pool.revise], [], 'a topic pinned and never opened is not revision');
  assert.equal(pool.fallback, null, 'and the panel is right to say there is nothing');
});

// -------------------------------------------------- the resurface mark

/**
 * "I'm done for now but not done."
 *
 * the product contract asks for two things the Gardener owns: the mark feeds the existing
 * decay/review machinery *with a stronger prior* — the learner's own read
 * outranks inferred decay — and the resurface must **cite the mark when it
 * fires**, so the learner sees the product kept the promise. A mark that only
 * appeared in a list on the panel would be a note to self, not a signal.
 */
test('a topic the learner asked to come back to is resurfaced, not merely taught', () => {
  const [d] = tend({
    topics: [topic('indexes', { comfort: 0.5, lastExposedAt: daysAgo(3) })],
    comforts: [comfort('indexes')],
    signals: [sig('indexes', 'resurface-deeper', 'positive', 2)],
    now: NOW,
  });
  assert.equal(d?.disposition, 'resurface');
  assert.match(d?.reason ?? '', /you asked/, 'the mark is cited when it fires');
});

test('the learner\'s ask outranks a regression and every ordinary teach', () => {
  const decisions = tend({
    topics: [
      topic('asked', { comfort: 0.5, lastExposedAt: daysAgo(3) }),
      topic('struggling', { comfort: 0 }),
      topic('slipped', { comfort: 0.7 }),
    ],
    comforts: [comfort('asked'), comfort('struggling', { comfort: 0, certainty: 1 }), comfort('slipped', { regressed: true })],
    signals: [sig('asked', 'resurface-refresher', 'negative', 1)],
    now: NOW,
  });
  const order = duePool(decisions).teach.map((d) => d.topicId);
  assert.deepEqual(order, ['asked', 'slipped', 'struggling'],
    'what the learner asked for outranks what the product inferred');
});

test('an explicit ask owns the reason even when the same topic has regressed', () => {
  const [decision] = tend({
    topics: [topic('asked', { comfort: 0.7, lastExposedAt: daysAgo(3) })],
    comforts: [comfort('asked', { comfort: 0.4, regressed: true })],
    signals: [sig('asked', 'quick-take-still-shaky', 'negative', 1)],
    now: NOW,
  });
  assert.equal(decision?.priority, 110);
  assert.match(decision?.reason ?? '', /you said this one was still shaky/,
    'the lesson cites the learner, not the inference that followed from their answer');
});

test('a mark from before the topic was last taught has already been answered', () => {
  // The promise is "resurface it later", and later happened. Leaving the mark
  // standing would resurface the same section every night for ever, which is
  // the nag  is careful not to be.
  const [d] = tend({
    topics: [topic('indexes', { comfort: 0.5, lastExposedAt: daysAgo(1) })],
    comforts: [comfort('indexes')],
    signals: [sig('indexes', 'resurface-deeper', 'positive', 5)],
    now: NOW,
  });
  assert.notEqual(d?.disposition, 'resurface');
});

test('a mark the learner took back does not resurface anything', () => {
  const withdrawn = { ...sig('indexes', 'resurface-deeper', 'positive', 2), invalidated: true };
  const [d] = tend({
    topics: [topic('indexes', { comfort: 0.5, lastExposedAt: daysAgo(3) })],
    comforts: [comfort('indexes')],
    signals: [withdrawn],
    now: NOW,
  });
  assert.notEqual(d?.disposition, 'resurface');
});

// ------------------------------------------ the still-shaky tap

/**
 * *"This run, the IAM topic is prioritised and its register biased down."*
 *
 * The register half is the comfort model's and is asserted in
 * `registrar.test.ts`. The priority half is this agent's, and it is the same
 * shape as  mark: the learner has told the product, in one tap, that
 * they are not there yet. So it joins the marks that resurface rather than
 * getting a mechanic of its own — and it cites itself when it fires, because a
 * topic that comes back without saying why is indistinguishable from decay.
 */
test('a still-shaky tap brings the topic back, and the session says whose idea it was', () => {
  const [d] = tend({
    topics: [topic('iam', { comfort: 0.5, lastExposedAt: daysAgo(3) })],
    comforts: [comfort('iam')],
    signals: [sig('iam', 'quick-take-still-shaky', 'negative', 2)],
    now: NOW,
  });
  assert.equal(d?.disposition, 'resurface');
  assert.match(d?.reason ?? '', /still shaky/i, 'the tap is cited when it fires');
});

test('got it is not a request to come back — it is the opposite', () => {
  // The nightly still decides what to do with the topic; what it must not do
  // is treat "I have this" as the learner asking for it back. That would make
  // the honest answer the one that buys you more of the same material.
  const [d] = tend({
    topics: [topic('iam', { comfort: 0.5, lastExposedAt: daysAgo(3) })],
    comforts: [comfort('iam')],
    signals: [sig('iam', 'quick-take-got-it', 'positive', 2)],
    now: NOW,
  });
  assert.notEqual(d?.disposition, 'resurface');
});

test('the learner retiring a topic still wins over their own older mark', () => {
  const [d] = tend({
    topics: [topic('indexes', { retiredByUser: true, lastExposedAt: daysAgo(3) })],
    comforts: [comfort('indexes')],
    signals: [sig('indexes', 'resurface-deeper', 'positive', 2)],
    now: NOW,
  });
  assert.equal(d?.disposition, 'hold');
});

// ================================ The learner-lineup contract: the lineup feeds the ranking

/**
 * THE LOOP, CLOSED, AND PROVED WITHOUT A MODEL ANYWHERE NEAR IT.
 *
 * A control that records a preference nothing reads is worse than
 * no control: it is a promise the product cannot keep, made in the one place
 * the learner is most likely to check.
 *
 * So these are the acceptance tests for that clause, written against the real
 * `tend`. The second thing they hold is that the algorithm stayed an algorithm:
 * every function here is arithmetic over topics and signals, and `tend` takes
 * no `deps` and can reach no model.
 */

/** Two topics the ranker cannot tell apart. Whatever separates them afterwards
 *  is the thing under test and nothing else. */
const twins = (signals: readonly Signal[] = []) => tend({
  topics: [topic('left'), topic('right')],
  comforts: [comfort('left', { comfort: 0.5 }), comfort('right', { comfort: 0.5 })],
  signals, now: NOW,
});

const priorityOf = (decisions: readonly { topicId: string; priority: number }[], id: string): number =>
  decisions.find((d) => d.topicId === id)?.priority ?? -1;

test('two otherwise-equal topics rank equally, which is what makes the rest of this file mean anything', () => {
  const decisions = twins();
  assert.equal(priorityOf(decisions, 'left'), priorityOf(decisions, 'right'));
});

test('a bad call sinks a topic below an otherwise-equal peer on the next run', () => {
  const decisions = twins([sig('left', 'lineup-bad-call', 'negative', 1)]);
  assert.ok(priorityOf(decisions, 'left') < priorityOf(decisions, 'right'),
    'the thing the learner said was not what they needed is taught later');
  // Still IN the pool. A preference reorders what is taught; it does not decide
  // what is teachable, which is what the X is for.
  assert.equal(decisions.find((d) => d.topicId === 'left')?.disposition, 'teach');
});

test('a good call lifts it above the same peer', () => {
  const decisions = twins([sig('left', 'lineup-good-call', 'positive', 1)]);
  assert.ok(priorityOf(decisions, 'left') > priorityOf(decisions, 'right'));
});

test('taste is bounded: four thumbs down say what one thumbs down says', () => {
  const one = twins([sig('left', 'lineup-bad-call', 'negative', 1)]);
  const four = twins([
    sig('left', 'lineup-bad-call', 'negative', 4), sig('left', 'lineup-bad-call', 'negative', 3),
    sig('left', 'lineup-bad-call', 'negative', 2), sig('left', 'lineup-bad-call', 'negative', 1),
  ]);
  assert.equal(priorityOf(four, 'left'), priorityOf(one, 'left'),
    'unbounded taste would eventually beat the evidence, and the product would teach what is comfortable');
});

test('a verdict on a lineup from two months ago is a verdict on a different board', () => {
  const decisions = twins([sig('left', 'lineup-bad-call', 'negative', CHOICE_WINDOW_DAYS + 1)]);
  assert.equal(priorityOf(decisions, 'left'), priorityOf(decisions, 'right'));
});

test('a withdrawn verdict stops steering, like every other withdrawn signal', () => {
  const stale = sig('left', 'lineup-bad-call', 'negative', 1);
  const decisions = twins([{ ...stale, invalidated: true }]);
  assert.equal(priorityOf(decisions, 'left'), priorityOf(decisions, 'right'));
});

test('taking something out of a lineup holds it out of selection for its window', () => {
  const decisions = tend({
    topics: [topic('iam')],
    comforts: [comfort('iam', { comfort: 0.2 })],
    signals: [sig('iam', 'lineup-not-now', 'neutral', 1)],
    now: NOW,
  });
  assert.equal(decisions[0]?.disposition, 'hold');
  assert.equal(decisions[0]?.priority, 0);
  // And the reason says when it comes back, because the panel promised a date.
  assert.match(decisions[0]?.reason ?? '', /back in 6 days/);
  // Held means out of the pool, not merely last in it.
  assert.equal(duePool(decisions).teach.length, 0);
});

test('and the hold expires, which is the whole difference between not now and never', () => {
  const decisions = tend({
    topics: [topic('iam')],
    comforts: [comfort('iam', { comfort: 0.2 })],
    signals: [sig('iam', 'lineup-not-now', 'neutral', NOT_NOW_DAYS + 1)],
    now: NOW,
  });
  assert.equal(decisions[0]?.disposition, 'teach');
  assert.equal(duePool(decisions).teach.length, 1);
});

test('a second X extends the window rather than starting a second one', () => {
  const decisions = tend({
    topics: [topic('iam')],
    comforts: [comfort('iam', { comfort: 0.2 })],
    signals: [
      sig('iam', 'lineup-not-now', 'neutral', NOT_NOW_DAYS + 2),
      sig('iam', 'lineup-not-now', 'neutral', 1),
    ],
    now: NOW,
  });
  assert.equal(decisions[0]?.disposition, 'hold', 'the newest mark is the one that counts');
});

test('a removal outranks a regression, because one of them is a person speaking', () => {
  //  puts a regression above everything derived, and it stays there. This
  // is not derived: the learner looked at the topic and said not tonight, which
  // is the same KIND of statement as retiring it and differs only in expiring.
  const decisions = tend({
    topics: [topic('iam')],
    comforts: [comfort('iam', { comfort: 0.7, regressed: true })],
    signals: [sig('iam', 'lineup-not-now', 'neutral', 1)],
    now: NOW,
  });
  assert.equal(decisions[0]?.disposition, 'hold');
});

test('the removal is not retirement: the topic is never dropped, only delayed', () => {
  //  law. The board must never quietly lose something somebody chose to
  // keep, and a one-tap "not tonight" that became a deletion would do exactly
  // that. `retiredByUser` is the control that means never, and it has no expiry.
  const held = tend({
    topics: [topic('iam')],
    comforts: [comfort('iam')],
    signals: [sig('iam', 'lineup-not-now', 'neutral', 1)],
    now: NOW,
  });
  assert.notEqual(held[0]?.reason, 'retired by you');
  assert.match(held[0]?.reason ?? '', /you took this out of a lineup/);
});

test('a topic taken out of a lineup yesterday comes back tomorrow, said as tomorrow', () => {
  const decisions = tend({
    topics: [topic('iam')],
    comforts: [comfort('iam')],
    signals: [sig('iam', 'lineup-not-now', 'neutral', NOT_NOW_DAYS - 0.5)],
    now: NOW,
  });
  assert.equal(decisions[0]?.reason, 'you took this out of a lineup, so it is back tomorrow');
});

test('the lineup marks never touch the comfort model, only the order', () => {
  /**
   * The property the whole design rests on, asserted from the Gardener's side.
   *
   * A thumbs-down is the learner saying *not this*. Reading it as *I am bad at
   * this* would be the product inferring ability from taste, which is
   * failure with the sign flipped. `domain/signals.ts` makes it impossible by
   * type; this checks the consequence, which is that the REASON a topic is
   * taught never changes because somebody voted on it.
   */
  const plain = tend({
    topics: [topic('iam')], comforts: [comfort('iam', { comfort: 0.2 })],
    signals: [], now: NOW,
  });
  const voted = tend({
    topics: [topic('iam')], comforts: [comfort('iam', { comfort: 0.2 })],
    signals: [sig('iam', 'lineup-bad-call', 'negative', 1)], now: NOW,
  });
  assert.equal(plain[0]?.reason, voted[0]?.reason);
  assert.equal(plain[0]?.disposition, voted[0]?.disposition);
  assert.notEqual(plain[0]?.priority, voted[0]?.priority, 'only the order moved');
});
