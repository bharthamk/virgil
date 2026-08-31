import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseNextAction,
  quickTakeMaterialKey,
  type NextActionInput, type CourseIntakeDraft, type Commitment, type Course,
  type LearningOutcome, type Pin, type Session, type Topic, type TopicComfortRead,
} from '../index.js';

const NOW = new Date('2026-08-23T10:00:00.000Z');
const input = (over: Partial<NextActionInput> = {}): NextActionInput => ({
  now: NOW, availableMinutes: 5, drafts: [], commitments: [], courses: [],
  outcomes: [], topics: [], pins: [], signals: [], topicDecisions: [], session: null, ...over,
});
const commitment = (over: Partial<Commitment> = {}): Commitment => ({
  id: 'c1', title: 'Architecture report', kind: 'assignment', courseId: 'k1', topicIds: ['t1'],
  dueAt: '2026-08-25T23:59:00.000Z', plannedFor: null, estimateMinutes: 5,
  notes: '', doneAt: null, createdAt: NOW.toISOString(), ...over,
});
const topic = (over: Partial<Topic> = {}): Topic => ({
  id: 't1', label: 'Agent boundaries', summary: '', pinIds: ['p1'], state: 'working',
  comfort: 0.4, lastExposedAt: null, retiredByUser: false, createdAt: NOW.toISOString(), ...over,
});
const pin = (over: Partial<Pin> = {}): Pin => ({
  id: 'p1', type: 'interest', note: null, label: 'Agent boundaries',
  capturedAt: NOW.toISOString(), fromSuggestion: false, enrichment: null, topicId: 't1',
  envelope: {
    selection: 'An agent boundary keeps authority explicit by separating what a worker may decide, change, and hand back to its owner during one delegated task without inheriting broader control.', parts: [],
    surroundingText: 'An agent boundary keeps authority explicit by separating what a worker may decide, change, and hand back to its owner during one delegated task without inheriting broader control.', headingPath: ['Architecture'],
    pageTitle: 'Agent systems', url: 'https://example.test/agents', canonicalUrl: null,
    siteName: null, contentLanguage: 'en', media: null,
  },
  ...over,
});
const activeDecision = (over: Partial<NextActionInput['topicDecisions'][number]> = {}) => ({
  topicId: 't1', disposition: 'teach', reason: 'ready from your saved source', priority: 10,
  ...over,
});
const session = (over: Partial<Session> = {}): Session => ({
  id: 's1', builtAt: NOW.toISOString(), fromPinCount: 1, targetMinutes: 5,
  estimatedMinutes: 5, currentSectionIndex: 0, closingNote: null,
  sections: [{
    topicId: 't1', heading: 'Agent boundaries', body: 'Lesson', depth: 'building',
    estimatedMinutes: 5, question: null, sourceIds: ['p1'], completed: false,
  }], ...over,
});
const outcome = (over: Partial<LearningOutcome> = {}): LearningOutcome => ({
  id: 'o1', kind: 'rubric', courseId: 'k1', commitmentId: 'c0', topicIds: ['t1'],
  title: 'Report result', score: 4, maxScore: 10, summary: 'Gap', feedback: '', criteria: [],
  source: null, recordedAt: NOW.toISOString(), supersedesId: null, deletedAt: null, ...over,
});
const course = (over: Partial<Course> = {}): Course => ({
  id: 'k1', title: 'Applied Agent Systems', provider: '', url: '', topicIds: [],
  material: [{
    id: 'm1', title: 'Agent lecture', url: 'https://example.test/lecture', kind: 'class',
    minutes: 25, doneAt: null, pinIds: [], addedAt: NOW.toISOString(),
  }],
  archivedAt: null, createdAt: NOW.toISOString(), ...over,
});

test('one unresolved blocking question outranks a plan built on a guess', () => {
  const draft = {
    id: 'd1', status: 'draft', title: 'Course', provider: '', url: '', objectives: [], material: [], commitments: [],
    source: { id: 'src', kind: 'syllabus', title: 'S', text: 'x', url: null, capturedAt: NOW.toISOString(), digest: 'sha256:x' },
    questions: [{ id: 'q1', field: 'commitments.0.dueAt', prompt: 'Which September date?', source: null, blocking: true, resolvedAt: null }],
    warnings: [], createdAt: NOW.toISOString(), appliedAt: null,
  } as CourseIntakeDraft;
  const decision = chooseNextAction(input({ drafts: [draft], commitments: [commitment()] }));
  assert.equal(decision.primary.kind, 'clarify-intake');
  assert.equal(decision.primary.detail, 'Which September date?');
});

test('a due commitment wins when there is no better prepared intervention', () => {
  const decision = chooseNextAction(input({ commitments: [commitment()] }));
  assert.equal(decision.primary.kind, 'commitment');
  assert.match(decision.primary.reasons[0]!.text, /due in 2 days/i);
});

test('a whole commitment identifies the work without repeating a storage date', () => {
  const c = course();
  const decision = chooseNextAction(input({
    commitments: [commitment({ topicIds: [] })],
    courses: [{
      ...c,
      material: c.material.map((material) => ({ ...material, doneAt: NOW.toISOString() })),
    }],
  }));
  assert.equal(decision.primary.kind, 'commitment');
  assert.equal(decision.primary.detail, 'Assignment · Applied Agent Systems.');
  assert.doesNotMatch(decision.primary.detail, /\b\d{4}-\d{2}-\d{2}\b/);
  assert.equal(decision.primary.reasons[0]?.text, 'This is due in 2 days.');
});

test('Today retains the wall time and zone of an exact deadline', () => {
  const due = commitment({
    title: 'Studio report', dueAt: '2026-08-24T07:00:00.000Z',
    dueTime: '17:00', dueTimeZone: 'Australia/Sydney',
  });
  const chosen = chooseNextAction(input({
    now: new Date('2026-08-23T10:00:00.000Z'), commitments: [due],
  }));
  assert.match(chosen.primary.reasons[0]?.text ?? '',
    /due in 1 day at 5:00 pm Australia\/Sydney/);
});

test('a verified lesson tied to both a deadline and assessed gap can beat generic assignment work', () => {
  const decision = chooseNextAction(input({
    commitments: [commitment({ dueAt: '2026-08-29T23:59:00.000Z' })],
    session: session(), outcomes: [outcome()], topics: [topic()],
  }));
  assert.equal(decision.primary.kind, 'session');
  assert.deepEqual(decision.primary.reasons.slice(0, 2).map((r) => r.code), ['assessed-gap', 'deadline']);
});

/**
 * THE SESSION LEADS WHEN THERE IS ONE.
 *
 * The arrival page's primary action once opened a list, while the session room
 * was reachable from no screen at all. Every commitment ranked above the lesson
 * that prepared its topics, so the more urgent somebody's week was, the further
 * the product moved them from the work.
 */
test('a lesson that is ready leads even a piece of work that is late', () => {
  const decision = chooseNextAction(input({
    commitments: [commitment({ dueAt: '2026-08-20T23:59:00.000Z' })],
    session: session(), topics: [topic()],
  }));
  assert.equal(decision.primary.kind, 'session');
  assert.equal(decision.primary.destination, 'session');
  // And the late thing has not been hidden: it is the alternative under it.
  assert.equal(decision.alternatives[0]!.kind, 'commitment');
});

test('a checked 5.2-minute lesson still leads the five-minute window it was composed for', () => {
  const decision = chooseNextAction(input({
    session: session({
      estimatedMinutes: 5.2,
      sections: [{
        topicId: 't1', heading: 'Agent boundaries', body: 'Lesson', depth: 'building',
        estimatedMinutes: 5.2, question: null, sourceIds: ['p1'], completed: false,
      }],
    }),
    topics: [topic()],
  }));
  assert.equal(decision.primary.kind, 'session',
    'the whole-minute lesson UI said five while the ranker silently treated 5.2 as too long');
  assert.equal(decision.primary.minutes, 5);
});

test('a section that displays as six minutes is still excluded from a five-minute window', () => {
  const decision = chooseNextAction(input({
    session: session({
      sections: [{
        topicId: 't1', heading: 'Agent boundaries', body: 'Lesson', depth: 'building',
        estimatedMinutes: 5.6, question: null, sourceIds: ['p1'], completed: false,
      }],
    }),
    topics: [topic()],
  }));
  assert.notEqual(decision.primary.kind, 'session');
});

test('a populated board sends an unbuilt lesson to Pending when no prepared section fits', () => {
  const decision = chooseNextAction(input({
    availableMinutes: 3,
    session: session({
      estimatedMinutes: 11,
      sections: [
        { topicId: 't1', heading: 'Agent boundaries', body: 'First', depth: 'building',
          estimatedMinutes: 5.2, question: null, sourceIds: ['p1'], completed: false },
        { topicId: 't2', heading: 'Delegation', body: 'Second', depth: 'building',
          estimatedMinutes: 5.8, question: null, sourceIds: ['p2'], completed: false },
      ],
    }),
    topics: [topic()], pins: [pin()], topicDecisions: [activeDecision()],
  }));
  assert.equal(decision.primary.kind, 'quick-take');
  assert.equal(decision.primary.destination, 'board');
  assert.equal(decision.primary.cta, 'See Pending');
  assert.equal(decision.primary.targetId, 'p1');
  assert.equal(decision.primary.minutes, 3);
  assert.match(decision.primary.title, /pending/i);
});

test('the one-minute choice shapes the source-backed take to one minute', () => {
  const decision = chooseNextAction(input({
    availableMinutes: 1,
    session: session(), topics: [topic()], pins: [pin()],
    topicDecisions: [activeDecision()],
  }));
  assert.equal(decision.primary.kind, 'quick-take');
  assert.equal(decision.primary.minutes, 1);
  assert.equal(decision.primary.destination, 'board');
});

test('a thin source is offered only at the smaller window it can support', () => {
  const base = pin();
  const economics = 'Comparative advantage depends on lower opportunity cost rather than absolute productivity, allowing specialisation to benefit both parties.';
  const decision = chooseNextAction(input({
    availableMinutes: 3,
    topics: [topic()],
    pins: [pin({
      envelope: { ...base.envelope, selection: economics, surroundingText: economics },
    })],
    topicDecisions: [activeDecision()],
  }));
  assert.equal(decision.primary.kind, 'quick-take');
  assert.equal(decision.primary.minutes, 1);
  assert.equal(decision.primary.destination, 'board');
});

test('a source-bound failure suppresses the same offer but leaves a safer shorter one', () => {
  const base = pin();
  const failed = pin({
    quickTakeFailure: {
      materialKey: quickTakeMaterialKey(base.envelope.selection ?? ''),
      register: 'from-nothing', minutes: 3, reason: 'verifier-defect',
      attemptedAt: NOW.toISOString(),
    },
  });
  const decision = chooseNextAction(input({
    availableMinutes: 3, topics: [topic()], pins: [failed],
    topicDecisions: [activeDecision()],
  }));
  assert.equal(decision.primary.kind, 'quick-take');
  assert.equal(decision.primary.minutes, 1);
});

test('a five-minute window exposes only the prepared section that fits', () => {
  const decision = chooseNextAction(input({
    availableMinutes: 5,
    session: session({
      estimatedMinutes: 11,
      sections: [
        { topicId: 't1', heading: 'Agent boundaries', body: 'First', depth: 'building',
          estimatedMinutes: 5.2, question: null, sourceIds: ['p1'], completed: false },
        { topicId: 't2', heading: 'Delegation', body: 'Second', depth: 'building',
          estimatedMinutes: 5.8, question: null, sourceIds: ['p2'], completed: false },
      ],
    }),
    topics: [topic()],
  }));
  assert.equal(decision.primary.kind, 'session');
  assert.equal(decision.primary.minutes, 5);
  assert.deepEqual(decision.primary.sessionTopicIds, ['t1']);
});

test('a whole prepared session names every section it exposes', () => {
  const decision = chooseNextAction(input({
    availableMinutes: 5,
    session: session({
      sections: [
        { topicId: 't1', heading: 'Agent boundaries', body: 'First', depth: 'building',
          estimatedMinutes: 2, question: null, sourceIds: ['p1'], completed: false },
        { topicId: 't2', heading: 'Delegation', body: 'Second', depth: 'building',
          estimatedMinutes: 3, question: null, sourceIds: ['p2'], completed: false },
      ],
    }),
    topics: [topic()],
  }));
  assert.equal(decision.primary.kind, 'session');
  assert.deepEqual(decision.primary.sessionTopicIds, ['t1', 't2']);
});

test('closing a quick take prevents an immediate repeat without calling the board empty', () => {
  const decision = chooseNextAction(input({
    availableMinutes: 3,
    topics: [topic()], pins: [pin()], topicDecisions: [activeDecision()],
    signals: [{
      id: 'sig-1', topicId: 't1', type: 'quick-take-got-it', direction: 'positive',
      at: NOW.toISOString(), sourceEvent: 'quick-take:p1', invalidated: false,
    }],
  }));
  assert.equal(decision.primary.kind, 'caught-up');
  assert.match(decision.primary.detail, /nothing on your board/i);
});

// ---------------------------------- the one-minute pick, and its reason

/**
 * The walkthrough finding this section exists for.
 *
 * At one minute with nothing due, the quick take leads, and its reason was
 * *"Nothing has been asked about this yet."* — true of every topic on the
 * board, so the product's smallest recommendation read as a shuffle. What is
 * pinned here is that the pick is made on the ground it is about to teach and
 * that the sentence says which ground that was, including when the honest
 * answer is that there was nothing to choose between.
 */
const board = (n: number): { topics: Topic[]; pins: Pin[] } => ({
  topics: Array.from({ length: n }, (_, i) => topic({
    id: `t${i + 1}`, label: `Topic ${i + 1}`, pinIds: [`p${i + 1}`], comfort: 0.15,
  })),
  pins: Array.from({ length: n }, (_, i) => pin({ id: `p${i + 1}`, topicId: `t${i + 1}` })),
});
const decisions = (n: number) => Array.from({ length: n }, (_, i) =>
  activeDecision({ topicId: `t${i + 1}` }));
const read = (topicId: string, over: Partial<TopicComfortRead> = {}): TopicComfortRead => ({
  topicId, comfort: 0.15, certainty: 0, evidenceCount: 0, demonstrationCount: 0, ...over,
});

test('the take goes to the weakest ground, and the reason names it', () => {
  const { topics, pins } = board(3);
  const decision = chooseNextAction(input({
    availableMinutes: 1, topics, pins, topicDecisions: decisions(3),
    comforts: [
      // t1 is alphabetically first and would have won on the old id tie-break.
      read('t1', { comfort: 0.8, certainty: 0.7, evidenceCount: 4, demonstrationCount: 2 }),
      read('t2', { comfort: 0.5, certainty: 0.6, evidenceCount: 3, demonstrationCount: 2 }),
      read('t3'),
    ],
  }));
  assert.equal(decision.primary.kind, 'quick-take');
  assert.equal(decision.primary.targetId, 'p3', 'the pick still followed id order');
  assert.deepEqual(decision.primary.reasons, [{
    code: 'ready',
    text: 'You are new to this one, and nothing has been asked about it yet.',
  }]);
});

test('with everything asked about, the least settled ground leads', () => {
  const { topics, pins } = board(2);
  const decision = chooseNextAction(input({
    availableMinutes: 1, topics, pins, topicDecisions: decisions(2),
    comforts: [
      read('t1', { comfort: 0.7, certainty: 0.7, evidenceCount: 4, demonstrationCount: 2 }),
      read('t2', { comfort: 0.5, certainty: 0.7, evidenceCount: 4, demonstrationCount: 2 }),
    ],
  }));
  assert.equal(decision.primary.targetId, 'p2');
  assert.equal(decision.primary.reasons[0]?.text,
    'Of everything ready to teach, this is the one you are least settled on.');
});

test('a board with nothing to choose between says so rather than sounding chosen', () => {
  // The case the finding was found on: eight new topics, no evidence anywhere.
  // The pick is arbitrary and the sentence admits it, which is the only honest
  // thing a ranker can say when every input is identical.
  const { topics, pins } = board(8);
  const first = chooseNextAction(input({
    availableMinutes: 1, topics, pins, topicDecisions: decisions(8),
    comforts: topics.map((t) => read(t.id)),
  }));
  assert.equal(first.primary.reasons[0]?.text,
    'Nothing here has been asked about yet, so this is where I am starting.');
  // Deterministic: an unchanged board proposes an unchanged thing, and the
  // order the decisions arrive in is not part of the answer.
  const again = chooseNextAction(input({
    availableMinutes: 1, topics: [...topics].reverse(), pins: [...pins].reverse(),
    topicDecisions: [...decisions(8)].reverse(),
    comforts: topics.map((t) => read(t.id)),
  }));
  assert.equal(again.primary.targetId, first.primary.targetId);
  assert.equal(again.primary.reasons[0]?.text, first.primary.reasons[0]?.text);
});

test('a caller with no comfort reads still ranks on the board it has', () => {
  // Every pre- caller. The stored comfort is the only standing available
  // and it is used rather than the pick falling back to alphabetical order.
  const { topics, pins } = board(2);
  const decision = chooseNextAction(input({
    availableMinutes: 1, topicDecisions: decisions(2),
    topics: [{ ...topics[0]!, comfort: 0.6 }, { ...topics[1]!, comfort: 0.2 }],
    pins,
  }));
  assert.equal(decision.primary.targetId, 'p2');
});

test('every sentence the quick take can say is free of the two dashes', () => {
  // The learner-lineup contract’s copy law, asserted on the copy this slice added. A domain
  // string reaches the learner unedited, so it is held to the panel's rule.
  const said = new Set<string>();
  for (const comforts of [
    [read('t1'), read('t2')],
    [read('t1', { comfort: 0.2, certainty: 0.7, evidenceCount: 3, demonstrationCount: 2 }),
      read('t2', { comfort: 0.2, certainty: 0.7, evidenceCount: 3, demonstrationCount: 2 })],
    [read('t1'), read('t2', { comfort: 0.5, certainty: 0.7, evidenceCount: 3, demonstrationCount: 2 })],
    [read('t1', { comfort: 0.2, certainty: 0.7, evidenceCount: 3, demonstrationCount: 2 }),
      read('t2', { comfort: 0.5, certainty: 0.7, evidenceCount: 4, demonstrationCount: 2 })],
  ]) {
    const { topics, pins } = board(2);
    const decision = chooseNextAction(input({
      availableMinutes: 1, topics, pins, topicDecisions: decisions(2), comforts,
    }));
    said.add(decision.primary.reasons[0]!.text);
  }
  assert.equal(said.size, 4, 'the four cases did not produce four different sentences');
  for (const text of said) {
    assert.doesNotMatch(text, /[—–]/, text);
    assert.match(text, /[.!?]$/, text);
  }
});

/**
 *  — the pick a learner has refused, and the count that decides whether
 * refusing again is offered at all.
 *
 * The walkthrough finding: at one minute the hero is a single quick take with
 * no controls on it, so the one thing the product offers cannot be redirected
 * before it is opened. The half of that fix which lives here is the re-pick,
 * and its two properties are that a refused pin is gone from the answer and
 * that the answer says whether anything is left behind it.
 */
test('a refused pick is replaced by the next one down, not repeated', () => {
  const { topics, pins } = board(3);
  const comforts = [
    read('t1', { comfort: 0.2, certainty: 0.7, evidenceCount: 4, demonstrationCount: 2 }),
    read('t2', { comfort: 0.5, certainty: 0.7, evidenceCount: 4, demonstrationCount: 2 }),
    read('t3', { comfort: 0.8, certainty: 0.7, evidenceCount: 4, demonstrationCount: 2 }),
  ];
  const ask = (passedOverPinIds: string[]) => chooseNextAction(input({
    availableMinutes: 1, topics, pins, topicDecisions: decisions(3), comforts, passedOverPinIds,
  })).primary;

  const first = ask([]);
  assert.equal(first.targetId, 'p1');
  assert.equal(first.othersReady, 2, 'the pick did not say what was standing behind it');

  const second = ask(['p1']);
  assert.equal(second.targetId, 'p2');
  assert.equal(second.othersReady, 1);

  const third = ask(['p1', 'p2']);
  assert.equal(third.targetId, 'p3');
  assert.equal(third.othersReady, 0, 'the last candidate still claimed a spare');

  // Nothing left to offer is not a quick take at all: the ranker falls through
  // to whatever the board honestly has, which on this one is the empty state.
  assert.notEqual(ask(['p1', 'p2', 'p3']).kind, 'quick-take');
});

test('refusing a pick writes nothing and changes nothing else', () => {
  // The refusals are an argument to a read. Asking again without them returns
  // the board's own best pick, which is what makes this a fact about one screen
  // rather than a mark on a topic.
  const { topics, pins } = board(2);
  const comforts = [read('t1'), read('t2')];
  const asked = input({
    availableMinutes: 1, topics, pins, topicDecisions: decisions(2), comforts,
  });
  const refused = chooseNextAction({ ...asked, passedOverPinIds: ['p1'] }).primary;
  assert.equal(refused.targetId, 'p2');
  assert.equal(chooseNextAction(asked).primary.targetId, 'p1');
  // The tie-break sentence still describes the topics that are left rather than
  // the ones that were: with one candidate gone there is nothing to tie with.
  assert.equal(refused.reasons[0]?.text,
    'You are new to this one, and nothing has been asked about it yet.');
});

test('a held topic is not silently turned into a quick take', () => {
  const decision = chooseNextAction(input({
    availableMinutes: 3,
    topics: [topic()], pins: [pin()],
    topicDecisions: [activeDecision({ disposition: 'hold' })],
  }));
  assert.equal(decision.primary.kind, 'caught-up');
});

test('the deadline the lesson serves is named in the lesson, not ranked against it', () => {
  const decision = chooseNextAction(input({
    commitments: [commitment({ title: 'Architecture report', dueAt: '2026-08-24T23:59:00.000Z' })],
    session: session(), topics: [topic()],
  }));
  assert.equal(decision.primary.reasons[0]!.code, 'deadline');
  /**
   * ONE LINE, MERGING TIME AND PURPOSE.
   *
   * The two facts that carried information are one sentence, and both
   * halves of it are computed: how long the lineup actually takes, and what it
   * moves forward.
   */
  // The record, not a line on the hero: nothing above the lineup renders this,
  // and the fact reaches the learner as a chip on the row it is about.
  assert.equal(decision.primary.reasons.length, 1);
  assert.equal(decision.primary.reasons[0]!.text,
    'It moves “Architecture report” forward, and that is due in 1 day.');
});

test('a deadline the lesson does not touch says nothing about the lesson', () => {
  const decision = chooseNextAction(input({
    commitments: [commitment({ topicIds: ['elsewhere'] })],
    session: session(), topics: [topic()],
  }));
  assert.equal(decision.primary.kind, 'session');
  assert.deepEqual(decision.primary.reasons.map((r) => r.code), [],
    'nothing dated behind it and no gap is nothing to say');
});

test('a refresh does not outrank an assignment due tomorrow', () => {
  // Acceptance clause 8: a nearer assessed obligation can beat generic revision.
  // A revision session is what the Gardener offers on a night with nothing new
  // to teach, and "the session leads" is about a lesson, not about a refresh.
  const decision = chooseNextAction(input({
    commitments: [commitment({ topicIds: ['elsewhere'], dueAt: '2026-08-24T23:59:00.000Z' })],
    session: session({ revision: true }), topics: [topic()],
  }));
  assert.equal(decision.primary.kind, 'commitment');
  assert.equal(decision.alternatives[0]!.kind, 'session');
});

test('a refresh that prepares the thing due leads it, as it always did', () => {
  const decision = chooseNextAction(input({
    commitments: [commitment({ dueAt: '2026-08-24T23:59:00.000Z' })],
    session: session({ revision: true }), topics: [topic()],
  }));
  assert.equal(decision.primary.kind, 'session');
  assert.equal(decision.primary.title, 'A refresh on what you have already met');
});

test('a blocking question still outranks the prepared lesson', () => {
  // The one thing above it, and for the reason it always was: Virgil will not
  // plan around a date it had to guess.
  const draft = {
    id: 'd1', status: 'draft', title: 'Course', provider: '', url: '', objectives: [], material: [], commitments: [],
    source: { id: 'src', kind: 'syllabus', title: 'S', text: 'x', url: null, capturedAt: NOW.toISOString(), digest: 'sha256:x' },
    questions: [{ id: 'q1', field: 'commitments.0.dueAt', prompt: 'Which September date?', source: null, blocking: true, resolvedAt: null }],
    warnings: [], createdAt: NOW.toISOString(), appliedAt: null,
  } as CourseIntakeDraft;
  const decision = chooseNextAction(input({ drafts: [draft], session: session(), topics: [topic()] }));
  assert.equal(decision.primary.kind, 'clarify-intake');
});

/**
 * A COMMITMENT'S BUTTON GOES SOMEWHERE IT CAN DELIVER.
 *
 * Three destinations, decided by what the board actually holds for it. The old
 * answer was `plan` for all of them, which is why the product's largest control
 * repainted the room the learner was already standing in.
 */
test('a commitment the prepared lesson teaches for opens the lesson', () => {
  const decision = chooseNextAction(input({
    availableMinutes: 5,
    // Too long for the window, so the lesson itself is not a candidate and the
    // commitment is the hero. Its destination is still the real work.
    commitments: [commitment({ estimateMinutes: 5 })],
    session: session({ sections: [{
      topicId: 't1', heading: 'Agent boundaries', body: 'Lesson', depth: 'building',
      estimatedMinutes: 45, question: null, sourceIds: ['p1'], completed: false,
    }] }),
    topics: [topic()],
  }));
  assert.equal(decision.primary.kind, 'commitment');
  assert.equal(decision.primary.destination, 'session');
  assert.equal(decision.primary.cta, 'Work on it');
});

test('a commitment with topics and no lesson yet offers to build one', () => {
  const decision = chooseNextAction(input({ commitments: [commitment()] }));
  assert.equal(decision.primary.destination, 'build');
  assert.equal(decision.primary.cta, 'Build a session now');
});

test('a commitment linked to nothing stops promising work it cannot open', () => {
  const decision = chooseNextAction(input({ commitments: [commitment({ topicIds: [] })] }));
  assert.equal(decision.primary.destination, 'plan');
  assert.equal(decision.primary.cta, 'Show me where this sits');
  // The room it opens is still named on the wire, so the card can be marked.
  assert.equal(decision.primary.targetId, 'c1');
});

test('an unlinked commitment with board topics opens the choice that makes it useful', () => {
  const decision = chooseNextAction(input({
    commitments: [commitment({ topicIds: [] })],
    topics: [topic()],
  }));
  assert.equal(decision.primary.destination, 'plan');
  assert.equal(decision.primary.cta, 'Choose what it needs');
  assert.equal(decision.primary.planIntent, 'links');
});

test('a longer course item still offers one useful five-minute start', () => {
  const decision = chooseNextAction(input({ courses: [course()] }));
  assert.equal(decision.primary.kind, 'course-material');
  assert.equal(decision.primary.minutes, 5);
  assert.equal(decision.primary.url, 'https://example.test/lecture');
  assert.equal(decision.primary.materialId, 'm1');
  assert.equal(decision.primary.materialTotalMinutes, 25);
  assert.equal(decision.primary.materialProgressMinutes, 0);
  assert.match(decision.primary.detail, /5 minutes/i);
  assert.match(decision.primary.detail, /25 minutes/i);
});

test('a one-minute course start is singular without changing its bounded action', () => {
  const decision = chooseNextAction(input({ availableMinutes: 1, courses: [course()] }));
  assert.equal(decision.primary.kind, 'course-material');
  assert.equal(decision.primary.minutes, 1);
  assert.equal(decision.primary.detail,
    'Use this minute to begin it; the full item is 25 minutes.');
});

test('linkless course material asks for its link instead of pretending to start', () => {
  const c = course();
  const decision = chooseNextAction(input({
    courses: [{
      ...c,
      material: c.material.map((material) => ({ ...material, url: '' })),
    }],
  }));
  assert.equal(decision.primary.kind, 'course-material');
  assert.equal(decision.primary.url, null);
  assert.equal(decision.primary.cta, 'Add its link');
  assert.match(decision.primary.detail, /does not have a link/i);
});

test('a recorded course block changes the next action from begin to continue', () => {
  const c = course();
  const decision = chooseNextAction(input({
    courses: [{
      ...c,
      material: c.material.map((m) => ({ ...m, progressMinutes: 5 })),
    }],
  }));
  assert.equal(decision.primary.minutes, 5);
  assert.equal(decision.primary.materialProgressMinutes, 5);
  assert.equal(decision.primary.detail, 'Continue for 5 minutes; 20 of 25 remain.');
});

test('a whole final material remainder keeps its exact duration', () => {
  const c = course();
  const decision = chooseNextAction(input({
    availableMinutes: 5,
    courses: [{
      ...c,
      material: c.material.map((m) => ({ ...m, minutes: 10, progressMinutes: 8 })),
    }],
  }));
  assert.equal(decision.primary.kind, 'course-material');
  assert.equal(decision.primary.minutes, 2);
  assert.equal(decision.primary.detail, 'Finish it in about 2 minutes; 8 already recorded.');
});

test('a one-minute continuation remains singular', () => {
  const c = course();
  const decision = chooseNextAction(input({
    availableMinutes: 1,
    courses: [{
      ...c,
      material: c.material.map((m) => ({ ...m, progressMinutes: 5 })),
    }],
  }));
  assert.equal(decision.primary.minutes, 1);
  assert.equal(decision.primary.detail, 'Continue for 1 minute; 20 of 25 remain.');
});

test('useful course material beats merely locating a deadline that is still two weeks away', () => {
  const decision = chooseNextAction(input({
    commitments: [commitment({ topicIds: [], dueAt: '2026-09-05T23:59:00.000Z' })],
    courses: [course()],
  }));
  assert.equal(decision.primary.kind, 'course-material');
  assert.equal(decision.primary.title, 'Agent lecture');
  assert.deepEqual(decision.primary.reasons.map((r) => r.code), ['next-material', 'deadline']);
  assert.equal(decision.alternatives[0]?.kind, 'commitment');
});

test('work explicitly planned for today outranks generic course material', () => {
  const decision = chooseNextAction(input({
    commitments: [commitment({
      topicIds: [], dueAt: '2026-09-05T23:59:00.000Z',
      plannedFor: '2026-08-23T23:59:00.000Z',
    })],
    courses: [course()],
  }));
  assert.equal(decision.primary.kind, 'commitment');
  assert.deepEqual(decision.primary.reasons.map((reason) => reason.code),
    ['planned-day', 'deadline']);
  assert.equal(decision.primary.reasons[0]?.text, 'You planned this for today.');
  assert.match(decision.primary.reasons[1]?.text ?? '', /due in 13 days/i);
});

test('a future plan does not pull work forward early', () => {
  const decision = chooseNextAction(input({
    commitments: [commitment({
      topicIds: [], dueAt: '2026-09-05T23:59:00.000Z',
      plannedFor: '2026-08-24T23:59:00.000Z',
    })],
    courses: [course()],
  }));
  assert.equal(decision.primary.kind, 'course-material');
  assert.deepEqual(decision.alternatives[0]?.reasons.map((reason) => reason.code), ['deadline']);
});

test('the learner timezone decides when the planned day becomes today', () => {
  const decision = chooseNextAction(input({
    now: new Date('2026-08-22T15:00:00.000Z'), timeZone: 'Australia/Sydney',
    commitments: [commitment({
      topicIds: [], dueAt: '2026-09-05T23:59:00.000Z',
      plannedFor: '2026-08-23T23:59:00.000Z',
    })],
    courses: [course()],
  }));
  assert.equal(decision.primary.kind, 'commitment');
  assert.equal(decision.primary.reasons[0]?.text, 'You planned this for today.');
});

test('a prepared lesson still leads work planned for today', () => {
  const decision = chooseNextAction(input({
    commitments: [commitment({ plannedFor: '2026-08-23T23:59:00.000Z' })],
    session: session(), topics: [topic()],
  }));
  assert.equal(decision.primary.kind, 'session');
  assert.equal(decision.alternatives[0]?.kind, 'commitment');
});

test('a first course leads to its material instead of locating its five-day deadline', () => {
  const decision = chooseNextAction(input({
    availableMinutes: 3,
    commitments: [commitment({
      title: 'Reflection report', courseId: 'k1', topicIds: [],
      dueAt: '2026-08-28T23:59:00.000Z', estimateMinutes: null,
    })],
    courses: [course({ material: [{
      id: 'm1', title: 'Lecture recording', url: 'https://example.test/lecture',
      kind: 'class', minutes: 20, doneAt: null, pinIds: [], addedAt: NOW.toISOString(),
    }] })],
  }));
  assert.equal(decision.primary.kind, 'course-material');
  assert.equal(decision.primary.title, 'Lecture recording');
  assert.equal(decision.primary.cta, 'Open material');
  assert.deepEqual(decision.primary.reasons.map((r) => r.code), ['next-material', 'deadline']);
  assert.match(decision.primary.reasons[1]!.text, /Reflection report is due in 5 days/);
  assert.equal(decision.alternatives[0]?.kind, 'commitment',
    'the deadline stays in the decision record even though Learn leads to work');
});

test('a window too small for the whole job promises the first move only', () => {
  const decision = chooseNextAction(input({
    availableMinutes: 5,
    commitments: [commitment({ estimateMinutes: 90 })],
    session: session({ sections: [{
      topicId: 't1', heading: 'Agent boundaries', body: 'Lesson', depth: 'building',
      estimatedMinutes: 20, question: null, sourceIds: ['p1'], completed: false,
    }] }), topics: [topic()],
  }));
  assert.equal(decision.primary.destination, 'session');
  assert.equal(decision.primary.cta, 'Make a start');
});

test('every selected action fits the time the learner actually has', () => {
  const decision = chooseNextAction(input({
    availableMinutes: 5,
    commitments: [commitment({ estimateMinutes: 90 })],
    session: session(), topics: [topic()],
  }));
  assert.equal(decision.primary.minutes, 5);
  assert.ok(decision.alternatives.every((a) => a.minutes <= 5));
});

test('an empty board asks for material instead of pretending it has a plan', () => {
  const decision = chooseNextAction(input());
  assert.equal(decision.primary.kind, 'capture-material');
  assert.match(decision.primary.reasons[0]!.text, /no reviewed obligation/i);
});

test('completed course history is caught up in My studies, not reset to first run', () => {
  const decision = chooseNextAction(input({
    courses: [course({
      material: [{
        id: 'm1', title: 'Agent lecture', url: 'https://example.test/lecture', kind: 'class',
        minutes: 12, progressMinutes: 12, doneAt: NOW.toISOString(), pinIds: [],
        addedAt: NOW.toISOString(),
      }],
    })],
    commitments: [commitment({ doneAt: NOW.toISOString() })],
    outcomes: [outcome()],
  }));
  assert.equal(decision.primary.kind, 'caught-up');
  assert.equal(decision.primary.destination, 'courses');
  assert.equal(decision.primary.cta, 'See my studies');
  assert.equal(decision.primary.detail, 'You finished what you set out to do.');
  assert.doesNotMatch(decision.primary.reasons[0]!.text, /no .*course material yet/i);
});

test('completed Plan-only history is caught up in Plan, not reset to first run', () => {
  const decision = chooseNextAction(input({
    commitments: [commitment({ courseId: null, topicIds: [], doneAt: NOW.toISOString() })],
  }));
  assert.equal(decision.primary.kind, 'caught-up');
  assert.equal(decision.primary.destination, 'plan');
  assert.equal(decision.primary.cta, 'See my plan');
  assert.equal(decision.primary.detail, 'You finished what you set out to do.');
});

test('caught-up history and current attention are separate facts', () => {
  const completedCourse = course();
  const studies = chooseNextAction(input({
    courses: [{
      ...completedCourse,
      material: completedCourse.material.map((material) => ({
        ...material, doneAt: NOW.toISOString(),
      })),
    }],
  })).primary;
  assert.equal(studies.detail, 'You finished what you set out to do.');
  assert.equal(studies.reasons[0]?.text, 'Nothing in My studies needs attention just now.');

  const plan = chooseNextAction(input({
    commitments: [commitment({ courseId: null, topicIds: [], doneAt: NOW.toISOString() })],
  })).primary;
  assert.equal(plan.detail, 'You finished what you set out to do.');
  assert.equal(plan.reasons[0]?.text, 'Nothing on your plan needs attention just now.');
});

test('a completed session with nothing due reads as caught up, not as an empty board', () => {
  const decision = chooseNextAction(input({
    availableMinutes: 3,
    topics: [topic()],
    session: session({
      currentSectionIndex: 1,
      sections: [{
        topicId: 't1', heading: 'Agent boundaries', body: 'Lesson', depth: 'building',
        estimatedMinutes: 5, question: null, sourceIds: ['p1'], completed: true,
        completionEvidence: 'answer',
      }],
    }),
  }));
  assert.equal(decision.primary.kind, 'caught-up');
  assert.equal(decision.primary.destination, 'board');
  assert.equal(decision.primary.title, 'You’re done for now');
  assert.equal(decision.primary.cta, 'See my board');
  assert.equal(decision.primary.detail, 'This session is complete.');
  assert.match(decision.primary.reasons[0]!.text, /nothing is due/i);
});

test('real work still outranks the caught-up fallback after a completed session', () => {
  const completed = session({
    sections: [{
      topicId: 't1', heading: 'Agent boundaries', body: 'Lesson', depth: 'building',
      estimatedMinutes: 5, question: null, sourceIds: ['p1'], completed: true,
    }],
  });
  assert.equal(chooseNextAction(input({ session: completed, courses: [course()] })).primary.kind,
    'course-material');
  assert.equal(chooseNextAction(input({ session: completed, commitments: [commitment()] })).primary.kind,
    'commitment');
});


/**
 * THE HERO'S SENTENCE IS GONE, AND ITS FACTS ARE SHOWN INSTEAD.
 *
 * The time became the kicker over the lineup, summed from the sections on
 * screen so it moves when they do. The deadline became a chip on the row it is
 * about. Neither of them is a sentence any more, so neither is computed here.
 *
 * What survives in the domain is the structured record: `reasons` is what a
 * ranked ALTERNATIVE renders as its caption in the rail, where a link has
 * nowhere else to carry a fact. It is allowed to be empty.
 */
const reasonsFor = (sections: readonly number[], commitments: readonly Commitment[] = []) =>
  chooseNextAction(input({
    availableMinutes: 5, topics: [topic()], commitments,
    session: session({
      sections: sections.map((estimatedMinutes, i) => ({
        topicId: `t${i}`, heading: `Section ${i}`, body: 'x', depth: 'building' as const,
        estimatedMinutes, question: null, sourceIds: [], completed: false,
      })),
    }),
  })).primary.reasons;

test('the lineup carries no sentence about how long it is', () => {
  // The kicker shows it, from the sections themselves. A paragraph saying the
  // same number over a list that is already on screen is the narration the law
  // is against.
  for (const said of reasonsFor([3, 2]).map((r) => r.text)) {
    assert.ok(!/minute/i.test(said), said);
  }
});

test('a session with nothing dated and no gap carries no caption at all', () => {
  // Empty rather than padded. The rail falls back to `detail`, and a sentence
  // invented to fill a field is the same defect one layer down.
  assert.deepEqual(reasonsFor([3, 2]), []);
});

test('The time-window contract exposes only one, three and five minute windows', () => {
  for (const availableMinutes of [1, 3, 5] as const) {
    const decision = chooseNextAction(input({ availableMinutes }));
    assert.equal(decision.availableMinutes, availableMinutes);
    assert.equal(decision.primary.minutes, availableMinutes);
    assert.ok(decision.alternatives.every((a) => a.minutes <= availableMinutes));
  }
});

test('a lineup the smallest chip cannot start is not offered as one', () => {
  // Honest by construction rather than by copy: with nothing that fits, the
  // session is not a candidate and something that does fit leads instead.
  const decision = chooseNextAction(input({
    availableMinutes: 5, topics: [topic()],
    session: session({
      sections: [{
        topicId: 't0', heading: 'Long one', body: 'x', depth: 'building' as const,
        estimatedMinutes: 20, question: null, sourceIds: [], completed: false,
      }],
    }),
  }));
  assert.notEqual(decision.primary.kind, 'session');
});
