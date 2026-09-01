# Virgil: product and engineering deep dive

This document preserves the detailed product contracts, agent behavior,
operating boundaries and implementation rationale behind Virgil. For the
concise product overview and quick start, return to the
[repository README](../README.md).

[![Verify](https://github.com/bharthamk/virgil/actions/workflows/verify.yml/badge.svg)](https://github.com/bharthamk/virgil/actions/workflows/verify.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](../LICENSE)

**Stop collecting things to learn. Start knowing what to do next.**

Virgil stays by your side while you browse. See something worth understanding,
pin the exact passage without leaving the page, and learn it there and then or
return when you have time. The same source and context can become a quick lesson
in the side panel, a prepared session in Virgil, or an explicit handoff to
Gemini, WebMCP or Google Notebook (NotebookLM).

Behind that simple action is an AI learning manager. Virgil works through the
learner's material in the background, gives them one useful next move for the
time they have, and changes the plan when their answers, corrections, deadlines
and outcomes change the evidence.

Virgil was conceived, designed and built in full during the 2026 Google All
Things Agentic Hackathon. It contains no pre-existing product code.

Learning rarely arrives as a curriculum. It arrives as saved pages, videos,
course documents, deadlines, unfinished work and feedback scattered across
different tools. Virgil brings that reality into one system. Its agents prepare
and independently verify what is useful while nobody is waiting. What you save,
understand, avoid, correct and achieve becomes evidence, so the next
recommendation changes with you.

---

## Judge quick start

**60-second read.** Virgil turns scattered learning material into one adaptive
next move. Capture supplies evidence, Grow runs an 11-stage background agent
pipeline, Learn presents the smallest useful lesson, and Manage records the
learner's answer, correction or outcome. That new evidence changes what Virgil
recommends next. This is one causal loop over one learner-owned state, not a
collection of disconnected AI demos.

![Virgil architecture overview](architecture-overview.svg)

The [detailed implementation map](architecture.png) expands the service,
worker, model, storage and extension boundaries for a deeper review.

**Google stack.** Gemini supplies the model calls behind one typed `Llm`
boundary. Google ADK hosts the deep background workflow. Cloud Run serves the
browser product and dispatches the per-learner worker, while Firestore holds the
isolated learner boards. The extension and full browser page use the same
service and state. The [Google backend engineering map](GOOGLE_BACKEND.md)
names the APIs, identity chain, IAM, secrets, Gemini/Gemma routes, failure
boundaries and live proof commands in one place. The paired
[operations and recovery runbook](OPERATIONS.md) owns monitoring,
same-release rollback, backup drills, secret rotation and connection acceptance.

**Open the accepted hosted demo.** Submission reviewers receive a private,
unlinked Demo-mode URL and password outside this repository. That entrance
opens the same current product build over one shared disposable judge board; it
does not enter the owner's Google account or inherit personal Notebook/Drive
connections. Cloud/API use across the service and its Grow worker shares a
server-owned 500,000-token UTC-day ceiling. The ordinary hosted `/app/` route
continues to show only Google sign-in.

**Verify and open the included local demo.** The repository ships a synthetic,
public-safe learner board so the product can be inspected without an account or
model spend. Copy the compact judge story into a scratch store; never run the
mutable service against either checked-in `.data` fixture.

```bash
npm ci
npm test
node scripts/prepare-judge-story.mjs --out release/judge-story-scratch/store.json
SB_DB=release/judge-story-scratch/store.json node runner/dist/service.js
```

Then open `http://127.0.0.1:8791/app/`. The scratch story has three visibly
different topic states, a sourced RAG lesson, one course with material, one
dated commitment, an External receipt, and learner-authored plus machine-read
insights. Follow **Up next → Find the broken link in a RAG answer → Board →
Insights → My studies / Plan / External** to inspect the causal loop.
Actions that require a live model remain visibly unavailable until a model is
configured; the included state and the full offline gate remain reviewable.

For a fresh Google deployment, use [`INSTALL.md`](../INSTALL.md). It gives the
exact Firebase, OAuth, Secret Manager, Cloud Run, Firestore and stable-extension
sequence, with a no-write `--plan` before the guarded apply. The deeper design,
agent tables and evidence follow below; the exact accepted revision and gates
are in the [public release receipt](RELEASE.md).

---

## Five parts, one learner state

**Capture.** Pin an exact passage, paste a link or note, upload course material,
add a syllabus, rubric or deadline, or record learning that happened elsewhere.
Capture is deliberately cheap: you should not have to organise an idea before
it deserves to survive.

**Learn.** Use a Quick take, prepared lesson, recall check or guided action in
the exact 1, 3 or 5 minutes you have. When another tool is the better place to
go deep, Virgil deliberately opens Gemini, AI Mode or Google Notebook with the
source and context prepared; it never silently sends anything.

**Grow.** This is the centerpiece and the feedback loop, not a paid action that
runs whenever somebody pins. A learner action or the configured background
schedule asks eleven ordered stages to triage,
research, group, map, read evidence, detect gaps, propose missing material,
refresh, compose and independently verify. The learner model stays inspectable:
Virgil separates **my read** from **your words**, shows the evidence and accepts
correction. Each run leaves inspectable state and receipts; it never silently
sends material or overwrites a learner-authored claim.

**Manage.** Board, My studies, Plan and Check keep courses, material, deadlines,
drafts, marking criteria and outcomes reviewable. Grow is the invisible
intelligence; Manage is where the learner directs and audits it.

**Customize.** Settings owns model routes, spend, privacy, pause and exclusions,
backups, connections, theme and People. A self-hoster supplies their own Google
Cloud/Firebase project and model credentials; admitted members share that
installation's server-side model/billing boundary while keeping isolated
learner boards.

Every part reads or feeds the same board, evidence and learner model.

---

## What makes it different

**One move, never a backlog.** The panel shows one ready lesson and an exact
**1 / 3 / 5 minute** choice, not a grid of unread items. A learning board that
rots is not neutral, it is guilt.

**Three depths in one session.** Comfort is tracked per topic, so a single
session can go straight to the nuance on something you know, and start from an
analogy on something you do not — without you configuring anything.

**It knows when reading will not help.** If you are trying to learn something
perceptual or physical by reading explanations of it, it says so and gives you
something to *do* instead. No other learning tool tells you to stop reading.

**It notices things about you.** Not "you have 12 pins" — patterns like *the same
scope-qualifier mistake across five unrelated topics*, or *your sense of
understanding forms before you meet the exceptions*.

**The moat is the compounding loop, not any one feature.** A passage saved on
Tuesday can shape Thursday's lesson; Thursday's answer can change Friday's
recommendation. A new product can import bookmarks. It cannot immediately
reconstruct the evidence, corrections and outcomes that made the current next
move right for this learner.

---

## Architecture

The diagram is shown in the judge quick start above so the execution path is
visible before the implementation detail.

Every agent is a pure typed function. All model calls go through one `Llm`
interface, all persistence through one `Store`, all outside-world access through
`Research`, all vectors through one `Embedder`, and time is injected via
`Clock`. **`core/` imports no vendor SDK** — `scripts/check-seam.mjs` fails the
build if it ever does.

### On demand — interactive work

| Agent | Job |
| :--- | :--- |
| **Scout** | Labels a pin inside the toast. Measured 367–775ms against a 1500ms budget. |
| **Tutor** | Runs the session: marking, per-section depth shifts, bounded tangents, corrections. |
| **Reviewer** | Reviews *your own* writing against your known weak spots. Never rewrites. Reachable from **Check a draft** (`POST /review`); writes nothing to your record on its own. A recurring subject becomes a struggle pin only when you press **Put it on the board**, after which **Learn this now** can open a short lesson on that exact saved finding. |
| **Marker** | Assignment QC: marks a piece of work against the criteria you were given, one row each, with a quotation for every verdict. The criteria are split out of your pasted text in code and scanned for hostile instructions before anything reads them; **one miss is a send-back and nothing averages it away**. Never writes the fix. Same screen as the Reviewer — pasting the criteria is what chooses it (`POST /mark`). |
| **Intake Planner** | Reads a pasted syllabus, rubric, or assignment brief with reasoning on and proposes objectives, obligations, and clarification questions. Every accepted proposal carries an exact source quote; deterministic code recomputes dates and nothing reaches the plan before confirmation (`POST /course-intakes`). |
| **Transcriber** | Types out the words on the pages of a scanned document, and does nothing else. Exists because the criteria a mark is made against are split in code, one row per line, and pixels cannot be split into rows: a scanned rubric is read, the text lands in the box you can edit, and you check it before anything is marked against it (`POST /transcribe-pages`). Writes nothing, reads no record. |

All fifteen agents in the two tables are reachable from a surface, including
all Tutor behaviors. **Ask Virgil about this** reaches `answerTangent` from an
ordinary lesson. **This is wrong** reaches `handleCorrection`, rechecks the
cited source, keeps the exchange, replaces a conceded bad lesson and withdraws
its derived learning marks. **That marking is wrong** remains a distinct,
model-free control for withdrawing an incorrect answer mark.

A withdrawn mark does not make the learner repeat a lesson Virgil got wrong.
The lesson remains finished, its obsolete question stays closed, and its status
separately says that learning evidence was withdrawn. Session receipts never
call withdrawn evidence saved and describe an ordinary answer as an outcome,
not as raw answer or Tutor-feedback text the service does not persist.

A conceded claim is also retired from the rest of the lesson, not merely from
its main paragraph. The current heading falls back to the neutral topic name;
model-written summary, recap, question, action minute and closing note are
removed. That projection is applied to historical sessions, backups and
Notebook exports as well as new writes, so a known-wrong derivative cannot be
asked again or exported as settled teaching. Existing stored records are not
silently rewritten merely because the learner opens them.

The lesson rail shows expected time only while real work remains. A finished
session uses its completion receipt and does not turn an empty remainder into
the misleading duration `Expected time · 0 min`. A fully completed lesson
reopened from the Board offers **See what’s next** and re-reads Today; a mixed
session keeps its unfinished-lesson rail instead of duplicating that action.

The full Virgil page is an ordinary page on the learner's self-hosted service,
not an extension document. Its external doors therefore use native browser
navigation: course material, Drive consent, Gemini forwarding and Gemini
Notebook open in a new tab while Virgil keeps the lesson and its receipt. The
side panel uses the extension tabs API for the same destinations. Async handoffs
never pre-open a blank tab before copying; if the browser blocks their eventual
open, the exact destination remains as a visible link for a deliberate second
press.

Recall bursts keep the useful part of retrieval practice and stop there. Each
accepted answer—including an honest **I don't remember**—records its own
scheduling evidence. Reaching the end creates no participation award or points;
the close names how many topics were checked, then returns to Learn. The legacy
finish endpoint remains read-compatible for an older panel but cannot write an
award.

Learner-authored lesson questions and teaching challenges cross that boundary
whole or not at all. The lesson shows the 800-character question and
2,000-character challenge limits before submission; the browser keeps and names
an oversized draft without sending it. The service counts Unicode characters,
refuses overflow before a model call or write, and the Tutor prompt uses the
same code-point bounds so emoji and other astral characters cannot be halved or
silently reduce how much of the learner's meaning is checked.

Lesson follow-ups keep a fixed two-turn rolling window rather than an
ever-growing transcript, but each successful exchange in that window is whole:
the visible question can use the same 800 Unicode characters and the returned
answer can use up to 8,000. Direct callers that send oversized history are
refused before a Tutor call rather than having the earlier exchange silently
shortened, so “does that change it?” refers to the conversation still on screen.

Evidence-writing answers use the same law. Ordinary lesson answers and
five-minute recall answers visibly accept up to 1,500 Unicode characters. An
oversized answer stays editable and produces no request, model call, comfort
signal, or lesson completion; an exact boundary value reaches the relevant
marker whole. Virgil therefore never changes its learner model from a partial
reading of an answer the learner can still see in full.

The narrow quick-take panel follows the same rule for follow-up questions. It
states a 1,200-Unicode-character limit, keeps overflow without sending, and
clears an authored question only after a successful answer. A failed question
stays editable and an exact retry replaces its failed exchange instead of
duplicating it; the service refuses overflow before the fast Tutor call and the
prompt receives the exact boundary value whole.

Its closing verdict is a learner-owned decision, not a first-write-wins flag.
Repeating the same choice is idempotent; choosing the other one later
invalidates the earlier signal and leaves exactly one active answer. The panel
uses the verdict returned by the service for its receipt, so an older service
that cannot name what it retained can say only that nothing changed—never that
the newly pressed choice landed.

An answered quick take is also visible as progress without being inflated into
mastery. A topic that is still `waiting` in the agent ledger appears under
**Currently Learning** once either active closing verdict exists; invalidating
that verdict removes the projection. **Learnt** remains reserved for settled
topics. When no new pins are waiting, the seven-call action says **Build a
lesson** from what is on the board until settled learning really exists; only
then does it offer **Build a refresh** from what the learner has already learnt.

When a quick-take answer has grown into a subject of its own, **Put it on the
board** owns one opaque browser-generated receipt for that specific offer. A
lost response keeps the action and retries the same receipt; reopening the same
source cannot recreate that identity for a different later subject.

The Reviewer uses the same receipt law when a finding becomes a struggle pin:
one opaque identity belongs to that rendered finding, remains stable while its
write is retried, and cannot be recreated by a later review merely because the
suggestion has the same label or position.

### Background — reason-triggered batch, reasoning on

| Agent | Job |
| :--- | :--- |
| **Intake Planner** | Reads the course sources you dropped and proposes the objectives and dated obligations in them — as drafts you review, never as a course it wrote. |
| **Forager** | Re-fetches the page, reads around your selection, finds what the passage assumed. |
| **Clusterer** | Groups pins into topics across time and source. The grouping is arithmetic, not a model call — see below. |
| **Analyst** | Finds what is true about you that you have not noticed. |
| **Surveyor** | Builds the prerequisite graph. Refuses to guess. |
| **Registrar** | Comfort ledger — arithmetic, not judgement — plus the prose in **Insights**. The learner can add authoritative words before Virgil makes a read; those words outrank derived prose and can govern the next lesson. Rejecting a machine read blocks a paraphrase from the same evidence while allowing materially new evidence to support a later read. |
| **Prospector** | The night scout, and the one agent that looks outward. Reads the gaps the batch has already computed — a read of you the evidence does not settle, a check on your own writing, something several sources assume you know, a topic you keep setting aside — and proposes a few things to collect that you never thought to pin. At most three a night, every one naming the record it came from, every one a proposal you review. It writes no course, commitment, deadline, topic or signal, and any address it names has not been opened. |
| **Gardener** | Decay, resurfacing, retirement, and what should be taught next. |
| **Composer** | Builds the one session, at your target duration, at three depths. |
| **Verifier** | A separate adversarial pass over every authored lesson field and its private marking key. Its defect kind and severity are closed enums at both schema and runtime; malformed verdicts withhold as unchecked. Withholds; never patches. |

Pipeline order is load-bearing. The eleven stages the runner prints, in order:

```
intake → forage → cluster → survey → analyse → comfort → statements → prospect → garden → compose → verify
```

Only Forager fans out. `comfort` and `garden` make no model call at all — they
are the Registrar's arithmetic and the Gardener, and they are the two stages
that cost nothing. **Model-backed stages degrade independently** — one agent
having a bad batch must not erase useful work around it. The two pure policy
stages, Comfort and Garden, fail closed on infrastructure faults: pretending
their arithmetic ran would be less safe than stopping the batch.

#### Drop a semester, and the batch works through it

My studies → **Add** → **Syllabus or brief** includes **Choose course folder**,
so you can hand Virgil a whole course at once — a syllabus, lecture notes,
readings, and up to three hundred documents in one gesture. The browser reads
supported `.txt`, `.md`, `.docx` and `.pdf` files through the same bounded
parsers as single-source intake, then sends the extracted text under one stable
drop id. If the serialized folder would exceed 28 MiB, the browser sends
bounded parts under that same id and the same stable indexed item ids; a retry
therefore converges instead of duplicating work. Filenames never become
protocol keys: an invisible control or unusually long path cannot turn a valid
folder into an impossible retry. Extraction applies
backpressure too: the browser reads only until one part is ready, waits for that
send, and releases its text before continuing. It retains the selected File
objects for exact retry, not the extracted contents of the whole semester.
The folder root names the drop once; each source separately keeps its path inside that
root, so `week-01/notes.md` and `week-09/notes.md` remain distinguishable on the
board and in review. An unusually long path keeps a Unicode-safe head, a short
content-derived disambiguator and its useful tail instead of collapsing into a
shared prefix or broken character. A partial import keeps one folded list of every failed path
and its repair, with a direct route to add one another way; it never reduces
those failures to a count the learner cannot investigate. If a later request
stops after earlier parts succeeded, Virgil says exactly how many files were
checked, says that readable files from that part are already on the board, and
keeps one **Finish folder import** action under the same identities so retry
cannot duplicate landed work. Likely syllabuses, rubrics and briefs become intake drafts; everything
else becomes material on the board. Every draft still waits under **Needs your
eye** and nothing at the door becomes a course or deadline.

Every readable document, including a fetched URL, enters one
**200,000-Unicode-character** storage boundary. An exact boundary stays whole;
an overlong source keeps the first complete 200,000 characters and returns
`truncated: true` with the same receipt on retry. My studies counts that source
as added but separately names the file under **was shortened**, explains what
was kept, and opens the existing reviewed-source route for its missing tail. A
partial source therefore cannot look like a complete import.

Fetched course pages keep a second, block-aware text representation for
planning, so headings, table rows and separate deadlines reach review as
separate lines while Forager retains its compact prose contract. A custom or
older Research provider that supplies only flattened prose remains compatible,
but the per-source receipt and proposed-plan warnings both tell the learner to
check rows, headings and dates against the original before applying it.

Inside block-aware HTML, table rows remain separate but their cells stay on the
same line. A row such as `Lab report | 25% | due 9 September 2026` therefore
becomes one dated proposal rather than an undated title plus a second task named
after its date; generic header rows such as `Assessment item | Due date` do not
become learner work.
If the due-date cell contains only a date, the accepted date stays in the source
quote and structured deadline but is removed from the display title, so it is
not printed twice in the review proposal.

Course-drop pin, draft and source ids are derived from the stable drop/item
identity. That makes the retry law independent of request boundaries: identical
files in different chunks remain distinct, while simultaneous delivery of the
same item upserts one material/proposal set. A pre-stable draft is reused during
migration rather than duplicated. Caller-owned identities are never shortened
to fit: the service accepts drop ids exactly through 120 Unicode characters and
item references through 180, or refuses the complete request before a write.
The same limits and character rules are published in agent capabilities and the
course-drop format receipt. Each agent item may carry at most one non-null
source representation: `text`, `contentBase64`, or `url`. Supplied text must be
non-empty, and a supplied URL must use HTTP or HTTPS. No representation is an
ordinary per-item no-text receipt; malformed or conflicting representations
refuse the complete request before any document is written. When supplied,
`contentBase64` must be a non-empty string using the standard RFC 4648 alphabet,
optional padding and no whitespace; it must round-trip canonically. Both
discovery surfaces publish the source-selection and encoding contracts.

What is *not* done at the door is the expensive part. Three hundred documents
must not become three hundred model calls inside one request, so they become a
queue, and `intake` and `forage` take **fifty of it a night** — the cap is
`SB_WORK_CAP`, and its size is chosen so that a board nobody dropped a course on
never meets it. What is left over is left over on purpose: every stage line says
how many it took and how many are still waiting, and a run that is interrupted
resumes exactly where it stopped, because *owed work* is a property of the board
rather than of a job somebody has to remember. Nothing the batch proposes is
written as fact: a deadline it extracted is a draft with the source's own words
quoted beside it, and one it could not read unambiguously is a question, not a
guess.

### The model does not decide what goes with what

Topic identity is the hardest problem in the design: comfort and signal history
attach to topic ids, so a board that reshuffles during processing detaches a learner's
history from the thing it was about. Asked to partition the same 21 pins three
times, the same model with the same prompt returned 6, 6 and 7 topics.

So the partition is not a model call. Pins are embedded, clustered in code —
agglomerative, average linkage, cosine, every tie broken by pin id — and the
model is asked only to **name** the topics that get created. Pins already
assigned never move; new ones attach to the nearest existing topic or seed a new
one. A batch over an untouched board is a no-op by construction.

The fallback is a TF-IDF space in plain TypeScript with no model and no
dependency, because clustering was the one stage that could not degrade: no
partition, no topics, no board at all. It is selected rather than automatic —
see `SB_EMBEDDER` under *Running it* for why a silent swap would be worse than
a failed stage.

### Reasoning is an axis, separate from capability

Disabling the model's thinking pass took a topic label from 5005ms to 419ms.
Foreground agents run reasoning off because someone is waiting; background
agents run it on because asynchronous work has no interaction latency budget.
The fleet does its expensive thinking away from the learner's tap.

---

## Privacy

The one agent-initiated signal is re-read detection — noticing you came back to
a passage three times and then went looking for a simpler explanation. It:

- **never auto-pins** — it proposes, you confirm;
- **never interrupts** — it waits until you next open the panel yourself;
- **reads behaviour only** — scroll position, dwell, visibility. No keystrokes,
  no form contents, ever. The corroborating search signal takes the query from
  the URL of a results page, which is a navigation fact.

It ships with pause, domain exclusions, an inspectable and editable model of what
it thinks about you, and deletion that propagates into derived state. Those are
not extras — behavioural monitoring is only acceptable because they exist. A
pause stops both passive observation and Process while it is live; manual pins
still land. Privacy says that scope before the choice is made, and General
offers **Start again now** instead of an action the service would refuse.

---

## Running it

```bash
npm install
npm run build                     # compile every workspace
npm test                          # the full suite; the runner prints the count
npm run check:quality             # type safety, structural debt caps and coverage floors
npm run check:public              # credential and private-data release boundary
npm run check:seam                # cross-workspace import and runtime seams
npm run check:d1                  # partition implementation/equivalence contract

node runner/dist/service.js       # local service on port 8791, using the included judge board

SB_DB=.data-local/store.json node runner/dist/cli.js seed
SB_DB=.data-local/store.json node runner/dist/cli.js process
# The two commands above use the same disposable local board.

npm run eval:session              # score the latest session; non-zero on a broken contract
npm run eval:session -- --reference   # the two frontier reference sessions, scored

DOCKER=1 npm test                 # also builds both containers and checks their contract
```

**Containers and the cloud.** `deploy/` holds the Cloud Run preparation: one
`Dockerfile` with a job target and a service target, the job and service YAML,
and the runbook scripts. The service and Job have been exercised on an
operator-owned reference deployment; the optional Scheduler sweep remains off
by default. Every script that could create or bill still refuses without
`VIRGIL_DEPLOY=yes`. `deploy/build.sh --plan` only prints commands and performs
no writes; `deploy/apply.sh --plan` writes local `deploy/*.plan.yaml` for review
but makes no cloud change.
`deploy/CLOUD_RUN.md` is the design,
the statelessness audit, the reasoning behind every number, and the ledger of
what a local container run cannot prove about Cloud Run. `./deploy/smoke.sh`
runs the whole container proof on a network with no route off the machine.

**Scoring a session.** `scripts/eval-session.mjs` grades a composed session
against the board that produced it, offline and with no model: the contracts a
session must hold (provenance closed, registers the ledger's, budgets not
overrun, durations that recompute from the words written, questions the Tutor
can read, nothing invented about the learner) are **hard checks** and exit
non-zero; everything about tone, register authenticity and difficulty fit stays
human and is served only by **proxy metrics** — per-register length and
vocabulary spread, topic diversity, evidence density — which are signal to
compare runs on and never verdicts. `core/src/eval/session-score.ts` says which
is which and why each tolerance is the number it is. This is the instrument a
prompt change or the Gemini port is measured with; the two checked-in reference
sessions live in `runner/src/__tests__/fixtures/` as the bar, and the pre-fix
one still fails two of its checks.

`npm test` compiles as well, so it runs from a clean clone on its own. The seed
and partition corpora contain Virgil-authored synthetic text; no build step
downloads or overlays captured webpage excerpts. `npm run fixtures:synthetic`
rebuilds the checked-in 21-, 50- and 80-pin fixtures deterministically after the
compiled seed changes.

`SB_PORT` moves the service off 8791 and `SB_DB` moves the board off
`.data/store.json`; every run writes its artefacts beside whichever store it was
pointed at, so a probe never touches the seeded board. `SB_CONCURRENCY` (default
3) sets how many pages the Forager re-fetches at once.

`SB_WORK_CAP` (default 50) is how many queued items one run may work through:
documents waiting to be planned, and pins waiting to be enriched. It exists for
the course drop, where three hundred documents can arrive in one gesture, and its
default is set well above every board this project has ever been run on so that
a learner who has not dropped a course never meets it. `SB_WORK_CAP=0` removes
the cap entirely, which is a reasonable thing to want on a machine with no
metered provider behind it; anything below 5 is raised to 5, because a cap of one
is the per-item model call that batching exists to avoid. Deferred work is never
lost — it is simply still owed, and the next run takes it.

Every service JSON body is bounded at 28 MiB. The limit is checked against both
declared length and bytes actually read, so a client cannot evade it by omitting
or lying about `content-length`. Cloud Run's HTTP/1 boundary is 32 MiB; the
application margin leaves room for the hosted transport rather than asking the
platform to produce Virgil's error. The ordinary folder UI chunks before this
line and Check's 20 rendered pages are capped at one decoded megabyte each.

`SB_STORE` picks the store outright, and is what lets one container image serve
a laptop and a cloud: `memory` is a real board held in memory and forgotten with
the process — no disk, no database, which is what a container smoke test runs
against; `json:<path>` is the file store and is what `SB_DB` has always meant;
and `firestore:` is the production store. Its grammar carries the difference
between an emulator and a bill: **`firestore:<projectId>/<boardId>` names a real
Google Cloud project, `firestore:<boardId>` does not** and can only ever be an
emulator spec. Reaching a real project additionally requires
`VIRGIL_ALLOW_PRODUCTION=yes` — an exact word, not a truthiness test — and the
process refuses **at startup**, before any work begins, rather than at first
access: a run that dies halfway through a night asks its platform to retry a
condition no retry can change. A spec this build does not recognise stops the
process instead of defaulting, because a store that is not the one somebody
asked for is silent data loss rather than a default.

`SB_LLM` picks the default provider, in the same grammar: `cloud` (or legacy
`gemini`) is Google Gemini and is what unset means; `local` (or `ollama`) is an
Ollama-compatible self-hosted service; `cli` is the authenticated loopback CLI
bridge; and `gemini:<fastModel>/<deepModel>` pins a Cloud pair outright. The
learner can turn Cloud/API, Local and Agent CLI on independently under
**Settings → Models**, then assign Quick, Deep and Image work to one enabled
connection each. The persisted map drives foreground and batch calls without a
restart, and there is no provider fallback: a failed assigned connection fails
that work instead of spending somewhere else. Half a
tier map is refused rather than half-applied, and a scheme this build does not
know stops the process instead of falling back — falling back to the local model
would fail every night at the first call with a log line about `127.0.0.1` and
nothing about a variable, and falling back to Gemini would spend money nobody
authorised. The Cloud connection itself has one explicit, budget-gated key
ladder: the eligible free Gemini API key is tried first; only 429/503 may reach
the paid rung after the learner's existing spend gate. The current Cloud Run
YAMLs pin both arms to
`gemini:gemini-3.5-flash-lite/gemini-3.5-flash-lite`: free first, then the managed
API key behind that gate. The pinned id was live-probed on both the ordinary and structured deep
paths before the final submission lock. There is no below-floor model or provider fallback, and no fallback between the learner's
Cloud, Local and Agent CLI connections. Cloud remains the recommended/default.
Local runs directly beside a self-hosted service, or through an expiring,
learner-scoped connector when the Virgil service is hosted. The connector polls
outbound, calls Ollama on the learner's computer, and returns the ordinary LLM
receipt through that learner's Firestore board; it does not publish localhost,
carry Google credentials, or create a second learning pipeline.
Agent CLI is a real quick-setup and testing
connection for an installed agent or compatible harness. It is not the general
default and it does not turn an interactive desktop app into a hidden API.
**Use recommended settings** atomically enables Cloud/API, assigns Quick, Deep
and Image work to Google, and turns the other two connections off while keeping
their saved endpoints — but only after the service has a Cloud credential. If
the key is missing, the panel preserves the exact working map, focuses the key
field and says that setup comes first; the service independently refuses the
preset, so a stale client cannot disable a working self-hosted route. The
routing receipt also names any connection that is
on but has no work assigned to it. That state is valid standby rather than a
save error, but it is no longer easy to mistake a healthy self-hosted endpoint
for the connection Virgil will actually use.

`GEMINI_API_KEY_FREE` sits beside `GEMINI_API_KEY` and makes the Cloud
connection a two-key ladder: the free-tier key answers **first**, and the
managed key becomes a fallback reached only when the free pool returns 429 or
503 — so a learner runs on their own free allowance until it is genuinely spent.
Nothing else fails over: a 400 would fail identically on either key, and a
401/403 is a credential problem worth showing rather than spending money to
silence.
The learner's visible Cloud/API limit guards the complete ladder before either
key is reached. Once that limit is exhausted, Virgil issues no free or managed
Cloud call; raising or resetting the limit deliberately reopens the route. While
the route is available, the free key still answers first and only 429/503 may
reach the managed key. Both `deploy/job.yaml` and `deploy/service.yaml` take the
limit from its own secret. **Without a free key, this remains the single-key
build it has always been, behind the same complete-route guard.**

Settings is also where those connections are made usable. A loopback or
protected local JSON service accepts a Gemini API key from **Settings → Models** and stores it
outside the board in a mode-0600 `.virgil-secrets` file; the key is never
returned to the browser. Environment-injected credentials remain operator
managed. Local exposes its Ollama endpoint and the exact model-pull commands on
a loopback install. On the hosted build it instead offers **Connect this computer**
and returns a command for `npm run connector`. The connection remains paired
until the learner disconnects or replaces it; closing the worker merely makes
Local unavailable until it is started again, without silently moving work to Cloud/API.
The worker keeps ordinary fast work on Gemma and sends reasoning-on verification
to the stronger local Qwen tier; both remain on the learner's computer.
Agent CLI exposes its read-only bridge endpoint and startup command. Each has a
**Check connection** action that validates reachability or protocol without
running model work. Loopback is itself the trusted setup boundary: the service
cannot be reached off-device and its CORS policy admits only its own page and
the extension. An exposed service still requires its shared secret or verified
learner identity for the same actions. On an account-backed build, **Settings → Connections**
reports the Google account that owns this page; it never asks the learner for an
operator key or a Virgil password. Google handles the credential, and Virgil
exchanges that identity for the deployment's Firebase session before making
personal-board requests. A self-hosted single-board service can still be
provisioned with an operator secret, but that is installation configuration,
not an account or learner setting.

Learner-facing recency copy is also clock-skew safe. A timestamp up to five
minutes ahead of the browser reads **just now**; a materially future or invalid
timestamp is omitted; the established minute/time-of-day/day thresholds remain
unchanged, with singular and plural days rendered correctly. A service clock
must never make Settings report negative time or `1 days ago`.

`SB_ORCHESTRATOR` picks which host sequences the batch, and follows `SB_STORE`'s
grammar exactly: `local` is the framework-free sequencer in `adk/src/host.ts`,
`adk` runs the night inside a real `@google/adk` `SequentialAgent` driven by
ADK's own `Runner`, and anything else stops the process rather than falling back.
Unset is `local`, so a laptop runs the same batch locally. `deploy/job.yaml`
sets `adk`, which makes a deployed batch framework-hosted while the entrypoint
stays Virgil's own Node process. `HostedNightly` pauses the stateful pipeline at
each real boundary and hands ADK all eleven matching stage bodies; the framework's
report releases the next boundary. `hosted-nightly.test.ts` drives that exact
entrypoint shape through ADK's own Runner, offline, and proves it persists the
result. The remaining boundary is cloud execution, not tree shape.

**Nothing in the product needs a clock.** Batch work happens when
there is a reason for it: a learner presses **Process** on their board, or
enough new pins have piled up and they have turned automatic processing on
(`autoAfter`, off by default). A pin arriving is the trigger. Locally, the
long-lived service runs the batch in process. In the signed-in Cloud Run shape,
the service finishes one short, request-bound Admin API call and hands the
eleven stages to the existing Job with the verified learner's board and exact
learner-day key as execution overrides. The pin waits for dispatch acceptance,
never for model work; the Job then survives scale-to-zero and request CPU
throttling. A persisted worker receipt prevents duplicate dispatch across
requests and service restart and lets the board say queued, finished or failed.
The Job itself advances that receipt through the same Firestore board, so the
service identity needs launch permission but no Cloud Run read role. Its
terminal receipt keeps only a bounded outcome, stage/failure class and queue
counts: enough to offer the right recovery without storing prompts, provider
prose, exception text or API bodies. Receipt transitions are compare-and-set
store mutations; a stale worker cannot overwrite a newer dispatch, and an
ordinary Settings save cannot mutate deployment-owned worker state. Every
Cloud Run retry renews its own attempt-sized lease.
`domain/batch.ts` makes the due decision arithmetically, with no model call.
`deploy/schedule.sh` can add one optional hourly sweep for the operator's fixed
board, but it is off by default and is not the multi-user trigger.

`SB_AUTO_RUN_JOB` is the service-to-worker boundary: when present it must be the
exact `projects/<project>/locations/<region>/jobs/<job>` resource in the same
project as the project-qualified Firestore store. The service will only accept
it alongside `SB_AUTH`, then overrides the Job's `SB_STORE` from the verified
learner identity. `SB_BATCH_KEY` and `SB_RUN_RECEIPT_ID` are the corresponding
service-owned execution overrides. The first carries the already-decided real
`YYYY-MM-DD` learner day into the Job so a queued run cannot silently become
tomorrow's run while it waits; the second prevents a late retry from closing a
newer run on that same day. An operator normally sets none of these by hand: the
deployment template supplies the Job target and each accepted dispatch supplies
the day and receipt key.

`SB_AUTH` decides whether this process knows who is asking, and it is what makes
one service able to serve more than one person. In the account-backed product,
the extension opens at **Sign in**, offers one **Continue with Google** door,
and then opens that learner's own Virgil page. Virgil never receives a Google
password. The extension exchanges the Google credential with the Firebase
project owned by that self-hosted deployment, and the resulting Firebase ID
token is the service credential; there is no second shared key to find, copy or
save. Unset — the default for a laptop — is the single-board development
service this has always been: no sign-in, one board, whatever `SB_STORE` points
at. `firebase:<projectId>` makes it
multi-tenant: every route but `/health` needs a Firebase ID token, the signature
is verified against Google's published certificates, and each learner gets their
own board (`learner-<uid>.json` beside the single-board file locally, a Firestore
board of the same name deployed). `firebase:<projectId>@<host:port>` verifies
against a local **Auth emulator** instead, which is how the account journey is developed —
emulator tokens are genuinely unsigned, because a local emulator has no private
key. That form is spelled out rather than sniffed from
`FIREBASE_AUTH_EMULATOR_HOST`, so accepting unsigned tokens is always something
this process was told to do in a committed file; and if `K_SERVICE` is set, the
process refuses to start in it, because an unsigned-token verifier on Cloud Run
is an authentication bypass the platform would report as healthy.

The full board is served by that same process at **`/app/`**. The extension's
**Open Virgil**, account and settings doors resolve from the service origin
provisioned into `chrome.storage.local` under `sb_service_url`: loopback opens
`http://127.0.0.1:8791/app/`, while a self-hoster's cloud install opens
`https://<their-service>/app/`. No board door opens `chrome-extension://`.
The service publishes only the browser-safe configuration the hosted page needs:
`SB_FIREBASE_API_KEY` identifies that deployment's Firebase Web app and
`SB_GOOGLE_WEB_CLIENT_ID` identifies the **Web application** OAuth client whose
authorized JavaScript origin is this service. The packaged extension separately
carries a **Chrome extension** OAuth client tied to its stable extension id;
Google does not treat those as the same application type. None is a password or
a shared Virgil credential, but all are deployment-specific and installation
must provision them. `SB_WEB_ROOT` may override the baked-in web
asset directory for packaging tests or a custom image; ordinary installs leave
it unset.

`SB_GOOGLE_OAUTH_CLIENT_ID` is read for one release only as a migration fallback
for an already-running hosted service. New deployments must use
`SB_GOOGLE_WEB_CLIENT_ID`; the old ambiguous name must never be copied into a
new manifest or deployment file.

Results are learner-authored evidence, so Virgil does not quietly edit them on
the way to the board. **Record a result** and **Correct result** both state the
same Unicode limits: 180 characters for the result name and 6,000 for feedback.
Overflow remains in the focused field and sends no request; the service applies
the same limits before any result or learning signal is written. Exact-boundary
text, including emoji and other astral characters, is stored whole.

The shared result form has two honest doors. Plan keeps it beside the natural
post-completion moment; My studies keeps it beside the course and result rows a
learner returns to when a grade or feedback arrives later. My studies receives
its active courses, all assignments and active topics from the `/courses` read
it already makes, so the second door adds no store round trip. Opening it writes
nothing. A successful save rereads the owning course or loose-results section,
focuses the exact landed result and keeps the causal next-move receipt beside it.
Each result row also names the explicitly linked assignment and topics from that
same course context. Missing references stay unnamed rather than leaking raw ids
or guessing a relationship. Choosing an assignment that already belongs to a
course carries that course visibly into the form; choosing another course clears
the contradictory assignment, and the service independently refuses an
impossible pair before evidence or replanning is written. **Correct result**
mirrors name, kind, score, course, assignment, multi-topic links and feedback
under the same relationship law. A placement correction
rereads My studies and focuses the replacement in its authoritative section;
Cancel discards only the mounted draft and writes nothing.

The learner's optional note on a pin follows the same law at both ends of its
life. **Add details before pinning** and the later **Details** editor each state
a 1,000-Unicode-character limit. Overflow stays editable and unsent; the
service rejects malformed or oversized notes before Scout or storage, and an
accepted note keeps its internal wording and line breaks rather than being
silently compressed.

The course-intake review is also a truth boundary, not a formatting pass.
Explicitly labelled resources such as **Reading**, **Lecture** and **Exercise**
remain course material even when the outline supplies no link. Their label,
title, kind, duration and source quote survive review; generic timetable prose
is not guessed into material, and a refused unsafe URL is not laundered into a
linkless item. Review renders an external link only for a non-empty safe HTTP(S)
URL, so a book, classroom or LMS-only resource never leaves a blank keyboard
stop. Its optional link correction remains available, and supplying a safe URL
restores the normal external-link treatment.
That honesty continues after import. A URL-free material row offers **Add
link**, and Today calls the move **Add its link** while stating that Virgil does
not have one yet; it never advertises the repair under **Or learn something
now**, invents an expected study duration for the repair, or substitutes a
completion tick. The exact action opens and focuses the
link field. Only a safe HTTP(S) link is accepted, every other material fact is
preserved, Cancel writes nothing, and linked material keeps the existing direct
open plus explicit return check-in.
My studies keeps that receipt useful after import: **Objectives and sources** is
folded by default, each source offers its exact stored text, safe original link
and saved time, and the raw digest lives separately under **Technical receipt**.
An older source with no stored text never invents one.
Course titles (160), providers (120), objectives (300), material titles (180)
and assignment titles (180) state their Unicode-character limits beside the
correction fields. Overflow remains editable and sends no PATCH; exact-boundary
corrections are retained whole and non-string values are refused before the
reviewed draft can become course truth.

Those limits belong to the records, not to intake. A course typed directly into
**My studies**, a material added by hand, an assignment entered in the Plan and
a later course or assignment repair publish and enforce the same 160/120/180/180
Unicode-character boundaries. Browser overflow remains editable and focused and
sends no request; every create, weekly-series and edit route refuses overflow
before storage. The same learner-owned record therefore keeps the same whole-
value contract whichever ordinary product door created it.

Per-course material entry is locally reversible and unambiguous. Its launcher
and submit name the course to assistive technology, the visible submit says
**Add material**, and **Cancel** discards the local draft without a write before
returning focus to the course's launcher. A refused save still keeps the exact
draft and focused retry; successful creation still focuses the new material.

My studies also keeps the learner's course context after the deadline is over.
A live **Coming up** deadline is an exact-work handoff: it rereads the full Plan
without changing, scoring or scheduling anything, then focuses the authoritative
card the learner chose. A missing historical target degrades to the ordinary
Plan instead of guessing a replacement.
A topic named directly by a course appears there; when the direct list is
empty, a topic linked to open or completed work for that course appears there
as a derived relationship and nowhere under **Not in a course**. The projection
uses the same deterministic subject rule as the lesson lineup and performs no
backfill. The course's canonical `topicIds` and evidence progress denominator
therefore remain unchanged: linking an assignment says what the work leans on,
not that the course itself produced mastery evidence.

Source review is whole-or-refuse too. **Add course sources** publishes a
160-character source-name limit and a 60,000-character source-text limit before
**Review source**. Direct and bulk intake refuse an oversized source before any
draft or course record is written; an accepted source is retained exactly,
including line endings and outside whitespace, and its digest names those exact
stored characters. Folder intake is the deliberate bounded exception because
one oversized file must not strand a semester import: it keeps the first 60,000
Unicode characters, shows that limit as a review warning, and computes the
digest from precisely the retained source.

Identity lines stay identity during that review. A labelled course/module/unit
title is never proposed as work merely because it contains a word such as
`Assessment` or `Project`; a narrow unbulleted first-line document heading with
no date, deadline or weighting is treated the same way. Real undated work still
appears in **Upcoming work** and blocks apply until the learner supplies a date
or explicitly leaves it out.

Ordinary outline structure stays structure too. Blank rows end an Objectives
or Rubric section instead of letting the following week, reading, exercise or
assessment leak into it. A standalone `Due:`/`Deadline:` row directly beneath
an assignment qualifies that assignment and is never proposed as another piece
of work. The join is deliberately adjacency-only; less certain layouts remain
visible questions or proposals for the learner to resolve.

Learner-authored **Insights** are authoritative teaching context, so creation
and correction share a visible 1,000-Unicode-character boundary. Overflow
stays editable and focused and issues no request; the service trims only
outside whitespace, stores an exact-boundary insight whole, and refuses
overflow or a malformed value before changing the learner model. The exact
stored words remain the correction admitted to Composer and Verifier context.
Correcting a machine read starts from its current sentence for context, but
that prefill is not learner authorship: Save remains unavailable until the
trimmed wording actually changes, and the service independently refuses a
no-change write before it can relabel the read as **your words**.

Those words remain authoritative while a lesson is being written. Immediately
before the first session or exposure write, Virgil re-reads both learner-owned
corrections and compatible machine reads. If either changed during Compose or
Verify, the draft is not saved, no topic is marked exposed, and the processing
receipt offers **Try Process again** so the next draft starts from the learner's
current words.

Repeated Insight actions remain concise on the board but independently
identifiable to assistive technology. Every edit, delete and destructive
confirmation names its statement through the existing bounded short-label
excerpt; machine reads and learner-authored truths retain their distinct verbs,
and confirmation retains the same statement identity.

A destructive Insight confirmation temporarily replaces that statement's
ordinary action row, so the accessibility tree never contains two identical
Delete or Reject controls. The irreversible step says **Delete insight** or
**Reject this read**; Cancel restores and focuses its original launcher, while
a failed request restores the row beside one focused nothing-changed receipt.

Machine-written Insights also expose a collapsed **What this came from**
receipt. The service joins only the statement's named ledger signals to safe
topic and evidence-kind facts; it never sends signal ids or source-event
strings. Repeated events collapse to kinds rather than tallies, inactive
evidence says it no longer counts, and a read with no itemised receipt says so
instead of inventing provenance. Learner-authored words need no machine-evidence
disclosure and keep their distinct authority.

Check treats the marking bar as a whole-value boundary too. The criteria box
states that one check accepts up to 24 criteria of 400 Unicode characters each.
An oversized line or excess criterion stays in the focused box and sends no
request; core refuses instead of slicing or stopping, and the service returns a
correctable input response before any Marker call. Every accepted criterion is
therefore the complete criterion that appears in the mark.

Readiness is visible on the same pre-send receipt. A board-informed Review needs
80 trimmed text characters and a criteria-led Mark needs 200; core exports both
floors and the service publishes them beside the existing caps. **What will be
checked** states the current count, active minimum and exact remainder, and a
known too-short text-only action stays disabled. Adding criteria switches the
minimum live. Attached PDF pages bypass text length because they may be the
complete work.

Once **Check it** is pressed, that visible handoff becomes one immutable
foreground snapshot. Draft, criteria, context and both upload routes disable
together under an accessible busy form; no later keystroke or file choice can
make the preflight describe text the model never received. Success or refusal
restores the exact inputs together. Edits made after a completed result retain
the feedback but continue to mark it clearly as belonging to the prior draft.

Topic repair keeps the same promise. When a learner splits a topic, the new
name field states its 60-Unicode-character limit before confirmation. Overflow
stays editable and focused and sends no request; core accepts the exact
boundary whole or refuses before moving a pin or creating a topic. The name in
the confirmation is therefore the name on the resulting topic.

### Back up and move a learner board

**Your account → Download a copy** exports a signed-in learner's complete
board; a one-board/no-sign-in installation exposes the same controls directly
under **Your data** in the masthead. Both produce a versioned
`virgil-learner-backup` JSON file. It includes pins,
topics, prerequisite edges, evidence, statements, sessions, suggestions,
commitments, awards, courses, intake drafts, results and learner preferences.
It does **not** include a Google/Firebase session, Gemini key, Drive token,
shared secret or deployment configuration.

On the destination, sign in as the same Google email, open **Your account →
Choose a backup to restore**, and inspect the preview before pressing Restore.
For a one-board install, open **Your data → Choose a backup to restore**; its
backup owner is deliberately null rather than an invented account.
The preview makes no write. Restore accepts an empty board, recognises an exact
retry, and can resume the exact subset left by an interrupted restore without
duplicating evidence. It refuses a backup owned by another account and refuses
to merge into a different non-empty board.

Back up operator material separately and keep it out of the learner-data file:

- local protected credentials live in `.virgil-secrets/` beside the store;
- Cloud Run credentials remain in Secret Manager;
- public Firebase/OAuth identifiers and runtime choices live in the deployment
  configuration (`deploy/*.yaml` plus the self-hoster's environment);
- the learner backup's SHA-256 digest detects an incomplete or altered file; it
  is an integrity check, not encryption.

Restore those operator-owned settings through their normal deployment or
protected-file route, then restore each learner from their own Account page.
Do not combine either file with another learner's board.

The destructive control follows the same distinction. An account-backed page
offers **Delete my account** and removes the board before its Firebase identity.
A one-board page offers **Delete this board**: after a separate confirmation it
calls only the board deletion route, leaves Virgil installed and returns to the
empty board. Both put the portable copy immediately above the irreversible
step and make no deletion on the first press. The warning names the complete
boundary before that press: learning records include pins, topics, lessons,
courses, planned work, results, Insights, suggestions and awards, while board
preferences include model routes, budget and Privacy choices. Deletion resets
both groups; saved model keys and Google sign-in remain outside the board.

`SB_HOST` sets the interface the service binds. The default is `127.0.0.1` —
this service has no authentication of any kind and `DELETE /everything` is one
of its routes, so binding every interface on a laptop publishes the whole board
to the local network. The one exception is automatic: when `K_SERVICE` is set,
the process is running on Cloud Run, which routes only to `0.0.0.0`; the shipped
multi-user service then requires verified Firebase identity before selecting a
board. A Cloud Run marker alone is not authentication.

`SB_SHARED_SECRET` is the optional operator credential at the authentication
boundary of a legacy/self-hosted **single-board** service, sent as
`x-virgil-secret`. A service exposed
beyond `127.0.0.1` must have either that secret **or** verified learner identity
through `SB_AUTH`; otherwise it does not start. On an account-backed service the
verified Firebase token is the door and no shared secret is required or shown in
the extension. On loopback the secret is optional; setting one there remains a
way to rehearse an exposed single-board deployment. The floor is 16 characters.
Browser preflight is answered without credentials because it is the request that
asks permission to send the credential headers.

The two-line recap a stale resume opens with (SB-31) is always on, and there is
no switch for it. There was one for as long as this was the only place in the
product where *opening* a screen bought a model call. It does not buy one any
more: the Composer writes each section's recap line while it writes the section,
so coming back to a cold session is assembly, and the switch went with the cost.

`SB_WARMUP` forces the boot warm-up on (`1`) or off (`0`). An unset value warms
only when Local is the default on a self-hosted service, where it was measured
moving a 2135ms first-pin cost off the learner. Cloud and CLI never spend or run
at startup merely because they are selected; under `K_SERVICE` warm-up also
remains off unless explicitly requested. Models → **Where the work came from**
records this separately as **Starting Virgil**: it is neither a learner press
nor a board run, prepares the first action, teaches nothing, and remains part of
the visible total.

`SB_LOCAL_ENDPOINT` (with `SB_OLLAMA_HOST` retained as its legacy alias) moves
the local adapter off `http://127.0.0.1:11434`. It exists
for two real cases: an Ollama on another machine, and a container — where
`127.0.0.1` is the container itself, so without this an image can only reach a
model that is not there.

`SB_ALLOW_REMOTE_MODEL_ENDPOINTS=1` permits a learner-selected **Local** model
endpoint outside loopback. It never applies to CLI: a bearer credential follows
that route, so only the operator's `SB_CLI_ENDPOINT` may name its destination.

`SB_CLI_ENDPOINT` names the CLI bridge and defaults to
`http://127.0.0.1:8798`. `SB_CLI_TOKEN` is a service-owned bearer credential of
at least 16 characters. Build, then start the operator-side bridge with:

```sh
npm run build
SB_CLI_TOKEN='generate-a-long-random-value' npm run cli:bridge
```

The bridge listens only on loopback, accepts no command, executable, arguments
or working directory from the browser, runs a fixed ephemeral/read-only Codex
invocation with shell, browser, computer, plugins, skills, hooks and web access
disabled, and caps request, process output, model output, time and concurrency.
The CLI endpoint is operator-owned because its bearer token follows it; Settings
can select CLI but cannot redirect that credential to another URL.

The model direction matters: Virgil calls the bridge; the bridge launches the
CLI. The supplied implementation is Codex-specific. A test harness can
implement the same `/v1/complete` contract, and another non-interactive CLI can
gain a separate bridge adapter. The authenticated `GET /v1/capabilities`
receipt publishes the exact model aliases, media and request limits, and its
zero-tool/zero-side-effect authority.

There is also an inbound agent contract, and its front door is the board page
itself. Open `/app/` in a browser whose agent supports WebMCP and Virgil
registers five tools on `document.modelContext`:

- `guide_virgil_view` explains one named target on the visible Virgil page.
  It is presentation-only: it cannot navigate, open a hidden area or change
  learner data. An explanation can pause at a visible **Next** control, and
  Pause preserves the exact visible target and local Virgil state. Its bounded
  target set covers the real Capture, Learn, Grow, Manage and Customize
  surfaces. An absent or hidden target returns `GUIDE_TARGET_NOT_VISIBLE`,
  clears stale presentation state and never substitutes a synthetic screen;
- `get_study_state` reads the action Virgil is offering next, how many active
  courses and open dated items there are, and how many course drafts are waiting
  for review;
- `draft_course_intake` turns one already-extracted source into one reviewable
  intake draft, deterministically and with no model call. Its required
  `clientRef` makes a retry return the same draft instead of adding a duplicate;
- `preview_classification` ranks up to 100 passages against existing board
  topics and writes nothing; and
- `drop_course_materials` takes up to 300 text-or-URL documents in one gesture.
  Its required `dropId` and per-item `clientRef` values make retries idempotent.
  It is the
  one tool here that is not draft-only, and its description says so: every
  readable document becomes a pin on the board immediately and the plan-bearing
  ones become proposals, while no course, commitment, deadline, topic or signal
  is written and no model call runs during acceptance.

Registration is silent and optional. The tools run inside the learner's own
session, so an agent needs no origin, no shared secret and no header set from
the operator; a browser with no agent behind it registers nothing and the page
behaves identically. Inputs are checked again at execution time rather than
trusting browser-side JSON Schema enforcement. Calls carry WebMCP cancellation,
overlapping calls to one lane are bounded, tool output is capped, and a partial
study-state read is named instead of being reported as plausible zeroes. Write
failures distinguish a definite refusal from a lost receipt, and the page shows
a human-visible receipt after a confirmed agent write.

The older discovery endpoint, authenticated `GET /agent/capabilities` on the
same service origin shown in Settings, is superseded by that registration and
still answers for an agent with no WebMCP surface of its own. It publishes the
same lanes plus `POST /course-intakes/bulk`, which takes up to 25 deterministic
drafts with no model calls and no automatic apply. Its caller correlation keys
are echoed exactly through 180 Unicode characters or refused before matching,
and that contract is published beside the lane.

Virgil does not launch or remote-control the browser. The outside agent owns
computer use; Virgil owns bounded input, draft/preview creation and the explicit
learner review boundary before anything authoritative changes.

Bridge-only controls remain operator-side: `SB_CLI_PORT` changes the loopback
listen port, `SB_CODEX_BINARY` selects the installed Codex executable,
`SB_CODEX_FAST_MODEL` and `SB_CODEX_DEEP_MODEL` pin the two fixed aliases, and
`SB_CODEX_TIMEOUT_MS` bounds one child process. None is accepted by the browser
or the Virgil HTTP API.

`SB_NOTEBOOK_DIR` turns on the local notebook seam: the
directory Virgil rewrites its three learner-facing documents into after every
nightly batch, and on demand at `POST /notebook/export`. Unset is the whole
feature off, which is the default: the endpoints answer 404, the nightly writes
nothing, and nothing warns, because a destination nobody configured is not a
destination that failed. Point it at a folder your Google Drive client syncs and
Google Notebook will re-read those documents by itself once you have added them
to a notebook, which is the entire point of it. It is a local-deployment setting
by construction, because a container has no durable disk. The export is pure and
makes no model call, so it is outside the spend limit and costs nothing to run.

`SB_NOTEBOOK_DRIVE=1` turns on the other destination for the same three
documents: the learner's own Google Drive, written by Virgil directly instead of
by a desktop sync client. Unset is the whole lane off and is the default, so the
four `/notebook/drive` endpoints answer 404 and Settings shows nothing. It is
available only on a local JSON board that is not running under `K_SERVICE`, for
the same reason the Gemini key is editable only there: the whole argument for
this seam is that the OAuth grant is between the learner's Google account and a
process on the learner's own machine, and a container that loses its disk when
the task ends cannot hold that property while claiming it.

`SB_NOTEBOOK_DRIVE_CREDENTIAL` is the hosted worker form. It is a Secret
Manager-injected JSON value containing the Notebook account, OAuth client and
refresh token; the committed Cloud Run templates reference
`virgil-notebook-drive-credential` and never contain that value. The foreground
Google Notebook press stores only the folder id and the three stable file ids on
the learner board, after confirming the selected account matches the managed
grant. The Job then rewrites those same files at the end of processing even
when the page is closed. `node runner/dist/cli.js notebook` performs the same
three-document write without a model call, for setup and recovery proof. Unset
keeps the hosted background lane off. Disconnecting the learner-board setup
stops later writes without deleting any Drive file; revoking Virgil in the
Google Account invalidates the managed grant at Google.

`SB_NOTEBOOK_URL` is the public URL of the already-created Google Notebook that
reads those three stable Drive sources. Set it to a concrete
`https://notebook.google.com/notebook/...` address and every Notebook door opens
that live notebook after the hand-off. Leave it unset on a fresh installation
and Virgil safely opens the Google Notebook home instead. This is routing
configuration, not a credential; each self-hoster supplies their own notebook.

An account-backed deployment requires one bootstrap owner. `deploy/apply.sh`
receives it as `OWNER_EMAIL` and renders it as `VIRGIL_OWNER_EMAIL`; an existing
installation may keep using the first `ALLOWED_EMAILS` entry as its migration
owner. On first start Virgil creates a deployment-owned Firestore member
directory, separate from every learner board. The verified owner can then add
or remove people under **Settings → General → People**. Members inherit that
installation's server-side model connections, spend ceiling and billing while
Firebase identity continues to select an isolated `learner-<uid>` board. A
removed member loses access but their board is not silently deleted.

`VIRGIL_ALLOWED_EMAILS` remains an optional comma-separated initial-member
input and `VIRGIL_REQUESTS_PER_MINUTE` remains the per-account request gate.
`SB_OPERATOR_MODEL_BUDGET_TOKENS` is the deployment-owned durable Cloud/API
token ceiling: a learner can choose a smaller limit, but cannot raise or clear
that ceiling. Personal account names stay in deployment configuration and the
deployment's own Firestore, never the public source tree.

Both destinations may
be on at once; a document then counts as written only when it landed in both.
The standalone nightly in `runner/src/cli.ts` reads the same variable and
honours a grant the service already saved, **read only**: it offers no setup and
never writes a credential, because a self-hoster whose nightly runs from there
would otherwise get a Drive folder that silently stopped changing.

Connecting is Authorization Code with PKCE against a **loopback** redirect: a
listener on `127.0.0.1` and a port the operating system picks, alive for five
minutes and closed the moment the browser comes back. The scope is exactly one,
`https://www.googleapis.com/auth/drive.file`, which grants access to the files
this app created and nothing else in the Drive. The refresh token is written
`0600` into the same `.virgil-secrets/` directory the Gemini key uses, beside the
board and never inside it, and **no endpoint returns it, nothing logs it, and it
is never part of a receipt**. Virgil never calls `files.delete`; disconnecting
forgets the token locally and leaves the documents in the learner's Drive.

**The Google sign in is configuration, and never something a learner is asked
for.** The Drive block in Settings has exactly two states: a build that has a
sign in shows one **Connect Drive** control, and a build that has none says so in
one sentence and asks for nothing. There is no field to paste a client id into
and no console instruction anywhere in the product. This keeps account setup
out of the learner-facing flow; self-host configuration is documented here
instead.

Three places a client can come from, in precedence order:

1. `SB_DRIVE_CLIENT_ID` and `SB_DRIVE_CLIENT_SECRET` on the service. Set
   together they are authoritative and nothing else can override them, the same
   rule `GEMINI_API_KEY` follows.
2. A `google-drive-client` file in `.virgil-secrets/` beside the board, holding
   `{"clientId":"...","clientSecret":"..."}`. Write it `0600` or let the service
   fix the mode on first read. A stored client beats a shipped one on purpose:
   somebody who made their own Google Cloud project did it so the consent screen
   would name *their* project, and silently preferring the built-in one would
   take that away without saying so.
3. `SHIPPED_DRIVE_CLIENT` in `runner/src/drive-shipped-client.ts`, which is a
   two-line edit and is what gives every install the one-button experience. **It
   ships empty in this repository**, so the block honestly reports that this
   build has no sign in until somebody fills it.

To make one: a Google Cloud project, the Drive API enabled, and an OAuth client
of type **Desktop app**. **A Desktop-app client id and secret are not
confidential.** Google's own installed-app documentation says *"it is assumed
that these apps cannot keep secrets"*, lists `client_secret` as optional on that
flow, and recommends PKCE and a loopback redirect — which is exactly what this
does. What carries the security is PKCE: the authorization code is bound by a
SHA-256 challenge to the process that asked for it. Holding those two strings
buys somebody the ability to put your app's name on a consent screen; it does not
buy them a token or a byte of anybody's Drive.

**Leave the consent screen in Testing and it will only serve your test users**,
with a tester warning screen and a shortened refresh-token lifetime, so a demo
account must be on that list and a token that worked last week may not work
today. Publishing to Production is the way out and needs no verification here:
Google states that *"if your app utilizes only non-sensitive scopes, it is not
mandatory for your app to complete the app verification process"*, and
`drive.file` is non-sensitive. That is the same property the single-scope
decision was made for, paying for itself twice. There is no billing account and
no quota that costs money at this volume.

`PORT` is Cloud Run's own and wins over `SB_PORT` when both are set. The
platform injects it and has never heard of `SB_PORT`, so an image reading only
the latter listens on a port nothing is routed to.

`SB_PARTITION` chooses the partition rule, and the default is now `d1` — the
two-space rule, coarse lexical buckets then the fine cut inside them. It wins
the held-out mean on both bake-off corpora and reaches 79.5 F1 against 47.6
under the incremental arrival a learner actually lives in.
`SB_PARTITION=single` is the way back to the rule that shipped first,
byte-identical to what it always was, so the two can be run against one board.
The standing caution travels with the flip: D1's coarse cut is a spike rather
than a plateau, so both bake-off harnesses run again before that threshold
moves. The reasoning, with the numbers on both sides, is in
`core/src/domain/partition-d1.ts`; `npm run check:d1` is the equivalence check.

**A batch is quiet, and slow before it is quiet.** Nothing prints until a
stage finishes, and the first one — Forager — re-fetches every pinned page and
reads around the selection: measured here at 8.5 minutes of silence before the
first line appeared. It is working, it just has nothing to report yet.

For a real self-hosted install, follow [`INSTALL.md`](../INSTALL.md) and load the
allowlisted output of `npm run package:extension`; do not load the source
`extension/` directory as the finished package. The two-stage packager creates a
stable extension id before the self-hoster creates its Chrome OAuth client, then
reuses that key while finalising the package. It provisions the exact HTTPS
service origin and host permission and excludes source, tests, declarations,
hosted-page files, QA and retired surfaces. The public source deliberately
contains no borrowed Firebase tenant or central Virgil service.

For local development only, `npm run build` populates `extension/dist/` and the
source `extension/` directory can be loaded unpacked against loopback. Its OAuth
placeholder is intentionally not a working universal account.
`qa/extension.html`, deliberately outside the load-unpacked directory,
overrides those boundaries for local Auth-emulator/service proof. The QA harness
cannot be carried by the supported package and its override is not exposed as a
learner setting.

**One directory in the extension is not ours, and it is the only one.**
`extension/vendor/pdfjs/` is `pdfjs-dist` 6.2.108 (Apache-2.0), committed rather
than installed, and it is the extension's **first third-party runtime code** —
the Check screen takes `.txt`, `.md`, `.docx` and `.pdf` into its boxes, and a
PDF is the one format that cannot honestly be hand-rolled (`.docx` is eighty
lines of central-directory arithmetic and `DecompressionStream`, which is why
there is no zip library here either). `extension/vendor/pdfjs/README.md` carries
the version, the upstream, the copy commands and the sha256 of both files. It is
loaded **lazily** — the import happens the first time somebody drops a PDF, not
when the room draws — used for text extraction only, and addressed through
`chrome.runtime.getURL()`, so it costs **no manifest change, no CSP change, no
host permission and no `web_accessible_resources` entry**. `manifest-paths.test.ts`
asserts the files are on disk and that neither path lives under the gitignored
`dist/`. `core/` is untouched by any of this and still imports no vendor SDK.

What lands in the box is **proposed, never imposed**: the extracted text goes
into the textarea for you to read and edit, and nothing is sent until you press
the button. A file that cannot be read gets its own sentence — an unsupported
type, one over the size cap, a PDF that turns out to be scanned images, a file
with no text in it, and one that would not open at all are five different
things, and all five say the box is untouched.

The screen has a third, optional box — *anything else I should know* — which is
read as background and never as instruction: it is capped, then scanned line by
line before it can reach a prompt, and a line that tells the check what to
conclude is **quarantined and shown to you**, tagged with the box it came out
of, rather than quietly deleted. Each box also says how much of it will be read
before you press anything; the numbers come from the service's own limits, the
warning is amber and advisory, and it never blocks the button.

### What has to be installed

The local adapter talks to [Ollama](https://ollama.com) on `127.0.0.1:11434` and
asks for four models by name:

```bash
ollama pull gemma4:12b-mlx        # fast tier
ollama pull qwen3.8:27b-mlx       # deep tier
ollama pull nomic-embed-text      # the space the partition is cut in
ollama pull qwen3-vl:8b           # any request carrying media, whatever its tier
```

The fourth is only reached by a request with `media` attached, so the pipeline
runs without it on a board of text pins — but the adapter will ask for it by
name the moment one is not, and a missing model is a failed call, not a
fallback.

Without them the pipeline degrades rather than crashes, which is the design:
`process` names each stage that failed, says `NO SESSION BUILT`, and still exits
0. A zero exit code from this command is not evidence that a session exists.

That is now a contract rather than an accident, because a Cloud Run Job retries
on exactly this signal. `process` exits **0** for any batch that was processed —
a session built, nothing to teach, or a model that addressed nothing are all
runs that happened and were reported honestly. It exits **1** only when the run
could not be completed at all, which is the one case a retry can fix, and **2**
when the container was started with an environment that cannot describe a run
(an unknown `SB_STORE`, an unknown command) — a case whose retries will fail
identically. The legacy `nightly` command remains an alias for compatibility.

Clustering is the one stage with a no-model path, and it is **opt-in, not
automatic**: `SB_EMBEDDER=tfidf` runs the whole board in the lexical space with
no embedding model at all. Deliberately not a silent fallback — the two spaces
have different cut points, and swapping them without saying so would move every
topic boundary. So with no embedding model and no `SB_EMBEDDER=tfidf`, the
cluster stage fails and there is no board; with it, the same board clusters.

The scripts under `scripts/` check for what they need before they do any work,
and say which of them can run without a model.

### The local adapter is a test bed, not a product promise

The product ships on Gemini. Providers sit behind an interface because that is
how the code should be written anyway, and because it buys something more useful
than portability: **a free way to run the whole fleet against deliberately weak
models.**

That is the point of it. A prompt that holds up on a 12B local model is robust;
one that only works on a frontier model is fragile and we would not know until
it drifted in production. Weak-model failures are diagnostic signal, not defects
to accommodate.

Two findings that came out of exactly that, and would not have surfaced
otherwise:

- **Surveyor emits almost no prerequisite edges locally, and how few is not
  stable.** Three runs over the same 21 pins produced 0, 0 and 1 edge; a later
  run produced 2. What holds across all of them is the discard: nearly every
  candidate edge falls below the confidence floor and is dropped rather than
  emitted as a bad ordering — so the guard works, but the prompt is carrying
  more of the model's judgement than it should. The spread in the surviving
  count is the run-to-run clustering instability showing through, not a second
  finding.
- **Truncation, not schema drift, is the dominant structured-output failure.**
  Found because a small model hits token ceilings sooner; the same failure exists
  on any model with a thinking budget.

Anyone who genuinely wants to run it locally can configure it themselves. We are
not chasing every model and runtime, and that surface changes weekly.

---

## Status

The accepted 2026-09-01 estate runs the account-backed product on Cloud Run and
Firestore, with durable per-learner Job dispatch and the paired Local-model
connector available as an ordinary model route. The public-safe
[current release receipt](RELEASE.md) names the exact current revision and
checks without depending on private operator files. That release
serves the accepted real-surface WebMCP guide and the
same Capture → Learn → Grow state used in the final causal-loop proof. This
reference deployment is execution evidence, not a universal Virgil account:
normal access remains owner-managed Google sign-in, while the unlinked private
Demo entrance uses one disposable judge board and a bounded shared model budget.
The current exact-tree gate is clean under
`npm test`; that command is the source of truth for its live total and prints
passing, failing and skipped counts.
Firestore and Pub/Sub emulator checks and live-key checks remain explicitly
skipped when their dependencies are absent. The same gate is required of the
history-free source package. `npm run check:public` guards
the public-data and credential boundary; `npm run package:source -- --out PATH`
creates the reviewable source artifact from a clean tree. Pass
`--source-ref EXACT_REF` to bind that artifact to an exact checked-out ref;
`--allow-dirty` exists only for clearly marked development snapshots. The v2
receipt records the source commit/tree plus a complete SHA-256 file inventory
and selected runtime-file identities. The repository already includes its
[Apache License 2.0](../LICENSE); publishing requires only an authorised clean
first commit.

Assignment QC now joins returned model rows back to Virgil's authored
criterion keys through a unique, conservative resolver. Harmless forms such as
`criterion c1`, `C2` and `3` retain their intended rows; unknown keys remain
unmarked, and a duplicate cannot overwrite the first answer or make the final
verdict depend on reply order.

The same conservative identity rule now protects Check's learner-specific
topic attribution. Reviewer and Marker retain a uniquely matched board topic
through harmless casing, quoting or a `topic` wrapper, but do not guess when a
returned id is unknown or ambiguous; the underlying finding or verdict remains
visible either way.

Check also names its foreground model wait instead of leaving a blank result
area behind **Reading…**. Review and rubric marking immediately show
**Reading your draft…** and the honest **This can take a minute or two.** caveat
inside the busy result region; the submitted fields remain visible and locked,
and the eventual finding, mark or failure replaces the waiter completely.

Learner-authored Insights now govern the foreground Tutor as well as the
background Composer. Quick Take generation and verification, Guide, stuck-step
help and Ask all use the same correction-first learner context: the learner's
words outrank incompatible machine reads, remain separately fenced, and shape
teaching without becoming evidence about the subject.

Adaptation does not buy permission to invent. Quick Take's deterministic
source-drift floor recognises ordinary worked-example and analogy openings such
as **Consider**, **for example** and **like a**. A drifting first draft receives
one narrower rewrite without being fed its unsupported prose. Proven drifting
sentences are then removed, and the surviving lesson still has to pass the
independent checker. If no source-bound lesson survives, it is withheld.

General Settings no longer turns Process into a dead-end state. A board with
no learning material offers **Add something to learn** instead of starting a
zero-work batch. A real run is reconciled through its terminal `/batch`
receipt: **Working through it…** is replaced without leaving the room, and a
diagnosed model or budget stop owns **Check model connection** rather than
offering the same Process action again.

When a prepared section is held back, Learn puts that safety result ahead of
future work and alternative topics. A held topic may still offer a shorter
lesson from its pin, but the page says that this is a separate check rather
than implying the failed lesson has been repaired. Model-backed foreground work
is described as taking a minute or two; the interface does not promise seconds.
If a quick lesson fails that check, the safe next move is **Choose something
else**. Repeating the model-backed work remains available as the secondary
**Try a fresh version**, and returning to Learn spends no second model call.
Inside a ready quick lesson, one interaction owns the foreground: while a
question or shortcut is waiting, every other question control and both closing
verdicts are disabled together. A confidence signal cannot close the lesson
ahead of an answer that is still being written.
Quick teaching also has a deterministic source-drift floor beneath its model
check: causal consequences and analogies made mostly from vocabulary absent
from the Pin trigger one bounded source-only rewrite. Unsupported sentences are
removed rather than patched with general knowledge, and anything that remains
still earns the full independent reasoning check.

Plan completions reconcile as one confirmed projection. The finished card
moves out of its open lane and into Done while its calendar markers disappear,
the score and tutor re-read, keyboard focus follows the card, and the award
receipt stays attached to it. Virgil never leaves one live page briefly saying
that the same commitment is both open and done; a slow response that arrives
after the learner navigates away cannot pull them back into Plan.

A dated item is repairable without being replaced. **Edit details** corrects
its name and assignment/lesson/study/task kind on the same record while its
deadline, planned day, course/topic links, completion and award history remain.
The form starts from stored values, saves only those two fields, keeps a failed
draft intact, and states when a recurring edit applies to this date only.
Course/topic filing is repairable on completed work too. It changes those links
on the same record without reopening it, disturbing its dates, or touching its
completion and award ledger; the authoritative card and focus return together.

Every screen on the main page is drawn inside one shell (`frame()` in
`extension/src/panel.ts`): the same bar in every room, the nav marking the door
you came through, and a measure chosen for the room rather than inherited from
whichever screen was written first. The side panel is exempt on purpose — it is
the one thing the learner just pressed, not the product.

**A learner arrives at Today, which answers one question: what should I do
right now.** The session when there is one, then what is due, then five minutes
of recall when that is all there is. Nothing on it counts anything — no overdue
tally, no total to fall behind on — which is SB-18 asserted directly rather than
inherited from a layout.

The **1 / 3 / 5 minute** choice is a hard boundary. Today exposes only prepared
sections that fit and keeps the same boundary after Start; longer prepared
sections remain visible under Coming up. If none fits, an active saved topic can
become a source-backed quick take sized to the chosen moment. Only a genuinely
empty board asks for material.

Quick takes are smaller than composed sessions, not less checked. Virgil writes
the foreground explanation, then a separate reasoning-on Verifier checks it
against the pinned passage before it is shown; numerical, musical and code
claims receive the deep tier. A fatal or unreadable verdict withholds the take
instead of letting the generating model patch its own answer, and no confidence
signal can be written for teaching the learner never saw.

The same rule governs full sessions. The Verifier receives the heading, lineup
summary, return recap, body, learner question and every expected answer point,
not only the paragraph being shown. If a lesson admits that its source does not
establish a mechanism, it cannot then require that mechanism in the question or
private marking key. Defect kinds and severities are closed structured enums;
if a provider still returns an unknown or malformed finding, Virgil treats the
whole verdict as unchecked and withholds rather than dropping or weakening it.
New contradictions are withheld before a model call;
historical sessions are projected through the same deterministic rule on Learn,
Today, backup and Notebook reads without rewriting the authored ledger row.

Answer completion follows the authored marking key, not the marker's summary
boolean alone. If the marker names one of those required points as missing, the
answer records a real miss and remains open for revision. A missing requirement
that is not in the key is discarded rather than becoming a hidden test.

Choosing **Add to my lessons** promises inclusion, not an exact next-session
slot a short time budget may be unable to hold. The live request does outrank
Virgil's inferred regressions and the lesson names that it was the learner's
ask. Once a verified section is actually stored, that topic's exposure
advances; an attempted, withheld or unverified section remains owed.

**The board is a room.** Five areas the learner named — Get Started, Currently
Learning, Recharging, Paused, Learnt — with what they have pinned and not yet
processed at the top of the first, a search in the top bar, and the Process
control on the heading of the area holding the things it would work through.
Every pin keeps its title as the direct lesson door and exposes a separate
**Details** receipt: exact captured material, page and time, plus repair for the
learner's interested/stuck intent, note and requested lesson level. The receipt
does not run a model, and none of its editable fields can rewrite the source or
learning history. A stopped Process run keeps only a closed learner-safe cause:
credential and budget refusals open Models, while an unknown operational stop
alone offers retry. Provider exception text never reaches the board.
When Process finishes with a checked lesson, that lesson owns the receipt's one
next move. **Open the lesson** is not placed beside another Process or refresh
action that could spend again before the learner sees what was just made.
Two of those five are facts the old three-state board was hiding: *Paused* is a
topic the learner retired, which used to be filed as *settled* (the product
telling somebody they had learnt a thing because they had stopped asking about
it), and *Recharging* is the spaced-review rule, which `TopicState` cannot carry
at all.

**Beside it: a plan, and what you are studying.** Commitments with due dates —
assignments, classes, study time on any platform — which earn points for being
closed, more for being closed on time, and again for being closed on the day you
told yourself you would. Stars accumulate faintly on the board itself. Nothing
here punishes: late still scores, nothing expires, nothing is deducted. And the
part that makes a planner worth having inside a learning product rather than
beside one: **a due date reweights what gets taught tonight**, bounded, and never
outranking what the learner or the ledger has actually said.

The deadline and **Your planned day** are separate facts. A learner can move
their planned day or remove it entirely when the week changes; removing that
promise keeps the work and its deadline and writes no award or penalty.
Open work planned for the learner's current day or an earlier day is promoted
on Today with an explicit planned-day reason; a future plan does not create
false urgency. That bounded promise can outrank generic material or recall, but
never a prepared non-revision lesson or a blocking question, and it never hides
the separate deadline reason. Following an exact Today action into Plan focuses
and marks the matching card; the link-repair action instead leaves focus in its
editor.
Date-only obligations remain learner-local calendar dates. When a source or
learner states a time, Virgil keeps the original wall time and IANA zone beside
the resolved instant, displays all three honestly, and uses the exact instant
for late/on-time rather than replacing 17:00 with an invented 23:59.

A weekly class can be added as a bounded series of 2–20 visible dates. Virgil
shows every date before saving, keeps each occurrence as ordinary Plan work,
and asks whether a deadline change applies only here or to this and the open
dates after it. Completed dates, earned awards and separately planned days are
never rewritten by a series edit or stop.

The extension has been installed in an ordinary Chrome profile and used, which
is a different thing from being loaded by a probe and is where most of the
recent defects came from. Nine scripts drive a real browser or a real service
for the questions that cannot be answered from node:
`scripts/shoot.mjs` (any surface, any width, either theme, storage seeded),
`scripts/probe-auth.mjs` (two emulator identities, two boards, and the boundary
between them),
`scripts/probe-selection.mjs` (CDP, selection recovery and CSP),
`scripts/probe-surfaces.mjs` (the page and the panel as distinct surfaces),
`scripts/probe-guide.mjs` (guide refusals, and how much of a step is lifted
from the passage), `scripts/probe-live-context.mjs` (whether a foreground
answer is pitched at the register the board has earned, without waiting for a
batch), `scripts/probe-menu.mjs` (whether Chrome actually **took** every context
menu item — `contextMenus.create` reports its refusals through a `lastError`
callback nothing was reading, so an item Chrome rejects is absent from the menu
and silent everywhere else), `scripts/probe-popup.mjs` (the toolbar button's own
surface, and whether pressing *Pick what to pin* reaches the worker) and
`scripts/probe-handoff.mjs` (§5d end to end: a real session, a **signed-out**
throwaway profile, the clipboard, the file, and the tab that opens at Gemini
Notebook).

Four of the five ways in have now been used by a person rather than by a
probe. The Selector has not — though it is at last *reachable*: it was declared
`contexts: ['page']`, and Chrome drops the page context the moment there is a
selection, so it was invisible to anybody who had already highlighted something.

The **hand-off to Google Notebook** has been walked by a probe and not by a
person. It works: sources copied, file offered, and a tab that opens at
`notebook.google.com` and follows its own redirect to a Google sign-in page —
which is exactly why the label reads *opens* and never *sends*. Walking it
found the seam handing over a reserved-TLD fixture url no fetcher can resolve,
so it now marks the sources **Virgil itself could not read from outside the
browser**: the same position Notebook's fetcher is in. Nothing is dropped from
the paste and nothing claims to know what a partner's fetcher can reach.

The seam has now been exercised at all five of its interfaces, and each one is
a different distance along:

- **Gemini** — the adapter is built and its transport is proven against the real
  API: pinned model ids on both tiers, never aliases, contract fixtures recorded
  from real responses rather than invented. It is what the benchmark harness
  runs on, and since the declaration commit it is what both composition roots
  build when `SB_LLM` names it — which `deploy/job.yaml` and
  `deploy/service.yaml` do. **A night has now been composed through it in
  production**: the deployed Job ran a batch in 121.4s against Firestore,
  compose taking 29.8s for two sections and verify 12.7s to report *0 deep / 2
  fast — all sections clear*, and the card it left reads `ready |
  Evidence-Based Learning Techniques | 2 min`. Every call was carried by the
  free arm of the key ladder with the paid key untouched.
- **ADK** — a workspace under `adk/` runs all eleven stages under ADK's own
  Runner, offline, with zero network. `@google/adk` is a declared dependency —
  603 packages, and the job image goes 161 MB to 500 MB — because
  `deploy/job.yaml` sets `SB_ORCHESTRATOR=adk` and the deployed night hosts
  itself in it. `HostedNightly` hands the deployed entrypoint the real eleven
  stage bodies; an integration test drives those bodies with ADK's Runner and
  proves the resulting session and persistence, without a network call. In the
  cloud the Job logged the pipeline as it then stood, ten stages, under `host
  adk (SequentialAgent)`, execution `virgil-nightly-w7kxl`.
- **Firestore** — a Store adapter held to the same `store-contract.ts` the local
  stores are held to, against a real Firestore process, and now against the
  `(default)` database in `nam5`. Sessions are named by night. Security rules
  are `deploy/firestore.rules`, which denies every client read and write — there
  is no client-SDK path in this product, and the adapter runs server-side under
  a service account, which bypasses rules.
- **Pub/Sub** — a separate `trigger/` workspace with message schema, night key,
  redelivery guard and ack policy, proven against a real broker. It is retained
  as a transport design and is not shipped in either runtime image. Production
  dispatch is the service's Cloud Run Jobs API call; no deploy script publishes
  a message the Job cannot consume.
- **Cloud Run** — two container targets, config as code, and scripts that refuse
  to create anything without `VIRGIL_DEPLOY=yes`. Both targets are deployed from
  digest-pinned distroless images in Artifact Registry, with every secret
  arriving by `secretKeyRef` and none of them in a layer. The next rollout
  applies the Job and its execution-with-overrides permission before the service
  revision that depends on them.

**What is still unproved is named rather than left out.** The paid arm of the
key ladder has no fuel: it reaches Google and Google answers 429, because the
Gemini API bills that account in prepaid mode and the hackathon credit is a
different pool — every cloud result above was carried by the free arm. Nobody
has funded or exercised that paid fallback. The managed Drive path has now been
observed rewriting the three stable source documents and Google Notebook has
visibly re-read the updated Learn-now source; Virgil still has no authority to
read Notebook's generated guide or chat back into the learner board.
`deploy/CLOUD_RUN.md` keeps the platform proof ledger and
`docs/GOOGLE_BACKEND.md` is the concise current operations map.

What is proven, what is assumed and where to start are kept in the project
record, which is not part of this repository.

## License

Copyright 2026 Benji Hart. Licensed under the
[Apache License 2.0](../LICENSE).
