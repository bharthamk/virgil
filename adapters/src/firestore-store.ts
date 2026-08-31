import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  Store, Pin, PinId, Topic, TopicId, PrereqEdge, Signal, Statement,
  Session, SessionId, Suggestion, LearnerPrefs, AliasMap, HostedProcessingReceipt,
  HostedProcessingVersion,
  Award, Commitment, Course, CourseIntakeDraft, ExternalEntry, LearningOutcome,
  ProspectProposal, PassedOverLedger,
  LocalConnectorJob, LocalConnectorResult,
} from '@sb/core';
import {
  LOCAL_CONNECTOR_LEASE_MS, TopicOpError, absorbedInto, isAbsorbed, owedEnrichment, planMerge, planSplit,
  readPassedOverLedger, resolveOn, resolveOnNullable, resolveTopicId,
} from '@sb/core';
import { DEFAULT_PREFS } from './json-store.js';


// ------------------------------------------------------- the vendor surface

/**
 * Typed as `string` rather than inferred as a literal, exactly as `ADK_MODULE`
 * is and for the same reason: a literal makes `tsc` resolve the module at build
 * time, and the hand-transcribed surface below exists precisely so that the
 * typecheck does not depend on the package being present.
 *
 * **The import is dynamic; the dependency is declared.** Those were the same
 * fact until 2026-08-21 and they are two facts now. The import stays dynamic so
 * that a build pointed at `memory` or `json:` never loads a database driver.
 * The declaration is what puts the driver in the image at all: `npm ci` installs
 * from the lockfile, the lockfile is written from the manifests, and a package
 * reached only by `await import(<a string variable>)` appears in neither unless
 * somebody writes it down. Undeclared, a deployed Job with
 * `SB_STORE=firestore:<project>/<board>` died on module resolution rather than
 * on the `sdk-missing` path below — the friendly error is only reachable in a
 * tree where the package *could* have been installed.
 * `deploy-config.test.ts` reads these two constants and checks the manifest and
 * the lockfile against them, so the version below is the version in the image.
 */
export const FIRESTORE_MODULE: string = '@google-cloud/firestore';

/** The version this adapter was written and measured against. Pinned, never an
 *  alias — the transport contract's second correction, applied to a second vendor. */
export const FIRESTORE_PINNED_VERSION = '9.0.0';

/**
 * The slice of `@google-cloud/firestore` this adapter uses, hand-transcribed
 * from the real 9.0.0 declarations.
 *
 * A copy, and a copy can go stale — so `firestore-store.test.ts` checks every
 * name on it against the installed package when one is present, the same
 * bargain `adk-binding.ts` makes. A structural type nobody verifies is a guess.
 */
export interface FsDocumentSnapshot {
  readonly id: string;
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}
export interface FsQueryDocumentSnapshot extends FsDocumentSnapshot {
  data(): Record<string, unknown>;
}
export interface FsQuerySnapshot {
  readonly size: number;
  readonly empty: boolean;
  readonly docs: readonly FsQueryDocumentSnapshot[];
}
export interface FsQuery {
  where(field: string, op: string, value: unknown): FsQuery;
  get(): Promise<FsQuerySnapshot>;
}
export interface FsDocumentReference {
  readonly id: string;
  readonly path: string;
  get(): Promise<FsDocumentSnapshot>;
  set(data: Record<string, unknown>): Promise<unknown>;
  delete(): Promise<unknown>;
  collection(id: string): FsCollectionReference;
}
export interface FsCollectionReference extends FsQuery {
  doc(id: string): FsDocumentReference;
}
export interface FsWriteBatch {
  set(ref: FsDocumentReference, data: Record<string, unknown>): unknown;
  delete(ref: FsDocumentReference): unknown;
  commit(): Promise<unknown>;
}
export interface FsTransaction {
  get(ref: FsDocumentReference): Promise<FsDocumentSnapshot>;
  set(ref: FsDocumentReference, data: Record<string, unknown>): FsTransaction;
}
export interface FsFirestore {
  collection(id: string): FsCollectionReference;
  batch(): FsWriteBatch;
  runTransaction<T>(update: (transaction: FsTransaction) => Promise<T>): Promise<T>;
  recursiveDelete(ref: FsDocumentReference): Promise<void>;
  terminate(): Promise<void>;
}
interface FirestoreModule {
  Firestore: new (settings: Record<string, unknown>) => FsFirestore;
}

// ------------------------------------------------------------ error taxonomy

/**
 * What went wrong, in terms a caller can act on.
 *
 * The same shape as `GeminiError` and for the same reason the transport proof
 * gives: an adapter that collapses every failure into one `Error` makes the
 * caller's degradation policy (graceful-degradation constraint) guess. The three that matter to this
 * product are not network failures at all — they are *writes the backend
 * refuses*, and each one is a fact about the data rather than about the day.
 *
 *  - `too-large`     — the row exceeds a Firestore ceiling. Retrying never
 *                      helps and the pin is unsavable as it stands. This is the
 *                      only one of the three the learner can be told about
 *                      honestly ("that image is too big to sync").
 *  - `invalid-value` — the row holds something Firestore has no representation
 *                      for (an `undefined`, a nested array). A bug, not a day.
 *  - `invalid-id`    — an id Firestore will not accept as a document name.
 *                      `docId()` exists to make this unreachable; if it is ever
 *                      raised, `docId()` has a hole.
 *
 * `retryable` is the field the runner's degradation policy actually reads.
 */
export type FirestoreErrorKind =
  | 'too-large' | 'invalid-value' | 'invalid-id'
  | 'unavailable' | 'deadline-exceeded' | 'resource-exhausted'
  | 'permission-denied' | 'aborted' | 'not-found'
  | 'production-not-authorised' | 'sdk-missing' | 'unknown';

export class FirestoreStoreError extends Error {
  constructor(
    readonly kind: FirestoreErrorKind,
    message: string,
    readonly retryable: boolean = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'FirestoreStoreError';
  }
}

export interface FirestoreClientOptions {
  readonly projectId?: string;
  readonly allowProduction?: boolean;
  readonly firestore?: FsFirestore;
}

/** One guarded client factory for every Firestore-backed adapter. */
export async function openFirestoreClient(opts: FirestoreClientOptions): Promise<FsFirestore> {
  if (opts.firestore) return opts.firestore;
  if (!process.env.FIRESTORE_EMULATOR_HOST && opts.allowProduction !== true) {
    throw new FirestoreStoreError('production-not-authorised',
      'Firestore refuses to open a client with no FIRESTORE_EMULATOR_HOST set. '
      + 'Point at the local emulator, or pass allowProduction: true as an explicit production opt-in.');
  }
  let mod: FirestoreModule;
  try {
    mod = (await import(FIRESTORE_MODULE)) as unknown as FirestoreModule;
  } catch (cause) {
    throw new FirestoreStoreError('sdk-missing',
      `${FIRESTORE_MODULE}@${FIRESTORE_PINNED_VERSION} is a declared dependency of `
      + `@sb/adapters and did not resolve. The install this process was started from is `
      + `incomplete — run \`npm ci\` against the committed lockfile.`,
    false, { cause });
  }
  return new mod.Firestore({ projectId: opts.projectId ?? 'virgil-emulator' });
}

/**
 * gRPC status codes, transcribed. Only the ones this adapter maps are listed —
 * a table of sixteen where nine are unreachable is a table nobody trusts.
 */
const GRPC = {
  NOT_FOUND: 5, PERMISSION_DENIED: 7, RESOURCE_EXHAUSTED: 8,
  ABORTED: 10, UNAVAILABLE: 14, DEADLINE_EXCEEDED: 4,
} as const;

/**
 * The mapping, measured rather than guessed.
 *
 * Firestore reports every one of the three data-shaped refusals as
 * `INVALID_ARGUMENT` (code 3) with the distinguishing information **only in the
 * message**, which is exactly the situation the transport contract's third defect
 * was: a caller that reads the status alone cannot tell "this image is too big"
 * from "there is a bug in the adapter". The exact strings, from the emulator:
 *
 *   maximum entity size is 1048576 bytes
 *   The value of property "big" is longer than 1048487 bytes.
 *   Property media contains an invalid nested entity.
 *   Nested arrays are not allowed
 *   Cannot use "undefined" as a Firestore value (found in field "b").
 *   Resource id "__reserved__" is invalid because it is reserved.
 *
 * Matched on substrings because that is all there is. If a future version
 * rewords them the classification degrades to `unknown`, which is the safe
 * direction: an unknown failure is not retried and is not explained away.
 */
export function classifyFirestoreError(err: unknown): FirestoreStoreError {
  if (err instanceof FirestoreStoreError) return err;
  const message = (err as { message?: string })?.message ?? String(err);
  const code = (err as { code?: number })?.code;
  const wrap = (kind: FirestoreErrorKind, retryable = false): FirestoreStoreError =>
    new FirestoreStoreError(kind, message, retryable, { cause: err });

  if (/maximum entity size|is longer than \d+ bytes|invalid nested entity/i.test(message)) {
    return wrap('too-large');
  }
  if (/nested arrays are not allowed|cannot use "undefined"/i.test(message)) {
    return wrap('invalid-value');
  }
  if (/is invalid because it is reserved|contains a resource id|must point to a document/i.test(message)) {
    return wrap('invalid-id');
  }
  switch (code) {
    case GRPC.UNAVAILABLE: return wrap('unavailable', true);
    case GRPC.DEADLINE_EXCEEDED: return wrap('deadline-exceeded', true);
    case GRPC.ABORTED: return wrap('aborted', true);
    case GRPC.RESOURCE_EXHAUSTED: return wrap('resource-exhausted', true);
    case GRPC.PERMISSION_DENIED: return wrap('permission-denied');
    case GRPC.NOT_FOUND: return wrap('not-found');
    default: return wrap('unknown');
  }
}

// --------------------------------------------------------------- id encoding

/**
 * A domain id, made safe to use as a Firestore document name.
 *
 * Four ids that are perfectly ordinary in this product are hard `400`s as
 * document names, measured: anything containing `/`, the names `.` and `..`,
 * anything matching `__*__`, and anything over 1,500 bytes. Pin and topic ids
 * are `randomUUID()` today and none of these can arise — but pin ids arrive
 * from an extension, and "cannot arise today" is how the `p1` in a test becomes
 * the `a/b` in a bug report. The encoding costs one function.
 *
 * **Deliberately one-way.** Nothing decodes it, because nothing needs to: every
 * document carries its true `id` as a field and every read takes the id from
 * there, never from the document name. That is what makes this safe to change
 * later — the document name is an address, not data.
 *
 * Injective, which is the only property that matters: `%` is escaped first, so
 * no encoded id can begin with a bare `%`, so the escape prefix cannot collide
 * with a legitimate value.
 */
export function docId(id: string): string {
  const escaped = id.replace(/%/g, '%25').replace(/\//g, '%2F');
  // Over the 1,500-byte name ceiling, address by digest. Lossy as a name and
  // exact as data — the `id` field is still the real one.
  if (Buffer.byteLength(escaped, 'utf8') > 1_000) {
    return `%h${createHash('sha256').update(id, 'utf8').digest('hex')}`;
  }
  if (escaped === '' || escaped === '.' || escaped === '..' || /^__.*__$/.test(escaped)) {
    return `%${escaped}`;
  }
  return escaped;
}

/**
 * The night a session belongs to — the batch-idempotency contract’s key, as one field.
 *
 * The UTC date of `builtAt`, because the nightly Job runs on a UTC schedule and
 * every stage of one run reads one clock. A retried Job produces the same key
 * and therefore the same document path, which is the whole of the idempotence:
 * no uniqueness index, no read-before-write, no transaction. A `set()` on a
 * path that already has a row replaces it, and the retry is the later write.
 *
 * Falls back to the whole string if `builtAt` is not the ISO instant the type
 * says it is. A session with an unparseable timestamp is a bug somewhere else,
 * and refusing to store it would turn that bug into lost work.
 */
export function batchKeyOf(builtAt: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T/.exec(builtAt);
  return m?.[1] ?? builtAt;
}

/**
 * The night a session is stored under — the batch-key alignment contract, and the only caller of
 * `batchKeyOf` that matters.
 *
 * `batchKeyOf(builtAt)` was the whole answer, and the sentence above it — *"a
 * retried Job produces the same key and therefore the same document path"* —
 * is true exactly while the retry's clock is on the same UTC date as the
 * original's. A task that dies before composing and whose retry finishes after
 * midnight breaks it: the retry writes the right session under the *next*
 * night's name, which then makes the next night look built and consumes it.
 *
 * So the row says which night it is for and this reads what it says. `builtAt`
 * is the fallback and only ever answers for a row written before the field
 * existed — not a second opinion for a row that carries it, because a "correct
 * the key against the clock" branch is the defect wearing a repair's clothes.
 */
export function sessionBatchKey(session: Session): string {
  // `batchKey` was called `nightKey` until the manual-processing contract renamed the whole idea.
  // The field is optional and was never written into the committed board, but a
  // board a running install wrote under the old name still exists, and reading
  // it wrong would file one of their sessions under a second key and make the
  // day look twice-built. Read both; only ever write the new one.
  const legacy = (session as { nightKey?: unknown }).nightKey;
  return session.batchKey
    ?? (typeof legacy === 'string' && legacy ? legacy : undefined)
    ?? batchKeyOf(session.builtAt);
}

// ----------------------------------------------------------------- plumbing

/**
 * Anything `undefined`, removed.
 *
 * `JSON.stringify` drops an `undefined` property silently; Firestore raises
 * `Cannot use "undefined" as a Firestore value` and refuses the whole write
 * (measured). `exactOptionalPropertyTypes` makes that unreachable from typed
 * callers, so this is defence against data that arrived as JSON — and it is
 * deliberately a *drop* rather than a coercion to `null`, because the domain
 * types say `undefined` and `null` mean the same thing on every optional field
 * they have (`contested`, `mediumWarning`, `revision`, `withheld`,
 * `mediaOmitted`, `videoMoment`, `pdfPage`) and inventing a `null` would put a
 * value where the honest answer is silence.
 */
function prune<T>(value: T): T {
  if (Array.isArray(value)) return value.map(prune) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = prune(v);
    }
    return out as unknown as T;
  }
  return value;
}

/** A domain value, pruned and widened into the shape a write takes. The domain
 *  types are `readonly` and closed; `DocumentData` is an open bag of unknowns.
 *  One cast, in one place, rather than at every call site. */
const asDoc = <T>(value: T): Record<string, unknown> =>
  prune(value) as unknown as Record<string, unknown>;

interface RootDoc {
  readonly prefs: Partial<LearnerPrefs>;
  readonly aliases: Record<TopicId, TopicId>;
}

/**
 * How many operations this store puts in one batch.
 *
 * A number chosen rather than a limit obeyed, because the limit turned out not
 * to be the one everybody quotes. The 500-operation ceiling is legacy
 * client-SDK lore; the current documentation gives a **10 MiB request size**
 * and no operation count, and says only *"A batched write with hundreds of
 * documents might require many index updates and might exceed the limit on
 * transaction size. In this case, reduce the number of documents per batch."*
 * (cloud.google.com/firestore/native/docs/manage-data/transactions, read
 * 2026-08-21).
 *
 * So 450 is a size bound in disguise: the rows this store batches are signals,
 * topic memberships and session provenance, none of which is near the per-field
 * ceiling, and 450 of them is comfortably inside 10 MiB. It is deliberately
 * conservative, because the emulator will not tell us when we are wrong — it
 * accepted 600 writes in one batch and its own documentation says *"the
 * emulator does not enforce all limits enforced in production"*. An emulator
 * more permissive than production is the one direction a local proof cannot
 * catch, so the code does not learn its limits from it.
 */
const BATCH_LIMIT = 450;

/**
 * A batch that flushes itself rather than failing at the ceiling.
 *
 * Every cascade on this store is unbounded in principle — `deletePin` touches
 * one document per signal traceable to the pin, `deleteTopic` one per row of a
 * topic's whole history — and a board with a year of nightly runs behind it has
 * thousands of signals. A single `WriteBatch` would have worked on every board
 * this project has ever built and failed on the first real one, which is §3a's
 * third class exactly: *the problem with an uncapped write is never the first
 * day.*
 *
 * **Chunking is not atomicity, and this does not pretend otherwise.** A cascade
 * that spans two chunks can be interrupted between them. That is the same
 * promise the local store makes — `store-serialisation`'s fifth law says a
 * cascade that awaits per step *"is not one atomic mutation, and does not
 * pretend to be"* — so the port matches it rather than quietly upgrading one
 * backend's guarantees. Firestore has transactions and could do better; doing
 * better on one implementation only would be an unstated divergence, and this
 * file's job is to have none of those.
 */
class Batcher {
  private batch: FsWriteBatch;
  private n = 0;
  private flushes: Promise<unknown>[] = [];
  constructor(private readonly db: FsFirestore) { this.batch = db.batch(); }

  set(ref: FsDocumentReference, data: Record<string, unknown>): void {
    this.batch.set(ref, data);
    this.roll();
  }

  delete(ref: FsDocumentReference): void {
    this.batch.delete(ref);
    this.roll();
  }

  private roll(): void {
    if (++this.n < BATCH_LIMIT) return;
    this.flushes.push(this.batch.commit());
    this.batch = this.db.batch();
    this.n = 0;
  }

  async commit(): Promise<void> {
    if (this.n > 0) this.flushes.push(this.batch.commit());
    await Promise.all(this.flushes);
    this.flushes = [];
    this.n = 0;
    this.batch = this.db.batch();
  }
}

export interface FirestoreStoreOptions {
  /** One learner's board. The direct analogue of `JsonStore`'s file path. */
  readonly boardId: string;
  readonly projectId?: string;
  readonly allowProduction?: boolean;
  /** An already-constructed client, for a caller that holds one. */
  readonly firestore?: FsFirestore;
}

export class FirestoreStore implements Store {
  /**
   * Single-flight client construction — the single-flight storage constraint shape, avoided on purpose.
   *
   * The promise is memoised, not the result. A `loaded` flag set after an await
   * is the bug that made sixty concurrent writes to a cold `JsonStore` persist
   * one, and `store-contract.ts` promoted it to a contract assertion precisely
   * so that the next lazily-initialising store could not reintroduce it. This
   * is the next lazily-initialising store.
   */
  private connecting: Promise<FsFirestore> | null = null;

  /**
   * Serialises this handle's writes, so that two writes to one row land in call
   * order.
   *
   * The measurement this exists for is in the class comment. What matters about
   * the shape: the caller awaits `slot` and hears about its own failure, while
   * the queue chains on a *handled* copy — a rejected queue would take every
   * later write with it, and a swallowed rejection would tell a learner their
   * pin is saved when it is not. Lifted from `JsonStore.save`, where the same
   * two failure modes had to be separated for the same reason.
   */
  private writing: Promise<unknown> = Promise.resolve();

  /**
   * The ledger's order, materialised.
   *
   * Firestore has no insertion order, so `appendSignal` stamps one. Seeded from
   * the highest `seq` already on the board and then advanced as
   * `max(last + 1, Date.now())` — strictly increasing within a handle, and
   * ordered by wall clock across handles, which is the honest answer for two
   * processes that genuinely cannot see each other's counters. Ties are broken
   * by document name so that two rows stamped in the same millisecond still
   * read back in a stable order rather than an arbitrary one.
   */
  private seq = 0;
  private seeding: Promise<void> | null = null;

  constructor(private readonly opts: FirestoreStoreOptions) {}

  // ------------------------------------------------------------ the client

  private client(): Promise<FsFirestore> {
    return (this.connecting ??= openFirestoreClient(this.opts));
  }

  private async board(): Promise<FsDocumentReference> {
    return (await this.client()).collection('boards').doc(docId(this.opts.boardId));
  }

  private async col(name: string): Promise<FsCollectionReference> {
    return (await this.board()).collection(name);
  }

  /**
   * Every mutation goes through here. Reads never do — a read queued behind a
   * write would make the store slower than the file it replaces for no gain,
   * and `store-serialisation`'s first law is that a read sees the newest state
   * rather than the flushing one.
   *
   * **A `TopicOpError` is not a storage failure and does not become one.** The
   * contract says why in its own words — *"the caller has to be able to tell a
   * bad request from a broken store"* — and an early draft of this method
   * classified everything it caught, which turned `splitTopic`'s
   * `empty-split` refusal into an `unknown` Firestore error and failed that
   * assertion against both subjects. The rule is that the taxonomy describes
   * the backend; a rule this adapter enforces on the caller's behalf is the
   * product speaking, and it travels unchanged.
   */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const slot = this.writing.then(fn, fn).catch((err: unknown) => {
      if (err instanceof TopicOpError) throw err;
      throw classifyFirestoreError(err);
    });
    this.writing = slot.catch(() => {});
    return slot;
  }

  /**
   * A whole collection, read.
   *
   * Every list on this store is a collection scan, and that is a decision
   * rather than an omission — see the alias note in the class comment for why a
   * server-side filter cannot answer the question `listSignals` asks. It is
   * still N document reads per call, which on a billed project is the number
   * that matters, and §7 of the port notes says so plainly.
   */
  private async rows<T>(name: string): Promise<T[]> {
    try {
      const snap = await (await this.col(name)).get();
      return snap.docs.map((d) => d.data() as unknown as T);
    } catch (err) { throw classifyFirestoreError(err); }
  }

  private async root(): Promise<RootDoc> {
    try {
      const snap = await (await this.board()).get();
      const data = snap.data() ?? {};
      return {
        prefs: (data['prefs'] as Partial<LearnerPrefs>) ?? {},
        aliases: (data['aliases'] as Record<TopicId, TopicId>) ?? {},
      };
    } catch (err) { throw classifyFirestoreError(err); }
  }

  private async writeRoot(next: RootDoc, replacePrefs = false): Promise<void> {
    const db = await this.client();
    const ref = await this.board();
    await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      const current = (snap.data()?.['prefs'] as Partial<LearnerPrefs> | undefined) ?? {};
      transaction.set(ref, asDoc({
        id: this.opts.boardId,
        prefs: replacePrefs ? next.prefs : current,
        aliases: next.aliases,
      }));
    });
  }

  private async put(collection: string, id: string, value: unknown): Promise<void> {
    const ref = (await this.col(collection)).doc(docId(id));
    await ref.set(asDoc(value as Record<string, unknown>));
  }

  // -------------------------------------------------------------------- pins

  async putPin(pin: Pin): Promise<void> {
    return this.serial(async () => {
      // Membership is derived state, so it resolves on write: a stage that read
      // the board before a merge must not write a pin back onto the retired id.
      const { aliases } = await this.root();
      await this.put('pins', pin.id, resolveOnNullable(pin, aliases));
    });
  }

  async getPin(id: PinId): Promise<Pin | null> {
    const [{ aliases }, snap] = await Promise.all([
      this.root(),
      this.col('pins').then((c) => c.doc(docId(id)).get()).catch((e: unknown) => {
        throw classifyFirestoreError(e);
      }),
    ]);
    const data = snap.exists ? (snap.data() as unknown as Pin) : null;
    return data ? resolveOnNullable(data, aliases) : null;
  }

  async mutatePin(id: PinId, change: (current: Pin) => Pin): Promise<Pin | null> {
    return this.serial(async () => {
      const db = await this.client();
      const ref = (await this.col('pins')).doc(docId(id));
      return db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        if (!snap.exists) return null;
        const current = snap.data() as unknown as Pin;
        const next = change(current);
        transaction.set(ref, asDoc(next as unknown as Record<string, unknown>));
        return next;
      });
    });
  }

  async listPins(opts?: { unenrichedOnly?: boolean }): Promise<readonly Pin[]> {
    const [{ aliases }, rows] = await Promise.all([this.root(), this.rows('pins')]);
    const pins = rows as unknown as Pin[];
    // `owedEnrichment`, not `enrichment === null`, and in memory rather than as
    // a query: the predicate reads `enrichment.outcome`, and encoding it as a
    // server-side filter would freeze a product rule into an index.
    const kept = opts?.unenrichedOnly ? pins.filter(owedEnrichment) : pins;
    return kept.map((p) => resolveOnNullable(p, aliases));
  }

  async deletePin(id: PinId, opts: { keepEmptyTopic?: boolean } = {}): Promise<void> {
    return this.serial(() => this.cascadeDeletePin(id, opts));
  }

  /**
   * The pin cascade, , transcribed from `json-store.ts` clause by clause.
   *
   * Private and un-queued so that `deleteTopic({ deletePins: true })` can call
   * it from inside the queue without deadlocking on it — the one structural
   * difference from the local store, which has no re-entrancy problem because
   * its queue guards the flush rather than the mutation.
   */
  private async cascadeDeletePin(
    id: PinId, opts: { keepEmptyTopic?: boolean } = {},
  ): Promise<void> {
    const db = await this.client();
    const { prefs, aliases } = await this.root();
    const [topics, signals, edges, statements, sessions] = await Promise.all([
      this.rows<Topic>('topics'),
      this.rows<Signal & { seq?: number }>('signals'),
      this.rows<PrereqEdge & { ord?: number }>('edges'),
      this.rows<Statement>('statements'),
      this.rows<Session>('sessions'),
    ]);

    // Scoped to the topics that actually held the pin: rebuilding every topic
    // and filtering on `pinIds.length > 0` collects any topic that was ALREADY
    // pinless, which is how deleting one pin silently deleted an unrelated
    // topic and its comfort history in the local store.
    const remaining = topics.flatMap((t) => {
      if (!t.pinIds.includes(id)) return [t];
      const pinIds = t.pinIds.filter((p) => p !== id);
      return pinIds.length > 0 || t.retiredByUser || opts.keepEmptyTopic ? [{ ...t, pinIds }] : [];
    });
    const live = new Set(remaining.map((t) => t.id));
    const gone = new Set<TopicId>(topics
      .filter((t) => !live.has(t.id))
      .flatMap((t) => [t.id, ...absorbedInto(t.id, aliases)]));

    const batch = new Batcher(db);
    const pinsCol = await this.col('pins');
    batch.delete(pinsCol.doc(docId(id)));

    const topicsCol = await this.col('topics');
    for (const t of topics) {
      const kept = remaining.find((r) => r.id === t.id);
      if (!kept) batch.delete(topicsCol.doc(docId(t.id)));
      else if (kept.pinIds.length !== t.pinIds.length) batch.set(topicsCol.doc(docId(t.id)), asDoc(kept));
    }

    // Comfort: nothing traceable to a deleted pin, and nothing held by a topic
    // that this deletion emptied, may keep counting.
    const signalsCol = await this.col('signals');
    for (const s of signals) {
      if (s.sourceEvent.includes(id) || gone.has(s.topicId)) batch.delete(signalsCol.doc(docId(s.id)));
    }
    if (gone.size) {
      const edgesCol = await this.col('edges');
      for (const e of edges) {
        if (gone.has(e.from) || gone.has(e.to)) batch.delete(edgesCol.doc(edgeDocId(e)));
      }
      const stCol = await this.col('statements');
      for (const s of statements) {
        if (s.topicId !== null && gone.has(s.topicId)) batch.delete(stCol.doc(docId(s.id)));
      }
    }

    // Provenance: nothing already built may keep citing it.
    //
    // The row written is the REWRITTEN one. An early draft computed the filtered
    // sections and then wrote `sess` — the row it had just read — so the cascade
    // ran, cost a write, and changed nothing. Both subjects failed the contract
    // on it, which is the whole argument for running the contract against the
    // real backend: the code looked right and the store still cited a pin the
    // learner had deleted.
    const sessCol = await this.col('sessions');
    for (const sess of sessions) {
      const sections = sess.sections.map((sec) => ({
        ...sec, sourceIds: sec.sourceIds.filter((sid) => !sid.startsWith(`${id}:`)),
      }));
      const changed = sections.some((sec, i) => sec.sourceIds.length !== sess.sections[i]?.sourceIds.length);
      // The row's own night, so a cascade rewrites the document it read rather
      // than putting a stripped copy under a name taken from a clock.
      if (changed) batch.set(sessCol.doc(sessionBatchKey(sess)), asDoc(sessionDoc({ ...sess, sections })));
    }

    await batch.commit();
    // A topic dropped above may have been the target of a merge.
    await this.writeRoot({ prefs, aliases: pruneAliases(aliases, remaining) });
  }

  // ------------------------------------------------------------------ topics

  async putTopic(topic: Topic): Promise<void> {
    return this.serial(async () => {
      const { aliases } = await this.root();
      // Loud rather than silent: writing under a retired id would resurrect it
      // on the board and point two live topics at each other.
      if (isAbsorbed(topic.id, aliases)) {
        throw new TopicOpError('absorbed-topic',
          `${topic.id} was merged into ${resolveTopicId(topic.id, aliases)} and cannot be written`);
      }
      await this.put('topics', topic.id, topic);
    });
  }

  async getTopic(id: TopicId): Promise<Topic | null> {
    // The ARGUMENT resolves, so a panel holding a pre-merge id finds the
    // survivor rather than nothing.
    const { aliases } = await this.root();
    const resolved = resolveTopicId(id, aliases);
    try {
      const snap = await (await this.col('topics')).doc(docId(resolved)).get();
      return snap.exists ? (snap.data() as unknown as Topic) : null;
    } catch (err) { throw classifyFirestoreError(err); }
  }

  async mutateTopic(id: TopicId, change: (current: Topic) => Topic): Promise<Topic | null> {
    return this.serial(async () => {
      const db = await this.client();
      const ref = (await this.col('topics')).doc(docId(id));
      return db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        if (!snap.exists) return null;
        const next = change(snap.data() as unknown as Topic);
        transaction.set(ref, asDoc(next));
        return next;
      });
    });
  }

  async listTopics(): Promise<readonly Topic[]> {
    const [{ aliases }, rows] = await Promise.all([this.root(), this.rows('topics')]);
    return (rows as unknown as Topic[]).filter((t) => !isAbsorbed(t.id, aliases));
  }

  async topicAliases(): Promise<AliasMap> { return { ...(await this.root()).aliases }; }

  async mergeTopics(keepId: TopicId, absorbId: TopicId): Promise<Topic> {
    return this.serial(async () => {
      const db = await this.client();
      const { prefs, aliases } = await this.root();
      const topics = await this.rows<Topic>('topics');
      const pins = await this.rows<Pin>('pins');
      const plan = planMerge(topics, aliases, keepId, absorbId);
      const moved = new Set(plan.movedPinIds);

      const batch = new Batcher(db);
      const topicsCol = await this.col('topics');
      batch.delete(topicsCol.doc(docId(plan.retiredTopicId)));
      batch.set(topicsCol.doc(docId(plan.keep.id)), asDoc(plan.keep));
      const pinsCol = await this.col('pins');
      for (const p of pins) {
        if (moved.has(p.id) || p.topicId === plan.retiredTopicId) {
          batch.set(pinsCol.doc(docId(p.id)), asDoc({ ...p, topicId: plan.keep.id }));
        }
      }
      await batch.commit();
      // The whole of the merge as far as history is concerned. Signals,
      // statements, sessions and edges are untouched and resolve on read.
      await this.writeRoot({ prefs, aliases: { ...aliases, [plan.retiredTopicId]: plan.keep.id } });
      return plan.keep;
    });
  }

  async splitTopic(topicId: TopicId, pinIds: readonly PinId[], newLabel: string): Promise<Topic> {
    return this.serial(async () => {
      const db = await this.client();
      const { aliases } = await this.root();
      const topics = await this.rows<Topic>('topics');
      const pins = await this.rows<Pin>('pins');
      const plan = planSplit(
        topics, pins, aliases, topicId, pinIds, newLabel,
        randomUUID(), new Date().toISOString(),
      );
      const moved = new Set(plan.movedPinIds);

      const batch = new Batcher(db);
      const topicsCol = await this.col('topics');
      batch.set(topicsCol.doc(docId(plan.original.id)), asDoc(plan.original));
      batch.set(topicsCol.doc(docId(plan.created.id)), asDoc(plan.created));
      const pinsCol = await this.col('pins');
      for (const p of pins) {
        if (moved.has(p.id)) batch.set(pinsCol.doc(docId(p.id)), asDoc({ ...p, topicId: plan.created.id }));
      }
      await batch.commit();
      // Signals stay with the original. Comfort is not divisible.
      return plan.created;
    });
  }

  async deleteTopic(id: TopicId, opts: { deletePins: boolean }): Promise<void> {
    return this.serial(async () => {
      const db = await this.client();
      const { aliases } = await this.root();
      // An id that has already been absorbed names nothing on the board;
      // resolving it would delete the survivor the user never pointed at.
      if (isAbsorbed(id, aliases)) return;
      const topics = await this.rows<Topic>('topics');
      const topic = topics.find((t) => t.id === id);
      if (!topic) return;
      // Captured before the pin cascade, which can empty the topic and take the
      // alias with it, leaving nothing here to read.
      const gone = new Set<TopicId>([id, ...absorbedInto(id, aliases)]);
      if (opts.deletePins) for (const pid of [...topic.pinIds]) await this.cascadeDeletePin(pid);

      const after = await this.root();
      const remaining = (await this.rows<Topic>('topics')).filter((t) => t.id !== id);
      const batch = new Batcher(db);
      batch.delete((await this.col('topics')).doc(docId(id)));
      const edgesCol = await this.col('edges');
      for (const e of await this.rows<PrereqEdge>('edges')) {
        if (gone.has(e.from) || gone.has(e.to)) batch.delete(edgesCol.doc(edgeDocId(e)));
      }
      const signalsCol = await this.col('signals');
      for (const s of await this.rows<Signal>('signals')) {
        if (gone.has(s.topicId)) batch.delete(signalsCol.doc(docId(s.id)));
      }
      const stCol = await this.col('statements');
      for (const s of await this.rows<Statement>('statements')) {
        if (s.topicId !== null && gone.has(s.topicId)) batch.delete(stCol.doc(docId(s.id)));
      }
      await batch.commit();
      await this.writeRoot({ prefs: after.prefs, aliases: pruneAliases(after.aliases, remaining) });
    });
  }

  // ------------------------------------------------------------------- edges

  async putEdges(edges: readonly PrereqEdge[]): Promise<void> {
    return this.serial(async () => {
      const db = await this.client();
      const col = await this.col('edges');
      const existing = await this.rows<PrereqEdge>('edges');
      const wanted = new Set(edges.map(edgeDocId));
      const batch = new Batcher(db);
      // `putEdges` replaces the graph wholesale, so anything not in the new set
      // goes. Keyed by `from|to` rather than by an ordinal, so replacing five
      // edges with three cannot leave two orphans behind under stale names.
      for (const e of existing) if (!wanted.has(edgeDocId(e))) batch.delete(col.doc(edgeDocId(e)));
      edges.forEach((e, ord) => batch.set(col.doc(edgeDocId(e)), asDoc({ ...e, ord })));
      await batch.commit();
    });
  }

  async listEdges(): Promise<readonly PrereqEdge[]> {
    const [{ aliases }, rows] = await Promise.all([this.root(), this.rows('edges')]);
    const ordered = (rows as unknown as (PrereqEdge & { ord?: number })[])
      .slice().sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0));
    const seen = new Set<string>();
    const out: PrereqEdge[] = [];
    for (const row of ordered) {
      const { ord: _ord, ...e } = row;
      const from = resolveTopicId(e.from, aliases);
      const to = resolveTopicId(e.to, aliases);
      // A merge can collapse an edge onto itself; "A before B" means nothing
      // once A and B are one topic.
      if (from === to) continue;
      const key = `${from} ${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...e, from, to });
    }
    return out;
  }

  // ------------------------------------------------------------------ ledger

  /** Seeded once per handle, from the board rather than from zero: a second
   *  process must not restart the ledger's order at 1. */
  private seedSeq(): Promise<void> {
    return (this.seeding ??= (async () => {
      const rows = await this.rows<{ seq?: number }>('signals');
      this.seq = rows.reduce((max, r) => Math.max(max, r.seq ?? 0), 0);
    })());
  }

  async appendSignal(signal: Signal): Promise<void> {
    return this.serial(async () => {
      await this.seedSeq();
      this.seq = Math.max(this.seq + 1, Date.now());
      // Append-only: history is what makes  possible. Keyed by the signal's
      // own id, which also makes a retried Job's re-append a replacement rather
      // than a duplicate — the same idempotence the batch-idempotency contract buys for sessions,
      // free here because the ledger already has stable ids.
      await this.put('signals', signal.id, { ...signal, seq: this.seq });
    });
  }

  async listSignals(topicId?: TopicId): Promise<readonly Signal[]> {
    const [{ aliases }, rows] = await Promise.all([this.root(), this.rows('signals')]);
    const ordered = (rows as unknown as (Signal & { seq?: number })[])
      .slice()
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.id.localeCompare(b.id));
    const out = ordered.map((row) => {
      const { seq: _seq, ...s } = row;
      return resolveOn(s as Signal, aliases);
    });
    if (topicId === undefined) return out;
    const wanted = resolveTopicId(topicId, aliases);
    return out.filter((x) => x.topicId === wanted);
  }

  async invalidateSignals(sourceEvent: string): Promise<void> {
    return this.serial(async () => {
      const db = await this.client();
      const col = await this.col('signals');
      const rows = await this.rows<Signal & { seq?: number }>('signals');
      const batch = new Batcher(db);
      // A flag, never a delete: the row is the evidence.
      for (const s of rows) {
        if (s.sourceEvent === sourceEvent) batch.set(col.doc(docId(s.id)), asDoc({ ...s, invalidated: true }));
      }
      await batch.commit();
    });
  }

  // ------------------------------------------------- commitments and awards

  /**
   * The second ledger, in its own two collections.
   *
   * Nothing here resolves topic aliases the way the signal collections do, and
   * that is on purpose: a commitment names the topics it leans on for
   * *scheduling*, and a merge that moved a topic is allowed to leave a stale id
   * behind here. The consequence is a due date that stops pulling a renamed
   * topic forward until the learner re-links it — a scheduling miss. Resolving
   * it would mean this ledger reaching into the alias map, which is the board's
   * record of decisions about knowledge, and the two are kept apart deliberately.
   */
  async putCommitment(c: Commitment): Promise<void> {
    return this.serial(() => this.put('commitments', c.id, c));
  }

  async getCommitment(id: string): Promise<Commitment | null> {
    const snap = await (await this.col('commitments')).doc(docId(id)).get();
    return snap.exists ? (snap.data() as unknown as Commitment) : null;
  }

  async listCommitments(): Promise<readonly Commitment[]> {
    return (await this.rows('commitments')) as unknown as Commitment[];
  }

  async deleteCommitment(id: string): Promise<void> {
    return this.serial(async () => {
      // The awards it earned stay. They record something the learner did, and
      // deleting the note about an assignment does not undo handing it in.
      await (await this.col('commitments')).doc(docId(id)).delete();
    });
  }

  async replaceCommitments(puts: readonly Commitment[], removeIds: readonly string[]): Promise<void> {
    return this.serial(async () => {
      //  caps a series at twenty and therefore this operation below forty
      // writes. One Firestore batch is genuinely atomic; do not route this
      // through the general chunking Batcher whose documented contract is not.
      if (puts.length + removeIds.length > 40) throw new Error('commitment batch exceeds its bounded contract');
      const db = await this.client();
      const batch = db.batch();
      const col = await this.col('commitments');
      for (const id of new Set(removeIds)) batch.delete(col.doc(docId(id)));
      for (const c of puts) batch.set(col.doc(docId(c.id)), asDoc(c));
      await batch.commit();
    });
  }

  /** Append-only, like signals. There is no delete and no way to spend points. */
  async appendAward(a: Award): Promise<void> {
    return this.serial(() => this.put('awards', a.id, a));
  }

  async listAwards(): Promise<readonly Award[]> {
    return (await this.rows('awards')) as unknown as Award[];
  }

  // ----------------------------------------------------------------- courses

  async putCourse(c: Course): Promise<void> {
    return this.serial(() => this.put('courses', c.id, c));
  }

  async getCourse(id: string): Promise<Course | null> {
    const snap = await (await this.col('courses')).doc(docId(id)).get();
    return snap.exists ? (snap.data() as unknown as Course) : null;
  }

  async listCourses(): Promise<readonly Course[]> {
    return (await this.rows('courses')) as unknown as Course[];
  }

  async deleteCourse(id: string): Promise<void> {
    return this.serial(async () => {
      await (await this.col('courses')).doc(docId(id)).delete();
    });
  }

  async replaceCourses(puts: readonly Course[], removeIds: readonly string[]): Promise<void> {
    return this.serial(async () => {
      if (puts.length + removeIds.length > 20) throw new Error('course batch exceeds its bounded contract');
      const db = await this.client();
      const batch = db.batch();
      const col = await this.col('courses');
      for (const id of new Set(removeIds)) batch.delete(col.doc(docId(id)));
      for (const course of puts) batch.set(col.doc(docId(course.id)), asDoc(course));
      await batch.commit();
    });
  }

  // ------------------------------------------------------ reviewed intake

  async putIntakeDraft(draft: CourseIntakeDraft): Promise<void> {
    return this.serial(() => this.put('intakeDrafts', draft.id, draft));
  }

  async getIntakeDraft(id: string): Promise<CourseIntakeDraft | null> {
    const snap = await (await this.col('intakeDrafts')).doc(docId(id)).get();
    return snap.exists ? (snap.data() as unknown as CourseIntakeDraft) : null;
  }

  async listIntakeDrafts(): Promise<readonly CourseIntakeDraft[]> {
    return (await this.rows('intakeDrafts')) as unknown as CourseIntakeDraft[];
  }

  // ------------------------------------------------ what the night proposed

  async putProspectProposal(proposal: ProspectProposal): Promise<void> {
    return this.serial(() => this.put('prospects', proposal.id, proposal));
  }

  async getProspectProposal(id: string): Promise<ProspectProposal | null> {
    const snap = await (await this.col('prospects')).doc(docId(id)).get();
    return snap.exists ? (snap.data() as unknown as ProspectProposal) : null;
  }

  async listProspectProposals(): Promise<readonly ProspectProposal[]> {
    return (await this.rows('prospects')) as unknown as ProspectProposal[];
  }

  // ------------------------------------------ what was offered and passed over

  /**
   * One document in its own collection rather than a field on the board root.
   *
   * The root is rewritten whole by `putPrefs` and by the hosted-receipt
   * compare-and-set, so a sibling field there would be dropped by the next
   * preference save. A collection of one is also what `recursiveDelete` already
   * knows how to wipe, so the full wipe needs no new line.
   */
  async getPassedOverLedger(): Promise<PassedOverLedger> {
    const snap = await (await this.col('passedOver')).doc('ledger').get();
    return readPassedOverLedger(snap.exists ? snap.data() : null);
  }

  async putPassedOverLedger(ledger: PassedOverLedger): Promise<void> {
    return this.serial(() => this.put('passedOver', 'ledger', ledger));
  }

  // --------------------------------------------- what went to another surface

  /**
   * A collection like every other, and a delete that really is one.
   *
   * `deleteEverything`'s `recursiveDelete` reaches it with no new line, and the
   * per-row removal is a single document delete: the learner is promised that
   * removing a row records nothing, so there is nothing else here to touch.
   */
  async putExternalEntry(entry: ExternalEntry): Promise<void> {
    return this.serial(() => this.put('externals', entry.id, entry));
  }

  async getExternalEntry(id: string): Promise<ExternalEntry | null> {
    const snap = await (await this.col('externals')).doc(docId(id)).get();
    return snap.exists ? (snap.data() as unknown as ExternalEntry) : null;
  }

  async listExternalEntries(): Promise<readonly ExternalEntry[]> {
    return (await this.rows('externals')) as unknown as ExternalEntry[];
  }

  async deleteExternalEntry(id: string): Promise<void> {
    return this.serial(async () => {
      await (await this.col('externals')).doc(docId(id)).delete();
    });
  }

  // ------------------------------------------------------- real outcomes

  async putOutcome(outcome: LearningOutcome): Promise<void> {
    return this.serial(() => this.put('outcomes', outcome.id, outcome));
  }

  async getOutcome(id: string): Promise<LearningOutcome | null> {
    const snap = await (await this.col('outcomes')).doc(docId(id)).get();
    return snap.exists ? (snap.data() as unknown as LearningOutcome) : null;
  }

  async listOutcomes(): Promise<readonly LearningOutcome[]> {
    return (await this.rows('outcomes')) as unknown as LearningOutcome[];
  }

  // -------------------------------------------------------------- statements

  async putStatement(statement: Statement): Promise<void> {
    return this.serial(() => this.put('statements', statement.id, statement));
  }

  async listStatements(): Promise<readonly Statement[]> {
    const [{ aliases }, rows] = await Promise.all([this.root(), this.rows('statements')]);
    return (rows as unknown as Statement[]).map((s) => resolveOnNullable(s, aliases));
  }

  async deleteStatement(id: string): Promise<void> {
    return this.serial(async () => {
      await (await this.col('statements')).doc(docId(id)).delete();
    });
  }

  // ---------------------------------------------------------------- sessions

  /**
   * The batch-idempotency contract, and the one place this store deliberately does not match the
   * local one.
   *
   * The document name is the night the session says it is for (the batch-key alignment contract), so a
   * retried Cloud Run Job writes the same path and leaves one row where
   * `JsonStore` leaves two — including the retry that finishes on the far side
   * of midnight, which is the case a name taken from `builtAt` could not
   * survive. `writeSeq` carries the tie-break `latestSession` promises: the
   * promise is "the row written last wins", and a promise kept by an accident
   * of the key is a promise that breaks when the key changes.
   */
  async putSession(session: Session): Promise<void> {
    return this.serial(async () => {
      const col = await this.col('sessions');
      await col.doc(sessionBatchKey(session)).set(asDoc(sessionDoc(session)));
    });
  }

  async getSession(id: SessionId): Promise<Session | null> {
    const [{ aliases }, rows] = await Promise.all([this.root(), this.rows('sessions')]);
    // By field, not by document name: the name is the night and the caller has
    // a session id. A `where('id','==',…)` would serve, on Firestore's automatic
    // single-field index — but an `orderBy`/`where` omits documents that lack
    // the field, and a session row written without an `id` would then be
    // unreachable rather than merely unsorted. In memory it cannot vanish.
    const found = (rows as unknown as Session[]).find((s) => s.id === id);
    return found ? resolveSession(found, aliases) : null;
  }

  /**
   * The newest session, with the tie broken toward the one written last.
   *
   * A reduce over rows put in write order, rather than an
   * `orderBy('builtAt','desc').limit(1)`. The query would be cheaper and would
   * be wrong: Firestore breaks an `orderBy` tie by document name (measured —
   * three rows written zeta, alpha, mike come back alpha, mike, zeta), and the
   * product's promise is write recency. `batch-recovery.test.ts` is the
   * regression that promise exists for: a run whose Verifier could not reach
   * the model persists a session with no sections, the retry persists the real
   * one, and a store that picks the wrong row of the two tells the learner
   * there is nothing ready on the night the retry succeeded.
   */
  async latestSession(): Promise<Session | null> {
    const [{ aliases }, rows] = await Promise.all([this.root(), this.rows('sessions')]);
    const inWriteOrder = (rows as unknown as (Session & { writeSeq?: number })[])
      .slice().sort((a, b) => (a.writeSeq ?? 0) - (b.writeSeq ?? 0));
    const latest = inWriteOrder.reduce<Session | null>(
      (best, s) => (best === null || s.builtAt.localeCompare(best.builtAt) >= 0 ? s : best), null);
    return latest ? resolveSession(latest, aliases) : null;
  }

  async listSessions(): Promise<readonly Session[]> {
    const [{ aliases }, rows] = await Promise.all([this.root(), this.rows('sessions')]);
    return (rows as unknown as Session[]).map((s) => resolveSession(s, aliases));
  }

  // ------------------------------------------------------------ suggestions

  async putSuggestion(s: Suggestion): Promise<void> {
    return this.serial(() => this.put('suggestions', s.id, s));
  }

  async listSuggestions(state?: Suggestion['state']): Promise<readonly Suggestion[]> {
    const rows = await this.rows<Suggestion>('suggestions');
    return state ? rows.filter((x) => x.state === state) : rows;
  }

  // ------------------------------------------------------------------ prefs

  /**
   * Prefs, with anything the stored copy pre-dates filled in from the defaults.
   *
   * `DEFAULT_PREFS` is imported from the local store rather than redeclared,
   * and the reason matters:  exclusion list is a *product* rule, not a
   * storage detail, and two shipped stores with different defaults would mean a
   * learner's board changed shape when the backend did. The oracle declares its
   * own on purpose — it is checking the rule, not implementing it — and this
   * store is not the oracle.
   */
  async getPrefs(): Promise<LearnerPrefs> {
    return { ...DEFAULT_PREFS, ...(await this.root()).prefs };
  }

  async mutatePrefs(change: (current: LearnerPrefs) => LearnerPrefs): Promise<LearnerPrefs> {
    return this.serial(async () => {
      const db = await this.client();
      const ref = await this.board();
      return db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        const data = snap.data() ?? {};
        const stored = (data['prefs'] as Partial<LearnerPrefs>) ?? {};
        const current: LearnerPrefs = { ...DEFAULT_PREFS, ...stored };
        const changed = change(current);
        const { hostedProcessing: _serviceOwned, ...learnerPrefs } = changed;
        const next: LearnerPrefs = {
          ...learnerPrefs,
          ...(stored.hostedProcessing ? { hostedProcessing: stored.hostedProcessing } : {}),
        };
        transaction.set(ref, asDoc({
          prefs: next,
          aliases: (data['aliases'] as Record<TopicId, TopicId>) ?? {},
        }));
        return { ...DEFAULT_PREFS, ...next };
      });
    });
  }

  async putPrefs(prefs: LearnerPrefs): Promise<void> {
    return this.serial(async () => {
      const db = await this.client();
      const ref = await this.board();
      await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        const data = snap.data() ?? {};
        const current = (data['prefs'] as Partial<LearnerPrefs>) ?? {};
        const {
          hostedProcessing: _serviceOwned,
          modelBudgetLease: _budgetCoordination,
          ...learnerPrefs
        } = prefs;
        transaction.set(ref, asDoc({
          prefs: {
            ...learnerPrefs,
            ...(current.hostedProcessing ? { hostedProcessing: current.hostedProcessing } : {}),
            ...(current.modelBudgetLease ? { modelBudgetLease: current.modelBudgetLease } : {}),
          },
          aliases: (data['aliases'] as Record<TopicId, TopicId>) ?? {},
        }));
      });
    });
  }

  async compareAndSetHostedProcessing(
    expected: HostedProcessingVersion | null,
    next: HostedProcessingReceipt,
  ): Promise<boolean> {
    return this.serial(async () => {
      const db = await this.client();
      const ref = await this.board();
      return db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        const data = snap.data() ?? {};
        const prefs = (data['prefs'] as Partial<LearnerPrefs>) ?? {};
        const current = prefs.hostedProcessing ?? null;
        const matches = expected === null ? current === null : Boolean(current
          && current.receiptId === expected.receiptId
          && current.state === expected.state
          && current.checkedAt === expected.checkedAt);
        if (!matches) return false;
        transaction.set(ref, asDoc({
          prefs: { ...DEFAULT_PREFS, ...prefs, hostedProcessing: next },
          aliases: (data['aliases'] as Record<TopicId, TopicId>) ?? {},
        }));
        return true;
      });
    });
  }

  async pairLocalConnector(tokenHash: string): Promise<void> {
    return this.serial(() => this.put('local-model-connectors', 'active', { tokenHash })); }
  async unpairLocalConnector(): Promise<void> {
    await this.serial(async () => (await this.col('local-model-connectors')).doc('active').delete()); }
  async localConnectorPaired(): Promise<boolean> {
    const snap = await (await this.col('local-model-connectors')).doc('active').get();
    return snap.exists && typeof snap.data()?.['tokenHash'] === 'string'; }
  async verifyLocalConnector(tokenHash: string): Promise<boolean> {
    const snap = await (await this.col('local-model-connectors')).doc('active').get();
    const row = snap.data();
    if (!snap.exists || typeof row?.['tokenHash'] !== 'string') return false;
    const expected = Buffer.from(row['tokenHash'], 'hex'), actual = Buffer.from(tokenHash, 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
  async touchLocalConnector(now: string): Promise<void> {
    const ref = (await this.col('local-model-connectors')).doc('active');
    await this.serial(async () => (await this.client()).runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        if (!snap.exists) return;
        transaction.set(ref, asDoc({ ...snap.data(), lastSeenAt: now }));
    }));
  }
  async localConnectorReady(now: string): Promise<boolean> {
    const snap = await (await this.col('local-model-connectors')).doc('active').get();
    const row = snap.data();
    if (!snap.exists || typeof row?.['tokenHash'] !== 'string'
      || typeof row['lastSeenAt'] !== 'string') return false;
    return Date.parse(now) - Date.parse(row['lastSeenAt']) <= 45_000;
  }
  async enqueueLocalConnectorJob(job: LocalConnectorJob): Promise<void> {
    return this.serial(() => this.put('local-model-jobs', job.id, job)); }
  async claimLocalConnectorJob(now: string, leaseId: string): Promise<LocalConnectorJob | null> {
    const jobs = (await this.rows<LocalConnectorJob>('local-model-jobs'))
      .filter((job) => (job.state === 'queued'
        || (job.state === 'claimed' && (!job.leaseUntil || job.leaseUntil <= now))) && job.expiresAt > now)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const chosen = jobs[0];
    if (!chosen) return null;
    const ref = (await this.col('local-model-jobs')).doc(docId(chosen.id));
    return (await this.client()).runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      const current = snap.data() as unknown as LocalConnectorJob | undefined;
      if (!current || (current.state !== 'queued'
        && !(current.state === 'claimed' && (!current.leaseUntil || current.leaseUntil <= now)))
        || current.expiresAt <= now) return null;
      const leaseUntil = new Date(Date.parse(now) + LOCAL_CONNECTOR_LEASE_MS).toISOString();
      const claimed: LocalConnectorJob = { ...current, state: 'claimed', leaseId, leaseUntil };
      transaction.set(ref, asDoc(claimed as unknown as Record<string, unknown>));
      return claimed;
    });
  }
  async renewLocalConnectorJob(id: string, leaseId: string, now: string): Promise<boolean> {
    const ref = (await this.col('local-model-jobs')).doc(docId(id));
    return (await this.client()).runTransaction(async (transaction) => {
      const snap = await transaction.get(ref), current = snap.data() as unknown as LocalConnectorJob;
      if (!current || current.state !== 'claimed' || current.leaseId !== leaseId) return false;
      transaction.set(ref, asDoc({ ...current,
        leaseUntil: new Date(Date.parse(now) + LOCAL_CONNECTOR_LEASE_MS).toISOString() }));
      return true;
    });
  }
  async finishLocalConnectorJob(
    id: string, leaseId: string, outcome: { result: LocalConnectorResult } | { error: string },
  ): Promise<boolean> {
    const ref = (await this.col('local-model-jobs')).doc(docId(id));
    return (await this.client()).runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      const current = snap.data() as unknown as LocalConnectorJob | undefined;
      if (!current || current.state !== 'claimed' || current.leaseId !== leaseId) return false;
      const next: LocalConnectorJob = 'result' in outcome
        ? { ...current, state: 'completed', result: outcome.result }
        : { ...current, state: 'failed', error: outcome.error.slice(0, 1_000) };
      transaction.set(ref, asDoc(next as unknown as Record<string, unknown>));
      return true;
    });
  }
  async readLocalConnectorJob(id: string): Promise<LocalConnectorJob | null> {
    const snap = await (await this.col('local-model-jobs')).doc(docId(id)).get();
    return snap.exists ? snap.data() as unknown as LocalConnectorJob : null;
  } async deleteLocalConnectorJob(id: string): Promise<void> {
    await (await this.col('local-model-jobs')).doc(docId(id)).delete();
  }

  async deleteEverything(): Promise<void> {
    return this.serial(async () => {
      const db = await this.client();
      // One call, because the board is one document with everything beneath it.
      // The alias map goes with it: it is a record of decisions the learner made
      // about their board, so a full wipe has to clear it too.
      await db.recursiveDelete(await this.board());
      // Re-created immediately, so the store is usable afterwards — which a
      // store that deleted its own root and left it is not.
      await this.writeRoot({ prefs: DEFAULT_PREFS, aliases: {} }, true);
      this.seq = 0;
      this.seeding = null;
    });
  }

  async close(): Promise<void> {
    if (!this.connecting) return;
    await (await this.connecting).terminate();
  }
}
function edgeDocId(e: { from: TopicId; to: TopicId }): string {
  return docId(`${e.from.replace(/\|/g, '%7C')}|${e.to.replace(/\|/g, '%7C')}`);
}
function sessionDoc(session: Session): Record<string, unknown> {
  return { ...session, batchKeyOf: sessionBatchKey(session), writeSeq: Date.now() };
}
function resolveSession(row: Session, aliases: AliasMap): Session {
  const { batchKeyOf: _n, writeSeq: _w, ...session } = row as Session & { batchKeyOf?: string; writeSeq?: number };
  return { ...session, sections: session.sections.map((s) => resolveOn(s, aliases)) };
}
function pruneAliases(aliases: Record<TopicId, TopicId>, live: readonly Topic[]): Record<TopicId, TopicId> {
  const ids = new Set(live.map((t) => t.id));
  return Object.fromEntries(Object.entries(aliases).filter(([k]) => ids.has(resolveTopicId(k, aliases))));
}
