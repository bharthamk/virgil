# Google operations and recovery

This is the operator runbook for an already deployed Virgil estate. Product
architecture and installation remain in [`GOOGLE_BACKEND.md`](GOOGLE_BACKEND.md)
and [`../deploy/CLOUD_RUN.md`](../deploy/CLOUD_RUN.md). Nothing here weakens the
rule that a release is one source identity across both Cloud Run containers.
The current accepted production identity and proof counts live in
[`RELEASE.md`](RELEASE.md).

## Acceptance before promotion

Run the read-only audit after every IAM, Firebase, Firestore, secret or runtime
change:

```bash
PROJECT_ID=your-project ./deploy/audit-live.sh
```

A failure blocks promotion. Warnings are explicit operator decisions: PITR,
paid container scanning, secret-version cleanup and notification delivery. The
script never reads a secret payload and never changes cloud state.

The annotated release tag records the audit count for the accepted estate.
Never copy a prior count forward: rerun the audit against the exact source and
live images being promoted. PITR, an external notification channel and paid
Artifact Registry scanning remain explicit operator choices when reported as
warnings rather than failures.

The release gate still includes the repository suite and container proof:

```bash
npm test
npm run check:quality
npm run check:seam
npm run check:d1
npm run check:public
./deploy/smoke.sh
```

## Availability monitoring

Virgil exposes one anonymous and data-free endpoint, `/health`. It is the only
appropriate public uptime target; probing a learner route would need a user
credential and would turn monitoring into application access.

Preview and then create the idempotent check and incident policy:

```bash
PROJECT_ID=your-project ./deploy/observe.sh --plan
VIRGIL_DEPLOY=yes PROJECT_ID=your-project ./deploy/observe.sh
```

The check runs every five minutes from three regions, validates TLS, requires
HTTP 200 and matches `"ok":true`. That is 25,920 regional executions in a
31-day month, well inside Google Cloud Monitoring's current free allotment of
one million uptime-check executions per project.

With no `ALERT_CHANNELS`, an incident appears only in Cloud Monitoring. To send
notifications, first create and verify an operator-owned channel, then pass its
resource name:

```bash
ALERT_CHANNELS=projects/PROJECT_ID/notificationChannels/CHANNEL_ID \
VIRGIL_DEPLOY=yes PROJECT_ID=your-project ./deploy/observe.sh
```

Do not put an email address, webhook secret or notification credential in this
repository.

## Release and rollback

Record these before moving traffic:

- source commit or immutable source-package digest;
- the common image tag;
- service image digest and revision;
- Job image digest and generation;
- active Firestore rules release;
- the previous known-good service revision and Job image.

Rollback is a pair, not a traffic-only action. Route the service to the recorded
known-good revision and restore the Job to the image from that same release:

```bash
gcloud run services update-traffic virgil-service \
  --region us-central1 --project PROJECT_ID \
  --to-revisions KNOWN_GOOD_REVISION=100

gcloud run jobs update virgil-nightly \
  --region us-central1 --project PROJECT_ID \
  --image KNOWN_GOOD_JOB_IMAGE
```

Then run `deploy/audit-live.sh`, one authenticated board read, and one bounded
Job execution. Never roll back Firestore data merely because code was rolled
back. If a schema change cannot read both the old and new shape, it requires an
expand/migrate/contract release plan before deployment.

## Recovery

Database deletion protection prevents accidental database removal. It does not
restore an overwritten learner board. Virgil's portable learner backup is the
default recovery path and should be drilled against a disposable test account:

1. export the learner backup and record its displayed SHA-256 digest;
2. add one uniquely named disposable pin;
3. delete only the disposable account or board through the product;
4. restore the backup through **Your data**;
5. verify the preview made no write, the owner matches, the digest is accepted,
   the disposable post-backup pin is absent, and a second restore is a no-op;
6. delete the disposable account again.

Firestore point-in-time recovery remains off unless the operator accepts its
storage cost. Enabling it is an infrastructure and billing decision, not a
release-script default.

## Secret rotation

Runtime containers mount `latest`, but old enabled versions remain accessible
to any principal with accessor authority on that secret. Rotate one secret at a
time:

1. add and independently validate the replacement version;
2. deploy both service and Job against it and run the full acceptance audit;
3. disable the previous version—do not destroy it yet;
4. wait through an agreed observation window and verify both runtimes again;
5. revoke the credential at its upstream provider, then destroy the disabled
   version only when rollback is no longer required.

Never print secret payloads as proof. Version state, IAM bindings, mounts and a
successful provider call are sufficient.

## Supply-chain decision

The repository pins container bases by digest and scans packaged files for key
material. Artifact Registry vulnerability scanning is a separate paid control:
Google currently charges per automatic or on-demand scan and begins billing
when scanning is enabled. Therefore it is not silently enabled by Virgil's
installer.

Before a long-lived production launch, choose one of:

- enable repository scanning and record the findings for both release images;
- perform two on-demand scans against the exact service and Job digests; or
- record a time-bounded risk acceptance with the dependency audit and base
  image digests.

An A+ promotion receipt should also retain an SBOM and image digest alongside
the release record. Signing or Binary Authorization is valuable for a managed
multi-operator deployment, but it is not a truthful control until the deployer
actually verifies the signature before promotion.

## Connection drills

Run these after changing auth, credentials or connection code:

### Google Notebook / Drive

- open the exact existing Notebook from **Google Notebook**;
- rewrite all three stable source files and verify file IDs do not change;
- disconnect automatic refresh and verify no Drive file is deleted;
- reconnect, force one refresh and verify the same IDs are reused;
- test one expired or revoked grant and confirm the UI reports access loss
  without creating duplicate files.

### Local Gemma connector

- pair from one authenticated learner account;
- verify only a token hash is stored and the pairing token is shown once;
- start the local worker and observe its readiness receipt;
- send one fast Gemma request through hosted Virgil, not directly to the model;
- stop the worker and verify a new request fails as unavailable rather than
  falling back to paid Gemini;
- unpair and verify the old token cannot poll, claim or finish work.

### Identity and isolation

- anonymous learner data returns 401;
- the owner, an ordinary member and a Demo judge each see only their own board;
- a non-member cannot redeem or read without the intended private grant;
- account deletion removes the board before revoking Firebase identity;
- deleting one account changes no other learner board.
