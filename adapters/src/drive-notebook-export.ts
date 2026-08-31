import { randomUUID } from 'node:crypto';
import type {
  Clock, DocReceipt, NotebookDoc, NotebookExport, WriteReceipt,
} from '@sb/core';
import { notebookDocHtml } from '@sb/core';

/**
 * The notebook export, into the learner's own Google Drive.
 *
 * `NOTEBOOK_SEAM_V2.md` §10. The sibling of `local-notebook-export.ts`, reached
 * through the identical port, and the reason that port exists at all: the local
 * adapter proved the engine before any OAuth client existed, and this is the
 * fill-in it was built to make possible rather than a rewrite.
 *
 * ## Raw REST, and no Google SDK
 *
 * §12: *"No Google SDK in this repository."* This file makes plain HTTPS calls
 * with `fetch` and nothing else. The Drive surface it needs is four requests
 * wide, an SDK would bring a dependency tree and a credential-handling layer of
 * its own into a repository whose whole trust argument is that nothing is in the
 * path, and `check-seam.mjs` would still have to keep `core/` unable to name it.
 * The cost of writing the four calls by hand is one file; the cost of the
 * dependency is an argument in §4 that stops being checkable.
 *
 * ## Route B: one call, one file id, still a native Doc
 *
 * §10.1 chose Drive `files.update` with converting media over the Docs API's
 * `documents.batchUpdate`, and the decision is load-bearing rather than a
 * preference. Google's upload guide states the behaviour outright: uploading and
 * converting media during an `update` on a Docs file **replaces the full
 * contents of the document**. One round trip, no index arithmetic in UTF-16 code
 * units, no undeletable-last-newline edge case, real headings and real
 * hyperlinks straight out of the HTML — and, decisively, **no second scope**.
 * Route A would have pulled a Docs API scope on top of `drive.file`, widening
 * the consent screen for a worse result.
 *
 * ## The file id is the identity, and nothing else is
 *
 * §3's law: **created exactly once, thereafter only rewritten.** A new file
 * every night is a file the learner's notebook has never heard of, and per §2's
 * Fact 2 the old one being removed would silently take the working source out of
 * the notebook with it. So there is a persisted map from document key to file
 * id, it is the only durable state this seam has, and losing it is the one
 * failure that costs a re-setup.
 *
 * **`files.delete` is never called. There is no delete path in this file at
 * all**, so a bug cannot reach one. Deleting is exactly how a source leaves a
 * notebook without anybody being told.
 *
 * ## What rejects and what is reported
 *
 * The port's split, held literally. A failure that is not about any one document
 * — no credential, consent withdrawn, the folder unreachable — rejects as a
 * whole, because reporting one problem as three identical rows describes it
 * wrongly and nothing that follows could have succeeded anyway. A failure that
 * *is* about one document — a quota on the fourth write, a single refused
 * upload — is a row, because four documents landing and one not is the realistic
 * case and an exception would discard the four along with the knowledge of which
 * one did not.
 */

/** Google's name for a native Google Doc. Metadata `mimeType`, never the media
 *  type: the media is `text/html` and the conversion is the point. */
const DOC_MIME = 'application/vnd.google-apps.document';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const HTML_MIME = 'text/html; charset=UTF-8';

/** §3: one folder, and it never grows a sibling. The learner sees this word in
 *  their own Drive, so it is the product's name and not a slug. */
export const DRIVE_FOLDER_NAME = 'Virgil';

/** Where a learner opens the folder. Built rather than stored, because it is a
 *  function of the id and a stored URL is a second thing that can go stale. */
export const driveFolderLink = (folderId: string): string =>
  `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`;

/** In words a learner can read, per the port. Never a path, never an id. */
export const DRIVE_TARGET_WORDS = `your Google Drive, in a folder called ${DRIVE_FOLDER_NAME}`;

const DEFAULT_API_BASE = 'https://www.googleapis.com';

/** Long enough for a slow upload on a bad connection, short enough that a
 *  nightly cannot hang on a socket Google never closes. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * A usable access token, and a way to ask for a fresh one.
 *
 * Deliberately this small. The adapter knows nothing about OAuth, refresh
 * tokens, PKCE or loopback listeners: all of that is credential handling, it
 * belongs in `runner/` beside `model-credentials.ts` which already does exactly
 * this job for the Gemini key, and an adapter that held a refresh token would be
 * an adapter that had to be trusted with one.
 *
 * `refresh` is asked for exactly once per request, after a 401. An access token
 * that expired mid-nightly is ordinary; the same request failing again with a
 * new token is consent that no longer exists.
 */
export interface DriveAuth {
  accessToken(opts?: { readonly refresh?: boolean }): Promise<string>;
}

/**
 * The only durable state this seam has (§10.3).
 *
 * Not a secret, and stored beside the credential anyway, because it is
 * meaningless without one and because losing them together is a clean re-setup
 * while losing them separately leaves Virgil holding ids for files it can no
 * longer prove it created.
 */
export interface DriveFileIds {
  readonly folderId: string | null;
  /** Keyed by `NotebookDocKey`. A plain record so it can be JSON on disk
   *  without a codec in the middle. */
  readonly files: Readonly<Record<string, string>>;
}

export interface DriveIdStore {
  read(): Promise<DriveFileIds>;
  write(ids: DriveFileIds): Promise<void>;
}

/**
 * Google will not let us in any more, and a different token will not help.
 *
 * The whole-target failure this adapter is most likely to meet in the wild:
 * §13's *"the notebook outlives the consent"*. A learner revokes access in their
 * Google account, Virgil's writes start failing, and Virgil's one job is to
 * notice and say so rather than to keep quietly not-writing.
 */
export class DriveAccessLost extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriveAccessLost';
  }
}

export interface DriveNotebookExportOptions {
  readonly auth: DriveAuth;
  readonly ids: DriveIdStore;
  readonly clock: Clock;
  /** Google's API root. Overridden only by the in-process fake in the tests,
   *  which is the whole reason it is an option: an adapter provable only
   *  against the live service is an adapter provable only by spending. */
  readonly apiBase?: string;
  readonly folderName?: string;
}

/**
 * What Google's answer means, in words a learner can act on.
 *
 * The port says `error` is a sentence and never an exception's `toString`, and
 * this is where that is true rather than intended. **The response body is never
 * quoted**, for a reason beyond tidiness: an error body from an upload can echo
 * request content, and this request's content is the learner's own learning.
 * Only the status and Google's own machine-readable `reason` are read.
 */
function plainly(status: number, reason: string): string {
  if (reason === 'storageQuotaExceeded') {
    return 'There is no room left in your Google Drive, so I could not write it.';
  }
  if (status === 429 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
    return 'Google asked me to slow down, so this one did not go through this time.';
  }
  if (status === 403) return 'Google would not let me write this one.';
  if (status === 404) return 'Google could not find this document any more.';
  if (status >= 500) return 'Google Drive was having trouble, so this one did not go through.';
  if (status === 0) return 'I could not reach Google Drive.';
  return `Writing it did not go through, and Google answered ${status}.`;
}

/** Google's own machine-readable reason, or an empty string. Read defensively:
 *  this is the one part of the response that is safe to look at, and it is only
 *  worth looking at when it is exactly the shape it is documented to be. */
function reasonOf(payload: unknown): string {
  const errors = (payload as { error?: { errors?: unknown } } | null)?.error?.errors;
  if (!Array.isArray(errors)) return '';
  const first = errors[0] as { reason?: unknown } | undefined;
  return typeof first?.reason === 'string' ? first.reason : '';
}

/** A `multipart/related` body: metadata, then the media. Built by hand because
 *  it is eight lines and the alternative is a dependency. */
function multipart(metadata: unknown, html: string): { readonly type: string; readonly body: string } {
  // The boundary may not occur in the payload, and the payload contains prose
  // the learner wrote. A uuid makes a collision impossible in practice; the
  // loop makes it impossible in fact.
  let boundary = `virgil-${randomUUID()}`;
  while (html.includes(boundary)) boundary = `virgil-${randomUUID()}`;
  const body = `--${boundary}\r\n`
    + 'Content-Type: application/json; charset=UTF-8\r\n\r\n'
    + `${JSON.stringify(metadata)}\r\n`
    + `--${boundary}\r\n`
    + `Content-Type: ${HTML_MIME}\r\n\r\n`
    + `${html}\r\n`
    + `--${boundary}--`;
  return { type: `multipart/related; boundary=${boundary}`, body };
}

interface Answer {
  readonly status: number;
  readonly payload: unknown;
}

export class DriveNotebookExport implements NotebookExport {
  private readonly auth: DriveAuth;
  private readonly ids: DriveIdStore;
  private readonly clock: Clock;
  private readonly apiBase: string;
  private readonly folderName: string;

  constructor(opts: DriveNotebookExportOptions) {
    this.auth = opts.auth;
    this.ids = opts.ids;
    this.clock = opts.clock;
    this.apiBase = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.folderName = opts.folderName ?? DRIVE_FOLDER_NAME;
  }

  async writeDocs(docs: readonly NotebookDoc[]): Promise<WriteReceipt> {
    const stored = await this.ids.read();
    // One folder, resolved before anything is written. A folder that cannot be
    // found or made is one problem and not three, and it is the one failure here
    // worth interrupting the caller for, because nothing after it could work.
    const folder = await this.folder(stored.folderId);
    const folderId = folder.id;

    const files: Record<string, string> = { ...stored.files };
    const receipts: DocReceipt[] = [];
    for (const doc of docs) {
      // A known file id is the source Notebook reads and therefore remains the
      // authority. Exact-name recovery is only for a genuinely lost map; a
      // copied or same-named document must never outrank the known identity.
      const recovered = !files[doc.key] && folder.existing
        ? await this.documentInFolder(doc, folderId) : null;
      const one = await this.writeOne(doc, folderId, files[doc.key] ?? recovered);
      if (one.receipt.written && one.fileId) files[doc.key] = one.fileId;
      receipts.push(one.receipt);
    }

    // Written once, after the loop, and only when something actually moved. A
    // write per document would turn three documents into three disk writes of the
    // same map, and a crash between two of them would leave a half-updated one.
    if (folderId !== stored.folderId || !sameFiles(files, stored.files)) {
      await this.ids.write({ folderId, files });
    }

    return {
      at: this.clock.now().toISOString(),
      target: `your Google Drive, in a folder called ${this.folderName}`,
      docs: receipts,
    };
  }

  /**
   * The folder, remembered if we have it and made if we do not.
   *
   * A remembered id is confirmed rather than assumed, because a learner who
   * moved the folder to their bin leaves an id that answers 404 on every write
   * underneath it, which would report three identical failures for one cause.
   * One cheap `files.get` a night buys the honest answer.
   *
   * The search is `files.list` restricted to the app's own files, which is what
   * `drive.file` grants and all it grants: this cannot see, and does not ask to
   * see, a folder somebody else made called Virgil.
   */
  private async folder(remembered: string | null): Promise<{
    readonly id: string; readonly existing: boolean;
  }> {
    if (remembered) {
      const got = await this.request(
        `${this.apiBase}/drive/v3/files/${encodeURIComponent(remembered)}?fields=id,trashed`,
        () => ({ method: 'GET' }),
      );
      const alive = got.status === 200
        && (got.payload as { trashed?: unknown } | null)?.trashed !== true;
      if (alive) return { id: remembered, existing: true };
      if (got.status !== 404 && got.status !== 200) {
        throw new Error(`I could not reach your ${this.folderName} folder in Google Drive.`);
      }
      // Gone, or in the bin. Fall through and make a new one: the learner threw
      // it away and the honest consequence is a fresh folder, which the
      // recreated rows on the receipt will explain document by document.
    }

    const q = `mimeType = '${FOLDER_MIME}' and name = '${this.folderName}' and trashed = false`;
    const found = await this.request(
      `${this.apiBase}/drive/v3/files?q=${encodeURIComponent(q)}`
      + '&spaces=drive&fields=files(id,name,createdTime)&pageSize=100',
      () => ({ method: 'GET' }),
    );
    if (found.status === 200) {
      const list = (found.payload as { files?: unknown } | null)?.files;
      // Sorted, so two folders with the same name cannot make the choice depend
      // on the order Google happened to answer in.
      const ids = Array.isArray(list)
        ? list.map((f) => (f as { id?: unknown }).id).filter((id): id is string => typeof id === 'string').sort()
        : [];
      if (ids[0]) return { id: ids[0], existing: true };
    } else if (found.status !== 404) {
      throw new Error('I could not look in your Google Drive to find where your documents go.');
    }

    const made = await this.request(
      `${this.apiBase}/drive/v3/files?fields=id`,
      () => ({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: this.folderName, mimeType: FOLDER_MIME }),
      }),
    );
    const id = (made.payload as { id?: unknown } | null)?.id;
    if (made.status >= 400 || typeof id !== 'string' || !id) {
      throw new Error(`I could not make a folder called ${this.folderName} in your Google Drive.`);
    }
    return { id, existing: false };
  }

  /** Recover a fixed document identity when only Virgil's local id map was lost. */
  private async documentInFolder(doc: NotebookDoc, folderId: string): Promise<string | null> {
    const q = `mimeType = '${DOC_MIME}' and name = '${doc.title}'`
      + ` and '${folderId}' in parents and trashed = false`;
    const found = await this.request(
      `${this.apiBase}/drive/v3/files?q=${encodeURIComponent(q)}`
      + '&spaces=drive&fields=files(id,name)&pageSize=10',
      () => ({ method: 'GET' }),
    );
    if (found.status !== 200) {
      throw new Error(`I could not look for ${doc.title} in your Google Drive.`);
    }
    const list = (found.payload as { files?: unknown } | null)?.files;
    const files = Array.isArray(list)
      ? list.flatMap((file) => {
        const row = file as { id?: unknown; createdTime?: unknown };
        return typeof row.id === 'string' && row.id
          ? [{ id: row.id, createdTime: typeof row.createdTime === 'string' ? row.createdTime : '' }]
          : [];
      }).sort((a, b) => a.createdTime.localeCompare(b.createdTime) || a.id.localeCompare(b.id))
      : [];
    return files[0]?.id ?? null;
  }

  /**
   * One document: rewritten in place where there is an id, created where there
   * is not, and created again where the id no longer answers.
   *
   * §10.3's third case is the interesting one. A 404 on update means the learner
   * deleted this document out of their Drive. Virgil cannot leave it missing —
   * the set is fixed and a missing document is a silent gap in what the notebook
   * can answer — so it makes a replacement, and marks the row `recreated` so the
   * receipt can tell them the old source is dead and this one has to be added.
   *
   * There is no rename call here. The titles are constants in `core/` and the
   * document set is a frozen contract (§3), so a rename has no caller today, and
   * §10.2's argument applies to it exactly: a path with no consumer is a path
   * with no way to be wrong yet.
   */
  private async writeOne(
    doc: NotebookDoc, folderId: string, fileId: string | null,
  ): Promise<{ readonly receipt: DocReceipt; readonly fileId: string | null }> {
    const bytes = Buffer.byteLength(doc.body, 'utf8');
    const html = notebookDocHtml(doc);
    const row = (over: Partial<DocReceipt>): DocReceipt => ({
      key: doc.key, title: doc.title, written: false, at: null, bytes, error: null, ...over,
    });

    try {
      if (fileId) {
        const updated = await this.request(
          `${this.apiBase}/upload/drive/v3/files/${encodeURIComponent(fileId)}`
          + '?uploadType=media&fields=id',
          () => ({ method: 'PATCH', headers: { 'content-type': HTML_MIME }, body: html }),
        );
        if (updated.status < 400) {
          return { receipt: row({ written: true, at: fileId }), fileId };
        }
        if (updated.status !== 404) {
          return {
            receipt: row({ error: plainly(updated.status, reasonOf(updated.payload)) }),
            fileId,
          };
        }
        // 404: the learner deleted it. Fall through to a fresh create.
      }

      const created = await this.create(doc, folderId, html);
      if (!created.id) {
        return {
          receipt: row({ error: plainly(created.status, reasonOf(created.payload)) }),
          fileId,
        };
      }
      return {
        receipt: row({
          written: true,
          at: created.id,
          ...(fileId ? { recreated: true } : {}),
        }),
        fileId: created.id,
      };
    } catch (error) {
      // Consent is a fact about the whole write, not about this document, and
      // the port says a fact of that shape rejects rather than repeating itself
      // once per row.
      if (error instanceof DriveAccessLost) throw error;
      return { receipt: row({ error: 'I could not reach Google Drive.' }), fileId };
    }
  }

  /** `files.create`, metadata and converting media in one multipart request. */
  private async create(
    doc: NotebookDoc, folderId: string, html: string,
  ): Promise<{ readonly id: string | null; readonly status: number; readonly payload: unknown }> {
    const answer = await this.request(
      `${this.apiBase}/upload/drive/v3/files?uploadType=multipart&fields=id`,
      () => {
        const part = multipart(
          { name: doc.title, parents: [folderId], mimeType: DOC_MIME },
          html,
        );
        return { method: 'POST', headers: { 'content-type': part.type }, body: part.body };
      },
    );
    const id = (answer.payload as { id?: unknown } | null)?.id;
    return {
      id: answer.status < 400 && typeof id === 'string' && id ? id : null,
      status: answer.status,
      payload: answer.payload,
    };
  }

  /**
   * One request, with the token attached, and exactly one retry on a 401.
   *
   * The init is built by a function rather than passed in, because the retry
   * sends the body again and a body built once is a body already consumed.
   *
   * **A second 401 is consent that no longer exists**, not a token that needed
   * refreshing, and it is raised as the whole-target failure it is. A refresh
   * that itself fails is the same fact arriving one step earlier: Google
   * answering `invalid_grant` to a refresh token is Google saying the grant is
   * gone.
   */
  private async request(url: string, init: () => RequestInit): Promise<Answer> {
    let token: string;
    try {
      token = await this.auth.accessToken();
    } catch (error) {
      throw new DriveAccessLost(accessMessage(error));
    }

    let answer = await this.send(url, init(), token);
    if (answer.status !== 401) return answer;

    try {
      token = await this.auth.accessToken({ refresh: true });
    } catch (error) {
      throw new DriveAccessLost(accessMessage(error));
    }
    answer = await this.send(url, init(), token);
    if (answer.status === 401) {
      throw new DriveAccessLost(
        'Google is not letting me into your Drive any more. '
        + 'That usually means Virgil\'s access was removed in your Google account.',
      );
    }
    return answer;
  }

  private async send(url: string, init: RequestInit, token: string): Promise<Answer> {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      let payload: unknown = null;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
      return { status: res.status, payload };
    } catch {
      // A transport failure is a status this code can reason about rather than
      // an exception every caller has to remember to catch. Nothing about the
      // thrown value is kept: a fetch failure's message is a hostname and a
      // system errno, and neither belongs in front of a learner.
      return { status: 0, payload: null };
    }
  }
}

/** What a credential layer refused, said plainly and without its stack. A
 *  message written by `runner/`'s own credential code is already a sentence;
 *  anything else is replaced rather than shown. */
function accessMessage(error: unknown): string {
  const said = error instanceof Error ? error.message : '';
  return said && said.length <= 200 && !said.includes('\n')
    ? said
    : 'I could not get permission to write to your Google Drive.';
}

const sameFiles = (
  a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>,
): boolean => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};
