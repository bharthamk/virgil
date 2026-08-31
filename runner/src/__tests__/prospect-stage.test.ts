import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LlmRefused, prospectGaps, PROSPECT_MAX_MODEL_CALLS, PROSPECT_SHAKY_COMFORT,
  type Llm, type LlmRequest, type LlmResult, type ProspectProposal,
} from '@sb/core';

import { runBatch } from '../pipeline.js';
import { PROSPECT_SKIPPED_LINE } from '../prospect-stage.js';
import { bench, generateBoard, stageOf, type Bench } from './batch-harness.js';
import { startService } from './service-harness.js';

/**
 * THE NIGHT SCOUT, IN A NIGHT.
 *
 * The stage is the only one in the pipeline that is allowed to do nothing and
 * still be working, so most of this file is about the ways it declines: a
 * preference, an empty gap list, a refusal it must not carry out of the run,
 * and a gap somebody has already answered. The one test that lets it succeed
 * checks the two things a proposal is for: that it is stored as a proposal, and
 * that nothing else on the board moved.
 *
 * A real `JsonStore` in a temp directory and the scripted model the rest of the
 * nightly tests use, so what is asserted is a night rather than a mock.
 */

const BOARD = () => generateBoard(4, 2);

/** The night, with the night scout answering as this test wants it to. */
const withProspect = (b: Bench, answer: (req: LlmRequest) => unknown): Llm => ({
  complete: (req) => b.llm.complete(),
  structured: async <T,>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => {
    if (stageOf(req) !== 'prospect') return b.llm.structured<T>(req);
    const value = answer(req);
    if (value instanceof Error) throw value;
    return { value: value as T, modelId: 'stub', inputTokens: 0, outputTokens: 0 };
  },
});

const PROPOSING = (req: LlmRequest): unknown => {
  const first = /^(e\d+) \[/m.exec(req.prompt);
  return req.prompt.includes('Proposals:')
    ? { leads: [{ proposal: 'n1', phrase: 'an introduction to it', url: 'https://example.test/read' }] }
    : {
      proposals: [{
        evidenceId: first?.[1] ?? 'e1',
        subject: 'An introduction to what your sources assume',
        reason: 'Several of your sources take this for granted and nothing on your board covers it.',
      }],
    };
};

const lineFor = (reports: readonly { stage: string; detail: string }[], stage: string): string =>
  reports.find((r) => r.stage === stage)?.detail ?? '';

// ------------------------------------------------------------- where it runs

test('prospect runs after the statements it reads and before the lesson it must not shape', async () => {
  const b = await bench('prospect-order', BOARD());
  const { reports } = await runBatch(b.deps);
  const order = reports.map((r) => r.stage);
  assert.deepEqual(order, [
    'intake', 'forage', 'cluster', 'survey', 'analyse', 'comfort', 'statements',
    'prospect', 'garden', 'compose', 'verify',
  ]);
  assert.ok(order.indexOf('prospect') > order.indexOf('statements'));
  assert.ok(order.indexOf('prospect') < order.indexOf('compose'),
    'and it lands before the brief is built, so what it proposes cannot shape tonight');
});

// ------------------------------------------------------------- the ways out

test('a learner who turned it off gets a night that says so and spends nothing', async () => {
  const b = await bench('prospect-off', BOARD());
  await b.store.putPrefs({ ...await b.store.getPrefs(), prospect: false });
  const llm = withProspect(b, () => { throw new Error('the stage must not reach a model'); });
  const { reports } = await runBatch({ ...b.deps, llm });
  const report = reports.find((r) => r.stage === 'prospect');
  assert.equal(report?.failed, false);
  assert.equal(report?.detail, PROSPECT_SKIPPED_LINE);
  assert.deepEqual(await b.store.listProspectProposals(), []);
});

test('a board with nothing to be short of buys no call', async () => {
  // One pin, so nothing is assumed twice, and no signal, so nothing is avoided.
  const b = await bench('prospect-no-gaps', generateBoard(1, 1));
  const llm = withProspect(b, () => { throw new Error('the stage must not reach a model'); });
  const { reports } = await runBatch({ ...b.deps, llm });
  assert.match(lineFor(reports, 'prospect'), /nothing new to look for/);
});

test('a refusal stops the night at the lesson, never at the night scout', async () => {
  /**
   * The one deliberate exception to the fleet rule, and the reason for it.
   *
   * A spend limit or a missing credential arrives as `LlmRefused` and ends the
   * run everywhere else, which is right: the learner set the limit and has to
   * hear about it. But this stage sits before Compose and is optional, so
   * carrying the refusal out of it would cost somebody tonight's lesson over a
   * suggestion they never asked for. It declines instead, and the refusal
   * reaches them from the stage that actually matters.
   */
  const b = await bench('prospect-refused', BOARD());
  const llm = withProspect(b, () => new LlmRefused('your budget stopped this before anything was sent'));
  const { reports, session } = await runBatch({ ...b.deps, llm });
  const report = reports.find((r) => r.stage === 'prospect');
  assert.equal(report?.failed, false, 'a stage that declined to spend did not fail');
  assert.match(report?.detail ?? '', /nothing was sent/);
  assert.ok(reports.some((r) => r.stage === 'compose'), 'the night carried on to the lesson');
  assert.equal(session?.outcome, 'composed', 'and the lesson was built');
  assert.deepEqual(await b.store.listProspectProposals(), []);
});

test('a provider failure inside the stage degrades it and loses nothing else', async () => {
  const b = await bench('prospect-failed', BOARD());
  const llm = withProspect(b, () => new Error('the provider is down'));
  const { reports, session } = await runBatch({ ...b.deps, llm });
  assert.match(lineFor(reports, 'prospect'), /MODEL-FAILED, nothing proposed and nothing lost/);
  assert.equal(reports.find((r) => r.stage === 'prospect')?.failed, false);
  assert.equal(session?.outcome, 'composed');
});

// ------------------------------------------------------------- the good night

test('a proposal is stored as a proposal, and the board it came from does not move', async () => {
  const b = await bench('prospect-proposes', BOARD());
  const llm = withProspect(b, PROPOSING);
  const { reports } = await runBatch({ ...b.deps, llm });
  assert.match(lineFor(reports, 'prospect'), /1 proposal\(s\) from \d+ gap\(s\) in 2 of 2 call\(s\)/);
  assert.match(lineFor(reports, 'prospect'), /all still proposals, nothing written to the board/);

  const [proposal] = await b.store.listProspectProposals();
  assert.ok(proposal, 'the proposal was persisted');
  assert.equal(proposal.state, 'pending');
  assert.equal(proposal.lead?.url, 'https://example.test/read');
  assert.equal(proposal.lead?.unread, true);
  assert.ok(proposal.evidenceKey.length > 0);
  assert.ok(proposal.evidenceDetail.length > 0, 'the evidence travels with the reason');

  // The four kinds of record a proposal is forbidden to write.
  assert.deepEqual(await b.store.listCourses(), []);
  assert.deepEqual(await b.store.listCommitments(), []);
  const topicsBefore = (await b.store.listTopics()).length;
  assert.ok(topicsBefore > 0, 'the night did its ordinary work');
  assert.equal((await b.store.listPins()).length, 4, 'and no pin was invented by a suggestion');
});

test('a gap that has already been put to the learner is not put to them again', async () => {
  const b = await bench('prospect-once', BOARD());
  const llm = withProspect(b, PROPOSING);
  await runBatch({ ...b.deps, llm });
  const first = await b.store.listProspectProposals();
  assert.equal(first.length, 1);
  // Answered, in the way that most invites a second attempt: turned down.
  await b.store.putProspectProposal({ ...(first[0] as ProspectProposal), state: 'dismissed' });

  const { reports } = await runBatch({ ...b.deps, llm });
  const after = await b.store.listProspectProposals();
  assert.equal(after.length, 1, 'the same gap did not come back with the same suggestion on it');
  assert.doesNotMatch(lineFor(reports, 'prospect'), /1 proposal\(s\) from/);
});

/**
 * THE FIFTH SOURCE, THROUGH THE NIGHT.
 *
 * The gap kind and its de-duplication rule are proved pure. What is proved here
 * is that the stage actually reads the board's plan and shelf, so a night can
 * propose material against the thing the learner has been walking past rather
 * than only against what a model call found in their pins.
 */
test('the night scout reads what keeps slipping as one more kind of gap', async () => {
  const b = await bench('prospect-slipping', BOARD());
  const day = (days: number): string =>
    new Date(Date.parse('2026-08-19T03:00:00.000Z') - days * 86_400_000).toISOString();
  await b.store.putCommitment({
    id: 'late-1', title: 'Stats problem set 3', kind: 'assignment', courseId: 'k1',
    topicIds: [], dueAt: day(12), plannedFor: null, estimateMinutes: null, notes: '',
    doneAt: null, createdAt: day(40),
  });
  await b.store.putCourse({
    id: 'k1', title: 'Statistics', provider: '', url: '', topicIds: [],
    material: [], archivedAt: null, createdAt: day(60),
  });
  for (let index = 0; index < 6; index += 1) {
    await b.store.appendSignal({
      id: `busy-${index}`, topicId: 'unrelated', type: 'section-completed',
      direction: 'positive', at: day(index + 1), sourceEvent: 'test', invalidated: false,
    });
  }

  const chooseSlipping = (req: LlmRequest): unknown => {
    if (req.prompt.includes('Proposals:')) return { leads: [] };
    const line = /^(e\d+) \[slipping-item\]/m.exec(req.prompt);
    // Named rather than defaulted: a stub that quietly answered about some
    // other gap would pass this test on a night where the plumbing was gone.
    assert.ok(line, 'the slipping list reached the prompt as its own kind of gap');
    return {
      proposals: [{
        evidenceId: line?.[1] ?? 'none',
        subject: 'A worked example of the method it needs',
        reason: 'It has stood untouched while you finished other work.',
      }],
    };
  };
  await runBatch({ ...b.deps, llm: withProspect(b, chooseSlipping) });
  const [stored] = await b.store.listProspectProposals();
  assert.equal(stored?.evidenceKind, 'slipping-item');
  assert.equal(stored?.evidenceKey, 'slipping:commitment:late-1',
    'its own key, so it can never be confused with the topic somebody explicitly skipped');
});

/**
 * NIGHT ONE, WHICH THIS STAGE USED TO SLEEP THROUGH.
 *
 * The board below is a first night as the product actually meets one: pins,
 * one topic, and no marks at all. Nothing has been skipped, nothing has gone
 * quiet, no check has failed, and every pin takes a different thing for
 * granted, so the four kinds of gap that read the ledger have nothing to read.
 * The night scout's real first run said so, in as many words, while the
 * statements stage two stages earlier had just written that the learner *has
 * not yet built the listening skill to recognise it*.
 *
 * Two runs over that board, differing in one sentence: the second is the
 * control, and the stub's ordinary statement names a habit rather than a hole.
 * A stage that spoke on both would be proposing material off any sentence at
 * all, which is what the shortfall marks exist to stop.
 */
const SHORTFALL = 'You have not yet built the listening skill to recognise it.';

/** A board where nothing is assumed twice, so no prerequisite hole is on it. */
const ownConcepts = (req: LlmRequest): unknown => {
  const keys = [...req.prompt.matchAll(/^pin (p\d+):/gm)].map((m) => String(m[1]));
  if (keys.length) {
    return {
      enrichments: keys.map((key) => ({
        pin: key, assumedConcepts: [`what ${key} takes for granted`], mediaDescription: null,
      })),
    };
  }
  const one = /the passage (p\d+) saved/.exec(req.prompt)?.[1] ?? 'nothing';
  return { assumedConcepts: [`what ${one} takes for granted`], mediaDescription: null };
};

const firstNight = (tag: string, statements: readonly string[]): Promise<Bench> =>
  bench(tag, generateBoard(4, 1), {
    answer: (stage, req) => {
      if (stage === 'forage') return ownConcepts(req);
      if (stage === 'statements') return { statements: [...statements] };
      return undefined;
    },
  });

test('a sentence the board wrote about a shortfall gets the scout speaking on night one', async () => {
  const b = await firstNight('prospect-night-one', [SHORTFALL]);
  const { reports } = await runBatch({ ...b.deps, llm: withProspect(b, PROPOSING) });
  assert.match(lineFor(reports, 'prospect'), /1 proposal\(s\) from 1 gap\(s\) in 2 of 2 call\(s\)/,
    'a board with no marks on it at all now has one thing to look for, and buys the call for it');

  const [stored] = await b.store.listProspectProposals();
  assert.equal(stored?.evidenceKind, 'shortfall-read');
  assert.match(stored?.evidenceKey ?? '', /^read:/);
  assert.match(stored?.evidenceDetail ?? '', /^Written on your board: /);
  assert.equal(stored?.evidenceUnconfirmed, true,
    'the caveat travels with the proposal, so the screen it lands on cannot lose it');
});

/**
 * SB-285 — THE GAP THAT COULD NEVER FIRE, FIRING.
 *
 * `shaky-statement` is the oldest kind in the file and the one with the
 * strongest ground under it: the arithmetic says this topic is not solid, and
 * the sentence is what that number reads like in prose. It reads
 * `Statement.topicId`, and SB-284 found that field was written null on every
 * path in the product that produces a statement, so on a real board the kind
 * had never once spoken. The pure tests could only prove it by handing the gap
 * list a statement no write path could produce.
 *
 * This is the same claim through a night: the Registrar's own label join now
 * writes the topic down, and the gap the arithmetic supports is what the scout
 * is given.
 */
const SHAKY_ABOUT_TOPIC = 'You are still shaky on Topic g1.';

test('SB-285: a sentence about one topic carries it, so the comfort-gated gap can fire', async () => {
  const b = await firstNight('prospect-shaky-real', [SHAKY_ABOUT_TOPIC]);
  await runBatch({ ...b.deps, llm: withProspect(b, () => ({ proposals: [] })) });

  const [topic] = await b.store.listTopics();
  const [written] = await b.store.listStatements();
  assert.equal(written?.topicId, topic?.id,
    'the write path records which topic the sentence was about');
  assert.ok((topic?.comfort ?? 1) < PROSPECT_SHAKY_COMFORT, 'and the ledger calls that topic shaky');

  const gaps = prospectGaps({
    statements: await b.store.listStatements(),
    topics: await b.store.listTopics(),
    signals: await b.store.listSignals(),
    pins: await b.store.listPins(),
  });
  assert.deepEqual(gaps.map((gap) => gap.kind), ['shaky-statement'],
    'one topic, one gap: the arithmetic-backed kind speaks and the read of the same sentence does not');
  assert.equal(gaps[0]?.key, `statement:${written?.id}`);
  assert.equal(gaps[0]?.topicId, topic?.id);
  assert.equal(gaps[0]?.unconfirmed, true, 'nobody has agreed to this sentence yet');
});

test('SB-285: a sentence about the whole board still carries no topic, and no gap is doubled', async () => {
  // The control for the test above, and the second half of the no-double-count
  // rule. The same shortfall word, naming no topic label, so the comfort-gated
  // kind has nothing to stand on and the weaker read of the sentence speaks
  // alone.
  const b = await firstNight('prospect-shaky-board-wide',
    ['You are still shaky on the exceptions.']);
  await runBatch({ ...b.deps, llm: withProspect(b, () => ({ proposals: [] })) });

  const [written] = await b.store.listStatements();
  assert.equal(written?.topicId, null);
  const gaps = prospectGaps({
    statements: await b.store.listStatements(),
    topics: await b.store.listTopics(),
    signals: await b.store.listSignals(),
    pins: await b.store.listPins(),
  });
  assert.deepEqual(gaps.map((gap) => `${gap.kind}:${gap.key}`), [`shortfall-read:read:${written?.id}`],
    'exactly one gap for one sentence, whichever kind it turns out to be');
});

test('the same night, one sentence different, still declines and spends nothing', async () => {
  const b = await firstNight('prospect-night-one-quiet',
    ['You reach for the mechanism before the definition.']);
  const llm = withProspect(b, () => { throw new Error('the stage must not reach a model'); });
  const { reports } = await runBatch({ ...b.deps, llm });
  assert.match(lineFor(reports, 'prospect'), /nothing new to look for/);
  assert.deepEqual(await b.store.listProspectProposals(), []);
});

test('the stage can never buy more than its two calls', async () => {
  const b = await bench('prospect-capped', BOARD());
  let calls = 0;
  const llm = withProspect(b, (req) => { calls += 1; return PROPOSING(req); });
  await runBatch({ ...b.deps, llm });
  assert.equal(calls, PROSPECT_MAX_MODEL_CALLS);
});

// ------------------------------------------------------------- the review door

const proposal = (over: Partial<ProspectProposal> = {}): ProspectProposal => ({
  id: 'pr1',
  subject: 'An introduction to eigenvalues',
  reason: 'Two of your sources assume it and nothing on your board covers it.',
  evidenceKey: 'prerequisite:eigenvalues',
  evidenceKind: 'prerequisite-hole',
  evidenceDetail: '2 of your sources assume you already know: eigenvalues',
  evidenceUnconfirmed: false,
  lead: { phrase: 'introduction to eigenvalues', url: 'https://example.test/eigen', unread: true },
  state: 'pending',
  raisedAt: '2026-08-19T03:00:00.000Z',
  batchKey: '2026-08-19',
  decidedAt: null,
  ...over,
});

test('the review door lists what is waiting and nothing that has been answered', async (t) => {
  const h = await startService('prospect-list');
  t.after(() => h.close());
  await h.store.putProspectProposal(proposal());
  await h.store.putProspectProposal(proposal({ id: 'pr2', state: 'dismissed' }));

  const res = await h.call('GET', '/prospects');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.proposals.map((p: ProspectProposal) => p.id), ['pr1']);
  assert.equal(res.body.proposals[0].lead.unread, true);
});

test('keeping one saves the address unread, and writes nothing else', async (t) => {
  const h = await startService('prospect-accept');
  t.after(() => h.close());
  await h.store.putProspectProposal(proposal());

  const res = await h.call('PATCH', '/prospects/pr1', { field: 'state', value: 'accepted' });
  assert.equal(res.status, 200);
  assert.equal(res.body.proposal.state, 'accepted');
  assert.equal(res.body.proposal.decidedAt, '2026-08-19T03:00:00.000Z');

  const [pin] = await h.store.listPins();
  assert.ok(pin, 'the address is on the board as material');
  assert.equal(pin.envelope.url, 'https://example.test/eigen');
  assert.equal(pin.envelope.selection, null, 'nobody selected anything, and the record says so');
  assert.equal(pin.envelope.surroundingText, '', 'and nobody has read the page around it');
  assert.equal(pin.enrichment, null, 'so it is owed a read, which is what the Forager queue means');
  assert.equal(pin.fromSuggestion, true);
  assert.deepEqual((await h.store.listPins({ unenrichedOnly: true })).map((p) => p.id), [pin.id]);
  assert.deepEqual(await h.store.listTopics(), []);
  assert.deepEqual(await h.store.listCommitments(), []);
  assert.deepEqual(await h.store.listSignals(), []);
});

test('keeping one with no address records the decision and saves nothing', async (t) => {
  const h = await startService('prospect-accept-bare');
  t.after(() => h.close());
  await h.store.putProspectProposal(proposal({ lead: null }));
  const res = await h.call('PATCH', '/prospects/pr1', { field: 'state', value: 'accepted' });
  assert.equal(res.status, 200);
  assert.equal(res.body.pinId, null);
  assert.deepEqual(await h.store.listPins(), []);
});

test('leaving one out is an answer, and answering twice is a conflict rather than a second write',
  async (t) => {
    const h = await startService('prospect-dismiss');
    t.after(() => h.close());
    await h.store.putProspectProposal(proposal());

    assert.equal((await h.call('PATCH', '/prospects/pr1',
      { field: 'state', value: 'dismissed' })).status, 200);
    const again = await h.call('PATCH', '/prospects/pr1', { field: 'state', value: 'accepted' });
    assert.equal(again.status, 409);
    assert.equal(again.body.proposal.state, 'dismissed', 'and it says what the answer already was');
    assert.deepEqual(await h.store.listPins(), [], 'the refused second answer saved nothing');
  });

test('a decision the door does not take is refused before anything is written', async (t) => {
  const h = await startService('prospect-refuse');
  t.after(() => h.close());
  await h.store.putProspectProposal(proposal());
  for (const body of [
    { field: 'subject', value: 'accepted' },
    { field: 'state', value: 'pending' },
    { field: 'state', value: 'deleted' },
  ]) {
    const res = await h.call('PATCH', '/prospects/pr1', body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal((await h.call('PATCH', '/prospects/nope',
    { field: 'state', value: 'accepted' })).status, 404);
  assert.equal((await h.store.getProspectProposal('pr1'))?.state, 'pending');
});

test('the preference is one the learner owns, and absent reads as on', async (t) => {
  const h = await startService('prospect-pref');
  t.after(() => h.close());
  assert.equal((await h.call('GET', '/prefs')).body.prospect, undefined,
    'a board that predates the switch has not turned anything off');

  const off = await h.call('PUT', '/prefs', { prospect: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.prospect, false);
  assert.equal((await h.store.getPrefs()).prospect, false);
  assert.equal((await h.call('PUT', '/prefs', { prospect: 'yes' })).status, 400,
    'and it is a switch rather than a string');
});
