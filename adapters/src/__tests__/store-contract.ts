import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TopicOpError,
  type Award, type Commitment, type Course, type CourseIntakeDraft, type Enrichment, type LearnerPrefs,
  type ExternalEntry, type LearningOutcome, type HostedProcessingReceipt,
  type Pin, type ProspectProposal, type Session, type Signal,
  type Statement, type Store, type Suggestion, type Topic,
} from '@sb/core';

/**
 * The `Store` contract, written once and run against every implementation.
 *
 * `ports/store.ts` is unusually opinionated for a persistence interface, and on
 * purpose: the cascade in `deletePin`, the alias resolution behind
 * `mergeTopics`, the append-only signal ledger and the "prefs exist before
 * anything is written" rule are all product promises, not storage details. Each
 * one is a place where a Firestore implementation could satisfy TypeScript
 * completely and break a promise the learner would notice — a deleted pin still
 * shaping tomorrow's session, a merged topic's history detaching, a first run
 * with no prefs to read.
 *
 * The existing store tests prove those behaviours for `JsonStore` by reaching
 * into `JsonStore`. This proves them for *a* store, so the second one inherits
 * them.
 *
 * A subject supplies an empty store and a way to read it back. The second half
 * matters more than it looks: a subject whose `reader()` hands back a freshly
 * opened handle turns every assertion here into a durability assertion as well,
 * which is exactly the class of bug an in-memory-first implementation ships
 * with.
 */

export interface StoreSession {
  /** Where writes go. */
  readonly writer: Store;
  /**
   * Where reads come from. May be the same handle, or a fresh one over the same
   * data — a subject that returns a fresh handle is additionally asserting that
   * everything written actually persisted.
   */
  reader(): Promise<Store>;
  dispose(): Promise<void>;
}

export interface StoreSubject {
  readonly name: string;
  /** A store with nothing in it. */
  create(): Promise<StoreSession>;
  /**
   * A reason to skip, or `false` to run — `node:test`'s own `skip` option,
   * passed straight through.
   *
   * Added for the Firestore subject, which needs a process this repo does not
   * start for itself. Every other subject omits it and runs, and the offline
   * suite is unchanged. The alternative — registering the subject only when the
   * emulator is up — would make twenty-eight assertions *disappear* from a run
   * rather than announce themselves as unrun, and a suite whose size depends on
   * what happens to be listening on a port is a suite nobody can read a count
   * from. The house already counts LIVE-gated skips out loud.
   */
  readonly skip?: string | false;
}

// -------------------------------------------------------------------- fixtures

const AT = '2026-08-19T03:00:00.000Z';

const enrichment = (over: Partial<Enrichment> = {}): Enrichment => ({
  refetchedText: null, assumedConcepts: ['the ack deadline'], mediaDescription: null,
  references: [], outcome: 'enriched', confidence: 'full', enrichedAt: AT, ...over,
});

export const aPin = (id: string, over: Partial<Pin> = {}): Pin => ({
  id, type: 'interest',
  envelope: {
    selection: `the passage for ${id}`, parts: [], surroundingText: 'ordinary prose around it',
    headingPath: ['Docs', 'Pub/Sub'], pageTitle: `page ${id}`, url: 'https://example.test/doc',
    canonicalUrl: null, siteName: null, contentLanguage: 'en', media: null,
  },
  note: null, capturedAt: '2026-08-01T00:00:00.000Z', fromSuggestion: false,
  enrichment: null, topicId: null, ...over,
});

export const aTopic = (id: string, pinIds: readonly string[], over: Partial<Topic> = {}): Topic => ({
  id, label: `topic ${id}`, summary: 'what this topic is about', pinIds,
  state: 'waiting', comfort: 0.15, lastExposedAt: null, retiredByUser: false,
  createdAt: AT, ...over,
});

const aSignal = (id: string, topicId: string, over: Partial<Signal> = {}): Signal => ({
  id, topicId, type: 'answer-correct', direction: 'positive',
  at: AT, sourceEvent: `session-1:${id}`, invalidated: false, ...over,
});

const aStatement = (id: string, topicId: string | null): Statement => ({
  id, text: 'comfortable with ack deadlines', topicId,
  userEdited: false, evidenceSignalIds: [], updatedAt: AT,
});

const aSession = (id: string, builtAt: string, topicId: string, sourceIds: readonly string[] = []): Session => ({
  id, builtAt, fromPinCount: 2, targetMinutes: 15, estimatedMinutes: 12.5,
  sections: [{
    topicId, heading: 'Pull subscriptions', body: 'prose', depth: 'building',
    estimatedMinutes: 12.5, question: null, sourceIds, completed: false,
  }],
  currentSectionIndex: 0, closingNote: null,
});

const aSuggestion = (id: string, state: Suggestion['state']): Suggestion => ({
  id, passage: 'a passage the detector noticed', url: 'https://example.test/page',
  reason: 'read three times', raisedAt: AT, state, pageTitle: 'A page', headingPath: ['Docs'],
});

/**
 * Text designed to break anything that re-encodes on the way through: scripts
 * outside the BMP, combining marks, right-to-left, a lone quote, a newline, and
 * the characters JSON has to escape.
 */
const AWKWARD = 'café ñ 日本語 🧪 é مرحبا "quoted" \\backslash\\ \n\ttab — ✅';

const aCommitment = (id: string, over: Partial<Commitment> = {}): Commitment => ({
  id, title: `Commitment ${id}`, kind: 'assignment', courseId: null, topicIds: [],
  dueAt: '2026-09-01T23:59:00.000Z', plannedFor: null, estimateMinutes: null,
  notes: '', doneAt: null, createdAt: '2026-08-20T09:00:00.000Z', ...over,
});

const anAward = (id: string, commitmentId: string | null = null): Award => ({
  id, at: '2026-08-23T10:00:00.000Z', points: 10, reason: 'closed', commitmentId, topicId: null,
});

const aCourse = (id: string): Course => ({
  id, title: `Course ${id}`, provider: 'NCW', url: 'https://example.test/c',
  material: [], topicIds: [], archivedAt: null, createdAt: '2026-08-20T09:00:00.000Z',
});

const anIntake = (id: string): CourseIntakeDraft => ({
  id, status: 'draft',
  source: {
    id: `source-${id}`, kind: 'syllabus', title: AWKWARD, text: AWKWARD,
    url: 'https://example.test/syllabus', capturedAt: AT, digest: 'sha256:test',
  },
  title: AWKWARD, provider: 'Example University', url: 'https://example.test/course',
  objectives: [{ id: 'objective-1', text: AWKWARD, source: { sourceId: `source-${id}`, quote: AWKWARD } }],
  material: [], commitments: [], questions: [], warnings: [], createdAt: AT, appliedAt: null,
});

const anOutcome = (id: string): LearningOutcome => ({
  id, kind: 'teacher-feedback', courseId: 'k1', commitmentId: 'c1', topicIds: ['t1'],
  title: AWKWARD, score: 4, maxScore: 10, summary: AWKWARD, feedback: AWKWARD,
  criteria: [{
    criterionId: 'criterion-1', label: AWKWARD, score: 4, maxScore: 10,
    verdict: 'gap', feedback: AWKWARD, topicIds: ['t1'],
  }],
  source: { sourceId: 'feedback-1', quote: AWKWARD }, recordedAt: AT,
  supersedesId: null, deletedAt: null,
});

const anExternal = (id: string): ExternalEntry => ({
  id, kind: 'lesson', label: AWKWARD, destination: 'new-tab', sentAt: AT,
  sessionId: 'sess-1', topicId: 't1', materialId: null, destinationSaid: null,
  note: AWKWARD, methods: ['read'], mark: null, markedAt: null,
});

const aProposal = (id: string): ProspectProposal => ({
  id,
  subject: AWKWARD,
  reason: AWKWARD,
  evidenceKey: 'prerequisite:eigenvalues',
  evidenceKind: 'prerequisite-hole',
  evidenceDetail: AWKWARD,
  evidenceUnconfirmed: false,
  lead: { phrase: AWKWARD, url: 'https://example.test/eigen', unread: true },
  state: 'pending',
  raisedAt: AT,
  batchKey: '2026-08-29',
  decidedAt: null,
});

// --------------------------------------------------------------------- helpers

const only = <T>(xs: readonly T[], what: string): T => {
  assert.equal(xs.length, 1, `expected exactly one ${what}, saw ${xs.length}`);
  return xs[0] as T;
};

// ------------------------------------------------------------------- the suite

export function runStoreContract(subject: StoreSubject): void {
  const named = (name: string, fn: (s: StoreSession) => Promise<void>) =>
    test(`[${subject.name}] ${name}`, { skip: subject.skip ?? false }, async () => {
      const s = await subject.create();
      try { await fn(s); } finally { await s.dispose(); }
    });

  // ------------------------------------------------------------- empty store

  named('an empty store answers every list with an empty array, never null', async (s) => {
    const r = await s.reader();
    assert.deepEqual([...await r.listPins()], []);
    assert.deepEqual([...await r.listTopics()], []);
    assert.deepEqual([...await r.listEdges()], []);
    assert.deepEqual([...await r.listSignals()], []);
    assert.deepEqual([...await r.listStatements()], []);
    assert.deepEqual([...await r.listSuggestions()], []);
    assert.deepEqual([...await r.listCommitments()], []);
    assert.deepEqual([...await r.listAwards()], []);
    assert.deepEqual([...await r.listCourses()], []);
    assert.deepEqual([...await r.listIntakeDrafts()], []);
    assert.deepEqual([...await r.listOutcomes()], []);
    assert.deepEqual([...await r.listExternalEntries()], []);
    assert.deepEqual(await r.topicAliases(), {});
    assert.equal(await r.latestSession(), null);
  });

  named('preferences exist before anything has been written', async (s) => {
    // The very first run reads prefs before it has ever written any. A store
    // that answers null here crashes the panel on the day it is installed.
    const prefs: LearnerPrefs = await (await s.reader()).getPrefs();
    assert.ok(prefs, 'a store with no prefs written must still have prefs');
    assert.ok([5, 15, 45].includes(prefs.targetMinutes), 'the default session length is not a valid one');
    assert.ok(Array.isArray(prefs.excludedDomains), 'SB-41 ships exclusions, not an empty promise');
    assert.ok(prefs.rejectedOrigins && typeof prefs.rejectedOrigins === 'object');
  });

  named('an id that was never written reads back as null', async (s) => {
    const r = await s.reader();
    assert.equal(await r.getPin('nope'), null);
    assert.equal(await r.getTopic('nope'), null);
    assert.equal(await r.getSession('nope'), null);
  });

  // --------------------------------------------------------------- round trip

  named('a pin comes back exactly as it went in', async (s) => {
    const pin = aPin('p1', { note: 'my note', enrichment: enrichment() });
    await s.writer.putPin(pin);
    assert.deepEqual(await (await s.reader()).getPin('p1'), pin);
  });

  named('awkward text survives storage byte for byte', async (s) => {
    // A store that round-trips through JSON, a query string, or a database
    // driver has several chances to mangle this, and the learner reads the
    // result. Their own note is the least forgiving place for it to happen.
    await s.writer.putPin(aPin('p1', {
      note: AWKWARD,
      envelope: { ...aPin('p1').envelope, selection: AWKWARD, pageTitle: AWKWARD },
    }));
    const back = await (await s.reader()).getPin('p1');
    assert.equal(back?.note, AWKWARD);
    assert.equal(back?.envelope.selection, AWKWARD);
    assert.equal(back?.envelope.pageTitle, AWKWARD);
  });

  named('a pin far larger than a normal one round-trips whole', async (s) => {
    const big = 'x'.repeat(400_000);
    await s.writer.putPin(aPin('p1', { envelope: { ...aPin('p1').envelope, surroundingText: big } }));
    assert.equal((await (await s.reader()).getPin('p1'))?.envelope.surroundingText.length, big.length);
  });

  named('writing the same id twice replaces it rather than duplicating it', async (s) => {
    await s.writer.putPin(aPin('p1', { note: 'first' }));
    await s.writer.putPin(aPin('p1', { note: 'second' }));
    const pins = await (await s.reader()).listPins();
    assert.equal(only(pins, 'pin').note, 'second');
  });

  named('unenrichedOnly means owed an attempt, not missing a record', async (s) => {
    // A pin whose model call failed carries a record and is still owed another
    // attempt. A store that reads this as `enrichment === null` makes every
    // model failure permanent and invisible at the same time.
    await s.writer.putPin(aPin('never', { enrichment: null }));
    await s.writer.putPin(aPin('failed', { enrichment: enrichment({ outcome: 'model-failed' }) }));
    await s.writer.putPin(aPin('answered', { enrichment: enrichment({ outcome: 'nothing-found' }) }));
    const owed = (await (await s.reader()).listPins({ unenrichedOnly: true })).map((p) => p.id).sort();
    assert.deepEqual(owed, ['failed', 'never']);
  });

  named('topics, edges, statements, sessions and suggestions all round-trip', async (s) => {
    await s.writer.putTopic(aTopic('t1', ['p1']));
    await s.writer.putEdges([{ from: 't1', to: 't2', confidence: 0.8, justification: 'because' }]);
    await s.writer.putStatement(aStatement('st1', 't1'));
    await s.writer.putSession(aSession('s1', AT, 't1'));
    await s.writer.putSuggestion(aSuggestion('g1', 'pending'));
    const r = await s.reader();
    assert.equal(only(await r.listTopics(), 'topic').id, 't1');
    assert.equal(only(await r.listEdges(), 'edge').confidence, 0.8);
    assert.equal(only(await r.listStatements(), 'statement').id, 'st1');
    assert.equal((await r.getSession('s1'))?.sections.length, 1);
    assert.equal(only(await r.listSuggestions(), 'suggestion').id, 'g1');
    assert.equal((await r.listSuggestions('accepted')).length, 0, 'the state filter is not applied');
  });

  named('a modality question and the answer to it both survive a round trip', async (s) => {
    // SB-282. The mark is what separates a question from a read, and the
    // denial is the learner's own no. A store that dropped either would either
    // ask somebody the same question every morning or read an unanswered one
    // as a claim about them, so both are in the contract rather than left to
    // whichever adapter happens to write objects whole.
    await s.writer.putStatement({
      ...aStatement('mod-1', null),
      modality: {
        key: 'notation-heavy|logic-structure', slower: 'notation-heavy',
        faster: 'logic-structure', askedAt: AT, confirmedAt: null,
      },
    });
    await s.writer.putPrefs({
      ...await s.writer.getPrefs(),
      modalityDenied: { key: 'notation-heavy|logic-structure', at: AT },
    });
    const r = await s.reader();
    assert.deepEqual(only(await r.listStatements(), 'statement').modality, {
      key: 'notation-heavy|logic-structure', slower: 'notation-heavy',
      faster: 'logic-structure', askedAt: AT, confirmedAt: null,
    });
    assert.deepEqual({ ...(await r.getPrefs()).modalityDenied },
      { key: 'notation-heavy|logic-structure', at: AT });
  });

  named('preferences round-trip and are not merged away', async (s) => {
    const prefs: LearnerPrefs = {
      targetMinutes: 45, interfaceLanguage: 'fr', pausedUntil: null,
      // Emptied on purpose. A store that "helpfully" restores the defaults here
      // overrules a choice the learner made.
      excludedDomains: [], interview: { goal: 'ship' }, rejectedOrigins: { 'https://a.test': 2 },
    };
    await s.writer.putPrefs(prefs);
    const back = await (await s.reader()).getPrefs();
    assert.equal(back.targetMinutes, 45);
    assert.equal(back.interfaceLanguage, 'fr');
    assert.deepEqual([...back.excludedDomains], []);
    assert.deepEqual({ ...back.rejectedOrigins }, { 'https://a.test': 2 });
  });

  named('a hosted worker receipt advances by version without clobbering preferences', async (s) => {
    const queued: HostedProcessingReceipt = {
      receiptId: 'receipt_1234567890', state: 'queued', batchKey: '2026-08-27',
      requestedAt: '2026-08-27T01:00:00.000Z', expiresAt: '2026-08-27T01:35:00.000Z',
      checkedAt: '2026-08-27T01:00:00.000Z', asked: false, unprocessedPins: 3,
    };
    assert.equal(await s.writer.compareAndSetHostedProcessing(null, queued), true);
    assert.equal(await s.writer.compareAndSetHostedProcessing(null, {
      ...queued, receiptId: 'receipt_competing_1234',
    }), false, 'a second dispatcher claimed an occupied receipt');

    const prefs = await s.writer.getPrefs();
    await s.writer.putPrefs({
      ...prefs, interfaceLanguage: 'es',
      hostedProcessing: { ...queued, receiptId: 'receipt_injected_1234', state: 'failed' },
    });
    assert.equal((await s.writer.getPrefs()).hostedProcessing?.receiptId, queued.receiptId,
      'the generic preference writer changed service-owned worker state');
    const running: HostedProcessingReceipt = {
      ...queued, state: 'running', checkedAt: '2026-08-27T01:02:00.000Z',
      expiresAt: '2026-08-27T01:37:00.000Z',
    };
    assert.equal(await s.writer.compareAndSetHostedProcessing({
      receiptId: queued.receiptId, state: queued.state, checkedAt: queued.checkedAt,
    }, running), true);
    assert.equal(await s.writer.compareAndSetHostedProcessing({
      receiptId: queued.receiptId, state: queued.state, checkedAt: queued.checkedAt,
    }, { ...running, state: 'failed' }), false, 'a stale worker overwrote the winner');

    const back = await (await s.reader()).getPrefs();
    assert.equal(back.interfaceLanguage, 'es', 'receipt mutation erased a learner preference');
    assert.deepEqual(back.hostedProcessing, running);
  });

  // -------------------------------------------------------------- the ledger

  named('the signal ledger is append-only and keeps its order', async (s) => {
    for (const i of [1, 2, 3]) await s.writer.appendSignal(aSignal(`s${i}`, 't1'));
    const rows = await (await s.reader()).listSignals();
    assert.deepEqual(rows.map((x) => x.id), ['s1', 's2', 's3'],
      'SB-22 needs the history in order; regression is invisible without it');
  });

  named('signals filter by topic, and an unknown topic returns none', async (s) => {
    await s.writer.appendSignal(aSignal('a', 't1'));
    await s.writer.appendSignal(aSignal('b', 't2'));
    const r = await s.reader();
    assert.equal(only(await r.listSignals('t1'), 'signal').id, 'a');
    assert.deepEqual([...await r.listSignals('nope')], []);
  });

  named('invalidating a source event marks only that event', async (s) => {
    await s.writer.appendSignal(aSignal('a', 't1', { sourceEvent: 'section-4' }));
    await s.writer.appendSignal(aSignal('b', 't1', { sourceEvent: 'section-5' }));
    await s.writer.invalidateSignals('section-4');
    const rows = await (await s.reader()).listSignals();
    assert.equal(rows.find((x) => x.id === 'a')?.invalidated, true);
    assert.equal(rows.find((x) => x.id === 'b')?.invalidated, false,
      'SB-45 withdraws the signals from one conceded section, not the learner\'s history');
    assert.equal(rows.length, 2, 'invalidation is a flag, not a delete — the row is evidence');
  });

  named('the latest session is the newest one, whatever order they were written', async (s) => {
    await s.writer.putSession(aSession('old', '2026-08-01T00:00:00.000Z', 't1'));
    await s.writer.putSession(aSession('new', '2026-08-19T00:00:00.000Z', 't1'));
    await s.writer.putSession(aSession('older', '2026-07-01T00:00:00.000Z', 't1'));
    assert.equal((await (await s.reader()).latestSession())?.id, 'new');
  });

  named('every session is readable, not only the newest one', async (s) => {
    // The progression projection (§5a) states the medium-follow-through badge
    // from a warning that was shown on some earlier night and demonstrated on a
    // later one, so it has to be able to see more than this run. A read-only
    // addition: nothing about the write path changed to make it possible.
    await s.writer.putSession(aSession('old', '2026-08-01T00:00:00.000Z', 't1'));
    await s.writer.putSession(aSession('new', '2026-08-19T00:00:00.000Z', 't1'));

    const all = await (await s.reader()).listSessions();
    assert.deepEqual([...all].map((x) => x.id).sort(), ['new', 'old']);
  });

  named('the session list resolves a merged topic id, exactly as a single read does', async (s) => {
    await s.writer.putTopic(aTopic('keep', ['p1']));
    await s.writer.putTopic(aTopic('gone', ['p2']));
    await s.writer.putSession(aSession('s1', AT, 'gone'));
    await s.writer.mergeTopics('keep', 'gone');

    const [only] = await (await s.reader()).listSessions();
    assert.equal(only?.sections[0]?.topicId, 'keep',
      'a list that skipped the alias map would hand the projection a topic that no longer exists');
  });

  // ---------------------------------------------------------------- cascades

  named('deleting a pin takes its signals, its membership and its provenance with it', async (s) => {
    await s.writer.putPin(aPin('p1', { topicId: 't1' }));
    await s.writer.putPin(aPin('p2', { topicId: 't1' }));
    await s.writer.putTopic(aTopic('t1', ['p1', 'p2']));
    await s.writer.appendSignal(aSignal('sig', 't1', { sourceEvent: 'reread:p1' }));
    await s.writer.appendSignal(aSignal('keep', 't1', { sourceEvent: 'reread:p2' }));
    await s.writer.putSession(aSession('s1', AT, 't1', ['p1:0', 'p2:0']));

    await s.writer.deletePin('p1');

    const r = await s.reader();
    assert.equal(await r.getPin('p1'), null);
    assert.deepEqual([...(await r.getTopic('t1'))?.pinIds ?? []], ['p2'],
      'SB-43: a deleted pin must stop being a member of anything');
    assert.deepEqual((await r.listSignals()).map((x) => x.id), ['keep'],
      'a deleted pin must stop counting toward comfort');
    assert.deepEqual([...(await r.getSession('s1'))?.sections[0]?.sourceIds ?? []], ['p2:0'],
      'a session must stop citing a pin the learner deleted');
  });

  named('undoing a pin keeps the topic even when it was the last member', async (s) => {
    await s.writer.putPin(aPin('p1', { topicId: 't1' }));
    await s.writer.putTopic(aTopic('t1', ['p1']));
    await s.writer.deletePin('p1', { keepEmptyTopic: true });
    const r = await s.reader();
    assert.equal(await r.getPin('p1'), null);
    assert.deepEqual((await r.getTopic('t1'))?.pinIds, [],
      'a brief capture Undo must not silently delete a learner-visible topic');
  });

  named('deleting a topic without its pins leaves the pins alone', async (s) => {
    await s.writer.putPin(aPin('p1', { topicId: 't1' }));
    await s.writer.putTopic(aTopic('t1', ['p1']));
    await s.writer.appendSignal(aSignal('sig', 't1'));
    await s.writer.deleteTopic('t1', { deletePins: false });
    const r = await s.reader();
    assert.equal(await r.getTopic('t1'), null);
    assert.ok(await r.getPin('p1'), 'the learner deleted a topic, not their pins');
    assert.deepEqual([...await r.listSignals()], [], 'the history of a deleted topic goes with it');
  });

  named('deleting a topic with its pins takes the pins', async (s) => {
    await s.writer.putPin(aPin('p1', { topicId: 't1' }));
    await s.writer.putTopic(aTopic('t1', ['p1']));
    await s.writer.deleteTopic('t1', { deletePins: true });
    const r = await s.reader();
    assert.equal(await r.getPin('p1'), null);
    assert.equal(await r.getTopic('t1'), null);
  });

  named('a full wipe clears everything and leaves the store usable', async (s) => {
    await s.writer.putPin(aPin('p1'));
    await s.writer.putTopic(aTopic('t1', ['p1']));
    await s.writer.appendSignal(aSignal('sig', 't1'));
    await s.writer.deleteEverything();

    const r = await s.reader();
    assert.deepEqual([...await r.listPins()], []);
    assert.deepEqual([...await r.listTopics()], []);
    assert.deepEqual([...await r.listSignals()], []);
    assert.deepEqual(await r.topicAliases(), {}, 'the alias map is a record of the board too');
    // Still usable afterwards, which a store that closed its own handle is not.
    await s.writer.putPin(aPin('p2'));
    assert.equal(only(await (await s.reader()).listPins(), 'pin').id, 'p2');
  });

  // ----------------------------------------------------- identity repair

  named('a merge retires the absorbed id and keeps the survivor whole', async (s) => {
    await s.writer.putPin(aPin('p1', { topicId: 'keep' }));
    await s.writer.putPin(aPin('p2', { topicId: 'gone' }));
    await s.writer.putTopic(aTopic('keep', ['p1'], { label: 'Reharmonisation' }));
    await s.writer.putTopic(aTopic('gone', ['p2'], { label: 'Modal interchange' }));

    const survivor = await s.writer.mergeTopics('keep', 'gone');
    assert.equal(survivor.id, 'keep');
    assert.equal(survivor.label, 'Reharmonisation', 'the survivor keeps its own name');

    const r = await s.reader();
    assert.deepEqual((await r.listTopics()).map((t) => t.id), ['keep'],
      'a retired id on the board can have new pins attached to it');
    assert.equal((await r.getTopic('gone'))?.id, 'keep',
      'a panel holding the pre-merge id must find the survivor, not nothing');
    assert.deepEqual([...(await r.getTopic('keep'))?.pinIds ?? []].sort(), ['p1', 'p2']);
    assert.equal((await r.getPin('p2'))?.topicId, 'keep');
    assert.deepEqual(await r.topicAliases(), { gone: 'keep' });
  });

  named('a merge unions the comfort history without rewriting the ledger', async (s) => {
    await s.writer.putPin(aPin('p1', { topicId: 'keep' }));
    await s.writer.putPin(aPin('p2', { topicId: 'gone' }));
    await s.writer.putTopic(aTopic('keep', ['p1']));
    await s.writer.putTopic(aTopic('gone', ['p2']));
    await s.writer.appendSignal(aSignal('a', 'keep'));
    await s.writer.appendSignal(aSignal('b', 'gone'));
    await s.writer.mergeTopics('keep', 'gone');

    const r = await s.reader();
    const rows = await r.listSignals('keep');
    assert.deepEqual(rows.map((x) => x.id).sort(), ['a', 'b'],
      'D15: history that detaches from the topic it was about is the failure this seam exists to stop');
    assert.ok(rows.every((x) => x.topicId === 'keep'), 'rows must resolve on read');
    // Asking under the retired id must find the same union, because a caller
    // holding a stale id is normal and not an error.
    assert.equal((await r.listSignals('gone')).length, 2);
  });

  named('a split moves the pins and leaves every signal where it was', async (s) => {
    await s.writer.putPin(aPin('p1', { topicId: 't1' }));
    await s.writer.putPin(aPin('p2', { topicId: 't1' }));
    await s.writer.putTopic(aTopic('t1', ['p1', 'p2']));
    await s.writer.appendSignal(aSignal('a', 't1'));

    const created = await s.writer.splitTopic('t1', ['p2'], 'Sourdough hydration');
    assert.equal(created.label, 'Sourdough hydration');

    const r = await s.reader();
    assert.deepEqual([...(await r.getTopic('t1'))?.pinIds ?? []], ['p1']);
    assert.deepEqual([...(await r.getTopic(created.id))?.pinIds ?? []], ['p2']);
    assert.equal((await r.getPin('p2'))?.topicId, created.id);
    assert.equal(only(await r.listSignals('t1'), 'signal').id, 'a',
      'comfort is not divisible — splitting it would fabricate evidence');
    assert.deepEqual([...await r.listSignals(created.id)], [],
      'a new topic starts with no evidence, which D14 made a safe state to be in');
  });

  named('a split that would empty the original is refused', async (s) => {
    await s.writer.putPin(aPin('p1', { topicId: 't1' }));
    await s.writer.putTopic(aTopic('t1', ['p1']));
    await assert.rejects(
      () => s.writer.splitTopic('t1', ['p1'], 'Everything'),
      (err: unknown) => err instanceof TopicOpError && err.code === 'empty-split',
      'the caller has to be able to tell a bad request from a broken store',
    );
  });

  // ---------------------------------------------------------- caller safety

  named('a list the caller holds is theirs to keep', async (s) => {
    // Every read here crosses what will be a network boundary at port, where
    // the result is always a fresh object. A local store that hands back its own
    // array makes a caller's harmless-looking `.push` or `.sort` a silent
    // corruption that only reproduces on one implementation.
    await s.writer.putSuggestion(aSuggestion('g1', 'pending'));
    await s.writer.putPin(aPin('p1'));
    await s.writer.putTopic(aTopic('t1', ['p1']));
    await s.writer.appendSignal(aSignal('sig', 't1'));

    const r = await s.reader();
    (await r.listSuggestions() as Suggestion[]).push(aSuggestion('ghost', 'pending'));
    (await r.listPins() as Pin[]).length = 0;
    (await r.listTopics() as Topic[]).length = 0;
    (await r.listSignals() as Signal[]).length = 0;

    const after = await s.reader();
    assert.equal((await after.listSuggestions()).length, 1, 'a caller pushed a suggestion into the store');
    assert.equal((await after.listPins()).length, 1, 'a caller emptied the store\'s pins');
    assert.equal((await after.listTopics()).length, 1);
    assert.equal((await after.listSignals()).length, 1);
  });

  /**
   * The same promise, one level deeper.
   *
   * The test above catches a caller mutating the ARRAY a list read handed
   * back. A session is a list read AND an object graph — `session.sections` is
   * itself a mutable array — and `resolveSession` (both implementations) is
   * free to answer the session object unchanged, sections array and all, when
   * there is no alias to rewrite. That is the common case: most boards have
   * never had a merge. A store that takes that shortcut by returning the
   * literal object it holds, rather than a shallow copy, passes the array-level
   * test above while still handing a caller a live handle onto its own
   * `sections` array through `getSession`, `latestSession` and `listSessions`
   * alike — the exact shape `progressionSnapshot` (§5a) reads through on every
   * request, and the exact shape the caller-safety promise above exists to
   * rule out.
   */
  named('a session handed back by a read is not the store\'s own object graph', async (s) => {
    await s.writer.putSession(aSession('s1', AT, 't1'));

    const r1 = await s.reader();
    const bySingle = await r1.getSession('s1');
    (bySingle!.sections as unknown[]).push({ ...bySingle!.sections[0], heading: 'ghost' });

    const r2 = await s.reader();
    const byLatest = await r2.latestSession();
    (byLatest!.sections as unknown[]).push({ ...byLatest!.sections[0], heading: 'ghost-2' });

    const r3 = await s.reader();
    const [byList] = await r3.listSessions();
    (byList!.sections as unknown[]).push({ ...byList!.sections[0], heading: 'ghost-3' });

    const after = await s.reader();
    assert.equal((await after.getSession('s1'))?.sections.length, 1,
      'mutating what getSession handed back must not corrupt the store\'s own session');
    assert.equal((await after.latestSession())?.sections.length, 1,
      'mutating what latestSession handed back must not corrupt the store\'s own session');
    assert.equal((await (await s.reader()).listSessions())[0]?.sections.length, 1,
      'mutating what listSessions handed back must not corrupt the store\'s own session');
  });

  // ------------------------------------------------------------ concurrency

  named('concurrent writes to a cold store all persist', async (s) => {
    // D17, the worst bug in the build: 60 concurrent writes to a cold store
    // persisted 1, because the load flag was set after the await. Any store
    // that lazily initialises can reproduce it, so it belongs in the contract
    // rather than in one implementation's test file.
    await Promise.all(Array.from({ length: 40 }, (_, i) => s.writer.putPin(aPin(`p${i}`))));
    assert.equal((await (await s.reader()).listPins()).length, 40,
      'no pin the learner saved may be lost');
  });

  // ------------------------------------------------- the second ledger (2026-08-23)

  /**
   * Commitments, awards and courses, held to the same promises as everything
   * else — and here rather than in an endpoint test for the reason this file
   * exists at all: `FirestoreStore` gained eight methods that TypeScript is
   * perfectly happy with and that no test had ever run. A store can satisfy the
   * interface completely and lose a learner's plan.
   */
  named('a commitment round-trips, and reads back as the caller wrote it', async (s) => {
    await s.writer.putCommitment(aCommitment('c1', { topicIds: ['t1'], notes: 'the brief' }));
    const got = await (await s.reader()).getCommitment('c1');
    assert.equal(got?.title, 'Commitment c1');
    assert.deepEqual([...(got?.topicIds ?? [])], ['t1']);
    assert.equal(got?.notes, 'the brief');
    assert.equal(got?.doneAt, null);
  });

  named('a commitment that is not there is null, not a throw', async (s) => {
    assert.equal(await (await s.reader()).getCommitment('nope'), null);
  });

  named('closing a commitment is a write the next reader sees', async (s) => {
    await s.writer.putCommitment(aCommitment('c1'));
    await s.writer.putCommitment(aCommitment('c1', { doneAt: '2026-08-23T10:00:00.000Z' }));
    const got = await (await s.reader()).getCommitment('c1');
    assert.equal(got?.doneAt, '2026-08-23T10:00:00.000Z');
    assert.equal((await (await s.reader()).listCommitments()).length, 1, 'an update, not a second row');
  });

  named('deleting a commitment leaves the awards it earned', async (s) => {
    // Deleting the note about an assignment does not undo having handed it in,
    // and a ledger that forgets on tidying up is one nobody can trust a total
    // from. This is the promise, in the contract, where a second store inherits it.
    await s.writer.putCommitment(aCommitment('c1'));
    await s.writer.appendAward(anAward('a1', 'c1'));
    await s.writer.deleteCommitment('c1');
    const r = await s.reader();
    assert.deepEqual([...await r.listCommitments()], []);
    assert.equal((await r.listAwards()).length, 1);
  });

  named('a bounded commitment replacement applies puts and removals together', async (s) => {
    await s.writer.putCommitment(aCommitment('c1'));
    await s.writer.putCommitment(aCommitment('c2'));
    await s.writer.replaceCommitments([
      aCommitment('c2', { title: 'Changed second' }), aCommitment('c3'),
    ], ['c1']);
    const rows = [...await (await s.reader()).listCommitments()]
      .sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(rows.map((row) => [row.id, row.title]), [
      ['c2', 'Changed second'], ['c3', 'Commitment c3'],
    ]);
  });

  named('the award ledger is append-only and keeps what it was told', async (s) => {
    await s.writer.appendAward(anAward('a1', 'c1'));
    await s.writer.appendAward(anAward('a2', 'c1'));
    const awards = await (await s.reader()).listAwards();
    assert.equal(awards.length, 2);
    // Every award can be explained later, which is the whole reason this is a
    // ledger rather than a counter.
    for (const a of awards) {
      assert.equal(a.commitmentId, 'c1');
      assert.ok(a.at && a.reason);
    }
  });

  named('a course round-trips with its material', async (s) => {
    const course = aCourse('k1');
    await s.writer.putCourse({
      ...course,
      material: [{
        id: 'm1', title: 'Lecture 1', url: 'https://example.test/1', kind: 'video',
        minutes: 12, doneAt: null, pinIds: [], addedAt: '2026-08-20T09:00:00.000Z',
      }],
    });
    const got = await (await s.reader()).getCourse('k1');
    assert.equal(got?.material.length, 1);
    assert.equal(got?.material[0]?.title, 'Lecture 1');
    assert.equal(got?.material[0]?.doneAt, null);
  });

  named('a deleted course is gone and the rest of the shelf is not', async (s) => {
    await s.writer.putCourse(aCourse('k1'));
    await s.writer.putCourse(aCourse('k2'));
    await s.writer.deleteCourse('k1');
    const left = await (await s.reader()).listCourses();
    assert.deepEqual(left.map((c) => c.id), ['k2']);
  });

  named('a bounded course replacement moves one exact row without a half shelf', async (s) => {
    await s.writer.putCourse(aCourse('k1'));
    await s.writer.putCourse(aCourse('k2'));
    await s.writer.replaceCourses([
      { ...aCourse('k1'), title: 'Changed first' }, aCourse('k3'),
    ], ['k2']);
    const rows = [...await (await s.reader()).listCourses()]
      .sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(rows.map((row) => [row.id, row.title]), [
      ['k1', 'Changed first'], ['k3', 'Course k3'],
    ]);
  });

  named('awkward text survives the second ledger too', async (s) => {
    await s.writer.putCommitment(aCommitment('c1', { title: AWKWARD, notes: AWKWARD }));
    const got = await (await s.reader()).getCommitment('c1');
    assert.equal(got?.title, AWKWARD);
    assert.equal(got?.notes, AWKWARD);
  });

  named('reviewed intake drafts preserve their immutable source receipt', async (s) => {
    const draft = anIntake('i1');
    await s.writer.putIntakeDraft(draft);
    const got = await (await s.reader()).getIntakeDraft('i1');
    assert.deepEqual(got, draft);
    assert.equal(got?.source.text, AWKWARD);
    assert.equal((await (await s.reader()).listIntakeDrafts()).length, 1);
    assert.equal(await (await s.reader()).getIntakeDraft('nope'), null);
  });

  named('a proposed collection round-trips, unread lead and all', async (s) => {
    // Here for the reason this whole file exists: a store can satisfy the
    // interface completely and lose the thing. `unread` is asserted because a
    // store that dropped it would leave a surface free to render an address
    // nothing has opened as though somebody had checked it.
    const proposal = aProposal('pr1');
    await s.writer.putProspectProposal(proposal);
    const r = await s.reader();
    assert.deepEqual(await r.getProspectProposal('pr1'), proposal);
    assert.equal((await r.listProspectProposals()).length, 1);
    assert.equal(await r.getProspectProposal('nope'), null);

    await s.writer.putProspectProposal({ ...proposal, state: 'dismissed', decidedAt: AT });
    const after = await (await s.reader()).listProspectProposals();
    assert.equal(after.length, 1, 'a decision is an update, not a second row');
    assert.equal(after[0]?.state, 'dismissed');
  });

  named('the passed-over ring round-trips whole, and an unwritten one reads as empty', async (s) => {
    // One record rather than a collection, so what is asserted is that the
    // whole ring survives the trip and that a board that has never written one
    // answers with nothing counted rather than with nothing at all.
    const r0 = await s.reader();
    assert.deepEqual(await r0.getPassedOverLedger(), { startedAt: null, marks: [] });

    const ledger = {
      startedAt: AT,
      marks: [
        { offeredId: 'commitment:c1', offeredReason: 'deadline', chosenId: 'burst:t1', at: AT },
        { offeredId: 'material:k1:m1', offeredReason: 'next-material', chosenId: 'session:s1', at: AT },
      ],
    };
    await s.writer.putPassedOverLedger(ledger);
    assert.deepEqual(await (await s.reader()).getPassedOverLedger(), ledger);

    await s.writer.putPassedOverLedger({ startedAt: AT, marks: [] });
    assert.deepEqual((await (await s.reader()).getPassedOverLedger()).marks, [],
      'the ring is replaced whole, so a trim is a write and not an append');
  });

  named('what went to another surface round-trips, and a removal really removes', async (s) => {
    // The one collection whose promise is about what is NOT written: a row the
    // learner takes off this list leaves nothing behind it anywhere.
    await s.writer.putExternalEntry(anExternal('x1'));
    await s.writer.putExternalEntry({ ...anExternal('x1'), mark: 'hard', markedAt: AT });
    let r = await s.reader();
    assert.equal((await r.listExternalEntries()).length, 1, 'the second write was an insert');
    assert.equal((await r.getExternalEntry('x1'))?.mark, 'hard');
    assert.equal(await r.getExternalEntry('nope'), null);

    await s.writer.deleteExternalEntry('x1');
    r = await s.reader();
    assert.deepEqual([...await r.listExternalEntries()], []);
    assert.deepEqual([...await r.listSignals()], []);
  });

  named('real outcomes and their correction lineage round-trip whole', async (s) => {
    const first = anOutcome('o1');
    const correction: LearningOutcome = {
      ...anOutcome('o2'), score: 9, feedback: 'corrected', supersedesId: 'o1',
    };
    await s.writer.putOutcome(first);
    await s.writer.putOutcome(correction);
    const r = await s.reader();
    assert.deepEqual(await r.getOutcome('o1'), first);
    assert.deepEqual(await r.getOutcome('o2'), correction);
    assert.equal((await r.listOutcomes()).length, 2);
    assert.equal(await r.getOutcome('nope'), null);
  });

  named('a full wipe clears the second ledger with everything else', async (s) => {
    // SB-43 is a full wipe, and the learner's plan is theirs.
    await s.writer.putCommitment(aCommitment('c1'));
    await s.writer.appendAward(anAward('a1', 'c1'));
    await s.writer.putCourse(aCourse('k1'));
    await s.writer.putIntakeDraft(anIntake('i1'));
    await s.writer.putProspectProposal(aProposal('pr1'));
    await s.writer.putExternalEntry(anExternal('x1'));
    await s.writer.putOutcome(anOutcome('o1'));
    await s.writer.putPassedOverLedger({
      startedAt: AT,
      marks: [{ offeredId: 'commitment:c1', offeredReason: 'deadline', chosenId: 'burst:t1', at: AT }],
    });
    await s.writer.deleteEverything();
    const r = await s.reader();
    assert.deepEqual([...await r.listCommitments()], []);
    assert.deepEqual([...await r.listAwards()], []);
    assert.deepEqual([...await r.listCourses()], []);
    assert.deepEqual([...await r.listIntakeDrafts()], []);
    assert.deepEqual([...await r.listProspectProposals()], []);
    assert.deepEqual([...await r.listExternalEntries()], []);
    assert.deepEqual([...await r.listOutcomes()], []);
    assert.deepEqual(await r.getPassedOverLedger(), { startedAt: null, marks: [] });
  });

  named('concurrent writes across different collections do not lose each other', async (s) => {
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => s.writer.putPin(aPin(`p${i}`))),
      ...Array.from({ length: 10 }, (_, i) => s.writer.putTopic(aTopic(`t${i}`, [`p${i}`]))),
      ...Array.from({ length: 10 }, (_, i) => s.writer.appendSignal(aSignal(`s${i}`, `t${i}`))),
      ...Array.from({ length: 10 }, (_, i) => s.writer.putSuggestion(aSuggestion(`g${i}`, 'pending'))),
    ]);
    const r = await s.reader();
    assert.equal((await r.listPins()).length, 10);
    assert.equal((await r.listTopics()).length, 10);
    assert.equal((await r.listSignals()).length, 10);
    assert.equal((await r.listSuggestions()).length, 10);
  });
}
