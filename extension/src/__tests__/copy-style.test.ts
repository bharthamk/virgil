import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * COPY LINT — the product's own words, as a learner reads them.
 *
 * `prompt-lint.test.ts` holds the model to the house style. Nothing held the
 * panel to it, and the panel writes more sentences than any agent does: every
 * empty state, every refusal, every confirmation, every line under every
 * control. On 2026-08-22 those sentences carried thirty-two em-dashes.
 *
 * The rule is one sentence and it is the same one the agents are given: no
 * em-dash and no en-dash in anything a learner reads. It is a rule about the
 * product sounding like a person rather than like a generator, which is the
 * whole claim this surface makes, and it is exactly the kind of rule that
 * decays the moment nobody is checking.
 *
 * ## What is checked, and what is deliberately not
 *
 * Only string literals in the copy modules, with comments stripped first.
 * Comments are for whoever maintains this and may punctuate however they
 * like; this file's own prose is full of the mark it bans, which is the
 * distinction working rather than an inconsistency.
 *
 * `service.ts`, `queue.ts` and the rest are not here: they carry no learner
 * copy. If that changes, the last test fails, because a module gains copy the
 * moment somebody writes a sentence into it.
 */

/** The source tree, reached from `dist/__tests__/` where this runs. */
const SRC = new URL('../../src/', import.meta.url);
const BANNED = ['—', '–'];

/** The modules that hold sentences a learner reads. */
const COPY_MODULES = [
  'check-surface.ts', 'course-material.ts', 'model-budget-status.ts', 'panel-core.ts', 'pin-body.ts',
  'pins-face.ts', 'guide-view.ts', 'demo-mode.ts',
  'notebook-drive.ts', 'notebook.ts',
  'hosted-drive-settings.ts', 'tenant-settings.ts', 'panel.ts', 'pending-lesson.ts', 'toast.ts',
  // The strip at the foot of the board: what is waiting, what a run would cost,
  // and every receipt a run leaves behind.
  'process-bar.ts',
  // The arrival screen: three sentences, and the first three most people read.
  'arrival.ts',
  // The Insights room's two deterministic blocks. The slipping block is the
  // only place in the product that says something about a learner's behaviour
  // rather than about their knowledge, which makes its four sentences the ones
  // most worth holding to the house voice.
  'insights.ts',
  // The night scout's review surface: the only screen in this product that
  // shows somebody material they never saved, and therefore the one whose
  // sentences have to say where it came from and what has not been read.
  'prospect.ts',
  // The tutor brief: six sentences a learner reads about themselves, and the
  // only block in the product written knowing an assistant may read it too.
  // Held to the house style twice over, since a sentence that sounds generated
  // is exactly what a page-reading assistant would repeat back.
  'tutor-brief.ts',
  // The menu titles are copy: they are the first words of this product most
  // people will ever read.
  'pin-modes.ts',
  // SB-283: the quick take's three closing controls and the receipts they
  // produce. Every string on it is read by somebody who has just finished
  // reading a lesson, which is the moment a generated-sounding sentence is
  // most noticeable.
  'quick-take-close.ts',
  // SB-286: the same take's two controls before it is opened. Two labels and
  // one honest sentence for the night with nothing else on it.
  'quick-take-offer.ts',
  // Standard's box: every label and every explanatory line on it.
  'pin-box.ts',
  // The picker's bar, including the count it reads back.
  'selector.ts',
  // The toolbar button's own surface: two choices, what each one means, and
  // the sentence a page this extension may not read gets instead.
  'action-popup.ts',
  // Every sentence a sign-in refusal produces. These are read by somebody who
  // has just failed to get into their own account, which is the moment a
  // shouted Firebase constant would do the most damage.
  'identity.ts',
  // Both sides of a lesson. Every string on it is read by somebody in the
  // middle of learning something, which is the moment a generated-sounding
  // sentence is most noticeable.
  'lesson.ts',
  // Immediate source-backed lessons use the same visible lesson grammar, but
  // keep quick-take writes behind their own callbacks.
  'foreground-lesson.ts',
  // The External face: the record of what left Virgil, and the one screen in
  // the product that asks a learner about work it did not watch them do. Every
  // sentence on it has to say what the answer changed and what it did not.
  'external.ts',
  // Browser-agent writes stay visible without replacing the form or room the
  // learner was using.
  'webmcp-receipt.ts',
];

/** Source with block comments, line comments and imports removed. */
function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^import[\s\S]*?from '[^']*';$/gm, '');
}

/** Every string literal in a module, with its line number. */
function literals(src: string): { line: number; text: string }[] {
  const stripped = withoutComments(src);
  const out: { line: number; text: string }[] = [];
  const re = /`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g;
  for (const m of stripped.matchAll(re)) {
    out.push({ line: stripped.slice(0, m.index).split('\n').length, text: m[0] });
  }
  return out;
}

for (const file of COPY_MODULES) {
  test(`${file}: no em-dash or en-dash in anything a learner reads`, () => {
    const src = readFileSync(fileURLToPath(new URL(file, SRC)), 'utf8');
    const offenders = literals(src)
      .filter((l) => BANNED.some((d) => l.text.includes(d)))
      .map((l) => `${file}:${l.line} ${l.text.slice(0, 90)}`);
    assert.deepEqual(offenders, [],
      'the house style bans these in model output; copy written by the product is held to the same rule');
  });
}

test('the copy modules are still the modules that hold copy', () => {
  // A guard against the list going stale. Any module that grows a sentence
  // long enough to be copy should either be linted or be shown not to need
  // it; this fails when a new source file appears, which is the moment to
  // decide which.
  const seen = readdirSync(fileURLToPath(SRC)).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts')).sort();
  assert.deepEqual(seen, [
    'account-scope.ts', 'account-surface.ts', 'action-popup-main.ts', 'action-popup.ts', 'arrival.ts',
    'background.ts', 'browser-tabs.ts', 'capture-session.ts', 'capture.ts',
    // Check's learner-facing workspace furniture and compact readiness copy.
    // Linted above rather than hidden in the already-stateful renderer.
    'check-surface.ts', 'course-material.ts', 'demo-mode.ts',
    'external-receipts.ts',
    // The record of what left for another surface, and the answers that come
    // back. Linted above: it is nothing but copy and the controls it hangs on.
    'external.ts', 'foreground-lesson.ts', 'guide-core.ts', 'guide-view.ts',
    'handoff-presentation.ts', 'hosted-drive-settings.ts',
    'identity.ts',
    'insights.ts', 'learn-now.ts',
    'lesson.ts',
    'material-check-in.ts', 'model-budget-status.ts', 'notebook-drive.ts', 'notebook.ts',
    'panel-core.ts',
    // SB-286: the panel's glyph set, moved out of `panel.ts` when a second
    // surface needed it. Every label it draws is handed in by its caller, so it
    // holds no sentence of its own and is not linted above.
    'panel-glyphs.ts',
    'panel.ts', 'pending-lesson.ts', 'pin-body.ts', 'pin-box.ts', 'pin-modes.ts',
    'pins-face.ts',
    'prefs.ts', 'process-bar.ts', 'prospect.ts', 'queue.ts', 'quick-take-close.ts',
    'quick-take-offer.ts',
    'reread-bridge.ts', 'reread-core.ts', 'reread.ts', 'room-lifecycle.ts', 'selection-memory.ts',
    'selector.ts', 'service.ts', 'surfaces.ts', 'tenant-settings.ts',
    // Theme applies one validated presentation value to an extension document
    // and carries no learner-facing sentence of its own.
    'theme.ts',
    'toast.ts', 'tutor-brief.ts',
    // Decided, rather than skipped: `upload.ts` reads a dropped file and answers
    // with a discriminated outcome. Every sentence about what happened to that
    // file is written in `panel-core.ts`, which is linted above, and the test
    // below is what keeps it that way.
    'upload.ts',
    // Decided, rather than skipped: the WebMCP surface's strings are tool
    // schemas and their results, written for an agent calling this page and
    // read by a learner nowhere. They are held to the schema's own register,
    // which is not the house voice, so they are named here and left out of
    // COPY_MODULES rather than quietly matching neither rule. The receipt is
    // learner copy, so it is linted above as well as named in this inventory.
    'webmcp-core.ts', 'webmcp-receipt.ts', 'webmcp.ts',
  ], 'a new extension module: decide whether it holds learner copy and add it to COPY_MODULES if so');
});


test('the file reader holds no sentences, so its refusals stay in the linted module', () => {
  /**
   * `upload.ts` is where a docx is unzipped and a PDF is walked, and it is
   * exactly the kind of module that grows an apologetic string the first time
   * somebody debugs it. Every one of those would be a learner-facing sentence
   * living outside the copy lint, said at the worst moment — a file that would
   * not open, on the screen somebody is using an hour before a deadline.
   *
   * So the rule is structural rather than stylistic: the reader returns an
   * outcome and `panel-core.ts` turns it into English. What is checked is that
   * no string long enough to be a sentence appears in it.
   */
  const src = readFileSync(fileURLToPath(new URL('upload.ts', SRC)), 'utf8');
  const sentences = literals(src)
    .map((l) => ({ ...l, body: l.text.slice(1, -1) }))
    // A sentence is prose: several words with a full stop in it. Mime types,
    // selectors, entity names and `Error` tags are none of those.
    .filter((l) => /\s\w+\s\w+/.test(l.body) && /[.!?]/.test(l.body))
    .map((l) => `upload.ts:${l.line} ${l.text.slice(0, 90)}`);
  assert.deepEqual(sentences, [],
    'a sentence in the file reader is copy outside the lint: put it in panel-core.ts and return an outcome');
});


const CORE = new URL('../../../core/src/', import.meta.url);

const NOT_LEARNER_COPY = new Set([
  // `detail` strings on a stage report. Read in the run log, never on a screen.
  'closing-note.ts',
  // The degrade classifier's `note`, which travels in a `BatchOutcome`.
  'provider-failure.ts',
  // An invariant that throws when the partition is not a partition. If a
  // learner ever reads this string, the em-dash is not the problem.
  'clustering.ts',
]);

function coreCopyModules(): { file: string; path: string }[] {
  const out: { file: string; path: string }[] = [];
  for (const dir of ['domain', 'progression']) {
    const here = fileURLToPath(new URL(`${dir}/`, CORE));
    for (const file of readdirSync(here).sort()) {
      if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
      if (NOT_LEARNER_COPY.has(file)) continue;
      out.push({ file: `core/src/${dir}/${file}`, path: join(here, file) });
    }
  }
  return out;
}

test('the service writes learner copy too, and the same rule holds over it', () => {
  const offenders: string[] = [];
  for (const { file, path } of coreCopyModules()) {
    const src = readFileSync(path, 'utf8');
    for (const l of literals(src)) {
      if (BANNED.some((d) => l.text.includes(d))) offenders.push(`${file}:${l.line} ${l.text.slice(0, 90)}`);
    }
  }
  assert.deepEqual(offenders, [],
    'the hero, the card, the strip and the next move are all written in core/src/domain: no em-dash, no en-dash');
});


test('no learner-facing copy sells the machinery instead of the lesson', () => {
  const banned = /\b(already prepared and verified|prepared and verified|verified section)\b/i;
  const offenders: string[] = [];
  for (const { file, path } of coreCopyModules()) {
    for (const l of literals(readFileSync(path, 'utf8'))) {
      if (banned.test(l.text)) offenders.push(`${file}:${l.line} ${l.text.slice(0, 80)}`);
    }
  }
  for (const file of COPY_MODULES) {
    for (const l of literals(readFileSync(fileURLToPath(new URL(file, SRC)), 'utf8'))) {
      if (banned.test(l.text)) offenders.push(`${file}:${l.line} ${l.text.slice(0, 80)}`);
    }
  }
  assert.deepEqual(offenders, [],
    'say what the learner will have covered and how long it takes, not what the pipeline did to get here');
});


test('no learner-facing copy speaks in the vocabulary of the build', () => {
  const banned = /\b(?:source[- ]backed|source[- ]shaped|pinned material)\b/i;
  const offenders: string[] = [];
  for (const file of COPY_MODULES) {
    for (const l of literals(readFileSync(fileURLToPath(new URL(file, SRC)), 'utf8'))) {
      if (banned.test(l.text)) offenders.push(`${file}:${l.line} ${l.text.slice(0, 100)}`);
    }
  }
  for (const { file, path } of coreCopyModules()) {
    for (const l of literals(readFileSync(path, 'utf8'))) {
      if (banned.test(l.text)) offenders.push(`${file}:${l.line} ${l.text.slice(0, 100)}`);
    }
  }
  assert.deepEqual(offenders, [],
    'say "what you saved" or "your saved pages": nobody reading their own lesson knows what source-backed means');
});

test('no learner-facing copy promises an hour the product does not control', () => {
  const offenders: string[] = [];
  for (const file of COPY_MODULES) {
    const src = readFileSync(fileURLToPath(new URL(file, SRC)), 'utf8');
    for (const l of literals(src)) {
      if (/\b(this run|this evening|overnight)\b/i.test(l.text)) offenders.push(`${file}:${l.line} ${l.text.slice(0, 80)}`);
    }
  }
  assert.deepEqual(offenders, [],
    'say "your next session", not an hour: the run is one UTC cron and the learner is not in UTC');
});

test('ordinary failure copy speaks as Virgil, not as an architecture layer', () => {
  const offenders: string[] = [];
  for (const file of COPY_MODULES) {
    for (const l of literals(readFileSync(fileURLToPath(new URL(file, SRC)), 'utf8'))) {
      if (/can(?:not|'t) reach the service/i.test(l.text)) {
        offenders.push(`${file}:${l.line} ${l.text.slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'ordinary rooms speak as Virgil; service vocabulary belongs in self-hosting settings');
});

/**
 * SB-139: exact operator constructions that escaped the earlier service-only
 * guard. These phrases appeared in ordinary Board, Learn, Check, Plan, account
 * and budget-recovery copy. Settings may still name the technical objects it
 * changes, but none of these constructions is needed even there.
 */
test('learner copy contains no ruled operator narration', () => {
  const banned = [
    /\bVirgil answered\b/i,
    /\bVirgil refused\b/i,
    /\brefused (?:that|the) request\b/i,
    /\bsign-in service\b/i,
    /\bservice timezone\b/i,
    /\bqueued pins\b/i,
    /\bno route changed\b/i,
    /\bwas routed to\b/i,
    /\broute that works\b/i,
    /\broughly \$\{n\(estimate\)\} tokens\b/i,
  ];
  const offenders: string[] = [];
  for (const file of COPY_MODULES) {
    for (const l of literals(readFileSync(fileURLToPath(new URL(file, SRC)), 'utf8'))) {
      if (banned.some((rule) => rule.test(l.text))) {
        offenders.push(`${file}:${l.line} ${l.text.slice(0, 100)}`);
      }
    }
  }
  for (const { file, path } of coreCopyModules()) {
    for (const l of literals(readFileSync(path, 'utf8'))) {
      if (banned.some((rule) => rule.test(l.text))) {
        offenders.push(`${file}:${l.line} ${l.text.slice(0, 100)}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'ordinary copy says what happened and what remains safe; operator narration belongs in code, not prose');
});
