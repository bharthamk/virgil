import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mountWebMcpReceipt } from '../webmcp-receipt.js';
import { El, click, find, installPanelDom, text } from './panel-dom.js';

const make = (markup: string): HTMLElement => {
  const host = new El('div');
  host.innerHTML = markup;
  return host.firstElementChild as unknown as HTMLElement;
};

test('a browser-agent receipt is replaceable, reviewable and dismissible', async (t) => {
  const dom = installPanelDom();
  t.after(() => dom.uninstall());
  let reviews = 0;
  mountWebMcpReceipt(dom.app as unknown as HTMLElement,
    { kind: 'drop', summary: 'Material added' }, make, () => { reviews += 1; });
  assert.match(text(find(dom.app, '.webmcp-receipt')), /readable material is on your board/);

  mountWebMcpReceipt(dom.app as unknown as HTMLElement,
    { kind: 'draft', summary: 'Draft made' }, make, () => { reviews += 1; });
  assert.equal(dom.app.querySelectorAll('.webmcp-receipt').length, 1);
  assert.match(text(find(dom.app, '.webmcp-receipt')), /course details are a draft/);
  await click(find(dom.app, '[data-review]'));
  assert.equal(reviews, 1);
  assert.equal(dom.app.querySelector('.webmcp-receipt'), null);

  mountWebMcpReceipt(dom.app as unknown as HTMLElement,
    { kind: 'drop', summary: 'Material added' }, make, () => { reviews += 1; });
  await click(find(dom.app, '[data-close]'));
  assert.equal(dom.app.querySelector('.webmcp-receipt'), null);
  assert.equal(reviews, 1);
});
