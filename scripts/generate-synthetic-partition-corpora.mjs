#!/usr/bin/env node
/**
 * Generate the deterministic 21-pin and 80-pin partition fixtures from the
 * Virgil-authored seed corpus. No captured webpage text enters these files.
 * Run `npm run build` first so the compiled corpus is current.
 */
import { writeFileSync } from 'node:fs';
import { SEED_PINS } from '../runner/dist/seed/corpus.js';

const flat = (source, id, capturedAt, suffix = '') => ({
  id,
  capturedAt,
  type: source.type,
  url: `https://example.invalid/virgil-seed/${source.expect}/${id}`,
  site: 'example.invalid',
  title: `${source.title}${suffix}`,
  headings: [...source.headings],
  selection: source.selection === null
    ? null
    : `${source.selection}${suffix ? ` ${suffix.trim()} keeps this authored follow-up distinct.` : ''}`,
  surrounding: `${source.surrounding} Synthetic fixture marker: ${source.expect}.`,
  ...(source.note ? { note: source.note } : {}),
  ...(source.parts ? { parts: source.parts.map((part) => ({ ...part })) } : {}),
});

const scale = [];
for (let i = 0; i < 80; i += 1) {
  const source = SEED_PINS[i % SEED_PINS.length];
  const id = `pin-${String(i + 1).padStart(2, '0')}`;
  const date = `2026-07-${String(1 + ((i * 5) % 27)).padStart(2, '0')}`;
  const round = Math.floor(i / SEED_PINS.length);
  scale.push(flat(source, id, date, round === 0 ? '' : ` — synthetic follow-up ${round}`));
}

const evaluation = scale.slice(0, SEED_PINS.length);
if (evaluation.length !== 21 || scale.length !== 80) throw new Error('fixture cardinality drifted');
writeFileSync(new URL('./eval-pins.json', import.meta.url), `${JSON.stringify(evaluation, null, 2)}\n`);
writeFileSync(new URL('./scale-pins.json', import.meta.url), `${JSON.stringify(scale, null, 2)}\n`);
console.log(`wrote ${evaluation.length} evaluation pins and ${scale.length} scale pins`);
