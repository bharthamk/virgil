/**
 * The thing that consumes `exhaustedForPeriod`, and the ledger it decrements.
 *
 * ## Where the gap actually was
 *
 * The adapter is not the gap. `adapters/src/gemini-llm.ts` decodes `RetryInfo`
 * into `retryAfterMs`, decodes the quota id, and derives `exhaustedForPeriod`
 * from `/PerDay/` — it has done since the transport proof, and its taxonomy is
 * right. The orchestration policy is not the gap either: `adk/src/errors.ts`
 * landed with the ADK merge and does exactly what transport-proof the quota-retry policy
 * asked for — exhausted outranks retryable, a day cap degrades rather than
 * waits, and `isTerminalForSeam` tells the host to stop pretending later stages
 * were attempted.
 *
 * The gap is that **the benchmark harness runs `runBatch`, which is not the
 * ADK host**, and nothing between the adapter and the pipeline reads either
 * field. `GEMINI_BENCHMARK_2026-08-20.md` anomaly 2 predicts the consequence
 * exactly: a nightly begun with the deep tier spent issues one doomed request
 * per stage — about six — each failing its stage into its own degrade path.
 * Six requests of noise, and on a twenty-request day that is nearly a third of
 * the cap spent finding out the same fact six times.
 *
 * So the fix is here, at the seam the benchmark actually owns, and it is one
 * rule: **once a day cap has been seen on a tier, no further request on that
 * tier reaches the wire.** The stage still fails, still degrades, still reports
 * — it just does not pay for the privilege.
 *
 * No adapter change was needed and none was made. The error taxonomy is
 * `adk/src/errors.ts`'s, imported rather than re-implemented: it duck-types the
 * seam's promised properties instead of importing `GeminiError`, which is what
 * lets a benchmark harness use the same classifier the orchestration host does
 * without either of them learning which provider is behind the tier.
 *
 * ## What the ledger is for
 *
 * Counting successful calls is a cost model. Counting ATTEMPTS is a quota — the
 * free tier bills the 429 as readily as the 200 — so the ledger increments
 * before the await, not after, and a request refused locally is not counted
 * because it never happened.
 *
 * ## The second thing this file learned, on 2026-08-21
 *
 * At 00:23 PT the ruled deep benchmark met a **provider capacity outage**:
 * seventeen requests, seventeen identical `503 UNAVAILABLE`, two minutes twelve
 * seconds, and not one number worth keeping. Everything above worked exactly as
 * written — a 503 is not an exhaustion signal, so nothing stopped, and the run
 * dutifully spent every planned attempt finding out the same fact seventeen
 * times. That is the day cap's failure mode wearing different clothes.
 *
 * The difference is that a day cap announces itself in one response and an
 * outage does not announce itself at all. Each 503 is individually retryable,
 * individually degradable, indistinguishable from a blip. What makes it a
 * run-ending fact is *the third one in a row saying the same thing*, and
 * nothing here was counting. The quota-accounting contract says to count: **three identical
 * consecutive failures and the run stops issuing requests.**
 *
 * The quota-accounting contract also settles the accounting those seventeen requests raised. A
 * transport failure with no exhaustion signal never reached the model, so it is
 * an attempt but not a billed request, and the two are now tracked apart. The
 * *cap* is still enforced on attempts — a request that has been sent cannot be
 * un-sent, and guessing in the run's own favour is how a day gets spent twice —
 * but the number the reconciliation reports is presumed billing, and both are
 * printed so nobody has to choose which one to believe.
 */

import { classify, isTerminalForSeam, messageOf } from '../adk/dist/index.js';

/** Raised instead of a request, when making the request would be pointless or unsafe. */
export class QuotaRefusal extends Error {
  constructor(reason, detail) {
    super(detail);
    this.name = 'QuotaRefusal';
    this.reason = reason;
    // Carried so the pipeline degrades this stage the same way it degrades a
    // real day cap. A refusal that looked like a bug would be read as one.
    this.exhaustedForPeriod = reason === 'exhausted';
    this.retryable = false;
    this.quotaId = reason === 'exhausted' ? 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' : undefined;
  }
}

/**
 * Identical consecutive failures before the run gives up. The quota-accounting contract.
 *
 * Three, and the number is doing real work in both directions. Two would trip
 * on the ordinary pair of blips that a retry clears; ten would have let the
 * 2026-08-21 washout spend its whole allocation before saying anything. Three
 * is the smallest count that cannot be a coincidence.
 */
export const BREAKER_THRESHOLD = 3;

/** The exit code an aborted run leaves behind. Distinct, so a script can grep it. */
export const EXIT_CIRCUIT_BREAKER = 4;

/** What the run says it was when the breaker stopped it. One string, everywhere. */
export const OUTCOME_CIRCUIT_BREAKER = 'aborted-circuit-breaker';

/**
 * What makes two failures "the same failure".
 *
 * Status and kind, which is what the contract names, and deliberately **not** the
 * message: providers reword capacity notices without changing what they mean,
 * and a breaker keyed on prose is a breaker that never trips. The signature is
 * built to be readable in an artefact — `degrade/transport/503/UNAVAILABLE` is
 * a sentence an operator can act on at 02:00.
 */
export function failureSignature(directive, err) {
  const e = (typeof err === 'object' && err !== null) ? err : {};
  const status = typeof e.status === 'number' ? e.status : '—';
  const provider = typeof e.providerStatus === 'string' && e.providerStatus ? e.providerStatus : '—';
  return `${directive.kind}/${directive.reason ?? 'named-delay'}/${status}/${provider}`;
}

/**
 * Did this failure reach the model — i.e. is the provider going to have counted it?
 *
 * The quota-accounting contract: *transport-level 503s that arrive WITHOUT a provider exhaustion
 * signal do not count against the day's request ledger — they never reached the
 * model.* Read narrowly, on purpose. A 5xx is the front door saying it could not
 * pass the request on. A 429 is a quota decision, which means something did the
 * counting; a 4xx is the request itself being refused. Both of those stay
 * presumed-billed, because over-counting the day is the safe direction to be
 * wrong in and this file is not in a position to audit the provider's meter.
 */
function reachedTheModel(directive, err) {
  const e = (typeof err === 'object' && err !== null) ? err : {};
  const status = typeof e.status === 'number' ? e.status : 0;
  return !(directive.kind === 'degrade' && directive.reason === 'transport' && status >= 500);
}

/**
 * The running count. One object, passed everywhere, printed at the end.
 *
 * `reserve` is held against the DEEP tier only. The fast tier was never once
 * rate-limited across ~80 calls in the transport proof and ~11 in the benchmark;
 * reserving against a limit nobody has met would cut real work for nothing.
 */
export function makeLedger({ dayCap = 20, reserve = 3, breaker = BREAKER_THRESHOLD } = {}) {
  return {
    dayCap,
    reserve,
    /**
     * Requests ISSUED. This is what the cap and the reserve are enforced on,
     * and it is deliberately the pessimistic number — see `deepBilled`.
     */
    deepSpent: 0,
    fastSpent: 0,
    /**
     * Requests presumed to have been counted by the provider (the quota-accounting contract).
     *
     * Equal to the attempts on any ordinary run. It diverges only when a
     * request failed in transport without an exhaustion signal, which is the
     * one case the contract says the day did not pay for.
     */
    deepBilled: 0,
    fastBilled: 0,
    /** The attempts the contract says never reached the model. The difference, itemised. */
    unbilled: [],
    deepExhausted: false,
    fastExhausted: false,
    /** Every attempt, in order, for the run log. */
    attempts: [],
    /** Requests this file refused to make, and why. The interesting column. */
    refusals: [],
    /** Set when the deep tier is stopped, so the runner can mark stages cut. */
    stoppedAt: null,
    /** Identical consecutive failures the breaker gives the provider. The quota-accounting contract. */
    breaker,
    /** The run of identical failures currently in progress, if any. */
    streak: null,
    /** Set once, when the breaker opens. From here the run issues nothing. */
    tripped: null,
    stage: 'boot',
  };
}

export const deepRemaining = (ledger) => ledger.dayCap - ledger.deepSpent;
export const deepAllocatable = (ledger) => Math.max(0, deepRemaining(ledger) - ledger.reserve);

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The longest per-minute wait worth taking inside one benchmark run.
 *
 * Per-minute caps on this key have come back with hints of 7s and 11s and have
 * cleared on the first retry. A hint longer than this is either a different
 * limit class wearing a per-minute name or a service under load, and either way
 * the run should degrade the stage rather than stall a scheduled window.
 */
export const MAX_WAIT_MS = 65_000;

/**
 * Wrap an `Llm` so every call is counted, capped, and classified.
 *
 * Deliberately NOT a retry policy for the product. `adapters/src/gemini-llm.ts`
 * documents why the adapter does not retry — provider-retry constraint keeps nightly cost and latency
 * predictable — and this wrapper is benchmark tooling that is wired into no
 * composition root. The one retry it does take is the per-minute wait the
 * provider itself named, which is the case the transport proof measured
 * working, and it is counted as a second request because it is one.
 */
export function guard(inner, ledger, opts = {}) {
  const sleep = opts.sleep ?? defaultSleep;
  const onEvent = opts.onEvent ?? (() => {});

  const spentKey = (tier) => (tier === 'deep' ? 'deepSpent' : 'fastSpent');
  const billedKey = (tier) => (tier === 'deep' ? 'deepBilled' : 'fastBilled');
  const exhaustedKey = (tier) => (tier === 'deep' ? 'deepExhausted' : 'fastExhausted');

  /**
   * Count a failure the run is not going to recover from, and open the breaker
   * if this is the third identical one in a row.
   *
   * "In a row" is per tier, because the two tiers are two model endpoints and a
   * fast-tier success says nothing about whether the deep one is answering.
   * Anything that is not a failure of the same shape — a success, a different
   * status — clears the streak: the run is no longer in one state, and a
   * breaker that survived that would be counting a coincidence.
   */
  const recordFailure = (tier, signature) => {
    const s = ledger.streak;
    if (s && s.tier === tier && s.signature === signature) s.count += 1;
    else ledger.streak = { tier, signature, count: 1, from: ledger.stage };

    if (!ledger.tripped && ledger.streak.count >= ledger.breaker) {
      ledger.tripped = {
        tier,
        signature,
        count: ledger.streak.count,
        stage: ledger.stage,
        at: new Date().toISOString(),
        from: ledger.streak.from,
      };
      onEvent({ kind: 'tripped', tier, stage: ledger.stage, signature, count: ledger.streak.count });
    }
  };

  const call = async (method, req, isRetry = false) => {
    const tier = req?.tier === 'deep' ? 'deep' : 'fast';

    // ---- refusals, before the wire -------------------------------------
    /**
     * The breaker is checked first and applies to every tier. A provider
     * outage is not a property of a tier, and "stop issuing requests" ruled at
     * 2026-08-21 means the run, not the endpoint that happened to notice.
     */
    if (ledger.tripped) {
      const t = ledger.tripped;
      const refusal = new QuotaRefusal(
        'circuit-open',
        `the circuit breaker is open — ${t.count} identical ${t.signature} failure(s) in a row`
        + ` on the ${t.tier} tier at "${t.stage}". Request not issued: one more copy of an answer`
        + ` the provider has already given ${t.count} times buys nothing.`,
      );
      ledger.refusals.push({ stage: ledger.stage, tier, reason: 'circuit-open' });
      onEvent({ kind: 'refused', tier, reason: 'circuit-open', stage: ledger.stage });
      throw refusal;
    }

    if (ledger[exhaustedKey(tier)]) {
      const refusal = new QuotaRefusal(
        'exhausted',
        `the ${tier} tier's daily cap was already met in this run — request not issued`
        + ' (a per-day quota does not refill on a retry, and each doomed request still bills)',
      );
      ledger.refusals.push({ stage: ledger.stage, tier, reason: 'exhausted' });
      onEvent({ kind: 'refused', tier, reason: 'exhausted', stage: ledger.stage });
      throw refusal;
    }

    if (tier === 'deep' && deepAllocatable(ledger) <= 0) {
      const refusal = new QuotaRefusal(
        'reserve',
        `the deep tier's hard reserve of ${ledger.reserve} call(s) is all that remains`
        + ` (${deepRemaining(ledger)} left of ${ledger.dayCap}) — request not issued`,
      );
      ledger.refusals.push({ stage: ledger.stage, tier, reason: 'reserve' });
      onEvent({ kind: 'refused', tier, reason: 'reserve', stage: ledger.stage });
      throw refusal;
    }

    // ---- the attempt ----------------------------------------------------
    const started = Date.now();
    ledger[spentKey(tier)] += 1;
    // Presumed billed until the failure proves otherwise. An in-flight request
    // counts: the pessimistic direction is the safe one for a quota.
    ledger[billedKey(tier)] += 1;
    const attempt = { stage: ledger.stage, tier, at: new Date().toISOString(), billed: true };
    if (isRetry) attempt.isRetry = true;
    ledger.attempts.push(attempt);

    try {
      const res = await inner[method](req);
      attempt.ok = true;
      attempt.ms = Date.now() - started;
      // This tier's endpoint answered. Whatever run of failures preceded it on
      // THIS tier was weather rather than an outage — and only on this tier:
      // a nightly interleaves fast Clusterer and Verifier calls with the deep
      // ones, so an unconditional reset would let a healthy fast tier hold the
      // breaker open forever while the deep tier answered nothing.
      if (ledger.streak?.tier === tier) ledger.streak = null;
      return res;
    } catch (err) {
      attempt.ok = false;
      attempt.ms = Date.now() - started;
      attempt.error = messageOf(err).slice(0, 160);

      const directive = classify(err);
      attempt.directive = directive.kind;
      attempt.reason = directive.reason ?? null;

      const signature = failureSignature(directive, err);
      attempt.signature = signature;

      // The quota-accounting contract’s accounting, applied to this one request.
      if (!reachedTheModel(directive, err)) {
        attempt.billed = false;
        ledger[billedKey(tier)] -= 1;
        ledger.unbilled.push({ stage: ledger.stage, tier, signature });
      }

      // 1. A day cap. The whole point of this file.
      if (isTerminalForSeam(directive)) {
        ledger[exhaustedKey(tier)] = true;
        if (tier === 'deep' && !ledger.stoppedAt) ledger.stoppedAt = ledger.stage;
        onEvent({ kind: 'exhausted', tier, stage: ledger.stage, note: directive.note });
        // NOT waited on. The 429 that closed 2026-08-20 carried a RetryInfo of
        // 49 seconds beside a quotaId that said `...PerDay...`; anything backing
        // off on the provider's own hint retries a cap that does not refill for
        // hours. `exhaustedForPeriod` is the only correct signal and this is the
        // branch that reads it.
        throw err;
      }

      // 2. A per-minute cap, with a hint short enough to be worth taking. One
      //    retry, counted as its own request, because that is what it is.
      //
      //    `isRetry` is the guard, and it has to be a parameter rather than a
      //    flag on the attempt: the recursion builds a FRESH attempt, so a flag
      //    set on this one is invisible to the next and a provider answering
      //    429-with-RetryInfo forever was retried until the reserve refused it.
      //
      //    Ruled 32: the wait the harness already handles does not count toward
      //    the breaker — a run recovering as designed must not trip it. The
      //    RETRY does count, and it is where `recordFailure` sees this failure
      //    if the wait bought nothing.
      if (directive.kind === 'retry-after' && !isRetry) {
        if (directive.ms > MAX_WAIT_MS) {
          onEvent({ kind: 'wait-too-long', tier, ms: directive.ms, stage: ledger.stage });
          recordFailure(tier, signature);
          throw err;
        }
        onEvent({ kind: 'waiting', tier, ms: directive.ms, stage: ledger.stage });
        await sleep(directive.ms);
        attempt.retried = true;
        return call(method, req, true);
      }

      recordFailure(tier, signature);
      throw err;
    }
  };

  return {
    get modelId() { return inner.modelId; },
    complete: (req) => call('complete', req),
    structured: (req) => call('structured', req),
  };
}

/** Point the ledger at a stage, so every attempt is attributed to one. */
export const enterStage = (ledger, stage) => { ledger.stage = stage; };

/**
 * Why the remaining stages are cut, in words the artefact can use verbatim.
 *
 * Said once, at the top of the results, rather than repeated per stage: a run
 * that reports six degraded stages and does not say they share one cause reads
 * as six problems.
 */
export const abortNote = (ledger) => {
  const notes = [];

  if (ledger.tripped) {
    const t = ledger.tripped;
    notes.push(
      `RUN ABORTED — CIRCUIT BREAKER: ${t.count} identical ${t.signature} failure(s) in a row on the`
      + ` ${t.tier} tier, first at "${t.from}" and last at "${t.stage}". No further request was issued,`
      + ` by any tier. ${ledger.refusals.filter((r) => r.reason === 'circuit-open').length} were refused`
      + ' before the wire. This is a statement about the provider, not about the quota:'
      + ` ${ledger.deepSpent} deep request(s) were attempted and ${ledger.deepBilled} are presumed billed.`,
    );
  }

  if (ledger.deepExhausted) {
    notes.push(
      `DEEP TIER STOPPED at stage "${ledger.stoppedAt}" — the free-tier daily cap was met after`
      + ` ${ledger.deepSpent} deep request(s). Every later deep stage was CUT, not attempted, and`
      + ` ${ledger.refusals.filter((r) => r.tier === 'deep').length} request(s) were refused before the wire.`
      + ' The provider\'s RetryInfo was not waited on: a per-day quota does not refill on a retry.',
    );
  }

  return notes.length ? notes.join(' ') : null;
};
