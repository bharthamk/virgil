import type { PureDeps } from './deps.js';
import { UNTRUSTED_RULE, fencePinned } from './untrusted.js';
import { DASH_RULE } from './house-style.js';
import { positionalKey, resolveKey } from './keys.js';
import { LlmRefused } from '../ports/llm.js';
import {
  admitProspectProposals, withProspectLead,
  PROSPECT_MAX_PROPOSALS, PROSPECT_PHRASE_MAX_CHARS,
  PROSPECT_REASON_MAX_CHARS, PROSPECT_SUBJECT_MAX_CHARS,
  type ProspectCandidate, type ProspectEvidence, type ProspectProposal,
} from '../domain/prospect.js';

/**
 * PROSPECTOR — the night's one extroverted agent.
 *
 * Every other background agent in this fleet answers a question about material
 * the learner already has. This one asks what is missing, and the difference is
 * the reason it is written under tighter rules than any of them:
 *
 *  - **It cannot choose what the evidence is.** `domain/prospect.ts` builds the
 *    gap list in code, off records the night has already produced, and this
 *    agent is handed it. The model picks which gaps are worth a proposal and
 *    writes the sentence; a proposal citing anything not on the list is dropped
 *    by `admitProspectProposals` rather than repaired. It is the source-id rule
 *    from the Composer and the criterion rule from the Marker, applied to the
 *    one agent that would otherwise be free to make things up.
 *
 *  - **It cannot read anything.** The port carries no browsing and this agent
 *    asks for none. The second call names a search phrase and, when the model
 *    is confident enough to offer one, an address. Neither is fetched. The
 *    record says `unread` in as many words, and the Forager is what reads an
 *    accepted lead on a later run.
 *
 *  - **It cannot write.** It returns proposals. A proposal becomes material
 *    when a person says so, on the same review surface a dropped course lands
 *    on, and not before.
 *
 * Two calls, capped in the domain rather than here so the pipeline and the cost
 * model can read the same constant. Deep and reasoning on, because this runs in
 * the background where latency is free and the judgement is the entire product
 * of the stage.
 */

export type ProspectOutcome =
  /** At least one proposal survived admission. */
  | 'proposed'
  /** The model answered and nothing it offered could be admitted. */
  | 'nothing-proposed'
  /** The call did not come back. Different from an empty answer, on purpose. */
  | 'model-failed';

/** Whether the second call happened, and what it managed. */
export type ProspectLeadOutcome = 'not-asked' | 'named' | 'model-failed';

export interface ProspectorInput {
  readonly gaps: readonly ProspectEvidence[];
  readonly now: string;
  readonly batchKey: string;
  /** Supplied by the composition root, so the agent stays deterministic. */
  readonly id: () => string;
}

export interface ProspectorResult {
  readonly outcome: ProspectOutcome;
  readonly proposals: readonly ProspectProposal[];
  /** Model calls actually issued. Never more than `PROSPECT_MAX_MODEL_CALLS`. */
  readonly calls: number;
  readonly leads: ProspectLeadOutcome;
  /** What was refused on the way in, counted by reason rather than summed. */
  readonly refused: {
    readonly invented: number;
    readonly empty: number;
    readonly duplicate: number;
    readonly overCap: number;
  };
}

/** How much of one gap the model is shown. A cap that cannot go missing. */
const GAP_CHARS = 300;

const NONE: ProspectorResult['refused'] = { invented: 0, empty: 0, duplicate: 0, overCap: 0 };

const PROPOSE_SCHEMA = {
  type: 'object',
  properties: {
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          evidenceId: { type: 'string' },
          subject: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['evidenceId', 'subject', 'reason'],
      },
    },
  },
  required: ['proposals'],
};

const LEAD_SCHEMA = {
  type: 'object',
  properties: {
    leads: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          proposal: { type: 'string' },
          phrase: { type: 'string' },
          url: { type: ['string', 'null'] },
        },
        required: ['proposal', 'phrase', 'url'],
      },
    },
  },
  required: ['leads'],
};

/**
 * The first call: which holes are worth filling, and what would fill them.
 *
 * The refuse-to-guess framing is deliberate and is the same shape that produced
 * the Surveyor's good behaviour. What is being asked for is small, specific and
 * new, and the failure mode worth writing against is a plausible list of
 * generic study advice attached to whichever evidence line happened to be
 * nearest.
 */
const PROPOSE_SYSTEM = `You read what a person's study board is short of, and propose new material they have not thought to collect.

You are given a numbered list of gaps. Each one was found by code, in their own records: a machine read of them on a topic they are shaky at, a check on their own writing that raised something, a thing several of their sources assume they already know, a topic they keep setting aside, something of theirs that has gone untouched, or a sentence already written about them that names something they are short of.

Rules, and they matter more than coverage:
1. At most three proposals. Fewer is better. An empty list is a good answer when nothing on the list is worth acting on.
2. Every proposal cites exactly one evidenceId from the list you were given, copied exactly. Never write an id you were not given, and never write one twice.
3. The subject is the thing to go and get, in a few words. Name a kind of material, not a task: "a worked example of X", "an introduction to Y", not "practise Y more".
4. The reason is one sentence, and it says what in their own records made you propose this. Point at the gap you cited. Do not describe them beyond what the gap says.
5. A gap marked "unconfirmed" is a sentence this product wrote about them that they have never agreed to. Write its reason as a read rather than as a fact: say what was written, not what they are.
6. Propose something genuinely new. If the gap is already covered by the topic it names, skip it.
7. No praise, no encouragement, and never promise when anything will happen.

${DASH_RULE}

JSON only.

${UNTRUSTED_RULE}`;

/**
 * The second call: where somebody could go looking.
 *
 * Separate from the first because it is a different question with a different
 * failure mode. The first call is judgement about a person's board; this one is
 * recall about what material exists, and recall is exactly where a model
 * invents a confident address. So the phrase is asked for first and the address
 * is optional, and `prospectLeadUrl` throws away anything that is not an
 * ordinary web address before it can reach a screen.
 */
const LEAD_SYSTEM = `You name where somebody could go looking for one specific piece of study material.

For each proposal you are given:
1. Write a phrase they could type into a search box to find it. A few words. This is the useful half of your answer.
2. Give an address only if you are confident it is a real, stable page for that material. If you are not, answer null. An invented address is worse than none, and nothing here will check it before they see it.
3. Never claim to have read anything. You have not.

${DASH_RULE}

JSON only.

${UNTRUSTED_RULE}`;

/**
 * The gap list as the model reads it.
 *
 * `unconfirmed` is on the line rather than left to the kind tag, because the
 * kind does not decide it: a statement the learner rewrote in their own words
 * is a settled thing to build on, and the identical kind of gap off a sentence
 * nobody has answered is not. The rendered proposal says so to the learner
 * whatever the model writes, and this is the half that lets the model write the
 * right sentence in the first place.
 */
const gapBlock = (gaps: readonly ProspectEvidence[]): string =>
  gaps.map((gap, index) =>
    `${positionalKey(index, 'e')} [${gap.kind}]${gap.unconfirmed ? ' [unconfirmed]' : ''}`
    + ` ${gap.detail.slice(0, GAP_CHARS)}`).join('\n');

/**
 * The whole stage body, minus the storing.
 *
 * Returns rather than writes, like every other agent here. The caller decides
 * whether a proposal is worth persisting, and the caller is the one place that
 * knows whether this learner asked for the stage at all.
 */
export async function prospect(
  deps: PureDeps,
  input: ProspectorInput,
): Promise<ProspectorResult> {
  const gaps = input.gaps;
  // Nothing to look at is not a failure and costs nothing. The pipeline checks
  // this too, so no call is made on an empty board; it is checked twice
  // because a caller that forgot would otherwise buy a model call to be told
  // there is nothing to say.
  if (!gaps.length) {
    return { outcome: 'nothing-proposed', proposals: [], calls: 0, leads: 'not-asked', refused: NONE };
  }

  const offeredIds = gaps.map((_, index) => positionalKey(index, 'e'));
  const byOfferedId = new Map(offeredIds.map((id, index) => [id, gaps[index] as ProspectEvidence]));

  let raw: { proposals?: readonly Record<string, unknown>[] };
  try {
    const answer = await deps.llm.structured<{ proposals: Record<string, unknown>[] }>({
      tier: 'deep',
      reasoning: 'on',
      system: PROPOSE_SYSTEM,
      // Every line of this is the board's own words: model prose over pages the
      // learner pinned, and page text underneath that. It is quoted material,
      // and the ids beside it are ours.
      prompt: `Gaps:\n${fencePinned(gapBlock(gaps))}\n\n`
        + `Propose at most ${PROSPECT_MAX_PROPOSALS}. `
        + `Subject at most ${PROSPECT_SUBJECT_MAX_CHARS} characters, `
        + `reason at most ${PROSPECT_REASON_MAX_CHARS}.`,
      schema: PROPOSE_SCHEMA,
      maxOutputTokens: 1_200,
    });
    raw = answer.value;
    if (!raw || !Array.isArray(raw.proposals)) {
      throw new Error('the proposal reply carried no list');
    }
  } catch (err) {
    // A refusal is not a failure. Nothing was sent, the learner's own limit or
    // a missing credential said so, and reporting it as a model failure would
    // send somebody to check a network over a switch they own.
    if (err instanceof LlmRefused) throw err;
    return { outcome: 'model-failed', proposals: [], calls: 1, leads: 'not-asked', refused: NONE };
  }

  /**
   * The read-back, and the refusal that makes this stage safe.
   *
   * `resolveKey` identifies exactly one offered id or gives up, and giving up
   * means the proposal is dropped. There is no nearest gap and no positional
   * guess: a proposal attached to the wrong evidence is a sentence about
   * somebody's learning built on a record that says something else.
   */
  const candidates: ProspectCandidate[] = [];
  for (const offer of raw.proposals) {
    const claimed = typeof offer?.evidenceId === 'string' ? offer.evidenceId : '';
    const resolved = resolveKey(claimed, offeredIds);
    const gap = resolved === null ? undefined : byOfferedId.get(resolved);
    candidates.push({
      // An unresolved id is passed on as the model wrote it, so admission
      // counts it as invented rather than this loop swallowing it silently.
      evidenceKey: gap ? gap.key : `unknown:${claimed}`,
      subject: typeof offer?.subject === 'string' ? offer.subject : '',
      reason: typeof offer?.reason === 'string' ? offer.reason : '',
    });
  }

  const admission = admitProspectProposals(candidates, gaps, {
    now: input.now, batchKey: input.batchKey, id: input.id,
  });
  const refused = {
    invented: admission.inventedEvidence,
    empty: admission.empty,
    duplicate: admission.duplicate,
    overCap: admission.overCap,
  };
  if (!admission.kept.length) {
    return { outcome: 'nothing-proposed', proposals: [], calls: 1, leads: 'not-asked', refused };
  }

  // The second call, and it is optional in every sense: a proposal with no
  // lead is still a proposal somebody can act on, so a failure here costs a
  // search phrase and nothing else.
  const keys = admission.kept.map((_, index) => positionalKey(index, 'n'));
  let proposals = admission.kept;
  let leads: ProspectLeadOutcome = 'named';
  try {
    const answer = await deps.llm.structured<{ leads: Record<string, unknown>[] }>({
      tier: 'deep',
      reasoning: 'on',
      system: LEAD_SYSTEM,
      prompt: `Proposals:\n${fencePinned(admission.kept
        .map((proposal, index) => `${keys[index]}: ${proposal.subject}\n  why: ${proposal.reason}`)
        .join('\n'))}\n\nPhrase at most ${PROSPECT_PHRASE_MAX_CHARS} characters.`,
      schema: LEAD_SCHEMA,
      maxOutputTokens: 700,
    });
    const rows = Array.isArray(answer.value?.leads) ? answer.value.leads : [];
    const named = new Map<string, { phrase?: string; url?: string | null }>();
    for (const row of rows) {
      const key = resolveKey(typeof row?.proposal === 'string' ? row.proposal : '', keys);
      if (key === null || named.has(key)) continue;
      named.set(key, {
        phrase: typeof row?.phrase === 'string' ? row.phrase : '',
        url: typeof row?.url === 'string' ? row.url : null,
      });
    }
    proposals = admission.kept.map((proposal, index) =>
      withProspectLead(proposal, named.get(keys[index] as string) ?? null));
  } catch (err) {
    if (err instanceof LlmRefused) throw err;
    leads = 'model-failed';
  }

  return { outcome: 'proposed', proposals, calls: 2, leads, refused };
}
