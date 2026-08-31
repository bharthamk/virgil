import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A Drive REST API, in this process, over an ephemeral loopback port.
 *
 * The adapter it exercises makes plain `fetch` calls, so the honest way to test
 * it is to let it make them: a stubbed `fetch` proves the code calls a function,
 * where this proves it builds a request Drive would accept and reads an answer
 * Drive would give. Multipart bodies, `uploadType` query strings, bearer headers
 * and 401 retries are all things a stub would have agreed with regardless.
 *
 * It models the four operations §10's table names and **nothing else**, so a
 * call the design did not sanction fails here rather than being quietly served.
 * `DELETE` is recorded rather than implemented, because "the adapter never calls
 * `files.delete`" is a law and a law wants a witness.
 */

export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: readonly string[];
  content: string;
  trashed: boolean;
}

export interface FakeFailure {
  readonly status: number;
  readonly reason?: string;
  /** Fail this many times and then stop. Absent means for ever. */
  readonly times?: number;
}

export class FakeDrive {
  private server: Server | null = null;
  private nextId = 1;

  readonly files = new Map<string, FakeFile>();
  /** Every request, in order, as `METHOD path`. The audit trail a law needs. */
  readonly calls: string[] = [];
  readonly deletes: string[] = [];

  /** Tokens this Drive accepts. Anything else is a 401. */
  accepted = new Set<string>(['access-1']);
  /** Or a shape of token, for a test whose tokens come from a fake Google that
   *  mints a new one each time rather than from a list written here. */
  acceptTokensMatching: RegExp | null = null;
  /** Keyed by document title, so a test can refuse one document by name. */
  readonly failures = new Map<string, FakeFailure>();
  /** Refuse every write, whatever the token: consent that no longer exists. */
  alwaysUnauthorised = false;
  /** Refuse to list or create the folder, which is the whole-target failure. */
  folderStatus = 200;

  url = '';

  async start(): Promise<string> {
    const server = createServer((req, res) => { void this.handle(req, res); });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
  }

  /** The five documents as they stand, keyed by title, for an assertion about
   *  what the learner would actually see in their Drive. */
  contents(): Record<string, string> {
    return Object.fromEntries([...this.files.values()]
      .filter((f) => f.mimeType !== FOLDER_MIME)
      .map((f) => [f.name, f.content]));
  }

  folder(): FakeFile | null {
    return [...this.files.values()].find((f) => f.mimeType === FOLDER_MIME) ?? null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    this.calls.push(`${req.method} ${url.pathname}`);

    if (req.method === 'DELETE') {
      // Recorded and refused. The adapter has no delete path at all, and this
      // is where that stops being a claim in a comment.
      this.deletes.push(url.pathname);
      return send(res, 405, { error: { errors: [{ reason: 'notImplemented' }] } });
    }

    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    const token = bearer?.[1] ?? '';
    const known = this.accepted.has(token)
      || (this.acceptTokensMatching?.test(token) ?? false);
    if (this.alwaysUnauthorised || !token || !known) {
      return send(res, 401, { error: { errors: [{ reason: 'authError' }] } });
    }

    if (url.pathname.startsWith('/upload/drive/v3/files')) {
      return this.upload(req, res, url);
    }
    if (url.pathname.startsWith('/drive/v3/files')) {
      return this.metadata(req, res, url);
    }
    return send(res, 404, { error: { errors: [{ reason: 'notFound' }] } });
  }

  private async metadata(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const idPath = /^\/drive\/v3\/files\/(.+)$/.exec(url.pathname);

    if (req.method === 'GET' && idPath) {
      const file = this.files.get(decodeURIComponent(idPath[1]!));
      if (!file) return send(res, 404, { error: { errors: [{ reason: 'notFound' }] } });
      return send(res, 200, { id: file.id, trashed: file.trashed });
    }

    if (req.method === 'GET') {
      if (this.folderStatus !== 200) {
        return send(res, this.folderStatus, { error: { errors: [{ reason: 'forbidden' }] } });
      }
      const q = url.searchParams.get('q') ?? '';
      const name = /name = '([^']*)'/.exec(q)?.[1] ?? '';
      const mimeType = /mimeType = '([^']*)'/.exec(q)?.[1] ?? '';
      const parent = /'([^']*)' in parents/.exec(q)?.[1] ?? '';
      const files = [...this.files.values()]
        .filter((f) => (!mimeType || f.mimeType === mimeType)
          && f.name === name && (!parent || f.parents.includes(parent)) && !f.trashed)
        .map((f) => ({ id: f.id, name: f.name }));
      return send(res, 200, { files });
    }

    if (req.method === 'POST') {
      if (this.folderStatus !== 200) {
        return send(res, this.folderStatus, { error: { errors: [{ reason: 'forbidden' }] } });
      }
      const body = JSON.parse(await read(req)) as { name?: string; mimeType?: string };
      const file = this.put({
        name: body.name ?? '', mimeType: body.mimeType ?? '', parents: [], content: '',
      });
      return send(res, 200, { id: file.id });
    }

    return send(res, 405, { error: { errors: [{ reason: 'notImplemented' }] } });
  }

  private async upload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const type = req.headers['content-type'] ?? '';
    const raw = await read(req);
    const idPath = /^\/upload\/drive\/v3\/files\/(.+)$/.exec(url.pathname);

    if (req.method === 'PATCH' && idPath) {
      if (url.searchParams.get('uploadType') !== 'media') {
        return send(res, 400, { error: { errors: [{ reason: 'badRequest' }] } });
      }
      if (!type.startsWith('text/html')) {
        return send(res, 400, { error: { errors: [{ reason: 'badRequest' }] } });
      }
      const file = this.files.get(decodeURIComponent(idPath[1]!));
      if (!file || file.trashed) return send(res, 404, { error: { errors: [{ reason: 'notFound' }] } });
      const refusal = this.refusal(file.name);
      if (refusal) return send(res, refusal.status, { error: { errors: [{ reason: refusal.reason ?? 'x' }] } });
      // Route B's whole point: the contents are REPLACED, and the id survives.
      file.content = raw;
      return send(res, 200, { id: file.id });
    }

    if (req.method === 'POST') {
      if (url.searchParams.get('uploadType') !== 'multipart') {
        return send(res, 400, { error: { errors: [{ reason: 'badRequest' }] } });
      }
      const boundary = /boundary=(.+)$/.exec(type)?.[1];
      if (!boundary) return send(res, 400, { error: { errors: [{ reason: 'badRequest' }] } });
      const parts = raw.split(`--${boundary}`)
        .map((p) => p.replace(/^\r\n/, '').replace(/\r\n$/, ''))
        .filter((p) => p && p !== '--');
      const metaPart = parts.find((p) => p.startsWith('Content-Type: application/json'));
      const mediaPart = parts.find((p) => p.startsWith('Content-Type: text/html'));
      if (!metaPart || !mediaPart) return send(res, 400, { error: { errors: [{ reason: 'badRequest' }] } });
      const meta = JSON.parse(metaPart.split('\r\n\r\n').slice(1).join('\r\n\r\n')) as {
        name?: string; parents?: string[]; mimeType?: string;
      };
      const refusal = this.refusal(meta.name ?? '');
      if (refusal) return send(res, refusal.status, { error: { errors: [{ reason: refusal.reason ?? 'x' }] } });
      const file = this.put({
        name: meta.name ?? '',
        mimeType: meta.mimeType ?? '',
        parents: meta.parents ?? [],
        content: mediaPart.split('\r\n\r\n').slice(1).join('\r\n\r\n'),
      });
      return send(res, 200, { id: file.id });
    }

    return send(res, 405, { error: { errors: [{ reason: 'notImplemented' }] } });
  }

  private refusal(name: string): FakeFailure | null {
    const found = this.failures.get(name);
    if (!found) return null;
    if (typeof found.times === 'number') {
      if (found.times <= 0) return null;
      this.failures.set(name, { ...found, times: found.times - 1 });
    }
    return found;
  }

  private put(file: Omit<FakeFile, 'id' | 'trashed'>): FakeFile {
    const id = `file-${this.nextId++}`;
    const made: FakeFile = { ...file, id, trashed: false };
    this.files.set(id, made);
    return made;
  }
}

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const DOC_MIME = 'application/vnd.google-apps.document';

const send = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const read = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};
