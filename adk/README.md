# Google ADK host

This workspace maps Virgil's background pipeline to Google ADK without moving
domain behavior into the framework.

- `src/stages.ts` defines the ordered stage registry.
- `src/host.ts` provides the framework-independent orchestration contract and
  local sequential host.
- `src/adk-binding.ts` is the only module that loads `@google/adk`.
- `src/select.ts` selects the local or ADK host explicitly.

The ADK binding constructs a `SequentialAgent` from the stage registry. Each
node calls the same typed function used by the local runner, so changing hosts
does not change model, storage, or safety behavior.

Run the workspace tests through the repository root:

```bash
npm test
npm run check:seam
```
