/**
 * WHAT THE NIGHT PROPOSED COLLECTING, AS A PERSON READS IT.
 *
 * The rest of this product shows a learner their own material back. This is the
 * one screen that shows them something they never saved, which makes it the one
 * screen where the copy has a job beyond being clear: it has to say, without
 * being asked, where the suggestion came from and how much of it is guesswork.
 *
 * Three rules, and each one is a sentence on the screen rather than a comment:
 *
 *  - **Say what the evidence was.** Every proposal is drawn under the line from
 *    the board that produced it. A reason with no evidence beside it is a
 *    recommendation, and this product does not make recommendations.
 *  - **Say the address has not been read.** A phrase and a link sitting under a
 *    confident sentence look checked. Neither is. Nothing in this product has
 *    opened that page, and the screen says so above the link rather than in a
 *    footnote under it.
 *  - **Say when the ground is a guess.** A proposal can stand on a sentence
 *    Virgil wrote about the learner and the learner has never answered. That is
 *    a different object from a check that failed or a concept two sources
 *    assumed, and the difference is invisible in a well written reason, because
 *    a well written reason reads like a fact either way. So the caveat is a
 *    sentence under the reason rather than a tone in it, in the register the
 *    modality card already uses: a read, not a fact.
 *  - **Say what a decision writes.** Keeping one saves the address, unread, and
 *    nothing else. Leaving one out writes the decision and nothing else. Both
 *    are stated when the button is pressed, in the sentence that replaces it.
 *
 * A rendering module on the `arrival.ts` model: it builds DOM, it holds no
 * route, and anything that writes is handed in by the shell.
 */

const el = (html: string): HTMLElement => {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html.trim();
  return wrapper.firstElementChild as HTMLElement;
};

export interface ProspectLeadView {
  readonly phrase: string;
  readonly url?: string | null;
}

export interface ProspectProposalView {
  readonly id: string;
  readonly subject: string;
  readonly reason: string;
  readonly evidenceKind: string;
  /**
   * The code's own name for the record this was built on, never shown.
   *
   * Optional because a proposal from a service too old to send it has none, and
   * because nothing on this screen draws it: the Insights room reads it to work
   * out which of its own sentences already has something standing on it.
   */
  readonly evidenceKey?: string;
  readonly evidenceDetail: string;
  /**
   * True when this stands on a sentence about the learner they never agreed to.
   *
   * Optional because a proposal raised before this field existed does not carry
   * it, and absent has to read as no caveat: those were all built off a check,
   * a source count or a mark in the ledger, and stamping a hedge on them after
   * the fact would be the product doubting a record it has.
   */
  readonly evidenceUnconfirmed?: boolean;
  readonly lead?: ProspectLeadView | null;
}

/** What the learner does with one. The shell owns the request. */
export type ProspectDecision = 'accepted' | 'dismissed';

export const PROSPECT_HEADING = 'Worth collecting';

/**
 * The section's one sentence, and every clause in it is load-bearing.
 *
 * It names the input (their own gaps), the output (a suggestion), the state
 * (nothing added), and who decides. An earlier draft said Virgil "found" these,
 * which claims a search nothing performed.
 */
export const PROSPECT_INTRO = 'These come from gaps already on your board. '
  + 'Nothing has been added and no page has been read. You decide what is worth having.';

export const PROSPECT_EVIDENCE_LABEL = 'What this came from';
export const PROSPECT_LEAD_LABEL = 'Where to look';
export const PROSPECT_KEEP_LABEL = 'Worth having';
export const PROSPECT_DISMISS_LABEL = 'Not for me';

/** Said above any address, never below it. */
export const PROSPECT_UNREAD_LINE = 'This address was named from memory and has not been opened. '
  + 'Treat it as a lead, not a source.';

/**
 * Said under any reason built on a sentence the learner has not answered.
 *
 * Written in the panel's own two words for the same distinction. Every insight
 * on the model screen is badged either `my read` or `your words`, and a person
 * who has used this product for a week already knows which of those they are
 * allowed to argue with. Reusing them here means the caveat needs no explaining
 * and cannot drift into a different claim: this is the same fact, on a screen
 * that reached the sentence from a different direction.
 */
export const PROSPECT_UNCONFIRMED_LINE = 'This stands on my read of you, not on your words. '
  + 'Nothing has confirmed it, so take the reason as my read rather than as settled.';

export const PROSPECT_WORKING_LINE = 'Saving your answer…';
export const PROSPECT_FAILED_LINE = 'That did not go through. Nothing changed.';

/**
 * What keeping one actually did, in two versions, because it does two different
 * things and a single sentence covering both would be false about one of them.
 */
export const prospectKeptLine = (saved: boolean): string => saved
  ? 'Kept. The address is saved unread and gets read before your next session. '
    + 'It is on your board as material, and nothing else has changed.'
  : 'Kept. There was no address to save, so this one is yours to go and find. '
    + 'Nothing has been added.';

export const PROSPECT_DISMISSED_LINE = 'Left out. This one will not come back.';

/** Where the gap came from, in the learner's terms rather than the code's. */
export const PROSPECT_KIND_LINES: Readonly<Record<string, string>> = {
  'shaky-statement': 'a read of you that the evidence does not settle',
  'check-finding': 'a check on your own writing',
  'prerequisite-hole': 'something your sources assume you know',
  'avoided-topic': 'a topic you keep setting aside',
  'slipping-item': 'something that keeps slipping while you work on other things',
  // Authorship deliberately left out of this line. Whether the sentence is mine
  // or yours is the next line's job, and saying it twice in two registers is
  // how a screen ends up contradicting itself.
  'shortfall-read': 'a gap named in your insights',
};

const kindLine = (kind: string): string => PROSPECT_KIND_LINES[kind] ?? 'your board';

/**
 * One proposal, with its evidence, its lead and its two answers.
 *
 * `decide` returns whether the service took the answer. The row reports the
 * outcome either way and never removes itself on a failure: a card that
 * vanished after a request that did not land would tell somebody they had
 * decided something they had not.
 */
export function prospectBlock(
  proposal: ProspectProposalView,
  decide: (id: string, state: ProspectDecision) => Promise<boolean>,
): HTMLElement {
  const node = el(`<article class="prospect" data-prospect="">
    <h3></h3>
    <p class="reason"></p>
    <p class="evidence"><span class="label"></span> <span class="detail"></span></p>
    <div class="row">
      <button data-keep></button>
      <button data-dismiss class="secondary"></button>
    </div>
    <p class="note" role="status" aria-live="polite"></p>
  </article>`);
  node.dataset['prospect'] = proposal.id;
  (node.querySelector('h3') as HTMLElement).textContent = proposal.subject;
  const reason = node.querySelector('.reason') as HTMLElement;
  reason.textContent = proposal.reason;

  /**
   * Built rather than hidden, on the same rule as the lead below.
   *
   * A row always in the tree and sometimes empty is a row a stylesheet can
   * reveal, and what it would reveal here is a proposal calling its own
   * evidence a guess when the evidence was a check that actually failed. It
   * goes immediately under the reason because that is the sentence it qualifies
   * and a caveat further down the card is a caveat somebody reads second.
   */
  if (proposal.evidenceUnconfirmed) {
    const caveat = el('<p class="unconfirmed"></p>');
    caveat.textContent = PROSPECT_UNCONFIRMED_LINE;
    node.insertBefore(caveat, node.querySelector('.evidence'));
  }

  (node.querySelector('.evidence .label') as HTMLElement).textContent =
    `${PROSPECT_EVIDENCE_LABEL} (${kindLine(proposal.evidenceKind)}):`;
  (node.querySelector('.evidence .detail') as HTMLElement).textContent = proposal.evidenceDetail;

  /**
   * The lead is built rather than hidden, and only when there is one.
   *
   * A row that is always in the tree and sometimes invisible is a row that can
   * be revealed by a stylesheet change, and what it would reveal here is an
   * empty "where to look" under a proposal that has nowhere to point.
   */
  const phrase = proposal.lead?.phrase ?? '';
  const url = proposal.lead?.url ?? null;
  if (phrase) {
    const lead = el('<div class="lead"><p class="unread"></p><p class="phrase"></p></div>');
    (lead.querySelector('.unread') as HTMLElement).textContent = url ? PROSPECT_UNREAD_LINE : '';
    (lead.querySelector('.phrase') as HTMLElement).textContent =
      `${PROSPECT_LEAD_LABEL}: ${phrase}${url ? ` (${url})` : ''}`;
    node.insertBefore(lead, node.querySelector('.row'));
  }

  const keep = node.querySelector('[data-keep]') as HTMLButtonElement;
  const dismiss = node.querySelector('[data-dismiss]') as HTMLButtonElement;
  const note = node.querySelector('.note') as HTMLElement;
  keep.textContent = PROSPECT_KEEP_LABEL;
  dismiss.textContent = PROSPECT_DISMISS_LABEL;

  const answer = async (state: ProspectDecision): Promise<void> => {
    keep.disabled = true;
    dismiss.disabled = true;
    note.textContent = PROSPECT_WORKING_LINE;
    const done = await decide(proposal.id, state);
    if (!done) {
      keep.disabled = false;
      dismiss.disabled = false;
      note.textContent = PROSPECT_FAILED_LINE;
      return;
    }
    // Removed rather than disabled: the answer has been given, and a control
    // that stays on screen greyed out is a screen still asking the question.
    (node.querySelector('.row') as HTMLElement).remove();
    note.textContent = state === 'accepted'
      ? prospectKeptLine(Boolean(url))
      : PROSPECT_DISMISSED_LINE;
  };
  keep.addEventListener('click', () => void answer('accepted'));
  dismiss.addEventListener('click', () => void answer('dismissed'));
  return node;
}

/** The whole section, drawn only when something is actually waiting. */
export function prospectSection(
  proposals: readonly ProspectProposalView[],
  decide: (id: string, state: ProspectDecision) => Promise<boolean>,
): HTMLElement {
  const node = el(`<section class="prospect-review">
    <h2></h2>
    <p class="setting-explain"></p>
    <details>
      <summary></summary>
      <div class="prospect-list"></div>
    </details>
  </section>`);
  (node.querySelector('h2') as HTMLElement).textContent = PROSPECT_HEADING;
  (node.querySelector('.setting-explain') as HTMLElement).textContent = PROSPECT_INTRO;
  (node.querySelector('summary') as HTMLElement).textContent =
    `Review ${proposals.length} ${proposals.length === 1 ? 'suggestion' : 'suggestions'}`;
  const list = node.querySelector('.prospect-list') as HTMLElement;
  for (const proposal of proposals) list.append(prospectBlock(proposal, decide));
  return node;
}

// ------------------------------------------------------------- the switch

export const PROSPECT_SETTING_LABEL = 'Look for material I have not collected';
export const PROSPECT_SETTING_EXPLAIN = 'On, Virgil proposes a few things to collect '
  + 'from the gaps on your board. Off, it works only with what you have given it. '
  + 'Either way it writes nothing you have not reviewed.';
export const PROSPECT_SETTING_SAVING = 'Saving what Virgil looks for…';
export const PROSPECT_SETTING_FAILED = "That didn't go through. Nothing changed.";

/**
 * One checkbox, in the section that already owns what the background work does.
 *
 * It carries its own button and its own status line and hands both back to the
 * shell, because the shell owns the one door every preference write goes
 * through and this module owns no route. A row that wrote its own preference
 * would be a second write path for the same field.
 */
export function prospectSettingRow(
  on: boolean,
  write: (next: boolean, control: HTMLInputElement, note: HTMLElement) => Promise<boolean>,
): HTMLElement {
  const node = el(`<div class="row prospect-setting">
    <label class="setting-check"><input type="checkbox" data-prospect-pref><span></span></label>
    <p class="setting-explain"></p>
    <p class="note" role="status" aria-live="polite"></p>
  </div>`);
  const box = node.querySelector('input') as HTMLInputElement;
  const note = node.querySelector('.note') as HTMLElement;
  box.checked = on;
  (node.querySelector('label span') as HTMLElement).textContent = PROSPECT_SETTING_LABEL;
  (node.querySelector('.setting-explain') as HTMLElement).textContent = PROSPECT_SETTING_EXPLAIN;
  box.addEventListener('change', async () => {
    const next = box.checked;
    const saved = await write(next, box, note);
    if (!saved) box.checked = on;
  });
  return node;
}

/**
 * WHICH SENTENCE A PROPOSAL STANDS ON, WHERE IT STANDS ON ONE AT ALL.
 *
 * The scout's evidence keys are positional in nothing and opaque by design, and
 * exactly two of its six kinds name a statement: `statement:<id>` is the read
 * the arithmetic said was shaky, and `read:<id>` is the shortfall the board
 * wrote about somebody. The other four name a signal, a topic, a concept or an
 * item on the plan, and reading a statement out of one of those would be
 * inventing a link the record does not hold.
 *
 * So this is a read of the key and nothing else. A proposal with no key, from a
 * service that predates it, names nothing rather than being guessed at.
 */
export function statementsCitedByProposals(
  proposals: readonly ProspectProposalView[],
): ReadonlySet<string> {
  const cited = new Set<string>();
  for (const proposal of proposals) {
    const key = typeof proposal.evidenceKey === 'string' ? proposal.evidenceKey : '';
    const match = /^(?:statement|read):(.+)$/.exec(key);
    if (match?.[1]) cited.add(match[1]);
  }
  return cited;
}
