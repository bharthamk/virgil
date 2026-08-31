import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyComfort, computeComfort, renderStatements } from '../agents/registrar.js';
import { SIGNAL_WEIGHT } from '../domain/signals.js';
import { registerFor, registerRank } from '../domain/registers.js';
import type { Signal, SignalType, Topic } from '../domain/types.js';
import type { PureDeps } from '../agents/deps.js';
import type { LlmResult } from '../ports/llm.js';

const NOW = new Date('2026-08-19T09:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

let seq = 0;
const sig = (type: SignalType, direction: Signal['direction'], days: number): Signal => ({
  id: `s${seq++}`, topicId: 'T', type, direction,
  at: daysAgo(days), sourceEvent: 'test', invalidated: false,
});

test('no evidence yields low comfort and zero certainty', () => {
  const c = computeComfort('T', [], NOW);
  assert.equal(c.evidenceCount, 0);
  assert.equal(c.certainty, 0);
  assert.ok(c.comfort < 0.3, 'must not assume competence it has not seen');
});

test('correct answers raise comfort; wrong answers lower it', () => {
  const good = computeComfort('T', [
    sig('answer-correct', 'positive', 2),
    sig('answer-correct', 'positive', 5),
  ], NOW);
  const bad = computeComfort('T', [
    sig('answer-wrong', 'negative', 2),
    sig('answer-wrong', 'negative', 5),
  ], NOW);
  assert.ok(good.comfort > 0.9, `expected high, got ${good.comfort}`);
  assert.ok(bad.comfort < 0.1, `expected low, got ${bad.comfort}`);
});

test('self-declared comfort counts for less than a demonstrated answer', () => {
  // Claiming to know it, while actually getting it wrong, must not net out even.
  const c = computeComfort('T', [
    sig('self-skip', 'positive', 1),
    sig('answer-wrong', 'negative', 1),
  ], NOW);
  assert.ok(c.comfort < 0.35,
    `declared comfort must not cancel demonstrated failure, got ${c.comfort}`);
});

// ------------------------------------------- the quick take's two taps

/**
 * *"Both taps are demonstrated signals into the existing ledger — same
 * machinery as every other signal, stronger than declared-only evidence,
 * weaker than repeated demonstrated competence. No new signal type
 * semantics."*
 *
 * That sentence is a position in the weight table and nothing else, so it is
 * asserted as one. The taps are made after reading a real explanation, which is
 * what puts them above `self-skip` — a claim made about material the learner
 * never opened. They are still the learner's own read rather than an answer
 * anybody marked, which is what keeps them below `recall-check`.
 */
test('a quick-take tap outranks a bare skip and is outranked by a marked answer', () => {
  for (const tap of ['quick-take-got-it', 'quick-take-still-shaky'] as const) {
    assert.ok(SIGNAL_WEIGHT[tap] > SIGNAL_WEIGHT['self-skip'],
      `${tap} must count for more than "I know this" about something unread`);
    assert.ok(SIGNAL_WEIGHT[tap] < SIGNAL_WEIGHT['recall-check'],
      `${tap} is the learner's own read, not a demonstration anybody checked`);
  }
  assert.equal(SIGNAL_WEIGHT['quick-take-got-it'], SIGNAL_WEIGHT['quick-take-still-shaky'],
    'the two taps are one instrument — weighting them apart would pay for one answer');
});

test('still shaky biases the register down, and got it does not', () => {
  // UX_SPEC §3: "Still shaky prioritises the topic and biases the register
  // down." The bias is the comfort model doing what it already does, which is
  // the whole point of the product contract's "no new signal type semantics" — so it is
  // measured against the same history with the tap swapped, and nothing else.
  // One right and one wrong: a topic the ledger reads as genuinely mid-ladder,
  // which is where a single tap can and should be the thing that decides.
  const history = [sig('answer-correct', 'positive', 12), sig('answer-wrong', 'negative', 6)];
  const shaky = computeComfort('T', [...history, sig('quick-take-still-shaky', 'negative', 0)], NOW);
  const got = computeComfort('T', [...history, sig('quick-take-got-it', 'positive', 0)], NOW);

  assert.ok(shaky.comfort < got.comfort, `${shaky.comfort} is not below ${got.comfort}`);
  assert.ok(registerRank(registerFor(shaky)) < registerRank(registerFor(got)),
    `the register did not move: ${registerFor(shaky)} vs ${registerFor(got)}`);
});

test('one tap at first contact does not carry a topic on its own', () => {
  // The signal arrives on day zero of a topic, which is exactly when the
  // Composer must still hedge. A single tap that pushed certainty over
  // `registerFor`'s floor would let one tap on one passage speak for a whole
  // topic — and *got it* is the direction where that would cost the learner a
  // section pitched above them.
  const c = computeComfort('T', [sig('quick-take-got-it', 'positive', 0)], NOW);
  assert.equal(c.evidenceCount, 1, 'it is real evidence, not a seed');
  assert.ok(c.certainty < 0.3, `one tap is not knowing them, got ${c.certainty}`);
  assert.equal(registerFor(c), 'from-nothing',
    'the register is where a topic with almost nothing behind it belongs');
});

test('one marked answer starts learning but cannot establish fluency', () => {
  const c = computeComfort('T', [
    sig('quick-take-got-it', 'positive', 0),
    sig('answer-correct', 'positive', 0),
    sig('section-completed', 'positive', 0),
  ], NOW);

  assert.equal(c.comfort, 1, 'the answer can be wholly correct without proving the whole topic');
  assert.equal(c.demonstrationCount, 1);
  assert.equal(registerFor(c), 'building',
    'self-report and attendance beside one answer cannot turn it into repeated competence');
});

test('interview seed decays once real evidence accrues', () => {
  const seedOnly = computeComfort('T', [sig('interview-seed', 'positive', 30)], NOW);
  const withReal = computeComfort('T', [
    sig('interview-seed', 'positive', 30),
    ...Array.from({ length: 8 }, (_, i) => sig('answer-wrong', 'negative', i + 1)),
  ], NOW);
  assert.ok(seedOnly.comfort > 0.9, 'seed alone should be believed at first');
  assert.ok(withReal.comfort < 0.1,
    `behaviour must overrule what the learner said about themselves, got ${withReal.comfort}`);
});

test('regression is detected when solid history is undercut recently', () => {
  const c = computeComfort('T', [
    sig('answer-correct', 'positive', 60),
    sig('answer-correct', 'positive', 50),
    sig('recall-check', 'positive', 40),
    sig('answer-wrong', 'negative', 3),
  ], NOW);
  assert.equal(c.regressed, true);
});

test('a consistently weak topic is not reported as a regression', () => {
  const c = computeComfort('T', [
    sig('answer-wrong', 'negative', 60),
    sig('answer-wrong', 'negative', 40),
    sig('answer-wrong', 'negative', 3),
  ], NOW);
  assert.equal(c.regressed, false, 'never having had it is not losing it');
});

test('recency: an old success does not outweigh a recent failure', () => {
  const c = computeComfort('T', [
    sig('answer-correct', 'positive', 200),
    sig('answer-wrong', 'negative', 1),
  ], NOW);
  assert.ok(c.comfort < 0.4, `stale evidence should fade, got ${c.comfort}`);
});

test('invalidated signals stop counting ( correction path)', () => {
  const signals = [sig('answer-wrong', 'negative', 1), sig('answer-wrong', 'negative', 2)];
  const before = computeComfort('T', signals, NOW);
  const after = computeComfort('T', signals.map((s) => ({ ...s, invalidated: true })), NOW);
  assert.ok(before.comfort < 0.1);
  assert.equal(after.evidenceCount, 0, 'a conceded agent error must not leave a mark on the learner');
});

test('certainty separates "known to be shaky" from "barely any evidence"', () => {
  const thin = computeComfort('T', [sig('pin-interest', 'neutral', 1)], NOW);
  const solid = computeComfort('T', [
    sig('answer-correct', 'positive', 1),
    sig('answer-wrong', 'negative', 2),
    sig('recall-check', 'positive', 3),
  ], NOW);
  assert.ok(thin.certainty < 0.3, `thin evidence, got ${thin.certainty}`);
  assert.ok(solid.certainty > thin.certainty);
});

// ------------------------------------- the statement must reach the evidence

/**
 * `Statement.evidenceSignalIds` was declared, rendered as `[]` on every path,
 * and has been since it was written. The learner-model screen can show a
 * sentence about a person and no sentence can point at what produced it, which
 * is the half of the product contract calls the load-bearing one: *rejecting an
 * observation must reach the evidence, not just hide the sentence. Otherwise it
 * regenerates next week and reads as not listening.*
 *
 * The attribution is a deterministic join in code — the topics a sentence names,
 * and the live signals of those topics — and never a field the model fills in.
 * A model asked to cite its own evidence can write an id as easily as recall
 * one, and a fabricated provenance trail for a claim about a person is worse
 * than none.
 */

const topic = (id: string, label: string): Topic => ({
  id, label, summary: '', pinIds: ['p'], state: 'working', comfort: 0.5,
  lastExposedAt: null, retiredByUser: false, createdAt: daysAgo(30),
});

test('automatic settling requires repeated demonstrated evidence', () => {
  const subject = topic('T', 'Web Accessibility');
  const firstSitting = [
    sig('quick-take-got-it', 'positive', 0),
    sig('answer-correct', 'positive', 0),
    sig('section-completed', 'positive', 0),
  ];
  const afterFirst = applyComfort([subject], firstSitting, NOW)[0];
  assert.equal(afterFirst?.state, 'working');

  const afterSecond = applyComfort(
    [subject], [...firstSitting, sig('recall-check', 'positive', 7)], NOW,
  )[0];
  assert.equal(afterSecond?.state, 'settled', 'a second marked demonstration can close the topic');
});

const forTopic = (topicId: string, id: string, type: SignalType = 'answer-correct'): Signal => ({
  id, topicId, type, direction: 'positive', at: daysAgo(2), sourceEvent: 'test', invalidated: false,
});

const saying = (...statements: string[]): PureDeps => ({
  clock: { now: () => NOW },
  llm: {
    complete: async () => { throw new Error('the registrar does not use complete()'); },
    structured: async <T>(): Promise<LlmResult<T>> => ({
      value: { statements } as T, modelId: 'stub', inputTokens: 0, outputTokens: 0,
    }),
  },
});

test('comfort names the signals it counted, so a statement has something to point at', () => {
  const signals = [forTopic('T', 'sig-1'), forTopic('T', 'sig-2'), forTopic('OTHER', 'sig-3')];
  assert.deepEqual([...computeComfort('T', signals, NOW).evidenceSignalIds], ['sig-1', 'sig-2']);
  assert.deepEqual([...computeComfort('NOBODY', signals, NOW).evidenceSignalIds], [],
    'no evidence names nothing, which is the honest answer and not an empty gesture');
});

test('an invalidated signal is not evidence for anything ( holds here too)', () => {
  const signals = [forTopic('T', 'sig-1'), { ...forTopic('T', 'sig-2'), invalidated: true }];
  assert.deepEqual([...computeComfort('T', signals, NOW).evidenceSignalIds], ['sig-1'],
    'a conceded error stops counting, and stops being cited');
});

test('a statement carries the ids of the signals behind the topic it names', async () => {
  const signals = [forTopic('t1', 'sig-1'), forTopic('t1', 'sig-2')];
  const topics = [topic('t1', 'Firestore indexes')];
  const comforts = topics.map((t) => computeComfort(t.id, signals, NOW));

  const [statement] = await renderStatements(
    saying('You are getting there with Firestore indexes.'), topics, comforts, []);

  assert.deepEqual([...(statement?.evidenceSignalIds ?? [])], ['sig-1', 'sig-2']);
  const ledger = new Set(signals.map((s) => s.id));
  assert.ok((statement?.evidenceSignalIds ?? []).every((id) => ledger.has(id)),
    'every id resolves in the ledger — a reference that resolves to nothing is not evidence');
});

test('a statement that names two topics carries both, once each', async () => {
  const signals = [forTopic('t1', 'sig-1'), forTopic('t2', 'sig-2'), forTopic('t2', 'sig-3')];
  const topics = [topic('t1', 'Firestore indexes'), topic('t2', 'IAM conditions')];
  const comforts = topics.map((t) => computeComfort(t.id, signals, NOW));

  const [statement] = await renderStatements(
    saying('You are steadier on Firestore indexes than on IAM conditions.'), topics, comforts, []);

  assert.deepEqual([...(statement?.evidenceSignalIds ?? [])], ['sig-1', 'sig-2', 'sig-3']);
});

test('a topic with no signals yields a statement with an empty list, and that is honest', async () => {
  // Not papered over. The alternative — attaching the nearest signals we can
  // find — would hand the learner a provenance trail that was written rather
  // than recorded, which is the failure this field exists to prevent.
  const topics = [topic('t1', 'Bread baking')];
  const comforts = topics.map((t) => computeComfort(t.id, [], NOW));

  const [statement] = await renderStatements(
    saying('You have pinned about Bread baking and nothing has been checked yet.'),
    topics, comforts, ['they pin late at night']);

  assert.ok(statement, 'the sentence is still worth showing');
  assert.deepEqual([...(statement?.evidenceSignalIds ?? [])], []);
});

test('an observation about the whole board names no topic and claims no evidence', async () => {
  const signals = [forTopic('t1', 'sig-1')];
  const topics = [topic('t1', 'Firestore indexes')];
  const comforts = topics.map((t) => computeComfort(t.id, signals, NOW));

  const [statement] = await renderStatements(
    saying('You tend to move on before meeting the exceptions.'), topics, comforts, []);

  assert.deepEqual([...(statement?.evidenceSignalIds ?? [])], [],
    'the sentence in the product contract is exactly this shape, and it must not borrow a topic\'s evidence');
});

/**
 * THE TOPIC A SENTENCE IS ABOUT, WRITTEN DOWN.
 *
 * `topicId` was null here, on the only path in the product that writes machine
 * statements, so the field was null on every row a real board has ever held and
 * the comfort-gated `shaky-statement` prospect gap could never fire. The join
 * is the one the Registrar already trusts for evidence, under one extra rule:
 * exactly one topic named, or nothing.
 */

test('a statement about one topic carries that topic', async () => {
  const signals = [forTopic('t1', 'sig-1')];
  const topics = [topic('t1', 'Firestore indexes'), topic('t2', 'IAM conditions')];
  const comforts = topics.map((t) => computeComfort(t.id, signals, NOW));

  const [statement] = await renderStatements(
    saying('You are still shaky on Firestore indexes.'), topics, comforts, []);

  assert.equal(statement?.topicId, 't1');
});

test('a statement about two topics, or about none, keeps null', async () => {
  const signals = [forTopic('t1', 'sig-1'), forTopic('t2', 'sig-2')];
  const topics = [topic('t1', 'Firestore indexes'), topic('t2', 'IAM conditions')];
  const comforts = topics.map((t) => computeComfort(t.id, signals, NOW));

  const [comparison] = await renderStatements(
    saying('You are steadier on Firestore indexes than on IAM conditions.'), topics, comforts, []);
  assert.equal(comparison?.topicId, null,
    'a sentence about the relation between two topics is not a sentence about one of them');

  const [board] = await renderStatements(
    saying('You tend to move on before meeting the exceptions.'), topics, comforts, []);
  assert.equal(board?.topicId, null,
    'a pattern across the board keeps the same honest empty answer the evidence list gives');
});

// ============================ The learner-lineup contract: taste is not evidence about anybody

/**
 * THE LEDGER'S NEW MARKS ARE PREFERENCES, AND THE LEARNER MODEL MUST NOT READ
 * ONE.
 *
 * Three signal types arrived with tonight's lineup: a thumbs up and a thumbs
 * down on the CHOICE, and an X meaning not tonight. All three are the learner
 * looking at a list of subjects nobody has taught them yet and saying which
 * ones they want.
 *
 * If any of them reached the arithmetic below, taste would rewrite the comfort
 * model — which is  failure with the sign flipped. A learner who marked
 * a topic as "not what I need" would be recorded as struggling with it, and one
 * who liked the choice would be recorded as knowing it, both on the strength of
 * a tap made before they read a word.
 *
 * The exclusion is structural: `SIGNAL_WEIGHT` is keyed on
 * `EvidenceSignalType`, so there is no entry for any of them and no `?? 0.1`
 * fallback can invent one. These are the consequences.
 */

const preference = (type: SignalType, direction: Signal['direction']): Signal =>
  sig(type, direction, 1);

test('the weight table has no entry for a lineup mark, and cannot be given one', () => {
  // The compile-time half is the type. This is the runtime shadow of it: if
  // somebody widens the table back to `SignalType`, a preference gets a number
  // and this fails.
  for (const type of ['lineup-good-call', 'lineup-bad-call', 'lineup-not-now']) {
    assert.equal((SIGNAL_WEIGHT as Record<string, number | undefined>)[type], undefined, type);
  }
});

test('a thumbs down on the choice is not evidence that the learner is struggling', () => {
  const before = computeComfort('T', [sig('answer-correct', 'positive', 2)], NOW);
  const after = computeComfort('T', [
    sig('answer-correct', 'positive', 2),
    preference('lineup-bad-call', 'negative'),
  ], NOW);
  assert.equal(after.comfort, before.comfort);
  assert.equal(after.evidenceCount, before.evidenceCount);
  assert.equal(after.certainty, before.certainty);
});

test('a thumbs up on the choice is not evidence that they know it either', () => {
  const before = computeComfort('T', [sig('answer-wrong', 'negative', 2)], NOW);
  const after = computeComfort('T', [
    sig('answer-wrong', 'negative', 2),
    preference('lineup-good-call', 'positive'),
  ], NOW);
  assert.equal(after.comfort, before.comfort);
  assert.equal(after.evidenceCount, before.evidenceCount);
});

test('a board whose only marks are preferences is a board with no evidence at all', () => {
  // The state the copy hangs on. `evidenceCount` of zero is what stops the
  // Gardener saying "you have been struggling with this" about a topic nothing
  // has ever asked a question about, and a tap on a lineup must not buy a
  // learner out of that honesty.
  const c = computeComfort('T', [
    preference('lineup-good-call', 'positive'),
    preference('lineup-bad-call', 'negative'),
    preference('lineup-not-now', 'neutral'),
  ], NOW);
  assert.equal(c.evidenceCount, 0);
  assert.equal(c.certainty, 0);
  assert.equal(c.comfort, 0.15, 'the cold default, not a number computed from taste');
  assert.deepEqual(c.evidenceSignalIds, []);
});

test('a preference cannot be cited as the evidence behind a statement', () => {
  //  contestability. A learner who rejects a sentence about themselves
  // has to be able to reach what produced it; pointing them at a thumbs-down
  // they gave on a running order would be pointing them at nothing.
  const c = computeComfort('T', [
    sig('answer-correct', 'positive', 2),
    preference('lineup-bad-call', 'negative'),
  ], NOW);
  assert.equal(c.evidenceSignalIds.length, 1);
});

test('a preference cannot trigger a regression, which is the loudest thing the model says', () => {
  //  fires on solid history plus a heavy recent negative. A thumbs-down on
  // a choice is the heaviest-looking negative the ledger now carries, and it
  // must never be able to tell somebody they have lost something they had.
  const history: Signal[] = [
    sig('answer-correct', 'positive', 40), sig('answer-correct', 'positive', 35),
    sig('answer-correct', 'positive', 30),
  ];
  assert.equal(computeComfort('T', history, NOW).regressed, false);
  assert.equal(
    computeComfort('T', [...history, preference('lineup-bad-call', 'negative')], NOW).regressed,
    false);
});
