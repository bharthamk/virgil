import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

import type { DriveFileIds } from '@sb/adapters';
import { SECRET_DIR } from './model-credentials.js';
import { SHIPPED_DRIVE_CLIENT } from './drive-shipped-client.js';

/**
 * The Drive credential and the file-id map, beside the board and never in it.
 *
 * `NOTEBOOK_SEAM_V2.md` §4.1 and §10.3. This follows `model-credentials.ts`
 * point for point, and that is a deliberate reuse rather than a new invention:
 * the Gemini key already had to solve exactly this problem, the answer was
 * reviewed, and a second credential store written from scratch is a second set
 * of permission bugs.
 *
 *  - **Outside the board.** The board is the learner's data and may be shared,
 *    synced or handed to somebody helping them. Credentials live in a sibling
 *    `.virgil-secrets/` directory, created `0700` — the same directory the
 *    Gemini key uses, because two private directories is two sets of
 *    permissions to get right.
 *  - **`0600`, written atomically.** A fresh temp file with `flag: 'wx'`,
 *    `chmod`, then `rename`, so an interrupted save cannot leave half a
 *    credential behind.
 *  - **A symlink is refused rather than followed** on read.
 *  - **Never returned, never logged, never in a receipt.** §4.1's law: the only
 *    things the product will ever say about a Drive token are whether one
 *    exists and when it was granted.
 *
 * ## Three files, and why the id map is one of them
 *
 * `google-drive-client` is the OAuth client (§4.3). `google-drive-token` is the
 * refresh token. `google-drive-files` is the map from document key to Drive file
 * id plus the folder id, and it is not a secret at all. It lives here anyway,
 * for §10.3's reason: it is meaningless without the credential, and losing them
 * together is a clean re-setup while losing them separately leaves Virgil
 * holding ids for files it can no longer prove it created.
 */

const CLIENT_FILE = 'google-drive-client';
const TOKEN_FILE = 'google-drive-token';
const IDS_FILE = 'google-drive-files';

/**
 * §4.3 route (b) — the shipped Google sign in.
 *
 * Re-exported rather than declared here, because the fill point wants to be one
 * obvious file with the whole argument on it: see `drive-shipped-client.ts` for
 * why shipping a Desktop-app client id and secret is legitimate rather than a
 * leaked credential, and for what filling it costs and buys.
 */
export { SHIPPED_DRIVE_CLIENT } from './drive-shipped-client.js';

export interface DriveClientCredential {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** What a surface may be told about the token, and the whole of it. */
export interface DriveConnectionState {
  readonly connected: boolean;
  /** When consent was granted, from the injected clock. Never the token. */
  readonly connectedAt: string | null;
  readonly scope: string | null;
}

export interface DriveCredentialOptions {
  readonly dbPath: string;
  /** The service sets this; a read-only reader opens the same files without it. */
  readonly editable?: boolean;
  /** An operator who put the client in the environment owns it, and no browser
   *  may edit it. The same rule `managedKey` follows for the Gemini key. */
  readonly managedClient?: DriveClientCredential | null;
  /** §4.3 route (b), overridable so a test can prove both halves of the
   *  precedence without editing the shipped file. */
  readonly shippedClient?: DriveClientCredential;
}

const absent = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT');

/** A single-line value with nothing in it a header, a URL or a log line would
 *  reinterpret. The floor is deliberately low: Google's client ids and secrets
 *  have changed shape before and a format check that guesses would refuse a
 *  valid credential somebody just pasted correctly. */
function cleanPart(value: unknown, what: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 512 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`the Google Drive ${what} must be a non-empty single-line value`);
  }
  return text;
}

const readJson = async (path: string): Promise<Record<string, unknown> | null> => {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error('a Google Drive credential path is not a regular file');
  }
  await chmod(path, 0o600);
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
};

export class LocalDriveCredential {
  readonly editable: boolean;
  readonly managed: boolean;
  readonly directory: string;
  readonly clientPath: string;
  readonly tokenPath: string;
  readonly idsPath: string;

  private savedClient: DriveClientCredential | null = null;
  private readonly managedClient: DriveClientCredential | null;
  private readonly shippedClient: DriveClientCredential;
  private token = '';
  private tokenAt: string | null = null;
  private tokenScope: string | null = null;

  private constructor(opts: DriveCredentialOptions) {
    const managed = opts.managedClient?.clientId.trim() ? opts.managedClient : null;
    this.managedClient = managed;
    this.managed = managed !== null;
    this.editable = !this.managed && (opts.editable ?? false);
    this.shippedClient = opts.shippedClient ?? SHIPPED_DRIVE_CLIENT;
    this.directory = join(dirname(resolve(opts.dbPath)), SECRET_DIR);
    this.clientPath = join(this.directory, CLIENT_FILE);
    this.tokenPath = join(this.directory, TOKEN_FILE);
    this.idsPath = join(this.directory, IDS_FILE);
  }

  static async open(opts: DriveCredentialOptions): Promise<LocalDriveCredential> {
    const out = new LocalDriveCredential(opts);
    if (out.editable) await out.ensureDirectory();
    try {
      const saved = await readJson(out.clientPath);
      if (saved) {
        out.savedClient = {
          clientId: cleanPart(saved.clientId, 'client id'),
          clientSecret: cleanPart(saved.clientSecret, 'client secret'),
        };
      }
    } catch (error) { if (!absent(error)) throw error; }
    try {
      const saved = await readJson(out.tokenPath);
      if (saved) {
        out.token = cleanPart(saved.refreshToken, 'refresh token');
        out.tokenAt = typeof saved.connectedAt === 'string' ? saved.connectedAt : null;
        out.tokenScope = typeof saved.scope === 'string' ? saved.scope : null;
      }
    } catch (error) { if (!absent(error)) throw error; }
    return out;
  }

  // ------------------------------------------------------------- the client

  /**
   * WHICH GOOGLE SIGN IN THE FLOW USES. **Environment, then stored, then
   * shipped**, and each step of that order is a decision rather than an
   * accident.
   *
   * **Environment first** (`SB_DRIVE_CLIENT_ID`/`SB_DRIVE_CLIENT_SECRET`).
   * Somebody who put a client in this install's environment owns this install,
   * and it is the only source that also locks the browser out: a managed client
   * is not editable, exactly as `GEMINI_API_KEY` is not.
   *
   * **Then what the learner pasted** (§4.3 route (a)). This has to beat the
   * shipped one or route (a) stops being first-class: a self-hoster who went to
   * the trouble of making their own Google Cloud project, precisely so that the
   * consent screen names *their* project, would otherwise keep silently using
   * Virgil's. The whole point of route (a) is whose name is on the screen, and a
   * precedence that ignored it would take that away without saying so.
   *
   * **Then the shipped one** (§4.3 route (b)), which is the floor that makes the
   * one-button experience real. Empty is a legitimate state and not a fault: it
   * means this build carries no sign in of its own, the Settings block says so
   * plainly, and route (a) is still there behind a quiet disclosure.
   *
   * Null when there is none of the three, which is the honest answer and is what
   * turns Connect Drive off rather than into a button that fails at Google.
   */
  client(): DriveClientCredential | null {
    if (this.managedClient) return this.managedClient;
    if (this.savedClient) return this.savedClient;
    return this.shippedClient.clientId ? this.shippedClient : null;
  }

  clientConfigured(): boolean { return this.client() !== null; }

  /** Which route the client came from, for copy that has to be honest about it
   *  rather than for anything the code branches on. */
  clientSource(): 'operator' | 'saved' | 'shipped' | 'none' {
    if (this.managedClient) return 'operator';
    if (this.savedClient) return 'saved';
    return this.shippedClient.clientId ? 'shipped' : 'none';
  }

  async setClient(clientId: unknown, clientSecret: unknown): Promise<void> {
    if (!this.editable) throw new Error('the Google Drive client is managed by the service operator');
    const next: DriveClientCredential = {
      clientId: cleanPart(clientId, 'client id'),
      clientSecret: cleanPart(clientSecret, 'client secret'),
    };
    await this.writePrivate(this.clientPath, JSON.stringify(next));
    this.savedClient = next;
  }

  /** Clearing the client disconnects too. A refresh token issued to a client id
   *  Virgil no longer holds cannot be refreshed, so keeping it would leave a
   *  stored secret whose only remaining property is that it is a stored secret. */
  async clearClient(): Promise<void> {
    if (!this.editable) throw new Error('the Google Drive client is managed by the service operator');
    await this.remove(this.clientPath);
    this.savedClient = null;
    await this.disconnect();
  }

  // -------------------------------------------------------------- the token

  connected(): boolean { return this.token.length > 0; }

  /** Read by the token exchange and by nothing else. It is never returned by an
   *  endpoint, never logged, and never part of a receipt (§4.1). */
  refreshToken(): string { return this.token; }

  connection(): DriveConnectionState {
    return {
      connected: this.connected(),
      connectedAt: this.connected() ? this.tokenAt : null,
      scope: this.connected() ? this.tokenScope : null,
    };
  }

  async setToken(refreshToken: string, scope: string, at: string): Promise<void> {
    const clean = cleanPart(refreshToken, 'refresh token');
    await this.writePrivate(this.tokenPath, JSON.stringify({
      refreshToken: clean, scope, connectedAt: at,
    }));
    this.token = clean;
    this.tokenScope = scope;
    this.tokenAt = at;
  }

  /**
   * Forget the grant. **Nothing in Drive is touched.**
   *
   * §13: the notebook outliving the consent is recorded behaviour, not a bug to
   * clean up after. The five documents stay where they are, in the learner's own
   * Drive, because they are the learner's; Virgil simply stops writing to them.
   * Deleting them would be Virgil removing sources from a notebook it cannot see
   * on the way out of a door it was asked to close.
   *
   * The id map survives too, on purpose: reconnecting the same account then
   * resumes the same five documents rather than creating a duplicate set beside
   * them, and a duplicate set is a visible harm in somebody's Drive. A different
   * account simply 404s on the stale ids and gets fresh documents, which
   * `writeOne` already handles and reports.
   */
  async disconnect(): Promise<void> {
    await this.remove(this.tokenPath);
    this.token = '';
    this.tokenAt = null;
    this.tokenScope = null;
  }

  // ------------------------------------------------------------- the id map

  async readIds(): Promise<DriveFileIds> {
    try {
      const saved = await readJson(this.idsPath);
      const folderId = typeof saved?.folderId === 'string' && saved.folderId ? saved.folderId : null;
      const raw = saved?.files;
      const files: Record<string, string> = {};
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof value === 'string' && value) files[key] = value;
        }
      }
      return { folderId, files };
    } catch (error) {
      if (!absent(error)) throw error;
      return { folderId: null, files: {} };
    }
  }

  async writeIds(ids: DriveFileIds): Promise<void> {
    await this.writePrivate(this.idsPath, JSON.stringify(ids));
  }

  // ------------------------------------------------------------- the plumbing

  /** A fresh `wx` temp file, chmod, rename. An interrupted save leaves the
   *  previous file whole rather than half of the new one. */
  private async writePrivate(path: string, contents: string): Promise<void> {
    await this.ensureDirectory();
    const temp = join(this.directory, `.drive-${process.pid}-${randomUUID()}`);
    try {
      await writeFile(temp, `${contents}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await chmod(temp, 0o600);
      await rename(temp, path);
      await chmod(path, 0o600);
    } catch (error) {
      try { await unlink(temp); } catch { /* absent or already renamed */ }
      throw error;
    }
  }

  private async remove(path: string): Promise<void> {
    try { await unlink(path); } catch (error) { if (!absent(error)) throw error; }
  }

  private async ensureDirectory(): Promise<void> {
    try {
      const info = await lstat(this.directory);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error('Virgil secret path is not a private directory');
      }
    } catch (error) {
      if (!absent(error)) throw error;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
    }
    await chmod(this.directory, 0o700);
  }
}
