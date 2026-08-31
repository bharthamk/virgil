/**
 * UX_SPEC §5d — the hand-off to Gemini Notebook, and the only place it exists.
 *
 * The Notebook handoff contract settled the shape before there was a surface: **Virgil stays the
 * centre.** Gemini Notebook is not an integration target — no consumer API
 * exists, the Enterprise API is licence-gated, and cookie-auth automation was
 * refused. What is ruled in is a hand-off, and this file holds the copy for it.
 *
 * ## What changed, and why there are two honest paths
 *
 * The first version of this control put the session's source URLs on the
 * clipboard, opened Notebook's front door, and told the learner to paste them
 * into Notebook's own *Add sources* step. It was honest and it was work: every
 * hand-off was a paste, and what arrived on the other side was a list of pages
 * with nothing of Virgil's own thinking attached to them.
 *
 * The configured export seam replaces the whole errand. Virgil already keeps a
 * small fixed set of documents in the learner's own Drive and rewrites them in
 * place, so the button writes the current lesson into the document that is
 * already a source and then opens the door. Nothing is pasted on that path.
 *
 * A hosted service cannot safely keep a learner's durable Drive OAuth grant.
 * When that service returns the deliberate 404 "not kept" boundary, the same
 * learner gesture instead copies a bounded lesson payload — heading, body and
 * current practice question — and opens Notebook for a visible paste. The
 * clipboard write must land before the tab opens or any External receipt is
 * recorded. This is less automatic, but it is a working hand-off rather than a
 * Settings route that cannot complete in the hosted product.
 *
 * ## Why this is a module and not four template strings in `panel.ts`
 *
 * Three of §5d's laws need somewhere to live that a test can point at.
 *
 *  1. **The host is dated evidence, not a constant.** §5d's table was checked
 *     over plain HTTPS and carries the date it was checked on; the law attached
 *     to it is that any lane implementing this re-checks the chain and amends
 *     the table. That is only worth doing if there is exactly one string in the
 *     shipped code to amend, which `notebook-seam.test.ts` enforces.
 *  2. **The copy may never claim more than a hand-off.** No sentence anywhere
 *     may say integrated, connected, synced or linked. What the control may
 *     promise is exactly what the active path does: Virgil either rewrites its
 *     own document or copies the lesson for the learner to paste, then opens
 *     Notebook. What Notebook then reads, and when, is Notebook's, and Virgil
 *     cannot see it.
 *  3. **The seam writes nothing to the ledger.** §5d's law is absolute — no
 *     signal, no comfort update, no progression event, not a reduced signal.
 *     The one request this control makes is the export door, which writes
 *     documents and touches no signal, and `panel-wiring.test.ts` reads the
 *     request log after the tap to hold it.
 *
 * ## The verified surface
 *
 * Re-checked on 2026-08-21, over plain HTTPS:
 *
 *   https://notebooklm.google.com/  301 → https://notebook.google.com/
 *   https://notebook.google.com/    302 → /login?continue=… when signed out
 *   https://notebooklm.google/      301 → https://notebook.google/
 *   https://notebook.google/        200, the product page — not the app
 *
 * So the app host is `notebook.google.com`, and it is named directly rather than
 * reached through the `notebooklm` redirect: shipping a link that only survives
 * on someone else's permanent redirect is borrowing a guarantee we were not
 * given. There is no documented create-a-notebook deep link — no `/new`, no
 * documented parameter — so the hand-off targets the host root and nothing
 * deeper. A guessed path that lands somewhere other than where it promised is
 * how a learner stops believing every link on the screen, which is the same rule
 * the video pin already follows where a site's seek convention is not real.
 */

/**
 * The app host, and the only place it is written down.
 *
 * Already in normalised form — scheme, host, trailing slash — so nothing
 * downstream has to decide whether it needs a slash on the end.
 */
export const NOTEBOOK_HOST = 'https://notebook.google.com/';

/**
 * Use the learner's configured live notebook when the deployment names one.
 *
 * The service may return this public, non-credential destination from setup.
 * Treat it as untrusted input anyway: only a concrete notebook on Google's
 * application host is accepted. A fresh self-host with no notebook configured
 * keeps the honest product-root fallback.
 */
export function notebookTarget(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return NOTEBOOK_HOST;
  try {
    const target = new URL(value.trim());
    if (target.protocol !== 'https:' || target.hostname !== 'notebook.google.com'
      || !/^\/notebook\/[^/]+\/?$/.test(target.pathname)) return NOTEBOOK_HOST;
    target.hash = '';
    return target.toString();
  } catch {
    return NOTEBOOK_HOST;
  }
}

/**
 * Which document the lesson's control writes.
 *
 * The scope the panel sends to `POST /notebook/export`, and the reason it is
 * named here rather than inline: it is half of a contract with `core/`'s
 * `NotebookDocKey`, and a key typed into a fetch body is a key nothing checks.
 */
export const LEARN_NOW_DOC = 'learn-now';
export const HOSTED_NOTEBOOK_DOC_KEYS = [LEARN_NOW_DOC, 'on-the-board', 'archive'] as const;

/**
 * The label: a destination, because that is what this is one of now.
 *
 * It read *Send this lesson to my notebook* while it was a block of its own,
 * and both halves of that were load-bearing: *send* because something really is
 * sent, and *my notebook* because the document belongs to the learner.
 *
 * In a row of destinations, a sentence is not a fourth destination.
 * The verb moved up into the group's own heading, which already says *take this
 * lesson to*, and what a learner cannot read off the short label is on the
 * control as its title and its accessible name (`notebookPushSeamLine`) and in
 * the receipt the press writes.
 *
 * Receipts retain the product's own name.
 */
export const NOTEBOOK_PUSH_LABEL = 'Google Notebook';

/**
 * The sentence that keeps this honest, before it is pressed.
 *
 * §5d: the surface states plainly what Virgil can and cannot do. It rewrites
 * its own document, which it can. It cannot see the notebook, cannot know when
 * Google next reads that document, and does not say otherwise.
 *
 * **It was a line under the button and is now the button's own sentence.** The
 * custody claim did not get smaller when the label did: it is the title and the
 * accessible name on the control, which is where the other three doors in that
 * group already carry theirs, and it is read before a press rather than after.
 */
export function notebookPushSeamLine(): string {
  return 'I take this lesson to Gemini Notebook. Virgil refreshes its stable Notebook sources when available; '
    + 'otherwise I copy this lesson for you to paste. I can’t see your notebook.';
}

/** Hosted fallback when no durable Drive connection exists. */
export function notebookClipboardText(
  heading: string, body: string, question: string | null,
): string {
  return [
    heading.trim(), body.trim(),
    question?.trim() ? `Practice question\n${question.trim()}` : '',
  ].filter(Boolean).join('\n\n');
}

export function notebookCopiedLine(opened: boolean): string {
  return opened
    ? 'I copied this lesson and opened Gemini Notebook. Paste it there to continue.'
    : `I copied this lesson, but I couldn’t open the tab. Gemini Notebook is at ${NOTEBOOK_HOST}`;
}

export function notebookCopyFailedLine(): string {
  return 'I couldn’t copy this lesson, so I haven’t opened Notebook. Nothing left this page.';
}

/**
 * What happened, in the service's own words plus the one fact it does not have.
 *
 * The receipt line is written once, in `core/`, so that the panel and the
 * settings screen and the run log cannot describe one write three ways. This
 * adds only the thing the service could not know: that a tab was opened here.
 */
export function notebookPushedLine(receiptLine: string): string {
  return `${receiptLine} I have opened Gemini Notebook in a new tab.`;
}

/**
 * The write did not go through.
 *
 * Said as one fact and with the consequence attached, because the consequence
 * is the whole reason this seam reports at all: a document that did not get
 * rewritten is a document still saying what it said last time, and from where
 * the learner is standing that looks exactly like success.
 */
export function notebookPushFailedLine(): string {
  return 'I couldn’t write your document just now, so I haven’t opened anything. '
    + 'What your notebook has is still what I last wrote.';
}

/** The tab did not open. The learner still gets the address, because the one
 *  thing this affordance promised is a door and it should not close silently. */
export function notebookTabFailedLine(): string {
  return `I couldn’t open the tab. Gemini Notebook is at ${NOTEBOOK_HOST}`;
}

/**
 * There is nowhere for the document to go, which is not a failure.
 *
 * A service with no folder and no Drive grant does not have this feature yet,
 * and the endpoint says so with a 404 rather than an error. So the surface says
 * so too: no red, no apology, no retry. One sentence naming the missing thing
 * and one door to the place it is switched on.
 */
export function notebookNotKeptLine(): string {
  return 'I’m not keeping documents for a notebook here, so I’ll use a visible copy-and-paste hand-off.';
}

/** Truthful receipt for the foreground three-source refresh. Opening is separate. */
export function hostedNotebookWrittenLine(account: string, createdKeys: readonly string[]): string {
  if (!createdKeys.length) {
    return `I refreshed Virgil’s three Notebook sources in ${account} Google Drive.`;
  }
  if (createdKeys.length === HOSTED_NOTEBOOK_DOC_KEYS.length) {
    return `I created Virgil’s three Notebook sources in ${account} Google Drive: Learn now, On the board and Archive. Add each one to this Google Notebook once; after that I’ll rewrite these same sources.`;
  }
  const labels: Record<string, string> = {
    'learn-now': 'Learn now', 'on-the-board': 'On the board', archive: 'Archive',
  };
  const made = createdKeys.map((key) => labels[key] ?? key).join(', ');
  return `I refreshed Virgil’s three Notebook sources in ${account} Google Drive. I also created ${made}; add ${createdKeys.length === 1 ? 'it' : 'them'} to this Google Notebook once.`;
}

/** The one door, and it goes where the setup actually is. */
export const NOTEBOOK_SETTINGS_ACTION = 'Set that up';
