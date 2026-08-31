/**
 * SB-283 — THE CLOSE ON A QUICK TAKE, AND WHY THE ROOM HAS ONE AT ALL.
 *
 * The walkthrough finding, accepted: a learner reads a take and leaves, and
 * the board learns nothing from the one surface `PRODUCT_SHAPE.md` describes
 * as *"answer a few questions, in and out"*. The moat clause underneath it is
 * blunter still: *one learner model that every surface feeds*. A screen that
 * only spends the model is the one shape this product cannot afford.
 *
 * So the take closes with three controls, and the third is the one that was
 * missing. *Got it* and *Still fuzzy* are the two readings SB-61 built. *Not
 * now* is the honest answer neither of them covers: I read it, and I am not
 * doing this today. Before this, that answer was the browser's back button,
 * which the ledger cannot hear.
 *
 * ## The four rules this file is written under
 *
 *  1. **One tap, and optional.** Nothing here blocks the screen, nothing
 *     nags, and leaving without answering writes nothing at all. There is no
 *     default and no timeout: an unanswered take is an unanswered take, which
 *     is a fact the board is entitled to and a mark it is not.
 *  2. **No streak and no praise.** Every line below says what Virgil will do
 *     next. None of them says anything about the learner, and none of them
 *     congratulates anybody for pressing a button.
 *  3. **Existing kinds only.** The three verdicts map onto three marks the
 *     ledger already carries, in `core`'s `QUICK_TAKE_MARKS`. The consumers
 *     that read them (comfort, the Gardener's hold window, the night scout's
 *     avoided-topic gap, the slipping read) were not touched and did not need
 *     to be. Minting a fourth kind for *not now* would have been a fourth
 *     thing every one of them had to learn.
 *  4. **SB-282's exclusion stands.** None of the three is in
 *     `MODALITY_ASSESSED_TYPES`, so a self-reported reading of a reading can
 *     never help write a sentence about how somebody learns.
 *
 * Extracted rather than added to `panel.ts`, which is at its budget: a room
 * that grew a third control by growing the file that already holds every room
 * is how that budget stopped meaning anything.
 */

/** The value the panel sends, which is the value the endpoint validates
 *  against, so there is one vocabulary and not two spellings of one. */
export type QuickTakeVerdict = 'got-it' | 'still-shaky' | 'not-now';

const VERDICTS: ReadonlySet<string> = new Set<QuickTakeVerdict>([
  'got-it', 'still-shaky', 'not-now',
]);

/** Whether a value a service returned is one of the three on offer. Written as
 *  a narrowing so a caller gets the type back rather than a boolean it has to
 *  remember to act on. */
export const isQuickTakeVerdict = (value: unknown): value is QuickTakeVerdict =>
  typeof value === 'string' && VERDICTS.has(value);

/**
 * The three closing answers, in the order they are worth having.
 *
 * Labelled for what the learner is saying rather than for what the machine
 * records, and short enough that three of them fit a 360px panel on one line.
 * *Still fuzzy* rather than *still shaky*: the reading was fuzzy, the reader
 * is not, and the receipt underneath it promises the lesson rather than a
 * backlog, which is the half of that older complaint that actually mattered.
 */
export const QUICK_TAKE_CHOICES: readonly {
  readonly verdict: QuickTakeVerdict;
  readonly label: string;
}[] = [
  { verdict: 'got-it', label: 'Got it' },
  { verdict: 'still-shaky', label: 'Still fuzzy' },
  { verdict: 'not-now', label: 'Not now' },
];

/**
 * What the tap bought, said once it has landed.
 *
 * All three are about what Virgil will do next, never about the learner.
 * *Still fuzzy* is the answer this product needs people to be willing to give,
 * so it must not read as a consolation; *got it* must not read as praise; and
 * *not now* must not read as a telling-off. The window in the third is the
 * service's own number rather than a copy of it, so the promise and the
 * suppression cannot drift apart.
 */
export function quickTakeAnsweredLine(verdict: string, days: number | null = null): string {
  if (verdict === 'still-shaky') return "Added. I'll bring it back in a lesson.";
  if (verdict !== 'not-now') return 'Understood. I will not start this one over.';
  const n = Number.isFinite(days as number) && (days as number) > 0 ? Math.round(days as number) : null;
  const back = n === null ? 'later' : n === 1 ? 'tomorrow' : `in about ${n} days`;
  return `Put down. It comes back ${back}.`;
}

/** Compatibility truth for an older service that reports an existing answer
 * without saying which answer it retained. The panel must not claim the newly
 * pressed choice landed when the wire cannot support that claim. */
export const QUICK_TAKE_ANSWER_UNCHANGED = 'This pin already has an answer. Nothing changed.';

/** A tap the learner believes they made and did not is a promise no consumer
 *  will ever keep, so the row stays and the failure is said. */
export const QUICK_TAKE_CLOSE_FAILED = "That didn't go through. Nothing changed.";

/** What the service says back about one tap. Every field is optional because
 *  an older service answers with fewer of them. */
export interface QuickTakeCloseReply {
  readonly ok?: boolean;
  readonly verdict?: string;
  readonly alreadyAnswered?: boolean;
  readonly backAfterDays?: number;
}

export interface QuickTakeCloseDeps {
  /** The panel's own element builder, handed in rather than imported, so this
   *  module carries no opinion about how the room makes DOM. */
  readonly el: (html: string) => HTMLElement;
  /** Whether some other interaction on this screen is already in flight. */
  readonly busy: () => boolean;
  readonly setBusy: (busy: boolean) => void;
  readonly answer: (verdict: QuickTakeVerdict) => Promise<QuickTakeCloseReply | null>;
  /** Called with the receipt once a tap has actually landed. */
  readonly closed: (receipt: string) => void;
}

export interface QuickTakeClose {
  readonly row: HTMLElement;
  /** Where a failure or a no-change is said, under the row. */
  readonly said: HTMLElement;
  /** Exposed so the screen's own pending state can disable all three. */
  readonly buttons: readonly HTMLButtonElement[];
}

/**
 * The row, wired.
 *
 * Nothing is written until a button is pressed, and the receipt follows the
 * verdict the service says it retained rather than the button the browser
 * attempted: an older service that cannot name its retained answer gets an
 * honest no-change line instead of a claim the wire cannot support.
 */
export function quickTakeClose(deps: QuickTakeCloseDeps): QuickTakeClose {
  const row = deps.el('<div class="row verdict"></div>');
  const said = deps.el('<div class="meta answered"></div>');
  const buttons = QUICK_TAKE_CHOICES.map((choice) => {
    const button = deps.el('<button></button>') as HTMLButtonElement;
    button.setAttribute('data-verdict', choice.verdict);
    button.textContent = choice.label;
    button.addEventListener('click', async () => {
      if (deps.busy()) return;
      deps.setBusy(true);
      const reply = await deps.answer(choice.verdict);
      if (!reply?.ok) {
        deps.setBusy(false);
        said.textContent = QUICK_TAKE_CLOSE_FAILED;
        return;
      }
      if (!isQuickTakeVerdict(reply.verdict)) {
        deps.setBusy(false);
        said.textContent = QUICK_TAKE_ANSWER_UNCHANGED;
        return;
      }
      deps.closed(quickTakeAnsweredLine(reply.verdict, reply.backAfterDays ?? null));
    });
    row.append(button);
    return button;
  });
  return { row, said, buttons };
}
