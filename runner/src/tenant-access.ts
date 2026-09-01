import { FirestoreTenantDirectory } from '@sb/adapters';
import type { FirestoreWiring } from './runtime.js';
import {
  allowedEmailsFrom, judgeDailyCloudTokensFrom, judgePassHashFrom,
  learnerAccessPolicy, ownerEmailFrom, requestsPerMinuteFrom,
  type LearnerAccessPolicy,
} from './access-policy.js';

interface TenantAccessEnv {
  readonly K_SERVICE?: string | undefined;
  readonly VIRGIL_OWNER_EMAIL?: string | undefined;
  readonly VIRGIL_ALLOWED_EMAILS?: string | undefined;
  readonly VIRGIL_REQUESTS_PER_MINUTE?: string | undefined;
  readonly VIRGIL_JUDGE_ACCESS_CODE_SHA256?: string | undefined;
  readonly VIRGIL_JUDGE_DAILY_CLOUD_TOKENS?: string | undefined;
}

export async function openTenantAccess(options: {
  readonly env: TenantAccessEnv;
  readonly authProjectId: string | null;
  readonly wiring: FirestoreWiring | null;
}): Promise<LearnerAccessPolicy | null> {
  const bootstrapEmails = allowedEmailsFrom(options.env.VIRGIL_ALLOWED_EMAILS);
  const ownerEmail = ownerEmailFrom(options.env.VIRGIL_OWNER_EMAIL, bootstrapEmails);
  const hostedIdentity = Boolean(options.env.K_SERVICE && options.authProjectId);
  const judgePassHash = judgePassHashFrom(options.env.VIRGIL_JUDGE_ACCESS_CODE_SHA256);
  if (hostedIdentity && ownerEmail === null) {
    throw new Error('hosted identity requires VIRGIL_OWNER_EMAIL or VIRGIL_ALLOWED_EMAILS; refusing an ownerless build');
  }
  if (!ownerEmail) return null;

  const directory = hostedIdentity && options.wiring && options.authProjectId
    ? new FirestoreTenantDirectory({
      tenantId: options.wiring.projectId ?? options.authProjectId,
      projectId: options.wiring.projectId ?? options.authProjectId,
      ownerEmail,
      initialMembers: bootstrapEmails,
      ...(options.wiring.allowProduction === undefined
        ? {} : { allowProduction: options.wiring.allowProduction }),
    })
    : null;
  const tenant = directory ? await directory.ensure() : null;
  if (judgePassHash && !directory) {
    throw new Error('private judge access requires hosted identity and a durable board store');
  }
  return learnerAccessPolicy({
    ownerEmail,
    allowedEmails: tenant?.memberEmails ?? [ownerEmail, ...bootstrapEmails],
    requestsPerMinute: requestsPerMinuteFrom(options.env.VIRGIL_REQUESTS_PER_MINUTE),
    judgePassHash,
    judgeDailyCloudTokens: judgeDailyCloudTokensFrom(options.env.VIRGIL_JUDGE_DAILY_CLOUD_TOKENS),
    ...(directory ? { directory } : {}),
  });
}
