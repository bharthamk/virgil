/**
 * The hosted page's learner-owned Google Drive bridge.
 *
 * The main Virgil login and the Drive account are deliberately independent.
 * `chrome.identity.getAuthToken` is supplied by `web-runtime.js` on the hosted
 * page, so the account picker can grant exactly `drive.file` without changing
 * the Firebase learner session. The access token lives only in this module's
 * memory. The only durable values are the account label and Google's file ids,
 * which are not credentials and are what make every later press rewrite the
 * same three native Google Docs rather than create new sources.
 */

export const HOSTED_NOTEBOOK_DRIVE_SCOPE =
  'https://www.googleapis.com/auth/drive.file';
export const HOSTED_NOTEBOOK_DRIVE_KEY = 'virgil-hosted-notebook-drive-v2';

const API = 'https://www.googleapis.com';
const DOC_MIME = 'application/vnd.google-apps.document';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDER_NAME = 'Virgil';

export interface HostedNotebookDocument {
  readonly key: string;
  readonly title: string;
  readonly html: string;
}

interface StoredDrive {
  readonly account: string;
  readonly folderId: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface HostedNotebookWrite {
  readonly account: string;
  readonly fileId: string;
  readonly created: boolean;
}

export interface HostedNotebookBatchWrite {
  readonly account: string;
  readonly folderId: string;
  readonly documents: readonly (HostedNotebookWrite & { readonly key: string })[];
}

export interface HostedNotebookScope {
  readonly learnerId: string;
  readonly serviceOrigin: string;
  readonly expectedAccount: string;
}

let accessToken = '';

function storedDrive(value: unknown): StoredDrive | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.account !== 'string' || typeof row.folderId !== 'string'
    || !row.files || typeof row.files !== 'object' || Array.isArray(row.files)) return null;
  const files = Object.fromEntries(Object.entries(row.files as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  return { account: row.account, folderId: row.folderId, files };
}

async function token(force = false): Promise<string> {
  if (!force && accessToken) return accessToken;
  const reply = await chrome.identity.getAuthToken({
    interactive: true,
    scopes: [HOSTED_NOTEBOOK_DRIVE_SCOPE],
  });
  const value = typeof reply === 'string' ? reply : reply.token ?? '';
  if (!value) throw new Error('Google Drive connection did not return an account. Nothing was sent.');
  accessToken = value;
  return value;
}

async function request(url: string, init: RequestInit = {}, retry = true): Promise<Response> {
  let credential: string;
  try { credential = await token(); } catch {
    throw new Error('Google Drive connection did not finish. Nothing was sent.');
  }
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${credential}` },
    });
  } catch {
    throw new Error('I could not reach Google Drive. Nothing was sent.');
  }
  if (response.status === 401 && retry) {
    accessToken = '';
    await token(true);
    return request(url, init, false);
  }
  return response;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json().catch(() => ({})) as Record<string, unknown>;
}

async function account(): Promise<string> {
  const response = await request(`${API}/drive/v3/about?fields=user(emailAddress)`);
  const body = await json(response);
  const email = (body.user as Record<string, unknown> | undefined)?.emailAddress;
  if (!response.ok || typeof email !== 'string' || !email) {
    throw new Error('I connected to Google Drive, but could not read which account it was. Nothing was sent.');
  }
  return email;
}

async function folder(remembered: string): Promise<string> {
  if (remembered) {
    const response = await request(
      `${API}/drive/v3/files/${encodeURIComponent(remembered)}?fields=id,trashed`,
    );
    if (response.ok && (await json(response)).trashed !== true) return remembered;
    if (response.status !== 404) throw new Error('I could not reach your Virgil folder in Google Drive.');
  }

  const q = `mimeType = '${FOLDER_MIME}' and name = '${FOLDER_NAME}' and trashed = false`;
  const listed = await request(`${API}/drive/v3/files?q=${encodeURIComponent(q)}`
    + '&spaces=drive&fields=files(id)&pageSize=10');
  if (listed.ok) {
    const files = (await json(listed)).files;
    if (Array.isArray(files)) {
      const ids = files.flatMap((file) => {
        const id = (file as Record<string, unknown>)?.id;
        return typeof id === 'string' && id ? [id] : [];
      }).sort();
      if (ids[0]) return ids[0];
    }
  } else if (listed.status !== 404) {
    throw new Error('I could not look for your Virgil folder in Google Drive.');
  }

  const made = await request(`${API}/drive/v3/files?fields=id`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
  });
  const id = (await json(made)).id;
  if (!made.ok || typeof id !== 'string' || !id) {
    throw new Error('I could not make your Virgil folder in Google Drive.');
  }
  return id;
}

function multipart(
  metadata: Record<string, unknown>, html: string,
): { readonly type: string; readonly body: string } {
  let boundary = `virgil-${crypto.randomUUID()}`;
  while (html.includes(boundary)) boundary = `virgil-${crypto.randomUUID()}`;
  return {
    type: `multipart/related; boundary=${boundary}`,
    body: `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`
      + `${JSON.stringify(metadata)}\r\n--${boundary}\r\n`
      + `Content-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${boundary}--`,
  };
}

async function create(document: HostedNotebookDocument, folderId: string): Promise<string> {
  const part = multipart({
    name: document.title, parents: [folderId], mimeType: DOC_MIME,
  }, document.html);
  const response = await request(
    `${API}/upload/drive/v3/files?uploadType=multipart&fields=id`,
    { method: 'POST', headers: { 'content-type': part.type }, body: part.body },
  );
  const id = (await json(response)).id;
  if (!response.ok || typeof id !== 'string' || !id) {
    throw new Error('I could not create your Notebook source in Google Drive. Nothing was sent.');
  }
  return id;
}

/**
 * Create each source once, thereafter rewrite those same native Google Docs.
 *
 * The account and folder are resolved once for the whole foreground gesture.
 * A newly-created id is persisted immediately, rather than at the end of the
 * batch, so a later Drive failure cannot strand a duplicate on the retry.
 */
export async function writeHostedNotebookDocuments(
  documents: readonly HostedNotebookDocument[],
  scope: HostedNotebookScope,
): Promise<HostedNotebookBatchWrite> {
  if (!documents.length) throw new Error('Virgil had no Notebook sources to write. Nothing was sent.');
  if (new Set(documents.map((document) => document.key)).size !== documents.length) {
    throw new Error('Virgil found the same Notebook source twice. Nothing was sent.');
  }
  const email = await account();
  if (email.toLowerCase() !== scope.expectedAccount.trim().toLowerCase()) {
    throw new Error(`Automatic refresh belongs to ${scope.expectedAccount}. Nothing was written to ${email}.`);
  }
  const learnerId = scope.learnerId.trim();
  let serviceOrigin = '';
  try { serviceOrigin = new URL(scope.serviceOrigin).origin; } catch { /* refused below */ }
  if (!learnerId || !serviceOrigin) throw new Error('Virgil could not bind this Drive write to your page. Nothing was sent.');
  const storageKey = `${HOSTED_NOTEBOOK_DRIVE_KEY}:${encodeURIComponent(serviceOrigin)}:${encodeURIComponent(learnerId)}`;
  const read = await chrome.storage.local.get(storageKey);
  const previous = storedDrive(read[storageKey]);
  const sameAccount = previous?.account === email ? previous : null;
  const folderId = await folder(sameAccount?.folderId ?? '');
  const files: Record<string, string> = { ...(sameAccount?.files ?? {}) };
  const written: (HostedNotebookWrite & { readonly key: string })[] = [];
  let driveWrites = 0;

  try {
    for (const document of documents) {
      const remembered = files[document.key] ?? '';
      if (remembered) {
        const updated = await request(
          `${API}/upload/drive/v3/files/${encodeURIComponent(remembered)}?uploadType=media&fields=id`,
          { method: 'PATCH', headers: { 'content-type': 'text/html; charset=UTF-8' }, body: document.html },
        );
        if (updated.ok) {
          driveWrites += 1;
          written.push({ account: email, key: document.key, fileId: remembered, created: false });
          continue;
        }
        if (updated.status !== 404) {
          throw new Error('I could not rewrite your Notebook sources in Google Drive. Nothing was recorded as sent.');
        }
      }

      const fileId = await create(document, folderId);
      driveWrites += 1;
      files[document.key] = fileId;
      await chrome.storage.local.set({
        [storageKey]: { account: email, folderId, files: { ...files } },
      });
      written.push({ account: email, key: document.key, fileId, created: true });
    }
  } catch (error) {
    if (!driveWrites) throw error;
    const writtenWord = driveWrites === 1 ? 'source was' : 'sources were';
    const remaining = Math.max(0, documents.length - driveWrites);
    const remainingLine = remaining === 1
      ? 'The remaining source was not written.'
      : `The remaining ${remaining} sources were not written.`;
    throw new Error(`Google Drive wrote ${driveWrites} of ${documents.length} Notebook sources before it stopped. `
      + `${driveWrites === 1 ? 'That' : 'Those'} ${writtenWord} already changed in Drive. ${remainingLine}`);
  }

  return { account: email, folderId, documents: written };
}

/** Backwards-compatible one-source form used by the extension seam and tests. */
export async function writeHostedNotebookDocument(
  document: HostedNotebookDocument, scope: HostedNotebookScope,
): Promise<HostedNotebookWrite> {
  const result = await writeHostedNotebookDocuments([document], scope);
  const written = result.documents[0];
  if (!written) throw new Error('Virgil had no Notebook source to write. Nothing was sent.');
  return { account: result.account, fileId: written.fileId, created: written.created };
}
