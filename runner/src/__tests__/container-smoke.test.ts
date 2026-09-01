import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The container proof, reachable from the suite rather than only from a shell
 * script nobody runs.
 *
 * Same gating convention as `gemini-live.test.ts`: the expensive,
 * environment-dependent proof is opt-in, and when it is not opted into it
 * **skips loudly, naming what was not checked**. An untested claim reported as
 * untested beats a file nobody notices — and the claim here is a large one, so
 * a silent skip would be the worst of the options.
 *
 *     DOCKER=1 npm test
 *
 * What it runs is `deploy/smoke.sh`, which builds both images and exercises
 * every branch of the exit-code contract plus the service's container contract
 * on a Docker `--internal` network. No provider is called and nothing leaves
 * the machine — see `deploy/CLOUD_RUN.md` §5.
 *
 * This does not duplicate what the script asserts. The script owns the
 * assertions; this owns the fact that they were run.
 */

const root = new URL('../../../', import.meta.url);
const smoke = fileURLToPath(new URL('deploy/smoke.sh', root));

/** A container runtime that is actually up, not merely installed. */
function runtimeUp(): boolean {
  const probe = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8', timeout: 15_000,
  });
  return probe.status === 0 && Boolean(probe.stdout.trim());
}

const WANTED = process.env.DOCKER === '1';

test('both containers hold the contract they were built for', { skip: skipReason() }, () => {
  // Builds two images and runs a dozen containers, so it is minutes rather than
  // milliseconds. That cost is the reason for the gate.
  const out = execFileSync('bash', [smoke], {
    cwd: fileURLToPath(root), encoding: 'utf8', timeout: 20 * 60_000,
  });
  // The script exits non-zero on any failure, so reaching here is the result.
  // The count is asserted anyway: a script that silently stopped running its
  // checks would also exit zero.
  const passes = (out.match(/PASS/g) ?? []).length;
  assert.ok(passes >= 15, `the smoke suite reported only ${passes} checks — it used to report more`);
  assert.ok(!out.includes('FAIL'), out);
});

function skipReason(): string | false {
  if (!WANTED) {
    return 'DOCKER=1 not set — the container contract (bind address, PORT, SIGTERM drain, and every'
      + ' branch of the Job exit code) was NOT checked in this run. `DOCKER=1 npm test` checks it.';
  }
  if (!runtimeUp()) {
    return 'DOCKER=1 was set and no container runtime answered `docker info` — the container contract'
      + ' was NOT checked. This is a skip rather than a failure: the absence of a runtime is a fact'
      + ' about this machine, not about the images.';
  }
  return false;
}
