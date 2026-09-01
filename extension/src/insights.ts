/**
 * INSIGHTS — the two blocks on it that are arithmetic rather than prose.
 *
 * The room behind the Insights door is mostly the learner model: sentences a
 * machine wrote about a person, which they can edit or reject. These two are
 * not that. They are deterministic reads of the board, computed in `core/` with
 * no model call anywhere on the path, and they are here together because they
 * share the one property that makes them safe on a screen about somebody:
 * every line is a number they can check by looking.
 *
 *  - **Your studies at a glance** is the cross-course pulse. It moved out of
 *    `panel.ts` unchanged when the second block arrived, because the panel is a
 *    capped file and a room that grows two blocks a story is a room that has to
 *    live somewhere it can grow.
 *  - **What keeps slipping** is the newer one, and the one with a rule. It
 *    names things the board says have standing and have gone untouched while
 *    other work carried on. The sentences arrive from the service already
 *    written, so this module invents no claim about anybody: it draws a
 *    heading, the lines it was handed, and one control.
 *
 * ## What is deliberately not here
 *
 * There is no empty state for the slipping block. A board with nothing slipping
 * draws nothing at all, because the alternative is a congratulation, and
 * praising somebody for the absence of a problem is inventing an achievement to
 * hand out. It is also no place to say *avoidance*, or anything else that reads
 * as a diagnosis; the noun on the screen is *slipping*, which is a thing that
 * happens to work rather than a thing that is wrong with a person.
 *
 * A rendering module on the `arrival.ts` model: it builds DOM, it holds no
 * route, and anything that writes is handed in by the shell.
 */

import {
  registerLabel, REGISTER_LADDER,
  statementActionLabel, statementEvidenceLines, type StatementView,
} from './panel-core.js';
import { GLYPH } from './panel-glyphs.js';

const el = (html: string): HTMLElement => {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html.trim();
  return wrapper.firstElementChild as HTMLElement;
};

// ----------------------------------------------------------- first use

export const MODEL_PAGE_TITLE = 'What Virgil is learning about you';
export const MODEL_EMPTY_KICKER = 'Your words lead';
export const MODEL_EMPTY_TITLE = 'Teach Virgil how to teach you';
export const MODEL_EMPTY_EVIDENCE_LINE =
  'As you learn, I may add evidence-backed patterns here. You can confirm, correct or reject every one.';

/** First use is one purposeful board note, not an explanation for an empty database. */
export function insightFirstUse(body: string, add: HTMLElement): HTMLElement {
  const node = el(`<section class="insight-empty" aria-labelledby="insight-empty-title">
    <p class="kicker"></p><h2 id="insight-empty-title"></h2><p class="body"></p><p class="evidence"></p>
  </section>`);
  (node.querySelector('.kicker') as HTMLElement).textContent = MODEL_EMPTY_KICKER;
  (node.querySelector('h2') as HTMLElement).textContent = MODEL_EMPTY_TITLE;
  (node.querySelector('.body') as HTMLElement).textContent = body;
  (node.querySelector('.evidence') as HTMLElement).textContent = MODEL_EMPTY_EVIDENCE_LINE;
  node.append(add);
  return node;
}

// ------------------------------------------------ your studies at a glance

export interface CoursePulseView {
  readonly courseId: string;
  readonly title: string;
  readonly state: string;
  readonly stateLabel: string;
  readonly materialLine: string | null;
  readonly workLine: string | null;
  readonly resultLine: string | null;
}

export const PULSE_HEADING = 'Your studies at a glance';
export const PULSE_INTRO =
  'What is waiting, what you have covered, and the latest result I can see.';

/** The cross-course pulse. `open` is the shell's, because this holds no route. */
export function pulseSection(
  pulse: readonly CoursePulseView[],
  open: (courseId: string) => void,
): HTMLElement {
  const node = el(`<section class="learning-pulse" aria-labelledby="learning-pulse-title">
    <h2 id="learning-pulse-title"></h2>
    <p class="meta"></p>
    <div class="pulse-courses"></div>
  </section>`);
  (node.querySelector('h2') as HTMLElement).textContent = PULSE_HEADING;
  (node.querySelector('.meta') as HTMLElement).textContent = PULSE_INTRO;
  const cards = node.querySelector('.pulse-courses') as HTMLElement;
  for (const item of pulse) {
    const card = el(`<article class="pulse-course" data-state="">
      <div class="pulse-course-head"><h3></h3><span class="pulse-state"></span></div>
      <div class="pulse-facts"></div>
      <button class="link">Open course</button>
    </article>`);
    card.dataset['state'] = item.state;
    (card.querySelector('h3') as HTMLElement).textContent = item.title;
    (card.querySelector('.pulse-state') as HTMLElement).textContent = item.stateLabel;
    const facts = card.querySelector('.pulse-facts') as HTMLElement;
    for (const line of [item.workLine, item.materialLine, item.resultLine]) {
      if (!line) continue;
      const fact = document.createElement('p');
      fact.textContent = line;
      facts.append(fact);
    }
    const button = card.querySelector('button') as HTMLButtonElement;
    button.setAttribute('aria-label', `Open course: ${item.title}`);
    button.addEventListener('click', () => open(item.courseId));
    cards.append(card);
  }
  return node;
}

// ------------------------------------------------------ what keeps slipping

export interface SlippingRowView {
  readonly key: string;
  readonly title: string;
  readonly standingLine: string;
  readonly elsewhereLine: string;
  readonly activationLine: string;
  readonly passedOverLine?: string | null;
}

/**
 * The heading, and the whole learner-facing vocabulary of this feature.
 *
 * *Slipping* is a thing that happens to work. The word the code is organised
 * under says something about the person doing the work, and it does not appear
 * on this screen or on any other.
 */
export const SLIPPING_HEADING = 'What keeps slipping';

/**
 * The one control, named for the decision rather than for its effect.
 *
 * Not *Snooze*, not *Hide*, not *Dismiss*. Those all describe what happens to
 * the row, and what actually happens is that Virgil takes the learner's word
 * for it: the ranker stops nudging as well as the screen stopping showing. A
 * button called *Hide* would have made this a way to make the product quieter,
 * and the whole point is that it is a way to tell it something true.
 */
export const SLIPPING_SET_ASIDE_LABEL = 'Setting this aside on purpose';
export const SLIPPING_SET_ASIDE_SAVING = 'Saving that…';
export const SLIPPING_SET_ASIDE_DONE =
  'Set aside. It stops being raised, here and on Today, for the next two weeks.';
export const SLIPPING_SET_ASIDE_FAILED = "That didn't go through. Nothing changed.";

/**
 * One row: what it is, why it had standing, what happened instead, and the
 * smallest thing that would end it.
 *
 * `setAside` returns whether the service took the answer. The row reports the
 * outcome either way and never removes itself on a failure, for the same
 * reason the night scout's card does not: a row that vanished after a request
 * that did not land would tell somebody they had decided something they had
 * not.
 */
export function slippingRow(
  row: SlippingRowView,
  setAside: (key: string) => Promise<boolean>,
): HTMLElement {
  const node = el(`<article class="slipping" data-slipping="">
    <h3></h3>
    <p class="standing"></p>
    <p class="elsewhere"></p>
    <p class="activation"></p>
    <div class="row"><button class="link" data-set-aside></button></div>
    <p class="note" role="status" aria-live="polite"></p>
  </article>`);
  node.dataset['slipping'] = row.key;
  (node.querySelector('h3') as HTMLElement).textContent = row.title;
  (node.querySelector('.standing') as HTMLElement).textContent = row.standingLine;
  (node.querySelector('.elsewhere') as HTMLElement).textContent = row.elsewhereLine;
  (node.querySelector('.activation') as HTMLElement).textContent = row.activationLine;

  /**
   * The ledger's line is built only when the ledger has one, and it arrives
   * with its own start date already in it. A count with no date reads as a
   * count over all time, and nothing here has been counting for all time.
   */
  if (row.passedOverLine) {
    const passed = el(`<p class="passed-over"></p>`);
    passed.textContent = row.passedOverLine;
    node.insertBefore(passed, node.querySelector('.activation'));
  }

  const button = node.querySelector('[data-set-aside]') as HTMLButtonElement;
  const note = node.querySelector('.note') as HTMLElement;
  button.textContent = SLIPPING_SET_ASIDE_LABEL;
  button.setAttribute('aria-label', `${SLIPPING_SET_ASIDE_LABEL}: ${row.title}`);
  button.addEventListener('click', () => void (async () => {
    button.disabled = true;
    note.textContent = SLIPPING_SET_ASIDE_SAVING;
    if (!await setAside(row.key)) {
      button.disabled = false;
      note.textContent = SLIPPING_SET_ASIDE_FAILED;
      return;
    }
    (node.querySelector('.row') as HTMLElement).remove();
    note.textContent = SLIPPING_SET_ASIDE_DONE;
  })());
  return node;
}

/**
 * The block, or nothing at all.
 *
 * `null` rather than an empty section, and the caller appends only what it is
 * given. See the header: a board with nothing slipping has nothing to say, and
 * saying it anyway would be praise.
 */
export function slippingSection(
  rows: readonly SlippingRowView[],
  setAside: (key: string) => Promise<boolean>,
): HTMLElement | null {
  if (!rows.length) return null;
  const node = el(`<section class="slipping-block" aria-labelledby="slipping-title">
    <h2 id="slipping-title"></h2>
  </section>`);
  (node.querySelector('h2') as HTMLElement).textContent = SLIPPING_HEADING;
  for (const row of rows) node.append(slippingRow(row, setAside));
  return node;
}

// ------------------------------------------------------- what a read came from

/**
 * The evidence receipt under a machine read.
 *
 * Moved out of `panel.ts` unchanged when the modality question arrived, for the
 * ordinary reason: the panel is a capped file, and this is DOM built from lines
 * that `panel-core.ts` has already written. Nothing here decides anything.
 */
export function statementEvidence(statement: StatementView): HTMLElement {
  const node = el(`<details class="statement-evidence">
    <summary>What this came from</summary><ul></ul>
  </details>`);
  const summary = node.querySelector('summary') as HTMLElement;
  summary.setAttribute('aria-label', statementActionLabel('What this came from', statement.text));
  const list = node.querySelector('ul') as HTMLElement;
  for (const line of statementEvidenceLines(statement)) {
    const item = document.createElement('li');
    item.textContent = line;
    list.append(item);
  }
  return node;
}

// ------------------------------------------------ what these sentences are about

/**
 * THE ROOM WAS ONE PILE, AND IT IS TWO KINDS OF CLAIM.
 *
 * Every statement drew as the same flat card: the sentence, a badge, a
 * disclosure and two controls. So a read about one course, a read about a topic
 * and a read about how somebody learns in general were indistinguishable at a
 * glance, and the screen that is supposed to make a learner model arguable
 * asked them to hold the difference in their head instead.
 *
 * The join has been in the store since SB-285 repaired `topicId`, and the
 * subject over it is the same one the lesson page puts over a heading. Nothing
 * here decides what anything is about: the service says, and this arranges.
 *
 * Two rules, and both are about meaning rather than layout:
 *
 *  - **Stored order survives inside a group.** The night writes chains of
 *    reasoning, and a sentence can say "in that area" about the one before it.
 *    Sorting them would break sentences the product itself wrote.
 *  - **One group draws no label.** A heading over everything separates nothing,
 *    and it is also exactly what a service too old to send a subject produces,
 *    so the older-service answer is the same shape rather than a special case.
 */
export type InsightStatementView = ModalityStatementView & {
  readonly topicId?: string | null;
  /** The topic's own board label, where the service knows one. */
  readonly topicLabel?: string | null;
  /** The course that claims the topic, where one does. Stronger than the label,
   *  and the same rule `subjectOf` applies over a lesson. */
  readonly subject?: { readonly courseId: string; readonly title: string } | null;
  /**
   * Where the board says this sentence's topic currently stands.
   *
   * The stored key, not the word: `registerLabel` is the one seam between the
   * two everywhere else in this panel and it stays the only one here. Absent
   * from a service too old to send it and from a row whose topic has left the
   * board, and absent draws no chip rather than a guessed one.
   */
  readonly register?: string | null;
};

/**
 * The sentences that are about how somebody works rather than about a subject.
 *
 * Not "Other", not "General", not "Uncategorised". It began as the label over
 * the reads that named no subject; since the room became five sections it is
 * the one SUB-category the store can honestly answer, over the rows carrying a
 * modality mark. Both uses are the same claim in the same words, which is why
 * there is one constant and not two.
 */
export const GENERAL_GROUP_LABEL = 'How you learn';

export interface StatementGroupView<T> {
  /** The subject these share, or null where they are about no subject at all. */
  readonly label: string | null;
  readonly statements: readonly T[];
}

/** Strongest first, exactly as `subjectOf` reads a lesson's two stored facts. */
const subjectTitle = (statement: InsightStatementView): string | null =>
  statement.subject?.title ?? statement.topicLabel ?? null;

/** Groups in the order their first sentence appears, and sentences in the order
 *  they were written. Both orders are the store's, and neither is invented. */
export function groupStatements<T extends InsightStatementView>(
  statements: readonly T[],
): readonly StatementGroupView<T>[] {
  const groups = new Map<string, { label: string | null; statements: T[] }>();
  for (const statement of statements) {
    const label = subjectTitle(statement);
    const key = label ?? '';
    const group = groups.get(key) ?? { label, statements: [] };
    group.statements.push(statement);
    groups.set(key, group);
  }
  return [...groups.values()];
}

// ------------------------------------------------- the room, in five sections


export type InsightSectionKey =
  | 'questions' | 'told' | 'confirmed' | 'patterns' | 'subjects';

/** The order they are read in: what is asked of you, then what you said, then
 *  what you agreed with, then what is still only my read. */
export const INSIGHT_SECTION_ORDER: readonly InsightSectionKey[] =
  ['questions', 'told', 'confirmed', 'patterns', 'subjects'];

/**
 * The five headings, and every one of them is a sentence about who said what.
 *
 * *Patterns I'm seeing* rather than "About you", because a read nobody has
 * answered is something Virgil is noticing rather than something that is true
 * about a person. *Where each subject stands* rather than "Topics", because the
 * rows under it are about the work rather than about the reader.
 */
export const INSIGHT_SECTION_HEADINGS: Readonly<Record<InsightSectionKey, string>> = {
  questions: 'Questions for you',
  told: 'Things you told me',
  confirmed: 'Things you confirmed',
  patterns: "Patterns I'm seeing",
  subjects: 'Where each subject stands',
};

/** Exact row counts that also say whether this section is waiting on the learner. */
export function insightSectionCount(key: InsightSectionKey, count: number): string {
  if (key === 'questions') return `${count} to answer`;
  if (key === 'told') return `${count} from you`;
  if (key === 'confirmed') return `${count} confirmed`;
  return `${count} to review`;
}

/**
 * Which section a row belongs in, from its own stored fields and nothing else.
 *
 * The order of the tests IS the precedence, and each one is a fact rather than
 * a reading: an unanswered modality mark is a question; `userEdited` is the
 * learner's authorship; `confirmed` is their endorsement of Virgil's wording.
 * Only after all three does the subject matter at all.
 *
 * A service too old to say what a sentence is about sends no subject and no
 * topic label, and its unanswered reads land under *Patterns I'm seeing* —
 * which is where a read with nothing to say about a subject honestly goes. The
 * discriminator is the subject the screen can NAME rather than the raw
 * `topicId`, because a subject section whose subject cannot be named is a
 * heading with nothing written on it.
 */
export function sectionOf(statement: InsightStatementView): InsightSectionKey {
  if (statement.modality && !statement.modality.confirmed) return 'questions';
  if (statement.userEdited) return 'told';
  if (statement.confirmed) return 'confirmed';
  return subjectTitle(statement) ? 'subjects' : 'patterns';
}

export interface InsightSectionView<T> {
  readonly key: InsightSectionKey;
  readonly heading: string;
  readonly statements: readonly T[];
}

/** The sections that have something in them, in the fixed order above, with
 *  stored order preserved inside each one for the reason `groupStatements`
 *  preserves it: the night writes chains, and sorting breaks its sentences. */
export function insightSectionsOf<T extends InsightStatementView>(
  statements: readonly T[],
): readonly InsightSectionView<T>[] {
  return INSIGHT_SECTION_ORDER
    .map((key) => ({
      key,
      heading: INSIGHT_SECTION_HEADINGS[key],
      statements: statements.filter((statement) => sectionOf(statement) === key),
    }))
    .filter((section) => section.statements.length > 0);
}

/**
 * The register word a subject wears, or nothing.
 *
 * The service sends each row the register of its own topic, computed by the
 * same arithmetic the lineup chip and the board rail read. A subject can hold
 * several topics, so the group's chip is drawn only where the registers under
 * it agree: one subject standing in two places at once is not a fact, and
 * picking either one of them would be this screen inventing a summary.
 *
 * An unknown value never reaches the screen, exactly as `registerChips` refuses
 * one: the keys are load-bearing in prompts and in the ledger, and a machine
 * name printed as a word about somebody is the failure this rule exists for.
 */
export function subjectRegister(statements: readonly InsightStatementView[]): string | null {
  const known: readonly string[] = REGISTER_LADDER;
  const present = new Set(
    statements.map((statement) => statement.register ?? '').filter((value) => known.includes(value)),
  );
  return present.size === 1 ? ([...present][0] as string) : null;
}

/** The two-column bed. Sentences, not cards: two columns at width and one when
 *  there is not room, which `panel.css` decides rather than this. */
function statementGrid<T>(
  statements: readonly T[], row: (statement: T) => HTMLElement,
): HTMLElement {
  const grid = el(`<div class="statement-grid"></div>`);
  for (const statement of statements) grid.append(row(statement));
  return grid;
}

/** One named sub-group: the label, its chip where it has one, and its rows. */
function subGroup<T extends InsightStatementView>(
  label: string, register: string | null,
  statements: readonly T[], row: (statement: T) => HTMLElement,
): HTMLElement {
  const node = el(`<section class="statement-group">
    <h2 class="alt-label"><span class="name"></span><span class="register" data-register=""></span></h2>
  </section>`);
  (node.querySelector('.name') as HTMLElement).textContent = label;
  const chip = node.querySelector('.register') as HTMLElement;
  if (register) {
    chip.dataset['register'] = register;
    chip.textContent = registerLabel(register);
  } else chip.remove();
  node.append(statementGrid(statements, row));
  return node;
}

/**
 * What goes inside one section, sub-grouped only where the store can say so.
 *
 * *Where each subject stands* is sub-grouped by subject, which is the join
 * SB-285 repaired and the service already sends. Everywhere else the only
 * stored fact that divides these sentences is the modality mark, so the rows
 * carrying one are gathered under *How you learn* and the rest are drawn plain
 * above them.
 *
 * There is no display-time classification here and there is deliberately none
 * coming: a sub-heading picked by reading a sentence's words would be this
 * screen making a second claim about somebody underneath the first one, and it
 * would be the only claim on the page with no evidence behind it. A second
 * sub-category needs a second stored fact, stamped where the sentence is
 * written.
 *
 * A label over everything separates nothing, which is the rule the subject
 * grouping already followed: where every row in a section carries the mark, or
 * none does, the section draws one plain bed and no sub-heading.
 */
function sectionBody<T extends InsightStatementView>(
  key: InsightSectionKey, statements: readonly T[], row: (statement: T) => HTMLElement,
): readonly HTMLElement[] {
  if (key === 'subjects') {
    return groupStatements(statements).map((group) => subGroup(
      group.label ?? GENERAL_GROUP_LABEL, subjectRegister(group.statements), group.statements, row,
    ));
  }
  const marked = statements.filter((statement) => statement.modality);
  if (!marked.length || marked.length === statements.length) return [statementGrid(statements, row)];
  return [
    statementGrid(statements.filter((statement) => !statement.modality), row),
    subGroup(GENERAL_GROUP_LABEL, null, marked, row),
  ];
}

/**
 * Whether a section is open, and where that answer is kept.
 *
 * Handed in, because this module holds no state any more than it holds a route.
 * The shell keeps it for the visit in memory beside its other unsaved screen
 * state; nothing about which drawers somebody left open is worth writing down
 * across sessions, and a remembered collapse that outlived the visit would hide
 * a question about them behind a decision they made a week ago.
 */
export interface InsightSectionMemory {
  readonly open: (key: InsightSectionKey) => boolean;
  readonly toggled: (key: InsightSectionKey, open: boolean) => void;
}

/** The chevron on the head, which is the only thing on it that is not words. */
const SECTION_MARK =
  '<svg class="glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor"'
  + ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
  + ` focusable="false">${GLYPH.down}</svg>`;

/**
 * The sections, as the board's areas: a name, a rule under it, and what is
 * underneath.
 *
 * A heading with a button inside it rather than a `<details>`, so the same
 * markup says the same thing to a pointer and to a screen reader: the heading
 * structure survives, the control announces whether it is expanded, and what it
 * controls is named. `row` is the shell's, because a row writes.
 */
export function insightSections<T extends InsightStatementView>(
  statements: readonly T[],
  row: (statement: T) => HTMLElement,
  memory: InsightSectionMemory,
): readonly HTMLElement[] {
  return insightSectionsOf(statements).map((section) => {
    const node = el(`<section class="insight-section" data-section="">
      <div class="head"><h2><button class="section-toggle" data-toggle>${SECTION_MARK}<span class="name"></span><span class="count"></span></button></h2></div>
      <div class="rows"></div>
    </section>`);
    node.dataset['section'] = section.key;
    (node.querySelector('.name') as HTMLElement).textContent = section.heading;
    (node.querySelector('.count') as HTMLElement).textContent =
      insightSectionCount(section.key, section.statements.length);
    const rows = node.querySelector('.rows') as HTMLElement;
    rows.setAttribute('id', `insight-rows-${section.key}`);
    rows.append(...sectionBody(section.key, section.statements, row));
    const toggle = node.querySelector('[data-toggle]') as HTMLButtonElement;
    toggle.setAttribute('aria-controls', `insight-rows-${section.key}`);
    const show = (open: boolean): void => {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) rows.removeAttribute('hidden'); else rows.setAttribute('hidden', '');
    };
    show(memory.open(section.key));
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      show(open);
      memory.toggled(section.key, open);
    });
    return node;
  });
}

// ------------------------------------------------- what a sentence has caused

/**
 * The one line on this screen about something that happened because of a
 * sentence on it.
 *
 * The night scout records which gap each proposal was built on, and two of its
 * kinds are built on a statement. Where such a proposal is still waiting, the
 * row it came from says so: a learner deciding whether a read of them is right
 * should know that something is already standing on it, and where to go and
 * answer that.
 *
 * It is a statement of fact and a door, and deliberately not a summary of the
 * suggestion. The suggestion is reviewed where it lives, beside the evidence it
 * carries; repeating its subject here would be this room making a case for it.
 */
export const STATEMENT_BEHIND_SUGGESTION_LINE =
  'This is behind a suggestion waiting in My studies.';

/** Named for the room, because the room is where the answer is given. */
export const STATEMENT_BEHIND_SUGGESTION_ACTION = 'My studies';

export function statementConsequence(open: () => void): HTMLElement {
  const node = el(`<div class="statement-consequence">
    <span class="meta"></span><button class="link"></button>
  </div>`);
  (node.querySelector('.meta') as HTMLElement).textContent = STATEMENT_BEHIND_SUGGESTION_LINE;
  const door = node.querySelector('button') as HTMLButtonElement;
  door.textContent = STATEMENT_BEHIND_SUGGESTION_ACTION;
  door.addEventListener('click', () => open());
  return node;
}

// -------------------------------------------------- the one question about you

/**
 * SB-282. The only sentence in this product that asks a person what they are
 * like, and the rules around it are what make it askable at all.
 *
 * PRODUCT_SHAPE.md puts modality profiling in the tier that may not be claimed:
 * *if it ever exists, it enters as a learner-confirmed statement with its
 * evidence shown, never as a hidden profile*. So this block is built as the
 * opposite of a profile in four visible ways, and each one is load-bearing
 * rather than decorative:
 *
 *  - It is written as a question and ends in a question mark. Nothing on the
 *    screen states it as a fact about them.
 *  - Its evidence is the counts inside the sentence itself, put there by
 *    arithmetic in `core/domain/modality.ts`. There is no score, no band and
 *    nothing to look up.
 *  - The badge says it is not a read yet, so a person who answers nothing is
 *    never left looking at an unanswered question that reads as a verdict.
 *  - It says, in as many words, that answering changes nothing about what they
 *    are offered. That is true in this slice and it is the sentence a later
 *    slice would have to come back and change on purpose.
 *
 * A denial is final for a month and the row says so, which is the difference
 * between taking somebody's answer and merely hiding a card.
 */
export interface StatementModalityView {
  readonly key: string;
  readonly confirmed: boolean;
}

/**
 * A statement row that may carry one.
 *
 * Declared here rather than widened in `panel-core.ts` because the field is
 * this feature's and only this block reads it. The panel types its `/model`
 * read with it and branches on the same shape.
 */
export type ModalityStatementView = StatementView & {
  readonly modality?: StatementModalityView | null;
};

/** The badge, in the slot that otherwise says `my read` or `your words`. */
export const MODALITY_BADGE = 'a question, not a read';

/**
 * The promise the slice actually keeps.
 *
 * Stated on the card rather than left implicit, because a person asked whether
 * they find notation hard will reasonably assume the answer changes what they
 * are given, and in this slice it does not.
 */
export const MODALITY_NOTE =
  'Answering this changes nothing about what I offer you. It only tells me whether my read is right.';

export const MODALITY_CONFIRM_LABEL = 'Yes, that matches';
export const MODALITY_DENY_LABEL = 'No, that is not it';
export const MODALITY_SAVING = 'Saving that…';
export const MODALITY_FAILED = "That didn't go through. Nothing changed.";
export const MODALITY_CONFIRMED =
  'Saved. It sits with your insights now, and it still changes nothing about what I offer you.';

/**
 * How long a no lasts, said to the person who said it.
 *
 * The number is `MODALITY_DENIED_DAYS` in `core/domain/modality.ts`, which owns
 * it; this is the copy's own copy, exactly as `LEARNER_STATEMENT_MAX_CHARS` is
 * in `panel-core.ts`. The extension is a separate build and does not import the
 * domain, so the alternative to repeating the number is not naming it, and a
 * promise with no number in it is not one somebody can hold this product to.
 */
export const MODALITY_DENIED_DAYS = 30;
export const MODALITY_DENIED =
  `Taken. I will not raise a pattern like this again for ${MODALITY_DENIED_DAYS} days.`;

/**
 * The card, with its two answers.
 *
 * `answer` returns whether the service took it. Like the slipping row, the card
 * never removes itself on a failure: telling somebody they have answered a
 * question about themselves when the answer did not land is worse than making
 * them press it again.
 */
export function modalityQuestion(
  statement: ModalityStatementView,
  answer: (id: string, confirmed: boolean) => Promise<boolean>,
): HTMLElement {
  const node = el(`<div class="statement modality" data-modality="">
    <div class="text"></div>
    <div class="state"></div>
    <p class="meta"></p>
    <div class="row repair">
      <button data-confirm></button><button class="link" data-deny></button>
    </div>
    <p class="note" role="status" aria-live="polite"></p>
  </div>`);
  node.dataset['modality'] = statement.modality?.key ?? '';
  (node.querySelector('.text') as HTMLElement).textContent = statement.text;
  (node.querySelector('.state') as HTMLElement).textContent = MODALITY_BADGE;
  (node.querySelector('.meta') as HTMLElement).textContent = MODALITY_NOTE;
  node.insertBefore(statementEvidence(statement), node.querySelector('.repair'));

  const note = node.querySelector('.note') as HTMLElement;
  const confirm = node.querySelector('[data-confirm]') as HTMLButtonElement;
  const deny = node.querySelector('[data-deny]') as HTMLButtonElement;
  const wire = (button: HTMLButtonElement, label: string, confirmed: boolean): void => {
    button.textContent = label;
    button.setAttribute('aria-label', statementActionLabel(label, statement.text));
    button.addEventListener('click', () => void (async () => {
      confirm.disabled = true;
      deny.disabled = true;
      note.textContent = MODALITY_SAVING;
      if (!await answer(statement.id, confirmed)) {
        confirm.disabled = false;
        deny.disabled = false;
        note.textContent = MODALITY_FAILED;
        return;
      }
      (node.querySelector('.repair') as HTMLElement).remove();
      note.textContent = confirmed ? MODALITY_CONFIRMED : MODALITY_DENIED;
    })());
  };
  wire(confirm, MODALITY_CONFIRM_LABEL, true);
  wire(deny, MODALITY_DENY_LABEL, false);
  return node;
}
