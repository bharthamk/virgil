import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NIGHTLY_STAGES } from '@sb/adk';
import { NOTEBOOK_DOC_KEYS } from '@sb/core';

/**
 * The README is a judged artefact, so its facts are checked like code.
 *
 * The submission asks for a judge-accessible repository with README spin-up
 * instructions, and
 * a stranger who follows an instruction that no longer works learns something
 * about the project that no test was watching for. Every fact below was, at
 * some point, hand-typed in one place and owned in another:
 *
 *   - the test count drifted three times in one night before it was deleted in
 *     favour of the number the runner prints — that is the shape of this bug;
 *   - the agent roster listed the Reviewer, which nothing calls, and omitted the
 *     Verifier, which is the pipeline's last stage and the entry's best result;
 *   - the pipeline order named seven stages while the runner printed nine;
 *   - "asks for three models by name" while the adapter names four;
 *   - the status section said 3,490 tests, said nine stages in two paragraphs
 *     while the pipeline block above them printed ten, and said nothing was
 *     deployed on a day when a night had already been composed on Cloud Run.
 *
 * The rule this file follows is the one that retired the test count: prefer
 * deriving a fact to asserting it. Nothing here re-types a number the code
 * owns. Each test reads the README, pulls out what it claims, and compares it
 * to the source of that claim — so the failure message names the drift rather
 * than a magic constant that also has to be maintained.
 *
 * What this cannot check is prose. A README can be perfectly consistent with
 * the code and still oversell it; that is a reading job, not a test.
 */

const root = new URL('../../../', import.meta.url);
const at = (relative: string): string => fileURLToPath(new URL(relative, root));
const read = (relative: string): string => readFileSync(at(relative), 'utf8');

const readme = read('README.md');

/** Fenced shell blocks — where the README tells a stranger what to run. */
const shellBlocks = [...readme.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]!);
const shell = shellBlocks.join('\n');

/**
 * Where a run's environment is actually read.
 *
 * `runtime.ts` joined the list when the container contract moved there. It was
 * widened rather than swapped: the composition roots and the operator-started
 * CLI bridge still read env, and a variable that appears in one of them and in none of the README is the
 * bug this pair of tests exists for.
 */
const ENV_SOURCES = [
  'runner/src/cli.ts', 'runner/src/service.ts', 'runner/src/runtime.ts',
  'runner/src/codex-cli-bridge.ts',
];

/**
 * Every way this tree reads an environment variable.
 *
 * It used to be `process.env.NAME` and nothing else, which had two blind spots
 * that both turned out to be real. `process.env['SB_RESUME_RECAP']` — bracket
 * notation — was invisible to it, so the resume-recap flag shipped documented
 * nowhere and guarded by nothing. And once `startService(env)` took its
 * environment as an argument so a test could start the service, every variable
 * it read stopped being spelled `process.env.` at all.
 *
 * Matching on `env.NAME` catches `process.env.NAME` as a substring, so this is
 * strictly wider than what it replaces and nothing that used to be checked has
 * stopped being checked.
 */
const readsEnv = (source: string, name: string): boolean =>
  new RegExp(`\\benv(?:\\.${name}\\b|\\[['"]${name}['"]\\])`).test(source);

test('every SB_ environment variable the README documents is read by the code', () => {
  const documented = new Set([...readme.matchAll(/\bSB_[A-Z_]+/g)].map((m) => m[0]));
  assert.ok(documented.size >= 3, 'the README stopped naming environment variables, so this test stopped reading it');

  const sources = ENV_SOURCES.map(read).join('\n');
  for (const name of documented) {
    assert.ok(readsEnv(sources, name),
      `the README documents ${name} and nothing reads it — either the code dropped it or the README invented it`);
  }
});

test('every SB_ environment variable the code reads is documented in the README', () => {
  // The other direction, and the one that actually bit: `SB_PARTITION` shipped
  // in `cli.ts` and the README never mentioned it, so the only way to discover
  // the D1 partition rule was to read the source.
  const sources = ENV_SOURCES.map(read).join('\n');
  const read_ = new Set([
    ...sources.matchAll(/\benv\.(SB_[A-Z_]+)\b/g),
    ...sources.matchAll(/\benv\[['"](SB_[A-Z_]+)['"]\]/g),
  ].map((m) => m[1]!));
  assert.ok(read_.size >= 3, 'nothing reads SB_ variables any more, so this test stopped reading the code');

  for (const name of read_) {
    assert.ok(readme.includes(name),
      `${name} changes how a run behaves and the README does not mention it — a reader cannot find it without the source`);
  }
});

test('the platform variables Cloud Run injects are documented too', () => {
  // Not SB_, so the pair above cannot see them, and they are the two that
  // decide whether a deployed container works at all: Cloud Run sets `PORT` and
  // never `SB_PORT`, and `K_SERVICE` is what tells the process it is running on
  // the platform rather than on a laptop.
  const sources = ENV_SOURCES.map(read).join('\n');
  for (const name of ['PORT', 'K_SERVICE']) {
    assert.ok(readsEnv(sources, name), `${name} is part of the container contract and nothing reads it`);
    assert.ok(readme.includes(name),
      `${name} decides whether a deployed container serves anything and the README does not mention it`);
  }
});

test('the port and store path the README quotes are the ones the service defaults to', () => {
  const service = read('runner/src/service.ts');

  const port = /\benv\.SB_PORT \?\? (\d+)/.exec(service)?.[1];
  assert.ok(port, 'the service stopped defaulting its port, so this test stopped reading it');
  assert.ok(readme.includes(port), `the service defaults to port ${port} and the README says something else`);

  const db = /\benv\.SB_DB \?\? '([^']+)'/.exec(service)?.[1];
  assert.ok(db, 'the service stopped defaulting its store path, so this test stopped reading it');
  assert.ok(readme.includes(db), `the service defaults to the store at ${db} and the README says something else`);
});

test('README seed and process examples leave the included judge board untouched', () => {
  const seed = readme.match(/^(\S*SB_DB=\S+)\s+node runner\/dist\/cli\.js seed$/m)?.[1];
  const process = readme.match(/^(\S*SB_DB=\S+)\s+node runner\/dist\/cli\.js process$/m)?.[1];
  assert.ok(seed, 'the README seed example must select a disposable board explicitly');
  assert.equal(process, seed, 'README seed and process examples must use the same disposable board');
  assert.notEqual(seed, 'SB_DB=.data/store.json', 'the README must not overwrite the included judge board');
});

test('every file the README tells a stranger to run exists after a build', () => {
  // `npm test` compiles first, so `dist/` here is what someone gets from a
  // clean clone. A path that has moved is the difference between a working
  // spin-up and a stack trace on the first command.
  const paths = [...shell.matchAll(/\bnode\s+(\S+\.js)/g)].map((m) => m[1]!);
  assert.ok(paths.length >= 2, 'the README stopped naming files to run, so this test stopped reading it');
  for (const path of paths) {
    assert.ok(existsSync(at(path)), `the README says to run \`node ${path}\` and there is no such file after a build`);
  }
});

test('every npm script the README tells a stranger to run exists', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
  const scripts = Object.keys(pkg.scripts ?? {});
  const named = [...readme.matchAll(/\bnpm run ([a-z][\w:]*)/g)].map((m) => m[1]!);
  assert.ok(named.length > 0, 'the README stopped naming npm scripts, so this test stopped reading it');
  for (const name of new Set(named)) {
    assert.ok(scripts.includes(name), `the README says to run \`npm run ${name}\` and package.json has no such script`);
  }
});

test('every script path the README points at exists', () => {
  const paths = new Set([...readme.matchAll(/`(scripts\/[\w-]+\.mjs)`/g)].map((m) => m[1]!));
  for (const path of paths) {
    assert.ok(existsSync(at(path)), `the README points at ${path} and there is no such file`);
  }
});

test('the models the README says to pull are the models the adapters ask for', () => {
  // Both directions. A model named in the README and not in the adapter is a
  // download nobody needs; a model in the adapter and not in the README is a
  // failed call on someone else's machine with no way to know why.
  const adapters = ['adapters/src/ollama-llm.ts', 'adapters/src/ollama-embedder.ts'].map(read).join('\n');
  const wanted = new Set([...adapters.matchAll(/'([a-z][\w.]*(?:-[\w.]+)*:[\w.-]+)'/g)].map((m) => m[1]!));
  // The embedder's default carries no tag, so it is picked up on its own.
  const embedDefault = /DEFAULT_EMBED_MODEL = '([^']+)'/.exec(adapters)?.[1];
  if (embedDefault) wanted.add(embedDefault);
  assert.ok(wanted.size >= 3, 'the adapters stopped naming models, so this test stopped reading them');

  const pulled = new Set([...shell.matchAll(/ollama pull (\S+)/g)].map((m) => m[1]!));
  assert.deepEqual([...pulled].sort(), [...wanted].sort(),
    'the README and the Ollama adapters disagree about which models a local run needs');
});

test('the README names every agent in the tree, and no agent that is not', () => {
  // The roster is the Architectural Discipline claim. It drifted in both
  // directions at once: the Verifier — the last stage and the strongest single
  // result — was missing, while `Cartographer`, an agent that was split in two
  // and has not existed since, was still named in four places.
  // Shared vocabulary rather than members of the fleet: `deps.ts` is the port
  // bundle, `untrusted.ts` is the fence and its rule, and `house-style.ts` is
  // the prose rules every prose agent quotes. None of them calls a model, and
  // `prompt-lint.test.ts` is what proves that claim rather than this list.
  // `keys.ts` joined them when the Forager started batching: it is the
  // read-back that maps a model's reply onto the thing it was asked about,
  // shared by the two agents that ask about several things in one call.
  const NOT_AGENTS = new Set(['deps.ts', 'untrusted.ts', 'house-style.ts', 'keys.ts']);
  const agents = readdirSync(at('core/src/agents'))
    .filter((f) => f.endsWith('.ts') && !NOT_AGENTS.has(f))
    .map((f) => f.replace(/\.ts$/, ''));
  assert.ok(agents.length >= 10, 'the agents directory stopped looking like a fleet, so this test stopped reading it');

  const named = (name: string): boolean =>
    new RegExp(`\\b${name.replace(/-/g, '[- ]')}\\b`, 'i').test(readme);

  for (const agent of agents) {
    assert.ok(named(agent), `\`core/src/agents/${agent}.ts\` is an agent and the README's roster does not mention it`);
  }
  assert.ok(!/\bcartographer\b/i.test(readme),
    'the README names Cartographer, which was split into the Clusterer and the Analyst and no longer exists');
});

test('the pipeline order the README prints is the order the runner runs', () => {
  const pipeline = read('runner/src/pipeline.ts');
  // Both ways a stage announces itself: the timed ones and the two arithmetic
  // stages that report without being timed.
  const stages = [...pipeline.matchAll(/execute\('([a-z]+)'/g)].map((m) => m[1]!);
  assert.ok(stages.length >= NIGHTLY_STAGES.length,
    'the pipeline stopped naming its stages, so this test stopped reading it');
  // Two lists of the same night, written in two workspaces. The README is
  // checked against the pipeline below; this is what stops the pipeline and the
  // registry the hosted night is built from drifting apart underneath it.
  assert.deepEqual(stages, NIGHTLY_STAGES.map((s) => s.name),
    'runner/src/pipeline.ts and adk/src/stages.ts disagree about the night');

  // Source order is run order: the two arithmetic stages report themselves in
  // place rather than through `timed`, but they sit where they run.
  //
  // Anchored on the first stage the pipeline actually names rather than on the
  // word `forage`, because which stage leads is a decision the pipeline is
  // allowed to make — and the version of this that spelled it out went red for
  // the one change it existed to catch, reporting it as "the README no longer
  // prints a pipeline order" when the README printed one perfectly well.
  const line = new RegExp(`\`\`\`\\n(${stages[0]}[^\`]*?)\\n\`\`\``).exec(readme)?.[1];
  assert.ok(line, 'the README no longer prints a pipeline order, which was the whole point of this check');

  const claimed = line.split('→').map((s) => s.trim());
  assert.deepEqual(claimed, stages,
    'the README and the runner disagree about which stages run, or in what order');
});

test('every public surface shows the same product name', () => {
  // The name is being changed before submission, and a half-finished rename is
  // worse than none: a judge sees one name in the video, another in the tab and
  // a third in the repo. This does not care which name it is — only that the
  // four surfaces a person actually sees agree on one.
  const manifest = JSON.parse(read('extension/manifest.json')) as {
    name?: string; action?: { default_title?: string };
  };
  const name = manifest.name;
  assert.ok(name, 'the extension manifest has no name, which is what Chrome shows in the extensions list');

  assert.equal(manifest.action?.default_title, name,
    'the toolbar tooltip and the extension name disagree');

  const title = /<title>([^<]*)<\/title>/.exec(read('extension/panel.html'))?.[1];
  assert.equal(title, name, "the side panel's title and the extension name disagree");

  // Chrome draws the manifest name and icon in the native side-panel header.
  // Repeating the name inside the 360px content surface is not another public
  // identity surface; it is duplicate furniture. The document title above is
  // the extension-controlled input to Chrome's header, and this guard now
  // holds the learner's ruling that the content must not draw a second brand.
  const tools = read('extension/src/panel.ts').split('function panelTools')[1]?.split('interface Section')[0] ?? '';
  assert.ok(!tools.includes('panel-brand'), 'the side-panel content repeats the brand Chrome already draws');

  assert.ok(readme.includes(name), `the README does not mention "${name}", which is the name on every screen`);
});

test('current submission sources cannot fall back to the pre-A+ architecture story', () => {
  // The project desk is a sibling of the code directory in the RUI workspace.
  // A public clone may not carry that desk, so README/ADK truth is always held;
  // when the submission sources are present, the same guard holds those too.
  const localSubmission = new URL('../../Projects/virgil/artifacts/submission/', root);
  const currentNames = [
    'ARCHITECTURE_A_PLUS_2026-08-24.md',
    'WRITEUP_A_PLUS_DRAFT_2026-08-24.md',
    'VIDEO_STORYBOARD_A_PLUS_2026-08-24.md',
  ];
  // `adk/DESIGN.md` is deliberately a dated scaffold record and says so in
  // its header. It is not current submission truth; including it here made the
  // old case-sensitive guard pass by accident on "Wired into nothing".
  const current = [readme, read('adk/src/stages.ts')];
  for (const name of currentNames) {
    const file = fileURLToPath(new URL(name, localSubmission));
    if (existsSync(file)) current.push(readFileSync(file, 'utf8'));
  }
  const joined = current.join('\n');
  const joinedLower = joined.toLowerCase();
  for (const stale of [
    'eleven agents', 'wired into nothing',
    'dependency stays undeclared', 'pub/sub on pin-created',
    'every stage degrades independently',
    // 13 was true until Marker and Transcriber landed (third window,
    // later); the release build caught the regex below still asking
    // for it — inside the container, where the project desk is not mounted,
    // the README alone had to answer and honestly said fourteen.
    '13 specialised agents', '**13 agents**',
    // Fourteen was true until the night scout landed, and the README is the
    // one document a build container can read.
    'fourteen agents', '14 specialised agents', '**14 agents**',
  ]) {
    assert.ok(!joinedLower.includes(stale), `current submission truth still contains the stale claim: ${stale}`);
  }
  // Satisfiable by the repo alone: the desk's submission files are joined in
  // when present, but the build container mounts only the repo, so the README
  // must carry the fleet count itself or release validation fails.
  assert.match(joined, /fifteen agents|15 (?:specialised )?agents|\*\*15 agents\*\*/,
    'the current submission set must state the executable 15-agent fleet');

  // Held against the README alone rather than against `joined`. `adk/DESIGN.md`
  // is a design record of the night as it was when nine stages was the truth,
  // and rewriting history there would be a worse repair than leaving it dated.
  // The README is the judged front page, and it is the one that must be current.
  for (const stale of [
    '3,490 tests', '3,343 passing',
    'nine stages', 'nine-stage', 'all nine', 'nine stage bodies',
    'Nothing is deployed', 'No night has yet been composed',
    'four of its five interfaces', 'Nothing in it has been applied',
  ]) {
    assert.ok(!readme.includes(stale), `the README still contains the stale claim: ${stale}`);
  }

  // A suite cannot reliably assert the number of tests in the run that is
  // currently discovering it. Keeping that total in prose created a second
  // release counter which drifted every time a contract was added. The README
  // now names the executable source of truth and is forbidden from pinning a
  // comma-formatted total again.
  assert.match(readme, /`npm test`[^.]*source\s+of\s+truth/is,
    'the README must direct readers to the runner for current suite totals');
  assert.doesNotMatch(readme, /\b[0-9]+,[0-9]{3}\s+tests\b/,
    'the README must not pin a suite total that the next test can invalidate');
  // Iterated off the registry rather than retyped. This list was nine names
  // long — the nine the night had before `intake` led it — so the one stage a
  // rewrite was most likely to drop was the one stage this loop was structurally
  // unable to notice was missing. Deriving it also means a tenth stage cannot be
  // added to the pipeline and left out of every document that describes it.
  const stageNames = NIGHTLY_STAGES.map((s) => s.name);
  assert.ok(stageNames.includes('intake'), 'the registry no longer starts the night at intake');
  for (const stage of stageNames) {
    assert.match(joined.toLowerCase(), new RegExp(`\\b${stage}\\b`), `current truth omits the ${stage} stage`);
  }
  // The names alone do not catch a count, and the count is what went stale: two
  // paragraphs said nine while the pipeline block above them printed ten.
  assert.match(readme, new RegExp(`\\b${['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven'][stageNames.length] ?? String(stageNames.length)}[ -]stage`, 'i'),
    'the README does not say in words how many stages the night has, which is where the old count survived');

  const countWord = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'][NOTEBOOK_DOC_KEYS.length];
  assert.ok(countWord, 'the Notebook document count has no prose form for the README guard');
  assert.match(readme, new RegExp(`\\b${countWord} learner-facing documents\\b`, 'i'),
    'the README does not state the executable Notebook document count');
  assert.doesNotMatch(readme, /\bfive learner-facing documents\b|\bsame five documents\b/i,
    'the README still describes the retired five-document Notebook seam');

  for (const oldName of ['WRITEUP_DRAFT.md', 'VIDEO_STORYBOARD.md', 'ARCHITECTURE_DIAGRAM.md']) {
    const file = fileURLToPath(new URL(oldName, localSubmission));
    if (existsSync(file)) {
      assert.match(readFileSync(file, 'utf8').slice(0, 900), /SUPERSEDED 2026-08-24/,
        `${oldName} still looks current instead of pointing to the A+ source`);
    }
  }
});
