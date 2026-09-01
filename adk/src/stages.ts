/**
 * The nightly, described as orchestration nodes rather than executed as one.
 *
 * `runner/src/pipeline.ts` is the truth about what the nightly *does*; this file
 * is the truth about what its stages *are* — a name, which agent runs there,
 * whether the stage reaches the model seam, and what the run does when it fails.
 * Two different questions, and only the second one a framework can host.
 *
 * Why the shape is data and not code: an orchestration host has to be handed the
 * stage list before it can build anything (ADK's `SequentialAgent` takes its
 * sub-agents in its constructor), so the list has to exist independently of the
 * function that runs them. Keeping it as data also means `adk-stages.test.ts`
 * can check it against `pipeline.ts` itself, which is the only way this file
 * stays true — a hand-maintained mirror of a nine-stage pipeline is a mirror
 * that is wrong within a week of somebody adding a tenth stage.
 */

/**
 * Whether the stage reaches the model.
 *
 * This is the distinction the whole ADK design rests on. A `pure` stage is
 * arithmetic — `comfort` and `garden` compute over what is already stored and
 * cannot fail — and a `seam` stage reaches `Llm` through the injected `Deps`.
 *
 * Neither kind calls a vendor SDK, and that is the point: hosting a stage in a
 * framework is a statement about *sequencing*, not about *who owns the model
 * call*. The model call stays behind `core/src/ports/llm.ts` in both cases.
 */
export type StageKind = 'pure' | 'seam';

/**
 * What the run does when the stage does not complete.
 *
 * `degrade` means the host continues and retains a failed report, because later
 * diagnostic work is still useful. `skip` means the stage is gated on a
 * predecessor's success and does not execute. This field governs sequencing,
 * not the process exit: `HostedNightly.result()` elevates a failed pure Comfort
 * or Garden boundary to an infrastructure failure after reports are collected.
 */
export type StagePolicy = 'degrade' | 'skip';

export interface AdkStageSpec {
  /** Matches `StageReport.stage` exactly. The two names are one name. */
  readonly name: string;
  /**
   * The `core/` agent that does the work. Named so the architecture diagram and
   * the framework's agent tree can be checked against each other rather than
   * both being drawn from memory.
   */
  readonly agent: string;
  readonly kind: StageKind;
  readonly policy: StagePolicy;
  /** One line, and it becomes the hosted agent's `description`. */
  readonly description: string;
}

/**
 * The eleven stages, in the order `runBatch` runs them.
 *
 * Order is load-bearing and is asserted against `pipeline.ts` rather than
 * trusted: each stage genuinely needs the previous one complete, which is why
 * this is a sequence and not a set, and why the framework primitive it maps onto
 * is a sequential workflow rather than a router or a delegating supervisor.
 *
 * `intake` is the one stage nothing downstream depends on, and it is first
 * anyway. It plans the course sources a learner dropped — proposals, never
 * writes — and what it produces is what somebody most wants to find in the
 * morning: the deadlines. It is first for the person rather than for the
 * sequence, and it is in this list rather than beside it because it is
 * background work on a queue, which is precisely what a framework host is for.
 *
 * `prospect` is the one stage that looks outward. It is late in the order
 * because the gaps it reads are what the stages above it produced, and it is
 * before `compose` on purpose: what it proposes must not be able to shape the
 * lesson it was proposed about. Like `intake`, nothing downstream depends on
 * it, and unlike every other stage, the night is complete without it.
 *
 * Only `forage` fans out, and it fans out *within* the stage over pins — not
 * across stages. That is why there is no parallel node here: everything after
 * Forager reasons over the whole board and loses its cross-pin context if split.
 */
export const NIGHTLY_STAGES: readonly AdkStageSpec[] = [
  {
    name: 'intake',
    agent: 'intake-planner',
    kind: 'seam',
    policy: 'degrade',
    description: 'Works through dropped course sources, proposing objectives and dated obligations as drafts.',
  },
  {
    name: 'forage',
    agent: 'forager',
    kind: 'seam',
    policy: 'degrade',
    description: 'Re-fetches and reads around each new pin, one source record per retrieved fact.',
  },
  {
    name: 'cluster',
    agent: 'clusterer',
    kind: 'seam',
    policy: 'degrade',
    description: 'Groups pins into topics across time and source, conservatively.',
  },
  {
    name: 'survey',
    agent: 'surveyor',
    kind: 'seam',
    policy: 'degrade',
    description: 'Builds the prerequisite graph, degrading to unordered rather than wrongly ordered.',
  },
  {
    name: 'analyse',
    agent: 'analyst',
    kind: 'seam',
    policy: 'degrade',
    description: 'Produces the observations about the learner that are the product’s core value.',
  },
  {
    name: 'comfort',
    agent: 'registrar',
    kind: 'pure',
    policy: 'degrade',
    description: 'Scores comfort from the signal ledger. No model fallback; a storage fault fails the hosted run closed.',
  },
  {
    name: 'statements',
    agent: 'registrar',
    kind: 'seam',
    policy: 'degrade',
    description: 'Renders the editable prose model of the learner. Best-effort; losing it costs one panel.',
  },
  {
    name: 'prospect',
    agent: 'prospector',
    kind: 'seam',
    policy: 'degrade',
    description: 'Proposes a few things the learner never collected, each one citing the gap it came from.',
  },
  {
    name: 'garden',
    agent: 'gardener',
    kind: 'pure',
    policy: 'degrade',
    description: 'Decides what is taught next. Deterministic; a storage fault fails the hosted run closed.',
  },
  {
    name: 'compose',
    agent: 'composer',
    kind: 'seam',
    policy: 'degrade',
    description: 'Writes the one session, to a target duration, in three depth registers.',
  },
  {
    name: 'verify',
    agent: 'verifier',
    kind: 'seam',
    policy: 'skip',
    description: 'Re-reads every composed section against its pins and withholds what it cannot support.',
  },
];

/**
 * The agents that never appear above, and why that is correct rather than an
 * omission.
 *
 * The fleet is fifteen. Eleven stages run in the nightly; five agents run in
 * the foreground only, off a request rather than off a queue: Scout, Tutor,
 * Reviewer, Marker and the Transcriber. They are hosted by `runner/src/service.ts`, not by
 * the nightly, so an orchestration host built from `NIGHTLY_STAGES` must not
 * claim them. The Transcriber earned its place late and this list was slow to
 * notice: it reads scanned rubric pages at `POST /transcribe-pages`, writes
 * nothing and reads no record, and a registry that omitted it made the writeup
 * and the diagram disagree by one.
 *
 * **The Intake Planner is in neither list and in both**, which is why this one
 * is a list of names rather than a partition. It answers a request when somebody
 * presses *enhance* on a single draft, and it runs as the nightly's first stage
 * over the queue a course drop leaves behind. Those are the same agent doing the
 * same job at two scales, and pretending otherwise in the registry would put a
 * sixteenth agent in the writeup.
 *
 * Kept as a named constant because the alternative is a writeup claiming a
 * count of agents expressed as framework primitives beside an architecture
 * diagram showing a different one, with nothing in the repo able to say which
 * number is wrong.
 */
export const FOREGROUND_AGENTS: readonly string[] = [
  'scout', 'tutor', 'reviewer', 'marker', 'transcriber', 'intake-planner',
];

/** Every agent the fleet has, background and foreground, deduplicated. */
export const FLEET_AGENTS: readonly string[] = [
  ...new Set([...NIGHTLY_STAGES.map((s) => s.agent), ...FOREGROUND_AGENTS]),
];

/** The stages that reach the model seam. The cost model counts these. */
export const SEAM_STAGES: readonly AdkStageSpec[] =
  NIGHTLY_STAGES.filter((s) => s.kind === 'seam');

export const stageByName = (name: string): AdkStageSpec | undefined =>
  NIGHTLY_STAGES.find((s) => s.name === name);
