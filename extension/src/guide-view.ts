import {
  type GuideSectionId, type GuideSurface, type GuideTarget, type GuideViewInput,
} from './guide-core.js';

export const GUIDE_STATE_KEY = 'virgil_guide_state_v1';
export const GUIDE_NEXT_EVENT = 'virgil:guide-next';

interface GuidePacket {
  readonly surface: GuideSurface;
  readonly target: GuideTarget;
  readonly targetLabel: string;
  readonly message: string;
  readonly exactSectionId?: GuideSectionId;
  readonly canonicalState: {
    readonly room: string | null;
    readonly face: string | null;
  };
}

interface GuideState {
  readonly awaitingNext: boolean;
  readonly nextAdvanced: boolean;
  readonly paused: boolean;
  readonly lastGuide: GuidePacket | null;
  readonly pausedAt: GuidePacket | null;
}

const emptyState = (): GuideState => ({
  awaitingNext: false, nextAdvanced: false, paused: false,
  lastGuide: null, pausedAt: null,
});

const targetLabels: Readonly<Record<GuideTarget, string>> = {
  top: 'Virgil navigation',
  'capture-entry': 'Capture',
  'captured-item': 'captured pin',
  pins: 'Pins inbox',
  'learn-surface': 'Learn',
  'grow-surface': 'Grow',
  'manage-surface': 'Manage',
  'customize-settings': 'Customize',
  'current-priority': 'current priority',
};

/** Default guide copy is written for each destination rather than assembled
 * from its short label. Labels are nouns for headings; they are not all nouns
 * that fit after “This is the…”. */
const targetMessages: Readonly<Record<GuideTarget, string>> = {
  top: 'This is Virgil’s main navigation.',
  'capture-entry': 'This is where you add something to learn.',
  'captured-item': 'This is the pin you just captured.',
  pins: 'This is your Pins inbox.',
  'learn-surface': 'This is where your current lesson and lineup live.',
  'grow-surface': 'This is your Board, where Virgil shows how your learning is developing.',
  'manage-surface': 'This is where you plan work and manage your studies.',
  'customize-settings': 'These are Virgil’s settings.',
  'current-priority': 'This is the one learning move Virgil recommends now.',
};

const encode = (value: string): string => {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
};

async function loadState(): Promise<GuideState> {
  try {
    const stored = await chrome.storage.local.get(GUIDE_STATE_KEY);
    const value = stored?.[GUIDE_STATE_KEY] as Partial<GuideState> | null;
    if (!value || typeof value !== 'object') return emptyState();
    return {
      awaitingNext: value.awaitingNext === true,
      nextAdvanced: value.nextAdvanced === true,
      paused: value.paused === true,
      lastGuide: value.lastGuide ?? null,
      pausedAt: value.pausedAt ?? null,
    };
  } catch { return emptyState(); }
}

const saveState = async (state: GuideState): Promise<void> => {
  try { await chrome.storage.local.set({ [GUIDE_STATE_KEY]: state }); }
  catch { /* the visible overlay still works for this page lifetime */ }
};

const appNode = (): HTMLElement | null => document.getElementById('app');

function canonicalState(): GuidePacket['canonicalState'] {
  const app = appNode();
  return {
    room: app?.dataset.room ?? null,
    face: app?.querySelector('[data-learn-face]')?.getAttribute('data-learn-face') ?? null,
  };
}

function visibleSurface(): GuideSurface | null {
  const app = appNode();
  const room = app?.dataset.room;
  if (room === 'today') {
    const face = app?.querySelector('[data-learn-face]')?.getAttribute('data-learn-face');
    if (face === 'pins') return 'capture';
    if (face === 'board') return 'grow';
    if (face === 'learn') return 'learn';
  }
  if (room === 'plan' || room === 'courses' || room === 'check') return 'manage';
  if (room === 'privacy') return 'customize';
  return null;
}

function setApplicationPaused(paused: boolean): void {
  const app = appNode();
  if (!app) return;
  app.toggleAttribute('inert', paused);
  document.documentElement.toggleAttribute('data-guide-paused', paused);
}

function clearSpotlight(): void {
  for (const node of Array.from(document.querySelectorAll('[data-guide-spotlight="true"]'))) {
    node.removeAttribute('data-guide-spotlight');
  }
}

function clearOverlay(): void {
  document.getElementById('virgil-guide-overlay')?.remove();
}

function guideTarget(target: GuideTarget, section?: GuideSectionId): HTMLElement | null {
  const base = document.querySelector(`[data-guide-target="${encode(target)}"]`) as HTMLElement | null;
  if (!base || !section) return base;
  if (base.dataset.guideSection === section) return base;
  return base.querySelector(`[data-guide-section="${encode(section)}"]`) as HTMLElement | null;
}

function packetText(packet: GuidePacket | null): string {
  if (!packet) return 'none';
  return `${packet.targetLabel}: ${packet.message}`;
}

function result(
  code: 'VIEW_GUIDED' | 'GUIDE_WAITING_FOR_PERSON' | 'GUIDE_PAUSED_FOR_QUESTION'
    | 'GUIDE_TARGET_NOT_VISIBLE',
  packet: GuidePacket | null, detail: string,
): string {
  return [
    `resultCode: ${code}`,
    'acceptedStateChanged: false',
    `detail: ${detail}`,
    `pausedAt: ${packetText(packet)}`,
  ].join('\n');
}

async function notVisible(detail: string): Promise<string> {
  setApplicationPaused(false);
  clearSpotlight();
  clearOverlay();
  await saveState(emptyState());
  return result('GUIDE_TARGET_NOT_VISIBLE', null, detail);
}

function overlayPlacement(target: HTMLElement): 'top-right' | 'bottom-right' | 'bottom-left' {
  if (typeof target.getBoundingClientRect !== 'function') return 'bottom-right';
  const rect = target.getBoundingClientRect();
  const width = typeof window.innerWidth === 'number' ? window.innerWidth : 1200;
  const height = typeof window.innerHeight === 'number' ? window.innerHeight : 800;
  if (rect.bottom <= height * .4) return 'bottom-right';
  return rect.left >= width * .5 ? 'bottom-left' : 'top-right';
}

async function mountOverlay(
  packet: GuidePacket, pauseForNext: boolean, target: HTMLElement,
): Promise<void> {
  clearOverlay();
  const overlay = document.createElement('aside');
  overlay.setAttribute('id', 'virgil-guide-overlay');
  overlay.className = 'virgil-guide-overlay';
  overlay.setAttribute('aria-live', 'polite');
  overlay.setAttribute('aria-label', 'Virgil guide');
  overlay.dataset.placement = overlayPlacement(target);

  const kicker = document.createElement('div');
  kicker.className = 'guide-kicker';
  kicker.textContent = 'Virgil guide';
  const title = document.createElement('strong');
  title.className = 'guide-title';
  title.textContent = packet.targetLabel;
  const message = document.createElement('p');
  message.className = 'guide-message';
  message.textContent = packet.message;
  const actions = document.createElement('div');
  actions.className = 'guide-actions';

  if (pauseForNext) {
    const next = document.createElement('button');
    next.className = 'guide-next';
    next.textContent = 'Next';
    next.addEventListener('click', async () => {
      const state = await loadState();
      await saveState({ ...state, awaitingNext: false, nextAdvanced: true });
      clearSpotlight();
      clearOverlay();
      window.dispatchEvent(new CustomEvent(GUIDE_NEXT_EVENT));
    });
    actions.append(next);
  }

  const pause = document.createElement('button');
  pause.className = 'guide-pause';
  pause.textContent = 'Pause guide';
  pause.addEventListener('click', async () => {
    const state = await loadState();
    const paused = !state.paused;
    await saveState({ ...state, paused, pausedAt: paused ? packet : null });
    setApplicationPaused(paused);
    pause.textContent = paused ? 'Resume guide' : 'Pause guide';
    overlay.dataset.state = paused ? 'paused' : (pauseForNext ? 'waiting' : 'guiding');
  });
  actions.append(pause);

  const end = document.createElement('button');
  end.className = 'guide-end';
  end.textContent = 'End guide';
  end.addEventListener('click', async () => {
    await saveState(emptyState());
    setApplicationPaused(false);
    clearSpotlight();
    clearOverlay();
  });
  actions.append(end);

  const footer = document.createElement('p');
  footer.className = 'guide-footer';
  footer.textContent = 'Ask your browser agent a question, or continue when you are ready.';
  overlay.dataset.state = pauseForNext ? 'waiting' : 'guiding';
  overlay.append(kicker, title, message, actions, footer);
  document.body.append(overlay);
}

export async function guideVirgilView(input: GuideViewInput): Promise<string> {
  const state = await loadState();
  if (state.paused) {
    setApplicationPaused(true);
    return result('GUIDE_PAUSED_FOR_QUESTION', state.pausedAt ?? state.lastGuide,
      'The guide is paused. Virgil made no product changes.');
  }
  setApplicationPaused(false);

  if (state.awaitingNext && !state.nextAdvanced) {
    await restoreGuidePresentation();
    return result('GUIDE_WAITING_FOR_PERSON', state.lastGuide,
      'The visible Next control is waiting for an explicit continuation.');
  }

  const visible = visibleSurface();
  if (input.surface !== 'current' && visible !== input.surface) {
    return notVisible(
      `The requested ${input.surface} surface is not visible. Nothing was shown.`);
  }
  const target = guideTarget(input.target, input.exactSectionId);
  if (!target || (typeof target.getClientRects === 'function' && target.getClientRects().length === 0)) {
    return notVisible(
      `The named ${targetLabels[input.target]} target is not visible. Nothing was shown.`);
  }

  clearSpotlight();
  target.setAttribute('data-guide-spotlight', 'true');
  target.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  const packet: GuidePacket = {
    surface: input.surface, target: input.target, targetLabel: targetLabels[input.target],
    message: input.message?.trim() || targetMessages[input.target],
    ...(input.exactSectionId ? { exactSectionId: input.exactSectionId } : {}),
    canonicalState: canonicalState(),
  };
  const nextState: GuideState = {
    awaitingNext: input.pauseForNext === true,
    nextAdvanced: false,
    paused: false,
    lastGuide: packet,
    pausedAt: null,
  };
  await saveState(nextState);
  await mountOverlay(packet, input.pauseForNext === true, target);
  return result(input.pauseForNext ? 'GUIDE_WAITING_FOR_PERSON' : 'VIEW_GUIDED', packet,
    input.pauseForNext ? 'The concept is visible and waiting at Next.' : 'The concept is visible.');
}

export async function restoreGuidePresentation(): Promise<void> {
  const state = await loadState();
  if (!state.lastGuide) return;
  const now = canonicalState();
  if (state.lastGuide.canonicalState.room !== now.room
      || state.lastGuide.canonicalState.face !== now.face) {
    await clearGuidePresentation();
    return;
  }
  const target = guideTarget(state.lastGuide.target, state.lastGuide.exactSectionId);
  if (!target || (typeof target.getClientRects === 'function' && target.getClientRects().length === 0)) {
    await clearGuidePresentation();
    return;
  }
  clearSpotlight();
  target.setAttribute('data-guide-spotlight', 'true');
  await mountOverlay(state.lastGuide, state.awaitingNext, target);
  if (state.paused) {
    setApplicationPaused(true);
    const overlay = document.getElementById('virgil-guide-overlay');
    if (overlay) overlay.dataset.state = 'paused';
    const pause = overlay?.querySelector('.guide-pause');
    if (pause) pause.textContent = 'Resume guide';
  }
}

export async function clearGuidePresentation(): Promise<void> {
  await saveState(emptyState());
  setApplicationPaused(false);
  clearSpotlight();
  clearOverlay();
}
