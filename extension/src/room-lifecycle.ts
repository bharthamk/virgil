import { withRoomReadCancellation } from './service.js';

export interface RoomOwnership<T> {
  readonly content: T;
  readonly generation: number;
}

/**
 * Coordinates asynchronous room reads with navigation.
 *
 * A continuation may paint only while both the mounted content and generation
 * still match. Starting another room aborts reads from the previous room but
 * deliberately says nothing about writes already requested by the learner.
 */
export class RoomLifecycle<T> {
  #generation = 0;
  #reads = new AbortController();

  ownership(content: T): RoomOwnership<T> {
    return { content, generation: this.#generation };
  }

  owns(owner: RoomOwnership<T>, content: T): boolean {
    return owner.generation === this.#generation && owner.content === content;
  }

  begin(): void {
    this.#reads.abort();
    this.#reads = new AbortController();
    this.#generation += 1;
  }

  read(init: RequestInit = {}): RequestInit {
    return withRoomReadCancellation(init, this.#reads.signal);
  }
}
