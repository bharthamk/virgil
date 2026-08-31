
import { normaliseTheme } from './theme.js';

/** Page to worker: the learner pressed the button. */
export const COMPOSE_SAVE = 'sb-compose-save';

/** What the box hands back. The envelope rides along untouched except for the
 *  two fields the learner could change. */
export interface ComposeResult {
  readonly kind: typeof COMPOSE_SAVE;
  readonly envelope: unknown;
  /** The passage as it now reads. Never empty: the button is disabled. */
  readonly text: string;
  /** The learner's own words, or null when they wrote none. */
  readonly note: string | null;
  /** Their answer to the one question this surface asks. */
  readonly struggle: boolean;
  /** The depth they asked for, or null where they left it to the ledger. */
  readonly requestedRegister: 'from-nothing' | 'building' | 'fluent' | null;
  /** How long they asked for, in minutes, or null where they did not say. */
  readonly requestedMinutes: number | null;
}

export const BOX_HEADING = 'Add to board';
export const PASSAGE_LABEL = 'What gets pinned';
export const NOTE_LABEL = 'Additional comments or context';
export const SAVE_LABEL = 'Add';
export const CANCEL_LABEL = 'Cancel';
export const PIN_NOTE_MAX_CHARS = 1_000;

/** The editable page context is the topic model's strongest filing hint. */
export const CONTEXT_LABEL = 'What this is about';

/** Name the page field, nearest heading, and site; omit unavailable parts. */
export function sourceLine(envelope: unknown): string {
  const e = (envelope ?? {}) as { siteName?: unknown; url?: unknown; headingPath?: unknown };
  const site = typeof e.siteName === 'string' && e.siteName.trim()
    ? e.siteName.trim()
    : hostOf(e.url);
  const path = Array.isArray(e.headingPath)
    ? e.headingPath.filter((h): h is string => typeof h === 'string' && !!h.trim())
      .map((h) => h.replace(/\s+/g, ' ').trim())
    : [];
  // The deepest heading, because it is the one the passage actually sits
  // under. The rest of the path is where the topic model reads it from, and
  // is more than anybody needs to check a title against.
  const under = path.at(-1);
  return [
    'Page title',
    under ? `under “${under}”` : '',
    site,
  ].filter(Boolean).join(' · ');
}

/** The host, for a page that named no site of its own. Empty rather than the
 *  raw url: a learner checking provenance reads a domain, not a query string. */
function hostOf(url: unknown): string {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Explicit depth replaces an ambiguous struggle checkbox while preserving its signal. */
export const EFFORT_LABEL = 'Desired lesson level';

export interface EffortChoice {
  readonly value: string;
  readonly label: string;
  /**
   * How much knowledge to assume. This is the register the model writes at
   * and it is one of the three the ledger already speaks.
   */
  readonly register: 'from-nothing' | 'building' | 'fluent';
  /**
   * How long it should be, in minutes.
   *
   * A second axis, and the reason these four options are four rather than
   * three. "Refresher" and "Deep dive" can both assume the same knowledge and
   * be nothing alike: one is a reminder and one is the long version. Folding
   * them into a register would have made two of these options synonyms.
   */
  readonly minutes: number;
  /** Whether this is the learner saying the material is hard for them. */
  readonly struggle: boolean;
}

/** Available lesson-depth choices. */
export const EFFORT_CHOICES: readonly EffortChoice[] = [
  { value: 'simple', label: 'Make it simple', register: 'from-nothing', minutes: 2, struggle: false },
  { value: 'refresher', label: 'Refresher', register: 'fluent', minutes: 1, struggle: false },
  { value: 'deep', label: 'Deep dive', register: 'building', minutes: 6, struggle: false },
  { value: 'basics', label: 'Start from basics', register: 'from-nothing', minutes: 6, struggle: true },
];

/** The one the box opens on. */
export const EFFORT_DEFAULT = 'deep';

export const effortFor = (value: string): EffortChoice =>
  EFFORT_CHOICES.find((c) => c.value === value)
  ?? EFFORT_CHOICES.find((c) => c.value === EFFORT_DEFAULT)!;

/** Shown in place of the passage when the capture came back with nothing. */
export const EMPTY_PASSAGE_NOTE = 'Nothing came back from the page. Type what you want to keep.';

/**
 * The material to start from.
 *
 * The selection when there is one. Otherwise the page's own text, trimmed hard:
 * a whole page dumped into a box is not something anybody edits, and the
 * honest use of this mode on an unselected page is to type what you meant.
 */
export const PAGE_TEXT_PREFILL = 600;

export function prefillFor(envelope: unknown): string {
  const e = (envelope ?? {}) as { selection?: unknown; surroundingText?: unknown };
  const selection = typeof e.selection === 'string' ? e.selection.trim() : '';
  if (selection) return selection;
  const page = typeof e.surroundingText === 'string' ? e.surroundingText.replace(/\s+/g, ' ').trim() : '';
  return page.slice(0, PAGE_TEXT_PREFILL);
}

/** The title to show as the source, collapsed and cut. */
export function sourceTitle(envelope: unknown): string {
  const e = (envelope ?? {}) as { pageTitle?: unknown };
  const title = typeof e.pageTitle === 'string' ? e.pageTitle.replace(/\s+/g, ' ').trim() : '';
  return title.length > 70 ? `${title.slice(0, 69)}…` : title;
}

/**
 * The envelope, with the learner's edits on it.
 *
 * `selection` is set even where the capture had none, because what the box
 * returns IS the selection now: they chose it by typing it. The rest of the
 * envelope is untouched, so the heading path, the url and the surrounding text
 * still describe where it came from.
 */
export function envelopeWithEdits(envelope: unknown, text: string, context?: string): unknown {
  const base = { ...(envelope as Record<string, unknown> ?? {}), selection: text };
  // The context is the page title as far as every agent is concerned, so a
  // correction has to land there rather than in a field of its own that
  // nothing reads. An empty one is refused: a pin with no context at all
  // gives the topic model less than the page did.
  const fixed = String(context ?? '').replace(/\s+/g, ' ').trim();
  return fixed ? { ...base, pageTitle: fixed } : base;
}

/** Trimmed, and null rather than empty: the service stores a note or nothing,
 *  and a note of `""` is a note that reads as one and says nothing. */
export function noteFrom(raw: string): string | null {
  const note = raw.trim();
  return note ? note : null;
}

const TEMPLATE = `
<div class="sb-box" role="dialog" aria-modal="true">
  <div class="sb-head"></div>
  <label class="sb-label" data-for="passage"></label>
  <textarea class="sb-passage" rows="7"></textarea>
  <div class="sb-empty"></div>
  <label class="sb-label" data-for="context"></label>
  <input class="sb-context" type="text" />
  <div class="sb-hint"></div>
  <label class="sb-label" data-for="note"></label>
  <input class="sb-note" type="text" />
  <div class="sb-note-limit">Up to 1,000 characters. I save the whole note.</div>
  <label class="sb-label" data-for="effort"></label>
  <select class="sb-effort"></select>
  <div class="sb-status" role="status" aria-live="polite" tabindex="-1"></div>
  <div class="sb-row">
    <button class="sb-cancel"></button>
    <button class="sb-save"></button>
  </div>
</div>`;

export interface BuiltBox {
  readonly root: HTMLElement;
  readonly passage: HTMLTextAreaElement;
  readonly context: HTMLInputElement;
  readonly note: HTMLInputElement;
  readonly effort: HTMLSelectElement;
  readonly save: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
  readonly status: HTMLElement;
  /** Send only when the learner-authored note can cross the service whole. */
  commit(send: (msg: unknown) => void): boolean;
  /** What would be sent if the button were pressed now. */
  result(): ComposeResult;
}

/**
 * Build the tree, wire the one rule it enforces, and hand it back.
 *
 * Separated from mounting so the form can be driven in a test without a shadow
 * root, which is the same split `panel-core.ts` and `panel.ts` already use:
 * the tree and its behaviour here, the host and its styling below, and a real
 * browser for the question of whether it looks like anything.
 */
export function buildPinBox(doc: Document, envelope: unknown): BuiltBox {
  const holder = doc.createElement('div');
  holder.innerHTML = TEMPLATE.trim();
  const root = holder.firstElementChild as HTMLElement;
  const pick = <T>(sel: string): T => root.querySelector(sel) as unknown as T;

  const passage = pick<HTMLTextAreaElement>('.sb-passage');
  const context = pick<HTMLInputElement>('.sb-context');
  const note = pick<HTMLInputElement>('.sb-note');
  const effort = pick<HTMLSelectElement>('.sb-effort');
  const save = pick<HTMLButtonElement>('.sb-save');
  const cancel = pick<HTMLButtonElement>('.sb-cancel');
  const status = pick<HTMLElement>('.sb-status');

  pick<HTMLElement>('.sb-head').textContent = BOX_HEADING;
  const labels = root.querySelectorAll('.sb-label');
  labels[0]!.textContent = PASSAGE_LABEL;
  labels[1]!.textContent = CONTEXT_LABEL;
  labels[2]!.textContent = NOTE_LABEL;
  labels[3]!.textContent = EFFORT_LABEL;
  pick<HTMLElement>('.sb-hint').textContent = sourceLine(envelope);
  save.textContent = SAVE_LABEL;
  cancel.textContent = CANCEL_LABEL;

  context.value = sourceTitle(envelope);
  for (const choice of EFFORT_CHOICES) {
    const option = doc.createElement('option');
    option.setAttribute('value', choice.value);
    option.textContent = choice.label;
    effort.append(option);
  }
  effort.value = EFFORT_DEFAULT;

  const prefill = prefillFor(envelope);
  passage.value = prefill;
  // The one state worth saying out loud. An empty box over a page that had
  // text is a capture that failed, and a learner who cannot tell the two apart
  // will assume the product is broken rather than that the page was.
  pick<HTMLElement>('.sb-empty').textContent = prefill ? '' : EMPTY_PASSAGE_NOTE;

  /** A pin with no material is a pin the nightly cannot teach from, so the
   *  button is the guard rather than a message after the fact. */
  const sync = (): void => { save.disabled = !passage.value.trim(); };
  sync();
  passage.addEventListener('input', sync);
  note.addEventListener('input', () => { status.textContent = ''; });

  const result = (): ComposeResult => {
    const chosen = effortFor(effort.value);
    return {
      kind: COMPOSE_SAVE,
      envelope: envelopeWithEdits(envelope, passage.value.trim(), context.value),
      text: passage.value.trim(),
      note: noteFrom(note.value),
      struggle: chosen.struggle,
      requestedRegister: chosen.register,
      requestedMinutes: chosen.minutes,
    };
  };

  return {
    root,
    passage,
    context,
    note,
    effort,
    save,
    cancel,
    status,
    commit: (send): boolean => {
      const noteChars = Array.from(noteFrom(note.value) ?? '').length;
      if (noteChars > PIN_NOTE_MAX_CHARS) {
        status.textContent = `That note is ${noteChars.toLocaleString('en-US')} characters. `
          + 'Keep it to 1,000 so I can save all of it. Nothing was sent.';
        note.focus();
        return false;
      }
      status.textContent = '';
      send(result());
      return true;
    },
    result,
  };
}

/**
 * The form is an extension surface even though it sits over somebody else's
 * page. These are the panel's whiteboard/blackboard decisions expressed inside
 * a closed shadow root: the page cannot restyle them and the form does not
 * need the panel's several-thousand-line stylesheet to look like Virgil.
 */
export const PIN_BOX_STYLE = `
:host{
  --sb-scheme:light;
  --sb-scrim:rgba(31,27,22,.36);--sb-board:#fcfcfa;--sb-frame:#b0aca2;
  --sb-ink:#1a1c1e;--sb-muted:#6a6459;--sb-line:rgba(26,34,44,.18);
  --sb-wash:rgba(255,255,255,.72);--sb-mark:#b4640e;--sb-focus:#1657b8;
  --sb-warn:#8a5a1f;--sb-shadow:0 18px 42px -14px rgba(40,34,24,.5),0 2px 7px rgba(40,34,24,.18);
  --sb-texture:radial-gradient(120% 70% at 12% -10%,rgba(28,40,52,.045),transparent 62%),
    radial-gradient(90% 55% at 88% 112%,rgba(28,40,52,.035),transparent 58%);
  --sb-hand:"Chalkboard SE","Bradley Hand","Segoe Print","Comic Sans MS",cursive;
  background:var(--sb-scrim);color-scheme:var(--sb-scheme)
}
@media(prefers-color-scheme:dark){
  :host(:not([data-theme="light"])){
    --sb-scrim:rgba(3,6,5,.62);--sb-board:#1e2d26;--sb-frame:#4d3b28;
    --sb-ink:#f0ece1;--sb-muted:#a4b0a6;--sb-line:rgba(236,240,228,.17);
    --sb-wash:rgba(236,240,228,.055);--sb-mark:#efd08f;--sb-focus:#a9cbe8;
    --sb-warn:#d2a15e;--sb-shadow:0 20px 46px -14px rgba(0,0,0,.78),0 2px 9px rgba(0,0,0,.5);
    --sb-texture:radial-gradient(110% 70% at 18% -8%,rgba(236,240,228,.055),transparent 62%),
      radial-gradient(80% 50% at 82% 108%,rgba(236,240,228,.04),transparent 58%),
      linear-gradient(96deg,rgba(236,240,228,.03) 8%,transparent 34%);
    --sb-scheme:dark
  }
}
:host([data-theme="dark"]){
  --sb-scrim:rgba(3,6,5,.62);--sb-board:#1e2d26;--sb-frame:#4d3b28;
  --sb-ink:#f0ece1;--sb-muted:#a4b0a6;--sb-line:rgba(236,240,228,.17);
  --sb-wash:rgba(236,240,228,.055);--sb-mark:#efd08f;--sb-focus:#a9cbe8;
  --sb-warn:#d2a15e;--sb-shadow:0 20px 46px -14px rgba(0,0,0,.78),0 2px 9px rgba(0,0,0,.5);
  --sb-texture:radial-gradient(110% 70% at 18% -8%,rgba(236,240,228,.055),transparent 62%),
    radial-gradient(80% 50% at 82% 108%,rgba(236,240,228,.04),transparent 58%),
    linear-gradient(96deg,rgba(236,240,228,.03) 8%,transparent 34%);
  --sb-scheme:dark
}
:host([data-theme="light"]){--sb-scheme:light}
.sb-box{box-sizing:border-box;width:min(520px,calc(100vw - 32px));max-height:calc(100vh - 32px);
  overflow:auto;padding:20px 22px 18px;border:5px solid var(--sb-frame);border-bottom-width:8px;
  border-radius:4px;background-color:var(--sb-board);background-image:var(--sb-texture);
  color:var(--sb-ink);box-shadow:var(--sb-shadow);
  font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.sb-head{position:relative;width:max-content;max-width:100%;margin:0 0 18px;
  color:var(--sb-mark);font:700 20px/1.2 var(--sb-hand);letter-spacing:.01em}
.sb-head::after,.sb-row button::after{content:"";position:absolute;left:1px;right:-2px;bottom:-2px;
  height:2px;border-radius:50%;background:currentColor;opacity:.52;transform:rotate(-.7deg)}
.sb-label{display:block;margin:0 0 5px;color:var(--sb-ink);
  font:700 14px/1.25 var(--sb-hand)}
.sb-passage,.sb-note,.sb-context,.sb-effort{box-sizing:border-box;width:100%;margin:0 0 13px;
  padding:9px 10px;border:1px solid var(--sb-line);border-radius:4px;
  background:var(--sb-wash);color:var(--sb-ink);font:inherit}
.sb-passage{min-height:132px;resize:vertical}
.sb-passage:focus-visible,.sb-note:focus-visible,.sb-context:focus-visible,.sb-effort:focus-visible{
  outline:2px solid var(--sb-focus);outline-offset:1px}
.sb-empty:not(:empty){margin:-8px 0 13px;color:var(--sb-warn);font-size:12px}
.sb-hint{margin:-8px 0 15px;color:var(--sb-muted);font-size:11px;line-height:1.45}
.sb-note-limit{margin:-8px 0 13px;color:var(--sb-muted);font-size:11px;line-height:1.45}
.sb-status:not(:empty){margin:0 0 10px;color:var(--sb-warn);font-size:12px;line-height:1.45}
.sb-row{display:flex;align-items:center;justify-content:flex-end;gap:22px;margin-top:3px}
.sb-row button{position:relative;padding:6px 1px;border:0;border-radius:0;background:transparent;
  color:var(--sb-muted);font:700 15px/1.2 var(--sb-hand);cursor:pointer}
.sb-row button:hover{color:var(--sb-ink)}
.sb-row button:focus-visible{outline:2px solid var(--sb-focus);outline-offset:3px}
.sb-row .sb-save{color:var(--sb-mark)}
.sb-save:disabled{opacity:.42;cursor:default}
@media(max-width:460px){.sb-box{padding:17px 16px 15px}.sb-passage{min-height:112px}}
`;

/** Apply the same stored three-state theme contract as the panel. `system` is
 * no attribute so the media query remains the one authority. */
export function applyPinBoxTheme(host: HTMLElement, raw: unknown): 'light' | 'dark' | 'system' {
  const theme = normaliseTheme(raw);
  if (theme === 'system') host.removeAttribute('data-theme');
  else host.setAttribute('data-theme', theme);
  return theme;
}

/**
 * Mount it over the page.
 *
 * Same host contract as the toast, and for the same reasons: `all:initial`
 * first in the declaration so nothing before it is discarded, a fixed position
 * the page cannot scroll away from, the maximum z-index, and a closed shadow
 * root so no page stylesheet reaches in and nothing here leaks out.
 *
 * Escape cancels. There is no click-outside-to-dismiss: this box holds text
 * the learner may have just typed, and dismissing that on a stray click is a
 * worse failure than making them reach for a button.
 */
export function openPinBox(
  envelope: unknown,
  send: (msg: unknown) => void,
  rawTheme: unknown = 'system',
): void {
  const existing = document.querySelector('div[data-sb-box]');
  if (existing) return;

  const host = document.createElement('div');
  host.setAttribute('data-sb-box', '');
  applyPinBoxTheme(host, rawTheme);
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;inset:0;'
    + 'display:flex;align-items:center;justify-content:center;'
    + 'background:var(--sb-scrim);color-scheme:var(--sb-scheme)';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = PIN_BOX_STYLE;

  const box = buildPinBox(document, envelope);
  shadow.append(style, box.root);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    host.remove();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    // The shortcut anybody who types in boxes already has in their hands.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !box.save.disabled) {
      e.stopPropagation();
      if (box.commit(send)) close();
    }
  };

  box.save.addEventListener('click', () => { if (box.commit(send)) close(); });
  box.cancel.addEventListener('click', close);
  // Capture phase: a page with its own Escape handler must not eat this one.
  document.addEventListener('keydown', onKey, true);

  document.documentElement.append(host);
  box.passage.focus();
}
