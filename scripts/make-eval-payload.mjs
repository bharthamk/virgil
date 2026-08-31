import { readFileSync, writeFileSync } from 'node:fs';
const src = readFileSync('runner/src/seed/corpus.ts', 'utf8');
// crude but sufficient: evaluate the array literal after stripping types
const body = src.slice(src.indexOf('export const SEED_PINS'));
const arr = body.slice(body.indexOf('['), body.lastIndexOf('];') + 1);
const pins = eval(arr);
const today = new Date('2026-08-19T09:00:00Z');
const out = pins.map((p, i) => {
  const d = new Date(today);
  d.setDate(d.getDate() - (p.week * 7) - p.day);
  const { expect, week, day, ...rest } = p;
  return { id: `pin-${String(i + 1).padStart(2, '0')}`, capturedAt: d.toISOString().slice(0, 10), ...rest };
});
writeFileSync('scripts/eval-pins.json', JSON.stringify(out, null, 1));
writeFileSync('scripts/eval-expected.json', JSON.stringify(
  pins.map((p, i) => ({ id: `pin-${String(i + 1).padStart(2, '0')}`, expect: p.expect })), null, 1));
console.log(`${out.length} pins, ${new Set(pins.map(p=>p.expect)).size} expected clusters`);
