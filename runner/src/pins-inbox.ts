import { fallbackLabel, type Pin, type Topic } from '@sb/core';

export interface PinInboxRow {
  id: string;
  type: Pin['type'];
  label: string;
  note: string | null;
  capturedAt: string;
  topicId: string | null;
  topicLabel: string | null;
  status: 'new' | 'processed';
  source: {
    text: string;
    kind: 'selection' | 'page';
    pageTitle: string;
    url: string | null;
  };
}

export function pinsInbox(
  pins: readonly Pin[], topics: readonly Topic[], requestedLimit: string | null,
): { pins: PinInboxRow[] } {
  const requested = Number(requestedLimit ?? 50);
  const limit = Number.isFinite(requested)
    ? Math.max(1, Math.min(100, Math.floor(requested)))
    : 50;
  const topicsById = new Map(topics.map((topic) => [topic.id, topic]));
  const stamp = (value: string): number => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const rows = [...pins]
    .sort((a, b) => stamp(b.capturedAt) - stamp(a.capturedAt) || b.id.localeCompare(a.id))
    .slice(0, limit)
    .map((pin): PinInboxRow => {
      const text = pin.envelope.selection ?? pin.envelope.surroundingText ?? '';
      const topic = pin.topicId ? topicsById.get(pin.topicId) ?? null : null;
      return {
        id: pin.id,
        type: pin.type,
        label: pin.label ?? fallbackLabel(pin.envelope),
        note: pin.note,
        capturedAt: pin.capturedAt,
        topicId: pin.topicId,
        topicLabel: topic?.label ?? null,
        status: pin.topicId ? 'processed' : 'new',
        source: {
          // Enough material for the inbox card's explicit Show more control to
          // be useful without turning an 80-pin list into an unbounded read.
          text: Array.from(text).slice(0, 4_000).join(''),
          kind: pin.envelope.selection ? 'selection' : 'page',
          pageTitle: pin.envelope.pageTitle ?? '',
          url: pin.envelope.url ?? null,
        },
      };
    });
  return { pins: rows };
}
