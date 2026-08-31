/**
 * Seeds the 80-pin scale corpus into a store of its own.
 *
 * Deliberately not part of `cli.js seed`, which loads the 21-pin learner the
 * whole evaluation record is written against. That corpus and its golden key
 * are the baseline every number in AGENT_EVAL_LOG.md is measured from, and a
 * scale run must not be able to overwrite them by accident.
 *
 * The runner already selects its store with `SB_DB`, so isolation needs no
 * runner change — only a different path:
 *
 *   node scripts/seed-scale.mjs                       # writes .data-scale/store.json
 *   SB_DB=.data-scale/store.json node runner/dist/cli.js nightly
 *
 * Pins go in raw: no topics, no enrichment, no signals. The fleet earns those,
 * the same way it does on the seeded board.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { JsonStore } from '../adapters/dist/index.js';

const DB = process.env.SB_DB ?? '.data-scale/store.json';
if (DB.startsWith('.data/')) {
  // The one mistake this script must not be able to make.
  throw new Error(`refusing to seed the scale corpus into ${DB} — that is the 21-pin board`);
}

const raw = JSON.parse(readFileSync('scripts/scale-pins.json', 'utf8'));
const store = new JsonStore(DB);
await store.deleteEverything();

const ids = [];
for (const p of raw) {
  const id = randomUUID();
  ids.push({ fixtureId: p.id, id });
  await store.putPin({
    id,
    type: p.type,
    envelope: {
      selection: p.selection ?? null,
      parts: p.parts ?? [],
      surroundingText: p.surrounding ?? '',
      headingPath: p.headings ?? [],
      pageTitle: p.title ?? '',
      url: p.url ?? '',
      canonicalUrl: null,
      siteName: p.site ?? null,
      contentLanguage: 'en',
      media: null,
    },
    note: p.note ?? null,
    capturedAt: new Date(p.capturedAt).toISOString(),
    fromSuggestion: false,
    enrichment: null,
    topicId: null,
  });
}

const selections = raw.map((p) => (p.selection ?? p.surrounding).length).sort((a, b) => a - b);
console.log(`seeded ${ids.length} pins into ${DB} — no topics, no enrichment`);
console.log(`  selection length: median ${selections[Math.floor(selections.length / 2)]}`
  + `, max ${selections.at(-1)} chars`);
console.log(`  run:  SB_DB=${DB} node runner/dist/cli.js nightly`);
