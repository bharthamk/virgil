
import { newClientRef } from './pin-body.js';
import {
  ASK_PLACEHOLDER, ASK_SEND, ASK_SHORTCUTS, ASK_YOU,
  LESSON_ANSWER_REQUIRED,
  OFFER_AS_PIN_ACTION, OFFER_AS_PIN_DONE, RESURFACE_FROM_LESSON,
  SESSION_FINISH, SESSION_LEAVE, SESSION_NEXT, SESSION_NOT_REFRESHED, SOURCES_HIDDEN, SOURCES_OPEN,
  bodyBlocks, contestConfirmLines, contestedLine, esc, lessonCompletionLine,
  lessonCorrectionFailedLine, lessonCorrectionReceiptLine,
  lineupWhyLine, offerAsPinLine, offersContest, railRowLabel, resurfacedLine,
  safeHref, sourceAvailabilityLine, sourceLine, sourcesLabel, unresolvedSourcesLine,
  lessonAnswerUnreadableLine, lessonQuestionFailedLine,
  type GuideFailure, type SourceView,
} from './panel-core.js';
/** Type-only, so nothing here imports the shell at runtime and the shell stays
 *  the only module that owns a route. */
import type { ApiResult } from './panel.js';


export interface LessonTitle {
  /** The subject this lesson sits in: the course where there is one, the
   *  topic's board label otherwise, and null only where the heading already
   *  says it or the service sent neither. */
  readonly family: string | null;
  /** The lesson's own name. The label with the family clipped off where the
   *  label really starts with it, and the whole label otherwise. */
  readonly area: string;
}

/**
 * Which of the two stored facts is this lesson's subject, strongest first.
 *
 * A course is the stronger claim: it is a thing on the board with a page of its
 * own, and the line is a door into it. The topic's label is the weaker one and
 * is still a fact somebody's board holds. Neither is composed here, and a
 * section carrying neither gets nothing.
 */
export function subjectOf(section: Section): string | null {
  return section.subject?.title ?? section.topicLabel ?? null;
}

export function lessonTitle(
  heading: string | null | undefined, subjectTitle: string | null | undefined,
): LessonTitle {
  const label = (heading ?? '').replace(/\s+/g, ' ').trim();
  const family = (subjectTitle ?? '').replace(/\s+/g, ' ').trim();
  if (!family || !label) return { family: family || null, area: label };
  if (label.toLowerCase() === family.toLowerCase()) return { family: null, area: label };
  const clipped = label.toLowerCase().startsWith(family.toLowerCase())
    // Only the separators a label can actually carry between the two, and the
    // colon is here because a stored session composed before 2026-08-29 still
    // has one. Nothing is inserted; something is removed or it is not.
    ? label.slice(family.length).replace(/^[\s:,·]+/, '').trim()
    : '';
  return { family, area: clipped || label };
}


export const LESSON_GOT_IT = 'Got it';
export const LESSON_REFRESH_LATER = 'Refresh later';
export const LESSON_EXPLAIN_AGAIN = 'Explain another way';
export const LESSON_GO_DEEPER = 'Go deeper';
/** Three things to learn after this one, with what each costs. The heading is
 *  the whole instruction (The affordance-first interface contract), and where there is nothing to offer
 *  there is no heading over nothing. */
export const LEARN_NEXT_HEADING = 'Learn next';

/** Labels for the two teaching blocks in the lesson rail. */
export const LESSON_QUESTION_HEADING = 'Test your knowledge';
export const LESSON_CONTINUE_HEADING = 'Continue the lesson with Virgil';

// ------------------------------------------------------------------ the data

export interface LessonCorrection {
  id: string; clientRef: string; claim: string; challenge: string; reply: string;
  conceded: boolean; sourceIds: string[]; withdrawn: number; at: string;
}

export interface Section {
  topicId: string; heading: string; body: string;
  depth: 'from-nothing' | 'building' | 'fluent';
  estimatedMinutes: number; sourceIds: string[];
  corrections?: LessonCorrection[];
  question: { prompt: string; expectedPoints: string[] } | null;
  /** Still carried, still exported, and no longer drawn on this face. */
  mediumWarning?: string | null;
  /** The learner-controlled lineup contract: why the ranker chose this, in its own words. */
  why?: string | null;
  /** The felt why: what the learner saved here, and when. Derived by the
   *  service; absent on an older one, and absent when the facts are thin. Read
   *  by the notebook export; not drawn on the lesson since 2026-08-29. */
  grounding?: string | null;
  /** One line naming what this section covers, written by the Composer in the
   *  call that wrote the section. Never derived from the body: a well-written
   *  lesson opens on an analogy often enough that extraction is wrong as a
   *  mechanism. Read by the lineup row and by the tutor brief. */
  summary?: string | null;
  /** The affordance-first interface contract: what this lesson is part of, and what it moves forward. Both
   *  derived by the service. `subject` is the family line over the lesson now;
   *  `serves` is a fact about a deadline and belongs on the rows that choose. */
  subject?: { courseId: string; title: string } | null;
  /** What the board calls the topic this section teaches, derived by the
   *  service. The subject line for a topic no course claims; absent on a
   *  service too old to send it, which draws no line rather than a guess. */
  topicLabel?: string | null;
  serves?: { commitmentId: string; title: string } | null;
  completed: boolean;
  completionEvidence?: 'answer' | 'known';
  contested?: boolean;
}

export interface Session {
  id: string; builtAt: string; fromPinCount: number;
  estimatedMinutes: number; targetMinutes: number;
  sections: Section[]; currentSectionIndex: number; closingNote: string | null;
}

/** One row under the lesson: what it is, what it costs, and what pressing it
 *  does. Computed by the shell, because only the shell holds the ranking, the
 *  chosen window and the passed-over ledger. */
export interface LearnNextRow {
  readonly label: string;
  readonly minutes: number | null;
  readonly press: () => void;
}

type Unreadable = Exclude<ApiResult<unknown>, { kind: 'ok' }>;

/** Everything a lesson does that leaves the lesson. Handed in, so this module
 *  knows no room, no route and no mount. */
export interface LessonShell {
  readonly api: <T>(path: string, init?: RequestInit) => Promise<T | null>;
  readonly apiResult: <T>(path: string, init?: RequestInit) => Promise<ApiResult<T>>;
  readonly failureOf: (r: Unreadable) => GuideFailure;
  readonly appendBudgetRecovery: (host: HTMLElement, r: Unreadable) => void;
  /** True when the request failed because identity expired, in which case the
   *  shell has already reopened sign-in and this lesson must stop. */
  readonly reopenSignIn: (
    result: ApiResult<unknown>, resume: () => void | Promise<void>,
  ) => Promise<boolean>;
  /** Open a lesson in the session already mounted, optionally from a session
   *  just re-read, optionally onto the close. */
  readonly openLesson: (
    at: string | null, from: Session | null, close?: boolean,
  ) => void;
  /** Rebuild the page onto this same lesson, after a sign-in round trip. */
  readonly reopenAt: (topicId: string) => void;
  readonly openModels: () => void;
  readonly openCourse: (courseId: string) => void;
  readonly openHome: () => void;
  readonly confirmStep: (
    host: HTMLElement, lines: readonly string[], verb: string, go: () => Promise<void>,
    returnFocus?: HTMLElement | null,
  ) => void;
}

// -------------------------------------------------------------- the memory

/**
 * Unsent lesson answers belong to the browser surface, not the learner model.
 * They survive room navigation for the same reason Check's boxes do, but never
 * become evidence until Answer succeeds. Cleared with the account, which is why
 * the shell can reach them.
 */
const LESSON_ANSWER_DRAFTS = new Map<string, string>();
interface LessonTangentTurn {
  readonly question: string;
  readonly answer: string;
  readonly offerAsPin: string | null;
  readonly clientRef: string;
  pinId: string | null;
}
const LESSON_TANGENT_DRAFTS = new Map<string, string>();
const LESSON_TANGENT_TURNS = new Map<string, LessonTangentTurn[]>();
interface LessonCorrectionDraft { text: string; clientRef: string }
const LESSON_CORRECTION_DRAFTS = new Map<string, LessonCorrectionDraft>();

const LESSON_QUESTION_MAX_CHARS = 800;
const LESSON_CORRECTION_MAX_CHARS = 2_000;
const LEARNER_ANSWER_MAX_CHARS = 1_500;

/** Whether anything a learner typed into a lesson is still unsent. The shell
 *  asks before it does anything that would throw that work away. */
export function hasLessonDrafts(): boolean {
  return [...LESSON_ANSWER_DRAFTS.values()].some((value) => value.trim())
    || [...LESSON_TANGENT_DRAFTS.values()].some((value) => value.trim())
    || [...LESSON_CORRECTION_DRAFTS.values()].some((value) => value.text.trim());
}

/** A session id is not a safe account boundary on a self-hosted page shared by
 *  two people, so everything unsent goes when the account does. */
export function clearLessonMemory(): void {
  LESSON_ANSWER_DRAFTS.clear();
  LESSON_TANGENT_DRAFTS.clear();
  LESSON_TANGENT_TURNS.clear();
  LESSON_CORRECTION_DRAFTS.clear();
}

const el = (html: string): HTMLElement => {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLElement;
};

const unicodeChars = (value: string): number => Array.from(value).length;
const lessonKey = (sessionId: string, topicId: string): string => `${sessionId}\u0000${topicId}`;
const domId = (prefix: string, topicId: string): string =>
  `${prefix}-${topicId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

/** The body, block by block, so a fenced example stays an example. */
function fillBody(into: HTMLElement, text: string): void {
  into.replaceChildren();
  for (const block of bodyBlocks(text)) {
    const node = el(block.kind === 'code' ? '<pre class="code"></pre>' : '<p class="para"></p>');
    node.textContent = block.text;
    into.append(node);
  }
}

// ------------------------------------------------------------- the two sides

export interface LessonSurfaces {
  /** The lesson's own column. */
  readonly face: HTMLElement;
  /** The teaching panel, for the rail. Always drawn while a lesson is open:
   *  what is inside it is what the section's state supports, and a lesson
   *  already read still keeps the box that answers questions about it. */
  readonly panel: HTMLElement;
}

/**
 * Both sides of one lesson, built together.
 *
 * Together rather than separately because they are one interaction: conceding a
 * correction on the left retires the question on the right, and answering on
 * the right paints the completion receipt that the correction also writes. Two
 * functions sharing that through the DOM is how a receipt ends up on the wrong
 * side of a repaint.
 */
export function lessonSurfaces(
  shell: LessonShell, session: Session, section: Section, index: number,
  learnNext: readonly LearnNextRow[] = [],
): LessonSurfaces {
  const done = !!section.completed;
  const key = lessonKey(session.id, section.topicId);
  const reopen = (): void => shell.reopenAt(section.topicId);

  const face = el(`<div class="section${done ? ' done' : ''}" data-resume data-section="${esc(section.topicId)}">
    <div class="body" data-lesson-part="body"></div>
    <button class="link sources">${esc(sourcesLabel(section.sourceIds.length))}</button>
    <div class="sources-out" role="region"></div>
    <p class="meta sources-said" role="status" aria-live="polite"></p>
    <p class="meta lesson-said" role="status" aria-live="polite"></p>
  </div>`);
  const body = face.querySelector('.body') as HTMLElement;
  const said = face.querySelector('.lesson-said') as HTMLElement;
  fillBody(body, section.body);


  const title = lessonTitle(section.heading, subjectOf(section));
  const courseId = section.subject?.courseId ?? null;
  if (title.family) {
    const family = courseId
      ? el('<button class="link lesson-family" data-lesson-part="family"></button>')
      : el('<p class="lesson-family" data-lesson-part="family"></p>');
    family.textContent = title.family;
    if (courseId) family.addEventListener('click', () => shell.openCourse(courseId));
    face.insertBefore(family, body);
  }
  const area = el('<h1 class="lesson-area" data-lesson-part="area"></h1>');
  area.textContent = title.area;
  face.insertBefore(area, body);

  // SB-44, and wired before the done short-circuit on purpose: checking where a
  // claim came from is the one thing on a section that writes nothing, so it
  // stays available on a lesson already read.
  sourcesControl(shell, face, session, section);

  const panel = el(`<div class="rail-block teaching" data-rail="teaching">
    <div class="explain-choices row" data-explain-choices hidden></div>
    <div class="continue-learning" data-continue>
      <span class="alt-label">${esc(LESSON_CONTINUE_HEADING)}</span>
      <div class="continue-body">
        <div class="exchange teaching-turns" data-teaching-turns></div>
        <div class="ask">
          <label for="${esc(domId('lesson-ask', section.topicId))}">Your question</label>
          <div class="row field"><input id="${esc(domId('lesson-ask', section.topicId))}" class="ask-box" type="text"><button data-send>${esc(ASK_SEND)}</button></div>
          <div class="meta input-limit">Up to 800 characters. Sending makes one API call to your configured model.</div>
        </div>
        <div class="meta lesson-question-status" role="status" aria-live="polite" tabindex="-1"></div>
      </div>
    </div>
    <div class="meta lesson-completion" data-lesson-completion></div>
  </div>`);

  const paintCompletion = (): void => {
    const status = panel.querySelector('[data-lesson-completion]') as HTMLElement;
    status.textContent = lessonCompletionLine(section) ?? '';
  };

  const ask = tangentExchange(shell, panel, session, section, key, reopen);
  paintCompletion();

  /** A conceded claim retires the question the Composer wrote against it, and
   *  the lesson the learner is reading becomes the corrected one. */
  face.append(lessonCorrectionControl(shell, face, session, section, () => {
    panel.querySelector('.q')?.remove();
    area.textContent = lessonTitle(section.heading, subjectOf(section)).area;
    fillBody(body, section.body);
    paintCompletion();
  }));

  /**
   * Moving on, and what it does and does not mean.
   *
   * A plain read-through has no terminal action: there is nothing to mark,
   * because reading is not evidence and a control that recorded it would be the
   * skip button with a friendlier name. So this is a pager. It writes nothing,
   * it does not touch the resume point, and the lesson it leaves is exactly as
   * owed as it was before. On the last lesson there is nowhere further to page,
   * so it offers the close instead.
   *
   * It lives at the end of the teaching panel because that is where the flow
   * ends now: the ask, the answer, the mark, and then the way out.
   */
  const after = session.sections[index + 1] ?? null;
  const onward = (label: string, accent: boolean, go: () => void): HTMLElement => {
    const row = el('<div class="row lesson-onward"><button data-onward></button></div>');
    const control = row.querySelector('[data-onward]') as HTMLButtonElement;
    control.textContent = label;
    if (accent) control.classList.add('primary');
    control.addEventListener('click', go);
    return row;
  };

  if (done) {
    /**
     * A lesson already read keeps what asks nothing of the learner: the sources
     * tap, the challenge, and the box that answers questions about it. It gains
     * no controls, because every one of them would write against work that is
     * already recorded.
     *
     * The one exception is a session where everything is finished and the
     * learner arrived by re-reading rather than by finishing: the close that
     * offers the next move was never drawn, and global navigation is a poor
     * substitute for the step this screen already knows how to offer.
     */
    if (session.sections.every((candidate) => candidate.completed)) {
      panel.append(onward('See what’s next', true, () => shell.openHome()));
    }
    return { face, panel };
  }

  // ------------------------------------------------------- the four controls


  // `row` for the flex line and nothing else: the generic `.controls` rule (and
  // the page surface's heavier override of it) is written for bordered buttons
  // and would put pill padding back on chalk.
  const controls = el(`<div class="row lesson-controls" data-lesson-part="controls">
    <button class="chalk" data-got-it></button>
    <button class="chalk" data-refresh-later></button>
    <button class="chalk" data-explain></button>
    <button class="chalk" data-go-deeper></button>
  </div>`);
  const gotIt = controls.querySelector('[data-got-it]') as HTMLButtonElement;
  const refreshLater = controls.querySelector('[data-refresh-later]') as HTMLButtonElement;
  const explain = controls.querySelector('[data-explain]') as HTMLButtonElement;
  const goDeeper = controls.querySelector('[data-go-deeper]') as HTMLButtonElement;
  gotIt.textContent = LESSON_GOT_IT;
  refreshLater.textContent = LESSON_REFRESH_LATER;
  explain.textContent = LESSON_EXPLAIN_AGAIN;
  goDeeper.textContent = LESSON_GO_DEEPER;
  face.insertBefore(controls, face.querySelector('.sources'));

  /** Re-read, then move to whatever is owed. The write has been answered; this
   *  is the read that repaints from it, and a read that does not land leaves
   *  the learner where they are with the truth about what happened. */
  const advance = async (): Promise<void> => {
    const fresh = await shell.api<{ session: Session | null }>('/session');
    if (!fresh?.session) { said.textContent = SESSION_NOT_REFRESHED; return; }
    shell.openLesson(nextOwed(fresh.session, section.topicId), fresh.session);
  };

  // SB-29: skipping shortens the session rather than backfilling. Backfilling
  // punishes honesty, and the comfort model would stop being trustworthy. The
  // words changed on 2026-08-29; the write did not.
  gotIt.addEventListener('click', async () => {
    gotIt.disabled = true;
    gotIt.textContent = 'Marking…';
    const marked = await shell.apiResult<{ ok: boolean }>(
      `/sessions/${session.id}/sections/${section.topicId}/skip`, { method: 'POST' });
    if (await shell.reopenSignIn(marked, reopen)) return;
    if (marked.kind !== 'ok' || !marked.body.ok) {
      said.textContent = "That didn't go through. Nothing changed.";
      gotIt.disabled = false;
      gotIt.textContent = LESSON_GOT_IT;
      gotIt.focus();
      return;
    }
    gotIt.textContent = 'Marked';
    await advance();
  });

  /**
   * SB-62, collapsed to the nuance one button can promise.
   *
   * The mark had two of them and the second said *"I'll bring this back and go
   * further with it"*, which a control labelled *Refresh later* cannot claim.
   * Going further is the button beside it now, and it goes further immediately
   * rather than promising a future session. Same route, same body shape, same
   * write; one fewer thing on the screen.
   */
  refreshLater.addEventListener('click', async () => {
    refreshLater.disabled = true;
    const r = await shell.api<{ ok: boolean }>(
      `/sessions/${session.id}/sections/${section.topicId}/resurface`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nuance: RESURFACE_FROM_LESSON }),
      });
    // A tap that did not land has to be said out loud, like every other write
    // on this screen. A mark the learner believes they made and did not is a
    // promise the Gardener will never keep.
    if (!r) {
      said.textContent = "That didn't go through. Nothing changed.";
      refreshLater.disabled = false;
      return;
    }
    said.textContent = resurfacedLine('refresher');
    said.focus();
  });

  /**
   * The two requests that mean "say that differently", offered where the answer
   * will appear.
   *
   * They were three buttons in the ask box and two of them mean the same thing
   * to a learner: try it simpler, or show me one. So the control is one word on
   * the lesson and the choice between them is made in the panel, next to the
   * exchange the answer lands in. Neither is a new request type: they are the
   * same two shortcut questions, sent on the same route.
   */
  const choices = panel.querySelector('[data-explain-choices]') as HTMLElement;
  explain.addEventListener('click', () => {
    if (choices.children.length) {
      (choices.querySelector('button') as HTMLElement).focus();
      return;
    }
    choices.setAttribute('aria-label', 'Choose another explanation');
    choices.append(el('<span class="alt-label">Explain it as</span>'));
    for (const shortcut of ASK_SHORTCUTS.filter((s) => s.key !== 'deeper')) {
      const choice = el(`<button data-shortcut="${esc(shortcut.key)}"></button>`) as HTMLButtonElement;
      choice.textContent = shortcut.label;
      choice.addEventListener('click', () => void ask(shortcut.question));
      choices.append(choice);
    }
    choices.removeAttribute('hidden');
    (choices.querySelector('button') as HTMLElement).focus();
  });

  const deeper = ASK_SHORTCUTS.find((s) => s.key === 'deeper');
  goDeeper.addEventListener('click', () => void ask(deeper?.question ?? 'Go deeper on that.'));

  // -------------------------------------------------------------- Learn next

  /**
   * Three things to learn after this one, drawn out of the machinery the
   * choosing rail already uses: a take on a pin opens at the window the chips
   * are set to, a ranked alternative carries the figure `/today` sent, and
   * pressing one records what was passed over. Fewer than three renders fewer;
   * none renders nothing, because a heading over nothing is scaffolding.
   */
  if (learnNext.length) {
    const block = el(`<div class="learn-next" data-lesson-part="learn-next">
      <span class="alt-label"></span>
      <div class="rail-actions"></div>
    </div>`);
    (block.querySelector('.alt-label') as HTMLElement).textContent = LEARN_NEXT_HEADING;
    const host = block.querySelector('.rail-actions') as HTMLElement;
    for (const row of learnNext.slice(0, 3)) {
      const button = el('<button class="link alt"><span class="what"></span></button>') as HTMLButtonElement;
      (button.querySelector('.what') as HTMLElement).textContent =
        railRowLabel(row.label, row.minutes);
      button.addEventListener('click', row.press);
      host.append(button);
    }
    face.insertBefore(block, face.querySelector('.sources'));
  }

  // ------------------------------------------------- the question, in the rail

  let onwardControl: HTMLButtonElement | null = null;
  if (section.question) {
    const promptId = domId('lesson-question', section.topicId);
    // The label is the rail's own block label, which is what the two headings
    // beside it in this column already are: quiet, small, and never competing
    // with the lesson's own name on the other side.
    const q = el(`<div class="q">
      <span class="alt-label">${esc(LESSON_QUESTION_HEADING)}</span>
      <div id="${esc(promptId)}" class="prompt">${esc(section.question.prompt)}</div>
      <textarea placeholder="In your own words…" aria-labelledby="${esc(promptId)}"></textarea>
      <div class="meta input-limit">Up to 1,500 characters. I assess the whole answer.</div>
      <div class="row"><button class="primary" data-answer>Answer</button></div>
    </div>`);
    panel.insertBefore(q, panel.querySelector('[data-explain-choices]'));
    answerControl(shell, q, panel, session, section, key, reopen, () => {
      paintCompletion();
      if (onwardControl && !after) onwardControl.textContent = SESSION_FINISH;
    });
  }

  const onwardRow = onward(
    after ? SESSION_NEXT : SESSION_LEAVE,
    // One accent per screen. Answer owns it while the question is open and
    // hands it over when it goes; a lesson with nothing to answer has nothing
    // else to give it to.
    !section.question,
    () => {
      if (after) { shell.openLesson(after.topicId, session); return; }
      // The section snapshot mounted before an answer landed. Closing over it
      // repeats a pre-action prediction and can call demonstrated work
      // "untested". Re-read once at the terminal boundary, then let the close be
      // computed from the flags that actually persisted.
      void (async () => {
        const fresh = await shell.api<{ session: Session | null }>('/session');
        if (!fresh?.session) { said.textContent = SESSION_NOT_REFRESHED; return; }
        shell.openLesson(null, fresh.session, true);
      })();
    },
  );
  onwardControl = onwardRow.querySelector('[data-onward]') as HTMLButtonElement;
  panel.append(onwardRow);

  return { face, panel };
}

/**
 * Where a terminal action lands the learner.
 *
 * Something was just marked done, so the honest next thing is the next lesson
 * that is NOT done — after this one where there is one, and otherwise the
 * earliest one still owed, because a learner who jumped forward should be
 * walked back to what they left rather than shown a closing note over
 * unfinished work. Null only when every lesson is done.
 */
function nextOwed(session: Session, topicId: string): string | null {
  const at = session.sections.findIndex((s) => s.topicId === topicId);
  const ahead = session.sections.slice(at + 1).find((s) => !s.completed);
  if (ahead) return ahead.topicId;
  const behindIt = session.sections.find((s) => !s.completed && s.topicId !== topicId);
  return behindIt?.topicId ?? null;
}

// ------------------------------------------------------------- the answer box


function answerControl(
  shell: LessonShell, q: HTMLElement, panel: HTMLElement,
  session: Session, section: Section, key: string,
  reopen: () => void, paintCompletion: () => void,
): void {
  const ta = q.querySelector('textarea') as HTMLTextAreaElement;
  const controls = q.querySelector('.row') as HTMLElement;
  const discard = el('<button class="link" data-discard-answer>Discard draft</button>');
  const responseFor = (): HTMLElement => {
    let response = q.querySelector('.response') as HTMLElement | null;
    if (!response) {
      response = el('<div class="response" role="status" aria-live="polite" tabindex="-1"></div>');
      q.append(response);
    }
    return response;
  };
  ta.value = LESSON_ANSWER_DRAFTS.get(key) ?? '';
  const paintDiscard = (): void => {
    if (ta.value.trim()) {
      LESSON_ANSWER_DRAFTS.set(key, ta.value);
      if (!controls.querySelector('[data-discard-answer]')) controls.append(discard);
    } else {
      LESSON_ANSWER_DRAFTS.delete(key);
      discard.remove();
    }
  };
  ta.addEventListener('input', () => {
    paintDiscard();
    const blocked = q.querySelector('.response[data-state="required"], .response[data-state="limit"]');
    if (blocked && ta.value.trim()) blocked.remove();
  });
  discard.addEventListener('click', () => { ta.value = ''; paintDiscard(); });
  paintDiscard();

  q.querySelector('[data-answer]')!.addEventListener('click', async () => {
    const written = ta.value.trim();
    if (!written) {
      const response = responseFor();
      response.dataset.state ='required';
      response.textContent = LESSON_ANSWER_REQUIRED;
      ta.focus();
      return;
    }
    const answerChars = unicodeChars(written);
    if (answerChars > LEARNER_ANSWER_MAX_CHARS) {
      const response = responseFor();
      response.dataset.state ='limit';
      response.textContent = `That answer is ${answerChars.toLocaleString('en-US')} characters. `
        + 'Keep it to 1,500 so I can assess all of it. Nothing was sent.';
      ta.focus();
      return;
    }
    const btn = q.querySelector('[data-answer]') as HTMLButtonElement;
    q.querySelectorAll('.answer-contest, .contest-form').forEach((node) => node.remove());
    LESSON_ANSWER_DRAFTS.set(key, ta.value);
    btn.disabled = true; btn.textContent = 'Reading…';
    const response = responseFor();
    response.replaceChildren();
    response.removeAttribute('data-state');
    response.setAttribute('aria-busy', 'true');
    const r = await shell.apiResult<{ response: string; signal: string }>(
      `/sessions/${session.id}/sections/${section.topicId}/answer`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: written }),
      });
    if (await shell.reopenSignIn(r, reopen)) return;
    response.removeAttribute('aria-busy');
    const reading = r.kind === 'ok' && typeof r.body.response === 'string'
      ? r.body.response.trim() : '';
    if (r.kind !== 'ok' || !reading) {
      response.textContent = r.kind === 'ok'
        ? lessonAnswerUnreadableLine('no-reading')
        : r.kind === 'unreachable'
          ? lessonAnswerUnreadableLine('unreachable')
          : lessonAnswerUnreadableLine('refused', r.status, r);
      if (r.kind !== 'ok') {
        const failure = shell.failureOf(r);
        shell.appendBudgetRecovery(response, r);
        if (failure === 'budget' || failure === 'credential') {
          btn.classList.remove('primary'); // The recovery owns the accent now.
          const recovery = el('<div class="row answer-recovery"><button class="primary">Open Models</button></div>');
          recovery.querySelector('button')!.addEventListener('click', () => shell.openModels());
          response.append(recovery);
        }
      }
      btn.disabled = false;
      btn.textContent = 'Answer';
      response.focus();
      return;
    }
    response.textContent = reading;
    const passed = r.body.signal === 'answer-correct' || r.body.signal === 'answer-right';
    if (!passed) {
      // A useful miss stays editable. The service has recorded the negative
      // evidence but deliberately kept this section open; disabling the box
      // or painting Lesson finished would contradict that state and strand
      // the learner one action short of recovery.
      btn.disabled = false;
      btn.textContent = 'Try again';
      // SB-45. Offered only where the agent can actually have been wrong about
      // the learner — a mark against them — and nowhere else.
      if (offersContest(r.body.signal)) contestControl(shell, q, session, section);
      response.focus();
      return;
    }
    LESSON_ANSWER_DRAFTS.delete(key);
    discard.remove();
    btn.remove();
    ta.disabled = true;
    // The service has recorded evidence before it returns this reading. Keep
    // the mounted session truthful as the learner pages: without this, the
    // answered lesson reappears under "Coming up" until a full service reread.
    // This is deliberately after every failure branch, so no optimistic
    // completion can be painted from a request that did not land.
    section.completed = true;
    section.completionEvidence = 'answer';
    paintCompletion();
    // One accent per screen: Answer held it and Answer has just gone.
    (panel.querySelector('[data-onward]') as HTMLElement | null)?.classList.add('primary');
    response.focus();
  });
}

/**
 * "That marking is wrong" — withdraw a bad answer mark.
 *
 * The consequence of a conceded error has been proven by test since the first
 * commit and there has never been a way to concede one, so this is a small
 * button on a large promise. It reuses `confirmStep` because it is the same kind
 * of control as a merge or a split: the learner is told exactly what happens to
 * their history before anything happens to it.
 */
function contestControl(
  shell: LessonShell, host: HTMLElement, session: Session, section: Section,
): void {
  const row = el('<div class="row answer-contest"><button class="link" data-contest>That marking is wrong</button></div>');
  const form = el('<div class="contest-form" role="status" aria-live="polite" tabindex="-1"></div>');
  const contest = row.querySelector('[data-contest]') as HTMLButtonElement;
  contest.addEventListener('click', () => {
    shell.confirmStep(form, contestConfirmLines(section.heading), 'Take the mark back', async () => {
      const r = await shell.api<{ withdrawn: number }>(
        `/sessions/${session.id}/sections/${section.topicId}/contest`, { method: 'POST' });
      if (!r) {
        form.replaceChildren(el('<p class="empty">That didn\'t go through. Nothing changed.</p>'));
        form.focus();
        return;
      }
      row.remove();
      form.replaceChildren(el(`<div class="meta">${esc(contestedLine(r.withdrawn))}</div>`));
      form.focus();
    }, contest);
  });
  host.append(row, form);
}

// ---------------------------------------------------------- the tutor exchange


function tangentExchange(
  shell: LessonShell, panel: HTMLElement, session: Session, section: Section,
  key: string, reopen: () => void,
): (raw: string) => Promise<void> {
  const turns = LESSON_TANGENT_TURNS.get(key) ?? [];
  if (!LESSON_TANGENT_TURNS.has(key)) LESSON_TANGENT_TURNS.set(key, turns);
  const exchange = panel.querySelector('[data-teaching-turns]') as HTMLElement;
  const box = panel.querySelector('.ask-box') as HTMLInputElement;
  const send = panel.querySelector('[data-send]') as HTMLButtonElement;
  const status = panel.querySelector('.lesson-question-status') as HTMLElement;
  box.placeholder = ASK_PLACEHOLDER;
  box.value = LESSON_TANGENT_DRAFTS.get(key) ?? '';

  const drawTurn = (turn: LessonTangentTurn): HTMLElement => {
    const pair = el(`<div class="lesson-tangent-turn">
      <div class="turn learner"><div class="who"></div><div class="what"></div></div>
      <div class="turn virgil" tabindex="-1"><div class="what"></div><div class="offer"></div></div>
    </div>`);
    (pair.querySelector('.learner .who') as HTMLElement).textContent = ASK_YOU;
    (pair.querySelector('.learner .what') as HTMLElement).textContent = turn.question;
    const reply = pair.querySelector('.virgil') as HTMLElement;
    (reply.querySelector('.what') as HTMLElement).textContent = turn.answer;
    const offer = reply.querySelector('.offer') as HTMLElement;
    if (turn.offerAsPin) {
      const line = el('<span class="meta" role="status" aria-live="polite" tabindex="-1"></span>');
      line.textContent = turn.pinId ? OFFER_AS_PIN_DONE : offerAsPinLine(turn.offerAsPin);
      offer.append(line);
      if (!turn.pinId) {
        const put = el('<button class="link"></button>') as HTMLButtonElement;
        put.textContent = OFFER_AS_PIN_ACTION;
        put.addEventListener('click', async () => {
          put.disabled = true;
          put.textContent = 'Putting it on the board…';
          const made = await shell.apiResult<{ id: string; label: string }>(
            `/sessions/${encodeURIComponent(session.id)}/sections/${encodeURIComponent(section.topicId)}/tangent-pin`, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                question: turn.question, label: turn.offerAsPin, clientRef: turn.clientRef,
              }),
            });
          if (await shell.reopenSignIn(made, reopen)) return;
          if (made.kind !== 'ok' || !made.body.id) {
            line.textContent = "That didn't reach your board. Nothing was added.";
            put.disabled = false;
            put.textContent = OFFER_AS_PIN_ACTION;
            line.focus();
            return;
          }
          turn.pinId = made.body.id;
          put.remove();
          line.textContent = OFFER_AS_PIN_DONE;
          line.focus();
        });
        offer.append(put);
      }
    }
    exchange.append(pair);
    return reply;
  };
  for (const turn of turns) drawTurn(turn);

  const setBusy = (busy: boolean): void => {
    for (const control of Array.from(
      panel.querySelectorAll('[data-send], [data-shortcut]'),
    ) as HTMLButtonElement[]) control.disabled = busy;
    box.disabled = busy;
    if (busy) panel.setAttribute('aria-busy', 'true');
    else panel.removeAttribute('aria-busy');
  };

  const ask = async (raw: string): Promise<void> => {
    const question = raw.trim();
    if (!question) {
      status.textContent = 'Write the question you want to ask.';
      box.focus();
      return;
    }
    const questionChars = unicodeChars(question);
    if (questionChars > LESSON_QUESTION_MAX_CHARS) {
      status.textContent = `That question is ${questionChars.toLocaleString('en-US')} characters. `
        + 'Keep it to 800 so I can read all of it. Nothing was sent.';
      box.focus();
      return;
    }
    box.value = question;
    LESSON_TANGENT_DRAFTS.set(key, question);
    status.textContent = 'Thinking…';
    setBusy(true);
    const result = await shell.apiResult<{ answer: string; offerAsPin: string | null }>(
      `/sessions/${encodeURIComponent(session.id)}/sections/${encodeURIComponent(section.topicId)}/tangent`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question,
          history: turns.slice(-2).map((turn) => ({ question: turn.question, answer: turn.answer })),
        }),
      });
    if (await shell.reopenSignIn(result, reopen)) return;
    setBusy(false);
    const answer = result.kind === 'ok' && typeof result.body.answer === 'string'
      ? result.body.answer.trim() : '';
    if (result.kind !== 'ok' || !answer) {
      const failure = result.kind === 'ok' ? 'empty' : shell.failureOf(result);
      const cause = failure === 'budget' || failure === 'credential' || failure === 'unreachable'
        || failure === 'update-service' || failure === 'update-extension'
        ? failure : 'refused';
      status.textContent = lessonQuestionFailedLine(cause);
      if (result.kind !== 'ok') shell.appendBudgetRecovery(status, result);
      if (failure === 'budget' || failure === 'credential') {
        const models = el('<button class="link">Open Models</button>');
        models.addEventListener('click', () => shell.openModels());
        status.append(models);
      }
      status.focus();
      return;
    }

    const turn: LessonTangentTurn = {
      question, answer,
      offerAsPin: typeof result.body.offerAsPin === 'string' && result.body.offerAsPin.trim()
        ? result.body.offerAsPin.trim() : null,
      clientRef: newClientRef(), pinId: null,
    };
    turns.push(turn);
    LESSON_TANGENT_DRAFTS.delete(key);
    box.value = '';
    status.textContent = '';
    drawTurn(turn).focus();
  };

  box.addEventListener('input', () => {
    if (box.value.trim()) LESSON_TANGENT_DRAFTS.set(key, box.value);
    else LESSON_TANGENT_DRAFTS.delete(key);
    if (status.textContent === 'Write the question you want to ask.') status.textContent = '';
  });
  send.addEventListener('click', () => void ask(box.value));
  box.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key !== 'Enter') return;
    event.preventDefault();
    void ask(box.value);
  });
  return ask;
}

// ------------------------------------------------------------- the challenge

/**
 * SB-45 — Virgil's teaching can be challenged at the claim, not only at the
 * later mark. The service owns source re-reading and the durable exchange;
 * this browser memory owns only the unsent challenge and its idempotency key.
 *
 * It stays on the lesson's own side, under the body, because it is about what
 * the words on that side say. A quiet disclosure, not a control competing with
 * the four the learner is meant to see.
 */
function lessonCorrectionControl(
  shell: LessonShell, host: HTMLElement, session: Session, section: Section,
  onConceded: () => void,
): HTMLElement {
  const key = lessonKey(session.id, section.topicId);
  const saved = LESSON_CORRECTION_DRAFTS.get(key) ?? { text: '', clientRef: newClientRef() };
  const id = domId('lesson-correction', section.topicId);
  const node = el(`<details class="lesson-correction">
    <summary>This is wrong</summary>
    <div class="lesson-correction-body">
      <div class="exchange correction-history" data-correction-history></div>
      <label for="${esc(id)}">What looks wrong?</label>
      <textarea id="${esc(id)}" rows="3" placeholder="Tell me what conflicts with the source"></textarea>
      <div class="meta input-limit">Up to 2,000 characters. I check the whole challenge.</div>
      <div class="row"><button data-recheck>Check the cited source</button></div>
      <div class="meta correction-status" role="status" aria-live="polite" tabindex="-1"></div>
    </div>
  </details>`);
  const history = node.querySelector('[data-correction-history]') as HTMLElement;
  const box = node.querySelector('textarea') as HTMLTextAreaElement;
  const button = node.querySelector('[data-recheck]') as HTMLButtonElement;
  const status = node.querySelector('.correction-status') as HTMLElement;
  const sources = host.querySelector('button.sources') as HTMLButtonElement | null;
  box.value = saved.text;

  const draw = (entry: LessonCorrection): HTMLElement => {
    const pair = el(`<div class="lesson-correction-turn">
      <div class="turn learner"><div class="who">You</div><div class="what"></div></div>
      <div class="turn virgil" tabindex="-1"><div class="what"></div><div class="meta receipt"></div><div class="row source-route"></div></div>
    </div>`);
    (pair.querySelector('.learner .what') as HTMLElement).textContent = entry.challenge;
    const reply = pair.querySelector('.virgil') as HTMLElement;
    (reply.querySelector('.what') as HTMLElement).textContent = entry.reply;
    (reply.querySelector('.receipt') as HTMLElement).textContent =
      lessonCorrectionReceiptLine(entry.conceded, entry.withdrawn);
    if (sources) {
      const see = el('<button class="link">See cited sources</button>') as HTMLButtonElement;
      see.addEventListener('click', () => {
        if (sources.getAttribute('aria-expanded') !== 'true') sources.click();
        sources.focus();
      });
      reply.querySelector('.source-route')!.append(see);
    }
    history.append(pair);
    return reply;
  };
  for (const entry of section.corrections ?? []) draw(entry);

  box.addEventListener('input', () => {
    const current = LESSON_CORRECTION_DRAFTS.get(key) ?? saved;
    LESSON_CORRECTION_DRAFTS.set(key, { ...current, text: box.value });
    if (status.textContent === 'Tell me what you think is wrong.') status.textContent = '';
  });
  button.addEventListener('click', async () => {
    const challenge = box.value.trim();
    if (!challenge) {
      status.textContent = 'Tell me what you think is wrong.';
      box.focus();
      return;
    }
    const challengeChars = unicodeChars(challenge);
    if (challengeChars > LESSON_CORRECTION_MAX_CHARS) {
      status.textContent = `That challenge is ${challengeChars.toLocaleString('en-US')} characters. `
        + 'Keep it to 2,000 so I can check all of it. Nothing was sent.';
      box.focus();
      return;
    }
    const draft = LESSON_CORRECTION_DRAFTS.get(key) ?? { text: challenge, clientRef: saved.clientRef };
    LESSON_CORRECTION_DRAFTS.set(key, { ...draft, text: challenge });
    button.disabled = true;
    box.disabled = true;
    node.setAttribute('aria-busy', 'true');
    status.textContent = 'Checking the cited source…';
    const result = await shell.apiResult<{ correction: LessonCorrection; section?: Section }>(
      `/sessions/${encodeURIComponent(session.id)}/sections/${encodeURIComponent(section.topicId)}/correction`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challenge, clientRef: draft.clientRef }),
      });
    if (await shell.reopenSignIn(result, () => shell.reopenAt(section.topicId))) return;
    button.disabled = false;
    box.disabled = false;
    node.removeAttribute('aria-busy');
    if (result.kind !== 'ok' || !result.body.correction?.reply?.trim()) {
      const failure = result.kind === 'unreachable' ? 'unreachable'
        : result.kind === 'refused' && result.stoppedBy === 'source-unavailable' ? 'source'
          : result.kind === 'refused' && shell.failureOf(result) === 'budget' ? 'budget'
            : result.kind === 'refused' && shell.failureOf(result) === 'credential' ? 'credential'
              : result.kind === 'refused' && shell.failureOf(result) === 'update-service' ? 'update-service'
                : result.kind === 'refused' && shell.failureOf(result) === 'update-extension' ? 'update-extension'
                  : 'refused';
      status.textContent = lessonCorrectionFailedLine(failure);
      if (result.kind !== 'ok') shell.appendBudgetRecovery(status, result);
      if (failure === 'budget' || failure === 'credential') {
        const models = el('<button class="link">Open Models</button>');
        models.addEventListener('click', () => shell.openModels());
        status.append(models);
      }
      status.focus();
      return;
    }
    section.corrections = [...(section.corrections ?? []), result.body.correction];
    if (result.body.correction.conceded) {
      const corrected = result.body.section;
      section.heading = corrected?.heading?.trim() || 'Corrected lesson';
      section.body = corrected?.body?.trim() || result.body.correction.reply;
      section.summary = corrected?.summary ?? null;
      section.question = null;
      if (typeof corrected?.estimatedMinutes === 'number') {
        section.estimatedMinutes = corrected.estimatedMinutes;
      }
      session.closingNote = null;
      onConceded();
    }
    LESSON_CORRECTION_DRAFTS.delete(key);
    box.value = '';
    status.textContent = '';
    draw(result.body.correction).focus();
  });
  return node;
}

// ------------------------------------------------------------- the provenance

/**
 * SB-44 — where every claim in this lesson came from, in one tap that writes
 * nothing. It stays on the lesson's own side, under the body, because it is a
 * fact about those words. A learner may open it on a lesson they have already
 * read, which is most of the point of it.
 */
function sourcesControl(
  shell: LessonShell, host: HTMLElement, session: Session, section: Section,
): void {
  const open = host.querySelector('.sources') as HTMLButtonElement;
  const out = host.querySelector('.sources-out') as HTMLElement;
  const said = host.querySelector('.sources-said') as HTMLElement;
  const outId = domId('lesson-sources', section.topicId);
  const closedLabel = open.textContent ?? 'Show sources';
  out.setAttribute('id', outId);
  out.setAttribute('aria-label', `Sources for ${section.heading}`);
  open.setAttribute('aria-controls', outId);
  open.setAttribute('aria-expanded', 'false');
  out.hidden = true;
  let loaded = false;

  open.addEventListener('click', async () => {
    if (loaded) {
      const expanding = out.hidden;
      out.hidden = !expanding;
      open.setAttribute('aria-expanded', String(expanding));
      open.textContent = expanding ? 'Hide sources' : closedLabel;
      said.textContent = expanding ? SOURCES_OPEN : SOURCES_HIDDEN;
      return;
    }
    const r = await shell.api<{ sources: SourceView[]; unresolved: number }>(
      `/sessions/${session.id}/sections/${section.topicId}/sources`);
    // Said out loud, like every other request on this screen that did not land.
    // Silence here would read as "there are no sources", which is a different
    // and much worse claim.
    if (!r) { said.textContent = "That didn't go through. Nothing changed."; return; }

    out.replaceChildren();
    // The label asks two questions and this answered only the second. The
    // ranker's own sentence, already on the section, answers the first.
    out.append(el(`<p class="meta sources-why">${esc(lineupWhyLine(section.why ?? null))}</p>`));
    // Several pins can come from one page. Showing the same link six times
    // hides the useful distinction (the six selected passages) behind six
    // identical receipts. Group by the checkable destination, then keep each
    // distinct excerpt inside the one page receipt.
    const groups = new Map<string, SourceView[]>();
    for (const source of r.sources ?? []) {
      const groupKey = [source.origin, safeHref(source.url) ?? source.url ?? '', source.title ?? ''].join('\u0000');
      const group = groups.get(groupKey) ?? [];
      group.push(source);
      groups.set(groupKey, group);
    }
    for (const group of groups.values()) {
      const source = group[0]!;
      const line = group.length === 1
        ? sourceLine(source)
        : source.origin === 'user-pin'
          ? `${group.length} selections from the same page you pinned`
          : source.origin === 'agent-sourced'
            ? `${group.length} references to the same background page I found, not from your pins`
            : null;
      // A source whose origin is neither is not described. The provenance
      // surface does not account for what it cannot account for.
      if (!line) continue;
      const href = safeHref(source.url);
      const title = (source.title ?? '').replace(/\s+/g, ' ').trim();
      const named = title
        ? `: ${href ? `<a href="${esc(href)}" target="_blank" rel="noreferrer noopener">${esc(title)}</a>` : esc(title)}`
        : '';
      const receipt = el(`<div class="source">${esc(line)}${named}</div>`);
      const excerpts = [...new Set(group
        .map((item) => item.excerpt?.replace(/\s+/g, ' ').trim() ?? '')
        .filter(Boolean))];
      for (const excerpt of excerpts) {
        const quote = el('<q class="source-excerpt"></q>');
        quote.textContent = excerpt;
        receipt.append(quote);
      }
      const latestAvailability = group
        .map((item) => item.availability ?? null)
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))[0];
      if (latestAvailability?.status === 'unavailable') {
        const unavailable = el('<div class="meta source-availability"></div>');
        unavailable.textContent = sourceAvailabilityLine(latestAvailability);
        receipt.append(unavailable);
      }
      out.append(receipt);
    }

    const missing = unresolvedSourcesLine(r.unresolved ?? 0);
    if (missing) out.append(el(`<div class="meta unresolved">${esc(missing)}</div>`));
    loaded = true;
    out.hidden = false;
    open.setAttribute('aria-expanded', 'true');
    open.textContent = 'Hide sources';
    said.textContent = SOURCES_OPEN;
  });
}
