/**
 * Everything the orchestration layer is allowed to know about where it is
 * running — and, more importantly, everything it is not.
 *
 * ## The rule this file enforces
 *
 * **No key material reaches this layer.** Not read from the environment, not
 * held in a field, not passed through, not logged. The model credential is the
 * `Llm` adapter's business and the adapter reads it itself; an orchestration
 * host that also read it would be a second place a key lives, and the second
 * place is the one that ends up in a log line.
 *
 * This is checked by a test rather than asserted here, because the realistic
 * failure is somebody adding one convenient field in six months' time.
 *
 * ## Why the names are prefixed
 *
 * `VIRGIL_ADK_*` rather than bare names, so a variable this layer reads can
 * never collide with one the provider SDK reads. `GOOGLE_CLOUD_PROJECT` and
 * `GOOGLE_GENAI_USE_VERTEXAI` are the two exceptions and they are deliberate:
 * those are Google's own contract with its own libraries, and renaming them
 * would mean the deployed process and the framework disagreed about where it is.
 */

/** Where the framework keeps session state between invocations. */
export type SessionBackend =
  /** In-process. The nightly's default: a batch job's session dies with it. */
  | 'memory'
  /** A SQL URI. For a hosted session surface that outlives one invocation. */
  | 'database'
  /** Vertex AI's managed session service. Requires a project and a location. */
  | 'vertex';

export interface AdkConfig {
  /** Namespaces sessions. One app name per deployment, stable across runs. */
  readonly appName: string;
  readonly sessionBackend: SessionBackend;
  /**
   * Only ever set for `database`, and it is a *connection* string, which on a
   * managed instance carries no password. A backend that needed an inline
   * password would be a key in this layer and is rejected below.
   */
  readonly sessionUri: string | null;
  /** Set when the deployment is on Vertex rather than the public API. */
  readonly project: string | null;
  readonly location: string | null;
  /** True when the framework should route model calls through Vertex. */
  readonly useVertex: boolean;
  readonly allowNetwork: boolean;
}

export const DEFAULT_APP_NAME = 'virgil-nightly';

/**
 * Names that may not be read by this layer, matched rather than listed.
 *
 * A list of exact names is a list that the next credential is not on. The
 * pattern catches `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `..._SECRET`,
 * `..._TOKEN`, `..._PASSWORD` and the things that have not been invented yet.
 */
export const CREDENTIAL_PATTERN = /(^|_)(API_)?(KEY|SECRET|TOKEN|PASSWORD|CREDENTIALS?)(_|$)/i;

export class AdkConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdkConfigError';
  }
}

const BACKENDS: readonly SessionBackend[] = ['memory', 'database', 'vertex'];

const isBackend = (v: string): v is SessionBackend =>
  (BACKENDS as readonly string[]).includes(v);

/** Trimmed, and empty-string treated as absent — an unset variable in a shell
 *  script is very often an empty one, and `appName: ''` would namespace every
 *  session under nothing. */
const read = (env: Readonly<Record<string, string | undefined>>, name: string): string | null => {
  const v = env[name];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
};

/**
 * Build the config from an environment, which is passed in rather than read.
 *
 * `process.env` is a global and this function takes an argument, for the same
 * reason `Clock` exists in `core/`: a function that reads the ambient world is a
 * function whose tests need the ambient world set up. The composition root hands
 * it `process.env`; every test hands it an object.
 */
export function adkConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = {},
): AdkConfig {
  const backendRaw = read(env, 'VIRGIL_ADK_SESSION_BACKEND') ?? 'memory';
  if (!isBackend(backendRaw)) {
    throw new AdkConfigError(
      `VIRGIL_ADK_SESSION_BACKEND=${backendRaw} is not one of ${BACKENDS.join(', ')} — `
      + 'refusing to guess which one was meant',
    );
  }

  const sessionUri = read(env, 'VIRGIL_ADK_SESSION_URI');
  if (backendRaw === 'database' && sessionUri === null) {
    throw new AdkConfigError('VIRGIL_ADK_SESSION_BACKEND=database needs VIRGIL_ADK_SESSION_URI');
  }
  if (sessionUri !== null && /:\/\/[^/@]*:[^/@]+@/.test(sessionUri)) {
    // A password inline in the URI is key material, and key material does not
    // live in this layer. Rejected loudly rather than carried and redacted:
    // something that is redacted in one log line is printed in the next.
    throw new AdkConfigError(
      'VIRGIL_ADK_SESSION_URI carries an inline password — the orchestration layer '
      + 'holds no credentials; use a socket path, IAM auth, or a secret mount',
    );
  }

  const useVertex = (read(env, 'GOOGLE_GENAI_USE_VERTEXAI') ?? '').toLowerCase() === 'true';
  const project = read(env, 'GOOGLE_CLOUD_PROJECT');
  const location = read(env, 'GOOGLE_CLOUD_LOCATION');

  if (backendRaw === 'vertex' && (project === null || location === null)) {
    throw new AdkConfigError(
      'VIRGIL_ADK_SESSION_BACKEND=vertex needs GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION',
    );
  }

  return {
    appName: read(env, 'VIRGIL_ADK_APP_NAME') ?? DEFAULT_APP_NAME,
    sessionBackend: backendRaw,
    sessionUri,
    project,
    location,
    useVertex,
    /**
     * Opt-in by exact string, read RAW rather than through `read()`.
     *
     * Two separate rules, and the second one was a real defect this file's own
     * test caught. First: a switch that opens on a truthy value opens on the
     * string `"false"`, so it compares against one literal. Second: it must not
     * be trimmed. `read()` trims, which made `" 1 "` — a trailing space in an
     * env file, the single most common way an environment variable is
     * malformed — open the network.
     *
     * Every other variable here is trimmed because the failure of a malformed
     * app name is cosmetic. The failure of a malformed spend switch is money, so
     * this one fails closed on anything that is not exactly `1`.
     */
    allowNetwork: env['VIRGIL_ADK_ALLOW_NETWORK'] === '1',
  };
}
