import type { PureDeps } from './deps.js';
import type { CaptureEnvelope, PinType } from '../domain/types.js';
import { MAX_HEADING_PATH, MAX_NOTE, MAX_TITLE, UNTRUSTED_RULE, capped, fencePinned } from './untrusted.js';

/**
 * SCOUT — triage, foreground, sub-second.
 *
 * Runs on every pin and must render inside the toast (SB-03), so it takes
 * `reasoning: 'off'`: measured 367-775ms against a 1500ms budget, versus ~5000ms
 * with the thinking pass on. Labelling is not a reasoning problem.
 *
 * Deliberately given only topic *labels*, never topic bodies. Scout decides
 * "which bucket, roughly" — the Clusterer does the real clustering overnight
 * with full context. Keeping Scout's context tiny is what keeps it fast.
 */
export interface ScoutInput {
  readonly envelope: CaptureEnvelope;
  readonly type: PinType;
  readonly note: string | null;
  readonly existingTopicLabels: readonly string[];
}

export interface ScoutOutput {
  readonly label: string;
  readonly matchedExistingLabel: string | null;
  readonly confidence: number;
}

const SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    matchedExistingLabel: { type: ['string', 'null'] },
    confidence: { type: 'number' },
  },
  required: ['label', 'matchedExistingLabel', 'confidence'],
};

const SYSTEM = `You label learning material for a study tool. You are the fast triage step, not the analyst.
Give a short topic label (2-5 words) naming what the learner is trying to understand, not the page title and not the website.
The selected passage is primary. When it is a short named term or proper noun, label that selected subject itself; use the page and section only to disambiguate it, never to replace it with their broader topic.
If it clearly belongs to one of the learner's existing topics, say which. Otherwise return null for the match.
Answer with JSON only.

${UNTRUSTED_RULE}`;

export async function scout(deps: PureDeps, input: ScoutInput): Promise<ScoutOutput> {
  const { envelope: e } = input;
  // SB-07: whole-page pins are a first-class case, so fall back to the page's
  // own text rather than treating a missing selection as an error.
  const material = e.selection ?? e.surroundingText.slice(0, 600);

  // Scout is the first thing in the product to touch arbitrary web text, so it
  // gets the same fence as the background fleet even though its blast radius is
  // one label. Topic labels are fenced too: they were written by an earlier
  // model from pinned text and can carry the page's instruction at one remove.
  // What sits OUTSIDE is only the product's own interpretation of the press.
  const prompt = [
    fencePinned([
      `Passage: "${material.slice(0, 900)}"`,
      e.headingPath.length ? `Section: ${capped(e.headingPath.join(' > '), MAX_HEADING_PATH)}` : null,
      `Page: ${capped(e.pageTitle, MAX_TITLE)}`,
      input.note ? `Learner's own note: "${capped(input.note, MAX_NOTE)}"` : null,
      input.existingTopicLabels.length
        ? `Existing topics: ${input.existingTopicLabels.map((l) => `"${l}"`).join(', ')}`
        : 'The learner has no topics yet.',
    ].filter(Boolean).join('\n')),
    input.type === 'struggle' ? 'The learner flagged this as something they are struggling with.' : null,
  ].filter(Boolean).join('\n');

  const res = await deps.llm.structured<ScoutOutput>({
    tier: 'fast',
    reasoning: 'off',
    system: SYSTEM,
    prompt,
    schema: SCHEMA,
    maxOutputTokens: 200,
  });

  return {
    label: res.value.label?.trim() || fallbackLabel(e),
    matchedExistingLabel: res.value.matchedExistingLabel ?? null,
    confidence: typeof res.value.confidence === 'number' ? res.value.confidence : 0.5,
  };
}

/** The longest a fallback label may be. A heading for a narrow panel. */
export const FALLBACK_LABEL_MAX = 40;

/**
 * Cut without cutting through a word.
 *
 * `slice(40)` produced *"Deep Learning with PyTorch - Network Arc"* on the
 * first real pin anybody made, which is not an abbreviation, it is a heading
 * that looks broken. The panel cuts at render as well, so this had to be
 * fixed in both places or the panel would only ever see the damage already
 * done. Back off to the last space in the final quarter of the budget: far
 * enough to find a boundary in ordinary titles, near enough that one long
 * unbroken token still cuts rather than collapsing the label to nothing.
 */
function cutToWord(raw: string, limit: number): string {
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  const hard = clean.slice(0, limit);
  const space = hard.lastIndexOf(' ');
  const kept = space > Math.floor(limit * 0.75) ? hard.slice(0, space) : hard;
  // A cut that lands after "Training a" is a word boundary and still reads as
  // damage, so a trailing function word goes with the cut. Never the only
  // word: "The" alone is a worse heading than a hard cut.
  return kept
    .replace(/\s+(?:a|an|the|of|for|to|and|with|in|on|at|by|from|is|as|or)$/i, '')
    .replace(/[\s,;:.\-–—]+$/, '');
}

/**
 * The masthead off the end of a page title.
 *
 * A synthetic board carried a topic reading *"How to write a short story |
 * National"*. `cutToWord` was right — that is a word boundary — and the defect
 * was one step earlier: almost every page on the open web titles itself
 * `<subject> | <masthead>`, so a label taken from the raw title is the subject
 * plus however much of the publication fits in forty characters. The longer
 * the masthead, the less of the subject survives.
 *
 * `siteName` is already on the envelope and on that page it was exactly
 * *"National Centre for Writing | NCW"* — the string to remove — so this is
 * evidence rather than a guess. It is done **only** where the evidence is
 * there: a title with no `siteName` to match is left whole, because splitting
 * on the last separator would damage every title that legitimately contains
 * one. The separator has to be in front of the match for the same reason —
 * *"Everything about Firestore"* is a subject, not a masthead — and a title
 * that IS the masthead keeps it, because an empty heading is a broken screen.
 */
function withoutSiteName(rawTitle: string, rawSite: string | null): string {
  const title = rawTitle.replace(/\s+/g, ' ').trim();
  const site = (rawSite ?? '').replace(/\s+/g, ' ').trim();
  if (!site) return title;
  const at = title.toLowerCase().lastIndexOf(site.toLowerCase());
  if (at <= 0 || at + site.length !== title.length) return title;
  const head = title.slice(0, at);
  if (!/[|·•»–—\-:]\s*$/.test(head)) return title;
  return head.replace(/[\s|·•»–—\-:]+$/, '').trim() || title;
}

/**
 * SB-03 says never block the toast on Scout. When the model is unavailable or
 * useless, the heading path is the next best signal of where this sits, then
 * the page title. A worse label beats a spinner.
 */
export function fallbackLabel(e: CaptureEnvelope): string {
  const deepest = e.headingPath.at(-1);
  if (deepest) return cutToWord(deepest, FALLBACK_LABEL_MAX);
  return cutToWord(withoutSiteName(e.pageTitle, e.siteName), FALLBACK_LABEL_MAX) || 'Saved';
}
