# Contributing to Virgil

Virgil treats product behavior, privacy, and source grounding as code contracts.
Changes should make those contracts easier to understand and harder to break.

## Development setup

Use Node.js 22 or 24 LTS:

```bash
npm ci
npm run build
node runner/dist/service.js
```

The local product is available at `http://127.0.0.1:8791/app/`.

## Before opening a pull request

```bash
npm test
npm run check:quality
npm run check:public
npm run check:seam
npm run check:d1
```

If your change touches a live provider or emulator boundary, run the relevant
opt-in test and describe it in the pull request. Do not weaken or remove a skip
just to make an unavailable external dependency appear green.

## Design rules

- Keep `core/` provider-independent. Add provider SDKs only in adapters or
  explicit host bindings.
- Put model calls behind `Llm`, persistence behind `Store`, external reads
  behind `Research`, vectors behind `Embedder`, and time behind `Clock`.
- Preserve provenance and learner-visible control for any new generated output.
- Treat page content, uploaded documents, and learner text as untrusted input.
- Prefer deterministic policy code for dates, limits, routing, identity, spend,
  and destructive operations.
- Add a regression test for every behavior change.
- Keep comments focused on enduring constraints and non-obvious trade-offs.
  Do not commit internal ticket IDs, build diaries, review conversations, or
  temporary submission notes.

## Pull requests

Keep each pull request scoped to one coherent change. Explain:

1. the user problem;
2. the behavior that changed;
3. the trust or migration implications;
4. the tests and manual checks performed.

Use synthetic data in fixtures, screenshots, logs, and issue reports. Never
commit learner material, personal email addresses, credentials, private service
URLs, or local filesystem paths.

## Commit messages

Write an imperative subject that describes the product or engineering outcome,
for example:

```text
Preserve source receipts across lesson corrections
```

Do not add generated-by or agent co-author metadata.
