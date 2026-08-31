/**
 * A SEMESTER THAT DOES NOT EXIST, SO THE ONE THAT DOES CAN BE PROVEN AGAINST IT.
 *
 * The QA board this product has been walked on is three pins. Every claim the
 * scale lane makes — that a course drop is worked through over several nights,
 * that a resumed run never re-enriches, that topics do not fork as documents
 * keep arriving — is a claim about a hundred and twenty documents, and nobody is
 * going to hand-write a hundred and twenty documents.
 *
 * So this builds them, and the word doing the work is **realistic**. A corpus of
 * `lorem ipsum` would prove the plumbing and nothing else: the deadline
 * extractor is a line-based reader of the shapes a syllabus actually uses, so a
 * fixture with no assessment table, no `Week 4:` headings and no
 * `due 9 September 2026` proves that a parser which found nothing did not crash.
 * What is generated here therefore carries:
 *
 *  - **one syllabus per course**, with a `Course:` field, a `Learning objectives`
 *    section, an `Assessment` table with weightings, and dated obligations in
 *    all three shapes `unambiguousDate` accepts, plus one deliberately ambiguous
 *    `07/09/2026` that has to become a question rather than a date;
 *  - **lecture notes** under `Week N` headings, with the vocabulary of the
 *    subject repeated inside a course and not across them, so a partition can
 *    actually separate two courses and keep one course together;
 *  - **readings and problem sets**, which are material and are not plans, so the
 *    drop's kind split is exercised rather than assumed;
 *  - **the unreadable ones.** A real folder has PDFs in it and a scanned
 *    handbook with no text layer, and a corpus without them would test the happy
 *    path of an endpoint whose whole promise is about the unhappy one.
 *
 * Deterministic to the character. No clock, no randomness, no id generator: the
 * same call returns the same corpus, because every scale claim below it is a
 * comparison between two runs and a fixture that moved would make all of them
 * unfalsifiable. Seeded arithmetic where variety is needed, in the shape
 * `batch-harness.ts` already uses.
 */

export type CorpusKind =
  | 'syllabus' | 'rubric' | 'assignment-brief' | 'course-page'
  | 'learner-note' | 'image' | 'other';

/** One document, in the shape `POST /course-drops` takes an item in. */
export interface CorpusDocument {
  readonly clientRef: string;
  readonly name: string;
  readonly kind: CorpusKind;
  readonly mimeType: string;
  /** Present for everything the server can read. */
  readonly text?: string;
  /** Present instead for the ones it cannot, so the failure path is real. */
  readonly contentBase64?: string;
}

export interface CorpusOptions {
  /** How many documents in total, syllabi and unreadables included. */
  readonly documents: number;
  /** How many distinct courses the semester is made of. */
  readonly courses?: number;
  /** How many of the documents are deliberately unreadable by the server. */
  readonly unreadable?: number;
}

/**
 * The subjects, and why there are exactly these.
 *
 * Each one carries its own vocabulary, and the vocabularies do not overlap. That
 * is the property the topic-stability proof rests on: two documents from
 * *Cognitive Psychology* have to look more like each other than either looks
 * like one from *Fluid Mechanics*, or a partition passing the test would be
 * passing it by luck. Three is enough for a prerequisite ordering to say
 * something (`SURVEY_FLOOR`) and small enough that the fixture stays readable.
 */
const SUBJECTS = [
  {
    code: 'PSY201',
    title: 'Cognitive Psychology',
    provider: 'Northgate University',
    vocabulary: [
      'working memory', 'the phonological loop', 'chunking', 'recall under load',
      'attentional blink', 'the central executive', 'encoding specificity',
      'retrieval cues', 'the serial position effect', 'proactive interference',
    ],
    objectives: [
      'Explain the components of working memory and what each one is evidence for',
      'Distinguish encoding failures from retrieval failures using experimental evidence',
      'Design a recall experiment that controls for the serial position effect',
    ],
  },
  {
    code: 'MEC340',
    title: 'Fluid Mechanics',
    provider: 'Northgate University',
    vocabulary: [
      'the Reynolds number', 'laminar flow', 'boundary layer separation',
      'the continuity equation', 'viscous drag', 'pressure gradients',
      'the Navier-Stokes momentum balance', 'turbulent transition',
      'head loss in pipe flow', 'dimensional analysis',
    ],
    objectives: [
      'Predict whether a flow is laminar or turbulent from its Reynolds number',
      'Apply the continuity and momentum equations to a control volume',
      'Estimate head loss in a pipe network and say where the estimate breaks down',
    ],
  },
  {
    code: 'HIS118',
    title: 'Industrial Revolution Britain',
    provider: 'Northgate University',
    vocabulary: [
      'enclosure and land tenure', 'the factory system', 'proto-industrial households',
      'canal freight', 'the Corn Laws', 'child labour legislation',
      'urban mortality rates', 'the Luddite risings', 'poor law reform',
      'the cotton famine',
    ],
    objectives: [
      'Weigh demographic and technological explanations for early industrialisation',
      'Read a nineteenth-century parliamentary source against its own purpose',
      'Account for regional variation in the pace of industrial change',
    ],
  },
] as const;

/** The three date shapes `unambiguousDate` accepts, one per assessment. */
const DATE_SHAPES = [
  (d: number, m: string, y: number) => `${d} ${m} ${y}`,
  (d: number, m: string, y: number) => `${m} ${d}, ${y}`,
  (d: number, _m: string, y: number, iso?: string) => iso ?? `${y}-09-${String(d).padStart(2, '0')}`,
] as const;

/**
 * The one date the extractor must refuse.
 *
 * `07/09/2026` is 7 September in Britain and 9 July in America and there is no
 * way to tell from the document which one wrote it. `ambiguousNumericDate`
 * exists for exactly this and turns it into a blocking question. A corpus with
 * only readable dates would let a guess pass as an extraction.
 */
const AMBIGUOUS = '07/09/2026';

const MONTHS = ['September', 'October', 'November', 'December'] as const;

/** A tiny deterministic mixer, so variety does not become randomness. */
const spin = (n: number, mod: number): number => ((n * 2654435761) % 4294967296 >>> 0) % mod;

function syllabus(subject: typeof SUBJECTS[number], index: number): string {
  const lines: string[] = [];
  lines.push(`${subject.code} ${subject.title}`);
  lines.push(`Course: ${subject.title}`);
  lines.push(`Provider: ${subject.provider}`);
  lines.push('');
  lines.push('Learning objectives:');
  for (const objective of subject.objectives) lines.push(`- ${objective}`);
  lines.push('');
  lines.push('Assessment:');
  // Four obligations: three with dates the extractor must read, one with a date
  // it must refuse. Weightings and word counts are carried because a real
  // assessment row carries them, and because `collapseSameDayDuplicates` keeps
  // the longer title for exactly that reason.
  const day = 9 + spin(index, 5);
  const month = MONTHS[spin(index + 1, MONTHS.length)] as string;
  lines.push(`- Lab report, 1500 words (25%) due ${DATE_SHAPES[0](day, month, 2026)}`);
  lines.push(`- Research essay, 3000 words (40%) due ${DATE_SHAPES[1](day + 8, month, 2026)}`);
  lines.push(`- Final examination (25%) due ${DATE_SHAPES[2](day + 14, month, 2026)}`);
  lines.push(`- Seminar presentation (10%) due ${AMBIGUOUS}`);
  lines.push('');
  lines.push('Teaching schedule:');
  for (let week = 1; week <= 6; week += 1) {
    const topic = subject.vocabulary[spin(index + week, subject.vocabulary.length)] as string;
    lines.push(`- Week ${week}: ${topic}, 90 minutes`);
  }
  lines.push('');
  lines.push('Reading list:');
  lines.push(`- Course handbook: https://northgate.example/${subject.code.toLowerCase()}/handbook`);
  lines.push(`- Lecture recordings: https://northgate.example/${subject.code.toLowerCase()}/recordings`);
  return lines.join('\n');
}

function lectureNotes(subject: typeof SUBJECTS[number], week: number, seed: number): string {
  const a = subject.vocabulary[spin(seed, subject.vocabulary.length)] as string;
  const b = subject.vocabulary[spin(seed + 7, subject.vocabulary.length)] as string;
  const c = subject.vocabulary[spin(seed + 13, subject.vocabulary.length)] as string;
  return [
    `${subject.code} ${subject.title}`,
    `Week ${week} lecture notes`,
    '',
    `Today is about ${a}, and the thing to hold on to is that it is not the same`,
    `as ${b}. The distinction only matters once you try to predict something, so`,
    'the second half of the hour is worked examples.',
    '',
    'Key points',
    `- ${a} is what the standard account leans on, and it is doing more work than`,
    '  the textbook admits.',
    `- ${b} is measured differently in every study you will read this week.`,
    `- ${c} is where the two meet, and where most of the exam marks are.`,
    '',
    'Worked example',
    `Take the case in the handout. Applying ${a} directly gives the wrong answer`,
    `because it assumes what ${c} is there to establish. Work it the other way`,
    'and the numbers fall out in two lines.',
    '',
    'For next week: read the chapter, and bring one question about it.',
  ].join('\n');
}

function reading(subject: typeof SUBJECTS[number], n: number, seed: number): string {
  const a = subject.vocabulary[spin(seed + 3, subject.vocabulary.length)] as string;
  return [
    `${subject.title}: reading ${n}`,
    '',
    `An extract on ${a}. The author's argument runs against the standard account`,
    'and is worth reading for the objection rather than for the conclusion.',
    '',
    `The evidence for ${a} is thinner than the summary suggests. Three of the four`,
    'studies cited are re-analyses of one dataset, and the fourth measured',
    'something adjacent and was reported as though it measured this.',
  ].join('\n');
}

function problemSet(subject: typeof SUBJECTS[number], n: number, seed: number): string {
  const a = subject.vocabulary[spin(seed + 5, subject.vocabulary.length)] as string;
  return [
    `${subject.code} problem set ${n}`,
    `Assignment brief: exercises on ${a}`,
    '',
    'Attempt all four. Show the reasoning, not only the answer.',
    '',
    `1. State what ${a} predicts here, and what it does not.`,
    `2. Work the case where the assumption behind ${a} fails.`,
    '3. Explain, in two sentences, why the third case is not a counterexample.',
    '4. Sketch the general result.',
    '',
    `Submission: due ${DATE_SHAPES[0](12 + spin(n, 6), 'October', 2026)}, 17:00.`,
  ].join('\n');
}

/**
 * A semester, as a list of documents.
 *
 * The syllabi come first because that is the order a person drops a folder in
 * and because the intake queue is worked oldest-first: a run that only gets
 * through fifty items should get through the plans before the lecture notes.
 * The unreadables are scattered rather than appended, so a caller cannot pass
 * the failure assertions by only looking at the tail.
 */
export function courseCorpus(opts: CorpusOptions): readonly CorpusDocument[] {
  const courses = Math.max(1, Math.min(SUBJECTS.length, opts.courses ?? 3));
  const unreadable = Math.max(0, opts.unreadable ?? 0);
  const total = Math.max(courses, opts.documents);
  const docs: CorpusDocument[] = [];

  for (let i = 0; i < courses; i += 1) {
    const subject = SUBJECTS[i] as typeof SUBJECTS[number];
    docs.push({
      clientRef: `syllabus-${subject.code}`,
      name: `${subject.code}-syllabus.md`,
      kind: 'syllabus',
      mimeType: 'text/markdown',
      text: syllabus(subject, i),
    });
  }

  let made = docs.length;
  let n = 0;
  while (made < total - unreadable) {
    const subject = SUBJECTS[n % courses] as typeof SUBJECTS[number];
    const cycle = Math.floor(n / courses);
    // Three shapes in rotation. Only the problem set is a plan; the other two
    // are material, which is what makes the drop's kind split observable.
    if (cycle % 3 === 0) {
      const week = (cycle % 12) + 1;
      docs.push({
        clientRef: `notes-${subject.code}-${cycle}`,
        name: `${subject.code}-week${week}-notes.md`,
        kind: 'learner-note',
        mimeType: 'text/markdown',
        text: lectureNotes(subject, week, n),
      });
    } else if (cycle % 3 === 1) {
      docs.push({
        clientRef: `reading-${subject.code}-${cycle}`,
        name: `${subject.code}-reading-${cycle}.txt`,
        kind: 'other',
        mimeType: 'text/plain',
        text: reading(subject, cycle, n),
      });
    } else {
      docs.push({
        clientRef: `problems-${subject.code}-${cycle}`,
        name: `${subject.code}-problems-${cycle}.md`,
        kind: 'assignment-brief',
        mimeType: 'text/markdown',
        text: problemSet(subject, cycle, n),
      });
    }
    made += 1;
    n += 1;
  }

  /**
   * The ones the server cannot read, and the two different reasons.
   *
   * A `.pdf` is a format the product reads on the other side of the seam, so it
   * comes back `elsewhere` with an instruction. A `.pages` is a format nothing
   * here reads at all, so it comes back `unsupported`. Both are ordinary things
   * to find in a course folder, and a drop that reported them the same way would
   * send somebody looking for a corrupt file.
   */
  for (let i = 0; i < unreadable; i += 1) {
    const subject = SUBJECTS[i % courses] as typeof SUBJECTS[number];
    const pdf = i % 2 === 0;
    docs.push({
      clientRef: `unreadable-${i}`,
      name: pdf ? `${subject.code}-handbook-${i}.pdf` : `${subject.code}-notes-${i}.pages`,
      kind: 'course-page',
      mimeType: pdf ? 'application/pdf' : 'application/octet-stream',
      // Real bytes, so nothing passes by being empty. A PDF header is enough:
      // the refusal is decided by format and never by content.
      contentBase64: Buffer.from(pdf ? '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n' : 'PAGESDOC  ')
        .toString('base64'),
    });
  }

  // Interleave the unreadables into the body rather than leaving them at the
  // end. Deterministically: every third position from the sixth, which is where
  // a folder listing would scatter them anyway.
  const body = docs.slice(courses, docs.length - unreadable);
  const bad = docs.slice(docs.length - unreadable);
  const mixed: CorpusDocument[] = docs.slice(0, courses);
  let badAt = 0;
  for (let i = 0; i < body.length; i += 1) {
    mixed.push(body[i] as CorpusDocument);
    if (badAt < bad.length && i > 3 && (i - 4) % 3 === 0) {
      mixed.push(bad[badAt] as CorpusDocument);
      badAt += 1;
    }
  }
  while (badAt < bad.length) { mixed.push(bad[badAt] as CorpusDocument); badAt += 1; }
  return mixed;
}

/** The subjects the corpus is built from, for a test that wants to name one. */
export const CORPUS_SUBJECTS = SUBJECTS;
/** The date shape the extractor must refuse to resolve. */
export const CORPUS_AMBIGUOUS_DATE = AMBIGUOUS;
