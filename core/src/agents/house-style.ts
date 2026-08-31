/**
 * HOUSE STYLE — how anything a learner reads is written.
 *
 * Learner-facing prose must be scannable in a narrow panel and avoid em-dashes
 * and en-dashes. The shared constants prevent prompt drift, while prompt lint
 * verifies that each agent follows the same rules it asks the model to follow.
 */

/** The dashes this product does not put in front of a learner. */
export const BANNED_DASHES = ['—', '–'] as const;

/** The one rule with no exceptions, stated once so everything can quote it. */
export const DASH_RULE = 'Never use an em-dash or an en-dash. Where you would reach for one, use a full stop, a comma, or brackets. This applies to every sentence you write.';

/**
 * The rule that applies to every word a learner reads, however short.
 *
 * Separate from `PROSE_STYLE` because the paragraph rule is not universal: the
 * Tutor answers a marked question in two sentences, and telling a two-sentence
 * reply to break itself into paragraphs is an instruction it can only obey by
 * padding. The dash rule has no such limit. It is one sentence and it belongs
 * on everything.
 */
export const SHORT_REPLY_STYLE = `How to write it:
- ${DASH_RULE}
- Plain sentences. No headings, no bullet points, no bold, no markdown of any kind: nothing renders it, so a learner reads the characters.`;

/**
 * The full rules, for anything long enough to have a shape.
 *
 * Concrete on purpose. "Write clearly" is not a rule a model can be checked
 * against; "two to four sentences, then a blank line" is. The lengths are
 * chosen against the panel, which is a side panel roughly 380px wide: a
 * paragraph of more than about four sentences is taller than the reader's
 * patience at that width, and one of a single sentence every time reads as a
 * list of assertions rather than as somebody explaining something.
 */
export const PROSE_STYLE = `How to write it:
- Break it into short paragraphs of two to four sentences, with a blank line between them. One unbroken block is not acceptable however short it is.
- Lead with the thing itself. Do not open by restating the question or announcing what you are about to cover.
- ${DASH_RULE}
- Plain sentences. No headings, no bullet points, no bold, no markdown of any kind: nothing renders it, so a learner reads the characters. Asterisks around a word arrive on screen as asterisks.`;

/**
 * Does this text carry a dash the house style bans?
 *
 * Exported so the lint, the panel's copy check and anything else that has to
 * ask are asking the same question of the same list.
 */
export function hasBannedDash(text: string): boolean {
  return BANNED_DASHES.some((d) => text.includes(d));
}
