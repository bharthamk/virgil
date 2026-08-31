import type { Llm, LlmRequest, LlmResult, ModelTier, Reasoning, Embedder } from '@sb/core';
import { LlmRefused } from '@sb/core';

/**
 * Token accounting for the nightly run.
 *
 * The cost model is built from token counts and published per-token prices,
 * and from nothing else. Local wall-clock durations are deliberately excluded:
 * they measure this Mac under whatever else it happens to be running, they do
 * not measure Gemini, and a cost model that quietly mixes the two is a cost
 * model that cannot be checked. `StageReport.ms` stays where it is for
 * operational reporting; it never enters this file.
 *
 * Metering sits at the PORT, not in an adapter. `LlmResult` already carries
 * `inputTokens` / `outputTokens` because every provider reports them, so the
 * same decorator counts Ollama today and Gemini after the port with no change.
 * Putting the counter in `OllamaLlm` would have made the numbers a property of
 * the test bed rather than of the fleet.
 *
 * Known and deliberate gap: `Llm.structured` retries internally on truncation
 * and schema drift (see the escalation in `OllamaLlm.structured`), and only the
 * attempt that succeeded reaches this decorator. Discarded attempts are
 * therefore uncounted. That is honest for the shipped shape — Gemini enforces
 * `responseSchema` natively, so most of that escalation collapses at port — but
 * it means these figures are a floor, not a ceiling, and COST_MODEL.md says so.
 */

/**
 * WHICH HALF OF THE PRODUCT SPENT IT.
 *
 * Three lanes because the learner's question has three distinct owners and one
 * sum. A tap is something they just did and can decide not to do again; a run is
 * board work they scheduled or requested; setup is work the service initiated
 * while starting, such as the local model warm-up. Rolling any two together
 * would manufacture an action or hide who initiated the work.
 */
export type UsageLane =
  /** Something the learner pressed. Charged to the thing they pressed. */
  | 'taps'
  /** A board run: the nightly, an automatic run, or Process. */
  | 'runs'
  /** Service-initiated preparation, never presented as a learner gesture. */
  | 'setup';

export const USAGE_LANES: readonly UsageLane[] = ['taps', 'runs', 'setup'];

/** One accounting bucket: a lane, a stage, a tier, a model. */
export interface LlmUsageRow {
  readonly lane: UsageLane;
  readonly stage: string;
  readonly tier: ModelTier;
  readonly reasoning: Reasoning;
  readonly modelId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * Requests that were issued and did not come back: a 503, a 429, a timeout,
   * a reply the adapter could not read.
   *
   * They are counted because **the usage-accounting contract says every issued request
   * is presumed billed** — there is no unbilled-503 category on this provider,
   * and that amendment exists because a run that took 17 × 503 and then 3 more
   * on retry hit `GenerateRequestsPerDayPerProjectPerModel-FreeTier` at exactly
   * twenty. Every one of those twenty was billed and this meter recorded none
   * of them, because it recorded after the await and nothing ever returned.
   *
   * Tokens are not carried here. A request that did not return reported no
   * usage block, and inventing a number for it would be worse than a count.
   *
   * A call that was REFUSED is not in here and must never be. `LlmRefused` —
   * the learner's own budget stop, or a connection with no credential saved —
   * means nothing was sent, so there is no issued request to presume billed.
   * The decorators drop it before it reaches the meter; see `billable`.
   */
  issuedNotReturned: number;
}

/**
 * The embedding port reports no token counts — an embedding API bills on input
 * text and returns a vector, not a usage block. So the honest record is what we
 * actually know: how many texts, and how long they were. Tokens are estimated
 * downstream from characters, and the estimate is labelled as one.
 */
export interface EmbedUsageRow {
  readonly lane: UsageLane;
  readonly stage: string;
  readonly modelId: string;
  /** Number of `embed()` invocations. */
  calls: number;
  /** Number of individual texts embedded across those invocations. */
  inputs: number;
  inputChars: number;
  /** Per-text character counts, so the size distribution survives the run. */
  inputSizes: number[];
}

export interface LlmTotals { calls: number; inputTokens: number; outputTokens: number }
export interface EmbedTotals { calls: number; inputs: number; inputChars: number }

export interface UsageReport {
  readonly runAt: string;
  readonly llm: {
    /** Everything, both lanes. The number the learner asked for first. */
    readonly totals: LlmTotals;
    /**
     * The same arithmetic, split the way the question is asked.
     *
     * Derived from the rows rather than counted alongside them, so the split
     * and the total can never disagree — the same reason `stars` is a
     * projection of `points` and is not stored beside it.
     */
    readonly byLane: Record<UsageLane, LlmTotals>;
    readonly rows: readonly LlmUsageRow[];
  };
  readonly embed: {
    readonly totals: EmbedTotals;
    readonly byLane: Record<UsageLane, EmbedTotals>;
    readonly rows: readonly EmbedUsageRow[];
  };
  readonly notes: readonly string[];
}

export class UsageMeter {
  private stage = 'unattributed';
  private readonly llmRows = new Map<string, LlmUsageRow>();
  private readonly embedRows = new Map<string, EmbedUsageRow>();

  /**
   * The nightly's stages run strictly in sequence, so one current-stage marker
   * is enough to attribute every call — including the two stages that fan out
   * internally, whose concurrency is entirely inside a single stage.
   *
   * The service is the other case, and it is why `recordLlm` takes a stage. Two
   * requests overlap the moment two windows are open, and a marker set by one
   * and read by the other attributes a pin's label to a marked answer. Nothing
   * would go red; the cost model would simply be wrong about which tap costs
   * what, which is the only thing a cost model is for.
   */
  enter(stage: string): void { this.stage = stage; }

  recordLlm(
    req: LlmRequest, res: LlmResult<unknown>, lane: UsageLane, stage: string = this.stage,
  ): void {
    const reasoning: Reasoning = req.reasoning ?? 'on';
    const key = `${lane}|${stage}|${req.tier}|${reasoning}|${res.modelId}`;
    let row = this.llmRows.get(key);
    if (!row) {
      row = {
        lane, stage, tier: req.tier, reasoning, modelId: res.modelId,
        calls: 0, inputTokens: 0, outputTokens: 0, issuedNotReturned: 0,
      };
      this.llmRows.set(key, row);
    }
    row.calls++;
    row.inputTokens += res.inputTokens;
    row.outputTokens += res.outputTokens;
  }

  /**
   * A request that was issued and did not come back.
   *
   * Bucketed without a model id, because there is not always one: the failure
   * may be the transport rather than the model, and a row keyed on a model the
   * provider never named would be a guess in the ledger. `(unreturned)` is the
   * honest key.
   */
  recordLlmFailure(req: LlmRequest, lane: UsageLane, stage: string = this.stage): void {
    const reasoning: Reasoning = req.reasoning ?? 'on';
    const key = `${lane}|${stage}|${req.tier}|${reasoning}|(unreturned)`;
    let row = this.llmRows.get(key);
    if (!row) {
      row = {
        lane, stage, tier: req.tier, reasoning, modelId: '(unreturned)',
        calls: 0, inputTokens: 0, outputTokens: 0, issuedNotReturned: 0,
      };
      this.llmRows.set(key, row);
    }
    row.issuedNotReturned++;
  }

  recordEmbed(
    modelId: string, texts: readonly string[], lane: UsageLane, stage: string = this.stage,
  ): void {
    const key = `${lane}|${stage}|${modelId}`;
    let row = this.embedRows.get(key);
    if (!row) {
      row = { lane, stage, modelId, calls: 0, inputs: 0, inputChars: 0, inputSizes: [] };
      this.embedRows.set(key, row);
    }
    row.calls++;
    row.inputs += texts.length;
    for (const t of texts) { row.inputChars += t.length; row.inputSizes.push(t.length); }
  }

  report(runAt: string): UsageReport {
    const rows = [...this.llmRows.values()];
    const embed = [...this.embedRows.values()];
    const llmOf = (rs: readonly LlmUsageRow[]): LlmTotals => ({
      calls: rs.reduce((a, r) => a + r.calls, 0),
      inputTokens: rs.reduce((a, r) => a + r.inputTokens, 0),
      outputTokens: rs.reduce((a, r) => a + r.outputTokens, 0),
    });
    const embedOf = (rs: readonly EmbedUsageRow[]): EmbedTotals => ({
      calls: rs.reduce((a, r) => a + r.calls, 0),
      inputs: rs.reduce((a, r) => a + r.inputs, 0),
      inputChars: rs.reduce((a, r) => a + r.inputChars, 0),
    });
    // Both lanes are always present, at zero where nothing happened. A lane
    // that disappeared when it was empty would make "nothing ran overnight"
    // and "this build does not count runs" the same answer.
    const byLane = <T>(f: (lane: UsageLane) => T): Record<UsageLane, T> =>
      Object.fromEntries(USAGE_LANES.map((l) => [l, f(l)])) as Record<UsageLane, T>;
    return {
      runAt,
      llm: {
        totals: llmOf(rows),
        byLane: byLane((lane) => llmOf(rows.filter((r) => r.lane === lane))),
        rows,
      },
      embed: {
        totals: embedOf(embed),
        byLane: byLane((lane) => embedOf(embed.filter((r) => r.lane === lane))),
        rows: embed,
      },
      notes: [
        'Token counts are reported by the provider, not estimated.',
        'Retried attempts inside Llm.structured are not counted; only the attempt that returned.',
        'issuedNotReturned counts requests that were issued and did not come back. The usage-accounting contract as '
          + 'amended presumes every issued request billed, so a failing provider must not read as free.',
        'Embedding tokens are not reported by the embedding port — character counts are recorded instead.',
        'No wall-clock duration enters this record by design.',
      ],
    };
  }
}

/**
 * A throw this meter must NOT count.
 *
 * `issuedNotReturned` means "issued and presumed billed" — the usage-accounting contract as
 * amended, written after twenty free-tier requests died as 503s and were billed
 * anyway. A refusal is the opposite fact: `LlmRefused` is the seam's word for
 * *nothing was sent*, and its two instances are the learner's own budget stop
 * and a connection with no credential saved. Counting either of them here bills
 * somebody for a call this product declined to make on their behalf, and puts
 * the number on the same display that is supposed to explain why they were
 * stopped.
 *
 * Shared by both decorators below so the lanes cannot drift on it, which is
 * exactly how the runs lane came to record nothing at all.
 */
const billable = (error: unknown): boolean => !(error instanceof LlmRefused);

/**
 * Counts every call that returns. Adds no behaviour of its own.
 *
 * The lane is stated at the call site and has no default, deliberately: a
 * decorator that guessed would put a night's spend in the learner's tap column
 * on the day somebody wires a third caller, and the whole point of the split is
 * that a learner can tell the two apart.
 *
 * **Failures are counted here too, and they were not.** `meterLlmAs` grew the
 * `issuedNotReturned` catch while this wrapper did not,
 * so for as long as both have existed a provider falling over in the FOREGROUND
 * cost something visible and the same provider falling over on the nightly read
 * as free — on the lane that spends with nobody watching, and the lane whose
 * own 503 storm is exactly the failure this protection addresses. Two decorators
 * over one meter must not disagree about what a throw means.
 */
export const meterLlm = (llm: Llm, meter: UsageMeter, lane: UsageLane): Llm => ({
  async complete(req) {
    try {
      const res = await llm.complete(req);
      meter.recordLlm(req, res, lane);
      return res;
    } catch (err) {
      if (billable(err)) meter.recordLlmFailure(req, lane);
      throw err;
    }
  },
  async structured<T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> {
    try {
      const res = await llm.structured<T>(req);
      meter.recordLlm(req, res, lane);
      return res;
    } catch (err) {
      if (billable(err)) meter.recordLlmFailure(req, lane);
      throw err;
    }
  },
});

/**
 * The same counter, told at the call which bucket this belongs in.
 *
 * For the service, where requests overlap and `enter` cannot mean anything.
 * Every handler that reaches a model names its own stage, so attribution is a
 * property of the call site rather than of whatever happened to run last.
 */
export const meterLlmAs = (
  llm: Llm, meter: UsageMeter, stage: string, lane: UsageLane,
): Llm => ({
  async complete(req) {
    try {
      const res = await llm.complete(req);
      meter.recordLlm(req, res, lane, stage);
      return res;
    } catch (err) {
      // Recorded and rethrown. Every caller's behaviour is unchanged; the
      // difference is that a provider failing costs something visible instead
      // of looking free. See `issuedNotReturned` — and see `billable`, which is
      // the half of that rule this catch was missing: a request that was never
      // issued has no bill to presume.
      if (billable(err)) meter.recordLlmFailure(req, lane, stage);
      throw err;
    }
  },
  async structured<T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> {
    try {
      const res = await llm.structured<T>(req);
      meter.recordLlm(req, res, lane, stage);
      return res;
    } catch (err) {
      if (billable(err)) meter.recordLlmFailure(req, lane, stage);
      throw err;
    }
  },
});

/**
 * The embedding counter.
 *
 * `stage` is optional and means the same thing it does for the model: pass it
 * where requests overlap, leave it where they cannot. A run's stages are
 * strictly sequential so the marker `enter` sets is sufficient there — but a
 * foreground embed made WHILE a run is going would otherwise be filed under
 * whatever stage that run happens to be in, which is exactly the cross-talk
 * `meterLlmAs` exists to avoid. Now that the service meters both lanes through
 * one ledger, that is no longer hypothetical.
 */
export const meterEmbedder = (
  embedder: Embedder, meter: UsageMeter, lane: UsageLane, stage?: string,
): Embedder => ({
  get modelId() { return embedder.modelId; },
  async embed(texts) {
    const out = await embedder.embed(texts);
    if (stage === undefined) meter.recordEmbed(embedder.modelId, texts, lane);
    else meter.recordEmbed(embedder.modelId, texts, lane, stage);
    return out;
  },
});

/** Fixed-width console block. Printed after the stage lines in the run summary. */
export function formatUsage(r: UsageReport): string {
  const lines: string[] = [];
  const n = (x: number) => x.toLocaleString('en-US');
  lines.push('token accounting — counts only, no durations');
  lines.push(`  ${'lane'.padEnd(6)}${'stage'.padEnd(12)}${'tier'.padEnd(6)}${'model'.padEnd(20)}${'calls'.padStart(6)}${'in'.padStart(10)}${'out'.padStart(10)}`);
  for (const row of r.llm.rows) {
    lines.push(`  ${row.lane.padEnd(6)}${row.stage.padEnd(12)}${row.tier.padEnd(6)}${row.modelId.slice(0, 19).padEnd(20)}`
      + `${String(row.calls).padStart(6)}${n(row.inputTokens).padStart(10)}${n(row.outputTokens).padStart(10)}`);
  }
  lines.push(`  ${'TOTAL'.padEnd(44)}${String(r.llm.totals.calls).padStart(6)}`
    + `${n(r.llm.totals.inputTokens).padStart(10)}${n(r.llm.totals.outputTokens).padStart(10)}`);
  for (const row of r.embed.rows) {
    const sizes = [...row.inputSizes].sort((a, b) => a - b);
    const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] ?? 0 : 0;
    lines.push(`  embed ${row.lane}/${row.stage} — ${row.modelId}: ${row.calls} call(s), ${row.inputs} inputs,`
      + ` ${n(row.inputChars)} chars (median ${n(median)}, max ${n(sizes.at(-1) ?? 0)})`);
  }
  return lines.join('\n');
}
