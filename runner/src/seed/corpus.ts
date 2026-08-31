/**
 * The seeded learner — Maya, six weeks of real-shaped pinning.
 *
 * Two deliberately unrelated domains. Clustering within one subject is not
 * impressive; clustering *across* cloud infrastructure and jazz harmony, from
 * six different sites, over six weeks, is.
 *
 * Pins carry no topic assignment and no enrichment. The Clusterer has to earn
 * the topics. Signal history is layered on afterwards by matching whatever
 * topics actually emerge — see `history.ts`.
 *
 * `week` is weeks before "today"; 5 is the oldest.
 *
 * URLs model recognisable public learning sources, including three deliberately
 * awkward fetch shapes (a JS-rendered lesson, a forum tag and a video page) so
 * the demo still exercises capture-envelope fallback. Every selection and context
 * sentence is Virgil-authored synthetic material; no captured page excerpt is
 * distributed with the repository.
 */
export interface SeedPin {
  readonly week: number;
  readonly day: number;
  readonly type: 'interest' | 'struggle';
  readonly url: string;
  readonly site: string;
  readonly title: string;
  readonly headings: readonly string[];
  readonly selection: string | null;
  readonly surrounding: string;
  readonly note?: string;
  readonly parts?: readonly { role: 'my-answer' | 'correct-answer' | 'error' | 'fix'; text: string }[];
  /** Expected cluster, for evaluation only. Never given to any agent. */
  readonly expect: string;
}

export const SEED_PINS: readonly SeedPin[] = [
  // ---- Pub/Sub delivery: pinned early, worked through, should end up settled
  { week: 5, day: 1, type: 'struggle', expect: 'pubsub-delivery',
    url: 'https://cloud.google.com/pubsub/docs/subscriber', site: 'cloud.google.com',
    title: 'Choose a subscription type', headings: ['Pub/Sub', 'Subscriptions'],
    selection: 'With pull delivery your subscriber client requests messages; with push delivery Pub/Sub sends each message as an HTTP request to an endpoint you control.',
    surrounding: 'Subscription type determines how messages reach your code. Pull suits high throughput and variable processing time. Push suits low volume and serverless endpoints that are already HTTP.' },
  { week: 5, day: 3, type: 'struggle', expect: 'pubsub-delivery',
    url: 'https://cloud.google.com/pubsub/docs/lease-management', site: 'stackoverflow.com',
    title: 'Why are my Pub/Sub messages redelivered?', headings: ['Questions'],
    selection: 'If you do not acknowledge within the ack deadline the message is redelivered. Extending the deadline is done by the client library automatically, but only up to maxExtension.',
    surrounding: 'Accepted answer explains that redelivery is expected behaviour and at-least-once delivery means your handler must be idempotent.',
    note: 'why?' },
  { week: 4, day: 2, type: 'interest', expect: 'pubsub-delivery',
    url: 'https://cloud.google.com/pubsub/docs/exactly-once-delivery', site: 'cloud.google.com',
    title: 'Exactly-once delivery', headings: ['Pub/Sub', 'Delivery'],
    selection: 'Exactly-once delivery guarantees that an acknowledged message is not redelivered, within a single subscription and region.',
    surrounding: 'This does not remove the need for idempotency across subscriptions or regions.' },

  // ---- Ordering keys: advanced, pinned BEFORE the basics were solid (tests )
  { week: 5, day: 2, type: 'interest', expect: 'pubsub-ordering',
    url: 'https://cloud.google.com/pubsub/docs/ordering', site: 'cloud.google.com',
    title: 'Ordering messages', headings: ['Pub/Sub', 'Ordering'],
    selection: 'Messages published with the same ordering key are delivered to subscribers in the order the service received them.',
    surrounding: 'Ordering keys require the subscription to have message ordering enabled. Throughput per ordering key is limited.' },
  { week: 3, day: 4, type: 'struggle', expect: 'pubsub-ordering',
    url: 'https://cloud.google.com/pubsub/quotas', site: 'medium.com',
    title: 'Three ways ordering keys bite you', headings: ['Ordering'],
    selection: 'A single hot ordering key serialises all its messages through one subscriber, so a poorly chosen key turns a parallel pipeline into a queue.',
    surrounding: 'Choose keys with high cardinality. Tenant id is usually fine; a constant string is a disaster.' },

  // ---- IAM conditions: the persistent struggle, three weeks running
  { week: 4, day: 1, type: 'struggle', expect: 'iam-conditions',
    url: 'https://cloud.google.com/iam/docs/conditions-overview', site: 'cloud.google.com',
    title: 'IAM Conditions overview', headings: ['IAM', 'Conditions'],
    selection: 'Conditional role bindings grant access only when the condition expression evaluates to true for the request.',
    surrounding: 'Conditions are written in Common Expression Language and can reference request attributes and resource attributes.' },
  { week: 3, day: 2, type: 'struggle', expect: 'iam-conditions',
    url: 'https://cloud.google.com/iam/docs/conditions-attribute-reference', site: 'cloud.google.com',
    title: 'Attribute reference', headings: ['IAM', 'Conditions', 'Attributes'],
    selection: 'resource.name is only available for some services. Where it is unavailable the condition cannot reference the specific resource.',
    surrounding: 'Check the supported attributes table per service before writing a condition.',
    note: 'this keeps catching me out' },
  { week: 2, day: 3, type: 'struggle', expect: 'iam-conditions',
    url: 'https://stackoverflow.com/questions/tagged/google-iam', site: 'stackoverflow.com',
    title: 'IAM condition never matches', headings: ['Questions'],
    selection: null,
    surrounding: 'Asker wrote a condition on resource.type expecting it to match a bucket, but resource.type for Cloud Storage objects is storage.googleapis.com/Object not Bucket.',
    parts: [
      { role: 'my-answer', text: 'resource.type == "storage.googleapis.com/Bucket"' },
      { role: 'correct-answer', text: 'resource.type == "storage.googleapis.com/Object"' },
    ] },
  { week: 1, day: 2, type: 'struggle', expect: 'iam-conditions',
    url: 'https://cloud.google.com/iam/docs/conditions-overview', site: 'cloud.google.com',
    title: 'IAM Conditions overview', headings: ['IAM', 'Conditions', 'Limitations'],
    selection: 'Conditions cannot be used with basic roles, and a conditional binding does not reduce access granted by another unconditional binding.',
    surrounding: 'This is the most common source of surprise: adding a condition to one binding does not restrict a broader grant elsewhere in the policy.',
    note: 'THIS is what I kept missing' },

  // ---- Cloud Run cold starts: currently working on
  { week: 2, day: 1, type: 'interest', expect: 'cloudrun-coldstart',
    url: 'https://cloud.google.com/run/docs/tips/general', site: 'cloud.google.com',
    title: 'General development tips', headings: ['Cloud Run', 'Tips'],
    selection: 'A cold start occurs when a request arrives and no instance is available, so the container must be started and initialised before the request is served.',
    surrounding: 'Minimum instances keep containers warm at the cost of always-on billing.' },
  { week: 1, day: 4, type: 'struggle', expect: 'cloudrun-coldstart',
    url: 'https://cloud.google.com/run/docs/configuring/min-instances', site: 'cloud.google.com',
    title: 'Minimum instances', headings: ['Cloud Run', 'Configuring'],
    selection: 'Idle instances retained by the minimum instances setting are billed at a reduced rate but are still billed.',
    surrounding: 'Setting minimum instances above zero eliminates most cold starts for steady traffic but does not help with sudden spikes.' },
  { week: 0, day: 2, type: 'interest', expect: 'cloudrun-coldstart',
    url: 'https://cloud.google.com/run/docs/configuring/services/cpu', site: 'cloud.google.com',
    title: 'Startup CPU boost', headings: ['Cloud Run', 'Configuring'],
    selection: 'Startup CPU boost allocates additional CPU during instance startup to reduce cold start latency.',
    surrounding: 'Most effective for runtimes with heavy initialisation such as JVM or large Python dependency trees.' },

  // ---- Firestore query limits: the REGRESSION topic
  { week: 4, day: 4, type: 'interest', expect: 'firestore-queries',
    url: 'https://firebase.google.com/docs/firestore/query-data/queries', site: 'firebase.google.com',
    title: 'Perform simple and compound queries', headings: ['Firestore', 'Queries'],
    selection: 'Compound queries with range filters on multiple fields require a composite index and are subject to ordering constraints.',
    surrounding: 'Range and inequality filters must all apply to the same field unless you use the newer multi-field capability.' },
  { week: 0, day: 3, type: 'struggle', expect: 'firestore-queries',
    url: 'https://firebase.google.com/docs/firestore/query-data/index-overview', site: 'stackoverflow.com',
    title: 'The query requires an index', headings: ['Questions'],
    selection: null,
    surrounding: 'Asker hit an index error combining a where on status with an orderBy on createdAt.',
    parts: [
      { role: 'error', text: 'FAILED_PRECONDITION: The query requires an index.' },
      { role: 'fix', text: 'Create a composite index on (status ASC, createdAt DESC).' },
    ],
    note: 'thought I had this' },

  // ---- Intervals: absorbed, should settle
  { week: 5, day: 4, type: 'struggle', expect: 'intervals',
    url: 'https://www.musictheory.net/lessons/31', site: 'musictheory.net',
    title: 'Generic intervals', headings: ['Lessons', 'Intervals'],
    selection: 'An interval is the distance between two notes, counted inclusively from the lower note to the higher.',
    surrounding: 'C to E is a third because C, D, E is three letter names, regardless of accidentals.' },
  { week: 4, day: 3, type: 'struggle', expect: 'intervals',
    url: 'https://www.musictheory.net/lessons/32', site: 'musictheory.net',
    title: 'Specific intervals', headings: ['Lessons', 'Intervals'],
    selection: 'A major third spans four semitones; a minor third spans three. The generic name tells you the letter distance, the quality tells you the semitone count.',
    surrounding: 'Perfect intervals are the unison, fourth, fifth and octave. These are never major or minor.' },

  // ---- Seventh chords: currently building
  { week: 3, day: 1, type: 'interest', expect: 'seventh-chords',
    url: 'https://en.wikipedia.org/wiki/Seventh_chord', site: 'jazzadvice.com',
    title: 'The four seventh chord qualities', headings: ['Harmony'],
    selection: 'Major seventh, dominant seventh, minor seventh and half-diminished are built by stacking thirds and differ only in which thirds are major or minor.',
    surrounding: 'A dominant seventh is a major triad with a minor seventh on top, which is what gives it its instability.' },
  { week: 2, day: 4, type: 'struggle', expect: 'seventh-chords',
    url: 'https://en.wikipedia.org/wiki/Voicing_(music)', site: 'reddit.com',
    title: 'Why does my Cmaj7 sound muddy?', headings: ['r/jazztheory'],
    selection: 'Below roughly the C below middle C, thirds sound muddy. Voice the third higher or drop it and let the seventh carry the colour.',
    surrounding: 'Rootless voicings exist partly for this reason. The bass player has the root anyway.' },

  // ---- Tritone substitution: struggle that DEPENDS on seventh chords
  { week: 1, day: 1, type: 'struggle', expect: 'tritone-sub',
    url: 'https://en.wikipedia.org/wiki/Tritone_substitution', site: 'jazzadvice.com',
    title: 'Tritone substitution', headings: ['Harmony', 'Substitution'],
    selection: 'Any dominant seventh can be replaced by the dominant seventh a tritone away, because both chords share the same third and seventh.',
    surrounding: 'G7 and Db7 both contain B and F. The guide tones are identical, only inverted, which is why the substitution works.' },
  { week: 0, day: 1, type: 'struggle', expect: 'tritone-sub',
    url: 'https://www.youtube.com/watch?v=tritone-explained', site: 'youtube.com',
    title: 'Tritone subs in ii-V-I', headings: [],
    selection: null,
    surrounding: 'Video explains that the substituted chord produces chromatic root movement down a semitone into the tonic, which is the actual reason it sounds smooth.',
    note: 'still not hearing it' },

  // ---- The ABANDONED interest: pinned once on a whim, never returned to.
  // Deliberately orthogonal to both tracks. An earlier draft used modal
  // interchange, but a correct clusterer merges that into tritone substitution
  // (they are both reharmonisation) and the abandonment case stops being
  // testable. The Gardener needs something nothing else will absorb.
  { week: 5, day: 5, type: 'interest', expect: 'sourdough-hydration',
    url: 'https://en.wikipedia.org/wiki/Baker_percentage', site: 'theperfectloaf.com',
    title: 'Understanding dough hydration', headings: ['Baking', 'Fundamentals'],
    selection: 'Hydration is the weight of water as a percentage of the weight of flour, so 375g water to 500g flour is 75% hydration.',
    surrounding: 'Higher hydration gives a more open crumb but a slacker dough that is harder to shape.' },
];
