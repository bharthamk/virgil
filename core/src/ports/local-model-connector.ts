import type { LlmRequest, ModelTier } from './llm.js';

export const LOCAL_CONNECTOR_PROTOCOL = 'virgil-local-model-connector' as const;
export const LOCAL_CONNECTOR_VERSION = 1 as const;
export const LOCAL_CONNECTOR_LEASE_MS = 60_000;

export interface LocalConnectorRequest {
  readonly tier: ModelTier;
  readonly reasoning?: 'on' | 'off';
  readonly system: string;
  readonly prompt: string;
  readonly maxOutputTokens?: number;
  readonly media?: LlmRequest['media'];
  readonly structured: boolean;
  readonly schema?: unknown;
}

export interface LocalConnectorResult {
  readonly value: unknown;
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface LocalConnectorJob {
  readonly id: string;
  readonly state: 'queued' | 'claimed' | 'completed' | 'failed';
  readonly request: LocalConnectorRequest;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly leaseId?: string;
  readonly leaseUntil?: string;
  readonly result?: LocalConnectorResult;
  readonly error?: string;
}

/** Short-lived mailbox shared by the hosted service/job and one paired local worker. */
export interface LocalConnectorStore {
  pairLocalConnector(tokenHash: string): Promise<void>;
  unpairLocalConnector(): Promise<void>;
  localConnectorPaired(): Promise<boolean>;
  verifyLocalConnector(tokenHash: string): Promise<boolean>;
  touchLocalConnector(now: string): Promise<void>;
  localConnectorReady(now: string): Promise<boolean>;
  enqueueLocalConnectorJob(job: LocalConnectorJob): Promise<void>;
  claimLocalConnectorJob(now: string, leaseId: string): Promise<LocalConnectorJob | null>;
  renewLocalConnectorJob(id: string, leaseId: string, now: string): Promise<boolean>;
  finishLocalConnectorJob(
    id: string, leaseId: string, outcome: { result: LocalConnectorResult } | { error: string },
  ): Promise<boolean>;
  readLocalConnectorJob(id: string): Promise<LocalConnectorJob | null>;
  deleteLocalConnectorJob(id: string): Promise<void>;
}

export function isLocalConnectorStore(value: unknown): value is LocalConnectorStore {
  const candidate = value as Partial<LocalConnectorStore> | null;
  return Boolean(candidate
    && typeof candidate.pairLocalConnector === 'function'
    && typeof candidate.unpairLocalConnector === 'function'
    && typeof candidate.localConnectorPaired === 'function'
    && typeof candidate.verifyLocalConnector === 'function'
    && typeof candidate.touchLocalConnector === 'function'
    && typeof candidate.localConnectorReady === 'function'
    && typeof candidate.enqueueLocalConnectorJob === 'function'
    && typeof candidate.claimLocalConnectorJob === 'function'
    && typeof candidate.renewLocalConnectorJob === 'function'
    && typeof candidate.finishLocalConnectorJob === 'function'
    && typeof candidate.readLocalConnectorJob === 'function'
    && typeof candidate.deleteLocalConnectorJob === 'function');
}
