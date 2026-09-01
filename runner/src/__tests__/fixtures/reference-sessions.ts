/**
 * THE TWO REFERENCE SESSIONS, AS FIXTURES. Generated — do not hand-edit.
 *
 *   node scripts/transcribe-reference-sessions.mjs <artefacts-dir>
 *
 * Transcribed from artifacts/REFERENCE_SESSION.md and REFERENCE_SESSION_V2.md,
 * the two sessions the local pipeline produced unattended and the baseline a
 * port has to match. Topic ids and source ids are minted by the transcription
 * (the rendering carries a source COUNT, not ids); everything else is the
 * artefact's own text. See the script header for exactly what is reconstructed
 * and why the comfort-ledger and verbatim-quote checks are left to skip.
 */
import type { ScoreBoard, ScoreableSession } from '@sb/core';

export interface ReferenceFixture {
  readonly name: string;
  readonly builtAt: string;
  readonly fromPinCount: number;
  readonly session: ScoreableSession;
  readonly board: ScoreBoard;
}

export const REFERENCE_V1: ReferenceFixture = {
  "name": "REFERENCE_SESSION (v1)",
  "builtAt": "2026-08-19T00:59:25.267Z",
  "fromPinCount": 9,
  "session": {
    "targetMinutes": 15,
    "estimatedMinutes": 15,
    "closingNote": "The composite-index slip is back in your exceptions list with a why-attached; the four IAM carve-outs are written out as Rule/Exception pairs with a generative reason for each, which is the format that should stop the re-encounter. The tertian table is intact on paper but the ear is still untrained, so the 20-minute daily block is the only thing that moves that. Open: whether the resource.name availability list for the services you actually use is now checked, and whether the one-semitore difference between a major and minor third is felt in the throat or still only known as a number.",
    "sections": [
      {
        "topicId": "v1-s1",
        "heading": "Firestore composite indexes: why two single-field indexes don't compose",
        "body": "You had this. The slip is specific: you wrote a query like\n\n  db.collection('orders')\n    .where('status', '==', 'pending')\n    .orderBy('createdAt')\n\nand expected Firestore to use a single-field index on `status` for the filter and a single-field index on `createdAt` for the sort, and stitch them together. It can't. A single-field index on `status` gives you every 'pending' row in arbitrary order. A single-field index on `createdAt` gives you every row in date order, unfiltered. Neither structure contains the joint ordering \"pending, sorted by date.\" The composite index is a different data structure: it is a single B-tree sorted by `status` first, then by `createdAt` within each `status` value. It is not two indexes combined at query time; it is one pre-built structure that both conditions traverse in a single scan.\n\nWhy the rule exists (the generative step you tend to skip): without the composite index, Firestore would have to either (a) read the `status` index, pull every matching row, then sort in memory, or (b) read the `createdAt` index in order and test `status` on each row until it finds enough matches. Both are O(n) on the larger set. The composite index collapses that to a single ordered scan. If you removed the composite index, the query either fails with the index error you saw, or silently degrades to a full-collection scan with a filter applied post-read.\n\nThe reduced-confidence pin you saved adds a second layer: compound queries that carry range filters on more than one field also require a composite index, and the ordering direction is constrained. I can't enumerate the full constraint set from that pin alone, but the operative point is that sort direction and range direction must be compatible within the same index entry. A `where('createdAt','>', X)` combined with `orderBy('createdAt','desc')` will not resolve against an index built for ascending order on that field. When you hit the index-creation prompt in the console, read the field list and the sort directions it proposes before you click create.\n\nAdd this to your running exceptions list, in the format you already use:\n  Rule: two single-field indexes satisfy a where + orderBy on two fields.\n  Exception: they do not. Firestore requires an explicit composite index; the two single-field indexes are never joined at query time.\n\nAnd the second entry:\n  Rule: I can sort and range-filter on the same field freely.\n  Exception: direction must match the index. A descending sort with an ascending range (or vice versa) on the same field needs its own composite index entry.",
        "depth": "building",
        "estimatedMinutes": 5,
        "sourceIds": [
          "v1-s1:src-1",
          "v1-s1:src-2"
        ],
        "mediumWarning": null,
        "question": {
          "prompt": "Name one query shape other than where+orderBy on two fields that would also fail if you only had single-field indexes. You do not need a real query; a description of the shape is enough.",
          "kind": "free-text",
          "expectedPoints": []
        }
      },
      {
        "topicId": "v1-s2",
        "heading": "Intervals and tertian chords: stop reading, go play",
        "body": "You can see the tertian construction on paper: a seventh chord is three stacked thirds, each major (4 semitones) or minor (3), giving four useful permutations out of eight, the eighth being four stacked major thirds which collapses into an augmented non-seventh chord. That model is intact; the pin marks it full-confidence interest. The problem is not that you cannot reconstruct it. The problem, in your own words, is that you are \"still not hearing it.\" Reading the semitone counts again will not fix that, because the gap is auditory-motor, not conceptual. A major third and a minor third differ by one semitone; that is a fact you already have. The skill you lack is the ability to hear that one-semitone difference in isolation, in your own ear, before a chord name is attached.\n\nSo the section is not an explanation. It is a 20-minute daily instruction that produces no notes and no reading:\n\n1. Five minutes. On a single piano key or a single guitar string, play C, then play E (4 semitones up: major third). Hum both. Then play C, then E-flat (3 semitones up: minor third). Hum both. Repeat until the two hums feel different in your own throat, not just in your head. Label them out loud: \"four,\" \"three.\" You are building the mapping from semitone count to a felt pitch difference.\n\n2. Five minutes. Play the root of C7 (the note C) and the root of F-sharp 7 (the note F-sharp). That is one semitone of chromatic descent. Listen for the pull. Do not name the chords. Do not think about shared tones yet. Just listen for the direction of the pull and whether it resolves to C major or leaves you suspended.\n\n3. Five minutes. Sing a single syllable (say, \"ba\") up a major third and back down. Then sing up a minor third and back down. The difference is one semitone. You are training the larynx to produce and the ear to discriminate that difference without a keyboard.\n\n4. Five minutes. Silence. Listen back to what you just produced. Note which of the two thirds was easier to hold steady and which wobbled. That wobble is where the next session starts.\n\nThe tertian construction you already understand becomes useful the moment the ear can hear the individual thirds inside a chord. Until then, the four-permutation table is a diagram, not a tool. Put the YouTube and jazzadvice pins aside; they are reference material for after the ear is trained, not a substitute for it.",
        "depth": "building",
        "estimatedMinutes": 3,
        "sourceIds": [
          "v1-s2:src-1",
          "v1-s2:src-2",
          "v1-s2:src-3"
        ],
        "mediumWarning": "Intervals and chord quality are auditory-motor skills; reading the semitone counts or watching a video will not build the hearing. This section is a practice instruction, not an explanation, because no amount of prose closes the gap between knowing 'four semitones' and hearing the difference between a major and a minor third.",
        "question": null
      },
      {
        "topicId": "v1-s3",
        "heading": "IAM condition expressions: the bouncer, and the four doors where the bouncer is absent",
        "body": "Start with a concrete picture. You hand someone a hotel keycard. The card says: floor 3, all day. That is a role binding: a principal (the person) is granted a role (access to floor 3). Now you add a sticker on the card: \"valid 18:00–06:00.\" The sticker is a condition expression. The person still holds the card, but the grant only takes effect when the sticker's expression evaluates to true. Without the sticker, the card works all day. With it, the card works only in the window. In IAM terms: if a role binding has a condition, the principals in that binding are only granted the role when the condition expression evaluates to true. A condition expression is a boolean you attach to a binding; it is evaluated at request time, not at grant time. The principal is not \"partially in\" the role; they are either in or out for each request.\n\nNow the four carve-outs. These are the ones that keep catching you, and they share a shape: the rule you built in your head says \"conditions work everywhere,\" and each of these is a door where the bouncer is absent.\n\n1. Legacy roles. You cannot attach a condition to Owner, Editor, or Viewer. These three predate the attribute-based evaluation layer. They are blanket grants: full read, full write, or full admin, with no hook for a request-time expression to slot into. The exception in your running list: Rule: a condition restricts a role binding. Exception: conditions cannot be attached to legacy basic roles (roles/owner, roles/editor, roles/viewer). Why: there is no evaluation point in the legacy grant path. Adding a condition to them is a no-op that the console will reject.\n\n2. Conditional vs. unconditioned binding. If a principal has two bindings on the same role — one with a condition, one without — the unconditioned binding wins. The condition narrows its own binding; it does not override the broader one. Exception: Rule: a conditional binding restricts access. Exception: it does not override an unconditioned binding on the same principal. Why: IAM is an allow-by-accumulation system. The unconditioned binding says \"always in.\" The conditional binding says \"in when X.\" The union is \"always in,\" because the unconditioned path is always true.\n\n3. resource.name. This field is not available for every service. Where a service does not expose a resource-level name to the condition evaluator, you cannot write a condition that says \"only for this specific bucket\" or \"only for this specific Pub/Sub topic.\" Exception: Rule: resource.name identifies the specific resource in a condition. Exception: resource.name is only available for some services; for services that do not expose it, you cannot reference the specific resource by name in a condition. The pin is reduced-confidence, so I will not assert which services do and do not expose it; check the service's IAM documentation for the list of supported request attributes before you write the condition.\n\n4. resource.type string. You wrote a condition on resource.type expecting it to match a bucket, and it did not. For Cloud Storage objects, the type string is storage.googleapis.com/Object, not storage.googleapis.com/Bucket. The object and its parent bucket are different nodes in the resource hierarchy, and the type string reflects the node you are at. Exception: Rule: resource.type tells me what kind of resource I am looking at, and I can predict the string. Exception: type strings are service-specific and follow that service's own resource hierarchy. For Storage, an object-level operation reports Object, not Bucket. The general principle is that each service defines its own hierarchy and its own type vocabulary; you cannot assume the container name is the type string.\n\nThe generative question for each one, which you tend to skip: why does the carve-out exist? For legacy roles, the evaluation framework was added after they were designed; there is no hook. For resource.name, not every service has a stable, queryable per-resource identifier exposed to the policy engine. For resource.type, the string is a path in a service-defined tree, not a free-form label you can guess. Writing the \"why\" down next to each entry is what turns the list from a set of facts into a predictive model: when you see a new service, you ask \"does it have a per-resource name? what is its resource hierarchy? does it use a legacy role?\" before you write the condition.\n\nYour running list now reads:\n  Rule: conditions restrict any role binding. Exception: not on legacy basic roles.\n  Rule: a conditional binding narrows access. Exception: an unconditioned binding on the same principal is not overridden.\n  Rule: resource.name identifies a specific resource. Exception: only available for some services; check the service's supported attributes.\n  Rule: resource.type is the container I expect. Exception: it is the node in that service's own hierarchy; for Storage objects it is Object, not Bucket.",
        "depth": "from-nothing",
        "estimatedMinutes": 7,
        "sourceIds": [
          "v1-s3:src-1",
          "v1-s3:src-2",
          "v1-s3:src-3",
          "v1-s3:src-4"
        ],
        "mediumWarning": null,
        "question": {
          "prompt": "Pick a service other than Cloud Storage that you use in your current project. What resource.type string would you expect a condition on that service to report, and what is the one thing you would check before writing the condition that you would not have checked if type strings were uniform across services?",
          "kind": "free-text",
          "expectedPoints": []
        }
      }
    ]
  },
  "board": {
    "topics": [
      {
        "id": "v1-s1",
        "label": "Firestore composite indexes: why two single-field indexes don't compose",
        "summary": "",
        "pinIds": [
          "v1-s1-pin"
        ],
        "state": "working",
        "comfort": 0.4,
        "lastExposedAt": null,
        "retiredByUser": false,
        "createdAt": "2026-08-01T00:00:00.000Z"
      },
      {
        "id": "v1-s2",
        "label": "Intervals and tertian chords: stop reading, go play",
        "summary": "",
        "pinIds": [
          "v1-s2-pin"
        ],
        "state": "working",
        "comfort": 0.4,
        "lastExposedAt": null,
        "retiredByUser": false,
        "createdAt": "2026-08-01T00:00:00.000Z"
      },
      {
        "id": "v1-s3",
        "label": "IAM condition expressions: the bouncer, and the four doors where the bouncer is absent",
        "summary": "",
        "pinIds": [
          "v1-s3-pin"
        ],
        "state": "working",
        "comfort": 0.4,
        "lastExposedAt": null,
        "retiredByUser": false,
        "createdAt": "2026-08-01T00:00:00.000Z"
      }
    ],
    "offeredSourceIds": [
      "v1-s1:src-1",
      "v1-s1:src-2",
      "v1-s2:src-1",
      "v1-s2:src-2",
      "v1-s2:src-3",
      "v1-s3:src-1",
      "v1-s3:src-2",
      "v1-s3:src-3",
      "v1-s3:src-4"
    ],
    "knownAboutLearner": [
      "You build a clean general model of a system, feel you have it, and then get stopped by the exception or boundary case — and the gap is the condition under which the rule stops applying, not the rule itself.",
      "You tend to treat a summary as complete knowledge, and the false confidence only surfaces when you first try to apply the topic in practice.",
      "You conflate the name or label of a concept with its actual behaviour, and this has shown up in more than one domain you are working in.",
      "You are trying to train your ear to recognise tritone substitution and voicing clarity through text and a video, and I think the medium cannot deliver that skill — your own note that you still cannot hear it is direct evidence of that.",
      "The pattern repeats: you read the happy-path description, mark the topic as understood, and the struggle reappears some days or weeks later when an edge case forces itself on you.",
      "Your recurring self-reports — 'this keeps catching me out', 'thought I had this' — are the tell that the missing piece was never the rule but its boundary.",
      "Your music study is text and video only, and the last pin on chromatic bass movement says 'still not hearing it' after a video explanation, which reads as a modality gap rather than a knowledge gap.",
      "Intervals and voice leading are built by ear and by a hand on a keyboard, so the reading-and-watching path may not reach the auditory schema you need.",
      "In your cloud work you make the same structural move across topics: you model a system as uniform and then encounter a carve-out the model did not include.",
      "Each time the failure is that the rule you had applied did not extend to that case, and nothing in your existing model flags the exception beforehand.",
      "You tend to stop at the mechanical description of a system, understanding what a deadline does without understanding why it was designed that way, so a new case still requires a fresh lookup.",
      "The unresolved 'why?' on the ack deadline and the 'still not hearing it' on tritone substitution look like the same gap in two domains: a rule held as a black box rather than something reconstructable from a design or acoustic reason.",
      "Your earlier pins that register as understanding tend to be followed weeks later by pins showing the model was never stress-tested against an edge case.",
      "Not much to go on yet about whether the next carve-out will catch you by surprise, because the pattern so far is that it does."
    ],
    "offeredTopicOrder": [
      "v1-s1",
      "v1-s2",
      "v1-s3"
    ]
  }
};

export const REFERENCE_V2: ReferenceFixture = {
  "name": "REFERENCE_SESSION_V2",
  "builtAt": "2026-08-19T06:15:37.670Z",
  "fromPinCount": 9,
  "session": {
    "targetMinutes": 15,
    "estimatedMinutes": 14.4,
    "closingNote": "The two-axis construction (letter distance vs. semitone count) and the 'why the composite index is a physical structure, not a flag' are the mechanisms that replace the rule-as-fact pins; the IAM condition exclusions (legacy roles, resource.type string, resource.name availability) are the boundary conditions to write down before the next session. Open: whether the 48-hour re-derivations for G⁷ and the Firestore query are actually attempted, and whether the IAM condition question is written out before the next IAM work.",
    "sections": [
      {
        "topicId": "v2-s1",
        "heading": "Firestore Composite Indexes: why the error is the mechanism",
        "body": "You pinned this on 8/16 with 'thought I had this' next to a where-on-status plus orderBy-on-createdAt query that threw an index error (14a110e6). The error is not a nuisance bolted onto a feature you understood; the error is the mechanism, and the mechanism is what slipped.\n\nWorked extension. Your query:\n\n  col.where('status', '==', 'active')\n      .orderBy('createdAt')\n\nFirestore must do two things at once: filter rows by status and walk the result in createdAt order. A single-field B-tree index on status sorts by status — it cannot walk the output in createdAt order without a full scan. A single-field index on createdAt sorts by createdAt — it cannot efficiently filter by status. Neither serves the query. A composite index on (status, createdAt) builds a B-tree whose key is the concatenation of both columns: rows are grouped by status value and, within each group, sorted by createdAt. That is the structure the error is asking you to create, and the reason it asks is that no such structure existed for that query shape.\n\nThe boundary you keep colliding with across services: you do not declare this index. You write the query, it parses, it looks correct, and Firestore infers the index need at execution time. The happy path — write query, get results — breaks because the constraint is implicit. You go to the Firestore console, see the suggested index definition, and create it. The collision surfaces at runtime, not at schema-design time. That is the 'what I would not expect' constraint for this feature: the requirement is invisible until the query executes and fails.\n\nNow extend the query. Add a second inequality:\n\n  col.where('status', '>', 'pending')\n      .where('priority', '<', 5)\n      .orderBy('createdAt')\n\nTwo range filters, one sort. The source you pinned says compound queries with range filters on multiple fields 'are subject to ordering constraints' (5186333f). I will keep the claim to what that passage states: the ordering of fields within the composite index is constrained, and the relationship between the filter directions and the sort direction is not free. You cannot list three fields in any sequence and expect the resulting index to serve the query. I cannot expand on the exact ordering rules beyond what that single line states, so treat the specific field-ordering as something to verify in the console when you hit the next error rather than as a rule I am handing you here. What the passage does show is that adding a second inequality does not extend the original composite index; it may require a different composite index with a different field order.\n\nThe 'why' to pin instead of the 'what': the composite index exists because a B-tree index is a sorted structure on a fixed key. To serve a filter on one column and a sort on another, you need a structure whose key spans both columns. The index is not a flag or a hint; it is a physical data structure that must be built and maintained. Firestore builds it when you accept the console suggestion, but the reason the error appears at all is that no such structure pre-existed for that query shape. Pin that causal sentence. The fact 'where + orderBy needs a composite index' is the what; the reason is that a single-column B-tree cannot simultaneously satisfy a range scan on one column and a sorted walk on another.\n\nRe-derivation, 48 hours from now, without this open: write the query that triggered your 8/16 error, state what composite index it needs, and say in one sentence why a single-field index on either column cannot serve it. If you stall at 'why,' you have kept the what and lost the mechanism. That is the same slip pattern across your cloud material: the rule sticks, the reason evaporates, and two weeks later the rule feels new again.",
        "depth": "building",
        "estimatedMinutes": 4.5,
        "sourceIds": [
          "v2-s1:src-1",
          "v2-s1:src-2"
        ],
        "mediumWarning": null,
        "question": {
          "prompt": "Extend your 8/16 query with a second inequality on a third field (e.g. where('priority', '<', 5)). State what index Firestore now needs, and say in one sentence why the original two-field composite index on (status, createdAt) is insufficient for the three-field query.",
          "kind": "free-text",
          "expectedPoints": []
        }
      },
      {
        "topicId": "v2-s2",
        "heading": "Intervals and Chords: the two-axis construction",
        "body": "You have three pinned facts and they are slipping. An interval is counted inclusively from the lower note to the higher (c41bbf41). A major third is four semitones, a minor third three; the generic name gives the letter distance, the quality gives the semitone count (02aa6679). Tertian chords stack major and minor thirds; a seventh chord has three such intervals, 2³ = 8 permutations, the all-major one is excluded because it divides the octave evenly, leaving 7 (4417a5d4). The slip is that these are stored as three separate sentences. The mechanism that holds them together is a two-axis construction, and I want you to rebuild a chord so the axes become procedural.\n\nWorked example: build G⁷ (G dominant seventh) from the root.\n\nStep 1 — first third. Generic name: a third means two letters up the diatonic sequence, three letters counted inclusively. G → A → B. That is the letter slot. Quality: major, four semitones. G + 4 semitones = B. Interval: G–B, a major third.\n\nStep 2 — second third, stacked from B. Generic: B → C → D, two letters up, a third. Quality: for a dominant seventh, minor, three semitones. B + 3 semitones = D. Interval: B–D, a minor third.\n\nStep 3 — third third, stacked from D. Generic: D → E → F, two letters up, a third. Quality: minor, three semitones. D + 3 semitones = F. Interval: D–F, a minor third.\n\nResult: G–B–D–F. The chord is 'dominant' because the first third is major and the second and third are minor. Notice that the spelling (G, B, D, F) came entirely from letter counting. The semitone counts (4, 3, 3) came from quality. The two operations are independent. That independence is the core of 02aa6679: the generic name and the quality answer different questions, and confusing them is how a correct semitone count produces a wrong spelling.\n\nNow the exclusion from 4417a5d4, applied. All three thirds major: G + 4 = B, B + 4 = D#, D# + 4 = F##, which is G. The top note lands on the root an octave up. Three major thirds tile the octave exactly (4 + 4 + 4 = 12 semitones), so the chord is an augmented triad stretched to the octave, not a seventh chord. That is the excluded eighth permutation. 8 − 1 = 7 distinct seventh-chord qualities remain. You do not need to memorise all seven names now; you need the construction: stack three thirds, choose major or minor at each step, and check that the top note is not the root.\n\nWhy the slip happens: when the material is retained as 'a major third is four semitones,' the letter-counting axis has fused into the semitone axis and dropped out. You can state the number and lose the spelling. The re-derivation exercise below forces both axes simultaneously.\n\nRe-derivation, 48 hours from now: build D minor 7th (Dm7) from scratch. D + 3 semitones (minor third, letters D-E-F) = F. F + 4 semitones (major third, letters F-G-A) = A. A + 3 semitones (minor third, letters A-B-C) = C. Result: D–F–A–C. If you get any letter distance wrong, the spelling is wrong even if the semitone counts are right, because the two axes are independent.\n\nThe construction logic above is learnable from this section. The ability to hear, by ear, whether an interval is a major or minor third is not; that discrimination is auditory and requires playing the two intervals back to back, not reading about them.",
        "depth": "building",
        "estimatedMinutes": 4.2,
        "sourceIds": [
          "v2-s2:src-1",
          "v2-s2:src-2",
          "v2-s2:src-3"
        ],
        "mediumWarning": "Discriminating a major third from a minor third by ear is an auditory skill that reading cannot build; the construction logic in this section is text-learnable, but the listening step requires playing the intervals back to back.",
        "question": null
      },
      {
        "topicId": "v2-s3",
        "heading": "IAM Condition Expressions: the gate and its exclusions",
        "body": "Start from a concrete picture. A role binding in GCP is a key that opens a door: 'service account payments-sa has the role storage.objects.getter on bucket invoices.' A condition expression is a second lock on that same door. The key works, but the door opens only if the second lock's condition is also satisfied — say, 'the request originates from an IP in 10.0.0.0/8.' The condition is an AND gate stacked on top of the role grant. The grant is active only when the expression evaluates to true (68aeabc8). That is the whole mechanism: condition is a Boolean filter on the binding, not a separate policy object.\n\nTerms, defined in order. A principal is the entity receiving the grant: a user, a service account, a group, or a domain. A role binding is a line in an access policy that attaches a role to a principal within a resource scope (organisation, folder, project, or resource). A condition expression is an optional Boolean expression attached to that binding, using a restricted set of operators and fields (request.ip, resource.type, resource.name, and a few others). Legacy basic roles are the three original, broad roles: Owner (roles/owner), Editor (roles/editor), Viewer (roles/viewer). resource.type is a field identifying the kind of resource the request targets; resource.name identifies the specific instance.\n\nNow the two constraints that your material flags as the ones you keep missing (99d5220c, marked 'THIS is what I kept missing').\n\nFirst: you cannot attach a condition to a legacy basic role. A binding that says 'grant roles/owner to user@corp.com with condition request.ip in 10.0.0.0/8' is not a valid binding. The condition must go on a custom role or a predefined role (roles/storage.admin, for example), not on Owner, Editor, or Viewer. The source states this as a hard restriction; it does not explain the reason, so I will not manufacture one. What it shows is that the legacy roles are excluded from conditional binding by design.\n\nSecond, and the one the source singles out: conditional role bindings do not override role bindings with no conditions. This is the counterintuitive point. In many policy systems, a more specific rule wins. Here, if a user has an unconditional Viewer binding on a project and also a conditional Owner binding on the same project that evaluates to false, the unconditional Viewer binding still grants read access. The conditional binding, when false, grants nothing; it does not cancel the unconditional one. The two bindings are evaluated independently, and any binding that grants access is sufficient. The condition narrows its own binding; it does not widen its authority over other bindings.\n\nTwo further constraints from reduced-confidence sources. The first: resource.name is only available for some services (4281e80e, marked 'this keeps catching me out'). The passage states this as a limitation; it does not enumerate which services expose it, so I will not list them. What it shows is that a condition referencing resource.name will fail to evaluate for services that do not expose that field, and the binding is effectively ungrantable for those services. The second: for Cloud Storage objects specifically, resource.type is 'storage.googleapis.com/Object', not 'Bucket' (8f70d1fd). The object model distinguishes the container (bucket) from the stored item (object), and the type string reflects the item. A condition written expecting 'Bucket' will not match a request for an object.\n\nThe boundary-condition pattern you carry across services applies here: the happy path is 'attach a condition to any binding, reference any resource attribute, and it works.' The constraints are: legacy roles are excluded; resource.name may not exist for the service you are targeting; resource.type strings are specific and not what the UI label suggests. Write those three constraints down before your next IAM session, because they are the ones that re-surface as 'I thought I had this.'",
        "depth": "from-nothing",
        "estimatedMinutes": 5.7,
        "sourceIds": [
          "v2-s3:src-1",
          "v2-s3:src-2",
          "v2-s3:src-3",
          "v2-s3:src-4"
        ],
        "mediumWarning": null,
        "question": {
          "prompt": "Write a condition expression that grants a service account read access to Cloud Storage objects only when the request originates from a specific IP range, using resource.type. Then state, in one sentence, why that same condition cannot be attached to a roles/owner binding.",
          "kind": "free-text",
          "expectedPoints": []
        }
      }
    ]
  },
  "board": {
    "topics": [
      {
        "id": "v2-s1",
        "label": "Firestore Composite Indexes: why the error is the mechanism",
        "summary": "",
        "pinIds": [
          "v2-s1-pin"
        ],
        "state": "working",
        "comfort": 0.4,
        "lastExposedAt": null,
        "retiredByUser": false,
        "createdAt": "2026-08-01T00:00:00.000Z"
      },
      {
        "id": "v2-s2",
        "label": "Intervals and Chords: the two-axis construction",
        "summary": "",
        "pinIds": [
          "v2-s2-pin"
        ],
        "state": "working",
        "comfort": 0.4,
        "lastExposedAt": null,
        "retiredByUser": false,
        "createdAt": "2026-08-01T00:00:00.000Z"
      },
      {
        "id": "v2-s3",
        "label": "IAM Condition Expressions: the gate and its exclusions",
        "summary": "",
        "pinIds": [
          "v2-s3-pin"
        ],
        "state": "working",
        "comfort": 0.4,
        "lastExposedAt": null,
        "retiredByUser": false,
        "createdAt": "2026-08-01T00:00:00.000Z"
      }
    ],
    "offeredSourceIds": [
      "v2-s1:src-1",
      "v2-s1:src-2",
      "v2-s2:src-1",
      "v2-s2:src-2",
      "v2-s2:src-3",
      "v2-s3:src-1",
      "v2-s3:src-2",
      "v2-s3:src-3",
      "v2-s3:src-4"
    ],
    "knownAboutLearner": [
      "Across several cloud services you build a model of the happy path and then keep colliding with a boundary condition that was never part of it.",
      "You tend to pin the WHAT of a rule and stop there, leaving the mechanism unexamined; you have written 'why?' next to Pub/Sub's ack deadline without tracing back what forces that structure.",
      "Your sense that a topic is mastered tends to outrun what you actually retain, and you come back surprised by gaps that reopen after some weeks.",
      "With jazz voice-leading you are absorbing material through text and video, but the discrimination the skill requires is auditory, and a week after the tritone-substitution mechanism was explained you wrote that you still cannot hear it.",
      "Firestore composite indexes and music intervals are both slipping after a period of progress.",
      "IAM condition expressions are where you are struggling most clearly at the moment.",
      "Cloud Run instance lifecycle is the topic you are most comfortable with.",
      "Pub/Sub delivery and ordering is still in progress for you."
    ],
    "offeredTopicOrder": [
      "v2-s1",
      "v2-s2",
      "v2-s3"
    ]
  }
};
