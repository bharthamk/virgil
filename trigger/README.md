# Background trigger

This workspace defines the message and idempotency boundary for scheduled or
event-driven Virgil runs.

- `src/message.ts` owns the versioned wire schema.
- `src/batch-key.ts` derives stable run identities.
- `src/guard.ts` prevents duplicate work and manages leases.
- `src/handler.ts` validates, claims, runs, and records a batch.
- `src/local-transport.ts` provides a deterministic in-process transport.
- `src/pubsub-binding.ts` is the explicit Google Cloud Pub/Sub binding.

Provider code is intentionally absent from the public index. A deployment must
select the Pub/Sub binding directly, which keeps network behavior visible at the
composition root.

Run the trigger contracts from the repository root:

```bash
npm test
npm run check:seam
```
