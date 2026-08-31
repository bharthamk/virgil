import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MODALITY_DENIED_DAYS, type Signal, type Statement, type Topic } from '@sb/core';

import { NOW, noLlm, startService, type Harness } from './service-harness.js';

/**
 * , THROUGH THE DOORS THE LEARNER ACTUALLY USES.
 *
 * The claim-discipline law in PRODUCT_SHAPE.md is not a property of the
 * arithmetic; it is a property of what the doors will and will not do. Four
 * things are asserted here, and each of them is the law rather than a detail:
 *
 *  - the question reaches the screen as a question, with its evidence;
 *  - yes turns it into an ordinary confirmed read and nothing else;
 *  - no records a denial the preferences door can neither write nor clear;
 *  - and neither answer changes what the learner is offered, because this slice
 *    deliberately has no selection effect at all.
 */

const DAY_MS = 86_400_000;
const ago = (days: number): string => new Date(Date.parse(NOW) - days * DAY_MS).toISOString();

const topic = (id: string, label: string): Topic => ({
  id, label, summary: '', pinIds: [], state: 'working', comfort: 0.5,
  lastExposedAt: null, retiredByUser: false, createdAt: ago(120),
});

const signal = (id: string, topicId: string): Signal => ({
  id, topicId, type: 'answer-wrong', direction: 'negative',
  at: ago(2), sourceEvent: 'test', invalidated: false,
});

const QUESTION: Statement = {
  id: 'mod-1',
  text: 'Recent checks suggest notation heavy material goes less smoothly for you than'
    + ' logic and structure work: 1 of 5 checks went well on notation heavy material,'
    + ' against 5 of 6 on logic and structure work. Does that match how it feels?',
  topicId: null,
  userEdited: false,
  evidenceSignalIds: ['sig-1'],
  updatedAt: ago(0),
  modality: {
    key: 'notation-heavy|logic-structure',
    slower: 'notation-heavy',
    faster: 'logic-structure',
    askedAt: ago(0),
    confirmedAt: null,
  },
};

async function askedBoard(tag: string): Promise<Harness> {
  const h = await startService(tag, { llm: noLlm() });
  await h.store.putTopic(topic('t-notation', 'Laplace transforms'));
  await h.store.appendSignal(signal('sig-1', 't-notation'));
  await h.store.putStatement(QUESTION);
  return h;
}

test('the question reaches Insights as a question, with the evidence behind it', async (t) => {
  const h = await askedBoard('modality-read');
  t.after(() => h.close());

  const read = await h.call('GET', '/model');
  assert.equal(read.status, 200);
  const rows = read.body.statements as readonly Record<string, unknown>[];
  const question = rows.find((row) => row.id === 'mod-1');
  assert.equal(question?.text, QUESTION.text, 'the counts are in the sentence itself');
  assert.deepEqual(question?.modality, { key: 'notation-heavy|logic-structure', confirmed: false });
  assert.equal(question?.userEdited, false);
  assert.deepEqual(question?.evidence, [
    { type: 'answer-wrong', topic: 'Laplace transforms', active: true },
  ], 'the receipt says what it was built from, in the learner-safe words');
});

test('yes makes it an ordinary confirmed read and nothing more', async (t) => {
  const h = await askedBoard('modality-confirm');
  t.after(() => h.close());

  const done = await h.call('POST', '/model/mod-1/confirm');
  assert.equal(done.status, 200);
  assert.equal(done.body.confirmed, true);

  const [stored] = await h.store.listStatements();
  assert.equal(stored?.modality?.confirmedAt, NOW);
  assert.equal(stored?.text, QUESTION.text, 'the sentence is unchanged: they agreed with this one');
  assert.equal(stored?.userEdited, false, 'agreeing with a read does not make it their words');
  assert.equal(stored?.rejected, undefined);
  assert.equal((await h.store.getPrefs()).modalityDenied, undefined);

  const again = await h.call('POST', '/model/mod-1/confirm');
  assert.equal(again.body.alreadyConfirmed, true, 'confirming twice is not an error');

  const read = await h.call('GET', '/model');
  const rows = read.body.statements as readonly Record<string, unknown>[];
  assert.deepEqual(rows.find((row) => row.id === 'mod-1')?.modality,
    { key: 'notation-heavy|logic-structure', confirmed: true });
});

test('no is stored where the preferences door cannot reach it', async (t) => {
  const h = await askedBoard('modality-deny');
  t.after(() => h.close());

  const done = await h.call('DELETE', '/model/mod-1');
  assert.equal(done.status, 200);
  assert.equal(done.body.rejected, true);
  assert.equal(done.body.quietForDays, MODALITY_DENIED_DAYS,
    'the screen is told the number so it can promise it out loud');

  const prefs = await h.store.getPrefs();
  assert.equal(prefs.modalityDenied?.key, 'notation-heavy|logic-structure');
  assert.equal(prefs.modalityDenied?.at, NOW);
  const [stored] = await h.store.listStatements();
  assert.equal(stored?.rejected, true, 'the rejection receipt is kept as well as the denial');

  const read = await h.call('GET', '/model');
  assert.deepEqual(read.body.statements, [],
    'a denied question is gone from the screen the moment it is denied');
});

test('a denial can be neither forged nor cleared through the preferences door', async (t) => {
  const h = await askedBoard('modality-prefs-door');
  t.after(() => h.close());
  await h.call('DELETE', '/model/mod-1');

  const forged = await h.call('PUT', '/prefs', { modalityDenied: null, targetMinutes: 15 });
  assert.equal(forged.status, 200);
  assert.equal((await h.store.getPrefs()).modalityDenied?.at, NOW,
    'the patch validator does not name the field, so a client cannot clear it');

  const invented = await h.call('PUT', '/prefs', {
    modalityDenied: { key: 'hands-on|logic-structure', at: NOW }, targetMinutes: 15,
  });
  assert.equal(invented.status, 200);
  assert.equal((await h.store.getPrefs()).modalityDenied?.key, 'notation-heavy|logic-structure',
    'and cannot write one either');
});

test('rewriting the question in your own words answers it', async (t) => {
  const h = await askedBoard('modality-edit');
  t.after(() => h.close());

  const saved = await h.call('PUT', '/model/mod-1', {
    text: 'Symbols slow me down when I am tired, and not otherwise.',
  });
  assert.equal(saved.status, 200);
  const [stored] = await h.store.listStatements();
  assert.equal(stored?.userEdited, true);
  assert.equal(stored?.modality?.confirmedAt, NOW,
    'a sentence that no longer asks anything must not hold the one-at-a-time slot for ever');
});

test('the confirm door refuses what it has nothing to say about', async (t) => {
  const h = await startService('modality-not-a-question', { llm: noLlm() });
  t.after(() => h.close());
  const made = await h.call('POST', '/model', { text: 'I need a worked example first.' });
  const id = (made.body.statement as { id: string }).id;
  const own = await h.call('POST', `/model/${id}/confirm`);
  assert.equal(own.status, 400, 'their own words are already theirs');
  assert.match(own.body.error, /do not need confirming/);
  assert.equal((await h.call('POST', '/model/nobody/confirm')).status, 404);
});
