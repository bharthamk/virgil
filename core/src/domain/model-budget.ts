import type { ModelMode } from './types.js';

/**
 * A spend limit the learner sets, and the switch that stops model work when it
 * is reached.
 *
 * ## Why this is denominated in tokens and not in money
 *
 * There is no price table in this repository. `usage.ts` says the cost model is
 * built "from token counts and published per-token prices", and the prices half
 * of that sentence has never existed in code — nothing under `core/`,
 * `adapters/` or `runner/` carries a rate for any model. A budget that showed
 * dollars would therefore be showing a number this build invented, against
 * prices that change without telling us, on a model id the router picks at call
 * time. That is exactly the kind of figure the accounting notes in `usage.ts`
 * refuse to produce for unreturned requests, and the same refusal applies here.
 *
 * So the unit is tokens, and `unit` is carried in the record and in every
 * receipt so no surface can render the number as anything else. Adding a money
 * unit later is additive: a second `ModelBudgetUnit`, a real price table with an
 * as-of date beside it, and this state machine unchanged.
 *
 * Input and output tokens are summed. They are not billed at the same rate
 * anywhere, so a token budget is a proxy rather than an invoice — the receipt
 * says so in `notes`, and the per-connection breakdown keeps both halves
 * visible so nobody has to take the total on trust.
 *
 * ## Why only the cloud connection is guarded
 *
 * Three connections reach a model: `cloud` (Gemini, billed by Google), `local`
 * (Ollama on the learner's own machine) and `cli` (the operator's own harness).
 * Only one of them can present a bill. A kill switch that also stopped Ollama
 * would be taking away the free option at the exact moment the paid one ran
 * out, which is the opposite of what somebody who set a spend limit wants.
 *
 * All three are still counted, and the receipt shows all three. Activity a
 * learner cannot see is activity they cannot reason about, and "local calls are
 * free" is a claim worth being able to check.
 */

/** Tokens, and deliberately only tokens. See the note above. */
export type ModelBudgetUnit = 'tokens';

/**
 * Total since the budget was set, cleared by an explicit reset.
 *
 * A calendar month would need a timezone, a rollover the service is awake for,
 * and a story about what happens to a limit set on the 31st. Total-since-set
 * needs a timestamp and a button, and it is the shape a learner can check by
 * reading two numbers. A monthly window is additive later — the field exists so
 * that a second value does not change the shape of anything already stored.
 */
export type ModelBudgetWindow = 'total';

export const MODEL_BUDGET_UNIT: ModelBudgetUnit = 'tokens';
export const MODEL_BUDGET_WINDOW: ModelBudgetWindow = 'total';

/**
 * The connections a budget stops. Cloud only, because cloud is the only one
 * that costs money. An array rather than a boolean so the guard reads as a set
 * and a second billed connection is one entry rather than a rewrite.
 */
export const BUDGETED_CONNECTIONS: readonly ModelMode[] = Object.freeze(['cloud'] as const);

/** Warned at four fifths. A flag on the receipt and nothing else — no throttle,
 *  no slower model, no quiet degradation the learner has to discover. */
export const BUDGET_WARN_FRACTION = 0.8;

/**
 * The largest limit this service will store, and the reason it has one.
 *
 * Not a policy about what a learner may spend. It is the difference between a
 * number and a mistake: a billion tokens is far past any real month's work, so
 * a value above it is a typo, a millisecond timestamp pasted into the wrong
 * box, or a client sending something that is not a limit at all. Refusing it
 * with the field named is kinder than storing it and calling it a budget.
 */
export const MAX_BUDGET_TOKENS = 1_000_000_000;

export interface ModelBudget {
  /** Whole tokens. Always at least 1 — a budget of zero is a cleared budget. */
  readonly limit: number;
  readonly unit: ModelBudgetUnit;
  readonly window: ModelBudgetWindow;
  /** When the learner set this limit. Not when the window last reset. */
  readonly setAt: string;
}

/** What one connection has done since the window opened. */
export interface ConnectionSpend {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Requests issued that did not come back, counted and never given tokens.
   *
   * The quota-accounting contract as amended presumes every issued request billed, so these are
   * shown rather than dropped. They are not added to the budgeted total: the
   * provider reported no usage block for them, and inventing a token count to
   * charge against a learner's limit would be worse than a visible count of
   * calls whose size nobody knows.
   */
  readonly issuedNotReturned: number;
}

export interface ModelSpend {
  /** When this window opened, or `null` if nothing has been recorded yet. */
  readonly since: string | null;
  readonly connections: Readonly<Record<ModelMode, ConnectionSpend>>;
}

export type ModelBudgetStatus = 'off' | 'ok' | 'warning' | 'exhausted';

export interface ModelBudgetState {
  /**
   * `off` — no limit set, nothing is being stopped.
   * `ok` — under four fifths of the limit.
   * `warning` — at or over four fifths, and still running.
   * `exhausted` — at or over the limit; the guarded connection is stopped.
   */
  readonly status: ModelBudgetStatus;
  readonly limit: number | null;
  readonly unit: ModelBudgetUnit;
  readonly window: ModelBudgetWindow;
  /** Tokens spent on the guarded connections in this window. */
  readonly used: number;
  /** `limit - used`, floored at zero, or `null` when no limit is set. */
  readonly remaining: number | null;
  /** `used / limit`, to four places, or `null` when no limit is set. */
  readonly fraction: number | null;
  readonly warnAtFraction: number;
  /** Which connections this budget stops. The others are counted, never cut. */
  readonly guards: readonly ModelMode[];
  readonly setAt: string | null;
  readonly since: string | null;
}

const zeroConnection = (): ConnectionSpend => ({
  calls: 0, inputTokens: 0, outputTokens: 0, issuedNotReturned: 0,
});

export const emptyModelSpend = (): ModelSpend => ({
  since: null,
  connections: { cloud: zeroConnection(), local: zeroConnection(), cli: zeroConnection() },
});

export const isBudgetedConnection = (mode: ModelMode): boolean =>
  BUDGETED_CONNECTIONS.includes(mode);

/** What the limit is measured against: the guarded connections, in + out. */
export function budgetedTokens(spend: ModelSpend): number {
  let total = 0;
  for (const mode of BUDGETED_CONNECTIONS) {
    const row = spend.connections[mode];
    total += row.inputTokens + row.outputTokens;
  }
  return total;
}

/** Every connection, for the display. Never compared to the limit. */
export function totalTokens(spend: ModelSpend): number {
  let total = 0;
  for (const row of Object.values(spend.connections)) total += row.inputTokens + row.outputTokens;
  return total;
}

/** Rounded where it is shown, never where it is compared. */
const toFourPlaces = (n: number): number => Math.round(n * 10_000) / 10_000;

export function modelBudgetState(
  budget: ModelBudget | null | undefined, spend: ModelSpend,
): ModelBudgetState {
  const used = budgetedTokens(spend);
  if (!budget) {
    return {
      status: 'off', limit: null, unit: MODEL_BUDGET_UNIT, window: MODEL_BUDGET_WINDOW,
      used, remaining: null, fraction: null, warnAtFraction: BUDGET_WARN_FRACTION,
      guards: BUDGETED_CONNECTIONS, setAt: null, since: spend.since,
    };
  }
  // The comparisons are on the raw numbers. `fraction` is a rendering of the
  // same division and is rounded, so a receipt that reads 0.8 and a state that
  // reads `ok` are both true — the boundary is decided here, once.
  const status: ModelBudgetStatus = used >= budget.limit
    ? 'exhausted'
    : used >= budget.limit * BUDGET_WARN_FRACTION ? 'warning' : 'ok';
  return {
    status,
    limit: budget.limit,
    unit: budget.unit,
    window: budget.window,
    used,
    remaining: Math.max(0, budget.limit - used),
    fraction: toFourPlaces(used / budget.limit),
    warnAtFraction: BUDGET_WARN_FRACTION,
    guards: BUDGETED_CONNECTIONS,
    setAt: budget.setAt,
    since: spend.since,
  };
}

/**
 * Would a call on this connection be stopped?
 *
 * The whole enforcement decision, as one pure function, so the endpoint that
 * reports the state and the guard that acts on it cannot disagree.
 */
export function budgetStops(
  mode: ModelMode, budget: ModelBudget | null | undefined, spend: ModelSpend,
): boolean {
  if (!budget) return false;
  if (!isBudgetedConnection(mode)) return false;
  return modelBudgetState(budget, spend).status === 'exhausted';
}

const withConnection = (
  spend: ModelSpend, mode: ModelMode, next: ConnectionSpend, at: string,
): ModelSpend => ({
  since: spend.since ?? at,
  connections: { ...spend.connections, [mode]: next },
});

/** One returned call, recorded against the connection it actually ran on. */
export function addLlmSpend(
  spend: ModelSpend, mode: ModelMode,
  result: { readonly inputTokens: number; readonly outputTokens: number },
  at: string,
): ModelSpend {
  const row = spend.connections[mode];
  // A provider that reports a non-number cannot be allowed to make the ledger
  // NaN — every later comparison against the limit would then be false, and a
  // kill switch that silently stops killing is the one failure this must not
  // have. Unreadable counts read as zero and the call is still counted.
  const input = Number.isFinite(result.inputTokens) ? Math.max(0, Math.round(result.inputTokens)) : 0;
  const output = Number.isFinite(result.outputTokens) ? Math.max(0, Math.round(result.outputTokens)) : 0;
  return withConnection(spend, mode, {
    calls: row.calls + 1,
    inputTokens: row.inputTokens + input,
    outputTokens: row.outputTokens + output,
    issuedNotReturned: row.issuedNotReturned,
  }, at);
}

/** One issued call that did not come back. Counted, never given tokens. */
export function addIssuedNotReturned(spend: ModelSpend, mode: ModelMode, at: string): ModelSpend {
  const row = spend.connections[mode];
  return withConnection(spend, mode, { ...row, issuedNotReturned: row.issuedNotReturned + 1 }, at);
}

/**
 * A new window from `at`, over the connections the limit actually measures.
 *
 * Sam, dogfood batch C: he pressed "Start a new window" to zero a budget count
 * he had just been told *"is measured against Cloud/API alone"*, and the record
 * of what his own machine had done — 14 calls, 7,100 tokens on Local — went
 * with it, permanently, with no confirmation and no undo. Nothing on the button
 * had offered to touch it.
 *
 * So the window is the budget's window, and the budget guards `cloud`. The
 * guarded rows go to zero because that is the count the limit is compared
 * against; the unguarded rows carry on because they were never in the
 * comparison and nobody asked for them to be cleared. The receipt says exactly
 * this, in those words, before the button is pressed.
 *
 * Passing no prior spend gives the old behaviour — an empty ledger — which is
 * what a caller opening a window on a board with nothing recorded means.
 */
export const resetModelSpend = (at: string, spend: ModelSpend = emptyModelSpend()): ModelSpend => {
  const connections = { ...spend.connections };
  for (const mode of BUDGETED_CONNECTIONS) connections[mode] = zeroConnection();
  return { since: at, connections };
};

export function isModelBudgetLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
    && Number.isInteger(value) && value >= 1 && value <= MAX_BUDGET_TOKENS;
}

/**
 * A budget read back from storage, or `null`.
 *
 * Defensive because prefs are a document, not a schema: a board written by an
 * older build has no budget at all, and a board written by a newer one may have
 * a shape this build does not know. Anything unreadable reads as no budget —
 * which fails OPEN on enforcement, and is the correct direction for a value
 * whose absence has always meant "nothing is being stopped". A stored budget
 * that this build cannot parse is not evidence that a learner wanted their
 * model work halted.
 */
export function readModelBudget(value: unknown): ModelBudget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!isModelBudgetLimit(row['limit'])) return null;
  if (row['unit'] !== MODEL_BUDGET_UNIT) return null;
  if (row['window'] !== MODEL_BUDGET_WINDOW) return null;
  if (typeof row['setAt'] !== 'string' || !Number.isFinite(Date.parse(row['setAt']))) return null;
  return {
    limit: row['limit'], unit: MODEL_BUDGET_UNIT, window: MODEL_BUDGET_WINDOW,
    setAt: row['setAt'],
  };
}

const readConnection = (value: unknown): ConnectionSpend => {
  const row = (value && typeof value === 'object' && !Array.isArray(value))
    ? value as Record<string, unknown> : {};
  const count = (key: string): number => {
    const n = row[key];
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  };
  return {
    calls: count('calls'),
    inputTokens: count('inputTokens'),
    outputTokens: count('outputTokens'),
    issuedNotReturned: count('issuedNotReturned'),
  };
};

/**
 * The spend window read back from storage.
 *
 * Unreadable counts read as zero rather than as a refusal. The alternative is a
 * service that will not answer at all because one number in a preferences
 * document is a string, and the honest consequence — a window that undercounts
 * what happened before the corruption — is recorded by `since` staying where it
 * was rather than being invented.
 */
export function readModelSpend(value: unknown): ModelSpend {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyModelSpend();
  const row = value as Record<string, unknown>;
  const connections = (row['connections'] && typeof row['connections'] === 'object'
    && !Array.isArray(row['connections']))
    ? row['connections'] as Record<string, unknown> : {};
  const since = typeof row['since'] === 'string' && Number.isFinite(Date.parse(row['since']))
    ? row['since'] : null;
  return {
    since,
    connections: {
      cloud: readConnection(connections['cloud']),
      local: readConnection(connections['local']),
      cli: readConnection(connections['cli']),
    },
  };
}
