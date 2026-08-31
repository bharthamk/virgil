# Cloud Run production design and verification
>
> Status: **reference deployment exercised; fresh-project route supported.**
> The service and Job have run against real Firebase identity, Firestore,
> Secret Manager, Google ADK and the Gemini API. Section 7 separates local-only
> evidence from live platform evidence; §9 remains the source-first route for a
> new project.
>
> This is the compute third of the mandatory infrastructure. The Store third and
> the event-bus third are both present in the repository; what is written here
> is read from that source.
>
> That said: **the estate is now a hard prerequisite rather than a tidy-up.**
> Since the store's authorisation moved to startup, a resource whose YAML is
> wrong exits 2 before it does anything — by design, and the log names the
> variable. §9 has the three of them in a table.

---

## 1. What this branch is for

This port makes deployment a configuration task: build and push the two images,
apply the Job and service templates, and optionally create the Scheduler sweep.
The scripts still require an explicit `VIRGIL_DEPLOY=yes`; the reference estate
is proof that the route can run, not a shared backend for new installations.

---

## 2. The platform facts this configuration rests on

Every number below was read live on 2026-08-21. Google's documentation now
lives at `docs.cloud.google.com`; the old `cloud.google.com/run/docs/*` URLs
301 to it, and pricing stayed put.

| fact | value | source |
| :--- | :--- | :--- |
| a job container must **not** listen on a port | *"Because jobs shouldn't serve requests, the container shouldn't listen on a port or start a web server."* | [container contract](https://docs.cloud.google.com/run/docs/container-contract) |
| a job's exit code **is** the contract | *"the container must exit with exit code 0 when the job has successfully completed, and exit with a non-zero exit code when the job has failed."* | [container contract](https://docs.cloud.google.com/run/docs/container-contract) |
| a service must bind `0.0.0.0` | *"The ingress container within an instance must listen for requests on `0.0.0.0` on the port to which requests are sent."* | [container contract](https://docs.cloud.google.com/run/docs/container-contract) |
| the port arrives as `PORT` | default 8080, configurable | [container contract](https://docs.cloud.google.com/run/docs/container-contract) |
| a service must be listening within | 4 minutes | [container contract](https://docs.cloud.google.com/run/docs/container-contract) |
| SIGTERM grace, **service** | 10 seconds, then SIGKILL | [container contract](https://docs.cloud.google.com/run/docs/container-contract) |
| SIGTERM grace, **job** | *"a few seconds"* — **no number is documented** | [container contract](https://docs.cloud.google.com/run/docs/container-contract) |
| job task timeout | default **10 min**, max **168 h (7 days)** | [task timeout](https://docs.cloud.google.com/run/docs/configuring/task-timeout) |
| job max-retries | default **3**, range **0–10** | [max retries](https://docs.cloud.google.com/run/docs/configuring/max-retries) |
| job CPU minimum | **1 CPU** — jobs cannot go fractional | [job CPU](https://docs.cloud.google.com/run/docs/configuring/jobs/cpu) |
| memory default / max | 512 MiB / 32 GiB | [memory limits](https://docs.cloud.google.com/run/docs/configuring/services/memory-limits) |
| service request timeout | default 300 s, max 3600 s | [request timeout](https://docs.cloud.google.com/run/docs/configuring/request-timeout) |
| service concurrency | default **80**, max 1000 | [concurrency](https://docs.cloud.google.com/run/docs/configuring/concurrency) |
| min-instances default | **0** — scales to zero, cold starts | [min instances](https://docs.cloud.google.com/run/docs/configuring/min-instances) |
| **jobs bill instance-based** | *"for the entire lifetime of any instance started, with a minimum of 1 minute"* | [pricing](https://cloud.google.com/run/pricing) |
| job price, us-central1 tier 1 | **$0.000018 / vCPU-s**, **$0.000002 / GiB-s** | [pricing](https://cloud.google.com/run/pricing) |
| free tier, instance-based | 240,000 vCPU-s + 450,000 GiB-s per month | [pricing](https://cloud.google.com/run/pricing) |

Two of these changed what got built, and one of them is the single most
consequential finding on this branch — see §5.

### 2a. The background shape — a request dispatches a Job

The signed-in service is multi-user: Firebase verifies the caller and selects
`boards/learner-<uid>`. The Job template is necessarily deployment-owned, so a
fixed `SB_STORE` in that template cannot be the automatic worker for every
signed-in learner.

The service therefore uses the documented Cloud Run v2 `jobs.run` method with
execution overrides. A threshold-crossing pin or explicit **Process** press:

1. decides whether work is due without a model call;
2. derives the board only from verified identity;
3. persists a launch lease on that learner's board;
4. requests the named Job with fixed command arguments plus overridden
   `SB_STORE`, `SB_BATCH_KEY` and a per-dispatch receipt nonce;
5. validates that Google returned an Operation for this deployment and answers
   the request without another board write.

Automatic dispatch runs `process --if-due`; an explicit press runs `process`.
The already-decided batch key survives queue delay and a midnight boundary.
The Job itself advances the matching Firestore receipt to `running` and
`finished`. A late retry cannot touch a newer same-day run because the nonce,
not the day, is the join. Every receipt transition is an atomic compare-and-set
against nonce, state and check time; generic preference writes preserve the
service-owned field. Each Cloud Run attempt renews a 35-minute lease, just past
that attempt's 30-minute timeout. A catchable failure closes the receipt only
when `CLOUD_RUN_TASK_ATTEMPT` reaches the configured retry budget; a hard-killed
attempt recovers by lease expiry. Board reads therefore need no Cloud Run API
permission and cannot dispatch over a legitimate retry. A transport loss after
POST leaves the launch lease active because Google may have accepted the
execution; a definite pre-request or HTTP refusal is retryable immediately. The terminal
receipt stores only a bounded outcome, stage/failure class and queue counts so
the board can name useful recovery without retaining prompts, provider prose,
exception text or Cloud API bodies.

The runtime service account receives
`roles/run.jobsExecutorWithOverrides` on this named Job — the narrow role that
carries `run.jobs.runWithOverrides`, not `run.operations.get`,
`roles/run.viewer` or `roles/run.developer`. `apply.sh`
validates the service first, then applies the Job and role, and only then rolls
the service revision that depends on them.

This is why request-based CPU and `minScale: 0` remain correct. The service
finishes the Admin API dispatch call before responding; every model call belongs to
the Job. Switching to always-on CPU and one minimum instance would add idle cost
to every self-hoster and still couple a long run to service-instance lifetime.

`trigger/` remains a tested Pub/Sub transport design. It is deliberately removed
from both runtime images and no deployment script publishes its message. The
old two-cron shape published to a subscription the Job never consumed and has
been retired rather than documented as production.

`deploy/schedule.sh` now creates at most one optional hourly UTC HTTP trigger,
off by default, for the operator's fixed `BOARD_ID`. It is a recovery floor for
that board only, not a multi-user sweep and not the product trigger.

---

## 3. The statelessness audit

Every place the runner assumed a local disk or a single process, what it costs
on Cloud Run, and what was done about it.

### S1 — the service bound `127.0.0.1` · **fixed**

`server.listen(PORT, '127.0.0.1', …)`. Inside a Cloud Run instance the request
never arrives, and the symptom is a startup-probe timeout with nothing in the
log naming a bind address. This is the defect that would have cost the most time
to diagnose in production.

Fixed by `bindHost`, which widens to `0.0.0.0` **only** when `K_SERVICE` is set.
The widening is conditional because of S9: `DELETE /everything` is one of this
service's routes, so binding every interface on a laptop publishes the learner's
board to the local network. Proven by a smoke test that reaches `/health` **from
a different container**, which is precisely what a loopback bind cannot answer.

The exposed-service authentication boundary hangs off the same line: a bind that is not loopback is what makes the
shared secret mandatory, so the two decisions are one function apart rather than
one being a platform marker and the other a guess.

### S2 — the service read `SB_PORT` and Cloud Run sets `PORT` · **fixed**

The platform has never heard of `SB_PORT`. `PORT` now wins when both are set;
`SB_PORT` keeps its meaning and its 8791 default everywhere else.

### S3 — the store was a file path, in both composition roots · **fixed**

`new JsonStore(DB)` where `DB = process.env.SB_DB ?? '.data/store.json'`.

Cloud Run's filesystem is an **in-memory tmpfs per instance**: what is written
counts against the memory limit, vanishes when the instance goes away, and is
never shared with another instance. A service at `min-instances: 0` would lose
the entire board on every scale to zero, and would report nothing wrong.

Fixed by `SB_STORE`, which names the store rather than a path — `memory`,
`json:<path>`, `firestore:<boardId>`, `firestore:<projectId>/<boardId>` — so one
image serves a laptop, a smoke test and production. **Firestore is the
production answer**, and as of the declaration commit it is one a deployed
process can actually reach.

Two things had to be true for that and neither was. The driver was undeclared,
so `npm ci` never installed it and the image had none. And the adapter was not
exported from `adapters/src/index.ts`, so both composition roots asked the barrel
for `FirestoreStore` by name, found nothing, and exited 2 with *"this build has
no Firestore store"* — which meant **every** firestore spec answered there and
the authorisation gate below had never once been reached in a deployed process.
Both are closed. `@google-cloud/firestore@9.0.0` is declared and locked, the
adapter is exported and named directly by both roots, and the adapter-missing
branch is gone rather than unreached.

**The production spec is the project-qualified one, and that is now a hard
prerequisite rather than a preference.** The slash is the whole grammar
addition, and it exists because the project is the difference between an
emulator and a bill: without it the adapter defaults `projectId` to
`virgil-emulator`, which is a name for nothing, and the SDK's failure would be
about credentials rather than about a missing variable. A spec with no project
is an emulator spec and is unchanged — every gated test and `deploy/smoke.sh`'s
own line still read exactly as they did. Split on the **first** slash, and a
second one is refused rather than guessed at: a board id may legitimately
contain `/`, so a two-slash spec is genuinely ambiguous about which half is the
project.

**And authorisation is a second variable, asked at startup.**
`VIRGIL_ALLOW_PRODUCTION=yes` — an exact word, not a truthiness test, because a
variable that is *set* is not a decision. The adapter's own refusal was already
correct and arrived **late**: it connects lazily, so an unwired Job cleared
startup, began a night, and died partway through it at 3am under `EXIT_INFRA`,
which tells the platform to retry a condition no retry can change.
`firestoreWiring` asks the same question before any night work exists, so the
answer is `EXIT_CONFIG` and the log names the variable. Two halves, refused
separately:

- **no opt-in** — a laptop with a stray `gcloud auth` must not be one export
  away from the real board;
- **opt-in with no project** — the subtler half, and the one no error message
  would ever have named on its own.

The opt-in lives in `deploy/job.yaml` and `deploy/service.yaml` rather than in
the composition roots, deliberately. A hard-coded `true` would authorise the
*build*; a committed YAML file authorises the *deployment* and is reviewed like
code.

An unrecognised spec **stops the process** with exit 2. The failure that refuses
is the quiet one: `SB_STORE=firestor:demo` landing on a container disk, running
one night, losing it with the instance, and leaving a green execution in the
console to say it worked.

Both resources are pointed at the **same** board, asserted in
`deploy-config.test.ts`. A service writing pins to one board while the nightly
reads another is a product that appears to work and teaches nothing.

### S4 — the store's serialisation law is a **per-process** guarantee · **capped, not fixed**

**The most important finding on this branch, and it is cross-lane.**

`JsonStore` holds the whole board in `this.db`, memoises the load in a single
`loading` promise, and serialises writes through a single `writing` promise
chain. Those two fields are what make the store's own laws true — *"the same id
written twice concurrently keeps the later call, not the later flush"*, and the
measured fix for *"60 concurrent writes to a cold store persisted 1"*.

**Both are properties of one process.** Two Cloud Run instances each hold a
complete copy of the board and each writes it whole; nothing between them
orders anything. And this is not a JsonStore-only problem: the Firestore lane's
own notes record measuring that *"two concurrent `set()` calls on one document
do not resolve in call order"* on the emulator, and fixing it with a `serial()`
queue — which is also per-process, and therefore also does not survive a second
instance.

Disposition: **`maxScale: 1` on the service**, deliberately, with this as the
reason. For one learner and one extension the throughput cost is nil. Raising it
is not a bigger number — it needs Firestore transactions or optimistic
concurrency underneath the store, which is the Store lane's call to make. It is
recorded here so that the day somebody raises the ceiling they meet the reason
first.

**Unchanged by the authentication and persisted batch-identity contracts, and worth saying so.** The persisted batch-identity contract made the
session's document name a field the run carries rather than one derived from its
clock, which removes a *retry* hazard — one process writing the same night twice
— and removes nothing about *two* processes. `sessionNight` makes the two
writes land on one path, and two instances racing on that path still resolve in
whatever order Firestore feels like, because `serial()` is per-process. The cap
is still the mitigation and still the only one. The shared secret at the exposed-service authentication boundary is
orthogonal: it decides *who* may write, not *how many at once*.

### S5 — `GET /usage` counts one instance · **documented**

`UsageMeter` is built inside `createApp` and lives in the process. Under
`maxScale: 1` it is correct; above it, it reports a fraction of the spend and
says nothing about it. It also resets on every cold start, which at
`min-instances: 0` is often. The endpoint is an operator surface, never a
learner one, so this is a known limit rather than a defect — and the nightly's
half now also goes to stdout (below), which is the durable record.

### S6 — the nightly wrote its usage artefact to local disk · **fixed**

`writeFileSync(join(dirname(DB), 'usage-<ts>.json'))`. In a Job that lands on
the tmpfs and vanishes with the task, losing exactly the runs the cost model
most wants: the unattended ones. Now written only when the store is a `json`
board, and always emitted to stdout as a single `usage-json {…}` line, which is
what Cloud Logging captures.

### S7 — `seed` and `history` write beside the store · **unchanged, flagged**

`seed-pin-order.json` is written by `seed` and read by `history`. Both are
local-authoring commands and neither is a production path, so they are left
alone — but they only make sense against a `json` board, and see R2 for why the
shared entrypoint that carries them is a standing risk.

### S8 — the boot warm-up assumed boot is rare · **fixed**

Not a disk assumption; a cost-shape one. The throwaway model call on boot is
measured and worth it on a laptop — it moves a 2135 ms first-pin cost off the
learner. At `min-instances: 0` every cold start buys a model call against a free
tier of **twenty a day**, on an instance that may then serve no pin at all. Off
under `K_SERVICE`, forced either way by `SB_WARMUP`. Proven in the smoke suite by
asserting the service logged no warm-up line at all.

### S9 — the service had no authentication of any kind · **fixed (The Firebase identity boundary)**

Not statelessness, but it is what the audit turned up and it was the thing most
likely to matter. `DELETE /everything`, `DELETE /pins/:id`, `PUT /model/:id` and
every other route were unauthenticated, and `access-control-allow-origin: '*'`
was sent on every response. On a laptop bound to loopback that reads like a
reasonable trade. On a Cloud Run URL it is a learner's board that anyone who
reaches it can read or destroy.

The Firebase identity boundary makes a verified **Firebase ID token** the account-backed service's
door. Every route but `/health` verifies the token first and derives
`boards/learner-<uid>` from its subject. `/health` reports only `{ok:true}` and
contains no board count or learner data. A missing, malformed, expired or
wrong-project token receives the same 401.

Cloud Run's invoker IAM check is disabled on this service because a browser's
Firebase token is not a Cloud Run IAM token. That allows a request to reach the
container; it does not select or open a board. The application identity check is
the gate that follows. Each self-hosted deployment supplies its own public
Firebase configuration and Google OAuth client during installation; the source
extension contains neither a borrowed tenant nor an operator secret.

The exposed-service authentication boundary still protects an exposed **single-board** service with
`x-virgil-secret`. `sharedSecret` refuses that shape at startup if it binds past
loopback without a secret. It is an operator provision, not a second credential
for an authenticated learner.

**`OPTIONS` stays open, and `access-control-allow-headers` names the header.**
CORS is decided before any credential is presented, so a preflight that required
the header could never carry one — and if the allowed list omits it the browser
strips it from every real request and each one comes back 401 naming nothing.

**And the wildcard is gone.** The `*` above outlived the audit that named it.
It was never only a Cloud Run problem: the loopback shape is the one with no
secret in front of it by design, so `*` meant any page the learner happened to
have open could call these routes *and read the replies*. `service.ts` now
echoes the request's own Origin, and only for a `chrome-extension://` origin —
the panel and the worker, whose id changes per profile so it cannot be a fixed
string — or an `http://127.0.0.1:<port>` / `http://localhost:<port>` one, which
is `qa/extension.html` running the compiled panel off a throwaway static server
against the real service. Every other origin gets no header at all.

Local friction: none. On loopback with both `SB_AUTH` and `SB_SHARED_SECRET`
unset the single-board service behaves as before. The Auth emulator form
`firebase:<project>@<host:port>` exercises the account-backed shape without
accepting unsigned emulator tokens in Cloud Run.

### S10 — `SB_RESUME_RECAP` was documented nowhere · **fixed**

Read as `process.env['SB_RESUME_RECAP']`, and `readme-claims.test.ts` only
scanned for dot notation — so a flag that buys a model call had no documentation
and no guard. Found by widening that scan, then documented.

**Superseded 2026-08-22: the variable no longer exists.** The recap stopped
buying a model call — the Composer writes each section's recap line as it writes
the section — so the flag had no argument left and was removed with it. The
widened scan that found this is what kept the README honest when it went.
Nothing in any estate should set it.

### S11 — nothing records that a nightly is in flight · **noted, not this lane's**

`pinsSince` says so in as many words: there is no run state in the store. With
the Job and the service as separate deployments, nothing coordinates them. The
Pub/Sub lane's `NightGuard` is exactly this problem; it is named here so the two
lanes do not each assume the other solved it.

### Concurrency, stated rather than assumed

Default concurrency is 80 requests per instance. Every handler is async over one
shared `deps.store`; reads are cheap because the board is memoised, and
concurrent writes queue through the single `writing` chain — so 80 concurrent
writes serialise rather than race, within the instance. Combined with
`maxScale: 1` that is a real throughput ceiling and an irrelevant one at this
scale. The default is left at 80 rather than tuned, because nothing here has
measured a reason to move it.

---

## 4. The exit-code contract

This is what a Job retry keys on, and it is the part of the per-night idempotency
question that belongs to this lane. (The other parts — the per-night session
key, and Pub/Sub ack semantics — are the Store and Pub/Sub lanes'.)

| the night | exit | why |
| :--- | :--- | :--- |
| a session was built | **0** | processed |
| nothing to teach | **0** | processed. The three-state batch-result contract's honest empty night |
| the model addressed nothing | **0** | processed. The three-state batch-result contract's third state |
| the provider's daily cap was spent | **0** | processed. The quota-degradation contract |
| the run could not be completed | **1** | the only case a retry can fix |
| the environment cannot describe a run | **2** | a retry will fail identically |

**Failure to produce is not failure to process.** A non-zero exit on an empty
night asks Cloud Run to run the whole fleet again to arrive at the same true
answer, at the same cost. The quota case is the sharpest: the quota-degradation contract specifies that
a spent *daily* cap degrades and is terminal, because `…PerDay…` is not worth
waiting for — and a non-zero exit hands that judgement to a retry policy that
knows nothing about quota, which recreates D10 through an unguarded retry path.

The Pub/Sub lane reached the identical judgement from the other side, in its own
words: *"failure to produce is not failure to process"*, with `nack` reserved
for a run that threw before deciding anything. A Job retry and a Pub/Sub
redelivery are the same event in different clothes, and the two contracts agree
by construction rather than by coincidence.

The README's standing sentence survives intact and is now a contract rather than
an accident: *a zero exit code from this command is not evidence that a session
exists.* The run's last line says which night it was: `night-outcome <kind>`.

**One honest gap.** `quota-degraded` is in the type and is not reachable from
`runNightly` today: the adapter decodes the quota metadata and `adk/src/errors.ts`
consumes it, but that host is wired into nothing. It costs nothing to carry,
because it maps to the same exit code as every other honestly-empty night, and
carrying it stops the two lanes' contracts drifting.

---

## 5. The images, and the Node finding

### Node 25 does not exist as a base image, because Node 25 is dead

This repository is developed on **Node 25.8.1**. Node 25 reached **end of life on
2026-03-31** ([Node releases](https://nodejs.org/en/about/previous-releases)),
and the consequences are not cosmetic:

- Docker Hub publishes **no supported `node:25-*` tag**. The maintained majors
  are 26 (Current), 24 (Active LTS) and 22 (Maintenance LTS).
- Google's distroless images publish **`nodejs22`, `nodejs24` and `nodejs26`**
  on debian13 and nothing else; every other tag is documented as deprecated and
  no longer updated ([distroless](https://github.com/GoogleContainerTools/distroless)).
- Google's Node buildpack supports *"the Current and Active LTS releases"* and
  documents 24.x as its example ([buildpacks](https://docs.cloud.google.com/docs/buildpacks/nodejs)).

So there is no such thing as a pinned, patched Node 25 base image, and any
config that names one will fail or run unpatched. **The images are Node 24, the
Active LTS.** That is a different runtime from the development one, which is
exactly why the whole suite is run against it rather than assumed:

```
docker run --rm -v "$PWD":/w -w /w --network none node:24-bookworm npm test
→ 0 fail
```

**Read the fail count, not the totals.** `deploy/build.sh` runs this first,
before it builds anything, and `set -e` stops the deploy on a non-zero exit —
so the claim this section makes is `0 fail`, which is the claim that stays true
while the suite grows. **Measured on 2026-08-21: 2266 tests, 2142 pass, 0 fail,
124 skipped**, and that total will be stale before it is read. An earlier
revision of this section pinned `1849 tests, 1816 pass` as though the number
were the finding; it drifted by several hundred within the week, and a build
script contradicting its own document in production is a reason to stop and
re-read rather than a reason to proceed.

Whatever the total, it is identical to the count on the development runtime, so
nothing in this tree depends on a Node that no longer ships. `--network none`,
so that run also proves the offline claim rather than restating it — the version
gap is a standing condition of this deploy, not a one-off check.

Every skip is an environment gate that announces itself rather than passing
quietly: the store and Gemini transport proofs (`LIVE=` plus an emulator host or
an API key), the Pub/Sub joint proof (`PUBSUB_EMULATOR_HOST`), and the container
suite (`DOCKER=1 npm test`), which is the one that checks the bind address,
`PORT`, the SIGTERM drain and every branch of the Job exit code.

### The shape

One `deploy/Dockerfile`, two targets, so the nightly and the service are
guaranteed to be the same build of the same source.

- **Builder** `node:24-bookworm`, pinned by multi-arch index digest.
- **Runtime** `gcr.io/distroless/nodejs24-debian13:nonroot`, pinned the same
  way. No shell, no package manager, non-root (uid 65532) by default.
- Manifests are copied before sources so an edit does not re-run the install.
- `npm ci --ignore-scripts`, then `tsc -b`, then **`npm prune --omit=dev`**.
  This bullet used to say the repository declared no third-party runtime
  dependency at all. **That stopped being true on 2026-08-21**, in the
  declaration commit, and the sentence is replaced rather than deleted because
  what replaced it is the same rule with a list instead of a prohibition:
  `adapters` declares `@google-cloud/firestore@9.0.0` and `adk` declares
  `@google/adk@2.0.0`, both named one by one in `seam-purity.test.ts`, and
  `core/` is still on the no-vendor side of both. Both are reached by a dynamic
  import, which is what kept them invisible to `npm ci` for as long as nobody
  declared them — and an image without the Firestore driver is an image whose
  production store dies on module resolution.
- `__tests__` is deleted before the runtime copy. Not for size: it carries
  `StubLlm`, the fixture boards and a harness that builds a store over a temp
  directory, and none of that should be one import away inside a production
  image.
- `extension` and `trigger` are built (so the typecheck is the whole project)
  and **not** carried into either image. `adk` is carried, because
  `SB_ORCHESTRATOR=adk` in `job.yaml` makes the nightly host itself in it.

**Sizes, measured on 2026-08-21 after the declaration commit:** the job image is
**500 MB**, up from 161 MB. 161 → 200 MB is the Firestore driver (121 packages);
200 → 500 MB is `@google/adk` (555 more, ~390 MB installed). That is the price
of the framework requirement and it is paid in the image, not hidden: the pull
happens once per revision and Cloud Run caches it, so what it costs a night is
cold-start bytes rather than money. The job target declares no `EXPOSE` at all,
per the jobs contract.

### No secret is in any layer

The key at `~/.config/virgil/env` reaches the image never. `.dockerignore`
excludes `.env*` and every board under `.data*/` from the context — the latter
matters as much, because `.data/` is the seeded demo board and the others are
the adversarial, scale and probe boards. Injection is at run time, from Secret
Manager in production (§6). The smoke suite scans every file in both images for
`AIza…` key shapes and for `GEMINI_API_KEY=` and asserts zero hits.

### Architecture

The build machine is arm64. Cloud Run runs amd64, so **`--platform linux/amd64`
is mandatory** for the real push — `deploy/build.sh` sets it and does not offer
the choice. Verified rather than assumed: the amd64 image cross-builds and runs
correctly under emulation, exiting 0 with `night-outcome no-session:nothing-to-teach`
on an empty board.

---

## 6. Config as code, and where every number came from

`deploy/job.yaml` and `deploy/service.yaml` are the first-deployment step.
`deploy/build.sh`, `deploy/apply.sh` and `deploy/schedule.sh` are the runbook
around them. Every one of them refuses to run without an explicit confirmation
variable, because nothing on this branch may create a billable resource.

### Task timeout — **1800 s**

The platform default is **600 s and would kill this nightly.** The Forager alone
was measured at *"8.5 minutes of silence before the first line appeared"* on the
local stack, and the three-register artifacts record full local runs at 25–47
minutes.

Those are Ollama-on-a-laptop figures and carry the standing machine-noise
caveat; they are **not** the production path. Production is Gemini, and the
benchmark recorded a warm nightly at **0.2 minutes (12 s)** for seven model
calls. So the honest expectation is about a minute, and the risk is the tail:
the Forager re-fetching a cold board over the network, plus per-minute quota
backoff — the transport proof observed the provider's own 11,000 ms retry hint
being read and taken successfully.

1800 s is roughly 3.5× the worst local network-bound reference and about 150×
the measured Gemini path, and it bounds a hung night to half an hour.

The asymmetry decides it. Jobs bill instance-based per second with a **1-minute
minimum**, so a normal night costs the minimum — about **$0.0011** at 1 vCPU and
512 MiB — and even a full 1800 s timeout costs about **$0.034**, against a free
tier of 240,000 vCPU-seconds a month. An over-generous timeout costs
approximately nothing; an under-generous one costs the nightly on the one day it
has to work.

### Max retries — **1** (the platform default is 3)

**Retries are safe because of the per-night idempotency contract.** A retried Job re-runs the night, and
`nightly-idempotence.test.ts` already proves what that does to the store: no
second set of topics, the same topic ids so the learner's signals stay attached,
and no re-enrichment of a pin the first run settled. The one thing not idempotent
is the session row, which is what the per-night idempotency contract — *"per-night session key at port —
approved"* — exists to fix.

**That half has landed** — the session document is named after the night, so a
retried Job writes the same path twice and leaves one row, idempotent by
construction rather than by a check.

**The key and this timeout used to be coupled, and are no longer.** The key was
the **UTC date of `builtAt`**, so a task beginning near midnight UTC and retried
after the boundary produced a *different* name on the retry and the row landed
on the following night. With `timeoutSeconds: 1800` and one retry the exposed
window was up to an hour either side of 00:00 UTC, and the only thing keeping it
shut was where the cron happened to sit.

The persisted batch-identity contract closed it: the name comes from `Session.nightKey`, which the run is
handed rather than deriving, so the retry's clock names nothing. See R3. Moving
the schedule and raising the timeout are no longer coupled to this — and the
retry budget below is bounded by quota alone, which is the only argument for it
that remains.

**Retries are bounded because a poisoned night must not burn quota.** A warm
nightly is seven model calls and the free-tier daily cap is twenty requests per
day per model. Two attempts is fourteen and fits inside the cap; three attempts
is twenty-one and does not. That arithmetic is the whole reason the number is 1
rather than the platform's 3.

And the exit contract keeps the blast radius small in the first place: only an
infrastructure failure retries at all. A degraded, empty or quota-stopped night
exits 0 and is never repeated.

### CPU and memory — measured, then rounded up

Jobs cannot go below **1 CPU**, so that is the floor and the setting.

Memory was measured rather than guessed. On the 21-pin seeded demo board, at 1
CPU, the nightly completed **inside a 128 MiB limit**; the service served
`/health` inside one too. Both are set to **512 MiB** — the platform default and
about 4× the measured floor. The headroom is for the thing the measurement could
not produce: real enrichment text held in memory for a real board, which a stub
model never writes. At $0.000002 per GiB-second the headroom is free.

**What that measurement does not say.** The stub answers instantly and the
internal network makes every page fetch fail immediately, so the *durations* in
that run measure the code and not a night. Nothing here sizes the timeout; §6's
timeout reasoning comes from the local and Gemini measurements instead.

### Service scaling

- `minScale: 0` — scale to zero. The demo is used in bursts and idle billing is
  avoidable; the cold start is accepted, and the warm-up is off precisely so a
  cold start costs no model call.
- `maxScale: 1` — **S4**. Not a throughput judgement; a correctness one.
- concurrency **2**, explicit. Model waits do not become dozens of queued
  requests competing over one CPU and one process-local learner-store cache.
- request timeout **300 s**, the default. The slowest endpoint is a single
  model call — a depth rewrite or a quick take — not a composition.

### Which model, and which host — two specs, both explicit

Both landed in the declaration commit, and both follow `SB_STORE`'s grammar:
named, refused when malformed, never a silent fallback, and unset is what a
laptop already did.

| variable | job.yaml | service.yaml | unset means |
| :--- | :--- | :--- | :--- |
| `SB_LLM` | `gemini:gemini-3.5-flash-lite/gemini-3.5-flash-lite` | same | direct Gemini API; local source can select its separate Local route |
| `SB_ORCHESTRATOR` | `adk` | *not set* | `local` — no framework |

**`SB_LLM` is the defect the runbook §2.4a named.** Both composition roots built
`OllamaLlm` unconditionally, and both containers are handed a `GEMINI_API_KEY`
that nothing read — so every deployed night and every deployed pin would have
reached `127.0.0.1:11434`, which inside a container is the container. It is set
on the service as well as the Job, and that is not symmetry for its own sake: the
service hosts Scout, Tutor and Reviewer, so wiring only the Job produces a
working night and a panel that cannot label a pin. `deploy-config.test.ts`
asserts the two values are equal, that a resource injecting the key names the
provider that reads it, and the reverse.

This is where **the model-benchmark boundary's** condition ends. *"Gemini's benchmark-lane role is
benchmarking only"* was never about the adapter being unproven — it has been
transport-proven since 2026-08-20 — it was about a paid provider not arriving in
the fleet by accident. `seam-purity.test.ts` still holds that line, in its new
form: only the two composition roots may name `GeminiLlm`, both must reach it
through `llmChoice`, and both must still be able to build the local adapter.
`model-spec.test.ts` proves the money rather than the shape — a service started
with no spec has its boot warm-up watched, and reaching any `googleapis` host
fails the test.

**`SB_ORCHESTRATOR` selects the workflow host.** See §5 for what it costs the image.

### The model secrets and public account configuration

Injected at run time, never baked. Production uses three Secret Manager
references: free-first Gemini key, managed Gemini key, and the optional managed
Notebook Drive grant (or the literal `disabled` sentinel):

```yaml
env:
  - name: GEMINI_API_KEY
    valueFrom:
      secretKeyRef:
        name: virgil-gemini-api-key   # the secret
        key: latest                   # the version
```

The runtime service account receives `roles/secretmanager.secretAccessor` on
those three secrets individually. `deploy/apply.sh` checks all three before
either resource references them. The checked-in direct Gemini API route needs
no Vertex AI project role.

The account configuration is intentionally public but deployment-owned: the
self-hoster supplies the Firebase project id, Web API key and Google OAuth
client id when packaging the extension. The API key is restricted to Identity
Toolkit and Secure Token. Possession identifies the Firebase project; it grants
no board access. Only a Firebase ID token whose signature, audience, issuer and
lifetime verify selects a learner board. The source manifest keeps an explicit
OAuth placeholder so a public clone cannot silently authenticate against
someone else's estate.

---

## 7. Local boundary and live platform receipt

Everything in §5 and the smoke suite is evidence about the *container*, not the
platform. The reference estate has since closed the principal gaps. Current
release identity must still be checked separately: a healthy service and a
healthy Job are not a matched release when their image tags differ.

| Platform fact | Reference-estate evidence | Remaining boundary |
| :--- | :--- | :--- |
| IAM and secrets | Dedicated runtime identity reads Firestore, mounts only three named secrets, and executes only the named Job with overrides | Re-audit after every IAM change |
| Service contract | Cloud Run injected `PORT`; the revision became Ready and serves `/health`; anonymous data routes return 401 | Measure cold start separately if latency becomes a goal |
| Job contract | Repeated executions reached terminal success and persisted receipts | A deliberately forced platform retry is not part of routine acceptance |
| Firestore | Native `(default)` database in `nam5`; real learner isolation and deny-all client rules observed | Service remains capped at one instance until whole-board writes are fully transactional |
| Gemini | Real Gemini 3.5 calls composed and verified a session; exact model ids and tokens were recorded | Paid fallback remains deliberately unfunded and unexercised |
| Google ADK | The live Job logged the ordered workflow under ADK and completed | Framework telemetry is kept in the Job image, not the HTTP service |
| Artifact pull | Both image targets have pulled successfully from Artifact Registry | Service and Job tags must still match for each accepted release |
| Scheduler | Direct Job execution is proven; optional schedules are paused/off by default | Enable only when an operator explicitly wants the fixed-board floor |

The smoke suite's own header says the same thing in one line, so that nobody
reads a green run as more than it is.

---

## 8. Risks

### R1 — the deployed service was unreachable by the thing that uses it · **closed for a provisioned deployment (The deployed reachability contract)**

Installation gives the extension one self-hoster-owned Cloud Run URL and its
exact host permission. **Continue with Google** obtains a Google credential
through Chrome, exchanges it with that deployment's Firebase project, and sends
the resulting Firebase ID token on every request. Cloud Run's invoker IAM check
is disabled so the browser request reaches the application; that deployment's
`SB_AUTH=firebase:<projectId>` then verifies the token before any learner board
is opened. Missing or invalid identity receives 401, and `/health` is the sole
anonymous, data-free route.

This is not the rejected unauthenticated API: network reachability and learner
authorization are deliberately separate layers. The old shared-key solution is
superseded for the account-backed estate because it made a deployment credential
the learner's setup task. The exposed-service authentication boundary remains available only for an exposed
single-board/self-hosted service.

The same Cloud Run origin serves the learner-facing board at `/app/`; the
extension never owns or hosts that page. `SB_FIREBASE_API_KEY` and
`SB_GOOGLE_WEB_CLIENT_ID` are rendered from the self-hoster's public browser
configuration. The latter is a **Web application** OAuth client whose
Authorized JavaScript origins include the exact Cloud Run origin. The packaged
extension uses a separate **Chrome extension** OAuth client tied to its stable
manifest id. `apply.sh` refuses to publish the hosted sign-in door if either of
its two values is missing; `scripts/package-extension.mjs` owns the Chrome
client boundary.

### R2 — one entrypoint answers both `nightly` and `seed` · **closed for Firestore**

The Job image ships `cli.js`, which also answers `seed` for disposable local
fixtures, and `seed` begins with `deleteEverything()`. A Firestore seed now
refuses before opening a client unless `VIRGIL_ALLOW_REMOTE_SEED=yes` is set in
addition to the production-store opt-in. The checked-in Job carries neither the
command nor that destructive authorization. The local fixture remains useful;
a copied Cloud Run override no longer turns it into an accidental board wipe.

### R3 — the retry window could straddle the night key's boundary · **closed (the persisted batch-identity contract)**

The per-night idempotency contract's key was the **UTC date of `builtAt`**, which made a retry idempotent
— one path, one row — right up until a task started near midnight UTC and its
retry landed on the other side of the boundary. Then one night wrote a row named
for the *following* night, that night looked built and never ran, and the ruling
was undone by the clock rather than by the code. `trigger-store-joint.test.ts`
produced the whole chain rather than arguing it.

**The persisted batch-identity contract removes the mechanism.** `Session.nightKey` is which night a run was
*for*, distinct from `builtAt`, which stays what it always was: when the run
finished. The trigger derives it from the message, `runNightly` takes it and
stamps it, `sessionNight` is what names the document, and the guard asks the
field before it asks the clock — and, for a row that has one, does not ask the
clock at all. A retry's clock now decides nothing.

Two consequences for this file:

- **The schedule's margin is no longer a safety argument.** At `0 3 * * *` a run
  finishes ~03:08Z with twenty hours to the next boundary, and the joint proof
  still measures it — as a record, not as a mitigation. Moving the schedule no
  longer has to re-check this.
- **`maxRetries` is bounded by quota alone.** The third argument for keeping it
  at 1 — *"more retries is a wider window"* — has been retired. Two attempts is
  fourteen model calls and fits inside a free-tier cap of twenty; three is
  twenty-one and does not. That arithmetic is the whole of it now.

Related, and also settled: the two lanes still do not *define* a night with the
same function — the store's is the UTC date, the trigger's is a local date
shifted back `H` hours, default 6 — but that is now a legibility difference
rather than data loss, because the document name comes from the field. The
estate pins `VIRGIL_TRIGGER_NIGHT_BOUNDARY_H=0` and `VIRGIL_TRIGGER_NIGHT_TZ=UTC`
anyway, which makes them the same function for every instant of the day.

### R4 — the base image digests are from today

Both bases are pinned by digest, which is the right call, and it means they will
be however old they are at deployment time. If a CVE lands in between, the fix is to
re-pin and re-run §5's Node 24 suite — which takes about seven seconds.

---

## 9. Fresh-project deployment, in order

The reference estate has run these resources. A new self-hoster must still run
the sequence below in their own project. Each mutating script refuses without
an explicit confirmation variable.

```bash
# 0. Three secret names. The first two may contain the same Gemini key. The
#    third is either a managed-Drive OAuth JSON grant (README.md) or the literal
#    `disabled` when the optional background Notebook refresh is off.
#
#    gcloud secrets create virgil-gemini-api-key        --data-file=-  < the key
#    gcloud secrets create virgil-gemini-api-key-free   --data-file=-  < the key
#    printf %s disabled | gcloud secrets create virgil-notebook-drive-credential --data-file=-

# 1. Register Firebase and configure the only sign-in provider Virgil uses.
npx --yes firebase-tools@15 login
npx --yes firebase-tools@15 projects:addfirebase "$PROJECT_ID"     # once, ever
# Initialise Firebase Auth with Google as the provider, create one Firebase Web
# app, one Web-application OAuth client for the service origin, and later one
# Chrome-extension OAuth client for the stable id printed by the packager. Keep
# Email/Password and Anonymous disabled.
# The public key is restricted to Identity Toolkit and Secure Token; the
# Firebase token returned after Google sign-in is what protects data. The source
# tree intentionally keeps the OAuth client and remote host unresolved until
# installation.
./deploy/build.sh      # tests, APIs, both images, --platform linux/amd64, push
FIREBASE_API_KEY=... GOOGLE_WEB_CLIENT_ID=... OWNER_EMAIL=owner@example.com ./deploy/apply.sh
                       # runtime SA, Firestore DB/rules/protection, IAM, Job, service
./deploy/schedule.sh   # optional fixed-board HTTP sweep; only if VIRGIL_SCHEDULE=on

# then run the live execution gate:
gcloud run jobs execute virgil-nightly --region us-central1 --wait
```

**`deploy/firestore.rules` denies everything, and that is the finished rule
rather than a placeholder.** Security rules govern client SDKs, and this product
has no client SDK path at all: the extension speaks HTTP to `service.ts`, and the
only Firestore client in the tree is the adapter, which runs server-side under
the runtime service account — Admin credentials bypass rules entirely. So
`if false` costs the deployment nothing and closes the one door nobody built.
`apply.sh` publishes the ruleset before either Cloud Run resource and then
enables database delete protection. `deploy-config.test.ts` holds both the
deny-all content and that ordering.

What `firebase deploy --only firestore:rules` needs:

- **The project registered with Firebase.** `virgil-506009` is a plain GCP
  project; `firebase projects:addfirebase` is what turns one into a Firebase
  project, and it is a one-time registration that adds a Firebase app surface to
  the estate. Budget it as an explicit first-deployment step, not a flag.
- **`firebaserules.googleapis.com` enabled.** `build.sh` enables it with the
  rest of the default backend API set.
- **A `firebase.json` naming the rules file.** This document once said the
  repository carries none on purpose; that stopped being true when the emulator
  ports were checked in, and as of 2026-08-25 the checked-in `firebase.json`
  also names `deploy/firestore.rules` — so the deploy runs from the repo root,
  and the scratch-directory copy this section used to prescribe is no longer
  needed. The emulator is unaffected: the only Firestore client in the tree
  carries Admin credentials, which bypass rules.

**The fallback is the console**, and it is not a lesser answer: Firestore →
Rules → paste the file → Publish. Slower to automate, faster to get right once,
and it needs no local tooling and no registration decision at all.

Either route has the same evidence: the active ruleset reads
`allow read, write: if false`, with a publish timestamp preceding the first
accepted runtime execution.

Every one of those refuses without `VIRGIL_DEPLOY=yes`, and `--plan` on any of
them prints exactly what would run and changes nothing. `PROJECT_ID` is required
by all three — it is rendered into both YAML files because the store spec
carries it. `apply.sh` additionally requires `FIREBASE_API_KEY`,
`GOOGLE_WEB_CLIENT_ID` and a bootstrap `OWNER_EMAIL`; the first two are public
per-deployment browser identifiers, while the owner becomes the authority for
the durable member directory. An existing estate may migrate with its first
`ALLOWED_EMAILS` entry as owner. Leaving identity or owner blank would publish a
`/app/` whose sign-in or administration boundary cannot work.

**What to check first when a revision does not come up.** All three of these
exit 2 at startup and say which variable, by design, so the log is the answer
rather than the symptom:

| exit 2 says | the estate is missing |
| :--- | :--- |
| `VIRGIL_ALLOW_PRODUCTION is not 'yes'` | the opt-in on that resource |
| `SB_STORE names Firestore … names none` | the project half of the store spec |
| `SB_SHARED_SECRET is not set` | an exposed single-board service has neither the exposed-service authentication boundary's operator secret nor `SB_AUTH` learner identity |

---

## 10. Sources

Live, fetched 2026-08-21. Google Cloud documentation has moved to
`docs.cloud.google.com`; `cloud.google.com/run/docs/*` 301s there, and pricing
did not move.

- [container contract](https://docs.cloud.google.com/run/docs/container-contract) ·
  [create jobs](https://docs.cloud.google.com/run/docs/create-jobs) ·
  [jobs on a schedule](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule)
- [task timeout](https://docs.cloud.google.com/run/docs/configuring/task-timeout) ·
  [max retries](https://docs.cloud.google.com/run/docs/configuring/max-retries) ·
  [request timeout](https://docs.cloud.google.com/run/docs/configuring/request-timeout)
- [job CPU](https://docs.cloud.google.com/run/docs/configuring/jobs/cpu) ·
  [memory limits](https://docs.cloud.google.com/run/docs/configuring/services/memory-limits) ·
  [concurrency](https://docs.cloud.google.com/run/docs/configuring/concurrency) ·
  [min instances](https://docs.cloud.google.com/run/docs/configuring/min-instances)
- [billing settings](https://docs.cloud.google.com/run/docs/configuring/billing-settings) ·
  [pricing](https://cloud.google.com/run/pricing) ·
  [quotas](https://docs.cloud.google.com/run/quotas)
- [job secrets](https://docs.cloud.google.com/run/docs/configuring/jobs/secrets) ·
  [service secrets](https://docs.cloud.google.com/run/docs/configuring/services/secrets)
- [YAML v1 reference](https://docs.cloud.google.com/run/docs/reference/yaml/v1) ·
  [jobs replace](https://docs.cloud.google.com/sdk/gcloud/reference/run/jobs/replace) ·
  [services replace](https://docs.cloud.google.com/sdk/gcloud/reference/run/services/replace)
- [eventarc triggers create](https://docs.cloud.google.com/sdk/gcloud/reference/eventarc/triggers/create) ·
  [buildpacks for Node](https://docs.cloud.google.com/docs/buildpacks/nodejs)
- [Node releases](https://nodejs.org/en/about/previous-releases) ·
  [Docker Hub node](https://hub.docker.com/_/node) ·
  [distroless](https://github.com/GoogleContainerTools/distroless)
