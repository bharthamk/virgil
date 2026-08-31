/**
 * What gets posted, and what the toast says while it happens.
 *
 * SB-13: the confirmation copy reflects the pin type immediately, or the user
 * will not believe the two types are treated differently. SB-47: when the
 * service cannot be reached the copy degrades to a promise, never to an error.
 * Both are one-line decisions, and both are the kind of one-line decision that
 * silently regresses, so they live here with the strings in one place.
 */
import type { CapturedEnvelope } from './capture.js';

export type PinType = 'interest' | 'struggle';

export interface PinBody {
  type: PinType;
  envelope: CapturedEnvelope;
  capturedAt: string;
  /**
   * The depth the learner asked for on this pin, where they asked.
   *
   * Standard's effort choice. Null is the ordinary case and means the ledger
   * decides, which is usually better than a judgement made in two seconds
   * while looking at one passage.
   */
  requestedRegister?: 'from-nothing' | 'building' | 'fluent' | null;
  /** How long they asked for, in minutes. See `Pin.requestedMinutes`. */
  requestedMinutes?: number | null;
  /**
   * This client's name for this pin.
   *
   * A post that runs past the toast's 2.5 second budget is abandoned and
   * queued, and the drain retries it, possibly against a service that had
   * already finished the first one. Without a name to match, that second
   * request is a second pin: two identical ones were found on a real board,
   * sharing a `capturedAt` to the millisecond, which is one gesture.
   *
   * Generated once, where the body is built, so the retry carries the same
   * one. That is the whole mechanism.
   */
  clientRef: string;
}

/**
 * SB-09: the image is the bytes, or it is nothing at all.
 *
 * `image` is what `fetchPinnedImage` came back with — absent for the pins that
 * were never about an image. A refusal stores no media and records why, because
 * the alternative is a reference that reads as a picture right up until the
 * vision call comes back describing nothing.
 */
export function buildPinBody(type: PinType, envelope: CapturedEnvelope, capturedAt: string): PinBody {
  // A fact about the browser rather than about the material, and the ledger
  // stores the second kind. Stripped here, at the one place every pin is
  // built, so no route can leak it into the store.
  const {
    selectionWatched: _watched,
    selectionRecovered: _recovered,
    ...material
  } = envelope;
  return {
    type,
    // Once, here, because here is where a body becomes a thing that can be
    // retried. Generated in the worker rather than the page: the page is gone
    // by the time the drain runs.
    clientRef: newClientRef(),
    envelope: material,
    capturedAt,
  };
}

/**
 * SB-11 — the one capture the product refuses, and what it says instead.
 *
 * Chrome's built-in PDF viewer hands a content script the document's identity
 * and nothing else: the text layer, the selection and the page indicator all
 * live inside a frame belonging to another extension, which nothing here may
 * script. A pin made there carries a title, a url and no material — it looks
 * like a pin on the board, produces nothing overnight, and never tells the
 * learner that anything went wrong. That is the worst of the three outcomes;
 * an honest refusal is the second worst and is this one.
 *
 * Deliberately narrow. A thin HTML page is a legitimate whole-page pin (SB-07)
 * and the Forager re-fetches it this run, so it is never refused however little
 * it carried. A PDF we cannot read now is one nothing can read later.
 *
 * `MIN_PDF_CHARS` is a floor rather than a non-empty check because a viewer
 * that hands over anything usually hands over its own furniture — a filename,
 * "1 / 12", a toolbar label. A pin built from that is worse than the refusal,
 * because it looks like it worked.
 */
const MIN_PDF_CHARS = 24;

export function captureRefusal(envelope: CapturedEnvelope): string | null {
  if (envelope.documentKind !== 'pdf') return null;
  const material = `${envelope.selection ?? ''} ${envelope.surroundingText ?? ''}`.trim();
  if (material.length >= MIN_PDF_CHARS) return null;
  // No workaround is offered, because there is not one: selecting the text and
  // trying again does not help inside Chrome's own viewer. A refusal that
  // suggests a remedy that does not work is worse than one that does not.
  return 'Can’t pin this PDF. Chrome won’t let me read it.';
}

/** Shown the instant the gesture lands, before the service has said anything. */
export function initialToastText(type: PinType): string {
  return type === 'struggle' ? 'Noted, working it out…' : 'Pinned, working it out…';
}

/**
 * What the post came back with: whether the service took the pin, and what
 * Scout called it. Two questions, which is why they are two fields — a pin the
 * service took but did not name is not a pin that failed to send.
 */
export interface PinOutcome {
  readonly ok: boolean;
  readonly label: string | null;
  /**
   * The id the service filed it under, when it took it.
   *
   * A third question, and it is the one the quick take needs: everything on
   * that path is addressed by pin id, and a pin sitting in the offline queue
   * does not have one yet. Null for a pin that did not land, and null for a 200
   * that carried no id — a reply we cannot address is not one to offer a take
   * against.
   */
  readonly id: string | null;
}

/**
 * SB-59 — the escalation, and the one condition on offering it.
 *
 * *"The escalation must live on the toast, after capture … If the toast is
 * missed, nothing is lost — the pin is saved regardless."* So this decides
 * nothing about capture and everything about whether there is a take to offer.
 *
 * The condition is that the service took the pin and named an id for it. A pin
 * in the offline queue has neither: the take is a live call to a service that
 * has never heard of it, and queueing the *request* would be worse than not
 * offering — the learner would tap "now", get nothing, and be handed an
 * explanation at some later moment for a passage they have stopped thinking
 * about, with a comfort signal attached to it. SB-47 protects capture from the
 * network. Consumption is allowed to need it.
 */
export const LEARN_NOW_LABEL = 'Learn it now?';

export interface LearnNowOffer {
  /** What the learner presses. Always `LEARN_NOW_LABEL`. */
  readonly label: string;
  readonly pinId: string;
  /**
   * What it is about — Scout's label, the same words already on the toast.
   *
   * A second field rather than a second use of the first, because they are two
   * different sentences. It exists because the panel needs one: `learn-now.ts`
   * says the hand-off carries *"what the toast called it, so the panel has a
   * heading before the take lands"*, and until this field there was nothing to
   * carry — the tap sent the pin id alone, and the quick-take screen opened on
   * an empty heading over a `…` for as long as the model took.
   *
   * Null for a pin Scout could not name, which is the same answer `pendingTake`
   * gives an empty one.
   */
  readonly pinLabel: string | null;
}

export function learnNowOffer(sent: PinOutcome): LearnNowOffer | null {
  if (!sent.ok || !sent.id) return null;
  return { label: LEARN_NOW_LABEL, pinId: sent.id, pinLabel: sent.label || null };
}

/**
 * Shown once Scout answers — or once we have given up and queued it instead.
 *
 * Three outcomes, not two. The missing one was the middle: a 200 with no label
 * in it, which the copy read as offline and answered with SB-47's promise to
 * sort it later. The pin was already sorted — the drain path has known that
 * since it stopped resending label-less successes forever — so the learner was
 * told their pin had not arrived when it had. A promise that is not true about
 * a pin is worse than a plainer confirmation, so the plainer confirmation is
 * what an unnamed success gets.
 */
export function finalToastText(
  // The two questions the copy turns on, named rather than taking the whole
  // outcome: whether the pin landed and what it was called. The third — the id
  // — decides whether there is a take to offer, and no sentence here depends
  // on it.
  type: PinType, sent: Pick<PinOutcome, 'ok' | 'label'>,
): string {
  if (!sent.ok) return 'Pinned. I’ll sort it once I’m back online';
  const label = sent.label || null;
  if (type === 'struggle') {
    return label
      ? `Noted: ${label}. I’ll start from the bottom on this one.`
      : 'Noted. I’ll start from the bottom on this one.';
  }
  return label ? `Pinned: ${label}` : 'Pinned';
}

/**
 * The confirmation for a batch of picks (`mode-select`).
 *
 * One sentence for a gesture that made several pins, because five toasts for
 * one decision is five confirmations of a choice made once. It counts rather
 * than naming: the labels arrive one per pin from Scout and reading five of
 * them off a toast is a list, which is the thing this product does not do.
 *
 * Zero has its own line and it is not an apology. Everything picked can be
 * refused legitimately, a PDF frame being the ordinary case, and a learner who
 * saw nothing land is owed the fact rather than a cheerful count of nothing.
 */
export function pickedToastText(landed: number): string {
  if (landed <= 0) return 'Nothing could be pinned from that.';
  return landed === 1 ? 'Pinned one thing.' : `Pinned ${landed} things.`;
}

// ------------------------------------- what was actually saved, on the toast

/** Quote the saved material itself so capture confirmation is independently verifiable. */
export const TOAST_QUOTE_CHARS = 90;

/**
 * The first line of the material, cut at a word.
 *
 * Whitespace collapsed first: page text arrives with the markup's newlines in
 * it and a quotation full of them looks like broken output rather than like a
 * passage. Empty for a pin with no material to quote, and the caller draws no
 * line at all rather than an empty quotation.
 */
export function savedQuote(envelope: CapturedEnvelope, limit: number = TOAST_QUOTE_CHARS): string {
  const raw = String(envelope?.selection ?? envelope?.surroundingText ?? '')
    .replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  if (raw.length <= limit) return `“${raw}”`;
  const hard = raw.slice(0, limit);
  const space = hard.lastIndexOf(' ');
  const kept = space > Math.floor(limit * 0.6) ? hard.slice(0, space) : hard;
  return `“${kept.replace(/[\s,;:.]+$/, '')}…”`;
}

/**
 * Was the material the learner's own choice, or the page's?
 *
 * A whole-page pin quotes the page's own text, which on a busy page is
 * furniture. Saying which it is turns a confusing quotation into a legible
 * one, and is the same distinction the quick take's screen draws.
 */
export function savedFromPage(envelope: CapturedEnvelope): boolean {
  return !String(envelope?.selection ?? '').trim();
}

/** The line under the quotation on a whole-page pin. Absent otherwise: a
 *  selection needs no explaining. */
export const WHOLE_PAGE_NOTE = 'The whole page. Select something first to pin just that.';

/**
 * A name for one pin, unique enough that two gestures never collide.
 *
 * `crypto.randomUUID` is present in a service worker and in every context this
 * runs in. The fallback exists because a body that cannot be named would
 * otherwise be a body that cannot be retried safely, and losing the pin is a
 * worse answer than a slightly weaker name.
 */
export function newClientRef(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  return `ref-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}
