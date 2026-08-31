import { randomUUID } from 'node:crypto';
import type { Signal, SignalType, Store, Clock, Topic } from '@sb/core';
import { SEED_PINS } from './corpus.js';

/**
 * The seeded learner's signal history.
 *
 * Layered on AFTER clustering, and mapped to whatever topics actually emerged,
 * because the demo has to show the fleet's own clustering rather than ours.
 * Topics are matched by pin membership: we know which pins we authored for each
 * expected key, so whichever emergent topic holds most of them is that key.
 *
 * `w` is weeks before today.
 */
export interface Beat { w: number; type: SignalType; dir: Signal['direction'] }

export const HISTORY: Record<string, readonly Beat[]> = {
  // Worked through and genuinely absorbed — should settle.
  'pubsub-delivery': [
    { w: 4, type: 'answer-wrong', dir: 'negative' },
    { w: 3, type: 'depth-simpler', dir: 'negative' },
    { w: 2, type: 'answer-correct', dir: 'positive' },
    { w: 1, type: 'recall-check', dir: 'positive' },
    { w: 0, type: 'answer-correct', dir: 'positive' },
  ],
  // Read about, never really tested.
  'pubsub-ordering': [
    { w: 3, type: 'section-completed', dir: 'positive' },
    { w: 1, type: 'depth-deeper', dir: 'positive' },
  ],
  // The persistent one: three weeks of not getting it, then a breakthrough note.
  'iam-conditions': [
    { w: 4, type: 'answer-wrong', dir: 'negative' },
    { w: 3, type: 'depth-simpler', dir: 'negative' },
    { w: 3, type: 'answer-wrong', dir: 'negative' },
    { w: 2, type: 'answer-wrong', dir: 'negative' },
    { w: 1, type: 'section-abandoned', dir: 'negative' },
  ],
  // Actively in progress.
  'cloudrun-coldstart': [
    { w: 2, type: 'section-completed', dir: 'positive' },
    { w: 1, type: 'answer-correct', dir: 'positive' },
    { w: 0, type: 'depth-deeper', dir: 'positive' },
  ],
  // THE REGRESSION: solid a month ago, undercut last week.
  'firestore-queries': [
    { w: 4, type: 'answer-correct', dir: 'positive' },
    { w: 4, type: 'recall-check', dir: 'positive' },
    { w: 3, type: 'answer-correct', dir: 'positive' },
    { w: 0, type: 'answer-wrong', dir: 'negative' },
  ],
  'intervals': [
    { w: 5, type: 'answer-wrong', dir: 'negative' },
    { w: 4, type: 'answer-correct', dir: 'positive' },
    { w: 3, type: 'answer-correct', dir: 'positive' },
    { w: 1, type: 'recall-check', dir: 'positive' },
  ],
  'seventh-chords': [
    { w: 3, type: 'section-completed', dir: 'positive' },
    { w: 2, type: 'answer-correct', dir: 'positive' },
    { w: 1, type: 'answer-wrong', dir: 'negative' },
  ],
  // Understands the theory, cannot hear it. The medium-mismatch case.
  'tritone-sub': [
    { w: 1, type: 'answer-correct', dir: 'positive' },
    { w: 0, type: 'depth-simpler', dir: 'negative' },
    { w: 0, type: 'section-abandoned', dir: 'negative' },
  ],
  // Deliberately empty: pinned once, never touched. The Gardener's abandonment case.
  'sourdough-hydration': [],
};

/** Which emergent topic best corresponds to each authored key. */
export function matchTopics(
  topics: readonly Topic[],
  pinIdsByIndex: readonly string[],
): Map<string, string> {
  const expectByPin = new Map<string, string>();
  SEED_PINS.forEach((s, i) => {
    const pid = pinIdsByIndex[i];
    if (pid) expectByPin.set(pid, s.expect);
  });

  const out = new Map<string, string>();
  const scores = new Map<string, Map<string, number>>();
  for (const t of topics) {
    for (const pid of t.pinIds) {
      const key = expectByPin.get(pid);
      if (!key) continue;
      const m = scores.get(key) ?? new Map<string, number>();
      m.set(t.id, (m.get(t.id) ?? 0) + 1);
      scores.set(key, m);
    }
  }
  for (const [key, m] of scores) {
    const best = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) out.set(key, best[0]);
  }
  return out;
}

export async function loadHistory(
  store: Store,
  clock: Clock,
  mapping: Map<string, string>,
): Promise<number> {
  const now = clock.now();
  let n = 0;
  for (const [key, beats] of Object.entries(HISTORY)) {
    const topicId = mapping.get(key);
    if (!topicId) continue;
    for (const b of beats) {
      const at = new Date(now);
      at.setDate(at.getDate() - b.w * 7 - 2);
      await store.appendSignal({
        id: randomUUID(),
        topicId,
        type: b.type,
        direction: b.dir,
        at: at.toISOString(),
        sourceEvent: `seed:${key}:${b.w}`,
        invalidated: false,
      });
      n++;
    }
  }
  return n;
}
