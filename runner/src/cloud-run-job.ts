/**
 * The durable boundary between the request-serving half of Virgil and its
 * hosted batch worker.
 *
 * A Cloud Run service using request-based billing cannot keep doing model work
 * after it has answered a pin. It may, however, finish a short Admin API call
 * inside that request and hand the long work to a Job. This adapter does only
 * that. The caller decides whether work is due and derives the board from a
 * verified learner; this file turns those already-bounded facts into one Job
 * execution.
 */

export interface CloudRunJobTarget {
  readonly resource: string;
  readonly projectId: string;
  readonly location: string;
  readonly job: string;
}

export interface HostedRunRequest {
  /** Always produced by `boardIdFor`, never read from a request body. */
  readonly boardId: string;
  /** The learner-day already decided by the service. */
  readonly batchKey: string;
  /** True for the learner's Process press; false for threshold processing. */
  readonly asked: boolean;
  /** Service-generated nonce tying this execution to exactly one receipt. */
  readonly receiptId: string;
}

export interface HostedRunLaunch {
  readonly operationName: string;
}

export interface HostedRunLauncher {
  launch(request: HostedRunRequest): Promise<HostedRunLaunch>;
}

export class CloudRunJobConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'CloudRunJobConfigError'; }
}

/** Whether a failed launch is safe to retry immediately. */
export class CloudRunJobLaunchError extends Error {
  constructor(message: string, readonly ambiguous: boolean) {
    super(message);
    this.name = 'CloudRunJobLaunchError';
  }
}

const RESOURCE = /^projects\/([a-z][a-z0-9-]{4,62})\/locations\/([a-z0-9-]{1,63})\/jobs\/([a-z][a-z0-9-]{0,62})$/;
const BOARD = /^learner-[A-Za-z0-9_-]{1,128}$/;
const DAY = /^20\d{2}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;
const RECEIPT_ID = /^[A-Za-z0-9_-]{16,128}$/;
const OPERATION = /^projects\/[a-z][a-z0-9-]{4,62}\/locations\/[a-z0-9-]{1,63}\/operations\/[A-Za-z0-9_-]{1,200}$/;

/** Parse the one accepted deployment-owned resource grammar. */
export function cloudRunJobTarget(raw: string | null | undefined): CloudRunJobTarget | null {
  const value = raw?.trim();
  if (!value) return null;
  const match = RESOURCE.exec(value);
  if (!match) {
    throw new CloudRunJobConfigError(
      'SB_AUTO_RUN_JOB must be projects/<project>/locations/<region>/jobs/<job>');
  }
  return { resource: value, projectId: match[1]!, location: match[2]!, job: match[3]! };
}

const validDay = (value: string): boolean => {
  if (!DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

/** The exact learner-day a dispatched Job must retain across queue delay. */
export function hostedBatchKey(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (!validDay(value)) throw new CloudRunJobConfigError('SB_BATCH_KEY must be a real YYYY-MM-DD learner day');
  return value;
}

/** The execution-to-receipt nonce. Both variables are present, or neither is. */
export function hostedReceiptId(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (!RECEIPT_ID.test(value)) {
    throw new CloudRunJobConfigError('SB_RUN_RECEIPT_ID must be a valid hosted receipt id');
  }
  return value;
}

type Fetch = typeof fetch;

export interface CloudRunJobLauncherOptions {
  readonly target: CloudRunJobTarget;
  readonly fetch?: Fetch;
  readonly now?: () => number;
  readonly metadataEndpoint?: string;
  readonly apiOrigin?: string;
}

interface AccessTokenReceipt {
  readonly access_token?: unknown;
  readonly expires_in?: unknown;
}

interface OperationReceipt {
  readonly name?: unknown;
}

const readJson = async (response: Response): Promise<Record<string, unknown>> => {
  const body = await response.text();
  if (!response.ok) {
    // Never echo the response body. Google errors can carry project and policy
    // detail which belongs in operator logs, not in a learner receipt.
    throw new Error(`Cloud Run Admin API answered HTTP ${response.status}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new Error('Cloud Run Admin API returned invalid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Cloud Run Admin API returned no object');
  }
  return parsed as Record<string, unknown>;
};

/**
 * Cloud Run v2 Jobs REST adapter, using the instance metadata identity.
 *
 * No SDK is needed and no long-lived credential is stored. The metadata token
 * is cached only in memory until one minute before expiry.
 */
export class CloudRunJobLauncher implements HostedRunLauncher {
  private readonly fetcher: Fetch;
  private readonly now: () => number;
  private readonly metadataEndpoint: string;
  private readonly apiOrigin: string;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly options: CloudRunJobLauncherOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.metadataEndpoint = options.metadataEndpoint
      ?? 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
    this.apiOrigin = options.apiOrigin ?? 'https://run.googleapis.com';
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > this.now()) return this.token.value;
    const response = await this.fetcher(this.metadataEndpoint, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(5_000),
    });
    const receipt = await readJson(response) as AccessTokenReceipt;
    if (typeof receipt.access_token !== 'string' || receipt.access_token.length < 16
        || typeof receipt.expires_in !== 'number' || receipt.expires_in <= 0) {
      throw new Error('Cloud Run metadata returned no usable access token');
    }
    this.token = {
      value: receipt.access_token,
      expiresAt: this.now() + receipt.expires_in * 1_000,
    };
    return this.token.value;
  }

  async launch(request: HostedRunRequest): Promise<HostedRunLaunch> {
    if (!BOARD.test(request.boardId)) throw new Error('automatic run board is not a learner board');
    if (!validDay(request.batchKey)) throw new Error('automatic run batch key is not a real day');
    const receiptId = hostedReceiptId(request.receiptId);
    if (!receiptId) throw new Error('automatic run receipt id is missing');
    const args = ['runner/dist/cli.js', 'process', ...(request.asked ? [] : ['--if-due'])];
    const body = {
      overrides: {
        containerOverrides: [{
          args,
          env: [
            { name: 'SB_STORE', value: `firestore:${this.options.target.projectId}/${request.boardId}` },
            { name: 'SB_BATCH_KEY', value: request.batchKey },
            { name: 'SB_RUN_RECEIPT_ID', value: receiptId },
          ],
        }],
        taskCount: 1,
      },
    };
    let accessToken: string;
    try {
      accessToken = await this.accessToken();
    } catch (err) {
      throw new CloudRunJobLaunchError(
        err instanceof Error ? err.message : 'Cloud Run identity is unavailable', false);
    }
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.apiOrigin}/v2/${this.options.target.resource}:run`, {
          method: 'POST', body: JSON.stringify(body),
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
          },
          signal: AbortSignal.timeout(10_000),
        });
    } catch {
      // The request may have reached Google. Immediate retry could buy the
      // learner two executions, so the persisted lease must remain active.
      throw new CloudRunJobLaunchError('Cloud Run Job launch did not return a response', true);
    }
    if (!response.ok) {
      throw new CloudRunJobLaunchError(
        `Cloud Run Admin API answered HTTP ${response.status}`, false);
    }
    let receipt: OperationReceipt;
    try {
      receipt = await readJson(response) as OperationReceipt;
    } catch {
      throw new CloudRunJobLaunchError('Cloud Run accepted no readable Job operation', true);
    }
    const ownedPrefix = `projects/${this.options.target.projectId}/locations/${this.options.target.location}/operations/`;
    if (typeof receipt.name !== 'string' || !OPERATION.test(receipt.name)
        || !receipt.name.startsWith(ownedPrefix)) {
      throw new CloudRunJobLaunchError('Cloud Run accepted no identifiable Job operation', true);
    }
    return { operationName: receipt.name };
  }
}
