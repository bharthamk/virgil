import { test } from 'node:test';
import assert from 'node:assert/strict';

import { quickTakeMaterialKey, type Embedder, type Signal } from '@sb/core';
import { NOW, StubLlm, brokenLlm, noLlm, pin, startService, topic } from './service-harness.js';

/**
 * SB-59/60/61 — the quick take, end to end through the service.
 *
 * Three things the endpoints have to keep straight and the agent cannot:
 *
 *  1. **which topic this is about.** A tap at first contact happens before the
 *     nightly has clustered anything, and a signal has to land somewhere.
 *  2. **that reading costs nothing.** The take itself writes no signal, no
 *     topic and no pin — the same rule the provenance tap follows, for the same
 *     reason: a learner scored for looking at something stops looking.
 *  3. **that teaching is checked.** The foreground generation is followed by
 *     a separate reasoning-on source check before any prose is returned.
 *  4. **that the tap lands once.** A double tap and a retried request are the
 *     same thing from here, and both used to be how one answer became two.
 */

const clock = new Date(NOW);
const daysAgo = (n: number): string => new Date(clock.getTime() - n * 86_400_000).toISOString();

let seq = 0;
const signal = (topicId: string, type: Signal['type'], days: number): Signal => ({
  id: `seed${seq += 1}`, topicId, type, direction: 'positive',
  at: daysAgo(days), sourceEvent: 'seed', invalidated: false,
});

/** A model that answers the take with a body we can recognise. */
const taking = (body: string): StubLlm => new StubLlm((req) =>
  ((req.schema as { required?: string[] })?.required?.includes('body')
    ? { heading: 'How composite field order works', body } : undefined));

// ------------------------------------------------------------- the take

test('Add to Board files one fresh pin without generating a lesson', async (t) => {
  const h = await startService('pin-to-board', { llm: noLlm() });
  t.after(() => h.close());
  await h.store.putPin(pin('p1', null));

  const res = await h.call('POST', '/pins/p1/board');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.topicId, 'string');
  assert.equal((await h.store.getPin('p1'))?.topicId, res.body.topicId);
  assert.deepEqual(await h.store.listSignals(), [], 'filing the pin invented learner evidence');
  assert.equal((await h.store.listTopics()).length, 1);
});

test('a take on a pin that is not there is a 404, not a lesson about nothing', async (t) => {
  const h = await startService('qt-missing');
  t.after(() => h.close());
  assert.equal((await h.call('POST', '/pins/nope/quick-take')).status, 404);
});

test('SB-59: the take comes back in the register the ledger already reads', async (t) => {
  const h = await startService('qt-register', { llm: taking('Composite indexes, condensed.') });
  t.after(() => h.close());

  await h.store.putTopic(topic('A', ['p1']));
  await h.store.putPin(pin('p1', 'A'));
  for (const s of [signal('A', 'answer-correct', 12), signal('A', 'answer-correct', 4)]) {
    await h.store.appendSignal(s);
  }

  const res = await h.call('POST', '/pins/p1/quick-take');
  assert.equal(res.status, 200);
  assert.equal(res.body.outcome, 'ready');
  assert.equal(res.body.body, 'Composite indexes, condensed.');
  assert.equal(res.body.register, 'fluent', 'the comfort model chose it, not the model');
  assert.equal(res.body.label, 'label of A');
  assert.equal(res.body.topicLabel, 'label of A');
  assert.equal(res.body.heading, 'How composite field order works');
  assert.equal(res.body.topicId, 'A', 'the foreground handoff needs the real board topic');
});

test('SB-59: a pin the nightly has not seen yet is taught from nothing', async (t) => {
  // The whole point of the moment: this is day zero of a topic, and the honest
  // register for a topic the ledger has never heard of is the bottom one.
  const h = await startService('qt-fresh', { llm: taking('From the top.') });
  t.after(() => h.close());
  await h.store.putPin(pin('p1', null));

  const res = await h.call('POST', '/pins/p1/quick-take');
  assert.equal(res.body.register, 'from-nothing');
  assert.equal(res.body.label, 'Section', 'named from the page, because nothing else has named it');
  assert.equal(res.body.topicLabel, 'Section');
  assert.equal(res.body.heading, 'How composite field order works');
  assert.equal(res.body.topicId, null, 'an unfiled pin must not acquire a synthetic topic on read');
});

test('an exact selection stays the visible and taught subject while its paragraph is context', async (t) => {
  const llm = taking('Ipswich Rugby Club is the selected subject.');
  const h = await startService('qt-exact-selection', { llm });
  t.after(() => h.close());
  await h.store.putPin(pin('p1', null, {
    envelope: {
      ...pin('p1', null).envelope,
      selection: 'Ipswich Rugby Club',
      surroundingText: 'Ipswich A.F.C. merged with Ipswich Rugby Club to form Ipswich Town Football Club.',
      pageTitle: 'Ipswich Town F.C. - Wikipedia',
      headingPath: ['History', 'Early years'],
    },
  }));

  const res = await h.call('POST', '/pins/p1/quick-take');
  assert.equal(res.status, 200);
  assert.equal(res.body.pinned.text, 'Ipswich Rugby Club');
  const generation = llm.calls.find((call) =>
    (call.schema as { required?: readonly string[] } | undefined)?.required?.includes('body'));
  assert.match(generation?.prompt ?? '',
    /Exact selection — this is the subject to explain: "Ipswich Rugby Club"/);
  assert.match(generation?.prompt ?? '', /Containing source context: "Ipswich A\.F\.C\. merged/);
});

test('SB-247: learner-authored Insights govern every foreground Tutor route the product offers next', async (t) => {
  const llm = taking('Composite indexes, condensed.');
  const h = await startService('qt-insight', { llm });
  t.after(() => h.close());
  const ownWords = 'I understand technical ideas best after I see one concrete example.';
  const contradictedRead = 'The learner avoids concrete examples.';
  await h.store.putStatement({
    id: 'mine', text: ownWords, topicId: null, userEdited: true,
    evidenceSignalIds: [], updatedAt: NOW,
  });
  await h.store.putStatement({
    id: 'machine', text: contradictedRead, topicId: null, userEdited: false,
    evidenceSignalIds: [], updatedAt: NOW,
  });
  await h.store.putPin(pin('p1', null));

  const res = await h.call('POST', '/pins/p1/quick-take');
  assert.equal(res.body.outcome, 'ready');
  await h.call('POST', '/pins/p1/guide');
  await h.call('POST', '/pins/p1/guide/stuck', { action: 'Run the query', why: 'See its plan.' });
  await h.call('POST', '/pins/p1/ask', { question: 'Why does column order matter?', exchange: [] });

  assert.equal(llm.calls.length, 5);
  for (const [index, call] of llm.calls.entries()) {
    assert.ok(call.prompt.includes(ownWords), `foreground Tutor call ${index + 1} ignored the learner's words`);
    assert.ok(!call.prompt.includes(contradictedRead),
      `foreground Tutor call ${index + 1} let an incompatible machine read outrank them`);
  }
});

test('reading a take writes nothing at all', async (t) => {
  // The same rule as SB-44's provenance tap, and for the same reason. The taps
  // underneath are the signal; opening the take is not one, and a topic minted
  // by looking would put a thing on the board the learner never answered about.
  const h = await startService('qt-readonly', { llm: taking('A take.') });
  t.after(() => h.close());
  await h.store.putPin(pin('p1', null));

  await h.call('POST', '/pins/p1/quick-take');

  assert.deepEqual(await h.store.listSignals(), []);
  assert.deepEqual(await h.store.listTopics(), []);
  assert.equal((await h.store.getPin('p1'))?.topicId, null);
});

test('SB-60: a take that could not be written says so, and is not a 500', async (t) => {
  // The learner pressed a button and is owed a sentence about what happened.
  // Generation failed before there was anything for the Verifier to inspect.
  // The one thing this must never be is an empty body that reads as a take.
  const h = await startService('qt-broken', { llm: brokenLlm() });
  t.after(() => h.close());
  await h.store.putPin(pin('p1', null));

  const res = await h.call('POST', '/pins/p1/quick-take');
  assert.equal(res.status, 200);
  assert.equal(res.body.outcome, 'model-failed');
  assert.equal(res.body.failureReason, 'generation-failed');
  assert.equal(res.body.body, '');
});

test('the foreground take and its independent source check both show up on the bill', async (t) => {
  // Learn-now is paid work per tap. The bill must make the fast/off generation
  // and the fast/on safety pass visible rather than hiding the trust boundary.
  const h = await startService('qt-cost', { llm: taking('A take.') });
  t.after(() => h.close());
  await h.store.putPin(pin('p1', null));

  await h.call('POST', '/pins/p1/quick-take');
  const rows = (await h.call('GET', '/usage')).body.llm.rows as
    { stage: string; tier: string; reasoning: string; calls: number }[];

  assert.deepEqual(rows.map((r) => `${r.stage}/${r.tier}/${r.reasoning}/${r.calls}`),
    ['quick-take/fast/off/1', 'quick-take/fast/on/1']);
});

test('SB-203: a fatal source-check finding returns no lesson and writes no learner signal', async (t) => {
  const source = 'A major third spans four semitones; a minor third spans three semitones.';
  const llm = new StubLlm((req) => {
    const required = (req.schema as { required?: readonly string[] })?.required ?? [];
    if (required.includes('body')) {
      return { body: 'A minor third starting on G is F sharp.' };
    }
    if (required.includes('defects')) return { defects: [{
      kind: 'inconsistent',
      quote: 'A minor third starting on G is F sharp.',
      problem: 'A minor third above G is B flat, not F sharp.',
      severity: 'fatal',
    }] };
    return undefined;
  });
  const h = await startService('qt-unverified', { llm });
  t.after(() => h.close());
  await h.store.putPin(pin('p1', null, {
    envelope: {
      ...pin('p1', null).envelope,
      selection: source,
      pageTitle: 'Music Intervals and Chords',
    },
  }));

  const res = await h.call('POST', '/pins/p1/quick-take');
  assert.equal(res.status, 200);
  assert.equal(res.body.outcome, 'unverified');
  assert.equal(res.body.failureReason, 'verifier-defect');
  assert.equal(res.body.body, '');
  assert.deepEqual((await h.store.getPin('p1'))?.quickTakeFailure, {
    materialKey: quickTakeMaterialKey(source),
    register: 'from-nothing',
    minutes: 2,
    reason: 'verifier-defect',
    attemptedAt: NOW,
  });
  assert.deepEqual(await h.store.listSignals(), []);
  assert.deepEqual(await h.store.listTopics(), []);
});

// ------------------------------------------------------------- the two taps

test('SB-61: still shaky lands in the ledger on the pin\'s own topic', async (t) => {
  const h = await startService('qt-shaky', { llm: noLlm() });
  t.after(() => h.close());
  await h.store.putTopic(topic('A', ['p1']));
  await h.store.putPin(pin('p1', 'A'));

  const res = await h.call('POST', '/pins/p1/quick-take/verdict', { verdict: 'still-shaky' });
  assert.equal(res.status, 200);

  const [written, ...rest] = await h.store.listSignals('A');
  assert.deepEqual(rest, [], 'one tap, one signal');
  assert.equal(written?.type, 'quick-take-still-shaky');
  assert.equal(written?.direction, 'negative');
  assert.equal(written?.sourceEvent, 'quick-take:p1');
  assert.equal(written?.at, NOW, 'the injected clock, not the wall clock');
});

test('SB-61: got it lands as the positive read it is', async (t) => {
  const h = await startService('qt-got', { llm: noLlm() });
  t.after(() => h.close());
  await h.store.putTopic(topic('A', ['p1']));
  await h.store.putPin(pin('p1', 'A'));

  await h.call('POST', '/pins/p1/quick-take/verdict', { verdict: 'got-it' });
  const [written] = await h.store.listSignals('A');
  assert.equal(written?.type, 'quick-take-got-it');
  assert.equal(written?.direction, 'positive');
});

/**
 * SB-283's third answer, and the whole reason it needed no new machinery.
 *
 * *Not now* is a statement about timing, made about a topic, and it is exactly
 * what the session X already says. So it writes `lineup-not-now`, which is
 * neutral, is outside `SIGNAL_WEIGHT` by type, and is already read by the
 * Gardener's hold window and by the night scout's avoided-topic gap.
 */
test('SB-283: not now lands as the lineup mark it already is, with the take as its source', async (t) => {
  const h = await startService('qt-not-now', { llm: noLlm() });
  t.after(() => h.close());
  await h.store.putTopic(topic('A', ['p1']));
  await h.store.putPin(pin('p1', 'A'));

  const res = await h.call('POST', '/pins/p1/quick-take/verdict', { verdict: 'not-now' });
  assert.equal(res.status, 200);
  assert.equal(res.body.backAfterDays, 7, 'the panel is told the window rather than assuming it');

  const [written, ...rest] = await h.store.listSignals('A');
  assert.deepEqual(rest, [], 'one tap, one signal');
  assert.equal(written?.type, 'lineup-not-now');
  assert.equal(written?.direction, 'neutral', 'a deferral is not a claim about what they know');
  assert.equal(written?.sourceEvent, 'quick-take:p1', 'the provenance says where the tap came from');
});

test('SB-283: the two readings carry no window, because they hold nothing back', async (t) => {
  const h = await startService('qt-no-window', { llm: noLlm() });
  t.after(() => h.close());
  await h.store.putTopic(topic('A', ['p1']));
  await h.store.putPin(pin('p1', 'A'));

  for (const verdict of ['got-it', 'still-shaky']) {
    const res = await h.call('POST', '/pins/p1/quick-take/verdict', { verdict });
    assert.equal(res.body.backAfterDays, undefined, `${verdict} promised a window it does not buy`);
  }
});

test('SB-283: changing the answer to not now withdraws the reading it replaces', async (t) => {
  // The correction path SB-61 built, over the vocabulary SB-283 widened. One
  // active mark per pin: a learner who reads, says they have it, and then
  // decides not today has changed their mind rather than said two things.
  const h = await startService('qt-not-now-change', { llm: noLlm() });
  t.after(() => h.close());
  await h.store.putTopic(topic('A', ['p1']));
  await h.store.putPin(pin('p1', 'A'));

  await h.call('POST', '/pins/p1/quick-take/verdict', { verdict: 'got-it' });
  const changed = await h.call('POST', '/pins/p1/quick-take/verdict', { verdict: 'not-now' });
  assert.equal(changed.body.changed, true);

  const live = (await h.store.listSignals('A')).filter((s) => !s.invalidated);
  assert.deepEqual(live.map((s) => s.type), ['lineup-not-now']);
});

test('a tap on a pin with no topic yet gives it one, named from the page', async (t) => {
  /**
   * The product call this endpoint had to make. §3's whole argument for the
   * quick take is signal *"on day zero of a topic"*, and on day zero there is
   * no topic: clustering is overnight work. A signal has to attach to
   * something, and the alternatives were both worse — deferring the tap into a
   * second store until the nightly caught up would be the parallel bookkeeping
   * the one-ledger law exists to refuse, and dropping it would make SB-61 inert
   * in exactly the case it was written for.
   *
   * So the tap does what the cluster stage already does for a pin the partition
   * dropped: a topic of its own, labelled from the page, which the nightly then
   * treats as an existing topic and attaches to rather than re-deciding.
   */
  const h = await startService('qt-mint', { llm: noLlm() });
  t.after(() => h.close());
  await h.store.putPin(pin('p1', null));

  await h.call('POST', '/pins/p1/quick-take/verdict', { verdict: 'still-shaky' });

  const [made, ...others] = await h.store.listTopics();
  assert.deepEqual(others, [], 'one topic, for the one thing they asked about');
  assert.equal(made?.label, 'Section');
  assert.deepEqual([...(made?.pinIds ?? [])], ['p1']);
  assert.equal(made?.state, 'waiting');
  assert.equal(made?.provisionalName, true,
    'nothing named this — it exists so a signal is not orphaned, and the cluster stage must be '
    + 'allowed to name it once rather than the identity promise freezing a stopgap for ever');
  assert.equal((await h.store.getPin('p1'))?.topicId, made?.id, 'and the pin knows where it went');

  const [written] = await h.store.listSignals(made!.id);
  assert.equal(written?.type, 'quick-take-still-shaky');
});

/**
 * A board where "index" material and everything else point in different
 * directions. The harness embedder answers `[0, 0]` for every text, which can
 * match nothing — right for every other test here and useless for this one.
 */
const twoWayEmbedder: Embedder = {
  modelId: 'stub-space',
  embed: async (texts) => texts.map((t) => (/index/i.test(t) ? [1, 0] : [0, 1])),
};

test('a tap on an unfiled pin joins the topic it is about, rather than minting a rival', async (t) => {
  /**
   * Found in the 2026-08-22 audit, and it is the same shape as the register
   * bug. This endpoint used to go straight to a new topic for any pin the
   * nightly had not filed, and the code said what that cost: *"two taps on two
   * related pins before the first nightly leave two topics... That is the
   * learner's to repair."*
   *
   * It was worse than untidy. The minted topic starts at comfort 0.15, so
   * pressing *still shaky* on material about something the learner is fluent in
   * filed the strongest negative signal this product collects against a
   * beginner's topic that had not existed a second earlier — and split the
   * history that made them fluent away from the evidence that they were not.
   */
  const h = await startService('qt-join', { llm: noLlm(), embedder: twoWayEmbedder });
  t.after(() => h.close());
  await h.store.putTopic(topic('known', ['p0'], { label: 'Firestore indexes' }));
  await h.store.putPin(pin('p0', 'known', {
    envelope: { ...pin('p0', 'known').envelope, selection: 'a composite index over two fields' },
  }));
  await h.store.putPin(pin('p1', null, {
    envelope: { ...pin('p1', null).envelope, selection: 'index field ordering and the query planner' },
  }));

  await h.call('POST', '/pins/p1/quick-take/verdict', { verdict: 'still-shaky' });

  const topics = await h.store.listTopics();
  assert.equal(topics.length, 1, `a rival topic was minted: ${topics.map((x) => x.label).join(', ')}`);
  assert.equal((await h.store.getPin('p1'))?.topicId, 'known', 'the pin did not join the topic it is about');

  const written = await h.store.listSignals('known');
  assert.equal(written.length, 1, 'the signal did not land on the history it belongs to');
  assert.equal(written[0]?.type, 'quick-take-still-shaky');
});

test('material the board knows nothing about still gets a topic of its own', async (t) => {
  // The other half. Attaching everything to the nearest topic would file a
  // signal about short stories against a topic about databases, and the
  // minting path is what SB-61 needs for genuinely new material.
  const h = await startService('qt-mint-still', { llm: noLlm(), embedder: twoWayEmbedder });
  t.after(() => h.close());
  await h.store.putTopic(topic('known', ['p0'], { label: 'Firestore indexes' }));
  await h.store.putPin(pin('p0', 'known', {
    envelope: { ...pin('p0', 'known').envelope, selection: 'a composite index over two fields' },
  }));
  await h.store.putPin(pin('p1', null, {
    envelope: { ...pin('p1', null).envelope, selection: 'writing dialogue that carries a scene' },
  }));

  await h.call('POST', '/pins/p1/quick-take/verdict', { verdict: 'still-shaky' });

  const topics = await h.store.listTopics();
  assert.equal(topics.length, 2, 'unrelated material was filed onto an unrelated topic');
  assert.notEqual((await h.store.getPin('p1'))?.topicId, 'known');
  assert.equal((await h.store.listSignals('known')).length, 0, 'a signal landed on the wrong ledger');
});

test('the same tap twice is one reading', async (t) => {
  // The same rule the resurface mark and the suggestion verbs follow. A retried
  // request and a second press are indistinguishable from here, and a second
  // signal would move comfort further than the learner actually asked.
  const h = await startService('qt-twice', { llm: noLlm() });
  t.after(() => h.close());
  await h.store.putTopic(topic('A', ['p1']));
  await h.store.putPin(pin('p1', 'A'));

  await h.call('POST', '/pins/p1/quick-take/verdict', { verdict: 'still-shaky' });
  const again = await h.call('POST', '/pins/p1/quick-take/verdict', { verdict: 'still-shaky' });

  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyAnswered, true);
  const written = await h.store.listSignals('A');
  assert.equal(written.length, 1);
  assert.equal(written[0]?.type, 'quick-take-still-shaky', 'the answer they gave stands');
});

test('a verdict the panel does not offer writes nothing rather than defaulting', async (t) => {
  // The whole of the untrusted boundary on this endpoint. A default here would
  // put a comfort signal the learner never gave into the ledger.
  const h = await startService('qt-bad-verdict', { llm: noLlm() });
  t.after(() => h.close());
  await h.store.putTopic(topic('A', ['p1']));
  await h.store.putPin(pin('p1', 'A'));

  for (const body of [{ verdict: 'maybe' }, {}, { verdict: 5 }]) {
    assert.equal((await h.call('POST', '/pins/p1/quick-take/verdict', body)).status, 400);
  }
  assert.deepEqual(await h.store.listSignals('A'), []);
});

test('a tap on a pin that is gone is a 404 and mints nothing', async (t) => {
  const h = await startService('qt-verdict-missing', { llm: noLlm() });
  t.after(() => h.close());

  assert.equal((await h.call('POST', '/pins/nope/quick-take/verdict', { verdict: 'got-it' })).status, 404);
  assert.deepEqual(await h.store.listTopics(), []);
});

// ---------------------------------------------------------------- the pause

test('the manual-capture pause exemption: a pause stops the watching, and never the asking', async (t) => {
  /**
   * The deliberate-capture precedence, confirmed as the manual-capture pause exemption: pause governs what is *watched*, not
   * what the learner asks for by name. Manual capture has been exempt since it
   * was written, and the Scout's label — a model call — already runs on every
   * paused pin. The quick take is the same class of gesture one step further
   * in: the learner pinned something and then pressed a second button.
   *
   * Nothing in UX_SPEC §3 rules otherwise; the only pause-adjacent line in the
   * spec is that no surface may *solicit* taps, and the exemption does not
   * solicit anything. The collection-pause contract's rationale points the same way — a withheld
   * off-switch spends the learner's money against their intent, and so would a
   * pause that silently refused a button they pressed on purpose.
   */
  const h = await startService('qt-paused', { llm: taking('A take.') });
  t.after(() => h.close());
  await h.store.putPrefs({ ...await h.store.getPrefs(), pausedUntil: '9999-12-31T23:59:59.999Z' });
  await h.store.putTopic(topic('A', ['p1']));
  await h.store.putPin(pin('p1', 'A'));

  assert.equal((await h.call('POST', '/pins/p1/quick-take')).body.outcome, 'ready');
  assert.equal((await h.call('POST', '/pins/p1/quick-take/verdict', { verdict: 'got-it' })).status, 200);
  assert.equal((await h.store.listSignals('A')).length, 1);
});

// ------------------------------------------------- through to the surfaces

test('SB-61: a still-shaky tap reaches zone 3 and this run\'s reason, with no second store', async (t) => {
  // The one-ledger claim, made end to end: one tap, and the two surfaces that
  // are supposed to know about it both do, from the signal ledger and nothing
  // else. This is what "one ledger, no parallel bookkeeping" has to mean.
  const h = await startService('qt-surfaces', { llm: noLlm() });
  t.after(() => h.close());
  await h.store.putTopic(topic('A', ['p1'], { lastExposedAt: daysAgo(9) }));
  await h.store.putPin(pin('p1', 'A'));

  await h.call('POST', '/pins/p1/quick-take/verdict', { verdict: 'still-shaky' });

  const flagged = (await h.call('GET', '/flagged')).body;
  assert.deepEqual(flagged.rows.map((r: { source: string }) => r.source), ['quick-take-still-shaky']);
  assert.equal(flagged.rows[0]?.topicLabel, 'label of A');

  const card = (await h.call('GET', '/session')).body.card;
  assert.match(card.why ?? '', /still shaky/i, 'and the night can say whose idea it was');
});

test('got it is not a flag — it is the learner saying they are done with it', async (t) => {
  const h = await startService('qt-surfaces-got', { llm: noLlm() });
  t.after(() => h.close());
  await h.store.putTopic(topic('A', ['p1'], { lastExposedAt: daysAgo(9) }));
  await h.store.putPin(pin('p1', 'A'));

  await h.call('POST', '/pins/p1/quick-take/verdict', { verdict: 'got-it' });
  assert.deepEqual((await h.call('GET', '/flagged')).body.rows, []);
});

/**
 * SB-286 — THE ONE MINUTE HERO'S TWO REFUSALS, THROUGH THE DOORS THEY USE.
 *
 * The walkthrough finding: at one minute the hero is a single quick take with
 * no controls at all, so the one move the product offers cannot be refused or
 * redirected before it is opened. Both halves of the fix are old doors used
 * again, and that is what these pin.
 *
 * *Not now* is `POST /pins/:id/quick-take/verdict`, unchanged, said before the
 * take rather than after it: the same mark, the same source event, the same
 * hold window. *Show me another* is a query on the read, so refusing a pick
 * writes nothing to the board at all.
 */
test('SB-286: not now before the take is read holds the topic exactly as it does after', async (t) => {
  const h = await startService('qt-hero-defer', { llm: noLlm() });
  t.after(() => h.close());
  const enough = 'A saved passage with enough source words for one concise explanation now.';
  await h.store.putTopic(topic('A', ['p1']));
  await h.store.putPin(pin('p1', 'A', {
    envelope: { ...pin('p1', 'A').envelope, selection: enough, surroundingText: enough },
  }));
  await h.store.putTopic(topic('B', ['p2']));
  await h.store.putPin(pin('p2', 'B', {
    envelope: { ...pin('p2', 'B').envelope, selection: enough, surroundingText: enough },
  }));

  const offered = (await h.call('GET', '/today?minutes=1')).body.next.primary;
  assert.equal(offered.kind, 'quick-take');
  assert.equal(offered.othersReady, 1, 'the pick did not say another topic was behind it');

  // No take was fetched first. The door does not ask, and must not: refusing
  // something before you read it is the case this control exists for.
  const said = await h.call('POST', `/pins/${offered.targetId}/quick-take/verdict`, { verdict: 'not-now' });
  assert.equal(said.status, 200);
  assert.equal(said.body.backAfterDays, 7);

  const live = (await h.store.listSignals(said.body.topicId)).filter((s) => !s.invalidated);
  assert.deepEqual(live.map((s) => s.type), ['lineup-not-now'],
    'a deferral said on the hero minted a kind the close does not write');
  assert.equal(live[0]?.sourceEvent, `quick-take:${offered.targetId}`);

  // And the screen does not dead-end: the next read offers the other topic.
  const after = (await h.call('GET', '/today?minutes=1')).body.next.primary;
  assert.equal(after.kind, 'quick-take');
  assert.notEqual(after.targetId, offered.targetId, 'the topic just put down came straight back');
  assert.equal(after.othersReady, 0);
});

test('SB-286: a passed over pick is held out of the read and nothing is written', async (t) => {
  const h = await startService('qt-hero-another', { llm: noLlm() });
  t.after(() => h.close());
  const enough = 'A saved passage with enough source words for one concise explanation now.';
  await h.store.putTopic(topic('A', ['p1']));
  await h.store.putPin(pin('p1', 'A', {
    envelope: { ...pin('p1', 'A').envelope, selection: enough, surroundingText: enough },
  }));
  await h.store.putTopic(topic('B', ['p2']));
  await h.store.putPin(pin('p2', 'B', {
    envelope: { ...pin('p2', 'B').envelope, selection: enough, surroundingText: enough },
  }));

  const offered = (await h.call('GET', '/today?minutes=1')).body.next.primary;
  const swapped = (await h.call('GET', `/today?minutes=1&passedOver=${offered.targetId}`)).body.next.primary;
  assert.equal(swapped.kind, 'quick-take');
  assert.notEqual(swapped.targetId, offered.targetId);
  assert.equal(swapped.othersReady, 0, 'the last candidate offered a swap it could not make');

  // The pass over itself is the panel's own call on the ledger that already
  // counts them, and it is the only thing the gesture writes.
  assert.equal((await h.call('POST', '/model/slipping/passed-over', {
    offeredId: offered.id, chosenId: swapped.id, offeredReason: offered.reasons[0]?.code,
  })).status, 200);

  for (const topicId of ['A', 'B']) {
    assert.deepEqual(await h.store.listSignals(topicId), [],
      'refusing a pick before reading it wrote evidence about the learner');
  }
  // Nothing about how somebody learns, either: SB-282's tallies are built from
  // statements, and this gesture leaves the room without one.
  assert.deepEqual(await h.store.listStatements(), []);

  // Asking again without the refusal returns the board's own best pick, which
  // is what makes this a fact about one screen rather than a mark on a topic.
  assert.equal((await h.call('GET', '/today?minutes=1')).body.next.primary.targetId, offered.targetId);
});

test('SB-286: an unrecognised refusal changes nothing about the answer', async (t) => {
  // The bound on the query, from the outside: an id that names no pin is the
  // same as no id at all, and a hostile one cannot grow the read.
  const h = await startService('qt-hero-junk', { llm: noLlm() });
  t.after(() => h.close());
  await h.store.putTopic(topic('A', ['p1']));
  await h.store.putPin(pin('p1', 'A'));

  const plain = (await h.call('GET', '/today?minutes=1')).body.next.primary;
  const noisy = (await h.call('GET',
    `/today?minutes=1&passedOver=${'x'.repeat(400)}&passedOver=nope`)).body.next.primary;
  assert.equal(noisy.targetId, plain.targetId);
  assert.equal(noisy.othersReady, plain.othersReady);
});
