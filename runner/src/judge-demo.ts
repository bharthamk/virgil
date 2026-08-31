import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Learner } from '@sb/core';
import type { AppOptions } from './service.js';
import type { LearnerAccessPolicy } from './access-policy.js';

export interface JudgeLoginRouteContext {
  readonly access: LearnerAccessPolicy | null;
  readonly readBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  readonly reply: (res: ServerResponse, status: number, body: unknown) => void;
}

export interface JudgeAccessRouteContext {
  readonly access: LearnerAccessPolicy | null;
  readonly learner: Learner | null;
  readonly hostedNeedsRun: boolean;
  readonly hostedRunAvailable: boolean;
  readonly reply: (res: ServerResponse, status: number, body: unknown) => void;
}

/** The only anonymous mutation in Demo mode. Empty deployment configuration
 * makes every password fail, while the public page hides the entrance. */
export async function handleJudgeLoginRoute(
  req: IncomingMessage, res: ServerResponse, url: URL, context: JudgeLoginRouteContext,
): Promise<boolean> {
  if (req.method !== 'POST' || url.pathname !== '/judge/login') return false;
  const admission = context.access?.take(`judge-login:${req.socket.remoteAddress ?? 'unknown'}`);
  if (admission && !admission.allowed) {
    res.setHeader('retry-after', String(admission.retryAfter));
    context.reply(res, 429, { error: 'too many attempts; wait before trying again' });
    return true;
  }
  let body: Record<string, unknown>;
  try { body = await context.readBody(req); }
  catch {
    context.reply(res, 400, { error: 'body must contain only pass' });
    return true;
  }
  if (Object.keys(body).length !== 1 || typeof body.pass !== 'string') {
    context.reply(res, 400, { error: 'body must contain only pass' });
    return true;
  }
  const receipt = context.access?.judgeLogin(body.pass);
  context.reply(res, receipt ? 200 : 403,
    receipt ?? { error: 'that private demo password is not valid' });
  return true;
}

/** The Demo-only capability receipt. It lives beside the identity override so
 * the UI cannot be told a different story from the router that enforces it. */
export function handleJudgeAccessRoute(
  req: IncomingMessage, res: ServerResponse, url: URL, context: JudgeAccessRouteContext,
): boolean {
  if (req.method !== 'GET' || url.pathname !== '/judge/access') return false;
  const judge = context.learner ? context.access?.judgeAccess(context.learner) : null;
  context.reply(res, judge ? 200 : 404, judge ? {
    ...judge,
    capabilities: {
      grow: {
        available: !context.hostedNeedsRun || context.hostedRunAvailable,
        mode: context.hostedRunAvailable
          ? 'cloud-run-job' : context.hostedNeedsRun ? 'unavailable' : 'in-process',
      },
      personalNotebook: false,
      personalDrive: false,
    },
    readOnly: {
      modelConfiguration: true,
      modelBudget: true,
      restore: true,
      permanentDelete: true,
    },
  } : { error: 'not found' });
  return true;
}

/** Demo mode is the normal router over one disposable board, minus inherited
 * personal connections. The features remain in the build and begin off. */
export function judgeDemoOverrides(opts: AppOptions, learner: Learner): Partial<AppOptions> {
  const judge = opts.access?.judgeAccess(learner);
  if (!judge) return {};
  const operatorLimit = Math.min(
    opts.models?.operatorLimit ?? Number.MAX_SAFE_INTEGER, judge.dailyCloudTokens,
  );
  const hostedRun = opts.hostedRun ?? null;
  return {
    judgeSession: true,
    notebook: null,
    drive: null,
    hostedNotebookDriveAccount: null,
    hostedNotebookDrive: null,
    hostedNotebookUrl: null,
    // Keep Grow real in Demo. The launcher receives restrictions from this
    // verified identity boundary; none of them are supplied by the request.
    hostedRun: hostedRun ? {
      launch: (request) => hostedRun.launch({
        ...request,
        policy: {
          operatorLimit,
          operatorWindow: 'day',
          notebookExport: 'disabled',
        },
      }),
    } : null,
    models: {
      ...(opts.models ?? {}),
      operatorLimit,
      operatorWindow: 'day',
    },
  };
}
