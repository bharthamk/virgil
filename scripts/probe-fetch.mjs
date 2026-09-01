import { LocalResearch } from '../adapters/dist/index.js';
import { readFileSync } from 'node:fs';
const pins = JSON.parse(readFileSync('scripts/eval-pins.json', 'utf8'));
const r = new LocalResearch();
const seen = new Set();
let ok = 0, fail = 0, thin = 0;
for (const p of pins) {
  if (seen.has(p.url)) continue;
  seen.add(p.url);
  const t = Date.now();
  const got = await r.fetchPage(p.url);
  const ms = Date.now() - t;
  if (!got) { fail++; console.log(`FAIL   ${String(ms).padStart(5)}ms  ${p.url}`); continue; }
  const words = got.text.split(/\s+/).length;
  // Does the page actually still contain what the learner highlighted?
  const probe = (p.selection ?? p.surrounding).slice(0, 50);
  const hasSel = got.text.includes(probe);
  if (words < 300) { thin++; console.log(`THIN   ${String(ms).padStart(5)}ms  ${words}w  ${p.url}`); continue; }
  ok++;
  console.log(`OK     ${String(ms).padStart(5)}ms  ${String(words).padStart(6)}w  sel=${hasSel ? 'found' : 'MISSING'}  ${p.url}`);
}
console.log(`\nfetched ${ok} usable, ${thin} too thin, ${fail} failed, of ${seen.size} unique URLs`);
