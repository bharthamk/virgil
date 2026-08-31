import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type {
  Clock, DocReceipt, NotebookDoc, NotebookExport, WriteReceipt,
} from '@sb/core';

/**
 * The notebook export, onto a local disk.
 *
 * `NOTEBOOK_SEAM_V2.md` §9. This is two things at once, and it is worth being
 * clear which, because they have different lifetimes.
 *
 * **It is the self-hoster's floor.** Somebody running Virgil on their own
 * machine who does not want to connect a Google account still gets the three
 * documents, as files, in a directory they chose. They can put them anywhere
 * that reads files, including a Drive folder synced by Google's own desktop
 * client, which is a route to the same destination that involves this
 * repository in none of it.
 *
 * **It is the proof the engine works before OAuth exists.** The Drive adapter
 * (§10) cannot be written yet, because there is no OAuth client to write it
 * against, and an adapter that has never once run is not evidence of anything.
 * So the port gets an implementation that runs, on every machine, in every
 * test, and the Drive adapter becomes a fill-in rather than a first attempt.
 *
 * **No Google SDK is involved, here or anywhere in this repository yet.** This
 * file imports `node:fs/promises` and nothing else. When the Drive adapter is
 * built it will live beside this one, in `adapters/`, and `core/` will remain
 * structurally unable to name it.
 *
 * ## The failure contract, held rather than described
 *
 * `ports/notebook-export.ts` states it: one row per document offered, always,
 * and a document that failed to write is reported rather than silently left
 * stale. This implementation holds it by never letting one document's failure
 * end the loop. Four documents writing and one hitting a full disk is the
 * realistic case, and an exception thrown at the fifth would discard the four
 * that worked along with the knowledge of which one did not.
 *
 * The one thing that does reject as a whole is the directory: a target that
 * cannot be created is not a failure of any particular document, and reporting
 * it three times as three identical rows would be describing one problem as three.
 */

/**
 * The three filesystem calls this adapter makes, named so something can stand
 * in front of them.
 *
 * The same argument `JsonStore` makes for `StoreFs`, and the same one applies
 * with more force here: the interesting behaviour of this class is entirely
 * what it does when a write does *not* work, none of that is reachable by
 * driving the public API on a working disk, and a seam whose whole point is
 * honest failure reporting cannot have its failure path be the untested one.
 *
 * Deliberately three methods rather than the module: the surface a stand-in has
 * to implement is the surface this class actually uses, and widening it would
 * invite new filesystem calls to arrive silently.
 */
export interface ExportFs {
  mkdir(path: string, opts: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

const realFs: ExportFs = {
  mkdir: (path, opts) => mkdir(path, opts),
  writeFile: (path, data, encoding) => writeFile(path, data, encoding),
  rename: (from, to) => rename(from, to),
};

/**
 * What went wrong, in words a learner can act on.
 *
 * The port says `error` is a sentence and never an exception's `toString`, and
 * this is where that is true rather than intended. `Error: ENOENT, open
 * '/Users/x/Library/.../virgil-sources.md'` is not a sentence, it is a stack
 * frame with the learner's home directory in it, and a surface that shows it
 * has passed the problem on rather than reported it.
 */
function plainly(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'EACCES' || code === 'EPERM') {
    return 'I do not have permission to write there.';
  }
  if (code === 'ENOSPC') return 'The disk is full, so I could not write it.';
  if (code === 'ENOENT') return 'The folder I was writing into is not there any more.';
  if (code === 'EROFS') return 'That folder is read only, so I could not write it.';
  if (typeof code === 'string' && code) {
    return `Writing it failed, and the system said ${code}.`;
  }
  return 'Writing it failed, and the system did not say why.';
}

export interface LocalNotebookExportOptions {
  /** The directory the documents live in. Created if it is not there. */
  readonly directory: string;
  readonly clock: Clock;
  readonly fs?: ExportFs;
}

/**
 * `virgil-<key>.md`.
 *
 * Named from the **key** and never from the title. The key is a closed union of
 * three string literals declared in `core/`, so the filename cannot contain a
 * separator, a parent reference, or anything else a learner or a model put
 * into a title. A file named from a title would be a path built out of prose.
 *
 * `.md` because the body is light Markdown and because a self-hoster opening
 * the directory should find something readable rather than something that needs
 * this repository to make sense of.
 */
const fileNameFor = (doc: NotebookDoc): string => `virgil-${doc.key}.md`;

export class LocalNotebookExport implements NotebookExport {
  private readonly directory: string;
  private readonly clock: Clock;
  private readonly fs: ExportFs;

  constructor(opts: LocalNotebookExportOptions) {
    this.directory = resolve(opts.directory);
    this.clock = opts.clock;
    this.fs = opts.fs ?? realFs;
  }

  async writeDocs(docs: readonly NotebookDoc[]): Promise<WriteReceipt> {
    // A target that cannot be made is one problem, not three. It is also the one
    // failure here that is worth interrupting the caller for, because nothing
    // that follows can succeed.
    await this.fs.mkdir(this.directory, { recursive: true });

    const receipts: DocReceipt[] = [];
    for (const doc of docs) {
      receipts.push(await this.writeOne(doc));
    }
    return {
      at: this.clock.now().toISOString(),
      target: this.directory,
      docs: receipts,
    };
  }

  /**
   * One document, atomically.
   *
   * A temporary file and then a rename, so that a crash or a full disk half way
   * through leaves the previous version of the document intact rather than half
   * of the new one. That matters more here than it does for most files: these
   * are the sources a notebook is reading, and half a document is worse than an
   * old document, because an old document is at least internally consistent and
   * says its own date on line two.
   *
   * The temporary name carries the pid and a uuid so that two processes
   * exporting the same board at once cannot collide on it.
   */
  private async writeOne(doc: NotebookDoc): Promise<DocReceipt> {
    const target = join(this.directory, fileNameFor(doc));
    const temp = join(this.directory, `.${fileNameFor(doc)}.${process.pid}.${randomUUID()}`);
    const bytes = Buffer.byteLength(doc.body, 'utf8');
    try {
      await this.fs.writeFile(temp, doc.body, 'utf8');
      await this.fs.rename(temp, target);
      return { key: doc.key, title: doc.title, written: true, at: target, bytes, error: null };
    } catch (error) {
      // Best effort. A temp file left behind is untidy; failing to report the
      // real problem because tidying up threw its own is worse.
      try { await unlink(temp); } catch { /* never written, or already renamed */ }
      return {
        key: doc.key,
        title: doc.title,
        written: false,
        at: null,
        bytes,
        error: plainly(error),
      };
    }
  }
}
