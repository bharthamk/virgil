/**
 * What each agent would actually be sent, as the board grows.
 *
 * `runner/src/usage.ts` counts tokens that came BACK from real calls, which is
 * the right instrument for a cost model and the wrong one for this question:
 * it can only measure a run you were willing to pay for, and the run this is
 * asking about is the one at three hundred pins that nobody wants to sit
 * through. So this drives the real pipeline with a recording `Llm` that returns
 * schema-shaped stubs and never calls a model. Every prompt is the genuine one
 * the agent built; only the reply is fabricated.
 *
 * The board is grown 21 -> 41 -> 61 -> 80 and every request is recorded, so
 * each agent gets a growth curve rather than two points. Two points cannot tell
 * linear from quadratic and the whole question here is which agents are which.
 *
 *   node scripts/measure-prompts.mjs              # character footprint, no model
 *   node scripts/measure-prompts.mjs --tokenize   # + real prompt_eval_count
 *
 * `--tokenize` sends the largest recorded prompt for each agent to the local
 * model with num_predict 1 and reads the token count the server reports, which
 * converts the character estimate into a measured one and shows whether the
 * runtime context window silently truncated it.
 */
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { systemClock } from '../core/dist/index.js';
import { OllamaEmbedder, TfIdfEmbedder, JsonStore, DEFAULT_EMBED_MODEL } from '../adapters/dist/index.js';
import { LOCAL_TIERS } from '../adapters/dist/ollama-llm.js';
import { runBatch } from '../runner/dist/pipeline.js';
import { requireOllama } from './preflight.mjs';

const SCRATCH = '.data-scale/measure';
const HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
const TOKENIZE = process.argv.includes('--tokenize');

/**
 * Context windows the fleet has to fit inside.
 *
 * The local figure is not the number on the model card, it is the number
 * `ollama ps` reports for the loaded instance — 262144, the model's declared
 * length, because this Ollama sizes the window to the model rather than
 * capping it at a default. Worth checking rather than assuming: a runtime that
 * silently caps the window truncates the prompt before the model sees it, and
 * nothing in the response says so. `--tokenize` is what settles it.
 */
const CEILINGS = [
  ['local (qwen3.8:27b-mlx, ollama ps)', 262_144],
  ['Gemini 1M', 1_000_000],
];

/**
 * Characters per token, MEASURED per agent by `--tokenize` rather than assumed.
 *
 * The usual chars/4 rule of thumb is right for prose (the Analyst measured
 * 3.99) and wrong by a third for a prompt full of UUIDs and JSON schema (the
 * Surveyor measured 2.81), which is exactly the direction that would make a
 * ceiling estimate too generous. Re-derive these with `--tokenize` after any
 * prompt change; 4.0 is the fallback for an agent not in the table.
 */
const CHARS_PER_TOKEN = {
  forager: 4.90, clusterer: 4.35, surveyor: 2.81, analyst: 3.99,
  registrar: 4.38, composer: 4.20, verifier: 2.97,
};
const cpt = (agent) => CHARS_PER_TOKEN[agent] ?? 4;

// --------------------------------------------------------------- the corpus

const toPin = (p, i) => ({
  id: p.id,
  type: p.type,
  envelope: {
    selection: p.selection ?? null,
    parts: p.parts ?? [],
    surroundingText: p.surrounding ?? '',
    headingPath: p.headings ?? [],
    pageTitle: p.title ?? '',
    url: p.url ?? '',
    canonicalUrl: null,
    siteName: p.site ?? null,
    contentLanguage: 'en',
    media: null,
  },
  note: p.note ?? null,
  capturedAt: new Date(p.capturedAt).toISOString(),
  fromSuggestion: false,
  enrichment: null,
  topicId: null,
});

const PINS = JSON.parse(readFileSync('scripts/scale-pins.json', 'utf8')).map(toPin);

// ------------------------------------------------------- the recording model

/**
 * Which agent a request came from, read off the system prompt.
 *
 * Matching on the prompt text rather than passing a name through the port is
 * deliberate: it keeps this script entirely outside `core/`, so measuring the
 * fleet cannot change the fleet. The cost is that a reworded system prompt
 * shows up here as `unknown`, which the run asserts on rather than ignores.
 */
const AGENTS = [
  ['forager', 'You prepare pinned material for teaching later'],
  ['clusterer', 'You name topics on a learner'],
  ['surveyor', 'You decide what must be understood BEFORE what'],
  ['analyst', 'You look at everything a learner has pinned'],
  ['registrar', 'You write, in plain sentences, what a study tool'],
  ['composer', 'You write one study session for one learner'],
  ['verifier', 'You are checking a study section BEFORE a learner reads it'],
];
const agentOf = (system) => AGENTS.find(([, probe]) => system.includes(probe))?.[0] ?? 'unknown';

const words = (n) => Array.from({ length: Math.max(1, n) }, (_, i) => `word${i % 40}`).join(' ');

/**
 * Replies are stubs, but they are stubs of the right SIZE and SHAPE, because
 * one agent's output is the next agent's prompt. A Composer stub that returned
 * an empty section list would have made the Verifier look free.
 */
function stubFor(agent, req) {
  switch (agent) {
    case 'forager':
      return { assumedConcepts: ['a prior concept', 'another prior concept'], mediaDescription: null };
    case 'clusterer': {
      const groups = [...req.prompt.matchAll(/^group (g\d+):/gm)].map((m) => m[1]);
      return {
        names: groups.map((g) => ({
          group: g,
          label: 'Placeholder topic name',
          summary: 'One sentence naming what the learner is trying to understand here.',
        })),
      };
    }
    case 'surveyor':
      return { edges: [] };
    case 'analyst':
      return {
        observations: Array.from({ length: 4 }, (_, i) => ({
          claim: `Stub observation ${i + 1}, about the length a real one runs to in practice.`,
          evidencePinIds: PINS.slice(i * 2, i * 2 + 3).map((p) => p.id),
          implication: 'What should change as a result, in one sentence of about this length.',
          mediumMismatch: i === 0,
          confidence: 0.8 - i * 0.05,
        })),
      };
    case 'registrar':
      return {
        statements: Array.from({ length: 8 }, (_, i) =>
          `Stub statement ${i + 1}: a plain sentence of roughly the length the real ones run to.`),
      };
    case 'composer': {
      const topics = [...req.prompt.matchAll(/^TOPIC (\S+): /gm)].map((m) => m[1]);
      const budgets = [...req.prompt.matchAll(/^ {2}length: about (\d+) words/gm)].map((m) => Number(m[1]));
      return {
        sections: topics.map((topicId, i) => ({
          topicId,
          heading: 'Stub section heading',
          body: words(budgets[i] ?? 250),
          estimatedMinutes: 5,
          question: null,
          sourceIds: [],
          mediumWarning: null,
        })),
        closingNote: 'What moved, what is still open, what to look at next.',
      };
    }
    case 'verifier':
      return { defects: [] };
    default:
      return {};
  }
}

class RecordingLlm {
  constructor(sink) { this.sink = sink; }

  #record(req) {
    const agent = agentOf(req.system);
    // What the adapter actually puts on the wire: system, the prompt, and — for
    // a structured call — the schema appended to the user turn. Chat-template
    // overhead is a couple of dozen tokens and is left out rather than guessed.
    const schema = req.schema ? JSON.stringify(req.schema) : '';
    const record = {
      agent,
      tier: req.tier,
      reasoning: req.reasoning ?? 'on',
      systemChars: req.system.length,
      promptChars: req.prompt.length,
      schemaChars: schema.length,
      totalChars: req.system.length + req.prompt.length + schema.length,
      maxOutputTokens: req.maxOutputTokens ?? 2048,
      system: req.system,
      prompt: req.prompt,
      schema,
    };
    this.sink.push(record);
    return { agent, record };
  }

  async complete(req) {
    const { record } = this.#record(req);
    return { value: '', modelId: 'recording', inputTokens: 0, outputTokens: 0, __record: record };
  }

  async structured(req) {
    const { agent } = this.#record(req);
    return { value: stubFor(agent, req), modelId: 'recording', inputTokens: 0, outputTokens: 0 };
  }
}

/** Forager must not reach the network here; the measurement is of prompts. */
const stubResearch = {
  hasGrounding: false,
  async fetchPage() { return null; },
  async findReferences() { return []; },
};

// ------------------------------------------------------------------- the run

/**
 * Two passes, because the product has two kinds of night.
 *
 * The FIRST night on a board is cold: nothing is enriched, no topic has a
 * comfort score, and the Registrar has nothing to describe. Every night after
 * that is warm: enrichment is done so Forager is not called, and every topic
 * carries signal history so the Registrar's prompt is a line per topic. Measure
 * only the cold run and the Registrar looks free; measure only the warm one and
 * the Forager disappears. Both are real and both are reported.
 */
async function measure(size, embedderName) {
  const path = `${SCRATCH}/board-${size}-${embedderName}.json`;
  rmSync(path, { force: true });
  const store = new JsonStore(path);
  for (const pin of PINS.slice(0, size)) await store.putPin(pin);

  const deps = (sink) => ({
    llm: new RecordingLlm(sink),
    embedder: embedderName === 'tfidf' ? new TfIdfEmbedder() : new OllamaEmbedder(),
    store,
    research: stubResearch,
    clock: systemClock,
  });

  const cold = [];
  const first = await runBatch(deps(cold), { concurrency: 8 });

  // Signal history, layered the way `cli.js history` layers it: against the
  // topics that actually emerged, never against topics we chose in advance.
  const now = systemClock.now();
  let i = 0;
  for (const topic of await store.listTopics()) {
    for (let k = 0; k < 3; k++) {
      const at = new Date(now.getTime() - (7 + k * 5) * 86_400_000).toISOString();
      await store.appendSignal({
        id: `sig-${topic.id}-${k}`,
        topicId: topic.id,
        type: k === 2 ? 'section-completed' : (i + k) % 3 === 0 ? 'answer-wrong' : 'answer-correct',
        direction: k === 2 ? 'neutral' : (i + k) % 3 === 0 ? 'negative' : 'positive',
        at,
        sourceEvent: 'measurement fixture',
        invalidated: false,
      });
    }
    i++;
  }

  const warm = [];
  await runBatch(deps(warm), { concurrency: 8 });

  for (const sink of [cold, warm]) {
    const unknown = sink.filter((r) => r.agent === 'unknown');
    if (unknown.length) {
      throw new Error(`${unknown.length} request(s) came from an unrecognised system prompt — `
        + 'the probes in AGENTS have drifted from the agents');
    }
  }

  // The one prompt in the fleet that is assembled from UNTRUNCATED pin text:
  // the pipeline builds the Verifier's source material by joining whole
  // selections for every pin in the section's topic. Worth measuring on its
  // own, because which topics the Composer happens to pick decides whether the
  // recorded run ever saw the worst case.
  const pins = await store.listPins();
  const worstMaterial = Math.max(0, ...(await store.listTopics()).map((t) =>
    pins.filter((p) => p.topicId === t.id)
      .reduce((a, p) => a + (p.envelope.selection ?? p.envelope.surroundingText).length + 2, 0)));

  return { cold, warm, topics: first.topics.length, worstMaterial };
}

const byAgent = (sink) => {
  const out = new Map();
  for (const r of sink) {
    const row = out.get(r.agent) ?? { agent: r.agent, tier: r.tier, calls: 0, total: 0, max: 0, biggest: null };
    row.calls++;
    row.total += r.totalChars;
    if (r.totalChars > row.max) { row.max = r.totalChars; row.biggest = r; }
    out.set(r.agent, row);
  }
  return out;
};

const ORDER = ['forager', 'clusterer', 'surveyor', 'analyst', 'registrar', 'composer', 'verifier'];
const n = (x) => Math.round(x).toLocaleString('en-US');
const est = (chars, agent) => Math.round(chars / cpt(agent));

// ------------------------------------------------------------- real tokens

async function tokenCount(record) {
  const model = LOCAL_TIERS[record.tier];
  const body = {
    model,
    stream: false,
    think: false,
    options: { num_predict: 1 },
    messages: [
      { role: 'system', content: record.system },
      { role: 'user', content: `${record.prompt}\n\nReturn JSON matching:\n${record.schema}` },
    ],
  };
  const r = await fetch(`${HOST}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return { model, promptTokens: j.prompt_eval_count ?? 0 };
}

// ------------------------------------------------------------------- report

const SIZES = [21, 41, 61, 80];
const embedderName = process.env.SB_EMBEDDER === 'tfidf' ? 'tfidf' : 'ollama';

// The stub `Llm` means no model is called, but the board still has to be
// clustered for real or every row below is a row about zero topics — and the
// report prints those zeros happily, which is worse than stopping.
await requireOllama([
  ...(embedderName === 'ollama' ? [DEFAULT_EMBED_MODEL] : []),
  ...(TOKENIZE ? [LOCAL_TIERS.fast, LOCAL_TIERS.deep] : []),
], { hint: 'The lexical space needs no model: `SB_EMBEDDER=tfidf node scripts/measure-prompts.mjs`.' });

mkdirSync(SCRATCH, { recursive: true });

console.log(`# Prompt footprint by board size — ${embedderName} embedder, no model called`);

const runs = new Map();
for (const size of SIZES) {
  const m = await measure(size, embedderName);
  runs.set(size, { cold: byAgent(m.cold), warm: byAgent(m.warm), topics: m.topics, worstMaterial: m.worstMaterial });
}

const get = (size, pass, agent, field) => runs.get(size)[pass].get(agent)?.[field] ?? 0;
const HEAD = `| agent | ${SIZES.map((s) => `${s} pins`).join(' | ')} | 21 -> 80 |`;
const RULE = `| :---- | ${SIZES.map(() => '-----:').join(' | ')} | -------: |`;

console.log(`\ntopics the board settled on: ${SIZES.map((s) => `${s} pins -> ${runs.get(s).topics}`).join(', ')}`);

for (const pass of ['cold', 'warm']) {
  console.log(`\n## Calls per nightly run — ${pass === 'cold' ? 'first night on the board' : 'every night after'}\n`);
  console.log(`| agent | ${SIZES.map((s) => `${s} pins`).join(' | ')} |`);
  console.log(`| :---- | ${SIZES.map(() => '-----:').join(' | ')} |`);
  for (const agent of ORDER) {
    console.log(`| ${agent} | ${SIZES.map((s) => get(s, pass, agent, 'calls')).join(' | ')} |`);
  }
}

console.log('\n## Largest single prompt, characters (system + prompt + schema)\n');
console.log(HEAD);
console.log(RULE);
for (const agent of ORDER) {
  const row = SIZES.map((s) => Math.max(get(s, 'cold', agent, 'max'), get(s, 'warm', agent, 'max')));
  const growth = row[0] ? `${(row.at(-1) / row[0]).toFixed(2)}x` : '—';
  console.log(`| ${agent} | ${row.map(n).join(' | ')} | ${growth} |`);
}

console.log('\n## Total characters sent per nightly run — cold night\n');
console.log(HEAD);
console.log(RULE);
let grand = SIZES.map(() => 0);
for (const agent of ORDER) {
  const row = SIZES.map((s) => get(s, 'cold', agent, 'total'));
  grand = grand.map((g, i) => g + row[i]);
  const growth = row[0] ? `${(row.at(-1) / row[0]).toFixed(2)}x` : '—';
  console.log(`| ${agent} | ${row.map(n).join(' | ')} | ${growth} |`);
}
console.log(`| **whole run** | ${grand.map(n).join(' | ')} | ${(grand.at(-1) / grand[0]).toFixed(2)}x |`);

console.log('\n## Total characters sent per nightly run — warm night\n');
console.log(HEAD);
console.log(RULE);
let warmGrand = SIZES.map(() => 0);
for (const agent of ORDER) {
  const row = SIZES.map((s) => get(s, 'warm', agent, 'total'));
  warmGrand = warmGrand.map((g, i) => g + row[i]);
  const growth = row[0] ? `${(row.at(-1) / row[0]).toFixed(2)}x` : '—';
  console.log(`| ${agent} | ${row.map(n).join(' | ')} | ${growth} |`);
}
console.log(`| **whole run** | ${warmGrand.map(n).join(' | ')} | ${(warmGrand.at(-1) / warmGrand[0]).toFixed(2)}x |`);

/**
 * Growth is classified against the board, not fitted blind. The board grew
 * 3.81x across these four sizes; an agent whose largest prompt grew by about
 * the same factor scales with the board, one that barely moved is bounded by
 * something else, and one that grew faster is the problem this run was looking
 * for. The straight-line fit is only used for the ceilings, and only for the
 * agents the classification says are actually growing.
 */
const RATIO = SIZES.at(-1) / SIZES[0];
console.log(`\n## Growth shape and where each agent runs out of room\n`);
console.log(`Board grew ${RATIO.toFixed(2)}x across the four sizes.\n`);
console.log('| agent | chars/pin | 21 -> 80 | shape | local 262k | Gemini 1M |');
console.log('| :---- | --------: | -------: | :---- | ---------: | --------: |');
for (const agent of ORDER) {
  const ys = SIZES.map((s) => Math.max(get(s, 'cold', agent, 'max'), get(s, 'warm', agent, 'max')));
  if (!ys.at(-1)) { console.log(`| ${agent} | — | — | not called | — | — |`); continue; }
  const meanX = SIZES.reduce((a, b) => a + b, 0) / SIZES.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  const slope = SIZES.reduce((a, x, i) => a + (x - meanX) * (ys[i] - meanY), 0)
    / SIZES.reduce((a, x) => a + (x - meanX) ** 2, 0);
  const intercept = meanY - slope * meanX;
  const ssRes = ys.reduce((a, y, i) => a + (y - (slope * SIZES[i] + intercept)) ** 2, 0);
  const ssTot = ys.reduce((a, y) => a + (y - meanY) ** 2, 0);
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  const grew = ys.at(-1) / ys[0];
  // A poor straight-line fit on a prompt that did move means the size is set by
  // something other than the board — for the per-pin Forager it is simply which
  // pin is the longest, and a bigger board only changes that by containing it.
  const shape = grew <= 1.25 ? 'bounded — does not grow with the board'
    : r2 < 0.9 ? 'bounded per call — set by the longest single pin'
    : grew > RATIO * 1.15 ? `SUPERLINEAR (r2 ${r2.toFixed(3)})`
    : grew >= RATIO * 0.85 ? `linear in pins (r2 ${r2.toFixed(3)})`
    : `sublinear — grows with topics (r2 ${r2.toFixed(3)})`;
  const growing = grew > 1.25 && slope > 1 && r2 >= 0.9;
  const pinsAt = (tokens) => growing ? n(Math.max(0, (tokens * cpt(agent) - intercept) / slope)) : 'never';
  console.log(`| ${agent} | ${growing ? slope.toFixed(0) : '~0'} | ${grew.toFixed(2)}x | ${shape} |`
    + ` ${pinsAt(262_144)} | ${pinsAt(1_000_000)} |`);
}
console.log('\nCeiling columns are board sizes in pins, extrapolated from the straight-line fit,');
console.log('at the measured characters-per-token for that agent. They are where the LARGEST');
console.log('single prompt fills the window, with no room left for the reply.');

console.log('\n## The one prompt built from untruncated pin text\n');
console.log('Every agent slices the material it quotes — 260 chars for the Clusterer, 300 for');
console.log('the Analyst, 700 for the Composer — except the Verifier, whose source material the');
console.log('pipeline joins whole. Worst case is the largest topic on the board:\n');
console.log(`| board | topics | largest topic's source material (chars) |`);
console.log('| ----: | -----: | -------------------------------------: |');
for (const s of SIZES) console.log(`| ${s} pins | ${runs.get(s).topics} | ${n(runs.get(s).worstMaterial)} |`);

console.log('\n## The largest prompt on the board, at 80 pins\n');
const at80 = runs.get(80).cold;
for (const [agent, row] of runs.get(80).warm) {
  const cold = at80.get(agent);
  if (!cold || row.max > cold.max) at80.set(agent, row);
}
const biggest = [...at80.values()].sort((a, b) => b.max - a.max)[0];
console.log(`  ${biggest.agent}: ${n(biggest.max)} chars, ~${n(est(biggest.max, biggest.agent))} measured-rate tokens`);
for (const [label, ceiling] of CEILINGS) {
  const pctOf = (est(biggest.max, biggest.agent) / ceiling) * 100;
  console.log(`    ${label.padEnd(38)} ${pctOf.toFixed(pctOf < 1 ? 2 : 1)}% of ${n(ceiling)} tokens`);
}

if (TOKENIZE) {
  console.log('\n## Measured token counts — largest prompt per agent at 80 pins\n');
  console.log('| agent | tier | model | chars | chars/4 | measured tokens | chars per token |');
  console.log('| :---- | :--- | :---- | ----: | ------: | --------------: | --------------: |');
  for (const agent of ORDER) {
    const row = at80.get(agent);
    if (!row?.biggest) continue;
    try {
      const { model, promptTokens } = await tokenCount(row.biggest);
      console.log(`| ${agent} | ${row.tier} | ${model} | ${n(row.max)} | ${n(est(row.max, agent))} |`
        + ` ${n(promptTokens)} | ${(row.max / (promptTokens || 1)).toFixed(2)} |`);
    } catch (err) {
      console.log(`| ${agent} | ${row.tier} | — | ${n(row.max)} | ${n(est(row.max, agent))} | FAILED — ${String(err).slice(0, 60)} | — |`);
    }
  }
  console.log('\nA measured count far below chars/4 means the runtime window truncated the prompt');
  console.log('before the model ever saw it, which is silent and is the failure worth finding.');
}

rmSync(SCRATCH, { recursive: true, force: true });
