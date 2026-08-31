#!/usr/bin/env node
/**
 * Replace the committed demo board's capture envelopes with the authored seed.
 * IDs, joins, learning signals and composed acceptance receipts stay intact;
 * captured webpage excerpts and live source URLs do not.
 *
 * This script is intentionally narrow. It will only touch the 21-pin demo
 * whose order file matches the store, and it refuses partial mappings.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { SEED_PINS } from '../runner/dist/seed/corpus.js';

const storeUrl = new URL('../.data/store.json', import.meta.url);
const orderUrl = new URL('../.data/seed-pin-order.json', import.meta.url);
const store = JSON.parse(readFileSync(storeUrl, 'utf8'));
const order = JSON.parse(readFileSync(orderUrl, 'utf8'));

if (!Array.isArray(store.pins) || !Array.isArray(order)
  || order.length !== SEED_PINS.length || store.pins.length !== order.length) {
  throw new Error('refusing to sanitize: this is not the 21-pin committed demo board');
}

const byId = new Map(store.pins.map((pin) => [pin.id, pin]));
for (const [index, id] of order.entries()) {
  const pin = byId.get(id);
  const source = SEED_PINS[index];
  if (!pin || !source) throw new Error(`refusing partial mapping at ${index}`);
  const url = `https://example.invalid/virgil-seed/${source.expect}/${index + 1}`;
  pin.type = source.type;
  pin.envelope = {
    ...pin.envelope,
    selection: source.selection,
    parts: source.parts?.map((part) => ({ ...part })) ?? [],
    surroundingText: source.surrounding,
    headingPath: [...source.headings],
    pageTitle: `${source.title} — synthetic demo`,
    url,
    canonicalUrl: null,
    siteName: 'example.invalid',
    contentLanguage: 'en',
    media: null,
  };
  pin.note = source.note ?? null;
  if (pin.enrichment) {
    pin.enrichment.refetchedText = null;
    pin.enrichment.assumedConcepts = [`synthetic ${source.expect} prerequisite`];
    pin.enrichment.references = (pin.enrichment.references ?? []).map((reference) => ({
      ...reference,
      url,
      title: `${source.title} — synthetic demo`,
    }));
  }
}

writeFileSync(storeUrl, `${JSON.stringify(store, null, 2)}\n`);
console.log(`sanitized ${order.length} demo pins; ids and learning receipts preserved`);
