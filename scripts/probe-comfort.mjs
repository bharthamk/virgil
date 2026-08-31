/**
 * What registers would tonight's session carry, and why?
 *
 * Offline, deterministic, no model, no network. It calls the product's own
 * `computeComfort`, `registerFor` and `tend`, and quotes the Composer's own
 * capacity rule, so the numbers it prints are the numbers the nightly will use
 * rather than a re-derivation that can drift from them.
 *
 * The reason it exists:  claim is that three registers appear in one
 * session, and both reference sessions ship two. Register is a pure function of
 * the ledger, so "which comfort spread produces three?" can be answered before
 * an hour of GPU is spent on a nightly that produces two.
 *
 *   node scripts/probe-comfort.mjs --table shipped          # the demo ledger
 *   node scripts/probe-comfort.mjs --table three-register   # the depth-register contract’s ledger
 *   node scripts/probe-comfort.mjs --store.data-3r/store.json   # a real board
 *
 * `--table` models a board where each authored pin cluster is one topic, which
 * is what the seeder intends; `--store` reads whatever the Clusterer actually
 * produced and is the only one of the two that is evidence. Run the table
 * before seeding and the store after, and if they disagree the clustering moved.
 *
 * Exit 0 when the session would carry all three registers, 1 when it would not,
 * 2 when the tool could not run.
 */
import { existsSync } from 'node:fs';
import { computeComfort, registerFor, tend } from '../core/dist/index.js';
import { JsonStore } from '../adapters/dist/index.js';
import { HISTORY_TABLES, CAPTURE_SIGNAL } from './history-tables.mjs';
import { SEED_PINS } from '../runner/dist/seed/corpus.js';
import { ageTopic } from './board-shape.mjs';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const die = (m) => { console.error(`probe-comfort: ${m}`); process.exit(2); };

/** The learner's session length. 15 is the shipped default (DEFAULT_PREFS). */
const targetMinutes = Number(arg('minutes', 15));
/** The Composer's rule, quoted rather than re-invented: one section per 5 min. */
const capacity = Math.max(1, Math.floor(targetMinutes / 5));

const DAY = 86_400_000;
let topics, signals, now, source;

if (arg('store')) {
  const path = arg('store');
  if (!existsSync(path)) die(`no store at ${path}`);
  const store = new JsonStore(path);
  topics = await store.listTopics();
  signals = await store.listSignals();
  now = new Date();
  source = `store ${path}`;
  if (!topics.length) die(`${path} holds no topics — cluster the board first`);
} else {
  const which = arg('table', 'shipped');
  const table = HISTORY_TABLES[which];
  if (!table) die(`no table "${which}" — have: ${Object.keys(HISTORY_TABLES).join(', ')}`);
  now = new Date();
  const capture = process.argv.includes('--capture');
  const age = !process.argv.includes('--no-age');
  source = `table ${which}${capture ? ' +capture' : ''}${age ? ' +aged' : ' (unaged, as the shipped seeder leaves it)'}`;

  // The seeder's own offset: `w` weeks back, plus the two days `loadHistory`
  // adds so no seeded signal lands on the same instant as the run.
  const atFor = (w) => new Date(now.getTime() - (w * 7 + 2) * DAY).toISOString();
  const capturedAt = (p) => new Date(now.getTime() - (p.week * 7 + p.day) * DAY).toISOString();
  const pinsFor = (key) => SEED_PINS.filter((p) => p.expect === key);

  topics = [];
  signals = [];
  for (const [key, beats] of Object.entries(table)) {
    const seedPins = pinsFor(key);
    const pins = seedPins.map((p, i) => ({ id: `${key}-p${i}`, capturedAt: capturedAt(p) }));
    const mine = [];
    const push = (b, i, tag) => mine.push({
      id: `${key}-${tag}${i}`, topicId: key, type: b.type, direction: b.dir,
      at: atFor(b.w), sourceEvent: `probe:${key}`, invalidated: false,
    });
    beats.forEach((b, i) => push(b, i, 'h'));
    if (capture) seedPins.forEach((p, i) => push({ ...CAPTURE_SIGNAL, w: p.week }, i, 'c'));
    signals.push(...mine);

    // Unaged is what the shipped seeder actually leaves behind: a topic the
    // Clusterer made tonight, never taught. Aged is what six weeks of use
    // would have written, read off the pins and the ledger.
    const base = {
      id: key, label: key, pinIds: pins.map((p) => p.id),
      comfort: 0, state: 'waiting', retiredByUser: false,
      createdAt: now.toISOString(), lastExposedAt: null,
    };
    topics.push(age ? { ...base, ...ageTopic(base, pins, mine) } : base);
  }
}

const comforts = topics.map((t) => computeComfort(t.id, signals, now));
const decisions = tend({ topics, comforts, signals, now });
const byId = new Map(comforts.map((c) => [c.topicId, c]));
const decById = new Map(decisions.map((d) => [d.topicId, d]));

// The Composer's own selection, quoted from `compose()`.
const chosen = decisions
  .filter((d) => d.disposition !== 'hold' && d.disposition !== 'offer-retire' && d.disposition !== 'settled')
  .sort((a, b) => b.priority - a.priority)
  .slice(0, capacity)
  .map((d) => d.topicId);

const pad = (s, n) => String(s).padEnd(n);
console.log(`source: ${source} — ${topics.length} topics, ${signals.length} signals`);
console.log(`session budget ${targetMinutes} min -> capacity ${capacity} section(s)\n`);
console.log(pad('topic', 34) + pad('comfort', 9) + pad('certain', 9) + pad('ev', 4)
  + pad('regr', 6) + pad('register', 14) + pad('disposition', 14) + pad('prio', 6) + 'pick');
for (const t of [...topics].sort((a, b) => decById.get(b.id).priority - decById.get(a.id).priority)) {
  const c = byId.get(t.id);
  const d = decById.get(t.id);
  console.log(
    pad(String(t.label).slice(0, 33), 34)
    + pad(c.comfort.toFixed(3), 9) + pad(c.certainty.toFixed(3), 9)
    + pad(c.evidenceCount, 4) + pad(c.regressed ? 'YES' : '-', 6)
    + pad(registerFor(c), 14) + pad(d.disposition, 14) + pad(d.priority, 6)
    + (chosen.includes(t.id) ? `#${chosen.indexOf(t.id) + 1}` : ''));
}

const labelOf = new Map(topics.map((t) => [t.id, t.label]));
const picked = chosen.map((id) => registerFor(byId.get(id)));
const distinct = [...new Set(picked)];
console.log(`\nsections: ${chosen.map((id, i) => `"${labelOf.get(id)}" [${picked[i]}]`).join(', ')}`);
console.log(`distinct registers: ${distinct.length}/3 — ${distinct.join(', ')}`);
const missing = ['from-nothing', 'building', 'fluent'].filter((r) => !distinct.includes(r));
if (missing.length) console.log(`MISSING: ${missing.join(', ')}`);
process.exit(missing.length ? 1 : 0);
