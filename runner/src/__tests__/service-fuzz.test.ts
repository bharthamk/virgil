import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NOW, StubLlm, noLlm, pin, section, session, startService, statement, suggestion, topic } from './service-harness.js';

/**
 * The endpoints, against bodies nobody would send on purpose.
 *
 * `service-endpoints.test.ts` carries one malformed case per endpoint and is
 * explicit that this is what it is: the wiring, plus the one 400 that proves
 * the endpoint reads its body at all. This file is the sweep — every endpoint
 * against a shared corpus of wrong shapes, and then the specific cases the
 * sweep is too blunt to reach.
 *
 * Two things are being asserted throughout, and neither is "the request
 * succeeds":
 *
 *  1. Nothing the client can send produces a 500. A 500 means somebody should
 *     read the log, and a client that sent a number where a string goes has not
 *     given anybody anything to read.
 *  2. Nothing the client can send corrupts what is already stored. A request
 *     that is refused must leave the store exactly as it found it, and a
 *     request that is accepted must store something the next read can survive.
 *
 * The service must also still be answering afterwards, which is asserted by
 * every one of these ending on a `/health` that comes back.
 */

/** Wrong shapes, each with a name so a failure says which one did it. */
const WRONG_BODIES: readonly (readonly [string, unknown])[] = [
  ['null', null],
  ['array', []],
  ['array of objects', [{ a: 1 }]],
  ['number', 42],
  ['string', 'not an object'],
  ['boolean', true],
  ['empty object', {}],
  ['every field null', { type: null, envelope: null, note: null, answer: null, direction: null, text: null, passage: null, url: null, reason: null, into: null, pinIds: null, label: null }],
  ['every field a number', { type: 1, envelope: 2, note: 3, answer: 4, direction: 5, text: 6, passage: 7, url: 8, reason: 9, into: 10, pinIds: 11, label: 12 }],
  ['every field an array', { type: [], envelope: [], note: [], answer: [], direction: [], text: [], passage: [], url: [], reason: [], into: [], pinIds: [], label: [] }],
  ['every field an empty string', { type: '', envelope: '', note: '', answer: '', direction: '', text: '', passage: '', url: '', reason: '', into: '', pinIds: '', label: '' }],
  ['every field whitespace', { type: '   ', answer: '   ', direction: '\t\n', text: '  ', passage: ' ', url: ' ', reason: ' ', into: ' ', label: ' ' }],
  ['prototype pollution', JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1}}')],
  ['deeply nested', { envelope: { a: { b: { c: { d: { e: { f: 1 } } } } } } }],
  ['nan and infinity as strings', { type: 'NaN', answer: 'Infinity', targetMinutes: 'NaN' }],
  ['a very long string everywhere', { type: 'x'.repeat(100_000), answer: 'y'.repeat(100_000), text: 'z'.repeat(100_000), passage: 'p'.repeat(100_000), url: `https://e.com/${'q'.repeat(100_000)}`, reason: 'r'.repeat(100_000), label: 'l'.repeat(100_000), into: 'i'.repeat(100_000) }],
  ['unicode and control characters', { type: '\u0000​', answer: '\ud800 lone surrogate', text: '‮', passage: '𝕏🧨', url: 'https://e.com/\u0000', reason: '\r\n\r\n', label: '\u0000' }],
];

/** Every write endpoint the service routes, with a path that exists. */
const WRITE_ROUTES: readonly (readonly [string, string, string])[] = [
  ['POST', '/pins', 'pins'],
  ['PUT', '/pins/p1', 'pin metadata edit'],
  ['POST', '/suggestions', 'suggestions'],
  ['POST', '/suggestions/s1/accept', 'suggestion accept'],
  ['POST', '/suggestions/s1/reject', 'suggestion reject'],
  ['POST', '/sessions/sess1/sections/t1/answer', 'answer'],
  ['POST', '/sessions/sess1/sections/t1/depth', 'depth'],
  ['POST', '/sessions/sess1/sections/t1/skip', 'skip'],
  ['POST', '/sessions/sess1/sections/t1/contest', 'contest'],
  ['POST', '/sessions/sess1/sections/t1/correction', 'taught-claim correction'],
  ['POST', '/sessions/sess1/sections/t1/resurface', 'resurface'],
  ['POST', '/pins/p1/quick-take', 'quick take'],
  ['POST', '/pins/p1/quick-take/verdict', 'quick take verdict'],
  ['POST', '/topics/t1/merge', 'merge'],
  ['POST', '/topics/t1/split', 'split'],
  ['PUT', '/prefs', 'prefs'],
  ['PUT', '/model/st1', 'statement edit'],
  // The spend limit. A write route whose whole job is to be believed later:
  // a body that gets past this and stores something the state machine cannot
  // compare to a count is a kill switch that has silently stopped switching.
  ['PUT', '/model-budget', 'model budget'],
  ['POST', '/model-budget/reset', 'model budget reset'],
];

/** A store with one of everything the routes above name. */
async function seeded(tag: string) {
  const h = await startService(tag, { llm: new StubLlm() });
  await h.store.putPin(pin('p1', 't1'));
  await h.store.putPin(pin('p2', 't1'));
  await h.store.putTopic(topic('t1', ['p1', 'p2']));
  await h.store.putTopic(topic('t2', []));
  await h.store.putSuggestion(suggestion('s1'));
  await h.store.putStatement(statement('st1'));
  await h.store.putSession(session('sess1', [section('t1')]));
  return h;
}

const quiet = async (run: () => Promise<void>): Promise<void> => {
  const realError = console.error, realWarn = console.warn;
  console.error = () => {}; console.warn = () => {};
  try { await run(); } finally { console.error = realError; console.warn = realWarn; }
};

// ------------------------------------------------------------------ the sweep

test('no wrong-shaped body on any write route produces a 500', async (t) => {
  const h = await seeded('fuzz-sweep');
  t.after(() => h.close());

  const faults: string[] = [];
  await quiet(async () => {
    for (const [method, path, name] of WRITE_ROUTES) {
      for (const [shape, body] of WRONG_BODIES) {
        const res = await h.call(method, path, body);
        if (res.status >= 500) faults.push(`${name} <- ${shape}: ${res.status} ${JSON.stringify(res.body)}`);
      }
    }
  });
  assert.deepEqual(faults, [], `these bodies reached the generic 500 handler:\n${faults.join('\n')}`);
});

test('a body that is not JSON at all is a 400 on every write route', async (t) => {
  const h = await seeded('fuzz-unparseable');
  t.after(() => h.close());

  await quiet(async () => {
    for (const [method, path, name] of WRITE_ROUTES) {
      for (const raw of ['{{', '', 'null', 'undefined', '[1,2,3', '"', '\u0000', '{"a":', 'NaN']) {
        const res = await h.raw(method, path, raw);
        assert.ok(res.status < 500, `${name} <- ${JSON.stringify(raw)}: ${res.status}`);
      }
    }
  });
});

test('the service is still answering after the whole corpus has been thrown at it', async (t) => {
  const h = await seeded('fuzz-survives');
  t.after(() => h.close());

  await quiet(async () => {
    for (const [method, path] of WRITE_ROUTES) {
      for (const [, body] of WRONG_BODIES) await h.call(method, path, body);
    }
  });
  const health = await h.call('GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
});

test('nothing in the corpus changed a topic, a pin or a statement', async (t) => {
  const h = await seeded('fuzz-no-corruption');
  t.after(() => h.close());

  const before = {
    topics: await h.store.listTopics(),
    statements: await h.store.listStatements(),
    pinIds: (await h.store.listPins()).map((p) => p.id).sort(),
  };

  await quiet(async () => {
    for (const [method, path] of WRITE_ROUTES) {
      // These three legitimately create things and take no body worth getting
      // wrong: `/pins` and `/suggestions` are creations, and accepting the
      // seeded suggestion makes its pin whatever body arrives with it.
      // Everything else in the list is an edit of something that already
      // exists, and none of these bodies is a valid edit.
      if (path === '/pins' || path === '/suggestions' || path.endsWith('/accept')) continue;
      for (const [, body] of WRONG_BODIES) await h.call(method, path, body);
    }
  });

  assert.deepEqual(await h.store.listTopics(), before.topics, 'a malformed body moved a topic');
  assert.deepEqual((await h.store.listPins()).map((p) => p.id).sort(), before.pinIds);
  // The statement is the exception, and legitimately: the corpus contains a
  // 100,000-character string, which is a real edit of a real field and lands.
  // Its count is what matters here — an edit must not become a second
  // statement, and no body in the corpus may remove one.
  assert.equal((await h.store.listStatements()).length, before.statements.length);
});

test('a statement cannot be edited to characters that render as nothing', async (t) => {
  // `requireString` refused '' and '   ' because `.trim()` covers whitespace,
  // and took a bidi override followed by a control character — which is not
  // whitespace, survives a trim, and displays as an empty field. The learner
  // model is the surface whose whole point is that the learner can read and
  // correct what the product believes about them, so a statement that renders
  // blank is a statement deleted without anybody having deleted it.
  const h = await seeded('fuzz-invisible-statement');
  t.after(() => h.close());

  const before = (await h.store.listStatements())[0];
  const invisible = [
    '\u202e\u0007',     // bidi override, then a control character
    '\u200b\u200b',     // zero-width spaces
    '\ufeff',           // byte-order mark
    '\u2066\u2069',     // a bidi isolate around nothing
    '\u00ad \u00ad',    // soft hyphens and a space
    '\u200d\u200c',     // joiners, which are kept in text but are not text
  ];
  for (const text of invisible) {
    const res = await h.call('PUT', '/model/st1', { text });
    assert.equal(res.status, 400, `${JSON.stringify(text)} produced ${res.status}`);
  }
  assert.deepEqual((await h.store.listStatements())[0], before, 'a refused edit moved the statement');
});

test('a statement in a right-to-left script is taken, and kept exactly', async (t) => {
  // The direction that would make the fix worse than the gap. Arabic, Hebrew
  // and Persian are written with ordinary letters; only the format characters
  // are dropped, and the zero-width non-joiner — a real part of Persian
  // spelling, and invisible — is deliberately not one of them.
  const h = await seeded('fuzz-rtl-statement');
  t.after(() => h.close());

  for (const text of ['\u064a\u062c\u062f \u0635\u0639\u0648\u0628\u0629', '\u05de\u05ea\u05e7\u05e9\u05d4', '\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u062f']) {
    const res = await h.call('PUT', '/model/st1', { text });
    assert.equal(res.status, 200, `${JSON.stringify(text)} produced ${res.status}`);
    assert.equal((await h.store.listStatements())[0]?.text, text,
      'text a learner can read was changed on its way into the store');
  }
});

test('prototype pollution through a body does not reach Object.prototype', async (t) => {
  const h = await seeded('fuzz-proto');
  t.after(() => h.close());

  await quiet(async () => {
    for (const [method, path] of WRITE_ROUTES) {
      await h.raw(method, path, '{"__proto__":{"sbPolluted":"yes"},"pinIds":["p1"],"label":"x","into":"t2","text":"t","answer":"a","direction":"deeper","passage":"p","url":"https://e.com","reason":"r","type":"interest"}');
    }
  });
  assert.equal(({} as Record<string, unknown>)['sbPolluted'], undefined,
    'a request body reached Object.prototype');
  const prefs = await h.store.getPrefs() as Record<string, unknown>;
  assert.equal(prefs['sbPolluted'], undefined, 'the pollution key was stored on prefs');
});

test('nothing in the corpus put a spend limit on the board', async (t) => {
  // The direction that matters for this one. A wrong-shaped body that stored
  // something the state machine reads as a limit would stop a learner's model
  // work over a request nobody meant to send.
  const h = await seeded('fuzz-budget');
  t.after(() => h.close());

  await quiet(async () => {
    for (const [, body] of WRONG_BODIES) await h.call('PUT', '/model-budget', body);
    for (const raw of ['{{', '', 'null', '[1,2,3', '{"limit":']) await h.raw('PUT', '/model-budget', raw);
  });

  const res = await h.call('GET', '/model-budget');
  assert.equal(res.status, 200);
  assert.equal(res.body.budget, null, 'a corpus of nonsense set a budget');
  assert.equal(res.body.state.status, 'off');
});

// ------------------------------------------------- reads, against wrong paths

test('read routes survive ids that are not ids', async (t) => {
  const h = await seeded('fuzz-reads');
  t.after(() => h.close());

  const hostile = [
    '..', '../..', '..%2F..%2Fetc%2Fpasswd', '%00', 'a'.repeat(5000),
    '__proto__', 'constructor', 'prototype', 'toString',
    '%E0%A4%A', 'null', 'undefined', 'true', '0', '-1', 'NaN',
  ];
  await quiet(async () => {
    for (const id of hostile) {
      for (const [method, path] of [
        ['GET', `/topics/${id}/pins`], ['DELETE', `/pins/${id}`], ['DELETE', `/topics/${id}`],
        ['DELETE', `/model/${id}`], ['GET', `/sessions/${id}`],
      ] as const) {
        const res = await h.call(method, path);
        assert.ok(res.status < 500, `${method} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
      }
    }
  });
  // The board the panel reads is still readable, and the topic that holds the
  // learner's pins is still on it. (A raw topic count is deliberately not
  // asserted here: the store's writes are serialised and a read taken between
  // a queued write and its flush is a fact about this harness, not about the
  // service. See the report for the one unattributed count seen while writing
  // this test.)
  const board = await h.call('GET', '/board');
  assert.equal(board.status, 200);
  assert.ok(board.body.topics.some((t: { id: string }) => t.id === 't1'),
    'a hostile id removed the topic holding the pins');
  assert.equal((await h.store.listPins()).length, 2, 'a hostile id deleted a pin');
});

test('a query string on the delete-topic route is read as false unless it says true', async (t) => {
  const h = await seeded('fuzz-query');
  t.after(() => h.close());

  // Deleting the pins with the topic is the destructive branch, so anything
  // other than the exact string the panel sends must take the safe one.
  // `?pins=true&pins=false` is not in this list: `searchParams.get` returns the
  // first value, the first value is `true`, and taking the learner's first
  // answer is the defensible reading of a duplicated parameter.
  // `?pins=%74rue` is not in this list either: percent-decoding is what
  // `searchParams` is for, and `%74rue` IS `true`.
  for (const q of ['?pins=TRUE', '?pins=1', '?pins=yes', '?pins']) {
    await h.store.putTopic(topic('t1', ['p1', 'p2']));
    await h.store.putPin(pin('p1', 't1'));
    await h.store.putPin(pin('p2', 't1'));
    const res = await h.call('DELETE', `/topics/t1${q}`);
    assert.equal(res.status, 200);
    assert.equal((await h.store.listPins()).filter((p) => p.id === 'p1').length, 1,
      `"${q}" deleted the pins as well`);
  }
});

// ------------------------------------------------ the cases the sweep misses

test('a pin admitted with no text at all does not break the split picker', async (t) => {
  // `pinRequestFrom` requires url, pageTitle and headingPath and nothing else,
  // so an envelope with neither a selection nor surrounding text is admitted.
  // `GET /topics/:id/pins` then reads `selection ?? surroundingText` and calls
  // `.replace` on it, which is a TypeError on a pin the service itself accepted.
  const h = await startService('fuzz-textless', { llm: new StubLlm() });
  t.after(() => h.close());

  const created = await h.call('POST', '/pins', {
    type: 'interest',
    envelope: { url: 'https://e.com', pageTitle: 'A page', headingPath: [] },
  });
  assert.equal(created.status, 201, 'the service accepted this pin');

  await h.store.putTopic(topic('t1', [created.body.id]));
  let res: { status: number; body: any } = { status: 0, body: null };
  await quiet(async () => { res = await h.call('GET', '/topics/t1/pins'); });
  assert.ok(res.status < 500,
    'a pin the service admitted crashes the endpoint that lists it for a split');
  assert.equal(res.body.pins.length, 1);
  assert.equal(typeof res.body.pins[0].gist, 'string');
});

test('an envelope whose fields are the wrong type is refused rather than stored', async (t) => {
  const h = await startService('fuzz-envelope', { llm: new StubLlm() });
  t.after(() => h.close());

  await quiet(async () => {
    for (const envelope of [
      { url: 'https://e.com', pageTitle: 'p', headingPath: [], selection: 42 },
      { url: 'https://e.com', pageTitle: 'p', headingPath: [], surroundingText: [] },
      { url: 'https://e.com', pageTitle: 'p', headingPath: [], selection: { a: 1 } },
      { url: 'https://e.com', pageTitle: 'p', headingPath: [], selection: true },
    ]) {
      const res = await h.call('POST', '/pins', { type: 'interest', envelope });
      assert.ok(res.status < 500, `envelope ${JSON.stringify(envelope)} produced ${res.status}`);
    }
  });
  // Whatever was admitted, the split picker still renders every one of them.
  const pins = await h.store.listPins();
  await h.store.putTopic(topic('t1', pins.map((p) => p.id)));
  let res: { status: number; body: any } = { status: 0, body: null };
  await quiet(async () => { res = await h.call('GET', '/topics/t1/pins'); });
  assert.equal(res.status, 200);
  for (const p of res.body.pins) assert.equal(typeof p.gist, 'string');
});

test('merging a topic into itself is refused by every route to the same topic', async (t) => {
  const h = await seeded('fuzz-self-merge');
  t.after(() => h.close());

  const direct = await h.call('POST', '/topics/t1/merge', { into: 't1' });
  assert.equal(direct.status, 400);
  assert.equal(direct.body.code, 'self-merge');

  // And by way of an alias: merge t2 into t1, then try to merge t1 into t2.
  assert.equal((await h.call('POST', '/topics/t2/merge', { into: 't1' })).status, 200);
  const viaAlias = await h.call('POST', '/topics/t1/merge', { into: 't2' });
  assert.equal(viaAlias.status, 400);
  assert.equal(viaAlias.body.code, 'self-merge');
  assert.equal((await h.store.listTopics()).length, 1, 'a self-merge removed a topic');
});

test('a split naming the same pin many times is one pin, not many', async (t) => {
  const h = await seeded('fuzz-split-dupes');
  t.after(() => h.close());

  const res = await h.call('POST', '/topics/t1/split', {
    pinIds: ['p1', 'p1', 'p1', 'p1'], label: 'the new one',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.movedPins, 1, 'a repeated id moved the pin more than once');
  assert.equal(res.body.remainingPins, 1);
  const all = await h.store.listTopics();
  const ids = all.flatMap((t2) => t2.pinIds);
  assert.deepEqual([...ids].sort(), ['p1', 'p2'], 'a pin ended up in two topics at once');
});

test('a split whose label is only whitespace or control characters is refused', async (t) => {
  const h = await seeded('fuzz-split-label');
  t.after(() => h.close());

  const nothing = [
    '', '   ', '\t\n\r',
    // Not whitespace, and `.trim()` keeps every one of them: a topic named out
    // of these is on the board with no name on it.
    '\u200b\u200b\u200b', '\u202e\u202c', '\ufeff', '\u2066\u2069', '\u00ad', '\u200d\u200c',
  ];
  for (const label of nothing) {
    const res = await h.call('POST', '/topics/t1/split', { pinIds: ['p1'], label });
    assert.equal(res.status, 400, `label ${JSON.stringify(label)} produced ${res.status}`);
  }
  assert.equal((await h.store.listTopics()).length, 2, 'a refused split still created a topic');
});

test('a split label in a right-to-left script keeps every letter it was given', async (t) => {
  // The other half of refusing invisible labels. What is dropped is the format
  // characters, never letters — a check that reached for "unusual script"
  // rather than "renders as nothing" would refuse to let anybody not writing in
  // English name a topic at all.
  const h = await seeded('fuzz-rtl-label');
  t.after(() => h.close());

  const label = '\u0627\u0644\u0623\u0648\u062a\u0627\u0631 \u0627\u0644\u0633\u0628\u0627\u0639\u064a\u0629';
  const res = await h.call('POST', '/topics/t1/split', { pinIds: ['p1'], label });
  assert.equal(res.status, 200);
  assert.equal(res.body.label, label, 'an Arabic topic name did not survive being stored');
  const created = (await h.store.listTopics()).find((x) => x.label === label);
  assert.ok(created, 'the topic on the board is not the one the learner named');
});

test('accepting the same suggestion twice does not make two pins', async (t) => {
  const h = await seeded('fuzz-double-accept');
  t.after(() => h.close());

  const first = await h.call('POST', '/suggestions/s1/accept');
  assert.equal(first.status, 200);
  const second = await h.call('POST', '/suggestions/s1/accept');
  assert.ok(second.status < 500);

  const fromSuggestion = (await h.store.listPins()).filter((p) => p.fromSuggestion);
  assert.equal(fromSuggestion.length, 1,
    'the second accept made a second pin out of one thing the learner clicked once');
});

test('rejecting the same suggestion twice does not quiet the site twice over', async (t) => {
  // SB-16 quiets at two rejections. If one card can be counted repeatedly, one
  // double-tap silences the detector on a site the learner said no to once.
  const h = await seeded('fuzz-double-reject');
  t.after(() => h.close());

  await h.call('POST', '/suggestions/s1/reject');
  await h.call('POST', '/suggestions/s1/reject');
  const counts = (await h.store.getPrefs()).rejectedOrigins;
  assert.equal(counts['https://example.com'], 1,
    'one suggestion rejected twice counted as two sites-worth of rejection');
});

test('a suggestion whose url has no real origin does not share a quieting bucket', async (t) => {
  // `new URL('javascript:x').origin` is the STRING "null", not the value, so an
  // opaque-origin suggestion lands in a bucket named "null" — and every other
  // opaque-origin suggestion lands in the same one. Two rejections across two
  // unrelated pages would then quiet both.
  const h = await startService('fuzz-opaque', { llm: new StubLlm() });
  t.after(() => h.close());

  await h.store.putSuggestion(suggestion('a', { url: 'javascript:alert(1)' }));
  await h.store.putSuggestion(suggestion('b', { url: 'data:text/html,hello' }));
  await h.call('POST', '/suggestions/a/reject');
  await h.call('POST', '/suggestions/b/reject');

  // Two rejections on two unrelated pages, and the SB-16 threshold is two: a
  // shared bucket here quiets the detector on both of them and on every other
  // page with no real origin. Each opaque url gets its own key instead.
  const counts = (await h.store.getPrefs()).rejectedOrigins;
  assert.equal(counts['null'], undefined, 'opaque origins are sharing a bucket again');
  assert.deepEqual(counts, {
    'url:javascript:alert(1)': 1,
    'url:data:text/html,hello': 1,
  }, 'one rejection on one page counted as anything other than one');
});

test('a real origin is counted under its origin, and nothing else', async (t) => {
  // The half of the fix that must not have moved: SB-16 is keyed on the origin
  // string for every url that has one, unchanged, and the detector reads that
  // same string back. Two urls on one site are one site.
  const h = await startService('fuzz-real-origin', { llm: new StubLlm() });
  t.after(() => h.close());

  await h.store.putSuggestion(suggestion('a', { url: 'https://example.com/one?q=1#x' }));
  await h.store.putSuggestion(suggestion('b', { url: 'https://example.com:443/two' }));
  await h.store.putSuggestion(suggestion('c', { url: 'http://example.com/three' }));
  for (const id of ['a', 'b', 'c']) await h.call('POST', `/suggestions/${id}/reject`);

  assert.deepEqual((await h.store.getPrefs()).rejectedOrigins, {
    'https://example.com': 2,
    'http://example.com': 1,
  });
});

// ------------------------------------------------------------- prefs, closely

test('a prefs PUT cannot replace a field with a value of the wrong type', async (t) => {
  // Everything the extension enforces is read from these — pause, exclusions
  // and the SB-16 counts. `PUT /prefs` spreads the body over the stored prefs
  // with no check on any field, so a client that sends `excludedDomains: "x"`
  // or `pausedUntil: 12345` replaces a working control with a value nothing
  // downstream reads as one.
  const h = await startService('fuzz-prefs-types', { llm: noLlm() });
  t.after(() => h.close());

  const shipped = await h.store.getPrefs();
  const paused = new Date(Date.now() + 3_600_000).toISOString();
  await h.call('PUT', '/prefs', { pausedUntil: paused });

  const wrong: readonly (readonly [string, unknown])[] = [
    ['pausedUntil', 12345],
    ['pausedUntil', true],
    ['pausedUntil', 'not a date at all'],
    ['excludedDomains', 'bank.com'],
    ['excludedDomains', 42],
    ['excludedDomains', { 0: 'bank.com' }],
    ['rejectedOrigins', 'lots'],
    ['rejectedOrigins', ['https://e.com']],
    ['targetMinutes', 9999],
    ['targetMinutes', -1],
    ['targetMinutes', 'fifteen'],
    ['interfaceLanguage', []],
  ];

  const accepted: string[] = [];
  await quiet(async () => {
    for (const [field, value] of wrong) {
      const res = await h.call('PUT', '/prefs', { [field]: value });
      const stored = (await h.store.getPrefs()) as Record<string, unknown>;
      // Two acceptable answers: refuse it, or drop it. What is not acceptable
      // is storing it — `rejectedOrigins` is not a field a client may set at
      // all, so it is dropped rather than refused, and either way the stored
      // value must not be the one that was sent.
      if (res.status < 400 && JSON.stringify(stored[field]) === JSON.stringify(value)) {
        accepted.push(`${field} = ${JSON.stringify(value)}`);
      }
      // Whatever the verdict, the pause must not have been dropped and the
      // exclusion list must not have stopped being a list of strings.
      const now = await h.store.getPrefs();
      assert.ok(Array.isArray(now.excludedDomains) && now.excludedDomains.every((d) => typeof d === 'string'),
        `${field} = ${JSON.stringify(value)} left excludedDomains as ${JSON.stringify(now.excludedDomains)}`);
      assert.ok(now.pausedUntil === null || typeof now.pausedUntil === 'string',
        `${field} = ${JSON.stringify(value)} left pausedUntil as ${JSON.stringify(now.pausedUntil)}`);
    }
  });
  assert.deepEqual(accepted, [], `these wrong-typed prefs were stored: ${accepted.join(', ')}`);
  // And the counter no client may set is still the counter the reject endpoint
  // wrote — an SB-16 quieting a learner never asked for is a detector going
  // silent on a site they never said no to.
  assert.deepEqual((await h.store.getPrefs()).rejectedOrigins, {});
  assert.equal((await h.store.getPrefs()).pausedUntil, paused, 'the pause was lost');
  assert.deepEqual((await h.store.getPrefs()).excludedDomains, shipped.excludedDomains);
});

test('a prefs PUT of a huge or hostile exclusion list is bounded', async (t) => {
  const h = await startService('fuzz-prefs-size', { llm: noLlm() });
  t.after(() => h.close());

  await quiet(async () => {
    const res = await h.call('PUT', '/prefs', {
      excludedDomains: Array.from({ length: 20_000 }, (_, i) => `site${i}.example`),
    });
    assert.ok(res.status < 500, `a 20k exclusion list produced ${res.status}`);
  });
  assert.equal((await h.call('GET', '/health')).status, 200);
});

// ------------------------------------------------------- big and empty inputs

test('an answer, a statement and a note of a hundred thousand characters are handled', async (t) => {
  const h = await seeded('fuzz-big');
  t.after(() => h.close());

  const big = 'why '.repeat(25_000);
  await quiet(async () => {
    for (const [method, path, body] of [
      ['POST', '/sessions/sess1/sections/t1/answer', { answer: big }],
      ['PUT', '/model/st1', { text: big }],
      ['POST', '/pins', { type: 'interest', note: big, envelope: { url: 'https://e.com', pageTitle: big, headingPath: [big] } }],
      ['POST', '/suggestions', { passage: big, url: 'https://e.com', reason: big }],
    ] as const) {
      const res = await h.call(method, path, body);
      assert.ok(res.status < 500, `${path} with ${big.length} characters produced ${res.status}`);
    }
  });
  assert.equal((await h.call('GET', '/health')).status, 200);
  assert.equal((await h.call('GET', '/board')).status, 200);
});

test('the interaction routes refuse an empty answer whatever kind of empty it is', async (t) => {
  const h = await seeded('fuzz-empty-answer');
  t.after(() => h.close());

  for (const answer of ['', '   ', '\n\n', '\t', undefined, null, 0, false, []]) {
    const res = await h.call('POST', '/sessions/sess1/sections/t1/answer', { answer });
    assert.equal(res.status, 400, `answer ${JSON.stringify(answer)} was marked`);
  }
  assert.equal((await h.store.listSignals('t1')).length, 0, 'an empty answer left a signal');
});

test('a section id that is a valid topic but not in the session is a 404, not a mark', async (t) => {
  const h = await seeded('fuzz-wrong-section');
  t.after(() => h.close());

  for (const action of ['answer', 'skip', 'contest', 'correction', 'depth'] as const) {
    const res = await h.call('POST', `/sessions/sess1/sections/t2/${action}`,
      { answer: 'a', direction: 'deeper' });
    assert.equal(res.status, 404, `${action} on a topic that is not in this session`);
  }
  assert.equal((await h.store.listSignals('t2')).length, 0);
});

test('the clock the service writes with is its own, not the body\'s', async (t) => {
  // `capturedAt` is taken from the body when it is a string, which is how the
  // extension stamps a capture made offline. It must not be able to become a
  // number, an object, or something the next read cannot parse.
  const h = await startService('fuzz-clock', { llm: new StubLlm() });
  t.after(() => h.close());

  await quiet(async () => {
    for (const capturedAt of [12345, {}, [], true, null, 'not a date', '9999-99-99T99:99:99Z', '']) {
      const res = await h.call('POST', '/pins', {
        type: 'interest', capturedAt,
        envelope: { url: 'https://e.com', pageTitle: 'p', headingPath: [], selection: 's' },
      });
      assert.ok(res.status < 500, `capturedAt ${JSON.stringify(capturedAt)} produced ${res.status}`);
    }
  });
  for (const p of await h.store.listPins()) {
    assert.equal(typeof p.capturedAt, 'string', `capturedAt was stored as ${typeof p.capturedAt}`);
  }
  // The analyst slices this to ten characters and the panel renders it. A pin
  // whose date cannot be read is a pin that reads as a blank in both.
  assert.equal((await h.call('GET', '/health')).status, 200);
  assert.equal(NOW.slice(0, 4), '2026');
});

/**
 * The read routes §5 added, swept the same way.
 *
 * They take no body, so the corpus above says nothing about them — what they
 * take is a path segment and whatever the store happens to hold. A projection
 * that threw on a topic with no signals, a session with an unreadable
 * `builtAt`, or a signal timestamped with a string, would take the whole main
 * page down at exactly the moment the learner opened the panel.
 */
const READ_ROUTES: readonly string[] = ['/session', '/board', '/flagged', '/progression'];

test('no read on the main page produces a 500, whatever the store holds', async (t) => {
  const h = await seeded('fuzz-zones');
  t.after(() => h.close());

  // A store deliberately full of the shapes that have historically broken a
  // reader: an unparseable instant, a signal on a topic that no longer exists,
  // a session with no build time, and a withdrawn mark.
  await h.store.appendSignal({
    id: 'ok', topicId: 't1', type: 'answer-correct', direction: 'positive',
    at: '2026-08-01T09:00:00.000Z', sourceEvent: 'answer:sess1:t1', invalidated: false,
  });
  await h.store.appendSignal({
    id: 'whenever', topicId: 't1', type: 'resurface-deeper', direction: 'positive',
    at: 'not a date', sourceEvent: 'resurface:sess1:t1', invalidated: false,
  });
  await h.store.appendSignal({
    id: 'orphan', topicId: 'gone', type: 'resurface-refresher', direction: 'negative',
    at: '2026-08-02T09:00:00.000Z', sourceEvent: 'resurface:sess1:gone', invalidated: false,
  });
  await h.store.appendSignal({
    id: 'withdrawn', topicId: 't1', type: 'resurface-refresher', direction: 'negative',
    at: '2026-08-03T09:00:00.000Z', sourceEvent: 'resurface:sess1:t1', invalidated: true,
  });
  await h.store.putSession(session('broken', [section('t1')], { builtAt: 'whenever' }));

  const faults: string[] = [];
  await quiet(async () => {
    for (const path of [...READ_ROUTES, '/sessions/broken/awards', '/sessions/sess1/awards']) {
      const res = await h.call('GET', path);
      if (res.status >= 500) faults.push(`${path}: ${res.status} ${JSON.stringify(res.body)}`);
    }
  });
  assert.deepEqual(faults, []);
});

test('a session id of any shape is a 404 from the awards route, never a fault', async (t) => {
  const h = await seeded('fuzz-awards-id');
  t.after(() => h.close());

  await quiet(async () => {
    for (const id of ['', '..', '%00', 'a'.repeat(5000), '%E0%A4%A', 'null', '__proto__']) {
      const res = await h.call('GET', `/sessions/${id}/awards`);
      assert.ok(res.status < 500, `${JSON.stringify(id)}: ${res.status}`);
    }
  });
});
