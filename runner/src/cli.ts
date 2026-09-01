import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  systemClock, partitionStrategyFrom, planBatch, dayKeyFor, receiptLine, workCapFrom,
  allWritten, type Deps, type NotebookExport,
} from '@sb/core';
import {
  CliEndpointLlm, FirestoreStore, GeminiLlm, KeyLadderLlm, OllamaLlm, OllamaEmbedder,
  TfIdfEmbedder, JsonStore, LocalResearch, LocalNotebookExport, DriveNotebookExport,
  VertexCredential, VERTEX_GEMINI_TIERS, vertexModelEndpoint,
} from '@sb/adapters';
import {
  NIGHTLY_STAGES, adkConfigFromEnv, hostFactoryFor,
  type OrchestrationHost,
} from '@sb/adk';
import { loadSeed } from './seed/load.js';
import { matchTopics, loadHistory } from './seed/history.js';
import { runBatch } from './pipeline.js';
import { HostedNightly } from './hosted-nightly.js';
import { UsageMeter, meterLlm, meterEmbedder, formatUsage } from './usage.js';
import {
  ModelBudgetLedger, ModelBudgetStop, budgetedLlm, firePaidGateInScope,
  operatorModelBudgetFrom, operatorModelBudgetWindowFrom, withBudgetScope,
} from './model-budget.js';
import { LocalConnectorLlm } from './local-model-connector.js';
import { isLocalConnectorStore } from '@sb/core';
import { LocalDriveCredential } from './drive-credentials.js';
import { DriveTokens } from './drive-oauth.js';
import { notebookDestination } from './notebook-targets.js';
import { managedDriveGrant, managedDriveIds, type ManagedDriveGrant } from './managed-drive.js';
import { exportNotebook } from './notebook-export.js';
import {
  EXIT_CONFIG, EXIT_INFRA, LlmSpecError, MEMORY_BOARD_PATH, OrchestratorSpecError, StoreSpecError,
  exitCodeFor, firestoreWiring, llmChoice, memoryFs, orchestratorChoice, outcomeOf, storeChoice,
  type FirestoreWiring, type LlmChoice, type OrchestratorChoice, type StoreChoice,
} from './runtime.js';
import {
  DEFAULT_CLI_MODEL_ENDPOINT, DEFAULT_LOCAL_MODEL_ENDPOINT, ModelRouter,
  type ModelMode,
} from './model-routing.js';
import { LocalCloudCredential } from './model-credentials.js';
import { hostedBatchKey, hostedReceiptId } from './cloud-run-job.js';
import { markHostedFailureOnFinalAttempt, markHostedProcessing } from './hosted-processing.js';

const DB = process.env.SB_DB ?? '.data/store.json';

/**
 * Which store this run was pointed at, and whether it is allowed to open it.
 *
 * Resolved before anything else because a spec this build cannot open is a
 * decision somebody got wrong in a YAML file, not a night that failed. It exits
 * `EXIT_CONFIG` and says which variable, because a Cloud Run Job that fails this
 * way will fail its retries identically and the fix is not in this repository.
 *
 * The authorisation is settled *here*, in the same breath as the spec, and not
 * left to the adapter's own lazy check. The adapter refuses correctly and it
 * refuses late: it connects on first access, so an unauthorised Job would clear
 * startup, begin a night, and fail partway through it — at 3am, with an exit
 * code that says "retry me" about a condition no retry can change.
 */
let choice: StoreChoice;
let firestore: FirestoreWiring | null = null;
/**
 * And which host sequences the night, asked in the same breath and for the same
 * reason: a host this build cannot run is a decision somebody got wrong in a
 * YAML file, not a night that failed. `deploy/job.yaml` is where it is named.
 */
let orchestrator: OrchestratorChoice;
/**
 * And which provider answers. Asked here for the third time and for the third
 * identical reason: a spec this build cannot reach is a YAML file somebody got
 * wrong, and it must not be discovered at the first model call of the night.
 */
let model: LlmChoice;
let managedNotebookDrive: ManagedDriveGrant | null;
const notebookExportDisabled = process.argv.includes('--disable-notebook-export');
try {
  choice = storeChoice(process.env.SB_STORE, DB);
  if (choice.kind === 'firestore') firestore = firestoreWiring(choice, process.env);
  orchestrator = orchestratorChoice(process.env.SB_ORCHESTRATOR);
  model = llmChoice(process.env.SB_LLM);
  managedNotebookDrive = notebookExportDisabled
    ? null : managedDriveGrant(process.env.SB_NOTEBOOK_DRIVE_CREDENTIAL);
} catch (err) {
  const known = err instanceof StoreSpecError || err instanceof OrchestratorSpecError
    || err instanceof LlmSpecError;
  console.error(known ? (err as Error).message : String(err));
  process.exit(EXIT_CONFIG);
}

const cmd = process.argv[2];

/**
 * `seed` starts with `deleteEverything()`. That is useful for a disposable
 * local demo and categorically unsafe as an incidental capability of a
 * production Job image. Pointing at Firestore already requires the broad
 * `VIRGIL_ALLOW_PRODUCTION=yes` network opt-in; deleting that remote board is a
 * separate decision and therefore needs a separate, command-specific opt-in.
 *
 * This guard runs before the Firestore client or any model credential is
 * opened. A manually overridden Cloud Run Job therefore exits as configuration
 * failure without touching the board, even though the image still contains the
 * local fixture command.
 */
if (cmd === 'seed' && choice.kind === 'firestore'
    && process.env.VIRGIL_ALLOW_REMOTE_SEED?.trim() !== 'yes') {
  console.error(
    'Refusing to seed a Firestore board. seed deletes the selected board first; '
    + 'run it only for an intentional disposable fixture with VIRGIL_ALLOW_REMOTE_SEED=yes.',
  );
  process.exit(EXIT_CONFIG);
}

/**
 * Exit with a code, without losing the last thing that was printed.
 *
 * `process.exit()` does not wait for a pending write, and in a container
 * stdout is a **pipe** rather than a terminal — which is exactly the case where
 * a write can still be buffered. The last line this command prints is
 * `batch-outcome`, and the second-to-last is the usage record the cost model is
 * built from, so truncating them loses the two things a run is read for.
 *
 * So the code is set and the process is allowed to end on its own, which
 * flushes. The unref'd timer is the other half: a Cloud Run Job that does not
 * exit burns its entire timeout and is then recorded as a failure, so a socket
 * an adapter left open must not be able to hold the run open. An unref'd timer
 * does not keep the loop alive, and does fire if something else has.
 */
function finish(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 250).unref();
}

/**
 * The store, built here.
 *
 * Duplicated from `service.ts` rather than shared, and deliberately:
 * `seam-purity.test.ts` holds that `new JsonStore(...)` appears in exactly the
 * two composition roots. A shared factory would be a third place the port has
 * to find, which is the thing that guard is counting.
 */
async function openStore(): Promise<Deps['store']> {
  if (choice.kind === 'memory') return new JsonStore(MEMORY_BOARD_PATH, memoryFs());
  if (choice.kind === 'json') return new JsonStore(choice.path);
  /**
   * The adapter is named directly now, and the branch that used to stand here is
   * gone rather than unreached.
   *
   * It read the barrel through a dynamic import, found no `FirestoreStore`, and
   * exited 2 with "this build has no Firestore store" — a retired placeholder.
   * Every firestore spec answered there, which meant the production store was
   * unreachable in any deployed process and the authorisation gate above had
   * never once been reached in one. Keeping a dead branch for it would leave a
   * reader thinking the build might still be missing something it now declares,
   * locks and ships.
   *
   * `firestore` is non-null here by construction: it is set in the same `try`
   * that produced this `choice`, from the same `choice`. The assertion is the
   * compiler's, not a runtime check pretending to be one.
   */
  return new FirestoreStore(firestore as FirestoreWiring);
}

/**
 * Everything a run writes lives beside the store that run was pointed at.
 *
 * The seed pin order is a property of the board that was seeded, not of the
 * default directory. This was hardcoded to `.data/`, so an isolated run
 * (`SB_DB=.data-adversarial/store.json ... seed`) overwrote the DEFAULT board's
 * order file and left its `history` command mapping six weeks of signals onto
 * pin ids from somebody else's board — a silent cross-board write with nothing
 * in the output to suggest it happened.
 *
 * Derived from `dirname(DB)` exactly the way the usage artefact below is, so
 * there is one rule for where a run's files go rather than two.
 */
const SEED_ORDER = join(dirname(DB), 'seed-pin-order.json');

// Always on. Token accounting that has to be switched on is token accounting
// that is off on the run you later wish you had measured, and counting adds
// nothing to a call that already reports its own usage.
const meter = new UsageMeter();

/**
 * `SB_PARTITION` chooses the partition rule. Nothing, or anything unrecognised,
 * is `d1` — the two-space rule in `core/`'s `domain/partition-d1.ts`, made the
 * default on 2026-08-20 (the D1 partition default). `SB_PARTITION=single` is the way back to
 * the rule that shipped first, byte-identical to what it always was, and it is
 * kept reachable so the two can still be run against one board.
 *
 * The evidence and the standing caution are both in `domain/partition-d1.ts`:
 * D1 wins the held-out mean on both corpora and by 32 points under incremental
 * arrival, and its coarse cut is a spike rather than a plateau — so the bucket
 * threshold does not move without both bake-off harnesses run again.
 *
 * Composition of the two spaces happens HERE rather than in `core/`, which
 * receives embed functions and never constructs an adapter. D1 needs both a
 * lexical space and an embedding one, so the coarse embedder is only built when
 * it is actually selected — an unused TF-IDF instance is cheap, but a dep that
 * exists for a strategy nobody chose invites a later reader to use it.
 */
const partitionStrategy = partitionStrategyFrom(process.env.SB_PARTITION);
// Threaded explicitly into every run below rather than left to the clusterer's
// wiring-shaped default: what the operator selected and what got built are two
// facts, and a run should fail loudly if they ever disagree.

// The local adapter has always defaulted to 127.0.0.1:11434, which inside a
// container is the container. Moving it is what lets the Job image be run end
// to end against a stub on the host — the only way to exercise a night that
// actually builds a session without spending real tokens on a real provider.
const localEndpoint = process.env.SB_LOCAL_ENDPOINT ?? process.env.SB_OLLAMA_HOST
  ?? DEFAULT_LOCAL_MODEL_ENDPOINT;
const cliEndpoint = process.env.SB_CLI_ENDPOINT ?? DEFAULT_CLI_MODEL_ENDPOINT;
const cliToken = process.env.SB_CLI_TOKEN ?? '';
const allowRemoteEndpoints = process.env.SB_ALLOW_REMOTE_MODEL_ENDPOINTS === '1';
const ollama = { host: localEndpoint };
const cloudCredential = await LocalCloudCredential.open({
  dbPath: choice.kind === 'json' ? choice.path : DB,
  ...(process.env.GEMINI_API_KEY === undefined ? {} : { managedKey: process.env.GEMINI_API_KEY }),
  readStored: choice.kind === 'json',
});

/**
 * The model, built here.
 *
 * Duplicated from `service.ts` for the reason `openStore` is: `seam-purity.test.ts`
 * counts the places an adapter is constructed, and a shared factory would be a
 * third one for a port to find.
 *
 * The local adapter is the `ollama` arm and the default, which is what makes
 * every existing invocation in this repository run the model it always ran.
 * `GeminiLlm` reads its own key out of the environment — deliberately, so the
 * credential has exactly one name in the process and is never passed through a
 * call chain that might log it — so nothing about a key reaches this line.
 */
const defaultMode: ModelMode = model.kind === 'ollama' ? 'local' : model.kind === 'cli' ? 'cli' : 'cloud';
/**
 * The ladder in the batch composition root has the same shape as
 * `service.ts`: `GEMINI_API_KEY_FREE` present means the free key answers
 * first and the managed key is the paid fallback behind the budget's own
 * gate. The batch is the caller that spends with nobody watching, so it is
 * the last place the ladder could be allowed to differ.
 */
const geminiWith = (apiKey: () => string): GeminiLlm => model.kind === 'gemini' && model.tiers
  ? new GeminiLlm({ tiers: model.tiers, apiKey })
  : new GeminiLlm({ apiKey });
const freeKeyValue = process.env.GEMINI_API_KEY_FREE?.trim() || null;
const ladderActive = freeKeyValue !== null;
const vertexProject = process.env.GOOGLE_CLOUD_PROJECT?.trim() ?? '';
const vertexLocation = process.env.GOOGLE_CLOUD_LOCATION?.trim() ?? '';
if (model.kind === 'vertex' && (!vertexProject || !vertexLocation)) {
  console.error('SB_LLM=vertex needs GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION');
  process.exit(EXIT_CONFIG);
}
const vertexCredential = model.kind === 'vertex' ? new VertexCredential() : null;
const paidVertex = model.kind === 'vertex' && vertexCredential
  ? new GeminiLlm({
    tiers: model.tiers ?? VERTEX_GEMINI_TIERS,
    accessToken: () => vertexCredential.token(),
    modelEndpoint: vertexModelEndpoint(vertexProject, vertexLocation),
  })
  : null;
const paidCloud = paidVertex ?? geminiWith(() => cloudCredential.value());
const cloud = ladderActive
  ? new KeyLadderLlm(
    geminiWith(() => freeKeyValue), paidCloud,
    { beforePaid: firePaidGateInScope })
  : paidCloud;
const openedStore = await openStore();
const hosted = Boolean(process.env.K_SERVICE?.trim() || process.env.CLOUD_RUN_JOB?.trim());

function buildLlm() {
  return new ModelRouter({
    store: openedStore,
    defaultMode,
    defaultLocalEndpoint: localEndpoint,
    defaultCliEndpoint: cliEndpoint,
    allowRemoteEndpoints,
    providers: {
      cloud,
      local: (endpoint) => hosted && isLocalConnectorStore(openedStore)
        ? new LocalConnectorLlm(openedStore)
        : new OllamaLlm({ host: endpoint }),
      cli: (endpoint) => new CliEndpointLlm({ endpoint, token: cliToken }),
    },
  });
}

// The learner's budget binds this process too. A kill switch the nightly
// ignores is not a kill switch: the batch is the one caller that spends with
// nobody watching. Composed the way the service composes it — the gate sits
// OUTSIDE the meter, so a stopped call is never recorded as issued (Decision
// 32 reads issued as billed).
const operatorLimitArgument = process.argv.find((arg) => arg.startsWith('--operator-limit='))
  ?.slice('--operator-limit='.length);
const operatorWindowArgument = process.argv.find((arg) => arg.startsWith('--operator-window='))
  ?.slice('--operator-window='.length);
const operatorLimit = operatorModelBudgetFrom(
  operatorLimitArgument ?? process.env.SB_OPERATOR_MODEL_BUDGET_TOKENS,
);
const operatorWindow = operatorModelBudgetWindowFrom(operatorWindowArgument);
const budgetLedger = new ModelBudgetLedger({
  store: openedStore,
  clock: systemClock,
  defaultMode,
  ...(operatorLimit != null ? { operatorLimit } : {}),
  ...(operatorWindow !== undefined ? { operatorWindow } : {}),
  onWriteError: (err) => console.error(`model-budget bookkeeping write failed: ${String(err)}`),
});

/** Keep each ladder call's stop receipt scoped to that call. */
const scoped = (llm: Deps['llm']): Deps['llm'] => !ladderActive ? llm : {
  complete: (req) => withBudgetScope(() => llm.complete(req)),
  structured: (req) => withBudgetScope(() => llm.structured(req)),
};

const deps: Deps = {
  // The standalone nightly IS a run, whole. There is no learner in front of
  // this process, so nothing here can belong to the other lane.
  llm: scoped(budgetedLlm(meterLlm(buildLlm(), meter, 'runs'), budgetLedger)),
  // `SB_EMBEDDER=tfidf` runs the whole board with no embedding model at all.
  // Worth keeping switchable rather than automatic: silently falling back to a
  // weaker space would move every cut point without saying so, and the two
  // spaces are not comparable — vectors from one must never meet the other.
  embedder: meterEmbedder(
    process.env.SB_EMBEDDER === 'tfidf' ? new TfIdfEmbedder() : new OllamaEmbedder(ollama),
    meter, 'runs'),
  // Metered like the fine space: TF-IDF costs no tokens, but a run should still
  // be able to show that a second space was built and over how much text.
  ...(partitionStrategy === 'd1'
    ? { coarseEmbedder: meterEmbedder(new TfIdfEmbedder(), meter, 'runs') }
    : {}),
  store: openedStore,
  research: new LocalResearch(),
  clock: systemClock,
};

/** One destination constructor shared by the nightly and the no-model proof command. */
async function configuredNotebookExport(): Promise<NotebookExport | null> {
  if (notebookExportDisabled) return null;
  const notebookDir = process.env.SB_NOTEBOOK_DIR?.trim();
  const localNotebook = notebookDir
    ? new LocalNotebookExport({ directory: notebookDir, clock: deps.clock })
    : null;
  const localDrive = !managedNotebookDrive
    && process.env.SB_NOTEBOOK_DRIVE?.trim() === '1' && choice.kind === 'json'
    ? await LocalDriveCredential.open({ dbPath: choice.path })
    : null;
  const driveTokens = managedNotebookDrive || localDrive
    ? new DriveTokens({
      client: () => managedNotebookDrive?.client ?? localDrive?.client() ?? null,
      refreshToken: () => managedNotebookDrive?.refreshToken ?? localDrive?.refreshToken() ?? '',
      clock: deps.clock,
    })
    : null;
  const ids = managedNotebookDrive
    ? managedDriveIds(deps.store, managedNotebookDrive.account, () => deps.clock.now())
    : localDrive
      ? { read: () => localDrive.readIds(), write: (next: Parameters<typeof localDrive.writeIds>[0]) => localDrive.writeIds(next) }
      : null;
  return localNotebook || driveTokens
    ? notebookDestination({
      local: localNotebook,
      drive: () => (driveTokens && ids && (managedNotebookDrive || localDrive?.connected())
        ? new DriveNotebookExport({ auth: driveTokens, ids, clock: deps.clock })
        : null),
    })
    : null;
}

if (cmd === 'seed') {
  await deps.store.deleteEverything();
  const pins = await loadSeed(deps.store, deps.clock);
  console.log(`seeded ${pins.length} pins — no topics, no enrichment; the fleet earns those`);
  // `history` is a local demo-layering tool and its order receipt belongs
  // beside a file-backed board. A Firestore or memory seed has no local board
  // directory; trying to write `.data/seed-pin-order.json` after the remote
  // writes have landed makes a successful hosted seed exit 1 and invites a
  // destructive platform retry over the same new board.
  if (choice.kind === 'json') {
    writeFileSync(SEED_ORDER, JSON.stringify(pins.map((p) => p.id)));
    console.log(`  pin order written to ${SEED_ORDER}`);
  } else {
    console.log('  pin order is a file-backed demo receipt, so none was written for this store');
  }

} else if (cmd === 'history') {
  if (choice.kind !== 'json') {
    console.error('history is a file-backed demo tool; use a json:<path> store seeded beside its receipt');
    finish(EXIT_CONFIG);
  } else {
    // Layered after clustering so the mapping targets emergent topics, not ours.
    const order = JSON.parse(readFileSync(SEED_ORDER, 'utf8'));
    const mapping = matchTopics(await deps.store.listTopics(), order);
    const n = await loadHistory(deps.store, deps.clock, mapping);
    console.log(`layered ${n} signals across ${mapping.size} matched topics`);
    for (const [key, id] of mapping) {
      const t = await deps.store.getTopic(id);
      console.log(`  ${key.padEnd(22)} -> "${t?.label ?? '?'}"`);
    }
  }

} else if (cmd === 'notebook') {
  const destination = await configuredNotebookExport();
  if (!destination) {
    console.error('Google Notebook export is not configured.');
    finish(EXIT_CONFIG);
  } else {
    const receipt = await exportNotebook(deps.store, deps.clock, destination);
    console.log(receiptLine(receipt));
    finish(allWritten(receipt) ? 0 : EXIT_INFRA);
  }

} else if (cmd === 'nightly' || cmd === 'process') {
  /**
   * Run only when the board has work due.
   *
   * `--if-due` used to mean "ask the clock". There is no clock. It now means
   * "run only if there is a reason", and the reason is material or a person:
   * `domain/batch.ts` answers it out of arithmetic over the store, with no
   * model call anywhere on the path.
   *
   * `nightly` is kept as a name so nothing that invokes it breaks, and
   * `process` is what it is called now.
   */
  const prefs = await deps.store.getPrefs();
  const pins = await deps.store.listPins();
  const unprocessed = pins.filter((p) => !p.topicId).length;
  const pausedUntil = prefs.pausedUntil;
  const decision = planBatch({
    unprocessedPins: unprocessed,
    // Counted rather than derived from a run: the Gardener is arithmetic, and
    // the point of this whole path is that asking costs nothing.
    dueForRevision: 0,
    paused: typeof pausedUntil === 'string' && Date.parse(pausedUntil) > deps.clock.now().getTime(),
    autoAfter: prefs.autoAfter ?? null,
    asked: !process.argv.includes('--if-due'),
  });
  // A hosted service decides the learner's day before it dispatches the Job.
  // The execution may not start until after midnight, so recomputing here
  // could put one accepted run on a different day. Unset preserves every local
  // and scheduled invocation that predates the durable dispatch path.
  let requestedBatchKey: string | null = null;
  let requestedReceiptId: string | null = null;
  try {
    requestedBatchKey = hostedBatchKey(process.env.SB_BATCH_KEY);
    requestedReceiptId = hostedReceiptId(process.env.SB_RUN_RECEIPT_ID);
    if (Boolean(requestedBatchKey) !== Boolean(requestedReceiptId)) {
      throw new Error('SB_BATCH_KEY and SB_RUN_RECEIPT_ID must be supplied together');
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(EXIT_CONFIG);
  }
  const dayKey = requestedBatchKey ?? dayKeyFor(deps.clock.now(), 'UTC');
  if (requestedReceiptId) {
    const claim = await markHostedProcessing(deps.store, requestedReceiptId, 'running');
    if (claim === 'stale') {
      console.log(`not running: hosted dispatch ${requestedReceiptId} is no longer active`);
      console.log('batch-outcome stale-dispatch');
      process.exit(0);
    }
  }
  if (!decision.run) {
    if (requestedReceiptId) {
      await markHostedProcessing(deps.store, requestedReceiptId, 'finished', new Date(), {
        outcome: null, outcomeReason: null, reports: [], remaining: 0, withheld: 0,
      });
    }
    console.log(`not running: ${decision.because} (${unprocessed} unprocessed, their day ${dayKey})`);
    console.log('batch-outcome not-due');
    process.exit(0);
  }

  const t0 = Date.now();
  const startedAt = new Date().toISOString();

  /**
   * The one place a night can fail as infrastructure rather than as a night.
   *
   * `runBatch` is failure-tolerant stage by stage — that is the design, and
   * it is why a degraded night still exits 0. What it does not survive is the
   * board being unreachable: a store that will not read, or will not be written
   * back. That is the case a Cloud Run Job retry can actually fix, so it is the
   * case that reports failure. Everything else the fleet does with a bad night
   * is already a decision the fleet made on purpose.
   */
  /**
   * The night, run inside an orchestration host.
   *
   * **The orchestration dependency boundary's commit.** `SB_ORCHESTRATOR` picks the host and `deploy/job.yaml`
   * sets it to `adk`, so the deployed Job's night genuinely runs inside Google's
   * `SequentialAgent`, driven by ADK's own `Runner` — while the entrypoint stays
   * Virgil's own Node process rather than `adk deploy cloud_run`, which builds an
   * Express service and has no Cloud Run Jobs target at all (`adk/DESIGN.md` §5a).
   * Unset is `local`, which is the same sequencing rules with no framework under
   * them, so a laptop runs exactly the night it always ran.
   *
   * The host is handed all nine real stage bodies. `HostedNightly` is the
   * rendezvous: the stateful pipeline yields each body, the matching framework
   * child executes it, and the host's report releases the next stage. Prompts,
   * state transitions and persistence remain owned by the same pipeline.
   *
   * `runBatch` is failure-tolerant stage by stage — that is the design, and it
   * is why a degraded night still exits 0. What it does not survive is the board
   * being unreachable, and that is the case a Cloud Run Job retry can actually
   * fix. The host catches rather than propagates (a `SequentialAgent` that threw
   * would take every report with it), so the throw is captured on the way past
   * and the same EXIT_INFRA path runs on the far side of it.
   */
  const notebookExport = await configuredNotebookExport();

  /**
   * How much of the queue one run may work through.
   *
   * `SB_WORK_CAP` unset is `DEFAULT_WORK_CAP`, and `SB_WORK_CAP=0` is no cap at
   * all — which is a thing an operator can genuinely want on a machine with no
   * metered provider behind it, and is spelled as a number rather than as a
   * word so that the same variable answers both questions. `workCapFrom` raises
   * anything below the floor and treats an unreadable value as the default: a
   * typo in a YAML file must not stop a night, and it must not silently remove
   * the protection either.
   */
  const nightly = new HostedNightly(deps, NIGHTLY_STAGES, {
    concurrency: Number(process.env.SB_CONCURRENCY ?? 3),
    usage: meter,
    partitionStrategy,
    workCap: workCapFrom(process.env.SB_WORK_CAP),
    ...(notebookExport ? { notebook: notebookExport } : {}),
  });

  let host: OrchestrationHost;
  try {
    host = await (await hostFactoryFor(orchestrator.kind))(nightly.works, adkConfigFromEnv(process.env));
  } catch (err) {
    // A host that cannot be built has not run a night, and a retry will fail
    // identically: since the declaration commit `@google/adk` is a real
    // dependency, so its absence is an incomplete install rather than a decision
    // nobody made.
    console.error(`the ${orchestrator.kind} orchestration host could not be built: ${String(err)}`);
    if (requestedReceiptId) {
      await markHostedFailureOnFinalAttempt(
        deps.store, requestedReceiptId, process.env,
      ).catch((writeError) => {
        console.error(`the hosted failure receipt could not be written: ${String(writeError)}`);
      });
    }
    process.exit(EXIT_CONFIG);
  }
  // Read off the built tree rather than recited, which is the whole reason
  // `describe()` exists: this line cannot claim a primitive the code did not
  // construct.
  console.log(`  host ${host.framework} (${host.describe().primitive})`);
  nightly.start();
  await host.run({
    onStage: (r) => {
      nightly.accept(r);
      console.log(`  ${r.failed ? '!' : ' '} ${r.stage.padEnd(10)} ${String((r.ms / 1000).toFixed(1)).padStart(6)}s  ${r.detail}`);
    },
  });

  let result: Awaited<ReturnType<typeof runBatch>>;
  try {
    result = await nightly.result();
  } catch (err) {
    if (err instanceof ModelBudgetStop) {
      // Not a failure: the learner's own limit did exactly what it says. The
      // fix is theirs (raise it or reset the window), so this is config-class,
      // not infra-class, and no stack trace is owed.
      console.error(`\n${err.message}`);
      console.log('batch-outcome budget-stopped');
      if (requestedReceiptId) {
        await markHostedProcessing(deps.store, requestedReceiptId, 'finished', new Date(), {
          outcome: 'quota-degraded', outcomeReason: null, reports: [],
          remaining: unprocessed, withheld: 0,
        });
        // The worker handled the learner's refusal and published its recovery
        // truth. A platform retry cannot repair a budget decision and would
        // only repeat model work that already stopped correctly.
        process.exit(0);
      }
      process.exit(EXIT_CONFIG);
    }
    console.error(`\nnightly FAILED — the run could not be completed: ${String(err)}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    if (requestedReceiptId) {
      await markHostedFailureOnFinalAttempt(
        deps.store, requestedReceiptId, process.env,
      ).catch((writeError) => {
        console.error(`the hosted failure receipt could not be written: ${String(writeError)}`);
      });
    }
    process.exit(EXIT_INFRA);
  }

  const degraded = result.reports.filter((r) => r.failed);
  // Reported on its own line, never added to the degraded-stage count. The
  // verify stage completed; what failed was the check on individual sections,
  // and a run that says "1 stage degraded" invites the reader to look at a
  // stage that ran fine.
  const unverified = result.withheld.filter((w) => w.reason === 'unverified');
  // `outcome === 'composed'` rather than `!insufficient`: a night the model
  // emptied is not a session, and the run summary is the first place anyone
  // reads that (the three-state batch-result contract).
  const built = Boolean(result.session?.outcome === 'composed' && result.session.sections.length);
  console.log(`\nnightly complete in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`
    + (degraded.length ? ` — ${degraded.length} stage(s) degraded` : '')
    + (built ? (degraded.length ? ', session still built' : '')
             : ' — NO SESSION BUILT'));
  if (unverified.length) {
    console.log(`  ${unverified.length} section(s) UNVERIFIED — the check did not run, so they were not shipped;`
      + ' their topics stay in the pool for tomorrow');
  }
  /**
   * What this night deliberately left, said once and in one place.
   *
   * The stage lines already carry it per stage; this is the number somebody
   * reading a Cloud Logging entry six weeks later needs, and it is the
   * difference between *"the semester is in"* and *"the semester is coming in"*.
   * Printed only when there is something to say, because a night that finished
   * the pile does not need a line about the pile.
   */
  if (result.remaining > 0) {
    console.log(`  ${result.remaining} item(s) still queued — the cap is ${workCapFrom(process.env.SB_WORK_CAP) ?? 'off'}`
      + ' per run, and the next run picks them up where this one stopped');
  }

  // The cost model is built from these numbers and from published per-token
  // prices, never from the durations above — a local wall clock measures this
  // machine, not the provider that will actually be billed.
  const usage = meter.report(startedAt);
  console.log(`\n${formatUsage(usage)}`);
  /**
   * The artefact goes beside the board it was measured on — when there is a
   * board to put it beside.
   *
   * A container has no durable disk, so in a Cloud Run Job this file would be
   * written to a layer that vanishes with the task and the cost model would
   * lose exactly the runs it most wants: the ones that ran unattended. So the
   * numbers go to stdout as one JSON line in every environment, which is what
   * Cloud Logging captures, and the file is written only where a file survives.
   */
  console.log(`usage-json ${JSON.stringify(usage)}`);
  if (choice.kind === 'json') {
    const usagePath = join(dirname(choice.path), `usage-${startedAt.replace(/[:.]/g, '-')}.json`);
    writeFileSync(usagePath, `${JSON.stringify(usage, null, 2)}\n`);
    console.log(`  written to ${usagePath}`);
  }

  for (const w of result.withheld) {
    console.log(`\n  WITHHELD (${w.reason}): ${w.heading}`);
    if (w.reason === 'unverified') console.log(`    the verifier call failed — ${w.error ?? 'no detail'}`);
    for (const d of w.defects) {
      console.log(`    [${d.kind}] ${d.problem}`);
      console.log(`      rejected: "${d.quote}"`);
    }
  }
  if (result.session?.outcome === 'composed') {
    console.log(`\nSession ready — ${result.session.sections.length} sections, ~${Math.round(result.session.estimatedMinutes)} min`);
    for (const s of result.session.sections) {
      console.log(`  [${s.depth}] ${s.heading}  (~${s.estimatedMinutes.toFixed(1)}min${s.mediumWarning ? ', MEDIUM WARNING' : ''})`);
    }
  }

  /**
   * The exit code, which is the whole of what a Cloud Run Job retry reads.
   *
   * The README's standing sentence still holds and is the point rather than a
   * survival: *a zero exit code from this command is not evidence that a
   * session exists.* A night with nothing to teach and a night the model
   * misaddressed are runs that happened and were reported honestly, and a
   * non-zero exit on either would ask the platform to spend the fleet's model
   * calls re-deriving the same true answer. Only a run that could not be
   * completed reports failure, because that is the only one a retry can fix.
   */
  // Reported on its own line and never folded into the outcome. The night is
  // judged on whether it could be completed; a folder that would not take a
  // file is a real problem and is not one a Cloud Run Job retry can fix by
  // running nine model stages again.
  if (result.notebook) console.log(`\n${receiptLine(result.notebook)}`);

  const outcome = outcomeOf(result);
  console.log(`batch-outcome ${outcome.kind}${'reason' in outcome ? `:${outcome.reason}` : ''}`);
  if (requestedReceiptId) {
    await markHostedProcessing(deps.store, requestedReceiptId, 'finished', new Date(), {
      outcome: outcome.kind === 'session' || outcome.kind === 'no-session'
        || outcome.kind === 'quota-degraded' ? outcome.kind : null,
      outcomeReason: outcome.kind === 'no-session' ? outcome.reason : null,
      reports: result.reports.map((report) => ({
        stage: report.stage, ms: report.ms, failed: report.failed,
        ...(report.degradeReason === undefined ? {} : { degradeReason: report.degradeReason }),
      })),
      remaining: result.remaining,
      withheld: result.withheld.length,
      lean: result.lean,
    });
  }
  finish(exitCodeFor(outcome));

} else {
  console.log('usage: cli.js seed | nightly | process | notebook | history');
  finish(EXIT_CONFIG);
}
