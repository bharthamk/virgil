import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ProspectStateError, decideProspectProposal, pendingProspectProposals,
  type Deps, type Pin, type ProspectProposal, type ProspectState,
} from '@sb/core';

/**
 * The review boundary for what the night proposed collecting.
 *
 * Two routes and no third, because there are only two things a person does with
 * a proposal: read it, and decide about it. Everything a richer surface would
 * want — a search, a history, a bulk accept — would be a way of deciding faster
 * about things nobody has read, which is the opposite of what a review surface
 * is for.
 *
 * **What accepting does, exactly.** It marks the proposal accepted, and where
 * the proposal carried an address, it saves that address as one unread pin. No
 * course, no commitment, no deadline, no topic and no signal: the four kinds of
 * record that would mean the board had decided something about the learner are
 * untouched, and none of them is reachable from here.
 *
 * The pin is the point, and it is the only honest way to keep the promise the
 * proposal makes. Nothing has read that address. The record says so: no
 * enrichment, which is exactly what the Forager's own queue means by owed a
 * read. So the page is fetched on a later run, by the agent whose job that
 * already is, under the same untrusted-content rules as anything else the
 * learner saved. Reading it here, in a request, would put an unverified address
 * behind a button press and charge somebody a model call for a tap.
 *
 * A proposal with no address is a proposal with nothing to save. Accepting it
 * records the decision and writes nothing, because a search phrase is a thing
 * for a person to act on and not a source.
 *
 * Its own module rather than another block in `service.ts` for the same reason
 * the spend limit and the learner overview have theirs: the ownership boundary
 * is visible, and the file that answers every other request does not grow a
 * third of a screen every time a lane is added.
 */
export interface ProspectRouteContext {
  readonly store: Deps['store'];
  readonly now: () => Date;
  readonly readBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  readonly reply: (res: ServerResponse, code: number, body: unknown) => void;
}

const DECISIONS: readonly ProspectState[] = ['accepted', 'dismissed'];

const isDecision = (value: unknown): value is ProspectState =>
  typeof value === 'string' && (DECISIONS as readonly string[]).includes(value);

export async function handleProspectRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ProspectRouteContext,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/prospects') {
    // Only what is still waiting on somebody. A decided proposal has had its
    // moment, and a review surface that also lists them is a surface where the
    // three things needing an answer are hidden among thirty that do not.
    ctx.reply(res, 200, { proposals: pendingProspectProposals(await ctx.store.listProspectProposals()) });
    return true;
  }

  const decide = /^\/prospects\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'PATCH' && decide) {
    const id = decodeURIComponent(decide[1] as string);
    const body = await ctx.readBody(req);
    // The same `{ field, value }` shape the reviewed intake takes, so one client
    // helper serves both review surfaces and neither invents its own verb.
    // Answered here rather than raised, so this router needs nothing from the
    // service but a store, a clock and the two functions that read and write.
    if (body.field !== 'state' || !isDecision(body.value)) {
      ctx.reply(res, 400, {
        error: `field must be state and value one of: ${DECISIONS.join(', ')}`,
      });
      return true;
    }
    const proposal = await ctx.store.getProspectProposal(id);
    if (!proposal) {
      ctx.reply(res, 404, { error: 'no such proposal' });
      return true;
    }
    let decided;
    try {
      decided = decideProspectProposal(proposal, body.value, ctx.now().toISOString());
    } catch (err) {
      // Deciding twice is a conflict rather than a bad request: the caller sent
      // a well-formed decision about something that had already been settled,
      // which is what two open panels look like.
      if (err instanceof ProspectStateError) {
        ctx.reply(res, 409, { error: err.message, proposal });
        return true;
      }
      throw err;
    }
    await ctx.store.putProspectProposal(decided);
    const pin = decided.state === 'accepted' ? await savePin(ctx, decided) : null;
    ctx.reply(res, 200, { proposal: decided, pinId: pin });
    return true;
  }

  return false;
}

/**
 * The accepted address, saved as the one thing it honestly is: an unread page
 * somebody asked for.
 *
 * The envelope is deliberately almost empty, and every empty field is a fact.
 * There is no selection because nobody selected anything; no surrounding text
 * and no heading path because nobody has seen the page; no site name and no
 * language because reading those means fetching it. The title is the subject
 * the proposal was reviewed under, so the pin says on the board what the
 * learner agreed to, rather than whatever a page turns out to call itself.
 *
 * `fromSuggestion` is true for the reason it exists: this pin was not made by
 * somebody selecting text, and a board that could not tell the difference would
 * be counting the product's own proposals as the learner's own reading.
 */
async function savePin(
  ctx: ProspectRouteContext,
  proposal: ProspectProposal,
): Promise<string | null> {
  const url = proposal.lead?.url ?? null;
  if (!url) return null;
  const pin: Pin = {
    id: randomUUID(),
    type: 'interest',
    envelope: {
      selection: null,
      parts: [],
      surroundingText: '',
      headingPath: [],
      pageTitle: proposal.subject,
      url,
      canonicalUrl: null,
      siteName: null,
      contentLanguage: null,
      media: null,
    },
    note: null,
    label: proposal.subject,
    capturedAt: ctx.now().toISOString(),
    fromSuggestion: true,
    // Owed a read, which is what the Forager's queue is a list of.
    enrichment: null,
    topicId: null,
  };
  await ctx.store.putPin(pin);
  return pin.id;
}
