import { readFileSync, existsSync } from 'node:fs';

import { scoreSession, renderScorecard, boardFromStore } from '../core/dist/index.js';
import { JsonStore } from '../adapters/dist/index.js';

const TAKES_VALUE = new Set(['store', 'board']);
const flags = new Set();
const opts = {};
const positional = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) { positional.push(a); continue; }
  const name = a.slice(2);
  if (TAKES_VALUE.has(name)) opts[name] = process.argv[++i] ?? null;
  else flags.add(name);
}
const flag = (name) => flags.has(name);
const opt = (name) => opts[name] ?? null;

const die = (msg) => { console.error(`eval-session: ${msg}`); process.exit(2); };

const readJson = (path) => {
  if (!existsSync(path)) die(`no such file: ${path}`);
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { return die(`${path} is not readable JSON: ${e.message}`); }
};

// ------------------------------------------------------------------ sources

/** The two frontier baselines, so the tool can show what "the bar" looks like. */
async function fromReference() {
  const mod = await import('../runner/dist/__tests__/fixtures/reference-sessions.js')
    .catch(() => die('the reference fixtures are not built — run `npm run build` first'));
  return [mod.REFERENCE_V1, mod.REFERENCE_V2].map((f) => ({
    name: f.name, session: f.session, board: f.board,
  }));
}

async function fromStore(path) {
  if (!existsSync(path)) die(`no store at ${path} — pass --store, set SB_DB, or give a session JSON`);
  const store = new JsonStore(path);
  const session = await store.latestSession();
  if (!session) die(`${path} holds no session yet — run a nightly first`);
  // `builtAt` is the honest clock for a stored session: comfort decays with
  // time, and scoring last week's session against today's ledger would report
  // a register mismatch that was never in the artefact.
  const board = await boardFromStore(store, new Date(session.builtAt ?? Date.now()));
  return [{ name: `${path} · session built ${session.builtAt}`, session, board }];
}

function fromFile(path, boardPath) {
  const raw = readJson(path);
  // Accept a bare session, a `{ session }` wrapper, or a whole nightly result.
  const session = raw.sections ? raw : raw.session;
  if (!session?.sections) die(`${path} does not look like a session (no "sections")`);
  const board = boardPath ? readJson(boardPath) : { topics: [] };
  if (!Array.isArray(board.topics)) die('a board must carry a "topics" array');
  if (!boardPath) {
    console.warn('eval-session: no --board given — provenance, register-vs-ledger, '
      + 'ordering and over-quoting will be SKIPPED, not passed.\n');
  }
  return [{ name: path, session, board }];
}

// --------------------------------------------------------------------- main

if (positional.length > 1) die(`expected at most one session file, got ${positional.length}`);

const targets = flag('reference') ? await fromReference()
  : positional.length ? fromFile(positional[0], opt('board'))
    : await fromStore(opt('store') ?? process.env.SB_DB ?? '.data/store.json');

const scored = targets.map((t) => ({ ...t, card: scoreSession(t.session, t.board) }));

if (flag('json')) {
  console.log(JSON.stringify(scored.map((s) => ({ name: s.name, card: s.card })), null, 2));
} else {
  for (const s of scored) {
    console.log(`\n${'='.repeat(78)}\n${s.name}\n${'='.repeat(78)}`);
    console.log(renderScorecard(s.card));
    const skipped = s.card.hard.filter((c) => c.status === 'skipped').length;
    if (skipped) {
      console.log(`\n  ${skipped} of ${s.card.hard.length} hard checks were SKIPPED for want of board state.`
        + '\n  A skipped check is not a passed one.');
    }
    console.log('\n  Hard checks are contracts; proxy metrics are signal for a human re-eval'
      + '\n  and are not quality verdicts. Tone, register authenticity and difficulty fit'
      + '\n  are not scored here and still need a reader.');
  }
}

const broken = scored.filter((s) => !s.card.passed);
if (broken.length) {
  console.error(`\neval-session: ${broken.length} of ${scored.length} session(s) failed a hard check`);
  process.exit(1);
}
