/**
 * Measures whether a guide produces actionable steps rather than restating its
 * source passage. Reports route outcome and lexical lift for synthetic cases.
 * Every pin created by the probe is deleted before exit.
 */
const SERVICE = process.env.SB_SERVICE ?? 'http://127.0.0.1:8791';

/**
 * The cases, and why each one is here.
 *
 * `expect` is what the outcome must be for the probe to pass. `judge` marks
 * the ones where the outcome is a product question rather than a defect — they
 * print and are read, they do not fail the run.
 */
const CASES = [
  {
    name: 'synthetic-short-story',
    expect: 'ready',
    why: 'The case that started this. Four named qualities are a spine; a guide should walk them.',
    pageTitle: 'How to write a short story | National Centre for Writing | NCW',
    url: 'https://nationalcentreforwriting.org.uk/writing-hub/how-to-write-a-short-story-2/',
    headingPath: [],
    selection: 'write compelling short stories with intriguing ideas, interesting '
      + 'characters, tight dialogue and satisfying endings.',
  },
  {
    name: 'explicit-instructions',
    expect: 'ready',
    why: 'The easy case, and the one the old prompt could already do. Keeps the floor honest.',
    pageTitle: 'Deploying safely',
    url: 'https://example.com/migrations',
    headingPath: ['Operations', 'Migrations'],
    selection: 'Run the migration against a copy of the database first, then verify the '
      + 'row counts match before switching the application over.',
  },
  {
    name: 'explainer-no-imperative',
    expect: 'ready',
    judge: true,
    why: 'A passage that describes rather than instructs. The old rule refused these; the '
      + 'learner asked to be walked through doing it, and the press is what sets the task.',
    pageTitle: 'Optimisers',
    url: 'https://example.com/optimisers',
    headingPath: ['Training', 'Optimisers'],
    selection: 'An optimiser is the part of the training loop that decides how far to move '
      + 'each weight once the gradients are known. Stochastic gradient descent moves every '
      + 'weight by the same learning rate; Adam keeps a running estimate per weight.',
  },
  {
    name: 'no-subject',
    expect: 'no-subject',
    why: 'The refusal must survive. Material with nothing in it must not become a guide, '
      + 'because inventing one is how a learner ends up performing a task nobody set.',
    pageTitle: 'Home',
    url: 'https://example.com/',
    headingPath: [],
    selection: 'Home About Careers Press Contact Privacy Cookies Accessibility Sitemap '
      + 'We use cookies to improve your experience. Accept all Manage preferences',
  },
];

const STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'how',
  'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'then', 'this', 'to',
  'up', 'was', 'what', 'when', 'which', 'with', 'you', 'your',
]);

/** Content words, lowercased. Stop words are excluded: they overlap between any
 *  two English sentences and would flatter every guide equally. */
const words = (s) => (s.toLowerCase().match(/[a-z']+/g) ?? []).filter((w) => !STOP.has(w));

/**
 * How much of a step came out of the passage.
 *
 * Counted over content words, so 1.0 is a step that introduced no word the
 * learner had not already read, and a low number is a step that is doing work.
 * A crude instrument on purpose: it is a tripwire for the formatter failure,
 * not a quality score, and it says nothing about whether the steps are *good*.
 */
function lift(step, material) {
  const source = new Set(words(material));
  const own = words(`${step.action} ${step.why}`);
  if (!own.length) return 1;
  return own.filter((w) => source.has(w)).length / own.length;
}

const post = async (path, body) => {
  const r = await fetch(`${SERVICE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
};

async function run(testCase) {
  const envelope = {
    url: testCase.url,
    canonicalUrl: testCase.url,
    pageTitle: testCase.pageTitle,
    siteName: new URL(testCase.url).hostname,
    documentKind: 'html',
    contentLanguage: 'en-US',
    headingPath: testCase.headingPath,
    selection: testCase.selection,
    surroundingText: testCase.selection,
    parts: [{ role: 'passage', text: testCase.selection }],
    pdfPage: null,
    videoMoment: null,
    media: null,
    mediaOmitted: null,
  };

  const pin = await post('/pins', {
    type: 'interest',
    clientRef: `probe-guide-${testCase.name}`,
    capturedAt: new Date().toISOString(),
    envelope,
  });

  try {
    const answer = await post(`/pins/${encodeURIComponent(pin.id)}/guide`);
    return { pin, answer };
  } finally {
    await fetch(`${SERVICE}/pins/${encodeURIComponent(pin.id)}`, { method: 'DELETE' })
      .catch(() => {});
  }
}

const pct = (n) => `${Math.round(n * 100)}%`;

let failures = 0;

for (const testCase of CASES) {
  const { answer } = await run(testCase);
  const ok = answer.outcome === testCase.expect;
  const verdict = ok ? 'PASS' : (testCase.judge ? 'JUDGE' : 'FAIL');
  if (!ok && !testCase.judge) failures += 1;

  console.log(`\n${'='.repeat(72)}`);
  console.log(`${verdict}  ${testCase.name}`);
  console.log(`  ${testCase.why}`);
  console.log(`  pinned:  "${testCase.selection.slice(0, 96)}${testCase.selection.length > 96 ? '…' : ''}"`);
  console.log(`  outcome: ${answer.outcome}   (expected ${testCase.expect})`);

  if (answer.steps?.length) {
    const lifts = answer.steps.map((s) => lift(s, testCase.selection));
    const mean = lifts.reduce((a, b) => a + b, 0) / lifts.length;
    console.log(`  steps:   ${answer.steps.length}   mean lift ${pct(mean)}`);
    answer.steps.forEach((s, i) => {
      console.log(`\n   ${i + 1}. ${s.action}`);
      console.log(`      why: ${s.why}`);
      console.log(`      lift: ${pct(lifts[i])}`);
    });
    if (mean > 0.6) {
      console.log('\n  ⚠ HIGH LIFT — these steps are largely the passage\'s own words back. '
        + 'A learner paid for a model call and got a formatter.');
    }
  }
}

console.log(`\n${'='.repeat(72)}`);
console.log(failures ? `${failures} case(s) FAILED` : 'all non-judge cases passed');
process.exit(failures ? 1 : 0);
