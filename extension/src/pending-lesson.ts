import type { Section } from './lesson.js';

export interface ForegroundQuickTakeReply {
  outcome: string;
  failureReason?: string | null;
  body: string;
  heading?: string | null;
  label: string | null;
  register: Section['depth'];
  topicId?: string | null;
  topicLabel?: string | null;
  subject?: { courseId: string; title: string } | null;
  pinned?: {
    text: string; kind: string; pageTitle: string; url: string | null; note: string | null;
  };
}

export interface PendingBoardLesson {
  pinId: string;
  minutes: 1 | 3 | 5;
  heldBack: boolean;
}

type PendingResult =
  | { readonly kind: 'ok'; readonly body: ForegroundQuickTakeReply }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'refused'; readonly status: number | null; readonly stoppedBy?: string | null };
type ReadyResult = Extract<PendingResult, { kind: 'ok' }>;

const RESULTS = new Map<string, ReadyResult>();

export const clearPendingLessonResults = (): void => { RESULTS.clear(); };

interface PendingLessonDeps {
  readonly restingLabel: string;
  readonly onScreen: (node: HTMLElement) => boolean;
  readonly run: () => Promise<PendingResult>;
  readonly open: (result: ReadyResult) => Promise<void>;
  readonly failureLine: (result: Exclude<PendingResult, { kind: 'ok' }>) => string;
}

const nonReadyLine = (result: ReadyResult): string => result.body.outcome === 'unverified'
  ? 'That version did not pass its source check. It is still pending.'
  : 'That lesson was not built. It is still pending.';

/** Keep a checked result when its Board card leaves the DOM while the run is in flight. */
export async function runPendingLesson(
  card: HTMLElement, lesson: PendingBoardLesson, button: HTMLButtonElement,
  deps: PendingLessonDeps,
): Promise<void> {
  const status = card.querySelector('.run-status') as HTMLElement;
  const prepared = RESULTS.get(lesson.pinId);
  if (prepared) {
    RESULTS.delete(lesson.pinId);
    await deps.open(prepared);
    return;
  }
  button.disabled = true;
  button.textContent = 'Running…';
  status.textContent = 'Writing and checking this lesson…';
  const result = await deps.run();
  if (!deps.onScreen(card)) {
    button.disabled = false;
    button.textContent = deps.restingLabel;
    if (result.kind === 'ok' && result.body.outcome === 'ready' && result.body.body) {
      RESULTS.set(lesson.pinId, result);
      status.textContent = 'Ready to open.';
    } else status.textContent = result.kind === 'ok' ? nonReadyLine(result) : deps.failureLine(result);
    return;
  }
  if (result.kind !== 'ok') {
    status.textContent = deps.failureLine(result);
    button.disabled = false;
    button.textContent = deps.restingLabel;
    button.focus();
    return;
  }
  if (result.body.outcome !== 'ready' || !result.body.body) {
    status.textContent = nonReadyLine(result);
    button.disabled = false;
    button.textContent = deps.restingLabel;
    button.focus();
    return;
  }
  await deps.open(result);
}
