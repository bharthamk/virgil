import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  AI_MODE_PARAM, AI_MODE_SEARCH, AI_MODE_VALUE, FORWARD_URL_CAP,
  TUTOR_LESSON_LABEL, TUTOR_START_WITH_QUESTION,
  forwardUrl, tutorForwardHandoffLine, tutorForwardLines,
  tutorForwardPrompt, tutorForwardTarget, tutorForwardedLine,
  tutorGoalLine, tutorLineupLine, tutorNowLine, tutorPracticeLine, tutorQuestionLine,
  tutorRegisterLine, tutorOpenFailedLine,
  POPUP_HEIGHT, POPUP_WIDTH, TUTOR_BESIDE_LABEL, TUTOR_COPIED_LINE, TUTOR_COPY_LABEL,
  TUTOR_FORWARD_LABEL, TUTOR_ROUTES_HEADING,
  besideWindow, popupFeatures, tutorClipboardPrompt, tutorRouteTitle,
} from '../tutor-brief.js';


const srcDir = new URL('../../src/', import.meta.url);
const shipped = (): string[] =>
  readdirSync(fileURLToPath(srcDir)).filter((f) => f.endsWith('.ts'));
const read = (file: string): string => readFileSync(fileURLToPath(new URL(file, srcDir)), 'utf8');

/** Comments removed, the way the notebook seam removes them: the module's prose
 *  names every route and construction its code is forbidden to use. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** A brief with every optional fact present, so the fullest form is the one
 *  most assertions read. */
const brief = (over: Partial<Parameters<typeof tutorForwardLines>[0]> = {}) => ({
  heading: 'How TLS gets its keys',
  summary: 'What the handshake agrees on before anything is encrypted',
  depth: 'building',
  course: 'Networks and Security',
  serves: 'Marketing analysis',
  next: 'Why forward secrecy',
  ...over,
});

const QUESTION = 'Say it back in your own words.';

/**
 * Lesson prose, at the shape the Composer actually writes.
 *
 * Not `'x'.repeat(n)`: a repeated character encodes to itself and would make
 * the cap look twice as generous as it is. Real prose carries spaces, full
 * stops, commas and paragraph breaks, and those are where the percent-encoding
 * cost comes from — which is the whole thing being measured.
 */
const prose = (paragraphs: number): string => Array.from({ length: paragraphs }, (_, i) =>
  `Paragraph ${i + 1}. The handshake begins with a hello, and the two sides agree on a `
  + 'cipher suite before anything else happens. The server proves who it is with a '
  + 'certificate, and the key that encrypts the rest of the conversation is derived '
  + 'fresh, on both sides, from values neither of them sent in the clear.').join('\n\n');

/** Every sentence the module can put in front of a reader. */
const everySentence = (): string[] => [
  TUTOR_ROUTES_HEADING, TUTOR_COPIED_LINE, TUTOR_LESSON_LABEL, TUTOR_START_WITH_QUESTION,
  TUTOR_FORWARD_LABEL, TUTOR_BESIDE_LABEL, TUTOR_COPY_LABEL,
  tutorOpenFailedLine('tab'), tutorOpenFailedLine('beside'), tutorOpenFailedLine('copy'),
  tutorForwardedLine(true), tutorForwardedLine(false),
  tutorForwardedLine(true, 'beside'), tutorForwardedLine(false, 'beside'),
  tutorForwardedLine(true, 'copy'), tutorForwardedLine(false, 'copy'),
  tutorRouteTitle('tab'), tutorRouteTitle('beside'), tutorRouteTitle('copy'),
  tutorForwardHandoffLine(true), tutorForwardHandoffLine(false),
  String(tutorQuestionLine(QUESTION)), TUTOR_START_WITH_QUESTION, TUTOR_LESSON_LABEL,
  ...tutorForwardLines(brief(), QUESTION, true),
  ...tutorForwardLines(brief({ depth: 'from-nothing' }), QUESTION, true),
  ...tutorForwardLines(brief({ depth: 'fluent' }), null, false),
  ...tutorForwardLines(
    brief({ depth: 'unheard-of', course: null, serves: null, next: null, summary: null }), null, false),
];

// ------------------------------------------------------------------- the route

test('§6f-i fact 1: forwarding targets Google AI Mode, over https, at the search path', () => {
  const url = new URL(AI_MODE_SEARCH);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.host, 'www.google.com');
  assert.equal(url.pathname, '/search');
  // The constant carries no query of its own. A template with `q=` already in
  // it is a template somebody appends a raw string to, which is how a lesson
  // containing an ampersand becomes a parameter nobody meant.
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
});

test('§6f-i fact 2: it is AI Mode and not a results page, and that is one parameter', () => {
  assert.equal(AI_MODE_PARAM, 'udm');
  assert.equal(AI_MODE_VALUE, '50');
  const url = new URL(forwardUrl('hello'));
  assert.equal(url.searchParams.get('udm'), '50',
    'without udm=50 this is a search box, and the prompt becomes a query nobody answers');
  assert.equal(url.searchParams.get('q'), 'hello');
});

test('§6f-i build gate: the address is written down in exactly one place', () => {
  const naming = shipped().filter((f) => /www\.google\.com\/search/.test(read(f)));
  assert.deepEqual(naming, ['tutor-brief.ts']);
});

test('§6f-i: the unsupported Gemini chat query route is shipped in no code path', () => {
  for (const file of shipped()) {
    assert.ok(!/gemini\.google\.com/.test(stripComments(read(file))),
      `${file} carries an unsupported Gemini chat route`);
  }
});

test('§6f-i: the module that holds the address has no way to send anything itself', () => {
  const code = stripComments(read('tutor-brief.ts'));
  for (const forbidden of [/\bfetch\s*\(/, /serviceFetch/, /XMLHttpRequest/, /sendBeacon/, /chrome\./]) {
    assert.ok(!forbidden.test(code),
      `the brief names ${forbidden} — the file that builds the prompt must not also be `
      + 'the file that can send it');
  }
});

test('§6f-i: the brief imports nothing at all', () => {
  const strays = [...stripComments(read('tutor-brief.ts')).matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)]
    .map((m) => m[1]);
  assert.deepEqual(strays, [],
    'pure copy and pure url arithmetic: there is nothing for it to reach through');
});

// ----------------------------------------------- continuation, not instruction

test('§6f-i AUDIENCE LAW: the prompt is the learner speaking, and nobody else', () => {

  const everyLine = ['from-nothing', 'building', 'fluent'].flatMap((depth) => [
    ...tutorForwardLines(brief({ depth }), QUESTION, true),
    ...tutorForwardLines(brief({ depth }), null, false),
  ]);
  for (const line of everyLine) {
    /**
     * Third-person references TO THE LEARNER, which is the thing banned — not
     * the pronoun wherever it falls. *"build on them"* points at the basics and
     * is the learner talking about their own knowledge; the ban is on the
     * learner being described from outside, or the assistant being addressed as
     * somebody's tutor about somebody else.
     */
    for (const re of [
      /\bthey\b/i, /\btheir\b/i, /\bthe learner\b/i, /\byour student\b/i,
      /\bthe student\b/i, /for your tutor/i,
      /\b(for|to|tell|help|show|ask|give) them\b/i, /\bthem\b\s*$/i,
    ]) {
      assert.ok(!re.test(line), `"${line}" speaks about a third person: ${re}`);
    }
  }
  // And the learner really is in it, rather than the pronouns merely being absent.
  assert.ok(everyLine.filter((l) => /\bI\b|I’|\bmy\b|\bme\b/.test(l)).length >= 5);
});

test('§6f-i: the prompt carries no heading naming an audience', () => {
  // The heading WAS the bug. A line naming an audience tells the model who it
  // is working for, and it worked for them.
  const q = new URL(tutorForwardTarget(brief(), QUESTION, prose(1)).url).searchParams.get('q')!;
  assert.ok(!/for your tutor/i.test(q));
  assert.match(q, /^I’m studying /,
    'the prompt opens with the learner talking, because that is who is talking');
  assert.equal(TUTOR_LESSON_LABEL, 'Here’s the lesson Virgil opened:');
});

test('§6f-i: what the learner asks for is a request, not an attempt to operate a model', () => {
  /**
   * The register lines are the learner directing their own tutor — *I have the
   * basics; build on them* — which is the most ordinary thing in teaching and
   * nothing like a page slipping orders to somebody's assistant. What stays
   * banned is the vocabulary of a prompt trying to drive a model.
   */
  const everyLine = ['from-nothing', 'building', 'fluent'].flatMap((depth) =>
    tutorForwardLines(brief({ depth }), QUESTION, true));
  for (const line of everyLine) {
    for (const re of [
      /\byou are\b/i, /\byou’re\b/i, /\bact as\b/i, /\byour task\b/i,
      /\bignore\b/i, /\binstructions?\b/i, /\bsystem\b/i, /\bprompt\b/i,
      /\brespond with\b/i, /\bas an ai\b/i,
    ]) {
      assert.ok(!re.test(line), `"${line}" is operating the model rather than talking to a tutor: ${re}`);
    }
    assert.match(line, /[.!?”]$/, 'each line is a whole sentence');
  }
});


test('§6f-i: the question and its first teaching move are one line, inseparable', () => {
  /**
   * The rubric cannot travel (the function takes a string and refuses
   * everything else), and the first teaching move travels in the same breath.
   * Asking the question protects the learner's answer without making Gemini
   * announce that it is ready and wait for the learner to recreate the turn.
   */
  assert.equal(TUTOR_START_WITH_QUESTION,
    'I haven’t answered it. Ask me that question directly as your first response, then teach from my answer.');
  assert.equal(tutorQuestionLine(QUESTION),
    `The lesson has this practice question: “Say it back in your own words.” ${TUTOR_START_WITH_QUESTION}`);
  assert.equal(tutorQuestionLine(null), null, 'no question, no line about one');
  assert.equal(tutorQuestionLine('   '), null);
  assert.equal(tutorQuestionLine('Say it\n  back.'),
    `The lesson has this practice question: “Say it back.” ${TUTOR_START_WITH_QUESTION}`);
  // There is no arrangement of the module in which one arrives without the other.
  for (const carries of [true, false]) {
    const sent = tutorForwardLines(brief(), QUESTION, carries);
    const asked = sent.filter((l) => /The lesson has this practice question/.test(l));
    assert.equal(asked.length, 1);
    assert.ok(asked[0]!.includes(TUTOR_START_WITH_QUESTION));
  }
});

test('§6f-i: New tab begins the lesson instead of opening a waiting room', () => {
  /**
   * Live joint QC, 2026-08-30. The old continuation said the learner had just
   * read the lesson, that the ground was already covered, and that Gemini
   * should let them try. AI Mode therefore answered with “I am ready whenever
   * you are”, “reply whenever you are set”, and a menu of things it could do
   * later. Every sentence was obedient and the hand-off was still a failure:
   * the learner pressed a teaching door and landed in more setup.
   */
  const prompt = tutorForwardPrompt(
    tutorForwardLines(brief({ depth: 'from-nothing' }), QUESTION, true),
    'The handshake picks a key.',
  );

  assert.doesNotMatch(prompt, /I’ve just read|already covers the ground|let me try/i,
    'the hand-off claims teaching has already happened');
  assert.match(prompt, /I’m opening a lesson on How TLS gets its keys/,
    'opening the hand-off is the only progress Virgil can truthfully claim');
  assert.match(prompt, /Ask me that question directly as your first response/,
    'Gemini is still free to answer with readiness rather than the actual next move');
  assert.match(prompt, /I don’t need a welcome, a menu, or a reminder to reply/,
    'the prompt leaves room for the exact friction the live result produced');
  assert.match(prompt, /Start teaching me now\.$/m,
    'the hand-off does not transfer the teaching in the press that opened it');
});

test('§6f-i: it ends at the hand-over, and the hand-over asks rather than orders', () => {
  for (const carries of [true, false]) {
    const lines = tutorForwardLines(brief(), QUESTION, carries);
    assert.equal(lines.at(-1), tutorForwardHandoffLine(carries));
    assert.match(lines.at(-1)!, /Start teaching me now\.$/,
      'the press transfers the teaching instead of announcing readiness');
  }
});

test('§6f-i: the hand-over tells the truth about what travelled with it', () => {
  // The on-page line points at the lesson above it. A forwarded prompt has no
  // above: either the lesson came too, or the summary is the whole account.
  // Saying the wrong one is a small lie that produces a confident wrong answer.
  assert.match(tutorForwardHandoffLine(true), /^The lesson itself is below\./);
  assert.ok(!/below/.test(tutorForwardHandoffLine(false)),
    'a prompt with no lesson in it may not point at one');
  assert.ok(!/on this page/.test(tutorForwardHandoffLine(true)),
    'the new tab cannot see this page, and a line that said so would be wrong at the far end');
});

// -------------------------------------------------------------- the six lines

test('§6f-i line 1: why I am here, from the chips the lesson already carries', () => {
  assert.equal(tutorGoalLine('Networks and Security', 'Marketing analysis'),
    'I’m studying Networks and Security, working towards Marketing analysis.');
  assert.equal(tutorGoalLine('Networks and Security', null), 'I’m studying Networks and Security.');
  assert.equal(tutorGoalLine(null, 'Marketing analysis'), 'I’m working towards Marketing analysis.');
  // Neither is a real answer rather than an absence: somebody studying off
  // their own board chose this, and saying so is truer than saying nothing.
  assert.equal(tutorGoalLine(null, null), 'I’m studying from things I’ve pinned myself.');
  assert.equal(tutorGoalLine('  ', '  '), 'I’m studying from things I’ve pinned myself.');
});

test('§6f-i line 2: what I am opening, from the Composer’s own summary', () => {
  assert.equal(
    tutorNowLine('How TLS gets its keys', 'What the handshake agrees on before anything is encrypted'),
    'I’m opening a lesson on How TLS gets its keys: What the handshake agrees on before anything is encrypted.');
  // No summary is a shorter sentence, never a placeholder and never the body:
  // first-sentence extraction was ruled out on 2026-08-24 because a good lesson
  // opens on an analogy often enough that the mechanism is wrong.
  assert.equal(tutorNowLine('How TLS gets its keys', null),
    'I’m opening a lesson on How TLS gets its keys.');
  assert.equal(tutorNowLine('', null), 'I’m opening a lesson on this one.');
  assert.equal(tutorNowLine('How TLS  gets\nits keys', 'A sentence.'),
    'I’m opening a lesson on How TLS gets its keys: A sentence.',
    'no double stop, no stray whitespace');
});

test('§6f-i line 3: my level, said as what I am asking my tutor to do about it', () => {
  /**
   * The register is a machine word with a real meaning behind it, and the
   * meaning is the useful half. In the first person these become **requests I
   * am making of my own tutor** — *I have the basics, build on them* — which is
   * a different thing from a page slipping instructions to somebody's model.
   */
  assert.equal(tutorRegisterLine('from-nothing'),
    'This topic is new to me, so keep the words plain.');
  assert.equal(tutorRegisterLine('building'),
    'I have the basics; build on them, don’t re-explain.');
  assert.equal(tutorRegisterLine('fluent'),
    'I know this well; push me on the edge cases.');
  // A register this build does not know is said as not knowing. A guess here
  // would be a claim about the learner made by a version mismatch.
  assert.equal(tutorRegisterLine('sideways'), 'I’m not sure what level to call myself on this one.');
  assert.equal(tutorRegisterLine(''), 'I’m not sure what level to call myself on this one.');
});

test('§6f-i line 4: how teaching should begin, without claiming the lesson is covered', () => {
  assert.equal(tutorPracticeLine('from-nothing'),
    'I want to learn it from the beginning, one small step at a time.');
  assert.equal(tutorPracticeLine('building'),
    'I want to connect it to what I know and use it on a case I haven’t seen yet.');
  assert.equal(tutorPracticeLine('fluent'),
    'I want to test the edge cases and where the idea stops holding.');
  assert.equal(tutorPracticeLine('sideways'),
    'I want to work out what I understand and take the next useful step.');
  for (const depth of ['from-nothing', 'building', 'fluent', 'sideways']) {
    assert.doesNotMatch(tutorPracticeLine(depth), /already|covered|read/i,
      'opening a lesson was mistaken for completing it');
  }
});

test('§6f-i line 5: where today’s lineup goes after this one', () => {
  assert.equal(tutorLineupLine('Why forward secrecy'), 'After this one I’m on to Why forward secrecy.');
  assert.equal(tutorLineupLine(null), 'This is the last one in today’s lineup.');
  assert.equal(tutorLineupLine('  '), 'This is the last one in today’s lineup.');
});

// --------------------------------------------------------- the forwarded shape

test('§6f-i: the forwarded prompt is the learner’s context, first move and lesson', () => {
  const lines = tutorForwardLines(brief(), QUESTION, true);
  assert.deepEqual(lines, [
    'I’m studying Networks and Security, working towards Marketing analysis.',
    'I’m opening a lesson on How TLS gets its keys: What the handshake agrees on before anything is encrypted.',
    'I have the basics; build on them, don’t re-explain.',
    'I want to connect it to what I know and use it on a case I haven’t seen yet.',
    'After this one I’m on to Why forward secrecy.',
    'The lesson has this practice question: “Say it back in your own words.” '
      + 'I haven’t answered it. Ask me that question directly as your first response, then teach from my answer.',
    'The lesson itself is below. I don’t need a welcome, a menu, or a reminder to reply. Start teaching me now.',
  ]);
  assert.equal(tutorForwardPrompt(lines, 'The handshake picks a key.'), [
    ...lines,
    '',
    'Here’s the lesson Virgil opened:',
    'The handshake picks a key.',
  ].join('\n'));
});


test('§6f-i: a lesson with no question forwards no invented question or answer turn', () => {
  const sent = tutorForwardLines(brief(), null, false);
  assert.equal(sent.length, 6, 'five context/request lines and the hand-over');
  assert.ok(!sent.some((l) => /practice question/.test(l)));
  assert.ok(!sent.some((l) => l.includes(TUTOR_START_WITH_QUESTION)),
    'nothing is unanswered when nothing was asked');
});

test('§6f-i: the Marker’s rubric never travels — only the question’s own words do', () => {
  /**
   * From the live rehearsal, 2026-08-25. `section.question` is an OBJECT:
   * `{ prompt, expectedPoints }`, and `expectedPoints` is the Marker's expected
   * answer. A naive render leaked it into the prompt, which would have handed
   * the learner's assistant the marking scheme for the question it was about to
   * help them attempt.
   *
   * The refusal is structural rather than a rule about call sites: the function
   * takes a string and answers null to everything else, so passing the whole
   * object by mistake produces no line at all rather than a leak.
   */
  const question = {
    prompt: 'Say it back in your own words.',
    expectedPoints: ['ephemeral keys', 'nothing long lived is reused'],
    kind: 'recall',
  };
  assert.equal(tutorQuestionLine(question as unknown as string), null,
    'the whole object rendered rather than being refused');

  // And end to end, through the url the press actually opens.
  const q = new URL(tutorForwardTarget(brief(), question.prompt, prose(1)).url)
    .searchParams.get('q')!;
  assert.match(q, /Say it back in your own words/, 'the question itself is what travels');
  for (const leak of [...question.expectedPoints, 'expectedPoints', 'kind', 'recall']) {
    assert.ok(!q.includes(leak), `the forwarded prompt leaked "${leak}"`);
  }
});

test('§6f-i: the concrete first move reaches the far end, in the learner’s own voice', () => {
  /**
   * The rehearsal finding that changed the payload. With the question in and
   * nothing said about whose move it was, Gemini answered it on the spot —
   * *"The Direct Answer: decrease..."* — the worst available outcome for a
   * from-nothing learner holding a say-it-back question.
   *
   * The third-person version of the fix was in the rehearsal and was ignored.
   * First person is a different speech act, not a rephrasing.
   */
  for (const depth of ['from-nothing', 'building', 'fluent']) {
    for (const carries of [true, false]) {
      const sent = tutorForwardLines(brief({ depth }), QUESTION, carries);
      const asked = sent.find((l) => /The lesson has this practice question/.test(l));
      assert.ok(asked?.endsWith(TUTOR_START_WITH_QUESTION), 'the first move did not travel with the question');
      assert.equal(sent.at(-1), tutorForwardHandoffLine(carries),
        'and the hand-over is still the last thing said');
    }
  }
  assert.ok(!/\bdo not\b|\bdon’t answer\b|\bwait\b|\bavoid\b/i.test(TUTOR_START_WITH_QUESTION),
    'a request for the question, never a prohibition');
  // Through the url rather than through the array.
  const q = new URL(tutorForwardTarget(brief(), QUESTION, prose(1)).url).searchParams.get('q')!;
  assert.ok(q.includes(TUTOR_START_WITH_QUESTION));
});

// -------------------------------------------------------------------- the url

test('§6f-i: the prompt rides in q, encoded, and comes back out unchanged', () => {
  const prompt = tutorForwardPrompt(tutorForwardLines(brief(), QUESTION, true), 'Body & more. 100% of it.');
  const url = new URL(forwardUrl(prompt));
  assert.equal(url.searchParams.get('q'), prompt,
    'what the far end receives is character for character what was built');
});

test('§6f-i: a lesson containing an ampersand cannot end the prompt early', () => {
  // The failure this guards is a lesson about `A & B` truncating the prompt at
  // the ampersand and starting a parameter nobody meant. Encoded parts rather
  // than string concatenation is the whole answer.
  const url = new URL(forwardUrl('one & two ?three #four=five'));
  assert.equal(url.searchParams.get('q'), 'one & two ?three #four=five');
  assert.equal([...url.searchParams.keys()].sort().join(','), 'q,udm');
  assert.equal(url.hash, '', 'a hash in the prompt is not a hash in the url');
});

// ------------------------------------------------------------------- the cap

test('§6f-i: an ordinary lesson travels whole', () => {
  const target = tutorForwardTarget(brief(), QUESTION, prose(1));
  assert.equal(target.carriesBody, true);
  assert.ok(target.url.length <= FORWARD_URL_CAP, `${target.url.length} is over the cap`);
  const q = new URL(target.url).searchParams.get('q')!;
  assert.match(q, /Paragraph 1\./, 'the lesson itself went');
  assert.match(q, /The lesson itself is below\..*Start teaching me now\./);
});

test('§6f-i: a lesson too long for one address sends its summary and says so', () => {
  /**
   * Nothing is truncated. A prompt cut off mid-sentence still runs and still
   * answers, about half a lesson, without saying so — which is the failure the
   * whole file exists to avoid. The short branch sends the Composer's summary,
   * a hand-over that does not claim a lesson is below it, and a sentence on the
   * screen telling the learner which of the two happened.
   */
  const target = tutorForwardTarget(brief(), QUESTION, prose(24));
  assert.equal(target.carriesBody, false);
  assert.ok(target.url.length <= FORWARD_URL_CAP, `${target.url.length} is over the cap`);
  const q = new URL(target.url).searchParams.get('q')!;
  assert.ok(!/Paragraph 1\./.test(q), 'the lesson did not go, whole or in part');
  assert.ok(!/\nThe lesson\n/.test(q), 'and there is no heading over a lesson that is not there');
  assert.ok(!/below/.test(q), 'nor a hand-over pointing at one');
  assert.match(q, /What the handshake agrees on before anything is encrypted/,
    'the Composer’s summary is what the far end knows about the material');
});

test('§6f-i: the cap is a measured url rather than a guess about characters', () => {
  // Prose roughly doubles through percent-encoding once spaces, newlines and
  // punctuation are counted, so a length check on the raw text would pass a
  // prompt the url refuses. The boundary is walked here rather than asserted at
  // one convenient size.
  assert.equal(FORWARD_URL_CAP, 6000);
  let carried = 0;
  let dropped = 0;
  for (let n = 1; n <= 26; n += 1) {
    const t = tutorForwardTarget(brief(), QUESTION, prose(n));
    assert.ok(t.url.length <= FORWARD_URL_CAP, `${n} paragraphs produced ${t.url.length}`);
    if (t.carriesBody) carried += 1; else dropped += 1;
  }
  assert.ok(carried > 0 && dropped > 0, 'the fixtures must straddle the cap or this proves nothing');
});

test('§6f-i: an empty lesson body is the short branch, not an empty heading', () => {
  for (const body of [null, '', '   ']) {
    const t = tutorForwardTarget(brief(), QUESTION, body);
    assert.equal(t.carriesBody, false);
    assert.ok(!new URL(t.url).searchParams.get('q')!.includes('\nThe lesson\n'));
  }
});

// -------------------------------------------------------------- the control

test('§6f-i: the heading carries the object, and the labels are the destinations', () => {

  assert.equal(TUTOR_ROUTES_HEADING, 'Take this lesson to Gemini');
  assert.equal(TUTOR_FORWARD_LABEL, 'New tab');
  assert.equal(TUTOR_BESIDE_LABEL, 'Pop out');
  assert.equal(TUTOR_COPY_LABEL, 'Side panel');

  // The heading names the thing that travels, so no button has to repeat it.
  assert.match(TUTOR_ROUTES_HEADING, /\bthis lesson\b/);
  // And it does not promise a placement over controls that place nothing.
  assert.ok(!/\bin a\b\s*$/i.test(TUTOR_ROUTES_HEADING));
  const labels: string[] = [TUTOR_FORWARD_LABEL, TUTOR_BESIDE_LABEL, TUTOR_COPY_LABEL];
  for (const label of labels) {
    // Short enough to sit four-across in a 380px column and wrap once at worst.
    // The whole sentence is on the control, not in the label.
    assert.ok(label.length <= 16, `"${label}" is a sentence where a label belongs`);
    assert.ok(!/\bsends?\b|\bshared?\b|\buploaded\b/i.test(label));
  }
  // The one that opens nothing still says so in both places a learner can read
  // it. This is the whole of what the short label costs, and the whole of what
  // pays for it.
  assert.match(tutorRouteTitle('copy'), /^Copies\b/,
    'the door that copies must say copy where a learner meets it before pressing');
  assert.match(TUTOR_COPIED_LINE, /copied to your clipboard/,
    'and again in the receipt, because this door opens nothing at all');
  // The failure this guards is "send this lesson to Gemini". Nothing is sent: a
  // url is handed to the browser, or text is put on the learner's clipboard.
  assert.ok(!/\bsends?\b|\bshared?\b|\buploaded\b/i.test(TUTOR_ROUTES_HEADING));
});

test('§6f-i: each door carries its whole sentence, as title and as accessible name', () => {
  // The labels are places; this is what pressing one does. One string feeds
  // both attributes, because a control whose tooltip and accessible name
  // disagree is two controls depending on how you meet it.
  assert.match(tutorRouteTitle('tab'), /^Opens a new tab, with this lesson and where you have got to with it already written out\.$/);
  assert.match(tutorRouteTitle('beside'), /^Opens a small window beside this page,/);
  assert.match(tutorRouteTitle('copy'), /^Copies this lesson and where you have got to with it to your clipboard\./);
  // And the panel's title tells the truth about why it is a copy rather than an
  // opener: no page can open the browser's own panel.
  assert.match(tutorRouteTitle('copy'), /No page can open your browser’s own side panel, so opening it and pasting stays yours/);
  // *Thread* was a word only this codebase knew. Whatever these sentences say
  // now, they may not go back to naming the payload after itself.
  for (const where of ['tab', 'beside', 'copy'] as const) {
    assert.ok(!/thread/i.test(tutorRouteTitle(where)),
      'the control says what travels, not the internal name for it');
  }
});

test('§6f-i: the panel door copies, and never claims to have opened anything', () => {


  assert.equal(TUTOR_COPIED_LINE,
    'Forwarding prompt has been copied to your clipboard. '
    + 'Open your Gemini side panel, paste, and hit enter.');
  // One line, whatever the lesson's length: the clipboard has no cap, so there
  // is no second case to report. Saying "too long for one address" over a
  // clipboard write that carried the whole lesson would be false in the one
  // place a learner could check it.
  assert.equal(tutorForwardedLine(true, 'copy'), TUTOR_COPIED_LINE);
  assert.equal(tutorForwardedLine(false, 'copy'), TUTOR_COPIED_LINE);
  assert.ok(!tutorForwardedLine(false, 'copy').includes('too long'));
  // And it is the copy door's alone: the other two report their own outcome.
  for (const where of ['tab', 'beside'] as const) {
    assert.notEqual(tutorForwardedLine(true, where), TUTOR_COPIED_LINE);
    assert.ok(!tutorForwardedLine(true, where).includes('clipboard'));
  }
  assert.match(tutorForwardedLine(false, 'tab'), /too long for one address/);
  assert.match(tutorOpenFailedLine('copy'), /^I couldn’t copy it\. Nothing was lost\./);
});

test('§6f-i: the clipboard carries the whole lesson, however long it is', () => {
  // Same builder, same statements, same refusal to carry the rubric, same
  // hand-over of the turn. The only difference is the cap, and the difference
  // is that there is not one.
  const long = prose(40);
  const payload = tutorClipboardPrompt(brief(), QUESTION, long);
  assert.equal(payload.carriesBody, true);
  assert.ok(payload.text.includes('Paragraph 40.'), 'the clipboard shortened a lesson it had room for');
  assert.ok(payload.text.includes(TUTOR_START_WITH_QUESTION));
  assert.match(payload.text, /^I’m studying /);
  assert.match(payload.text, /The lesson itself is below\./);
  // The url door, on the same lesson, takes the short branch. Two doors, two
  // honest accounts, one builder.
  assert.equal(tutorForwardTarget(brief(), QUESTION, long).carriesBody, false);
});

test('§6f-i: a lesson with no body copies the brief and says only that', () => {
  const payload = tutorClipboardPrompt(brief(), QUESTION, null);
  assert.equal(payload.carriesBody, false);
  assert.ok(!payload.text.includes('\nThe lesson\n'));
  assert.ok(!payload.text.includes('below'), 'nor a hand-over pointing at one');
});

test('§6f-i: the clipboard payload refuses the rubric exactly as the url does', () => {
  const question = {
    prompt: 'Say it back in your own words.',
    expectedPoints: ['ephemeral keys', 'nothing long lived is reused'],
  };
  const leaked = tutorClipboardPrompt(brief(), question as unknown as string, 'Body.');
  assert.ok(!leaked.text.includes('ephemeral keys'));
  assert.ok(!leaked.text.includes('The question at the end'),
    'an object where a string belongs produces no question line at all');
  const clean = tutorClipboardPrompt(brief(), question.prompt, 'Body.');
  assert.match(clean.text, /Say it back in your own words/);
  for (const leak of question.expectedPoints) assert.ok(!clean.text.includes(leak));
});

test('§6f-i: the module has no explainer paragraph left for the buttons to lean on', () => {
  /**
   * There was one, and both its sentences were true: *"An assistant has to be
   * pointed at this page before it can read any of this. These three take the
   * same words with them instead."* Read cold in the rail on 2026-08-29 it took
   * three passes and still did not say what pressing anything would do. The
   * first sentence is about a route the block does not offer, and *the same
   * words* has no antecedent on the screen.
   *
   * The affordance-first interface contract's rule is that the affordances ARE the instruction, so a
   * paragraph explaining a row of controls is the report that the controls are
   * wrong. It is deleted rather than rewritten, and this test is what stops it
   * growing back the next time somebody feels the block is bare.
   *
   * **Nothing true was lost, and that is asserted rather than asserted about.**
   * The panel's own cost is still said, on the control that has it.
   */
  const code = stripComments(read('tutor-brief.ts'));
  assert.ok(!/\bseam\b/i.test(code),
    'a seam line grew back into the module: the labels do this job now');
  assert.match(tutorRouteTitle('copy'), /No page can open your browser’s own side panel/,
    'the one thing the affordance cannot demonstrate is still said on the affordance');
  assert.ok(!/already see|reads this page|unprompted/i.test(everySentence().join(' ')),
    'the panel does not read the page on its own, and the copy may not say it does');
});

test('§6f-i: what travelled is reported, including when the lesson did not', () => {
  /**
   * **It used to say *"Sent the brief and this lesson"*.** The on-page brief was
   * deleted on 2026-08-25, so from that day the receipt reported the delivery of
   * a thing the learner had never been shown and could not go and look at. What
   * travelled is this lesson, and that is now what it says.
   */
  assert.equal(tutorForwardedLine(true), 'Opened a new tab with this lesson in it.');
  assert.match(tutorForwardedLine(false), /too long for one address/,
    'a learner about to read a chat should know what it was given');
  for (const carries of [true, false]) {
    assert.ok(!/\bbrief\b/i.test(tutorForwardedLine(carries)),
      'the receipt names a thing that is not on the screen');
  }
});

test('§6f-i: something that would not open says nothing was lost, because nothing was', () => {
  // Named for what failed: the tab and the window are two different things that
  // just went wrong, and a learner who pressed one is not told about the other.
  assert.match(tutorOpenFailedLine('tab'), /couldn’t open the tab/);
  assert.match(tutorOpenFailedLine('beside'), /couldn’t open the window/);
  for (const line of [tutorOpenFailedLine('tab'), tutorOpenFailedLine('beside'), tutorOpenFailedLine('copy')]) {
    assert.match(line, /Nothing was lost/);
    // "is above" was true when this block sat under the lesson. It is in the
    // rail now, beside it, so the recovery names the page rather than a
    // direction that would send the learner looking in the wrong place.
    assert.match(line, /still on this page/);
    assert.ok(!/\babove\b/.test(line));
    // There is nowhere else to point them: the address is thousands of
    // characters of their own lesson, and reading it out is not a recovery.
    assert.ok(!/google\.com/.test(line));
  }
});

// ------------------------------------------------------ the window beside it

test('§6f-i: the three doors are three distinct places, named once each', () => {
  const labels = [TUTOR_FORWARD_LABEL, TUTOR_BESIDE_LABEL, TUTOR_COPY_LABEL];
  assert.equal(new Set(labels).size, 3);
  assert.equal(new Set(labels.map((l) => l.toLowerCase())).size, 3);
  for (const label of labels) {
    assert.match(label, /^[A-Z]/, 'sentence case, like every other control on this screen');
    assert.ok(!label.endsWith('.'), 'a button label is not a sentence');
  }
});

test('§6f-i: the outcome line names the surface the learner actually pressed', () => {
  assert.equal(tutorForwardedLine(true, 'tab'), 'Opened a new tab with this lesson in it.');
  assert.equal(tutorForwardedLine(true, 'beside'),
    'Opened a window beside this page with this lesson in it.');
  assert.match(tutorForwardedLine(false, 'beside'),
    /^Opened a window beside this page with a summary of this lesson\. The whole thing was too long/);
  // The two controls may not report each other's outcome.
  assert.ok(!tutorForwardedLine(true, 'beside').includes('tab'));
  assert.ok(!tutorForwardedLine(true, 'tab').includes('window'));
});

test('§6f-i: the handoff window uses the accepted width and sits beside the lesson', () => {
  /**
   * `width=440,height=760` is an observation rather than a preference: that is
   * what was opened and watched answering in his own Chrome on 2026-08-25. The
   * placement is the whole feature — right-aligned inside the learner's own
   * window and level with its top, so the lesson keeps the left of the screen.
   */
  assert.equal(POPUP_WIDTH, 440);
  assert.equal(POPUP_HEIGHT, 760);
  const box = besideWindow({ left: 100, top: 60, width: 1440, height: 900 });
  assert.deepEqual(box, { width: 440, height: 760, left: 1100, top: 60 });
  // Right edge of the popup meets the right edge of the window it sits beside.
  assert.equal(box.left + box.width, 100 + 1440);
});

test('§6f-i: the placement is computed from the learner’s window, not the screen', () => {
  // A browser on half a monitor gets a chat on the same half.
  const half = besideWindow({ left: 0, top: 0, width: 720, height: 900 });
  assert.equal(half.left, 280);
  assert.equal(half.left + half.width, 720);
  // On a second monitor, negative coordinates are ordinary rather than wrong.
  assert.equal(besideWindow({ left: -1600, top: 0, width: 1600, height: 900 }).left, -440);
});

test('§6f-i: a short window gets a short popup rather than one off the bottom', () => {
  // A popup running off the bottom of the screen hides the follow-up box, which
  // is the one part of that surface the learner has to reach.
  assert.equal(besideWindow({ left: 0, top: 0, width: 1440, height: 600 }).height, 600);
  assert.equal(besideWindow({ left: 0, top: 0, width: 1440, height: 2000 }).height, POPUP_HEIGHT);
});

test('§6f-i: a window that will not say where it is still gets a placed popup', () => {
  /**
   * `chrome.windows.getCurrent` types every one of these as optional, and a
   * fullscreen or minimised window can answer with a zero, a negative or
   * nothing. The alternative to a fallback is a window at `NaN`, which Chrome
   * places somewhere nobody can predict.
   */
  for (const current of [null, undefined, {}, { width: 0, height: 0 },
    { left: Number.NaN, top: Number.NaN, width: Number.NaN, height: Number.NaN }]) {
    const box = besideWindow(current as never);
    for (const v of [box.left, box.top, box.width, box.height]) {
      assert.ok(Number.isFinite(v), `besideWindow(${JSON.stringify(current)}) produced ${v}`);
    }
    assert.equal(box.width, POPUP_WIDTH);
    assert.ok(box.height >= 320 && box.height <= POPUP_HEIGHT);
  }
});

test('§6f-i: the qa fallback asks for the same box, in the browser’s own words', () => {
  // `qa/extension.html` runs the compiled panel with a hand-built `chrome` that has no
  // `windows` on it. Browser QA should exercise this control rather than skip
  // the one thing about it that is hard to get right.
  const box = besideWindow({ left: 0, top: 0, width: 1440, height: 900 });
  const features = popupFeatures(box);
  assert.equal(features, 'popup=yes,width=440,height=760,left=1000,top=0');
  const read = Object.fromEntries(features.split(',').map((pair) => pair.split('=')));
  assert.equal(Number(read['width']), box.width);
  assert.equal(Number(read['height']), box.height);
  assert.equal(Number(read['left']), box.left);
  assert.equal(Number(read['top']), box.top);
});

// -------------------------------------------------------------- the copy laws

test('§6f-i: the module holds no hidden-text vocabulary, because nothing here is hidden', () => {
  /**
   * The visibility law, checked structurally. Hidden instructions addressed to
   * a model are a recorded product non-goal: anything Virgil would not show the
   * learner is something Virgil should not be saying to their assistant either.
   * Forwarding keeps the property by construction, since what travels is the
   * block the learner just read — but a module with no vocabulary for hiding is
   * a module that cannot quietly grow an off-screen paragraph either.
   */
  const code = stripComments(read('tutor-brief.ts'));
  for (const word of [
    'aria-hidden', 'display:none', 'display: none', 'visibility', 'sr-only',
    'visually-hidden', 'hidden', 'opacity: 0', 'clip-path', 'textIndent',
  ]) {
    assert.ok(!code.includes(word),
      `the brief names "${word}" — the block is visible learner-facing text and nothing else`);
  }
});

test('§6f-i: the copy claims no relationship the product does not have', () => {
  const said = everySentence().join(' ').toLowerCase();
  for (const banned of ['integrated', 'integration', 'synced', 'plugged in']) {
    assert.ok(!said.includes(banned), `a rendered line says "${banned}" — nothing here is that`);
  }
});

test('§6f-i: no sentence promises what the browser will do, because the browser decides', () => {
  // No page and no extension can open the browser's own assistant panel or fire
  // its shortcut, and a sentence that implied otherwise would be a promise
  // broken by the one learner who tried it.
  for (const line of everySentence()) {
    assert.ok(!/\bopens? the (side )?panel\b|\bsidebar will\b|\bpress ctrl\b/i.test(line),
      `"${line}" promises a browser surface no page can reach`);
  }
});

test('§6f-i: the forwarded prompt obeys the copy law too, since the learner reads it twice', () => {
  // Once in the address bar, once echoed back by the page it lands on. Both
  // dashes are banned in anything a learner reads, and this is read in a place
  // the panel's own lint does not look.
  const q = new URL(tutorForwardTarget(brief(), QUESTION, prose(1)).url).searchParams.get('q')!;
  for (const banned of ['—', '–']) {
    assert.ok(!q.replace(/Paragraph[\s\S]*/, '').includes(banned),
      'the forwarded brief carries a dash the house style bans');
  }
});
