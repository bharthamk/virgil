import { LlmCredentialMissing } from '@sb/core';
import type { ModelTier } from '@sb/core';

/** The pair live-probed against this project's us-central1 Vertex endpoint. */
export const VERTEX_GEMINI_TIERS: Readonly<Record<ModelTier, string>> = {
  fast: 'gemini-2.5-flash-lite',
  deep: 'gemini-2.5-flash',
};

/** Cloud Run's service-account token endpoint. It returns a short-lived OAuth
 * token without placing a key in the image, environment, request body or log. */
export const GOOGLE_METADATA_TOKEN_ENDPOINT =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

const REFRESH_MARGIN_MS = 60_000;

export interface VertexCredentialOptions {
  readonly endpoint?: string;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
}

/** A cached Cloud Run identity token source for Vertex prediction calls. */
export class VertexCredential {
  private cached: { token: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(opts: VertexCredentialOptions = {}) {
    this.endpoint = opts.endpoint ?? GOOGLE_METADATA_TOKEN_ENDPOINT;
    this.fetcher = opts.fetcher ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async token(): Promise<string> {
    const now = this.now();
    if (this.cached && this.cached.expiresAt - REFRESH_MARGIN_MS > now) return this.cached.token;
    return (this.refreshing ??= this.refresh()).finally(() => { this.refreshing = null; });
  }

  private async refresh(): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        headers: { 'metadata-flavor': 'Google' },
      });
    } catch (cause) {
      throw new LlmCredentialMissing(
        'cloud', `Vertex service-account metadata did not respond: ${String(cause)}`,
      );
    }
    if (!response.ok) {
      throw new LlmCredentialMissing(
        'cloud', `Vertex service-account metadata refused the token request (${response.status})`,
      );
    }
    const body = await response.json().catch(() => null) as {
      access_token?: unknown; expires_in?: unknown;
    } | null;
    const token = typeof body?.access_token === 'string' ? body.access_token.trim() : '';
    const seconds = Number(body?.expires_in);
    if (!token || !Number.isFinite(seconds) || seconds <= 0) {
      throw new LlmCredentialMissing(
        'cloud', 'Vertex service-account metadata returned no usable access token',
      );
    }
    this.cached = { token, expiresAt: this.now() + seconds * 1000 };
    return token;
  }
}

/** The Vertex REST address for one publisher model, without query parameters. */
export function vertexModelEndpoint(
  projectId: string, location: string,
): (model: string) => string {
  const project = projectId.trim();
  const region = location.trim();
  if (!project || !region) {
    throw new Error('Vertex Gemini needs GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION');
  }
  return (model: string) =>
    `https://${region}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}`
    + `/locations/${encodeURIComponent(region)}/publishers/google/models/${encodeURIComponent(model)}`
    + ':streamGenerateContent';
}
