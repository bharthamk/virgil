import { randomUUID } from 'node:crypto';
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

/**
 * A reference `Store`, in memory, written to the contract and to nothing else.
 *
 * **A test fixture. Not exported from the package and constructed in no
 * composition root** — `runner/src/__tests__/seam-purity.test.ts` guards the
 * roots, and nothing here may become a thing the product runs on.
 *
 * ## Why a second implementation exists at all
 *
 * `store-contract.ts` was written against `JsonStore`, and a contract with one
 * implementation is a description of that implementation. Every assertion in it
 * is a promise the product makes, but nothing so far distinguishes "the promise"
 * from "what the local store happens to do" — and the whole point of the
 * contract is to be the thing a *Firestore* store is held to, before anybody
 * writes it against a live project.
 *
 * So this is the oracle. It shares no storage code with `JsonStore`: no file, no
 * temp-and-rename, no single-flight load, no write queue. What it does share is
 * `core`'s domain helpers — `planMerge`, `planSplit`, `resolveTopicId` — and that
 * sharing is the interesting result. Everything left over after those helpers is
 * *storage*, and everything the two implementations must agree on is *product
 * rule*. The contract passing against both is what makes that split checkable
 * rather than asserted.
 *
 * ## What it is deliberately stricter about
 *
 * Every value is cloned on the way in and on the way out. A local store can hand
 * back its own objects and nothing notices; Firestore cannot, because the value
 * crossed a network and is always fresh. Cloning here means an accidental
 * dependency on shared references fails against this store first — in
 * milliseconds, on a laptop — rather than at port, on a bill.
 */

/** Its own defaults, on purpose: an oracle that imported them would be checking
 *  the store it exists to check. Only the rules the contract states are kept. */
const DEFAULTS: LearnerPrefs = {
  targetMinutes: 15,
  interfaceLanguage: 'en',
  pausedUntil: null,
  excludedDomains: ['mail.google.com', 'nhs.uk'],
  interview: {},
  rejectedOrigins: {},
};

/** Structured clone, so nothing the caller holds is ever the store's own object. */
const copy = <T>(value: T): T => structuredClone(value) as T;

export class MemoryStore implements Store {
  private pins: Pin[] = [];
  private topics: Topic[] = [];
  private edges: PrereqEdge[] = [];
  private signals: Signal[] = [];
  private statements: Statement[] = [];
  private sessions: Session[] = [];
  private suggestions: Suggestion[] = [];
  private commitments: Commitment[] = [];
  private awards: Award[] = [];
  private courses: Course[] = [];
  private intakeDrafts: CourseIntakeDraft[] = [];
  private prospects: ProspectProposal[] = [];
  private externals: ExternalEntry[] = [];
  private outcomes: LearningOutcome[] = [];
  private passedOver: PassedOverLedger = EMPTY_PASSED_OVER_LEDGER;
  private prefs: LearnerPrefs = DEFAULTS;
  private aliases: Record<TopicId, TopicId> = {};

  private upsert<T extends { id: string }>(arr: T[], item: T): void {
    const i = arr.findIndex((x) => x.id === item.id);
    if (i >= 0) arr[i] = copy(item); else arr.push(copy(item));
  }

  // ------------------------------------------------------------------- pins

  async putPin(pin: Pin): Promise<void> {
    // Membership is derived state, so it resolves on write: a stage that read
    // the board before a merge must not write a pin back onto the retired id.
    this.upsert(this.pins, resolveOnNullable(pin, this.aliases));
  }

  async getPin(id: PinId): Promise<Pin | null> {
    const pin = this.pins.find((p) => p.id === id);
    return pin ? copy(resolveOnNullable(pin, this.aliases)) : null;
  }

  async listPins(opts?: { unenrichedOnly?: boolean }): Promise<readonly Pin[]> {
    const pins = opts?.unenrichedOnly ? this.pins.filter(owedEnrichment) : this.pins;
    return pins.map((p) => copy(resolveOnNullable(p, this.aliases)));
  }

  async deletePin(id: PinId, opts: { keepEmptyTopic?: boolean } = {}): Promise<void> {
    this.pins = this.pins.filter((p) => p.id !== id);

    // Membership, and the topics this emptied. A topic the learner retired by
    // hand stays; a topic whose last piece of evidence just went does not.
    const remaining = this.topics
      .map((t) => ({ ...t, pinIds: t.pinIds.filter((p) => p !== id) }))
      .filter((t) => t.pinIds.length > 0 || t.retiredByUser || opts.keepEmptyTopic);
    const live = new Set(remaining.map((t) => t.id));
    const gone = new Set<TopicId>(this.topics
      .filter((t) => !live.has(t.id))
      .flatMap((t) => [t.id, ...absorbedInto(t.id, this.aliases)]));
    this.topics = remaining;

    // Comfort: nothing traceable to a deleted pin, and nothing held by a topic
    // that deletion emptied, may keep counting.
    this.signals = this.signals.filter((s) => !s.sourceEvent.includes(id) && !gone.has(s.topicId));
    if (gone.size) {
      this.edges = this.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
      this.statements = this.statements.filter((s) => s.topicId === null || !gone.has(s.topicId));
    }
    // Provenance: nothing already built may keep citing it.
    this.sessions = this.sessions.map((sess) => ({
      ...sess,
      sections: sess.sections.map((sec) => ({
        ...sec,
        sourceIds: sec.sourceIds.filter((sid) => !sid.startsWith(`${id}:`)),
      })),
    }));
    this.pruneAliases();
  }

  // ----------------------------------------------------------------- topics

  async putTopic(topic: Topic): Promise<void> {
    if (isAbsorbed(topic.id, this.aliases)) {
      throw new TopicOpError('absorbed-topic',
        `${topic.id} was merged into ${resolveTopicId(topic.id, this.aliases)} and cannot be written`);
    }
    this.upsert(this.topics, topic);
  }

  async getTopic(id: TopicId): Promise<Topic | null> {
    // The ARGUMENT resolves, so a panel holding a pre-merge id finds the
    // survivor rather than nothing.
    const resolved = resolveTopicId(id, this.aliases);
    const topic = this.topics.find((t) => t.id === resolved);
    return topic ? copy(topic) : null;
  }

  async mutateTopic(id: TopicId, change: (current: Topic) => Topic): Promise<Topic | null> {
    if (isAbsorbed(id, this.aliases)) return null;
    const index = this.topics.findIndex((topic) => topic.id === id);
    if (index < 0) return null;
    const next = change(copy(this.topics[index]!));
    this.topics[index] = copy(next);
    return copy(next);
  }

  async listTopics(): Promise<readonly Topic[]> {
    return this.topics.filter((t) => !isAbsorbed(t.id, this.aliases)).map(copy);
  }

  async topicAliases(): Promise<AliasMap> { return { ...this.aliases }; }

  async mergeTopics(keepId: TopicId, absorbId: TopicId): Promise<Topic> {
    const plan = planMerge(this.topics, this.aliases, keepId, absorbId);
    const moved = new Set(plan.movedPinIds);
    this.topics = this.topics
      .filter((t) => t.id !== plan.retiredTopicId)
      .map((t) => (t.id === plan.keep.id ? plan.keep : t));
    this.pins = this.pins.map((p) =>
      moved.has(p.id) || p.topicId === plan.retiredTopicId ? { ...p, topicId: plan.keep.id } : p);
    // The whole of the merge as far as history is concerned. The ledger is
    // append-only; signals, statements, sessions and edges resolve on read.
    this.aliases = { ...this.aliases, [plan.retiredTopicId]: plan.keep.id };
    return copy(plan.keep);
  }

  async splitTopic(topicId: TopicId, pinIds: readonly PinId[], newLabel: string): Promise<Topic> {
    const plan = planSplit(
      this.topics, this.pins, this.aliases, topicId, pinIds, newLabel,
      randomUUID(), new Date().toISOString(),
    );
    const moved = new Set(plan.movedPinIds);
    this.topics = this.topics.map((t) => (t.id === plan.original.id ? plan.original : t));
    this.topics.push(plan.created);
    this.pins = this.pins.map((p) => (moved.has(p.id) ? { ...p, topicId: plan.created.id } : p));
    // Signals stay with the original. Comfort is not divisible.
    return copy(plan.created);
  }

  async deleteTopic(id: TopicId, opts: { deletePins: boolean }): Promise<void> {
    // An id that has already been absorbed names nothing on the board;
    // resolving it would delete the survivor the user never pointed at.
    if (isAbsorbed(id, this.aliases)) return;
    const topic = this.topics.find((t) => t.id === id);
    if (!topic) return;
    // Captured before the pin cascade, which can empty the topic and take the
    // alias with it.
    const gone = new Set<TopicId>([id, ...absorbedInto(id, this.aliases)]);
    if (opts.deletePins) for (const pid of [...topic.pinIds]) await this.deletePin(pid);
    this.topics = this.topics.filter((t) => t.id !== id);
    this.edges = this.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
    this.signals = this.signals.filter((s) => !gone.has(s.topicId));
    this.statements = this.statements.filter((s) => s.topicId === null || !gone.has(s.topicId));
    this.pruneAliases();
  }

  /** An alias must always terminate at a live topic, or `getTopic` answers null
   *  for a topic that is on the board. */
  private pruneAliases(): void {
    const live = new Set(this.topics.map((t) => t.id));
    this.aliases = Object.fromEntries(Object.entries(this.aliases)
      .filter(([k]) => live.has(resolveTopicId(k, this.aliases))));
  }

  // ------------------------------------------------------------------ edges

  async putEdges(edges: readonly PrereqEdge[]): Promise<void> { this.edges = copy([...edges]); }

  async listEdges(): Promise<readonly PrereqEdge[]> {
    const seen = new Set<string>();
    const out: PrereqEdge[] = [];
    for (const e of this.edges) {
      const from = resolveTopicId(e.from, this.aliases);
      const to = resolveTopicId(e.to, this.aliases);
      // A merge can collapse an edge onto itself; "A before B" means nothing
      // once A and B are one topic.
      if (from === to) continue;
      const key = `${from} ${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(copy({ ...e, from, to }));
    }
    return out;
  }

  // ----------------------------------------------------------------- ledger

  async appendSignal(signal: Signal): Promise<void> { this.signals.push(copy(signal)); }

  async listSignals(topicId?: TopicId): Promise<readonly Signal[]> {
    const rows = this.signals.map((s) => copy(resolveOn(s, this.aliases)));
    if (topicId === undefined) return rows;
    const wanted = resolveTopicId(topicId, this.aliases);
    return rows.filter((x) => x.topicId === wanted);
  }

  async invalidateSignals(sourceEvent: string): Promise<void> {
    // A flag, never a delete: the row is the evidence.
    this.signals = this.signals.map((s) =>
      s.sourceEvent === sourceEvent ? { ...s, invalidated: true } : s);
  }

  // ------------------------------------------------------------- statements

  async putCommitment(c: Commitment): Promise<void> { this.upsert(this.commitments, c); }
  async getCommitment(id: string): Promise<Commitment | null> {
    const found = this.commitments.find((c) => c.id === id);
    return found ? copy(found) : null;
  }
  async listCommitments(): Promise<readonly Commitment[]> { return this.commitments.map(copy); }
  async deleteCommitment(id: string): Promise<void> {
    // The awards survive: they record something the learner did, and deleting
    // the note about an assignment does not undo having handed it in.
    this.commitments = this.commitments.filter((c) => c.id !== id);
  }
  async replaceCommitments(puts: readonly Commitment[], removeIds: readonly string[]): Promise<void> {
    const removed = new Set(removeIds);
    this.commitments = this.commitments.filter((c) => !removed.has(c.id));
    for (const c of puts) this.upsert(this.commitments, c);
  }
  async appendAward(a: Award): Promise<void> { this.awards.push(copy(a)); }
  async listAwards(): Promise<readonly Award[]> { return this.awards.map(copy); }

  async putCourse(c: Course): Promise<void> { this.upsert(this.courses, c); }
  async getCourse(id: string): Promise<Course | null> {
    const found = this.courses.find((c) => c.id === id);
    return found ? copy(found) : null;
  }
  async listCourses(): Promise<readonly Course[]> { return this.courses.map(copy); }
  async deleteCourse(id: string): Promise<void> {
    this.courses = this.courses.filter((c) => c.id !== id);
  }
  async replaceCourses(puts: readonly Course[], removeIds: readonly string[]): Promise<void> {
    const removed = new Set(removeIds);
    this.courses = this.courses.filter((c) => !removed.has(c.id));
    for (const c of puts) this.upsert(this.courses, c);
  }

  async putIntakeDraft(draft: CourseIntakeDraft): Promise<void> { this.upsert(this.intakeDrafts, draft); }
  async getIntakeDraft(id: string): Promise<CourseIntakeDraft | null> {
    const found = this.intakeDrafts.find((d) => d.id === id);
    return found ? copy(found) : null;
  }
  async listIntakeDrafts(): Promise<readonly CourseIntakeDraft[]> { return this.intakeDrafts.map(copy); }

  async putProspectProposal(proposal: ProspectProposal): Promise<void> {
    this.upsert(this.prospects, proposal);
  }
  async getProspectProposal(id: string): Promise<ProspectProposal | null> {
    const found = this.prospects.find((p) => p.id === id);
    return found ? copy(found) : null;
  }
  async listProspectProposals(): Promise<readonly ProspectProposal[]> {
    return this.prospects.map(copy);
  }

  async getPassedOverLedger(): Promise<PassedOverLedger> {
    return readPassedOverLedger(copy(this.passedOver));
  }
  async putPassedOverLedger(ledger: PassedOverLedger): Promise<void> {
    this.passedOver = copy(ledger);
  }

  async putExternalEntry(entry: ExternalEntry): Promise<void> { this.upsert(this.externals, entry); }
  async getExternalEntry(id: string): Promise<ExternalEntry | null> {
    const found = this.externals.find((e) => e.id === id);
    return found ? copy(found) : null;
  }
  async listExternalEntries(): Promise<readonly ExternalEntry[]> { return this.externals.map(copy); }
  async deleteExternalEntry(id: string): Promise<void> {
    this.externals = this.externals.filter((e) => e.id !== id);
  }

  async putOutcome(outcome: LearningOutcome): Promise<void> { this.upsert(this.outcomes, outcome); }
  async getOutcome(id: string): Promise<LearningOutcome | null> {
    const found = this.outcomes.find((o) => o.id === id);
    return found ? copy(found) : null;
  }
  async listOutcomes(): Promise<readonly LearningOutcome[]> { return this.outcomes.map(copy); }

  async putStatement(statement: Statement): Promise<void> { this.upsert(this.statements, statement); }
  async listStatements(): Promise<readonly Statement[]> {
    return this.statements.map((s) => copy(resolveOnNullable(s, this.aliases)));
  }
  async deleteStatement(id: string): Promise<void> {
    this.statements = this.statements.filter((s) => s.id !== id);
  }

  // --------------------------------------------------------------- sessions

  async putSession(session: Session): Promise<void> { this.upsert(this.sessions, session); }

  async getSession(id: SessionId): Promise<Session | null> {
    const found = this.sessions.find((s) => s.id === id);
    return found ? copy(this.resolveSession(found)) : null;
  }

  /** Newest by `builtAt`, with the tie broken toward the row written last — a
   *  retried nightly Job writes a second session for the same instant, and the
   *  real one is the later write. */
  async latestSession(): Promise<Session | null> {
    const latest = this.sessions.reduce<Session | null>(
      (best, s) => (best === null || s.builtAt.localeCompare(best.builtAt) >= 0 ? s : best), null);
    return latest ? copy(this.resolveSession(latest)) : null;
  }

  async listSessions(): Promise<readonly Session[]> {
    return this.sessions.map((s) => copy(this.resolveSession(s)));
  }

  private resolveSession(session: Session): Session {
    return { ...session, sections: session.sections.map((s) => resolveOn(s, this.aliases)) };
  }

  // ------------------------------------------------------------ suggestions

  async putSuggestion(s: Suggestion): Promise<void> { this.upsert(this.suggestions, s); }
  async listSuggestions(state?: Suggestion['state']): Promise<readonly Suggestion[]> {
    return (state ? this.suggestions.filter((x) => x.state === state) : this.suggestions).map(copy);
  }

  // ------------------------------------------------------------------ prefs

  /** Defaults fill only keys that were never written; a list the learner
   *  emptied on purpose stays empty. */
  async getPrefs(): Promise<LearnerPrefs> { return copy({ ...DEFAULTS, ...this.prefs }); }
  async putPrefs(prefs: LearnerPrefs): Promise<void> {
    const { hostedProcessing: _serviceOwned, ...learnerPrefs } = prefs;
    this.prefs = copy({
      ...learnerPrefs,
      ...(this.prefs.hostedProcessing ? { hostedProcessing: this.prefs.hostedProcessing } : {}),
    });
  }
  async compareAndSetHostedProcessing(
    expected: HostedProcessingVersion | null,
    next: HostedProcessingReceipt,
  ): Promise<boolean> {
    const current = this.prefs.hostedProcessing ?? null;
    const matches = expected === null ? current === null : Boolean(current
      && current.receiptId === expected.receiptId
      && current.state === expected.state
      && current.checkedAt === expected.checkedAt);
    if (!matches) return false;
    this.prefs = { ...this.prefs, hostedProcessing: copy(next) };
    return true;
  }

  async deleteEverything(): Promise<void> {
    this.pins = []; this.topics = []; this.edges = []; this.signals = [];
    this.statements = []; this.sessions = []; this.suggestions = [];
    // SB-43 is a full wipe, and the second ledger is the learner's too.
    this.commitments = []; this.awards = []; this.courses = [];
    this.intakeDrafts = []; this.prospects = []; this.externals = []; this.outcomes = [];
    this.passedOver = EMPTY_PASSED_OVER_LEDGER;
    // The alias map is a record of decisions about the board, so it goes too.
    this.aliases = {};
    this.prefs = DEFAULTS;
  }
}
