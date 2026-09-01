import type {
  Pin, PinId, Topic, TopicId, PrereqEdge, Signal, Statement,
  Session, SessionId, Suggestion, LearnerPrefs, HostedProcessingReceipt,
} from '../domain/types.js';
import type { Award, Commitment } from '../domain/commitments.js';
import type { Course } from '../domain/courses.js';
import type { CourseIntakeDraft } from '../domain/intake.js';
import type { ProspectProposal } from '../domain/prospect.js';
import type { PassedOverLedger } from '../domain/avoidance.js';
import type { ExternalEntry } from '../domain/external.js';
import type { LearningOutcome } from '../domain/outcomes.js';
import type { AliasMap } from '../domain/aliases.js';

/**
 * The persistence seam. Local JSON/SQLite now, Firestore at port.
 *
 * SB-43 is the reason `deletePin` and `deleteTopic` are on this interface
 * rather than left to callers: deletion must propagate into the signal ledger,
 * topic membership and session history. A deleted pin still shaping tomorrow's
 * session is a broken promise, and this is genuinely painful to retrofit — so
 * it is in the contract from the first commit.
 *
 * `mergeTopics` and `splitTopic` are on it for the same reason. A merge retires
 * a topic id without rewriting one signal, and every read of a topic id has to
 * resolve through the alias map for the comfort history to follow. Leaving that
 * resolution to callers means one caller forgets, and a learner's history
 * silently detaches from the thing it was about — which is the exact failure
 * D15 was fought to prevent.
 */
export interface Store {
  // pins
  putPin(pin: Pin): Promise<void>;
  getPin(id: PinId): Promise<Pin | null>;
  /** Atomic field-preserving pin update for work that crosses an await. */
  mutatePin?(id: PinId, change: (current: Pin) => Pin): Promise<Pin | null>;
  /**
   * `unenrichedOnly` means "owed an enrichment attempt", which is not the same
   * as "has no enrichment record". A pin whose model call failed carries a
   * capture-envelope-only enrichment and is owed another attempt; a pin the
   * model read and found self-contained is not — the model answered, and asking
   * it the same question every night for ever would be paying to be told the
   * same thing. `outcome` is what separates the two.
   */
  listPins(opts?: { unenrichedOnly?: boolean }): Promise<readonly Pin[]>;
  /** Cascades: signals, topic membership, session provenance. */
  deletePin(id: PinId, opts?: { keepEmptyTopic?: boolean }): Promise<void>;

  // topics
  putTopic(topic: Topic): Promise<void>;
  getTopic(id: TopicId): Promise<Topic | null>;
  /** Atomic field-preserving topic update for work that crosses an await. */
  mutateTopic?(id: TopicId, change: (current: Topic) => Topic): Promise<Topic | null>;
  listTopics(): Promise<readonly Topic[]>;
  /** Cascades to member pins on explicit confirmation (SB-43). */
  deleteTopic(id: TopicId, opts: { deletePins: boolean }): Promise<void>;

  // topic identity repair — the user's control, confirmed and never silent.
  /**
   * `absorbId`'s pins move to `keepId`; `absorbId` is retired into the alias
   * map. Signals are NOT rewritten — the ledger is append-only — so both
   * histories are unioned by resolving topic ids on read. `keepId` keeps its own
   * label and summary. Returns the survivor.
   */
  mergeTopics(keepId: TopicId, absorbId: TopicId): Promise<Topic>;
  /**
   * `pinIds` move out of `topicId` into a new topic the user has named. All of
   * the signal history stays with the original: comfort is not divisible, and
   * splitting it would fabricate evidence about which half of a topic a past
   * answer was about. Rejects a split that would empty the original. Returns the
   * created topic.
   */
  splitTopic(topicId: TopicId, pinIds: readonly PinId[], newLabel: string): Promise<Topic>;
  /** `absorbedId -> keptId`, one entry per merge. Chains are real and are not
   *  compressed; resolve with `resolveTopicId`. */
  topicAliases(): Promise<AliasMap>;

  // prerequisite graph
  putEdges(edges: readonly PrereqEdge[]): Promise<void>;
  listEdges(): Promise<readonly PrereqEdge[]>;

  // signals — append-only; history is what makes regression detectable (SB-22)
  appendSignal(signal: Signal): Promise<void>;
  listSignals(topicId?: TopicId): Promise<readonly Signal[]>;
  invalidateSignals(sourceEvent: string): Promise<void>;

  // learner model statements (SB-42)
  putStatement(statement: Statement): Promise<void>;
  listStatements(): Promise<readonly Statement[]>;
  deleteStatement(id: string): Promise<void>;

  // sessions
  putSession(session: Session): Promise<void>;
  getSession(id: SessionId): Promise<Session | null>;
  latestSession(): Promise<Session | null>;
  /**
   * Every session ever built, in no promised order.
   *
   * Here for the progression projection (§5a), which states one of its four
   * badges — *medium follow-through* — from a warning shown on one night and a
   * recall demonstrated on a later one. `latestSession` cannot see that, and
   * the alternative was writing a second record of the same fact somewhere the
   * projection could reach, which would be a gamification surface writing to
   * the ledger: the one thing §5a exists to forbid.
   *
   * A read, and only ever a read. Callers cap what they take.
   */
  listSessions(): Promise<readonly Session[]>;

  // suggestions (SB-15/16)
  putSuggestion(s: Suggestion): Promise<void>;
  listSuggestions(state?: Suggestion['state']): Promise<readonly Suggestion[]>;

  /**
   * Commitments and awards — the second ledger (`domain/commitments.ts`).
   *
   * Deliberately beside the signal ledger rather than inside it. What somebody
   * says they will do and what they have demonstrated are different kinds of
   * claim, and the first must never be able to reach the machinery that reads
   * the second.
   *
   * `listAwards` is a read of an append-only list, like `listSignals`. There is
   * no `deleteAward` and no way to spend or lose points: a total nobody can
   * lose is a total nobody has to protect.
   */
  putCommitment(c: Commitment): Promise<void>;
  getCommitment(id: string): Promise<Commitment | null>;
  listCommitments(): Promise<readonly Commitment[]>;
  deleteCommitment(id: string): Promise<void>;
  /** One bounded Plan mutation. Recurring-series creation/edit/stop must never
   * publish half a semester. Implementations apply all puts and removals as one
   * local save or one Firestore batch; callers keep this below 40 writes. */
  replaceCommitments(puts: readonly Commitment[], removeIds: readonly string[]): Promise<void>;
  appendAward(a: Award): Promise<void>;
  listAwards(): Promise<readonly Award[]>;

  /** Courses and their material (`domain/courses.ts`). */
  putCourse(c: Course): Promise<void>;
  getCourse(id: string): Promise<Course | null>;
  listCourses(): Promise<readonly Course[]>;
  deleteCourse(id: string): Promise<void>;
  /** One bounded shelf mutation. A material move must never duplicate or lose
   * the row between its source and destination courses. */
  replaceCourses(puts: readonly Course[], removeIds: readonly string[]): Promise<void>;

  /** Review boundary for messy-source intake. Drafts write no course state. */
  putIntakeDraft(draft: CourseIntakeDraft): Promise<void>;
  getIntakeDraft(id: string): Promise<CourseIntakeDraft | null>;
  listIntakeDrafts(): Promise<readonly CourseIntakeDraft[]>;

  /**
   * Review boundary for the one stage that looks outward.
   *
   * Beside the intake drafts rather than inside them, because they are
   * different claims: a draft is a plan read out of a document the learner
   * handed over, and a prospect proposal is a suggestion that they collect
   * something they never had. Both are proposals and neither writes anything
   * authoritative, which is why they share a review surface and not a record.
   */
  putProspectProposal(proposal: ProspectProposal): Promise<void>;
  getProspectProposal(id: string): Promise<ProspectProposal | null>;
  listProspectProposals(): Promise<readonly ProspectProposal[]>;

  /**
   * The passed-over ledger, read and written whole.
   *
   * One record rather than a collection, and that is the shape of the thing
   * rather than a shortcut: it is a fixed-size ring of the last two hundred
   * marks, and the trim is a rule in `domain/avoidance.ts` that both stores
   * must obey identically. A collection would put the eviction rule in the
   * adapters, where two backends could disagree about which marks survived.
   *
   * A board that has never written one reads as `EMPTY_PASSED_OVER_LEDGER`,
   * which is the honest answer: nothing has been counted yet.
   */
  getPassedOverLedger(): Promise<PassedOverLedger>;
  putPassedOverLedger(ledger: PassedOverLedger): Promise<void>;

  /**
   * What the learner took to another surface, and what they made of it.
   *
   * A collection rather than a field on preferences, because it is a history
   * with rows the learner adds and removes one at a time, and because the one
   * operation the learner is promised on it is a removal that writes nothing
   * else. `deleteExternalEntry` is on this interface for the same reason
   * `deletePin` is: it must remove the row and touch no ledger, and a caller
   * that had to remember not to write would eventually forget.
   */
  putExternalEntry(entry: ExternalEntry): Promise<void>;
  getExternalEntry(id: string): Promise<ExternalEntry | null>;
  listExternalEntries(): Promise<readonly ExternalEntry[]>;
  deleteExternalEntry(id: string): Promise<void>;

  /** Real-world learning evidence. Corrections supersede; they do not erase. */
  putOutcome(outcome: LearningOutcome): Promise<void>;
  getOutcome(id: string): Promise<LearningOutcome | null>;
  listOutcomes(): Promise<readonly LearningOutcome[]>;

  // preferences
  getPrefs(): Promise<LearnerPrefs>;
  putPrefs(prefs: LearnerPrefs): Promise<void>;
  /**
   * Read and replace learner preferences as one store-owned operation.
   *
   * Optional only for small third-party/test stores written before this
   * primitive existed. Both shipped stores implement it. Firestore executes
   * the callback inside its retryable transaction, so the Service and Job do
   * not overwrite one another with snapshots read before either process
   * started its write.
   */
  mutatePrefs?(change: (current: LearnerPrefs) => LearnerPrefs): Promise<LearnerPrefs>;
  /**
   * Replace only the deployment-local worker receipt when the stored version
   * still matches. This is a store primitive, not a read-then-write helper:
   * the hosted service and Job are different processes, and a late worker must
   * not overwrite either a newer dispatch or a concurrent learner preference.
   */
  compareAndSetHostedProcessing(
    expected: HostedProcessingVersion | null,
    next: HostedProcessingReceipt,
  ): Promise<boolean>;

  /** SB-43: full wipe, one confirmed action. */
  deleteEverything(): Promise<void>;
}

/** Small optimistic-concurrency token; no worker payload or learner data. */
export type HostedProcessingVersion = Pick<
  HostedProcessingReceipt,
  'receiptId' | 'state' | 'checkedAt'
>;

/** Use the store's cross-process mutation primitive where it has one. */
export async function mutateLearnerPrefs(
  store: Pick<Store, 'getPrefs' | 'putPrefs' | 'mutatePrefs'>,
  change: (current: LearnerPrefs) => LearnerPrefs,
): Promise<LearnerPrefs> {
  if (store.mutatePrefs) return store.mutatePrefs(change);
  const current = await store.getPrefs();
  const next = change(current);
  await store.putPrefs(next);
  return next;
}

export async function mutateStoredPin(
  store: Pick<Store, 'getPin' | 'putPin' | 'mutatePin'>,
  id: PinId,
  change: (current: Pin) => Pin,
): Promise<Pin | null> {
  if (store.mutatePin) return store.mutatePin(id, change);
  const current = await store.getPin(id);
  if (!current) return null;
  const next = change(current);
  await store.putPin(next);
  return next;
}

export async function mutateStoredTopic(
  store: Pick<Store, 'getTopic' | 'putTopic' | 'mutateTopic'>,
  id: TopicId,
  change: (current: Topic) => Topic,
): Promise<Topic | null> {
  if (store.mutateTopic) return store.mutateTopic(id, change);
  const current = await store.getTopic(id);
  if (!current) return null;
  const next = change(current);
  await store.putTopic(next);
  return next;
}
