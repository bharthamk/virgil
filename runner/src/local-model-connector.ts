import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  LlmCredentialMissing,
  LOCAL_CONNECTOR_PROTOCOL,
  LOCAL_CONNECTOR_VERSION,
  type Llm,
  type LlmRequest,
  type LlmResult,
  type LocalConnectorJob,
  type LocalConnectorRequest,
  type LocalConnectorResult,
  type LocalConnectorStore,
} from '@sb/core';

const TOKEN_PREFIX = 'virgil-local-v1';
const JOB_TTL_MS = 15 * 60_000;
const POLL_MS = 500;

export const localConnectorTokenHash = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export const localConnectorExecutionRequest = (
  request: LocalConnectorRequest,
): LocalConnectorRequest => request.reasoning === 'on' && request.tier === 'fast'
  ? { ...request, tier: 'deep' }
  : request;

export function createLocalConnectorToken(learnerId: string): string {
  return `${TOKEN_PREFIX}.${Buffer.from(learnerId).toString('base64url')}.${randomBytes(32).toString('base64url')}`;
}

export function localConnectorLearnerId(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || parts[2]!.length < 40) return null;
  try {
    const learnerId = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    return /^[A-Za-z0-9_-]{1,128}$/.test(learnerId) ? learnerId : null;
  } catch { return null; }
}

export const localConnectorPairingReceipt = (token: string) => ({
  protocol: LOCAL_CONNECTOR_PROTOCOL,
  version: LOCAL_CONNECTOR_VERSION,
  token,
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class LocalConnectorLlm implements Llm {
  constructor(private readonly store: LocalConnectorStore) {}

  complete(req: LlmRequest): Promise<LlmResult<string>> {
    return this.call<string>(req, false);
  }

  structured<T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> {
    return this.call<T>(req, true);
  }

  private async call<T>(req: LlmRequest, structured: boolean): Promise<LlmResult<T>> {
    const now = new Date();
    if (!await this.store.localConnectorReady(now.toISOString())) {
      throw new LlmCredentialMissing('local', 'No paired local connector is currently polling.');
    }
    const job: LocalConnectorJob = {
      id: randomUUID(),
      state: 'queued',
      request: {
        tier: req.tier,
        ...(req.reasoning ? { reasoning: req.reasoning } : {}),
        system: req.system,
        prompt: req.prompt,
        ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}),
        ...(req.media ? { media: req.media } : {}),
        structured,
        ...(req.schema ? { schema: req.schema } : {}),
      },
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + JOB_TTL_MS).toISOString(),
    };
    await this.store.enqueueLocalConnectorJob(job);
    try {
      while (Date.now() < Date.parse(job.expiresAt)) {
        const current = await this.store.readLocalConnectorJob(job.id);
        if (current?.state === 'completed' && current.result) {
          return current.result as LlmResult<T>;
        }
        if (current?.state === 'failed') throw new Error(current.error ?? 'Local connector failed.');
        await sleep(POLL_MS);
      }
      throw new Error('Local connector timed out before returning a model response.');
    } finally {
      await this.store.deleteLocalConnectorJob(job.id).catch(() => {});
    }
  }
}

export function localConnectorResult(value: LlmResult<unknown>): LocalConnectorResult {
  return {
    value: value.value,
    modelId: value.modelId,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
  };
}
