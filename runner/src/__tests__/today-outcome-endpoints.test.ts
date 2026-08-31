import { test } from 'node:test';
import assert from 'node:assert/strict';
import { section, session, startService, topic } from './service-harness.js';

test('Today returns exactly one primary action that fits the requested window', async () => {
  const h = await startService('today-one');
  try {
    await h.call('POST', '/commitments', {
      title: 'Long report', kind: 'assignment', dueAt: '2026-08-21', estimateMinutes: 90,
    });
    const today = await h.call('GET', '/today?minutes=5');
    assert.equal(today.status, 200);
    assert.equal(today.body.next.primary.kind, 'commitment');
    assert.equal(today.body.next.primary.minutes, 5);
    // Linked to nothing on the board, so the only honest destination is the
    // room that lists it, and the cta says that rather than promising work.
    assert.equal(today.body.next.primary.destination, 'plan');
    assert.equal(today.body.next.primary.cta, 'Show me where this sits');
    assert.ok(today.body.next.alternatives.length <= 2);
  } finally { await h.close(); }
});

test('Today exposes an intake question instead of planning on an ambiguous date', async () => {
  const h = await startService('today-question');
  try {
    await h.call('POST', '/course-intakes', {
      kind: 'syllabus', text: 'Course: Security\nAssignment due 08/09/2026',
    });
    const today = await h.call('GET', '/today?minutes=3');
    assert.equal(today.body.next.primary.kind, 'clarify-intake');
    assert.match(today.body.next.primary.detail, /What date does/);
  } finally { await h.close(); }
});

test('Today opens the learning-link choice when an unlinked deadline has board topics', async () => {
  const h = await startService('today-link-choice');
  try {
    await h.store.putTopic(topic('t1', []));
    await h.call('POST', '/commitments', {
      title: 'Audit one web page', kind: 'assignment', dueAt: '2026-09-05', topicIds: [],
    });
    const today = await h.call('GET', '/today?minutes=3');
    assert.equal(today.body.next.primary.destination, 'plan');
    assert.equal(today.body.next.primary.cta, 'Choose what it needs');
    assert.equal(today.body.next.primary.planIntent, 'links');
  } finally { await h.close(); }
});

test('a negative assessed outcome names itself on the next move', async () => {
  const h = await startService('outcome-adapt');
  try {
    await h.store.putTopic(topic('t1', []));
    await h.store.putSession(session('s1', [section('t1', { estimatedMinutes: 3 })]));
    await h.call('POST', '/commitments', {
      title: 'Architecture report', kind: 'assignment', dueAt: '2026-08-21',
      estimateMinutes: 15, topicIds: [],
    });
    const before = await h.call('GET', '/today?minutes=3');
    assert.equal(before.body.next.primary.kind, 'session', 'the prepared lesson leads');
    // Nothing dated is linked to this topic and nothing has been marked yet, so
    // the lesson captions itself with nothing. The interface-affordance contract took the standing
    // "ready" sentence out: it restated what the screen already shows.
    assert.deepEqual(before.body.next.primary.reasons.map((r: { code: string }) => r.code), []);

    const recorded = await h.call('POST', '/outcomes', {
      kind: 'rubric', title: 'Boundary criterion', score: 4, maxScore: 10,
      topicIds: ['t1'], summary: 'The boundary was not explained.', availableMinutes: 3,
      clientRef: 'outcome_attempt_001',
    });
    assert.equal(recorded.status, 201);
    assert.equal(recorded.body.signalsAdded, 1);
    assert.equal(recorded.body.adaptation.after.kind, 'session');
    assert.equal(recorded.body.adaptation.after.reasons[0].code, 'assessed-gap');
    // Honest about itself: the move did not change, and the receipt says so
    // rather than claiming a replanning that did not happen.
    assert.equal(recorded.body.adaptation.changed, false);
    assert.match(recorded.body.adaptation.changedBecause, /still wins/);
    const signals = await h.store.listSignals('t1');
    assert.equal(signals[0]?.type, 'assessed-gap');
    assert.match(signals[0]?.sourceEvent ?? '', /^outcome:/);
    const retry = await h.call('POST', '/outcomes', {
      kind: 'rubric', title: 'Boundary criterion', score: 4, maxScore: 10,
      topicIds: ['t1'], summary: 'The boundary was not explained.', availableMinutes: 3,
      clientRef: 'outcome_attempt_001',
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.alreadyRecorded, true);
    assert.equal(retry.body.outcome.id, recorded.body.outcome.id);
    assert.equal((await h.store.listOutcomes()).length, 1);
    assert.equal((await h.store.listSignals('t1')).length, 1);
  } finally { await h.close(); }
});

test('correcting an outcome invalidates old evidence and replans from the correction', async () => {
  const h = await startService('outcome-correct');
  try {
    await h.store.putTopic(topic('t1', []));
    await h.store.putSession(session('s1', [section('t1', { estimatedMinutes: 3 })]));
    await h.call('POST', '/commitments', {
      title: 'Architecture report', kind: 'assignment', dueAt: '2026-08-21',
      estimateMinutes: 15, topicIds: [],
    });
    const first = await h.call('POST', '/outcomes', {
      kind: 'grade', title: 'Reported grade', score: 40, maxScore: 100,
      topicIds: ['t1'], availableMinutes: 3,
    });
    const oldId = first.body.outcome.id;
    const corrected = await h.call('POST', `/outcomes/${oldId}/correct`, {
      kind: 'grade', title: 'Corrected grade', score: 90, maxScore: 100,
      topicIds: ['t1'], availableMinutes: 3, clientRef: 'outcome_correction_attempt_001',
    });
    assert.equal(corrected.status, 200);
    assert.equal(corrected.body.outcome.supersedesId, oldId);
    assert.equal(corrected.body.adaptation.after.kind, 'session');
    // The gap the wrong grade asserted is gone from the reasons, which is what
    // "replans from the correction" means now that the ordering is settled.
    assert.ok(!corrected.body.adaptation.after.reasons
      .some((r: { code: string }) => r.code === 'assessed-gap'));
    assert.ok(corrected.body.adaptation.before.reasons
      .some((r: { code: string }) => r.code === 'assessed-gap'));
    const signals = await h.store.listSignals('t1');
    assert.equal(signals.filter((s) => s.type === 'assessed-gap')[0]?.invalidated, true);
    assert.equal(signals.filter((s) => s.type === 'assessed-strong')[0]?.invalidated, false);
    const rows = await h.call('GET', '/outcomes');
    assert.equal(rows.body.outcomes.length, 1);
    assert.equal(rows.body.history.length, 1);
    const retry = await h.call('POST', `/outcomes/${oldId}/correct`, {
      kind: 'grade', title: 'Corrected grade', score: 90, maxScore: 100,
      topicIds: ['t1'], availableMinutes: 3, clientRef: 'outcome_correction_attempt_001',
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.alreadyRecorded, true);
    assert.equal(retry.body.outcome.id, corrected.body.outcome.id);
    const afterRetry = await h.call('GET', '/outcomes');
    assert.equal(afterRetry.body.outcomes.length, 1);
    assert.equal(afterRetry.body.history.length, 1);
    assert.equal((await h.store.listSignals('t1')).length, 2);
  } finally { await h.close(); }
});

test('a scoreless correction preserves omitted relationships and cannot rewrite hidden evidence fields', async () => {
  const h = await startService('outcome-correct-owned-fields');
  try {
    await h.store.putTopic(topic('t1', []));
    await h.store.putCourse({
      id: 'course-1', title: 'Reliable Systems', provider: '', url: '',
      material: [], topicIds: ['t1'], archivedAt: null,
      createdAt: '2026-08-19T03:00:00.000Z',
    });
    const commitment = await h.call('POST', '/commitments', {
      title: 'Retry reflection', kind: 'assignment', dueAt: '2026-08-30',
      courseId: 'course-1', topicIds: ['t1'],
    });
    const recorded = await h.call('POST', '/outcomes', {
      kind: 'teacher-feedback', title: 'Tutor note', score: null, maxScore: null,
      courseId: 'course-1', commitmentId: commitment.body.commitment.id,
      topicIds: ['t1'], summary: 'Original summary', feedback: 'Retry handling is unclear.',
      criteria: [{
        criterionId: 'retry-safety', label: 'Retry safety', score: null, maxScore: null,
        verdict: 'mixed', feedback: 'Name the idempotency boundary.', topicIds: ['t1'],
      }],
      source: { sourceId: 'source-1', quote: 'Retry handling is unclear.' },
    });
    const old = recorded.body.outcome;

    const corrected = await h.call('POST', `/outcomes/${old.id}/correct`, {
      kind: 'self-assessment', title: 'My retry reflection', score: null, maxScore: null,
      feedback: 'I can now explain the failure case.',
      // Relationships are visible correction controls now. Omitting them is
      // the older-client shape and must preserve the active placement; the
      // hidden structured fields remain non-authoritative browser echoes.
      criteria: [],
      summary: 'Rewritten behind the form', source: null,
      clientRef: 'scoreless_owned_fields_001', availableMinutes: 3,
    });
    assert.equal(corrected.status, 200);
    const replacement = corrected.body.outcome;
    assert.equal(replacement.title, 'My retry reflection');
    assert.equal(replacement.kind, 'self-assessment');
    assert.equal(replacement.score, null);
    assert.equal(replacement.maxScore, null);
    assert.equal(replacement.feedback, 'I can now explain the failure case.');
    assert.equal(replacement.courseId, old.courseId);
    assert.equal(replacement.commitmentId, old.commitmentId);
    assert.deepEqual(replacement.topicIds, old.topicIds);
    assert.deepEqual(replacement.criteria, old.criteria);
    assert.equal(replacement.summary, old.summary);
    assert.deepEqual(replacement.source, old.source);
    assert.equal(replacement.supersedesId, old.id);

    const reread = await h.call('GET', '/outcomes');
    assert.deepEqual(reread.body.outcomes.map((row: { id: string }) => row.id), [replacement.id]);
    assert.deepEqual(reread.body.history.map((row: { id: string }) => row.id), [old.id]);
    assert.ok(corrected.body.adaptation.after,
      'the correction did not re-read the live next move');
  } finally { await h.close(); }
});

test('a result stores its exact Unicode boundary whole and refuses overflow before evidence exists', async () => {
  const h = await startService('outcome-whole-words');
  try {
    const title = '🙂'.repeat(180);
    const feedback = '🟢'.repeat(6_000);
    const recorded = await h.call('POST', '/outcomes', {
      kind: 'self-assessment', title, feedback, score: null, maxScore: null,
    });
    assert.equal(recorded.status, 201);
    assert.equal(recorded.body.outcome.title, title);
    assert.equal(Array.from(recorded.body.outcome.title).length, 180);
    assert.equal(recorded.body.outcome.feedback, feedback);
    assert.equal(Array.from(recorded.body.outcome.feedback).length, 6_000);

    const outcomeCount = (await h.store.listOutcomes()).length;
    const signalCount = (await h.store.listSignals()).length;
    for (const body of [
      { kind: 'self-assessment', title: `${title}x`, feedback: '' },
      { kind: 'self-assessment', title: 'Reflection', feedback: `${feedback}x` },
      { kind: 'self-assessment', title: 'Reflection', feedback: ['not', 'text'] },
    ]) {
      const refused = await h.call('POST', '/outcomes', body);
      assert.equal(refused.status, 400);
      assert.equal((await h.store.listOutcomes()).length, outcomeCount);
      assert.equal((await h.store.listSignals()).length, signalCount);
    }
  } finally { await h.close(); }
});

test('a correction shares the whole-or-refuse result word boundary', async () => {
  const h = await startService('outcome-correction-whole-words');
  try {
    const first = await h.call('POST', '/outcomes', {
      kind: 'self-assessment', title: 'Reflection', feedback: 'First account',
    });
    assert.equal(first.status, 201);
    const title = '🧭'.repeat(180);
    const feedback = '📝'.repeat(6_000);
    const corrected = await h.call('POST', `/outcomes/${first.body.outcome.id}/correct`, {
      kind: 'self-assessment', title, feedback,
    });
    assert.equal(corrected.status, 200);
    assert.equal(corrected.body.outcome.title, title);
    assert.equal(corrected.body.outcome.feedback, feedback);

    const activeId = corrected.body.outcome.id;
    const outcomesBefore = await h.store.listOutcomes();
    const signalsBefore = await h.store.listSignals();
    const refused = await h.call('POST', `/outcomes/${activeId}/correct`, {
      kind: 'self-assessment', title, feedback: `${feedback}x`,
    });
    assert.equal(refused.status, 400);
    assert.deepEqual(await h.store.listOutcomes(), outcomesBefore);
    assert.deepEqual(await h.store.listSignals(), signalsBefore);
  } finally { await h.close(); }
});

test('outcomes cannot claim a topic the board does not have', async () => {
  const h = await startService('outcome-topic');
  try {
    const result = await h.call('POST', '/outcomes', {
      kind: 'grade', title: 'Grade', score: 90, maxScore: 100, topicIds: ['invented'],
    });
    assert.equal(result.status, 400);
    assert.equal((await h.store.listOutcomes()).length, 0);
    assert.equal((await h.store.listSignals()).length, 0);
  } finally { await h.close(); }
});

test('an assignment result carries its owning course and refuses a contradictory one', async () => {
  const h = await startService('outcome-assignment-course');
  try {
    for (const [id, title] of [
      ['course-1', 'Data Structures'], ['course-2', 'Databases'],
    ] as const) {
      await h.store.putCourse({
        id, title, provider: '', url: '', material: [], topicIds: [], archivedAt: null,
        createdAt: '2026-08-28T00:00:00.000Z',
      });
    }
    const work = await h.call('POST', '/commitments', {
      title: 'Complete Big O quiz', kind: 'assignment', dueAt: '2026-08-29',
      courseId: 'course-1', topicIds: [],
    });
    const commitmentId = work.body.commitment.id as string;

    const recorded = await h.call('POST', '/outcomes', {
      kind: 'grade', title: 'Big O quiz result', score: 8, maxScore: 10,
      courseId: null, commitmentId,
    });
    assert.equal(recorded.status, 201);
    assert.equal(recorded.body.outcome.courseId, 'course-1',
      'the exact assignment was stored while its owning course was discarded');

    const outcomeCount = (await h.store.listOutcomes()).length;
    const signalCount = (await h.store.listSignals()).length;
    const refused = await h.call('POST', '/outcomes', {
      kind: 'grade', title: 'Contradictory result', score: 7, maxScore: 10,
      courseId: 'course-2', commitmentId,
    });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /assignment belongs to Data Structures/);
    assert.equal((await h.store.listOutcomes()).length, outcomeCount);
    assert.equal((await h.store.listSignals()).length, signalCount);
  } finally { await h.close(); }
});

test('result correction persists offered relationships and keeps hidden evidence fields', async () => {
  const h = await startService('outcome-correction-relationships');
  try {
    await h.store.putCourse({
      id: 'course-1', title: 'Data Structures', provider: '', url: '', material: [],
      topicIds: [], archivedAt: null, createdAt: '2026-08-28T00:00:00.000Z',
    });
    const work = await h.call('POST', '/commitments', {
      title: 'Complete Big O quiz', kind: 'assignment', dueAt: '2026-08-29',
      courseId: 'course-1', topicIds: [],
    });
    const first = await h.call('POST', '/outcomes', {
      kind: 'self-assessment', title: 'Loose reflection', feedback: 'First note.',
      criteria: [{
        criterionId: 'c1', label: 'Explain complexity', score: null, maxScore: null,
        verdict: 'mixed', feedback: 'Needs a comparison.', topicIds: [],
      }],
    });
    const corrected = await h.call('POST', `/outcomes/${first.body.outcome.id}/correct`, {
      kind: 'self-assessment', title: 'Filed reflection', feedback: 'Same evidence, filed.',
      courseId: 'course-1', commitmentId: work.body.commitment.id, topicIds: [],
    });
    assert.equal(corrected.status, 200);
    assert.equal(corrected.body.outcome.courseId, 'course-1');
    assert.equal(corrected.body.outcome.commitmentId, work.body.commitment.id);
    assert.deepEqual(corrected.body.outcome.criteria, first.body.outcome.criteria,
      'relationship repair rewrote hidden structured evidence');
  } finally { await h.close(); }
});
