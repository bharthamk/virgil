import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

/**
 * The private directory beside the board that every service-owned secret lives
 * in. Exported so the Drive credential store cannot drift to a second one:
 * two secret directories is two sets of permissions to get right.
 */
export const SECRET_DIR = '.virgil-secrets';
const CLOUD_KEY_FILE = 'gemini-api-key';

export interface CloudCredentialControl {
  readonly editable: boolean;
  readonly managed: boolean;
  configured(): boolean;
  value(): string;
  set(value: string): Promise<void>;
  clear(): Promise<void>;
}

export interface CloudCredentialOptions {
  readonly dbPath: string;
  /** An environment/deployment key is authoritative and never browser-editable. */
  readonly managedKey?: string;
  /** The service sets this; batch readers open the same file read-only. */
  readonly editable?: boolean;
  /** Read a previously saved local key even when this process cannot edit it. */
  readonly readStored?: boolean;
}

const absent = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT');

const cleanKey = (value: string): string => {
  const key = value.trim();
  if (!key || key.length > 4096 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new Error('Google Gemini API key must be a non-empty single-line value');
  }
  return key;
};

/**
 * Service-owned credential state beside the local board, never inside it.
 *
 * The directory is private even when the board directory is shared, and writes
 * replace a fresh 0600 file atomically so an interrupted save cannot leave half
 * a credential behind. A symlink is refused on read rather than followed.
 */
export class LocalCloudCredential implements CloudCredentialControl {
  readonly managed: boolean;
  readonly editable: boolean;
  readonly directory: string;
  readonly path: string;
  private current = '';

  private constructor(opts: CloudCredentialOptions) {
    this.managed = Boolean(opts.managedKey?.trim());
    this.editable = !this.managed && (opts.editable ?? false);
    this.directory = join(dirname(resolve(opts.dbPath)), SECRET_DIR);
    this.path = join(this.directory, CLOUD_KEY_FILE);
    this.current = opts.managedKey?.trim() ?? '';
  }

  static async open(opts: CloudCredentialOptions): Promise<LocalCloudCredential> {
    const out = new LocalCloudCredential(opts);
    if (out.managed) return out;
    if (!out.editable && !opts.readStored) return out;
    if (out.editable) await out.ensureDirectory();
    try {
      const info = await lstat(out.path);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('Gemini credential path is not a regular file');
      await chmod(out.path, 0o600);
      out.current = cleanKey(await readFile(out.path, 'utf8'));
    } catch (error) {
      if (!absent(error)) throw error;
    }
    return out;
  }

  configured(): boolean { return this.current.length > 0; }
  value(): string { return this.current; }

  async set(value: string): Promise<void> {
    if (!this.editable) throw new Error('Google Gemini credential is managed by the service operator');
    const key = cleanKey(value);
    await this.ensureDirectory();
    const temp = join(this.directory, `.gemini-api-key-${process.pid}-${randomUUID()}`);
    try {
      await writeFile(temp, `${key}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await chmod(temp, 0o600);
      await rename(temp, this.path);
      await chmod(this.path, 0o600);
      this.current = key;
    } catch (error) {
      try { await unlink(temp); } catch { /* absent or already renamed */ }
      throw error;
    }
  }

  async clear(): Promise<void> {
    if (!this.editable) throw new Error('Google Gemini credential is managed by the service operator');
    try { await unlink(this.path); } catch (error) { if (!absent(error)) throw error; }
    this.current = '';
  }

  private async ensureDirectory(): Promise<void> {
    try {
      const info = await lstat(this.directory);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error('Virgil model-secret path is not a private directory');
      }
    } catch (error) {
      if (!absent(error)) throw error;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
    }
    await chmod(this.directory, 0o700);
  }
}
