
/** Page to worker: these are the envelopes, one per thing picked. */
export const SELECT_SAVE = 'sb-select-save';

/** What the picker hands back. */
export interface SelectResult {
  readonly kind: typeof SELECT_SAVE;
  readonly envelopes: readonly unknown[];
}

/** Worker to the side panel: the picker has crossed the page boundary and is
 *  either being saved or has reached a durable outcome. The exact tab id keeps
 *  another window's panel from claiming somebody else's pin. */
export const SELECT_STATUS = 'sb-select-status';
export interface SelectStatus {
  readonly kind: typeof SELECT_STATUS;
  readonly tabId: number;
  readonly state: 'saving' | 'saved' | 'failed';
  readonly count: number;
  readonly queued: number;
  /** Present only when one chosen passage reached the service and therefore
   *  has one honest lesson the already-open panel can enter. */
  readonly lessonPinId?: string;
  readonly lessonLabel?: string | null;
  readonly lessonAt?: number;
}

export function selectorStatusLine(status: Pick<SelectStatus, 'state' | 'count' | 'queued'>): string {
  if (status.state === 'saving') return 'Saving your selection…';
  if (status.state === 'failed') return 'That pin did not finish. Try again.';
  if (status.count < 1) return 'Nothing was pinned. Try selecting a different part.';
  if (status.queued >= status.count) {
    return status.count === 1
      ? 'Pinned. Saved in this browser and waiting to sync.'
      : `Pinned ${status.count} parts. Saved in this browser and waiting to sync.`;
  }
  if (status.queued > 0) {
    return `Pinned ${status.count} parts. ${status.queued} ${status.queued === 1 ? 'is' : 'are'} waiting to sync.`;
  }
  return status.count === 1 ? 'Pinned. It is on your board.' : `Pinned ${status.count} parts. They are on your board.`;
}

export const SELECTOR_HINT = 'Select exact words, or click whole parts of the page.';
export const SELECTOR_CANCEL = 'Cancel';
export const SELECTOR_ESCAPE_NOTE = 'Escape closes this.';

/** The button, which has to say how many, because the count is the whole
 *  state of this surface and there is nowhere else to read it. */
export function selectorConfirmLabel(count: number, selectionReady = false): string {
  if (selectionReady) return 'Pin this selection';
  if (count === 0) return 'Nothing picked yet';
  return count === 1 ? 'Pin this one thing' : `Pin these ${count} things`;
}

/** The instruction changes with the state so picking never ends in a silent
 *  outline with no indication of what happens next. */
export function selectorHint(count: number, selectionReady = false): string {
  if (selectionReady) return 'Selection ready. Pin it, or select different words.';
  if (count === 1) return '1 part ready. Choose another, or pin it now.';
  if (count > 1) return `${count} parts ready. Choose another, or pin them now.`;
  return SELECTOR_HINT;
}

/**
 * The blocks a pick may land on.
 *
 * The same list `capture` uses for the block a selection sits in, so the two
 * agree about what a unit of page is. `DIV` and the sectioning elements are
 * included because plenty of pages mark paragraphs up as neither.
 */
export const PICKABLE = 'P,LI,PRE,BLOCKQUOTE,TD,DD,SECTION,ARTICLE,DIV,H1,H2,H3,H4,H5,H6,FIGURE';

/** Text short enough to be furniture rather than material. Below this a pick
 *  is a byline, a nav item or a caption, and the click was probably a miss. */
export const MIN_PICK_CHARS = 25;

/**
 * What the click actually picked.
 *
 * From the deepest element outwards to the first one that is a block and
 * carries enough text to be worth keeping. Clicking a word inside a paragraph
 * picks the paragraph, which is what somebody pointing at a page means, and
 * clicking a link picks the sentence it sits in rather than the link.
 *
 * Null when nothing on the way up qualifies: the page's furniture is not
 * pickable and saying nothing is better than pinning a nav bar.
 */
export function blockFor(start: Element | null, root: Element | null): Element | null {
  let el: Element | null = start;
  while (el && el !== root?.parentElement) {
    if (el.matches?.(PICKABLE) && textOf(el).length >= MIN_PICK_CHARS) return el;
    el = el.parentElement;
  }
  return null;
}

/** An element's text, as a reader sees it. */
export function textOf(el: Element | null): string {
  if (!el) return '';
  const rendered = (el as HTMLElement).innerText;
  return (typeof rendered === 'string' ? rendered : el.textContent ?? '')
    .replace(/\s+/g, ' ').trim();
}

/**
 * Is `candidate` already covered by something picked?
 *
 * Picking a paragraph and then the article that contains it would pin the same
 * words twice and weigh them twice in the clustering. Containment either way
 * is a replacement rather than an addition: the outer one wins, because it is
 * the more recent statement of what the learner meant.
 */
export function overlaps(a: Element, b: Element): boolean {
  return a === b || a.contains?.(b) === true || b.contains?.(a) === true;
}

/** What a fresh pick list looks like after one more click. */
export function togglePick(picked: readonly Element[], next: Element): Element[] {
  if (picked.some((p) => p === next)) return picked.filter((p) => p !== next);
  return [...picked.filter((p) => !overlaps(p, next)), next];
}

export const SELECTOR_STYLE = `
:host{all:initial}
.sb-mark{position:absolute;pointer-events:none;border:2px solid #2f81f7;border-radius:4px;
  background:rgba(47,129,247,.12);transition:all .06s ease}
.sb-mark.sb-held{border:3px solid #1a7f37;background:rgba(26,127,55,.14)}
.sb-mark.sb-held::after{content:'✓';position:absolute;right:5px;top:4px;width:22px;height:22px;
  border-radius:50%;background:#1a7f37;color:white;text-align:center;font:700 14px/22px sans-serif}
.sb-bar{position:fixed;left:20px;top:20px;pointer-events:auto;
  font:13px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
  background:#11181c;color:#f4f6f7;border-radius:10px;padding:12px 14px;
  box-shadow:0 10px 34px rgba(0,0,0,.34);box-sizing:border-box;
  display:grid;grid-template-columns:minmax(0,1fr) auto auto;column-gap:12px;row-gap:6px;
  align-items:center;width:min(620px,calc(100vw - 40px))}
.sb-lines{display:flex;flex-direction:column;min-width:0}
.sb-hint{font-size:12px;color:#b7c2c7}
.sb-note{font-size:11px;color:#8b989e}
.sb-bar button{font:inherit;padding:7px 12px;border-radius:6px;cursor:pointer;border:0;
  white-space:nowrap}
.sb-go{background:#f4f6f7;color:#11181c}
.sb-go:disabled{opacity:.45;cursor:default}
.sb-stop{background:transparent;color:#b7c2c7}
@media(max-width:659px){
  .sb-bar{grid-template-columns:minmax(0,1fr) auto}
  .sb-lines{grid-column:1/-1}
  .sb-stop{justify-self:start}
  .sb-go{justify-self:end}
}
@media(prefers-reduced-motion:reduce){.sb-mark{transition:none}}`;

const BAR = `
<div class="sb-bar">
  <div class="sb-lines">
    <span class="sb-hint"></span>
    <span class="sb-note"></span>
  </div>
  <button class="sb-stop"></button>
  <button class="sb-go"></button>
</div>`;

/**
 * Draw the picker over the page.
 *
 * The overlay is `pointer-events:none` except for its own bar, so every mouse
 * event still reaches the page and the target under the cursor is the page's
 * own element rather than ours. Clicks are taken in the capture phase and
 * stopped there, because a page that navigates while somebody is choosing what
 * to keep has taken the choice away.
 */
export function openSelector(
  captureNow: (pickerVisibleSelection?: string | null) => unknown,
  send: (msg: unknown) => void,
): void {
  if (document.querySelector('div[data-sb-selector]')) return;

  const host = document.createElement('div');
  host.setAttribute('data-sb-selector', '');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;inset:0;pointer-events:none';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = SELECTOR_STYLE;

  const holder = document.createElement('div');
  holder.innerHTML = BAR.trim();
  const bar = holder.firstElementChild as HTMLElement;
  const hint = bar.querySelector('.sb-hint') as HTMLElement;
  const note = bar.querySelector('.sb-note') as HTMLElement;
  const go = bar.querySelector('.sb-go') as HTMLButtonElement;
  const stop = bar.querySelector('.sb-stop') as HTMLButtonElement;
  hint.textContent = SELECTOR_HINT;
  note.textContent = SELECTOR_ESCAPE_NOTE;
  stop.textContent = SELECTOR_CANCEL;

  const hover = document.createElement('div');
  hover.className = 'sb-mark';
  hover.style.display = 'none';
  shadow.append(style, hover, bar);
  document.documentElement.append(host);

  let picked: Element[] = [];
  const selectedText = (): string => (window.getSelection()?.toString() ?? '').replace(/\s+/g, ' ').trim();
  let selectionReady = selectedText().length > 0;
  const held: HTMLElement[] = [];

  const place = (mark: HTMLElement, el: Element): void => {
    const r = el.getBoundingClientRect();
    mark.style.display = 'block';
    mark.style.left = `${r.left + window.scrollX}px`;
    mark.style.top = `${r.top + window.scrollY}px`;
    mark.style.width = `${r.width}px`;
    mark.style.height = `${r.height}px`;
  };

  const redraw = (): void => {
    for (const mark of held.splice(0)) mark.remove();
    for (const el of picked) {
      const mark = document.createElement('div');
      mark.className = 'sb-mark sb-held';
      place(mark, el);
      shadow.append(mark);
      held.push(mark);
    }
    hint.textContent = selectorHint(picked.length, selectionReady);
    go.textContent = selectorConfirmLabel(picked.length, selectionReady);
    go.disabled = !selectionReady && picked.length === 0;
  };
  redraw();

  const onMove = (e: MouseEvent): void => {
    const block = blockFor(e.target as Element | null, document.body);
    if (!block || picked.some((p) => p === block)) { hover.style.display = 'none'; return; }
    place(hover, block);
  };

  const onClick = (e: MouseEvent): void => {
    if (host.contains(e.target as Node)) return;
    // A drag across exact words normally ends with a click. Preserve that
    // native selection and turn it into the immediately actionable state;
    // do not replace it with the paragraph underneath.
    if (selectedText()) {
      e.preventDefault();
      e.stopPropagation();
      selectionReady = true;
      picked = [];
      hover.style.display = 'none';
      redraw();
      return;
    }
    const block = blockFor(e.target as Element | null, document.body);
    if (!block) return;
    // Taken here so the page never sees it: a link followed mid-choice loses
    // both the choice and the page it was being made on.
    e.preventDefault();
    e.stopPropagation();
    selectionReady = false;
    picked = togglePick(picked, block);
    hover.style.display = 'none';
    redraw();
  };

  const close = (): void => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('selectionchange', onSelectionChange, true);
    window.removeEventListener('scroll', redraw, true);
    host.remove();
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  };

  const onSelectionChange = (): void => {
    const ready = selectedText().length > 0;
    if (ready === selectionReady) return;
    selectionReady = ready;
    if (ready) {
      picked = [];
      hover.style.display = 'none';
    }
    redraw();
  };

  const confirm = (): void => {
    // One envelope per pick, each made by putting the page's own selection
    // around that block and asking the shipped capture what it sees. Same
    // function, same answers, as a hand-made highlight.
    const envelopes: unknown[] = [];
    const selection = window.getSelection();
    if (selectionReady && selectedText()) {
      // The selection is already the exact range the learner made. Capture it
      // before touching the page selection so the pin keeps those exact words.
      try { envelopes.push(captureNow()); } catch { /* the page moved under us */ }
    } else {
      for (const el of picked) {
        try {
          const range = document.createRange();
          range.selectNodeContents(el);
          selection?.removeAllRanges();
          selection?.addRange(range);
          envelopes.push(captureNow(textOf(el)));
        } catch { /* a node that moved under us is one pick lost, not the batch */ }
      }
    }
    selection?.removeAllRanges();
    close();
    if (envelopes.length) send({ kind: SELECT_SAVE, envelopes } satisfies SelectResult);
  };

  go.addEventListener('click', confirm);
  stop.addEventListener('click', close);
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('selectionchange', onSelectionChange, true);
  // The marks are absolutely positioned in the document, so they follow the
  // page as it scrolls; the hovered one is dropped because the cursor is no
  // longer over what it was drawn around.
  window.addEventListener('scroll', redraw, true);
}
