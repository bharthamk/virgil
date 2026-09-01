import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Embedder } from '@sb/core';

/**
 * The `Embedder` contract, written once and run against every implementation.
 *
 * `ports/embedder.ts` states the promise in prose — "must be deterministic: the
 * same input array must yield the same numbers" — and until now nothing checked
 * it. That is the one promise on this port that cannot be checked by reading the
 * type, and it is the whole reason the port exists: D15 moved the partition out
 * of the model precisely because the model gave three different answers to the
 * same question on three consecutive nights. An embedder that is quietly
 * non-deterministic puts that back, and puts it back invisibly — the board does
 * not crash, it just reorganises itself while the learner sleeps.
 *
 * The other half of the contract is positional. A vector is meaningless on its
 * own; it is meaningful because it belongs to a particular pin. An adapter that
 * batches, retries a chunk, or resolves its requests out of order can hand back
 * the right numbers attached to the wrong pins, and every assertion about the
 * numbers themselves still passes. So the tests below permute, duplicate and
 * overflow the batch and check the correspondence rather than the values.
 *
 * No test here touches a network. An HTTP-backed subject supplies a fake.
 *
 * ## Two honest scopes, declared rather than assumed
 *
 * `ports/embedder.ts` says an implementation "whose output depends on batching,
 * ordering or sampling cannot be used here", and `TfIdfEmbedder` depends on
 * batching by construction: IDF is fitted to the batch, so the same text in a
 * different batch is a different vector. Both ship, and both are correct — the
 * clusterer embeds the whole board in one call, so every comparison it makes is
 * inside one consistent space.
 *
 * Rather than pretend the difference away, a subject declares its `scope`, and
 * the contract asserts the declaration is TRUE in both directions: a `per-text`
 * subject must produce a text's vector independently of its company, and a
 * `per-batch` subject must actually be batch-sensitive. A declaration nobody
 * checks is how a `per-batch` adapter ends up wired somewhere that assumes
 * `per-text` — which for this port means comparing vectors from two different
 * spaces and calling the result a similarity.
 */

export interface EmbedderSession {
  readonly embedder: Embedder;
  /**
   * A second instance, built exactly as the first was.
   *
   * The port's determinism promise is about the space, not about one object. An
   * adapter that memoises a vocabulary, a warm-up call or a random projection
   * into instance state agrees with itself all day and disagrees with the
   * process that ran last night.
   */
  fresh(): Embedder;
  close(): void;
}

export interface EmbedderSubject {
  readonly name: string;
  /**
   * `per-text` — a vector is a function of its own text alone.
   * `per-batch` — the space is fitted to the batch it is handed.
   */
  readonly scope: 'per-text' | 'per-batch';
  open(): EmbedderSession;
}

// --------------------------------------------------------------------- fixtures

/** Ordinary prose, deliberately from two unrelated subjects. */
const PULL = 'A pull subscription lets the subscriber client control the rate of delivery';
const ACK = 'The acknowledgement deadline is extended while the client keeps the message';
const BREAD = 'Sourdough hydration is the weight of water as a share of the flour';

/** Scripts outside the BMP, combining marks, right-to-left, and punctuation. */
const AWKWARD = 'café ñ 日本語 🧪 é مرحبا "quoted" — ✅ tritóne';

/** Larger than any pinned selection the product will ever see. */
const HUGE = `${PULL} `.repeat(4_000);

// ---------------------------------------------------------------------- helpers

const finite = (rows: readonly (readonly number[])[], where: string): void => {
  rows.forEach((vec, i) => vec.forEach((x, j) => {
    assert.equal(typeof x, 'number', `${where}: vector ${i}[${j}] is not a number`);
    assert.ok(Number.isFinite(x),
      `${where}: vector ${i}[${j}] is ${x} — a NaN reaching cosine() poisons every comparison `
      + 'in the matrix, and the board it produces looks merely odd rather than broken');
  }));
};

const same = (a: readonly (readonly number[])[], b: readonly (readonly number[])[], why: string): void =>
  assert.deepEqual(a.map((v) => [...v]), b.map((v) => [...v]), why);

const widths = (rows: readonly (readonly number[])[]): number[] => [...new Set(rows.map((v) => v.length))];

// -------------------------------------------------------------------- the suite

/**
 * Registers the whole contract against one embedder.
 *
 * Every test name states the promise being kept, because a failing test name is
 * the only documentation anyone reads at 3am.
 */
export function runEmbedderContract(subject: EmbedderSubject): void {
  const named = (name: string, fn: (s: EmbedderSession) => Promise<void>) =>
    test(`[${subject.name}] ${name}`, async () => {
      const s = subject.open();
      try { await fn(s); } finally { s.close(); }
    });

  // ------------------------------------------------------------- determinism

  named('the same array embeds to the same numbers twice', async (s) => {
    const texts = [PULL, ACK, BREAD];
    same(await s.embedder.embed(texts), await s.embedder.embed(texts),
      'D15 moved the partition into code to stop the board reorganising itself overnight — '
      + 'an embedder that answers differently on the second call puts that back');
  });

  named('a second instance agrees with the first, number for number', async (s) => {
    const texts = [PULL, ACK, BREAD];
    same(await s.embedder.embed(texts), await s.fresh().embed(texts),
      'the nightly run is a new process; a space that only agrees with itself inside one '
      + 'object is not a space, and the threshold measured against it means nothing');
  });

  named('two identical calls in flight at once agree', async (s) => {
    const texts = [PULL, ACK, BREAD];
    const [a, b] = await Promise.all([s.embedder.embed(texts), s.embedder.embed(texts)]);
    same(a as readonly (readonly number[])[], b as readonly (readonly number[])[],
      'per-request state held on the instance shows up only under overlap');
  });

  // -------------------------------------------------------------------- shape

  named('one vector per text, in the order the texts were given', async (s) => {
    const out = await s.embedder.embed([PULL, ACK, BREAD]);
    assert.equal(out.length, 3,
      'a short reply means the vectors no longer line up with the pins, and clustering '
      + 'the wrong pin to the wrong vector is worse than not clustering at all');
  });

  named('every vector in one call has the same width', async (s) => {
    const out = await s.embedder.embed([PULL, ACK, BREAD, '', AWKWARD]);
    assert.deepEqual(widths(out), widths(out).slice(0, 1),
      'cosine() reads the shorter length and counts the tail into the norm, so ragged '
      + 'widths do not throw — they quietly report a similarity nobody can reproduce');
  });

  named('an empty batch is an empty result, not a call', async (s) => {
    assert.deepEqual([...await s.embedder.embed([])], [],
      'a board with nothing on it is the first run of every install');
  });

  named('the space is named, and the name does not move between calls', async (s) => {
    const before = s.embedder.modelId;
    await s.embedder.embed([PULL]);
    assert.ok(before.length > 0, 'thresholdFor(modelId) has nothing to look up');
    assert.equal(s.embedder.modelId, before,
      'the cut point is a property of the space; a modelId that changes under the '
      + 'threshold silently swaps which measurement applies');
    assert.equal(s.fresh().modelId, before, 'two instances of one adapter are one space');
  });

  // ------------------------------------------------------------------ numbers

  named('no vector ever contains a NaN or an infinity', async (s) => {
    finite(await s.embedder.embed([PULL, '', '   \t\n  ', AWKWARD, ACK, ACK, HUGE]), 'mixed batch');
  });

  named('a batch of nothing but empty and whitespace text still returns finite numbers', async (s) => {
    const out = await s.embedder.embed(['', ' ', '\t', '\n\n', '   ']);
    assert.equal(out.length, 5);
    finite(out, 'empty batch');
  });

  named('different texts do not all collapse to the same vector', async (s) => {
    const [pull, bread] = await s.embedder.embed([PULL, BREAD]);
    assert.notDeepEqual([...pull ?? []], [...bread ?? []],
      'an adapter that returns a constant passes determinism, dimension and ordering '
      + 'and produces exactly one topic for every board ever built');
  });

  // ------------------------------------------------------- positional integrity

  named('permuting the texts permutes the vectors and changes nothing else', async (s) => {
    const texts = [PULL, ACK, BREAD];
    const straight = await s.embedder.embed(texts);
    const reversed = await s.embedder.embed([...texts].reverse());
    same([...reversed].reverse(), straight,
      'this is the failure that has no symptom: the numbers are all correct and each one '
      + 'is attached to the wrong pin, so the board is confidently wrong');
  });

  named('the same text twice in one batch embeds to the same vector twice', async (s) => {
    const out = await s.embedder.embed([PULL, BREAD, PULL]);
    assert.deepEqual([...out[0] ?? []], [...out[2] ?? []],
      'two pins of the same passage must be maximally similar, not merely close');
  });

  named('a batch larger than any internal chunk keeps its order', async (s) => {
    // An adapter that splits its work — Ollama's does, at a fixed batch size —
    // reassembles it, and reassembly is where a `Promise.all` without an index
    // or a `push` in completion order loses the correspondence. 40 crosses every
    // chunk size this project uses.
    const texts = Array.from({ length: 40 }, (_, i) => `${PULL} number ${i} of forty`);
    const straight = await s.embedder.embed(texts);
    const reversed = await s.embedder.embed([...texts].reverse());
    assert.equal(straight.length, 40);
    same([...reversed].reverse(), straight, 'the chunk boundary reordered the board');
  });

  named('a batch far larger than a real board returns one vector per text', async (s) => {
    const texts = Array.from({ length: 200 }, (_, i) => `${BREAD} ${i}`);
    const out = await s.embedder.embed(texts);
    assert.equal(out.length, 200);
    assert.deepEqual(widths(out), widths(out).slice(0, 1));
    finite(out, 'large board');
  });

  // --------------------------------------------------------------- awkward text

  named('unicode reaches the space intact rather than as replacement glyphs', async (s) => {
    const out = await s.embedder.embed([AWKWARD, `${AWKWARD} and more`, AWKWARD]);
    finite(out, 'unicode');
    assert.deepEqual([...out[0] ?? []], [...out[2] ?? []],
      'a text that survives the trip twice must survive it identically');
    assert.notDeepEqual([...out[0] ?? []], [...out[1] ?? []],
      'a transport that mangles multi-byte characters tends to mangle them to the SAME '
      + 'thing, which reads as two unrelated pins being the same idea');
  });

  named('a text far larger than any pinned selection is embedded, not truncated away', async (s) => {
    const out = await s.embedder.embed([HUGE, BREAD]);
    assert.equal(out.length, 2);
    finite(out, 'huge');
    assert.ok((out[0] ?? []).length > 0, 'the oversized text produced no vector at all');
  });

  // --------------------------------------------------------------- batch scope

  if (subject.scope === 'per-text') {
    named('a text embeds the same alone as it does in company', async (s) => {
      const alone = await s.embedder.embed([PULL]);
      const together = await s.embedder.embed([BREAD, PULL, ACK]);
      assert.deepEqual([...alone[0] ?? []], [...together[1] ?? []],
        'a per-text subject that turns out to be batch-fitted makes every incremental '
        + 'attach compare vectors from two different spaces');
    });
  } else {
    named('the declared batch sensitivity is real, and stays inside one call', async (s) => {
      // The declaration is checked rather than trusted. If this ever stops being
      // true the subject should be redeclared `per-text` and inherit the
      // stronger assertion above — silence in either direction is the bug.
      const alone = await s.embedder.embed([PULL]);
      const together = await s.embedder.embed([BREAD, PULL, ACK]);
      assert.notDeepEqual([...alone[0] ?? []], [...together[1] ?? []],
        'declared per-batch but behaves per-text — the declaration is stale');
      // What the clusterer actually relies on: one call, one consistent space.
      const twice = await s.embedder.embed([BREAD, PULL, ACK]);
      same(twice, together, 'the same batch must still be the same space');
    });
  }

  // ---------------------------------------------------------------- concurrency

  test(`[${subject.name}] concurrent calls do not cross their results`, async () => {
    // The nightly run embeds the board once, but the service embeds on demand
    // while the nightly run is still going. An adapter holding a buffer, a
    // pending-chunk list or a "last batch" field on the instance passes every
    // test above and then hands one board's vectors to another caller.
    const s = subject.open();
    try {
      const batches = Array.from({ length: 8 }, (_, i) => [`${PULL} ${i}`, `${BREAD} ${i}`]);
      const together = await Promise.all(batches.map((b) => s.embedder.embed(b)));
      for (const [i, batch] of batches.entries()) {
        same(together[i] as readonly (readonly number[])[], await s.embedder.embed(batch),
          `batch ${i} came back with another caller's vectors`);
      }
    } finally {
      s.close();
    }
  });
}

/**
 * The failure half, for subjects with a provider that can misbehave.
 *
 * Separate because an in-process embedder has no transport to fail, and failing
 * it for that would be the same category error as failing a text-only provider
 * for having no vision. What it pins down is the rule stated on the port but
 * enforceable only where there is a wire: a short or broken reply must be an
 * error, never a shorter array.
 */
export interface FaultyEmbedderSubject {
  readonly name: string;
  /** An embedder whose provider answers with an error status. */
  openHttpError(status: number): EmbedderSession;
  /** An embedder whose provider answers with fewer vectors than it was given texts. */
  openShortReply(): EmbedderSession;
  /** An embedder whose provider answers with no vectors field at all. */
  openMalformed(): EmbedderSession;
}

export function runEmbedderFailureContract(subject: FaultyEmbedderSubject): void {
  const named = (name: string, open: () => EmbedderSession, fn: (s: EmbedderSession) => Promise<void>) =>
    test(`[${subject.name}] ${name}`, async () => {
      const s = open();
      try { await fn(s); } finally { s.close(); }
    });

  named('a provider error rejects rather than resolving to fewer vectors',
    () => subject.openHttpError(500), async (s) => {
      await assert.rejects(() => s.embedder.embed([PULL, ACK]), /500/,
        'the clusterer would read a short array as a smaller board and silently drop pins');
    });

  named('a reply with fewer vectors than texts is refused, not zipped',
    subject.openShortReply, async (s) => {
      await assert.rejects(() => s.embedder.embed([PULL, ACK, BREAD]), /vector/i,
        'zipping a short reply against the pins attaches every vector after the gap to the '
        + 'wrong pin — the one failure mode of this port with no visible symptom');
    });

  named('a reply of the wrong shape is refused rather than read as empty',
    subject.openMalformed, async (s) => {
      await assert.rejects(() => s.embedder.embed([PULL]),
        'an empty result is a legitimate answer to an empty board and must not be how a '
        + 'broken provider looks');
    });
}
