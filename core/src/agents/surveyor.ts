import type { PureDeps } from './deps.js';
import type { PrereqEdge, Topic } from '../domain/types.js';
import { UNTRUSTED_RULE, fencePinned } from './untrusted.js';

/**
 * SURVEYOR — the prerequisite graph.
 *
 * foundations before advanced material, and the ordering must be
 * explainable to the learner in one line.
 *
 * Evaluation (Run 1) downgraded this agent's risk. It produced 15 defensible
 * edges, recovered intervals → seventh chords → tritone substitution, and
 * correctly refused to invent cross-domain edges — its own reasoning being
 * "sharing a vendor is not a prerequisite relationship". The refuse-to-guess
 * framing below is what produced that, so it is load-bearing prompt text, not
 * decoration.
 */

export interface SurveyorInput {
  readonly topics: readonly Topic[];
}

/** Below this, an edge is dropped. A wrong edge is worse than no edge, because
 *  it teaches in an order that makes no sense and the learner blames themselves. */
export const EDGE_CONFIDENCE_FLOOR = 0.6;

/** Caps fan-out so one topic cannot become a bottleneck for everything else. */
export const MAX_EDGES_PER_TOPIC = 3;

const SCHEMA = {
  type: 'object',
  properties: {
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          confidence: { type: 'number' },
          justification: { type: 'string' },
        },
        required: ['from', 'to', 'confidence', 'justification'],
      },
    },
  },
  required: ['edges'],
};

const SYSTEM = `You decide what must be understood BEFORE what, so a teaching session can be ordered correctly.

Rules, and these matter more than coverage:
1. Only assert an edge when you are genuinely confident. A wrong edge is far worse than a missing edge.
2. Do NOT create edges between unrelated subject areas. Two topics sharing a vendor, a website, or a week is not a dependency. This is the worst failure mode available to you.
3. Every edge needs a confidence 0-1 and a ONE-LINE justification the learner would find convincing.
4. Returning few edges is a good outcome. Returning none is acceptable.

JSON only. Use the topic ids exactly as given.

${UNTRUSTED_RULE}`;

export async function survey(deps: PureDeps, input: SurveyorInput): Promise<readonly PrereqEdge[]> {
  const active = input.topics.filter((t) => !t.retiredByUser);
  if (active.length < 2) return [];

  const res = await deps.llm.structured<{ edges: PrereqEdge[] }>({
    tier: 'deep',
    reasoning: 'on',
    system: SYSTEM,
    // Labels and summaries are written by the naming model out of pinned text,
    // so they can carry a payload through at one remove. Same fence: a label is
    // material about the learner's board, not an instruction to this agent.
    prompt: `Topics:\n${fencePinned(active.map((t) => `${t.id} "${t.label}": ${t.summary}`).join('\n'))}`,
    schema: SCHEMA,
    maxOutputTokens: 2500,
  });

  const ids = new Set(active.map((t) => t.id));
  const seen = new Set<string>();
  const perTopic = new Map<string, number>();

  return (res.value.edges ?? [])
    .filter((e) => e && ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
    .filter((e) => (e.confidence ?? 0) >= EDGE_CONFIDENCE_FLOOR)
    .sort((a, b) => b.confidence - a.confidence)
    .filter((e) => {
      const key = `${e.from}->${e.to}`;
      if (seen.has(key) || seen.has(`${e.to}->${e.from}`)) return false; // no contradictions
      const n = perTopic.get(e.to) ?? 0;
      if (n >= MAX_EDGES_PER_TOPIC) return false;
      seen.add(key);
      perTopic.set(e.to, n + 1);
      return true;
    })
    .map((e) => ({
      from: e.from, to: e.to,
      confidence: e.confidence,
      justification: (e.justification ?? '').trim(),
    }));
}

/**
 * Topological order, comfort-ascending within a tier.
 *
 * Deliberately not a hard topological sort: a cycle in the graph must not stop
 * the learner getting a session. Anything still unplaced is appended in comfort
 * order, which is the deterministic fallback  degrades to — unordered
 * beats wrongly ordered.
 */
export function orderTopics(topics: readonly Topic[], edges: readonly PrereqEdge[]): readonly Topic[] {
  const byId = new Map(topics.map((t) => [t.id, t]));
  const blockers = new Map<string, Set<string>>();
  for (const t of topics) blockers.set(t.id, new Set());
  for (const e of edges) if (byId.has(e.from) && byId.has(e.to)) blockers.get(e.to)?.add(e.from);

  const out: Topic[] = [];
  const placed = new Set<string>();
  const remaining = new Set(topics.map((t) => t.id));

  while (remaining.size) {
    const ready = [...remaining]
      .filter((id) => [...(blockers.get(id) ?? [])].every((b) => placed.has(b) || !remaining.has(b)))
      .sort((a, b) => (byId.get(a)?.comfort ?? 0) - (byId.get(b)?.comfort ?? 0));

    // Cycle, or an edge into something already gone: fall back rather than hang.
    const batch = ready.length ? ready : [...remaining].sort(
      (a, b) => (byId.get(a)?.comfort ?? 0) - (byId.get(b)?.comfort ?? 0));

    for (const id of batch) {
      const t = byId.get(id);
      if (t) out.push(t);
      placed.add(id);
      remaining.delete(id);
    }
  }
  return out;
}
