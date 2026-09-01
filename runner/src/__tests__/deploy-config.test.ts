import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  PRODUCTION_OPT_IN, PRODUCTION_OPT_IN_VALUE, llmChoice, orchestratorChoice, storeChoice,
} from '../runtime.js';

/**
 * The deploy configuration is the first-deployment step, so its facts are checked
 * like code.
 *
 * Same rule as `readme-claims.test.ts`, and for the same reason: every fact
 * below is owned in one place and written down in another, and the ones that
 * drift are the ones nobody reads again until the day they matter. There is no
 * YAML parser in this tree — the two vendor dependencies the repository has
 * taken on are a database driver and an agent framework, and neither is a
 * reason to acquire a third — so these are text assertions over the templates.
 * That is enough for the class of mistake worth catching here, which is a value
 * that silently stopped meaning what a comment says it means.
 *
 * What this cannot check is whether Cloud Run accepts the file. Nothing local
 * can; `deploy/CLOUD_RUN.md` §7 is the ledger of that gap.
 */

const root = new URL('../../../', import.meta.url);
const at = (relative: string): string => fileURLToPath(new URL(relative, root));
const read = (relative: string): string => readFileSync(at(relative), 'utf8');

const job = read('deploy/job.yaml');
const service = read('deploy/service.yaml');
const dockerfile = read('deploy/Dockerfile');
const apply = read('deploy/apply.sh');
const config = read('deploy/config.sh');
const schedule = read('deploy/schedule.sh');
const build = read('deploy/build.sh');
const auditLive = read('deploy/audit-live.sh');
const firebase = JSON.parse(read('firebase.json')) as {
  emulators?: Record<string, { host?: string; port?: number }>;
};

/** A YAML line that is a setting rather than a comment about one. */
const settings = (yaml: string): string[] =>
  yaml.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

test('the checked-in emulator config can run every Firebase proof the repo documents', () => {
  // The Firestore transport proof had been documented three times but could not
  // start: `firebase emulators:start --only firestore` refuses when
  // firebase.json names no Firestore emulator. Keep the documented safe port
  // executable in an ordinary clone, beside the Auth proof already configured.
  assert.deepEqual(firebase.emulators?.firestore, { host: '127.0.0.1', port: 8377 });
  assert.deepEqual(firebase.emulators?.auth, { host: '127.0.0.1', port: 9099 });
});

test('the shipped deployment enables no dead Pub/Sub runtime', () => {
  assert.doesNotMatch(build, /pubsub\.googleapis\.com/,
    'build.sh enables Pub/Sub even though the service dispatches the Job directly');
});

test('every placeholder in the templates is one apply.sh knows how to render', () => {
  // The failure this prevents is a resource created with a literal
  // `__RUNTIME_SA__` in it, which Cloud Run would accept as a service account
  // name and then fail on at execution time.
  const found = new Set([...`${job}\n${service}`.matchAll(/__[A-Z_]+__/g)].map((m) => m[0]));
  assert.ok(found.size >= 3, 'the templates stopped using placeholders, so this test stopped reading them');
  for (const name of found) {
    assert.ok(apply.includes(name),
      `${name} appears in a template and apply.sh has no rule to render it`);
  }
});

test('a deployment plan cannot overwrite the last applied render receipt', () => {
  assert.match(apply, /JOB_OUTPUT=deploy\/job\.plan\.yaml/);
  assert.match(apply, /SERVICE_OUTPUT=deploy\/service\.plan\.yaml/);
  assert.match(apply, /JOB_OUTPUT=deploy\/job\.rendered\.yaml/);
  assert.match(apply, /SERVICE_OUTPUT=deploy\/service\.rendered\.yaml/);
  assert.doesNotMatch(apply, /render deploy\/job\.yaml\s+deploy\/job\.rendered\.yaml/);
  assert.doesNotMatch(apply, /render deploy\/service\.yaml\s+deploy\/service\.rendered\.yaml/);
});

test('neither container is handed PORT, because the platform reserves it', () => {
  // https://docs.cloud.google.com/run/docs/configuring/services/environment-variables
  // — "the PORT environment variable is injected inside your container by Cloud
  // Run. You shouldn't set it yourself."
  for (const [name, yaml] of [['job', job], ['service', service]] as const) {
    assert.ok(!settings(yaml).some((l) => l === '- name: PORT'),
      `${name}.yaml sets PORT, which Cloud Run reserves and injects itself`);
  }
});

test('the service does not set SB_HOST, so the platform marker is what widens the bind', () => {
  // The bind is `0.0.0.0` under Cloud Run because `K_SERVICE` is set, not
  // because a variable in this file said so. Pinning it here would work and
  // would also mean the code path that makes a laptop safe stops being the one
  // production exercises.
  assert.ok(!settings(service).some((l) => l === '- name: SB_HOST'),
    'service.yaml pins SB_HOST — the K_SERVICE widening is meant to be what binds');
});

test('the service is capped at one instance, which is a correctness setting', () => {
  // CLOUD_RUN.md S4. The store's serialisation law and its single-flight load
  // are per-process promises; two instances each hold a whole copy of the board
  // and each write it whole. Raising this is not a bigger number, it is
  // transactions underneath the store — so if this value moves, that work
  // happened or a regression did.
  assert.match(service, /autoscaling\.knative\.dev\/maxScale: '1'/,
    'maxScale is not 1 — see CLOUD_RUN.md S4 before changing it');
  assert.match(service, /autoscaling\.knative\.dev\/minScale: '0'/);
});

test('the job runs the command that does not delete the board', () => {
  // The same entrypoint answers `seed`, which begins with deleteEverything().
  // CLOUD_RUN.md R2.
  // `--if-due` rides along, and what it MEANS changed with the event-driven processing contract: it used
  // to be "only if the hour has come", and it is now "only if there is a
  // reason" — material waiting, and automatic processing turned on. Without the
  // flag every invocation would run a batch on a board nobody added to, which
  // is the money this ruling exists to stop being spent.
  assert.match(job, /args: \['runner\/dist\/cli\.js', 'process', '--if-due'\]/);
  assert.ok(!job.includes("'seed'"), 'job.yaml names the destructive command');
  assert.ok(!job.includes('VIRGIL_ALLOW_REMOTE_SEED'),
    'the production Job pre-authorises its dormant destructive fixture command');
});

test('the task timeout is above the platform default, which would kill this run', () => {
  // https://docs.cloud.google.com/run/docs/configuring/task-timeout — the
  // default is 600s. The Forager alone measured 8.5 minutes of silence on the
  // local stack, so a job left at the default fails on a slow night and the
  // console blames a timeout rather than the fetch.
  const timeout = /timeoutSeconds: '(\d+)'/.exec(job)?.[1];
  assert.ok(timeout, 'job.yaml stopped naming a task timeout, so this test stopped reading it');
  assert.ok(Number(timeout) > 600,
    `the task timeout is ${timeout}s and the platform default is 600s — the Forager alone can exceed that`);
  // Quoted, because TaskSpec types it as a string where RevisionSpec types the
  // service's as an integer. The two kinds genuinely differ.
  assert.match(job, /timeoutSeconds: '\d+'/, "the Job's timeoutSeconds must be a quoted string");
  assert.match(service, /timeoutSeconds: \d+$/m, "the Service's timeoutSeconds must be a bare integer");
});

test('the retry budget fits inside the daily model quota, which is why it is not the default', () => {
  // A warm nightly is seven model calls; the free-tier cap is twenty requests
  // per day per model. Two attempts is fourteen and fits; three is twenty-one
  // and does not. This is the arithmetic, kept as arithmetic so that raising
  // the retries fails here rather than on a night nobody is watching.
  const CALLS_PER_NIGHT = 7;
  const FREE_TIER_DAILY = 20;

  const retries = /maxRetries: (\d+)/.exec(job)?.[1];
  assert.ok(retries, 'job.yaml stopped naming maxRetries, so this test stopped reading it');
  const attempts = Number(retries) + 1;
  assert.ok(attempts * CALLS_PER_NIGHT <= FREE_TIER_DAILY,
    `${attempts} attempts x ${CALLS_PER_NIGHT} calls exceeds the ${FREE_TIER_DAILY}/day free-tier cap`);
  assert.ok(Number(retries) < 3, 'the platform default is 3, and this is a deliberate reduction');
  assert.match(job, new RegExp(`name: SB_RUN_MAX_RETRIES\\s+value: '${retries}'`),
    'the worker receipt retry budget drifted from the Cloud Run task retry budget');
});

test('the job asks for at least the one CPU the platform requires of jobs', () => {
  // https://docs.cloud.google.com/run/docs/configuring/jobs/cpu — "You must set
  // a minimum of 1 CPU for a Cloud Run job." A fractional value is accepted by
  // a service and rejected by a job.
  const cpu = /cpu: '([\d.]+)'/.exec(job)?.[1];
  assert.ok(cpu, 'job.yaml stopped naming a cpu limit');
  assert.ok(Number(cpu) >= 1, `a job cannot run on ${cpu} CPU`);
});

test('both base images are pinned by digest rather than by a tag that moves', () => {
  const bases = [...dockerfile.matchAll(/^ARG (?:BUILDER|RUNTIME)_IMAGE=(.+)$/gm)].map((m) => m[1]!);
  assert.equal(bases.length, 2, 'the Dockerfile stopped declaring two base images');
  for (const base of bases) {
    assert.match(base, /@sha256:[0-9a-f]{64}$/,
      `${base} is pinned by tag, so a future deployment may not get the image this was tested against`);
  }
});

test('the image build can see every workspace, or `tsc -b` cannot build any of them', () => {
  /**
   * **The defect this was written for: the image could not be built at all.**
   *
   * `tsconfig.json` references every workspace, so `tsc -b` inside the builder
   * fails on the first one that is not in the context — `error TS5083: Cannot
   * read file '/src/trigger/tsconfig.json'` — and the whole build stops. The
   * `trigger` workspace merged into `main` and the Dockerfile was not told, so
   * `deploy/build.sh` and `deploy/smoke.sh` were both dead and nothing said so,
   * because neither runs unless a person asks for Docker.
   *
   * The list is read out of `package.json` rather than written down here, which
   * is the point: a seventh workspace has to be added to the Dockerfile or this
   * fails, and it fails in the ordinary suite rather than in production.
   */
  const workspaces = (JSON.parse(read('package.json')) as { workspaces: string[] }).workspaces;
  assert.ok(workspaces.length >= 5, 'package.json stopped declaring workspaces, so this test stopped reading it');
  for (const name of workspaces) {
    assert.ok(dockerfile.includes(`COPY ${name}/package.json ${name}/`),
      `npm ci cannot see the ${name} workspace — "npm refuses to install a workspace set whose `
      + 'members it cannot see"');
    assert.ok(new RegExp(`^COPY ${name} ${name}$`, 'm').test(dockerfile),
      `${name} is a project reference in tsconfig.json and is not in the build context — `
      + 'tsc -b stops on the first one it cannot read, so the image does not build');
  }
});

test('the image build does not reintroduce the captured-page seed overlay', () => {
  // The public-release check requires this private captured-page overlay to be
  // absent. A stale Dockerfile copy made a clean release checkout impossible
  // to build even though the ordinary suite was green.
  assert.doesNotMatch(dockerfile, /selections\.json/,
    'the Dockerfile expects the captured-page seed overlay that release hygiene requires to be absent');
});

/**
 * A module named at run time is resolved from the lockfile the image installs
 * from, or it is not in the image.
 *
 * **The defect this was written for: the production store driver was not in the
 * image.** `adapters/src/firestore-store.ts` reaches its SDK by
 * `await import(FIRESTORE_MODULE)`, which `tsc` cannot see and `npm ci` cannot
 * guess. Nothing declared it, so the lockfile carried no Google package at all,
 * and `deploy/Dockerfile` — `npm ci` from that lock, then `npm prune` — built an
 * image whose `SB_STORE=firestore:<project>/<board>` Job died on module
 * resolution. Not on the friendly `sdk-missing` exit either: a deployed Job that
 * cannot resolve its store is a 3am stack trace naming a package nobody has
 * heard of, on the one night the deploy has to work.
 *
 * A dynamic import is the right shape — it is what keeps a store the build did
 * not choose out of the process — but it moves the declaration from the compiler
 * to a person, and a person is what this test replaces. The module name and the
 * pinned version are read out of the adapter's own constants rather than written
 * down here, so bumping either one fails in the ordinary suite rather than at
 * `docker buildx` time.
 */
const constant = (src: string, name: string): string => {
  const m = new RegExp(`export const ${name}(?::[^=]+)? = '([^']+)'`).exec(src);
  assert.ok(m, `${name} is no longer a single-quoted constant, so this test stopped reading it`);
  return m[1] as string;
};

/** The `packages` map of the lockfile, which is what `npm ci` installs from. */
const lock = JSON.parse(read('package-lock.json')) as {
  packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
};

function declaredRuntimeDependency(workspace: string, module: string, version: string): void {
  const pkg = JSON.parse(read(`${workspace}/package.json`)) as { dependencies?: Record<string, string> };
  assert.equal(pkg.dependencies?.[module], version,
    `${workspace}/package.json does not declare ${module}@${version} — the entrypoint imports it by `
    + 'name at run time, so nothing but this declaration puts it in the image');
  // npm may hoist a workspace dependency to the root or keep it beside the
  // declaring workspace. Both are clean-install lock shapes; absence from both
  // is the defect this guard owns.
  const entry = lock.packages[`node_modules/${module}`]
    ?? lock.packages[`${workspace}/node_modules/${module}`];
  assert.ok(entry, `package-lock.json has no entry for ${module} — \`npm ci\` in the builder installs `
    + 'from the lock, and a dependency that is only in a package.json is not in the image');
  assert.equal(entry.version, version, `the lockfile pins ${module}@${entry.version}, not ${version}`);
}

test('the production store driver is declared, locked, and therefore in the image', () => {
  const src = readFileSync(at('adapters/src/firestore-store.ts'), 'utf8');
  declaredRuntimeDependency(
    'adapters', constant(src, 'FIRESTORE_MODULE'), constant(src, 'FIRESTORE_PINNED_VERSION'));
});

test('the orchestration framework is declared, locked, and therefore in the image', () => {
  /**
   * The orchestration dependency boundary, discharged: *"the dependency is declared at the infra port — in
   * the commit where the ADK host becomes the nightly's real Cloud Run
   * entrypoint."* `job.yaml` names that host below, so this is that commit, and
   * the same dynamic-import trap applies — `adk-binding.ts` loads `@google/adk`
   * by a `string`-typed constant precisely so the typecheck does not need it,
   * which means nothing but this declaration puts it in the image.
   */
  const src = readFileSync(at('adk/src/adk-binding.ts'), 'utf8');
  declaredRuntimeDependency('adk', constant(src, 'ADK_MODULE'), constant(src, 'ADK_PINNED_VERSION'));
});

test('the workspace the entrypoint hosts is still in the image after the tests are stripped', () => {
  // The runbook §2.5's second edit, and the one it says gets forgotten: the
  // Dockerfile deleted `adk/dist` outright, because nothing in either entrypoint
  // imported it. One does now.
  const stripped = /^RUN rm -rf (.+?)$/ms.exec(dockerfile.replace(/\\\n\s*/g, ' '))?.[1] ?? '';
  assert.ok(stripped, 'the Dockerfile stopped stripping anything, so this test stopped reading it');
  // `(?!/)` because `adk/dist/__tests__` is still stripped and must be: the
  // fixtures and stubs under it are exactly what should not be one import away
  // inside a production image.
  assert.ok(!/\badk\/dist(?!\/)/.test(stripped),
    'the image deletes adk/dist and the Job entrypoint can host it — that is a container that '
    + 'cannot start, discovered at 3am');
  assert.match(dockerfile, /^COPY --from=build \/src\/adk\/dist \.\/adk\/dist$/m,
    'adk/dist survives the strip and is still not carried into the runtime stage');
  assert.match(dockerfile, /^COPY --from=build \/src\/adk\/node_modules \.\/adk\/node_modules$/m,
    '@google/adk is installed below its owning npm workspace, but that workspace-local '
    + 'node_modules tree is absent from the runtime image');
});

test('the builder installs from the lock and prunes only what a run does not need', () => {
  // `npm ci` is what makes the lock the image's dependency truth; `npm install`
  // in a builder would resolve fresh and could ship a version nothing was tested
  // against. `--omit=dev` removes TypeScript and the type packages, and it keeps
  // `dependencies` — which is why declaring the driver as a dependency rather
  // than a devDependency is the half that actually reaches the runtime stage.
  assert.match(dockerfile, /^RUN npm ci /m, 'the builder no longer installs from the lockfile');
  assert.match(dockerfile, /^RUN npm prune --omit=dev$/m, 'the prune step has changed shape');
});

test('the job image publishes no port, because a job container must not listen on one', () => {
  // https://docs.cloud.google.com/run/docs/container-contract — "Because jobs
  // shouldn't serve requests, the container shouldn't listen on a port or start
  // a web server." The EXPOSE in this file belongs to the service target; the
  // check is that it is downstream of `FROM runtime AS service`.
  const jobStart = dockerfile.indexOf('FROM runtime AS job');
  const serviceStart = dockerfile.lastIndexOf('\nFROM ', dockerfile.indexOf(' AS service', jobStart));
  const jobStage = dockerfile.slice(
    jobStart, serviceStart);
  assert.ok(!/^EXPOSE/m.test(jobStage), 'the job target declares an EXPOSE');
});

test('the board is closed to every client, and the estate is told to say so', () => {
  /**
   * **Found by the red team (F11): the deployment shipped no security rules at
   * all,** which means whatever the console's default was on the day the
   * database was created is the rule the learner's board would have lived under.
   * On a database created in test mode that default is open to the world for
   * thirty days, and the board holds every page a person chose to keep.
   *
   * Deny-all is not a compromise here, it is the exactly-correct rule, and the
   * reason is in `firestore.rules` itself: nothing in this product reaches
   * Firestore from a client. The extension talks HTTP to `service.ts` and the
   * only Firestore code in the tree is `adapters/src/firestore-store.ts`, which
   * runs server-side under the runtime service account — and Admin-SDK
   * credentials **bypass security rules entirely**. So `if false` costs this
   * deployment nothing and closes the one door nobody built.
   *
   * The rule file existing is half of it. Nothing deploys a rules file it is
   * never pointed at, so the first-deployment sequence has to name it, and that is
   * the half a test can check from here.
   *
   * **The second half, added after the runbook lane caught it:** naming the
   * file is worthless if the command beside it does not exist. Both documents
   * printed `gcloud firestore databases update --rules …` for a flag `gcloud`
   * has never had — `databases update` accepts `--async`,
   * `--concurrency-mode`, `--database`, `--delete-protection`, `--enable-pitr`
   * and `--type`, and `gcloud firestore` has no `rules` group in any release
   * track. An operator following it during deployment meets an
   * unrecognised-argument error at step 1 of the sequence. A test cannot prove
   * a command *works* from here, but it can pin the one form known not to, and
   * that a real route is still named.
   */
  const rules = read('deploy/firestore.rules');
  assert.match(rules, /rules_version\s*=\s*'2'/, 'the rules file does not declare a version');
  assert.match(rules, /allow read, write: if false;/,
    'deploy/firestore.rules no longer denies everything — every other rule in this product is a '
    + 'client path that does not exist');
  assert.ok(!/\bif true\b/.test(rules), 'the rules file allows something unconditionally');

  const cloudRun = read('deploy/CLOUD_RUN.md');
  assert.match(cloudRun, /firestore\.rules/,
    'CLOUD_RUN.md does not name the rules file, so a deployment would never deploy it and the '
    + 'database would keep whatever default the console gave it');

  // What is banned is the dead command *presented as a command to run* — on its
  // own line, bare or behind a `//`, `#` or `$` prompt, which is how both
  // documents carried it. Both are still free to name it in a sentence, and
  // both do: an operator holding the old revision has to be told it was wrong,
  // and a defect nobody is allowed to describe is a defect that comes back.
  const deadLine = /^[ \t]*(?:\/\/|#|\$)?[ \t]*gcloud[ \t]+firestore[ \t]+databases[ \t]+update\b[^\n]*--rules\b/m;
  for (const [name, text] of [['CLOUD_RUN.md', cloudRun], ['firestore.rules', rules]] as const) {
    assert.ok(!deadLine.test(text),
      `${name} tells the operator to run \`gcloud firestore databases update --rules\` — that flag `
      + 'does not exist, and following it means an unrecognised-argument error at deployment step 1');
  }
  // And inside a fenced block, where every line is a command, the looser form:
  // a re-paste that wraps across the backslash continuation is the same defect.
  for (const block of cloudRun.match(/```[\s\S]*?```/g) ?? []) {
    assert.ok(!/gcloud[\s\\]+firestore[\s\\]+databases[\s\\]+update[\s\S]{0,120}?--rules\b/.test(block),
      'a code block in CLOUD_RUN.md runs `gcloud firestore databases update --rules`, which is not a '
      + 'command that exists');
  }

  assert.match(cloudRun, /firebase deploy --only firestore:rules/,
    'CLOUD_RUN.md names the rules file but no route that deploys it, and gcloud has none — the '
    + 'operator needs firebase-tools or the console named, with what they cost');
});

/**
 * The two key shapes this repository knows about, named once and used twice —
 * by the scan below, and by the control above it.
 *
 * `AIza…` is the long-standing Google API key. `AQ.`-prefixed (~53 characters)
 * is what AI Studio started issuing in August 2026; a scan that knew only the
 * older shape waved the newer one straight through.
 */
const KEY_SHAPES = [
  { what: 'an API key', pattern: /AIza[0-9A-Za-z_-]{35}/, example: `AIza${'K3y'.repeat(11)}xx` },
  { what: 'a new-format API key', pattern: /\bAQ\.[A-Za-z0-9_-]{20,}/, example: `AQ.${'aB3-_x'.repeat(9)}` },
] as const;

test('the key-leak scan can actually see a key', () => {
  /**
   * THE TEST BELOW COULD NOT FAIL, AND SPENT ITS WHOLE LIFE PASSING.
   *
   * It asserts the *absence* of a pattern across a directory of files that have
   * never contained a key and — if everything else in this repository works —
   * never will. So every possible mistake in it is invisible: a typo in the
   * character class, a `\b` that cannot match after a dot, a regex narrowed
   * during some later edit, an empty directory. All of them stay green for
   * ever, and the reassurance is the whole product of the test.
   *
   * So the patterns are shown a key first. Not a real one — these are made of
   * repeated syllables — but the exact shapes the scan claims to catch, run
   * through the exact regexes the scan uses, in the same order. If a pattern
   * stops matching a key, this fails here, loudly, instead of the scan quietly
   * ceasing to look.
   */
  for (const { what, pattern, example } of KEY_SHAPES) {
    assert.ok(pattern.test(example),
      `the scan for ${what} no longer matches one — it would pass over a real key in a deploy file`);
    assert.ok(!pattern.test('SB_GEMINI_KEY: ${GEMINI_API_KEY}'),
      `the scan for ${what} matches an ordinary variable reference, so its verdict means nothing`);
  }
});

test('no deploy file carries key material, and none of them can print a secret', () => {
  const dir = at('deploy');
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.endsWith('.rendered.yaml'))
    .map((entry) => entry.name); // generated YAML and subdirectories are excluded
  // A scan over nothing passes. `deploy/` is the directory deployment commands run
  // from, so an empty read here is a broken test rather than a clean estate.
  assert.ok(names.length >= 3, `deploy/ has ${names.length} scannable files — this test scanned almost nothing`);

  for (const name of names) {
    const text = readFileSync(`${dir}/${name}`, 'utf8');
    for (const { what, pattern } of KEY_SHAPES) {
      assert.ok(!pattern.test(text), `${name} contains something shaped like ${what}`);
    }
    // A key reaches a container through a Secret Manager reference and never
    // through a value. `secrets create` is deliberately not scripted anywhere:
    // a script that creates a secret is a script that can print one.
    assert.ok(!/gcloud secrets (create|versions add)[^\n]*--data-file[= ][^-]/.test(text),
      `${name} would write a secret from a file rather than leaving that to a person`);
  }
});

// ------------------------------------------- the estate, as the code reads it

/** The `value:` of one `- name: X` entry in a container's env block. */
function envValue(yaml: string, name: string): string | null {
  const match = new RegExp(`- name: ${name}\\s*\\n\\s*value: (.+)`).exec(yaml);
  return match?.[1]?.trim().replace(/^'(.*)'$/, '$1') ?? null;
}

test('both resources name the store in the grammar the code actually parses', () => {
  /**
   * **The estate is now a hard deploy prerequisite rather than a tidiness
   * matter.** Since the authorisation fix, a container whose `SB_STORE` names
   * Firestore without a project exits 2 at startup by design — the adapter
   * would otherwise default the project to `virgil-emulator`, which is a name
   * for nothing, and fail on credentials with a message naming no variable.
   *
   * So the spec is parsed here with the same function the container parses it
   * with, rather than matched against a regex that agrees with it today. The
   * placeholder stands in for the project; what is asserted is the shape.
   */
  for (const [name, yaml] of [['job', job], ['service', service]] as const) {
    const spec = envValue(yaml, 'SB_STORE');
    assert.ok(spec, `${name}.yaml names no SB_STORE`);
    const choice = storeChoice(spec.replace(/__([A-Z_]+)__/g, (_, p: string) => p.toLowerCase()), '.data/store.json');
    assert.equal(choice.kind, 'firestore');
    assert.ok('projectId' in choice && choice.projectId,
      `${name}.yaml uses firestore:<board> and the code exits 2 on it — the project is the difference `
      + 'between an emulator and a bill, and a production spec has to name one');
  }
});

test('the job names the host that runs the night, and the code can read the name', () => {
  /**
   * The orchestration dependency boundary's trigger, as a line somebody can point at.
   *
   * The Job's entrypoint stays Virgil's own — `runner/dist/cli.js nightly`, a
   * Node process, not `adk deploy cloud_run`, which generates an Express service
   * and has no Cloud Run Jobs story at all (`adk/DESIGN.md` §5a). What this
   * variable decides is what that entrypoint hosts the night *inside*, which is
   * the shape the scaffold was built for.
   *
   * Parsed with the same function the container parses it with, for the same
   * reason `SB_STORE` is: a regex that agrees with the code today is a regex
   * that stops agreeing with it silently.
   */
  const named = envValue(job, 'SB_ORCHESTRATOR');
  assert.ok(named, 'job.yaml names no SB_ORCHESTRATOR — the deployed night would run framework-free '
    + 'while the writeup claims otherwise, and nothing would say so');
  assert.deepEqual(orchestratorChoice(named), { kind: 'adk' });
});

test('both resources name the model that answers, and the code can read the name', () => {
  /**
   * RUNBOOK §2.4a, closed. `GEMINI_API_KEY` is injected into both containers and
   * nothing in either entrypoint read it: the deployed processes would have
   * reached Ollama at `127.0.0.1:11434`, which inside a container is the
   * container, and failed at the first model call every night.
   *
   * Both, not just the Job. The service hosts all foreground agents. A
   * deployment that wired only the nightly would leave collaborative actions
   * unable to answer.
   */
  for (const [name, yaml] of [['job', job], ['service', service]] as const) {
    const spec = envValue(yaml, 'SB_LLM');
    assert.ok(spec, `${name}.yaml names no SB_LLM, and the container it describes is handed a `
      + 'GEMINI_API_KEY that nothing would read');
    const choice = llmChoice(spec);
    assert.equal(choice.kind, 'gemini');
    assert.deepEqual('tiers' in choice ? choice.tiers : undefined, {
      fast: 'gemini-3.5-flash-lite', deep: 'gemini-3.5-flash-lite',
    });
    assert.equal(envValue(yaml, 'GOOGLE_CLOUD_PROJECT'), '__PROJECT_ID__');
    assert.equal(envValue(yaml, 'GOOGLE_CLOUD_LOCATION'), '__REGION__');
  }
});

test('both resources name an embedder that exists inside the container', () => {
  /**
   * RUNBOOK §2.4a's defect, one port over — and it survived the SB_LLM fix
   * because nothing asserted this variable. Both composition roots build
   * `SB_EMBEDDER === 'tfidf' ? new TfIdfEmbedder() : new OllamaEmbedder(...)`,
   * and the Ollama embedder points at `127.0.0.1:11434`, which inside a
   * container is the container. Unlike the SB_LLM defect this one does not
   * fail at the first model call: the batch spends its Gemini calls first and
   * dies in the cluster stage, so the night bills and still writes no board.
   * `tfidf` is the embedder with no network under it; `check:d1` carries the
   * coarse-cut caveat that choice accepts.
   */
  for (const [name, yaml] of [['job', job], ['service', service]] as const) {
    assert.equal(envValue(yaml, 'SB_EMBEDDER'), 'tfidf',
      `${name}.yaml names no in-container embedder — the deployed batch would reach Ollama at `
      + '127.0.0.1:11434, spend its model calls, and fail in the cluster stage with no board');
  }
});

test('both resources carry the ladder\'s free arm, from the free-tier secret', () => {
  /**
   * The free key spends first; the managed key is the
   * paid fallback behind the learner's budget. The pair has to be a pair —
   * one resource laddered and one not would give the two halves of one
   * learner different spending rules — and the free arm must come from its
   * own secret, never as a literal value.
   */
  for (const [name, yaml] of [['job', job], ['service', service]] as const) {
    assert.match(yaml, /- name: GEMINI_API_KEY_FREE\s*\n\s*valueFrom:\s*\n\s*secretKeyRef:\s*\n\s*name: __FREE_SECRET_NAME__/,
      `${name}.yaml does not take GEMINI_API_KEY_FREE from the free-tier secret — the deployed ladder `
      + 'would have no free arm and every call would be the paid key from the first one');
    assert.equal(envValue(yaml, 'GEMINI_API_KEY_FREE'), null,
      `${name}.yaml carries the free key as a literal value`);
  }
});

test('both resources receive the managed Notebook grant from Secret Manager', () => {
  for (const [name, yaml] of [['job', job], ['service', service]] as const) {
    assert.match(yaml,
      /- name: SB_NOTEBOOK_DRIVE_CREDENTIAL\s*\n\s*valueFrom:\s*\n\s*secretKeyRef:\s*\n\s*name: __NOTEBOOK_DRIVE_SECRET_NAME__\s*\n\s*key: latest/,
      `${name} has no durable Notebook grant`);
    assert.doesNotMatch(yaml, /refresh_token|refreshToken|GOCSPX-/,
      `${name} carries credential material instead of a secret reference`);
  }
  assert.match(apply, /"\$NOTEBOOK_DRIVE_SECRET_NAME"/,
    'the deploy preflight does not require the Notebook secret to exist');
  assert.match(apply, /__SECRET_NAME__/);
  assert.match(apply, /__FREE_SECRET_NAME__/);
  assert.match(apply, /__NOTEBOOK_DRIVE_SECRET_NAME__/);
});

test('the two resources are pointed at the same model, as well as the same board', () => {
  // The panel labels a pin with the Scout and the nightly teaches it. Two
  // providers across those two halves is one learner's board written by two
  // different models, and a cost ledger that reconciles against neither.
  assert.equal(envValue(job, 'SB_LLM'), envValue(service, 'SB_LLM'));
});

test('a resource that names a model key also names the provider that reads it', () => {
  // Both ladder arms are direct Gemini at the final 3.5+ floor: free API-key
  // allowance first, then the managed API key behind the paid gate.
  for (const [name, yaml] of [['job', job], ['service', service]] as const) {
    const key = yaml.includes('GEMINI_API_KEY');
    const provider = llmChoice(envValue(yaml, 'SB_LLM') ?? undefined).kind;
    assert.ok(!key || provider === 'gemini' || provider === 'vertex',
      `${name}.yaml injects a Gemini free-arm key but names ${provider}`);
  }
});

test('a fresh project receives the runtime identity, Firestore database and bounded execution roles', () => {
  assert.match(apply, /gcloud iam service-accounts create "\$runtime_identity_id"/,
    'apply.sh assumes the dedicated runtime service account already exists');
  assert.match(apply, /gcloud firestore databases create --database='\(default\)'[\s\S]*--location "\$FIRESTORE_LOCATION"/,
    'apply.sh enables the Firestore API but never creates the database');
  assert.match(apply, /roles\/datastore\.user/,
    'the runtime service account cannot read the learner boards it serves');
  assert.doesNotMatch(apply, /--role roles\/aiplatform\.user/,
    'the direct Gemini API deployment pre-grants an unused Vertex project role');
  assert.match(apply, /gcloud secrets add-iam-policy-binding "\$secret"[\s\S]*roles\/secretmanager\.secretAccessor/,
    'the happy path creates secrets but never lets the runtime identity mount them');
  assert.doesNotMatch(apply, /roles\/owner|roles\/editor/,
    'the runtime was granted broad project authority instead of bounded execution roles');
});

test('a fresh project closes and protects Firestore before either runtime is published', () => {
  const rules = apply.indexOf('firebase deploy --only firestore:rules');
  const protect = apply.indexOf("firestore databases update --database='(default)'");
  const jobPublish = apply.indexOf('gcloud run jobs replace');
  const servicePublish = apply.lastIndexOf('gcloud run services replace');
  assert.ok(rules >= 0, 'apply.sh never publishes the checked-in deny-all rules');
  assert.ok(protect >= 0, 'apply.sh leaves the database deletable by accident');
  assert.ok(rules < jobPublish && rules < servicePublish,
    'a Cloud Run resource is published before direct Firestore clients are denied');
  assert.ok(protect < jobPublish && protect < servicePublish,
    'a Cloud Run resource is published before database delete protection is enabled');
});

test('the fresh-project API list includes the browser identity, rules and direct Gemini surfaces', () => {
  for (const api of [
    'firebaserules.googleapis.com',
    'generativelanguage.googleapis.com',
    'identitytoolkit.googleapis.com',
    'securetoken.googleapis.com',
  ]) {
    assert.ok(build.includes(api), `build.sh does not enable ${api}`);
  }
  assert.ok(!build.includes('aiplatform.googleapis.com'),
    'the direct Gemini API deployment enables Vertex without selecting it');
});

test('the service names no orchestration host, because a service runs no night', () => {
  // The nine stages are the nightly's. `service.ts` answers requests and hosts
  // the five foreground agents, which are not in `NIGHTLY_STAGES` and are not
  // sequenced by anything.
  assert.equal(envValue(service, 'SB_ORCHESTRATOR'), null,
    'service.yaml selects an orchestration host for a pipeline it does not run');
});

test('the job and the service are pointed at the same board', () => {
  // Two halves of one learner. A service writing pins to one board while the
  // nightly reads another is a product that appears to work and teaches nothing.
  assert.equal(envValue(job, 'SB_STORE'), envValue(service, 'SB_STORE'));
});

test('both resources carry the opt-in that lets a store leave the emulator', () => {
  // `firestoreWiring` refuses at startup without it and says so in a message
  // naming `deploy/job.yaml` — a committed file, reviewed like code — as the
  // one place the decision belongs. If that is where it belongs, it has to be
  // there.
  for (const [name, yaml] of [['job', job], ['service', service]] as const) {
    assert.equal(envValue(yaml, PRODUCTION_OPT_IN), PRODUCTION_OPT_IN_VALUE,
      `${name}.yaml does not set ${PRODUCTION_OPT_IN}=${PRODUCTION_OPT_IN_VALUE}, so the container `
      + 'exits 2 before the night begins');
  }
});

test('the job carries the night boundary the two lanes were aligned on', () => {
  /**
   * The joint proof's alignment rule, as environment.
   *
   * `trigger`'s night is the local date of `instant − H` hours, default 6;
   * `batchKeyOf` is the UTC date, which is `H = 0`. At zero they are the same
   * function for every instant of the day rather than merely compatible with
   * the current cron, and the production schedule sits inside the window where
   * the default disagrees. `trigger-store-joint.test.ts` asserts the arithmetic;
   * this asserts that the deployment says so.
   */
  assert.equal(envValue(job, 'VIRGIL_TRIGGER_NIGHT_BOUNDARY_H'), '0');
  assert.equal(envValue(job, 'VIRGIL_TRIGGER_NIGHT_TZ'), 'UTC');
});

test('the public service is protected by verified learner identity, not a browser-held deployment secret', () => {
  assert.equal(envValue(service, 'SB_AUTH'), 'firebase:__PROJECT_ID__');
  assert.equal(envValue(service, 'VIRGIL_OWNER_EMAIL'), '__OWNER_EMAIL__');
  assert.equal(envValue(service, 'VIRGIL_ALLOWED_EMAILS'), '__ALLOWED_EMAILS__');
  assert.equal(envValue(service, 'VIRGIL_JUDGE_ACCESS_CODE_SHA256'), '__JUDGE_DEMO_PASSWORD_SHA256__');
  assert.equal(envValue(service, 'VIRGIL_JUDGE_DAILY_CLOUD_TOKENS'), '500000');
  assert.ok(apply.includes('__OWNER_EMAIL__'), 'the bootstrap owner is never rendered by apply.sh');
  assert.ok(!service.includes('SB_SHARED_SECRET'),
    'the account-backed service still asks the browser for an operator secret');
  assert.match(service, /run\.googleapis\.com\/invoker-iam-disabled: 'true'/,
    'Cloud Run IAM still blocks the browser before Firebase can verify its learner token');
});

test('the hosted board receives this deployment’s public sign-in configuration', () => {
  assert.equal(envValue(service, 'SB_FIREBASE_API_KEY'), '__FIREBASE_API_KEY__');
  assert.equal(envValue(service, 'SB_GOOGLE_WEB_CLIENT_ID'), '__GOOGLE_WEB_CLIENT_ID__');
  assert.equal(envValue(service, 'SB_GOOGLE_OAUTH_CLIENT_ID'), null,
    'the hosted page and the Chrome extension require different OAuth client types');
  for (const placeholder of ['__FIREBASE_API_KEY__', '__GOOGLE_WEB_CLIENT_ID__']) {
    assert.ok(apply.includes(placeholder), `${placeholder} is never rendered by apply.sh`);
  }
  assert.match(config, /require_browser_identity/,
    'deployment can publish /app/ without the browser identity config its sign-in door needs');
});

test('the job is handed no shared secret, because a job serves nothing', () => {
  // "Because jobs shouldn't serve requests, the container shouldn't listen on a
  // port or start a web server." A secret on the Job would be a credential
  // granted to a process with no door to put it in front of.
  assert.ok(!job.includes('SB_SHARED_SECRET'), 'job.yaml carries a secret for a service it does not run');
});

// ------------------------------------------ durable runs and optional schedule

test('the optional schedule invokes one fixed-board Job and publishes no dead message', () => {
  const created = [...schedule.matchAll(/scheduler jobs "?\$?\{?VERB\}?"? (pubsub|http)/g)].map((m) => m[1]);
  assert.deepEqual(created, ['http']);
  assert.doesNotMatch(schedule, /gcloud pubsub|--message-body|--attributes/,
    'the deploy script still publishes a trigger the shipped Job does not consume');
});

test('the optional fixed-board sweep is hourly UTC', () => {
  /**
   * `Europe/London` was the original, and it is wrong for a reason that has
   * nothing to do with where the learner lives: it shifts by an hour twice a
   * year, so a schedule pinned to it walks across the night boundary and back
   * without anybody editing anything. `Etc/UTC` is fixed, and at `H = 0` the
   * cron and the night key are measured in the same clock.
   */
  const zones = [...config.matchAll(/^: "\$\{TIME_ZONE[A-Z_]*:=(.+)\}"$/gm)].map((m) => m[1]);
  assert.ok(zones.length >= 1, 'config.sh names no time zone');
  for (const zone of zones) assert.equal(zone, 'Etc/UTC');

  // Comments are exempt, and deliberately: the two scripts explain at length
  // why `Europe/London` was wrong, and a check that could not tell an argument
  // from a setting would make the estate harder to read in order to be checked.
  const settingLines = `${config}\n${schedule}`.split('\n')
    .filter((l) => !l.trim().startsWith('#'));
  for (const line of settingLines) {
    assert.ok(!/\b(Europe|America|Asia|Australia)\//.test(line),
      `a DST zone is set in the estate — a cron on one moves an hour twice a year: ${line.trim()}`);
  }
  assert.match(config, /^: "\$\{SCHEDULE_RUN:=0 \* \* \* \*\}"$/m);
});

test('the hosted service dispatches the named Job and has only the required override role', () => {
  assert.match(service, /- name: SB_AUTO_RUN_JOB\s+value: projects\/__PROJECT_ID__\/locations\/__REGION__\/jobs\/__JOB_NAME__/);
  assert.match(apply, /--role roles\/run\.jobsExecutorWithOverrides/);
  assert.match(apply, /gcloud run jobs add-iam-policy-binding "\$JOB_NAME"/);
  assert.doesNotMatch(apply, /--role roles\/run\.developer/,
    'the runtime identity was granted broad deployment authority instead of execution only');
  assert.doesNotMatch(apply, /--role roles\/run\.viewer/,
    'the worker writes its own receipt; the launch identity needs no Cloud Run read role');
  assert.match(service, /run\.googleapis\.com\/cpu-throttling: 'true'/,
    'the request service should not need paid background CPU after dispatch moved to the Job');
  assert.match(service, /autoscaling\.knative\.dev\/minScale: '0'/);
  const jobApply = apply.indexOf('gcloud run jobs replace "$JOB_OUTPUT"');
  const roleApply = apply.indexOf('--role roles/run.jobsExecutorWithOverrides');
  const serviceApplies = [...apply.matchAll(/gcloud run services replace "\$SERVICE_OUTPUT"/g)]
    .map((match) => match.index ?? -1);
  assert.ok(jobApply > 0 && roleApply > jobApply && serviceApplies.length === 2
    && serviceApplies[1]! > roleApply,
  'the serving revision can arrive before the Job or permission it needs');
});

test('every script that could bill is behind the confirmation gate', () => {
  // GCP_SETUP_2026-08-20.md: nothing is deployed before credits arrive. A
  // script that can be run by accident is a script that will be.
  for (const name of ['build.sh', 'apply.sh', 'schedule.sh']) {
    assert.match(read(`deploy/${name}`), /require_confirmation/,
      `deploy/${name} can create or bill resources and does not call require_confirmation`);
  }
  assert.match(read('deploy/config.sh'), /VIRGIL_DEPLOY.*!=.*yes/,
    'the gate stopped checking the variable it documents');
});

test('release builds prove a clean immutable source identity', () => {
  assert.match(build, /git status --porcelain=v1 --untracked-files=all/);
  assert.match(build, /VIRGIL_ALLOW_DIRTY_BUILD/);
  assert.match(build, /Refusing to reuse mutable release tag/);
  for (const label of [
    'org.opencontainers.image.revision', 'org.opencontainers.image.version',
    'dev.virgil.source-tree', 'dev.virgil.source-dirty',
  ]) assert.match(build, new RegExp(label.replaceAll('.', '\\.')));
});

test('live audit binds exact traffic to common clean image source', () => {
  assert.match(auditLive, /status\.traffic\.revisionName,status\.traffic\.percent/);
  assert.match(auditLive, /\$\{SERVICE_READY\},100/);
  assert.match(auditLive, /docker buildx imagetools inspect/);
  assert.match(auditLive, /image_summary\.digest/);
  assert.match(auditLive, /EXPECTED_SOURCE_COMMIT/);
  assert.match(auditLive, /dev\.virgil\.source-dirty/);
  assert.match(auditLive, /latest\|main\|master\|local\|final/);
});
