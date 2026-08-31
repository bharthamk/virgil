import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fixedClock } from '../ports/clock.js';
import type { Llm, LlmRequest, LlmResult } from '../ports/llm.js';
import type { PureDeps } from '../agents/deps.js';
import type { Pin, Signal, Statement, Topic } from '../domain/types.js';
import {
  admitProspectProposals, decideProspectProposal, orderProspectProposals,
  pendingProspectProposals, prospectGaps, prospectLeadUrl, withProspectLead,
  ProspectStateError,
  PROSPECT_MAX_GAPS, PROSPECT_MAX_MODEL_CALLS, PROSPECT_MAX_PROPOSALS,
  PROSPECT_MIN_ASSUMED, PROSPECT_MIN_AVOIDANCE, PROSPECT_SHAKY_COMFORT,
  type ProspectEvidence, type ProspectProposal,
} from '../domain/prospect.js';
import type { AvoidanceCandidate } from '../domain/avoidance.js';
import { prospect } from '../agents/prospector.js';

/**
 * THE NIGHT SCOUT, WITHOUT A MODEL AND THEN WITH A DISHONEST ONE.
 *
 * Two halves, and the second is the one that matters. The gap list is pure
 * arithmetic over records the night already produced, so it is asserted
 * directly. The agent is a model call, and every assertion about it is about
 * what happens when the reply is wrong: an id nobody offered, a fourth proposal
 * over a cap of three, two proposals on one gap, an address that is not an
 * address. This is the only agent in the fleet whose output is a suggestion the
 * learner never asked for, so its refusals are its behaviour.
 */

const clock = fixedClock('2026-08-29T03:00:00Z');
const NOW = '2026-08-29T03:00:00.000Z';

const deps = (llm: Llm): PureDeps => ({ llm, clock });

const topic = (id: string, over: Partial<Topic> = {}): Topic => ({
  id,
  label: `Topic ${id}`,
  summary: `What ${id} is about.`,
  pinIds: [],
  state: 'working',
  comfort: 0.2,
  lastExposedAt: null,
  retiredByUser: false,
  createdAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

const statement = (id: string, topicId: string | null, over: Partial<Statement> = {}): Statement => ({
  id,
  text: 'They reach for the mechanism before the definition.',
  topicId,
  userEdited: false,
  evidenceSignalIds: [],
  updatedAt: NOW,
  ...over,
});

const signal = (id: string, topicId: string, type: Signal['type'],
  direction: Signal['direction'] = 'negative'): Signal => ({
  id, topicId, type, direction, at: '2026-08-20T00:00:00.000Z',
  sourceEvent: `event:${id}`, invalidated: false,
});

const pin = (id: string, assumed: readonly string[]): Pin => ({
  id,
  type: 'interest',
  envelope: {
    selection: 'a passage', parts: [], surroundingText: 'around it',
    headingPath: [], pageTitle: `Page ${id}`, url: `https://example.test/${id}`,
    canonicalUrl: null, siteName: null, contentLanguage: 'en', media: null,
  },
  note: null,
  capturedAt: '2026-08-02T00:00:00.000Z',
  fromSuggestion: false,
  enrichment: {
    refetchedText: null,
    assumedConcepts: [...assumed],
    mediaDescription: null,
    references: [],
    outcome: 'enriched',
    confidence: 'full',
    enrichedAt: NOW,
  },
  topicId: null,
});

const evidence = (key: string): ProspectEvidence =>
  ({ key, kind: 'shaky-statement', detail: `the gap behind ${key}`, topicId: 't1', unconfirmed: false });

const context = () => {
  let n = 0;
  return { now: NOW, batchKey: '2026-08-29', id: () => `proposal-${++n}` };
};

// ------------------------------------------------------------- the gap list

test('a statement about a shaky topic is a gap, and one about a solid topic is not', () => {
  const gaps = prospectGaps({
    statements: [statement('s1', 't1'), statement('s2', 't2')],
    topics: [topic('t1', { comfort: 0.2 }), topic('t2', { comfort: 0.9 })],
    signals: [],
    pins: [],
  });
  assert.deepEqual(gaps.map((g) => g.key), ['statement:s1']);
  assert.equal(gaps[0]?.kind, 'shaky-statement');
  assert.match(gaps[0]?.detail ?? '', /Topic t1/, 'the gap names the topic it is about');
});

test('the comfort floor is the boundary it says it is', () => {
  const at = prospectGaps({
    statements: [statement('s1', 't1')],
    topics: [topic('t1', { comfort: PROSPECT_SHAKY_COMFORT })],
    signals: [], pins: [],
  });
  assert.deepEqual(at, [], 'at the floor a topic is solid enough to be left alone');
});

test('a statement the learner rejected is not evidence for proposing anything', () => {
  // They already argued with this read. Building a suggestion on it would be
  // the product asking the same question twice through a different door.
  const gaps = prospectGaps({
    statements: [statement('s1', 't1', { rejected: true })],
    topics: [topic('t1')], signals: [], pins: [],
  });
  assert.deepEqual(gaps, []);
});

test('a failed check on their own writing is a gap, and a positive one is not', () => {
  const gaps = prospectGaps({
    statements: [],
    topics: [topic('t1', { comfort: 0.9 })],
    signals: [
      signal('g1', 't1', 'qc-finding', 'negative'),
      signal('g2', 't1', 'qc-finding', 'positive'),
      signal('g3', 't1', 'qc-finding', 'negative') as Signal,
    ].map((s, i) => (i === 2 ? { ...s, invalidated: true } : s)),
    pins: [],
  });
  assert.deepEqual(gaps.map((g) => g.key), ['finding:g1'],
    'an invalidated mark and a positive one are not findings against them');
});

test('a concept two sources assume and no topic covers is a prerequisite hole', () => {
  const gaps = prospectGaps({
    statements: [],
    topics: [topic('t1', { label: 'Vector spaces', comfort: 0.9 })],
    signals: [],
    pins: [
      pin('p1', ['Eigenvalues', 'Vector spaces']),
      pin('p2', ['eigenvalues!', 'Vector Spaces']),
      pin('p3', ['Something only one page assumes']),
    ],
  });
  assert.deepEqual(gaps.map((g) => g.key), ['prerequisite:eigenvalues'],
    'the covered concept is not a hole, and one page assuming something is not either');
  assert.match(gaps[0]?.detail ?? '', new RegExp(`^${PROSPECT_MIN_ASSUMED} of your sources`));
});

test('a topic set aside twice is avoided, and one demonstration takes it off the list', () => {
  const stepped = [
    signal('a1', 't1', 'self-skip'), signal('a2', 't1', 'section-abandoned'),
    signal('b1', 't2', 'lineup-not-now'), signal('b2', 't2', 'self-skip'),
    signal('b3', 't2', 'answer-correct', 'positive'),
  ];
  const gaps = prospectGaps({
    statements: [], topics: [topic('t1', { comfort: 0.9 }), topic('t2', { comfort: 0.9 })],
    signals: stepped, pins: [],
  });
  assert.deepEqual(gaps.map((g) => g.key), ['avoided:t1']);
  assert.match(gaps[0]?.detail ?? '', new RegExp(`aside ${PROSPECT_MIN_AVOIDANCE} times`));
});

/**
 * THE FIFTH KIND OF GAP, AND WHY IT IS NOT THE FOURTH.
 *
 * `avoided-topic` is built from marks the learner MADE: offered, and skipped,
 * twice. The slipping list is built from marks that are ABSENT. They are
 * different evidence with different failure modes, so they carry distinct keys
 * and the refusal wins where both would speak about one topic.
 */
const slipper = (key: string, topicIds: readonly string[] = []): AvoidanceCandidate => ({
  key,
  kind: key.startsWith('material') ? 'material' : key.startsWith('recall') ? 'recall' : 'commitment',
  id: key.split(':')[1] ?? '',
  title: 'Stats problem set 3',
  standing: 'overdue',
  idleDays: 12,
  elsewhere: 9,
  score: 48,
  topicIds,
});

test('what keeps slipping reaches the scout as its own kind, under its own key', () => {
  const gaps = prospectGaps({
    statements: [], topics: [], signals: [], pins: [],
    slipping: [slipper('commitment:late-1')],
  });
  assert.deepEqual(gaps.map((g) => g.key), ['slipping:commitment:late-1']);
  assert.equal(gaps[0]?.kind, 'slipping-item');
  assert.match(gaps[0]?.detail ?? '', /untouched for 12 days while you finished 9 other things/);
});

test('a topic already on the list for being stepped around is not proposed twice', () => {
  const stepped = [signal('a1', 't1', 'self-skip'), signal('a2', 't1', 'section-abandoned')];
  const gaps = prospectGaps({
    statements: [], topics: [topic('t1', { comfort: 0.9 })], signals: stepped, pins: [],
    slipping: [slipper('recall:t1', ['t1']), slipper('commitment:late-1')],
  });
  assert.deepEqual(gaps.map((g) => g.key), ['avoided:t1', 'slipping:commitment:late-1'],
    'the refusal is the stronger claim and is already there; the silence about the same topic is not added');
});

test('the same board produces the same gaps in the same order, capped', () => {
  // Determinism is what makes this stage testable and what stops two runs over
  // an unchanged board proposing two different things and charging for both.
  const input = {
    statements: Array.from({ length: 9 }, (_, i) => statement(`s${i}`, `t${i}`)),
    topics: Array.from({ length: 9 }, (_, i) => topic(`t${i}`)),
    signals: [signal('g1', 't3', 'qc-finding')],
    pins: [],
  };
  const first = prospectGaps(input);
  const second = prospectGaps({ ...input, statements: [...input.statements].reverse() });
  assert.equal(first.length, PROSPECT_MAX_GAPS);
  assert.deepEqual(first.map((g) => g.key), second.map((g) => g.key));
  assert.equal(first[0]?.key, 'finding:g1', 'what a check found outranks what a read guessed');
});

test('a retired topic is off the board, so it is off this list too', () => {
  assert.deepEqual(prospectGaps({
    statements: [statement('s1', 't1')],
    topics: [topic('t1', { retiredByUser: true })],
    signals: [signal('g1', 't1', 'qc-finding')],
    pins: [],
  }), []);
});

/**
 * THE SIXTH KIND, AND THE NIGHT IT EXISTS FOR.
 *
 * The scout's first real night said "nothing new to look for across 8 scored
 * topic(s)" while the statements stage, two stages earlier, had just written
 * *has not yet built the listening skill to recognise it*. Every gap kind above
 * needs a mark the learner MADE, and on a first night the only marks are seeded
 * ones that score a topic solid. So the board held a sentence naming a hole and
 * the stage that looks for holes could not see it.
 *
 * These are the rules that let it see it without letting it overclaim: the
 * ledger stays silent in every board below, the sentence has to name a
 * shortfall in its own words, and the gap says whether the learner ever agreed
 * to the sentence it stands on.
 */
const SETTLED = { comfort: 0.9 } as const;
const SHORTFALL = 'You have not yet built the listening skill to recognise it.';

/** A statement joined to a topic the way the Registrar joined it: by signal. */
const wrote = (id: string, text: string, over: Partial<Statement> = {}): Statement =>
  statement(id, null, { text, evidenceSignalIds: ['seed-1'], ...over });

const seeded = () => ({
  topics: [topic('t1', SETTLED)],
  signals: [signal('seed-1', 't1', 'interview-seed', 'positive')],
  pins: [],
});

test('a sentence the board wrote about a shortfall is a gap on a night the ledger is quiet', () => {
  const gaps = prospectGaps({ ...seeded(), statements: [wrote('s1', SHORTFALL)] });
  assert.deepEqual(gaps.map((g) => g.key), ['read:s1'],
    'its own key, so it can never be confused with the comfort-gated read');
  assert.equal(gaps[0]?.kind, 'shortfall-read');
  assert.equal(gaps[0]?.topicId, 't1',
    'the topic comes off the signals the sentence summarised, not off a fresh guess');
  assert.match(gaps[0]?.detail ?? '', /^Written on your board about "Topic t1": /);
  assert.equal(gaps[0]?.unconfirmed, true,
    'nobody has agreed to this sentence, and the gap says so rather than leaving it to be worked out');
});

test('a sentence that names no shortfall is not a hole, however unsettled the board', () => {
  assert.deepEqual(prospectGaps({
    ...seeded(),
    statements: [wrote('s1', 'You reach for the mechanism before the definition.')],
  }), [], 'this stage reads prose, and reading prose it does not understand as a gap is how it would lie');
});

test('a sentence the learner rewrote themselves may speak plainly', () => {
  const gaps = prospectGaps({
    ...seeded(),
    statements: [wrote('s1', SHORTFALL, { userEdited: true })],
  });
  assert.equal(gaps[0]?.unconfirmed, false, 'their words, so there is nothing left to hedge about');
});

test('a sentence the learner agreed to may speak plainly, though the words are still mine', () => {
  // The third way across the line, and the one the Insights room's own gesture
  // writes. Confirming is not rewriting: the sentence stays as the arithmetic
  // wrote it, and what changes is that somebody has said it is right. A caveat
  // saying "nothing has confirmed this" over a sentence they confirmed would be
  // the product doubting an answer it was given.
  const gaps = prospectGaps({
    ...seeded(),
    statements: [wrote('s1', SHORTFALL, { confirmedAt: NOW })],
  });
  assert.equal(gaps[0]?.unconfirmed, false, 'they were asked and they said it was right');
});

test('a modality question is a question until it is answered, and a question proposes nothing', () => {
  const asking = (confirmedAt: string | null): Statement => wrote('s1', SHORTFALL, {
    modality: {
      key: 'notation-heavy|hands-on',
      slower: 'notation-heavy',
      faster: 'hands-on',
      askedAt: NOW,
      confirmedAt,
    },
  });
  assert.deepEqual(prospectGaps({ ...seeded(), statements: [asking(null)] }), [],
    ': nothing in the product may act on it, and proposing material off it would be acting on it');
  const answered = prospectGaps({ ...seeded(), statements: [asking(NOW)] });
  assert.deepEqual(answered.map((g) => g.key), ['read:s1']);
  assert.equal(answered[0]?.unconfirmed, false, 'they were asked and they said yes');
});

test('one topic yields the comfort-gated read or the written one, never both', () => {
  // The arithmetic is the stronger ground, so it is the one that speaks. A
  // second sentence about the same topic is the product asking twice.
  const gaps = prospectGaps({
    statements: [
      statement('s1', 't1', { text: SHORTFALL, evidenceSignalIds: ['seed-1'] }),
      wrote('s2', SHORTFALL),
    ],
    topics: [topic('t1', { comfort: 0.2 })],
    signals: [signal('seed-1', 't1', 'interview-seed', 'positive')],
    pins: [],
  });
  assert.deepEqual(gaps.map((g) => `${g.kind}:${g.key}`), ['shaky-statement:statement:s1'],
    'neither the same statement twice nor a second statement about the same topic');
});

test('a sentence about the whole board keeps no topic rather than borrowing one', () => {
  const gaps = prospectGaps({
    ...seeded(),
    statements: [wrote('s1', SHORTFALL, { evidenceSignalIds: [] })],
  });
  assert.equal(gaps[0]?.topicId, null);
  assert.equal(gaps[0]?.detail, `Written on your board: ${SHORTFALL}`);
});

test('the weakest evidence in the file is the first thing the cap drops', () => {
  const gaps = prospectGaps({
    statements: [wrote('s1', SHORTFALL)],
    topics: [topic('t1', SETTLED)],
    signals: [signal('seed-1', 't1', 'interview-seed', 'positive'),
      signal('g1', 't1', 'qc-finding', 'negative')],
    pins: [],
  });
  assert.deepEqual(gaps.map((g) => g.kind), ['check-finding', 'shortfall-read'],
    'a read of a sentence sits below every record of something that happened');
});

// ------------------------------------------------------------- admission

test('a proposal citing evidence nobody offered is dropped, not repaired', () => {
  const out = admitProspectProposals([
    { evidenceKey: 'statement:invented', subject: 'A book', reason: 'because' },
    { evidenceKey: 'statement:s1', subject: 'A worked example', reason: 'your read of t1 is unsettled' },
  ], [evidence('statement:s1')], context());
  assert.equal(out.inventedEvidence, 1);
  assert.deepEqual(out.kept.map((p) => p.subject), ['A worked example']);
  assert.equal(out.kept[0]?.evidenceDetail, 'the gap behind statement:s1',
    'the reason travels with the evidence in the code’s own words');
});

test('a proposal with no subject or no reason is nothing to show anybody', () => {
  const out = admitProspectProposals([
    { evidenceKey: 'statement:s1', subject: '   ', reason: 'a reason' },
    { evidenceKey: 'statement:s2', subject: 'A subject', reason: '' },
  ], [evidence('statement:s1'), evidence('statement:s2')], context());
  assert.deepEqual(out.kept, []);
  assert.equal(out.empty, 2);
});

test('one gap gets one proposal, and the nightly cap is three', () => {
  const gaps = Array.from({ length: 5 }, (_, i) => evidence(`statement:s${i}`));
  const out = admitProspectProposals([
    ...gaps.map((g, i) => ({ evidenceKey: g.key, subject: `Subject ${i}`, reason: 'a reason' })),
    { evidenceKey: 'statement:s0', subject: 'A second bite', reason: 'a reason' },
  ], gaps, context());
  assert.equal(out.kept.length, PROSPECT_MAX_PROPOSALS);
  assert.equal(out.overCap, 2);
  assert.equal(out.duplicate, 1);
  assert.deepEqual(out.kept.map((p) => p.state), ['pending', 'pending', 'pending']);
});

test('an address that is not an ordinary web address never reaches a proposal', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'https://user:pw@example.test/a', '']) {
    assert.equal(prospectLeadUrl(bad), null, bad);
  }
  assert.equal(prospectLeadUrl('https://example.test/a'), 'https://example.test/a');
  const out = admitProspectProposals([{
    evidenceKey: 'statement:s1', subject: 'A guide', reason: 'a reason',
    lead: { phrase: 'introduction to eigenvalues', url: 'javascript:alert(1)' },
  }], [evidence('statement:s1')], context());
  assert.equal(out.kept[0]?.lead?.url, null, 'the phrase survives and the address does not');
  assert.equal(out.kept[0]?.lead?.phrase, 'introduction to eigenvalues');
  assert.equal(out.kept[0]?.lead?.unread, true, 'and the record says nothing has read it');
});

test('a lead with no phrase is no lead at all', () => {
  const out = admitProspectProposals([{
    evidenceKey: 'statement:s1', subject: 'A guide', reason: 'a reason',
    lead: { phrase: '  ', url: 'https://example.test/a' },
  }], [evidence('statement:s1')], context());
  assert.equal(out.kept[0]?.lead, null);
});

test('a lead attached after the fact carries the same refusal', () => {
  const [proposal] = admitProspectProposals(
    [{ evidenceKey: 'statement:s1', subject: 'A guide', reason: 'a reason' }],
    [evidence('statement:s1')], context()).kept;
  assert.ok(proposal);
  assert.equal(withProspectLead(proposal, { phrase: '' }).lead, null, 'an empty phrase changes nothing');
  const led = withProspectLead(proposal, { phrase: 'eigenvalues intro', url: 'ftp://example.test/a' });
  assert.equal(led.lead?.url, null);
  assert.equal(led.lead?.phrase, 'eigenvalues intro');
});

// ------------------------------------------------------------- the decision

const made = (over: Partial<ProspectProposal> = {}): ProspectProposal => ({
  id: 'p1', subject: 'A worked example', reason: 'a reason',
  evidenceKey: 'statement:s1', evidenceKind: 'shaky-statement',
  evidenceDetail: 'the gap behind statement:s1', evidenceUnconfirmed: true, lead: null,
  state: 'pending', raisedAt: NOW, batchKey: '2026-08-29', decidedAt: null,
  ...over,
});

test('a decision is made once and is stamped when it is made', () => {
  const kept = decideProspectProposal(made(), 'accepted', NOW);
  assert.equal(kept.state, 'accepted');
  assert.equal(kept.decidedAt, NOW);
  assert.throws(() => decideProspectProposal(kept, 'dismissed', NOW), ProspectStateError);
  assert.throws(() => decideProspectProposal(made(), 'pending', NOW), ProspectStateError);
});

test('a review surface is shown what is still waiting, newest night first', () => {
  const all = [
    made({ id: 'a', raisedAt: '2026-08-27T03:00:00.000Z' }),
    made({ id: 'b', raisedAt: '2026-08-29T03:00:00.000Z', subject: 'Zebra' }),
    made({ id: 'c', raisedAt: '2026-08-29T03:00:00.000Z', subject: 'Apple' }),
    made({ id: 'd', state: 'dismissed' }),
  ];
  assert.deepEqual(pendingProspectProposals(all).map((p) => p.id), ['c', 'b', 'a']);
  assert.equal(orderProspectProposals(all).length, 4, 'ordering keeps everything; the filter is separate');
});

// ------------------------------------------------------------- the agent

interface Scripted { readonly requests: LlmRequest[]; readonly llm: Llm }

const scripted = (answers: readonly unknown[]): Scripted => {
  const requests: LlmRequest[] = [];
  return {
    requests,
    llm: {
      complete: async () => { throw new Error('the night scout asks for JSON'); },
      structured: async <T,>(req: LlmRequest): Promise<LlmResult<T>> => {
        const answer = answers[requests.length];
        requests.push(req);
        if (answer instanceof Error) throw answer;
        return { value: answer as T, modelId: 'stub', inputTokens: 0, outputTokens: 0 };
      },
    },
  };
};

const GAPS: readonly ProspectEvidence[] = [
  evidence('statement:s1'), { ...evidence('finding:g1'), kind: 'check-finding' },
];

const run = (llm: Llm) => prospect(deps(llm), {
  gaps: GAPS, now: NOW, batchKey: '2026-08-29', id: (() => { let n = 0; return () => `p${++n}`; })(),
});

test('no gaps means no model call, and that is an answer rather than a failure', async () => {
  const s = scripted([]);
  const out = await prospect(deps(s.llm), {
    gaps: [], now: NOW, batchKey: '2026-08-29', id: () => 'p1',
  });
  assert.equal(out.outcome, 'nothing-proposed');
  assert.equal(out.calls, 0);
  assert.equal(s.requests.length, 0, 'nothing was bought to be told there is nothing to say');
});

test('a proposal citing an id nobody gave it is dropped, and the stage says so', async () => {
  const s = scripted([{ proposals: [
    { evidenceId: 'e9', subject: 'A book somebody once liked', reason: 'a reason' },
  ] }]);
  const out = await run(s.llm);
  assert.equal(out.outcome, 'nothing-proposed');
  assert.deepEqual(out.proposals, []);
  assert.equal(out.refused.invented, 1);
  assert.equal(out.calls, 1, 'and the second call is not bought for an empty list');
});

test('the whole path: gaps in, a proposal out, with a lead and its evidence', async () => {
  const s = scripted([
    { proposals: [{
      evidenceId: 'e1', subject: 'A worked example of the mechanism',
      reason: 'Your own read on this topic is not settled by the evidence behind it.',
    }] },
    { leads: [{ proposal: 'n1', phrase: 'worked example mechanism', url: 'https://example.test/a' }] },
  ]);
  const out = await run(s.llm);
  assert.equal(out.outcome, 'proposed');
  assert.equal(out.calls, PROSPECT_MAX_MODEL_CALLS);
  assert.equal(out.leads, 'named');
  const [proposal] = out.proposals;
  assert.equal(proposal?.evidenceKey, 'statement:s1', 'the model chose the gap; the code named it');
  assert.equal(proposal?.evidenceDetail, 'the gap behind statement:s1');
  assert.equal(proposal?.lead?.url, 'https://example.test/a');
  assert.equal(proposal?.lead?.unread, true);
  assert.equal(proposal?.state, 'pending');
  assert.equal(proposal?.batchKey, '2026-08-29');
  for (const req of s.requests) {
    assert.equal(req.reasoning, 'on', 'a background stage thinks; latency is free at three in the morning');
    assert.equal(req.tier, 'deep');
  }
  assert.match(s.requests[0]?.prompt ?? '', /<pinned-material>/, 'the board’s own words are fenced');
});

test('a night never buys more than the two calls it is allowed', async () => {
  const s = scripted([
    { proposals: Array.from({ length: 6 }, (_, i) => ({
      evidenceId: i % 2 === 0 ? 'e1' : 'e2', subject: `Subject ${i}`, reason: 'a reason',
    })) },
    { leads: [] },
  ]);
  const out = await run(s.llm);
  assert.equal(s.requests.length, PROSPECT_MAX_MODEL_CALLS);
  assert.equal(out.proposals.length, 2, 'two gaps were offered, so two proposals is the ceiling here');
  assert.equal(out.refused.duplicate, 4);
});

test('a failed first call proposes nothing and loses nothing', async () => {
  const s = scripted([new Error('the provider is down')]);
  const out = await run(s.llm);
  assert.equal(out.outcome, 'model-failed');
  assert.deepEqual(out.proposals, []);
  assert.equal(out.calls, 1);
});

test('a reply that is not a list of proposals is a failure, not an empty night', async () => {
  const out = await run(scripted([{ nothing: true }]).llm);
  assert.equal(out.outcome, 'model-failed', 'a lax adapter must not read as "nothing to propose"');
});

test('a failed second call leaves the proposals standing without their leads', async () => {
  const s = scripted([
    { proposals: [{ evidenceId: 'e1', subject: 'A worked example', reason: 'a reason' }] },
    new Error('the provider is down'),
  ]);
  const out = await run(s.llm);
  assert.equal(out.outcome, 'proposed');
  assert.equal(out.leads, 'model-failed');
  assert.equal(out.proposals.length, 1);
  assert.equal(out.proposals[0]?.lead, null, 'a proposal with no lead is still a proposal');
});

test('a lead answered about a proposal nobody asked about is ignored', async () => {
  const s = scripted([
    { proposals: [{ evidenceId: 'e1', subject: 'A worked example', reason: 'a reason' }] },
    { leads: [{ proposal: 'n7', phrase: 'somewhere else entirely', url: null }] },
  ]);
  const out = await run(s.llm);
  assert.equal(out.proposals[0]?.lead, null);
});
