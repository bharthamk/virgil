import { randomUUID } from 'node:crypto';
import type { Pin, Store, Clock } from '@sb/core';
import { SEED_PINS } from './corpus.js';

/**
 * Loads the seeded learner as *raw pins only* — no topics, no enrichment.
 *
 * That is deliberate. If the seed handed the pipeline pre-made topics, the demo
 * would be showing our clustering, not the agent's. The Clusterer has to earn
 * them. Signal history is layered on afterwards against whatever topics actually
 * emerge (see `history.ts`).
 */
export async function loadSeed(store: Store, clock: Clock): Promise<Pin[]> {
  const today = clock.now();
  const pins: Pin[] = SEED_PINS.map((s, i) => {
    const at = new Date(today);
    at.setDate(at.getDate() - s.week * 7 - s.day);
    return {
      id: randomUUID(),
      type: s.type,
      envelope: {
        selection: s.selection,
        parts: s.parts ?? [],
        surroundingText: s.surrounding,
        headingPath: s.headings,
        pageTitle: s.title,
        url: s.url,
        canonicalUrl: null,
        siteName: s.site,
        contentLanguage: 'en',
        media: null,
      },
      note: s.note ?? null,
      capturedAt: at.toISOString(),
      fromSuggestion: false,
      enrichment: null,
      topicId: null,
    };
  });
  for (const p of pins) await store.putPin(p);
  return pins;
}

/** Expected clusters, for evaluation only. Never given to an agent. */
export const EXPECTED = SEED_PINS.map((s, i) => ({ index: i, expect: s.expect }));
