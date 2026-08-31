import type { Learner } from '@sb/core';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface LearnerAccessPolicy {
  allows(learner: Learner): boolean;
  take(learnerId: string, now?: number): { readonly allowed: boolean; readonly retryAfter: number };
  membership(learner: Learner): TenantMembershipReceipt | null;
  addMember(learner: Learner, email: string): Promise<TenantMembershipReceipt | null>;
  removeMember(learner: Learner, email: string): Promise<TenantMembershipReceipt | null>;
}

export interface TenantDirectorySnapshot {
  readonly ownerEmail: string;
  readonly memberEmails: readonly string[];
}

export interface TenantMemberDirectory {
  addMember(email: string): Promise<TenantDirectorySnapshot>;
  removeMember(email: string): Promise<TenantDirectorySnapshot>;
}

export interface TenantMembershipReceipt {
  readonly role: 'owner' | 'member';
  readonly editable: boolean;
  readonly members: readonly string[] | null;
}

export interface AccessPolicyOptions {
  readonly allowedEmails: readonly string[];
  readonly ownerEmail?: string;
  readonly requestsPerMinute: number;
  readonly directory?: TenantMemberDirectory;
}

export function allowedEmailsFrom(value: string | undefined): readonly string[] {
  if (!value?.trim()) return [];
  const emails = [...new Set(value.split(',').map((email) => email.trim().toLowerCase()).filter(Boolean))];
  if (emails.some((email) => !EMAIL.test(email))) {
    throw new Error('VIRGIL_ALLOWED_EMAILS must be a comma-separated list of email addresses');
  }
  return emails;
}

export function memberEmail(value: unknown): string {
  if (typeof value !== 'string') throw new Error('email must be a string');
  const normal = value.trim().toLowerCase();
  if (!EMAIL.test(normal) || normal.length > 320) throw new Error('enter a valid email address');
  return normal;
}

export function ownerEmailFrom(value: string | undefined, allowedEmails: readonly string[]): string | null {
  if (value?.trim()) return memberEmail(value);
  return allowedEmails[0] ?? null;
}

export function requestsPerMinuteFrom(value: string | undefined): number {
  if (!value?.trim()) return 120;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 10 || parsed > 10_000) {
    throw new Error('VIRGIL_REQUESTS_PER_MINUTE must be a whole number from 10 to 10000');
  }
  return parsed;
}

/** Fixed-window request gate. Authentication still runs first, so an attacker
 * cannot allocate buckets with invented learner ids. Cloud Run is pinned to a
 * single instance; the durable model ceiling remains the financial boundary
 * across instance restarts. */
export function learnerAccessPolicy(options: AccessPolicyOptions): LearnerAccessPolicy {
  const owner = ownerEmailFrom(options.ownerEmail, options.allowedEmails);
  if (!owner) throw new Error('a tenant access policy requires an owner email');
  let allowed = new Set([owner, ...options.allowedEmails.map(memberEmail)]);
  let mutations: Promise<void> = Promise.resolve();
  const windows = new Map<string, { started: number; used: number }>();
  const role = (learner: Learner): 'owner' | 'member' | null => {
    const email = learner.email?.trim().toLowerCase() ?? '';
    if (!email || !allowed.has(email)) return null;
    return email === owner ? 'owner' : 'member';
  };
  const receipt = (learner: Learner): TenantMembershipReceipt | null => {
    const learnerRole = role(learner);
    if (!learnerRole) return null;
    return {
      role: learnerRole,
      editable: learnerRole === 'owner' && Boolean(options.directory),
      members: learnerRole === 'owner'
        ? [owner, ...[...allowed].filter((email) => email !== owner).sort()]
        : null,
    };
  };
  const change = async (
    learner: Learner,
    email: string,
    update: (directory: TenantMemberDirectory, member: string) => Promise<TenantDirectorySnapshot>,
  ): Promise<TenantMembershipReceipt | null> => {
    const directory = options.directory;
    if (role(learner) !== 'owner' || !directory) return null;
    const operation = mutations.then(async () => {
      const snapshot = await update(directory, memberEmail(email));
      if (snapshot.ownerEmail !== owner) throw new Error('tenant directory owner changed unexpectedly');
      allowed = new Set(snapshot.memberEmails.map(memberEmail));
      return receipt(learner);
    });
    // A rejected write must not poison later owner changes. The caller still
    // receives its rejection; only the private sequencing tail is recovered.
    mutations = operation.then(() => undefined, () => undefined);
    return operation;
  };
  return {
    allows: (learner) => role(learner) !== null,
    take: (learnerId, now = Date.now()) => {
      const prior = windows.get(learnerId);
      const bucket = !prior || now - prior.started >= 60_000 ? { started: now, used: 0 } : prior;
      bucket.used += 1;
      windows.set(learnerId, bucket);
      const allowedRequest = bucket.used <= options.requestsPerMinute;
      return {
        allowed: allowedRequest,
        retryAfter: allowedRequest ? 0 : Math.max(1, Math.ceil((bucket.started + 60_000 - now) / 1_000)),
      };
    },
    membership: receipt,
    addMember: (learner, email) => change(learner, email,
      (directory, member) => directory.addMember(member)),
    removeMember: (learner, email) => change(learner, email,
      (directory, member) => directory.removeMember(member)),
  };
}
