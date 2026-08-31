/**
 * Owns the boundary between browser-local drafts and the signed-in learner.
 *
 * Draft contents remain with the rooms that understand them. This class owns
 * the one decision those rooms must not each make differently: when all of that
 * ephemeral state must be cleared because the learner changed or signed out.
 */
export class AccountScope {
  #owner: string | null = null;

  constructor(private readonly clearState: () => void) {}

  get owner(): string | null { return this.#owner; }

  /** Signing out always clears state, even when no owner was established. */
  forget(): void {
    this.clearState();
    this.#owner = null;
  }

  /** Same-account re-authentication preserves drafts; an account switch does not. */
  adopt(owner: string): void {
    if (this.#owner !== null && this.#owner !== owner) this.clearState();
    this.#owner = owner;
  }
}
