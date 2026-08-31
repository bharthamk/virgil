import type { SessionSection, Signal } from './types.js';

/** A resume is stale after two days without learner activity. */
export const RESUME_STALE_AFTER_MS = 48 * 60 * 60 * 1000;

/**
 * When the learner last did anything with this session.
 *
 * There is no such field in the store, and adding one would leave every session
 * ever written unable to answer. What the store does have is the ledger: every
 * interaction with a section writes a signal whose `sourceEvent` is
 * `<verb>:<sessionId>:<topicId>`, so the answer is derivable from what is
 * already there.
 *
 * `builtAt` is the fallback and would be the wrong answer used alone. A session
 * built last night and half-done this morning is not cold; one built this
 * morning and abandoned at nine is not cold either. Both read as "built
 * recently", and only one of them is a resume at all.
 *
 * The session id is matched as a whole field rather than as a substring:
 * `sess-1` and `sess-12` are different sessions, and a resume warmed by work
 * done on another one is a recap the learner never earned.
 */
export function lastTouchedAt(
  sessionId: string, builtAt: string, signals: readonly Signal[],
): string {
  let latest = Date.parse(builtAt);
  let answer = builtAt;
  for (const s of signals) {
    if (s.sourceEvent?.split(':')[1] !== sessionId) continue;
    const at = Date.parse(s.at);
    // An unreadable timestamp is not the last thing that happened. Same reading
    // the panel takes of a build time it cannot parse.
    if (!Number.isFinite(at)) continue;
    if (!Number.isFinite(latest) || at > latest) { latest = at; answer = s.at; }
  }
  return answer;
}

/**
 * Long enough ago that the learner should not be assumed to remember it.
 *
 * Both failure modes answer false. An unreadable timestamp is not evidence of
 * age, and a timestamp in the future means the clock moved — a clock we cannot
 * trust is an age we cannot read, which is the same reading the extension's
 * prefs cache takes of a stamp from the future. Saying "not cold" costs the
 * learner two lines of reminder; saying "cold" on the strength of a NaN buys a
 * model call with it.
 */
export function isStaleResume(lastTouched: string, now: number): boolean {
  const at = Date.parse(lastTouched);
  if (!Number.isFinite(at)) return false;
  const age = now - at;
  return age >= 0 && age >= RESUME_STALE_AFTER_MS;
}

// ------------------------------------------------- what to say on the way in

/** Recaps reuse stored section summaries and fall back to headings. */

/** Two, because the story says two. A recap that runs on is the session again. */
export const RECAP_LINES = 2;

/**
 * The lines, in the order they were worked through.
 *
 * The **last** finished sections rather than the first. A learner coming back
 * wants the ground next to where they stopped, not the ground they covered
 * first — the model call this replaced summarised the opening four sections
 * however many had been done, which is the wrong end of the session to remind
 * somebody of.
 */
export function recapSoFar(
  finished: readonly Pick<SessionSection, 'heading' | 'recap'>[],
): readonly string[] {
  // Nothing finished is a session being started rather than resumed, and there
  // is nothing to recap.
  if (!finished.length) return [];
  return finished
    .slice(-RECAP_LINES)
    .map((s) => (s.recap ?? '').trim() || s.heading.trim())
    .filter((line) => line.length > 0);
}
