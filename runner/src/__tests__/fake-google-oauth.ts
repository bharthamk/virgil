import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Google's token endpoint, in this process.
 *
 * It checks the two things that make the flow worth calling PKCE: that the
 * verifier presented hashes to the challenge the authorization request carried,
 * and that a code is spent exactly once. A fake that handed a token to anybody
 * would let the whole point of the flow rot without a test going red.
 */
export class FakeGoogleOAuth {
  private server: Server | null = null;
  url = '';

  /** Codes the fake will honour, and the challenge each was issued against. */
  readonly codes = new Map<string, { challenge: string; used: boolean }>();
  /** Refresh tokens it will exchange for an access token. */
  readonly refreshTokens = new Set<string>(['test-refresh-token']);

  /** Answer the next exchange with this error code instead of a grant. */
  nextError: string | null = null;
  /** Leave the refresh token out of the answer, which is the failure that would
   *  otherwise work for an hour and then stop in silence. */
  withholdRefreshToken = false;
  /** How long an issued access token claims to be good for. */
  expiresIn = 3600;

  accessTokensIssued = 0;

  async start(): Promise<string> {
    const server = createServer((req, res) => { void this.handle(req, res); });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
  }

  /** Issue a code against the challenge a consent URL carried, the way Google's
   *  consent screen would after somebody pressed Allow. */
  issueCode(challenge: string, code = 'test-auth-code'): string {
    this.codes.set(code, { challenge, used: false });
    return code;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));

    const fail = (error: string, status = 400): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error }));
    };
    const ok = (body: Record<string, unknown>): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      return fail(error);
    }
    if (!form.get('client_id') || !form.get('client_secret')) return fail('invalid_client');

    if (form.get('grant_type') === 'refresh_token') {
      const token = form.get('refresh_token') ?? '';
      if (!this.refreshTokens.has(token)) return fail('invalid_grant');
      this.accessTokensIssued += 1;
      return ok({ access_token: `test-access-${this.accessTokensIssued}`, expires_in: this.expiresIn });
    }

    if (form.get('grant_type') !== 'authorization_code') return fail('unsupported_grant_type');
    const issued = this.codes.get(form.get('code') ?? '');
    if (!issued || issued.used) return fail('invalid_grant');
    const verifier = form.get('code_verifier') ?? '';
    const hashed = createHash('sha256').update(verifier).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (hashed !== issued.challenge) return fail('invalid_grant');
    issued.used = true;

    this.accessTokensIssued += 1;
    const grant: Record<string, unknown> = {
      access_token: `test-access-${this.accessTokensIssued}`,
      expires_in: this.expiresIn,
      scope: 'https://www.googleapis.com/auth/drive.file',
    };
    if (!this.withholdRefreshToken) {
      grant.refresh_token = 'test-refresh-token';
      this.refreshTokens.add('test-refresh-token');
    }
    return ok(grant);
  }
}
