/**
 * A foreground quick lesson, inside the canonical two-sided lesson shell.
 *
 * A session section and a quick take do not share persistence: the former has
 * a stored question, completion state and section routes; the latter is a
 * checked explanation over one pin whose only evidence is an optional
 * quick-take verdict. They do share the learner-facing object: one lesson.
 * This module keeps the different writes behind handed-in callbacks while
 * drawing the same lesson/teaching structure and control grammar as
 * `lesson.ts`.
 */
import {
  ASK_PLACEHOLDER, ASK_SEND, ASK_SHORTCUTS, ASK_YOU,
  OFFER_AS_PIN_ACTION, OFFER_AS_PIN_DONE,
  askFailedLine, bodyBlocks, esc, offerAsPinLine, railRowLabel,
} from './panel-core.js';
import {
  LESSON_CONTINUE_HEADING, LESSON_EXPLAIN_AGAIN, LESSON_GO_DEEPER,
  LESSON_GOT_IT, LESSON_REFRESH_LATER, LEARN_NEXT_HEADING,
  type LearnNextRow,
} from './lesson.js';
import { newClientRef } from './pin-body.js';
import {
  quickTakeClose,
  type QuickTakeCloseReply, type QuickTakeVerdict,
} from './quick-take-close.js';

export interface ForegroundAskTurn {
  readonly who: 'learner' | 'virgil';
  readonly text: string;
}

export interface ForegroundAskReply {
  readonly outcome: string;
  readonly body: string;
  readonly offerAsPin: string | null;
}

export interface ForegroundLessonDeps {
  readonly el: (html: string) => HTMLElement;
  readonly family: string | null;
  readonly area: string;
  readonly body: string;
  readonly source: HTMLElement | null;
  readonly learnNext: readonly LearnNextRow[];
  readonly handoffs: HTMLElement;
  readonly ask: (
    question: string, exchange: readonly ForegroundAskTurn[],
  ) => Promise<ForegroundAskReply | null>;
  readonly saveOffer: (
    passage: string, question: string, clientRef: string,
  ) => Promise<boolean>;
  readonly answer: (verdict: QuickTakeVerdict) => Promise<QuickTakeCloseReply | null>;
  readonly closed: (receipt: string) => void;
  readonly protectQuestion?: (root: HTMLElement, field: HTMLInputElement) => void;
}

export interface ForegroundLessonSurfaces {
  readonly face: HTMLElement;
  readonly panel: HTMLElement;
  readonly heading: HTMLElement;
}

const ASK_MAX_CHARS = 1_200;
const unicodeChars = (value: string): number => Array.from(value).length;

const fillBody = (
  el: (html: string) => HTMLElement, host: HTMLElement, text: string,
): void => {
  host.replaceChildren();
  for (const block of bodyBlocks(text)) {
    const node = el(block.kind === 'code' ? '<pre class="code"></pre>' : '<p class="para"></p>');
    node.textContent = block.text;
    host.append(node);
  }
};

/**
 * Draw one checked foreground lesson using the same visible grammar as a
 * stored lesson. Nothing in this function invents session state: every write
 * and every exit comes from the foreground callbacks above.
 */
export function foregroundLessonSurfaces(
  deps: ForegroundLessonDeps,
): ForegroundLessonSurfaces {
  const face = deps.el(`<div class="section foreground-lesson" data-foreground-lesson data-guide-section="quick-lesson">
    <h1 class="lesson-area" data-lesson-part="area"></h1>
    <div class="body" data-lesson-part="body"></div>
    <p class="meta lesson-said" role="status" aria-live="polite"></p>
  </div>`);
  const heading = face.querySelector('.lesson-area') as HTMLElement;
  heading.textContent = deps.area;
  if (deps.family) {
    const family = deps.el('<p class="lesson-family" data-lesson-part="family"></p>');
    family.textContent = deps.family;
    face.insertBefore(family, heading);
  }
  fillBody(deps.el, face.querySelector('.body') as HTMLElement, deps.body);
  const said = face.querySelector('.lesson-said') as HTMLElement;

  if (deps.source) {
    const source = deps.el(`<details class="foreground-source">
      <summary class="link">Show source</summary>
      <div class="foreground-source-body"></div>
    </details>`);
    (source.querySelector('.foreground-source-body') as HTMLElement).append(deps.source);
    face.insertBefore(source, said);
  }

  const panel = deps.el(`<div class="rail-stack foreground-lesson-rail">
    <div class="rail-block teaching" data-rail="teaching">
      <div class="explain-choices row" data-explain-choices hidden></div>
      <div class="continue-learning" data-continue>
        <span class="alt-label">${esc(LESSON_CONTINUE_HEADING)}</span>
        <div class="continue-body">
          <div class="exchange teaching-turns" data-teaching-turns></div>
          <div class="ask">
            <label>Your question</label>
            <div class="row field"><input class="ask-box" type="text"><button data-send>${esc(ASK_SEND)}</button></div>
            <div class="meta input-limit">Up to 1,200 characters. Sending makes one API call to your configured model.</div>
          </div>
          <div class="meta ask-status" role="status" aria-live="polite"></div>
        </div>
      </div>
    </div>
  </div>`);
  const teaching = panel.querySelector('[data-rail="teaching"]') as HTMLElement;
  const choices = teaching.querySelector('[data-explain-choices]') as HTMLElement;
  const exchange = teaching.querySelector('[data-teaching-turns]') as HTMLElement;
  const box = teaching.querySelector('.ask-box') as HTMLInputElement;
  const send = teaching.querySelector('[data-send]') as HTMLButtonElement;
  const askStatus = teaching.querySelector('.ask-status') as HTMLElement;
  box.setAttribute('placeholder', ASK_PLACEHOLDER);

  const turns: ForegroundAskTurn[] = [];
  let interactionPending = false;
  let failedAttempt: {
    question: string; questionNode: HTMLElement; replyNode: HTMLElement;
  } | null = null;
  let shortcutButtons: HTMLButtonElement[] = [];
  let verdictButtons: readonly HTMLButtonElement[] = [];

  const setInteractionPending = (pending: boolean): void => {
    interactionPending = pending;
    send.disabled = pending;
    box.disabled = pending;
    for (const button of shortcutButtons) button.disabled = pending;
    for (const button of verdictButtons) button.disabled = pending;
    if (pending) face.setAttribute('aria-busy', 'true');
    else face.removeAttribute('aria-busy');
  };

  const close = quickTakeClose({
    el: deps.el,
    busy: () => interactionPending,
    setBusy: setInteractionPending,
    answer: deps.answer,
    closed: deps.closed,
  });
  verdictButtons = close.buttons;
  const [gotIt, refreshLater, notNow] = verdictButtons;
  if (!gotIt || !refreshLater || !notNow) throw new Error('quick lesson verdict controls are incomplete');
  gotIt.textContent = LESSON_GOT_IT;
  refreshLater.textContent = LESSON_REFRESH_LATER;
  gotIt.classList.add('chalk');
  refreshLater.classList.add('chalk');

  const ask = async (question: string): Promise<void> => {
    if (interactionPending) return;
    const asked = question.trim();
    if (!asked) return;
    const count = unicodeChars(asked);
    if (count > ASK_MAX_CHARS) {
      askStatus.textContent = `That question is ${count.toLocaleString('en-US')} characters. Keep it to 1,200 so I can read all of it. Nothing was sent.`;
      box.focus();
      return;
    }
    if (failedAttempt?.question === asked) {
      failedAttempt.questionNode.remove();
      failedAttempt.replyNode.remove();
      failedAttempt = null;
    }
    const draftBefore = box.value;
    const manual = draftBefore.trim() === asked;
    askStatus.textContent = '';
    setInteractionPending(true);

    const mine = deps.el('<div class="turn learner"><div class="who"></div><div class="what"></div></div>');
    (mine.querySelector('.who') as HTMLElement).textContent = ASK_YOU;
    (mine.querySelector('.what') as HTMLElement).textContent = asked;
    const waiting = deps.el('<div class="thinking" role="status">Writing…</div>');
    exchange.append(mine, waiting);

    const answer = await deps.ask(asked, turns);
    waiting.remove();
    setInteractionPending(false);

    const reply = deps.el('<div class="turn virgil"><div class="what"></div><div class="offer"></div></div>');
    const ok = answer?.outcome === 'ready' && !!answer.body;
    (reply.querySelector('.what') as HTMLElement).textContent = ok ? answer!.body : askFailedLine();
    exchange.append(reply);
    if (!ok) {
      failedAttempt = { question: asked, questionNode: mine, replyNode: reply };
      if (manual) box.value = draftBefore;
      box.focus();
      return;
    }

    if (manual) box.value = '';
    turns.push({ who: 'learner', text: asked }, { who: 'virgil', text: answer!.body });
    if (manual) box.focus();
    if (!answer!.offerAsPin) return;

    const offer = reply.querySelector('.offer') as HTMLElement;
    const line = deps.el('<span class="meta"></span>');
    line.textContent = offerAsPinLine(answer!.offerAsPin);
    const put = deps.el('<button class="link"></button>') as HTMLButtonElement;
    const clientRef = newClientRef();
    put.textContent = OFFER_AS_PIN_ACTION;
    put.addEventListener('click', async () => {
      put.disabled = true;
      line.textContent = 'Putting it on the board…';
      const saved = await deps.saveOffer(answer!.offerAsPin!, asked, clientRef);
      if (!saved) {
        put.disabled = false;
        line.textContent = "That didn't go through. Nothing changed.";
        put.focus();
        return;
      }
      put.remove();
      line.textContent = OFFER_AS_PIN_DONE;
    });
    offer.append(line, put);
  };

  const controls = deps.el(`<div class="row lesson-controls" data-lesson-part="controls">
    <button class="chalk" data-explain>${esc(LESSON_EXPLAIN_AGAIN)}</button>
    <button class="chalk" data-go-deeper>${esc(LESSON_GO_DEEPER)}</button>
  </div>`);
  const explain = controls.querySelector('[data-explain]') as HTMLButtonElement;
  controls.insertBefore(refreshLater, explain);
  controls.insertBefore(gotIt, refreshLater);
  notNow.textContent = 'Not now';
  notNow.classList.add('chalk');
  controls.append(notNow);
  (controls.querySelector('[data-explain]') as HTMLButtonElement).addEventListener('click', () => {
    if (!choices.children.length) {
      for (const shortcut of ASK_SHORTCUTS.filter((item) => item.key !== 'deeper')) {
        const button = deps.el(`<button data-shortcut="${esc(shortcut.key)}"></button>`) as HTMLButtonElement;
        button.textContent = shortcut.label;
        button.addEventListener('click', () => void ask(shortcut.question));
        choices.append(button);
      }
      shortcutButtons = Array.from(choices.querySelectorAll('[data-shortcut]')) as HTMLButtonElement[];
      choices.removeAttribute('hidden');
    }
    (choices.firstElementChild as HTMLElement | null)?.focus();
  });
  const deeper = ASK_SHORTCUTS.find((item) => item.key === 'deeper');
  (controls.querySelector('[data-go-deeper]') as HTMLButtonElement).addEventListener(
    'click', () => void ask(deeper?.question ?? 'Go deeper on that.'),
  );
  face.insertBefore(controls, face.querySelector('.foreground-source') ?? said);

  if (deps.learnNext.length) {
    const next = deps.el(`<div class="learn-next" data-lesson-part="learn-next">
      <span class="alt-label">${esc(LEARN_NEXT_HEADING)}</span>
      <div class="rail-actions"></div>
    </div>`);
    const host = next.querySelector('.rail-actions') as HTMLElement;
    for (const row of deps.learnNext.slice(0, 3)) {
      const button = deps.el('<button class="link alt"><span class="what"></span></button>') as HTMLButtonElement;
      (button.querySelector('.what') as HTMLElement).textContent = railRowLabel(row.label, row.minutes);
      button.addEventListener('click', row.press);
      host.append(button);
    }
    face.insertBefore(next, face.querySelector('.foreground-source') ?? said);
  }

  send.addEventListener('click', () => void ask(box.value));
  box.addEventListener('input', () => { askStatus.textContent = ''; });
  box.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') void ask(box.value);
  });
  deps.protectQuestion?.(panel, box);

  teaching.append(close.said);
  panel.append(deps.handoffs);
  return { face, panel, heading };
}
