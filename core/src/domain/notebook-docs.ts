import type {
  Pin, Session, SessionSection, Signal, SourceRecord, Statement, Topic, TopicId, DepthRegister,
} from './types.js';
import type { EvidenceSignalType } from './signals.js';
import { isEvidence } from './signals.js';
import type { Commitment, CommitmentKind } from './commitments.js';
import { commitmentState, deadlineDay, hasTimedDeadline } from './commitments.js';
import type { Course, Material, MaterialKind } from './courses.js';
import { courseProgress, isOpenableUrl } from './courses.js';
import type { CriterionOutcome, LearningOutcome, OutcomeKind } from './outcomes.js';
import { outcomeSignalSeeds } from './outcomes.js';
import type { BoardArea } from './board-areas.js';
import { boardAreaFor } from './board-areas.js';
import { subjectForTopic } from './subjects.js';
import { momentHref } from './video.js';
import { pdfPageHref } from './pdf.js';
import { rendersEmpty } from './text.js';
import { isUnansweredModality } from './modality.js';
import { dayKeyFor } from './schedule.js';
import type { NotebookDoc, NotebookDocKey } from '../ports/notebook-export.js';

/**
 * NOTEBOOK DOCS — the three documents Virgil keeps in the learner's own Drive.
 *
 * `NOTEBOOK_SEAM_V2.md` is the design and the argument. This file is the whole
 * of the decision half: board state in, three documents of prose out, and
 * nothing in between that can fail, bill, or vary.
 *
 * ## Why three, and why these three
 *
 * There were five, and they were organised the way the store is organised: what
 * you are working on, where you are steady and shaky, what your results said,
 * your sessions, your sources. Every one of them was honest, and every one of
 * them held one slice of every topic. So the question somebody actually brings
 * to a notebook — *which of these should I work on tonight?* — needed four
 * documents read and joined by hand, and the thing on the other end of this
 * seam does not join by hand. It retrieves a chunk and answers from it.
 *
 * The three below are named for the **moment a learner reaches for them**:
 *
 *  1. **Learn now.** The lesson that is in front of them: what it says, where
 *     it came from, where it sits, and what it asks them to do. Pushed from the
 *     lesson on demand, and rewritten by the nightly when the prepared session
 *     changes.
 *  2. **On the board.** Everything they are carrying, one topic at a time, with
 *     that topic's area, its steady or shaky read in words, its results, its
 *     saved pages and what is coming up on it **all under the same heading**.
 *     That adjacency is the entire point: it is what lets one retrieved chunk
 *     answer *which one*.
 *  3. **Archive.** The subjects they have held and have not removed: what was
 *     covered, when it was last touched, and where it landed. It is how
 *     somebody picks up something older.
 *
 * The split between 2 and 3 is `board-areas.ts`'s own five areas, cut where the
 * learner's own language cuts them: Get Started, Currently Learning and
 * Recharging are things they are carrying now; Paused and Learnt are things
 * they have put down or finished with. No topic appears in both documents and
 * none is missing from both, which is what makes "which one" and "what have I
 * held" two questions with one answer each rather than four overlapping ones.
 *
 * ## Three properties, and each one is load-bearing
 *
 * **Pure.** No I/O, no model call, no vendor. `check-seam.mjs` and
 * `seam-purity.test.ts` already forbid the first and third in `core/`; the
 * second is a choice, and it is the choice that makes this seam free. The
 * export is the last thing a nightly does, and a last step that could call a
 * model would be a last step that could be stopped by a spend limit, fail on a
 * provider outage, or quietly cost money every night for ever. Turning a board
 * into sentences is a job for code that knows the board, not for a model that
 * would have to be told about it first.
 *
 * **Deterministic.** Same inputs, byte-identical output. Nothing reads a clock
 * here: `now` arrives on the input, like everywhere else in this product. This
 * is not tidiness. The Drive adapter rewrites the same documents every night,
 * and a document whose bytes differ for no reason is a document Google
 * re-ingests for no reason, on a schedule nobody controls, for ever. An
 * unchanged board must produce an unchanged file. Every sort in this file is
 * total for the same reason, and none of them uses `localeCompare`, whose
 * answer depends on where the process is running.
 *
 * **Silent about numbers it was never given.** The comfort model is a number
 * (`Topic.comfort`, 0..1) and SB-33 is that it is never shown as one. The
 * defence here is structural rather than careful: this module is not handed the
 * number. `NotebookComfort` below carries `regressed`, `certainty` and
 * `evidenceCount` and no comfort value at all, so a document that printed a
 * comfort score would first have to be given one, and there is nowhere for it
 * to come from. `boardAreaFor` supplies the words instead, and they are the
 * board's own words rather than export-only ones, so the notebook and the panel
 * cannot tell a learner two different things about the same topic.
 *
 * ## Voice
 *
 * First person Virgil throughout. **"I" is Virgil and "you" is the learner**,
 * and every document says so in its own preamble, because a chunk retrieved out
 * of context and quoted back by a chat assistant has ambiguous pronouns, and a
 * source saying "I am shaky on recursion" is a disaster if the "I" is read as
 * the wrong party.
 *
 * `house-style.ts`'s dash rule applies in full and has no exceptions: nothing
 * this file writes contains an em-dash or an en-dash. Learner text quoted
 * verbatim is a different matter and is not rewritten, because correcting
 * somebody's punctuation inside a quotation of them is worse than the dash.
 *
 * Three phrases are banned outright by the vocabulary ruling and none of them
 * appears in anything below: *source-backed*, *source-shaped*, and *the pinned
 * material*. The human forms are **your saved pages** and **your sources**.
 *
 * The heading ban in `PROSE_STYLE` does not travel here, and
 * `ports/notebook-export.ts` records why.
 */

// --------------------------------------------------------------- the inputs

/**
 * A comfort reading, structurally, and deliberately missing a field.
 *
 * `ComfortResult` satisfies this. It is restated rather than imported for the
 * reason `main-page.ts` restates `TopicReason`: the Registrar is an agent and
 * this is the domain underneath the agents, and importing upwards is the
 * inversion `seam-purity.test.ts` exists to catch.
 *
 * `comfort` is absent on purpose. See the note above.
 */
export interface NotebookComfort {
  readonly topicId: TopicId;
  /** SB-36: it had settled, and something recent has undercut it. */
  readonly regressed: boolean;
  /** Low when we are guessing from very little. Never printed; only consulted. */
  readonly certainty: number;
  /** Interview seeds excluded, as the Registrar excludes them. */
  readonly evidenceCount: number;
}

/**
 * The Gardener's decision, structurally. `GardenDecision` satisfies it.
 *
 * Restated for the same reason and carried for the same one `main-page.ts`
 * carries it: the reason line is quoted from the scheduler rather than written
 * again in words that would drift from it, so the notebook and the session card
 * cannot disagree about why tonight is about what it is about.
 */
export interface NotebookReason {
  readonly topicId: TopicId;
  readonly reason: string;
}

/** Everything the three documents are made of. Read once, by the caller. */
export interface NotebookInput {
  readonly now: Date;
  /** Learner-owned zone for the dated work projection. */
  readonly timeZone?: string;
  readonly topics: readonly Topic[];
  readonly pins: readonly Pin[];
  readonly signals: readonly Signal[];
  readonly statements: readonly Statement[];
  readonly courses: readonly Course[];
  readonly commitments: readonly Commitment[];
  readonly sessions: readonly Session[];
  readonly outcomes: readonly LearningOutcome[];
  readonly comforts: readonly NotebookComfort[];
  readonly reasons: readonly NotebookReason[];
}

// ------------------------------------------------------------- the retention

/**
 * Retention, per document, as constants rather than as literals in a filter.
 *
 * Every one of these is the same trade in a different shape: a document that
 * only grows becomes noise, and noise in a retrieval corpus does not sit
 * quietly beside the signal, it competes with it. The limits are not about
 * size. Google's per-source allowance is generous and none of these documents
 * comes near it.
 */

/** §6.1 — a finished obligation from March is not context, it is ballast. */
export const CLOSED_COMMITMENT_DAYS = 30;

/** §6.3 — half a year of assessed reality, which is an academic term and a bit. */
export const OUTCOME_WINDOW_DAYS = 180;

/** §6.3 — and a hard cap, because a busy term can produce a lot of marking. */
export const MAX_OUTCOMES = 40;

/**
 * §6.4 — how far back the covered lines are read from.
 *
 * The sessions document is gone and its job is not: a learner still asks what
 * was covered on a topic. It is answered per topic now, from the recaps the
 * Composer already wrote, and this is the window those recaps are drawn from.
 * Ten sessions is a fortnight of nights, which is as far back as "what have we
 * done on this" is a question about the present.
 */
export const SESSION_WINDOW = 10;

/**
 * §6.5 — a cap rather than a window, because pinning is bursty.
 *
 * A fortnight's window is empty for somebody who reads at weekends and
 * thousands of rows for somebody who reads every day. A cap behaves the same
 * for both.
 */
export const MAX_SOURCE_PINS = 150;

/** A pinned selection is quoted, not reproduced. Long enough to be the thing,
 *  short enough that one pin cannot crowd out fifty. */
export const MAX_QUOTED_SELECTION = 400;

/** Below this, `certainty` is thin enough that a document should say so. */
export const THIN_CERTAINTY = 0.35;

/**
 * How many topics the board document writes out in full.
 *
 * A board is not supposed to have three hundred live topics on it, and a person
 * whose board does is not helped by a document with three hundred sections. The
 * newest touched win, and the document says plainly that it is not the whole
 * list, because a truncation nobody is told about is a document quietly
 * disagreeing with the board it describes.
 */
export const MAX_BOARD_TOPICS = 60;

/** And the same for the archive, which grows for ever by construction. */
export const MAX_ARCHIVE_SUBJECTS = 120;

/** Per topic, so that one busy topic cannot swallow the document. */
export const MAX_TOPIC_SOURCES = 8;
export const MAX_TOPIC_COVERED = 6;
export const MAX_TOPIC_RESULTS = 5;
export const MAX_TOPIC_COMMITMENTS = 5;

/** The sources behind one lesson. A section cites a handful; this is the wall. */
export const MAX_LESSON_SOURCES = 12;

/** What is still to come in the session the lesson belongs to. */
export const MAX_LESSON_LINEUP = 8;

const DAY_MS = 86_400_000;

// ----------------------------------------------------------------- plumbing

/** The house convention: a day is the first ten characters of an ISO stamp. */
const day = (iso: string): string => iso.slice(0, 10);

/**
 * A total order over strings that does not depend on where the process runs.
 *
 * Deliberately not `localeCompare`, which this repository uses elsewhere for
 * ordering a list somebody is about to look at. Here the output is bytes that
 * get compared against yesterday's bytes, and a sort whose answer depends on
 * an environment variable is a sort that rewrites files for no reason.
 */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Newest first, with the id as the tie-break so equal stamps never shuffle. */
const newestFirst = <T extends { readonly id: string }>(
  at: (item: T) => string,
) => (a: T, b: T): number => {
  const when = byText(at(b), at(a));
  return when !== 0 ? when : byText(a.id, b.id);
};

const daysBetween = (iso: string, now: Date): number =>
  (now.getTime() - Date.parse(iso)) / DAY_MS;

/** Present, and not only whitespace and things that render as nothing. */
const said = (text: string | null | undefined): text is string =>
  typeof text === 'string' && !rendersEmpty(text);

/** A Markdown link, or plain text when there is nothing safe to link to. */
function link(text: string, url: string | null | undefined): string {
  const label = text.replace(/[[\]]/g, '');
  if (!url || !isOpenableUrl(url)) return label;
  // A closing bracket inside the target ends the link early and leaves the rest
  // of the address on the page as text. Encoded rather than dropped: the
  // address still has to work.
  return `[${label}](${url.replace(/\)/g, '%29')})`;
}

const bullet = (text: string): string => `- ${text}`;

/** A block of lines, assembled in order. Nothing here is clever on purpose. */
class Body {
  private readonly lines: string[] = [];

  head(level: number, text: string): this {
    this.lines.push(`${'#'.repeat(level)} ${text}`, '');
    return this;
  }

  say(text: string): this {
    this.lines.push(text, '');
    return this;
  }

  /** One fact per line, no blank between them: a list is one idea. */
  list(items: readonly string[]): this {
    if (!items.length) return this;
    this.lines.push(...items, '');
    return this;
  }

  /** Verbatim learner or Composer prose. Not re-wrapped, not re-punctuated. */
  quote(text: string): this {
    this.lines.push(text, '');
    return this;
  }

  render(): string {
    // One trailing newline, and no run of blanks, so that an unchanged board
    // cannot produce a file that differs in whitespace.
    const out: string[] = [];
    for (const line of this.lines) {
      if (line === '' && out[out.length - 1] === '') continue;
      out.push(line);
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return `${out.join('\n')}\n`;
  }
}

/**
 * The opening of every document: its job for the notebook, what it is, who
 * wrote it, when, and how to tell it is behind. §5.8, and every line of it
 * earns its place.
 *
 * The source-specific brief is deliberately short and appears before metadata
 * so a retrieved opening chunk carries the document's purpose. It tells the
 * notebook how to use this source and where its authority stops. It never asks
 * the notebook to update Virgil, infer learner state, or treat Virgil's reads as
 * the learner's own words.
 *
 * The pronoun sentence is not politeness. A retrieval system hands a chat
 * assistant a chunk with no title attached and the assistant quotes it back;
 * without this line, "I" is whoever the reader assumes.
 *
 * The edit warning is the only honest mitigation for a learner typing into a
 * document Virgil is going to overwrite. The alternative is merge machinery for
 * a document nobody is meant to be authoring.
 *
 * The staleness line is the one thing this seam can honestly offer against its
 * own worst failure. **Nothing here claims the notebook is current** — Virgil
 * cannot see the notebook and does not know what Google read or when. What it
 * can do is print the date it last wrote, and tell the reader what to do when
 * that date looks older than they expected.
 */
function preamble(
  body: Body,
  title: string,
  use: readonly string[],
  what: string,
  now: Date,
  timeZone?: string,
): Body {
  return body
    .head(1, title)
    .head(2, 'How to use this source')
    .list(use.map(bullet))
    .say(`Virgil wrote this. I last rewrote it on ${dayKeyFor(now, timeZone ?? 'UTC')}.`)
    .say(what)
    .say('I rewrite this whole document in place every time, so anything you type into it will be replaced. '
      + 'Edit your board in Virgil instead and it will show up here.')
    .say('In this document, "I" means Virgil, the learning partner that wrote it. '
      + '"You" means the person it is about.')
    .say('If what you read here looks older than the date above, refresh this source in your notebook '
      + 'and read it again.');
}

// ------------------------------------------------------------- the phrasing

/**
 * SB-283: the same register vocabulary the panel shows, in a sentence.
 *
 * The panel renders `from-nothing` as *new to you*, and the notebook is the
 * other document a learner reads about their own board. Two surfaces
 * describing one stored register in two different words is how a reader comes
 * to believe there are two things.
 */
const REGISTER_WORDS: Readonly<Record<DepthRegister, string>> = {
  'from-nothing': 'as new to you, assuming no background',
  building: 'building on what you already had',
  fluent: 'at the level of someone already fluent in it',
};

/**
 * Where a topic stands, in words, and never in a number.
 *
 * The five are `board-areas.ts`'s five. Using the
 * board's own areas rather than inventing export-only ones is what stops the
 * notebook and the panel telling a learner two different things.
 */
const AREA_WORDS: Readonly<Record<BoardArea, string>> = {
  'get-started': 'This is filed and waiting. Nothing has happened on it yet.',
  learning: 'You are working on this and it has not gone solid yet.',
  recharging: 'You had this. It is due a check so that it does not slip away.',
  paused: 'You put this one down. It is yours to pick back up whenever you want it.',
  learnt: 'You have this, and nothing recent suggests otherwise.',
};

const AREA_HEADINGS: Readonly<Record<BoardArea, string>> = {
  'get-started': 'Get Started',
  learning: 'Currently Learning',
  recharging: 'Recharging',
  paused: 'Paused',
  learnt: 'Learnt',
};

/**
 * The cut between the two board documents, and it is the learner's own cut.
 *
 * What is being carried right now goes in the board document; what has been put
 * down or finished with goes in the archive. Written as two lists rather than
 * as a predicate so that the split is one thing to read and one thing to argue
 * with, and so that adding a sixth area could not silently fall into neither.
 */
const LIVE_AREAS: readonly BoardArea[] = ['get-started', 'learning', 'recharging'];
const ARCHIVE_AREAS: readonly BoardArea[] = ['paused', 'learnt'];

/**
 * What a kind of evidence is, said as a thing that happened.
 *
 * **Kinds, never tallies.** "Four right and two wrong" is a score with the word
 * score taken out, and SB-33 and SB-18 both land on it: comfort is never a
 * number, and nothing in this product counts anything a learner could fall
 * behind on. What is useful and safe is naming what the reading was built from,
 * so that a learner can disagree with it. That is SB-55's contestability
 * argument arriving in a document instead of on a screen.
 */
const EVIDENCE_WORDS: Readonly<Record<EvidenceSignalType, string>> = {
  'answer-correct': 'answers you have given me',
  'answer-wrong': 'answers you have given me',
  'recall-check': 'recall checks you have done',
  'assessed-strong': 'results you recorded from real marking',
  'assessed-gap': 'results you recorded from real marking',
  'qc-finding': 'something a check on your own writing turned up',
  'depth-simpler': 'times you asked me to go simpler',
  'depth-deeper': 'times you asked me to go deeper',
  'pin-struggle': 'things you saved because they were hard',
  'pin-interest': 'things you saved because they interested you',
  'self-skip': 'things you told me you already knew',
  'section-completed': 'how you moved through the sessions I built',
  'section-abandoned': 'how you moved through the sessions I built',
  'reread-confirmed': 'pages you went back to and read again',
  'interview-seed': 'what you told me when we started',
  'user-model-edit': 'corrections you made to what I had written about you',
  'resurface-refresher': 'times you asked for this one back as a refresher',
  'resurface-deeper': 'times you asked for this one back in more depth',
  'quick-take-got-it': 'quick checks you answered',
  'quick-take-still-shaky': 'quick checks you answered',
  'guide-stuck': 'a step you told me you were stuck on',
};

const KIND_WORDS: Readonly<Record<CommitmentKind, string>> = {
  assignment: 'an assignment',
  lesson: 'a lesson',
  study: 'study time you set aside',
  task: 'a task',
};

const MATERIAL_HEADINGS: Readonly<Record<MaterialKind, string>> = {
  video: 'Videos',
  reading: 'Readings',
  class: 'Classes',
  exercise: 'Exercises',
  other: 'Other material',
};

const MATERIAL_ORDER: readonly MaterialKind[] = [
  'video', 'reading', 'class', 'exercise', 'other',
];

const OUTCOME_WORDS: Readonly<Record<OutcomeKind, string>> = {
  grade: 'a grade',
  rubric: 'a rubric result',
  'teacher-feedback': 'feedback from a teacher',
  'self-assessment': 'your own assessment of your work',
  'real-world': 'something that happened outside your studies',
};

const VERDICT_WORDS: Readonly<Record<'strong' | 'mixed' | 'gap', string>> = {
  strong: 'You were strong on this.',
  mixed: 'This came out mixed.',
  gap: 'This was a gap.',
};

// ------------------------------------------------------------ shared reads

interface Board {
  readonly input: NotebookInput;
  readonly labels: ReadonlyMap<TopicId, string>;
  readonly liveSignals: readonly Signal[];
  readonly comfortBy: ReadonlyMap<TopicId, NotebookComfort>;
  readonly reasonBy: ReadonlyMap<TopicId, string>;
  readonly areaBy: ReadonlyMap<TopicId, BoardArea>;
  /** The sessions the covered lines are read from, newest first. */
  readonly recent: readonly Session[];
  /** Every outcome that is still standing, newest first, already capped. */
  readonly outcomes: readonly LearningOutcome[];
  /** Every pin that is still in scope, newest first, already capped. */
  readonly pins: readonly Pin[];
}

function readBoard(input: NotebookInput): Board {
  // A correction supersedes rather than erases (`outcomes.ts`). The superseded
  // record is left out of the body and named on the one that replaced it: a
  // notebook that answered about a mark which was later corrected, as though
  // the correction had not happened, would be confidently wrong about the one
  // kind of evidence this product treats as reality.
  const superseded = new Set(
    input.outcomes.map((o) => o.supersedesId).filter((id): id is string => Boolean(id)),
  );
  // An invalidated signal is one the learner said was wrong (SB-45). It is
  // kept in the ledger and it is not evidence, so it is not described as
  // evidence here either.
  const liveSignals = input.signals.filter((s) => !s.invalidated);
  return {
    input,
    labels: new Map(input.topics.map((t) => [t.id, t.label])),
    // Read now, off the Gardener, for the topics the board holds. It is the
    // right answer for a board-state document and the WRONG one for a night
    // that already recorded its own; `reasonForSection` is where that is
    // decided rather than here.
    reasonBy: new Map(input.reasons.filter((r) => said(r.reason)).map((r) => [r.topicId, r.reason])),
    liveSignals,
    comfortBy: new Map(input.comforts.map((c) => [c.topicId, c])),
    areaBy: new Map(input.topics.map((t) => [t.id, boardAreaFor(t, liveSignals, input.now)])),
    recent: input.sessions.slice()
      .sort(newestFirst<Session>((s) => s.batchKey ?? s.builtAt))
      .slice(0, SESSION_WINDOW),
    outcomes: input.outcomes
      .filter((o) => !o.deletedAt)
      .filter((o) => !superseded.has(o.id))
      .filter((o) => daysBetween(o.recordedAt, input.now) <= OUTCOME_WINDOW_DAYS)
      .slice()
      .sort(newestFirst<LearningOutcome>((o) => o.recordedAt))
      .slice(0, MAX_OUTCOMES),
    pins: input.pins.slice()
      .sort(newestFirst<Pin>((p) => p.capturedAt))
      .slice(0, MAX_SOURCE_PINS),
  };
}

/** A topic's label, or an honest stand-in. Never an id in front of a learner:
 *  a raw identifier in a sentence is a leak of how the thing is built. */
const labelFor = (board: Board, id: TopicId | null | undefined): string =>
  (id && board.labels.get(id)) || 'something no longer on your board';

/** Which course a topic belongs to, when the board honestly knows. The join is
 *  `subjects.ts`'s join, not a second opinion about it. */
function subjectLine(board: Board, topicId: TopicId): string | null {
  const subject = subjectForTopic(topicId, board.input.courses, board.input.commitments);
  return subject ? `Part of: ${subject.title}.` : null;
}

/** What the reading was built from, as kinds and never as a tally. */
function evidenceLine(board: Board, topicId: TopicId): string | null {
  const kinds: string[] = [];
  for (const signal of board.liveSignals) {
    if (signal.topicId !== topicId) continue;
    // The learner-controlled lineup contract: the lineup's three marks say what the learner WANTS taught.
    // This sentence is "what I am going by", and taste is not something to go
    // by — the comfort reading it describes was computed without them.
    if (!isEvidence(signal)) continue;
    const words = EVIDENCE_WORDS[signal.type];
    if (words && !kinds.includes(words)) kinds.push(words);
  }
  if (!kinds.length) return null;
  kinds.sort(byText);
  const last = kinds.pop() as string;
  const listed = kinds.length ? `${kinds.join(', ')} and ${last}` : last;
  return `What I am going by: ${listed}.`;
}

/**
 * What has been taught on this topic, in the Composer's own recap sentences.
 *
 * The recap was written at composition time, by the pass that had the whole
 * session in hand. Reading it here rather than re-describing the section is the
 * same rule the reason line follows: the surface quotes what the run recorded,
 * so two surfaces cannot drift into two accounts of one night.
 */
function coveredLines(board: Board, topicId: TopicId): readonly string[] {
  const out: string[] = [];
  for (const session of board.recent) {
    for (const section of session.sections) {
      if (section.topicId !== topicId) continue;
      const what = said(section.recap) ? section.recap as string : section.heading;
      out.push(bullet(`${day(session.batchKey ?? session.builtAt)}: ${what}`));
      if (out.length >= MAX_TOPIC_COVERED) return out;
    }
  }
  return out;
}

/** Which of the standing results touch this topic, newest first. Overall and
 *  by criterion both count: a rubric line naming a topic is a result about it. */
function outcomesFor(board: Board, topicId: TopicId): readonly LearningOutcome[] {
  return board.outcomes
    .filter((o) => o.topicIds.includes(topicId)
      || o.criteria.some((c) => c.topicIds.includes(topicId)))
    .slice(0, MAX_TOPIC_RESULTS);
}

/** The dated work that leans on this topic and is still open. */
function commitmentsFor(board: Board, topicId: TopicId): readonly Commitment[] {
  return board.input.commitments
    .filter((c) => !c.doneAt && c.topicIds.includes(topicId))
    .slice()
    .sort((a, b) => byText(a.dueAt, b.dueAt) || byText(a.id, b.id))
    .slice(0, MAX_TOPIC_COMMITMENTS);
}

// ============================================================== document 1

const LEARN_NOW_TITLE = 'Virgil: learn now';

const LEARN_NOW_USE = [
  'Use this as the learner\'s current Virgil lesson.',
  'Help them understand, test, or continue it using the exact lesson and cited sources here.',
  'When there is a practice question, let the learner answer before you explain it.',
  'Do not infer that they read, understood, completed, or mastered anything unless this source says so.',
] as const;

const LEARN_NOW_WHAT =
  'This document holds the one lesson I have ready for you right now: what it says, where it came '
  + 'from, where it sits on your board, and what it asks you to do. I rewrite it when you send a '
  + 'lesson over, and again whenever I build you a new session.';

/**
 * The lesson in front of the learner, and how it is chosen.
 *
 * The session is the newest one the board holds, and the section is the one the
 * store says they are on. Both facts come off the store rather than off
 * whatever surface asked for the write: a panel that told the service which
 * lesson it was showing would be a second opinion about a thing the store
 * already knows, and the two would differ on exactly the tap where somebody had
 * two panels open.
 *
 * `currentSectionIndex` equals `sections.length` on a finished session, which
 * is not an error and is not rounded down to the last section: a finished
 * session has no lesson in front of anybody, and saying so is the honest
 * answer.
 */
function currentSection(session: Session | null): SessionSection | null {
  if (!session) return null;
  return session.sections[session.currentSectionIndex] ?? null;
}

function learnNowBody(board: Board): string {
  const { input } = board;
  const body = preamble(
    new Body(), LEARN_NOW_TITLE, LEARN_NOW_USE, LEARN_NOW_WHAT, input.now, input.timeZone,
  );

  const session = board.recent[0] ?? null;
  const section = currentSection(session);

  if (!session) {
    body.say('There is no lesson waiting for you at the moment. I build them from what you save, '
      + 'so the way to get one is to save a few things and let me work through them.');
    return body.render();
  }
  if (!session.sections.length) {
    // A night that composed sections and withheld every one of them is the
    // safety check working, and the standing rule is that the surface names it
    // rather than being embarrassed by it. Falling through to "there is no
    // lesson" here would have been the one place this document could hide the
    // fact that something was written and refused.
    body.head(2, 'There is nothing in front of you from this session');
    body.say('I built you a session and there is nothing in it I can put in front of you.');
    body.list(sessionFacts(session));
    withheldInto(body, board, session);
    return body.render();
  }
  if (!section) {
    body.head(2, 'You are at the end of this session');
    body.say('You have worked through everything I built for this one. There is nothing in front '
      + 'of you until I build the next session, and what you have already covered is in the '
      + 'document about your board.');
    body.list(sessionFacts(session));
    withheldInto(body, board, session);
    return body.render();
  }

  // ------ the lesson itself
  body.head(2, 'The lesson in front of you');
  body.head(3, section.heading);

  const facts: string[] = [bullet(`This is about: ${labelFor(board, section.topicId)}.`)];
  const subject = subjectLine(board, section.topicId);
  if (subject) facts.push(bullet(subject));
  const area = board.areaBy.get(section.topicId);
  if (area) facts.push(bullet(`Where it sits on your board: ${AREA_HEADINGS[area]}.`));
  facts.push(bullet(`I wrote it ${REGISTER_WORDS[section.depth]}.`));
  facts.push(bullet(`About ${section.estimatedMinutes} minutes.`));
  const why = reasonForSection(board, section);
  if (why) facts.push(bullet(`Why I chose it: ${why}`));
  body.list(facts);

  if (area) body.say(AREA_WORDS[area]);
  if (said(section.summary)) body.say(`What it covers: ${section.summary as string}`);
  if (said(section.body)) body.quote(section.body);

  // ------ what it asks
  body.head(3, 'What this one asks you to do');
  if (section.question) {
    body.say(section.question.prompt);
    /*
     * `expectedPoints` is the marking scheme and it stays here. It is the list
     * an answer is checked against, and a document in a chat notebook is
     * exactly the place a learner would meet it before they had answered
     * anything. Handing somebody the mark scheme is not teaching them, and it
     * would quietly make every answer signal after it worthless as evidence.
     */
    if (section.question.kind === 'recall') {
      body.say('This one is a recall check, so answer it from memory before you go looking.');
    }
  } else {
    body.say('There is nothing to answer in this one. Read it, and the next one will ask you '
      + 'something.');
  }
  if (said(section.mediumWarning)) {
    body.say(`Reading will not close this one. ${section.mediumWarning as string}`);
  }
  if (section.completed) body.say('You have already worked through this one.');
  if (section.contested) {
    body.say('You told me the marking on this was wrong, and I withdrew what I had read into it. '
      + 'Nothing here counts against you.');
  }

  // ------ where it came from
  body.head(2, 'Where this lesson came from');
  const sources = lessonSources(board, section);
  if (!sources.length) {
    body.say('I could not trace this one back to a page you saved. That is worth knowing before '
      + 'you rely on it.');
  } else {
    body.say('These are the pages behind this lesson. Every link goes back to where it came from, '
      + 'and to the exact page or moment where I could work one out.');
    for (const source of sources) {
      if (source.pin) pinInto(body, source.pin);
      else foundInto(body, source.record as SourceRecord);
    }
  }

  // ------ the rest of the session
  const rest = session.sections
    .slice(session.currentSectionIndex + 1)
    .slice(0, MAX_LESSON_LINEUP);
  if (rest.length) {
    body.head(2, 'What comes after it in this session');
    body.list(rest.map((s) => bullet(
      `${s.heading}. About ${labelFor(board, s.topicId)}, about ${s.estimatedMinutes} minutes.`,
    )));
  }

  body.head(2, 'The session this belongs to');
  body.list(sessionFacts(session));
  if (said(session.closingNote)) {
    body.say('How I closed it:');
    body.quote(session.closingNote as string);
  }
  withheldInto(body, board, session);

  return body.render();
}

/**
 * A section's source ids, turned back into the pages behind them.
 *
 * Two kinds of id exist and both are minted by the composer's resolver:
 * `<pinId>:origin` is the page the learner saved, and an enrichment reference's
 * own id is something the Forager went and found. The index is built over the
 * whole board rather than over this topic's pins, exactly as the service's own
 * provenance surface builds it, so an id borrowed from a neighbouring section
 * still resolves to a real page.
 *
 * An id that matches nothing is dropped without comment here, because this
 * document is not the provenance surface: the panel counts what it could not
 * trace, and a notebook that reported a dead internal reference would be
 * reporting a fact about Virgil's plumbing to somebody who cannot act on it.
 */
function lessonSources(
  board: Board, section: SessionSection,
): readonly { readonly pin: Pin | null; readonly record: SourceRecord | null }[] {
  const pins = new Map<string, Pin>();
  const found = new Map<string, SourceRecord>();
  for (const pin of board.input.pins) {
    pins.set(`${pin.id}:origin`, pin);
    for (const reference of pin.enrichment?.references ?? []) {
      // A reference the Forager attributed to the pin itself is attribution and
      // not a second record of the page. The pin is the better answer, and it
      // is already in hand.
      if (pins.has(reference.id) || found.has(reference.id)) continue;
      found.set(reference.id, reference);
    }
  }
  const out: { pin: Pin | null; record: SourceRecord | null }[] = [];
  const seen = new Set<string>();
  for (const id of section.sourceIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const pin = pins.get(id) ?? null;
    const record = pin ? null : found.get(id) ?? null;
    if (!pin && !record) continue;
    out.push({ pin, record });
    if (out.length >= MAX_LESSON_SOURCES) break;
  }
  return out;
}

/** A page Virgil went and found, said as one. It is not the learner's own
 *  saved page and it is never described as though it were. */
function foundInto(body: Body, record: SourceRecord): void {
  body.head(3, said(record.title) ? record.title as string : 'Something I went and found');
  const facts: string[] = [
    bullet('I went and found this one while I was reading around what you saved.'),
  ];
  if (record.retrievedAt) facts.push(bullet(`I read it on ${day(record.retrievedAt)}.`));
  if (record.url && isOpenableUrl(record.url)) {
    facts.push(bullet(`Open it: ${link(record.url, record.url)}`));
  }
  body.list(facts);
}

/**
 * Why this section was in that night's lineup — the stored reason first.
 *
 * **The recorded divergence this repairs.** `runner/src/notebook-export.ts`
 * recomputes `tend()` at export time, which is right for a document about the
 * board as it stands now. It is wrong for a document about a night that has
 * already happened. Under the learner-controlled lineup contract, a session carries each section's `why`,
 * written by the run that ranked it, and `GET /session` reads
 * `sec.why ?? reasons.get(sec.topicId) ?? null` — stored first, fresh only as a
 * fallback for sessions composed before the field existed.
 *
 * Without this precedence the two surfaces drift apart on exactly the night
 * somebody asks: the panel quotes the reason the run ranked on, and an export
 * three days later quotes whatever the Gardener would say about that topic
 * *today*, after three days of new evidence moved it. Both are honest and they
 * are not the same sentence, and **the notebook and the panel telling different
 * stories about one night is the failure this whole seam cannot afford**,
 * because a chat assistant grounded in the document will state its version with
 * every appearance of authority.
 *
 * So the precedence here is the panel's precedence, character for character.
 * The board document keeps the fresh read, because a topic that is not in any
 * session has no stored counterpart and today's reason is the only reason there
 * is.
 */
function reasonForSection(board: Board, section: SessionSection): string | null {
  if (said(section.why)) return section.why as string;
  return board.reasonBy.get(section.topicId) ?? null;
}

function sessionFacts(session: Session): readonly string[] {
  const out: string[] = [
    // SB-18's own copy: the background work has to be legible or it may as well
    // not have happened.
    bullet(`Built on ${day(session.batchKey ?? session.builtAt)}, from `
      + `${session.fromPinCount} ${session.fromPinCount === 1 ? 'thing' : 'things'} you saved.`),
    bullet(`About ${session.estimatedMinutes} minutes in total.`),
  ];
  if (session.revision) {
    out.push(bullet('This was a short refresher rather than a full session, '
      + 'because there was not enough new material for one.'));
  }
  return out;
}

/**
 * What the check refused, said out loud.
 *
 * A night that composed four sections and withheld all four is the safety check
 * working, and the product's standing rule is that the surface names it rather
 * than being embarrassed by it. A notebook that quietly held only what passed
 * would be a more confident notebook than the product it came from.
 */
function withheldInto(body: Body, board: Board, session: Session): void {
  const withheld = session.withheld ?? [];
  if (!withheld.length) return;
  body.head(3, 'What I held back');
  body.list(withheld.map((w) => bullet(
    w.reason === 'defective'
      ? `I wrote something on ${labelFor(board, w.topicId)} and my own check found a `
        + `real problem with it, so I did not teach it to you.`
      : `I wrote something on ${labelFor(board, w.topicId)} and my check could not run `
        + `on it at all, so I did not teach it to you. That is not the same as it being wrong.`,
  )));
}

// ============================================================== document 2

const BOARD_TITLE = 'Virgil: on the board';

const BOARD_USE = [
  'Use this to help the learner choose what to study and answer questions about their current work.',
  'Keep each topic\'s board position, results, saved pages, and upcoming work together.',
  'Separate what the learner said or did from what Virgil inferred.',
  'Do not invent progress, ability, confidence, completion, or mastery.',
] as const;

const BOARD_WHAT =
  'This document holds everything you are carrying right now, one topic at a time. Under each '
  + 'topic you will find where it sits, what I am going by, what your results said about it, the '
  + 'pages you saved for it, and what is coming up on it. Each topic is written in one place so '
  + 'that you can ask which one to work on without reading four documents.';

function boardBody(board: Board): string {
  const { input } = board;
  const body = preamble(
    new Body(), BOARD_TITLE, BOARD_USE, BOARD_WHAT, input.now, input.timeZone,
  );

  // ------ the learner model, first, because it is the best thing in the set
  body.head(2, 'What I have come to believe about how you learn');
  /**
   * What may leave the board as a claim about this person.
   *
   * A rejected read is an invisible evidence receipt rather than a sentence,
   * and an unanswered modality question is a question (SB-282). Neither is
   * something the learner has agreed is true of them, and this document goes to
   * another tool under the heading *what I have come to believe about how you
   * learn*. A handover is exactly where an unconfirmed claim would harden into
   * a fact nobody could trace back.
   */
  const statements = input.statements
    .filter((s) => !s.rejected && !isUnansweredModality(s))
    .sort(newestFirst<Statement>((s) => s.updatedAt));
  if (!statements.length) {
    body.say('I have not written anything about how you learn yet. '
      + 'It takes a few sessions of watching what you actually do before I have '
      + 'anything worth saying, and I would rather say nothing than guess.');
  } else {
    body.say('These are my own sentences about you, built from what you have done '
      + 'rather than from what anybody declared. You can edit or delete any of them in Virgil.');
    for (const s of statements) {
      const about = s.topicId ? ` (about ${labelFor(board, s.topicId)})` : '';
      const mine = s.userEdited ? ' You rewrote this one yourself, so it is your wording.' : '';
      body.say(`${s.text}${about}.${mine}`);
    }
  }

  // ------ the topics themselves, each one whole
  body.head(2, 'Where each topic stands');
  const live = topicsIn(board, LIVE_AREAS, MAX_BOARD_TOPICS);
  if (!live.total) {
    body.say('There is nothing live on your board at the moment, so I have nothing to tell you '
      + 'about here. Save something you are reading and I will start from there.');
  } else {
    body.say('I never score any of this and there is no number anywhere in it. '
      + 'Everything I know about one topic is written under that topic, so you can read one '
      + 'heading and have the whole of it.');
    truncationLine(body, live.total, MAX_BOARD_TOPICS);
    for (const area of LIVE_AREAS) {
      const group = live.byArea.get(area) ?? [];
      if (!group.length) continue;
      body.head(3, AREA_HEADINGS[area]);
      for (const topic of group) topicInto(body, board, topic, area);
    }
  }

  // ------ the dated work, whole, because a deadline is not about one topic
  body.head(2, 'What you are on the hook for');
  datedWorkInto(body, board);

  // ------ courses, because a topic knows its course and a course knows more
  body.head(2, 'Your courses');
  coursesInto(body, board);

  // ------ results with nowhere to sit, so no mark is ever silently dropped
  const homeless = board.outcomes.filter((o) => !outcomeTouchesLive(board, o));
  if (homeless.length) {
    body.head(2, 'Other results you recorded');
    body.say('These did not attach to anything live on your board, and I am keeping them here '
      + 'rather than dropping them. I report each mark exactly as it was given to you, and I '
      + 'never average them, trend them or turn them into a score of my own.');
    for (const outcome of homeless) outcomeInto(body, board, outcome, 3);
  }

  // ------ the pages that have not been placed yet
  const loose = board.pins.filter((p) => !p.topicId);
  if (loose.length) {
    body.head(2, 'Saved pages I have not filed under a topic yet');
    body.say('I have not worked out what these belong with. That usually means '
      + 'they are new, or that there is not enough around them yet to place them.');
    for (const pin of loose.slice(0, MAX_SOURCE_PINS)) pinInto(body, pin);
  }

  return body.render();
}

/** Does this result say anything about a topic that is live on the board. */
function outcomeTouchesLive(board: Board, outcome: LearningOutcome): boolean {
  const ids = [...outcome.topicIds, ...outcome.criteria.flatMap((c) => [...c.topicIds])];
  return ids.some((id) => {
    const area = board.areaBy.get(id);
    return area ? LIVE_AREAS.includes(area) : false;
  });
}

/**
 * The topics in a set of areas, capped, grouped, and honest about the cap.
 *
 * Selection is by recency so that a board over the cap keeps what somebody is
 * actually touching; rendering is by label inside each area so that the
 * document reads the way the board reads. Both orders are total and neither
 * asks the environment anything.
 */
function topicsIn(board: Board, areas: readonly BoardArea[], cap: number): {
  readonly byArea: ReadonlyMap<BoardArea, readonly Topic[]>;
  readonly total: number;
} {
  const all = board.input.topics.filter((t) => {
    const area = board.areaBy.get(t.id);
    return area ? areas.includes(area) : false;
  });
  const kept = all.slice()
    .sort((a, b) => byText(b.lastExposedAt ?? b.createdAt, a.lastExposedAt ?? a.createdAt)
      || byText(a.id, b.id))
    .slice(0, cap);
  const byArea = new Map<BoardArea, Topic[]>();
  for (const topic of kept) {
    const area = board.areaBy.get(topic.id) as BoardArea;
    const bucket = byArea.get(area) ?? [];
    bucket.push(topic);
    byArea.set(area, bucket);
  }
  for (const bucket of byArea.values()) {
    bucket.sort((a, b) => byText(a.label, b.label) || byText(a.id, b.id));
  }
  return { byArea, total: all.length };
}

/** A truncation nobody is told about is a document quietly disagreeing with the
 *  board it describes. Said once, at the top, and only when it bites. */
function truncationLine(body: Body, total: number, cap: number): void {
  if (total <= cap) return;
  body.say(`You have ${total} of these. I am writing out the ${cap} you have touched most `
    + 'recently, so that this document stays readable. The rest are still on your board in Virgil.');
}

/** One topic, whole, under one heading. The adjacency is the point. */
function topicInto(body: Body, board: Board, topic: Topic, area: BoardArea): void {
  body.head(4, topic.label);
  if (said(topic.summary)) body.quote(topic.summary);
  body.say(AREA_WORDS[area]);

  const subject = subjectLine(board, topic.id);
  if (subject) body.say(subject);

  const comfort = board.comfortBy.get(topic.id);
  const evidence = evidenceLine(board, topic.id);
  if (evidence) body.say(evidence);

  if (comfort?.regressed) {
    body.say('This had settled, and something recent has undercut it. '
      + 'That is why it is back in front of you.');
  }
  if (!comfort || comfort.evidenceCount === 0) {
    body.say('I have nothing to go on here beyond the fact that it is on your board, '
      + 'so treat anything I say about it as a guess.');
  } else if (comfort.certainty < THIN_CERTAINTY) {
    body.say('I have very little to go on here, so take this one lightly.');
  }
  if (topic.lastExposedAt) {
    body.say(`I last taught you something on this on ${day(topic.lastExposedAt)}.`);
  } else {
    body.say('I have not taught you anything on this yet.');
  }
  const reason = board.reasonBy.get(topic.id);
  if (reason) body.say(`Why it is in front of you: ${reason}`);

  const covered = coveredLines(board, topic.id);
  if (covered.length) {
    body.say('What I have covered with you on this:');
    body.list(covered);
  }

  const results = outcomesFor(board, topic.id);
  if (results.length) {
    body.say('What your results said about this:');
    body.list(results.map((o) => bullet(resultSummary(o))));
  }

  const coming = commitmentsFor(board, topic.id);
  if (coming.length) {
    body.say('What is coming up on this:');
    for (const c of coming) body.list(commitmentLines(board, c));
  }

  const saved = board.pins.filter((p) => p.topicId === topic.id).slice(0, MAX_TOPIC_SOURCES);
  if (saved.length) {
    body.say('The pages you saved for this:');
    for (const pin of saved) pinInto(body, pin, 5);
  }
}

/** One result in one line, for a topic that is already the heading above it.
 *  The mark, exactly as awarded, and never a verdict of Virgil's own. */
function resultSummary(outcome: LearningOutcome): string {
  const parts = [`${outcome.title}. This was ${OUTCOME_WORDS[outcome.kind]}, recorded on `
    + `${day(outcome.recordedAt)}`];
  if (typeof outcome.score === 'number' && typeof outcome.maxScore === 'number') {
    parts.push(`The mark you were given: ${outcome.score} out of ${outcome.maxScore}`);
  }
  return `${parts.join('. ')}.`;
}

// ------------------------------------------------- the dated work and courses

function datedWorkInto(body: Body, board: Board): void {
  const { input } = board;
  const now = input.now;
  const open = input.commitments.filter((c) => !c.doneAt);
  const closed = input.commitments.filter(
    (c) => c.doneAt && daysBetween(c.doneAt, now) <= CLOSED_COMMITMENT_DAYS,
  );

  if (!open.length && !closed.length) {
    body.say('You have not told me about anything you are on the hook for. '
      + 'Deadlines you give me change what I teach you first, so they are worth adding.');
    return;
  }

  /*
   * `late` is the internal state name and 'Past their date' is what the product
   * says out loud. Every Plan surface refuses the punitive register on purpose —
   * a card past its deadline reads "was due", the strip above it reads "This is
   * still open past its date", and a sweep of that room for
   * overdue/late/behind/missed finds nothing. This document goes into the
   * learner's own notebook, so it was the one place in the product where the
   * word arrived as a heading, which is the loudest position it could have had.
   */
  for (const [state, heading] of [
    ['late', 'Past their date'], ['today', 'Due today'], ['soon', 'Due soon'], ['later', 'Later'],
  ] as const) {
    const group = open
      .filter((c) => commitmentState(c, now, input.timeZone ?? 'UTC') === state)
      .sort((a, b) => byText(a.dueAt, b.dueAt) || byText(a.id, b.id));
    if (!group.length) continue;
    body.head(3, heading);
    for (const c of group) body.list(commitmentLines(board, c));
  }

  if (closed.length) {
    body.head(3, 'Closed in the last month');
    body.list(closed
      .slice()
      .sort(newestFirst<Commitment>((c) => c.doneAt ?? ''))
      .map((c) => bullet(`${c.title}. You closed it on ${day(c.doneAt as string)}.`)));
  }
}

function coursesInto(body: Body, board: Board): void {
  const { input } = board;
  const settled = new Set(input.topics.filter((t) => t.state === 'settled').map((t) => t.id));
  const courses = input.courses
    .filter((c) => !c.archivedAt)
    .slice()
    .sort((a, b) => byText(a.title, b.title) || byText(a.id, b.id));

  if (!courses.length) {
    body.say('You have not put any courses on the board yet. '
      + 'When you add one I will keep its material and its progress here.');
    return;
  }
  for (const course of courses) {
    body.head(3, course.title);
    // Omitted rather than filled in with an absence. "Where it is from: you did
    // not say." is a line whose whole content is a thing the learner failed to
    // do, printed in a document that otherwise never asks anything of them —
    // and the field is optional, so there was nothing to fail at.
    if (said(course.provider)) body.say(`Where it is from: ${course.provider}.`);
    if (isOpenableUrl(course.url)) body.say(`The course itself: ${link(course.title, course.url)}`);

    // Two counts, never a percentage (`courses.ts`). They are two different
    // claims and collapsing them would let the weaker borrow the stronger's
    // authority.
    const progress = courseProgress(course, settled);
    body.list([
      bullet(`Material you have marked done: ${progress.covered} of ${progress.materialCount}.`),
      bullet(`Topics out of this course that the board calls learnt: `
        + `${progress.learnt} of ${progress.topicCount}.`),
    ]);

    if (course.objectives?.length) {
      body.say('What it says you should come out able to do:');
      body.list(course.objectives.map((o) => bullet(o.text)));
    }

    const material = course.material.slice()
      .sort((a, b) => byText(a.addedAt, b.addedAt) || byText(a.id, b.id));
    for (const kind of MATERIAL_ORDER) {
      const group = material.filter((m) => m.kind === kind);
      // Empty groups are omitted, as everywhere else this product groups.
      if (!group.length) continue;
      body.head(4, MATERIAL_HEADINGS[kind]);
      body.list(group.map((m) => bullet(materialLine(m))));
    }
    if (!material.length) body.say('There is no material on this course yet.');
  }
}

function materialLine(m: Material): string {
  const parts = [link(m.title, m.url)];
  if (typeof m.minutes === 'number' && m.minutes > 0) parts.push(`About ${m.minutes} minutes`);
  // Marking is the learner's, always, and a lecture in a hall leaves no trace
  // Virgil can see. So the honest line names who said so rather than reporting
  // it as though the product had observed anything.
  parts.push(m.doneAt ? `You marked this done on ${day(m.doneAt)}` : 'You have not marked this done');
  return `${parts.join('. ')}.`;
}

function commitmentLines(board: Board, c: Commitment): readonly string[] {
  const deadline = hasTimedDeadline(c)
    ? `${deadlineDay(c)} at ${c.dueTime} ${c.dueTimeZone}`
    : deadlineDay(c);
  const out: string[] = [bullet(`${c.title}. This is ${KIND_WORDS[c.kind]}, due on ${deadline}.`)];
  if (c.plannedFor) {
    out.push(`  You told me you would do it on ${day(c.plannedFor)}.`);
  }
  if (typeof c.estimateMinutes === 'number' && c.estimateMinutes > 0) {
    out.push(`  You reckoned about ${c.estimateMinutes} minutes.`);
  }
  if (c.topicIds.length) {
    const names = c.topicIds.map((id) => labelFor(board, id)).sort(byText);
    out.push(`  It leans on: ${names.join(', ')}.`);
  }
  if (said(c.notes)) out.push(`  Your note: ${c.notes}`);
  return out;
}

// ------------------------------------------------------------ one result

/** A result in full, for the places that have room for one. */
function outcomeInto(body: Body, board: Board, outcome: LearningOutcome, level: number): void {
  body.head(level, outcome.title);
  body.list(outcomeFacts(outcome, board));

  if (said(outcome.summary)) {
    body.say('What it said:');
    body.quote(outcome.summary);
  }
  if (said(outcome.feedback)) {
    body.say('The feedback:');
    body.quote(outcome.feedback);
  }

  if (outcome.criteria.length) {
    body.say('Criterion by criterion:');
    for (const criterion of outcome.criteria) body.list(criterionLines(board, criterion));
  }

  const seeds = outcomeSignalSeeds(outcome);
  body.say('What it changed on your board:');
  if (!seeds.length && outcome.kind === 'self-assessment') {
    body.say('Nothing. Your own assessment of your work is useful context and I keep it, '
      + 'but I do not treat it as marked evidence, so it does not move anything.');
  } else if (!seeds.length) {
    body.say('Nothing. There was nothing in this specific enough for me to attach '
      + 'to a topic without inventing a reading.');
  } else {
    body.list(seeds.map((seed) => bullet(
      `${labelFor(board, seed.topicId)}: I recorded this as `
      + `${seed.direction === 'positive' ? 'strong evidence' : 'a gap'}.`,
    )));
  }
}

function outcomeFacts(outcome: LearningOutcome, board: Board): readonly string[] {
  const courses = new Map(board.input.courses.map((c) => [c.id, c.title]));
  const commitments = new Map(board.input.commitments.map((c) => [c.id, c.title]));
  const out: string[] = [
    bullet(`What it was: ${OUTCOME_WORDS[outcome.kind]}.`),
    bullet(`You recorded it on ${day(outcome.recordedAt)}.`),
  ];
  const course = outcome.courseId ? courses.get(outcome.courseId) : null;
  if (course) out.push(bullet(`It belongs to the course: ${course}.`));
  const commitment = outcome.commitmentId ? commitments.get(outcome.commitmentId) : null;
  if (commitment) out.push(bullet(`It was for: ${commitment}.`));
  // The real mark, exactly as awarded. Suppressing it would be a comfortable
  // lie in the other direction, and it is the one number in this whole export
  // that somebody else decided.
  if (typeof outcome.score === 'number' && typeof outcome.maxScore === 'number') {
    out.push(bullet(`The mark you were given: ${outcome.score} out of ${outcome.maxScore}.`));
  }
  if (outcome.supersedesId) {
    out.push(bullet('This replaced an earlier record of the same work, '
      + 'so it is the one that counts.'));
  }
  return out;
}

function criterionLines(board: Board, c: CriterionOutcome): readonly string[] {
  const verdict = c.verdict ? VERDICT_WORDS[c.verdict] : 'Nobody put a verdict on this one.';
  const out: string[] = [bullet(`${c.label}. ${verdict}`)];
  if (typeof c.score === 'number' && typeof c.maxScore === 'number') {
    out.push(`  Marked ${c.score} out of ${c.maxScore}.`);
  }
  if (said(c.feedback)) out.push(`  What it said: ${c.feedback}`);
  if (c.topicIds.length) {
    const names = c.topicIds.map((id) => labelFor(board, id)).sort(byText);
    out.push(`  On your board this touches: ${names.join(', ')}.`);
  }
  return out;
}

// ------------------------------------------------------------- one saved page

function pinInto(body: Body, pin: Pin, level = 3): void {
  const envelope = pin.envelope;
  const heading = said(envelope.pageTitle) ? envelope.pageTitle
    : said(pin.label) ? (pin.label as string)
      : 'Something you saved';
  body.head(level, heading);

  const facts: string[] = [];
  facts.push(bullet(pin.type === 'struggle'
    ? 'You saved this because it was giving you trouble.'
    : 'You saved this because it interested you.'));
  facts.push(bullet(`Saved on ${day(pin.capturedAt)}.`));
  if (said(envelope.siteName)) facts.push(bullet(`From: ${envelope.siteName}.`));
  if (envelope.headingPath.length) {
    facts.push(bullet(`Where on the page: ${envelope.headingPath.join(' > ')}.`));
  }

  // The deepest honest link, and only where the convention is real. `momentHref`
  // and `pdfPageHref` both answer null rather than guess, so the fallback is the
  // page itself and never a fragment nobody reads.
  const deep = momentHref(envelope.url, envelope.videoMoment)
    ?? pdfPageHref(envelope.url, envelope.pdfPage);
  if (deep) {
    facts.push(bullet(`Open it where you were: ${link('the exact place', deep)}`));
  } else if (isOpenableUrl(envelope.url)) {
    facts.push(bullet(`Open it: ${link(envelope.canonicalUrl ?? envelope.url, envelope.url)}`));
  }
  body.list(facts);

  if (said(pin.note)) {
    body.say(`Why you saved it, in your words: ${pin.note}`);
  }
  if (said(envelope.selection)) {
    const text = envelope.selection as string;
    const quoted = text.length > MAX_QUOTED_SELECTION
      ? `${text.slice(0, MAX_QUOTED_SELECTION)}...`
      : text;
    body.say('What you had selected:');
    body.quote(quoted);
  }
  for (const part of envelope.parts) {
    if (said(part.text)) body.say(`${part.role.replace(/-/g, ' ')}: ${part.text}`);
  }
  if (pin.enrichment?.confidence === 'reduced') {
    body.say('I could not read this page properly from outside your browser, '
      + 'so what I know about it is only what you had on screen at the time.');
  }
  if (pin.enrichment?.assumedConcepts.length) {
    body.say(`This leans on things it does not explain: `
      + `${pin.enrichment.assumedConcepts.slice().sort(byText).join(', ')}.`);
  }
}

// ============================================================== document 3

const ARCHIVE_TITLE = 'Virgil: archive';

const ARCHIVE_USE = [
  'Use this to find and resume learning the learner previously paused or finished.',
  'When they revisit something, summarise what was covered and suggest a re-entry point grounded here.',
  'Treat paused as put down, not failed, and learnt as prior evidence, not permanent mastery.',
  'If this source does not support an answer, say so instead of filling the gap.',
] as const;

const ARCHIVE_WHAT =
  'This document holds the subjects you have held and have not removed: what was covered on each '
  + 'one, when you last touched it, and where it landed. It is here so that you can pick up '
  + 'something older without going looking for it.';

function archiveBody(board: Board): string {
  const body = preamble(
    new Body(), ARCHIVE_TITLE, ARCHIVE_USE, ARCHIVE_WHAT,
    board.input.now, board.input.timeZone,
  );

  const held = topicsIn(board, ARCHIVE_AREAS, MAX_ARCHIVE_SUBJECTS);
  if (!held.total) {
    body.say('There is nothing in here yet. A subject arrives when you put it down or when you '
      + 'have it, and nothing you have had is ever removed from here unless you remove it '
      + 'yourself.');
    return body.render();
  }

  body.say('Nothing here is finished with you. A subject you put down is yours to pick back up, '
    + 'and one you have is worth a check now and then so that it does not slip away.');
  truncationLine(body, held.total, MAX_ARCHIVE_SUBJECTS);

  for (const area of ARCHIVE_AREAS) {
    const group = held.byArea.get(area) ?? [];
    if (!group.length) continue;
    body.head(2, AREA_HEADINGS[area]);
    for (const topic of group) archiveInto(body, board, topic, area);
  }

  return body.render();
}

/** One subject, in the three facts somebody picking it up again is asking for:
 *  what was covered, when it was last touched, and where it landed. */
function archiveInto(body: Body, board: Board, topic: Topic, area: BoardArea): void {
  body.head(3, topic.label);
  if (said(topic.summary)) body.quote(topic.summary);
  body.say(AREA_WORDS[area]);

  const subject = subjectLine(board, topic.id);
  if (subject) body.say(subject);

  if (topic.lastExposedAt) {
    body.say(`You last touched this on ${day(topic.lastExposedAt)}.`);
  } else {
    body.say('I never taught you anything on this one.');
  }

  const covered = coveredLines(board, topic.id);
  if (covered.length) {
    body.say('What was covered:');
    body.list(covered);
  }

  const results = outcomesFor(board, topic.id);
  if (results.length) {
    body.say('Where it landed:');
    body.list(results.map((o) => bullet(resultSummary(o))));
  } else {
    body.say('Nothing was ever marked on this one, so where it landed is my own reading of it '
      + 'rather than a mark anybody gave you.');
  }

  const evidence = evidenceLine(board, topic.id);
  if (evidence) body.say(evidence);

  const saved = board.pins.filter((p) => p.topicId === topic.id).slice(0, MAX_TOPIC_SOURCES);
  if (saved.length) {
    body.say('The pages you saved for this:');
    body.list(saved.map((p) => bullet(savedPageLine(p))));
  }

  if (area === 'paused') {
    body.say('If you want it back, take it off pause in Virgil and I will start planning it again.');
  }
}

/** One saved page in one line. The archive names the page and the way back to
 *  it, and leaves the selections and the notes to the board document, because a
 *  subject somebody put down six months ago does not need reproducing. */
function savedPageLine(pin: Pin): string {
  const envelope = pin.envelope;
  const title = said(envelope.pageTitle) ? envelope.pageTitle
    : said(pin.label) ? (pin.label as string)
      : 'Something you saved';
  const deep = momentHref(envelope.url, envelope.videoMoment)
    ?? pdfPageHref(envelope.url, envelope.pdfPage);
  const target = deep ?? envelope.url;
  return `${link(title, target)}. Saved on ${day(pin.capturedAt)}.`;
}

// ================================================================= the set

const BUILDERS: Readonly<Record<NotebookDocKey, {
  readonly title: string;
  readonly build: (board: Board) => string;
}>> = {
  'learn-now': { title: LEARN_NOW_TITLE, build: learnNowBody },
  'on-the-board': { title: BOARD_TITLE, build: boardBody },
  archive: { title: ARCHIVE_TITLE, build: archiveBody },
};

/** Always returns all three deterministic documents, including honest empties. */
export function notebookDocs(input: NotebookInput): readonly NotebookDoc[] {
  const board = readBoard(input);
  return (Object.keys(BUILDERS) as NotebookDocKey[]).map((key) => ({
    key,
    title: BUILDERS[key].title,
    body: BUILDERS[key].build(board),
  }));
}

/** One document, for a caller that wants exactly one. Same inputs, same bytes.
 *  This is what the lesson's push door writes: one key, one document, and the
 *  other two left exactly as the last write left them. */
export function notebookDoc(key: NotebookDocKey, input: NotebookInput): NotebookDoc {
  return { key, title: BUILDERS[key].title, body: BUILDERS[key].build(readBoard(input)) };
}

/** The titles, without building anything. For a setup screen that has to list
 *  what the learner is about to add to their notebook. */
export const notebookDocTitle = (key: NotebookDocKey): string => BUILDERS[key].title;
