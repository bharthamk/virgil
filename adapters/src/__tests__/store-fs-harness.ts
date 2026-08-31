import type { StoreFs } from '../json-store.js';

/**
 * A filesystem the test schedules.
 *
 * Every question this lane exists to answer is a question about *when*: when a
 * mutation becomes visible relative to its flush, what a second handle sees in
 * the gap, and what is on disk if the process dies inside a write. Answering
 * any of them with real files and a real clock means answering them with sleeps,
 * and a sleep-timed durability test is a test that passes on a fast machine and
 * reports a phantom on a loaded one — which is exactly the shape of the report
 * this lane was handed.
 *
 * So the interleaving is not raced for, it is chosen. `hook` is awaited at every
 * point the real boundary could stall or die, and a test that parks it there has
 * frozen the store mid-flush with no timing assumption at all.
 *
 * `writeFile` deliberately lands its data in two halves with a hook between
 * them. A real `writeFile` of a store of any size is several syscalls and can
 * absolutely be interrupted between them; a stand-in that wrote atomically would
 * make the temp-file-and-rename promise untestable by construction, because the
 * only thing that promise protects against is the half-written file.
 */

export type FsPoint =
  | 'readFile'
  | 'mkdir'
  /** Before any bytes of a write land. */
  | 'writeFile'
  /** After the first half of a write has landed and before the rest does. */
  | 'writeFile:half'
  | 'rename';

export interface FsEvent {
  readonly point: FsPoint;
  readonly path: string;
}

export class MemFs implements StoreFs {
  readonly files = new Map<string, string>();
  readonly log: FsEvent[] = [];

  /**
   * Awaited at every point above, in the order the store reaches them. Throwing
   * from it fails that call the way the real boundary would; awaiting a deferred
   * inside it parks the store there for as long as the test likes.
   */
  hook: (event: FsEvent) => Promise<void> | void = () => {};

  async readFile(path: string): Promise<string> {
    await this.at('readFile', path);
    const found = this.files.get(path);
    if (found === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return found;
  }

  async mkdir(path: string): Promise<unknown> {
    await this.at('mkdir', path);
    return undefined;
  }

  async writeFile(path: string, data: string): Promise<void> {
    await this.at('writeFile', path);
    this.files.set(path, data.slice(0, Math.floor(data.length / 2)));
    await this.at('writeFile:half', path);
    this.files.set(path, data);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.at('rename', from);
    const found = this.files.get(from);
    if (found === undefined) throw Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' });
    this.files.set(to, found);
    this.files.delete(from);
  }

  /** What a reader opening the file right now would get, or null if it is not there. */
  read(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  /** Every path that is not the store file itself — leftover temp files. */
  strayPaths(storePath: string): string[] {
    return [...this.files.keys()].filter((p) => p !== storePath).sort();
  }

  private async at(point: FsPoint, path: string): Promise<void> {
    this.log.push({ point, path });
    await this.hook({ point, path });
  }
}

export interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

export function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * Park the store the first time it reaches `point`, and hand back a promise that
 * settles once it has arrived there.
 *
 * The arrival promise is the half that makes the test deterministic: without it
 * a test would have to guess how many microtask turns the store needs to get
 * into the flush, and guessing is the thing this harness exists to remove.
 */
export function parkAt(fs: MemFs, point: FsPoint, match: (p: string) => boolean = () => true): {
  arrived: Promise<void>;
  release(): void;
} {
  const arrival = deferred();
  const gate = deferred();
  let armed = true;
  const previous = fs.hook;
  fs.hook = async (event) => {
    await previous(event);
    if (!armed || event.point !== point || !match(event.path)) return;
    armed = false;
    arrival.resolve();
    await gate.promise;
  };
  return { arrived: arrival.promise, release: () => gate.resolve() };
}

/** Let every pending microtask run. Nothing here is timer-driven. */
export const settle = async (turns = 8): Promise<void> => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};
