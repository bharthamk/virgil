// Enforces the provider-seam contract: core/ imports no vendor SDK and no I/O.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const FORBIDDEN = [
  /from ['"]node:(fs|http|https|net|child_process|dns)/,
  /from ['"](@google-cloud|@google\/|firebase|@anthropic-ai|openai|node-fetch|axios|better-sqlite3)/,
  /\bfetch\s*\(/,
];
const bad = [];
const walk = (d) => readdirSync(d).forEach((f) => {
  const p = join(d, f);
  if (statSync(p).isDirectory()) return walk(p);
  if (!p.endsWith('.ts') || p.includes('__tests__')) return;
  const src = readFileSync(p, 'utf8');
  FORBIDDEN.forEach((re) => { if (re.test(src)) bad.push(`${p} :: ${re}`); });
});
walk('core/src');
// adapters are allowed I/O by definition; only core/ is guarded.
if (bad.length) { console.error('SEAM VIOLATION in core/:\n' + bad.join('\n')); process.exit(1); }
console.log('seam ok: core/ is vendor-free and I/O-free');
