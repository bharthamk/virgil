/**
 * Render a stored session as markdown, in the shape the two REFERENCE_SESSION
 * artefacts are already in.
 *
 * Those two were rendered by hand, which is why `transcribe-reference-sessions`
 * has to reconstruct topic ids and source ids from a count — the rendering
 * dropped them. This one is written from the store, so it can carry what the
 * hand rendering could not: the topic id behind each section, the source ids
 * that actually resolve, and the comfort reading the register was derived from.
 * A three-register claim that cannot be checked against the ledger it came from
 * is the claim §2 of the knowledge bank had to withdraw.
 *
 *   node scripts/render-session.mjs --store .data-3r/store.json > SESSION.md
 */
import { existsSync } from 'node:fs';
import { JsonStore } from '../adapters/dist/index.js';
import { computeComfort, registerFor } from '../core/dist/index.js';

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const path = arg('store', process.env.SB_DB ?? '.data/store.json');
if (!existsSync(path)) { console.error(`render-session: no store at ${path}`); process.exit(2); }

const store = new JsonStore(path);
const session = await store.latestSession();
if (!session) { console.error(`render-session: ${path} holds no session`); process.exit(2); }

const topics = await store.listTopics();
const signals = await store.listSignals();
const statements = await store.listStatements();
const at = new Date(session.builtAt ?? Date.now());
const byId = new Map(topics.map((t) => [t.id, t]));
const out = [];

out.push(`# Session — ${path}`);
out.push('');
out.push(`> Built ${session.builtAt} · target ${session.targetMinutes}min · estimated ${session.estimatedMinutes}min`);
out.push(`> ${session.sections.length} section(s)${session.withheld?.length ? `, ${session.withheld.length} withheld` : ''}`
  + ` · outcome \`${session.outcome}\`${session.revision ? ' · revision offer' : ''}`);
out.push('');

for (const s of session.sections) {
  const t = byId.get(s.topicId);
  const c = t ? computeComfort(t.id, signals, at) : undefined;
  out.push('---');
  out.push('');
  out.push(`## ${s.heading}`);
  out.push('');
  out.push(`**register:** \`${s.depth}\` · **~${s.estimatedMinutes} min** · **${s.sourceIds?.length ?? 0} sources**`);
  out.push('');
  // The register is derived, so the numbers it was derived from belong beside
  // it. Without them "this section is fluent" is an assertion about a string.
  if (c) {
    out.push(`> topic \`${t.id}\` — "${t.label}" · comfort ${c.comfort.toFixed(3)}`
      + ` · certainty ${c.certainty.toFixed(3)} · evidence ${c.evidenceCount}`
      + `${c.regressed ? ' · REGRESSED' : ''} → \`${registerFor(c)}\``);
    out.push('');
  }
  if (s.mediumWarning) {
    out.push(`> **Medium warning:** ${s.mediumWarning}`);
    out.push('');
  }
  out.push(s.body);
  out.push('');
  if (s.question) {
    out.push(`**Question (${s.question.kind}):** ${s.question.prompt}`);
    out.push('');
  }
  if (s.sourceIds?.length) {
    out.push(`*sources:* ${s.sourceIds.map((i) => `\`${i}\``).join(', ')}`);
    out.push('');
  }
}

if (session.withheld?.length) {
  out.push('---');
  out.push('');
  out.push('## Withheld');
  out.push('');
  for (const w of session.withheld) out.push(`- **${w.heading}** — ${w.reason}`);
  out.push('');
}

if (session.closingNote) {
  out.push('---');
  out.push('');
  out.push(`## Closing note`);
  out.push('');
  out.push(session.closingNote);
  out.push('');
}

if (statements.length) {
  out.push('---');
  out.push('');
  out.push('## The learner model, in its own words');
  out.push('');
  for (const st of statements) out.push(`> ${st.text}`);
  out.push('');
}

console.log(out.join('\n'));
