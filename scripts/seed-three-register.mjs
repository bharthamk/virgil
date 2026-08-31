/**
 * Layer decision-8's signal ledger onto an already-clustered board, and age the
 * board to what six weeks of use would have written.
 *
 * This is `cli.js history` with two differences, and no third:
 *
 *   1. it can layer a ledger other than the shipped one, and
 *   2. it sets each topic's `createdAt` and `lastExposedAt` from the board's own
 *      pins and signals instead of leaving them at "clustered five minutes ago"
 *      (see `board-shape.mjs` for why that is a fidelity fix rather than a
 *      thumb on the scale — two Gardener rules are unreachable without it).
 *
 * It matches authored keys to emergent topics with the seeder's own
 * `matchTopics`, so the Clusterer still earns the topics and nothing here
 * decides what a topic is.
 *
 *   node runner/dist/cli.js seed          # 21 pins
 *   node runner/dist/cli.js nightly       # the Clusterer earns the topics
 *   node scripts/seed-three-register.mjs  # this — the ledger and the ages
 *   node runner/dist/cli.js nightly       # the session under test
 *
 *   --history <name>   which table (default: three-register)
 *   --no-age           leave the topic dates as the Clusterer wrote them
 *   --manifest <path>  write the board manifest JSON here
 *
 * Refuses to touch `.data/`: that board is the 21-pin learner every number in
 * AGENT_EVAL_LOG.md is measured against, and another lane is running against it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { JsonStore } from '../adapters/dist/index.js';
import { computeComfort, registerFor, tend } from '../core/dist/index.js';
import { matchTopics } from '../runner/dist/seed/history.js';
import { HISTORY_TABLES, CAPTURE_SIGNAL } from './history-tables.mjs';
import { ageTopic } from './board-shape.mjs';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const die = (m) => { console.error(`seed-three-register: ${m}`); process.exit(2); };

const DB = process.env.SB_DB ?? '.data-3r/store.json';
if (DB.startsWith('.data/')) die(`refusing to write ${DB} — that is the shipped 21-pin board`);

const which = arg('history', 'three-register');
const table = HISTORY_TABLES[which];
if (!table) die(`no history table "${which}" — have: ${Object.keys(HISTORY_TABLES).join(', ')}`);
const age = !process.argv.includes('--no-age');

const orderPath = DB.replace(/[^/]+$/, 'seed-pin-order.json');
let order;
try { order = JSON.parse(readFileSync(orderPath, 'utf8')); }
catch { die(`no pin order at ${orderPath} — run \`SB_DB=${DB} node runner/dist/cli.js seed\` first`); }

const store = new JsonStore(DB);
const now = new Date();
const topicsBefore = await store.listTopics();
if (!topicsBefore.length) die(`${DB} holds no topics — run a nightly so the Clusterer earns them first`);

// ------------------------------------------------------------- the ledger

const mapping = matchTopics(topicsBefore, order);
let appended = 0;
for (const [key, beats] of Object.entries(table)) {
  const topicId = mapping.get(key);
  if (!topicId) { console.log(`  ! no emergent topic matched "${key}" — its ledger is not layered`); continue; }
  for (const b of beats) {
    const at = new Date(now);
    // The shipped seeder's offset, kept exactly: `w` weeks back plus two days,
    // so no seeded signal lands on the same instant as the run.
    at.setDate(at.getDate() - b.w * 7 - 2);
    await store.appendSignal({
      id: randomUUID(), topicId, type: b.type, direction: b.dir,
      at: at.toISOString(), sourceEvent: `seed:${which}:${key}:${b.w}`, invalidated: false,
    });
    appended++;
  }
}

// ------------------------------------------------------- the capture signal

// A pin is an attention signal and the product says so: `pin-interest` weighs
// 0.05, the lowest weight in the table, annotated "signals attention, not
// ability". One per pin, dated at the capture, is the weakest honest statement
// a ledger can make about a board, and it is one the board earns by existing.
//
// It is here because clustering is emergent and an authored ledger cannot
// reach a topic it did not predict. This run produced one — a single-pin
// "Voice Leading" the Clusterer split off — and a topic with zero evidence
// reads `from-nothing` at priority ~73, near the top of the board, for reasons
// that have nothing to do with the learner. With the capture signal it reads
// comfort 1.00 at certainty ~0.01: still `from-nothing`, because the certainty
// gate is doing exactly its job, and ranked last rather than second.
//
// Applied to every pin on the board without reference to which topic it lands
// on, so it cannot be aimed.
const capture = process.argv.includes('--capture');
let captured = 0;
if (capture) {
  for (const p of await store.listPins()) {
    if (!p.topicId) continue;
    await store.appendSignal({
      id: randomUUID(), topicId: p.topicId, type: CAPTURE_SIGNAL.type,
      direction: CAPTURE_SIGNAL.dir, at: p.capturedAt,
      sourceEvent: `seed:capture:${p.id}`, invalidated: false,
    });
    captured++;
  }
}

// --------------------------------------------------------------- the ages

const pins = await store.listPins();
const pinsByTopic = new Map();
for (const p of pins) {
  if (!p.topicId) continue;
  pinsByTopic.set(p.topicId, [...(pinsByTopic.get(p.topicId) ?? []), p]);
}
const allSignals = await store.listSignals();
const signalsByTopic = new Map();
for (const s of allSignals) {
  signalsByTopic.set(s.topicId, [...(signalsByTopic.get(s.topicId) ?? []), s]);
}

let aged = 0;
for (const t of topicsBefore) {
  if (!age) break;
  const dates = ageTopic(t, pinsByTopic.get(t.id) ?? [], signalsByTopic.get(t.id) ?? []);
  if (dates.createdAt === t.createdAt && dates.lastExposedAt === t.lastExposedAt) continue;
  await store.putTopic({ ...t, ...dates });
  aged++;
}

// ------------------------------------------------------- what it came to

const topics = await store.listTopics();
const signals = await store.listSignals();
const comforts = topics.map((t) => computeComfort(t.id, signals, now));
const decisions = tend({ topics, comforts, signals, now });
const byId = new Map(comforts.map((c) => [c.topicId, c]));
const decById = new Map(decisions.map((d) => [d.topicId, d]));
const keyOf = new Map([...mapping].map(([k, id]) => [id, k]));

console.log(`board:   ${DB}`);
console.log(`ledger:  ${which} — ${appended} signals across ${mapping.size} matched topics`);
console.log(`capture: ${capture ? `${captured} pin-interest signal(s), one per pin` : 'not seeded'}`);
console.log(`ages:    ${age ? `${aged} topic(s) dated from their own pins and ledger` : 'left as the Clusterer wrote them'}`);

// The clustering contract: same-page pins share a verbatim heading prefix and cluster
// near-automatically, so a seeded board can look artificially good. The demo
// board's rule is to state and maximise distinct-page count, and it is stated
// here, in the manifest, rather than asserted in prose somewhere else.
const distinctPages = new Set(pins.map((p) => p.envelope.url)).size;
const distinctSites = new Set(pins.map((p) => p.envelope.siteName).filter(Boolean)).size;
const distinctHosts = new Set(pins.map((p) => { try { return new URL(p.envelope.url).host; } catch { return null; } }).filter(Boolean)).size;
console.log(`board:   ${pins.length} pins, ${distinctPages} distinct pages, ${distinctSites} sites, ${distinctHosts} hosts, ${topics.length} topics`);

const manifest = {
  board: DB,
  builtAt: now.toISOString(),
  ledger: which,
  aged: age,
  captureSignal: capture,
  pins: pins.length,
  distinctPages,
  distinctSites,
  distinctHosts,
  pages: [...new Set(pins.map((p) => p.envelope.url))].sort(),
  topics: topics.map((t) => {
    const c = byId.get(t.id);
    const d = decById.get(t.id);
    return {
      id: t.id, label: t.label, authoredKey: keyOf.get(t.id) ?? null,
      pins: t.pinIds.length, createdAt: t.createdAt, lastExposedAt: t.lastExposedAt,
      comfort: Number(c.comfort.toFixed(4)), certainty: Number(c.certainty.toFixed(4)),
      evidenceCount: c.evidenceCount, regressed: c.regressed,
      register: registerFor(c), disposition: d.disposition, priority: d.priority,
    };
  }).sort((a, b) => b.priority - a.priority),
};
const manifestPath = arg('manifest', DB.replace(/[^/]+$/, 'board-manifest.json'));
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`manifest written to ${manifestPath}\n`);

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('topic', 36) + pad('comfort', 9) + pad('certain', 9) + pad('ev', 4)
  + pad('regr', 6) + pad('register', 14) + pad('disposition', 14) + 'prio');
for (const t of manifest.topics) {
  console.log(pad(t.label.slice(0, 35), 36) + pad(t.comfort.toFixed(3), 9)
    + pad(t.certainty.toFixed(3), 9) + pad(t.evidenceCount, 4)
    + pad(t.regressed ? 'YES' : '-', 6) + pad(t.register, 14)
    + pad(t.disposition, 14) + t.priority);
}
