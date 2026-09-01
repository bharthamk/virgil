import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Learner } from '@sb/core';
import { memberEmail, type LearnerAccessPolicy } from './access-policy.js';

export interface TenantMemberRouteContext {
  readonly access: LearnerAccessPolicy | null;
  readonly learner: Learner | null;
  readonly readBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  readonly reply: (res: ServerResponse, status: number, body: unknown) => void;
  readonly badRequest: (message: string) => never;
  readonly forbidden: (message: string) => never;
}

const receipt = (membership: NonNullable<ReturnType<LearnerAccessPolicy['membership']>>) => ({
  ...membership, sharedModelSetup: true, isolatedBoard: true,
});

export async function handleTenantMemberRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: TenantMemberRouteContext,
): Promise<boolean> {
  if (url.pathname !== '/tenant/members'
    || !['GET', 'POST', 'DELETE'].includes(req.method ?? '')) return false;
  if (!context.access || !context.learner) {
    context.reply(res, 404, { error: 'not found' });
    return true;
  }
  const current = context.access.membership(context.learner);
  if (!current) context.forbidden('this account is not a member of this Virgil installation');
  if (req.method === 'GET') {
    context.reply(res, 200, receipt(current));
    return true;
  }
  if (current.role !== 'owner' || !current.editable) {
    context.forbidden('only the Virgil owner can change members');
  }
  const body = await context.readBody(req);
  if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'email')) {
    context.badRequest('body must contain only email');
  }
  let email: string;
  try { email = memberEmail(body.email); }
  catch (error) {
    context.badRequest(error instanceof Error ? error.message : 'enter a valid email address');
  }
  if (req.method === 'DELETE' && email === context.learner.email?.trim().toLowerCase()) {
    context.badRequest('the Virgil owner cannot be removed');
  }
  const changed = req.method === 'POST'
    ? await context.access.addMember(context.learner, email)
    : await context.access.removeMember(context.learner, email);
  if (!changed) context.forbidden('only the Virgil owner can change members');
  context.reply(res, 200, receipt(changed));
  return true;
}
