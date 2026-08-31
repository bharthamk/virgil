/**
 *  — the link back to the page of the paper.
 *
 * The same rule as `video.ts`: build a deep link only where the convention is
 * real. `#page=N` is the PDF open-parameter convention rather than one site's
 * invention — Chrome's viewer, Preview, Acrobat and pdf.js all read it — which
 * makes it the one deep link in this product that does not depend on where the
 * document is hosted.
 *
 * It is still only applied to a pin that came off a PDF. On an HTML page the
 * same fragment is an ordinary anchor, and a source link that scrolls somewhere
 * arbitrary is worse than one that opens at the top.
 *
 * The fragment is also the only part of a url that is never sent to the server,
 * which is why a page number can be added to a signed url without invalidating
 * the signature the query carries.
 */
export function pdfPageHref(url: string, page: number | null | undefined): string | null {
  if (typeof page !== 'number' || !Number.isInteger(page) || page <= 0) return null;

  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  // The same allow-list the panel's `safeHref` applies: whatever comes back
  // here becomes an href inside the panel's own origin.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  // Replaced rather than appended. A viewer handed two `page=` fragments reads
  // one of them, and which one is not something anybody should have to know.
  parsed.hash = `#page=${page}`;
  return parsed.href;
}
