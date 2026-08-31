/**
 * Does the product use current learner context, or wait for a batch?
 * `Pin.topicId` is written only by the nightly
 * Clusterer, every foreground route keyed its comfort read on it, and
 * `registerFor(undefined)` is `from-nothing`. So a learner fluent in a subject
 * who pinned something new about it was taught it as a beginner, every time,
 * until a batch ran.
 *
 * This builds the board that proves it, end to end, against a real service:
 *
 *   1. a topic the learner has done real work on, with the signal history that
 *      makes them fluent in it
 *   2. a brand new pin about the same subject, which no batch has touched
 *   3. the two foreground routes, asked what register they teach it at
 *
 * `from-nothing` on step 3 is the bug. Anything above it is the board being
 * read at the moment it was asked.
 *
 * A control runs beside it: material the board knows nothing about must still
 * come back `from-nothing`, because that is true. A fix that matched everything
 * to the nearest topic would pass the first check and fail this one, and would
 * be worse than the bug — it would teach a passage about short stories at the
 * comfort of a topic about databases.
 *
 * Runs its own service on its own store and deletes it after. Nothing here
 * touches a real board.
 *
 *   node scripts/probe-live-context.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE_JS = fileURLToPath(new URL('../runner/dist/service.js', import.meta.url));
const PORT = 8794;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  // Detail only on failure: the numbers are printed above each check, and a
  // PASS line reading "no topic on the board" is the kind of thing that gets
  // screenshotted and misread.
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `  — ${detail}`}`);
};

const api = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}`);
  return r.status === 204 ? null : r.json();
};

const envelopeFor = (text, title) => ({
  url: `https://example.com/${encodeURIComponent(title)}`,
  canonicalUrl: `https://example.com/${encodeURIComponent(title)}`,
  pageTitle: title,
  siteName: 'example.com',
  documentKind: 'html',
  contentLanguage: 'en-US',
  headingPath: [],
  selection: text,
  surroundingText: text,
  parts: [{ role: 'passage', text }],
  pdfPage: null,
  videoMoment: null,
  media: null,
  mediaOmitted: null,
});

/** The subject the learner has already done the work on. */
const KNOWN = [
  'A Firestore composite index lists the fields a query filters and orders by, in that order.',
  'A query that filters on one field and orders by another needs a composite index or it fails.',
  'The index definition file is deployed separately from the security rules.',
];

/** New material about that same subject, pinned seconds ago and clustered by
 *  nothing. This is the pin the old code taught from nothing. */
const NEW_ABOUT_KNOWN =
  'Composite index field ordering matters: equality filters come first, then the range filter, '
  + 'then the ordering field, and a query planner that disagrees will simply refuse the query.';

/** The control. Nothing on this board is about it. */
const UNRELATED =
  'Write compelling short stories with intriguing ideas, interesting characters, tight dialogue '
  + 'and satisfying endings.';

/**
 * The board, written directly.
 *
 * There is no route that makes a topic — the Clusterer does, overnight, which
 * is the whole point of this probe. So the fixture is the board the nightly
 * would have left behind, and everything under test after this is a real HTTP
 * request against the real service reading it.
 */
function fixture() {
  const at = '2026-08-15T09:00:00.000Z';
  const pins = KNOWN.map((text, i) => ({
    id: `known-${i}`,
    type: 'interest',
    envelope: envelopeFor(text, 'Firestore indexes'),
    note: null,
    label: 'Firestore indexes',
    capturedAt: at,
    clientRef: `fixture-known-${i}`,
    requestedRegister: null,
    requestedMinutes: null,
    fromSuggestion: false,
    enrichment: null,
    // Filed by the nightly, which is exactly what the NEW pin will not be.
    topicId: 'topic-firestore',
  }));

  // The history that makes a learner fluent. Comfort is computed from these;
  // nothing about it is asserted here, it is simply what they did.
  const signals = Array.from({ length: 10 }, (_, i) => ({
    id: `sig-${i}`,
    topicId: 'topic-firestore',
    type: i % 5 === 4 ? 'section-completed' : 'answer-correct',
    direction: 'positive',
    at,
    sourceEvent: `fixture-${i}`,
    invalidated: false,
  }));

  return {
    pins,
    topics: [{
      id: 'topic-firestore',
      label: 'Firestore indexes',
      summary: 'Which indexes a query needs, and how they are defined and deployed.',
      pinIds: pins.map((p) => p.id),
      state: 'working',
      comfort: 0.85,
      lastExposedAt: at,
      retiredByUser: false,
      createdAt: at,
    }],
    edges: [],
    signals,
    statements: [],
    sessions: [],
    suggestions: [],
    prefs: {},
    aliases: {},
  };
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'virgil-live-'));
  const db = join(dir, 'store.json');
  writeFileSync(db, JSON.stringify(fixture(), null, 2));
  const service = spawn(process.execPath, [SERVICE_JS], {
    env: { ...process.env, SB_DB: db, SB_PORT: String(PORT) },
    stdio: 'ignore',
  });

  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i += 1) {
      await sleep(250);
      up = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false);
    }
    if (!up) throw new Error('the probe service never came up');
    console.log(`service on ${BASE}  store: ${db}\n`);

    console.log('--- a board the learner has done real work on ---');
    console.log(`  topic "Firestore indexes", ${KNOWN.length} pins, 8 positive signals`);
    const board = await api('GET', '/board');
    const topic = board.topics[0];
    console.log(`  the service reads it as: ${topic?.label} (comfort ${topic?.comfort?.toFixed?.(2)})`);
    check('the fixture board loaded', !!topic, 'no topic on the board');

    console.log('\n--- a NEW pin about the same subject, clustered by nothing ---');
    const fresh = await api('POST', '/pins', {
      type: 'interest', clientRef: 'probe-fresh-known',
      capturedAt: new Date().toISOString(),
      envelope: envelopeFor(NEW_ABOUT_KNOWN, 'Query planning'),
    });
    console.log(`  pinned, and the service named it: "${fresh.label}"`);
    check('named from the board rather than by a model call', fresh.label === 'Firestore indexes',
      `label was "${fresh.label}"`);

    const take = await api('POST', `/pins/${fresh.id}/quick-take`);
    console.log(`  quick-take register: ${take.register}`);
    check('the quick take is not taught from nothing', take.register !== 'from-nothing',
      `register was ${take.register}`);

    const guide = await api('POST', `/pins/${fresh.id}/guide`);
    console.log(`  guide register:      ${guide.register}`);
    check('the guide is not taught from nothing', guide.register !== 'from-nothing',
      `register was ${guide.register}`);

    console.log('\n--- the control: material this board knows nothing about ---');
    const stranger = await api('POST', '/pins', {
      type: 'interest', clientRef: 'probe-unrelated',
      capturedAt: new Date().toISOString(),
      envelope: envelopeFor(UNRELATED, 'How to write a short story'),
    });
    const strangeTake = await api('POST', `/pins/${stranger.id}/quick-take`);
    console.log(`  quick-take register: ${strangeTake.register}`);
    check('unknown material is still taught from nothing, because that is true',
      strangeTake.register === 'from-nothing', `register was ${strangeTake.register}`);
    check('and it was NOT named after an unrelated topic', stranger.label !== 'Firestore indexes',
      `label was "${stranger.label}"`);

    const usage = await api('GET', '/usage');
    console.log('\n--- what all of that cost ---');
    for (const row of usage.llm.rows) {
      console.log(`  ${row.stage.padEnd(12)} ${String(row.calls).padStart(3)} call(s)  ${row.modelId}`);
    }
    console.log(`  embed: ${usage.embed.totals.calls} call(s)`);
  } finally {
    service.kill();
    await sleep(300);
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${failures ? `${failures} check(s) FAILED` : 'all checks passed'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
