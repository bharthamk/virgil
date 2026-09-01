import {
  CONTEXT_LABEL, DRAFT_LABEL, RUBRIC_LABEL,
  checkMinimumShortfall, esc, reviewFramingLine,
  type CheckHandoffView, type CheckLimitsView,
} from './panel-core.js';

/** Static Check workspace furniture, kept out of the already-stateful renderer. */
export function checkFormHtml(visionAccept: string, uploadAccept: string): string {
  return `<div class="repair-choice check-form" data-phase="compose">
    <details class="check-editor" open>
      <summary><span class="check-editor-title">Edit this check</span><span class="meta check-editor-summary"></span></summary>
      <div class="check-fields">
        <section class="check-draft-card" aria-labelledby="check-draft-label">
          <label id="check-draft-label" for="check-draft">${esc(DRAFT_LABEL)}</label>
          <p id="check-draft-help" class="meta draft-why"></p>
          <div class="paste-box" data-box="draft">
            <textarea id="check-draft" class="statement-edit draft" placeholder="Paste it here…" aria-describedby="check-draft-help check-draft-status check-draft-size"></textarea>
            <div class="attachment"></div>
            <div class="dropper">
              <button class="check-upload" data-pick="draft" aria-label="Add a document or screenshot">
                <span>Add a document or screenshot</span><span class="meta how">PDF, Word, text, PNG or JPEG</span>
              </button>
              <input type="file" class="picker" data-file="draft" accept="${visionAccept}" hidden>
            </div>
            <p id="check-draft-status" class="meta read-note" aria-live="polite"></p>
            <p id="check-draft-size" class="meta size-note"></p>
          </div>
        </section>
        <aside class="check-options" aria-label="Optional check details">
          <details class="check-option" data-option="rubric">
            <summary><span>${esc(RUBRIC_LABEL)}</span><span class="meta">Optional</span></summary>
            <div class="check-option-body">
              <label class="sr-only" for="check-rubric">${esc(RUBRIC_LABEL)} (optional)</label>
              <p id="check-rubric-help" class="meta rubric-why"></p>
              <div class="paste-box" data-box="rubric">
                <textarea id="check-rubric" class="statement-edit rubric" placeholder="One criterion per line…" aria-describedby="check-rubric-help check-rubric-limit check-rubric-status check-rubric-size"></textarea>
                <div class="dropper compact"><button class="link" data-pick="rubric">Add criteria from a file</button><input type="file" class="picker" data-file="rubric" accept="${uploadAccept}" hidden></div>
                <p id="check-rubric-limit" class="meta rubric-limit"></p>
                <p id="check-rubric-status" class="meta read-note" aria-live="polite"></p>
                <div class="transcribe-offer"></div><p id="check-rubric-size" class="meta size-note"></p>
              </div>
            </div>
          </details>
          <details class="check-option" data-option="context">
            <summary><span>${esc(CONTEXT_LABEL)}</span><span class="meta">Optional</span></summary>
            <div class="check-option-body">
              <label class="sr-only" for="check-context">${esc(CONTEXT_LABEL)} (optional)</label>
              <p id="check-context-help" class="meta context-why"></p>
              <div class="paste-box" data-box="context">
                <textarea id="check-context" class="statement-edit context" placeholder="Brief, earlier feedback or anything else that matters…" aria-describedby="check-context-help check-context-size"></textarea>
                <p id="check-context-size" class="meta size-note"></p>
              </div>
            </div>
          </details>
        </aside>
      </div>
      <p class="meta window-note"></p>
      <div class="check-action-bar">
        <div class="check-ready"><strong class="check-ready-line"></strong>
          <details class="check-handoff"><summary>Check details</summary><div class="check-handoff-lines"></div><p class="meta check-file-block" role="status"></p><div class="check-file-recovery"></div></details>
        </div>
        <button class="primary" data-check>Check it</button>
      </div>
      <div class="note"></div><div class="meta check-authorship">${esc(reviewFramingLine())}</div>
    </details>
  </div>`;
}

/** One ordinary-language state beside Check's only primary action. */
export function checkReadinessLine(input: CheckHandoffView, limits: CheckLimitsView): string {
  const marked = input.rubric.trim().length > 0;
  const shortfall = checkMinimumShortfall(input, limits);
  if (!input.draftChars && !input.attachment && !marked && !input.contextChars) return 'Add your work to begin.';
  if (shortfall > 0) return `${shortfall.toLocaleString('en-US')} character${shortfall === 1 ? '' : 's'} to go`;
  const count = (value: number, noun: string): string =>
    `${value.toLocaleString('en-US')} ${noun}${value === 1 ? '' : 's'}`;
  const included = ['Ready'];
  included.push(input.attachment
    ? count(input.attachment.kind === 'image' ? 1 : input.attachment.pages,
      input.attachment.kind === 'image' ? 'image' : 'page')
    : count(input.draftReadyChars ?? input.draftChars, 'character'));
  if (marked) {
    const criteria = input.rubric.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
    included.push(count(criteria, 'criterion').replace(/criterions$/, 'criteria'));
  } else included.push('clarity and reasoning review');
  if (input.contextChars > 0) included.push('context included');
  return included.join(' · ');
}

/** Triage result rows without losing their order inside each verdict group. */
export function groupCheckCriteria<T extends { readonly verdict: string }>(rows: readonly T[]):
readonly { readonly key: string; readonly title: string; readonly rows: readonly T[] }[] {
  return [
    { key: 'needs-work', title: 'Needs work', accepts: ['does-not-meet', 'partial'] },
    { key: 'unreadable', title: 'Needs another check', accepts: [] },
    { key: 'met', title: 'Met', accepts: ['meets'] },
  ].map((group) => ({ ...group, rows: rows.filter(({ verdict }) =>
    group.key === 'unreadable'
      ? !['does-not-meet', 'partial', 'meets'].includes(verdict)
      : group.accepts.includes(verdict)) }))
    .filter((group) => group.rows.length > 0);
}
