# Current release contract

Release `virgil-00091-a-plus` is the exact source named by the annotated tag
`virgil-00091-a-plus-20260901`. The tag is created only after the synchronized
service and Job have passed the live acceptance rule below; its annotation is
the immutable runtime receipt and records the Cloud Run revision, Job
generation/execution, image digests and audit totals. This keeps live facts
attached to the exact source without committing an invented revision name
before Cloud Run creates it.

- Immutable image tag: `submission-a-plus-00091-20260901`
- Hosted health contract: service, client and model-config schema 1
- Repository test gate: 5,356 total, 5,193 pass, 163 explicit environment
  skips, 0 failures
- Quality gate: 213 production TypeScript files, 4,798 functions, all coverage
  thresholds met
- D1 equivalence: 20 comparisons, 0 divergences
- Public-source boundary: 618 release candidates clean
- Extension identity: `nknaakgjobbleeolbfkbpcclbepboika`
- Source and extension receipts: schema v2, exact commit/tree, clean-state
  declaration, complete byte inventory and SHA-256 hashes

The live audit may report explicit operator-choice warnings without weakening a
release: Firestore PITR may remain off in favour of the tested learner
backup/restore path; an external notification channel and paid Artifact
Registry scanning are optional. The implemented hosted-to-local Gemma connector
has contract and direct transport proof, but this receipt does not turn that
into a production UI-to-local round-trip claim.

Firestore rules are unchanged and remain the checked-in deny-all direct-client
policy. A runtime-only successor does not become the accepted release until its
annotated tag contains the exact live receipt and the source/package receipts
resolve back to the same commit and tree.

## Release identity rule

The receipt describes the tagged package, not whichever service revision happens
to be newest. Product iterations may move the live Cloud Run service ahead while
the background Job remains on an earlier worker image. That is a candidate
estate, not a synchronized successor release.

A new receipt replaces this one only after service and Job are rebuilt from the
same source under one immutable tag, both resources are Ready, the intended
service revision has 100% traffic, one real Job execution succeeds, and the
full repository and container gates pass. The read-only comparison commands are
in `docs/GOOGLE_BACKEND.md`. `deploy/build.sh` refuses a reused image tag and a
dirty release tree; `deploy/audit-live.sh` additionally requires the service
and Job OCI labels to prove one clean commit/tree at the exact revision receiving
100% of traffic.

## Dependency posture

The accepted production dependency graph reports 11 moderate advisories and no
high or critical advisories. They are inherited through Google ADK's
OpenTelemetry toolchain rather than Virgil's HTTP service code. The
`adm-zip@0.6.0` override is intentional: it replaces ADK's older declared
archive range with the patched release, so `npm ls` reports that one declared
range mismatch. npm's automated full remedy is a breaking downgrade to
`@google/adk@0.1.3`; it reports no in-place compatible fix. This is known
supply-chain debt, not a claim of zero risk.

This release is the synchronized final product union: capture remains a save,
never an implicit paid lesson; Pins and Board retain the no-Virgil-call Gemini
and Google Notebook handoffs; Learn, Up next, lessons, External, Board and
account/settings surfaces carry the accepted final UI repairs; and extension
reload invalidation is contained rather than leaking an unhandled promise.

The same build now has an off-by-default private **Demo mode**. The live
deployment enables its unlinked `?judge=1` entrance with a password digest.
Judges receive a temporary opaque session for the shared disposable Demo board,
not the owner's account. Personal Notebook and Drive connections start off and
cannot be attached to that shared identity. Hosted service and Grow-worker
model use shares a durable 500,000-token Cloud/API ceiling that resets at 00:00
UTC. The ordinary `/app/` route exposes only the normal Google sign-in door.
