/**
 * Text that is what it looks like.
 *
 * `.trim()` is the usual guard on a string a person typed, and it covers
 * whitespace and nothing else. Unicode has a second, larger family of
 * characters that occupy no space on the page and are not whitespace: the bidi
 * overrides, the zero-width space, the deprecated format controls, the C0/C1
 * control range. A string made only of those passes every `!s.trim()` check in
 * this codebase and renders as nothing at all — a learner-model statement that
 * displays blank on the one surface whose point is that the learner can read
 * and correct what the product believes about them, or a topic whose name is
 * absent from the board.
 *
 * Two functions rather than one, because "what do we store" and "is this
 * anything" are different questions:
 *
 *  - `stripInvisible` removes what is safe to remove anywhere.
 *  - `rendersEmpty` additionally ignores the invisible characters that are NOT
 *    safe to remove, only for the purpose of deciding whether anything is left.
 *
 * The second list is the reason this is not one regex. The zero-width joiner
 * and non-joiner are invisible, but they are load-bearing in Persian, Arabic,
 * Hindi and emoji sequences; the variation selectors and the combining grapheme
 * joiner are the same. Deleting those from a learner's text would be the exact
 * failure this file exists to prevent, applied to somebody whose script needs
 * them. So they survive `stripInvisible`, and a string made of nothing else
 * still counts as empty.
 *
 * Nothing here touches letters. Arabic, Hebrew, Thaana and every other RTL
 * script is written with ordinary letters and passes through unchanged — it is
 * the bidi *controls* that are dropped, and text that needs a direction gets it
 * from the letters, not from an override.
 */

/**
 * Invisible and meaningless on its own: control characters, the bidi embedding,
 * override and isolate controls, the zero-width space, the soft hyphen, the
 * deprecated format characters, the Hangul fillers, the byte-order mark, and
 * the interlinear annotation marks.
 *
 * Tab, newline and carriage return are deliberately absent — they are
 * whitespace, every caller already collapses or trims them, and a text field
 * that keeps its line breaks should keep them.
 */
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u115F\u1160\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB]/g;

/**
 * Invisible, but meaningful inside real words: the combining grapheme joiner,
 * the zero-width non-joiner and joiner, and the variation selectors. Kept in
 * the text, ignored when asking whether the text is anything.
 */
const JOINERS = /[\u034F\u200C\u200D\uFE00-\uFE0F]/g;

/** The text with everything that renders as nothing, and means nothing, gone. */
export function stripInvisible(text: string): string {
  return String(text ?? '').replace(INVISIBLE, '');
}

/** True when nothing would appear on screen. The check `.trim()` should be. */
export function rendersEmpty(text: string): boolean {
  return !stripInvisible(text).replace(JOINERS, '').trim();
}
