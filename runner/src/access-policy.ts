import type { Learner } from '@sb/core';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface LearnerAccessPolicy {
  allows(learner: Learner): boolean;
  take(learnerId: string, now?: number): { readonly allowed: boolean; readonly retryAfter: number };
  membership(learner: Learner): TenantMembershipReceipt | null;
  addMember(learner: Learner, email: string): Promise<TenantMembershipReceipt | null>;
  removeMember(learner: Learner, email: string): Promise<TenantMembershipReceipt | null>;
  judgeAccess(learner: Learner): JudgeAccessReceipt | null;
  judgeLogin(pass: string, now?: number): JudgeLoginReceipt | null;
  judgeIdentity(token: string, now?: number): Learner | null;
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
  readonly role: 'owner' | 'member' | 'judge';
  readonly editable: boolean;
  readonly members: readonly string[] | null;
}

export interface JudgeAccessReceipt {
  readonly active: true;
  readonly dailyCloudTokens: number;
  readonly resets: '00:00 UTC';
  readonly isolatedBoard: true;
  readonly personalConnections: false;
}

export interface JudgeLoginReceipt extends JudgeAccessReceipt {
  readonly token: string;
  readonly expiresAt: number;
  readonly uid: string;
}

export interface AccessPolicyOptions {
  readonly allowedEmails: readonly string[];
  readonly ownerEmail?: string;
  readonly requestsPerMinute: number;
  readonly directory?: TenantMemberDirectory;
  readonly judgePassHash?: string | null;
  readonly judgeDailyCloudTokens?: number;
}

export const DEFAULT_JUDGE_DAILY_CLOUD_TOKENS = 500_000;
export const JUDGE_WORKSPACE_ID = 'judge-workspace-v1';
const JUDGE_TOKEN_PREFIX = 'virgil-judge-v1';
const JUDGE_SESSION_MS = 30 * 24 * 60 * 60 * 1_000;

export function judgePassHashFrom(value: string | undefined): string | null {
  const hash = value?.trim().toLowerCase() ?? '';
  if (!hash) return null;
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error('VIRGIL_JUDGE_ACCESS_CODE_SHA256 must be a SHA-256 hex digest');
  }
  return hash;
}

const boundedWhole = (value: string | undefined, fallback: number, min: number, max: number, name: string): number => {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  }
  return parsed;
};

export const judgeDailyCloudTokensFrom = (value: string | undefined): number =>
  boundedWhole(value, DEFAULT_JUDGE_DAILY_CLOUD_TOKENS, 10_000, 10_000_000,
    'VIRGIL_JUDGE_DAILY_CLOUD_TOKENS');

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
  const role = (learner: Learner): 'owner' | 'member' | 'judge' | null => {
    if (options.judgePassHash && learner.id === JUDGE_WORKSPACE_ID && learner.email === null) return 'judge';
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
  const judgeReceipt = (learner: Learner): JudgeAccessReceipt | null => role(learner) === 'judge'
    ? {
      active: true,
      dailyCloudTokens: options.judgeDailyCloudTokens ?? DEFAULT_JUDGE_DAILY_CLOUD_TOKENS,
      resets: '00:00 UTC',
      isolatedBoard: true,
      personalConnections: false,
    }
    : null;
  const passMatches = (pass: string): boolean => {
    const expected = options.judgePassHash;
    if (!expected || typeof pass !== 'string' || pass.length < 20 || pass.length > 128) return false;
    const actual = createHash('sha256').update(pass, 'utf8').digest();
    return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
  };
  const tokenSignature = (expiresAt: number): Buffer => createHmac(
    'sha256', Buffer.from(options.judgePassHash ?? '', 'hex'),
  ).update(`${JUDGE_TOKEN_PREFIX}.${JUDGE_WORKSPACE_ID}.${expiresAt}`).digest();
  const tokenFor = (expiresAt: number): string =>
    `${JUDGE_TOKEN_PREFIX}.${expiresAt}.${tokenSignature(expiresAt).toString('base64url')}`;
  const judgeIdentity = (token: string, now = Date.now()): Learner | null => {
    if (!options.judgePassHash || typeof token !== 'string') return null;
    const match = /^virgil-judge-v1\.(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match) return null;
    const expiresAt = Number(match[1]);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return null;
    const actual = Buffer.from(match[2]!, 'base64url');
    const expected = tokenSignature(expiresAt);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    return { id: JUDGE_WORKSPACE_ID, email: null };
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
    judgeAccess: judgeReceipt,
    judgeLogin: (pass, now = Date.now()) => {
      if (!passMatches(pass)) return null;
      const expiresAt = now + JUDGE_SESSION_MS;
      return {
        active: true,
        dailyCloudTokens: options.judgeDailyCloudTokens ?? DEFAULT_JUDGE_DAILY_CLOUD_TOKENS,
        resets: '00:00 UTC',
        isolatedBoard: true,
        personalConnections: false,
        token: tokenFor(expiresAt),
        expiresAt,
        uid: JUDGE_WORKSPACE_ID,
      };
    },
    judgeIdentity,
  };
}
