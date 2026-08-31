import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import type {
  Clock, LearnerPrefs, Llm, LlmRequest, LlmResult, ModelBudget, ModelBudgetState, ModelMode,
  ModelSpend, Store,
} from '@sb/core';
import {
  LlmRefused, MAX_BUDGET_TOKENS, MODEL_BUDGET_UNIT, MODEL_BUDGET_WINDOW,
  addIssuedNotReturned, addLlmSpend, budgetStops, isModelBudgetLimit,
  modelBudgetState, mutateLearnerPrefs, readModelBudget, readModelSpend, resetModelSpend, totalTokens,
} from '@sb/core';

import { DEFAULT_MODEL_MODE, effectiveRouteMode, withModelRouteMode } from './model-routing.js';

/**
 * The kill switch, and the ledger it reads.
 *
 * `core/domain/model-budget.ts` decides what a budget MEANS — the unit, the
 * window, which connections are guarded, and when a limit is reached. This file
 * is the part that touches a store and a model: it resolves which connection a
 * request would run on, refuses the request before it is issued when that
 * connection is out of budget, and records what returned.
 *
 * ## Where the number lives
 *
 * In the store, and nowhere else. This class holds no running total of its own,
 * which is the entire reason it can be trusted after a restart, across two
 * request handlers racing, and in the endpoint that reports the state. It costs
 * one `getPrefs` per model call and one `putPrefs` per returned call —
 * deliberately, because a counter cached in a process is a counter that
 * disagrees with the file the next process reads, and a budget somebody can
 * clear by restarting the service is not a budget.
 *
 * `ModelRouter` already reads prefs on every call to pick a connection, so
 * per-call prefs reads are the established shape here rather than a new cost.
 *
 * ## Where the guard sits
 *
 * Outside the usage meter, wrapping it. A budget refusal is not a failed model
 * call and must never be counted as one: `meterLlmAs` records
 * `issuedNotReturned` for anything that throws through it, and the quota-accounting contract reads
 * that field as "issued and presumed billed". A stop that charged the learner
 * for the call it prevented would be worse than no stop at all.
 *
 * ## Where this and the usage report meet, and why they do not double-count
 *
 * They count the same calls and cut them differently, and since the model-budget contract
 * they cover the same set: every model call in this service, foreground and
 * board run alike, passes through `budgetedLlm` on the outside and a
 * `UsageMeter` decorator on the inside. **One pass through both, per call.**
 *
 *  - this ledger cuts by **connection** — cloud, local, cli — because that is
 *    what decides whether a call can bill, and it is persisted in prefs so it
 *    survives a restart and can be a limit;
 *  - `usage.ts` cuts by **lane, stage and tier** — what the learner pressed
 *    versus what the board ran — because that is what somebody can change, and
 *    it lives in the process because it is a report rather than a guard.
 *
 * So the two disagree on purpose about their windows and never about a call.
 * Anyone adding a third wrapper: it goes INSIDE this one, or a stop starts
 * being counted as a spend.
 */

/**
 * A call this service refused because the learner's own limit was reached.
 *
 * Its own type, and not `Error`, so the endpoint layer can answer it with
 * something the panel can say out loud. "The model failed" is a lie about a
 * budget stop and sends somebody to check their API key.
 *
 * It extends `LlmRefused` — the seam's word for "nothing was sent" — because
 * the type alone was not enough to keep that lie out of the product. The
 * endpoint layer here does distinguish the two, but the endpoint layer is not
 * where most of the catching happens: the agents in `core/` catch a model
 * failure and degrade, and `core/` cannot import this class, so a stop reached
 * a learner as `outcome: 'model-failed'` on every path that ran through one.
 * Found live — an exhausted budget, `POST /review`, a 200 saying the check did
 * not run, and the header beside it saying the budget stopped it.
 *
 * The refusal is the general fact and the budget is this service's instance of
 * it. Agents rethrow the general one and never learn what a budget is; the 402
 * below reads the specific one and says what was spent against what was
 * allowed.
 */
export class ModelBudgetStop extends LlmRefused {
  constructor(
    readonly connection: ModelMode,
    readonly state: ModelBudgetState,
  ) {
    super(
      `Your model budget stopped this before anything was sent. `
      + `${state.used.toLocaleString('en-US')} of ${(state.limit ?? 0).toLocaleString('en-US')} `
      + `${state.unit} used on the ${connection === 'cloud' ? 'Cloud/API' : connection} connection. `
      + `Raise the limit or reset the window to carry on.`,
    );
    this.name = 'ModelBudgetStop';
  }
}

/**
 * Whether a budget stop happened while answering THIS request.
 *
 * The reason this exists rather than relying on the thrown error alone: several
 * handlers, and several agents inside `core/`, catch a model failure on purpose
 * and degrade — a pin still gets a fallback label, a mark still comes back
 * saying the check did not run. Those are the right behaviours for a provider
 * outage and the wrong SENTENCE for a budget stop, because "that check did not
 * run" sends somebody to look at their API key when the answer is a limit they
 * set themselves.
 *
 * So the stop is recorded on the request as well as thrown. Handlers that let
 * it propagate answer 402 and say it in the body; handlers that swallow it
 * still carry `x-virgil-model-budget: stopped` on their reply, so no surface is
 * ever forced to guess which of the two happened.
 *
 * `AsyncLocalStorage` rather than a module-level flag for the reason this
 * service already documents about its usage meter: two requests overlap the
 * moment two windows are open, and a marker set by one and read by the other
 * would put one learner's stop on another's reply.
 */
interface BudgetScope {
  stopped: ModelMode | null;
  paidGate: (() => void) | null;
  /** The request's record, when this one is a single call inside it. */
  readonly parent: BudgetScope | null;
}

const scope = new AsyncLocalStorage<BudgetScope>();

/** Runs `fn` with a fresh record of whether the budget stopped anything. */
export const withBudgetScope = <T>(fn: () => T): T =>
  scope.run({ stopped: null, paidGate: null, parent: scope.getStore() ?? null }, fn);

/**
 * One model call's own record, inside whatever record the request already has.
 *
 * Only when there IS one. The fail-closed law below reads a missing scope as
 * "stop everything", and a child scope conjured out of nothing would satisfy
 * that check with a record no ladder was ever going to fire — which is the one
 * way a kill switch is not allowed to fail. No request scope, no child, and
 * `gate` refuses the way it always has.
 */
const withCallScope = <T>(fn: () => Promise<T>): Promise<T> => {
  const parent = scope.getStore();
  if (!parent) return fn();
  return scope.run({ stopped: null, paidGate: null, parent }, fn);
};

const paidGateArmedInCall = (): boolean => scope.getStore()?.paidGate !== null;

/**
 * A stop is recorded on the call it happened to AND on every record above it.
 *
 * The reply header is read off the request's record by a handler that is not
 * inside the call any more, so a stop written only to the child would be a stop
 * the panel never hears about — the exact silence `budgetStopInScope` exists to
 * prevent.
 */
const markStopped = (from: BudgetScope, mode: ModelMode): void => {
  for (let s: BudgetScope | null = from; s !== null; s = s.parent) s.stopped = mode;
};

/** The connection a stop happened on during this request, or `null`. */
export const budgetStopInScope = (): ModelMode | null => scope.getStore()?.stopped ?? null;

/**
 * The paid arm's gate, for the composition root to hand a `KeyLadderLlm`.
 *
 * The free tier is the learner's to spend and the
 * kill-switch guards the switch to money. So when the cloud connection has a
 * free arm, `budgetedLlm` stops gating up front and instead ARMS this scope
 * with the stop it would have thrown — and the ladder fires it only at the
 * moment it reaches for the paid key. A learner whose budget is exhausted
 * keeps every free call they have; the 402 they meet is the same
 * `ModelBudgetStop`, thrown before anything paid is issued.
 *
 * Outside any scope, or with nothing armed, it allows: the CLI's nightly has
 * no overlapping learners and its root passes a direct closure instead.
 */
export const firePaidGateInScope = (): void => {
  scope.getStore()?.paidGate?.();
};

/** Everything a display needs, in one read. */
export interface ModelBudgetReceipt {
  /** The learner's own setting, before a deployment ceiling is applied. */
  readonly learnerBudget: ModelBudget | null;
  /** Deployment-owned ceiling, when this service has one. */
  readonly operatorLimit: number | null;
  readonly budget: ModelBudget | null;
  readonly state: ModelBudgetState;
  readonly spend: ModelSpend;
  /** Tokens across every connection, guarded or not. Never the limit's basis. */
  readonly totalTokens: number;
  /** What these numbers are and are not. Shown, not buried. */
  readonly notes: readonly string[];
}

/**
 * What the receipt refuses to let a surface imply.
 *
 * Every one of these is a limitation that already exists in `usage.ts` and
 * would otherwise have to be rediscovered by whoever builds the panel.
 */
const NOTES: readonly string[] = Object.freeze([
  'Spend is counted in tokens, not money. This build carries no price table, so a currency figure would be invented.',
  'Input and output tokens are summed. They are not billed at the same rate, so this is a proxy for cost, not an invoice.',
  'Token counts are reported by the provider, not estimated.',
  'The limit guards the Cloud/API connection, which is the only one that costs money. Local and Agent CLI calls are counted here and are never stopped by it.',
  'Starting a new window sets the Cloud/API count back to zero, because that is the count the limit is measured against. The Local and Agent CLI counts are left exactly as they are.',
  'Requests that were issued and did not come back are counted as calls and given no tokens, because the provider reported none.',
  'Retried attempts inside a structured call are not counted; only the attempt that returned. These figures are a floor.',
]);

export interface ModelBudgetLedgerOptions {
  readonly store: Pick<Store, 'getPrefs' | 'putPrefs' | 'mutatePrefs'>;
  readonly clock: Clock;
  /** The service's declared default, for boards that predate the route toggles. */
  readonly defaultMode?: ModelMode;
  /** Deployment-owned hard ceiling. A learner may lower it, never clear or
   *  raise it. It uses the same durable spend window as the visible budget. */
  readonly operatorLimit?: number | null;
  /**
   * A persistence failure, reported rather than thrown.
   *
   * The call has already happened and the answer is already paid for by the
   * time this runs. Throwing would discard a result the learner has been
   * charged for in order to complain about a bookkeeping write, so the failure
   * goes to the log and the request completes. The honest consequence — a
   * window that undercounts by the calls whose writes failed — is a smaller
   * harm than the one the alternative causes.
   */
  readonly onWriteError?: (error: unknown) => void;
}

export function operatorModelBudgetFrom(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  if (!isModelBudgetLimit(parsed)) {
    throw new RangeError(`SB_OPERATOR_MODEL_BUDGET_TOKENS must be between 1 and ${MAX_BUDGET_TOKENS}`);
  }
  return parsed;
}

export class ModelBudgetLedger {
  /** Read-modify-write on one document. Concurrent handlers must queue. */
  private chain: Promise<unknown> = Promise.resolve();
  /** One budgeted Cloud/API call at a time inside this process. */
  private admissions: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: ModelBudgetLedgerOptions) {
    if (opts.operatorLimit != null && !isModelBudgetLimit(opts.operatorLimit)) {
      throw new RangeError(`operatorLimit must be between 1 and ${MAX_BUDGET_TOKENS}`);
    }
  }

  private now(): string { return this.opts.clock.now().toISOString(); }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run, run);
    // The chain must not reject, or every later write is skipped. Callers get
    // the real promise; the chain gets a settled one.
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  private async current(): Promise<{ budget: ModelBudget | null; spend: ModelSpend }> {
    const prefs = await this.opts.store.getPrefs();
    return {
      budget: readModelBudget(prefs.modelBudget),
      spend: readModelSpend(prefs.modelSpend),
    };
  }

  private effectiveBudget(budget: ModelBudget | null, spend: ModelSpend): ModelBudget | null {
    const limit = this.opts.operatorLimit ?? null;
    if (limit === null || (budget && budget.limit <= limit)) return budget;
    return {
      limit, unit: MODEL_BUDGET_UNIT, window: MODEL_BUDGET_WINDOW,
      setAt: budget?.setAt ?? spend.since ?? this.now(),
    };
  }

  private receiptOf(budget: ModelBudget | null, spend: ModelSpend): ModelBudgetReceipt {
    const effective = this.effectiveBudget(budget, spend);
    return {
      learnerBudget: budget,
      operatorLimit: this.opts.operatorLimit ?? null,
      budget: effective,
      state: modelBudgetState(effective, spend),
      spend,
      totalTokens: totalTokens(spend),
      notes: NOTES,
    };
  }

  async receipt(): Promise<ModelBudgetReceipt> {
    const { budget, spend } = await this.current();
    return this.receiptOf(budget, spend);
  }

  /**
   * Set the limit, or move an existing one.
   *
   * A NEW budget opens a fresh window: there was nothing being measured before,
   * and charging a learner's first limit against tokens they spent while no
   * limit existed would be a bill for a rule that was not in force.
   *
   * Moving an existing limit — up or down — leaves the window exactly as it is.
   * Raising a limit to keep working must not quietly erase the record of what
   * has been spent; that is what `reset` is for, and it is a separate,
   * deliberate act.
   */
  async setLimit(limit: number): Promise<ModelBudgetReceipt> {
    if (!isModelBudgetLimit(limit)) {
      // The endpoint validates first and names the field. This is the guard for
      // every other caller, and it throws rather than storing a number that
      // would make the state machine meaningless.
      throw new RangeError(`limit must be a whole number of tokens between 1 and ${MAX_BUDGET_TOKENS}`);
    }
    if (this.opts.operatorLimit != null && limit > this.opts.operatorLimit) {
      throw new RangeError(`limit cannot exceed this service's ${this.opts.operatorLimit} token ceiling`);
    }
    return this.serial(async () => {
      const at = this.now();
      let budget: ModelBudget | null = null;
      let spend = readModelSpend(undefined);
      await mutateLearnerPrefs(this.opts.store, (prefs) => {
        const existing = readModelBudget(prefs.modelBudget);
        budget = {
          limit, unit: MODEL_BUDGET_UNIT, window: MODEL_BUDGET_WINDOW,
          setAt: existing ? existing.setAt : at,
        };
        spend = existing
          ? readModelSpend(prefs.modelSpend)
          : resetModelSpend(at, readModelSpend(prefs.modelSpend));
        return { ...prefs, modelBudget: budget, modelSpend: spend };
      });
      return this.receiptOf(budget, spend);
    });
  }

  /**
   * No limit. Nothing is stopped, and the spend record is kept.
   *
   * Clearing is not a wipe. Somebody who turns the limit off still gets to see
   * what they have spent, and the count carries on — which is what makes the
   * display honest for a learner who has never set a budget at all.
   */
  async clear(): Promise<ModelBudgetReceipt> {
    return this.serial(async () => {
      let spend = readModelSpend(undefined);
      await mutateLearnerPrefs(this.opts.store, (prefs) => {
        spend = readModelSpend(prefs.modelSpend);
        return { ...prefs, modelBudget: null, modelSpend: spend };
      });
      return this.receiptOf(null, spend);
    });
  }

  /**
   * A new window from now, over the connections the limit measures.
   *
   * The limit, if there is one, is untouched — and so is every ledger the limit
   * was never compared against. Zeroing Local and Agent CLI here was a button
   * doing more than it said: the page has just finished explaining that the
   * limit guards Cloud/API alone, so the Local row is not the thing anybody
   * pressing this believes they are clearing, and there is no undo.
   */
  async reset(): Promise<ModelBudgetReceipt> {
    return this.serial(async () => {
      let budget: ModelBudget | null = null;
      let spend = readModelSpend(undefined);
      await mutateLearnerPrefs(this.opts.store, (prefs) => {
        budget = readModelBudget(prefs.modelBudget);
        spend = resetModelSpend(this.now(), readModelSpend(prefs.modelSpend));
        return { ...prefs, modelSpend: spend };
      });
      return this.receiptOf(budget, spend);
    });
  }

  /**
   * Which connection this request would run on, or `null` if that cannot be
   * decided.
   *
   * `null` happens when the stored routes are unusable — a workload pointed at
   * a provider that is switched off, or a prefs document this build cannot
   * read. It is not gated and not charged, and it does not need to be: the
   * router throws on exactly the same input, before any request is issued, so
   * nothing is spent on a call whose connection nobody could name.
   */
  async connectionFor(req: Pick<LlmRequest, 'tier' | 'media'>): Promise<ModelMode | null> {
    try {
      const prefs = await this.opts.store.getPrefs();
      return effectiveRouteMode(prefs, req, this.opts.defaultMode ?? DEFAULT_MODEL_MODE);
    } catch {
      return null;
    }
  }

  /**
   * Run one call across the read-gate-call-write gap without letting another
   * billable call make its admission decision against the same old count.
   *
   * The in-process queue covers stores that only implement get/put. The lease
   * is the cross-process half: the hosted service and its job worker have
   * separate ledgers but share prefs through a transactional `mutatePrefs`.
   * Calls with no effective limit, non-cloud calls, and already-stopped calls
   * do not take the lease. The last group still reaches `gate`, where a normal
   * stop is thrown or a free-tier paid-arm stop is armed.
   */
  async admitted<T>(
    req: Pick<LlmRequest, 'tier' | 'media'>,
    run: () => Promise<T>,
  ): Promise<T> {
    const initial = await this.opts.store.getPrefs();
    if (!this.needsAdmission(initial, req)) return run();

    const next = this.admissions.then(
      () => this.withAdmissionLease(req, run),
      () => this.withAdmissionLease(req, run),
    );
    this.admissions = next.then(() => undefined, () => undefined);
    return next;
  }

  private needsAdmission(
    prefs: LearnerPrefs,
    req: Pick<LlmRequest, 'tier' | 'media'>,
  ): boolean {
    let mode: ModelMode;
    try {
      mode = effectiveRouteMode(prefs, req, this.opts.defaultMode ?? DEFAULT_MODEL_MODE);
    } catch {
      return false;
    }
    const spend = readModelSpend(prefs.modelSpend);
    const budget = this.effectiveBudget(readModelBudget(prefs.modelBudget), spend);
    return mode === 'cloud' && budget !== null && !budgetStops(mode, budget, spend);
  }

  private leaseExpired(expiresAt: string): boolean {
    const expires = Date.parse(expiresAt);
    return !Number.isFinite(expires) || expires <= this.opts.clock.now().getTime();
  }

  private leaseExpiry(): string {
    return new Date(this.opts.clock.now().getTime() + 90_000).toISOString();
  }

  private async withAdmissionLease<T>(
    req: Pick<LlmRequest, 'tier' | 'media'>,
    run: () => Promise<T>,
  ): Promise<T> {
    const holder = randomUUID();
    for (;;) {
      const observed = await this.opts.store.getPrefs();
      if (!this.needsAdmission(observed, req)) return run();
      const active = observed.modelBudgetLease;
      if (active && active.holder !== holder && !this.leaseExpired(active.expiresAt)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        continue;
      }

      let claimed = false;
      let needed = true;
      await mutateLearnerPrefs(this.opts.store, (prefs) => {
        needed = this.needsAdmission(prefs, req);
        if (!needed) return prefs;
        const lease = prefs.modelBudgetLease;
        if (lease && lease.holder !== holder && !this.leaseExpired(lease.expiresAt)) return prefs;
        claimed = true;
        return { ...prefs, modelBudgetLease: { holder, expiresAt: this.leaseExpiry() } };
      });
      if (!needed) return run();
      if (claimed) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }

    const renew = setInterval(() => {
      void mutateLearnerPrefs(this.opts.store, (prefs) => prefs.modelBudgetLease?.holder === holder
        ? { ...prefs, modelBudgetLease: { holder, expiresAt: this.leaseExpiry() } }
        : prefs).catch((error) => this.opts.onWriteError?.(error));
    }, 30_000);
    renew.unref();
    try {
      return await run();
    } finally {
      clearInterval(renew);
      try {
        await mutateLearnerPrefs(this.opts.store, (prefs) =>
          prefs.modelBudgetLease?.holder === holder
            ? { ...prefs, modelBudgetLease: null }
            : prefs);
      } catch (error) {
        // The call has already happened. Keep the result and let the short
        // lease expire rather than replacing a paid answer with a write error.
        this.opts.onWriteError?.(error);
      }
    }
  }

  /**
   * The switch itself. Throws `ModelBudgetStop` before the caller reaches a
   * model, or returns the connection the call is about to run on.
   */
  async gate(
    req: Pick<LlmRequest, 'tier' | 'media'>,
    /**
     * `defer` is the free-arm shape: a stop on the
     * cloud connection is not thrown here — it is armed on THIS CALL's scope,
     * and the key ladder fires it only when the free tier could not answer and
     * the paid key is about to be. Every other connection is unchanged:
     * nothing but cloud ever stops.
     */
    behaviour: 'stop' | 'defer' = 'stop',
  ): Promise<ModelMode | null> {
    // One read, not two: the connection and the limit come out of the same
    // prefs document, and reading it twice would let a request be routed
    // against one version and charged against another.
    const prefs = await this.opts.store.getPrefs();
    let mode: ModelMode;
    try {
      mode = effectiveRouteMode(prefs, req, this.opts.defaultMode ?? DEFAULT_MODEL_MODE);
    } catch {
      return null;
    }
    const budget = this.effectiveBudget(
      readModelBudget(prefs.modelBudget), readModelSpend(prefs.modelSpend),
    );
    const spend = readModelSpend(prefs.modelSpend);
    const store = scope.getStore();
    if (budgetStops(mode, budget, spend)) {
      const stop = (): never => {
        const firing = scope.getStore();
        if (firing) markStopped(firing, mode);
        throw new ModelBudgetStop(mode, modelBudgetState(budget, spend));
      };
      if (behaviour === 'stop') stop();
      // Deferral needs somewhere to put the gate. Without a scope the armed
      // stop would evaporate and the paid arm would spend through an exhausted
      // budget silently — so no scope means the old behaviour, which is the
      // failure direction a kill-switch is allowed.
      if (store) store.paidGate = stop; else stop();
      return mode;
    }
    if (store) store.paidGate = null;
    return mode;
  }

  /** One returned call. */
  async record(mode: ModelMode | null, result: LlmResult<unknown>): Promise<void> {
    if (mode === null) return;
    await this.write((spend, at) => addLlmSpend(spend, mode, result, at));
  }

  /** One issued call that did not come back. The quota-accounting contract: it is not free. */
  async recordFailure(mode: ModelMode | null): Promise<void> {
    if (mode === null) return;
    await this.write((spend, at) => addIssuedNotReturned(spend, mode, at));
  }

  private async write(next: (spend: ModelSpend, at: string) => ModelSpend): Promise<void> {
    try {
      await this.serial(async () => {
        await mutateLearnerPrefs(this.opts.store, (prefs) => ({
          ...prefs,
          modelSpend: next(readModelSpend(prefs.modelSpend), this.now()),
        }));
      });
    } catch (error) {
      this.opts.onWriteError?.(error);
    }
  }
}

/**
 * The model, with the learner's limit in front of it.
 *
 * Refusal happens before `llm` is touched at all — which is the property worth
 * testing with a model that throws on any call, because "we stopped it" and "we
 * called it and threw the answer away" are indistinguishable on a bill.
 *
 * Wrap the METERED model with this, not the other way round: see the note at
 * the top of this file.
 *
 * ## A refusal that arrives from INSIDE the try is still a refusal
 *
 * That ordering protects the stop this wrapper throws before the `try`, and
 * when it was written that was the only refusal there was. It has not been for
 * some time. `LlmCredentialMissing` is thrown by the router underneath this
 * line, and since the free-arm contract the deferred `ModelBudgetStop` is thrown
 * by the key ladder underneath it too — both of them inside the `try`, where
 * every throw went straight to `recordFailure`. So a learner who had simply
 * never saved a Cloud/API key watched their own budget window fill up with
 * `issuedNotReturned` for calls that were never built, and the quota-accounting contract reads that
 * field as "issued and presumed billed". `LlmRefused` is the seam's word for
 * "nothing was sent". It is rethrown untouched and nothing is written.
 *
 * ## One scope per call, inside the request's
 *
 * The gate and the model call are run together in a child of whatever budget
 * scope the caller already had (`withCallScope`), so a deferred gate arms on a
 * record only this call can reach. Without that, the record is the request's:
 * the forage and verify stages issue three model calls at once inside one, and
 * a call that gated cleanly could reach the key ladder's paid arm and fire the
 * gate a DIFFERENT call had armed — answering 402 with someone else's
 * connection and someone else's numbers. Where there is no outer scope at all
 * no child is made, and the gate keeps failing closed.
 */
export const budgetedLlm = (
  llm: Llm,
  ledger: ModelBudgetLedger,
  /**
   * `defer` when the cloud connection is a key ladder (a free arm exists):
   * the gate is armed on this call's scope for the ladder's paid arm to fire,
   * so free-tier calls keep flowing after the limit and only money stops.
   */
  behaviour: 'stop' | 'defer' = 'stop',
): Llm => {
  const invoke = <T>(req: LlmRequest, call: () => Promise<LlmResult<T>>): Promise<LlmResult<T>> =>
    withCallScope(async () => {
      const firstMode = await ledger.gate(req, behaviour);
      const issue = async (mode: ModelMode | null): Promise<LlmResult<T>> => {
        let res: LlmResult<T>;
        try {
          res = mode === null ? await call() : await withModelRouteMode(mode, call);
        } catch (error) {
          if (error instanceof LlmRefused) throw error;
          await ledger.recordFailure(mode);
          throw error;
        }
        await ledger.record(mode, res);
        return res;
      };
      // An exhausted deferred call may try the free arm. Its own armed gate
      // stops the paid switch, so it needs no paid admission lease.
      if (behaviour === 'defer' && paidGateArmedInCall()) return issue(firstMode);
      return ledger.admitted(req, async () => {
        // Admission may have waited behind another process. Gate again against
        // the spend that process recorded before this call is issued.
        const admittedMode = await ledger.gate(req, behaviour);
        return issue(admittedMode);
      });
    });

  return {
    complete: (req) => invoke(req, () => llm.complete(req)),
    structured: <T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> =>
      invoke(req, () => llm.structured<T>(req)),
  };
};
