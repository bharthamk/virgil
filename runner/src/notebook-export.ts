import type {
  Clock, NotebookDocKey, NotebookExport, NotebookInput, Store, WriteReceipt,
} from '@sb/core';
import {
  NOTEBOOK_DOC_KEYS,
  allWritten, computeComfort, failedDocs, isZone, notebookDoc, notebookDocs, projectSafeSession,
  scheduleFrom, tend,
} from '@sb/core';

/**
 * The notebook export, composed.
 *
 * `NOTEBOOK_SEAM_V2.md` §9. Three steps and no judgement of its own: read the
 * board, hand it to the pure engine in `core/`, hand the documents to whichever
 * adapter the composition root configured. Everything interesting is on one
 * side of this file or the other.
 *
 * ## It costs nothing, and that is why there is no budget gate on it
 *
 * `notebookDocs` makes **no model call**. It is arithmetic and string
 * building over rows the store already holds. The spend limit
 * (`domain/model-budget.ts`) guards the connection that can bill, and there is
 * nothing here for it to guard: a run with an exhausted budget still exports,
 * and should, because the alternative is a learner whose limit stopped a night
 * also silently getting a stale notebook out of it.
 *
 * This is stated rather than left to be noticed, because the natural instinct
 * on seeing a new last-step-of-the-nightly is to wrap it in the same gate as
 * everything else, and doing so would make the one part of the night that
 * cannot fail for provider reasons able to fail for provider reasons.
 *
 * ## Failure here does not fail the night
 *
 * The session was built and persisted before this runs. An export that cannot
 * write is a real problem and is reported as one, and it is **not** grounds for
 * turning a successful night into a failed one: a Cloud Run Job retry would
 * re-run nine model stages to fix a directory permission. Both facts are true
 * at once and both are said.
 */

/**
 * Everything the three documents are made of, read once.
 *
 * The same two `core/` calls the nightly and the session card already make
 * (`computeComfort`, `tend`), on the same inputs, for the same reason
 * `readBoardState` in the service makes them: the reason line in the exported
 * document has to be **the Gardener's actual reason**, and the only way for the
 * document and the run to be unable to disagree is for the document to ask the
 * Gardener rather than to describe what it thinks the Gardener would have said.
 *
 * Deterministic and free: arithmetic over topics and signals, and no model call
 * anywhere on this path.
 *
 * `listSessions` and `listPins` are whole-collection reads, and the engine caps
 * what it uses (`SESSION_WINDOW`, `MAX_SOURCE_PINS`). That is the same shape
 * `progression-source.ts` already lives with, because the `Store` port offers
 * no windowed read of either, and inventing one for this would be a port change
 * driven by an export.
 */
export async function readNotebookInput(store: Store, clock: Clock): Promise<NotebookInput> {
  const now = clock.now();
  const [topics, signals, pins, statements, courses, commitments, sessions, outcomes, prefs] =
    await Promise.all([
      store.listTopics(),
      store.listSignals(),
      store.listPins(),
      store.listStatements(),
      store.listCourses(),
      store.listCommitments(),
      store.listSessions(),
      store.listOutcomes(),
      store.getPrefs(),
    ]);
  const scheduled = scheduleFrom(prefs.schedule);
  const timeZone = typeof prefs.timeZone === 'string' && isZone(prefs.timeZone)
    ? prefs.timeZone
    : scheduled.kind === 'daily' ? scheduled.timeZone : 'UTC';
  const comforts = topics.map((t) => computeComfort(t.id, signals, now));
  return {
    now,
    timeZone,
    topics,
    signals,
    pins,
    statements,
    courses,
    commitments,
    sessions: sessions.map((session) => projectSafeSession(session, topics)),
    outcomes,
    comforts,
    reasons: tend({ topics, comforts, signals, now, commitments, timeZone }),
  };
}

/**
 * A scope the caller asked for that this service cannot honour.
 *
 * Its own class, and it lives here rather than in `service.ts` for the reason
 * the parser does: the set of documents is `core/`'s and the rule about what may
 * be asked for belongs beside the function that writes them. The service maps it
 * to a 400, which is the only thing it means.
 */
export class NotebookScopeError extends Error {}

/**
 * Which documents a write is about, off the request body.
 *
 * The lesson's push door asks for one of them; the setup flow and anybody
 * pressing export ask for all of them by sending nothing. So absent is the whole
 * set, which keeps every existing caller correct without changing a line of it.
 *
 * **A name that is not a document key is refused rather than widened.** The
 * generous reading of a typo here is three Drive writes somebody did not ask
 * for, and a caller that meant one document and got three has been told nothing
 * about it. `NOTEBOOK_DOC_KEYS` is the only list, so this cannot drift from the
 * set the engine actually builds.
 *
 * Nothing about *which lesson* is expressible here, deliberately. The document
 * is rendered from the store's own current session, so there is no field on this
 * request through which one surface's idea of the current lesson could disagree
 * with another's.
 */
export function notebookScope(
  body: Record<string, unknown>,
): readonly NotebookDocKey[] | undefined {
  const asked = body.docs;
  if (asked === undefined || asked === null) return undefined;
  if (!Array.isArray(asked)) throw new NotebookScopeError('docs must be a list of document keys');
  const keys: NotebookDocKey[] = [];
  for (const one of asked) {
    const key = NOTEBOOK_DOC_KEYS.find((k) => k === one);
    if (!key) throw new NotebookScopeError(`docs: ${String(one)} is not a document I keep`);
    if (!keys.includes(key)) keys.push(key);
  }
  if (!keys.length) throw new NotebookScopeError('docs was empty, so there was nothing to write');
  return keys;
}

/**
 * Read the board, build the documents, write them. Returns the receipt.
 *
 * `only` is the lesson push and nothing else: *"send this to my notebook"* means
 * rewrite the learn-now document, and rewriting the other two on a tap somebody
 * made about one lesson would put two extra Drive writes behind a control that
 * promised one. The other documents stay exactly as the last write left them,
 * which is what "rewritten in place" already means everywhere else in this seam.
 *
 * **The scope decides which documents are written and nothing else.** Every one
 * of them is still built from the same `readNotebookInput` read of the store, so
 * a pushed learn-now says exactly what the nightly would have said about the
 * same board. There is no second path through the engine and no place for one
 * surface's idea of the current lesson to enter.
 *
 * An empty or absent scope is the whole set, which is what the nightly and the
 * setup flow both want.
 */
export async function exportNotebook(
  store: Store,
  clock: Clock,
  to: NotebookExport,
  only?: readonly NotebookDocKey[],
): Promise<WriteReceipt> {
  const input = await readNotebookInput(store, clock);
  return to.writeDocs(only?.length
    ? only.map((key) => notebookDoc(key, input))
    : notebookDocs(input));
}

/**
 * The same export, with the rule that it never fails a night applied.
 *
 * Lifted out of `runBatch` rather than written there, because it is not a
 * stage: it is the thing the run does once every stage is over, and the file
 * that sequences ten model stages should not also be the file that decides what
 * a partial filesystem write means. What moved is exactly the try/catch and its
 * two warnings; the contract is unchanged and is restated where it now lives.
 *
 * Two different failures, and both are receipts rather than throws:
 *
 *  - **Some documents were not written.** The receipt names them, and what they
 *    say at the target is out of date until the next run repairs it.
 *  - **Nothing could be written at all** (no folder, no credential, no network).
 *    A receipt with no documents in it, rather than nothing, because an absent
 *    receipt is indistinguishable from the feature being switched off, and those
 *    are different facts about somebody's board.
 *
 * `NOTEBOOK_SEAM_V2.md` §11: never silently stale, and a partial failure
 * reported as a partial failure.
 */
export async function exportNotebookAfterRun(
  store: Store,
  clock: Clock,
  to: NotebookExport,
): Promise<WriteReceipt> {
  try {
    const receipt = await exportNotebook(store, clock, to);
    if (!allWritten(receipt)) {
      const failed = failedDocs(receipt);
      console.warn(`[notebook] ${failed.length} document(s) were not written`
        + ` (${failed.map((d) => d.key).join(', ')}); what they say in ${receipt.target}`
        + ' is now out of date');
    }
    return receipt;
  } catch (err) {
    console.warn('[notebook] the export could not run at all:', err);
    return {
      at: clock.now().toISOString(),
      target: 'the place you asked me to keep your documents',
      docs: [],
    };
  }
}
