import type { WebMcpReceipt } from './webmcp.js';

type ElementFactory = (markup: string) => HTMLElement;

/** Mount a visible, non-modal receipt without disturbing the learner's open form. */
export function mountWebMcpReceipt(
  app: HTMLElement, receipt: WebMcpReceipt, makeElement: ElementFactory, onReview: () => void,
): void {
  app.querySelector('.webmcp-receipt')?.remove();
  const notice = makeElement(`<aside class="webmcp-receipt" role="status" aria-live="polite">
    <div><strong>Added by your browser agent</strong><p></p></div>
    <div class="row"><button class="primary" data-review>Review in My studies</button><button class="link" data-close aria-label="Close agent receipt">Close</button></div>
  </aside>`);
  const message = notice.querySelector('p') as HTMLElement;
  message.textContent = receipt.kind === 'drop'
    ? 'The readable material is on your board. Any course details are still proposals.'
    : 'The course details are a draft. Nothing enters your plan until you apply it.';
  notice.querySelector('[data-review]')?.addEventListener('click', () => {
    notice.remove();
    onReview();
  });
  notice.querySelector('[data-close]')?.addEventListener('click', () => notice.remove());
  app.append(notice);
}
