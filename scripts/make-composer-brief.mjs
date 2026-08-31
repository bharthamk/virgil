/**
 * Builds the EXACT brief the Composer would send, from seed data plus the
 * deterministic comfort model, so a frontier model can be tested on the real
 * prompt rather than a hand-written approximation.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { computeComfort, registerFor } from '../core/dist/index.js';

const store = JSON.parse(readFileSync('.data/store.json', 'utf8'));
const order = JSON.parse(readFileSync('.data/seed-pin-order.json', 'utf8'));
const src = readFileSync('runner/src/seed/corpus.ts', 'utf8');
const body = src.slice(src.indexOf('export const SEED_PINS'));
const seed = eval(body.slice(body.indexOf('['), body.lastIndexOf('];') + 1));
const byId = Object.fromEntries(store.pins.map((p) => [p.id, p]));

// Group by the authored key — we are testing the Composer, not the Clusterer.
const groups = new Map();
seed.forEach((s, i) => {
  const pin = byId[order[i]];
  if (!pin) return;
  const g = groups.get(s.expect) ?? [];
  g.push(pin);
  groups.set(s.expect, g);
});

// Same signal history the Registrar will see.
const NOW = new Date();
const H = {
  'pubsub-delivery': [[4,'answer-wrong','negative'],[3,'depth-simpler','negative'],[2,'answer-correct','positive'],[1,'recall-check','positive'],[0,'answer-correct','positive']],
  'pubsub-ordering': [[3,'section-completed','positive'],[1,'depth-deeper','positive']],
  'iam-conditions': [[4,'answer-wrong','negative'],[3,'depth-simpler','negative'],[3,'answer-wrong','negative'],[2,'answer-wrong','negative'],[1,'section-abandoned','negative']],
  'cloudrun-coldstart': [[2,'section-completed','positive'],[1,'answer-correct','positive'],[0,'depth-deeper','positive']],
  'firestore-queries': [[4,'answer-correct','positive'],[4,'recall-check','positive'],[3,'answer-correct','positive'],[0,'answer-wrong','negative']],
  'intervals': [[5,'answer-wrong','negative'],[4,'answer-correct','positive'],[3,'answer-correct','positive'],[1,'recall-check','positive']],
  'seventh-chords': [[3,'section-completed','positive'],[2,'answer-correct','positive'],[1,'answer-wrong','negative']],
  'tritone-sub': [[1,'answer-correct','positive'],[0,'depth-simpler','negative'],[0,'section-abandoned','negative']],
  'sourdough-hydration': [],
};

const out = [];
for (const [key, pins] of groups) {
  const signals = (H[key] ?? []).map(([w, type, direction], i) => ({
    id: `${key}-${i}`, topicId: key, type, direction, invalidated: false, sourceEvent: 'seed',
    at: new Date(NOW.getTime() - (w * 7 + 2) * 86400000).toISOString(),
  }));
  const c = computeComfort(key, signals, NOW);
  out.push({
    key, comfort: Number(c.comfort.toFixed(2)), certainty: Number(c.certainty.toFixed(2)),
    regressed: c.regressed, evidenceCount: c.evidenceCount, register: registerFor(c),
    pins: pins.map((p) => ({
      id: p.id.slice(0, 8),
      type: p.type, note: p.note,
      confidence: p.enrichment?.confidence ?? 'reduced',
      assumes: p.enrichment?.assumedConcepts ?? [],
      material: (p.envelope.selection ?? p.envelope.surroundingText).replace(/\s+/g, ' ').slice(0, 600),
      source: `${p.id.slice(0, 8)}:origin`,
    })),
  });
}
out.sort((a, b) => a.comfort - b.comfort);
writeFileSync('scripts/composer-brief.json', JSON.stringify(out, null, 1));
console.log('registers assigned by the deterministic model:');
for (const t of out) console.log(`  ${t.key.padEnd(22)} comfort=${t.comfort} certainty=${t.certainty}${t.regressed ? ' REGRESSED' : ''} -> ${t.register}`);
