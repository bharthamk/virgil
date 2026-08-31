/**
 * Who is asking.
 *
 * Identity must be service-backed so multiple learners remain isolated across
 * browsers and sessions.
 *
 * It was not in a browser session. It was worse: there was no learner identity
 * anywhere in this system. `boardId` was a process-level environment variable
 * read once at startup, not one route carried a user, and one running service
 * was one board was one person. Two people could not share a service at all.
 *
 * This is the seam that fixes it. A request arrives with a bearer token; this
 * port says whether it is real and who it belongs to. Nothing about Firebase,
 * JWTs or Google appears in `core/` — the same rule the model, store, embedder
 * and research ports keep. `adapters/firebase-auth.ts` owns the provider.
 */

/** A person, as far as this product is concerned. */
export interface Learner {
  /** Stable and provider-issued. This is what a board belongs to. */
  readonly id: string;
  /** For showing them which account they are in. Null when the provider has
   *  none — an anonymous sign-in has no address and is still a learner. */
  readonly email: string | null;
}

export interface Identity {
  /**
   * Verify a bearer token and say who it is, or `null`.
   *
   * `null` for every rejection rather than distinct errors, deliberately: the
   * caller's answer to all of them is the same 401, and a verifier that
   * explains *why* a token failed is a verifier that helps somebody find a
   * token that works. What the reason is good for is a log, and the adapter
   * writes one.
   *
   * Never throws for a bad token. A malformed string is an ordinary event on a
   * public endpoint, not an exceptional one.
   */
  verify(token: string): Promise<Learner | null>;
}
