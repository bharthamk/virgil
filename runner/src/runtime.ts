/**
 * The container contract, as decisions rather than as a Dockerfile.
 *
 * Cloud Run asks a container for four things this repository can answer on a
 * machine with no GCP project: bind the interface the platform routes to, name
 * the store the image was pointed at, exit with a code that means what the
 * platform thinks it means, and stop when told to stop. Every one of those is a
 * pure function here, which is why `deploy/` can be prepared and checked before
 * a project exists — what genuinely needs Google is IAM, scheduling and the
 * network, and none of those are decisions this code makes.
 *
 * **No adapter is constructed in this file.** `seam-purity.test.ts` holds the
 * line that a store adapter is built in the two composition roots and nowhere
 * else, and that guard is not edited to make room for a third. So this file
 * decides *which* store and the roots build it — `storeChoice` returns a
 * description, never an instance.
 *
 * That guard reads this file's source without stripping its comments, so the
 * constructor call it looks for cannot be written here even as prose. Naming it
 * would fail the check as though the call were real, which is a false positive
 * worth knowing about and not worth editing the guard to remove.
 *
 * Sources for every platform constant are in `deploy/CLOUD_RUN.md` §2.
 */

// ---------------------------------------------------------------------------
// Which interface to bind
// ---------------------------------------------------------------------------

export const LOOPBACK = '127.0.0.1';
export const EVERY_INTERFACE = '0.0.0.0';

/**
 * The address the service listens on.
 *
 * Cloud Run's container contract is explicit: *"The ingress container within an
 * instance must listen for requests on `0.0.0.0` on the port to which requests
 * are sent."* A container that binds loopback inside a Cloud Run instance
 * accepts nothing, and the symptom is a startup-probe timeout rather than
 * anything naming the bind address — which is why this is a function with a
 * test rather than a literal in `main()`.
 *
 * The widening is conditional, and deliberately so. This service has no
 * authentication of any kind, and `DELETE /everything` is one of its routes;
 * binding every interface on a laptop publishes the learner's whole board to
 * the local network. So the default stays loopback everywhere except the one
 * place that both requires the widening and puts an IAM boundary in front of
 * it.
 *
 * `K_SERVICE` is the marker rather than `PORT`, because `PORT` is a variable
 * anybody might set for any reason and `K_SERVICE` is set by the platform to
 * the name of the running service. An explicit `SB_HOST` overrides both, so
 * neither guess is a trap.
 */
export function bindHost(explicit: string | undefined, kService: string | undefined): string {
  // An empty or blank value is what an env block with `SB_HOST:` and no value
  // produces. It is not a host, and binding to '' is not the same as not
  // setting it.
  const named = explicit?.trim();
  if (named) return named;
  return kService?.trim() ? EVERY_INTERFACE : LOOPBACK;
}

/**
 * Whether to spend a model call warming the fast tier at boot.
 *
 * The warm-up is measured and worth it on a laptop: the first pin after boot
 * cost 2135ms against a 1500ms toast budget, purely from loading the model. In
 * Cloud Run it inverts. With `min-instances: 0` every cold start would spend one
 * model call before serving anything, on a free tier of twenty calls a day, and
 * an instance that scales up and is never asked for a pin has bought a call for
 * nothing.
 *
 * So the same image keeps the local behaviour and drops it where the platform
 * makes it a cost rather than a saving. Explicit `SB_WARMUP` wins either way,
 * because "warm this revision before the demo" is a real thing to want.
 */
export function warmupWanted(explicit: string | undefined, kService: string | undefined): boolean {
  const named = explicit?.trim();
  if (named) return named !== '0' && named.toLowerCase() !== 'false';
  return !kService?.trim();
}

// ---------------------------------------------------------------------------
// Who may knock on the door
// ---------------------------------------------------------------------------

/**
 * The header the service requires and the extension sends — the exposed-service authentication boundary.
 *
 * Plainly named. It is a shared secret and not an identity, and a header called
 * `authorization` would invite a reader to think a token had been verified
 * against something.
 */
export const SHARED_SECRET_HEADER = 'x-virgil-secret';

/**
 * Short enough to guess is not a secret.
 *
 * A floor rather than a shape, because at startup the only thing knowable about
 * a string is how much of it there is. Sixteen characters is well past anything
 * that could be reached by hand and well under anything a generator produces.
 */
export const SHARED_SECRET_MIN_LENGTH = 16;

export class SharedSecretError extends Error {}

/**
 * The secret this process will require, or `null` for a door that is not there.
 *
 * **Keyed on the bind, not on `K_SERVICE`.** The platform marker was the
 * obvious choice and it is the wrong one: `bindHost` widens for Cloud Run *and*
 * for anyone who sets `SB_HOST`, and the second case is the same exposure with
 * none of the platform's IAM in front of it. CLOUD_RUN.md S9 is explicit about
 * what is behind that door — `DELETE /everything`, `DELETE /pins/:id` and
 * `PUT /model/:id` — so the rule is the honest one: **a service that is
 * reachable from anywhere but this machine has a secret, or it does not
 * start.**
 *
 * S9 used to name a fourth item, `access-control-allow-origin: '*'` on every
 * reply, and that one is gone rather than guarded: a wildcard let any page on
 * the internet read the answers to those routes on the loopback shape that has
 * no secret at all, which is the shape almost every learner runs. `service.ts`
 * now echoes only a `chrome-extension://` or a loopback origin and sends the
 * header to nobody else.
 *
 * The refusal is at startup rather than at first request, for the same reason
 * `firestoreWiring`'s is. An instance that binds a port and then refuses
 * everything is reported healthy by the platform and reads as an outage; an
 * instance that binds a port and refuses *nothing* is worse, and is what a
 * lazily-checked secret would produce the first time somebody forgot the
 * variable.
 *
 * A verified learner identity is the public service's door. Requiring a second
 * operator secret after a Firebase token has already been verified would turn
 * account sign-in into a misleading first half of setup and leak deployment
 * vocabulary into the learner's browser. The shared secret therefore remains
 * protection for an exposed single-board service only. On loopback, or when
 * `SB_AUTH` supplies verified identity, nothing set returns `null`. Setting one
 * on loopback still rehearses the exposed single-board shape.
 */
export function sharedSecret(
  explicit: string | undefined, host: string, identityProtected = false,
): string | null {
  // Same trim as `bindHost`: an env block with `SB_SHARED_SECRET:` and no value
  // produces an empty string, which is not a secret and must not read as one.
  const named = explicit?.trim();
  if (!named) {
    if (host === LOOPBACK || identityProtected) return null;
    throw new SharedSecretError(
      `this service binds ${host} and SB_SHARED_SECRET is not set. Everything but loopback is `
      + 'reachable by something that is not this machine, and this service has no learner identity '
      + `(deploy/CLOUD_RUN.md S9). Set SB_SHARED_SECRET — at least ${SHARED_SECRET_MIN_LENGTH} `
      + `characters — and send it as the ${SHARED_SECRET_HEADER} header, bind ${LOOPBACK}, `
      + 'or configure SB_AUTH.');
  }
  if (named.length < SHARED_SECRET_MIN_LENGTH) {
    // Refused wherever it is set, including loopback. A rehearsal that accepted
    // a secret production would not is a rehearsal of something else.
    throw new SharedSecretError(
      `SB_SHARED_SECRET is ${named.length} characters and the floor is ${SHARED_SECRET_MIN_LENGTH}. `
      + 'A secret short enough to guess is not one.');
  }
  return named;
}

// ---------------------------------------------------------------------------
// Which store the image was pointed at
// ---------------------------------------------------------------------------

/** A store spec that names no store this build can open. */
export class StoreSpecError extends Error {}

/**
 * Which store, named rather than built.
 *
 * The point of the discriminated union is that one image serves every
 * environment: `memory` for a container smoke test with no disk and no
 * database, `json:` for a laptop and for the seeded board every measurement in
 * this repository was taken on, `firestore:` for production. The composition
 * root reads this and does the `new`.
 */
export type StoreChoice =
  | { readonly kind: 'json'; readonly path: string }
  | { readonly kind: 'memory' }
  /**
   * `projectId` is absent for an emulator run and present for a real one. The
   * adapter defaults it to `virgil-emulator` when it is not given, which is a
   * safe default and not a real project — so a spec that names no project can
   * only ever be an emulator spec, and `firestoreWiring` below enforces exactly
   * that rather than trusting the reader to notice.
   */
  | { readonly kind: 'firestore'; readonly boardId: string; readonly projectId?: string };

/**
 * `SB_STORE`, parsed.
 *
 * Unset is the json board at `SB_DB`, so every existing invocation in the
 * README, the scripts and the artefacts keeps working byte for byte.
 *
 * An unrecognised spec **throws**. The failure that refuses is worth naming: a
 * typo like `SB_STORE=firestor:demo` falling back to the container filesystem
 * would deploy happily, run one night onto a disk that goes away with the
 * instance, and report a green execution in the console. A store that is not
 * the store somebody asked for is not a default, it is a silent data loss.
 */
export function storeChoice(spec: string | undefined, defaultPath: string): StoreChoice {
  const raw = spec?.trim();
  if (!raw) return { kind: 'json', path: defaultPath };
  if (raw === 'memory') return { kind: 'memory' };

  const colon = raw.indexOf(':');
  const scheme = colon < 0 ? raw : raw.slice(0, colon);
  const rest = colon < 0 ? '' : raw.slice(colon + 1).trim();

  if (scheme === 'json') {
    if (!rest) throw new StoreSpecError('SB_STORE=json: names no path — use json:<path>, or unset it to use SB_DB');
    return { kind: 'json', path: rest };
  }
  if (scheme === 'firestore') {
    if (!rest) throw new StoreSpecError('SB_STORE=firestore: names no board — use firestore:<boardId>');
    /**
     * `firestore:<project>/<board>` names the project; `firestore:<board>`
     * does not.
     *
     * The slash is the whole grammar addition, and it exists because the
     * project is the difference between an emulator and a bill. A spec with no
     * project is an emulator spec and stays exactly as it was — every existing
     * invocation, every gated test, `deploy/smoke.sh`'s own line — so the
     * emulator path costs no new configuration at all.
     *
     * Split on the FIRST slash and refuse a second, rather than splitting on
     * the last or joining the remainder. A board id may legitimately contain a
     * `/` — `docId()` escapes one — so a two-slash spec is genuinely ambiguous
     * about which half is the project, and guessing would put a night on the
     * wrong board with nothing to show for it. Such a board cannot be named in
     * a production spec, and that is a stated limit rather than a silent one.
     */
    const slash = rest.indexOf('/');
    if (slash < 0) return { kind: 'firestore', boardId: rest };
    const projectId = rest.slice(0, slash).trim();
    const boardId = rest.slice(slash + 1).trim();
    if (!projectId || !boardId || boardId.includes('/')) {
      throw new StoreSpecError(
        `SB_STORE=firestore:${rest} is not a project and a board. Use firestore:<projectId>/<boardId> `
        + 'for a real project, or firestore:<boardId> for the emulator. A board id containing a slash '
        + 'cannot be named in a project-qualified spec.');
    }
    return { kind: 'firestore', boardId, projectId };
  }
  throw new StoreSpecError(
    `SB_STORE=${raw} names no store this build can open. `
    + 'Known: memory, json:<path>, firestore:<boardId>, firestore:<projectId>/<boardId>');
}

// ---------------------------------------------------------------------------
// Which model answers
// ---------------------------------------------------------------------------

/** A model spec that names no provider this build can reach. */
export class LlmSpecError extends Error {}

/**
 * Which provider, named rather than built — `storeChoice`'s bargain again.
 *
 * `tiers` absent means "whatever the adapter ships", which for Gemini is
 * `GEMINI_TIERS`: both entries live-verified, both pinned rather than aliased.
 * Present means the deployment pinned its own pair in a committed file, which is
 * how a tier decision gets reviewed like code.
 */
export type LlmChoice =
  | { readonly kind: 'ollama' }
  | { readonly kind: 'gemini'; readonly tiers?: { readonly fast: string; readonly deep: string } }
  | { readonly kind: 'vertex'; readonly tiers?: { readonly fast: string; readonly deep: string } }
  | { readonly kind: 'cli' };

/**
 * `SB_LLM`, parsed.
 *
 * Cloud is the product default (`model-spec.test.ts` holds the assertion), so
 * an environment with a key routes to Gemini unless an operator names `local`
 * or `cli`. Tests, laptops, and builds cannot spend unless credentials are
 * explicitly supplied, and an unrecognised spec stops the process.
 *
 * Both directions of fallback are refused, and they fail differently. Falling
 * back to the local model would deploy happily and fail every night at the first
 * model call, with a log line about a connection to `127.0.0.1` and nothing
 * about a variable. Falling back to Gemini would spend money nobody authorised.
 *
 * `gemini:<fast>/<deep>` splits on the first slash, the same way the store spec
 * does — but unlike a board id, half a tier map is not a thing. A spec naming
 * one model would leave the other tier on a default the deployment did not
 * choose, and a cost ledger reconciled against one model while the run used two.
 */
export function llmChoice(spec: string | undefined): LlmChoice {
  const raw = spec?.trim();
  if (!raw || raw === 'cloud' || raw === 'gemini') return { kind: 'gemini' };
  if (raw === 'vertex') return { kind: 'vertex' };
  if (raw === 'local' || raw === 'ollama') return { kind: 'ollama' };
  if (raw === 'cli') return { kind: 'cli' };

  const colon = raw.indexOf(':');
  const scheme = colon < 0 ? raw : raw.slice(0, colon);
  const rest = colon < 0 ? '' : raw.slice(colon + 1).trim();

  if (scheme === 'gemini' || scheme === 'vertex') {
    if (colon < 0) return { kind: scheme };
    const parts = rest.split('/').map((p) => p.trim());
    const [fast, deep] = parts;
    if (parts.length !== 2 || !fast || !deep) {
      throw new LlmSpecError(
        `SB_LLM=${raw} is not a tier map. Use ${scheme}:<fastModel>/<deepModel> to pin both tiers, or `
        + `${scheme} on its own for the pair the adapter ships. A spec that names one model would leave `
        + 'the other tier on a default this deployment did not choose.');
    }
    return { kind: scheme, tiers: { fast, deep } };
  }
  throw new LlmSpecError(
    `SB_LLM=${raw} names no model provider this build can reach. `
    + 'Known: cloud, local, cli, gemini, vertex, ollama, '
    + 'gemini:<fastModel>/<deepModel>, vertex:<fastModel>/<deepModel>');
}

// ---------------------------------------------------------------------------
// Which host sequences the night
// ---------------------------------------------------------------------------

/** An orchestration host this build cannot run. */
export class OrchestratorSpecError extends Error {}

/**
 * Which host, named rather than built — exactly `storeChoice`'s bargain, and the
 * composition root does the `new`.
 *
 * `local` is `adk/src/host.ts`'s `LocalSequentialHost`: the sequencing rules with
 * no framework under them, and the control the whole `OrchestrationHost` contract
 * is run against. `adk` is `AdkSequentialHost`, which builds Google's own
 * `SequentialAgent` and drives it through ADK's `Runner`.
 *
 * Unset is `local`, so a laptop gains no variable and every existing invocation
 * runs the night it always ran.
 */
export type OrchestratorChoice = { readonly kind: 'local' } | { readonly kind: 'adk' };

/**
 * `SB_ORCHESTRATOR`, parsed.
 *
 * An unrecognised spec **throws**, for the reason `SB_STORE`'s does and one more
 * that is particular to this variable. A typo falling back to the framework-free
 * host would deploy happily, run every night without the framework, and report a
 * green execution — and the framework claim the deployment exists to support
 * would be false with nothing anywhere able to say so. A silent fallback here is
 * not a lost feature, it is a claim that quietly stops being true.
 */
export function orchestratorChoice(spec: string | undefined): OrchestratorChoice {
  const raw = spec?.trim();
  if (!raw) return { kind: 'local' };
  if (raw === 'local') return { kind: 'local' };
  if (raw === 'adk') return { kind: 'adk' };
  throw new OrchestratorSpecError(
    `SB_ORCHESTRATOR=${raw} names no orchestration host this build can run. Known: local, adk`);
}

// ---------------------------------------------------------------------------
// Whether this run is allowed to reach a real project
// ---------------------------------------------------------------------------

/**
 * The named opt-in that lets a store leave the emulator.
 *
 * Deliberately the same shape as `deploy/config.sh`'s `VIRGIL_DEPLOY=yes`: an
 * exact word, not a truthiness test. `=0`, `=false`, `=maybe` and an empty
 * string are all refusals, because a variable that is *set* is not a decision
 * and the failure this guards is somebody exporting something in a shell.
 */
export const PRODUCTION_OPT_IN = 'VIRGIL_ALLOW_PRODUCTION';
export const PRODUCTION_OPT_IN_VALUE = 'yes';

/** Exactly the options a composition root hands the Firestore adapter. */
export interface FirestoreWiring {
  readonly boardId: string;
  readonly projectId?: string;
  readonly allowProduction?: boolean;
}

/** The env this decision reads, and nothing else. */
export interface StoreEnv {
  readonly FIRESTORE_EMULATOR_HOST?: string | undefined;
  readonly VIRGIL_ALLOW_PRODUCTION?: string | undefined;
}

/**
 * The adapter's refusal, moved to startup.
 *
 * The adapter already refuses to open a client outside the emulator without
 * `allowProduction: true`, and that refusal is right. What was wrong is *when*
 * it arrives. The adapter connects lazily — on first access — so a Job wired
 * without the authorisation starts cleanly, runs a stage, and dies partway
 * through a night with `production-not-authorised`, at 3am, having reported a
 * non-config failure that a retry will reproduce exactly. This asks the same
 * question before any night work exists, so the answer is `EXIT_CONFIG` and the
 * log says which variable.
 *
 * The two halves both matter and they fail for different reasons:
 *
 *  - **No opt-in.** The adapter's own comment says passing `allowProduction` is
 *    a decision that *"belongs in the commit that makes it rather than in an
 *    environment variable on somebody's laptop"*. This keeps that argument and
 *    reads its emphasis honestly: what it refuses is a laptop, and the place it
 *    reserves the decision for is a commit. `deploy/job.yaml` is a committed
 *    file, reviewed like code, and the one place in the tree where the variable
 *    is set. A hard-coded `true` in these two composition roots would authorise
 *    the *build* rather than the deployment, and then the same image run on a
 *    laptop with a stray `gcloud auth` would write to the real board.
 *  - **No project.** The subtler half of the defect, and the one no error
 *    message would ever have named. The adapter defaults `projectId` to
 *    `virgil-emulator`; authorised against a real project that is a name for
 *    nothing, and the SDK's failure would be about credentials rather than
 *    about a missing variable. So authorisation without a named project is
 *    refused too — a production run says which project it means.
 */
export function firestoreWiring(
  choice: { readonly boardId: string; readonly projectId?: string | undefined },
  env: StoreEnv,
): FirestoreWiring {
  const emulator = env.FIRESTORE_EMULATOR_HOST?.trim();
  const project = choice.projectId?.trim();

  // The emulator path, unchanged and unconfigured. `FIRESTORE_EMULATOR_HOST` is
  // Google's own emulator-selection variable and cannot route a client to a
  // billed project, so its presence is the whole safety argument — the same one
  // every gated test in this tree already rests on.
  if (emulator) {
    return project ? { boardId: choice.boardId, projectId: project } : { boardId: choice.boardId };
  }

  if (env.VIRGIL_ALLOW_PRODUCTION?.trim() !== PRODUCTION_OPT_IN_VALUE) {
    throw new StoreSpecError(
      `SB_STORE names Firestore, FIRESTORE_EMULATOR_HOST is not set, and ${PRODUCTION_OPT_IN} is not `
      + `'${PRODUCTION_OPT_IN_VALUE}'. Reaching a real Google Cloud project is an explicit decision `
      + '(adapters/src/firestore-store.ts: "pass allowProduction: true and mean it"). Point at the '
      + `emulator, or set ${PRODUCTION_OPT_IN}=${PRODUCTION_OPT_IN_VALUE} in deploy/job.yaml — a `
      + 'committed file — and name the project in the spec: SB_STORE=firestore:<projectId>/<boardId>.');
  }

  if (!project) {
    throw new StoreSpecError(
      `${PRODUCTION_OPT_IN}=${PRODUCTION_OPT_IN_VALUE} authorises a real project and SB_STORE names `
      + 'none. Without one the adapter would open the client against its emulator default, which is '
      + 'not a project anybody owns. Use SB_STORE=firestore:<projectId>/<boardId>.');
  }

  return { boardId: choice.boardId, projectId: project, allowProduction: true };
}

/**
 * The four filesystem calls `JsonStore` makes, held in memory.
 *
 * This is the "stub store" a container smoke test runs against: a real
 * `JsonStore` — the same code path, the same serialisation, the same
 * temp-file-then-rename durability shape — over a map instead of a disk. It
 * proves the image boots and serves without needing either a writable volume or
 * a database, and it is the only honest way to run the service container
 * against something before Firestore exists.
 *
 * `rename` moves rather than copies, and a missing file rejects with `ENOENT`,
 * because `JsonStore.load` distinguishes those two cases and treats anything
 * else as a store it must refuse to overwrite. A stand-in that got that wrong
 * would make the smoke test pass on a store the real one would have stopped on.
 */
export interface MemoryFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  mkdir(path: string, opts: { recursive: true }): Promise<unknown>;
  rename(from: string, to: string): Promise<void>;
}

export function memoryFs(): MemoryFs {
  const files = new Map<string, string>();
  const enoent = (path: string): NodeJS.ErrnoException => {
    const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    return err;
  };
  return {
    async readFile(path) {
      const found = files.get(path);
      if (found === undefined) throw enoent(path);
      return found;
    },
    async writeFile(path, data) { files.set(path, data); },
    async mkdir() { return undefined; },
    async rename(from, to) {
      const found = files.get(from);
      if (found === undefined) throw enoent(from);
      files.set(to, found);
      files.delete(from);
    },
  };
}

/** The path a memory board is addressed by. Never touches a disk. */
export const MEMORY_BOARD_PATH = '/virgil-memory/store.json';

// ---------------------------------------------------------------------------
// What an exit code means
// ---------------------------------------------------------------------------

/**
 * The night, as the platform needs to read it.
 *
 * Deliberately the same five cases the Pub/Sub lane's ack policy reaches from
 * the other side, and for the same reason. A Cloud Run Job retry and a Pub/Sub
 * redelivery are the same event wearing different clothes, and if the two lanes
 * disagreed about which nights are worth repeating, one of them would be
 * spending the fleet's model calls to re-derive an answer the other had already
 * accepted.
 */
export type BatchOutcome =
  /** A session was built and persisted. */
  | { readonly kind: 'session' }
  /** The run completed and honestly produced nothing (the three-state batch-result and verifier-withholding contracts). */
  | { readonly kind: 'no-session'; readonly reason: 'nothing-to-teach' | 'model-failed' | 'learner-context-changed' }
  /** The provider's daily cap was spent; later seam stages were not attempted. */
  | { readonly kind: 'quota-degraded' }
  /** The run could not be completed or its result could not be persisted. */
  | { readonly kind: 'infra-failure'; readonly detail: string }
  /** The container was started with env that cannot describe a run. */
  | { readonly kind: 'config-failure'; readonly detail: string };

/**
 * The night, read off what the run actually persisted.
 *
 * Takes the shape rather than `BatchResult` itself so that the one decision
 * the exit code rests on can be asserted without building a board.
 *
 * `outcome === 'composed'` is not sufficient and the CLI's summary line already
 * knew it: a night whose every section the Verifier withheld composed something
 * and shipped nothing. The three-state batch-result contract named that third state; this reads it at the
 * exit code, where getting it wrong would report a session that does not exist.
 *
 * `quota-degraded` is now reachable, and it was not before. The quota-degradation contract's quota
 * metadata was decoded by the adapter and classified by `adk/src/errors.ts`,
 * and this comment used to say that classifier was *"wired into nothing"* —
 * `runBatch` could not report that a daily cap had been met, so a night that
 * never got to try looked exactly like a night with nothing to teach. The
 * free-tier day cap is twenty requests and a nightly is seven model calls, so
 * that is not a corner: it is what ended the deep benchmark twice.
 *
 * `runBatch` classifies each failed stage now and reports `quotaExhausted`,
 * and this reads it FIRST. A run that was not able to try must not be recorded
 * as a run that found nothing worth teaching, because the repairs are opposite:
 * one waits for tomorrow, the other looks at the board.
 */
export function outcomeOf(
  result: {
    readonly session: { readonly outcome: string; readonly sections: readonly unknown[] } | null;
    readonly quotaExhausted?: boolean;
    readonly learnerContextChanged?: boolean;
  },
): BatchOutcome {
  // Before every other reading. A night that spent the account's capacity may
  // still have composed something from the stages that ran before it did, and
  // reporting that as an ordinary session would hide the fact that the rest was
  // never attempted.
  if (result.quotaExhausted) return { kind: 'quota-degraded' };
  if (result.learnerContextChanged) {
    return { kind: 'no-session', reason: 'learner-context-changed' };
  }
  const session = result.session;
  if (session?.outcome === 'composed' && session.sections.length) return { kind: 'session' };
  if (session?.outcome === 'nothing-to-teach') return { kind: 'no-session', reason: 'nothing-to-teach' };
  return { kind: 'no-session', reason: 'model-failed' };
}

/** The night was processed. Whether it produced a session is a separate fact. */
export const EXIT_PROCESSED = 0;
/** The run could not be completed. A retry is the right response. */
export const EXIT_INFRA = 1;
/** The container cannot describe a run. A retry will fail identically. */
export const EXIT_CONFIG = 2;

/**
 * The exit code contract, which is what Job retries key on.
 *
 * Cloud Run's container contract: *"the container must exit with exit code 0
 * when the job has successfully completed, and exit with a non-zero exit code
 * when the job has failed."* The platform reads exactly that distinction —
 * zero or not — so the whole design question is which nights count as failed.
 *
 * **Failure to produce is not failure to process.** A night with nothing to
 * teach and a night the model misaddressed are both runs that happened, were
 * reported honestly, and left a store that reflects them (the three-state batch-result and verifier-withholding contracts).
 * Exiting non-zero on either would ask Cloud Run to run the fleet again to
 * arrive at the same true answer, at the same cost.
 *
 * A quota-degraded night is the sharpest case and the one most easily got
 * wrong. The quota-degradation contract specifies that a spent *daily* cap degrades
 * and is terminal for the seam rather than being retried — because
 * `...PerDay...` is not worth waiting for. A non-zero exit there hands that
 * judgement to a retry policy that knows nothing about quota, and the run
 * degrades again immediately. That recreates D10 through an unguarded retry path.
 *
 * The two non-zero codes are for whoever reads the log, not for the platform:
 * `EXIT_CONFIG` says a retry will fail identically and the fix is in the YAML.
 */
export function exitCodeFor(outcome: BatchOutcome): number {
  switch (outcome.kind) {
    case 'session':
    case 'no-session':
    case 'quota-degraded':
      return EXIT_PROCESSED;
    case 'infra-failure':
      return EXIT_INFRA;
    case 'config-failure':
      return EXIT_CONFIG;
  }
}

// ---------------------------------------------------------------------------
// Stopping when told to stop
// ---------------------------------------------------------------------------

/** The part of `http.Server` a shutdown needs, and nothing else. */
export interface Closable {
  close(cb: (err?: Error) => void): void;
  closeIdleConnections?(): void;
}

export type ShutdownResult = 'drained' | 'timed-out';

/**
 * Stop accepting connections, let the ones in flight finish, and say which
 * happened.
 *
 * Cloud Run sends `SIGTERM` and then, for a service, *"a 10 second period
 * before the actual shutdown occurs, at which point Cloud Run sends a SIGKILL
 * signal."* Without a handler the process is simply killed mid-request, and the
 * learner's tap — which may have already written a signal to the ledger and not
 * yet answered — looks to the panel like a network failure.
 *
 * `closeIdleConnections` matters more than it looks. `server.close()` waits for
 * every open socket, and the extension holds keep-alive sockets that are
 * carrying no request at all; without this the drain always runs the full grace
 * period and always ends in SIGKILL.
 *
 * The timeout is not the platform's number. Giving up a moment early is a clean
 * shutdown in the log; being killed is an instance that reads as a crash, and
 * the difference matters when the question in production is whether the service
 * is healthy.
 *
 * A `close` that errors still resolves `drained`: a listener that was not open
 * is a listener that is now shut, and hanging the shutdown to report it would
 * turn a harmless race into a SIGKILL.
 */
export function gracefulClose(server: Closable, graceMs: number): Promise<ShutdownResult> {
  return new Promise<ShutdownResult>((resolve) => {
    const timer = setTimeout(() => resolve('timed-out'), graceMs);
    // Never hold the event loop open on the grace timer: if the drain finishes
    // first, the process should be free to exit immediately.
    timer.unref?.();
    server.close(() => {
      clearTimeout(timer);
      resolve('drained');
    });
    server.closeIdleConnections?.();
  });
}

// ---------------------------------------------------------------------------
// Who is asking (the Firebase identity boundary)
// ---------------------------------------------------------------------------

/** An identity spec this build cannot honour. */
export class IdentitySpecError extends Error {}

export type IdentityChoice =
  | { readonly kind: 'none' }
  | { readonly kind: 'firebase'; readonly projectId: string; readonly emulatorHost: string | null };

/**
 * `SB_AUTH` — whether this process knows who is asking, and how it finds out.
 *
 * Unset is the single-board service, which is what somebody running Virgil on
 * their own machine gets and what this has always been. There is no default
 * multi-tenancy: a service that silently started requiring tokens would break
 * every local install, and one that silently stopped would be worse.
 *
 *   firebase:<projectId>                  verify against Google. Signed tokens.
 *   firebase:<projectId>@<host:port>      verify against an Auth emulator.
 *
 * The emulator form is spelled out rather than sniffed from
 * `FIREBASE_AUTH_EMULATOR_HOST`, because that variable being set in a deployed
 * environment by accident would turn signature checking off. **Accepting
 * unsigned tokens is a thing this process is told to do, in a committed file,
 * or it does not happen** — the same shape as `VIRGIL_ALLOW_PRODUCTION`.
 */
export function identityChoice(spec: string | undefined): IdentityChoice {
  const raw = spec?.trim();
  if (!raw || raw === 'none') return { kind: 'none' };

  const colon = raw.indexOf(':');
  const scheme = colon < 0 ? raw : raw.slice(0, colon);
  const rest = colon < 0 ? '' : raw.slice(colon + 1).trim();

  if (scheme !== 'firebase') {
    throw new IdentitySpecError(
      `SB_AUTH=${raw} names no identity provider this build can reach. `
      + 'Known: none, firebase:<projectId>, firebase:<projectId>@<emulatorHost:port>');
  }
  if (!rest) {
    throw new IdentitySpecError(
      'SB_AUTH=firebase: names no project — use firebase:<projectId>. A verifier without a '
      + "project checks a token's audience against nothing.");
  }

  const at = rest.indexOf('@');
  if (at < 0) return { kind: 'firebase', projectId: rest, emulatorHost: null };

  const projectId = rest.slice(0, at).trim();
  const emulatorHost = rest.slice(at + 1).trim();
  if (!projectId || !emulatorHost) {
    throw new IdentitySpecError(
      `SB_AUTH=${raw} is not a project and an emulator. Use firebase:<projectId>@<host:port>, `
      + 'or firebase:<projectId> to verify signatures against Google.');
  }
  return { kind: 'firebase', projectId, emulatorHost };
}

/**
 * Refuse to accept unsigned tokens in a deployed process.
 *
 * The emulator form is legitimate and is how the Firebase identity boundary says to build; running
 * it in a deployed estate is an authentication bypass wearing a config value.
 * `K_SERVICE` is set by Cloud Run and by nothing a developer runs locally, so
 * it is the same signal `sharedSecret` already keys on.
 */
export function identityIsSafeHere(
  choice: IdentityChoice,
  env: Record<string, string | undefined>,
): { ok: true } | { ok: false; reason: string } {
  if (choice.kind !== 'firebase' || !choice.emulatorHost) return { ok: true };
  if (!env['K_SERVICE']) return { ok: true };
  return {
    ok: false,
    reason:
      `SB_AUTH names the Auth emulator at ${choice.emulatorHost}, and this process is running on `
      + 'Cloud Run. Emulator tokens are unsigned, so this would accept any identity anybody typed. '
      + 'Use SB_AUTH=firebase:<projectId> in a deployed estate.',
  };
}

/**
 * Where one learner's json board sits, given the single-board path.
 *
 * `.data/store.json` becomes `.data/learner-<uid>.json`, so a machine that was
 * running the single-board service keeps its file untouched and the per-learner
 * ones land beside it. Named here rather than inline in the service because it
 * is a decision about somebody's data on disk, and it is testable.
 */
export function learnerBoardPath(singlePath: string, boardId: string): string {
  const slash = Math.max(singlePath.lastIndexOf('/'), singlePath.lastIndexOf('\\'));
  const dir = slash < 0 ? '' : singlePath.slice(0, slash + 1);
  return `${dir}${boardId}.json`;
}
