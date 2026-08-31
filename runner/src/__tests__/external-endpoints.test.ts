import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  externalSourceEvent, notNowMark, NOT_NOW_DAYS,
  type ExternalEntry, type Signal,
} from '@sb/core';
import { NOW, pin, section, session, startService, topic } from './service-harness.js';

/**
 * THE EXTERNAL LOOP, END TO END THROUGH THE SERVICE.
 *
 * Four doors and one law each. Recording a handoff writes a row and nothing
 * else; the unresolved clearinghouse comes back newest first; a mark writes
 * exactly one mark the product already had a word for and clears that row from
 * the working list; and removing a row writes nothing at all.
 *
 * The last one is the reason several of these assertions count signals rather
 * than reading them. *"Remove it from the external tab with nothing recorded"*
 * is a promise that can only be broken quietly, by a later change adding one
 * withdrawal or one deferral to a branch that is supposed to contain a single
 * store call. A test that asserted the row was gone would pass through that.
 */

const record = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'lesson', label: 'How TLS gets its keys', destination: 'new-tab', topicId: 'A', ...over,
});

const signalsOn = async (
  h: Awaited<ReturnType<typeof startService>>, topicId?: string,
): Promise<readonly Signal[]> => h.store.listSignals(topicId);

const live = (signals: readonly Signal[]): readonly Signal[] =>
  signals.filter((s) => !s.invalidated);

/** A board with one topic, one pin and tonight's session on it. */
const board = async (h: Awaited<ReturnType<typeof startService>>): Promise<void> => {
  await h.store.putTopic(topic('A', ['p1']));
  await h.store.putPin(pin('p1', 'A'));
  await h.store.putSession(session('sess-1', [section('A')]));
};

// ------------------------------------------------------------- recording

test('a send is recorded as a row, with the id and the instant minted here', async (t) => {
  const h = await startService('ext-record');
  t.after(() => h.close());
  await board(h);

  const made = await h.call('POST', '/external', record({
    sessionId: 'sess-1', id: 'a-client-chose-this', sentAt: '1999-01-01T00:00:00.000Z',
  }));
  assert.equal(made.status, 201);
  const entry = made.body.entry as ExternalEntry;
  assert.equal(entry.kind, 'lesson');
  assert.equal(entry.label, 'How TLS gets its keys');
  assert.equal(entry.destination, 'new-tab');
  assert.equal(entry.topicId, 'A');
  assert.equal(entry.sessionId, 'sess-1');
  assert.equal(entry.mark, null);
  // A receipt whose identity and time the sender chooses proves nothing: two
  // panels on one board would write the same id, and a stale tab would date a
  // handoff to whenever it happened to be loaded.
  assert.notEqual(entry.id, 'a-client-chose-this');
  assert.equal(entry.sentAt, NOW);
  // Recording that a tab opened is not evidence about what anybody understands.
  assert.deepEqual([...await signalsOn(h)], []);
});

test('retrying one durable client receipt does not create a second handoff', async (t) => {
  const h = await startService('ext-client-retry');
  t.after(() => h.close());
  const first = await h.call('POST', '/external', record({ clientRef: 'send-once-1' }));
  const retried = await h.call('POST', '/external', record({ clientRef: 'send-once-1' }));

  assert.equal(first.status, 201);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.replayed, true);
  assert.equal((retried.body.entry as ExternalEntry).id, (first.body.entry as ExternalEntry).id);
  assert.equal((await h.store.listExternalEntries()).length, 1);
});

test('two concurrent retries of one client receipt still create one handoff', async (t) => {
  const h = await startService('ext-client-race');
  t.after(() => h.close());
  const [first, second] = await Promise.all([
    h.call('POST', '/external', record({ clientRef: 'send-once-race' })),
    h.call('POST', '/external', record({ clientRef: 'send-once-race' })),
  ]);

  assert.deepEqual([first.status, second.status].sort(), [200, 201]);
  assert.equal((first.body.entry as ExternalEntry).id, (second.body.entry as ExternalEntry).id);
  assert.equal((await h.store.listExternalEntries()).length, 1);
});

test('every destination the rail offers is a destination this door accepts', async (t) => {
  const h = await startService('ext-destinations');
  t.after(() => h.close());
  for (const destination of ['new-tab', 'window', 'side-panel', 'notebook', 'manual']) {
    const made = await h.call('POST', '/external', record({ destination, topicId: null }));
    assert.equal(made.status, 201, destination);
    assert.equal((made.body.entry as ExternalEntry).destination, destination);
  }
  assert.equal((await h.call('POST', '/external', record({ destination: 'telegram' }))).status, 400);
  assert.equal((await h.call('POST', '/external', record({ kind: 'homework' }))).status, 400);
});

test('a label longer than the cap is refused rather than stored short', async (t) => {
  const h = await startService('ext-label-cap');
  t.after(() => h.close());
  assert.equal((await h.call('POST', '/external', record({ label: 'x'.repeat(181) }))).status, 400);
  assert.equal((await h.call('POST', '/external', record({ label: 'x'.repeat(180) }))).status, 201);
});

test('the unresolved clearinghouse comes back newest first', async (t) => {
  const h = await startService('ext-order');
  t.after(() => h.close());
  for (const [i, label] of ['first', 'second', 'third'].entries()) {
    await h.store.putExternalEntry({
      id: `e${i}`, kind: 'manual', label, destination: 'manual',
      sentAt: new Date(Date.parse(NOW) + i * 60_000).toISOString(),
    });
  }
  const read = await h.call('GET', '/external');
  assert.equal(read.status, 200);
  assert.deepEqual((read.body.entries as ExternalEntry[]).map((e) => e.label),
    ['third', 'second', 'first']);
});

test('a resolved row leaves the clearinghouse but remains a durable receipt', async (t) => {
  const h = await startService('ext-cleared-receipt');
  t.after(() => h.close());
  const pending = (await h.call('POST', '/external', record({ label: 'Still waiting' })))
    .body.entry as ExternalEntry;
  const cleared = (await h.call('POST', '/external', record({ label: 'Already answered' })))
    .body.entry as ExternalEntry;
  await h.call('POST', `/external/${cleared.id}/mark`, { mark: 'easy' });

  const read = await h.call('GET', '/external');
  assert.deepEqual((read.body.entries as ExternalEntry[]).map((entry) => entry.id), [pending.id],
    'a resolved receipt is still being served as active work');
  assert.equal((await h.store.getExternalEntry(cleared.id))?.mark, 'easy',
    'clearing the active surface deleted the durable receipt');
});

// ----------------------------------------------------------------- the marks

/** The mapping, asserted one mark at a time against the ledger it writes into.
 *  No new signal kinds: every one of these is a word the product already had. */
for (const [mark, type, direction] of [
  ['easy', 'quick-take-got-it', 'positive'],
  ['hard', 'quick-take-still-shaky', 'negative'],
  ['skipped', 'lineup-not-now', 'neutral'],
  ['done', 'quick-take-got-it', 'positive'],
] as const) {
  test(`${mark} writes exactly one ${type}, under external:<entry>`, async (t) => {
    const h = await startService(`ext-mark-${mark}`);
    t.after(() => h.close());
    await board(h);
    const entry = (await h.call('POST', '/external', record())).body.entry as ExternalEntry;

    const answered = await h.call('POST', `/external/${entry.id}/mark`, { mark });
    assert.equal(answered.status, 200);
    assert.equal(answered.body.wrote, type);

    const written = live(await signalsOn(h, 'A'));
    assert.equal(written.length, 1, 'one mark, one signal');
    assert.equal(written[0]!.type, type);
    assert.equal(written[0]!.direction, direction);
    assert.equal(written[0]!.sourceEvent, externalSourceEvent(entry.id));
    assert.equal((answered.body.entry as ExternalEntry).mark, mark);
    assert.equal((answered.body.entry as ExternalEntry).markLocalOnly, false);
  });
}

test('skipped holds the topic, for the window the reply names', async (t) => {
  const h = await startService('ext-skipped-holds');
  t.after(() => h.close());
  await board(h);
  const entry = (await h.call('POST', '/external', record())).body.entry as ExternalEntry;
  const answered = await h.call('POST', `/external/${entry.id}/mark`, { mark: 'skipped' });
  assert.equal(answered.body.backAfterDays, NOT_NOW_DAYS);
  // The same reader the lineup's X is held by, over the same ledger: this is
  // the deferral the board already knows about rather than a second one.
  const held = notNowMark('A', await signalsOn(h, 'A'), new Date(NOW));
  assert.ok(held, 'the topic is not held out of selection');
  assert.equal(held.sourceEvent, externalSourceEvent(entry.id));
});

test('done is a comfort mark and never a completion the lesson did not see', async (t) => {
  /**
   * A section is completed by a correct answer or by *I know this*, both of
   * them things that happened inside the lesson. An entry saying a lesson was
   * finished on somebody else's surface saw neither, so it writes the honest
   * lesser fact and leaves the section exactly as it was.
   */
  const h = await startService('ext-done-honest');
  t.after(() => h.close());
  await board(h);
  const entry = (await h.call('POST', '/external', record({ sessionId: 'sess-1' })))
    .body.entry as ExternalEntry;
  await h.call('POST', `/external/${entry.id}/mark`, { mark: 'done' });

  const stored = await h.store.getSession('sess-1');
  assert.equal(stored?.sections[0]?.completed, false, 'the section was completed from outside');
  assert.equal(stored?.sections[0]?.completionEvidence, undefined);
  const types = live(await signalsOn(h, 'A')).map((s) => s.type);
  assert.deepEqual(types, ['quick-take-got-it']);
  assert.ok(!types.includes('section-completed'), 'attendance was claimed for a lesson nobody saw');
});

test('a second mark replaces the first, the same way a changed verdict does', async (t) => {
  const h = await startService('ext-mark-replace');
  t.after(() => h.close());
  await board(h);
  const entry = (await h.call('POST', '/external', record())).body.entry as ExternalEntry;

  await h.call('POST', `/external/${entry.id}/mark`, { mark: 'easy' });
  // The same mark twice is one answer pressed twice, not two answers.
  await h.call('POST', `/external/${entry.id}/mark`, { mark: 'easy' });
  assert.equal(live(await signalsOn(h, 'A')).length, 1, 'a double press doubled the mark');

  await h.call('POST', `/external/${entry.id}/mark`, { mark: 'hard' });
  const all = await signalsOn(h, 'A');
  assert.deepEqual(all.filter((s) => s.invalidated).map((s) => s.type), ['quick-take-got-it']);
  assert.deepEqual(live(all).map((s) => s.type), ['quick-take-still-shaky']);
  assert.equal((await h.store.getExternalEntry(entry.id))?.mark, 'hard');
});

test('a mark returns the visible before-and-after consequence from Today', async (t) => {
  const h = await startService('ext-mark-adapts-next');
  t.after(() => h.close());
  await h.store.putTopic(topic('A', ['p1']));
  await h.store.putTopic(topic('B', ['p2']));
  const source = 'A saved source with enough exact words to support one honest minute of teaching.';
  await h.store.putPin(pin('p1', 'A', {
    envelope: { ...pin('p1', 'A').envelope, selection: source, surroundingText: source },
  }));
  await h.store.putPin(pin('p2', 'B', {
    envelope: { ...pin('p2', 'B').envelope, selection: source, surroundingText: source },
  }));
  const entry = (await h.call('POST', '/external', record())).body.entry as ExternalEntry;

  const answered = await h.call('POST', `/external/${entry.id}/mark`, {
    mark: 'easy', availableMinutes: 1,
  });
  const adaptation = answered.body.adaptation as {
    changed: boolean;
    before: { id: string; title: string };
    after: { id: string; title: string };
    changedBecause: string;
  };
  assert.equal(adaptation.changed, true);
  assert.equal(adaptation.before.id, 'take:p1:1');
  assert.equal(adaptation.after.id, 'take:p2:1');
  assert.match(adaptation.changedBecause, /changed your next move/);
  assert.match(adaptation.changedBecause, /label of A/);
  assert.match(adaptation.changedBecause, /label of B/);
});

test('two different marks in flight leave one active answer, in request order', async (t) => {
  const h = await startService('ext-mark-race');
  t.after(() => h.close());
  await board(h);
  const entry = (await h.call('POST', '/external', record())).body.entry as ExternalEntry;

  await Promise.all([
    h.call('POST', `/external/${entry.id}/mark`, { mark: 'easy' }),
    h.call('POST', `/external/${entry.id}/mark`, { mark: 'hard' }),
  ]);

  const all = await signalsOn(h, 'A');
  assert.deepEqual(all.filter((signal) => signal.invalidated).map((signal) => signal.type),
    ['quick-take-got-it']);
  assert.deepEqual(live(all).map((signal) => signal.type), ['quick-take-still-shaky']);
  assert.equal((await h.store.getExternalEntry(entry.id))?.mark, 'hard');
});

test('an entry with nothing on the board behind it keeps its mark and writes none', async (t) => {
  const h = await startService('ext-unlinked');
  t.after(() => h.close());
  await board(h);
  const entry = (await h.call('POST', '/external', {
    kind: 'manual', label: 'A video a friend sent me', destination: 'manual',
  })).body.entry as ExternalEntry;
  assert.equal(entry.topicId, null);

  const answered = await h.call('POST', `/external/${entry.id}/mark`, { mark: 'easy' });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.wrote, null, 'a mark landed on a topic this row does not have');
  assert.equal((answered.body.entry as ExternalEntry).mark, 'easy');
  assert.equal((answered.body.entry as ExternalEntry).markLocalOnly, true);
  assert.equal(answered.body.adaptation.changed, false);
  assert.match(answered.body.adaptation.changedBecause, /not linked to a board subject/);
  assert.deepEqual([...await signalsOn(h)], [], 'the ledger heard about an unlinked row');
});

test('the declared methods and the note ride on the row and reach no tally', async (t) => {
  const h = await startService('ext-methods');
  t.after(() => h.close());
  await board(h);
  const entry = (await h.call('POST', '/external', record())).body.entry as ExternalEntry;
  const answered = await h.call('POST', `/external/${entry.id}/mark`, {
    mark: 'easy',
    methods: ['hands-on', 'read', 'invented-one', 'read'],
    note: 'The worked example was the thing that made it land.',
  });
  // Admitted rather than repaired, in vocabulary order, duplicates collapsed.
  assert.deepEqual((answered.body.entry as ExternalEntry).methods, ['read', 'hands-on']);
  assert.equal((answered.body.entry as ExternalEntry).note,
    'The worked example was the thing that made it land.');
  // One signal, and it is the comfort mark. A declared method is not a checked
  // outcome and may not write the claim it would then be asked to confirm.
  assert.deepEqual(live(await signalsOn(h, 'A')).map((s) => s.type), ['quick-take-got-it']);
  assert.deepEqual([...await h.store.listStatements()], []);
});

test('a mark this product does not have is refused rather than defaulted', async (t) => {
  const h = await startService('ext-mark-unknown');
  t.after(() => h.close());
  await board(h);
  const entry = (await h.call('POST', '/external', record())).body.entry as ExternalEntry;
  assert.equal((await h.call('POST', `/external/${entry.id}/mark`, { mark: 'brilliant' })).status, 400);
  assert.deepEqual([...await signalsOn(h)], []);
  assert.equal((await h.call('POST', '/external/nope/mark', { mark: 'easy' })).status, 404);
});

// -------------------------------------------------------------- the removal

test('removing an entry deletes it and records nothing at all', async (t) => {
  const h = await startService('ext-remove');
  t.after(() => h.close());
  await board(h);
  const entry = (await h.call('POST', '/external', record())).body.entry as ExternalEntry;

  const gone = await h.call('DELETE', `/external/${entry.id}`);
  assert.equal(gone.status, 200);
  assert.deepEqual((await h.call('GET', '/external')).body.entries, []);
  assert.equal(await h.store.getExternalEntry(entry.id), null);
  // The whole contract, as a count. Not a deferral, not a withdrawal, not a
  // preference: nothing.
  assert.deepEqual([...await signalsOn(h)], []);
  assert.deepEqual([...await h.store.listStatements()], []);
  assert.deepEqual((await h.store.getPassedOverLedger()).marks, []);
  assert.equal((await h.call('DELETE', `/external/${entry.id}`)).status, 404);
});

test('removing a marked entry leaves the mark it already made standing', async (t) => {
  /**
   * The learner said the ROW should go. They did not say the thing they told
   * us about their comfort never happened, and withdrawing a signal nobody
   * asked to withdraw is the same kind of silent rewrite `invalidateSignals`
   * exists to be careful with.
   */
  const h = await startService('ext-remove-marked');
  t.after(() => h.close());
  await board(h);
  const entry = (await h.call('POST', '/external', record())).body.entry as ExternalEntry;
  await h.call('POST', `/external/${entry.id}/mark`, { mark: 'hard' });
  await h.call('DELETE', `/external/${entry.id}`);
  assert.deepEqual(live(await signalsOn(h, 'A')).map((s) => s.type), ['quick-take-still-shaky']);
});
