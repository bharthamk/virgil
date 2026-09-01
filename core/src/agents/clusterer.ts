import type { Deps } from './deps.js';
import type { Pin, Topic } from '../domain/types.js';
import {
  partition, thresholdFor, assertPartition,
  type Embedded, type PartitionGroup,
} from '../domain/clustering.js';
import {
  partitionD1, bucketThresholdFor, DEFAULT_PARTITION_STRATEGY,
  type PartitionStrategyId, type TwoSpaceEmbedded,
} from '../domain/partition-d1.js';
import { MAX_HEADING_PATH, MAX_NOTE, MAX_TITLE, UNTRUSTED_RULE, capped, fencePinned } from './untrusted.js';
import { rendersEmpty, stripInvisible } from '../domain/text.js';
import { fallbackLabel } from './scout.js';
import { positionalKey, resolveKey } from './keys.js';
import { LlmRefused } from '../ports/llm.js';

/**
 * CLUSTERER — groups pins into topics across time and source (SB-19).
 *
 * Originally half of a Cartographer agent, and originally a single model call
 * that both partitioned and named. The partition half has been taken away from
 * the model entirely.
 *
 * Why, in one measurement: the same 21 pins, the same prompt, the same model,
 * three consecutive runs — 6, 6 and 7 topics, with different merge decisions
 * each time (DEAD_ENDS.md D15). Comfort and signal history attach to topic ids,
 * so that variance is not cosmetic; it detaches a learner's history from the
 * thing it was about, overnight, for no reason they can perceive.
 *
 * The shape now:
 *
 *   1. embed each pin from a fixed composition of its stable fields;
 *   2. partition in pure arithmetic — agglomerative, average linkage, cosine,
 *      attach-only, every tie broken by pin id (`domain/clustering.ts`);
 *   3. ask the model to name and summarise ONLY the topics being created.
 *
 * Naming is what a language model is actually good at, and getting it wrong
 * costs a bad label, not a lost history. Existing topic names are never
 * regenerated: a topic the learner has been reading for a month must not be
 * renamed because three new pins shifted its shape slightly.
 */

export type ClustererDeps = Pick<Deps, 'llm' | 'embedder' | 'coarseEmbedder'>;

export interface ClustererInput {
  readonly pins: readonly Pin[];
  readonly existingTopics: readonly Topic[];
  /** Defaults to the measured cut point for the embedder's space. */
  readonly threshold?: number;
  /**
   * Which partition rule decides the grouping. Left unset it is `d1` — the
   * default rule (`DEFAULT_PARTITION_STRATEGY`) — wherever `deps.coarseEmbedder`
   * is wired, and `single` (`domain/clustering.ts`) on a board with only one
   * space. Set it to say so explicitly; `d1` set by name without a coarse
   * embedder is an error, not a downgrade. See `domain/partition-d1.ts`.
   */
  readonly strategy?: PartitionStrategyId;
  /** D1 only. Defaults to the measured bucket cut for the coarse space. */
  readonly bucketThreshold?: number;
}

export interface ClusterResult {
  readonly label: string;
  readonly summary: string;
  readonly pinIds: readonly string[];
  readonly existingTopicId: string | null;
  /** Pins that joined an existing topic on this run. Empty for new topics. */
  readonly attached: readonly string[];
  /**
   * True when this label is still a stopgap: nothing named it, so it may be
   * named on a later run. See `Topic.provisionalName`.
   */
  readonly provisionalName: boolean;
}

export interface ClustererOutput {
  readonly clusters: readonly ClusterResult[];
  /** Kept, and kept asserted. By construction it is always empty (D13). */
  readonly unassigned: readonly string[];
  readonly embeddingModelId: string;
  readonly threshold: number;
  /** Which rule actually decided this partition. */
  readonly strategy: PartitionStrategyId;
  /** The coarse space, and its cut. Null unless a two-space strategy ran. */
  readonly coarseEmbeddingModelId: string | null;
  readonly bucketThreshold: number | null;
}

/**
 * What gets embedded, and what deliberately does not.
 *
 * In: the page title, the heading path, the selection (or the surrounding text
 * when the pin is whole-page), the parts of a struggle pin, and the learner's
 * own note — which is short and unusually high signal.
 *
 * Out: the site, because two pins are not related by sharing a vendor and the
 * old prompt had to be told so in words; the capture date, because when someone
 * pinned a thing says nothing about what it is; and everything the Forager
 * added, because enrichment is re-derived per run and an input that moves makes
 * a partition that moves.
 *
 * The 260-character cut on the gist is inherited from the prompt this replaced,
 * so the two are measured over the same text.
 */
export function pinClusterText(pin: Pin): string {
  const e = pin.envelope;
  const gist = (e.selection ?? e.surroundingText).replace(/\s+/g, ' ').trim().slice(0, 260);
  // `parts` is required by the type and was, for the whole life of the
  // extension, absent from every pin the extension actually made. This read
  // threw on the first real pin and the cluster stage is failure-tolerant, so
  // the run did not abort — it silently produced no topics. The capture path
  // populates it now; this stays because a pin stored by an older client is
  // still on disk and must degrade to what it does carry rather than take the
  // nightly down with it.
  const parts = (e.parts ?? []).map((p) => `${p.role}: ${p.text.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
  return [
    capped(e.pageTitle.replace(/\s+/g, ' ').trim(), MAX_TITLE),
    capped(e.headingPath.join(' > '), MAX_HEADING_PATH),
    gist,
    ...parts,
    pin.note ? `note: ${capped(pin.note.replace(/\s+/g, ' ').trim(), MAX_NOTE)}` : '',
  ].filter(Boolean).join('\n');
}

export const NAMING_PROMPT = `You name topics on a learner's study board.

The grouping is already decided and is NOT yours to revisit. Do not merge groups, do not split them, do not comment on them, do not move anything. Each group is fixed. Name it.

For each group id you are given, return:
- label: 2-5 words naming the subject.
- summary: one sentence naming the thing being understood. Write the SUBJECT MATTER, not a sentence about the person: "The forces the sun and moon exert on the oceans", never "The learner is trying to understand the forces...". Nobody reading their own study board is "the learner".

Rules:
1. A label must still fit in a month. Name the subject, not this week's angle. New material will be added to this same topic later.
2. Never name a topic after a website.
3. Never name a topic after a single fragment inside it. Look at what the whole group has in common.

JSON only.

${UNTRUSTED_RULE}`;

const NAMING_SCHEMA = {
  type: 'object',
  properties: {
    names: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          group: { type: 'string' },
          label: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['group', 'label', 'summary'],
      },
    },
  },
  required: ['names'],
};

/**
 * The label used when the naming call fails or skips a group.
 *
 * Honest degradation, not a placeholder: the heading path of the earliest pin
 * is a real description of the material, and a topic named "Ordering messages"
 * is worth far more to the learner than one named "Topic 4" — or than no topic
 * at all, which is what raising here would produce.
 */
function fallbackNaming(pins: readonly Pin[]): { label: string; summary: string } {
  const first = pins[0];
  if (!first) return { label: 'Unfiled', summary: '' };
  const e = first.envelope;
  // Through the sanitiser rather than `.trim()`: a heading of bidi overrides
  // and zero-width spaces is not empty by `.trim()`, so it slipped past the
  // `|| 'Unfiled'` guard and put a topic on the board with no visible name.
  // Through `fallbackLabel`, which is the one place that decides this: it cuts
  // at a word rather than through one, and it takes the masthead off a page
  // title. This used to be its own copy — `headingPath.at(-1) ?? pageTitle`,
  // sliced at 40 — so the two drifted, and the degraded path emitted labels the
  // toast path had already stopped producing. The invisible-character guard
  // stays here, because a topic is a board row that must never render blank.
  const source = stripInvisible(fallbackLabel(e)).replace(/\s+/g, ' ').trim();
  const label = rendersEmpty(source) ? '' : source;
  const summary = stripInvisible(e.selection ?? e.surroundingText).replace(/\s+/g, ' ').trim().slice(0, 160);
  return { label: label || 'Unfiled', summary };
}

/**
 * THE TOPIC'S OWN GIST, WITH THE INSTRUCTION'S FRAME TAKEN OFF.
 *
 * The naming prompt used to ask for *"one sentence naming what the learner is
 * trying to understand"*, and models do what prompts do: a live board came back
 * with *"The learner is trying to understand the gravitational forces exerted
 * by the sun and moon..."* — the instruction's own words, echoed, and then shown
 * verbatim to the person they are about. **Nobody reading their own study page
 * is "the learner".**
 *
 * The prompt above is fixed, so nothing new should arrive framed. This is for
 * everything already in a store, which is every topic on every board that
 * exists. It runs where a stored gist crosses to a surface, and it is a pure
 * string transformation: strip the frame, keep what the sentence was actually
 * about, capitalise what is now the first word.
 *
 * **A gist that does not match the frame is passed through untouched.** The
 * variants below are the ones this instruction produces; anything else is a
 * sentence somebody meant, and rewriting it on a guess would be a worse defect
 * than the one this fixes. So would emptying it: a frame with nothing after it
 * is not a match either, and the original survives.
 */
const GIST_FRAME = new RegExp(
  '^\\s*(?:the|this)\\s+(?:learner|user|student|reader)\\s+'
  + '(?:is\\s+(?:currently\\s+)?(?:trying|attempting|working|looking)\\s+to\\s+'
  + '|is\\s+seeking\\s+to\\s+|wants?\\s+to\\s+|would\\s+like\\s+to\\s+'
  + '|needs?\\s+to\\s+|is\\s+)?'
  + '(?:understand|understanding|grasp|grasping|learn|learning|work\\s+out|working\\s+out'
  + '|figure\\s+out|figuring\\s+out|know|get\\s+to\\s+grips\\s+with)\\s+',
  'i',
);

export function unframeGist(summary: string | null | undefined): string {
  if (typeof summary !== 'string') return '';
  const said = summary.replace(/\s+/g, ' ').trim();
  if (!said) return '';
  const rest = said.replace(GIST_FRAME, '');
  // No frame, or a frame with nothing behind it. Either way the sentence the
  // board already has is the best answer available.
  if (rest === said || !rest.trim()) return said;
  const kept = rest.trim();
  return `${kept.charAt(0).toUpperCase()}${kept.slice(1)}`;
}

export async function cluster(deps: ClustererDeps, input: ClustererInput): Promise<ClustererOutput> {
  const modelId = deps.embedder.modelId;
  const threshold = input.threshold ?? thresholdFor(modelId);
  // The default follows the wiring, and only for a caller who did not choose.
  //
  // D1 is the default rule (`DEFAULT_PARTITION_STRATEGY`, the D1 partition default) and runs
  // wherever a coarse space exists. A board with one space has one rule that
  // can run on it, and reporting `single` is not a silent downgrade: the stage
  // line names the rule and both cut points, so a board partitioned the older
  // way says so rather than leaving it to be inferred from what was not wired.
  //
  // An explicit `strategy: 'd1'` with no coarse embedder still throws below.
  // That is the case where somebody asked, and answering with a different rule
  // is the invisible substitution this seam refuses to make.
  const strategy: PartitionStrategyId = input.strategy
    ?? (deps.coarseEmbedder ? DEFAULT_PARTITION_STRATEGY : 'single');
  // A two-space strategy that was selected but not wired is a configuration
  // error, not something to degrade around: silently clustering by a different
  // rule than the one asked for is exactly the kind of invisible substitution
  // the embedder seam refuses to do (`cli.ts`, on SB_EMBEDDER).
  const coarseEmbedder = strategy === 'd1' ? deps.coarseEmbedder : undefined;
  if (strategy === 'd1' && !coarseEmbedder) {
    throw new Error('partition strategy d1 needs a coarse embedder, and deps.coarseEmbedder is not set');
  }
  const coarseModelId = coarseEmbedder?.modelId ?? null;
  const bucketThreshold = coarseEmbedder
    ? (input.bucketThreshold ?? bucketThresholdFor(coarseEmbedder.modelId))
    : null;
  const provenance = {
    embeddingModelId: modelId,
    threshold,
    strategy,
    coarseEmbeddingModelId: coarseModelId,
    bucketThreshold,
  };
  if (!input.pins.length) {
    return { clusters: [], unassigned: [], ...provenance };
  }

  // Sort before embedding, not after. The embedder is handed a fixed order so
  // that any batching it does is also fixed, and the vectors it returns are the
  // same numbers in the same places on every run.
  const pins = [...input.pins].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const texts = pins.map(pinClusterText);
  const vectors = await deps.embedder.embed(texts);
  if (vectors.length !== pins.length) {
    throw new Error(`embedder returned ${vectors.length} vectors for ${pins.length} pins`);
  }
  const items: Embedded[] = pins.map((p, i) => ({ id: p.id, vector: vectors[i] ?? [] }));
  const existing = input.existingTopics.map((t) => ({ topicId: t.id, memberIds: t.pinIds }));

  let groups: readonly PartitionGroup[];
  if (coarseEmbedder && bucketThreshold !== null) {
    // The same texts, in the same order, to both spaces. TF-IDF's IDF is a
    // property of the batch it is handed (see `TfIdfEmbedder`), so the coarse
    // space must be built over the whole board in one call, exactly as the fine
    // one is — and exactly as the bake-off harness does it per board.
    const coarseVectors = await coarseEmbedder.embed(texts);
    if (coarseVectors.length !== pins.length) {
      throw new Error(`coarse embedder returned ${coarseVectors.length} vectors for ${pins.length} pins`);
    }
    const twoSpace: TwoSpaceEmbedded[] = pins.map((p, i) => ({
      id: p.id,
      coarse: coarseVectors[i] ?? [],
      fine: vectors[i] ?? [],
    }));
    groups = partitionD1({ items: twoSpace, existing, bucketThreshold, threshold });
  } else {
    groups = partition({ items, existing, threshold });
  }

  const byId = new Map(pins.map((p) => [p.id, p]));
  const topicById = new Map(input.existingTopics.map((t) => [t.id, t]));
  // What the naming pass is for: a group with no topic, and a group whose topic
  // has never been named by anything. The second is not a rename — see
  // `Topic.provisionalName`. A topic that HAS a name is not offered, which is
  // the identity promise and is asserted directly in `clusterer.test.ts`.
  const isProvisional = (topicId: string | null): boolean =>
    topicId !== null && topicById.get(topicId)?.provisionalName === true;
  const toName = groups.filter((g) => g.topicId === null || isProvisional(g.topicId));
  // The key a group answers to, held explicitly rather than recomputed by a
  // counter walking a second list in step with this one.
  const keyOf = new Map(toName.map((g, index) => [g, groupKey(index)]));
  const names = toName.length
    ? await nameGroups(deps, toName, byId, (g) => keyOf.get(g) as string)
    : new Map<string, { label: string; summary: string }>();

  const clusters: ClusterResult[] = groups.map((g) => {
    const members = g.pinIds.map((id) => byId.get(id)).filter((p): p is Pin => Boolean(p));
    const offered = keyOf.get(g);
    const named = offered ? names.get(offered) : undefined;

    if (g.topicId !== null) {
      const prior = topicById.get(g.topicId);
      // Existing labels are carried through untouched. This is the identity
      // promise: the topic the learner has been working on keeps its name.
      // The one exception is a topic that has never had a name to keep.
      if (!isProvisional(g.topicId) || !named) {
        return {
          label: prior?.label ?? fallbackNaming(members).label,
          summary: prior?.summary ?? '',
          pinIds: g.pinIds,
          existingTopicId: g.topicId,
          attached: g.attached,
          // A naming failure must not launder a stopgap into a permanent name:
          // that would spend the one opportunity on the model being down.
          provisionalName: isProvisional(g.topicId),
        };
      }
      return {
        label: named.label,
        summary: named.summary,
        pinIds: g.pinIds,
        existingTopicId: g.topicId,
        attached: g.attached,
        provisionalName: false,
      };
    }
    const fresh = named ?? fallbackNaming(members);
    return {
      label: fresh.label,
      summary: fresh.summary,
      pinIds: g.pinIds,
      existingTopicId: null,
      attached: [],
      // A cold board whose naming call failed is in exactly the same position
      // as the orphan path: a heading-path label nothing chose. Nameable next
      // run rather than stuck.
      provisionalName: !named,
    };
  });

  // Belt and braces. `partition` already asserted this over its own output;
  // asserting again over what the caller will actually act on is what catches a
  // mistake made between the two — which is where D13 lived.
  assertPartition(pins.map((p) => p.id), clusters);

  return { clusters, unassigned: [], ...provenance };
}

/**
 * Stable key per group being created: its position among the created groups,
 * which is itself id-ordered. One function so the prompt side and the read-back
 * side cannot drift apart — they did, once, and every new topic silently took
 * the fallback label. Both halves live in `keys.ts` now, because the Forager
 * batches for the same reason and a second copy is the same drift again.
 */
const groupKey = (createdIndex: number): string => positionalKey(createdIndex, 'g');
const resolveGroupKey = resolveKey;

/**
 * How many groups one naming call may be asked about.
 *
 * **The scale bug this was written for.** The naming call used to be one call
 * for every new topic, whatever the board, and it asked for
 * `200 + created.length * 120` output tokens. That arithmetic is fine at the six
 * new topics a normal night makes and is nonsense at the size a **course drop**
 * produces: a semester of 300 documents partitions into dozens of topics on its
 * first night, and thirty of them alone asks for 3,800 output tokens of pure
 * labelling — beyond the fast tier's practical reply, and with every group's
 * material in one prompt, past the input window as well. A call that overruns
 * comes back truncated, `names` is short, and the shortfall lands as
 * heading-path fallback labels on a board the learner never sees named. It fails
 * *quietly*, which is why it is worth a constant.
 *
 * Twelve, because it bounds the two things that both get worse as a chunk grows,
 * and it is the same reasoning `FORAGE_BATCH` records for the other batched
 * stage: the cost of one failed call, which is now a chunk of labels rather than
 * every label in the run; and the size of the reply, which at twelve is 1,640
 * output tokens — inside every tier in the fleet with room to spare.
 *
 * The groups are **independent** here in a way the Forager's pins were not, and
 * that is what makes this batch safe where `forageBatch` was held back. A name
 * is a function of one group's own material; the bake-off's finding was that
 * pins in a chunk contaminated each other's *answers*, and a label cannot be
 * contaminated by a group it is not about because the prompt asks for one label
 * per named group id and the read-back is keyed by that id.
 */
export const NAMING_BATCH = 12;

/**
 * The new topics, named in chunks, on the cheap tier with reasoning off.
 *
 * Cheap tier because naming a group whose membership is already fixed is a
 * labelling task, and D2 measured what the thinking pass costs for exactly that
 * shape of job — 5005ms to 419ms with no quality loss. Background work has no
 * latency budget to protect, but it has no reason to burn twelve times the
 * compute either.
 *
 * A failure here degrades to heading-path labels rather than propagating: the
 * partition is already decided and stored, and losing the naming costs a
 * clumsier label, not a lost pin. Chunking makes that degradation *partial*
 * rather than total, which is the second reason for it — one bad call used to
 * cost every new topic on the board its name.
 *
 * `keyFor` is handed in rather than recomputed from a local index. The key a
 * group answers to is its position among **all** the groups being created, and a
 * chunk that renumbered from zero would offer `g0` in three different calls and
 * write three different topics' names into one slot. That is the drift
 * `keys.ts` exists to prevent, arriving through a new door.
 */
async function nameGroups(
  deps: ClustererDeps,
  created: readonly PartitionGroup[],
  byId: ReadonlyMap<string, Pin>,
  keyFor: (g: PartitionGroup) => string,
): Promise<Map<string, { label: string; summary: string }>> {
  const out = new Map<string, { label: string; summary: string }>();
  const describe = (g: PartitionGroup): string => {
    const lines = g.pinIds.map((id) => {
      const p = byId.get(id);
      if (!p) return '';
      const e = p.envelope;
      const gist = (e.selection ?? e.surroundingText).replace(/\s+/g, ' ').slice(0, 200);
      const head = e.headingPath.length ? ` <${capped(e.headingPath.join(' > '), MAX_HEADING_PATH)}>` : '';
      return `  - (${p.type})${head} ${capped(e.pageTitle, MAX_TITLE)}: "${gist}"${p.note ? `, learner noted: "${capped(p.note, MAX_NOTE)}"` : ''}`;
    }).filter(Boolean);
    // The group id stays outside the fence — it is ours, and the model has to
    // read it as the key it answers with. Only the pinned text goes inside.
    return `group ${keyFor(g)}:\n${fencePinned(lines.join('\n'))}`;
  };

  for (let from = 0; from < created.length; from += NAMING_BATCH) {
    const chunk = created.slice(from, from + NAMING_BATCH);
    try {
      const res = await deps.llm.structured<{ names?: { group?: string; label?: string; summary?: string }[] }>({
        tier: 'fast',
        reasoning: 'off',
        system: NAMING_PROMPT,
        prompt: chunk.map(describe).join('\n\n'),
        schema: NAMING_SCHEMA,
        maxOutputTokens: 200 + chunk.length * 120,
      });
      const offered = chunk.map(keyFor);
      for (const n of res.value.names ?? []) {
        if (!n?.group || !n.label) continue;
        const key = resolveGroupKey(String(n.group), offered);
        // Nothing certain, or a group already named: the second name for one
        // group is as likely to be the wrong one as the first, and overwriting
        // would make which of them wins depend on the order they came back in.
        if (key === null || out.has(key)) continue;
        out.set(key, {
          label: String(n.label).replace(/\s+/g, ' ').trim().slice(0, 60),
          summary: String(n.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
        });
      }
    } catch (err) {
      // A refusal is not a failure, and it ends the whole naming pass rather
      // than the chunk. Falling back per group is right for a naming call that
      // failed and wrong for one this build declined to issue: every remaining
      // chunk and every remaining stage would go and discover the same stop, and
      // the board would fill with fallback labels bought by nothing.
      if (err instanceof LlmRefused) throw err;
      // Deliberately swallowed, and only for this chunk. The caller falls back
      // per group for whatever is missing from `out`.
    }
  }
  return out;
}
