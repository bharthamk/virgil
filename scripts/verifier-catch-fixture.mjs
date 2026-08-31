
/** The defective section, exactly as it shipped. */
export const SECTION = {
  topicId: 't',
  heading: 'Intervals and tertian chords: stop reading, go play',
  depth: 'building',
  estimatedMinutes: 3,
  question: null,
  sourceIds: ['s1', 's2', 's3'],
  mediumWarning: 'Intervals and chord quality are auditory-motor skills; reading the semitone counts will not build the hearing.',
  body: `You can see the tertian construction on paper: a seventh chord is three stacked thirds, each major (4 semitones) or minor (3), giving four useful permutations out of eight, the eighth being four stacked major thirds which collapses into an augmented non-seventh chord.

So the section is a 20-minute daily instruction:

1. Five minutes. On a single piano key or a single guitar string, play C, then play E (4 semitones up: major third). Hum both.

2. Five minutes. Play the root of C7 (the note C) and the root of F-sharp 7 (the note F-sharp). That is one semitone of chromatic descent. Listen for whether it resolves to C major.

3. Five minutes. Sing up a major third and back down. Then a minor third. The difference is one semitone.

4. Five minutes. Silence. Listen back to what you just produced.

Put the YouTube and jazzadvice pins aside; they are reference material for after the ear is trained.`,
};

/** The pinned material the section was written from. Every defect is sourced. */
export const SOURCE_MATERIAL = `"A major third spans four semitones; a minor third spans three."
"The most common chords are tertian, constructed using a sequence of major and minor thirds."
"Any dominant seventh can be replaced by the dominant seventh a tritone away, because both chords share the same third and seventh." (G7 and Db7 both contain B and F.)
"produces chromatic root movement down a semitone into the tonic"`;

/** What the product is allowed to assert about the learner. The fence. */
export const KNOWN_ABOUT_LEARNER = [
  'You are trying to train your ear through text and video.',
  'Your music study is text and video only.',
];

/**
 * The four fatal defects, and a keyword probe for each.
 *
 * A keyword probe over one fixture is a narrow instrument and is recorded as
 * one: it asks whether the defect was named, not whether it was named well.
 * `GEMINI_BENCHMARK_2026-08-20.md` §5 has the standing caveat — the same
 * Verifier that missed `fabricated pins/sources` three times on this fixture
 * caught that exact defect class live on a freshly composed section, so catch
 * rate is content-dependent and this number is a floor for a shape, not a grade.
 */
export const GROUND_TRUTH = [
  ['C->F# called one semitone', (t) => /f.?sharp|f#/i.test(t) && /six|tritone|6 semitone/i.test(t)],
  ['permutation count wrong', (t) => /permutation|seven|eight|2.?3|combinations/i.test(t)],
  ['bare roots cannot resolve', (t) => /resolve|root|third and seventh|no third/i.test(t)],
  ['fabricated pins/sources', (t) => /youtube|jazzadvice|pins/i.test(t)],
];

/** Everything `verify()` needs, so a consumer cannot assemble three of the four. */
export const CATCH_FIXTURE = {
  section: SECTION,
  sourceMaterial: SOURCE_MATERIAL,
  knownAboutLearner: KNOWN_ABOUT_LEARNER,
};

/** The defect list a run produced, flattened into the text the probes read. */
export const blobOf = (defects) =>
  defects.map((d) => `${d.kind} ${d.quote} ${d.problem}`).join(' | ');

/** Which of the four this blob names. */
export const score = (blob) => GROUND_TRUTH.filter(([, probe]) => probe(blob)).map(([name]) => name);
