/**
 * capture costs one gesture and zero context switches. The toast is the
 * entire feedback surface — no modal, no panel, no confirmation click.
 *
 * It shows the *inferred topic label*, not just "Pinned", because that label is
 * the first evidence the agent is doing work. Scout's measured path is well
 * inside this toast's life, so the label lands before the toast leaves.
 */

/**
 *  — the one affordance the toast grows.
 *
 * UX_SPEC §3: *"The confirmation toast grows one affordance … Ignoring it costs
 * nothing and is the default."* It is one tappable clause appended to the
 * confirmation that was already there. Nothing animates, nothing repeats,
 * nothing comes back — a toast that behaved like it had something to sell would
 * be the surface soliciting taps that §3 rules out.
 *
 * A toast **carrying the clause** dwells 6000ms — enough to
 * read a handful of words and decide whether two minutes on this is wanted now.
 * The **plain** toast — offline, the  refusal, an unnamed success, every
 * confirmation with no take behind it — is untouched: 1500ms after the label,
 * 2600ms if the label never arrives, no listeners, exactly the build before.
 * Reachability is not solicitation, and only the surface with something to
 * decide about gets the longer window.
 */
export interface ToastOffer {
  /** What the clause reads. */
  readonly label: string;
  readonly pinId: string;
  /** What the pin is about, for the panel's heading. Null when Scout had
   *  nothing to say; see `LearnNowOffer.pinLabel`. */
  readonly pinLabel: string | null;
}

export const PIN_UNDO = 'sb-undo-pin';

export interface ToastUndo {
  readonly label: 'Undo';
  readonly pinId: string;
  /** Null is an intentional single-board install; an account capture names its owner. */
  readonly ownerUid: string | null;
}

/**
 * The quotation the confirmation carries, and whether it needs explaining.
 *
 * Data rather than a closure, like everything else that crosses the
 * `executeScript` boundary: this whole function is serialised and evaluated in
 * the page (reviewer-boundary constraint).
 */
export interface SavedQuote {
  /** The opening of the material, already cut and already quoted. Empty means
   *  draw nothing: an empty quotation is worse than none. */
  readonly quote: string;
  /** The material is the page's own text rather than a selection. */
  readonly wholePage: boolean;
  /** The one line explaining a whole-page capture or recovered selection. */
  readonly pageNote: string | null;
}

declare global {
  interface Window {
    __sbFinishToast?: (
      text: string, offer?: ToastOffer | null, saved?: SavedQuote | null, undo?: ToastUndo | null,
    ) => void;
  }
}

export function showToast(initial: string): void {
  // This function crosses Chrome's executeScript boundary and therefore owns
  // its dependency check. Reduced motion changes only presentation: the same
  // receipt, dwell and actions remain, but there is no rise/fade on either
  // edge of its life.
  const reduceMotion = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const host = document.createElement('div');
  // `all:initial` first, and it has to stay first. It is one declaration for
  // every property at once, so anything written before it in this block is
  // thrown away — which is what happened while it sat at the end: the host
  // arrived `position:static`, `z-index:auto`, and the toast rendered in the
  // page's own flow after the last paragraph rather than over the corner of it.
  // It still said the right words at the right moment, which is why nothing
  // caught it; on any page longer than a screen the learner never saw them.
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;bottom:24px;right:24px';
  const shadow = host.attachShadow({ mode: 'closed' });
  const el = document.createElement('div');
  el.textContent = initial;
  el.style.cssText = [
    'font:500 13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
    'background:#11181c;color:#f4f6f7;padding:10px 14px;border-radius:8px',
    `box-shadow:0 6px 24px rgba(0,0,0,.28);opacity:${reduceMotion ? '1' : '0'};transform:${reduceMotion ? 'none' : 'translateY(6px)'}`,
    `transition:${reduceMotion ? 'none' : 'opacity .16s ease,transform .16s ease'};max-width:320px`,
  ].join(';');
  shadow.append(el);
  document.documentElement.append(host);
  if (!reduceMotion) {
    requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
  }

  let done = false;
  let gone = false;
  /** The window the toast goes back to when a hold ends, so a pointer that
   *  leaves gets the same dwell as the timer it interrupted. */
  let dwell = 2600;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The page's, not ours, so it has to come off again (the capture-feedback contract). Null on
   *  every toast that never carried a clause. */
  let onKey: ((e: KeyboardEvent) => void) | null = null;

  const leave = () => {
    gone = true;
    if (onKey) document.removeEventListener('keydown', onKey);
    if (reduceMotion) { host.remove(); return; }
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => host.remove(), 200);
  };
  const dismiss = (delay: number) => {
    if (gone) return;
    dwell = delay;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(leave, delay);
  };
  const hold = () => { if (!gone && timer !== undefined) clearTimeout(timer); };
  dismiss(2600);

  // Injected functions are serialised, so a returned closure would be lost.
  // The service worker needs to update this toast in place once Scout answers,
  // so the finisher lives on window where a second injection can reach it.
  window.__sbFinishToast = (
    finalText: string, offer?: ToastOffer | null, saved?: SavedQuote | null, undo?: ToastUndo | null,
  ) => {
    if (done) return;
    done = true;
    el.textContent = finalText;

    /**
     * What was actually saved, quoted under the confirmation.
     *
     * The label above it is model output over the material, so it could be
     * perfect while the pin was a single word or a page's AI notice, with
     * nothing on screen able to tell the two apart. This is the line that
     * can: the opening of the exact string being posted, so "did it save what
     * I meant" is answered by looking.
     *
     * `textContent`, never markup. This is somebody else's page.
     */
    if (saved?.quote) {
      const quote = document.createElement('div');
      quote.textContent = saved.quote;
      quote.style.cssText = 'margin-top:6px;font-weight:400;font-style:italic;'
        + 'color:#b7c2c7;font-size:12px;line-height:1.45';
      el.append(quote);
      if (saved.pageNote) {
        const why = document.createElement('div');
        why.textContent = saved.pageNote;
        why.style.cssText = 'margin-top:4px;font-weight:400;color:#8b989e;font-size:11px;line-height:1.4';
        el.append(why);
      }
    }
    const hasTake = !!(offer && offer.pinId && offer.label);
    const hasUndo = !!(undo && undo.pinId && undo.label);
    if (hasTake || hasUndo) {
      if (offer && hasTake) {
      const ask = document.createElement('span');
      ask.textContent = ` · ${offer.label}`;
      ask.style.cssText = 'cursor:pointer;text-decoration:underline;text-underline-offset:2px';
      ask.addEventListener('click', () => {
        // Spelled out rather than imported. This whole function is serialised
        // across the `executeScript` boundary and evaluated in the page, where
        // an imported binding is `undefined`; `learn-now.test.ts` asserts that
        // this string and `LEARN_NOW` still agree.
        //
        // Guarded twice over: the isolated world this runs in does have
        // `chrome.runtime`, and a page that somehow does not must not throw out
        // of a click handler and leave the learner looking at a dead toast.
        try {
          (globalThis as { chrome?: { runtime?: { sendMessage?: (m: unknown) => unknown } } })
            .chrome?.runtime?.sendMessage?.({
              kind: 'sb-learn-now', pinId: offer.pinId,
              // `learn-now.ts` calls this "what the toast called it, so the
              // panel has a heading before the take lands". It used not to be
              // here, and the quick-take screen opened on an empty heading over
              // a `…` for the whole of however long the model took.
              label: offer.pinLabel ?? null,
            });
        } catch { /* the panel is the surface; the toast is only the door */ }
        // Acted on, so it goes. Leaving it up would offer a second tap on
        // something already answered.
        dismiss(0);
      });
      el.append(ask);
      }

      if (undo && hasUndo) {
        const remove = document.createElement('span');
        remove.textContent = ` · ${undo.label}`;
        remove.style.cssText = 'cursor:pointer;text-decoration:underline;text-underline-offset:2px';
        let undoing = false;
        remove.addEventListener('click', () => {
          if (undoing) return;
          undoing = true;
          remove.textContent = ' · Removing…';
          try {
            (globalThis as { chrome?: { runtime?: { sendMessage?: (
              message: unknown, reply?: (value: unknown) => void,
            ) => unknown } } }).chrome?.runtime?.sendMessage?.({
              // Kept literal across the executeScript boundary. `toast-shell`
              // asserts that it still equals exported `PIN_UNDO`.
              kind: 'sb-undo-pin', pinId: undo.pinId, ownerUid: undo.ownerUid,
            }, (reply: unknown) => {
              const ok = !!reply && typeof reply === 'object'
                && (reply as { ok?: unknown }).ok === true;
              el.replaceChildren();
              el.textContent = ok
                ? 'Removed. It is no longer on your board.'
                : 'I could not remove it. It is still on your board.';
              dismiss(ok ? 2500 : 4000);
            });
          } catch {
            el.replaceChildren();
            el.textContent = 'I could not remove it. It is still on your board.';
            dismiss(4000);
          }
        });
        el.append(remove);
      }

      // The capture-feedback contract’s courtesies belong to every toast action. A learner
      // reading is a learner deciding, so the clock stops while a pointer or
      // focus is on the toast and starts over when it leaves; and a window this
      // long is only fair if it can be ended, so Escape closes it now.
      //
      // Escape rather than a click on the bubble: the bubble is where the clause
      // is, and a near-miss must not delete the thing they were reaching for.
      // The listener is passive — the page's own Escape handling is untouched —
      // and it comes off the page again in `leave`.
      const resume = () => dismiss(dwell);
      el.addEventListener('mouseenter', hold);
      el.addEventListener('mouseleave', resume);
      // Honoured wherever the page's focus lands on it. The clause is not made
      // a tab stop: taking the page's tab order for a surface nobody asked for
      // is the soliciting §3 rules out, in the one place it would really cost.
      el.addEventListener('focusin', hold);
      el.addEventListener('focusout', resume);
      onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss(0); };
      document.addEventListener('keydown', onKey);

      dismiss(6000);
      return;
    }
    /**
     * The capture-feedback contract, amended by the same contract that added the quotation.
     *
     * 27 set the plain toast at 1500ms and said so explicitly, on the grounds
     * that a confirmation with nothing to press needs no longer. That held
     * while the confirmation was four words. A toast carrying a quotation has
     * something to *read*, and a line the learner cannot finish before it
     * leaves is not a line: it is the same missing information with a flicker
     * in front of it. So a toast that quotes dwells long enough to read the
     * quotation, and a toast that does not is untouched at 1500ms.
     *
     * It stays below the 6000ms of the branch that carries a decision, which
     * keeps 27's ordering intact: longest for the thing you might act on,
     * middling for the thing you should check, shortest for the thing you have
     * already been told.
     */
    if (saved?.quote) {
      // Same courtesy as the offer branch, for the same reason: a learner
      // reading is a learner who has not finished.
      el.addEventListener('mouseenter', hold);
      el.addEventListener('mouseleave', () => dismiss(dwell));
      dismiss(4000);
      return;
    }
    dismiss(1500);
  };
}
