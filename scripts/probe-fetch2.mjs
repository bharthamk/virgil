import { LocalResearch } from '../adapters/dist/index.js';
const r = new LocalResearch();
// Real, currently-live pages across the shapes a learner actually reads:
// vendor docs, MDN, wikipedia, a JS-rendered SPA, a blog, a spec.
const urls = [
  'https://cloud.google.com/pubsub/docs/ordering',
  'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch',
  'https://en.wikipedia.org/wiki/Tritone_substitution',
  'https://www.musictheory.net/lessons/31',
  'https://react.dev/learn/state-a-components-memory',
  'https://datatracker.ietf.org/doc/html/rfc9110',
  'https://docs.python.org/3/library/asyncio-task.html',
  'https://kubernetes.io/docs/concepts/workloads/pods/',
];
let usable = 0;
for (const url of urls) {
  const t = Date.now();
  const got = await r.fetchPage(url);
  const ms = Date.now() - t;
  if (!got) { console.log(`FAIL  ${String(ms).padStart(5)}ms  ${url}`); continue; }
  const words = got.text.split(/\s+/).length;
  if (words < 300) { console.log(`THIN  ${String(ms).padStart(5)}ms  ${String(words).padStart(6)}w  ${url}`); continue; }
  usable++;
  // Take a genuine verbatim sentence from the middle of the live page, then
  // check the anchoring window can actually relocate it.
  const mid = got.text.slice(Math.floor(got.text.length * 0.5), Math.floor(got.text.length * 0.5) + 120);
  const at = got.text.indexOf(mid.slice(0, 60));
  console.log(`OK    ${String(ms).padStart(5)}ms  ${String(words).padStart(6)}w  anchor=${at >= 0 ? 'found' : 'MISSING'}  ${url}`);
}
console.log(`\n${usable}/${urls.length} real pages usable by plain fetch`);
