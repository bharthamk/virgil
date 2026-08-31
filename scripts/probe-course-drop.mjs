/**
 * A SEMESTER, THROUGH A REAL SERVICE, AGAINST A REAL MODEL.
 *
 * Everything the scale lane claims is proven deterministically already —
 * `runner/src/__tests__/semester-scale.test.ts` drops a hundred and twenty
 * documents, paces three nights, resumes idempotently and holds topic identity,
 * against a scripted model and a stub embedder. What none of that can tell you
 * is what the **real** intake specialist does with a real syllabus: whether it
 * finds obligations the deterministic pass missed, whether every proposal it
 * makes really quotes the source, and what a night of it actually costs.
 *
 * So this is the live half, and it is **gated and never run by CI**:
 *
 *   VIRGIL_LIVE_DROP=1 node scripts/probe-course-drop.mjs
 *
 * without the variable it prints what it would do and exits 0, in the shape
 * every other live-gated proof in this repository uses. It spends real tokens on
 * whichever connection the service is configured for, so it says how many calls
 * it is about to make before it makes any of them.
 *
 * ## What it is for, and what it deliberately does not check
 *
 * It checks the things only a real model can answer:
 *
 *   1. **the quote law holds under a real model.** Every proposal
 *      `enrichCourseIntake` keeps has to carry a literal span of the source, and
 *      every date has to be recomputed from that span by `unambiguousDate`
 *      rather than taken from the reply. A model that paraphrases its evidence
 *      is silently discarded, which is correct and is also indistinguishable —
 *      from outside — from a stage that did nothing. This is the check that
 *      tells them apart.
 *   2. **ambiguity stays ambiguous.** `07/09/2026` is 7 September in Britain and
 *      9 July in America. A live model is exactly the thing most likely to
 *      resolve it confidently, and it must not: it has to arrive as a blocking
 *      question.
 *   3. **the pacing is real.** Two runs over one drop, with a cap that bites,
 *      and the second one must not re-ask about anything the first finished.
 *   4. **what it cost.** Printed from `GET /usage`, per lane, so the number in
 *      any writeup comes off a run rather than off an estimate.
 *
 * It does **not** check partition quality, and that is deliberate: what a real
 * embedder does with a course corpus is `scripts/eval-clustering.mjs`'s question
 * and it has a golden key to answer it against. Two probes measuring the same
 * thing with only one of them holding the evidence is how a claim drifts.
 *
 * Runs its own service on its own store, on a port nothing else uses, and
 * removes it afterwards. It never touches `.data/`, the QA board, or 8791.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE_JS = fileURLToPath(new URL('../runner/dist/service.js', import.meta.url));
const CORPUS_JS = fileURLToPath(new URL('../runner/dist/seed/course-corpus.js', import.meta.url));

/** Not 8791 (the learner's own service), not 4182, not 8787. */
const PORT = 8796;
const BASE = `http://127.0.0.1:${PORT}`;
/** Small enough to be affordable live, large enough that the cap bites twice. */
const DOCUMENTS = 24;
const CAP = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const { courseCorpus, CORPUS_AMBIGUOUS_DATE } = await import(CORPUS_JS);
const corpus = courseCorpus({ documents: DOCUMENTS, courses: 3, unreadable: 2 });
const plans = corpus.filter((d) => d.kind === 'syllabus' || d.kind === 'assignment-brief').length;
const material = corpus.filter((d) => !d.contentBase64).length;

if (process.env.VIRGIL_LIVE_DROP !== '1') {
  console.log('probe-course-drop — NOT RUN. This one spends real tokens.\n');
  console.log(`  It would drop ${corpus.length} documents (${material} readable, ${plans} of them plans)`);
  console.log(`  and run the batch twice at a cap of ${CAP}, which is:`);
  console.log(`    - up to ${plans} intake calls (deep, reasoning on), paced over the two runs`);
  console.log(`    - up to ${CAP * 2} forage calls`);
  console.log('    - the fixed stages, twice: naming, survey, analyse, statements, compose, verify');
  console.log('\n  Run it with:  VIRGIL_LIVE_DROP=1 node scripts/probe-course-drop.mjs');
  console.log('  The service must have a working connection configured; this script configures none.');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'virgil-drop-probe-'));
const db = join(dir, 'store.json');
console.log(`probe-course-drop — LIVE. board at ${db}\n`);

const service = spawn(process.execPath, [SERVICE_JS], {
  env: {
    ...process.env,
    SB_DB: db,
    SB_PORT: String(PORT),
    SB_HOST: '127.0.0.1',
    // The cap under test. The whole point of the probe is that it is the cap the
    // run will really apply, read from the same variable an operator would set.
    SB_WORK_CAP: String(CAP),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = [];
service.stdout.on('data', (b) => log.push(String(b)));
service.stderr.on('data', (b) => log.push(String(b)));

const stop = () => {
  service.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
};
process.on('exit', stop);

const call = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  try { return { status: res.status, body: text ? JSON.parse(text) : null }; }
  catch { return { status: res.status, body: text }; }
};

// Wait for the listener rather than guessing at a delay.
for (let i = 0; i < 60; i += 1) {
  try { if ((await call('GET', '/health')).status === 200) break; } catch { /* not yet */ }
  await sleep(250);
}

try {
  console.log('the drop');
  const dropped = await call('POST', '/course-drops', {
    title: 'Live probe semester', dropId: 'drop-probe', items: corpus,
  });
  check('the drop was accepted', dropped.status === 201, JSON.stringify(dropped.body).slice(0, 200));
  check(`${material} documents were read`, dropped.body?.read === material, `read ${dropped.body?.read}`);
  check('the unreadable ones were named rather than dropped',
    dropped.body?.failed === corpus.length - material);
  check('nothing authoritative was written', dropped.body?.authoritativeWrites === 0);
  console.log(`  queue: ${JSON.stringify(dropped.body?.queue)}`);

  console.log('\nthe first run');
  const first = await call('POST', '/batch');
  check('the run started', first.status === 200 && first.body?.started === true);
  // The run is asynchronous by design — a night is minutes of model work and an
  // HTTP request held open for it dies on somebody's proxy. Poll the board.
  const settle = async (want) => {
    for (let i = 0; i < 240; i += 1) {
      const { body } = await call('GET', '/course-intakes');
      const planned = (body?.drafts ?? []).filter((d) => d.enrichment).length;
      if (planned >= want) return planned;
      await sleep(2000);
    }
    return -1;
  };
  const plannedFirst = await settle(Math.min(CAP, plans));
  check(`the first run planned at most the cap (${CAP})`, plannedFirst >= 0 && plannedFirst <= CAP,
    `planned ${plannedFirst}`);

  const { body: afterFirst } = await call('GET', '/course-intakes');
  const enriched = (afterFirst?.drafts ?? []).filter((d) => d.enrichment);

  console.log('\nthe quote law, under a real model');
  let quoted = 0, unquoted = 0, added = 0;
  for (const draft of enriched) {
    for (const c of draft.commitments) {
      if (draft.source.text.includes(c.source.quote)) quoted += 1; else unquoted += 1;
    }
    added += draft.enrichment?.added?.commitments ?? 0;
  }
  check('every proposal quotes its source exactly', unquoted === 0, `${unquoted} did not`);
  console.log(`  ${quoted} proposals, ${added} of them added by the model rather than by the parser`);

  console.log('\nambiguity');
  const ambiguous = enriched.flatMap((d) => d.questions)
    .filter((q) => (q.source?.quote ?? '').includes(CORPUS_AMBIGUOUS_DATE));
  check(`${CORPUS_AMBIGUOUS_DATE} became a question rather than a date`, ambiguous.length > 0);
  check('and the question blocks apply', ambiguous.every((q) => q.blocking === true));
  const resolved = enriched.flatMap((d) => d.commitments)
    .filter((c) => c.dueAt && (c.source?.quote ?? '').includes(CORPUS_AMBIGUOUS_DATE));
  check('nothing resolved it silently', resolved.length === 0,
    `${resolved.length} commitment(s) carry a date derived from an ambiguous line`);

  console.log('\nthe second run');
  const before = enriched.map((d) => d.id).sort();
  await call('POST', '/batch');
  await settle(Math.min(plans, CAP * 2));
  const { body: afterSecond } = await call('GET', '/course-intakes');
  const secondEnriched = (afterSecond?.drafts ?? []).filter((d) => d.enrichment);
  const attemptedTwice = secondEnriched.filter((d) =>
    before.includes(d.id)
    && d.enrichment.attemptedAt !== enriched.find((x) => x.id === d.id)?.enrichment?.attemptedAt);
  check('the second run re-planned nothing the first one finished', attemptedTwice.length === 0,
    `${attemptedTwice.length} were asked about twice`);
  check('and it did make progress', secondEnriched.length > enriched.length,
    `${enriched.length} then ${secondEnriched.length}`);

  console.log('\nnothing was applied');
  const courses = await call('GET', '/courses');
  check('no course exists', (courses.body?.courses ?? []).length === 0);
  const commitments = await call('GET', '/commitments');
  check('no commitment exists', (commitments.body?.commitments ?? []).length === 0);

  console.log('\nwhat it cost');
  const usage = await call('GET', '/usage');
  const totals = usage.body?.llm?.totals;
  console.log(`  ${totals?.calls ?? '?'} calls, ${totals?.inputTokens ?? '?'} in, ${totals?.outputTokens ?? '?'} out`);
  for (const row of usage.body?.llm?.rows ?? []) {
    console.log(`    ${row.lane}/${row.stage} ${row.tier} ${row.modelId}: ${row.calls} calls`);
  }
} catch (err) {
  failures += 1;
  console.error('\nthe probe could not be completed:', err);
  console.error(log.join('').slice(-2000));
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
