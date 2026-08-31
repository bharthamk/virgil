/**
 * Which board a learner's work lives in.
 *
 * One board per learner, named by their provider id. This is the whole of
 * multi-user: `FirestoreStore` has taken a `boardId` since it was written and
 * `JsonStore` takes a path, so the partition already existed — what was missing
 * was anything that decided which one a given request should get.
 *
 * The validation is the point. A board id becomes a filename on one adapter and
 * a document id on another, so a learner id that this function let through
 * would be a path traversal in `json:` and a collection-path injection in
 * Firestore. Firebase uids are 28 URL-safe characters, but the emulator will
 * mint whatever a token claims, and the token is the least trusted thing in the
 * system.
 */

/** Firestore forbids these in a document id, and a filesystem forbids most of
 *  them in a path segment. Rejected rather than escaped: a learner id is issued
 *  by a provider, so an odd one is a sign something is wrong, not a formatting
 *  problem to paper over. */
const ALLOWED = /^[A-Za-z0-9_-]{1,128}$/;

/** Firestore reserves these two exactly, whatever they are made of. */
const RESERVED = new Set(['.', '..']);

export function isLearnerId(id: unknown): id is string {
  return typeof id === 'string' && !RESERVED.has(id) && ALLOWED.test(id);
}

/**
 * The board id for a learner, or `null` if the id is not one this system will
 * name a board after.
 *
 * Prefixed, so a board id is never bare user input even after validation, and
 * so a store can be swept for boards without guessing which documents are ones.
 */
export function boardIdFor(learnerId: unknown): string | null {
  return isLearnerId(learnerId) ? `learner-${learnerId}` : null;
}
