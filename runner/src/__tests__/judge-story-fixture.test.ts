import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JsonStore } from '@sb/adapters';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURE = join(ROOT, '.data/judge-story.json');

test('the judge story is compact, inspectable and demonstrates the whole learning loop', async () => {
  const raw = readFileSync(FIXTURE, 'utf8');
  const fixture = JSON.parse(raw) as Record<string, any>;
  const copy = join(mkdtempSync(join(tmpdir(), 'virgil-judge-story-')), 'store.json');
  copyFileSync(FIXTURE, copy);
  const store = new JsonStore(copy);

  const [pins, topics, sessions, courses, commitments, externals, statements] = await Promise.all([
    store.listPins(), store.listTopics(), store.listSessions(), store.listCourses(),
    store.listCommitments(), store.listExternalEntries(), store.listStatements(),
  ]);
  assert.equal(pins.length, 4);
  assert.equal(topics.length, 3);
  assert.deepEqual(new Set(topics.map((topic) => topic.state)), new Set(['waiting', 'working', 'settled']));
  assert.equal(sessions.length, 1);
  assert.equal(courses.length, 1);
  assert.ok(courses[0]!.material.length >= 2);
  assert.equal(commitments.length, 1);
  assert.match(commitments[0]!.dueAt, /^2026-09-03T/);
  assert.equal(commitments[0]!.doneAt, null);
  assert.equal(externals.length, 1);
  assert.equal(externals[0]!.destination, 'manual');
  assert.ok(statements.some((statement) => statement.userEdited));
  const machine = statements.find((statement) => !statement.userEdited);
  assert.ok(machine && machine.evidenceSignalIds.length > 0);

  const section = sessions[0]!.sections[0]!;
  assert.match(section.body, /retrieval failure|generation failure/i);
  assert.equal(section.sourceIds.length, 2);
  for (const sourceId of section.sourceIds) {
    assert.ok(pins.some((pin) => pin.enrichment?.references.some((source) => source.id === sourceId)),
      `lesson source ${sourceId} has no inspectable pin receipt`);
  }
  const source = courses[0]!.sources![0]!;
  assert.equal(source.digest, createHash('sha256').update(source.text).digest('hex'));
  const spend = fixture['prefs'].modelSpend.connections;
  assert.ok(Object.values(spend).every((row: any) => row.calls === 0
    && row.inputTokens === 0 && row.outputTokens === 0 && row.issuedNotReturned === 0));
  assert.doesNotMatch(raw, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
});

test('scratch preparation protects both included fixtures', () => {
  const temp = mkdtempSync(join(tmpdir(), 'virgil-judge-copy-'));
  const out = join(temp, 'store.json');
  const receipt = JSON.parse(execFileSync(process.execPath,
    [join(ROOT, 'scripts/prepare-judge-story.mjs'), '--out', out],
    { cwd: ROOT, encoding: 'utf8' })) as Record<string, any>;
  assert.equal(receipt['sha256'], createHash('sha256').update(readFileSync(FIXTURE)).digest('hex'));
  assert.deepEqual(readFileSync(out), readFileSync(FIXTURE));
  for (const protectedPath of [FIXTURE, join(ROOT, '.data/store.json')]) {
    const result = spawnSync(process.execPath,
      [join(ROOT, 'scripts/prepare-judge-story.mjs'), '--out', protectedPath],
      { cwd: ROOT, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to overwrite/);
  }
  const occupied = join(temp, 'occupied.json');
  writeFileSync(occupied, 'keep me');
  const occupiedResult = spawnSync(process.execPath,
    [join(ROOT, 'scripts/prepare-judge-story.mjs'), '--out', occupied],
    { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(occupiedResult.status, 0);
  assert.match(occupiedResult.stderr, /Refusing to overwrite existing scratch data/);
  assert.equal(readFileSync(occupied, 'utf8'), 'keep me');
});

test('the Firestore operator route is plan-only without an exact apply gate', () => {
  const script = join(ROOT, 'scripts/apply-judge-story.mjs');
  const plan = JSON.parse(execFileSync(process.execPath,
    [script, '--project', 'judge-plan-project', '--board-id', 'judge-board'],
    { cwd: ROOT, encoding: 'utf8' })) as Record<string, any>;
  assert.equal(plan['mode'], 'plan');
  assert.match(plan['sourceCommit'], /^[a-f0-9]{40}$/);
  assert.match(plan['sourceTree'], /^[a-f0-9]{40}$/);
  assert.equal(typeof plan['sourceDirty'], 'boolean');
  assert.equal(plan['counts'].topics, 3);
  const refused = spawnSync(process.execPath,
    [script, '--project', 'judge-plan-project', '--board-id', 'judge-board', '--apply'],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, VIRGIL_DEPLOY: '' } });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /requires VIRGIL_DEPLOY=yes/);
});

test('a plan receipt is new provenance and is never overwritten', () => {
  const temp = mkdtempSync(join(tmpdir(), 'virgil-judge-plan-receipt-'));
  const receipt = join(temp, 'plan.json');
  writeFileSync(receipt, 'keep me');
  const result = spawnSync(process.execPath, [
    join(ROOT, 'scripts/apply-judge-story.mjs'), '--project', 'judge-plan-project',
    '--board-id', 'judge-board', '--receipt', receipt,
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to overwrite existing plan receipt/);
  assert.equal(readFileSync(receipt, 'utf8'), 'keep me');
});

test('the Firestore apply gate refuses to overwrite backup or receipt provenance', () => {
  const temp = mkdtempSync(join(tmpdir(), 'virgil-judge-provenance-'));
  const backup = join(temp, 'existing-backup.json');
  const receipt = join(temp, 'new-receipt.json');
  writeFileSync(backup, 'keep me');
  const result = spawnSync(process.execPath, [
    join(ROOT, 'scripts/apply-judge-story.mjs'), '--project', 'judge-plan-project',
    '--board-id', 'judge-board', '--apply', '--backup', backup, '--receipt', receipt,
  ], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, VIRGIL_DEPLOY: 'yes', VIRGIL_REPLACE_JUDGE_STORY: 'judge-board' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be new paths/);
  assert.equal(readFileSync(backup, 'utf8'), 'keep me');
});

test('idempotence refuses partial, extra or content-mismatched stories', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, any>;
  const same = structuredClone(fixture);
  const partial = structuredClone(fixture);
  partial.topics.pop();
  const extra = structuredClone(fixture);
  extra.externals.push({ ...extra.externals[0], id: 'unexpected-extra' });
  const mismatched = structuredClone(fixture);
  mismatched.sessions[0].sections[0].body = 'different lesson under the same ids';
  const moduleUrl = pathToFileURL(join(ROOT, 'scripts/judge-story-shape.mjs')).href;
  const program = [
    `import { sameJudgeStory } from ${JSON.stringify(moduleUrl)};`,
    `const fixture = ${JSON.stringify(fixture)};`,
    `const cases = ${JSON.stringify([same, partial, extra, mismatched])};`,
    'console.log(JSON.stringify(cases.map((value) => sameJudgeStory(value, fixture))));',
  ].join('\n');
  const result = JSON.parse(execFileSync(process.execPath,
    ['--input-type=module', '--eval', program], { encoding: 'utf8' })) as boolean[];
  assert.deepEqual(result, [true, false, false, false]);
});

test('a mutating apply refuses a dirty operator tree before opening Firestore', (t) => {
  const marker = join(ROOT, 'judge-story-dirty-marker.tmp');
  writeFileSync(marker, 'test-only');
  t.after(() => rmSync(marker, { force: true }));
  const temp = mkdtempSync(join(tmpdir(), 'virgil-judge-dirty-'));
  const result = spawnSync(process.execPath, [
    join(ROOT, 'scripts/apply-judge-story.mjs'), '--project', 'judge-plan-project',
    '--board-id', 'judge-board', '--apply', '--backup', join(temp, 'backup.json'),
    '--receipt', join(temp, 'receipt.json'),
  ], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, VIRGIL_DEPLOY: 'yes', VIRGIL_REPLACE_JUDGE_STORY: 'judge-board' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dirty source tree/);
});
