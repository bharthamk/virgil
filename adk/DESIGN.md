# The ADK port — design, options, and what is actually proven

> Status when written: **scaffold. Wired into nothing.**
>
> **Updated 2026-08-26, deployment and the tenth stage.** Both boundaries named
> below have since closed: the nightly is **ten stages** (an `intake` stage now
> runs first, working the drafts a course drop leaves — the nine-stage counts in
> this record are period-correct and stale), and the Job **has run in
> production** under `host adk (SequentialAgent)` against a real cloud board.
> Where this record says "nothing is deployed", read it as the state of
> 2026-08-23; the README carries the current estate.
>
> **Updated 2026-08-27, release security.** The runtime pin is now
> `@google/adk@2.0.0`. Its real offline binding/host contract remains green.
> `SequentialAgent` now emits an upstream deprecation warning in favour of
> `Workflow`; the current bundle also says Workflow cannot yet replace an
> `LlmAgent` sub-agent, so migration is tracked rather than faked. The upgrade
> removed the vulnerable SQLite/node-tar chain carried by 1.6.0. The lockfile
> forces ADK's vulnerable `adm-zip <0.6.0` edge to 0.6.0 while upstream's range
> catches up; clean `npm ci`, the ADK contract and the full product gate are the
> required compatibility proof.
>
> **Updated 2026-08-23, the stage-level integration.** `@google/adk@1.6.0` was a
> declared dependency, `deploy/job.yaml` sets `SB_ORCHESTRATOR=adk`, and the Job
> entrypoint now hands the host all nine real pipeline stage bodies through
> `HostedNightly`. The remaining unproved boundary is deployment: it has not run
> against a real cloud board or Gemini account.
>
> **Zero Gemini calls were made building this, and none are needed to check it.**
> Every test in this workspace runs offline, including the ones that drive the
> real framework. That is a property of the design, not an accident of the day —
> see §5.

---

## 1. The language finding, which decided everything else

The first question was whether an official ADK exists for this repo's language,
because the honest option set collapses differently depending on the answer.

**It does.** `@google/adk` — Google's own JS/TS SDK.

| fact | value | how it was checked |
| :--- | :--- | :--- |
| package | `@google/adk` | `registry.npmjs.org` |
| current project pin | **2.0.0**, checked 2026-08-27 | `npm view @google/adk` |
| author / licence | Google, Apache-2.0 | package metadata |
| maintainers | `google-wombot` (Google's npm publishing bot), `ofrobots`, `mrdoob` | package metadata |
| repository | `github.com/google/adk-js` | package metadata |
| first published | 2025-10-09 (`0.1.0`); `1.0.0` on 2026-04-21 | registry `time` map |
| transitive install | **603–605 packages, ~390 MB** | measured, §6 |

Docs: <https://adk.dev/> (the old `https://google.github.io/adk-docs/` now 301s
there), TS quickstart <https://adk.dev/get-started/typescript/>, deployment
<https://adk.dev/deploy/> and <https://adk.dev/deploy/cloud-run/>.

Official SDKs today: Python (`google-adk` 2.7.1), **TypeScript/JS
(`@google/adk` 2.0.0)**, Go (`google.golang.org/adk/v2`), Java
(`com.google.adk:google-adk` 1.7.0), Kotlin.

**Two traps worth naming, because both would have cost a day:**

- `google/adk-typescript` **does not exist** (404). The repo is `google/adk-js`.
- `@iqai/adk` (0.8.5, `github.com/IQAIcom/adk-ts`) is a **third-party** ADK-TS
  with a *different API surface*, and it ranks high in search. Its examples do
  not apply. Likewise `waldzellai/adk-typescript` is a community port.

So the Python-sidecar branch of the brief is dead, and so is the GenKit
substitution. Neither is needed. (GenKit — `genkit` 1.41.0, Node-native,
<https://genkit.dev/> — remains a real alternative framework, but swapping to it
would be choosing a different framework than the accepted ADK architecture, with no
compensating benefit now that ADK ships for Node.)

### 1a. The version trap that did change the build

Live docs and `adk-js@main` say `SequentialAgent`, `ParallelAgent` and
`LoopAgent` are **deprecated in favour of a graph-based `Workflow`**
(<https://adk.dev/workflows/>, <https://adk.dev/graphs/>).

**That has not shipped.** Checked against the installed 1.6.0 tarball:

```
Workflow: undefined | node: undefined | START: undefined | BaseNode: undefined | Graph: undefined
```

`dist/types/` in 1.6.0 has no `workflow` directory, and `SequentialAgent`'s
published `.d.ts` carries **no `@deprecated` marker**. The graph API exists on
`main` and is unpublished.

**Implementation choice: build on `SequentialAgent`,** which is what the published package
actually offers, and record the migration as a known risk (§7). Building against
an API that cannot be installed would be building against nothing.

Same shape, same ruling, for auth env vars. Docs and `main` say
`GOOGLE_GENAI_USE_ENTERPRISE` supersedes `GOOGLE_GENAI_USE_VERTEXAI`. Grepping
the shipped 1.6.0 bundle finds `GOOGLE_GENAI_USE_VERTEXAI`,
`GOOGLE_GENAI_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`,
`GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` — and no `USE_ENTERPRISE`. The
config reads what ships, and `config.test.ts` is the thing that will fail when
that changes.

---

## 2. The design question, and the answer

The brief set three options. The real choice turned out to be narrower than it
looked, because one of them is disqualified by the seam and one by the criterion.

### (a) ADK as the orchestration host — stages become ADK agents

**Chosen, in the form described in §3.** The goal is to express the fleet as the
framework's own primitives, which is what the Architectural Discipline criterion
(30%) is actually looking at."*

### (b) ADK wrapping the nightly as one agent/job surface

**Rejected.** One opaque agent that shells into `runNightly` uses almost none of
the framework and would read, correctly, as a framework requirement discharged on
a technicality. It is also the option that survives least contact with a judge
who opens the repository.

### (c) Hybrid — ADK hosts what benefits, the seam stays the model boundary

**This is what (a) actually has to be**, and the distinction is the whole design.

The trap in a naive (a) is that ADK's `LlmAgent` **calls the model itself**. One
`LlmAgent` per stage would:

1. **Move the model boundary.** `core/src/ports/llm.ts` would stop being the only
   door to a provider. The adapter seam — "the port is two adapters, not a rewrite" —
   would stop being true on the day it shipped, and `seam-purity.test.ts` guards
   exactly this.
2. **Put thirteen frontier-tuned agents through a second templating layer.** ADK
   composes its own instruction, contents and tool declarations. Every prompt in
   this fleet was iterated against the reference session. A layer that rewrites
   what reaches the model **invalidates that evaluation** and buys a full re-eval
   nobody has budget for. This is the largest hidden cost in the whole port and
   it is why (c) is not a compromise but the correct reading of (a).
3. **Buy nothing yet.** `LlmAgent` earns its keep on tool use, delegation and
   multi-turn state. The nightly is a deterministic nine-stage batch with no tool
   calls and no conversation.

**So: ADK is the orchestration host; the seam keeps the model.**

---

## 3. What was built

```
adk/                          ← new workspace, OUTSIDE core/, above the seam
  src/
    stages.ts                 the nightly as orchestration nodes (data)
    errors.ts                 provider failure → degradation directive
    config.ts                 env config; holds no credentials
    host.ts                   the OrchestrationHost contract + framework-free reference host
    adk-binding.ts            the ONLY file that names @google/adk
    index.ts                  does NOT re-export the binding
    __tests__/
      host-contract.ts        provider-neutral contract, run against every host
      local-host.test.ts      the control: contract vs. no framework at all
      adk-binding.test.ts     the proof: contract vs. real ADK (gated on install)
      stages.test.ts          registry checked against pipeline.ts itself
      config.test.ts          env config + "no key material in this layer"
      adk-seam.test.ts        this workspace's own purity guard
  DESIGN.md
```

The shape, concretely: the nightly becomes an ADK **`SequentialAgent`** whose
sub-agents are one **`BaseAgent` subclass per stage**, in `runNightly`'s order.
Each stage agent is *deterministic* — it runs a `StageWork` whose body is a
`core/` agent reached through the injected `Deps`. It makes no model call of its
own.

`describe()` reads `constructor.name` off the **built** tree rather than reciting
names, so the framework claim is checkable by a machine and cannot pass for a
wrapper that merely imports ADK.

**The contract is run against two hosts.** `LocalSequentialHost` uses no
framework at all and is the control — it is what proves the sequencing rules are
*Virgil's*, not behaviour inherited from a dependency and written down afterwards
as though it had been a decision. It is also the fallback if the dependency is
declined or a version breaks.

### 3a. Two transport amendments implemented, not just noted

The measured transport contract says `retryAfterMs` and `exhaustedForPeriod`
must be consumed, not merely decoded. `errors.ts` is the
consumer:

- **A spent daily cap degrades and is terminal for the seam.** Free tier is 20
  requests/day and a nightly is ~7 model calls. Once the cap is met, the later
  seam stages are reported **not attempted** — not "failed", because a report
  claiming six failures is claiming six requests that were never sent. The two
  arithmetic stages (`comfort`, `garden`) still run: they owe the provider
  nothing.
- **A per-minute cap surfaces the wait and the host does not take it.** Retry
  policy belongs to the caller (D18).
- **A content refusal degrades as a model failure**, per the provider-refusal contract — never as an
  empty answer.

The classifier **duck-types** the error rather than importing `GeminiError`:
importing it would make the orchestration layer depend on which provider the
product runs on, which `seam-purity.test.ts` reserves for the composition root.
A policy keyed on `instanceof` also silently stops degrading the day a second
provider throws a different class carrying the same two facts.

---

## 4. The seam, and the guard that was deliberately not edited

**`core/` is untouched. `seam-purity.test.ts` is untouched and green.** ADK sits
*above* the seam: it sequences stages, it does not call models.

One honest complication, and it is the thing most worth the lead's attention
after §7. `seam-purity.test.ts` has:

```js
test('no workspace has taken on a third-party runtime dependency', () => {
  for (const ws of ['core', 'adapters', 'runner', 'extension']) { … }
```

`adk` is a fifth workspace. That loop is a literal list, so **a new workspace
with a vendor dependency in it would pass every assertion there** while
contradicting the sentence the test is built around: *"A vendor SDK arriving
before that decision is made — in any workspace, not only core — is the thing
that turns 'two adapters' into a negotiation."*

Satisfying the letter of a guard while breaking its intent is precisely the
erosion that file exists to prevent. So:

- The existing guard was **left untouched** — and `adk-seam.test.ts` asserts it
  still names the same four workspaces, so a later edit "to make room" fails.
- The rule is **extended** to the new workspace instead, with additional checks
  the original could not make: exactly one file may name `@google/adk`, the
  framework is never imported statically, `index.ts` cannot pull it in, nothing
  here calls `.complete(`/`.structured(` or names an adapter, and the whole layer
  is wired into nothing.
- **This workspace declares no vendor dependency at all.** See §6.

**Both of those last two bullets changed on 2026-08-21** and are kept as written
because what replaced them is narrower rather than absent. The workspace now
declares exactly one vendor dependency — the framework, at the version the
binding was proven against, asserted name by name. The layer is now reached from
exactly one composition root, `runner/src/cli.ts`, and named nowhere below it;
`adkHost` and `AdkSequentialHost` are still forbidden outside this workspace, so
the root asks for a host *by name* and one file decides what that means. The
`index.ts` check became transitive in the same commit, because `select.ts` is
exported from the index and reaching the binding is its whole job. `seam-purity`'s
own four-workspace loop is still untouched, and `core/` still declares nothing.

---

## 5. Provable offline today vs. what waits

**Provable today, and proven — zero Gemini calls.** The suite was 1691 tests when
this was written; on `lane/declaration` it is 2257, of which
`adk-binding.test.ts` contributes 18 and no longer skips any of them.

| claim | evidence |
| :--- | :--- |
| the nine stages build into a real ADK `SequentialAgent` of `BaseAgent` subclasses | `adk-binding.test.ts`, read off `constructor.name` |
| ADK's own `Runner` + `InMemorySessionService` drive them in order, emitting real ADK `Event`s | same |
| every sequencing rule holds identically with and without the framework | one contract, two hosts |
| a hosted run makes **no network call** | `fetch` replaced for the run; any call fails the test |
| a failing stage degrades and does not tear down `SequentialAgent`'s sequence | `adk-binding.test.ts` |
| a spent daily quota stops later seam stages being attempted | contract, both hosts |
| the registry is the pipeline's real stage list, in order | `stages.test.ts` reads `pipeline.ts` |
| no key material lives in this layer | `config.test.ts` pattern scan over sources |

The reason this is possible on a day with no credits: **the hosted stages are
deterministic**. Hosting the fleet costs CPU, not tokens.

**Waits for credits or deploy — claimed nowhere:**

- The stages being handed `runNightly`'s **real** work. The host takes
  `StageWork[]`; decomposing `pipeline.ts` into that list is a change to the
  nightly this branch deliberately does not make (another lane owns it, and it
  wants its own eval pass).
- Any end-to-end hosted nightly producing a session.
- `adk deploy cloud_run`, and everything downstream of a GCP project.
- `VirgilSeamLlm` — the `BaseLlm` subclass that would let a stage become a real
  `LlmAgent` calling *through* the seam. **Written as a documented sketch, not
  implemented**, with its two unresolved parts named: `BaseLlm.connect()` is
  abstract and throwing from it for non-live use is undocumented; and translating
  ADK's tool declarations into Virgil's `LlmRequest` is lossy in exactly the
  direction anyone would want it.

### 5a. Deployment finding: there is no Cloud Run **Jobs** story

`adk deploy cloud_run` generates a Dockerfile and shells out to `gcloud run
deploy --source --port` — an **HTTP service** built on Express
(`AdkApiServer`). Searching <https://adk.dev/deploy/>, the Cloud Run page, and
the CLI's `deploy/` sources found **no Cloud Run Jobs / batch / non-HTTP
target**. Recorded as absent-from-docs rather than confirmed-unsupported.

This matters because the hosted architecture uses **Cloud Run Jobs** for the
nightly. The resulting shape is to keep the job
entrypoint as Virgil's own (a Cloud Run Job running the Node process), with the
ADK host inside it — *not* `adk deploy cloud_run`. The scaffold supports that
directly, since `AdkSequentialHost` is a library object with no server attached.
`adk deploy cloud_run` remains the right tool if the **session service** (a
genuine HTTP surface) later moves onto ADK.

Also verified and potentially useful later: ADK ships first-class **A2A**
(`RemoteA2AAgent`, `toA2a`, `@a2a-js/sdk` as a direct dependency), which is the
supported way an ADK process calls a remote agent over HTTP.

---

## 6. The dependency, and the day it was declared

At the 2026-08-21 declaration, `@google/adk@1.6.0` pulled **603 packages / ~390 MB**, including
`@google-cloud/storage`, `@google-cloud/vertexai`, `@google/genai`, MikroORM, the
MCP SDK and a full OpenTelemetry stack.

**As written, this section argued for not declaring it**, and the argument was
the repo's standing one: whether the product takes that on is the build owner's
decision, in the commit that means it. The orchestration dependency boundary accepted that and set the
trigger — *"the dependency is declared at the infra port, in the commit where the
ADK host becomes the nightly's real Cloud Run entrypoint."*

**That commit landed on 2026-08-21.** `adk/package.json` originally declared
`@google/adk@1.6.0`; it now pins 2.0.0, the lockfile carries it, `deploy/Dockerfile` stops deleting
`adk/dist`, and the job image goes from 161 MB to 500 MB — 555 packages on top of
the 121 the Firestore driver brought the same day. The number is the honest price
of the framework requirement; it is recorded in `deploy/CLOUD_RUN.md` §5 rather
than left to be discovered.

The import is **still dynamic**, for a reason beyond the original choice: a process that
chose the framework-free host should not pay 390 MB of module loading to find
out. `adk/src/select.ts` is the one place that turns a host name into a package,
and it does so inside a function.

```bash
npm ci      # the framework is in the lockfile
npm test    # adk-binding.test.ts runs 18 tests, 16 of them formerly gated
```

`adk-binding.test.ts` still has an unavailable branch, and its meaning has
changed rather than gone: an install that cannot resolve the package is now an
incomplete install rather than a decision nobody made, and it says so.

### 6a. What the deployed host is handed

The Job runs `runner/dist/cli.js nightly`. `HostedNightly` starts the stateful
pipeline and pauses it at each boundary; each matching `StageWork` executes the
real body under the framework, then feeds the host's timing and failure decision
back into the pipeline before it advances. The Job therefore builds a real
nine-child `SequentialAgent`, with no duplicate pipeline and no prompt moved out
of `core/`.

This joins the two formerly separate claims: the container entrypoint selects
ADK, and the work it gives ADK is the actual nine-stage nightly. Local and ADK
hosts run the same contract. Cloud execution still waits for credentials and
must not be inferred from this local proof.

---

## 7. The biggest risk to "framework requirement met"

**`SequentialAgent` is deprecated upstream in favour of an unpublished graph
`Workflow` API** (§1a).

The scaffold is built on the primitive the published package ships, which is the
only defensible choice today — but the surface it is built on is on a
deprecation path with no announced removal date. If `Workflow` publishes before
submission and a judge reads the docs rather than the tarball, the entry looks
like it built on a superseded API.

Three things reduce it, and they were design goals rather than consolations:

1. **One file** names the framework, so the migration has one address.
2. **The contract is framework-neutral.** A `Workflow`-based host is a third
   implementation of `OrchestrationHost` bound to the same assertions — the
   migration is a new host, not a rewrite.
3. `loadAdk()` **fails loudly on version skew**, naming the missing export rather
   than dying later on `undefined is not a constructor`.

Second risk, smaller but sharper: **nothing is deployed, and the writeup's
`[AT INFRA]` rows must stay `[AT INFRA]`.** What this branch changes is exactly
one of them — "Framework | ADK for multi-agent orchestration" — and only to the
extent §5's table says. The scheduled job, store, event bus, session service and
grounding rows are untouched and still not started.

That is unchanged by the declaration commit, and it is worth being exact about
why, because the commit looks like it should have moved a row. It made the
framework the thing the deployed Job's night runs inside, and it proved that by
building the image and running the container — locally. No GCP resource exists,
nothing has been pushed, and a container that runs on this machine is evidence
about the container. `deploy/CLOUD_RUN.md` §7 is the ledger of that gap and it
gained a row rather than losing one.

---

## 8. Sources

Live, fetched 2026-08-20. Registry facts come from `registry.npmjs.org` JSON
(npmjs.com web pages 403 to automated fetches); API facts come from reading the
installed package `.d.ts` files and the shipped bundle directly, which is why §1a
could contradict the prose docs.

- <https://adk.dev/> · <https://adk.dev/get-started/typescript/>
- <https://adk.dev/deploy/> · <https://adk.dev/deploy/cloud-run/> · <https://adk.dev/runtime/>
- <https://adk.dev/workflows/> · <https://adk.dev/graphs/> · <https://adk.dev/agents/models/>
- <https://adk.dev/a2a/quickstart-consuming/> · <https://adk.dev/api-reference/java/>
- <https://github.com/google/adk-js> · <https://github.com/google/adk-python> · <https://github.com/google/adk-go>
- <https://registry.npmjs.org/@google/adk> · <https://pypi.org/pypi/google-adk/json> · <https://registry.npmjs.org/genkit>
- <https://genkit.dev/> · <https://developers.googleblog.com/introducing-agent-development-kit-for-typescript-build-ai-agents-with-the-power-of-a-code-first-approach/>
