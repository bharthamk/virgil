/**
 * Score one session, offline, and exit non-zero if a contract broke.
 *
 * This is the tool a port-day operator runs. The question on port day is "does
 * the session Gemini composed still hold what the local pipeline's did", and
 * until now the only way to answer it was to read the session. Reading is still
 * required for the half a machine cannot judge — tone, register authenticity,
 * whether the difficulty fits — but every contract in `session-score.ts` is
 * settled here in under a second, with no model, no network and no key.
 *
 *   node scripts/eval-session.mjs                       # latest from .data/store.json
 *   SB_DB=.data-port/store.json node scripts/eval-session.mjs
 *   node scripts/eval-session.mjs --store .data-port/store.json
 *   node scripts/eval-session.mjs out/session.json      # a session JSON on its own
 *   node scripts/eval-session.mjs out/session.json --board out/board.json
 *   node scripts/eval-session.mjs --json                # machine-readable
 *   node scripts/eval-session.mjs --reference           # the two frontier baselines
 *
 * EXIT CODES
 *   0  every hard check passed or skipped
 *   1  a hard check failed — the session broke a contract
 *   2  the tool could not run: no session, unreadable input, bad arguments
 *
 * A SKIPPED CHECK IS NOT A PASS. Scoring a bare session JSON with no board
 * skips provenance, register-against-ledger, ordering and over-quoting, and the
 * summary line says how many. Point it at a store, or hand it a board, before
 * reading a green as coverage.
 *
 * The verifier-withholding contract added `closing-note-withheld` — the note may not name a section the
 * Verifier withheld after it was written, which is the defect the 2026-08-20
 * benchmark found by eye. ADDED, NOT RENUMBERED: every check here is addressed
 * by name and nothing counts them, so scorecards from before this ruling stay
 * comparable check-for-check. That moved the total from 16 to 17; the later
 * `learner-action` floor moves it to 18 after a reading-only session passed the
 * two question-shape checks vacuously.
 *
 * It needs the session's own `withheld` array and SKIPS without one — a stored
 * session carries it, a rendered or transcribed session does not, and an empty
 * array (a night that withheld nothing) is a pass rather than a skip. With a
 * board it also matches on topic labels; without one it matches on section
 * headings alone, which is weaker.
 *
 * WORKED EXAMPLE, and a reason to trust the tool: run with no arguments against
 * the committed `.data/store.json`, it fails two hard checks on the session
 * stored there — and both are defects the code has SINCE fixed, found from the
 * artefact alone with no knowledge of the history.
 *
 *  - `word-budget`: the from-nothing section ran 729 words against a 385-word
 *    budget, on a flat per-section allowance. The register-weighted budget the
 *    Composer writes to now holds it — both reference sessions pass this check
 *    in `runner/src/__tests__/reference-session-score.test.ts`.
 *  - `question-well-formed`: two questions carry `kind: "construction"` and
 *    `"prediction"`, neither of which is in the type. `normaliseQuestion` now
 *    coerces anything that is not `recall` to `free-text`.
 *
 * IT ONCE FAILED A THIRD, and that one was never a defect in the session.
 * `provenance-sources` reported six dead citations because the stored ids were
 * bare pin ids, written before `offeredSourceIdsFor` began minting
 * `<pin>:origin` — so ids the Composer had cited correctly stopped resolving
 * underneath them, taking SB-44's provenance tap and §5d's Notebook hand-off
 * down with them on the one board the demo opens on. Repaired in the data as a
 * format migration rather than a content edit, and held there by
 * `runner/src/__tests__/committed-board.test.ts`, which asks the endpoint, the
 * hand-off and this scorer the same question so the board cannot fall behind a
 * convention unwatched again.
 *
 * The current pipeline is all-green (`runner/src/__tests__/session-score.test.ts`).
 * The stored board is a pre-fix artefact, kept as it is.
 */
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
