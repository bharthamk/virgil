import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_BUDGET_TOKENS, MODEL_BUDGET_UNIT, isModelBudgetLimit } from '@sb/core';
import type { ModelBudgetLedger } from './model-budget.js';

export interface ModelBudgetRouteContext {
  readonly budget: ModelBudgetLedger;
  readonly readBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  readonly reply: (res: ServerResponse, code: number, body: unknown) => void;
  readonly badRequest: (message: string) => never;
  /** Deployment-owned boards may expose the receipt without exposing controls. */
  readonly readOnly?: boolean;
}

/** The complete HTTP boundary for the learner-owned model spend limit. */
export async function handleModelBudgetRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ModelBudgetRouteContext,
): Promise<boolean> {
  if (url.pathname === '/model-budget') {
    if (req.method === 'GET') {
      const receipt = await ctx.budget.receipt();
      ctx.reply(res, 200, ctx.readOnly ? { ...receipt, readOnly: true } : receipt);
      return true;
    }
    if (req.method === 'PUT') {
      if (ctx.readOnly) {
        ctx.reply(res, 403, { error: 'the Demo model budget is managed by the service operator' });
        return true;
      }
      const body = await ctx.readBody(req);
      const extra = Object.keys(body).filter((key) => key !== 'limit' && key !== 'unit');
      if (extra.length) {
        ctx.badRequest(`body must contain only limit and unit; ${extra[0]} is not a field here`);
      }
      if (body.unit !== undefined && body.unit !== MODEL_BUDGET_UNIT) {
        ctx.badRequest(`unit must be one of: ${MODEL_BUDGET_UNIT}`);
      }
      if (!isModelBudgetLimit(body.limit)) {
        ctx.badRequest(
          `limit must be a whole number of ${MODEL_BUDGET_UNIT} between 1 and ${MAX_BUDGET_TOKENS}`,
        );
      }
      ctx.reply(res, 200, await ctx.budget.setLimit(body.limit));
      return true;
    }
    if (req.method === 'DELETE') {
      if (ctx.readOnly) {
        ctx.reply(res, 403, { error: 'the Demo model budget is managed by the service operator' });
        return true;
      }
      ctx.reply(res, 200, await ctx.budget.clear());
      return true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/model-budget/reset') {
    if (ctx.readOnly) {
      ctx.reply(res, 403, { error: 'the Demo model budget is managed by the service operator' });
      return true;
    }
    ctx.reply(res, 200, await ctx.budget.reset());
    return true;
  }

  return false;
}
