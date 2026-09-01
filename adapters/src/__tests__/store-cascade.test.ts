import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonStore } from '../json-store.js';

/**
 * SB-43: deletion must propagate into derived state. This is the test that
 * matters most in the whole suite — a deleted pin still shaping tomorrow's
 * session is a broken promise to the user, and it is invisible without a test.
 */

const store = () => new JsonStore(join(mkdtempSync(join(tmpdir(), 'sb-')), 'db.json'));

const pin = (id: string) => ({
  id, type: 'interest' as const,
  envelope: {
    selection: 'x', parts: [], surroundingText: 'y', headingPath: [],
    pageTitle: 't', url: 'https://e.com', canonicalUrl: null, siteName: null,
    contentLanguage: 'en', media: null,
  },
  note: null, capturedAt: '2026-08-01T00:00:00Z',
  fromSuggestion: false, enrichment: null, topicId: 'T1',
});

test('deleting a pin removes it from its topic', async () => {
  const s = store();
  await s.putPin(pin('p1')); await s.putPin(pin('p2'));
  await s.putTopic({ id: 'T1', label: 'L', summary: 'S', pinIds: ['p1', 'p2'],
    state: 'working', comfort: 0.5, lastExposedAt: null, retiredByUser: false, createdAt: '2026-08-01T00:00:00Z' });
  await s.deletePin('p1');
  assert.deepEqual((await s.getTopic('T1'))?.pinIds, ['p2']);
});

test('deleting a pin stops its signals counting toward comfort', async () => {
  const s = store();
  await s.putPin(pin('p1'));
  await s.appendSignal({ id: 'g1', topicId: 'T1', type: 'answer-wrong', direction: 'negative',
    at: '2026-08-02T00:00:00Z', sourceEvent: 'answer:sess:p1', invalidated: false });
  await s.deletePin('p1');
  assert.equal((await s.listSignals()).length, 0, 'a deleted pin must leave no trace in the ledger');
});

test('deleting a pin strips it from session provenance', async () => {
  const s = store();
  await s.putPin(pin('p1'));
  await s.putSession({
    id: 'S1', builtAt: '2026-08-03T00:00:00Z', fromPinCount: 1, targetMinutes: 15,
    estimatedMinutes: 10, currentSectionIndex: 0, closingNote: null,
    sections: [{ topicId: 'T1', heading: 'h', body: 'b', depth: 'building', estimatedMinutes: 10,
      question: null, sourceIds: ['p1:origin', 'p9:origin'], completed: false }],
  });
  await s.deletePin('p1');
  const sess = await s.getSession('S1');
  assert.deepEqual(sess?.sections[0]?.sourceIds, ['p9:origin'],
    'a session must not keep citing a source the user deleted');
});

test('a topic emptied by deletion does not linger', async () => {
  const s = store();
  await s.putPin(pin('p1'));
  await s.putTopic({ id: 'T1', label: 'L', summary: 'S', pinIds: ['p1'], state: 'working',
    comfort: 0.5, lastExposedAt: null, retiredByUser: false, createdAt: '2026-08-01T00:00:00Z' });
  await s.deletePin('p1');
  assert.equal(await s.getTopic('T1'), null);
});

test('deleting a topic removes its edges, signals and statements', async () => {
  const s = store();
  await s.putTopic({ id: 'T1', label: 'L', summary: 'S', pinIds: [], state: 'working',
    comfort: 0.5, lastExposedAt: null, retiredByUser: false, createdAt: '2026-08-01T00:00:00Z' });
  await s.putEdges([{ from: 'T1', to: 'T2', confidence: 0.9, justification: 'j' }]);
  await s.appendSignal({ id: 'g1', topicId: 'T1', type: 'answer-correct', direction: 'positive',
    at: '2026-08-02T00:00:00Z', sourceEvent: 'x', invalidated: false });
  await s.putStatement({ id: 'st1', text: 'you know this', topicId: 'T1', userEdited: false,
    evidenceSignalIds: [], updatedAt: '2026-08-02T00:00:00Z' });
  await s.deleteTopic('T1', { deletePins: false });
  assert.equal((await s.listEdges()).length, 0);
  assert.equal((await s.listSignals()).length, 0);
  assert.equal((await s.listStatements()).length, 0);
});

/**
 * Deletion meets the topic alias map.
 *
 * A merge retires a topic id rather than rewriting its signals, so after a
 * merge there is history in the ledger recorded under an id that no longer
 * names anything. SB-43 says deletion must reach derived state; these are the
 * cases where "derived state" now includes an alias.
 */

const topic = (id: string, pinIds: readonly string[]) => ({
  id, label: `L${id}`, summary: 'S', pinIds, state: 'working' as const,
  comfort: 0.5, lastExposedAt: null, retiredByUser: false, createdAt: '2026-08-01T00:00:00Z',
});

const sig = (id: string, topicId: string) => ({
  id, topicId, type: 'answer-correct' as const, direction: 'positive' as const,
  at: '2026-08-02T00:00:00Z', sourceEvent: `answer:sess:${id}`, invalidated: false,
});

/** T1 with p1, T2 with p2, a signal on each, then T2 merged into T1. */
async function merged(s: ReturnType<typeof store>): Promise<void> {
  await s.putPin({ ...pin('p1'), topicId: 'T1' });
  await s.putPin({ ...pin('p2'), topicId: 'T2' });
  await s.putTopic(topic('T1', ['p1']));
  await s.putTopic(topic('T2', ['p2']));
  await s.appendSignal(sig('g1', 'T1'));
  await s.appendSignal(sig('g2', 'T2'));
  await s.mergeTopics('T1', 'T2');
}

test('deleting a topic takes the history that was merged into it', async () => {
  // The deletion choice, stated as a test. The learner sees one topic and
  // deletes one topic; the absorbed id is a record of how it got its history,
  // not a separate thing they could have chosen to keep. Resurrecting T2 so its
  // signals survived would put a topic back on a board they just cleared.
  const s = store();
  await merged(s);
  await s.deleteTopic('T1', { deletePins: false });

  assert.equal((await s.listTopics()).length, 0);
  assert.equal((await s.listSignals()).length, 0, 'the absorbed history went with the topic that held it');
  assert.deepEqual(await s.topicAliases(), {}, 'and the alias is gone rather than dangling');
});

test('deleting an absorbed id is a no-op, not a crash and not a deletion', async () => {
  // T2 no longer names anything the learner can see. Resolving the id would
  // delete T1 — a live topic they never pointed at.
  const s = store();
  await merged(s);
  await s.deleteTopic('T2', { deletePins: false });

  assert.deepEqual((await s.listTopics()).map((t) => t.id), ['T1']);
  assert.equal((await s.listSignals()).length, 2, 'both histories intact');
  assert.deepEqual(await s.topicAliases(), { T2: 'T1' });
});

test('an alias never outlives the topic it points at', async () => {
  // Deleting the last pin empties T1, which drops the topic. The alias has to
  // go with it: left behind, it would resolve a live-looking id to a topic that
  // is no longer on the board.
  const s = store();
  await merged(s);
  await s.deletePin('p1');
  await s.deletePin('p2');

  assert.equal(await s.getTopic('T1'), null);
  assert.equal(await s.getTopic('T2'), null, 'and the old id does not resolve to a ghost either');
  assert.deepEqual(await s.topicAliases(), {});
  // And the history goes too — both halves of it. This used to leave the
  // signals in the ledger, inert, on the argument that an emptying cascade is
  // not a confirmed deletion. It is: the learner deleted every pin the topic
  // was built on, one at a time, and SB-43 says a deletion reaches derived
  // state. History that can never surface again is not history.
  assert.equal((await s.listSignals()).length, 0,
    'emptying an alias target takes the merged history with it, transitively');
});

test('emptying a topic by deleting its pins takes its own history', async () => {
  // The signal is not traceable to the pin — a section-completed signal names
  // the section, not the pin it was built from — so nothing but the topic
  // dropping can account for it.
  const s = store();
  await s.putPin(pin('p1'));
  await s.putTopic(topic('T1', ['p1']));
  await s.appendSignal({ ...sig('g1', 'T1'), sourceEvent: 'section:sess1:0' });
  await s.putEdges([{ from: 'T1', to: 'T2', confidence: 0.9, justification: 'j' }]);
  await s.putStatement({ id: 'st1', text: 'you keep coming back to this', topicId: 'T1',
    userEdited: false, evidenceSignalIds: ['g1'], updatedAt: '2026-08-02T00:00:00Z' });

  await s.deletePin('p1');

  assert.equal(await s.getTopic('T1'), null);
  assert.equal((await s.listSignals()).length, 0, 'the ledger keeps nothing for a topic that is gone');
  assert.equal((await s.listEdges()).length, 0, 'and no edge points at it');
  assert.equal((await s.listStatements()).length, 0, 'and nothing is still claimed about it');
});

test('emptying one topic leaves every other history alone', async () => {
  const s = store();
  await s.putPin({ ...pin('p1'), topicId: 'T1' });
  await s.putPin({ ...pin('p2'), topicId: 'T2' });
  await s.putTopic(topic('T1', ['p1']));
  await s.putTopic(topic('T2', ['p2']));
  await s.appendSignal({ ...sig('g1', 'T1'), sourceEvent: 'section:sess1:0' });
  await s.appendSignal({ ...sig('g2', 'T2'), sourceEvent: 'section:sess1:1' });

  await s.deletePin('p1');

  assert.deepEqual((await s.listTopics()).map((t) => t.id), ['T2']);
  assert.deepEqual((await s.listSignals()).map((x) => x.id), ['g2'],
    'the cascade is scoped to the topic that emptied, not to the ledger');
});

test('a topic the learner retired keeps its history when its last pin goes', async () => {
  // Retirement is the learner's own decision and outranks the cascade: the
  // topic stays on the board without pins, so it is not a topic that died and
  // there is nothing to take with it. Un-retiring it must find its history.
  const s = store();
  await s.putPin(pin('p1'));
  await s.putTopic({ ...topic('T1', ['p1']), retiredByUser: true });
  await s.appendSignal({ ...sig('g1', 'T1'), sourceEvent: 'section:sess1:0' });

  await s.deletePin('p1');

  assert.equal((await s.getTopic('T1'))?.retiredByUser, true);
  assert.equal((await s.listSignals()).length, 1);
});

test('emptying a merge target takes history from two hops back', async () => {
  const s = store();
  await s.putPin({ ...pin('p1'), topicId: 'T1' });
  await s.putPin({ ...pin('p2'), topicId: 'T2' });
  await s.putPin({ ...pin('p3'), topicId: 'T3' });
  await s.putTopic(topic('T1', ['p1']));
  await s.putTopic(topic('T2', ['p2']));
  await s.putTopic(topic('T3', ['p3']));
  await s.appendSignal({ ...sig('g3', 'T3'), sourceEvent: 'section:sess1:0' });
  await s.mergeTopics('T2', 'T3');  // T3 -> T2
  await s.mergeTopics('T1', 'T2');  // T2 -> T1

  // One topic on the board now, holding three pins. Emptying it is emptying
  // all three, so the chain goes with it exactly as `deleteTopic` takes it.
  for (const p of ['p1', 'p2', 'p3']) await s.deletePin(p);

  assert.equal((await s.listTopics()).length, 0);
  assert.deepEqual(await s.topicAliases(), {});
  assert.equal((await s.listSignals()).length, 0, 'including history two hops back');
});

test('the pin cascade and a confirmed topic deletion agree', async () => {
  // The ruling stated as a test: reaching an empty topic one pin at a time and
  // deleting the topic outright leave the store in the same place.
  const viaPins = store();
  await merged(viaPins);
  await viaPins.deletePin('p1');
  await viaPins.deletePin('p2');

  const viaTopic = store();
  await merged(viaTopic);
  await viaTopic.deleteTopic('T1', { deletePins: true });

  assert.deepEqual(await viaPins.listTopics(), await viaTopic.listTopics());
  assert.deepEqual(await viaPins.listSignals(), await viaTopic.listSignals());
  assert.deepEqual(await viaPins.listPins(), await viaTopic.listPins());
  assert.deepEqual(await viaPins.topicAliases(), await viaTopic.topicAliases());
});

test('deleting a topic with pins cascades through a merge', async () => {
  const s = store();
  await merged(s);
  await s.deleteTopic('T1', { deletePins: true });
  assert.equal((await s.listPins()).length, 0, 'both the original pins and the absorbed ones go');
  assert.equal((await s.listTopics()).length, 0);
  assert.deepEqual(await s.topicAliases(), {});
});

test('deleting a chain of merges cleans the whole chain up', async () => {
  const s = store();
  await s.putPin({ ...pin('p1'), topicId: 'T1' });
  await s.putPin({ ...pin('p2'), topicId: 'T2' });
  await s.putPin({ ...pin('p3'), topicId: 'T3' });
  await s.putTopic(topic('T1', ['p1']));
  await s.putTopic(topic('T2', ['p2']));
  await s.putTopic(topic('T3', ['p3']));
  await s.appendSignal(sig('g3', 'T3'));
  await s.mergeTopics('T2', 'T3');  // T3 -> T2
  await s.mergeTopics('T1', 'T2');  // T2 -> T1

  await s.deleteTopic('T1', { deletePins: false });
  assert.deepEqual(await s.topicAliases(), {}, 'both hops of the chain are cleared');
  assert.equal((await s.listSignals()).length, 0, 'including history two hops back');
});

test('a split leaves both topics deletable on their own', async () => {
  const s = store();
  await s.putPin({ ...pin('p1'), topicId: 'T1' });
  await s.putPin({ ...pin('p2'), topicId: 'T1' });
  await s.putTopic(topic('T1', ['p1', 'p2']));
  await s.appendSignal(sig('g1', 'T1'));
  const created = await s.splitTopic('T1', ['p2'], 'Split out');

  await s.deleteTopic(created.id, { deletePins: false });
  assert.deepEqual((await s.listTopics()).map((t) => t.id), ['T1']);
  assert.equal((await s.listSignals()).length, 1,
    'deleting the new topic cannot take history it never had');
});
