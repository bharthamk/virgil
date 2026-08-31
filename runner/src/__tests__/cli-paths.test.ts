import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where a run writes its files.
 *
 * `SB_DB` selects the board, and everything a run writes has to follow it. The
 * seed pin order did not: it was hardcoded to `.data/`, so an isolated run
 * seeded its own store and then overwrote the DEFAULT board's order file — and
 * that board's `history` command then mapped six weeks of signal history onto
 * pin ids belonging to somebody else's pins, with nothing in the output to say
 * so. These run the real CLI from a directory that has no `.data/` at all, so
 * anything still reaching for the default path is a hard failure rather than a
 * silent overwrite.
 *
 * No model is called: `seed` writes pins and `history` with no topics matches
 * nothing.
 */

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

function isolated() {
  return {
    /** A working directory with no `.data/` in it. */
    cwd: mkdtempSync(join(tmpdir(), 'sb-cwd-')),
    /** A board somewhere else entirely, as SB_DB. */
    db: join(mkdtempSync(join(tmpdir(), 'sb-board-')), 'store.json'),
  };
}

const run = (cmd: string, at: ReturnType<typeof isolated>): string =>
  execFileSync(process.execPath, [CLI, cmd], {
    cwd: at.cwd, env: { ...process.env, SB_DB: at.db }, encoding: 'utf8',
  });

test('seed writes the pin order beside the store SB_DB selects', () => {
  const at = isolated();
  const out = run('seed', at);

  assert.match(out, /seeded \d+ pins/);
  const order = join(dirname(at.db), 'seed-pin-order.json');
  assert.equal(existsSync(order), true, 'the order file belongs to the board it was seeded from');
  assert.equal(existsSync(join(at.cwd, '.data')), false,
    'and nothing at all is written to the default board');

  const ids = JSON.parse(readFileSync(order, 'utf8')) as string[];
  assert.equal(ids.length > 0, true);
});

test('history reads the pin order from the same board it seeded', () => {
  const at = isolated();
  run('seed', at);
  // No topics have been earned yet, so nothing matches — the assertion is that
  // it read the file at all. Against the hardcoded path this threw ENOENT.
  const out = run('history', at);

  assert.match(out, /layered 0 signals across 0 matched topics/);
  assert.equal(existsSync(join(at.cwd, '.data')), false);
});

test('a non-file seed does not invent a local receipt after its store writes land', () => {
  const at = isolated();
  const out = execFileSync(process.execPath, [CLI, 'seed'], {
    cwd: at.cwd,
    env: { ...process.env, SB_STORE: 'memory', SB_DB: '' },
    encoding: 'utf8',
  });

  assert.match(out, /seeded \d+ pins/);
  assert.match(out, /none was written for this store/);
  assert.equal(existsSync(join(at.cwd, '.data')), false,
    'a remote-shaped seed still reached for the default local board');
});

test('a Firestore seed needs its own destructive opt-in before any client opens', () => {
  const at = isolated();
  const result = spawnSync(process.execPath, [CLI, 'seed'], {
    cwd: at.cwd,
    env: {
      ...process.env,
      SB_STORE: 'firestore:virgil-production/disposable-fixture',
      VIRGIL_ALLOW_PRODUCTION: 'yes',
      VIRGIL_ALLOW_REMOTE_SEED: '',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Refusing to seed a Firestore board/);
  assert.doesNotMatch(result.stderr, /credential|PERMISSION_DENIED|Could not load the default credentials/i,
    'the refusal should happen before a remote client reports its own failure');
});
