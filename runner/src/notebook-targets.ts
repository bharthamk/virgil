import type { DocReceipt, NotebookDoc, NotebookExport, WriteReceipt } from '@sb/core';

/**
 * Where the three documents go, decided at the moment of writing.
 *
 * `NOTEBOOK_SEAM_V2.md` §9 and §10. The service holds one `NotebookExport` and
 * the promise made on `AppOptions.notebook` is that the Drive adapter arrives as
 * *"the same option with a different thing behind it, and nothing in this file
 * will change"*. This is that different thing, and it is here rather than in the
 * service for exactly that reason.
 *
 * ## Why the Drive lane is resolved per call rather than at boot
 *
 * A learner presses **Connect Drive** while the service is running. If the
 * destination were decided at startup, the seam would not begin writing to Drive
 * until they restarted the process, and nothing on any screen would say so. So
 * the Drive side is a function that is asked each time, and it answers null
 * until there is a grant to write with.
 *
 * ## Both, when both are configured
 *
 * A self-hoster may keep a local directory *and* connect Drive: the directory is
 * a readable copy on their own disk and Drive is what the notebook reads. The
 * receipt still has **one row per document offered**, which is the port's law,
 * and a row is `written` only when it landed in every destination — four
 * documents in a folder and none in Drive is not a night that wrote everything.
 * `at` prefers the Drive file id, because that is the identity the notebook is
 * reading and the path is the copy.
 */

export interface NotebookTargets {
  /** A directory, or null when `SB_NOTEBOOK_DIR` is unset. */
  readonly local: NotebookExport | null;
  /** The Drive adapter, or null while nothing is connected. Asked per write. */
  readonly drive: () => NotebookExport | null;
}

/** The words for a destination that is switched on and has no grant behind it
 *  yet. This is the port's whole-target rejection: it is not about any one
 *  document, and reporting it once per document would describe one thing as
 *  several separate failures. */
export const NO_DESTINATION =
  'Google Drive is switched on and is not connected yet, so there is nowhere to put your documents.';

export function notebookDestination(targets: NotebookTargets): NotebookExport {
  return {
    async writeDocs(docs: readonly NotebookDoc[]): Promise<WriteReceipt> {
      const drive = targets.drive();
      const to = [
        ...(drive ? [{ adapter: drive, isDrive: true }] : []),
        ...(targets.local ? [{ adapter: targets.local, isDrive: false }] : []),
      ];
      if (!to.length) throw new Error(NO_DESTINATION);
      // One destination is the ordinary case, and it hands its own receipt
      // straight back rather than being merged with nothing.
      if (to.length === 1) return to[0]!.adapter.writeDocs(docs);

      const receipts = await Promise.all(to.map(async (t) => ({
        isDrive: t.isDrive,
        receipt: await t.adapter.writeDocs(docs),
      })));
      return merge(docs, receipts);
    },
  };
}

/** Row by row, keyed on the document rather than on position, so a destination
 *  that ever answered in a different order could not shuffle the reasons. */
function merge(
  docs: readonly NotebookDoc[],
  parts: readonly { readonly isDrive: boolean; readonly receipt: WriteReceipt }[],
): WriteReceipt {
  const rows: DocReceipt[] = docs.map((doc) => {
    const seen = parts.map((p) => ({
      isDrive: p.isDrive,
      row: p.receipt.docs.find((d) => d.key === doc.key) ?? null,
    }));
    const written = seen.every((s) => s.row?.written === true);
    const failed = seen.find((s) => s.row && !s.row.written)?.row ?? null;
    const driveRow = seen.find((s) => s.isDrive)?.row ?? null;
    const landed = seen.find((s) => s.row?.written)?.row ?? null;
    return {
      key: doc.key,
      title: doc.title,
      written,
      // The Drive file id is the identity the notebook reads; the local path is
      // a copy of it. Where Drive did not land, the honest answer is whatever
      // did, and null when nothing did.
      at: written ? (driveRow?.at ?? landed?.at ?? null) : null,
      bytes: seen.find((s) => s.row)?.row?.bytes ?? Buffer.byteLength(doc.body, 'utf8'),
      error: written ? null : (failed?.error ?? 'It did not go through, and nothing said why.'),
      ...(seen.some((s) => s.row?.recreated) ? { recreated: true } : {}),
    };
  });
  return {
    at: parts[0]!.receipt.at,
    target: parts.map((p) => p.receipt.target).join(', and '),
    docs: rows,
  };
}
