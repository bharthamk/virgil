import { HANDOFF_KEY, pendingTake, type Handoff } from './learn-now.js';

type LocalStorage = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

/**
 * Make the durable and live routes into one presentation.
 *
 * A newly opening panel can read the same hand-off from storage just as the
 * worker's live notice arrives. De-duplicating here keeps one learner action
 * to one model call, and the timestamp guard prevents an older lesson from
 * clearing a newer request while its own call is still in flight.
 */
export class HandoffPresentation {
  private latestAt = Number.NEGATIVE_INFINITY;
  private activeAt: number | null = null;

  constructor(
    private readonly local: LocalStorage,
    private readonly show: (handoff: Handoff) => Promise<void>,
  ) {}

  async present(handoff: Handoff): Promise<void> {
    if (handoff.at < this.latestAt || this.activeAt === handoff.at) return;
    this.latestAt = handoff.at;
    this.activeAt = handoff.at;
    try {
      await this.show(handoff);
      const got = await this.local.get(HANDOFF_KEY);
      const current = pendingTake(got?.[HANDOFF_KEY], Date.now());
      if (current?.at === handoff.at) {
        await this.local.set({ [HANDOFF_KEY]: null });
      }
    } catch { /* the drawn failure/recovery screen owns the learner-facing answer */ }
    finally {
      if (this.activeAt === handoff.at) this.activeAt = null;
    }
  }
}
