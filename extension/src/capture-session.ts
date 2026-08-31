/**
 * The pins made during this browser session.
 *
 * The board remains the record. This is only a small index in
 * `chrome.storage.session` so a capture made on the page can be reopened in
 * the side panel, including after that panel closes and opens again. The
 * browser clears the area when its session ends.
 *
 * Owner scope is part of every row. A browser can switch Google accounts
 * without ending its session, and a label from one board must not become a
 * shortcut on another person's panel.
 */

export const CAPTURE_SESSION_KEY = 'sb_capture_session_pins';
export const CAPTURE_SESSION_ADDED = 'sb-capture-session-added';
export const CAPTURE_SESSION_REMOVED = 'sb-capture-session-removed';

export interface CaptureSessionPin {
  readonly pinId: string;
  readonly label: string;
  readonly at: number;
  readonly ownerUid: string | null;
}

const readable = (raw: unknown): CaptureSessionPin[] => {
  if (!Array.isArray(raw)) return [];
  const rows: CaptureSessionPin[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const pinId = typeof row['pinId'] === 'string' ? row['pinId'].trim() : '';
    const label = typeof row['label'] === 'string' ? row['label'].trim() : '';
    const at = row['at'];
    const ownerUid = row['ownerUid'];
    const ownerKey = ownerUid === null ? 'local' : `user:${String(ownerUid)}`;
    const key = `${ownerKey}\u0000${pinId}`;
    if (!pinId || !label || seen.has(key)
      || typeof at !== 'number' || !Number.isFinite(at)
      || (ownerUid !== null && (typeof ownerUid !== 'string' || !ownerUid))) continue;
    seen.add(key);
    rows.push({ pinId, label, at, ownerUid: ownerUid as string | null });
  }
  return rows;
};

/** Newest first, for one board only. */
export function captureSessionPins(
  raw: unknown, ownerUid: string | null,
): CaptureSessionPin[] {
  return readable(raw)
    .filter((row) => row.ownerUid === ownerUid)
    .sort((a, b) => b.at - a.at);
}

/** Add or refresh one shortcut while preserving rows for other signed-in users. */
export function holdCaptureSessionPin(
  raw: unknown, pin: CaptureSessionPin,
): CaptureSessionPin[] {
  const rest = readable(raw).filter((row) =>
    !(row.pinId === pin.pinId && row.ownerUid === pin.ownerUid));
  return [pin, ...rest];
}

/** Remove one shortcut only. The server pin is deliberately untouched. */
export function dismissCaptureSessionPin(
  raw: unknown, pinId: string, ownerUid: string | null,
): CaptureSessionPin[] {
  return readable(raw).filter((row) =>
    !(row.pinId === pinId && row.ownerUid === ownerUid));
}
