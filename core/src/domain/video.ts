import type { VideoMoment } from './types.js';

/**
 * SB-10 — the link back to the moment.
 *
 * The timestamp is captured at the gesture (`extension/src/capture.ts`) because
 * by the nightly the tab is closed. This is the other end of it: turning that
 * number into something the learner can follow, so that "the session later
 * opens at that moment" is a link rather than an instruction to go and scrub.
 *
 * **A link is built only where the convention is real.** There is no general
 * way to seek a video from a url — every site that supports it invented its
 * own — so YouTube's is implemented and everything else answers null and stays
 * the plain page link it already was. Appending `?t=` to a site that does not
 * read it is not a harmless extra: it is a link the learner follows expecting
 * the moment, lands at the top of, and after which they stop believing every
 * other timestamp on the screen.
 *
 * Vendor-neutral by the same rule as the rest of `domain/`: this knows a url
 * convention that a public site documents, in the way it knows what a heading
 * is. It imports nothing and calls nothing.
 */

/** A moment is a whole number of seconds into something. Zero is not one: it is
 *  where a video that was never played sits. */
const seekable = (moment: VideoMoment | null | undefined): number | null => {
  const seconds = moment?.timestampSeconds;
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds <= 0) return null;
  return seconds;
};

/** Exactly this host or a subdomain of it — never a host that merely contains
 *  it. `youtube.com.evil.test` is not YouTube and `notyoutube.com` is not either. */
const isHost = (hostname: string, domain: string): boolean =>
  hostname === domain || hostname.endsWith(`.${domain}`);

/**
 * The same page, at the moment the learner pinned — or null.
 *
 * Null covers every honest way of not knowing: no moment, a moment that is not
 * a moment, a player whose site has no convention, a url that will not parse,
 * and a url whose scheme is not one the panel would render as a link anyway.
 */
export function momentHref(url: string, moment: VideoMoment | null | undefined): string | null {
  const seconds = seekable(moment);
  if (seconds === null || moment?.player !== 'youtube') return null;

  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  // The same allow-list the panel's `safeHref` applies, and for the same
  // reason: whatever comes back here becomes an `href` in the panel's own
  // origin, and a scheme nobody has thought of is text.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  // `youtu.be/<id>` — the whole path is the video.
  if (isHost(parsed.hostname, 'youtu.be')) {
    if (parsed.pathname.length <= 1) return null;
    parsed.searchParams.set('t', `${seconds}s`);
    return parsed.href;
  }

  if (!isHost(parsed.hostname, 'youtube.com')) return null;

  // An embed reads `start`, in plain seconds. `t` does nothing there, which is
  // the kind of near-miss that looks like it works until somebody watches.
  if (parsed.pathname.startsWith('/embed/') && parsed.pathname.length > '/embed/'.length) {
    parsed.searchParams.set('start', String(seconds));
    return parsed.href;
  }

  // Everything else on the hostname — the home page, a channel, a search — is
  // not a video, and the player is named from the hostname so all of them
  // arrive here. `set` rather than `append`: a link that already carried a
  // timestamp must not end up carrying two.
  if (parsed.pathname !== '/watch' || !parsed.searchParams.get('v')) return null;
  parsed.searchParams.set('t', `${seconds}s`);
  return parsed.href;
}
