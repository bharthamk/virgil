/**
 * The export seam — where Virgil's own prose leaves for a place the learner
 * owns.
 *
 * `NOTEBOOK_SEAM_V2.md` is the design. The short version is that Gemini
 * Notebook re-reads native Google Docs from Drive by itself, on its own
 * schedule, with no user setting (verified 2026-08-24 against Google's release
 * note), so a small fixed set of documents rewritten in place becomes a
 * notebook that stays current for ever without anybody clicking anything.
 *
 * This port is the boundary between *deciding what to say*, which is
 * `domain/notebook-docs.ts` and is pure, and *putting it somewhere*, which is
 * an adapter and is not. Two adapters are foreseen and only one is built: the
 * local filesystem, which is the self-hoster's floor and the proof the engine
 * works, and Drive, which is designed in §10 of the doc (Projects/virgil/NOTEBOOK_SEAM_V2.md,
 * outside this repository) and waits on an OAuth
 * client that does not exist yet.
 *
 * ## Why this is a port rather than the runner writing files
 *
 * The same argument as `Llm` and `Store`, and one more that is specific to this
 * seam.
 *
 * The general one: the Drive adapter has to be a fill-in rather than a rewrite,
 * and the only way to know it can be is for the local adapter to be reachable
 * through the identical interface first.
 *
 * The specific one is the failure contract below. This seam has a failure mode
 * nothing else in the product has: **a stale export looks exactly like a fresh
 * one from where the learner is standing.** A notebook whose sources are three
 * weeks old answers fluently and confidently and gives no sign at all. There is
 * no blank screen, no spinner that never stops, no 500. Getting the reporting
 * right therefore matters more here than the writing does, and a contract
 * written twice is a contract got wrong twice.
 */

/**
 * Virgil's name for a document, and the only one that is stable for ever.
 *
 * Three names are kept apart on purpose, because conflating them is how
 * rewriting-in-place quietly stops being in place:
 *
 *  - **the key** is this. It appears in no learner-facing text, it is what the
 *    file-id mapping is keyed on, and it never changes.
 *  - **the file id** is Drive's name. Virgil stores it and never invents it.
 *  - **the title** is the learner's. It may be changed, by us or by them, and
 *    changing it breaks nothing, because it was never the identity.
 *
 * A closed union rather than a string, because the set is a published contract:
 * a learner adds these documents to their notebook once and Virgil can never
 * add a fourth for them afterwards, having no way to see or reach the notebook.
 * Growing this union is a versioned event with a migration story, and the type
 * is where that stops being a matter of remembering.
 *
 * ## Three, and organised by the moment they are read
 *
 * The set was five, and the five were Virgil's data model wearing learner
 * words: working-on, steady-and-shaky, results, sessions, sources. Each one was
 * honest and each one held a slice of every topic, so the question a person
 * actually brings to a notebook — *which of these should I work on?* — could
 * only be answered by reading four documents and joining them by hand. A
 * retrieval system does not join by hand.
 *
 * So the three are named for **when a learner reaches for them**:
 *
 *  - `learn-now` — the lesson that is in front of them right now.
 *  - `on-the-board` — everything they are carrying, each topic written whole
 *    and in one place, so *which one* is answerable from a single chunk.
 *  - `archive` — the subjects they have held and not removed, for picking up
 *    something older.
 *
 * There is no migration and no pointer document, and there was never a released
 * build holding the old five. A learner who had them adds three and deletes
 * five, which is the same one-time gesture the setup already asks for.
 */
export type NotebookDocKey =
  | 'learn-now'
  | 'on-the-board'
  | 'archive';

/** The three, in the order a learner is asked to add them, which is also the
 *  order they are reached for. Exported so that a caller cannot assemble a
 *  partial set by listing them again from memory. */
export const NOTEBOOK_DOC_KEYS: readonly NotebookDocKey[] = [
  'learn-now', 'on-the-board', 'archive',
];

/**
 * One document, as the engine produced it.
 *
 * `body` is prose with light Markdown structure. Light is deliberate: headings,
 * paragraphs, list items and links, and nothing else. The local adapter writes
 * it as it stands; the Drive adapter converts it to minimal HTML so the native
 * Doc gets real headings and real hyperlinks (§10.2).
 *
 * `house-style.ts` forbids headings in agent replies, and its stated reason is
 * that *"nothing renders it, so a learner reads the characters"*. In a Google
 * Doc something does render it, and structure is load-bearing for grounding: a
 * retrieval system chunks on structure, and a citation landing under a named
 * heading is a citation somebody can check. The reason for the ban does not
 * apply here, so the ban does not travel. Recorded so a later reader does not
 * find headings in a Virgil document and conclude the house style eroded.
 *
 * The dash rule has no such escape and applies in full.
 */
export interface NotebookDoc {
  readonly key: NotebookDocKey;
  readonly title: string;
  readonly body: string;
}

/**
 * What happened to one document.
 *
 * `error` is set exactly when `written` is false, and is a sentence rather than
 * an exception's `toString`. The learner-facing half of this seam is a line
 * saying which document did not get written; `Error: ENOENT, open '/x/y'` is
 * not that line, and a surface that shows it has passed the problem on rather
 * than reported it.
 */
export interface DocReceipt {
  readonly key: NotebookDocKey;
  readonly title: string;
  readonly written: boolean;
  /** Where it landed. A path for the local adapter, a file id for Drive. Null
   *  when it did not land, because there is no honest answer in that case. */
  readonly at: string | null;
  readonly bytes: number;
  readonly error: string | null;
  /**
   * This document had to be made again, because the one Virgil had was gone.
   *
   * Absent everywhere but Drive, and absent on almost every Drive write. §10.3:
   * a learner who deletes one of the three documents out of their Drive leaves
   * Virgil holding a file id that answers 404, and the only thing it can do is
   * create a replacement. That is a real thing a learner did, and the honest
   * consequence is a source their notebook is still pointing at which no longer
   * exists, plus one new document they have to add. **The receipt is how they
   * find out**, and there is no other route: Virgil cannot see the notebook.
   *
   * Optional rather than a required boolean, because it is a fact about one
   * destination and a local file rewritten in place has no equivalent event.
   */
  readonly recreated?: boolean;
}

/**
 * What happened to all of them.
 *
 * **One row per document offered, always.** A missing row is not expressible,
 * and that is the whole design of this type: the realistic failure here is two
 * documents writing and one hitting a quota, and a `Promise` that rejected
 * would discard both the two that worked and the knowledge of which one did
 * not. So `writeDocs` does not throw for a document that failed; it returns a
 * receipt whose row says so.
 *
 * An adapter may still reject as a whole, for a failure that is not about any
 * one document: no credential, no network, no folder. That is a different fact
 * and it has a different shape.
 *
 * `at` comes from the injected clock. Nothing in this seam reads a wall clock,
 * for the same reason nothing else in the product does.
 */
export interface WriteReceipt {
  readonly at: string;
  /** Where, in words a learner can read. A directory, or a Drive folder. */
  readonly target: string;
  readonly docs: readonly DocReceipt[];
}

export interface NotebookExport {
  writeDocs(docs: readonly NotebookDoc[]): Promise<WriteReceipt>;
}

/** Did every document offered actually land. */
export const allWritten = (receipt: WriteReceipt): boolean =>
  receipt.docs.length > 0 && receipt.docs.every((d) => d.written);

/** The ones that did not, for the warn line and the honest surface. */
export const failedDocs = (receipt: WriteReceipt): readonly DocReceipt[] =>
  receipt.docs.filter((d) => !d.written);

/** The ones that had to be made again, which is the one outcome that asks the
 *  learner to do something. See `DocReceipt.recreated`. */
export const recreatedDocs = (receipt: WriteReceipt): readonly DocReceipt[] =>
  receipt.docs.filter((d) => d.recreated === true);

/**
 * The sentence a recreated document earns, or none.
 *
 * Separate from `receiptLine`'s three cases because it is a different kind of
 * fact: those describe what Virgil managed, and this asks the learner for
 * something. It is appended rather than folded in so that a surface which only
 * wants the outcome can still show the outcome.
 */
function recreatedLine(receipt: WriteReceipt): string {
  const again = recreatedDocs(receipt);
  if (!again.length) return '';
  const one = again.length === 1;
  return ` I had to make ${one ? '1 of them' : `${again.length} of them`} from scratch, `
    + `because ${one ? 'it was' : 'they were'} no longer in your Drive. `
    + `You will need to add ${one ? 'that document' : 'those documents'} as a source again: `
    + `${again.map((d) => d.title).join(', ')}.`;
}

/**
 * What to say about a receipt, in one line.
 *
 * Three cases and not two, because a partial failure is its own fact: two
 * written and one not is neither "exported" nor "export failed", and rounding
 * it to either is the kind of small lie that makes somebody stop reading the
 * status line at all.
 *
 * **Nothing here says the notebook is up to date**, and nothing anywhere else
 * may either. Virgil knows when it last wrote a file. It cannot see the
 * notebook, does not know what Google read or when, and will not imply that it
 * does.
 */
export function receiptLine(receipt: WriteReceipt): string {
  const failed = failedDocs(receipt);
  const total = receipt.docs.length;
  if (total === 0) return 'There was nothing to write.';
  if (failed.length === 0) {
    return (total === 1
      ? `I rewrote 1 document in ${receipt.target}.`
      : `I rewrote all ${total} documents in ${receipt.target}.`) + recreatedLine(receipt);
  }
  if (failed.length === total) {
    return `I could not write any of your documents to ${receipt.target}. `
      + `They are still there, and what they say is out of date.`;
  }
  const names = failed.map((d) => d.title).join(', ');
  return `I rewrote ${total - failed.length} of ${total} documents in ${receipt.target}. `
    + `I could not write: ${names}. Those are still there, and what they say is out of date.`
    + recreatedLine(receipt);
}
