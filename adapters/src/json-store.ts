import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type {
  Store, Pin, PinId, Topic, TopicId, PrereqEdge, Signal, Statement,
  Session, SessionId, Suggestion, LearnerPrefs, AliasMap, HostedProcessingReceipt,
  HostedProcessingVersion,
  Award, Commitment, Course, CourseIntakeDraft, ExternalEntry, LearningOutcome,
  ProspectProposal, PassedOverLedger,
} from '@sb/core';
import {
  EMPTY_PASSED_OVER_LEDGER, TopicOpError, absorbedInto, isAbsorbed, owedEnrichment,
  planMerge, planSplit, readPassedOverLedger,
  resolveOn, resolveOnNullable, resolveTopicId,
} from '@sb/core';

interface Db {
  pins: Pin[];
  topics: Topic[];
  edges: PrereqEdge[];
  signals: Signal[];
  statements: Statement[];
  sessions: Session[];
  suggestions: Suggestion[];
  /** The second ledger — what the learner is on the hook for, and what they
   *  have earned. Optional on read: a store written before this existed is a
   *  real board and must not fail to load. */
  commitments: Commitment[];
  awards: Award[];
  courses: Course[];
  intakeDrafts: CourseIntakeDraft[];
  /** What the night proposed collecting, waiting on the learner. */
  prospects: ProspectProposal[];
  /** The forward-only ring of things offered and passed over. One record. */
  passedOver: PassedOverLedger;
  /** What the learner took to another surface, and what they made of it. */
  externals: ExternalEntry[];
  outcomes: LearningOutcome[];
  prefs: LearnerPrefs;
  /** absorbedId -> keptId. One entry per merge; chains are not compressed. */
  aliases: Record<TopicId, TopicId>;
}

/** SB-41: ships with sensible exclusions, not an empty list. */
export const DEFAULT_PREFS: LearnerPrefs = {
  targetMinutes: 15,
  // The flash-time duration policy: Virgil's session model is the flash-sized choice
  // the learner actually sees. `targetMinutes` remains above for old boards
  // and portable backups, but no new board should need a migration before its
  // first Process run can honour 1/3/5.
  availableMinutes: 3,
  interfaceLanguage: 'en',
  pausedUntil: null,
  excludedDomains: [
    'mail.google.com', 'outlook.com', 'outlook.office.com',
    'online.lloydsbank.co.uk', 'chase.com', 'monzo.com', 'revolut.com',
    'nhs.uk', 'patient.info', '1password.com', 'bitwarden.com',
  ],
  interview: {},
  // SB-16. Empty is the honest default: nothing has been rejected yet, and the
  // detector is loud everywhere until the learner says otherwise.
  rejectedOrigins: {},
};

const empty = (): Db => ({
  pins: [], topics: [], edges: [], signals: [],
  statements: [], sessions: [], suggestions: [],
  commitments: [], awards: [], courses: [], intakeDrafts: [], prospects: [],
  externals: [], outcomes: [],
  passedOver: EMPTY_PASSED_OVER_LEDGER,
  prefs: DEFAULT_PREFS,
  aliases: {},
});

/**
 * The four filesystem calls this store makes, named so something else can stand
 * in front of them.
 *
 * The durability promise in `save` — temp file, then atomic rename — is a claim
 * about what happens when a write does NOT complete: a crash between the two,
 * a partial write, a full disk. None of that is reachable by driving the public
 * API, and none of it is reachable with a wall clock either, so a store whose fs
 * calls are unreachable has a durability story that can only be reasoned about.
 * Injecting the boundary makes the failure a scheduling decision the test takes.
 *
 * Deliberately four methods and not `typeof import('node:fs/promises')`: the
 * surface a stand-in has to implement is the surface this class actually uses,
 * and widening it would be inviting the store to grow new fs calls silently.
 */
export interface StoreFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  mkdir(path: string, opts: { recursive: true }): Promise<unknown>;
  rename(from: string, to: string): Promise<void>;
}

const nodeFs: StoreFs = { readFile, writeFile, mkdir, rename };

/**
 * Local persistence. Firestore at port — the shape is deliberately
 * collection-per-key so the swap is mechanical.
 *
 * The cascade in `deletePin`/`deleteTopic` is the reason this is an adapter
 * concern and not left to callers: SB-43 requires a deleted pin to stop
 * influencing tomorrow's session, which means reaching into signals, topic
 * membership and session provenance. Getting that wrong is a broken promise.
 *
 * ## Alias resolution, and where it applies
 *
 * A merge retires a topic id into `db.aliases` and rewrites nothing else. The
 * signal ledger is append-only because history is what makes regression
 * detectable (SB-22), so the union of two merged histories happens **on read**:
 * every path that hands a topic id back to a caller resolves it through the
 * alias map first. Audited and covered here:
 *
 *  | read              | what carries a topic id                              |
 *  | :---              | :---                                                 |
 *  | `getPin`/`listPins`   | `pin.topicId` — membership                        |
 *  | `getTopic`        | the *argument*, so a stale id finds the survivor     |
 *  | `listTopics`      | absorbed ids are gone from the array entirely        |
 *  | `listEdges`       | `from` and `to` — prerequisite graph                 |
 *  | `listSignals`     | the argument *and* every row — this is the comfort union |
 *  | `listStatements`  | `statement.topicId` — the learner model              |
 *  | `getSession`/`latestSession` | `section.topicId` — session provenance     |
 *
 * Writes stay verbatim. A signal is stored with the topic id it was recorded
 * under, for ever; resolving on write would be a retroactive edit of the
 * learner's own evidence, and the ledger would stop being an honest record of
 * what happened. The one exception is `putPin`, whose `topicId` is derived
 * membership rather than evidence and is resolved so a race with a merge cannot
 * write a pin back onto a retired topic.
 */
export class JsonStore implements Store {
  private db: Db = empty();
  /**
   * Single-flight load. An earlier version set a `loaded` boolean *after*
   * awaiting the read, so N concurrent callers all saw it as false, each built
   * its own db object, and N-1 of them wrote into objects that were then
   * orphaned. Measured: 60 concurrent writes to a cold store persisted 1.
   *
   * Memoising the promise rather than the result means every concurrent caller
   * awaits the same load and shares the same object.
   */
  private loading: Promise<Db> | null = null;

  /** Serialises writes. Concurrent writeFile to one path is not atomic. */
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path: string, private readonly fs: StoreFs = nodeFs) {}

  /**
   * Two different events used to be one. `load` caught everything, so a file
   * that is not there yet — a legitimate first run — and a file that will not
   * parse both produced an empty board, and the next flush wrote that empty
   * board over whatever was actually there. A store the learner cannot read is
   * not a store with nothing in it, and losing every pin they ever saved is the
   * one failure this file exists to prevent.
   *
   * So absence is the empty board, and anything else stops the store with the
   * path in the message. The memoised promise keeps its rejection deliberately:
   * a retry that reset `loading` would get a fresh, empty db and perform the
   * same wipe one call later.
   */
  private load(): Promise<Db> {
    return (this.loading ??= (async () => {
      let raw: string;
      try {
        raw = await this.fs.readFile(this.path, 'utf8');
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException)?.code === 'ENOENT') {
          this.db = empty();
          return this.db;
        }
        throw new Error(`the store at ${this.path} could not be read`, { cause });
      }
      try {
        this.db = { ...empty(), ...JSON.parse(raw) as Partial<Db> };
      } catch (cause) {
        throw new Error(
          `the store at ${this.path} could not be read: it is not valid JSON. `
          + 'Refusing to start on a board that cannot be read, because the next '
          + 'write would replace it with an empty one.',
          { cause },
        );
      }
      return this.db;
    })());
  }

  /**
   * The temp file this handle writes through, before renaming it into place.
   *
   * Per HANDLE, not per process. Naming it `${path}.${pid}.tmp` made every
   * handle in one process share one temp file, and two handles over one file is
   * ordinary — the service holds one, a migration or a second run opens another.
   * With a shared name, one handle can rename the other's half-written file into
   * place, which is precisely the failure the rename exists to prevent, and
   * `load` then reads the wreckage as an empty board.
   */
  private readonly handle = randomUUID();

  /**
   * Write-through a queue, via a temp file and rename. Rename is atomic on the
   * same filesystem, so a crash mid-write cannot leave a half-written store —
   * which for this product means losing every pin the learner ever saved.
   *
   * The caller hears about a write that failed, and the queue does not. Those
   * have to be separated: a rejected `writing` would take every later write with
   * it, and a swallowed rejection tells the learner their pin is saved when it
   * is not. So the slot is what the caller awaits, and the queue chains on a
   * handled copy of it.
   */
  private async writeCurrent(): Promise<void> {
    await this.fs.mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${this.handle}.tmp`;
    await this.fs.writeFile(tmp, JSON.stringify(this.db, null, 2), 'utf8');
    await this.fs.rename(tmp, this.path);
  }

  private save(): Promise<void> {
    const slot = this.writing.then(() => this.writeCurrent());
    this.writing = slot.catch(() => {});
    return slot;
  }

  private async upsert<T extends { id: string }>(key: keyof Db, item: T): Promise<void> {
    const db = await this.load();
    const arr = db[key] as unknown as T[];
    const i = arr.findIndex((x) => x.id === item.id);
    if (i >= 0) arr[i] = item; else arr.push(item);
    await this.save();
  }

  async putPin(pin: Pin) {
    // Membership is derived, so resolving it here costs nothing and stops a
    // nightly run that read the board before a merge from writing a pin back
    // onto the retired id afterwards.
    const db = await this.load();
    await this.upsert('pins', resolveOnNullable(pin, db.aliases));
  }
  async getPin(id: PinId) {
    const db = await this.load();
    const pin = db.pins.find((p) => p.id === id);
    return pin ? resolveOnNullable(pin, db.aliases) : null;
  }
  async mutatePin(id: PinId, change: (current: Pin) => Pin): Promise<Pin | null> {
    const slot = this.writing.then(async () => {
      const db = await this.load();
      const index = db.pins.findIndex((pin) => pin.id === id);
      if (index < 0) return null;
      const before = db.pins[index]!;
      const next = resolveOnNullable(change(resolveOnNullable(before, db.aliases)), db.aliases);
      db.pins[index] = next;
      try {
        await this.writeCurrent();
        return resolveOnNullable(next, db.aliases);
      } catch (error) {
        db.pins[index] = before;
        throw error;
      }
    });
    this.writing = slot.then(() => undefined, () => undefined);
    return slot;
  }
  async listPins(opts?: { unenrichedOnly?: boolean }) {
    const db = await this.load();
    // `owedEnrichment`, not `enrichment === null`: a pin whose model call failed
    // holds a capture-envelope-only record and would otherwise never be asked
    // again — the failure would be permanent and invisible at the same time.
    const pins = opts?.unenrichedOnly ? db.pins.filter(owedEnrichment) : db.pins;
    return pins.map((p) => resolveOnNullable(p, db.aliases));
  }

  async deletePin(id: PinId, opts: { keepEmptyTopic?: boolean } = {}) {
    const db = await this.load();
    db.pins = db.pins.filter((p) => p.id !== id);
    // (alias upkeep happens at the end of the cascade — see `pruneAliases`)
    // Cascade 1: topic membership, and drop topics THIS deletion left with
    // nothing behind them.
    //
    // Scoped to the topics that actually held the pin, and that is the whole of
    // the rule. An earlier version rebuilt every topic and filtered the lot on
    // `pinIds.length > 0`, which collected any topic that was already pinless —
    // one a caller wrote with no members yet, or one the learner retired,
    // emptied and then un-retired — along with its signals, edges and
    // statements. Deleting one pin silently deleted an unrelated topic and the
    // comfort history behind it, and because it needs a pinless topic to be
    // sitting on the board at the same time it reads as an unreproducible
    // one-off rather than as a bug.
    const remaining = db.topics.flatMap((t) => {
      if (!t.pinIds.includes(id)) return [t];
      const pinIds = t.pinIds.filter((p) => p !== id);
      // A topic this deletion emptied is deleted, unless the learner retired it.
      return pinIds.length > 0 || t.retiredByUser || opts.keepEmptyTopic ? [{ ...t, pinIds }] : [];
    });
    // A topic this deletion emptied is deleted, and its history goes with it —
    // the same rule `deleteTopic` applies, for the same reason. The learner did
    // not delete "a pin": they deleted the last piece of evidence the topic was
    // built on, and SB-43 says a deletion reaches derived state. History under a
    // topic that can never surface again is not history, it is a permanent
    // residue of something the user asked to be rid of.
    //
    // Transitively through the alias map, exactly as a confirmed deletion does:
    // if the emptied topic was a merge TARGET, the histories merged into it are
    // part of what the learner saw as that one topic.
    //
    // A topic the learner retired is NOT emptied out from under them — it stays
    // on the board without pins by their own choice, so nothing here touches it.
    const live = new Set(remaining.map((t) => t.id));
    const emptied = db.topics.filter((t) => !live.has(t.id)).map((t) => t.id);
    const gone = new Set<TopicId>(
      emptied.flatMap((tid) => [tid, ...absorbedInto(tid, db.aliases)]));
    db.topics = remaining;
    // Cascade 2: signals traceable to this pin stop counting toward comfort,
    // and so does everything held by a topic this deletion emptied.
    db.signals = db.signals.filter((s) => !s.sourceEvent.includes(id) && !gone.has(s.topicId));
    if (gone.size) {
      db.edges = db.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
      db.statements = db.statements.filter((s) => s.topicId === null || !gone.has(s.topicId));
    }
    // Cascade 3: session provenance, so nothing already built keeps citing it.
    db.sessions = db.sessions.map((sess) => ({
      ...sess,
      sections: sess.sections.map((sec) => ({
        ...sec,
        sourceIds: sec.sourceIds.filter((sid) => !sid.startsWith(`${id}:`)),
      })),
    }));
    // Cascade 4: a topic dropped above may have been the target of a merge.
    this.pruneAliases(db);
    await this.save();
  }

  async putTopic(topic: Topic) {
    const db = await this.load();
    // Loud rather than silent. Writing under a retired id would resurrect it on
    // the board, and the alias map would then point live topics at each other.
    // The nightly stages are independently failure-tolerant (D10), so a throw
    // here degrades one stage instead of quietly re-detaching a history.
    if (isAbsorbed(topic.id, db.aliases)) {
      throw new TopicOpError('absorbed-topic',
        `${topic.id} was merged into ${resolveTopicId(topic.id, db.aliases)} and cannot be written`);
    }
    await this.upsert('topics', topic);
  }
  async getTopic(id: TopicId) {
    // The argument is resolved, not the result: a session, an edge or a panel
    // holding a pre-merge id must find the survivor rather than nothing.
    const db = await this.load();
    const resolved = resolveTopicId(id, db.aliases);
    return db.topics.find((t) => t.id === resolved) ?? null;
  }
  async mutateTopic(id: TopicId, change: (current: Topic) => Topic): Promise<Topic | null> {
    const slot = this.writing.then(async () => {
      const db = await this.load();
      if (isAbsorbed(id, db.aliases)) return null;
      const index = db.topics.findIndex((topic) => topic.id === id);
      if (index < 0) return null;
      const before = db.topics[index]!;
      const next = change(before);
      db.topics[index] = next;
      try { await this.writeCurrent(); return next; }
      catch (error) { db.topics[index] = before; throw error; }
    });
    this.writing = slot.then(() => undefined, () => undefined);
    return slot;
  }
  async listTopics() {
    const db = await this.load();
    // Absorbed ids are removed from `topics` by the merge itself. Filtering
    // again is what guarantees the clusterer can never see a retired topic and
    // therefore can never attach a new pin to one.
    return db.topics.filter((t) => !isAbsorbed(t.id, db.aliases));
  }
  async topicAliases(): Promise<AliasMap> { return { ...(await this.load()).aliases }; }

  /**
   * Merge, in one synchronous mutation between two awaits — the same atomicity
   * the rest of this class relies on, with the write itself serialised by the
   * queue in `save`.
   */
  async mergeTopics(keepId: TopicId, absorbId: TopicId): Promise<Topic> {
    const db = await this.load();
    const plan = planMerge(db.topics, db.aliases, keepId, absorbId);
    const moved = new Set(plan.movedPinIds);
    db.topics = db.topics
      .filter((t) => t.id !== plan.retiredTopicId)
      .map((t) => (t.id === plan.keep.id ? plan.keep : t));
    db.pins = db.pins.map((p) =>
      moved.has(p.id) || p.topicId === plan.retiredTopicId ? { ...p, topicId: plan.keep.id } : p);
    // The whole of the merge, as far as history is concerned. Signals,
    // statements, sessions and edges are untouched and resolve on read.
    db.aliases = { ...db.aliases, [plan.retiredTopicId]: plan.keep.id };
    await this.save();
    return plan.keep;
  }

  async splitTopic(topicId: TopicId, pinIds: readonly PinId[], newLabel: string): Promise<Topic> {
    const db = await this.load();
    const plan = planSplit(
      db.topics, db.pins, db.aliases, topicId, pinIds, newLabel,
      randomUUID(), new Date().toISOString(),
    );
    const moved = new Set(plan.movedPinIds);
    db.topics = db.topics.map((t) => (t.id === plan.original.id ? plan.original : t));
    db.topics.push(plan.created);
    db.pins = db.pins.map((p) => (moved.has(p.id) ? { ...p, topicId: plan.created.id } : p));
    // Signals are not touched, and that is the point: the original keeps every
    // one of them. The new topic starts with no evidence, which D14 made a safe
    // state to be in rather than one that reads as maximally overdue.
    await this.save();
    return plan.created;
  }

  async deleteTopic(id: TopicId, opts: { deletePins: boolean }) {
    const db = await this.load();
    // Deleting an id that has already been absorbed is a no-op. It no longer
    // names anything on the board, and resolving it would delete the survivor —
    // taking a live topic the user never pointed at.
    if (isAbsorbed(id, db.aliases)) return;
    const topic = db.topics.find((t) => t.id === id);
    if (!topic) return;
    // The deletion choice, stated: history merged INTO this topic goes with it.
    // The learner sees one topic and deletes one topic; the absorbed ids are an
    // implementation record of how it got that history, not separate things they
    // could have chosen to keep. The alternative — resurrecting the absorbed
    // topics so their signals survive — would put topics back on a board the
    // user just cleared, which is a worse surprise than losing merged history
    // they explicitly asked to delete.
    //
    // Captured before the pin cascade, because that cascade can empty the topic
    // and take the alias with it, leaving nothing here to read.
    const gone = new Set<TopicId>([id, ...absorbedInto(id, db.aliases)]);
    if (opts.deletePins) for (const pid of topic.pinIds) await this.deletePin(pid);
    const after = await this.load();
    after.topics = after.topics.filter((t) => t.id !== id);
    after.edges = after.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
    after.signals = after.signals.filter((s) => !gone.has(s.topicId));
    after.statements = after.statements.filter((s) => s.topicId === null || !gone.has(s.topicId));
    this.pruneAliases(after);
    await this.save();
  }

  /**
   * An alias must always terminate at a live topic. When the target dies — by
   * deletion, or by `deletePin` emptying it — the alias goes too. Left alone it
   * would resolve a live-looking topic id to one that is not on the board, and
   * `getTopic` would answer null for a topic that exists.
   *
   * This drops the alias and nothing else, deliberately, and the scope stays
   * narrow now that both cascades clear history for themselves. `deleteTopic`
   * and `deletePin` each compute what died — the topic plus everything absorbed
   * into it — and filter signals, edges and statements before calling this, so
   * by the time it runs there is no history left under the dead id to decide
   * about. A prune that deleted data as well would be deciding on behalf of
   * every future caller that loses an alias target for some other reason.
   */
  private pruneAliases(db: Db): void {
    const live = new Set(db.topics.map((t) => t.id));
    const dead = new Set(Object.keys(db.aliases).filter((k) => !live.has(resolveTopicId(k, db.aliases))));
    if (!dead.size) return;
    db.aliases = Object.fromEntries(Object.entries(db.aliases).filter(([k]) => !dead.has(k)));
  }

  async putEdges(edges: readonly PrereqEdge[]) {
    const db = await this.load();
    db.edges = [...edges];
    await this.save();
  }
  async listEdges() {
    const db = await this.load();
    const seen = new Set<string>();
    const out: PrereqEdge[] = [];
    for (const e of db.edges) {
      const from = resolveTopicId(e.from, db.aliases);
      const to = resolveTopicId(e.to, db.aliases);
      // A merge can collapse an edge onto itself — "you need A before B" is
      // meaningless once A and B are one topic. Dropping it is the only honest
      // reading; the Surveyor rebuilds the graph from the merged board anyway.
      if (from === to) continue;
      const key = `${from} ${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(from === e.from && to === e.to ? e : { ...e, from, to });
    }
    return out;
  }

  async appendSignal(signal: Signal) {
    const db = await this.load();
    db.signals.push(signal); // append-only: history is what makes SB-22 possible
    await this.save();
  }
  /**
   * Where the merge actually happens, as far as the learner is concerned.
   *
   * Rows come back carrying their RESOLVED topic id, so `computeComfort` —
   * which filters on `s.topicId === topicId` — sees both merged histories as
   * one and unions them with no knowledge of aliases at all. What is on disk is
   * unchanged: this is a projection, not a rewrite.
   */
  async listSignals(topicId?: TopicId) {
    const db = await this.load();
    const rows = db.signals.map((s) => resolveOn(s, db.aliases));
    if (topicId === undefined) return rows;
    const wanted = resolveTopicId(topicId, db.aliases);
    return rows.filter((x) => x.topicId === wanted);
  }
  async invalidateSignals(sourceEvent: string) {
    const db = await this.load();
    db.signals = db.signals.map((s) =>
      s.sourceEvent === sourceEvent ? { ...s, invalidated: true } : s);
    await this.save();
  }

  async putCommitment(c: Commitment) { await this.upsert('commitments', c); }
  async getCommitment(id: string) {
    const db = await this.load();
    return db.commitments.find((c) => c.id === id) ?? null;
  }
  async listCommitments() { return (await this.load()).commitments; }
  async deleteCommitment(id: string) {
    const db = await this.load();
    db.commitments = db.commitments.filter((c) => c.id !== id);
    // The awards it earned stay. They are a record of something the learner
    // actually did, and deleting the note about an assignment does not undo
    // having handed it in — a ledger that forgets on tidying up is one nobody
    // can trust a total from.
    await this.save();
  }
  async replaceCommitments(puts: readonly Commitment[], removeIds: readonly string[]) {
    const db = await this.load();
    const before = db.commitments;
    const removed = new Set(removeIds);
    const next = before.filter((c) => !removed.has(c.id));
    for (const c of puts) {
      const index = next.findIndex((row) => row.id === c.id);
      if (index >= 0) next[index] = c; else next.push(c);
    }
    db.commitments = next;
    try { await this.save(); }
    catch (error) {
      // A failed bounded mutation is absent from both disk and this live
      // handle. Without rollback, a read after ENOSPC would show a series the
      // service had truthfully told the learner was not saved.
      db.commitments = before;
      throw error;
    }
  }
  async appendAward(a: Award) {
    const db = await this.load();
    db.awards.push(a);
    await this.save();
  }
  async listAwards() { return (await this.load()).awards; }

  async putCourse(c: Course) { await this.upsert('courses', c); }
  async getCourse(id: string) {
    const db = await this.load();
    return db.courses.find((c) => c.id === id) ?? null;
  }
  async listCourses() { return (await this.load()).courses; }
  async deleteCourse(id: string) {
    const db = await this.load();
    db.courses = db.courses.filter((c) => c.id !== id);
    await this.save();
  }
  async replaceCourses(puts: readonly Course[], removeIds: readonly string[]) {
    const db = await this.load();
    const before = db.courses;
    const removed = new Set(removeIds);
    const next = before.filter((c) => !removed.has(c.id));
    for (const c of puts) {
      const index = next.findIndex((row) => row.id === c.id);
      if (index >= 0) next[index] = c; else next.push(c);
    }
    db.courses = next;
    try { await this.save(); }
    catch (error) {
      db.courses = before;
      throw error;
    }
  }

  async putIntakeDraft(draft: CourseIntakeDraft) { await this.upsert('intakeDrafts', draft); }
  async getIntakeDraft(id: string) {
    const db = await this.load();
    return db.intakeDrafts.find((d) => d.id === id) ?? null;
  }
  async listIntakeDrafts() { return [...(await this.load()).intakeDrafts]; }

  async putProspectProposal(proposal: ProspectProposal) { await this.upsert('prospects', proposal); }
  async getProspectProposal(id: string) {
    const db = await this.load();
    return db.prospects.find((p) => p.id === id) ?? null;
  }
  async listProspectProposals() { return [...(await this.load()).prospects]; }

  // The ring is read through the domain's own reader, so a hand-edited or
  // half-migrated file cannot put a malformed mark in front of the arithmetic.
  async getPassedOverLedger() { return readPassedOverLedger((await this.load()).passedOver); }
  async putPassedOverLedger(ledger: PassedOverLedger) {
    (await this.load()).passedOver = ledger;
    await this.save();
  }

  // What left for another surface. The removal is a plain filter and touches
  // nothing else: the learner was promised a row that goes away with nothing
  // recorded, and a cascade here would be the opposite of that promise.
  async putExternalEntry(entry: ExternalEntry) { await this.upsert('externals', entry); }
  async getExternalEntry(id: string) {
    const db = await this.load();
    return db.externals.find((e) => e.id === id) ?? null;
  }
  async listExternalEntries() { return [...(await this.load()).externals]; }
  async deleteExternalEntry(id: string) {
    const db = await this.load();
    db.externals = db.externals.filter((e) => e.id !== id);
    await this.save();
  }

  async putOutcome(outcome: LearningOutcome) { await this.upsert('outcomes', outcome); }
  async getOutcome(id: string) {
    const db = await this.load();
    return db.outcomes.find((o) => o.id === id) ?? null;
  }
  async listOutcomes() { return [...(await this.load()).outcomes]; }

  async putStatement(s: Statement) { await this.upsert('statements', s); }
  async listStatements() {
    const db = await this.load();
    return db.statements.map((s) => resolveOnNullable(s, db.aliases));
  }
  async deleteStatement(id: string) {
    const db = await this.load();
    db.statements = db.statements.filter((s) => s.id !== id);
    await this.save();
  }

  async putSession(s: Session) { await this.upsert('sessions', s); }
  async getSession(id: SessionId) {
    const db = await this.load();
    const found = db.sessions.find((s) => s.id === id);
    return found ? resolveSession(found, db.aliases) : null;
  }
  /**
   * The newest session, with the tie broken toward the one written last.
   *
   * `builtAt` is not unique. The nightly run is the local stand-in for a Cloud
   * Run Job, and a Job the platform retries writes a second session for the
   * same night — every stage in the retry reads the same clock, so both rows
   * can carry the same instant. A plain sort leaves that tie to insertion
   * order, which for a stable sort means the OLDER row wins: a run whose
   * Verifier could not run persists a session with no sections, the retry
   * persists the real one, and the panel keeps showing the empty one. The
   * learner is told there is nothing ready on a night the retry succeeded.
   *
   * A reduce rather than a sort, because the tie-break IS the behaviour here
   * and burying it in a comparator that returns 0 is what hid it.
   */
  async latestSession() {
    const db = await this.load();
    const latest = db.sessions.reduce<Session | null>(
      (best, s) => (best === null || s.builtAt.localeCompare(best.builtAt) >= 0 ? s : best), null);
    return latest ? resolveSession(latest, db.aliases) : null;
  }

  async listSessions() {
    const db = await this.load();
    return db.sessions.map((s) => resolveSession(s, db.aliases));
  }

  async putSuggestion(s: Suggestion) { await this.upsert('suggestions', s); }
  async listSuggestions(state?: Suggestion['state']) {
    const s = (await this.load()).suggestions;
    // Copied, not handed over. Every other read on this class already returns a
    // fresh array as a side effect of filtering or resolving aliases; this one
    // had nothing to do and returned the store's own array, so a caller's
    // `.push` or `.sort` mutated the board. Harmless today only because nobody
    // does it — and at port the same call returns a fresh array from Firestore,
    // so the difference would surface as a bug that reproduces on one
    // implementation and not the other.
    return state ? s.filter((x) => x.state === state) : [...s];
  }

  /**
   * Prefs, with anything the stored copy pre-dates filled in from the defaults.
   *
   * A field added to `LearnerPrefs` is absent from every store already on disk,
   * and the caller has a type that says it is there. Stored values always win —
   * an empty exclusion list the learner emptied on purpose stays empty — so this
   * only ever supplies keys that were never written.
   */
  async getPrefs() { return { ...DEFAULT_PREFS, ...(await this.load()).prefs }; }
  async mutatePrefs(change: (current: LearnerPrefs) => LearnerPrefs): Promise<LearnerPrefs> {
    const slot = this.writing.then(async () => {
      const db = await this.load();
      const before = db.prefs;
      const current = { ...DEFAULT_PREFS, ...before };
      const changed = change(current);
      const { hostedProcessing: _serviceOwned, ...learnerPrefs } = changed;
      const next: LearnerPrefs = {
        ...learnerPrefs,
        ...(before.hostedProcessing ? { hostedProcessing: before.hostedProcessing } : {}),
      };
      db.prefs = next;
      try {
        await this.writeCurrent();
        return { ...DEFAULT_PREFS, ...next };
      } catch (error) {
        db.prefs = before;
        throw error;
      }
    });
    this.writing = slot.then(() => undefined, () => undefined);
    return slot;
  }
  async putPrefs(prefs: LearnerPrefs) {
    const db = await this.load();
    const before = db.prefs;
    const {
      hostedProcessing: _serviceOwned,
      modelBudgetLease: _budgetCoordination,
      ...learnerPrefs
    } = prefs;
    db.prefs = {
      ...learnerPrefs,
      ...(before.hostedProcessing ? { hostedProcessing: before.hostedProcessing } : {}),
      ...(before.modelBudgetLease ? { modelBudgetLease: before.modelBudgetLease } : {}),
    };
    try { await this.save(); }
    catch (error) {
      db.prefs = before;
      throw error;
    }
  }
  async compareAndSetHostedProcessing(
    expected: HostedProcessingVersion | null,
    next: HostedProcessingReceipt,
  ): Promise<boolean> {
    const db = await this.load();
    const current = db.prefs.hostedProcessing ?? null;
    const matches = expected === null ? current === null : Boolean(current
      && current.receiptId === expected.receiptId
      && current.state === expected.state
      && current.checkedAt === expected.checkedAt);
    if (!matches) return false;
    const before = db.prefs;
    db.prefs = { ...db.prefs, hostedProcessing: next };
    try { await this.save(); }
    catch (error) {
      db.prefs = before;
      throw error;
    }
    return true;
  }

  async deleteEverything() {
    // The alias map goes with everything else. It is a record of decisions the
    // learner made about their board, so a full wipe has to clear it too.
    this.db = empty();
    // Resolve the single-flight load to the now-empty db, so any in-flight or
    // later reader sees the wipe rather than re-reading the file we replaced.
    this.loading = Promise.resolve(this.db);
    await this.save();
  }
}

/**
 * Session provenance, resolved — and handed back as the caller's own copy.
 *
 * A session built on Monday and merged on Tuesday still cites the pre-merge id.
 * Resolving it is what keeps "why am I seeing this?" pointing at a topic that
 * exists. Two sections can now resolve to the same topic id — that is a real
 * consequence of the merge and is left visible rather than collapsed, because
 * the sections are different pieces of writing the learner may already have
 * read.
 *
 * The `sections` array is always fresh, even when nothing needed resolving —
 * which is the common case, since most boards have never had a merge. Handing
 * back `session` itself on that path used to mean `getSession`, `latestSession`
 * and `listSessions` all leaked a live reference to this store's own
 * `sections` array: the same failure `listSuggestions` was fixed for, one level
 * deeper, and reachable through the read `progressionSnapshot` (§5a) takes on
 * every request.
 */
function resolveSession(session: Session, aliases: AliasMap): Session {
  const sections = session.sections.map((s) => resolveOn(s, aliases));
  return { ...session, sections };
}
