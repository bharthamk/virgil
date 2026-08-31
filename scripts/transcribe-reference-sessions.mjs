/**
 * One-time transcription: the two REFERENCE_SESSION artefacts → a test fixture.
 *
 * The reference sessions are the frontier baseline — two real sessions the
 * local pipeline produced unattended, kept as the thing a Gemini port has to
 * match. They live as rendered markdown in the project's artefacts directory,
 * which is outside this repository and is read-only, so the scorecard cannot
 * read them at test time and must not depend on a path outside the tree.
 *
 * So they are transcribed once, here, into a literal fixture that is committed.
 * The script is committed with it so the transcription is auditable and can be
 * re-run rather than re-typed:
 *
 *   node scripts/transcribe-reference-sessions.mjs <artefacts-dir>
 *
 * WHAT THE MARKDOWN DOES NOT CARRY, and what is therefore reconstructed:
 *
 *  - **topic ids.** The rendering shows headings, not ids. Ids are minted as
 *    `v1-s1`… and the fixture's board carries topics with those ids, so
 *    `provenance-topics` and `section-order` are checkable and the register
 *    check is honest about what it is checking.
 *  - **source ids.** The rendering shows "2 sources", a COUNT, not the ids.
 *    The fixture mints that many ids per section and puts exactly them on the
 *    board's `offeredSourceIds`, so `provenance-sources` asserts what the
 *    artefact actually claims: that the count the panel shows resolves. It does
 *    NOT assert that the model cited the right source — the rendering does not
 *    carry enough to ask that, and no scorer will ever be able to.
 *  - **the comfort ledger.** Not rendered. `register-matches-ledger` is
 *    therefore left to skip rather than back-solved from the stated register,
 *    which would make it a check on this script.
 *  - **the pinned material.** Not rendered, so `no-verbatim-overquote` reports
 *    skipped: there is no source text to compare a run of words against.
 *
 * Everything the artefact DOES carry — heading, register, stated minutes,
 * source count, medium warning, body, question, closing note, and the learner
 * model statements — is transcribed verbatim.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

// No default: the artefacts directory lives outside this repository, and a
// hardcoded absolute path both breaks in every clone and publishes the layout
// of a machine nobody else has. The usage line above already requires it.
const ART = process.argv[2];
if (!ART) {
  console.error('usage: node scripts/transcribe-reference-sessions.mjs <artefacts-dir>');
  process.exit(1);
}
const OUT = 'runner/src/__tests__/fixtures/reference-sessions.ts';

const HEAD = /^> Built (\S+) from (\d+) pins · target (\d+)min · estimated ([\d.]+)min/m;
const META = /^\*\*register:\*\* `([\w-]+)` · \*\*~([\d.]+) min\*\* · \*\*(\d+) sources?\*\*$/;
const WARN = /^> \*\*Medium warning:\*\* (.+)$/;
const QUESTION = /^\*\*Question:\*\* (.+)$/;
const CLOSING = /^\*\*Closing note:\*\* (.+)$/;

function parse(file, prefix) {
  const raw = readFileSync(file, 'utf8');
  const head = HEAD.exec(raw);
  if (!head) throw new Error(`${file}: no build header`);

  const lines = raw.split('\n');
  const sections = [];
  let closingNote = null;
  const statements = [];
  let inStatements = false;

  let cur = null;
  const flush = () => {
    if (!cur) return;
    cur.body = cur.bodyLines.join('\n').trim();
    delete cur.bodyLines;
    sections.push(cur);
    cur = null;
  };

  for (const line of lines) {
    const closing = CLOSING.exec(line);
    if (closing) { flush(); closingNote = closing[1].trim(); continue; }

    if (line.startsWith('## ')) {
      flush();
      const heading = line.slice(3).trim();
      // The trailing "## What the learner model said" / "## The learner model"
      // block is the statement list, not a section.
      if (/learner model/i.test(heading)) { inStatements = true; continue; }
      inStatements = false;
      cur = { heading, bodyLines: [], question: null, mediumWarning: null };
      continue;
    }

    if (inStatements) {
      if (line.startsWith('- ')) statements.push(line.slice(2).trim());
      continue;
    }
    if (!cur) continue;

    const meta = META.exec(line);
    if (meta) { cur.depth = meta[1]; cur.estimatedMinutes = Number(meta[2]); cur.sourceCount = Number(meta[3]); continue; }

    const warn = WARN.exec(line);
    if (warn) { cur.mediumWarning = warn[1].trim(); continue; }

    const q = QUESTION.exec(line);
    if (q) { cur.question = q[1].trim(); continue; }

    if (line.trim() === '---') { flush(); continue; }
    cur.bodyLines.push(line);
  }
  flush();

  return {
    prefix,
    builtAt: head[1],
    fromPinCount: Number(head[2]),
    targetMinutes: Number(head[3]),
    estimatedMinutes: Number(head[4]),
    sections: sections.map((s, i) => ({
      topicId: `${prefix}-s${i + 1}`,
      heading: s.heading,
      body: s.body,
      depth: s.depth,
      estimatedMinutes: s.estimatedMinutes,
      sourceIds: Array.from({ length: s.sourceCount }, (_, n) => `${prefix}-s${i + 1}:src-${n + 1}`),
      mediumWarning: s.mediumWarning,
      question: s.question
        ? { prompt: s.question, kind: 'free-text', expectedPoints: [] }
        : null,
    })),
    closingNote,
    statements,
  };
}

const v1 = parse(join(ART, 'REFERENCE_SESSION.md'), 'v1');
const v2 = parse(join(ART, 'REFERENCE_SESSION_V2.md'), 'v2');

for (const r of [v1, v2]) {
  if (!r.sections.length) throw new Error(`${r.prefix}: no sections parsed`);
  for (const s of r.sections) {
    if (!s.depth || !s.body || !Number.isFinite(s.estimatedMinutes)) {
      throw new Error(`${r.prefix}: section "${s.heading}" is incomplete`);
    }
  }
  if (!r.closingNote) throw new Error(`${r.prefix}: no closing note`);
}

const banner = `/**
 * THE TWO REFERENCE SESSIONS, AS FIXTURES. Generated — do not hand-edit.
 *
 *   node scripts/transcribe-reference-sessions.mjs <artefacts-dir>
 *
 * Transcribed from artifacts/REFERENCE_SESSION.md and REFERENCE_SESSION_V2.md,
 * the two sessions the local pipeline produced unattended and the baseline a
 * port has to match. Topic ids and source ids are minted by the transcription
 * (the rendering carries a source COUNT, not ids); everything else is the
 * artefact's own text. See the script header for exactly what is reconstructed
 * and why the comfort-ledger and verbatim-quote checks are left to skip.
 */
import type { ScoreBoard, ScoreableSession } from '@sb/core';

export interface ReferenceFixture {
  readonly name: string;
  readonly builtAt: string;
  readonly fromPinCount: number;
  readonly session: ScoreableSession;
  readonly board: ScoreBoard;
}
`;

const topicFor = (s) => ({
  id: s.topicId,
  label: s.heading,
  summary: '',
  pinIds: [`${s.topicId}-pin`],
  state: 'working',
  comfort: 0.4,
  lastExposedAt: null,
  retiredByUser: false,
  createdAt: '2026-08-01T00:00:00.000Z',
});

const emit = (r) => {
  const session = {
    targetMinutes: r.targetMinutes,
    estimatedMinutes: r.estimatedMinutes,
    closingNote: r.closingNote,
    sections: r.sections,
  };
  const board = {
    topics: r.sections.map(topicFor),
    // The rendered source COUNT, as ids. `pins` is deliberately left off: with
    // no pinned text to compare against, `no-verbatim-overquote` must skip
    // rather than pass vacuously over an empty corpus, and `comforts` is left
    // off for the same reason — back-solving a ledger from the stated register
    // would turn that check into a check on this script.
    offeredSourceIds: r.sections.flatMap((s) => s.sourceIds),
    knownAboutLearner: r.statements,
    offeredTopicOrder: r.sections.map((s) => s.topicId),
  };
  return `export const REFERENCE_${r.prefix.toUpperCase()}: ReferenceFixture = ${JSON.stringify({
    name: r.prefix === 'v1' ? 'REFERENCE_SESSION (v1)' : 'REFERENCE_SESSION_V2',
    builtAt: r.builtAt,
    fromPinCount: r.fromPinCount,
    session,
    board,
  }, null, 2)};\n`;
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${banner}\n${emit(v1)}\n${emit(v2)}`);

for (const r of [v1, v2]) {
  console.log(`${r.prefix}: ${r.sections.length} sections, ${r.sections.filter((s) => s.question).length} question(s), `
    + `${r.statements.length} learner statements, ${r.estimatedMinutes}/${r.targetMinutes}min`);
}
console.log(`wrote ${OUT}`);
