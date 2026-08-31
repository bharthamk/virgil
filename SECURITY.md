# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability or privacy
problem. Use GitHub's private vulnerability reporting for this repository and
include:

- the affected component and revision;
- the smallest reproducible example;
- the impact you observed;
- whether learner data, credentials, or billing may be involved.

Do not include real learner material, access tokens, model keys, OAuth secrets,
or production exports in a report. Replace them with synthetic values.

## Supported version

Security fixes target the current `main` branch. This project is under active
development and does not currently maintain parallel long-term-support branches.

## Deployment boundary

Virgil is self-hosted. Each operator is responsible for its Google Cloud
project, Firebase configuration, OAuth clients, Secret Manager values, IAM,
domain policy, backups, retention, and incident response.

Before deployment:

1. run `npm test`, `npm run check:quality`, and `npm run check:public`;
2. inspect the no-write deployment plan;
3. keep model keys and Drive credentials in Secret Manager;
4. use separate Web and Chrome-extension OAuth clients;
5. enable Firebase Authentication and verify learner isolation;
6. set `SB_OPERATOR_MODEL_BUDGET_TOKENS` for every authenticated hosted
   service;
7. review generated manifests before applying them.

Never publish a rendered deployment file, local store, backup, extension
package, `.env` file, or credential receipt.

## Security design

The codebase enforces several boundaries in tests:

- provider-independent domain code;
- authenticated, per-learner hosted stores;
- prompt-injection fences for external and learner-authored text;
- bounded request bodies and Unicode-safe input limits;
- explicit external handoffs and writes;
- model spend controls and fail-closed configuration;
- idempotent background work and durable receipts;
- cascade deletion of raw and derived learner state;
- public-tree and Git-history secret scanning.

These controls reduce risk; they do not replace a deployment-specific security
review.
