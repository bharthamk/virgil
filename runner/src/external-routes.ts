import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  admitExternalMethods, externalNewestFirst, externalSourceEvent,
  isExternalDestination, isExternalKind, isExternalMark,
  EXTERNAL_LABEL_MAX_CHARS, EXTERNAL_MARKS, EXTERNAL_MARK_WRITES, EXTERNAL_NOTE_MAX_CHARS,
  type AvailableMinutes, type Deps, type ExternalEntry, type NextAction, type Signal,
} from '@sb/core';

type Store = Deps['store'];

const mutationTails = new WeakMap<object, Promise<void>>();
const serialExternalMutation = async <T>(store: Store, run: () => Promise<T>): Promise<T> => {
  const before = mutationTails.get(store) ?? Promise.resolve();
  const next = before.then(run, run);
  mutationTails.set(store, next.then(() => undefined, () => undefined));
  return next;
};

const receiptId = (clientRef: string): string =>
  `external-${createHash('sha256').update(clientRef).digest('hex')}`;

export interface ExternalRouteContext {
  readonly store: Store;
  readonly nowIso: () => string;
  readonly readBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  readonly requireText: (
    body: Record<string, unknown>, field: string, maxChars: number, label: string,
  ) => string;
  readonly pathId: (match: RegExpExecArray, index: number) => string;
  readonly reply: (res: ServerResponse, code: number, body: unknown) => void;
  readonly badRequest: (message: string) => never;
  readonly newId: () => string;
  /** The service's own signal writer, so a mark from here is written exactly
   *  the way a mark from a lesson is. */
  readonly appendSignal: (
    topicId: string, type: Signal['type'], direction: Signal['direction'], sourceEvent: string,
  ) => Promise<void>;
  /** The same projection Today owns. External records evidence; it does not
   *  carry a second ranker that can disagree with the next move. */
  readonly readNextAction: (availableMinutes: AvailableMinutes) => Promise<NextAction>;
}

/**
 * THE EXTERNAL DOOR: what left Virgil, and what the learner made of it.
 *
 * Four operations on one resource, and a router of its own for the same reason
 * `learner-model-routes.ts` and `prospect-routes.ts` are routers of their own:
 * `service.ts`'s request handler has no room left, and a surface that is going
 * to grow a row at a time should grow somewhere it can.
 *
 * ## The four, and what each one is allowed to touch
 *
 *  - `POST /external` records a handoff. The panel calls it after a send that
 *    actually worked, and the learner calls it by hand for something that left
 *    without Virgil. It writes one row and nothing else: recording that a tab
 *    opened is not evidence about what anybody understands.
 *  - `GET /external` is the unresolved clearinghouse, newest first. Marked
 *    receipts remain in storage but are no longer active work.
 *  - `POST /external/:id/mark` is the one door in this file that reaches the
 *    ledger, and it reaches it through the marks `QUICK_TAKE_MARKS` already
 *    defines. One active `sourceEvent` per entry, so a changed mind replaces a
 *    mark rather than adding a second one to argue with the first.
 *  - `DELETE /external/:id` removes the row and **writes nothing else**. Ruled
 *    in as many words: *"remove it from the external tab with nothing
 *    recorded"*. The mark a removed row was carrying is not withdrawn either,
 *    and that is deliberate: the learner said the row should go, not that the
 *    thing they told us about their comfort never happened.
 *
 * ## What is deliberately not here
 *
 * No new signal kind, no new ledger consumer, and no completion. A lesson
 * finished on somebody else's surface cannot claim the machinery it did not go
 * through, and `domain/external.ts` says exactly which lesser fact `done`
 * writes instead and why.
 */
export async function handleExternalRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ExternalRouteContext,
  serialized = false,
): Promise<boolean> {
  if (!serialized && url.pathname.startsWith('/external')
      && (req.method === 'POST' || req.method === 'DELETE')) {
    return serialExternalMutation(ctx.store, () => handleExternalRoute(req, res, url, ctx, true));
  }
  if (url.pathname === '/external' && req.method === 'POST') {
    const body = await ctx.readBody(req);
    const kind = body.kind;
    const destination = body.destination;
    if (!isExternalKind(kind)) ctx.badRequest('kind must be lesson, material or manual');
    if (!isExternalDestination(destination)) {
      ctx.badRequest('destination must be one of the places a send can go');
    }
    const label = ctx.requireText(body, 'label', EXTERNAL_LABEL_MAX_CHARS, 'label');
    if (!label) ctx.badRequest('label is required, as the name of what went');
    const clientRef = optionalId(body.clientRef);
    if (clientRef) {
      const existing = (await ctx.store.listExternalEntries())
        .find((candidate) => candidate.clientRef === clientRef);
      if (existing) {
        ctx.reply(res, 200, { entry: existing, replayed: true });
        return true;
      }
    }
    /**
     * The id and the instant are minted here, and neither is readable from the
     * request. An entry is a receipt, and a receipt whose time and identity the
     * sender chooses is a receipt that proves nothing: two panels open on one
     * board could otherwise write the same id, and a stale tab could date a
     * handoff to whenever it happened to be loaded.
     */
    const entry: ExternalEntry = {
      id: clientRef ? receiptId(clientRef) : ctx.newId(),
      ...(clientRef ? { clientRef } : {}),
      kind,
      label,
      destination,
      sentAt: ctx.nowIso(),
      sessionId: optionalId(body.sessionId),
      topicId: optionalId(body.topicId),
      materialId: optionalId(body.materialId),
      destinationSaid: optionalId(body.destinationSaid),
      note: optionalNote(ctx, body),
      methods: admitExternalMethods(body.methods),
      mark: null,
      markedAt: null,
    };
    await ctx.store.putExternalEntry(entry);
    ctx.reply(res, 201, { entry });
    return true;
  }

  if (url.pathname === '/external' && req.method === 'GET') {
    /**
     * Unresolved work only, newest first. A mark clears the active surface, not
     * the receipt: the complete row and its evidence remain in the store. The
     * DELETE route below is the only operation that removes the row itself.
     */
    const entries = externalNewestFirst(await ctx.store.listExternalEntries())
      .filter((entry) => entry.mark === null || entry.mark === undefined);
    ctx.reply(res, 200, { entries });
    return true;
  }

  const marked = /^\/external\/([^/]+)\/mark$/.exec(url.pathname);
  if (marked && req.method === 'POST') {
    const id = ctx.pathId(marked, 1);
    const found = await ctx.store.getExternalEntry(id);
    if (!found) {
      ctx.reply(res, 404, { error: 'no such entry' });
      return true;
    }
    const body = await ctx.readBody(req);
    const mark = body.mark;
    if (!isExternalMark(mark)) ctx.badRequest(`mark must be one of: ${EXTERNAL_MARKS.join(', ')}`);
    const availableMinutes = externalAvailableMinutes(body.availableMinutes);
    const before = await ctx.readNextAction(availableMinutes);

    const at = ctx.nowIso();
    const write = EXTERNAL_MARK_WRITES[mark];
    const methods = body.methods === undefined
      ? found.methods ?? [] : admitExternalMethods(body.methods);
    const note = body.note === undefined ? found.note ?? null : optionalNote(ctx, body);

    /**
     * An entry with nothing on the board behind it degrades rather than
     * inventing somewhere to put the mark.
     *
     * A signal is keyed on a topic. A row the learner typed in about a video
     * nothing on their board has heard of has no topic, and the two ways out of
     * that are both wrong: minting a topic for it would put a subject on
     * somebody's board because they wrote one sentence about a thing they
     * watched, and dropping the mark would make the control do nothing. So the
     * row keeps the mark, the ledger is untouched, and the surface is told which
     * of the two happened.
     */
    const topicId = found.topicId ?? null;
    if (topicId) {
      const sourceEvent = externalSourceEvent(found.id);
      const standing = (await ctx.store.listSignals(topicId))
        .filter((signal) => signal.sourceEvent === sourceEvent && !signal.invalidated);
      /**
       * The correction pattern the quick take's verdict already uses, and the
       * lineup's before it. The same mark twice is a no-op rather than a second
       * signal; a different mark withdraws the standing one and appends the new
       * one, because somebody who presses Hard after Easy has changed their
       * mind rather than said two things.
       */
      if (!standing.some((signal) => signal.type === write.type)) {
        if (standing.length) await ctx.store.invalidateSignals(sourceEvent);
        await ctx.appendSignal(topicId, write.type, write.direction, sourceEvent);
      }
    }

    const next: ExternalEntry = {
      ...found, mark, markedAt: at, methods, note, markLocalOnly: topicId === null,
    };
    await ctx.store.putExternalEntry(next);
    const after = await ctx.readNextAction(availableMinutes);
    const changed = before.primary.id !== after.primary.id;
    const changedBecause = topicId === null
      ? `Saved on this receipt. It is not linked to a board subject, so “${after.primary.title}” is still your next move.`
      : changed
        ? `That answer changed your next move from “${before.primary.title}” to “${after.primary.title}”.`
        : `That answer is now evidence. “${after.primary.title}” is still your next move.`;
    ctx.reply(res, 200, {
      entry: next,
      /** What the mark actually did, so the panel never has to guess. Named
       *  rather than implied: `wrote` is null exactly when nothing on the board
       *  claims this entry. */
      wrote: topicId ? write.type : null,
      ...(write.backAfterDays ? { backAfterDays: write.backAfterDays } : {}),
      adaptation: { changed, before: before.primary, after: after.primary, changedBecause },
    });
    return true;
  }

  const one = /^\/external\/([^/]+)$/.exec(url.pathname);
  if (one && req.method === 'DELETE') {
    const id = ctx.pathId(one, 1);
    const found = await ctx.store.getExternalEntry(id);
    if (!found) {
      ctx.reply(res, 404, { error: 'no such entry' });
      return true;
    }
    // The row, and only the row. No signal, no withdrawal, no preference: the
    // ruling is that removing an entry records nothing, and the shortest way to
    // keep that promise is for this branch to contain one call.
    await ctx.store.deleteExternalEntry(id);
    ctx.reply(res, 200, { ok: true });
    return true;
  }

  return false;
}

/** External is an optional-capability surface and older panels did not send a
 *  time window. Preserve that wire contract with the same three-minute default
 *  Today uses, while refusing to let an arbitrary number create a fourth
 *  ranking lane. */
const externalAvailableMinutes = (value: unknown): AvailableMinutes =>
  value === 1 || value === 3 || value === 5 ? value : 3;

/** A provenance id the client offered, bounded the same way every other id
 *  reaching a stored document is: an unbounded key is an unbounded document. */
const optionalId = (value: unknown): string | null => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= EXTERNAL_LABEL_MAX_CHARS ? text : null;
};

/**
 * The learner's note on an entry, or nothing.
 *
 * Through the service's own bounded-string reader, which REFUSES an over-long
 * note rather than truncating it. The panel says how many characters it keeps
 * and promises to save the whole thing, and a note quietly cut in half is a
 * note the learner did not write being stored as one they did.
 */
const optionalNote = (
  ctx: ExternalRouteContext, body: Record<string, unknown>,
): string | null => {
  if (typeof body.note !== 'string' || !body.note.trim()) return null;
  return ctx.requireText(body, 'note', EXTERNAL_NOTE_MAX_CHARS, 'note') || null;
};
