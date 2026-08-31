import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  mutateLearnerPrefs, NOTEBOOK_DOC_KEYS, notebookDoc, notebookDocHtml,
  type Clock, type Store,
} from '@sb/core';
import { readNotebookInput } from './notebook-export.js';

export interface HostedNotebookRouteContext {
  readonly store: Store;
  readonly clock: Clock;
  readonly managedAccount: string;
  /** Public destination of this deployment's already-created live notebook. */
  readonly notebookUrl?: string | null;
  readonly readBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  readonly requestTimeZone: (req: IncomingMessage) => string | undefined;
  readonly reply: (res: ServerResponse, code: number, body: unknown) => void;
  readonly badRequest: (message: string) => never;
}

const driveId = (value: unknown, label: string, badRequest: (message: string) => never): string => {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) {
    return badRequest(`${label} is not a usable Google Drive file id`);
  }
  return id;
};

export async function handleHostedNotebookRoute(
  req: IncomingMessage, res: ServerResponse, url: URL, ctx: HostedNotebookRouteContext,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/notebook/documents') {
    const input = await readNotebookInput(ctx.store, ctx.clock);
    ctx.reply(res, 200, {
      documents: NOTEBOOK_DOC_KEYS.map((key) => {
        const document = notebookDoc(key, input);
        return { key: document.key, title: document.title, html: notebookDocHtml(document) };
      }),
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/notebook/document') {
    const key = url.searchParams.get('key');
    if (!NOTEBOOK_DOC_KEYS.some((candidate) => candidate === key)) {
      ctx.badRequest('key must name one of Virgil\'s Notebook documents');
    }
    const document = notebookDoc(
      key as typeof NOTEBOOK_DOC_KEYS[number], await readNotebookInput(ctx.store, ctx.clock),
    );
    ctx.reply(res, 200, {
      document: { key: document.key, title: document.title, html: notebookDocHtml(document) },
    });
    return true;
  }

  if (url.pathname !== '/notebook/drive/hosted-setup') return false;
  const managedAccount = ctx.managedAccount.trim();
  if (!managedAccount) {
    ctx.reply(res, 404, { error: 'automatic Google Notebook refresh is not configured' });
    return true;
  }
  if (req.method === 'GET') {
    const state = (await ctx.store.getPrefs()).notebookDrive;
    ctx.reply(res, 200, {
      connected: Boolean(state?.enabled
        && state.account.toLowerCase() === managedAccount.toLowerCase()),
      expectedAccount: managedAccount,
      account: state?.account ?? null,
      connectedAt: state?.connectedAt ?? null,
      // Older connected boards predate the dedicated write timestamp. Their
      // connection receipt was written only after all three Drive documents
      // succeeded, so it is the honest first-refresh receipt until the next
      // managed rewrite records a newer time.
      lastWriteAt: state?.lastWriteAt ?? state?.connectedAt ?? null,
      folderLink: state?.folderId
        ? `https://drive.google.com/drive/folders/${encodeURIComponent(state.folderId)}` : null,
      notebookUrl: hostedNotebookUrl(ctx.notebookUrl),
      documents: state?.files ? Object.keys(state.files).sort() : [],
    });
    return true;
  }
  if (req.method === 'DELETE') {
    await mutateLearnerPrefs(ctx.store, (prefs) => ({
      ...prefs,
      notebookDrive: prefs.notebookDrive ? { ...prefs.notebookDrive, enabled: false } : null,
    }));
    ctx.reply(res, 200, { connected: false });
    return true;
  }
  if (req.method !== 'PUT') return false;

  const body = await ctx.readBody(req);
  const account = typeof body.account === 'string' ? body.account.trim() : '';
  if (!account || account.toLowerCase() !== managedAccount.toLowerCase()) {
    ctx.badRequest('the selected Drive account does not match automatic refresh');
  }
  const folderId = driveId(body.folderId, 'folderId', ctx.badRequest);
  if (!body.files || typeof body.files !== 'object' || Array.isArray(body.files)) {
    ctx.badRequest('files must name Virgil\'s three Google Drive documents');
  }
  const rawFiles = body.files as Record<string, unknown>;
  const files = Object.fromEntries(NOTEBOOK_DOC_KEYS.map((key) => [
    key, driveId(rawFiles[key], `files.${key}`, ctx.badRequest),
  ]));
  const requestedTimeZone = ctx.requestTimeZone(req);
  await mutateLearnerPrefs(ctx.store, (prefs) => ({
    ...prefs,
    ...(requestedTimeZone ?? prefs.timeZone
      ? { timeZone: requestedTimeZone ?? prefs.timeZone } : {}),
    notebookDrive: {
      enabled: true, account, folderId, files,
      connectedAt: ctx.clock.now().toISOString(), lastWriteAt: ctx.clock.now().toISOString(),
    },
  }));
  ctx.reply(res, 200, { connected: true, account, documents: NOTEBOOK_DOC_KEYS });
  return true;
}

/** A notebook id is public routing configuration, never a credential. Refuse
 * every other host/path so deployment configuration cannot become an open
 * redirect on a signed-in product surface. */
export function hostedNotebookUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const target = new URL(value.trim());
    if (target.protocol !== 'https:' || target.hostname !== 'notebook.google.com'
      || !/^\/notebook\/[^/]+\/?$/.test(target.pathname)) return null;
    target.hash = '';
    return target.toString();
  } catch {
    return null;
  }
}
