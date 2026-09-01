#!/usr/bin/env node
/**
 * Guarded, idempotent operator path for the shared disposable Demo board.
 * Default is a read-only plan. Applying requires an exact board confirmation,
 * a pre-write backup path, production-store authority, and a built workspace.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sameJudgeStory } from './judge-story-shape.mjs';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : null;
};
const apply = process.argv.includes('--apply');
const projectId = arg('--project');
const boardId = arg('--board-id') || 'learner-judge-workspace-v1';
const fixturePath = resolve(arg('--fixture') || resolve(repo, '.data/judge-story.json'));
const backupPath = arg('--backup') ? resolve(arg('--backup')) : null;
const receiptPath = arg('--receipt') ? resolve(arg('--receipt')) : null;
if (!projectId) throw new Error('Usage: node scripts/apply-judge-story.mjs --project PROJECT [--board-id ID] [--receipt FILE] [--apply --backup FILE]');
if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,119}$/.test(boardId)) throw new Error('--board-id is invalid');
if (!existsSync(fixturePath)) throw new Error(`fixture does not exist: ${fixturePath}`);

const bytes = readFileSync(fixturePath);
const fixture = JSON.parse(bytes.toString('utf8'));
const digest = createHash('sha256').update(bytes).digest('hex');
const sourceCommit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const sourceTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo, encoding: 'utf8' }).trim();
const sourceDirty = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
  cwd: repo, encoding: 'utf8',
}).trim() !== '';
const summary = {
  schema: 'virgil-judge-story-operator-v1', mode: apply ? 'applied' : 'plan',
  projectId, boardId, fixture: fixturePath, fixtureSha256: digest,
  sourceCommit, sourceTree, sourceDirty,
  counts: counts(fixture), backup: backupPath,
};

if (!apply) {
  console.log(JSON.stringify({ ...summary, next: [
    'npm run build',
    `VIRGIL_DEPLOY=yes VIRGIL_REPLACE_JUDGE_STORY=${boardId} node scripts/apply-judge-story.mjs --project ${projectId} --board-id ${boardId} --apply --backup PATH --receipt PATH`,
  ] }, null, 2));
  if (receiptPath) {
    if (existsSync(receiptPath)) {
      throw new Error(`Refusing to overwrite existing plan receipt: ${receiptPath}`);
    }
    writeJson(receiptPath, summary);
  }
  process.exit(0);
}
if (process.env.VIRGIL_DEPLOY !== 'yes' || process.env.VIRGIL_REPLACE_JUDGE_STORY !== boardId) {
  throw new Error(`Apply requires VIRGIL_DEPLOY=yes and VIRGIL_REPLACE_JUDGE_STORY=${boardId}`);
}
if (!backupPath || !receiptPath) throw new Error('--apply requires both --backup and --receipt');
if (existsSync(backupPath) || existsSync(receiptPath)) {
  throw new Error('--backup and --receipt must be new paths; refusing to overwrite release provenance');
}
if (sourceDirty) {
  throw new Error('Refusing to mutate the Demo board from a dirty source tree; commit and verify the exact operator source first');
}
if (!existsSync(resolve(repo, 'adapters/dist/index.js'))) throw new Error('Run npm run build first');

const { FirestoreStore } = await import('../adapters/dist/index.js');
const store = new FirestoreStore({ projectId, boardId, allowProduction: true });
try {
  const current = await exportStore(store);
  const currentDigest = createHash('sha256').update(JSON.stringify(current)).digest('hex');
  const alreadyApplied = sameJudgeStory(current, fixture);
  if (alreadyApplied) {
    writeJson(receiptPath, { ...summary, idempotentNoop: true, previousBoardSha256: currentDigest });
    console.log(`Judge story already present; no writes. Receipt: ${receiptPath}`);
    process.exit(0);
  }
  writeJson(backupPath, current);
  await store.deleteEverything();
  for (const row of fixture.pins) await store.putPin(row);
  for (const row of fixture.topics) await store.putTopic(row);
  await store.putEdges(fixture.edges);
  for (const row of fixture.signals) await store.appendSignal(row);
  for (const row of fixture.statements) await store.putStatement(row);
  for (const row of fixture.sessions) await store.putSession(row);
  for (const row of fixture.suggestions) await store.putSuggestion(row);
  for (const row of fixture.commitments) await store.putCommitment(row);
  for (const row of fixture.awards) await store.appendAward(row);
  for (const row of fixture.courses) await store.putCourse(row);
  for (const row of fixture.intakeDrafts) await store.putIntakeDraft(row);
  for (const row of fixture.prospects) await store.putProspectProposal(row);
  await store.putPassedOverLedger(fixture.passedOver);
  for (const row of fixture.externals) await store.putExternalEntry(row);
  for (const row of fixture.outcomes) await store.putOutcome(row);
  await store.putPrefs(fixture.prefs);
  const applied = await exportStore(store);
  if (!sameJudgeStory(applied, fixture)) {
    throw new Error('Judge story read-back does not match the fixture; backup retained and no success receipt written');
  }
  writeJson(receiptPath, {
    ...summary, idempotentNoop: false, previousBoardSha256: currentDigest,
    backupSha256: createHash('sha256').update(readFileSync(backupPath)).digest('hex'),
    appliedCounts: counts(applied), appliedAt: new Date().toISOString(),
  });
  console.log(`Judge story applied. Backup: ${backupPath}; receipt: ${receiptPath}`);
} finally {
  await store.close();
}

async function exportStore(store) {
  const [pins, topics, edges, signals, statements, sessions, suggestions, commitments,
    awards, courses, intakeDrafts, prospects, passedOver, externals, outcomes, prefs, aliases] = await Promise.all([
    store.listPins(), store.listTopics(), store.listEdges(), store.listSignals(),
    store.listStatements(), store.listSessions(), store.listSuggestions(),
    store.listCommitments(), store.listAwards(), store.listCourses(), store.listIntakeDrafts(),
    store.listProspectProposals(), store.getPassedOverLedger(), store.listExternalEntries(),
    store.listOutcomes(), store.getPrefs(), store.topicAliases(),
  ]);
  return { pins, topics, edges, signals, statements, sessions, suggestions, commitments,
    awards, courses, intakeDrafts, prospects, passedOver, externals, outcomes, prefs, aliases };
}

function counts(value) {
  return Object.fromEntries(['pins', 'topics', 'sessions', 'courses', 'commitments', 'externals', 'statements']
    .map((key) => [key, Array.isArray(value[key]) ? value[key].length : 0]));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
