import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { DEFAULT_WORK_CAP, DOCUMENT_TEXT_CHARS } from '@sb/core';
import { courseCorpus, CORPUS_AMBIGUOUS_DATE } from '../seed/course-corpus.js';
import { noLlm, startService, stubResearch } from './service-harness.js';

/**
 * THE DOOR A SEMESTER COMES THROUGH.
 *
 * `POST /course-drops` is the surface the scale lane is built around, and the
 * three properties worth asserting about it are all properties about **what it
 * does not do**: it does not spend, it does not write anything authoritative,
 * and it does not silently lose an item it could not read.
 *
 * Every test here runs on `noLlm()`. That is not a convenience — it is the
 * assertion. A model call anywhere on this path throws and takes the test with
 * it, which is a far stronger statement than counting calls afterwards: three
 * hundred documents arriving in one request must not become three hundred model
 * calls inside it, and the way to prove that is to make one impossible.
 */

const drop = (documents: number, unreadable = 0) =>
  courseCorpus({ documents, courses: 3, unreadable });

/** One syllabus, written out here rather than taken from the corpus, so the
 *  tests about a half-finished drop can send the same document twice under two
 *  different kinds and nothing else moves between the two requests. */
const SYLLABUS = [
  'Course: Classical Mechanics',
  'Provider: Northgate',
  '',
  'Assessment',
  'Lab report (30%) due 12 October 2026',
  'Final exam (50%) due 2026-11-20',
].join('\n');

test('an oversized folder planning source discloses its bound and hashes exactly what it kept', async () => {
  const h = await startService('drop-source-bound', { llm: noLlm() });
  try {
    const text = '🙂'.repeat(60_001);
    const made = await h.call('POST', '/course-drops', {
      title: 'Large outline', dropId: 'drop-large-outline', items: [{
        clientRef: 'outline', name: 'outline.md', kind: 'syllabus',
        mimeType: 'text/markdown', text,
      }],
    });
    assert.equal(made.status, 201);
    const draft = (await h.store.listIntakeDrafts())[0]!;
    assert.equal(Array.from(draft.source.text).length, 60_000);
    assert.match(draft.warnings.join(' '), /first 60,000 characters.*kept for review/i);
    assert.equal(draft.source.digest,
      `sha256:${createHash('sha256').update(draft.source.text).digest('hex')}`);
    assert.equal(made.body.items[0].draftId, draft.id);
  } finally { await h.close(); }
});

test('a whole semester lands in one request and buys nothing', async () => {
  const h = await startService('drop-semester', { llm: noLlm() });
  try {
    const items = drop(120, 6);
    assert.equal(items.length, 120, 'the fixture is the size the test says it is');

    const made = await h.call('POST', '/course-drops', {
      title: 'Autumn semester', dropId: 'drop-autumn', items,
    });
    assert.equal(made.status, 201);
    assert.equal(made.body.read, 114, 'every readable document was read');
    assert.equal(made.body.failed, 6, 'and every unreadable one was reported, not dropped');
    assert.equal(made.body.items.length, 120, 'one receipt per item, always');
    // The line the whole lane exists to be able to write down.
    assert.equal(made.body.authoritativeWrites, 0);

    // Material on the board, and nothing else.
    assert.equal((await h.store.listPins()).length, 114);
    assert.deepEqual(await h.store.listCourses(), [], 'a drop writes no course');
    assert.deepEqual(await h.store.listCommitments(), [], 'and no commitment');
    assert.deepEqual(await h.store.listTopics(), [], 'and no topic — clustering is the run’s job');
    assert.deepEqual(await h.store.listSignals(), [], 'and no signal about the learner');
  } finally { await h.close(); }
});

test('what the server cannot read is named per item, with the repair', async () => {
  const h = await startService('drop-unreadable', { llm: noLlm() });
  try {
    const made = await h.call('POST', '/course-drops', {
      title: 'A folder with PDFs in it',
      items: [
        ...drop(6, 0),
        { clientRef: 'paper', name: 'lecture-slides.pdf', kind: 'course-page', mimeType: 'application/pdf', contentBase64: 'JVBERi0xLjcK' },
        { clientRef: 'keynote', name: 'notes.pages', kind: 'other', mimeType: 'application/octet-stream', contentBase64: 'UEFHRVM=' },
      ],
    });
    assert.equal(made.status, 201, 'a folder with PDFs in it is an ordinary folder, not a bad request');

    const byRef = new Map<string, any>(made.body.items.map((i: any) => [i.clientRef, i]));
    const pdf = byRef.get('paper');
    assert.equal(pdf.ok, false);
    // `elsewhere`, not `unsupported`. The product reads PDFs every day; it reads
    // them in the extension, and telling somebody their PDF cannot be read would
    // be false about a product that is reading files exactly like it.
    assert.equal(pdf.reason, 'elsewhere');
    assert.match(pdf.detail, /extension/i);
    assert.match(pdf.detail, /drop it on Check|Send this one/i);

    const pages = byRef.get('keynote');
    assert.equal(pages.ok, false);
    assert.equal(pages.reason, 'unsupported', 'a format nothing here reads is a different fact');

    assert.equal((await h.store.listPins()).length, 6, 'neither one became an empty pin');
  } finally { await h.close(); }
});

test('malformed base64 is refused before any document in the drop is written', async () => {
  const h = await startService('drop-strict-base64', { llm: noLlm() });
  try {
    const invalidAlphabet = await h.call('POST', '/course-drops', {
      title: 'Agent handoff', dropId: 'drop-invalid-base64', items: [
        { clientRef: 'item-1', name: 'valid.txt', kind: 'learner-note', text: 'Must not land' },
        { clientRef: 'item-2', name: 'rewritten.txt', kind: 'learner-note',
          contentBase64: '!!!!SGVsbG8=' },
      ],
    });
    assert.equal(invalidAlphabet.status, 400);
    assert.match(invalidAlphabet.body.error, /contentBase64.*canonical base64/i);
    assert.deepEqual(await h.store.listPins(), [],
      'the valid earlier item was written before the malformed item was refused');

    const invalidTrailingBits = await h.call('POST', '/course-drops', {
      title: 'Agent handoff', dropId: 'drop-invalid-bits', items: [{
        clientRef: 'item-1', name: 'bits.txt', kind: 'learner-note', contentBase64: 'AB==',
      }],
    });
    assert.equal(invalidTrailingBits.status, 400);
    assert.deepEqual(await h.store.listPins(), []);

    const wrongType = await h.call('POST', '/course-drops', {
      title: 'Agent handoff', dropId: 'drop-wrong-base64-type', items: [{
        clientRef: 'item-1', name: 'number.txt', kind: 'learner-note', contentBase64: 123,
      }],
    });
    assert.equal(wrongType.status, 400);
    assert.match(wrongType.body.error, /contentBase64.*non-empty string/i);
    assert.deepEqual(await h.store.listPins(), []);

    const canonicalUnpadded = await h.call('POST', '/course-drops', {
      title: 'Agent handoff', dropId: 'drop-unpadded-base64', items: [{
        clientRef: 'item-1', name: 'hello.txt', kind: 'learner-note', contentBase64: 'SGVsbG8',
      }],
    });
    assert.equal(canonicalUnpadded.status, 201);
    const [pin] = await h.store.listPins();
    assert.equal(pin?.envelope.surroundingText, 'Hello');
  } finally { await h.close(); }
});

test('one item cannot silently choose among conflicting source representations', async () => {
  const h = await startService('drop-one-source', { llm: noLlm() });
  try {
    const ambiguous = await h.call('POST', '/course-drops', {
      title: 'Agent handoff', dropId: 'drop-ambiguous-source', items: [
        { clientRef: 'item-1', name: 'valid.txt', kind: 'learner-note', text: 'Must not land' },
        {
          clientRef: 'item-2', name: 'three-versions.txt', kind: 'learner-note',
          text: 'The text version', contentBase64: 'VGhlIGJ5dGUgdmVyc2lvbg==',
          url: 'https://example.test/the-url-version',
        },
      ],
    });
    assert.equal(ambiguous.status, 400);
    assert.match(ambiguous.body.error, /one of text, contentBase64 or url/i);
    assert.deepEqual(await h.store.listPins(), [],
      'the valid earlier item landed before the ambiguous item was refused');

    const wrongTextType = await h.call('POST', '/course-drops', {
      title: 'Agent handoff', dropId: 'drop-wrong-text-type', items: [{
        clientRef: 'item-1', name: 'number.txt', kind: 'learner-note', text: 123,
      }],
    });
    assert.equal(wrongTextType.status, 400);
    assert.match(wrongTextType.body.error, /text.*non-empty string/i);
    assert.deepEqual(await h.store.listPins(), []);

    const invalidUrl = await h.call('POST', '/course-drops', {
      title: 'Agent handoff', dropId: 'drop-invalid-url', items: [{
        clientRef: 'item-1', name: 'unsafe.html', kind: 'course-page',
        url: 'javascript:alert(1)',
      }],
    });
    assert.equal(invalidUrl.status, 400);
    assert.match(invalidUrl.body.error, /url.*http.*https/i);
    assert.deepEqual(await h.store.listPins(), []);

    const empty = await h.call('POST', '/course-drops', {
      title: 'Agent handoff', dropId: 'drop-no-readable-source', items: [{
        clientRef: 'item-1', name: 'empty.txt', kind: 'learner-note', text: null,
      }],
    });
    assert.equal(empty.status, 201, 'no readable representation is an item receipt, not a malformed folder');
    assert.equal(empty.body.failed, 1);
    assert.equal(empty.body.items[0].reason, 'no-text');
  } finally { await h.close(); }
});

test('the syllabus becomes a plan draft and the lecture notes do not', async () => {
  const h = await startService('drop-planning', { llm: noLlm() });
  try {
    const made = await h.call('POST', '/course-drops', {
      title: 'Autumn semester', items: drop(30, 0),
    });
    assert.equal(made.status, 201);

    const drafts = await h.store.listIntakeDrafts();
    assert.ok(drafts.length >= 3, 'the three syllabi each became a draft');
    assert.ok(drafts.length < 30,
      'a lecture handout is material, not a plan — a draft per document would be the review queue as a denial of service');

    const psy = drafts.find((d) => d.title.includes('Cognitive Psychology'));
    assert.ok(psy, 'the syllabus’ own `Course:` field named the draft');
    assert.ok(psy.objectives.length >= 3, 'the learning objectives section was read');
    assert.ok(psy.commitments.length >= 3, 'and the assessment table');

    // The deadlines, read from the three shapes that are unambiguous.
    const dated = psy.commitments.filter((c) => c.dueAt !== null);
    assert.ok(dated.length >= 3, `three date shapes in, ${dated.length} dates out`);
    for (const c of dated) {
      assert.ok(!Number.isNaN(Date.parse(c.dueAt as string)));
      assert.ok(c.source.quote.length > 0, 'every proposal quotes the line it came from');
    }

    /**
     * And the one that must NOT be read.
     *
     * `07/09/2026` is 7 September in Britain and 9 July in America. The whole
     * intake boundary rests on a model never being allowed to resolve that by
     * sounding confident, so it arrives as a blocking question and the draft
     * cannot be applied until a person answers it.
     */
    const undatedQuestion = psy.questions.find((q) => q.source?.quote.includes(CORPUS_AMBIGUOUS_DATE));
    assert.ok(undatedQuestion, 'the ambiguous date produced no question');
    assert.equal(undatedQuestion.blocking, true);
    assert.match(undatedQuestion.prompt, /What date does/);

    const applied = await h.call('POST', `/course-intakes/${psy.id}/apply`);
    assert.equal(applied.status, 409, 'an unanswered blocking question blocks apply');
    assert.deepEqual(await h.store.listCourses(), []);
  } finally { await h.close(); }
});

test('a nested source path survives the service as visible board provenance', async () => {
  const h = await startService('drop-nested-path', { llm: noLlm() });
  try {
    const made = await h.call('POST', '/course-drops', {
      title: 'Autumn', dropId: 'drop-autumn', items: [{
        clientRef: '1-Autumn/week-09/notes.md',
        name: 'week-09/notes.md', kind: 'learner-note', text: 'Later notes',
      }],
    });
    assert.equal(made.status, 201);
    assert.equal(made.body.items[0]?.name, 'week-09/notes.md');
    const [pin] = await h.store.listPins();
    assert.equal(pin?.envelope.pageTitle, 'week-09/notes.md');
    assert.deepEqual(pin?.envelope.headingPath, ['Autumn']);
  } finally { await h.close(); }
});

test('long nested paths keep a distinct readable tail without broken Unicode', async () => {
  const h = await startService('drop-long-nested-paths', { llm: noLlm() });
  try {
    // The old 200-code-unit prefix slice both collapsed these names and split
    // the compass surrogate pair at its exact boundary.
    const shared = `${'a'.repeat(199)}🧭/${'archive/'.repeat(24)}`;
    const sameHead = 'shared-course-tree/'.repeat(4);
    const sameTail = `${'common-tail/'.repeat(24)}notes.md`;
    const names = [
      `${shared}week-01/notes.md`,
      `${shared}week-09/notes.md`,
      `${sameHead}week-01/${sameTail}`,
      `${sameHead}week-09/${sameTail}`,
    ];
    const made = await h.call('POST', '/course-drops', {
      title: 'Autumn', dropId: 'drop-long-paths', items: names.map((name, index) => ({
        clientRef: `item-${index + 1}`, name, kind: 'learner-note', text: `Notes ${index + 1}`,
      })),
    });
    assert.equal(made.status, 201);

    const receiptNames = made.body.items.map((item: any) => item.name);
    assert.equal(new Set(receiptNames).size, 4, 'two long paths became one visible source name');
    assert.match(receiptNames[0], /week-01\/notes\.md$/);
    assert.match(receiptNames[1], /week-09\/notes\.md$/);
    assert.notEqual(receiptNames[2], receiptNames[3],
      'paths differing only outside the retained head and tail need a disambiguator');
    assert.ok(receiptNames.every((name: string) => Array.from(name).length <= 200));
    const hasUnpairedSurrogate = (name: string): boolean => Array.from(name).some((char) =>
      char.length === 1 && char.charCodeAt(0) >= 0xD800 && char.charCodeAt(0) <= 0xDFFF);
    assert.ok(receiptNames.every((name: string) => !hasUnpairedSurrogate(name)),
      'display shortening left an unpaired UTF-16 surrogate');

    const pinNames = (await h.store.listPins()).map((pin) => pin.envelope.pageTitle).sort();
    assert.deepEqual(pinNames, [...receiptNames].sort(),
      'the receipt and stored board provenance described different sources');
  } finally { await h.close(); }
});

test('the same drop sent twice is the same board', async () => {
  /**
   * The retry that actually happens. A three-hundred-item request over a slow
   * link is the most retryable thing in the product, and a repeat that made a
   * second copy of a semester would be the worst duplicate in it.
   */
  const h = await startService('drop-retry', { llm: noLlm() });
  try {
    const items = drop(24, 2);
    const body = { title: 'Autumn semester', dropId: 'drop-autumn', items };
    const first = await h.call('POST', '/course-drops', body);
    const pinsAfterFirst = (await h.store.listPins()).map((p) => p.id).sort();
    const draftsAfterFirst = (await h.store.listIntakeDrafts()).length;

    const second = await h.call('POST', '/course-drops', body);
    assert.equal(second.status, 201);
    assert.equal(second.body.read, first.body.read, 'the retry read the same documents');
    assert.equal(second.body.repeated, first.body.read, 'and recognised every one of them');

    assert.deepEqual((await h.store.listPins()).map((p) => p.id).sort(), pinsAfterFirst,
      'not one pin was made twice');
    assert.equal((await h.store.listIntakeDrafts()).length, draftsAfterFirst,
      'and not one draft');
  } finally { await h.close(); }
});

test('two simultaneous deliveries upsert the same material and proposal ids', async () => {
  const h = await startService('drop-simultaneous', { llm: noLlm() });
  try {
    const body = {
      title: 'Autumn', dropId: 'drop-autumn', items: [{
        clientRef: 'week-01', name: 'week-01/syllabus.md', kind: 'syllabus', text: SYLLABUS,
      }],
    };
    const [left, right] = await Promise.all([
      h.call('POST', '/course-drops', body), h.call('POST', '/course-drops', body),
    ]);
    assert.equal(left.status, 201);
    assert.equal(right.status, 201);
    assert.equal(left.body.items[0]?.pinId, right.body.items[0]?.pinId);
    assert.equal(left.body.items[0]?.draftId, right.body.items[0]?.draftId);
    assert.equal((await h.store.listPins()).length, 1);
    assert.equal((await h.store.listIntakeDrafts()).length, 1);
  } finally { await h.close(); }
});

test('a drop interrupted between the pin and the plan finishes the job when it is sent again', async () => {
  const h = await startService('drop-resumed', { llm: noLlm() });
  try {
    const item = (kind: string) => ({
      clientRef: 'syllabus.txt', name: 'syllabus.txt', kind, text: SYLLABUS,
    });
    const interrupted = await h.call('POST', '/course-drops', {
      title: 'Autumn semester', dropId: 'drop-autumn', items: [item('other')],
    });
    assert.equal(interrupted.status, 201);
    assert.equal((await h.store.listPins()).length, 1, 'the pin landed');
    assert.deepEqual(await h.store.listIntakeDrafts(), [], 'and the plan did not — this is the torn state');
    const pinsAfterFirst = (await h.store.listPins()).map((p) => p.id).sort();

    const resumed = await h.call('POST', '/course-drops', {
      title: 'Autumn semester', dropId: 'drop-autumn', items: [item('syllabus')],
    });
    assert.equal(resumed.status, 201);
    assert.equal(resumed.body.repeated, 1, 'the pin was recognised as already there');
    assert.equal(resumed.body.planned, 1, 'and the plan the interrupted attempt never wrote was written now');
    assert.equal(resumed.body.authoritativeWrites, 0, 'a resumed drop is still a proposal and never a course');

    assert.deepEqual((await h.store.listPins()).map((p) => p.id).sort(), pinsAfterFirst,
      'not one pin was made twice on the way to fixing the plan');
    const drafts = await h.store.listIntakeDrafts();
    assert.equal(drafts.length, 1, 'the board converged on the state a complete drop would have reached');
    assert.ok(drafts[0]?.commitments.length, 'and it is a real proposal — the assessment table was read');

    // And the receipt points at it, rather than reporting `null` for a draft
    // that now exists — the sentence that made this invisible.
    const [row] = resumed.body.items;
    assert.equal(row.repeated, true);
    assert.equal(row.draftId, drafts[0]?.id);
    assert.match(row.detail, /did not get as far as the plan/);
  } finally { await h.close(); }
});

test('a torn drop identity cannot resume with different source material', async () => {
  const h = await startService('drop-resume-content-collision', { llm: noLlm() });
  try {
    const item = (kind: string, text: string) => ({
      clientRef: 'syllabus.txt', name: 'syllabus.txt', kind, text,
    });
    const first = await h.call('POST', '/course-drops', {
      title: 'Autumn semester', dropId: 'drop-autumn',
      items: [item('other', 'The original saved material.')],
    });
    assert.equal(first.status, 201);
    assert.equal((await h.store.listIntakeDrafts()).length, 0);

    const retried = await h.call('POST', '/course-drops', {
      title: 'Autumn semester', dropId: 'drop-autumn',
      items: [item('syllabus', `${SYLLABUS}\nChanged on retry.`)],
    });
    assert.equal(retried.status, 409);
    assert.match(retried.body.error, /exact retry/i);
    assert.equal((await h.store.listIntakeDrafts()).length, 0,
      'different source text was allowed to fill the old pin\'s missing plan');
    assert.equal((await h.store.listPins())[0]?.envelope.surroundingText,
      'The original saved material.');
  } finally { await h.close(); }
});

test('identical planning files across request chunks keep distinct drafts after a torn write', async () => {
  const h = await startService('drop-chunked-identical-resume', { llm: noLlm() });
  try {
    const item = (clientRef: string, kind: string) => ({
      clientRef, name: `${clientRef}.md`, kind, text: SYLLABUS,
    });
    await h.call('POST', '/course-drops', {
      title: 'Autumn', dropId: 'drop-autumn', items: [item('week-01', 'other')],
    });
    const second = await h.call('POST', '/course-drops', {
      title: 'Autumn', dropId: 'drop-autumn', items: [item('week-09', 'syllabus')],
    });
    const first = await h.call('POST', '/course-drops', {
      title: 'Autumn', dropId: 'drop-autumn', items: [item('week-01', 'syllabus')],
    });
    const repeated = await h.call('POST', '/course-drops', {
      title: 'Autumn', dropId: 'drop-autumn', items: [item('week-09', 'syllabus')],
    });

    assert.equal(first.body.planned, 1);
    assert.equal(repeated.body.planned, 0);
    assert.notEqual(first.body.items[0]?.draftId, second.body.items[0]?.draftId);
    assert.equal(repeated.body.items[0]?.draftId, second.body.items[0]?.draftId);
    assert.equal((await h.store.listPins()).length, 2);
    assert.equal((await h.store.listIntakeDrafts()).length, 2,
      'two identical files across chunks collapsed into one proposal');
  } finally { await h.close(); }
});

test('a pre-stable-id proposal is reused instead of duplicated during migration', async () => {
  const h = await startService('drop-legacy-draft-migration', { llm: noLlm() });
  try {
    await h.call('POST', '/course-drops', {
      title: 'Autumn', dropId: 'drop-autumn', items: [{
        clientRef: 'week-01', name: 'week-01/syllabus.md', kind: 'other', text: SYLLABUS,
      }],
    });
    const legacy = await h.call('POST', '/course-intakes', {
      kind: 'syllabus', title: 'Legacy proposal', text: SYLLABUS,
    });
    const resumed = await h.call('POST', '/course-drops', {
      title: 'Autumn', dropId: 'drop-autumn', items: [{
        clientRef: 'week-01', name: 'week-01/syllabus.md', kind: 'syllabus', text: SYLLABUS,
      }],
    });
    assert.equal(resumed.body.items[0]?.draftId, legacy.body.draft.id);
    assert.equal(resumed.body.planned, 0);
    assert.equal((await h.store.listIntakeDrafts()).length, 1);
  } finally { await h.close(); }
});

test('a replay whose plans are all present writes nothing and buys nothing', async () => {
  // The mutation check on the test above. A drop that re-made every draft on
  // every retry would pass it, and would double the review queue every time
  // somebody's connection dropped.
  const h = await startService('drop-resumed-noop', { llm: noLlm() });
  try {
    const body = { title: 'Autumn semester', dropId: 'drop-autumn', items: drop(9, 0) };
    const first = await h.call('POST', '/course-drops', body);
    const drafts = (await h.store.listIntakeDrafts()).map((d) => d.id).sort();
    assert.ok(drafts.length >= 3, 'the fixture has syllabi in it, or this test proves nothing');
    assert.equal(first.body.planned, drafts.length);

    const second = await h.call('POST', '/course-drops', body);
    assert.equal(second.body.planned, 0, 'nothing was owed, so nothing was planned');
    assert.deepEqual((await h.store.listIntakeDrafts()).map((d) => d.id).sort(), drafts,
      'the same drafts, with the same ids');
    // The receipt still points at the plan that exists, which is what a client
    // resuming a drop needs in order to find it.
    const pointed = second.body.items.filter((i: any) => i.draftId);
    assert.equal(pointed.length, drafts.length);
  } finally { await h.close(); }
});

test('two drops whose ids would run into each other cannot be sent at all', async () => {
  /**
   * The pin key is `<dropId>:<clientRef>` and the replay scan finds a drop's
   * own pins by that prefix, so with both halves free-form the join was
   * ambiguous: drop `cs101` with an item called `week1:notes` writes exactly
   * the key drop `cs101:week1` writes for an item called `notes`. The second
   * drop would find the first one's pin, report every item as `repeated`, and
   * import nothing while answering 201 — a whole course lost behind a success.
   *
   * A colon in the id is refused, so the first colon is always the separator
   * and the two halves cannot be confused. The item side stays free-form: a
   * `clientRef` is usually a file path and paths do carry colons.
   */
  const h = await startService('drop-prefix-collision', { llm: noLlm() });
  try {
    const refused = await h.call('POST', '/course-drops', {
      title: 'Autumn', dropId: 'cs101:week1',
      items: [{ clientRef: 'notes', name: 'notes.txt', kind: 'other', text: 'lecture notes' }],
    });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /dropId must not contain/);
    assert.deepEqual(await h.store.listPins(), [], 'and nothing was written on the way to the refusal');

    const outer = await h.call('POST', '/course-drops', {
      title: 'Autumn', dropId: 'cs101',
      items: [{ clientRef: 'week1:notes', name: 'notes.txt', kind: 'other', text: 'lecture notes' }],
    });
    assert.equal(outer.status, 201);
    assert.equal(outer.body.repeated, 0);

    const inner = await h.call('POST', '/course-drops', {
      title: 'Autumn', dropId: 'cs101-week1',
      items: [{ clientRef: 'notes', name: 'notes.txt', kind: 'other', text: 'lecture notes' }],
    });
    assert.equal(inner.status, 201);
    assert.equal(inner.body.repeated, 0,
      'a different drop is a different drop — its item was imported, not mistaken for another one');
    assert.equal((await h.store.listPins()).length, 2, 'both documents are on the board');
  } finally { await h.close(); }
});

test('the id this endpoint mints is one it will accept back', async () => {
  // The rule above is only honest if the default obeys it: a client that
  // retries with the `dropId` it was handed must not be refused for it.
  const h = await startService('drop-minted-id', { llm: noLlm() });
  try {
    const items = [{ clientRef: 'a', name: 'one.txt', kind: 'other', text: 'first' }];
    const first = await h.call('POST', '/course-drops', { title: 'Autumn', items });
    assert.ok(!String(first.body.dropId).includes(':'), 'the minted id carries no separator');

    const retry = await h.call('POST', '/course-drops', { title: 'Autumn', dropId: first.body.dropId, items });
    assert.equal(retry.status, 201);
    assert.equal(retry.body.repeated, 1, 'and it found the pins it made the first time');
    assert.equal((await h.store.listPins()).length, 1);
  } finally { await h.close(); }
});

test('course-drop identity is accepted exactly or refused before any write', async () => {
  /**
   * IDENTITY CANNOT BE A DISPLAY FIELD.
   *
   * These two pairs differ only after the old `.slice()` boundary. Sending
   * them in separate requests bypassed the within-request duplicate check:
   * request two found request one's truncated key, answered `repeated: 1`, and
   * silently lost different material. A retry key may be bounded, but it may
   * never be rewritten into somebody else's key.
   */
  const h = await startService('drop-identity-bounds', { llm: noLlm() });
  try {
    const dropPrefix = 'd'.repeat(120);
    const first = await h.call('POST', '/course-drops', {
      title: 'First', dropId: dropPrefix,
      items: [{ clientRef: 'notes', name: 'first.txt', kind: 'other', text: 'first source' }],
    });
    assert.equal(first.status, 201);

    const longDrop = await h.call('POST', '/course-drops', {
      title: 'Second', dropId: `${dropPrefix}x`,
      items: [{ clientRef: 'notes', name: 'second.txt', kind: 'other', text: 'second source' }],
    });
    assert.equal(longDrop.status, 400);
    assert.match(longDrop.body.error, /dropId must contain at most 120/);
    assert.equal((await h.store.listPins()).length, 1,
      'an overlong drop id was truncated into an existing drop and lost its source');

    const refPrefix = 'r'.repeat(180);
    const legalRef = await h.call('POST', '/course-drops', {
      title: 'References', dropId: 'drop-refs',
      items: [{ clientRef: refPrefix, name: 'first-ref.txt', kind: 'other', text: 'first ref' }],
    });
    assert.equal(legalRef.status, 201);

    const longRef = await h.call('POST', '/course-drops', {
      title: 'References', dropId: 'drop-refs',
      items: [{ clientRef: `${refPrefix}x`, name: 'second-ref.txt', kind: 'other', text: 'second ref' }],
    });
    assert.equal(longRef.status, 400);
    assert.match(longRef.body.error, /clientRef must contain at most 180/);
    assert.equal((await h.store.listPins()).length, 2,
      'an overlong item reference was truncated into an existing item and lost its source');
  } finally { await h.close(); }
});

test('invisible controls cannot be removed from caller-supplied identity', async () => {
  const h = await startService('drop-identity-controls', { llm: noLlm() });
  try {
    const hiddenDrop = await h.call('POST', '/course-drops', {
      title: 'Hidden', dropId: 'drop-\u200Bsame',
      items: [{ clientRef: 'notes', name: 'notes.txt', kind: 'other', text: 'notes' }],
    });
    assert.equal(hiddenDrop.status, 400);
    assert.match(hiddenDrop.body.error, /dropId must not contain invisible control characters/);

    const hiddenRef = await h.call('POST', '/course-drops', {
      title: 'Hidden', dropId: 'drop-visible',
      items: [{ clientRef: 'week-\u200B01', name: 'notes.txt', kind: 'other', text: 'notes' }],
    });
    assert.equal(hiddenRef.status, 400);
    assert.match(hiddenRef.body.error, /clientRef must not contain invisible control characters/);
    assert.deepEqual(await h.store.listPins(), [], 'an invalid identity wrote material before refusal');
  } finally { await h.close(); }
});

test('the drop says how many nights it will take, from the cap that will apply', async () => {
  const h = await startService('drop-nights', { llm: noLlm() }, { workCap: 25 });
  try {
    const made = await h.call('POST', '/course-drops', { title: 'Autumn', items: drop(120, 0) });
    assert.equal(made.body.queue.perRun, 25);
    assert.equal(made.body.queue.pins, 120, 'every readable document is owed enrichment');
    assert.equal(made.body.queue.nights, Math.ceil(120 / 25));
    // Arithmetic over the cap that will really be applied, rather than a
    // constant restated here — a promise about pacing that came from a
    // different number than the run uses would be worse than no promise.
    assert.equal(made.body.queue.nights, 5);
  } finally { await h.close(); }
});

test('the default cap is invisible to a board nobody dropped a course on', async () => {
  // The property that chose the number. A learner with a normal board must never
  // meet the pacing at all, or every ordinary night was made worse to protect a
  // case that had not happened.
  const h = await startService('drop-default-cap', { llm: noLlm() });
  try {
    const made = await h.call('POST', '/course-drops', { title: 'Small', items: drop(9, 0) });
    assert.equal(made.body.queue.perRun, DEFAULT_WORK_CAP);
    assert.equal(made.body.queue.nights, 1, 'nine documents is one night, and always was');
  } finally { await h.close(); }
});

test('a malformed item refuses the whole drop before anything is written', async () => {
  const h = await startService('drop-malformed', { llm: noLlm() });
  try {
    const items: any[] = [...drop(6, 0)];
    items.push({ clientRef: 'broken', name: 'x.txt', kind: 'not-a-kind', text: 'hello' });
    const made = await h.call('POST', '/course-drops', { title: 'Autumn', items });
    assert.equal(made.status, 400);
    assert.match(made.body.error, /items\.6/, 'the refusal names the item');
    assert.deepEqual(await h.store.listPins(), [],
      'a malformed seventh item must not leave six half-imported documents behind it');
  } finally { await h.close(); }
});

test('two items claiming the same name are refused rather than merged', async () => {
  const h = await startService('drop-dupe-ref', { llm: noLlm() });
  try {
    const made = await h.call('POST', '/course-drops', {
      title: 'Autumn',
      items: [
        { clientRef: 'a', name: 'one.txt', kind: 'other', text: 'first' },
        { clientRef: 'a', name: 'two.txt', kind: 'other', text: 'second' },
      ],
    });
    assert.equal(made.status, 400);
    assert.match(made.body.error, /unique clientRef/);
  } finally { await h.close(); }
});

test('an html page keeps its lines, because the deadline reader works on lines', async () => {
  /**
   * The failure this is here to prevent is a silent one. `LocalResearch`'s own
   * html-to-text collapses every run of whitespace, which is right for a Forager
   * that slices a window of prose and catastrophic for `buildDeterministicIntake`,
   * which finds an assessment table by reading lines. Flattened, the extraction
   * succeeds perfectly and finds nothing.
   */
  const h = await startService('drop-html', { llm: noLlm() });
  try {
    const html = [
      '<html><head><title>PHY100 outline</title></head><body>',
      '<h1>Course: Classical Mechanics</h1>',
      '<h2>Assessment</h2>',
      '<table><tr><td>Lab report (30%) due 12 October 2026</td></tr>',
      '<tr><td>Final exam (50%) due 2026-11-20</td></tr></table>',
      '<script>var deadline = "never";</script>',
      '</body></html>',
    ].join('');
    const made = await h.call('POST', '/course-drops', {
      title: 'Physics', items: [{ clientRef: 'p', name: 'outline.html', kind: 'syllabus', mimeType: 'text/html', text: html }],
    });
    assert.equal(made.status, 201);
    assert.equal(made.body.read, 1);

    const draft = (await h.store.listIntakeDrafts())[0];
    assert.ok(draft);
    assert.equal(draft.title, 'Classical Mechanics', 'the `Course:` field survived the tags');
    const dates = draft.commitments.map((c) => c.dueAt).filter(Boolean);
    assert.equal(dates.length, 2, 'both table rows were separate lines, so both dates were read');
    assert.ok(!JSON.stringify(draft).includes('var deadline'),
      'the script body is code and never reaches the extractor');
  } finally { await h.close(); }
});

test('a url item is fetched through the Research port and says so honestly', async () => {
  const h = await startService('drop-url', {
    llm: noLlm(),
    research: {
      ...stubResearch,
      fetchPage: async (url: string) => ({ text: `the page at ${url} about tides`, title: 'Tides' }),
    },
  });
  try {
    const made = await h.call('POST', '/course-drops', {
      title: 'Links',
      items: [{ clientRef: 'u', name: 'page.html', kind: 'other', url: 'https://example.test/tides' }],
    });
    assert.equal(made.status, 201);
    assert.equal(made.body.read, 1);
    const pin = (await h.store.listPins())[0];
    assert.match(pin?.envelope.surroundingText ?? '', /about tides/);
    assert.equal(pin?.envelope.url, 'https://example.test/tides');
    assert.match(made.body.items[0].detail, /fetched as flattened page text/i);
  } finally { await h.close(); }
});

test('a fetched syllabus keeps page blocks so every separate deadline reaches review', async () => {
  const h = await startService('drop-url-structured', {
    llm: noLlm(),
    research: {
      ...stubResearch,
      fetchPage: async () => ({
        text: SYLLABUS.replace(/\n+/g, ' '),
        structuredText: SYLLABUS,
        title: 'Classical Mechanics',
      }),
    },
  });
  try {
    const made = await h.call('POST', '/course-drops', {
      title: 'Physics',
      items: [{
        clientRef: 'outline', name: 'outline.html', kind: 'syllabus',
        url: 'https://example.test/mechanics',
      }],
    });
    assert.equal(made.status, 201);
    assert.match(made.body.items[0].detail, /page blocks kept as lines/i);
    const draft = (await h.store.listIntakeDrafts())[0]!;
    assert.equal(draft.commitments.filter((c) => c.dueAt !== null).length, 2,
      'the compact sibling is one line; only the structured representation can preserve both dates');
    assert.doesNotMatch(draft.warnings.join(' '), /flattened page text/i);
  } finally { await h.close(); }
});

test('a provider with only flattened page text leaves a receipt and proposal warning', async () => {
  const h = await startService('drop-url-flat-warning', {
    llm: noLlm(),
    research: {
      ...stubResearch,
      fetchPage: async () => ({ text: SYLLABUS.replace(/\n+/g, ' '), title: 'Classical Mechanics' }),
    },
  });
  try {
    const body = {
      title: 'Physics', dropId: 'drop-flat-warning',
      items: [{
        clientRef: 'outline', name: 'outline.html', kind: 'syllabus',
        url: 'https://example.test/mechanics',
      }],
    };
    const made = await h.call('POST', '/course-drops', body);
    assert.equal(made.status, 201);
    assert.match(made.body.items[0].detail,
      /flattened page text; check table rows, headings and dates against the original/i);
    const draft = (await h.store.listIntakeDrafts())[0]!;
    assert.match(draft.warnings.join(' '),
      /flattened page text.*check table rows, headings and dates against the original page/i);

    const retried = await h.call('POST', '/course-drops', body);
    assert.equal(retried.body.items[0].repeated, true);
    assert.match(retried.body.items[0].detail,
      /already on the board.*flattened page text.*check table rows/i,
      'a retry must not erase the limitation from the source receipt');
  } finally { await h.close(); }
});

test('a fetched URL uses the same Unicode-safe text cap and reports the shortened source', async () => {
  const exact = '😀'.repeat(DOCUMENT_TEXT_CHARS);
  const h = await startService('drop-url-cap', {
    llm: noLlm(),
    research: {
      ...stubResearch,
      fetchPage: async () => ({ text: `${exact}🧠`, title: 'Long page' }),
    },
  });
  try {
    const made = await h.call('POST', '/course-drops', {
      title: 'Links',
      items: [{ clientRef: 'long', name: 'long.html', kind: 'other', url: 'https://example.test/long' }],
    });
    assert.equal(made.status, 201);
    assert.equal(made.body.items[0].truncated, true);
    assert.match(made.body.items[0].detail, /cut at 200,000 characters/);
    const pin = (await h.store.listPins())[0];
    assert.equal(Array.from(pin?.envelope.surroundingText ?? '').length, DOCUMENT_TEXT_CHARS);
    assert.equal(pin?.envelope.surroundingText, exact);

    const retried = await h.call('POST', '/course-drops', {
      title: 'Links', dropId: made.body.dropId,
      items: [{ clientRef: 'long', name: 'long.html', kind: 'other', url: 'https://example.test/long' }],
    });
    assert.equal(retried.body.items[0].repeated, true);
    assert.equal(retried.body.items[0].truncated, true);
    assert.match(retried.body.items[0].detail, /already on the board.*cut at 200,000 characters/);
  } finally { await h.close(); }
});

test('a url the port cannot fetch is a named failure, not an empty pin', async () => {
  const h = await startService('drop-url-dead', { llm: noLlm() });
  try {
    // `stubResearch.fetchPage` answers null, which is what the real adapter does
    // for a gated or dead page.
    const made = await h.call('POST', '/course-drops', {
      title: 'Links',
      items: [{ clientRef: 'u', name: 'page.html', kind: 'other', url: 'https://example.test/gone' }],
    });
    assert.equal(made.body.read, 0);
    assert.equal(made.body.failed, 1);
    assert.equal(made.body.items[0].reason, 'unreadable');
    assert.deepEqual(await h.store.listPins(), []);
  } finally { await h.close(); }
});

test('the formats the server can read are published before anybody uploads 80MB', async () => {
  const h = await startService('drop-formats', { llm: noLlm() });
  try {
    const formats = await h.call('GET', '/course-drops/formats');
    assert.equal(formats.status, 200);
    assert.equal(formats.body.maxItems, 300);
    assert.equal(formats.body.caps.textChars, DOCUMENT_TEXT_CHARS);
    assert.deepEqual(formats.body.identity, {
      exact: true, dropIdMaxChars: 120, clientRefMaxChars: 180,
      dropIdMayContainColon: false, invisibleControls: false,
    });
    assert.deepEqual(formats.body.contentBase64, {
      alphabet: 'RFC 4648 standard', canonical: true,
      padding: 'optional', whitespace: false,
    });
    assert.deepEqual(formats.body.source, {
      modes: ['text', 'contentBase64', 'url'], maxModesPerItem: 1,
      nullMeansAbsent: true, missing: 'per-item no-text receipt',
      text: 'non-empty string', urlProtocols: ['http', 'https'],
    });
    const where = new Map(formats.body.formats.map((f: any) => [f.format, f.where]));
    assert.deepEqual([...where.entries()].sort(), [
      ['docx', 'server'], ['html', 'server'], ['pdf', 'extension'], ['text', 'server'],
    ]);
    assert.ok(formats.body.caps.documentBytes > formats.body.caps.textBytes);
  } finally { await h.close(); }
});
