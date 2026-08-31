#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOTS = ['core/src', 'adapters/src', 'runner/src', 'extension/src', 'adk/src', 'trigger/src'];
const DEFAULT_FILE_LINES = 1_500;
const DEFAULT_FUNCTION_LINES = 350;

// Existing debt is explicit and may shrink, never grow. New production files
// receive the defaults above; deleting an entry is how an extracted surface
// graduates back to the ordinary budget.
const FILE_DEBT = new Map([
  ['extension/src/panel.ts', 12_995],
  ['extension/src/panel-core.ts', 5_706],
  ['runner/src/service.ts', 7_629],
]);
const FUNCTION_DEBT = new Map([
  ['extension/src/panel.ts:renderCheck', 630],
  ['extension/src/panel.ts:modelRoutingSettings', 405],
  ['extension/src/panel.ts:intakeDraftBlock', 370],
  ['runner/src/service.ts:routes', 5_222],
  ['runner/src/service.ts:handle', 3_719],
  ['runner/src/service.ts:startService', 389],
  ['runner/src/pipeline.ts:runBatch', 821],
  ['core/src/eval/session-score.ts:scoreSession', 370],
]);
const TOP_LEVEL_LET_DEBT = new Map([['extension/src/panel.ts', 36]]);
const EXPLICIT_ANY_DEBT = new Map([['runner/src/codex-cli-bridge.ts', 4]]);

const files = [];
const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'dist') walk(path);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(path);
  }
};
for (const root of ROOTS) walk(root);

const failures = [];
let functionCount = 0;
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const rel = relative('.', file);
  const lineCount = source.split(/\r?\n/).length;
  const fileLimit = FILE_DEBT.get(rel) ?? DEFAULT_FILE_LINES;
  if (lineCount > fileLimit) failures.push(`${rel}: ${lineCount} lines exceeds ${fileLimit}`);

  const banned = [
    [/\b(?:TODO|FIXME|HACK|XXX)\b/g, 'unfinished-work marker'],
    [/@ts-(?:ignore|nocheck)/g, 'TypeScript suppression'],
  ];
  for (const [pattern, label] of banned) {
    const matches = [...source.matchAll(pattern)];
    if (matches.length) failures.push(`${rel}: ${matches.length} ${label}(s)`);
  }
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let explicitAny = 0;
  let topLevelLets = 0;
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Let)) {
      topLevelLets += statement.declarationList.declarations.length;
    }
  }
  const letLimit = TOP_LEVEL_LET_DEBT.get(rel) ?? 10;
  if (topLevelLets > letLimit) failures.push(`${rel}: ${topLevelLets} top-level let values exceeds ${letLimit}`);

  const functionName = (node) => {
    if (node.name?.getText) return node.name.getText(sourceFile);
    const parent = node.parent;
    if (parent && ts.isVariableDeclaration(parent)) return parent.name.getText(sourceFile);
    if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText(sourceFile);
    return '<anonymous>';
  };
  const inspect = (node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) explicitAny += 1;
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
        || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
        || ts.isGetAccessor(node) || ts.isSetAccessor(node)) && node.body) {
      functionCount += 1;
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const end = sourceFile.getLineAndCharacterOfPosition(node.end).line + 1;
      const lines = end - start + 1;
      const name = functionName(node);
      const limit = FUNCTION_DEBT.get(`${rel}:${name}`) ?? DEFAULT_FUNCTION_LINES;
      if (lines > limit) failures.push(`${rel}:${start} ${name} is ${lines} lines; limit ${limit}`);
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);
  const anyLimit = EXPLICIT_ANY_DEBT.get(rel) ?? 0;
  if (explicitAny > anyLimit) failures.push(`${rel}: ${explicitAny} explicit any uses exceeds ${anyLimit}`);
}

if (failures.length) {
  console.error(`quality check failed (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`quality ok: ${files.length} production TypeScript files; ${functionCount} functions checked`);
  console.log('ordinary budgets: 1,500 lines per file; 350 lines per function; explicit debt cannot grow');
}
