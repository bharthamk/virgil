import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installPanelDom, click, find, text, type El } from './panel-dom.js';
import {
  groupStatements, insightSectionCount, insightSections, insightSectionsOf, modalityQuestion, pulseSection,
  sectionOf, slippingRow, slippingSection, statementConsequence, subjectRegister,
  GENERAL_GROUP_LABEL, INSIGHT_SECTION_HEADINGS, INSIGHT_SECTION_ORDER,
  STATEMENT_BEHIND_SUGGESTION_ACTION, STATEMENT_BEHIND_SUGGESTION_LINE,
  MODALITY_BADGE, MODALITY_CONFIRM_LABEL, MODALITY_CONFIRMED, MODALITY_DENIED,
  MODALITY_DENIED_DAYS, MODALITY_DENY_LABEL, MODALITY_FAILED, MODALITY_NOTE,
  PULSE_HEADING, SLIPPING_HEADING, SLIPPING_SET_ASIDE_DONE, SLIPPING_SET_ASIDE_FAILED,
  SLIPPING_SET_ASIDE_LABEL,
  type InsightSectionKey, type InsightStatementView, type ModalityStatementView,
  type SlippingRowView,
} from '../insights.js';

/**
 * THE ONE BLOCK IN THIS PRODUCT THAT SAYS SOMETHING ABOUT A LEARNER'S WEEK.
 *
 * So the assertions are about the four claims on it rather than about layout:
 * the numbers the service wrote are the numbers on screen; the ledger's line
 * appears only when the ledger has one; the control writes the learner's own
 * decision and says what it did; and a board with nothing slipping draws
 * nothing at all rather than a compliment.
 */

const row = (over: Partial<SlippingRowView> = {}): SlippingRowView => ({
  key: 'commitment:late-1',
  title: 'Stats problem set 3',
  standingLine: 'Past its date, and you have not touched it for 12 days.',
  elsewhereLine: 'In that time you finished 9 other things on your board.',
  activationLine: '1 minute of it counts.',
  passedOverLine: null,
  ...over,
});

function mounted(t: { after: (f: () => void) => void }): void {
  const dom = installPanelDom();
  t.after(() => { dom.uninstall(); });
}

test('a row is the item, its standing, the contrast, and the smallest way in', (t) => {
  mounted(t);
  const node = slippingRow(row(), async () => true) as unknown as El;
  assert.equal(text(find(node, 'h3')), 'Stats problem set 3');
  assert.equal(text(find(node, '.standing')),
    'Past its date, and you have not touched it for 12 days.');
  assert.equal(text(find(node, '.elsewhere')),
    'In that time you finished 9 other things on your board.');
  assert.equal(text(find(node, '.activation')), '1 minute of it counts.');
  assert.equal(node.dataset['slipping'], 'commitment:late-1');
  assert.equal(node.querySelector('.passed-over'), null,
    'no ledger line without a ledger behind it');
});

test('the ledger line renders only when it is given, and it carries its own start date', (t) => {
  mounted(t);
  const node = slippingRow(
    row({ passedOverLine: 'Offered and passed over 3 times since 14 August 2026.' }),
    async () => true,
  ) as unknown as El;
  assert.equal(text(find(node, '.passed-over')),
    'Offered and passed over 3 times since 14 August 2026.');
  assert.match(text(find(node, '.passed-over')), /since /,
    'a count with no start date would read as a count over all time');
});

test('setting one aside writes the learner’s own decision and says what it did', async (t) => {
  mounted(t);
  const written: string[] = [];
  const node = slippingRow(row(), async (key) => { written.push(key); return true; }) as unknown as El;
  assert.equal(text(find(node, '[data-set-aside]')), SLIPPING_SET_ASIDE_LABEL);
  assert.equal(find(node, '[data-set-aside]').getAttribute('aria-label'),
    'Setting this aside on purpose: Stats problem set 3');
  await click(find(node, '[data-set-aside]'));
  assert.deepEqual(written, ['commitment:late-1']);
  assert.equal(text(find(node, '.note')), SLIPPING_SET_ASIDE_DONE);
  assert.match(SLIPPING_SET_ASIDE_DONE, /Today/,
    'the row says the ranker honours it too, because it does');
  assert.equal(node.querySelector('.row'), null,
    'the answer has been given, so the control goes rather than sitting there greyed out');
});

test('a decision that did not land leaves the row exactly where it was', async (t) => {
  mounted(t);
  const node = slippingRow(row(), async () => false) as unknown as El;
  await click(find(node, '[data-set-aside]'));
  assert.equal(text(find(node, '.note')), SLIPPING_SET_ASIDE_FAILED);
  assert.equal((find(node, '[data-set-aside]') as unknown as { disabled: boolean }).disabled, false);
  assert.ok(node.querySelector('.row'), 'and the control is still there to press again');
});

test('the section is the heading and its rows, and nothing at all when there are none', (t) => {
  mounted(t);
  const node = slippingSection([row(), row({ key: 'material:m1' })], async () => true) as unknown as El;
  assert.equal(text(find(node, 'h2')), SLIPPING_HEADING);
  assert.equal(node.querySelectorAll('.slipping').length, 2);
  assert.equal(slippingSection([], async () => true), null,
    'an empty board draws no block: praise for the absence of a problem is an invented award');
});

test('the studies pulse still draws its three facts and opens the course it names', async (t) => {
  mounted(t);
  const opened: string[] = [];
  const node = pulseSection([{
    courseId: 'systems', title: 'Systems Design', state: 'attention',
    stateLabel: 'Needs attention', materialLine: '0 of 1 material covered.',
    workLine: 'CAP exercise is due today.', resultLine: 'Latest result: Design review.',
  }], (courseId) => opened.push(courseId)) as unknown as El;
  assert.equal(text(find(node, 'h2')), PULSE_HEADING);
  assert.equal(find(node, '.pulse-course').dataset['state'], 'attention');
  assert.deepEqual(find(node, '.pulse-facts').querySelectorAll('p').map((line) => text(line)), [
    'CAP exercise is due today.',
    '0 of 1 material covered.',
    'Latest result: Design review.',
  ]);
  await click(find(node, 'button'));
  assert.deepEqual(opened, ['systems']);
});

// ------------------------------------------------- the one question about you

/**
 * SB-282. PRODUCT_SHAPE.md allows modality profiling to exist in exactly one
 * form: a learner-confirmed statement with its evidence shown. The assertions
 * below are that form, held in place on the screen where it is read.
 */
const QUESTION_TEXT =
  'Recent checks suggest notation heavy material goes less smoothly for you than'
  + ' logic and structure work: 1 of 5 checks went well on notation heavy material,'
  + ' against 5 of 6 on logic and structure work. Does that match how it feels?';

const question = (over: Partial<ModalityStatementView> = {}): ModalityStatementView => ({
  id: 'mod-1',
  text: QUESTION_TEXT,
  userEdited: false,
  evidenceReceipt: 'complete',
  evidence: [{ type: 'answer-wrong', topic: 'Laplace transforms', active: true }],
  modality: { key: 'notation-heavy|logic-structure', confirmed: false },
  ...over,
});

test('the card is a question, its numbers, its evidence, and two answers', (t) => {
  mounted(t);
  const node = modalityQuestion(question(), async () => true) as unknown as El;
  assert.equal(text(find(node, '.text')), QUESTION_TEXT);
  assert.match(QUESTION_TEXT, /\?$/, 'nothing on this screen states it as a fact about them');
  assert.match(QUESTION_TEXT, /1 of 5 .* 5 of 6/, 'the evidence is the counts in the sentence');
  assert.equal(text(find(node, '.state')), MODALITY_BADGE);
  assert.equal(MODALITY_BADGE, 'a question, not a read',
    'the badge slot says my read or your words everywhere else, and this is neither yet');
  assert.equal(text(find(node, '.meta')), MODALITY_NOTE);
  assert.match(MODALITY_NOTE, /changes nothing about what I offer you/,
    'this slice has no selection effect, and the card says so rather than implying one');
  assert.equal(text(find(node, '.statement-evidence li')),
    'Laplace transforms: answers I marked wrong');
  assert.equal(node.dataset['modality'], 'notation-heavy|logic-structure');
  assert.equal(text(find(node, '[data-confirm]')), MODALITY_CONFIRM_LABEL);
  assert.equal(text(find(node, '[data-deny]')), MODALITY_DENY_LABEL);
  // Both controls carry the same short visible words on every card, so the
  // accessible name is qualified by the sentence they belong to, exactly as
  // the ordinary statement row's Correct it and Reject it are.
  for (const [control, label] of [
    ['[data-confirm]', MODALITY_CONFIRM_LABEL], ['[data-deny]', MODALITY_DENY_LABEL],
  ] as const) {
    const spoken = find(node, control).getAttribute('aria-label') ?? '';
    assert.ok(spoken.startsWith(`${label}: `), `${control} is not named aloud by its row`);
    assert.ok(spoken.length > label.length + 2 && QUESTION_TEXT.startsWith(spoken.slice(label.length + 2, spoken.length - 1)),
      'and the name it is given is the question it sits under');
  }
});

test('yes and no each reach the service once, and say what they did', async (t) => {
  mounted(t);
  const answers: (readonly [string, boolean])[] = [];
  const yes = modalityQuestion(question(), async (id, confirmed) => {
    answers.push([id, confirmed]);
    return true;
  }) as unknown as El;
  await click(find(yes, '[data-confirm]'));
  assert.deepEqual(answers, [['mod-1', true]]);
  assert.equal(text(find(yes, '.note')), MODALITY_CONFIRMED);
  assert.equal(yes.querySelector('.repair'), null, 'the answer is given, so the controls go');

  const no = modalityQuestion(question(), async (id, confirmed) => {
    answers.push([id, confirmed]);
    return true;
  }) as unknown as El;
  await click(find(no, '[data-deny]'));
  assert.deepEqual(answers[1], ['mod-1', false]);
  assert.equal(text(find(no, '.note')), MODALITY_DENIED);
  assert.match(MODALITY_DENIED, new RegExp(`${MODALITY_DENIED_DAYS} days`),
    'a no that did not say how long it lasted would be a card being hidden, not an answer being taken');
});

test('an answer that did not land leaves the question exactly where it was', async (t) => {
  mounted(t);
  const node = modalityQuestion(question(), async () => false) as unknown as El;
  await click(find(node, '[data-deny]'));
  assert.equal(text(find(node, '.note')), MODALITY_FAILED);
  assert.ok(node.querySelector('.repair'),
    'telling somebody they answered a question about themselves when it did not land is worse than asking twice');
  assert.equal((find(node, '[data-confirm]') as unknown as { disabled: boolean }).disabled, false);
});

// ------------------------------------------------ what the sentences are about

/**
 * THE GROUPING, AS ARITHMETIC RATHER THAN AS LAYOUT.
 *
 * Two rules, and both of them are claims about meaning rather than about
 * spacing. Stored order survives inside a group, because the night writes
 * chains and a sentence can refer to the one before it. And a board with one
 * group has no label drawn over it, which is the same answer a service too old
 * to say what anything is about gets: nothing invented, nothing implied.
 */
const read = (id: string, over: Partial<InsightStatementView> = {}): InsightStatementView => ({
  id, text: `read ${id}`, userEdited: false, ...over,
});

test('statements cluster by their subject, and stored order survives inside a group', () => {
  const grouped = groupStatements([
    read('a1', { subject: { courseId: 'systems', title: 'Systems Design' }, topicLabel: 'CAP theorem' }),
    read('b1', { topicLabel: 'Bayes rule' }),
    read('a2', { subject: { courseId: 'systems', title: 'Systems Design' }, topicLabel: 'Quorums' }),
    read('c1'),
  ]);
  assert.deepEqual(grouped.map((group) => [group.label, group.statements.map((s) => s.id)]), [
    ['Systems Design', ['a1', 'a2']],
    ['Bayes rule', ['b1']],
    [null, ['c1']],
  ]);
});

test('the course outranks the topic, exactly as it does over a lesson', () => {
  const grouped = groupStatements([
    read('a', { subject: { courseId: 'systems', title: 'Systems Design' }, topicLabel: 'CAP theorem' }),
    read('b', { subject: { courseId: 'systems', title: 'Systems Design' }, topicLabel: 'Quorums' }),
  ]);
  assert.deepEqual(grouped.map((group) => group.label), ['Systems Design'],
    'two topics of one course are one subject, which is what the lesson page says too');
});

const nodeFor = (statement: InsightStatementView): HTMLElement => {
  const node = document.createElement('div');
  node.className = 'statement';
  node.setAttribute('data-statement', statement.id);
  node.textContent = statement.text;
  return node;
};

// ------------------------------------------------- the room, in five sections


const wide = (): { open: () => boolean; toggled: () => void } =>
  ({ open: () => true, toggled: () => {} });

const shut = new Set<InsightSectionKey>();
const memory = {
  open: (key: InsightSectionKey): boolean => !shut.has(key),
  toggled: (key: InsightSectionKey, open: boolean): void => {
    if (open) shut.delete(key); else shut.add(key);
  },
};

test('each row lands in the section its own stored fields put it in', () => {
  assert.equal(sectionOf(read('q', { modality: { key: 'notation-heavy', confirmed: false } })),
    'questions');
  assert.equal(sectionOf(read('mine', { userEdited: true })), 'told');
  assert.equal(sectionOf(read('agreed', { confirmed: true })), 'confirmed');
  assert.equal(sectionOf(read('loose')), 'patterns');
  assert.equal(sectionOf(read('scoped', { topicLabel: 'Bayes rule' })), 'subjects');
});

test('authority outranks subject, which is why confirming a read moves it', () => {
  const scoped = { topicId: 't-bayes', topicLabel: 'Bayes rule' };
  assert.equal(sectionOf(read('r', scoped)), 'subjects');
  assert.equal(sectionOf(read('r', { ...scoped, confirmed: true })), 'confirmed',
    'a read they have agreed with is one of the things they confirmed, wherever it is about');
  assert.equal(sectionOf(read('r', { ...scoped, userEdited: true })), 'told');
  assert.equal(sectionOf(read('r', { ...scoped, modality: { key: 'k', confirmed: false } })),
    'questions');
});

test('a service too old to say what a sentence is about sends it to Patterns', () => {
  assert.equal(sectionOf(read('old', { topicId: 't-1' })), 'patterns',
    'a subject heading this build cannot write is a heading with nothing on it');
  assert.equal(sectionOf(read('old', { topicId: 't-1', subject: { courseId: 'c', title: 'Systems Design' } })),
    'subjects');
});

test('the sections keep one order, and an empty one is not drawn at all', () => {
  assert.deepEqual([...INSIGHT_SECTION_ORDER],
    ['questions', 'told', 'confirmed', 'patterns', 'subjects']);
  assert.deepEqual(INSIGHT_SECTION_ORDER.map((key) => INSIGHT_SECTION_HEADINGS[key]), [
    'Questions for you', 'Things you told me', 'Things you confirmed',
    "Patterns I'm seeing", 'Where each subject stands',
  ]);
  const drawn = insightSectionsOf([
    read('scoped', { topicLabel: 'Bayes rule' }),
    read('mine', { userEdited: true }),
    read('loose'),
  ]);
  assert.deepEqual(drawn.map((section) => section.key), ['told', 'patterns', 'subjects'],
    'an empty drawer called Things you confirmed tells somebody what they have not done');
});

test('section counts say which rows are waiting on the learner', () => {
  assert.equal(insightSectionCount('questions', 2), '2 to answer');
  assert.equal(insightSectionCount('told', 3), '3 from you');
  assert.equal(insightSectionCount('confirmed', 1), '1 confirmed');
  assert.equal(insightSectionCount('patterns', 4), '4 to review');
  assert.equal(insightSectionCount('subjects', 5), '5 to review');
});

test('the questions section exists only while a question is waiting', () => {
  const pending = read('q', { modality: { key: 'notation-heavy', confirmed: false } });
  const answered = read('q', { modality: { key: 'notation-heavy', confirmed: true } });
  assert.deepEqual(insightSectionsOf([pending]).map((s) => s.key), ['questions']);
  assert.deepEqual(insightSectionsOf([answered]).map((s) => s.key), ['patterns'],
    'an answered question is an ordinary read and stops asking anything');
});

test('stored order survives inside a section', () => {
  const drawn = insightSectionsOf([read('a'), read('b'), read('c')]);
  assert.deepEqual(drawn[0]?.statements.map((s) => s.id), ['a', 'b', 'c']);
});

test('a section is a heading, a control that says which way it is, and its rows', (t) => {
  mounted(t);
  const [section] = insightSections(
    [read('a', { topicLabel: 'Bayes rule' })], nodeFor, wide(),
  ) as unknown as El[];
  assert.equal(section!.dataset['section'], 'subjects');
  assert.equal(text(find(section!, '.section-toggle .name')), 'Where each subject stands');
  assert.equal(text(find(section!, '.section-toggle .count')), '1 to review');
  assert.equal(find(section!, '.section-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(find(section!, '.section-toggle').getAttribute('aria-controls'),
    'insight-rows-subjects');
  assert.equal(find(section!, '.rows').getAttribute('id'), 'insight-rows-subjects');
  assert.equal(find(section!, '.rows').getAttribute('hidden'), null);
  // The heading is still a heading: the control is inside it, not instead of it.
  assert.equal(find(section!, '.head h2').tagName, 'H2');
});

test('shutting a drawer is remembered for the visit and reopening it forgets', async (t) => {
  mounted(t);
  shut.clear();
  const drawn = () => insightSections([read('a')], nodeFor, memory) as unknown as El[];
  await click(find(drawn()[0]!, '.section-toggle'));
  assert.deepEqual([...shut], ['patterns']);
  const again = drawn()[0]!;
  assert.equal(find(again, '.section-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(find(again, '.rows').getAttribute('hidden'), '',
    'a shut drawer really is shut, rather than open with a chevron pointing the wrong way');
  await click(find(again, '.section-toggle'));
  assert.deepEqual([...shut], []);
  shut.clear();
});

test('the rows sit in a bed the stylesheet can put two columns on', (t) => {
  mounted(t);
  const [section] = insightSections([read('a'), read('b')], nodeFor, wide()) as unknown as El[];
  const grid = find(section!, '.statement-grid');
  assert.deepEqual(grid.querySelectorAll('.statement').map((row) => text(row)),
    ['read a', 'read b']);
});

// ---------------------------------------------------- where each subject stands

/**
 * THE REGISTER CHIP, AND WHY A SUBJECT CAN WEAR NONE.
 *
 * The word is the board's own read of the topic, sent by the service from the
 * same arithmetic the lineup chip is drawn from. A subject can hold several
 * topics, and two topics standing in different places is not one place: the
 * chip is drawn only where the registers under it agree, because picking one of
 * them would be this screen inventing a summary of somebody's standing.
 */
test('a subject wears the register word its topics agree on', (t) => {
  mounted(t);
  const [section] = insightSections([
    read('a', { subject: { courseId: 'systems', title: 'Systems Design' }, register: 'building' }),
    read('b', { subject: { courseId: 'systems', title: 'Systems Design' }, register: 'building' }),
    read('c', { topicLabel: 'Bayes rule', register: 'from-nothing' }),
  ], nodeFor, wide()) as unknown as El[];
  assert.deepEqual(section!.querySelectorAll('.alt-label .name').map((n) => text(n)),
    ['Systems Design', 'Bayes rule']);
  assert.deepEqual(section!.querySelectorAll('.alt-label .register').map((chip) => [
    chip.dataset['register'], text(chip),
  ]), [['building', 'building'], ['from-nothing', 'new to you']]);
});

test('two topics standing in different places make one subject with no chip', () => {
  assert.equal(subjectRegister([
    read('a', { register: 'building' }), read('b', { register: 'fluent' }),
  ]), null);
  assert.equal(subjectRegister([read('a'), read('b')]), null,
    'a service too old to send the register draws no chip rather than a guessed one');
  assert.equal(subjectRegister([read('a', { register: 'from-nothing' }), read('b')]),
    'from-nothing');
  assert.equal(subjectRegister([read('a', { register: 'settled' })]), null,
    'a machine name this build does not know is never printed as a word about somebody');
});

// ------------------------------------------------------------ sub-categories


test('rows carrying a modality mark are gathered under How you learn', (t) => {
  mounted(t);
  const [section] = insightSections([
    read('plain', { confirmed: true }),
    read('marked', { confirmed: true, modality: { key: 'notation-heavy', confirmed: true } }),
  ], nodeFor, wide()) as unknown as El[];
  assert.equal(section!.dataset['section'], 'confirmed');
  assert.deepEqual(section!.querySelectorAll('.alt-label .name').map((n) => text(n)),
    [GENERAL_GROUP_LABEL]);
  assert.equal(GENERAL_GROUP_LABEL, 'How you learn');
  assert.deepEqual(section!.querySelectorAll('.statement-grid').map(
    (grid) => grid.querySelectorAll('.statement').map((row) => text(row)),
  ), [['read plain'], ['read marked']]);
});

test('a label over everything separates nothing, so it is not drawn', (t) => {
  mounted(t);
  const all = insightSections([
    read('a', { confirmed: true, modality: { key: 'k', confirmed: true } }),
    read('b', { confirmed: true, modality: { key: 'k', confirmed: true } }),
  ], nodeFor, wide()) as unknown as El[];
  assert.equal(all[0]!.querySelectorAll('.alt-label').length, 0);
  const none = insightSections(
    [read('a', { confirmed: true }), read('b', { confirmed: true })], nodeFor, wide(),
  ) as unknown as El[];
  assert.equal(none[0]!.querySelectorAll('.alt-label').length, 0);
});

test('the consequence line says what is waiting and opens the room it waits in', async (t) => {
  mounted(t);
  let opened = 0;
  const node = statementConsequence(() => { opened += 1; }) as unknown as El;
  assert.equal(text(find(node, '.meta')), STATEMENT_BEHIND_SUGGESTION_LINE);
  assert.equal(STATEMENT_BEHIND_SUGGESTION_LINE,
    'This is behind a suggestion waiting in My studies.');
  await click(find(node, 'button'));
  assert.equal(text(find(node, 'button')), STATEMENT_BEHIND_SUGGESTION_ACTION);
  assert.equal(opened, 1);
});
