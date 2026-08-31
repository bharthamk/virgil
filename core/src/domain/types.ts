/**
 * Virgil — domain types.
 *
 * This file describes what the product is, in terms no vendor owns.
 * Nothing here may import an SDK, touch I/O, or know what a Gemini is.
 */

import type { ModelBudget, ModelSpend } from './model-budget.js';

export type PinId = string;
export type TopicId = string;
export type SessionId = string;
export type SignalId = string;
export type SourceId = string;

/** Stable product modes. Provider-specific model ids remain adapter concerns. */
export type ModelMode = 'cloud' | 'local' | 'cli';

/**
 * The three workloads a learner can route independently. Image work takes
 * precedence over tier; non-image requests retain the existing fast/deep split.
 */
export type ModelRoute = 'quick' | 'deep' | 'images';

/** Which product modes this learner has deliberately made available. */
export interface ModelProviderToggles {
  readonly cloud: boolean;
  readonly local: boolean;
  readonly cli: boolean;
}

/** The provider assigned to each workload. */
export interface ModelRoutes {
  readonly quick: ModelMode;
  readonly deep: ModelMode;
  readonly images: ModelMode;
}

// ---------------------------------------------------------------- capture

/** the two pin types get genuinely different downstream treatment. */
export type PinType = 'interest' | 'struggle';

/** a struggle pin is often several parts with distinct roles. */
export type PartRole = 'passage' | 'my-answer' | 'correct-answer' | 'error' | 'fix';

export interface CapturePart {
  readonly role: PartRole;
  readonly text: string;
}

export interface MediaRef {
  readonly kind: 'image' | 'video-frame' | 'pdf-page';
  /** Data URI or a durable local reference. Never a hotlink we might lose. */
  readonly ref: string;
  readonly videoUrl?: string;
  readonly timestampSeconds?: number;
  readonly captions?: string;
}

/**
 * Why a pin that was made *about* an image is carrying no image.
 *
 * The three are the three ways capture can come back empty-handed, and they are
 * kept apart because they mean different things to whoever reads the store
 * later: `fetch-failed` is a page that would not give up its bytes, and might
 * on another day; `not-an-image` is a 200 that was a sign-in page or a format
 * the vision path cannot read, and never will be; `too-large` is a deliberate
 * refusal on our side.
 *
 * Recorded rather than left blank because a pin with no image and a pin whose
 * image was dropped are different pins, and only one of them is worth asking
 * the learner about.
 */
export type MediaOmitted = 'fetch-failed' | 'not-an-image' | 'too-large';

/**
 *  — where the playhead was when the learner reached for the hotkey.
 *
 * Deliberately not a `MediaRef`. That type's `ref` is a picture we hold, and
 * this is not one: the visible frame the product contract asks for cannot be taken from a
 * content script on a cross-origin player, and inventing a `ref` for a frame
 * that does not exist would put a claim in the one field that is supposed to be
 * the artefact itself.
 *
 * `player` is how the timestamp was read, and it is the field that decides
 * whether a link can carry it. Only some sites have a convention for seeking
 * from a url, and `domain/video.ts` will build one only where the convention is
 * real.
 */
export interface VideoMoment {
  /** Whole seconds. No link seeks to a fraction and no player displays one. */
  readonly timestampSeconds: number;
  readonly player: 'youtube' | 'html5';
}

/**
 * re-fetch will fail on gated pages, so capture-time context must be
 * rich enough to teach from on its own. This envelope is deliberately fat.
 */
export interface CaptureEnvelope {
  readonly selection: string | null; // null for a whole-page pin ()
  readonly parts: readonly CapturePart[];
  readonly surroundingText: string;
  readonly headingPath: readonly string[];
  readonly pageTitle: string;
  readonly url: string;
  readonly canonicalUrl: string | null;
  readonly siteName: string | null;
  readonly contentLanguage: string | null;
  readonly media: MediaRef | null;
  /**
   * Set when this pin was made about an image and the image is not here.
   *
   * Optional and nullable for the reason every other late field on this type is:
   * a pin captured before the bytes were fetched at capture has no answer to
   * give, and `undefined` and `null` both mean nothing was dropped.
   */
  readonly mediaOmitted?: MediaOmitted | null;
  /**
   * the moment in a video this pin was made at, when there was one.
   *
   * Optional and nullable like the two above, and for a third reason as well:
   * most pins are not made on a video at all, and a page with no player has no
   * answer to give rather than a missing one.
   */
  readonly videoMoment?: VideoMoment | null;
  /**
   * which page of the PDF this came off, where the viewer said.
   *
   * Usually it does not say. Chrome's viewer reads `#page=N` on the way in and
   * writes nothing as the reader scrolls, so this is set for a paper opened at
   * a page and null for one scrolled to it — and null is the honest answer,
   * rather than page one dressed up as a reading position.
   */
  readonly pdfPage?: number | null;
}

export interface Pin {
  readonly id: PinId;
  readonly type: PinType;
  readonly envelope: CaptureEnvelope;
  /** a scrap of intent, high signal, cheap to give. */
  readonly note: string | null;
  /**
   * What the Scout called it when the pin was made.
   *
   * It was computed at creation, shown on the toast, and thrown away. The
   * consequence was visible on every foreground surface: with no topic yet,
   * the quick take headed itself from `fallbackLabel`, which is the page's
   * deepest heading, so a take about derivatives was titled "Prerequisites"
   * and a learner reading it got the section rather than the subject.
   *
   * It also made the idempotent retry answer differently from the first post,
   * which was recorded as a known inconsistency and is now simply gone.
   *
   * Not the topic's label and never a substitute for it. Once clustering has
   * run, the topic is what this pin belongs to and its label is what it is
   * called; this is only what to say before that has happened.
   */
  readonly label?: string | null;
  readonly capturedAt: string;
  /**
   * The client's own name for this pin, where it gave one.
   *
   * A pin is posted with a 2.5 second budget, which is the toast's patience
   * rather than the network's, and a post that runs over it is abandoned and
   * queued for the drain to retry. Nothing made that retry idempotent, so a
   * request the service had in fact completed came back a minute later and
   * became a second pin. A captured regression fixture contains two `data`
   * pins carrying the same `capturedAt` to the millisecond, which is one
   * gesture, because that stamp is taken once per gesture.
   *
   * So the client names the pin and the service honours the name. Optional
   * rather than nullable: every pin already on a board predates it, and the
   * ones the service makes itself have no client and cannot be retried by one.
   */
  readonly clientRef?: string | null;
  /**
   * The depth the learner asked for on this material, where they asked.
   *
   * Standard's effort choice (2026-08-22). It outranks the ledger's own read
   * on the surfaces that teach this one pin, because it is the learner looking
   * at this passage and saying how much of it they want, which is a better
   * answer for this passage than a comfort score averaged over a topic.
   *
   * It does not outrank the ledger anywhere else. Comfort is evidence about a
   * person and this is a preference about one piece of material; a preference
   * that rewrote the evidence would be the learner grading themselves.
   */
  readonly requestedRegister?: DepthRegister | null;
  /**
   * How long the learner asked for on this material, in minutes.
   *
   * The second half of Standard's lesson level, and the reason four options
   * fit on three registers: a refresher and a deep dive can assume the same
   * knowledge and be nothing alike. Null where they did not say, which is
   * every pin that did not come from that box.
   */
  readonly requestedMinutes?: number | null;
  /**
   * The learner's last answer after they tried the saved source link.
   *
   * Optional for every historical pin and deliberately learner-authored. A
   * service-side probe cannot distinguish a dead page from a sign-in wall or
   * prove that returned words still match the capture. Replacing this receipt
   * never changes the capture envelope or derived learning.
   */
  readonly sourceAvailability?: {
    readonly status: 'available' | 'unavailable';
    readonly checkedAt: string;
    readonly checkedBy: 'learner';
  } | null;
  /**
   * Service-owned receipt for the last quick-take attempt that did not ship.
   * Operational truth only: it changes no comfort, topic state or progression.
   */
  readonly quickTakeFailure?: QuickTakeFailureReceipt | null;
  /** true when this began as an agent suggestion the user confirmed. */
  readonly fromSuggestion: boolean;
  readonly enrichment: Enrichment | null;
  readonly topicId: TopicId | null;
}

export type QuickTakeFailureReason =
  | 'generation-failed'
  | 'source-drift'
  | 'verifier-defect'
  | 'verifier-unreadable';

export interface QuickTakeFailureReceipt {
  readonly materialKey: string;
  readonly register: DepthRegister;
  readonly minutes: number;
  readonly reason: QuickTakeFailureReason;
  readonly attemptedAt: string;
}

// ------------------------------------------------------------- enrichment

/** every taught claim traces to a pin or to agent-sourced material. */
export interface SourceRecord {
  readonly id: SourceId;
  readonly origin: 'user-pin' | 'agent-sourced';
  readonly url: string | null;
  readonly title: string | null;
  readonly retrievedAt: string | null;
  readonly pinId: PinId | null;
}

/**
 * What actually happened when this pin was enriched.
 *
 * The three answers were previously one answer. Forager catches its own model
 * failure and returns an empty `assumedConcepts` list, which is exactly what it
 * also returns when the model read the passage and found it self-contained — so
 * a run where 19 of 21 model calls failed and a run where the passages were
 * genuinely self-contained left identical records in the store, and the stage
 * line counted neither. That is the safe-empty-state constraint shape: nothing failed, and the product
 * was wrong.
 *
 *  - `enriched`      — the model answered with something usable.
 *  - `nothing-found` — the model answered, and the honest answer was nothing.
 *  - `model-failed`  — the call did not produce an answer. The pin still holds a
 *                      capture-envelope-only enrichment, because enrichment is
 *                      an improvement and never a gate, but it is the only one
 *                      of the three that is owed another attempt.
 *
 * Deliberately NOT a place to record re-fetch failure: that is a separate axis
 * and `confidence` already carries it. A pin can have a failed re-fetch and a
 * perfectly good model answer, and one field cannot say both.
 */
export type EnrichmentOutcome = 'enriched' | 'nothing-found' | 'model-failed';

export interface Enrichment {
  readonly refetchedText: string | null;
  /** Concepts the passage leans on but does not itself explain. */
  readonly assumedConcepts: readonly string[];
  readonly mediaDescription: string | null;
  readonly references: readonly SourceRecord[];
  /**
   * Why `assumedConcepts` looks the way it does. Persisted so the store is
   * diagnosable after the fact rather than only while the run is on screen.
   */
  readonly outcome: EnrichmentOutcome;
  /**
   * when re-fetch failed we ran on capture-time context alone.
   * The Composer must narrow its claims rather than compensate.
   */
  readonly confidence: 'full' | 'reduced';
  readonly enrichedAt: string;
}

// ------------------------------------------------------------------ topics

export type TopicState = 'working' | 'settled' | 'waiting';

export interface Topic {
  readonly id: TopicId;
  readonly label: string;
  readonly summary: string;
  readonly pinIds: readonly PinId[];
  readonly state: TopicState;
  /** 0..1 derived, never shown as a number (). */
  readonly comfort: number;
  readonly lastExposedAt: string | null;
  /** retired by the user. Distinct from deleted (). */
  readonly retiredByUser: boolean;
  readonly createdAt: string;
  /**
   * True while nothing has ever *named* this topic — it is carrying a stopgap
   * taken from a heading or a page title.
   *
   * The clusterer's identity promise is that an existing topic keeps its name:
   * a topic the learner has been reading for a month must not be renamed
   * overnight. A prior fixture showed that promise protecting a row four
   * milliseconds old, invented by `topicForOrphan` so a *still shaky* signal
   * would have somewhere to live, and named from the page title because no
   * model had been asked and none was going to be. It read
   * *"How to write a short story | National"* and nothing was ever going to
   * change it.
   *
   * So the two cases are separated. A provisional topic is offered to the
   * naming pass at the first opportunity; the moment it has a name the flag
   * clears and the promise applies in full.
   *
   * **Optional, and absent means named.** Every row already in every store
   * predates this field, and reading those as nameable would rename real
   * topics on the next run — the exact thing the promise forbids.
   */
  readonly provisionalName?: boolean;
}

/** ordering must be explainable in one line. */
export interface PrereqEdge {
  readonly from: TopicId;
  readonly to: TopicId;
  readonly confidence: number;
  readonly justification: string;
}

// ----------------------------------------------------------------- signals

export type SignalType =
  | 'answer-correct' | 'answer-wrong' | 'recall-check'
  /** Real assessed results. Stronger evidence than a completion tick or a
   * learner declaration, and causally tied to an outcome receipt. */
  | 'assessed-strong' | 'assessed-gap'
  | 'qc-finding'
  | 'depth-simpler' | 'depth-deeper'
  | 'pin-struggle' | 'pin-interest'
  | 'self-skip'
  | 'section-completed' | 'section-abandoned'
  | 'reread-confirmed'
  | 'interview-seed'
  | 'user-model-edit'
  /**
   *  — "come back to this", with its one nuance.
   *
   * Two types rather than one type with a field, because they are not the same
   * statement about comfort and the ledger has no room for a qualifier. Asking
   * for a *refresher* is the learner saying the level was above them; asking to
   * go *deeper* is the learner saying it was below them. Folding both into one
   * negative signal would make "teach me more of this" evidence that they are
   * struggling with it, which is the opposite of what they said.
   *
   * Both are the learner's own read, so both are declared rather than
   * demonstrated and are weighted as such. Both put the topic on the
   * flagged list, because both are the learner asking for it back.
   */
  | 'resurface-refresher'
  | 'resurface-deeper'
  /**
   *  — the two taps that close a quick take (UX_SPEC §3).
   *
   * Two types rather than one with a direction field, for the same reason the
   * resurface marks are two: they are opposite statements and the ledger has no
   * room for a qualifier. They are also the only signals in this list that can
   * arrive on **day zero of a topic**, which is the whole reason the quick take
   * exists — *"a signal instrument that happens to also teach"*.
   *
   *  places them exactly: *"stronger than declared-only evidence, weaker
   * than repeated demonstrated competence"*. `domain/signals.ts` is where that
   * sentence is a number. It is a real read of their comfort — they read an
   * explanation and answered about it — and it is still their own read rather
   * than an answer anybody marked, so it never joins `DEMONSTRATED_TYPES`: a
   * recall chain that a self-report could extend is a chain the tap farms.
   */
  | 'quick-take-got-it'
  | 'quick-take-still-shaky'
  /**
   * The learner-lineup contract — the three marks the learner makes on the LINEUP, before any
   * of it has been read.
   *
   * They are preferences about **what was chosen**, and they are the only
   * signals in this list that are not evidence about what anybody knows.
   *
   * The distinction is load-bearing and is enforced structurally rather than by
   * convention: `domain/signals.ts` excludes them from `SIGNAL_WEIGHT` by TYPE,
   * so the comfort model cannot weigh one even by accident. A thumbs-down on a
   * choice is the learner saying *not this*, and reading it as *I am bad at
   * this* would be the product inferring ability from taste — the exact failure
   *  weight table exists to prevent, arriving through a new door.
   *
   * What they do reach is the Gardener's ranking, which is where a preference
   * belongs: `lineup-good-call` lifts the topic, `lineup-bad-call` lowers it,
   * and `lineup-not-now` holds it out of selection for a short, stated window.
   *
   *  - `lineup-good-call`  — thumbs up on the choice. Positive.
   *  - `lineup-bad-call`   — thumbs down on the choice. Negative.
   *  - `lineup-not-now`    — the X. Neutral, because "not tonight" is a
   *                          statement about timing and not about the topic.
   */
  | 'lineup-good-call'
  | 'lineup-bad-call'
  | 'lineup-not-now'
  /**
   * `mode-guide-me`: the learner said they were stuck on one step of a task.
   *
   * Its own type rather than reusing `pin-struggle`, because the two are not
   * the same statement. A struggle pin says "this subject is hard for me",
   * declared before reading anything. This says "I could not do this step",
   * which is demonstrated, in the middle of trying, and is the strongest
   * negative evidence this product can collect short of a wrong answer. It is
   * weighted as demonstrated for exactly that reason.
   */
  | 'guide-stuck';

export type SignalDirection = 'positive' | 'negative' | 'neutral';

/** demonstrated comfort must outweigh declared comfort. */
export interface Signal {
  readonly id: SignalId;
  readonly topicId: TopicId;
  readonly type: SignalType;
  readonly direction: SignalDirection;
  readonly at: string;
  readonly sourceEvent: string;
  /** a conceded error invalidates signals derived from that section. */
  readonly invalidated: boolean;
}

/** A learner-authored insight becomes authoritative prompt context. Keep one
 * sentence generous, but bounded enough that a paste cannot destabilise every
 * later lesson. Machine-authored statements share the stored shape but are
 * separately bounded by Registrar output. */
export const LEARNER_STATEMENT_MAX_CHARS = 1_000;

/**
 * the four kinds of demand a piece of material can make.
 *
 * A closed vocabulary, and closed is the whole safety property: a model asked
 * what kind of thing a topic is will otherwise invent categories for ever, and
 * each one would land on a screen as a claim about a person. The meanings, the
 * counting and the refusal live in `domain/modality.ts`.
 *
 * These describe MATERIAL. Nothing here is a learning style, a diagnosis, or a
 * property of the learner.
 */
export type ModalityKind = 'notation-heavy' | 'language-recall' | 'logic-structure' | 'hands-on';

/**
 * What makes a statement a modality question rather than a machine read.
 *
 * Present only on the one statement this feature produces. `confirmedAt` is the
 * whole claim-discipline law in one nullable field: until a person has said
 * yes, this sentence is a question, it is excluded from every teaching brief,
 * and nothing in the product may act on it.
 */
export interface ModalityMark {
  /** `slower|faster`. Ours, and what a denial is recorded against. */
  readonly key: string;
  readonly slower: ModalityKind;
  readonly faster: ModalityKind;
  readonly askedAt: string;
  /** When the learner agreed with it, or null while it is still a question. */
  readonly confirmedAt: string | null;
}

/**
 * The learner saying no to a modality question, and when.
 *
 * Stored in preferences beside `setAside` and for the identical reason: it is
 * an instruction about what a surface may raise, not evidence about what
 * somebody knows, so it must never reach the signal ledger. `PUT /prefs` does
 * not accept it, because the patch validator does not name the field, so the
 * only way in or out is answering the question it is about.
 */
export interface ModalityDenial {
  readonly key: string;
  readonly at: string;
}

/** the model must render as editable prose, which constrains storage. */
export interface Statement {
  readonly id: string;
  readonly text: string;
  readonly topicId: TopicId | null;
  readonly userEdited: boolean;
  /** A machine read the learner rejected. Kept as an invisible evidence
   * receipt so the same evidence cannot recreate it on the next run. */
  readonly rejected?: boolean;
  readonly evidenceSignalIds: readonly SignalId[];
  readonly updatedAt: string;
  /**
   * When the learner said this sentence, as written, is right.
   *
   * The third state this record can be in, and the one that was missing. A
   * statement was either the machine's prose or the learner's words, and the
   * only route between them rewrote the sentence and took the authorship with
   * it. That left no way at all to say "yes, that one" about a read somebody
   * agreed with, so every read on the board stayed a guess for ever, however
   * many times a person had nodded at it.
   *
   * Set by the confirm door and by nothing else. It never changes the text and
   * never sets `userEdited`: the words are still Virgil's, and what is recorded
   * is that a person endorsed them. Two things read it, and both were already
   * reading `modality.confirmedAt` for exactly this: the night scout, which
   * drops its "this is my read, not your words" caveat, and the statements
   * stage, which stops treating the row as its own prose to replace.
   *
   * Absent on every statement written before the door existed, which reads as
   * unconfirmed. That is the honest default: nobody was ever asked.
   */
  readonly confirmedAt?: string | null;
  /**
   * , and absent on every ordinary statement.
   *
   * Present, it means this row is the one modality contrast the board is
   * allowed to hold: a question while `confirmedAt` is null, an ordinary
   * confirmed statement once it is not. It also exempts the row from the
   * nightly replace in the statements stage, which exists to stop machine
   * prose piling up and has no business deleting a sentence a person answered.
   */
  readonly modality?: ModalityMark;
}

// ---------------------------------------------------------------- sessions

/** three registers in one session is the differentiator. */
export type DepthRegister = 'from-nothing' | 'building' | 'fluent';

export interface SessionQuestion {
  readonly prompt: string;
  readonly kind: 'free-text' | 'recall';
  readonly expectedPoints: readonly string[];
}

/** the durable exchange when a learner challenges Virgil's teaching.
 * The original claim stays beside the reply so a reload cannot make a
 * concession look like the lesson always said the corrected thing. */
export interface LessonCorrection {
  readonly id: string;
  readonly clientRef: string;
  readonly claim: string;
  readonly challenge: string;
  readonly reply: string;
  readonly conceded: boolean;
  readonly sourceIds: readonly SourceId[];
  readonly withdrawn: number;
  readonly at: string;
}

export interface SessionSection {
  readonly topicId: TopicId;
  readonly heading: string;
  readonly body: string;
  readonly depth: DepthRegister;
  /**
   * Time reserved for doing or answering, separate from reading. Absent on
   * sessions written before learner actions became part of the time promise.
   */
  readonly actionMinutes?: number;
  readonly estimatedMinutes: number;
  readonly question: SessionQuestion | null;
  /** every claim carries provenance, structurally not in prose. */
  readonly sourceIds: readonly SourceId[];
  /** Learner-triggered source rechecks, in the order they happened. */
  readonly corrections?: readonly LessonCorrection[];
  /**
   * Why the ranker put this section in tonight's lineup, in its own words.
   *
   * The learner-lineup contract’s `(i)`. The Gardener already writes one reason per topic and
   * the Composer is already handed it — `why now:` is a line in the brief — and
   * both threw it away the moment the prose came back, so the only surface that
   * could say why anything was chosen was the card's single highest-priority
   * line about the whole night.
   *
   * Carried on the section rather than recomputed at read time so the sentence
   * the learner opens is the one the run actually ranked on. A reason worked
   * out afterwards would agree with the ranking on most nights and drift from
   * it on exactly the night somebody asks.
   *
   * Optional and nullable because every session composed before this has none.
   * `/session` fills those in from the same pure ranker at read time, which is
   * the honest fallback: it is the Gardener's real reason for that topic, just
   * read now rather than then, and it is the only answer a row with no stored
   * reason has.
   */
  readonly why?: string | null;
  readonly recap?: string | null;
  /**
   * One line naming what this section COVERS, for somebody choosing whether to
   * start it.
   *
   * Written by the Composer in the same call that writes the section. It is
   * deliberately not `recap`: a recap is for a learner coming back who has
   * already read this, and this is read on a list by a learner who has not
   * opened it. A good lesson very
   * often opens on an analogy, and an analogy with no lesson under it is not a
   * description of anything.
   *
   * Optional because every session composed before this has none. Those fall
   * back to the topic's own summary at read time, which is the Clusterer's
   * one sentence naming what the learner is trying to understand, and to
   * nothing at all when there is not one. Never to the body.
   */
  readonly summary?: string | null;
  readonly completed: boolean;
  /**
   * The learner action that completed this section. Optional for sessions
   * written before the close learned to distinguish an answer from “I know
   * this”; absence remains valid legacy evidence rather than being guessed.
   */
  readonly completionEvidence?: 'answer' | 'known';
  /**
   * The learner said the answer marking on this section was wrong, and the
   * signals derived from that mark were withdrawn.  teaching challenge
   * is recorded separately in `corrections`.
   *
   * Optional because absent is the honest state for every section ever composed
   * — the Composer does not decide this and should not have to name it — and
   * because a session written before the concession path existed has no answer
   * to give. `undefined` and `false` mean the same thing and are read as such.
   */
  readonly contested?: boolean;
  /**
   * "Reading will not close this — here is what to go and do."
   *
   * The Composer has produced this since it was written and the pipeline has
   * persisted it since it was written, and it was never on this type: the panel
   * declared it locally off the wire, and every reader in `core/` was blind to
   * a field that was already in the store. Declared here because the
   * progression projection awards *medium follow-through* from it, and a badge
   * derived from an undeclared field is a badge derived from a coincidence.
   *
   * Optional and nullable for the same reason `contested` is: a section written
   * before the warning existed has no answer to give, and `undefined` and
   * `null` both mean there was no warning.
   */
  readonly mediumWarning?: string | null;
}

/**
 * A section the Verifier did not clear, kept with the session it was cut from.
 *
 * The nightly has always computed this and always thrown it away at the end of
 * the run, so a night that composed four sections and withheld all four was
 * stored as a session with no sections — and the panel said "Nothing ready
 * yet", which is §3a's last row exactly: every stage green, the learner told
 * something untrue. The withhold is the safety check working, and §5 says the
 * UI is to name it rather than be embarrassed by it. It cannot name what the
 * store does not keep.
 *
 * Deliberately thin. The defects themselves are the run's business and are in
 * the run log; what the learner is owed is that a section existed, what it was
 * about, and which of the two things happened to it.
 */
export interface WithheldNote {
  readonly topicId: TopicId;
  readonly heading: string;
  /** `defective` — the check ran and found a fatal problem. `unverified` — the
   *  check could not run at all, which is a different fact and is not folded in. */
  readonly reason: 'defective' | 'unverified';
}

export interface Session {
  readonly id: SessionId;
  readonly builtAt: string;
  /**
   * Which night this session is for — the batch-key alignment contract.
   *
   * `YYYY-MM-DD`, and **not** derivable from `builtAt`. The two agree on almost
   * every night and the exception is the one that costs a learner a session: a
   * run that begins before midnight UTC and whose retry finishes after it has
   * an honest `builtAt` on the far side of a date boundary and belongs to the
   * night on the near side. Everything that asked `builtAt` which night this was
   * — the trigger's guard, the Firestore document name — was reading a proxy,
   * exact only while a run's clock and its night agree.
   *
   * So the night is decided once, by whoever knows: the trigger, from an
   * instant the message carries, or the run's own start when nothing triggered
   * it. It travels here because a `Session` is what crosses into the store, and
   * a fact that does not travel with the row is a fact the row's reader has to
   * guess at.
   *
   * Optional because absent is the honest answer for every session written
   * before the field existed, and those rows still have `builtAt` — which is
   * what they were named from and is the only evidence they carry.
   */
  readonly batchKey?: string;
  readonly fromPinCount: number;
  readonly targetMinutes: number;
  readonly estimatedMinutes: number;
  readonly sections: readonly SessionSection[];
  /** resume is section-granular, and stale resumes need a recap. */
  readonly currentSectionIndex: number;
  readonly closingNote: string | null;
  /**
   * this is the revision offer — "not enough new to build a proper
   * session; here is a five-minute refresh on two things from last week" —
   * rather than a session.
   *
   * Optional because absent is the honest answer for every session composed
   * before the offer was wired, and because a full session is what a session is
   * unless something says otherwise. `undefined` and `false` mean the same
   * thing and are read as such.
   */
  readonly revision?: boolean;
  /**
   * What the Verifier refused, so the panel can say so.
   *
   * Optional because absent is the honest answer for every session written
   * before the field existed, and because most nights withhold nothing.
   * `undefined` and `[]` mean the same thing and are read as such.
   */
  readonly withheld?: readonly WithheldNote[];
}

// ------------------------------------------------------------- suggestions

/** never auto-promoted to a pin. Always confirmed by the user. */
export interface Suggestion {
  readonly id: string;
  readonly passage: string;
  readonly url: string;
  readonly reason: string;
  readonly raisedAt: string;
  readonly state: 'pending' | 'accepted' | 'rejected';
  /**
   * Enough of the page for the pin this becomes to have an honest envelope.
   *
   * Accepting a suggestion makes a real pin ( step 4), and a pin with no
   * title and no heading path is a pin the Scout cannot label and the Clusterer
   * has to guess at. The detector already reads both — it walks the heading path
   * to decide what the passage sits under — so carrying them costs nothing and
   * not carrying them would mean the confirmed suggestion produced a worse pin
   * than the same passage selected by hand.
   */
  readonly pageTitle: string | null;
  readonly headingPath: readonly string[];
}

import type { LearningSchedule } from './schedule.js';
import type { DegradeReason } from './provider-failure.js';

export interface HostedProcessingSummary {
  readonly outcome: 'session' | 'no-session' | 'quota-degraded' | null;
  readonly outcomeReason: 'nothing-to-teach' | 'model-failed' | 'learner-context-changed' | null;
  readonly reports: readonly {
    readonly stage: string;
    readonly ms: number;
    readonly failed: boolean;
    readonly degradeReason?: DegradeReason | null;
  }[];
  readonly remaining: number;
  readonly withheld: number;
  /**
   * The run produced no observation, no statement and no proposal.
   *
   * Optional because every receipt written before this field existed carries no
   * answer to the question, and absent must read as "not known" rather than as
   * "not lean".
   */
  readonly lean?: boolean;
}

// --------------------------------------------------------------- the user

/**
 * Service-owned receipt for model work handed to a durable hosted worker.
 *
 * It lives beside preferences because every shipped store already persists
 * that document atomically, but it is not a preference and `PUT /prefs` never
 * accepts it. Optional for every local and pre- board.
 */
export interface HostedProcessingReceipt {
  /** Per-dispatch nonce. A late retry must not close a newer run on the same day. */
  readonly receiptId: string;
  readonly state: 'launching' | 'queued' | 'running' | 'finished' | 'failed';
  readonly batchKey: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly checkedAt: string;
  readonly asked: boolean;
  readonly unprocessedPins: number;
  /** Bounded worker result: no prompts, prose detail, provider bodies or errors. */
  readonly result?: HostedProcessingSummary | null;
}

export interface LearnerPrefs {
  readonly targetMinutes: 5 | 15 | 45;
  readonly interfaceLanguage: string;
  /**
   * The learner's current IANA zone, observed by their browser.
   *
   * Separate from `schedule`: on-demand learners still have a today, a due
   * date and an on-time boundary. Optional for boards created before local-day
   * planning; absent fails back to UTC until a browser reports it.
   */
  readonly timeZone?: string;
  /** pause must genuinely stop collection, not just hide the UI. */
  readonly pausedUntil: string | null;
  /** ships with sensible defaults, not empty. */
  readonly excludedDomains: readonly string[];
  readonly interview: Readonly<Record<string, string>>;
  /**
   * how many suggestions the learner has turned down, per site.
   *
   * the product contract asks that repeated rejections *quiet the detector, not just filter
   * its output*, and a state flip on the suggestion cannot do that — the next
   * passage on the same page raises exactly as loudly. This is the counter that
   * closes it: the content script reads it before it starts observing anything,
   * and stops raising on a site that has already been told no twice.
   *
   * Keyed by origin rather than by hostname so that a rejection on one site
   * cannot quiet another that merely shares a registrable domain.
   */
  readonly rejectedOrigins: Readonly<Record<string, number>>;
  /**
   * When this learner's sessions get built.
   *
   * Theirs, in their own zone, or on no clock at all. Optional because every
   * board predates it, and absent reads as `DEFAULT_SCHEDULE`, which builds
   * nothing until they ask. See `domain/schedule.ts`.
   */
  readonly schedule?: LearningSchedule;
  /**
   * Process automatically once this many things have piled up, or absent for
   * never — which is the default.
   *
   * This replaced the hour-of-day schedule as the thing that triggers work.
   * A count is learner-controlled; a clock is not, because it fires
   * whether or not there is anything to do. See `domain/batch.ts`.
   */
  readonly autoAfter?: number | null;
  /**
   * Whether the night may propose material the learner has not collected.
   *
   * On unless they say otherwise, and absent reads as on: every board written
   * before this existed is a board whose owner never turned it off. It is a
   * preference rather than a setting with machinery behind it, because the
   * thing it governs is one stage that writes nothing. Off means the stage
   * reports that it was not wanted and the night is otherwise identical.
   */
  readonly prospect?: boolean;
  /**
   * What the learner has said they are setting aside on purpose, and when.
   *
   * Keyed by item, valued with the instant they said it. It lives beside
   * `pausedUntil` and `rejectedOrigins` because it is the same kind of thing as
   * both: a learner's own instruction that a surface is to stop raising
   * something, held for a stated window rather than for ever.
   *
   * It is deliberately NOT in the signal ledger. A deferral is a statement
   * about what somebody intends to do with their fortnight, and the ledger is
   * evidence about what they know; a mark that could reach the comfort model
   * would let "not this fortnight" be read as "I am bad at this", which is the
   * failure  weight table exists to prevent arriving through a new door.
   *
   * `PUT /prefs` does not accept it — the patch validator does not name the
   * field — so the only way in is the control on the row it is about.
   */
  readonly setAside?: Readonly<Record<string, string>>;
  /**
   * the learner's answer of no to a modality question, and when.
   *
   * Here for exactly the reasons `setAside` is here, and the reasoning is worth
   * repeating rather than referring to, because this one is about a claim
   * rather than about a deadline. Somebody saying "no, that is not how it goes
   * for me" is an instruction to stop raising it. It is NOT a mark against
   * their comfort on anything, and a record that could be reached from the
   * ledger would let a denial be read as evidence about the very material it
   * denies a pattern in.
   *
   * `PUT /prefs` does not accept it, because the patch validator does not name
   * the field. The only door is the answer on the question itself, which is
   * what makes the thirty day window a promise rather than a default.
   */
  readonly modalityDenied?: ModalityDenial | null;
  /** Durable worker state. Service-owned; see `HostedProcessingReceipt`. */
  readonly hostedProcessing?: HostedProcessingReceipt | null;
  /** Last duration chosen on Today. Optional for pre-A+ boards. */
  readonly availableMinutes?: 1 | 3 | 5;
  /**
   * Where model work runs. Optional on existing boards; absence is resolved by
   * the service's declared default, which is Cloud in the shipped product.
   * Endpoints are preferences, never credentials.
   */
  readonly modelMode?: ModelMode;
  /**
   * Optional because existing boards predate provider toggles. When absent,
   * `modelMode` remains the migration fallback and implicitly enables the one
   * provider it names.
   */
  readonly modelProviders?: ModelProviderToggles;
  /** Optional per-workload routes. Absence preserves the legacy global mode. */
  readonly modelRoutes?: ModelRoutes;
  readonly localModelEndpoint?: string;
  readonly cliModelEndpoint?: string;
  /**
   * The spend limit the learner set, or absent/null for no limit — which is
   * the default and what every board written before this existed carries.
   *
   * Stored beside the model configuration because it is the same kind of thing:
   * a service-side decision about where model work may run, made once and read
   * on every call. See `domain/model-budget.ts` for why it is denominated in
   * tokens and why it guards the cloud connection only.
   */
  readonly modelBudget?: ModelBudget | null;
  /**
   * What has been spent in the current window, per connection.
   *
   * A ledger rather than a preference, and here rather than in its own store
   * collection for one reason: a budget that forgets on restart is not a
   * budget, and `getPrefs`/`putPrefs` is the one persistence path both shipped
   * stores already implement. It is never written by `PUT /prefs` — the patch
   * validator does not accept the field — and it never touches the learning
   * ledger.
   */
  readonly modelSpend?: ModelSpend;

  /**
   * Short-lived, service-owned admission lease for a billable model call.
   *
   * The service and its hosted job are separate processes over the same board.
   * A counter transaction alone cannot stop both of them reading "still under
   * budget" and issuing work before either result has returned. The process
   * crossing that gap holds this lease; other budgeted Cloud/API calls wait,
   * then gate again against the spend it recorded.
   *
   * This is coordination state, not a learner preference. Learner-facing prefs
   * routes do not accept it and portable backups omit it.
   */
  readonly modelBudgetLease?: {
    readonly holder: string;
    readonly expiresAt: string;
  } | null;

  /**
   * The non-secret identity of Virgil's three native Google Docs.
   *
   * The hosted browser writes this only after Drive has accepted all three
   * documents. The background worker reads it so it can rewrite those exact
   * files with its separately managed grant. No access or refresh token is
   * ever stored on the learner board.
   */
  readonly notebookDrive?: {
    readonly enabled: boolean;
    readonly account: string;
    readonly folderId: string;
    readonly files: Readonly<Record<string, string>>;
    readonly connectedAt: string;
    /** The last time all three fixed documents were accepted by Drive. */
    readonly lastWriteAt?: string;
  } | null;
}
