import { esc } from './panel-core.js';

/**
 * Inline SVG avoids an extra asset or CSP exception. The panel runs under the extension's
 * content security policy: an icon font is a remote or bundled binary, and an
 * `<img>` is another asset to ship and version. Markup costs nothing, needs no
 * dependency, and is the only kind of icon this surface can carry without a CSP
 * exception.
 *
 * **One drawing style, so the glyphs read as one set.** Every one is a 16x16
 * `viewBox`, unfilled, `currentColor` at 1.5 stroke with round caps and joins.
 * `currentColor` is what makes them theme-aware for free and is why there is no
 * new colour anywhere in this table: a glyph is the colour of the control it is
 * inside, which is `--muted` at rest and `--fg` when the mark stands.
 *
 * Position uses bare chevrons; these are the only vertical controls on a row.
 *
 * Every one of them is unreadable on its own, which is the standing cost of an
 * icon. It is paid at the call site: each button carries its whole sentence as
 * both `aria-label` and `title`, so the control names itself to a screen reader
 * and to a pointer that rests on it, and `panel-wiring.test.ts` fails the suite
 * on any icon control that carries neither.
 *
 * No learner-facing sentence lives here; call sites supply accessible labels.
 */
export const GLYPH = {
  /** Information, asked for rather than announced: the circled lower-case i. */
  why: '<circle cx="8" cy="8" r="6"/><path d="M8 7.4v3.8"/><path d="M8 4.9v.5"/>',
  /** Good call. A fist and a hand, not a filled shape: nothing on this row is
   *  solid, because a solid glyph among seven outlines reads as selected. */
  good: '<path d="M2 7.4h2.6v6.2H2z"/><path d="M4.6 7.4 7.9 2.3a1.45 1.45 0 0 1 2.5 1.45L9.5 6.4h3.2a1.35 1.35 0 0 1 1.31 1.68l-1 4a1.35 1.35 0 0 1-1.31 1.02H4.6"/>',
  /** Not what I need. The same hand, turned over. */
  bad: '<path d="M2 2.4h2.6v6.2H2z"/><path d="M4.6 8.6l3.3 5.1a1.45 1.45 0 0 0 2.5-1.45L9.5 9.6h3.2a1.35 1.35 0 0 0 1.31-1.68l-1-4A1.35 1.35 0 0 0 11.7 2.9H4.6"/>',
  /** Position, as a bare chevron. No bar: this move has no floor and no ceiling
   *  beyond the ends of the list, and the row at each end has no control. */
  up: '<path d="M4.2 10 8 6.2 11.8 10"/>',
  down: '<path d="M4.2 6.2 8 10l3.8-3.8"/>',
  /** Not tonight. A cross, which everywhere means take this away, and nowhere
   *  means destroy it: the sentence behind it says when it comes back. */
  remove: '<path d="M4.6 4.6l6.8 6.8"/><path d="M11.4 4.6l-6.8 6.8"/>',
  /**
   * Show me another. An arrow that comes back round to where it started.
   *
   * , and the one glyph in the set that is not on a lineup row. It is a
   * cycle rather than a forward arrow deliberately: a forward arrow is the
   * chevron idiom this set already spends on moving a row, and it would promise
   * a next PAGE rather than a next candidate. Drawn open at the top right so
   * the head has somewhere to sit, in the same stroke as everything above it.
   */
  another: '<path d="M13.4 8a5.4 5.4 0 1 1-1.6-3.8"/><path d="M13.6 2.2v3h-3"/>',
  /** The drag handle. Not a control and not focusable: the row is the drag
   *  source, and the accessible way to do the same thing is the two chevrons
   *  above. It is here because a draggable thing that does not look draggable
   *  is a gesture nobody discovers. */
  grip: '<path d="M5.4 4.6h5.2"/><path d="M5.4 8h5.2"/><path d="M5.4 11.4h5.2"/>',
} as const;

/**
 * One icon button: the glyph inside, the sentence on the outside, twice.
 *
 * `aria-label` and `title` carry the same string deliberately. They are read by
 * different people in different ways — one by a screen reader, one by a pointer
 * that rests — and a control whose tooltip and accessible name disagree is a
 * control that is two different things depending on how you meet it.
 */
export const iconButton = (label: string, glyph: string, hooks: string): string =>
  `<button class="link icon" ${hooks} aria-label="${esc(label)}" title="${esc(label)}">`
  + `<svg class="glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor"`
  + ` stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`
  + ` focusable="false">${glyph}</svg></button>`;
