/**
 * Which registers a night COMPOSED, and which of them the learner was SHIPPED.
 *
 * The distinction is the whole result of the register-evidence distinction and the scorecard cannot
 * make it. `register-spread` counts registers on the sections that survived,
 * which is the right thing for a scorecard to count — it grades the artefact
 * the learner gets. But a section the Verifier withheld was still written, at a
 * register the Composer was told to write it at, and "the machinery produced
 * three registers" and "the learner saw three registers" are two different
 * claims that a single number cannot keep apart.
 *
 * A withheld section's register is recoverable without trusting anything the
 * model said about it: register is a pure function of the ledger
 * (`domain/registers.ts`), the stored withhold carries the topic id, and this
 * calls the same `registerFor(computeComfort(...))` the Composer called. It is
 * derived, not remembered.
 *
 *   node scripts/register-audit.mjs <store.json> [<store.json> ...]
 */
import { existsSync } from 'node:fs';
import { JsonStore } from '../adapters/dist/index.js';
import { computeComfort, registerFor } from '../core/dist/index.js';

const paths = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!paths.length) { console.error('register-audit: give me one or more store paths'); process.exit(2); }

const ORDER = ['from-nothing', 'building', 'fluent'];
const tally = (rs) => ORDER.filter((r) => rs.includes(r));

for (const path of paths) {
  if (!existsSync(path)) { console.error(`register-audit: no store at ${path}`); process.exit(2); }
  const store = new JsonStore(path);
  const session = await store.latestSession();
  if (!session) { console.log(`${path}: no session`); continue; }
  const signals = await store.listSignals();
  const topics = await store.listTopics();
  const labelOf = new Map(topics.map((t) => [t.id, t.label]));
  const at = new Date(session.builtAt ?? Date.now());
  const regOf = (topicId) => registerFor(computeComfort(topicId, signals, at));

  const shipped = session.sections.map((s) => ({
    register: s.depth, derived: regOf(s.topicId),
    label: labelOf.get(s.topicId) ?? s.topicId, heading: s.heading, state: 'shipped',
    reason: null,
  }));
  const refused = (session.withheld ?? []).map((w) => ({
    // A withheld section carries no register on the store — derived from the
    // ledger by the same function the Composer used to choose it.
    register: regOf(w.topicId), derived: regOf(w.topicId),
    label: labelOf.get(w.topicId) ?? w.topicId, heading: w.heading, state: 'WITHHELD',
    reason: w.reason,
  }));
  const all = [...shipped, ...refused];

  console.log(`\n=== ${path}`);
  console.log(`    built ${session.builtAt} · ${shipped.length} shipped, ${refused.length} withheld`);
  for (const r of all) {
    const flag = r.state === 'shipped' && r.register !== r.derived ? '  !! register does not match the ledger' : '';
    console.log(`    ${r.state.padEnd(9)} ${r.register.padEnd(13)} ${String(r.label).padEnd(28)} ${r.heading}`
      + (r.reason ? `  (${r.reason})` : '') + flag);
  }
  const composed = tally(all.map((r) => r.register));
  const delivered = tally(shipped.map((r) => r.register));
  console.log(`    COMPOSED registers: ${composed.length}/3 — ${composed.join(', ') || 'none'}`);
  console.log(`    SHIPPED  registers: ${delivered.length}/3 — ${delivered.join(', ') || 'none'}`);
}
