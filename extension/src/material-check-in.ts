export interface RecordedMaterialProgress {
  readonly progressMinutes?: number;
  readonly doneAt?: string | null;
}

export interface MaterialCheckInPrompt {
  readonly note: string;
  readonly recordLabel: string;
}

/** Copy for the still-open block, kept apart from the confirmed receipt below. */
export function materialCheckInPrompt(
  blockMinutes: number,
  startingProgress: number,
  totalMinutes: number | null | undefined,
): MaterialCheckInPrompt {
  const full = totalMinutes !== null && totalMinutes !== undefined
    && startingProgress + blockMinutes >= totalMinutes;
  return {
    note: full
      ? startingProgress > 0 ? 'This block covers what remains of the item.'
        : 'This block covers the full item.'
      : `This records ${blockMinutes} minutes, not the whole item.`,
    recordLabel: full ? 'I finished it' : `I did the ${blockMinutes} minutes`,
  };
}

/** Current receipt for a block the service has confirmed, never pre-action copy. */
export function materialCheckInReceipt(
  blockMinutes: number,
  startingProgress: number,
  totalMinutes: number | null | undefined,
  material: RecordedMaterialProgress,
): string {
  const progress = Math.max(0, material.progressMinutes ?? startingProgress + blockMinutes);
  const total = totalMinutes ?? null;
  const covered = Boolean(material.doneAt) || (total !== null && progress >= total);
  if (covered) return 'Marked covered.';
  if (total === null) return `Recorded ${blockMinutes} minutes. The item is still open.`;
  return `Recorded ${blockMinutes} minutes. ${Math.max(0, total - progress)} of ${total} remain.`;
}
