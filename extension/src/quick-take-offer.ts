import { GLYPH, iconButton } from './panel-glyphs.js';
import { QUICK_TAKE_CLOSE_FAILED } from './quick-take-close.js';

/**
 *  — THE ONE MINUTE HERO, WITH SOMETHING TO SAY BACK.
 *
 * The walkthrough finding, accepted: *"why is there still no controls on the 1
 * min version?"*. At three and five minutes the hero IS the lineup, and every
 * row on it carries six controls — why, good call, not what I need, up, down,
 * and the cross that takes it out of tonight. At one minute the hero is a
 * single quick take, and it carried none. The learner could open the pick or
 * leave, which on the product's smallest surface makes the one thing it offers
 * an instruction rather than a proposal.
 *
 * Two controls, and only two, because only two are honest here.
 *
 *  - **Not now.** The same statement the take's own close already takes, so it
 *    writes the same mark through the same door: `POST /pins/:id/quick-take/
 *    verdict`, `lineup-not-now`, the Gardener's hold window. A deferral said
 *    before reading and a deferral said after it are one decision about timing,
 *    and minting a second kind for the earlier one would have been a second
 *    thing the comfort model, the hold window, the night scout and the slipping
 *    read all had to learn.
 *  - **Show me another.** The pick refused rather than the topic put down. It
 *    records the passed-over fact on the ledger that already counts those and
 *    asks the ranker for its next answer; it writes no signal, because refusing
 *    something you have not read is not evidence about anybody.
 *
 * **What is deliberately not here.** Good call, not what I need, and the two
 * move chevrons. The verdict pair is a mark on the SELECTION of a lesson that
 * sits in a list of them, and a list of one has no selection to praise or
 * fault: the same statement is already available, better founded, on the close
 * of the take the learner is one press from opening. The chevrons reorder a
 * lineup, and there is no order in a single card. A control that cannot mean
 * anything is worse than an absent one, which is the same rule that keeps
 * *show me another* off a screen with nothing else to show.
 *
 * The four rules `quick-take-close.ts` is written under hold here unchanged:
 * one press and optional, no praise and no streak, existing kinds only, and
 *  exclusion — neither of these can reach the modality tallies, because
 * one writes a preference kind the weight table has no entry for and the other
 * writes no signal at all.
 *
 * Extracted rather than added to `panel.ts` for the reason  gives: a room
 * that grows a control by growing the file that already holds every room is how
 * that budget stopped meaning anything.
 */

/** What the learner is saying, not what the machine records. *Not now* is the
 *  close's own word for the same decision, kept to the letter so the two
 *  gestures cannot read as two different things. */
export const QUICK_TAKE_NOT_NOW_LABEL = 'Not now';
export const QUICK_TAKE_ANOTHER_LABEL = 'Show me another';

/**
 * The honest answer when the swap has nothing to swap to.
 *
 * The control is not drawn at all unless the ranker says another topic is
 * standing behind this one, so this is the race rather than the ordinary case:
 * the board can change between the read that drew the button and the press. It
 * still has to be said, because a press that silently redraws the same pick is
 * the dead control this story exists to remove.
 */
export const QUICK_TAKE_NOTHING_ELSE = 'Nothing else is ready just now, so this is still what I have.';

/** What `another` did. `none` is the honest no-op above; `failed` is a service
 *  that would not answer, and the pick on screen is untouched in both. */
export type QuickTakeSwap = 'swapped' | 'none' | 'failed';

export interface QuickTakeOfferDeps {
  /** The panel's own element builder, handed in rather than imported, so this
   *  module carries no opinion about how the room makes DOM. */
  readonly el: (html: string) => HTMLElement;
  /** Whether the ranker has another topic ready to stand in for this pick. */
  readonly othersReady: boolean;
  /** Writes the deferral and repaints the screen. `false` means the mark did
   *  not land, and the pick the learner tried to put down is still on screen. */
  readonly defer: () => Promise<boolean>;
  readonly another: () => Promise<QuickTakeSwap>;
}

export interface QuickTakeOffer {
  /** The controls and their status line, in one block the room mounts under the
   *  primary button. One node rather than two, so the panel places the offer
   *  rather than assembling it. */
  readonly node: HTMLElement;
  /** Where a failure or a no-change is said, under the controls. */
  readonly said: HTMLElement;
  readonly buttons: readonly HTMLButtonElement[];
}

/**
 * The two controls, wired.
 *
 * Both are quiet: `link icon` in the same 26px target the lineup's six use, so
 * the screen's one accent stays on Start. Neither writes anything until it is
 * pressed and neither carries a sentence of its own on the screen — the label
 * is the tooltip and the accessible name, which is where an icon's words belong
 * ( the interface-affordance contract).
 *
 * A press that succeeds repaints the card from a fresh ranking, which destroys
 * these nodes. That is why nothing below claims anything after a success: the
 * new pick on screen is the receipt for *show me another*, and the deferral's
 * own receipt is the one the close already writes, said by the screen that
 * replaces this one.
 */
export function quickTakeOffer(deps: QuickTakeOfferDeps): QuickTakeOffer {
  const node = deps.el(`<div class="offer">
    <span class="offer-controls">
      ${iconButton(QUICK_TAKE_NOT_NOW_LABEL, GLYPH.remove, 'data-offer="not-now"')}
      ${deps.othersReady ? iconButton(QUICK_TAKE_ANOTHER_LABEL, GLYPH.another, 'data-offer="another"') : ''}
    </span>
    <p class="meta offer-said" role="status" aria-live="polite"></p>
  </div>`);
  const said = node.querySelector('.offer-said') as HTMLElement;
  const buttons = Array.from(node.querySelectorAll('[data-offer]')) as HTMLButtonElement[];

  /** One press at a time, held here rather than on the panel: these two are the
   *  only things on this card that are not Start, and a second press while the
   *  first is in flight would race two rankings onto one screen. */
  let busy = false;
  const press = async (
    control: HTMLButtonElement, act: () => Promise<string | null>,
  ): Promise<void> => {
    if (busy) return;
    busy = true;
    for (const button of buttons) button.disabled = true;
    said.textContent = '';
    const line = await act();
    busy = false;
    for (const button of buttons) button.disabled = false;
    if (line === null) return;
    said.textContent = line;
    control.focus();
  };

  const notNow = node.querySelector('[data-offer="not-now"]') as HTMLButtonElement;
  notNow.addEventListener('click', () => void press(notNow, async () =>
    await deps.defer() ? null : QUICK_TAKE_CLOSE_FAILED));

  const another = node.querySelector('[data-offer="another"]') as HTMLButtonElement | null;
  another?.addEventListener('click', () => void press(another, async () => {
    const swap = await deps.another();
    if (swap === 'swapped') return null;
    return swap === 'none' ? QUICK_TAKE_NOTHING_ELSE : QUICK_TAKE_CLOSE_FAILED;
  }));

  return { node, said, buttons };
}
