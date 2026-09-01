import { test } from 'node:test';
import assert from 'node:assert/strict';

import { noLlm, pin, startService, topic, type Harness } from './service-harness.js';

/**
 * The three endpoints behind the learner's repair control, over HTTP.
 *
 * `store-topic-ops.test.ts` in `adapters/` proves the operations. This file
 * proves the *wire*: that a stale panel gets a status code and a machine-
 * readable `code` it can act on, rather than the generic 500 that an unmapped
 * throw would produce. Until now that mapping had been exercised by hand with
 * curl and by nothing else, which is precisely the kind of coverage that is
 * true on the evening it is written and untrue a month later.
 *
 * No model is reachable from any of them — `noLlm` makes a model call a test
 * failure, which is itself part of what these endpoints promise (D15: the
 * partition, and its repair, are never a model's decision).
 */

/** Two topics, three pins: A holds p1 and p2, B holds p3. */
async function board(tag: string): Promise<Harness> {
  const h = await startService(tag, { llm: noLlm() });
  await h.store.putPin(pin('p1', 'A'));
  await h.store.putPin(pin('p2', 'A'));
  await h.store.putPin(pin('p3', 'B'));
  await h.store.putTopic(topic('A', ['p1', 'p2']));
  await h.store.putTopic(topic('B', ['p3']));
  return h;
}

// ------------------------------------------------- GET /topics/:id/pins

test('the split picker gets the topic\'s pins in the topic\'s own order', async (t) => {
  const h = await board('pins');
  t.after(() => h.close());

  const res = await h.call('GET', '/topics/A/pins');
  assert.equal(res.status, 200);
  assert.equal(res.body.topicId, 'A');
  assert.equal(res.body.label, 'label of A');
  assert.deepEqual(res.body.pins.map((p: { id: string }) => p.id), ['p1', 'p2']);
  assert.equal(res.body.pins[0].title, 'page for p1');
  assert.equal(res.body.pins[0].gist, 'what p1 was about');
});

test('a gist falls back to the surrounding text, collapses whitespace and is capped', async (t) => {
  const h = await board('gist');
  t.after(() => h.close());

  // SB-07: a whole-page pin has no selection at all, and the picker still has
  // to show the learner something they can recognise.
  await h.store.putPin(pin('p4', 'A', {
    envelope: {
      ...pin('p4', 'A').envelope,
      selection: null,
      surroundingText: `  many\n\n  spaces  and ${'x'.repeat(400)}`,
    },
  }));
  await h.store.putTopic(topic('A', ['p1', 'p2', 'p4']));

  const gist = (await h.call('GET', '/topics/A/pins')).body.pins[2].gist as string;
  assert.equal(gist.length, 140);
  assert.ok(gist.startsWith('many spaces and xxx'), gist.slice(0, 30));
});

test('pins for an unknown topic is a 404, not an empty list', async (t) => {
  const h = await board('pins-404');
  t.after(() => h.close());

  const res = await h.call('GET', '/topics/nope/pins');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'no such topic');
});

test('pins asked for under a merged-away id land on the survivor', async (t) => {
  const h = await board('pins-alias');
  t.after(() => h.close());
  await h.call('POST', '/topics/B/merge', { into: 'A' });

  // A panel that has not refreshed still holds B. Resolving rather than 404ing
  // is the difference between a stale panel and a broken one.
  const res = await h.call('GET', '/topics/B/pins');
  assert.equal(res.status, 200);
  assert.equal(res.body.topicId, 'A');
  assert.deepEqual(res.body.pins.map((p: { id: string }) => p.id), ['p1', 'p2', 'p3']);
});

// ---------------------------------------------------- POST /topics/:id/merge

test('a merge absorbs the path id into the body id and reports both sides', async (t) => {
  const h = await board('merge');
  t.after(() => h.close());

  const res = await h.call('POST', '/topics/B/merge', { into: 'A' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    ok: true, keptId: 'A', keptLabel: 'label of A', absorbedId: 'B', pinCount: 3,
  });
  assert.deepEqual((await h.store.listTopics()).map((x) => x.id), ['A']);
  assert.equal((await h.store.getPin('p3'))?.topicId, 'A');
});

test('a merge with no target is a 400 the panel can render', async (t) => {
  const h = await board('merge-no-target');
  t.after(() => h.close());

  for (const body of [{}, { into: '' }]) {
    const res = await h.call('POST', '/topics/B/merge', body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'merge needs a topic to merge into');
  }
});

test('merging into a topic that does not exist is unknown-topic, 404', async (t) => {
  const h = await board('merge-unknown-into');
  t.after(() => h.close());

  const res = await h.call('POST', '/topics/B/merge', { into: 'ghost' });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'unknown-topic');
  assert.match(res.body.error, /ghost/);
});

test('merging a topic that does not exist is unknown-topic, 404', async (t) => {
  const h = await board('merge-unknown-from');
  t.after(() => h.close());

  const res = await h.call('POST', '/topics/ghost/merge', { into: 'A' });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'unknown-topic');
});

test('merging a topic into itself is self-merge, 400', async (t) => {
  const h = await board('self-merge');
  t.after(() => h.close());

  const res = await h.call('POST', '/topics/A/merge', { into: 'A' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'self-merge');
});

test('merging an already-absorbed id is absorbed-topic, 400 — a stale panel, not a fault', async (t) => {
  const h = await board('absorbed');
  t.after(() => h.close());
  await h.store.putPin(pin('p5', 'C'));
  await h.store.putTopic(topic('C', ['p5']));
  await h.call('POST', '/topics/B/merge', { into: 'A' });

  // Redirecting this to A would retire a topic the learner never pointed at.
  const res = await h.call('POST', '/topics/B/merge', { into: 'C' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'absorbed-topic');
  assert.match(res.body.error, /already merged into A/);
  assert.deepEqual((await h.store.listTopics()).map((x) => x.id).sort(), ['A', 'C']);
});

// ---------------------------------------------------- POST /topics/:id/split

test('a split moves the named pins into a topic the learner named', async (t) => {
  const h = await board('split');
  t.after(() => h.close());

  const res = await h.call('POST', '/topics/A/split', { pinIds: ['p2'], label: 'Ack deadlines' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.label, 'Ack deadlines');
  assert.equal(res.body.movedPins, 1);
  assert.equal(res.body.remainingPins, 1);

  const created = await h.store.getTopic(res.body.topicId as string);
  assert.deepEqual(created?.pinIds, ['p2']);
  assert.equal(created?.summary, '', 'no invented prose on a surface the learner owns');
  assert.equal((await h.store.getPin('p2'))?.topicId, res.body.topicId);
  assert.deepEqual((await h.store.getTopic('A'))?.pinIds, ['p1']);
});

test('a split label is stored whole or refused before any board mutation', async (t) => {
  const h = await board('split-label-whole');
  t.after(() => h.close());
  const exact = '😀'.repeat(60);
  const refused = await h.call('POST', '/topics/A/split', {
    pinIds: ['p2'], label: `${exact}x`,
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'label-too-long');
  assert.deepEqual((await h.store.getTopic('A'))?.pinIds, ['p1', 'p2']);
  assert.equal((await h.store.getPin('p2'))?.topicId, 'A');
  assert.equal((await h.store.listTopics()).length, 2);

  const accepted = await h.call('POST', '/topics/A/split', {
    pinIds: ['p2'], label: `  ${exact}  `,
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.label, exact);
  assert.equal(Array.from(String(accepted.body.label)).length, 60);
});

test('splitting a topic that does not exist is unknown-topic, 404', async (t) => {
  const h = await board('split-404');
  t.after(() => h.close());

  const res = await h.call('POST', '/topics/ghost/split', { pinIds: ['p1'], label: 'x' });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'unknown-topic');
});

test('a split with no name is empty-label, 400', async (t) => {
  const h = await board('split-label-empty');
  t.after(() => h.close());

  for (const body of [{ pinIds: ['p1'] }, { pinIds: ['p1'], label: '   ' }]) {
    const res = await h.call('POST', '/topics/A/split', body);
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'empty-label');
  }
});

test('a split with nothing selected is empty-selection, 400', async (t) => {
  const h = await board('split-empty');
  t.after(() => h.close());

  for (const body of [{ label: 'Ack deadlines' }, { pinIds: [], label: 'Ack deadlines' }]) {
    const res = await h.call('POST', '/topics/A/split', body);
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'empty-selection');
  }
});

test('a split naming a pin that does not exist is unknown-pin, 400', async (t) => {
  const h = await board('split-unknown-pin');
  t.after(() => h.close());

  const res = await h.call('POST', '/topics/A/split', { pinIds: ['ghost'], label: 'Ack deadlines' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'unknown-pin');
});

test('a split naming a pin from another topic is pin-not-in-topic, 400', async (t) => {
  const h = await board('split-foreign-pin');
  t.after(() => h.close());

  const res = await h.call('POST', '/topics/A/split', { pinIds: ['p3'], label: 'Ack deadlines' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'pin-not-in-topic');
  assert.match(res.body.error, /label of A/);
});

test('a split that would empty the original is empty-split, 400', async (t) => {
  const h = await board('split-all');
  t.after(() => h.close());

  // The original still owns the whole signal ledger, so this would leave the
  // comfort history on a topic with no pins. That is a rename, or a merge.
  const res = await h.call('POST', '/topics/A/split', { pinIds: ['p1', 'p2'], label: 'Everything' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'empty-split');
  assert.deepEqual((await h.store.getTopic('A'))?.pinIds, ['p1', 'p2'], 'nothing moved');
});

test('a store fault is still a 500 — only TopicOpError is translated', async (t) => {
  const h = await board('split-500');
  t.after(() => h.close());
  // A disk error is not a stale panel, and must not be dressed up as one: the
  // panel would tell the learner to refresh and the refresh would not help.
  h.deps.store.splitTopic = async () => { throw new Error('disk went away'); };

  const errors: unknown[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const res = await h.call('POST', '/topics/A/split', { pinIds: ['p1'], label: 'x' });
    assert.equal(res.status, 500);
    assert.equal(res.body.code, undefined);
  } finally {
    console.error = real;
  }
  assert.equal(errors.length, 1, 'and the cause is on the log, not only in the response');
  assert.match(String(errors[0]), /POST \/topics\/A\/split failed/);
});
