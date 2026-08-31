import type {
  DepthRegister, Pin, SessionQuestion, SourceId, Topic, TopicId,
} from '../domain/types.js';
import type { Store } from '../ports/store.js';
import { computeComfort, type ComfortResult } from '../agents/registrar.js';
import {
  LEARNER_ACTION_MINUTES, REVISION_MINUTES, budgetForMaterial, materialWordsFor,
  offeredSourceIdsFor, pinMaterialWords, plannedLearnerActions, sectionMinutes,
  registerFor, wordBudgets,
} from '../agents/composer.js';
import { REVISION_TOPICS } from '../agents/gardener.js';
import { PINNED_TAG } from '../agents/untrusted.js';
import { withheldTopicsNamedIn } from '../domain/closing-note.js';
import { isUnansweredModality } from '../domain/modality.js';

/**
 * SESSION SCORE — the instrument, not the product.
 *
 * The binding constraint on this project is iteration cycles on session
 * quality: today a prompt change is judged by a human rereading a transcript,
 * which is slow, unrepeatable, and exactly the thing that will not scale across
 * 33 proposals and a port to a different model family. This module makes the
 * DETERMINISTIC HALF of that judgement mechanical, so a human re-eval spends
 * its attention on the half a machine genuinely cannot do.
 *
 * Two kinds of number come out, and conflating them would be the whole failure
 * mode of an instrument like this:
 *
 *  - **hard** — a CONTRACT. Something the code, the schema or a stated rule in
 *    a system prompt promises, that can be checked without judgement. A failing
 *    hard check is a defect, and the CLI exits non-zero on one.
 *  - **proxy** — a SIGNAL. A measurable correlate of something only a reader
 *    can actually judge: whether a from-nothing section reads as one, whether
 *    the difficulty fits, whether the voice held across three registers. A
 *    proxy is never a verdict. It is a number to compare two runs on, and its
 *    job is to tell a re-eval owner WHERE to look.
 *
 * Nothing here calls a model. The scorer must be able to grade a session on a
 * laptop with the network off, or it cannot be run on every change, which is
 * the only reason it exists.
 *
 * What is deliberately NOT scored: tone, register authenticity, pedagogical
 * fit, whether an analogy is a good analogy, whether a question is worth
 * asking. Those are model-judged or human-judged and a hard check that pretends
 * otherwise would launder a guess into a gate.
 */

// ------------------------------------------------------------------- inputs

/**
 * The session shape the scorer reads.
 *
 * Structural rather than `Session | ComposedSession` on purpose: a scorecard
 * must grade a session BEFORE it is persisted (that is the point — the Composer
 * changed, does the output still hold), after the Verifier has withheld
 * sections from it, and after it has come back off disk. Those are three
 * different types in this codebase for good reasons, and all three satisfy
 * this.
 */
export interface ScoreableSection {
  readonly topicId: TopicId;
  readonly heading: string;
  readonly body: string;
  readonly depth: DepthRegister;
  readonly actionMinutes?: number;
  readonly estimatedMinutes: number;
  readonly question: SessionQuestion | null;
  readonly sourceIds: readonly SourceId[];
  readonly mediumWarning?: string | null;
}

export interface ScoreableSession {
  readonly targetMinutes: number;
  readonly estimatedMinutes: number;
  readonly sections: readonly ScoreableSection[];
  readonly closingNote: string | null;
  readonly revision?: boolean;
  /**
   * What the Verifier refused, for the withheld-content contract’s check.
   *
   * Optional, and the two absences are NOT the same here. `[]` is a night that
   * withheld nothing and the check passes on it; `undefined` is an artefact
   * that does not carry the fact at all — a session scored before the verify
   * stage ran, or a transcription of a rendered session — and the check skips
   * rather than passing vacuously. `Session` reads absent as empty, and that
   * is right for a stored session; this is a scorer over three different
   * shapes, and its stated rule is that a skipped check is not a pass.
   */
  readonly withheld?: readonly { readonly topicId: TopicId; readonly heading: string }[];
}

/**
 * The board and learner state that PRODUCED the session.
 *
 * A session cannot be graded on its own text. "Every source id resolves" is a
 * question about what the brief offered; "the register is legal" is a question
 * about the comfort ledger; "nothing is fabricated about the learner" is a
 * question about what the system was allowed to say. Scoring the artefact
 * without the state that made it is how a scorecard ends up measuring prose.
 *
 * Every field except `topics` may legitimately be unavailable — a session read
 * back off disk months later has no comfort ledger attached — and each check
 * that needs one reports `skipped` rather than passing vacuously.
 */
export interface ScoreBoard {
  readonly topics: readonly Topic[];
  readonly pins?: readonly Pin[];
  /**
   * The ids the brief offered, when they are known but the pins behind them are
   * not — a rendered session whose provenance count survived but whose source
   * text did not. Overrides what `pins` would derive.
   *
   * Separate from `pins` on purpose: supplying fabricated pins to make the
   * provenance check run would make the verbatim-quote check pass over an empty
   * corpus, which is a vacuous green rather than an honest skip.
   */
  readonly offeredSourceIds?: readonly SourceId[];
  readonly comforts?: readonly ComfortResult[];
  /** Everything the Composer was permitted to assert about the learner. */
  readonly knownAboutLearner?: readonly string[];
  /**
   * The order the briefs were put in front of the model — prerequisite order,
   * decided by the Surveyor's graph and applied in the runner. Not recoverable
   * from a stored session, so the order check is skipped without it rather than
   * guessed at from the session's own sequence, which would be circular.
   */
  readonly offeredTopicOrder?: readonly TopicId[];
}

// --------------------------------------------------------------- thresholds

/**
 * Tolerances, in one place, because every one of them is a judgement that a
 * future re-eval owner may want to move — and moving one silently is how an
 * instrument stops measuring what it claims to.
 *
 * Each says which side of the number is the failure. The budget checks are
 * ONE-SIDED on purpose: a session that runs long is the  failure that
 * destroys trust, and a session that runs short errs in the safe direction and
 * is reported as a proxy (`budget-fill`) rather than gated on. Run 2 measured
 * the frontier pipeline at 7.3–12.2 real minutes against a 15-minute claim; a
 * two-sided gate would have failed the artefact the product is built to make.
 */
export const TOLERANCE = {
  /** A section may exceed its word budget by this factor before it is a defect. */
  wordBudgetOverrun: 1.25,
  /** The session's own minute claim may exceed its target by this factor. */
  durationOverrun: 1.1,
  /** `estimatedMinutes` must agree with the words actually written, ± this. */
  durationRecompute: 0.15,
  /**
   * Longest verbatim run from pinned material a section may carry, in words.
   *
   * A HARNESS threshold, not a code contract — the Composer is told to "quote it
   * where it helps" and nothing in the code caps a quote. Forty words is about
   * two sentences: long enough that every real quotation in the reference
   * sessions clears it, short enough that a section which is mostly someone
   * else's page does not. Named and exported so a re-eval can argue with it.
   */
  verbatimQuoteWords: 40,
  /** The Composer's stated rule: "at most two questions across the session". */
  maxQuestions: 2,
  /** The revision refresh's stated rule: "at most one question". */
  maxQuestionsRevision: 1,
} as const;

// ---------------------------------------------------------------- scorecard

export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface HardCheck {
  readonly id: string;
  readonly kind: 'hard';
  readonly status: CheckStatus;
  /** One line, readable by someone who has not read this file. */
  readonly detail: string;
  /** Section headings, ids or quotes that caused a failure. */
  readonly offenders: readonly string[];
}

export interface ProxyMetric {
  readonly id: string;
  readonly kind: 'proxy';
  readonly value: number;
  readonly unit: 'ratio' | 'count' | 'words' | 'minutes';
  readonly detail: string;
}

/** Per-register shape: the measurable half of "three registers, one voice". */
export interface RegisterStats {
  readonly register: DepthRegister;
  readonly sections: number;
  readonly words: number;
  readonly meanSentenceWords: number;
  /** Distinct lowercased word stems over total words. Vocabulary spread. */
  readonly typeTokenRatio: number;
  readonly meanWordChars: number;
  /** Words written over words budgeted for this register's sections. */
  readonly budgetFill: number;
}

export interface Scorecard {
  /** True when no hard check failed. Skipped checks do not fail a session. */
  readonly passed: boolean;
  readonly hard: readonly HardCheck[];
  readonly proxies: readonly ProxyMetric[];
  readonly perRegister: readonly RegisterStats[];
}

// ------------------------------------------------------------------ helpers

const words = (text: string): string[] => {
  const t = text.trim();
  return t ? t.split(/\s+/) : [];
};

/** Lowercased, stripped of surrounding punctuation — for matching, not display. */
const normWords = (text: string): string[] =>
  words(text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' '));

const mean = (xs: readonly number[]): number =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

const round = (n: number, dp = 3): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

const pass = (id: string, detail: string): HardCheck =>
  ({ id, kind: 'hard', status: 'pass', detail, offenders: [] });

const fail = (id: string, detail: string, offenders: readonly string[]): HardCheck =>
  ({ id, kind: 'hard', status: 'fail', detail, offenders });

const skip = (id: string, detail: string): HardCheck =>
  ({ id, kind: 'hard', status: 'skipped', detail, offenders: [] });

const verdict = (
  id: string, offenders: readonly string[], ok: string, bad: (n: number) => string,
): HardCheck => (offenders.length ? fail(id, bad(offenders.length), offenders) : pass(id, ok));

/**
 * Second-person claims about a habit, tool or practice — the fabrication class
 * the Verifier calls fatal and the one a learner cannot check.
 *
 * Narrow on purpose, in the same spirit as `suspectedInjection`: this is a
 * tripwire over the phrasings that only appear when the model has invented a
 * history, not a classifier for the general case. Each pattern carries the
 * nouns that would make it TRUE, and a match is suppressed when the learner
 * model actually says one of them — the rule is "assert nothing beyond this
 * list", so a claim that is on the list is not a fabrication.
 */
const FABRICATION: readonly (readonly [string, RegExp, readonly string[]])[] = [
  ['claims-a-list', /\byour (usual|existing|current|running|regular|own) (\w+ )?(approach|method|list|format|workflow|routine|notes?|notebook|process|system)\b/i,
    ['list', 'notebook', 'note', 'format', 'workflow', 'routine', 'process', 'system', 'method']],
  ['claims-a-format', /\bin the (format|way|style) you already (use|write|keep)\b/i, ['format', 'style']],
  ['claims-they-keep-one', /\b(the|a) (list|notes?|notebook|log|spreadsheet|deck) you (already )?(keep|maintain|use|have)\b/i,
    ['list', 'note', 'notebook', 'log', 'spreadsheet', 'deck']],
  ['claims-they-already-have', /\byou already (keep|maintain|have|use) an? \w+/i, ['keep', 'maintain']],
  ['claims-a-prior-session', /\b(your|the) (last|previous|earlier) (session|lesson|study session)\b/i, ['session', 'lesson']],
  ['claims-a-habit', /\bas you (always|usually|normally|habitually) do\b/i, ['always', 'usually']],
];

/** A score surface on the one artefact the design refuses to put a number on. */
const SCORE_MARKER = /\b(\d{1,3}\s?%|\d+\s*(\/|out of)\s*\d+|score[ds]?\b|streak\b|accuracy\b)/i;

// --------------------------------------------------------------- the scorer

export function scoreSession(session: ScoreableSession, board: ScoreBoard): Scorecard {
  const sections = session.sections;
  const hard: HardCheck[] = [];

  const topicIds = new Set(board.topics.map((t) => t.id));
  const topicById = new Map(board.topics.map((t) => [t.id, t]));
  const comfortById = new Map((board.comforts ?? []).map((c) => [c.topicId, c]));
  const knowsOffered = board.offeredSourceIds !== undefined || board.pins !== undefined;
  const offeredIds = new Set(board.offeredSourceIds ?? (board.pins ?? []).flatMap(offeredSourceIdsFor));
  const known = (board.knownAboutLearner ?? []).map((k) => k.toLowerCase());

  const sectionWords = sections.map((s) => words(s.body).length);

  /**
   * The budget the Composer actually issued, reconstructed rather than stored.
   *
   * A section's budget is the smaller of its register share and what its
   * source material earns. No extra state is stored to carry
   * the number — so the scorer recomputes it from the same two inputs. With
   * `pins` on the board this is the number that was written into the brief;
   * without them the material half is unknowable and the register share is the
   * best available answer, which is what every scorecard measured before the
   * change. `budgetBasis` says which of the two a reader is looking at, because
   * a `budget-fill` computed against the register share is not comparable with
   * one computed against the issued budget on a board with a thin topic on it.
   */
  // `actionMinutes` is the composition-contract marker. Historical reference
  // sessions predate it: score those against the budget they were actually
  // issued, while every new session reserves and recomputes action time.
  const actionTimed = sections.some((section) => section.actionMinutes !== undefined);
  const plannedActions = actionTimed
    ? (session.revision ? 1 : plannedLearnerActions(session.targetMinutes)) : 0;
  const readingMinutes = Math.max(1,
    session.targetMinutes - plannedActions * LEARNER_ACTION_MINUTES);
  const registerBudgets = wordBudgets(readingMinutes, sections.map((s) => s.depth));
  const pinsByTopic = new Map<string, Pin[]>();
  for (const p of board.pins ?? []) {
    if (!p.topicId) continue;
    const pins = pinsByTopic.get(p.topicId) ?? [];
    pins.push(p);
    pinsByTopic.set(p.topicId, pins);
  }
  const materialByTopic = new Map([...pinsByTopic].map(([topicId, pins]) => [
    topicId,
    actionTimed ? materialWordsFor(pins) : pins.reduce((sum, pin) => sum + pinMaterialWords(pin), 0),
  ]));
  const budgetBasis: 'issued' | 'register-only' = board.pins ? 'issued' : 'register-only';
  const budgets = board.pins
    ? registerBudgets.map((b, i) =>
      budgetForMaterial(b, materialByTopic.get(sections[i]?.topicId ?? '') ?? 0))
    : registerBudgets;
  const label = (i: number): string => `#${i + 1} ${sections[i]?.heading ?? '(untitled)'}`;

  // ---- provenance is closed --------------------------------------------
  // An empty topic list is "no board was supplied", not "every topic is
  // invented": the Composer cannot produce a section without a topic to attach
  // it to, so a session with sections and a board with none is a scoring
  // input that is missing state, and reporting it as a defect in the SESSION
  // would be the instrument blaming the artefact for its own missing argument.
  hard.push(!board.topics.length
    ? skip('provenance-topics', 'no topics supplied — section topic ids cannot be resolved')
    : verdict(
      'provenance-topics',
      sections.flatMap((s, i) => (topicIds.has(s.topicId) ? [] : [`${label(i)} → ${s.topicId}`])),
      'every section is attached to a topic on the board',
      (n) => `${n} section(s) name a topic that is not on the board`,
    ));

  hard.push(!knowsOffered
    ? skip('provenance-sources', 'no pins or offered ids supplied — the offered source set cannot be reconstructed')
    : verdict(
      'provenance-sources',
      sections.flatMap((s, i) => s.sourceIds.filter((id) => !offeredIds.has(id)).map((id) => `${label(i)} → ${id}`)),
      `every cited source id resolves (${offeredIds.size} offered)`,
      (n) => `${n} cited source id(s) resolve to nothing the brief offered`,
    ));

  // ---- registers are legal and are the ledger's ------------------------
  const LEGAL: readonly DepthRegister[] = ['from-nothing', 'building', 'fluent'];
  hard.push(verdict(
    'register-legal',
    sections.flatMap((s, i) => (LEGAL.includes(s.depth) ? [] : [`${label(i)} → ${String(s.depth)}`])),
    'every section carries one of the three registers',
    (n) => `${n} section(s) carry a register that is not one of the three`,
  ));

  hard.push(board.comforts === undefined
    ? skip('register-matches-ledger', 'no comfort ledger supplied — the derived register cannot be checked')
    : verdict(
      'register-matches-ledger',
      sections.flatMap((s, i) => {
        const want = registerFor(comfortById.get(s.topicId));
        return s.depth === want ? [] : [`${label(i)} is ${s.depth}, the ledger says ${want}`];
      }),
      'every register is the one the comfort ledger derives',
      (n) => `${n} section(s) sit at a register the comfort ledger does not derive`,
    ));

  // ---- order is the order the briefs were offered in --------------------
  hard.push(board.offeredTopicOrder === undefined
    ? skip('section-order', 'the offered brief order was not supplied — order cannot be checked')
    : (() => {
      // Subsequence, not equality: the Verifier withholds sections after the
      // Composer has ordered them, and a session missing its middle section is
      // still in prerequisite order.
      const want = board.offeredTopicOrder;
      let at = 0;
      const out: string[] = [];
      for (const [i, s] of sections.entries()) {
        const found = want.indexOf(s.topicId, at);
        if (found === -1) out.push(`${label(i)} (${s.topicId}) is out of prerequisite order`);
        else at = found + 1;
      }
      return verdict('section-order', out,
        'sections run in the prerequisite order the briefs were offered in',
        (n) => `${n} section(s) break the prerequisite order`);
    })());

  // ---- sized to the budget ---------------------------------------------
  hard.push(verdict(
    'word-budget',
    sections.flatMap((s, i) => {
      const cap = (budgets[i] ?? 0) * TOLERANCE.wordBudgetOverrun;
      return (sectionWords[i] ?? 0) > cap
        ? [`${label(i)} ran ${sectionWords[i]} words against a ${budgets[i]}-word budget`] : [];
    }),
    `no section overruns its word budget (×${TOLERANCE.wordBudgetOverrun}, ${budgetBasis})`,
    (n) => `${n} section(s) overrun their word budget`,
  ));

  const overrun = session.estimatedMinutes > session.targetMinutes * TOLERANCE.durationOverrun;
  hard.push(overrun
    ? fail('duration-fits-budget',
      `the session claims ${session.estimatedMinutes}min against a ${session.targetMinutes}min budget`,
      [`${session.estimatedMinutes} > ${session.targetMinutes}`])
    : pass('duration-fits-budget',
      `${session.estimatedMinutes}min claimed against ${session.targetMinutes}min budgeted`));

  hard.push(verdict(
    'duration-computed',
    sections.flatMap((s, i) => {
      const want = sectionMinutes(s.body, s.depth, s.actionMinutes ?? 0);
      return Math.abs(s.estimatedMinutes - want) > TOLERANCE.durationRecompute
        ? [`${label(i)} claims ${s.estimatedMinutes}min, its reading and learner action take ${want}min`] : [];
    }),
    'every section duration recomputes from its reading and learner action',
    (n) => `${n} section duration(s) do not recompute from reading and action`,
  ));

  // ---- it closes rather than stopping ----------------------------------
  hard.push(verdict(
    'body-ends-on-sentence',
    sections.flatMap((s, i) => (/[.!?:'")\]]$/.test(s.body.trim()) ? [] : [`${label(i)} ends "…${s.body.trim().slice(-40)}"`])),
    'no section body stops mid-sentence',
    (n) => `${n} section(s) stop mid-sentence — composed to a cut, not to a duration`,
  ));

  const note = session.closingNote?.trim() ?? '';
  hard.push(!note
    ? fail('closing-note', 'the session has no closing note', ['closingNote is null or empty'])
    : SCORE_MARKER.test(note)
      ? fail('closing-note', 'the closing note carries a score, percentage or streak', [note])
      : pass('closing-note', `closes on ${note.split(/[;.]\s+/).filter(Boolean).length} clause(s), no score surface`));

  /**
   * "The note may not name a section that was withheld" is a hard contract, not a
   * judgement: the labels are carried on the session, the match is mechanical,
   * and there is nothing for a reader to weigh. The 2026-08-20 benchmark found
   * this defect by eye — `closing-note` counted clauses and looked for a score
   * surface, and passed the note that told a learner they had practised two
   * sections the Verifier had removed.
   *
   * ADDED, NOT RENUMBERED. The checks in this scorecard are identified by name
   * and never by position — `renderScorecard` prints ids and the CLI reads
   * `card.hard` by id. This contract moved the total from 16 to 17; the later
   * learner-action floor moves it to 18 without changing any earlier check.
   *
   * Skips on an artefact that does not carry a withhold list at all, and
   * passes on one that carries an empty one. Those are different facts: a
   * rendered session transcribed from a frontier model has no verify stage
   * behind it and cannot answer, while a stored session that withheld nothing
   * has answered.
   */
  const refused = session.withheld;
  const namedWithheld = withheldTopicsNamedIn(note, (refused ?? []).map((w) => ({
    topicId: w.topicId,
    heading: w.heading,
    label: topicById.get(w.topicId)?.label ?? null,
  })));
  hard.push(refused === undefined
    ? skip('closing-note-withheld', 'the session does not carry what the Verifier withheld — the claim cannot be checked')
    : !refused.length
      ? pass('closing-note-withheld', 'no section was withheld, so the note claims nothing it should not')
      : verdict(
        'closing-note-withheld',
        namedWithheld.map((id) => {
          const w = refused.find((x) => x.topicId === id);
          return `the note names "${w?.heading ?? id}", withheld after it was written`;
        }),
        `${refused.length} section(s) withheld, none of them named in the closing note`,
        (n) => `the closing note names ${n} withheld section(s) — the learner is told they`
          + ' practised material they never saw',
      ));

  // ---- the Tutor can actually read the questions -----------------------
  const questions = sections.filter((s) => s.question);
  hard.push(verdict(
    'question-well-formed',
    sections.flatMap((s, i) => {
      const q = s.question;
      if (!q) return [];
      const bad: string[] = [];
      if (typeof q.prompt !== 'string' || !q.prompt.trim()) bad.push(`${label(i)} has a question with no prompt`);
      if (q.kind !== 'free-text' && q.kind !== 'recall') bad.push(`${label(i)} has kind "${String(q.kind)}"`);
      // `markAnswer` reads `expectedPoints.length`; a missing array throws in
      // the foreground while the learner waits. An EMPTY array is a real
      // answer and is not a defect.
      if (!Array.isArray(q.expectedPoints)) bad.push(`${label(i)} has no expectedPoints array`);
      else if (q.expectedPoints.some((p) => typeof p !== 'string' || !p.trim())) bad.push(`${label(i)} has a blank expected point`);
      return bad;
    }),
    `${questions.length} question(s), all in the shape the Tutor reads`,
    (n) => `${n} question defect(s) the Tutor would trip over`,
  ));

  /**
   * A shape-only question check passes vacuously on zero questions. That was
   * acceptable while questions were optional decoration and became false the
   * moment the product promised to learn from what the learner does. A session
   * with no answerable action is a reading, not a learning loop, and the 2026-08-26
   * five-minute drumming run exposed exactly that: all seventeen old hard checks
   * passed over 571 words and a Finish button.
   *
   * This deliberately checks presence, not quality. Whether a question is
   * worth asking remains human/model judgement; whether the learner is offered
   * any question at all is a mechanical contract the Composer now guarantees.
   */
  hard.push(questions.length
    ? pass('learner-action', `${questions.length} answerable learner action${questions.length === 1 ? '' : 's'} in the session`)
    : fail('learner-action', 'the session is reading-only', ['no section offers a question the learner can answer']));

  const maxQ = session.revision ? TOLERANCE.maxQuestionsRevision : TOLERANCE.maxQuestions;
  hard.push(questions.length > maxQ
    ? fail('question-restraint', `${questions.length} questions against a stated maximum of ${maxQ}`,
      questions.map((s) => s.question?.prompt ?? '').filter(Boolean))
    : pass('question-restraint', `${questions.length} question(s) against a maximum of ${maxQ}`));

  // ---- the page did not get into the lesson ----------------------------
  hard.push(verdict(
    'no-fence-leak',
    sections.flatMap((s, i) => (s.body.toLowerCase().includes(`<${PINNED_TAG}`) ? [`${label(i)}`] : [])),
    `no section carries the <${PINNED_TAG}> delimiter through into the lesson`,
    (n) => `${n} section(s) leaked the fence delimiter into the learner's text`,
  ));

  hard.push(board.pins === undefined || !board.pins.length
    ? skip('no-verbatim-overquote', 'no pins supplied — verbatim runs cannot be measured')
    : (() => {
      const k = TOLERANCE.verbatimQuoteWords;
      const grams = new Set<string>();
      for (const p of board.pins) {
        const src = normWords(`${p.envelope.selection ?? ''} ${p.envelope.surroundingText} ${p.enrichment?.refetchedText ?? ''}`);
        for (let i = 0; i + k <= src.length; i++) grams.add(src.slice(i, i + k).join(' '));
      }
      const out: string[] = [];
      for (const [i, s] of sections.entries()) {
        const body = normWords(s.body);
        for (let j = 0; j + k <= body.length; j++) {
          const g = body.slice(j, j + k).join(' ');
          if (grams.has(g)) { out.push(`${label(i)}: "${g.slice(0, 80)}…"`); break; }
        }
      }
      return verdict('no-verbatim-overquote', out,
        `no section reproduces more than ${k} consecutive words of pinned material`,
        (n) => `${n} section(s) reproduce more than ${k} consecutive words of the source page`);
    })());

  // ---- nothing invented about the person -------------------------------
  hard.push(verdict(
    'no-learner-fabrication',
    sections.flatMap((s, i) => FABRICATION.flatMap(([id, re, anchors]) => {
      const m = re.exec(s.body);
      if (!m) return [];
      // On the list is not a fabrication: the rule is "assert nothing beyond
      // what you were told", not "never mention a habit".
      if (anchors.some((a) => known.some((k) => k.includes(a)))) return [];
      return [`${label(i)} [${id}]: "${m[0]}"`];
    })),
    'no section asserts a habit, tool or history the learner model does not carry',
    (n) => `${n} claim(s) about the learner that nothing establishes`,
  ));

  // ---- the revision offer is a refresh, not a short session -------------
  hard.push(!session.revision
    ? skip('revision-shape', 'not a revision offer')
    : (() => {
      const out: string[] = [];
      if (session.targetMinutes > REVISION_MINUTES) out.push(`budgeted ${session.targetMinutes}min against a ${REVISION_MINUTES}min refresh`);
      if (sections.length > REVISION_TOPICS) out.push(`${sections.length} sections against ${REVISION_TOPICS} topics`);
      return verdict('revision-shape', out,
        `a ${session.targetMinutes}min refresh over ${sections.length} topic(s)`,
        (n) => `${n} way(s) in which the refresh has been padded out to look like a session`);
    })());

  // ------------------------------------------------------------- proxies

  const totalWords = sectionWords.reduce((a, b) => a + b, 0);
  const totalBudget = budgets.reduce((a, b) => a + b, 0);
  const distinctTopics = new Set(sections.map((s) => s.topicId)).size;
  const registersPresent = new Set(sections.map((s) => s.depth));
  const sourceCount = sections.reduce((a, s) => a + s.sourceIds.length, 0);
  const cv = sectionWords.length > 1
    ? Math.sqrt(mean(sectionWords.map((w) => (w - mean(sectionWords)) ** 2))) / (mean(sectionWords) || 1)
    : 0;

  const proxy = (id: string, value: number, unit: ProxyMetric['unit'], detail: string): ProxyMetric =>
    ({ id, kind: 'proxy', value: round(value), unit, detail });

  const proxies: ProxyMetric[] = [
    proxy('duration-fill', session.targetMinutes ? session.estimatedMinutes / session.targetMinutes : 0,
      'ratio', 'claimed minutes over budgeted minutes — under 1 errs safe, near 1 may mean the model is targeting the number'),
    proxy('budget-fill', totalBudget ? totalWords / totalBudget : 0,
      'ratio', `words written over words budgeted, across the session (${budgetBasis})`),
    proxy('register-spread', registersPresent.size / 3,
      'ratio', 'distinct registers over the three that exist —  as a number, not a verdict on whether they read as one voice'),
    proxy('topic-diversity', sections.length ? distinctTopics / sections.length : 0,
      'ratio', 'distinct topics over sections — 1 means no topic was taught twice'),
    proxy('evidence-density', sections.length ? sourceCount / sections.length : 0,
      'count', 'resolving source ids per section'),
    proxy('evidence-per-1000-words', totalWords ? (sourceCount * 1000) / totalWords : 0,
      'count', 'resolving source ids per thousand words of lesson'),
    proxy('question-density', sections.length ? questions.length / sections.length : 0,
      'ratio', 'questions per section'),
    proxy('medium-warning-rate', sections.length
      ? sections.filter((s) => s.mediumWarning).length / sections.length : 0,
      'ratio', 'sections carrying a medium warning'),
    proxy('section-length-cv', cv,
      'ratio', 'spread of section lengths — Run 2 flagged uneven sections; the weighted budget is meant to hold this down'),
    proxy('session-words', totalWords, 'words', 'total words of lesson text'),
  ];

  // --------------------------------------------------------- per register

  const perRegister: RegisterStats[] = LEGAL.filter((r) => registersPresent.has(r)).map((r) => {
    const idx = sections.map((_, i) => i).filter((i) => sections[i]?.depth === r);
    const text = idx.map((i) => sections[i]?.body ?? '').join(' ');
    const w = words(text);
    const sentences = text.split(/(?<=[.!?])\s+/).map((s) => words(s).length).filter((n) => n > 0);
    const types = new Set(normWords(text)).size;
    return {
      register: r,
      sections: idx.length,
      words: w.length,
      meanSentenceWords: round(mean(sentences), 1),
      typeTokenRatio: round(w.length ? types / w.length : 0),
      meanWordChars: round(w.length ? w.reduce((a, x) => a + x.length, 0) / w.length : 0, 2),
      budgetFill: round(idx.reduce((a, i) => a + (budgets[i] ?? 0), 0)
        ? w.length / idx.reduce((a, i) => a + (budgets[i] ?? 0), 0) : 0),
    };
  });

  return {
    passed: hard.every((c) => c.status !== 'fail'),
    hard,
    proxies,
    perRegister,
  };
}

/**
 * The board, reconstructed from a store, for scoring a session read back off
 * disk.
 *
 * Everything except the offered brief order survives persistence: the comfort
 * ledger recomputes from the signal ledger, the offered source set recomputes
 * from the pins, and the learner model is the statements. The brief order does
 * not — it is decided per run from the prerequisite graph and never written
 * down — so `section-order` reports `skipped` on a stored session rather than
 * being inferred from the session's own sequence, which would be circular.
 *
 * Takes the port, not an adapter: `core/` still constructs nothing.
 */
export async function boardFromStore(
  store: Pick<Store, 'listTopics' | 'listPins' | 'listSignals' | 'listStatements'>,
  now: Date,
): Promise<ScoreBoard> {
  const topics = await store.listTopics();
  const signals = await store.listSignals();
  return {
    topics,
    pins: await store.listPins(),
    comforts: topics.map((t) => computeComfort(t.id, signals, now)),
    // a modality question nobody has answered is not known about
    // anybody, and scoring a session against it would grade the product on a
    // claim it is not allowed to make yet.
    knownAboutLearner: (await store.listStatements())
      .filter((s) => !isUnansweredModality(s)).map((s) => s.text),
  };
}

/** One line per check, for a terminal. Kept here so core owns its own rendering. */
export function renderScorecard(card: Scorecard): string {
  const mark = { pass: 'PASS', fail: 'FAIL', skipped: 'SKIP' } as const;
  const lines = [
    'HARD CHECKS (contract — a failure is a defect)',
    ...card.hard.map((c) => `  ${mark[c.status]}  ${c.id.padEnd(26)} ${c.detail}`
      + c.offenders.map((o) => `\n           · ${o}`).join('')),
    '',
    'PROXY METRICS (signal — compare runs, do not gate on them)',
    ...card.proxies.map((p) => `  ${String(p.value).padStart(8)} ${p.unit.padEnd(8)} ${p.id.padEnd(24)} ${p.detail}`),
    '',
    'PER REGISTER (proxy)',
    ...card.perRegister.map((r) =>
      `  ${r.register.padEnd(13)} ${r.sections} section(s)  ${String(r.words).padStart(5)} words`
      + `  sentence ${String(r.meanSentenceWords).padStart(5)}w  type/token ${r.typeTokenRatio}`
      + `  word ${r.meanWordChars}ch  budget-fill ${r.budgetFill}`),
    '',
    card.passed ? 'RESULT: all hard checks hold' : 'RESULT: hard check failure',
  ];
  return lines.join('\n');
}
