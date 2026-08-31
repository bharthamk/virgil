import type { Pin } from '@sb/core';

/**
 * The seeded learner's board, as clustering sees it.
 *
 * A verbatim copy of the fields `pinClusterText` reads out of
 * `runner/src/seed/corpus.ts` — title, heading path, selection, surrounding
 * text, parts and note. It is copied rather than imported because `adapters/`
 * cannot depend on `runner/`, which depends on it.
 *
 * It has to be the WHOLE board, not the music half. TF-IDF computes IDF over
 * the batch it is handed, so its geometry is corpus-relative: the same seven
 * music pins on their own produce a different partition and a different wrong
 * merge (measured — clustering-stability constraint says the same thing about subsets, and it
 * reproduces exactly here). The merge these tests demonstrate fixing is the one
 * that happens on the real 21-pin board.
 *
 * `expect` is the golden key and is never given to any agent. It is here so a
 * test can say "these two are wrongly welded" in the reader's language.
 *
 * Generated from the corpus rather than retyped. If it drifts, the demonstration
 * below is measuring a board the product does not have.
 */
export interface SeedRow {
  readonly id: string;
  readonly expect: string;
  readonly type: 'interest' | 'struggle';
  readonly title: string;
  readonly headings: readonly string[];
  readonly selection: string | null;
  readonly surrounding: string;
  readonly note?: string;
  readonly parts?: readonly { role: 'my-answer' | 'correct-answer' | 'error' | 'fix'; text: string }[];
}

export const SEED_ROWS: readonly SeedRow[] = [
  { id: "p00", expect: "pubsub-delivery", type: "struggle", title: "Choose a subscription type", headings: ["Pub/Sub","Subscriptions"], selection: "With pull delivery your subscriber client requests messages; with push delivery Pub/Sub sends each message as an HTTP request to an endpoint you control.", surrounding: "Subscription type determines how messages reach your code. Pull suits high throughput and variable processing time. Push suits low volume and serverless endpoints that are already HTTP." },
  { id: "p01", expect: "pubsub-delivery", type: "struggle", title: "Why are my Pub/Sub messages redelivered?", headings: ["Questions"], selection: "If you do not acknowledge within the ack deadline the message is redelivered. Extending the deadline is done by the client library automatically, but only up to maxExtension.", surrounding: "Accepted answer explains that redelivery is expected behaviour and at-least-once delivery means your handler must be idempotent.", note: "why?" },
  { id: "p02", expect: "pubsub-delivery", type: "interest", title: "Exactly-once delivery", headings: ["Pub/Sub","Delivery"], selection: "Exactly-once delivery guarantees that an acknowledged message is not redelivered, within a single subscription and region.", surrounding: "This does not remove the need for idempotency across subscriptions or regions." },
  { id: "p03", expect: "pubsub-ordering", type: "interest", title: "Ordering messages", headings: ["Pub/Sub","Ordering"], selection: "Messages published with the same ordering key are delivered to subscribers in the order the service received them.", surrounding: "Ordering keys require the subscription to have message ordering enabled. Throughput per ordering key is limited." },
  { id: "p04", expect: "pubsub-ordering", type: "struggle", title: "Three ways ordering keys bite you", headings: ["Ordering"], selection: "A single hot ordering key serialises all its messages through one subscriber, so a poorly chosen key turns a parallel pipeline into a queue.", surrounding: "Choose keys with high cardinality. Tenant id is usually fine; a constant string is a disaster." },
  { id: "p05", expect: "iam-conditions", type: "struggle", title: "IAM Conditions overview", headings: ["IAM","Conditions"], selection: "Conditional role bindings grant access only when the condition expression evaluates to true for the request.", surrounding: "Conditions are written in Common Expression Language and can reference request attributes and resource attributes." },
  { id: "p06", expect: "iam-conditions", type: "struggle", title: "Attribute reference", headings: ["IAM","Conditions","Attributes"], selection: "resource.name is only available for some services. Where it is unavailable the condition cannot reference the specific resource.", surrounding: "Check the supported attributes table per service before writing a condition.", note: "this keeps catching me out" },
  { id: "p07", expect: "iam-conditions", type: "struggle", title: "IAM condition never matches", headings: ["Questions"], selection: null, surrounding: "Asker wrote a condition on resource.type expecting it to match a bucket, but resource.type for Cloud Storage objects is storage.googleapis.com/Object not Bucket.", parts: [{"role":"my-answer","text":"resource.type == \"storage.googleapis.com/Bucket\""},{"role":"correct-answer","text":"resource.type == \"storage.googleapis.com/Object\""}] },
  { id: "p08", expect: "iam-conditions", type: "struggle", title: "IAM Conditions overview", headings: ["IAM","Conditions","Limitations"], selection: "Conditions cannot be used with basic roles, and a conditional binding does not reduce access granted by another unconditional binding.", surrounding: "This is the most common source of surprise: adding a condition to one binding does not restrict a broader grant elsewhere in the policy.", note: "THIS is what I kept missing" },
  { id: "p09", expect: "cloudrun-coldstart", type: "interest", title: "General development tips", headings: ["Cloud Run","Tips"], selection: "A cold start occurs when a request arrives and no instance is available, so the container must be started and initialised before the request is served.", surrounding: "Minimum instances keep containers warm at the cost of always-on billing." },
  { id: "p10", expect: "cloudrun-coldstart", type: "struggle", title: "Minimum instances", headings: ["Cloud Run","Configuring"], selection: "Idle instances retained by the minimum instances setting are billed at a reduced rate but are still billed.", surrounding: "Setting minimum instances above zero eliminates most cold starts for steady traffic but does not help with sudden spikes." },
  { id: "p11", expect: "cloudrun-coldstart", type: "interest", title: "Startup CPU boost", headings: ["Cloud Run","Configuring"], selection: "Startup CPU boost allocates additional CPU during instance startup to reduce cold start latency.", surrounding: "Most effective for runtimes with heavy initialisation such as JVM or large Python dependency trees." },
  { id: "p12", expect: "firestore-queries", type: "interest", title: "Perform simple and compound queries", headings: ["Firestore","Queries"], selection: "Compound queries with range filters on multiple fields require a composite index and are subject to ordering constraints.", surrounding: "Range and inequality filters must all apply to the same field unless you use the newer multi-field capability." },
  { id: "p13", expect: "firestore-queries", type: "struggle", title: "The query requires an index", headings: ["Questions"], selection: null, surrounding: "Asker hit an index error combining a where on status with an orderBy on createdAt.", note: "thought I had this", parts: [{"role":"error","text":"FAILED_PRECONDITION: The query requires an index."},{"role":"fix","text":"Create a composite index on (status ASC, createdAt DESC)."}] },
  { id: "p14", expect: "intervals", type: "struggle", title: "Generic intervals", headings: ["Lessons","Intervals"], selection: "An interval is the distance between two notes, counted inclusively from the lower note to the higher.", surrounding: "C to E is a third because C, D, E is three letter names, regardless of accidentals." },
  { id: "p15", expect: "intervals", type: "struggle", title: "Specific intervals", headings: ["Lessons","Intervals"], selection: "A major third spans four semitones; a minor third spans three. The generic name tells you the letter distance, the quality tells you the semitone count.", surrounding: "Perfect intervals are the unison, fourth, fifth and octave. These are never major or minor." },
  { id: "p16", expect: "seventh-chords", type: "interest", title: "The four seventh chord qualities", headings: ["Harmony"], selection: "Major seventh, dominant seventh, minor seventh and half-diminished are built by stacking thirds and differ only in which thirds are major or minor.", surrounding: "A dominant seventh is a major triad with a minor seventh on top, which is what gives it its instability." },
  { id: "p17", expect: "seventh-chords", type: "struggle", title: "Why does my Cmaj7 sound muddy?", headings: ["r/jazztheory"], selection: "Below roughly the C below middle C, thirds sound muddy. Voice the third higher or drop it and let the seventh carry the colour.", surrounding: "Rootless voicings exist partly for this reason. The bass player has the root anyway." },
  { id: "p18", expect: "tritone-sub", type: "struggle", title: "Tritone substitution", headings: ["Harmony","Substitution"], selection: "Any dominant seventh can be replaced by the dominant seventh a tritone away, because both chords share the same third and seventh.", surrounding: "G7 and Db7 both contain B and F. The guide tones are identical, only inverted, which is why the substitution works." },
  { id: "p19", expect: "tritone-sub", type: "struggle", title: "Tritone subs in ii-V-I", headings: [], selection: null, surrounding: "Video explains that the substituted chord produces chromatic root movement down a semitone into the tonic, which is the actual reason it sounds smooth.", note: "still not hearing it" },
  { id: "p20", expect: "sourdough-hydration", type: "interest", title: "Understanding dough hydration", headings: ["Baking","Fundamentals"], selection: "Hydration is the weight of water as a percentage of the weight of flour, so 375g water to 500g flour is 75% hydration.", surrounding: "Higher hydration gives a more open crumb but a slacker dough that is harder to shape." },
];

/** The rows as pins, with no topic and no enrichment — the fleet earns those. */
export function seedPins(): Pin[] {
  return SEED_ROWS.map((s) => ({
    id: s.id,
    type: s.type,
    envelope: {
      selection: s.selection,
      parts: s.parts ?? [],
      surroundingText: s.surrounding,
      headingPath: s.headings,
      pageTitle: s.title,
      url: 'https://example.test/',
      canonicalUrl: null,
      siteName: null,
      contentLanguage: 'en',
      media: null,
    },
    note: s.note ?? null,
    capturedAt: '2026-08-01T00:00:00Z',
    fromSuggestion: false,
    enrichment: null,
    topicId: null,
  }));
}

/** Golden-key membership, for asserting in words rather than in pin ids. */
export const expectOf = (id: string): string =>
  SEED_ROWS.find((r) => r.id === id)?.expect ?? 'unknown';
