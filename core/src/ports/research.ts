import type { SourceRecord } from '../domain/types.js';

export interface FetchedPage {
  /** Compact prose for Forager's evidence and language checks. */
  readonly text: string;
  readonly title: string | null;
  /**
   * Optional block-aware text for course intake, where headings, table rows and
   * separate deadlines must not be collapsed into one line. Optional keeps
   * custom Research providers compatible; the intake receipt discloses when it
   * has to fall back to `text`.
   */
  readonly structuredText?: string;
}

/**
 * The outside-world seam — used by Forager and fetched course sources.
 *
 * Local implementation now; Gemini's Google Search grounding at port. Kept
 * separate from `Llm` because grounding is a capability some providers have and
 * others do not, and the product should degrade rather than break.
 */
export interface Research {
  /** SB-20: re-fetch a pinned page to read around the selection. */
  fetchPage(url: string): Promise<FetchedPage | null>;

  /**
   * SB-34: source starting material for an intent-only topic, and fill concepts
   * a pin assumes but does not explain. Every result carries provenance.
   */
  findReferences(query: string, limit: number): Promise<readonly SourceRecord[]>;

  /** Honest capability report — Forager narrows its claims when false. */
  readonly hasGrounding: boolean;
}
