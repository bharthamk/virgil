import { createHash } from 'node:crypto';
import { rendersEmpty, stripInvisible, type Pin } from '@sb/core';

type Refuse = (message: string) => never;

/** Retry identities are opaque caller data: validate them without normalising. */
export const exactAgentIdentity = (
  value: unknown, field: string, maxChars: number, refuse: Refuse,
): string | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || rendersEmpty(value)) {
    return refuse(`${field} must be a non-empty string when supplied`);
  }
  if (stripInvisible(value) !== value) {
    return refuse(`${field} must not contain invisible control characters`);
  }
  if (Array.from(value).length > maxChars) {
    return refuse(`${field} must contain at most ${maxChars} characters`);
  }
  return value;
};

/** Stable IDs make retries idempotent across requests and service instances. */
export const dropArtifactId = (
  kind: 'pin' | 'draft' | 'source', dropId: string, clientRef: string,
): string => `drop_${kind}_${createHash('sha256')
  .update(`${dropId}\u0000${clientRef}`).digest('hex').slice(0, 32)}`;

export const intakeArtifactId = (
  kind: 'draft' | 'source', clientRef: string,
): string => `intake_${kind}_${createHash('sha256').update(clientRef).digest('hex').slice(0, 32)}`;

/** Keep the useful path head and tail while preserving whole Unicode code points. */
export const dropDisplayName = (value: string): string => {
  const clean = stripInvisible(value);
  const chars = Array.from(clean);
  if (chars.length <= 200) return clean;
  const marker = `…${createHash('sha256').update(clean).digest('hex').slice(0, 8)}…`;
  return `${chars.slice(0, 40).join('')}${marker}${chars.slice(-150).join('')}`;
};

/** One retry identity names one captured source body, even after a torn write. */
export const sameDropSource = (
  pin: Pin, item: { readonly name: string; readonly url: string | null },
  text: string, dropTitle: string,
): boolean => pin.envelope.surroundingText === text
  && pin.envelope.pageTitle === item.name
  && (pin.envelope.url ?? '') === (item.url ?? '')
  && pin.envelope.headingPath[0] === dropTitle;
