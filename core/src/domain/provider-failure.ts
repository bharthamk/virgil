/**
 * What a provider failure actually was, read off whatever a stage threw.
 *
 * ## Why this is in `core` and not in `adk`
 *
 * It was in `adk/src/errors.ts`, and that put it out of reach of the thing that
 * needed it most. The runtime could not distinguish a daily provider cap from
 * an empty learning queue, while `BatchOutcome` carried a `quota-degraded` case
 * no code path could produce.
 *
 * The obvious fix was for `pipeline.ts` to import the ADK layer, and
 * `adk-seam.test.ts` refused it, correctly: *"whether the nightly runs under a
 * framework is a composition-root decision, not an import."* The guard was
 * right and the location was wrong. Nothing here is about ADK. It is a pure
 * reading of a failure, it imports nothing, and both the plain pipeline and the
 * framework host are entitled to it.
 *
 * ## Why it reads the error structurally instead of importing it
 *
 * `GeminiError` lives in `adapters/src/gemini-llm.ts`, and importing it here
 * would make this depend on which provider the product runs on — a decision
 * `seam-purity.test.ts` reserves for the composition root. So the classifier
 * duck-types: it reads the *properties the seam promises*, not the class that
 * carries them.
 *
 * That is not a workaround. A second provider will throw a different class with
 * the same two facts on it, and a policy keyed on `instanceof` would silently
 * stop degrading the day that happened — treating a permanent daily cap as an
 * unknown failure, which is the same wrong answer arriving quietly.
 */

/** What the host does next, having caught something out of a stage. */
export type Directive =
  /**
   * Record the stage as failed, keep its predecessors' output, run the next
   * stage. The standing policy: every stage is its own failure unit.
   */
  | { readonly kind: 'degrade'; readonly reason: DegradeReason; readonly note: string }
  /**
   * The provider named a wait it is worth taking — a per-minute cap, not a per-
   * day one. The host does NOT sleep here; it returns the number so the caller,
   * which owns the run's total budget, can decide. An orchestration layer that
   * slept on its own would make the nightly's wall-clock unpredictable in
   * exactly the way provider-retry constraint warns about.
   */
  | { readonly kind: 'retry-after'; readonly ms: number; readonly note: string };

/**
 * Why a stage degraded, in the vocabulary the run report already uses.
 *
 * Distinguished rather than collapsed because they are different facts about the
 * night and lead to different repairs. `exhausted` means the account is out of
 * capacity until tomorrow and every later seam stage will fail the same way;
 * `blocked` means the provider refused this specific content; `transport` is the
 * network; `unknown` is everything nobody has classified yet, and it is last so
 * that adding a case is a widening rather than a rewrite.
 */
export type DegradeReason = 'exhausted' | 'blocked' | 'transport' | 'invalid' | 'unknown';

/**
 * The shape the seam promises on a provider failure.
 *
 * Every field optional, because this is read off `unknown` — the classifier is
 * handed whatever a stage threw, which on a bad day is a string.
 */
interface SeamFailureShape {
  readonly name?: unknown;
  readonly status?: unknown;
  readonly retryable?: unknown;
  readonly exhaustedForPeriod?: unknown;
  readonly retryAfterMs?: unknown;
  readonly quotaId?: unknown;
  readonly finishReason?: unknown;
  readonly blockReason?: unknown;
  readonly message?: unknown;
}

const shape = (err: unknown): SeamFailureShape =>
  (typeof err === 'object' && err !== null) ? err as SeamFailureShape : {};

/** `true` only for a genuine `true`. A truthy string is not a promise kept. */
const isTrue = (v: unknown): boolean => v === true;

const num = (v: unknown): number | undefined =>
  (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? v : undefined;

export const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message
    : typeof err === 'string' ? err
      : typeof shape(err).message === 'string' ? String(shape(err).message)
        : String(err);

/**
 * Read a stage failure and say what the run should do about it.
 *
 * The order of the branches is the contract, so it is worth reading as one:
 *
 *  1. **Exhausted first.** A daily cap outranks retryability, and it has to,
 *     because the envelope that carries `exhaustedForPeriod: true` *also*
 *     carries `retryable: true` — a 429 is retryable in general and pointless in
 *     this particular case. Checking retryability first would degrade nothing
 *     and wait until morning.
 *  2. **Blocked second**, and before transport, because a content refusal
 *     arrives over an ordinary 200 (the content-refusal contract) and has no status to sort on.
 *  3. **Retry-after third**, and only when the provider actually named a delay.
 *     A guessed backoff is a number nobody measured.
 *  4. **Retryable-without-a-delay** degrades rather than retrying: the adapter
 *     deliberately does not retry, and inventing a retry here would move that
 *     policy out of the one place that documents it.
 */
export function classify(err: unknown): Directive {
  const e = shape(err);
  const what = messageOf(err);

  if (isTrue(e.exhaustedForPeriod)) {
    const quota = typeof e.quotaId === 'string' ? e.quotaId : 'unnamed quota';
    return {
      kind: 'degrade',
      reason: 'exhausted',
      note: `${quota} is spent for the period — degraded rather than retried (graceful-degradation constraint); `
        + `every later stage that reaches the model will fail the same way`,
    };
  }

  if (e.finishReason !== undefined || e.blockReason !== undefined || e.name === 'GeminiBlockedError') {
    return {
      kind: 'degrade',
      reason: 'blocked',
      note: `the provider refused this content — a model failure, not an empty answer: ${what}`,
    };
  }

  const delay = num(e.retryAfterMs);
  if (delay !== undefined && isTrue(e.retryable)) {
    return { kind: 'retry-after', ms: delay, note: `the provider asked for ${delay}ms: ${what}` };
  }

  const status = num(e.status);
  if (status !== undefined) {
    // 4xx that is not a cap is a request the provider will refuse identically
    // however many times it is sent. 5xx and 429 are capacity, and degrade
    // because retry policy belongs to the caller, not to this layer.
    const reason: DegradeReason = (status >= 400 && status < 500 && status !== 429) ? 'invalid' : 'transport';
    return { kind: 'degrade', reason, note: `${status}: ${what}` };
  }

  return { kind: 'degrade', reason: 'unknown', note: what };
}

/**
 * True when this failure means every later seam stage is also going to fail.
 *
 * Read by the host to stop pretending: on a spent daily quota the remaining
 * model stages are not "degraded", they are *not attempted*, and a run report
 * that says the former is a report claiming five separate attempts that never
 * happened. The stage list still runs to the end — the pure stages genuinely do
 * work — but the seam stages are marked as skipped for a stated reason.
 */
export const isTerminalForSeam = (d: Directive): boolean =>
  d.kind === 'degrade' && d.reason === 'exhausted';
