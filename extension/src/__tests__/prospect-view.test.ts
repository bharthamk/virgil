import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installPanelDom, click, find, text, type El } from './panel-dom.js';
import {
  prospectBlock, prospectSection, prospectSettingRow, prospectKeptLine,
  statementsCitedByProposals,
  PROSPECT_DISMISSED_LINE, PROSPECT_FAILED_LINE, PROSPECT_HEADING, PROSPECT_INTRO,
  PROSPECT_KEEP_LABEL, PROSPECT_DISMISS_LABEL, PROSPECT_KIND_LINES,
  PROSPECT_SETTING_LABEL, PROSPECT_UNCONFIRMED_LINE, PROSPECT_UNREAD_LINE,
  type ProspectProposalView,
} from '../prospect.js';

/**
 * THE ONE SCREEN THAT SHOWS SOMEBODY SOMETHING THEY NEVER SAVED.
 *
 * So the assertions are about the three sentences that make that honest rather
 * than about the layout: the evidence is on screen beside the reason, the
 * address says it has not been opened, and pressing either button replaces it
 * with a sentence saying exactly what was written.
 */

const proposal = (over: Partial<ProspectProposalView> = {}): ProspectProposalView => ({
  id: 'pr1',
  subject: 'An introduction to eigenvalues',
  reason: 'Two of your sources assume it and nothing on your board covers it.',
  evidenceKind: 'prerequisite-hole',
  evidenceDetail: '2 of your sources assume you already know: eigenvalues',
  lead: { phrase: 'introduction to eigenvalues', url: 'https://example.test/eigen' },
  ...over,
});

function block(
  t: { after: (f: () => void) => void },
  view = proposal(),
  decide: (id: string, state: string) => Promise<boolean> = async () => true,
): El {
  const dom = installPanelDom();
  t.after(() => { dom.uninstall(); });
  return prospectBlock(view, decide as never) as unknown as El;
}

test('a proposal is drawn under the evidence that produced it', (t) => {
  const node = block(t);
  assert.equal(text(find(node, 'h3')), 'An introduction to eigenvalues');
  assert.equal(text(find(node, '.reason')),
    'Two of your sources assume it and nothing on your board covers it.');
  assert.equal(text(find(node, '.evidence .detail')),
    '2 of your sources assume you already know: eigenvalues');
  assert.match(text(find(node, '.evidence .label')),
    new RegExp(PROSPECT_KIND_LINES['prerequisite-hole'] as string),
    'the row says which kind of gap this came from, in the learner’s terms');
  assert.equal(node.dataset['prospect'], 'pr1');
});

test('every gap kind names its origin in the learner’s terms', () => {
  // The fallback 'your board' exists for a version-skewed service, not for a
  // kind this build ships. A kind missing here reaches the learner as a shrug.
  const shipped = [
    'check-finding', 'shaky-statement', 'prerequisite-hole', 'avoided-topic',
    'slipping-item', 'shortfall-read',
  ];
  for (const kind of shipped) {
    assert.equal(typeof PROSPECT_KIND_LINES[kind], 'string', `${kind} has a line`);
  }
});

/**
 *. The scout may now stand a proposal on a sentence Virgil wrote about
 * the learner and the learner has never answered. A reason built on one reads
 * exactly like a reason built on a check that actually failed, so the
 * difference is a sentence on the card rather than a tone in the reason, and it
 * sits above the evidence line because it qualifies the reason, not the record.
 */
test('a proposal built on an unanswered read says so, under the reason it qualifies', (t) => {
  const node = block(t, proposal({
    evidenceKind: 'shortfall-read',
    evidenceDetail: 'Written on your board: You have not yet built the listening skill.',
    evidenceUnconfirmed: true,
  }));
  assert.equal(text(find(node, '.unconfirmed')), PROSPECT_UNCONFIRMED_LINE);
  assert.match(PROSPECT_UNCONFIRMED_LINE, /my read/);
  assert.match(PROSPECT_UNCONFIRMED_LINE, /not on your words/,
    'the panel already badges every insight `my read` or `your words`, and this is the same fact');
  const order = [...node.children].map((child) => child.className);
  assert.ok(order.indexOf('unconfirmed') > order.indexOf('reason'));
  assert.ok(order.indexOf('unconfirmed') < order.indexOf('evidence'));
  assert.match(text(find(node, '.evidence .label')),
    new RegExp(PROSPECT_KIND_LINES['shortfall-read'] as string));
});

test('a proposal standing on a record carries no hedge about it', (t) => {
  // A check that failed and a concept two sources assumed are things that
  // happened. Hedging them would be the product doubting its own ledger.
  assert.equal(block(t).querySelector('.unconfirmed'), null);
  assert.equal(block(t, proposal({ evidenceUnconfirmed: false })).querySelector('.unconfirmed'), null,
    'and a proposal raised before the field existed reads as no caveat rather than as one');
});

test('an address is shown as a lead and says it has not been opened', (t) => {
  const node = block(t);
  assert.equal(text(find(node, '.lead .unread')), PROSPECT_UNREAD_LINE);
  assert.match(text(find(node, '.lead .phrase')), /introduction to eigenvalues/);
  assert.match(text(find(node, '.lead .phrase')), /https:\/\/example\.test\/eigen/);
});

test('a lead with a phrase and no address carries no unread warning to give', (t) => {
  const node = block(t, proposal({ lead: { phrase: 'introduction to eigenvalues', url: null } }));
  assert.equal(text(find(node, '.lead .unread')), '');
  assert.match(text(find(node, '.lead .phrase')), /introduction to eigenvalues/);
});

test('a proposal with no lead at all draws no lead block', (t) => {
  const node = block(t, proposal({ lead: null }));
  assert.equal(node.querySelector('.lead'), null,
    'an empty "where to look" under a proposal with nowhere to point is worse than none');
});

test('keeping one says what was saved and what was not', async (t) => {
  const answered: string[] = [];
  const node = block(t, proposal(), async (id, state) => { answered.push(`${id}:${state}`); return true; });
  await click(find(node, '[data-keep]'));
  assert.deepEqual(answered, ['pr1:accepted']);
  assert.equal(text(find(node, '.note')), prospectKeptLine(true));
  assert.match(text(find(node, '.note')), /before your next session/,
    'the product never promises an hour it does not control');
  assert.equal(node.querySelector('.row'), null,
    'and the buttons are gone, because the answer has been given');
});

test('keeping one with nothing to save says that instead', async (t) => {
  const node = block(t, proposal({ lead: null }));
  await click(find(node, '[data-keep]'));
  assert.equal(text(find(node, '.note')), prospectKeptLine(false));
  assert.match(text(find(node, '.note')), /Nothing has been added/);
});

test('leaving one out is an answer, and it says the answer sticks', async (t) => {
  const answered: string[] = [];
  const node = block(t, proposal(), async (id, state) => { answered.push(state); return true; });
  assert.equal(text(find(node, '[data-dismiss]')), PROSPECT_DISMISS_LABEL);
  await click(find(node, '[data-dismiss]'));
  assert.deepEqual(answered, ['dismissed']);
  assert.equal(text(find(node, '.note')), PROSPECT_DISMISSED_LINE);
});

test('an answer that did not land leaves the proposal exactly where it was', async (t) => {
  const node = block(t, proposal(), async () => false);
  await click(find(node, '[data-keep]'));
  assert.equal(text(find(node, '.note')), PROSPECT_FAILED_LINE);
  assert.equal((find(node, '[data-keep]') as unknown as { disabled: boolean }).disabled, false,
    'the control comes back rather than the card vanishing on a request that failed');
  assert.ok(node.querySelector('.row'), 'and the card is still asking the question');
});

test('the section says where these came from before it says what they are', (t) => {
  const dom = installPanelDom();
  t.after(() => { dom.uninstall(); });
  const node = prospectSection([proposal(), proposal({ id: 'pr2' })], async () => true) as unknown as El;
  assert.equal(text(find(node, 'h2')), PROSPECT_HEADING);
  assert.equal(text(find(node, '.setting-explain')), PROSPECT_INTRO);
  assert.match(PROSPECT_INTRO, /You decide/);
  assert.equal(text(find(node, 'summary')), 'Review 2 suggestions');
  assert.equal(find(node, 'details').getAttribute('open'), null,
    'suggestions eclipse the learner\'s actual studies before they choose to review them');
  assert.equal(node.querySelectorAll('.prospect').length, 2);
  assert.equal(text(find(node, '.prospect [data-keep]')), PROSPECT_KEEP_LABEL);
});

test('the switch shows the state it is in and puts a failed write back', async (t) => {
  const dom = installPanelDom();
  t.after(() => { dom.uninstall(); });
  const asked: boolean[] = [];
  const row = prospectSettingRow(true, async (next) => { asked.push(next); return false; }) as unknown as El;
  assert.equal(text(find(row, 'label span')), PROSPECT_SETTING_LABEL);
  const box = find(row, 'input') as unknown as { checked: boolean };
  assert.equal(box.checked, true, 'absent or on reads as on');
  box.checked = false;
  await (box as unknown as El).fireEvent('change');
  assert.deepEqual(asked, [false]);
  assert.equal(box.checked, true, 'a write that failed does not leave the screen claiming it worked');
});

/**
 * WHICH SENTENCE A PROPOSAL STANDS ON, WHERE IT STANDS ON ONE AT ALL.
 *
 * The scout's evidence keys are the code's own, never shown to anybody, and
 * exactly two of the six kinds name a statement: the comfort-gated read and the
 * shortfall the board wrote about somebody. Everything else names a signal, a
 * topic or a concept, and reading a statement id out of one of those would be
 * inventing a link the record does not hold.
 */
test('only the two statement-shaped kinds report a sentence behind them', () => {
  const cited = statementsCitedByProposals([
    proposal({ id: 'p1', evidenceKind: 'shaky-statement', evidenceKey: 'statement:st-1' }),
    proposal({ id: 'p2', evidenceKind: 'shortfall-read', evidenceKey: 'read:st-2' }),
    proposal({ id: 'p3', evidenceKind: 'avoided-topic', evidenceKey: 'avoided:t-9' }),
    proposal({ id: 'p4', evidenceKind: 'check-finding', evidenceKey: 'finding:sig-3' }),
    proposal({ id: 'p5', evidenceKind: 'prerequisite-hole', evidenceKey: 'prerequisite:eigenvalues' }),
    proposal({ id: 'p6', evidenceKind: 'slipping-item', evidenceKey: 'slipping:commitment:c-1' }),
  ]);
  assert.deepEqual([...cited].sort(), ['st-1', 'st-2']);
});

test('a proposal from a service too old to send its evidence key names nothing', () => {
  assert.deepEqual([...statementsCitedByProposals([proposal({ id: 'p1' })])], [],
    'a proposal with no key on it cannot be traced back, and a guess would be a false receipt');
});
