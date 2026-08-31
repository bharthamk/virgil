import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  computeComfort, coursePulse, recordModalityDenial, recordPassedOver, recordSetAside,
  mutateLearnerPrefs, registerFor, slippingRows,
  statementEndorsed, subjectForTopic, topicsNamedIn,
  AVOID_MAX_SURFACED, LEARNER_STATEMENT_MAX_CHARS, MODALITY_DENIED_DAYS,
  type AvoidanceCandidate, type Deps, type PassedOverMark, type Statement, type Topic,
} from '@sb/core';
import { readSlippingRecords, slippingFrom } from './today-source.js';

type Store = Deps['store'];

export interface LearnerModelRouteContext {
  readonly store: Store;
  /** The whole dependency set, for the reads the slipping list needs. */
  readonly deps: Deps;
  readonly nowIso: () => string;
  readonly timeZone: () => Promise<string>;
  readonly readBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  readonly requireText: (
    body: Record<string, unknown>, field: string, maxChars: number, label: string,
  ) => string;
  readonly receiptId: (kind: string, clientRef: unknown) => string | null;
  readonly pathId: (match: RegExpExecArray, index: number) => string;
  readonly reply: (res: ServerResponse, code: number, body: unknown) => void;
  readonly badRequest: (message: string) => never;
  readonly newId: () => string;
}

/**
 * A well-formed item key, and nothing else, may reach the deferral record.
 *
 * The record is a map keyed by whatever arrives, so an unbounded key is an
 * unbounded document. The three prefixes are the only kinds `avoidanceKey`
 * produces; anything else is a client sending something this product does not
 * have a row for.
 */
const SLIPPING_KEY = /^(?:material|recall|commitment):.{1,200}$/;

/** The ranker's own action ids, bounded the same way for the same reason. */
const ACTION_ID_MAX_CHARS = 200;

const boundedId = (value: unknown): string | null => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= ACTION_ID_MAX_CHARS ? text : null;
};

/**
 * The Insights room's doors.
 *
 * The learner-editable model is one HTTP resource with four operations, and it
 * is deliberately separate from model-provider configuration and model budgets:
 * those are installation controls, while these statements are learner data.
 *
 * The slipping lanes are under `/model/slipping` rather than in a router of
 * their own because they are the same room's data and the same room's writes:
 * `GET /model` already carries the deterministic cross-course pulse this screen
 * draws, and what keeps slipping is the second block on it. Two of the three
 * are writes and both are small, bounded and learner-initiated:
 *
 *  - `set-aside` is the learner saying a row is theirs to leave alone. It goes
 *    into preferences beside `pausedUntil`, never into the signal ledger.
 *  - `passed-over` is the forward-only mark, written when a person starts one
 *    thing while a different thing was the offer. It is a ring of two hundred
 *    and it makes no claim about anything before its own first entry.
 */
export async function handleLearnerModelRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: LearnerModelRouteContext,
): Promise<boolean> {
  if (req.method === 'POST' && url.pathname === '/model/slipping/set-aside') {
    const body = await ctx.readBody(req);
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!SLIPPING_KEY.test(key)) {
      ctx.reply(res, 400, { error: 'key must name one item on your board' });
      return true;
    }
    await mutateLearnerPrefs(ctx.store, (prefs) => ({
      ...prefs, setAside: recordSetAside(prefs.setAside, key, new Date(ctx.nowIso())),
    }));
    ctx.reply(res, 200, { ok: true, key });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/model/slipping/passed-over') {
    const body = await ctx.readBody(req);
    const offeredId = boundedId(body.offeredId);
    const chosenId = boundedId(body.chosenId);
    // A mark that names one action twice is not a pass over, it is the learner
    // pressing the thing that was offered. Refused rather than stored, because
    // a ledger that counted those would report everybody as avoiding everything.
    if (!offeredId || !chosenId || offeredId === chosenId) {
      ctx.reply(res, 400, { error: 'offeredId and chosenId must name two different actions' });
      return true;
    }
    const mark: PassedOverMark = {
      offeredId,
      offeredReason: boundedId(body.offeredReason) ?? 'unstated',
      chosenId,
      at: ctx.nowIso(),
    };
    await ctx.store.putPassedOverLedger(
      recordPassedOver(await ctx.store.getPassedOverLedger(), mark),
    );
    ctx.reply(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/model') {
    const [statements, pins, signals, topics, courses, commitments, outcomes, timeZone,
      prefs, ledger, slippingRecords] = await Promise.all([
      ctx.store.listStatements(), ctx.store.listPins(), ctx.store.listSignals(),
      ctx.store.listTopics(), ctx.store.listCourses(), ctx.store.listCommitments(),
      ctx.store.listOutcomes(), ctx.timeZone(),
      ctx.store.getPrefs(), ctx.store.getPassedOverLedger(), readSlippingRecords(ctx.deps),
    ]);
    /**
     * The same call the ranker makes, over the same records, so the block on
     * this screen and the one-minute offer on Today cannot name different
     * things. An empty list is sent as an empty list and the block does not
     * render: there is no praise copy for a board with nothing slipping,
     * because a product that congratulated somebody for the absence of a
     * problem would be inventing an achievement to hand out.
     */
    const slipping: readonly AvoidanceCandidate[] = slippingFrom(
      new Date(ctx.nowIso()), timeZone, prefs, slippingRecords,
    ).slice(0, AVOID_MAX_SURFACED);
    const signalById = new Map(signals.map((signal) => [signal.id, signal]));
    const topicById = new Map(topics.map((topic) => [topic.id, topic.label]));
    /**
     * Where the board says a topic stands, for the room that groups by subject.
     *
     * The same two calls the lineup chip and the board rail are drawn from,
     * over the same ledger, so a subject cannot be *building* on one screen and
     * *new to you* on another. Derived here rather than stored: there is no
     * comfort record in the store and there is not meant to be one, because the
     * number is a read of the signals and the signals are the fact.
     *
     * Only for a topic still on the board. `computeComfort` answers for any id
     * at all, and its answer for a topic that has left is the register of no
     * evidence, which would put a confident word under a subject nothing on
     * this board can still say anything about.
     */
    const registerNow = new Date(ctx.nowIso());
    const registerByTopic = new Map<string, string>();
    const registerOf = (topicId: string): string | null => {
      if (!topicById.has(topicId)) return null;
      const known = registerByTopic.get(topicId);
      if (known) return known;
      const value = registerFor(computeComfort(topicId, signals, registerNow));
      registerByTopic.set(topicId, value);
      return value;
    };
    ctx.reply(res, 200, {
      statements: statements.filter((statement) => !statement.rejected).map((statement) => {
        const resolved = statement.evidenceSignalIds
          .map((id) => signalById.get(id)).filter((signal) => signal !== undefined);
        /**
         * What the sentence is about, by the rule the lesson page already uses.
         *
         * `subjectForTopic` is the same call `/session` makes over the same
         * courses and commitments, so the family line over a lesson and the
         * group label over a read cannot name one course two different ways.
         * The topic's own label travels with it as the weaker of the two facts,
         * which is what the lesson does too. A statement about a pattern across
         * the whole board names no topic and borrows none.
         */
        const subject = statement.topicId === null
          ? null : subjectForTopic(statement.topicId, courses, commitments);
        const topicLabel = statement.topicId === null
          ? undefined : topicById.get(statement.topicId);
        const register = statement.topicId === null ? null : registerOf(statement.topicId);
        return {
          id: statement.id,
          text: statement.text,
          userEdited: statement.userEdited,
          updatedAt: statement.updatedAt,
          /**  repaired this join and nothing sent it. The room that draws
           *  these sentences groups by what they are about, so it needs it. */
          topicId: statement.topicId,
          ...(subject ? { subject } : {}),
          ...(topicLabel ? { topicLabel } : {}),
          /** The register word the subject wears in the Insights room. Sent
           *  only where the board can still answer, like the two above. */
          ...(register ? { register } : {}),
          /** The learner has agreed with this sentence as written. Sent only
           *  when true, like the modality mark below: a panel too old to know
           *  the state reads its absence as the state it always assumed. */
          ...(statementEndorsed(statement) ? { confirmed: true } : {}),
          evidence: resolved.map((signal) => ({
            type: signal.type,
            topic: topicById.get(signal.topicId) ?? 'A topic no longer on your board',
            active: !signal.invalidated,
          })),
          evidenceReceipt: !statement.evidenceSignalIds.length ? 'unitemised'
            : resolved.length === statement.evidenceSignalIds.length ? 'complete' : 'incomplete',
          /**
           *. Absent on every ordinary row, and the panel branches on it.
           *
           * `confirmed` rather than the stored instant, because the screen has
           * one decision to make and a date it would not render is a date this
           * door has no reason to hand out.
           */
          ...(statement.modality
            ? { modality: { key: statement.modality.key, confirmed: statement.modality.confirmedAt !== null } }
            : {}),
        };
      }),
      hasLearningMaterial: pins.length > 0,
      coursePulse: coursePulse(
        courses, commitments, outcomes, new Date(ctx.nowIso()), timeZone,
      ),
      slipping: slippingRows(slipping, ledger),
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/model') {
    const body = await ctx.readBody(req);
    const text = ctx.requireText(body, 'text', LEARNER_STATEMENT_MAX_CHARS, 'insight');
    const id = ctx.receiptId('statement', body.clientRef);
    if (id) {
      const existing = (await ctx.store.listStatements()).find((statement) => statement.id === id);
      if (existing) {
        ctx.reply(res, 200, { statement: existing, alreadyRecorded: true });
        return true;
      }
    }
    /**
     * the learner's own sentence, scoped by the same join as a machine
     * one.
     *
     * `topicsNamedIn` is the Registrar's deterministic label match, reused here
     * rather than reinvented, and it is applied under the same rule: exactly one
     * topic named is a sentence about that topic, and anything else keeps null.
     *
     * Two things downstream change because of it, and both are the rule this
     * field was always meant to carry rather than a new one. A correction that
     * plainly names one topic now governs that topic instead of the whole read,
     * which is what `sessionLearnerContext` says in as many words. And the
     * night scout's comfort-gated gap can see it, which on a real board it
     * never could, because this field was null on every row ever written.
     */
    const named = topicsNamedIn(text, await ctx.store.listTopics());
    const statement: Statement = {
      id: id ?? ctx.newId(),
      text,
      topicId: named.length === 1 ? (named[0] as Topic).id : null,
      userEdited: true,
      evidenceSignalIds: [],
      updatedAt: ctx.nowIso(),
    };
    await ctx.store.putStatement(statement);
    ctx.reply(res, 201, { statement });
    return true;
  }

  const answered = /^\/model\/([^/]+)\/confirm$/.exec(url.pathname);
  if (answered && req.method === 'POST') {
    const confirmId = ctx.pathId(answered, 1);
    const found = (await ctx.store.listStatements())
      .find((item) => item.id === confirmId && !item.rejected);
    if (!found) {
      ctx.reply(res, 404, { error: 'no such statement' });
      return true;
    }
    // Their own words are already theirs. Endorsing them would record a person
    // agreeing with themselves, which is not a fact about anything.
    if (found.userEdited) ctx.badRequest('your own words do not need confirming');
    if (found.modality) {
      if (found.modality.confirmedAt) {
        ctx.reply(res, 200, { ok: true, alreadyConfirmed: true });
        return true;
      }
      const at = ctx.nowIso();
      await ctx.store.putStatement({
        ...found, updatedAt: at, modality: { ...found.modality, confirmedAt: at },
      });
      ctx.reply(res, 200, { ok: true, confirmed: true });
      return true;
    }
    if (found.confirmedAt) {
      ctx.reply(res, 200, { ok: true, alreadyConfirmed: true });
      return true;
    }
    const confirmedAt = ctx.nowIso();
    // The same row, endorsed. Not a copy, not a rewrite, and not a signal: the
    // ledger records what a learner did with material, and this is what they
    // said about a sentence.
    await ctx.store.putStatement({ ...found, confirmedAt, updatedAt: confirmedAt });
    ctx.reply(res, 200, { ok: true, confirmed: true });
    return true;
  }

  const matched = /^\/model\/([^/]+)$/.exec(url.pathname);
  if (!matched) return false;
  const id = ctx.pathId(matched, 1);

  if (req.method === 'DELETE') {
    const found = (await ctx.store.listStatements()).find((item) => item.id === id && !item.rejected);
    if (!found) {
      ctx.reply(res, 404, { error: 'no such statement' });
      return true;
    }
    /**
     * A no to a modality question is louder than a rejected sentence.
     *
     * The rejection receipt on its own would only stop THIS wording coming back
     * from THIS evidence, and the next week of checks would rebuild the same
     * question with different counts in it. So the denial is recorded in
     * preferences as well, where nothing but this door can write it and
     * `PUT /prefs` cannot clear it, and it suppresses every modality question
     * for `MODALITY_DENIED_DAYS`.
     */
    if (found.modality) {
      const modalityKey = found.modality.key;
      await mutateLearnerPrefs(ctx.store, (prefs) => ({
        ...prefs,
        modalityDenied: recordModalityDenial(modalityKey, new Date(ctx.nowIso())),
      }));
      await ctx.store.putStatement({ ...found, rejected: true, updatedAt: ctx.nowIso() });
      ctx.reply(res, 200, { ok: true, rejected: true, quietForDays: MODALITY_DENIED_DAYS });
      return true;
    }
    if (found.userEdited) {
      await ctx.store.deleteStatement(id);
      ctx.reply(res, 200, { ok: true, rejected: false });
      return true;
    }
    await ctx.store.putStatement({ ...found, rejected: true, updatedAt: ctx.nowIso() });
    ctx.reply(res, 200, { ok: true, rejected: true });
    return true;
  }

  if (req.method === 'PUT') {
    const text = ctx.requireText(
      await ctx.readBody(req), 'text', LEARNER_STATEMENT_MAX_CHARS, 'insight',
    );
    const found = (await ctx.store.listStatements()).find((item) => item.id === id && !item.rejected);
    if (!found) {
      ctx.reply(res, 404, { error: 'no such statement' });
      return true;
    }
    if (text === found.text.trim()) {
      ctx.badRequest('change the insight before saving it as your words');
    }
    /**
     * Rewriting a modality question in your own words is an answer to it.
     *
     * The row becomes the learner's words like any other correction, and the
     * question is marked answered on the way past. Leaving it unanswered would
     * hold the one-at-a-time slot for ever against a sentence that no longer
     * asks anything, and would keep it out of every teaching brief on the
     * grounds that nobody had confirmed it, which is not what happened.
     */
    const modality = found.modality && !found.modality.confirmedAt
      ? { modality: { ...found.modality, confirmedAt: ctx.nowIso() } } : {};
    /**
     * An endorsement is of a sentence, and this is a different sentence.
     *
     * Keeping the mark would leave the row claiming a person agreed with
     * wording they have just replaced. It costs them nothing: their own words
     * outrank every read in this product, which is the stronger standing of the
     * two, and it is the one the row now carries.
     */
    await ctx.store.putStatement({
      ...found, ...modality, text, userEdited: true, confirmedAt: null, updatedAt: ctx.nowIso(),
    });
    ctx.reply(res, 200, { ok: true });
    return true;
  }

  return false;
}
