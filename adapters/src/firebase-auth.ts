import { createPublicKey, createVerify, timingSafeEqual } from 'node:crypto';
import type { Clock, Identity, Learner } from '@sb/core';
import { isLearnerId } from '@sb/core';

/**
 * Firebase Authentication as the `Identity` port (the Firebase identity boundary).
 *
 * A Firebase ID token is a JWT. Deployed, it is RS256 and signed by Google, and
 * this verifies the signature against Google's published certificates. Under
 * the Auth emulator it is UNSIGNED — the emulator issues `alg: none` and an
 * empty signature on purpose, because there is no private key in a local
 * emulator and pretending otherwise would mean shipping one.
 *
 * That difference is the whole security surface of this file, so it is a
 * constructor argument rather than an inference. `alg: none` is the oldest JWT
 * vulnerability there is: a verifier that accepts the token's own claim about
 * how it was signed lets anybody mint any identity. **The emulator is a mode
 * this adapter is put into, never one a token can talk it into.** A token
 * saying `alg: none` to a production verifier is rejected, and there is a test
 * whose only job is that.
 *
 * Certificates are fetched on first use and never at construction. The boot
 * warm-up has an anti-spend test that fails the suite if any `googleapis` host
 * is reached while the process starts, and a verifier that dialled out to be
 * built would trip it — correctly, because a service that cannot start without
 * the network is a service that cannot start.
 */

const GOOGLE_CERTS =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

export interface FirebaseAuthOptions {
  /** The Firebase project. A token's `aud` must equal it exactly. */
  readonly projectId: string;
  readonly clock: Clock;
  /**
   * `host:port` of a running Auth emulator. Present means unsigned tokens are
   * accepted; absent means signatures are required. Nothing else switches it.
   */
  readonly emulatorHost?: string | undefined;
  /**
   * Where the signing certificates come from. Injected only by tests — the
   * default reaches Google, lazily.
   */
  readonly certs?: (() => Promise<Record<string, string>>) | undefined;
  /** Seconds of clock skew tolerated on `exp` and `iat`. */
  readonly leewaySeconds?: number | undefined;
  /** Where a rejection is explained. The reason never reaches the caller. */
  readonly log?: ((reason: string) => void) | undefined;
}

interface Claims {
  readonly sub?: unknown;
  readonly aud?: unknown;
  readonly iss?: unknown;
  readonly exp?: unknown;
  readonly iat?: unknown;
  readonly email?: unknown;
  readonly email_verified?: unknown;
  readonly [k: string]: unknown;
}

export class FirebaseAuth implements Identity {
  readonly #projectId: string;
  readonly #clock: Clock;
  readonly #emulator: boolean;
  readonly #certs: () => Promise<Record<string, string>>;
  readonly #leeway: number;
  readonly #log: (reason: string) => void;
  #cached: { at: number; certs: Record<string, string> } | null = null;

  constructor(opts: FirebaseAuthOptions) {
    if (!opts.projectId) throw new Error('FirebaseAuth needs a projectId — a token audience is checked against it');
    this.#projectId = opts.projectId;
    this.#clock = opts.clock;
    this.#emulator = Boolean(opts.emulatorHost);
    this.#certs = opts.certs ?? (() => this.#fetchGoogleCerts());
    this.#leeway = opts.leewaySeconds ?? 60;
    this.#log = opts.log ?? (() => {});
  }

  /** Whether this verifier is in the mode that accepts unsigned tokens. Read
   *  by the composition root so a deployed process can refuse to start in it. */
  get acceptsUnsigned(): boolean { return this.#emulator; }

  async verify(token: string): Promise<Learner | null> {
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 3) return this.#no('not three segments');

    const header = decodeSegment(parts[0]!);
    const claims = decodeSegment(parts[1]!) as Claims | null;
    if (!header || !claims) return this.#no('segment is not base64url json');

    const alg = typeof header['alg'] === 'string' ? header['alg'] : '';

    if (this.#emulator) {
      // The emulator signs nothing, so there is nothing to check but the
      // shape. Anything claiming to be signed is not an emulator token.
      if (alg !== 'none') return this.#no(`emulator verifier got alg=${alg}`);
    } else {
      // The rejection that matters. A token is not allowed to tell the verifier
      // it does not need verifying.
      if (alg !== 'RS256') return this.#no(`refusing alg=${alg || '(absent)'} — production requires RS256`);
      const kid = typeof header['kid'] === 'string' ? header['kid'] : '';
      if (!kid) return this.#no('no kid');
      const ok = await this.#signatureHolds(parts, kid);
      if (!ok) return this.#no('signature does not hold');
    }

    // Claims are checked identically in both modes. The emulator not signing is
    // not a reason for it to hand out tokens for other people's projects.
    const now = Math.floor(this.#clock.now().getTime() / 1000);

    if (claims.aud !== this.#projectId) return this.#no(`aud ${String(claims.aud)} is not this project`);
    if (claims.iss !== `https://securetoken.google.com/${this.#projectId}`) {
      return this.#no(`iss ${String(claims.iss)} is not this project's issuer`);
    }
    if (typeof claims.exp !== 'number' || claims.exp + this.#leeway < now) return this.#no('expired');
    if (typeof claims.iat === 'number' && claims.iat - this.#leeway > now) return this.#no('issued in the future');

    // `sub` becomes a board id, so it is held to the board id's rule here
    // rather than trusted and validated somewhere further in.
    if (!isLearnerId(claims.sub)) return this.#no('sub is not a usable learner id');

    // Membership is email-address based. A signed token proves who issued the
    // claims, but an address is not an authorization fact until Firebase says
    // it verified that address. Anonymous identities remain valid learners;
    // they simply carry no email and cannot satisfy a tenant allowlist.
    const verifiedEmail = typeof claims.email === 'string' && claims.email_verified === true
      ? claims.email : null;
    return { id: claims.sub, email: verifiedEmail };
  }

  #no(reason: string): null {
    this.#log(reason);
    return null;
  }

  async #signatureHolds(parts: readonly string[], kid: string): Promise<boolean> {
    let certs: Record<string, string>;
    try {
      certs = await this.#loadCerts();
    } catch (e) {
      // A verifier that cannot reach its certificates fails CLOSED. The
      // alternative is that a network fault becomes an authentication bypass.
      this.#log(`certificates unavailable: ${(e as Error).message}`);
      return false;
    }
    const pem = certs[kid];
    if (!pem) {
      // Google rotates keys, so an unknown kid may simply be a stale cache.
      this.#cached = null;
      try {
        const fresh = await this.#loadCerts();
        if (!fresh[kid]) return false;
        return this.#check(parts, fresh[kid]!);
      } catch { return false; }
    }
    return this.#check(parts, pem);
  }

  #check(parts: readonly string[], pem: string): boolean {
    try {
      const verifier = createVerify('RSA-SHA256');
      verifier.update(`${parts[0]}.${parts[1]}`);
      verifier.end();
      const signature = Buffer.from(parts[2]!, 'base64url');
      return verifier.verify(createPublicKey(pem), signature);
    } catch { return false; }
  }

  async #loadCerts(): Promise<Record<string, string>> {
    const now = this.#clock.now().getTime();
    if (this.#cached && now - this.#cached.at < 60 * 60 * 1000) return this.#cached.certs;
    const certs = await this.#certs();
    this.#cached = { at: now, certs };
    return certs;
  }

  async #fetchGoogleCerts(): Promise<Record<string, string>> {
    const res = await fetch(GOOGLE_CERTS);
    if (!res.ok) throw new Error(`certificates: ${res.status}`);
    return await res.json() as Record<string, string>;
  }
}

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const json = Buffer.from(segment, 'base64url').toString('utf8');
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** Kept exported for the shared-secret comparison the service does next to
 *  this one, so both constant-time comparisons come from one place. */
export function constantTimeEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
