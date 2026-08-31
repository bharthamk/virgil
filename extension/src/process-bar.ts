import {
  batchActivityLine, batchRecoveryAction, batchStageReceiptLine, buildingStageLine,
  cardIsStartable, hasSomethingReady, modelConnectionLabel,
  type BatchActivityView, type SessionCardView, type SessionView,
} from './panel-core.js';


const el = (html: string): HTMLElement => {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLElement;
};

/**
 * The two facts the strip cannot read out of `/batch`, and both of them make
 * "nothing new is waiting" false in a different way.
 */
export interface BoardWaiting {
  /**
   * A checked lesson is built, startable, and nothing in it has been done yet.
   *
   * There is no "opened" record anywhere and there must not be one: drawing a
   * screen writes nothing in this product. What the store does keep is the
   * resume pointer and the per-section completion, and those are the same fact
   * `/today` already reads to say *Start* rather than *Continue*. So this is
   * "built and not begun", said out of what is already written down.
   */
  readonly lessonReady: boolean;
  /** Pending night proposals, as `GET /prospects` counts them. Zero on a
   *  service too old to answer it, which is a missing capability and not a
   *  fault. */
  readonly proposals: number;
}

export const NOTHING_WAITING: BoardWaiting = { lessonReady: false, proposals: 0 };

export function boardWaiting(
  card: SessionCardView | null,
  session: SessionView | null,
  proposals: number,
): BoardWaiting {
  const begun = (session?.sections ?? []).some((section) => section.completed === true)
    || (session?.currentSectionIndex ?? 0) > 0;
  return {
    lessonReady: cardIsStartable(card) && hasSomethingReady(session) && !begun,
    proposals: Math.max(0, proposals),
  };
}

export const STRIP_LESSON_READY = 'Your lesson is ready when you are.';
export const STRIP_OPEN_LESSON = 'Open the lesson';
export const STRIP_MODELS_ACTION = 'Check model connection';
export const STRIP_MODELS_LINE = 'Fix the model connection before building again.';
export const STRIP_RETRY_ACTION = 'Try Process again';
export const STRIP_WORKING_LINE = 'Working through what is on your board…';
export const STRIP_NOT_STARTED_LINE =
  'I could not start that. It is mine to fix, and nothing has been spent.';
export const STRIP_WORK_HEADING = 'What Virgil did';
export const STRIP_PROCESS = 'Process';
export const STRIP_BUILD_REFRESH = 'Build a refresh';
export const STRIP_BUILD_LESSON = 'Build a lesson';
export const STRIP_NOTHING_NEW = 'Nothing new is waiting.';
export const STRIP_REFRESH_OFFER =
  'You can build a short refresh from what you have already learned.';
export const STRIP_FULL_LESSON_OFFER =
  'You can build a full lesson from what is already on your board.';

export const stripCostLine = (calls: number): string => `about ${calls} model calls`;

export const stripStepsLine = (steps: number): string =>
  `${steps} ${steps === 1 ? 'step' : 'steps'} finished`;

/**
 * The idle offer, with its opening clause removed when it would be a lie.
 *
 * "Nothing new is waiting" is a claim about the whole product, and the night
 * scout can make it false without touching `/batch`: three proposals nobody has
 * answered are new, and they are waiting. The offer under it is unchanged and
 * still true, so it is the clause above it that goes.
 */
export function stripOfferLine(settled: boolean, proposals: number): string {
  const offer = settled ? STRIP_REFRESH_OFFER : STRIP_FULL_LESSON_OFFER;
  return proposals > 0 ? offer : `${STRIP_NOTHING_NEW} ${offer}`;
}

export const proposalsWaitingLine = (n: number): string => (n === 1
  ? 'I have a suggestion waiting in My studies.'
  : `I have ${n} suggestions waiting in My studies.`);

/** Everything the strip does that leaves the strip. Handed in, so this module
 *  knows no route and reaches no service of its own. */
export interface ProcessBarShell {
  readonly api: <T>(path: string, init?: RequestInit) => Promise<T | null>;
  readonly onScreen: (node: HTMLElement) => boolean;
  /** Open tonight's built lesson, rather than asking Today to choose again. */
  readonly openLesson: () => void;
  readonly openModels: () => void;
  /** My studies, where the night's proposals are reviewed. */
  readonly openStudies: () => void;
}

interface ProcessModelConfig {
  readonly providers?: Readonly<Record<string, { readonly readiness?: string }>>;
  readonly routes?: { readonly quick?: string; readonly deep?: string };
}

const activeModelRoutesReady = (config: ProcessModelConfig | null): boolean => {
  if (!config?.providers || !config.routes) return false;
  return [config.routes.quick, config.routes.deep].every((mode) =>
    typeof mode === 'string' && config.providers?.[mode]?.readiness === 'ready');
};

const activeModelRoutesLine = (config: ProcessModelConfig | null): string => {
  const quick = modelConnectionLabel(config?.routes?.quick);
  const deep = modelConnectionLabel(config?.routes?.deep);
  if (!quick || !deep) return 'Model routes · not checked';
  return quick === deep ? `${quick} · ready` : `Quick: ${quick} · Deep: ${deep} · ready`;
};

export async function processControl(
  shell: ProcessBarShell,
  hasLearningMaterial = true, hasSettledLearning = true,
  waiting: BoardWaiting = NOTHING_WAITING,
): Promise<HTMLElement | null> {
  type BatchState = {
    run: boolean; because: string; line: string;
    unprocessedPins: number; estimatedCalls: number; autoAfter: number | null;
    /** Added 2026-08-24. Absent from an older service, which says nothing. */
    building?: boolean;
    /** Added 2026-08-26. The exact pipeline stage currently in flight. */
    currentStage?: string | null;
    /** The current or most recent run, safe to repaint after navigation. */
    activity?: BatchActivityView | null;
  };
  const [state, initialModels] = await Promise.all([
    shell.api<BatchState>('/batch'), shell.api<ProcessModelConfig>('/model-config'),
  ]);
  if (!state || typeof state.line !== 'string') return null;
  if (!hasLearningMaterial && state.because === 'nothing-new'
    && !state.building && !state.activity) return null;

  const node = el(`<div class="zone processbar" data-zone="process" data-guide-section="process">
    <p class="line"></p>
    <div class="run-receipt" aria-live="polite"></div>
    <div class="row"></div>
    <p class="waiting-elsewhere"></p>
  </div>`);
  const line = node.querySelector('.line') as HTMLElement;
  const elsewhere = node.querySelector('.waiting-elsewhere') as HTMLElement;
  const receipt = node.querySelector('.run-receipt') as HTMLElement;
  const row = node.querySelector('.row') as HTMLElement;
  let polls = 0;
  let watching = false;
  let modelConfig = initialModels;
  let repairedModels = activeModelRoutesReady(modelConfig);
  let liveRunObserved = state.building
    || state.activity?.state === 'queued' || state.activity?.state === 'running';

  const recoveryFor = (activity: BatchActivityView | null | undefined) => {
    if (!activity) return null;
    const recovery = batchRecoveryAction(activity);
    if (recovery === 'lesson' && !waiting.lessonReady && !liveRunObserved) return null;
    const budgetStopped = activity.outcome === 'quota-degraded'
      || activity.failureReason === 'model-budget';
    return recovery === 'models' && repairedModels && !budgetStopped ? 'retry' : recovery;
  };

  const startRun = async (button: HTMLButtonElement): Promise<void> => {
    button.disabled = true;
    line.textContent = 'Checking the assigned model routes…';
    modelConfig = await shell.api<ProcessModelConfig>('/model-config');
    repairedModels = activeModelRoutesReady(modelConfig);
    if (!repairedModels) {
      paint(state);
      return;
    }
    liveRunObserved = true;
    line.textContent = STRIP_WORKING_LINE;
    const started = await shell.api<{ ok: boolean }>('/batch', { method: 'POST' });
    if (!started?.ok) {
      line.textContent = STRIP_NOT_STARTED_LINE;
      button.disabled = false;
      return;
    }
    const live = await shell.api<BatchState>('/batch');
    // An older service can accept the run without publishing activity yet.
    // Keep the truthful post-click line in that compatibility window instead
    // of repainting it as idle from a response that cannot describe the run.
    if (live?.building || live?.activity) paint(live);
    watch();
  };

  /**
   * The one door a built lesson has, wherever the strip offers it.
   *
   * A completed run can coexist with a shorter Today action (a recall burst or
   * exact course item), and the strip names the lesson it is talking about, so
   * it opens that session directly rather than asking Today to choose again and
   * potentially sending the learner somewhere else.
   */
  const openLessonAction = (): HTMLButtonElement => {
    const action = el('<button class="link run-action"></button>') as HTMLButtonElement;
    action.textContent = STRIP_OPEN_LESSON;
    action.addEventListener('click', () => shell.openLesson());
    return action;
  };

  /**
   * What is waiting somewhere that is not this board.
   *
   * A door beside the strip's accent button, and a plain sentence when the
   * strip's own action is itself a quiet link: two links under one line are two
   * offers and no answer to which one the screen is for. Either way it is said,
   * because three proposals nobody has answered are waiting whichever control
   * this strip happens to be carrying.
   */
  const waitingSentence = (n: number, door: boolean): HTMLElement => {
    const node = el(door
      ? '<button class="link waiting-door"></button>'
      : '<span class="waiting-said"></span>');
    node.textContent = proposalsWaitingLine(n);
    if (door) node.addEventListener('click', () => shell.openStudies());
    return node;
  };

  const paintActivity = (activity: BatchActivityView | null | undefined): void => {
    receipt.replaceChildren();
    if (!activity) return;
    const outcome = el('<p class="run-outcome"></p>');
    outcome.textContent = batchActivityLine(activity);
    receipt.append(outcome);

    if (activity.reports.length) {
      const details = el('<details class="run-work"><summary></summary><ol></ol></details>');
      (details.querySelector('summary') as HTMLElement).textContent = activity.state === 'running'
        ? stripStepsLine(activity.reports.length)
        : STRIP_WORK_HEADING;
      const list = details.querySelector('ol') as HTMLElement;
      for (const report of activity.reports) {
        const item = el(`<li data-failed="${report.failed ? 'yes' : 'no'}"></li>`);
        item.textContent = batchStageReceiptLine(report);
        list.append(item);
      }
      receipt.append(details);
    }

    const recovery = recoveryFor(activity);
    if (!recovery) return;
    if (recovery === 'lesson') { receipt.append(openLessonAction()); return; }
    const action = el('<button class="link run-action"></button>') as HTMLButtonElement;
    if (recovery === 'models') {
      action.textContent = STRIP_MODELS_ACTION;
      action.addEventListener('click', () => shell.openModels());
    } else {
      action.textContent = STRIP_RETRY_ACTION;
      action.addEventListener('click', () => void startRun(action));
    }
    receipt.append(action);
  };

  const paint = (next: BatchState): void => {
    const recovery = recoveryFor(next.activity);
    const repairModels = recovery === 'models';
    const nothingNew = !repairModels && !next.run && next.because === 'nothing-new';
    const ready = nothingNew && waiting.lessonReady;
    const refresh = nothingNew && !ready && hasSettledLearning;
    const fullLesson = nothingNew && !ready && !hasSettledLearning;
    line.textContent = next.building
      ? buildingStageLine(next.currentStage, next.unprocessedPins)
      : repairModels
        ? STRIP_MODELS_LINE
      : !repairedModels
        ? 'Connect the assigned model routes before processing.'
      : ready
        ? STRIP_LESSON_READY
      : refresh || fullLesson
        ? stripOfferLine(refresh, waiting.proposals)
      : next.line;
    paintActivity(next.activity);
    row.replaceChildren();
    elsewhere.replaceChildren();
    // A terminal receipt owns one next move. In particular, a checked lesson
    // must not compete with a fresh seven-call build before it has been opened.
    // States with no receipt recovery may still offer the ordinary refresh.
    if (next.building || next.because === 'paused' || recovery) return;
    if (!repairedModels) {
      const models = el('<button class="link run-action">Open Models</button>') as HTMLButtonElement;
      models.addEventListener('click', () => shell.openModels());
      row.append(models);
      return;
    }
    if (ready) {
      row.append(openLessonAction());
      if (waiting.proposals) elsewhere.append(waitingSentence(waiting.proposals, false));
      return;
    }

    const go = el('<button class="primary"></button>') as HTMLButtonElement;
    go.textContent = refresh ? STRIP_BUILD_REFRESH : fullLesson ? STRIP_BUILD_LESSON : STRIP_PROCESS;
    const cost = el('<span class="cost"></span>');
    cost.textContent = `${stripCostLine(next.estimatedCalls)} · ${activeModelRoutesLine(modelConfig)}`;
    go.addEventListener('click', () => void startRun(go));
    row.append(cost, go);
    if (waiting.proposals) elsewhere.append(waitingSentence(waiting.proposals, true));
  };

  const poll = async (): Promise<void> => {
    watching = false;
    polls += 1;
    if (polls > 2400 || !shell.onScreen(node)) return;
    const next = await shell.api<BatchState>('/batch');
    if (!next || !shell.onScreen(node)) return;
    paint(next);
    if (next.building) watch();
  };

  function watch(): void {
    if (watching || !shell.onScreen(node)) return;
    watching = true;
    setTimeout(() => { void poll(); }, 1500);
  }

  /**
   * A run already going, said on arrival rather than only to whoever started it.
   *
   * `POST /batch` has always answered "one is already being built" and only the
   * button that had just been pressed could hear it. A night is minutes of
   * model work, so a learner who starts one, walks away and comes back was told
   * nothing at all — and pressing again looked like it had done something.
   */
  if (state.building) {
    paint(state);
    setTimeout(watch, 0);
    return node;
  }

  paint(state);
  // Returned rather than appended. The board rebuilds itself on every keystroke
  // of the search, and this control has state a rebuild would throw away — a
  // learner who presses Process and then types would watch "Working through
  // what is on your board…" turn back into an offer to start it. Built once and
  // MOVED into each redraw, it keeps whatever it is in the middle of.
  return node;
}
