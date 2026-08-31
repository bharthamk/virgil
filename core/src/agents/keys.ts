/**
 * Joining a model's reply back to the thing it was asked about.
 *
 * Several agents ask about a list of things in one call and have to read the
 * answers back onto the right ones. The keys are ours, positional and opaque —
 * never a pin id or a topic id, which would put the learner's own identifiers
 * in front of a model for no purpose — and the read-back is the half that
 * cannot be fixed by writing a better prompt.
 *
 * This lived inside `clusterer.ts` while exactly one agent batched. The
 * Forager is the second, and it batches for the same reason the Clusterer
 * does. One copy, because the drift this function exists to survive is exactly
 * what two copies would produce.
 */

/** The key the nth offered item answers to. */
export const positionalKey = (index: number, letter = 'g'): string => `${letter}${index + 1}`;

/**
 * Resolve one model-returned identifier against identifiers the product
 * actually offered, without similarity or positional guessing.
 *
 * Topic ids are UUIDs in production rather than `g1`-style keys. They need the
 * safe half of `resolveKey` — outer quoting, case and a named wrapper — but
 * must never inherit its bare-number rule. An ambiguous case-insensitive match
 * is no match, because attaching a weakness to the wrong topic is worse than
 * omitting the attribution.
 */
export function resolveOfferedId(
  claimed: string,
  offered: readonly string[],
  wrappers: readonly string[] = [],
): string | null {
  const tidy = claimed.trim().replace(/^[[("'`]+|[\])"'`]+$/g, '').trim();
  if (!tidy) return null;
  if (offered.includes(tidy)) return tidy;

  const lower = tidy.toLowerCase();
  const withoutThe = lower.replace(/^the\s+/, '');
  const wrapperPattern = wrappers.length
    ? new RegExp(`^(?:${wrappers.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i')
    : null;
  const bare = wrapperPattern
    ? withoutThe.replace(wrapperPattern, '').replace(/^[:#\-\s]+/, '').trim()
    : withoutThe;
  const named = offered.filter((id) => {
    const candidate = id.toLowerCase();
    return candidate === lower || candidate === bare;
  });
  return named.length === 1 ? (named[0] as string) : null;
}

export function resolveKey(claimed: string, offered: readonly string[]): string | null {
  const tidy = claimed.trim().replace(/^[[("'`]+|[\])"'`]+$/g, '').trim();
  if (!tidy) return null;
  if (offered.includes(tidy)) return tidy; // the answer that was asked for

  // "Group g1", "group: g1", "#g1", "pin p2", "criterion c3", "group 1", "1".
  const lower = tidy.toLowerCase();
  const bare = lower.replace(/^(the\s+)?(group|pin|item|criterion)\b/, '').replace(/^[:#\-\s]+/, '').trim();
  const letter = offered[0]?.[0] ?? 'g';
  const spelled = /^\d+$/.test(bare) ? `${letter}${bare}` : bare;
  const named = offered.filter((o) => o.toLowerCase() === lower || o.toLowerCase() === spelled);
  if (named.length === 1) return named[0] as string;

  // Last resort: the key appears in the answer as a whole token, and no other
  // key does. Bounded on both sides because `g1` inside `g10` is a different
  // group, and matching it would be the mis-assignment this function exists to
  // avoid. The keys are `<letter><n>`, built by `positionalKey`, so there is
  // nothing in them to escape.
  const mentioned = offered.filter((o) => new RegExp(`(?<![a-z0-9])${o}(?![a-z0-9])`, 'i').test(lower));
  return mentioned.length === 1 ? (mentioned[0] as string) : null;
}
