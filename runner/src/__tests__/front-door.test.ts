import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cluster, pinClusterText, type Pin } from '@sb/core';
import { TfIdfEmbedder } from '@sb/adapters';
import { capture } from '@sb/extension/dist/capture.js';
import { buildPinBody } from '@sb/extension/dist/pin-body.js';
import {
  acrossExecuteScriptBoundary, installPage, node, type FakeNode, type NodeInit,
} from '@sb/extension/dist/__tests__/dom-stub.js';

import { StubLlm, startService } from './service-harness.js';

/**
 * The front door, wired to the engine.
 *
 * Every green clustering result in this repo runs on the seed corpus, which is
 * loaded by `seed/load.ts` — and `load.ts` is the one place in the codebase that
 * fills in `envelope.parts`. The extension never emitted it, `pinRequestFrom`
 * never defaulted it, and `pinClusterText` reads `e.parts.map(...)` with no
 * guard. So a board built by actually pinning things threw inside the cluster
 * stage, the stage caught it because it is failure-tolerant, and the learner got
 * a board with no topics on it and no error anywhere.
 *
 * This file is the test that nobody had: a page, the real injected `capture()`
 * run the way Chrome runs it, the real POST body the service worker builds, the
 * real endpoint, the real store, and the real clusterer — end to end, with no
 * model and no network. If "capture costs one gesture" is true, it is true
 * because this passes.
 */

const para = (text: string): FakeNode => node({ tag: 'p', text });

/** A page shaped like the ones people actually pin from. */
const page = (title: string, paragraphs: readonly string[], extra: readonly NodeInit[] = []): FakeNode =>
  node({
    tag: 'body',
    children: [
      node({ tag: 'nav', text: 'Home Docs' }),
      node({
        tag: 'article',
        children: [
          node({ tag: 'h1', text: title }),
          ...extra.map((e) => node(e)),
          ...paragraphs.map(para),
        ],
      }),
    ],
  });

/**
 * One pin, made the way the product makes one: inject `capture`, build the body
 * the service worker builds, post it to the endpoint the extension posts to.
 * Nothing here reaches around the client.
 */
async function pinThrough(
  h: Awaited<ReturnType<typeof startService>>,
  opts: {
    body: FakeNode;
    title: string;
    url: string;
    type?: 'interest' | 'struggle';
    select?: { text: string; at: FakeNode };
  },
): Promise<Pin> {
  const undo = installPage({
    body: opts.body,
    title: opts.title,
    url: opts.url,
    lang: 'en',
    ...(opts.select ? { selection: { text: opts.select.text, startContainer: opts.select.at, commonAncestorContainer: opts.select.at } } : {}),
  });
  let envelope;
  try {
    envelope = acrossExecuteScriptBoundary(capture)();
  } finally { undo(); }

  const posted = buildPinBody(opts.type ?? 'interest', envelope, '2026-08-19T10:00:00.000Z');
  const res = await h.call('POST', '/pins', posted);
  assert.equal(res.status, 201, `the service refused a pin the extension actually makes: ${JSON.stringify(res.body)}`);

  const stored = await h.store.getPin(res.body.id);
  assert.ok(stored, 'the pin was accepted and then could not be read back');
  return stored;
}

// ------------------------------------------------------------ the acceptance

test('a real pin survives capture, POST, the store and the clusterer — and lands in a topic', async (t) => {
  // The whole claim, in one test. No LLM does any thinking here: the Scout stub
  // answers from its schema and the clusterer's naming call is the only other
  // model call, so the partition is arithmetic over TF-IDF vectors.
  const h = await startService('front-door');
  t.after(() => h.close());

  const ack = 'An acknowledgement deadline is how long the subscriber has to ack a message before it is redelivered.';
  const ackPage = page('Pub/Sub — acknowledgement', [
    ack,
    'If the deadline passes the message is redelivered, so every handler has to be idempotent about redelivery.',
  ]);

  const pins = [
    await pinThrough(h, {
      body: ackPage, title: 'Pub/Sub — acknowledgement', url: 'https://example.test/pubsub/ack',
      type: 'struggle', select: { text: ack, at: ackPage.find('article').children[2] as FakeNode },
    }),
    await pinThrough(h, {
      body: page('Pub/Sub — delivery', [
        'At-least-once delivery means a subscriber can see the same message more than once and must cope with it.',
        'Exactly-once is a stronger guarantee and it costs latency, so the default subscription does not offer it.',
      ]),
      title: 'Pub/Sub — delivery', url: 'https://example.test/pubsub/delivery',
    }),
    await pinThrough(h, {
      body: page('IAM — conditions', [
        'A condition on a role binding restricts when the binding grants access, using an expression over the request.',
        'Conditions are evaluated per request, so a binding that grants access today can refuse it tomorrow.',
      ]),
      title: 'IAM — conditions', url: 'https://example.test/iam/conditions',
    }),
  ];

  // 1. The envelope the extension actually produced carries parts.
  assert.ok(pins[0]!.envelope.parts.length > 0,
    'the capture path emitted no parts, which is the defect this whole file exists for');
  assert.deepEqual([...new Set(pins[0]!.envelope.parts.map((p) => p.role))], ['passage']);

  // 2. The step that used to throw. `TypeError: Cannot read properties of
  //    undefined (reading 'map')` was the entire reason a real board had no
  //    topics, and it happened here.
  for (const p of pins) {
    assert.doesNotThrow(() => pinClusterText(p), 'a capture-shaped envelope still breaks the clusterer');
  }
  assert.match(pinClusterText(pins[0]!), /passage: /, 'and the parts reach the text that gets embedded');

  // 3. The whole point: topics, from pins made through the front door.
  const out = await cluster(
    { llm: new StubLlm((req) => (String(req.system).includes('You name topics')
      ? { names: [{ groupId: 'g0', label: 'Pub/Sub delivery', summary: 'How redelivery works.' },
                  { groupId: 'g1', label: 'IAM conditions', summary: 'When a binding grants access.' }] }
      : undefined)), embedder: new TfIdfEmbedder() },
    { pins, existingTopics: [] },
  );

  assert.ok(out.clusters.length >= 1, 'a board built by pinning produced no topics at all');
  assert.deepEqual(out.unassigned, [], 'every pin the learner made is on the board');
  assert.deepEqual(
    [...out.clusters.flatMap((c) => c.pinIds)].sort(),
    pins.map((p) => p.id).sort(),
    'the topics account for exactly the pins that were made',
  );
  for (const c of out.clusters) assert.ok(c.label.trim().length > 0, 'a topic with no name is not a topic');
});

// --------------------------------------------------------- degrading honestly

test('a pin stored by a client that never emitted parts does not take the nightly down', async (t) => {
  // There are such pins on disk. They pre-date the fix, they cannot be
  // rewritten, and the cluster stage swallowing their TypeError is exactly how
  // this stayed invisible for the life of the extension.
  const h = await startService('front-door-legacy');
  t.after(() => h.close());

  const legacy = {
    type: 'interest' as const,
    envelope: {
      selection: 'A subscriber that is slow will see the message again.',
      surroundingText: 'A subscriber that is slow will see the message again.',
      headingPath: ['Pub/Sub'],
      pageTitle: 'Pub/Sub',
      url: 'https://example.test/old',
      canonicalUrl: null,
      siteName: 'Example',
      contentLanguage: 'en',
      media: null,
      // no `parts` — this is the shape the extension posted for its whole life
    },
  };
  const res = await h.call('POST', '/pins', legacy);
  assert.equal(res.status, 201);

  const stored = (await h.store.getPin(res.body.id))!;
  assert.deepEqual(stored.envelope.parts, [], 'the boundary defaults it rather than storing a landmine');

  // And the agents survive it even when it arrives from somewhere the endpoint
  // never saw — a store restored from a backup, say.
  const unfixed = { ...stored, envelope: { ...stored.envelope, parts: undefined } } as unknown as Pin;
  assert.doesNotThrow(() => pinClusterText(unfixed));
  assert.match(pinClusterText(unfixed), /slow will see the message again/,
    'it degrades to what the envelope does carry');
});
