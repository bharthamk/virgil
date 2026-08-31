import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  LearnerPrefs, Llm, LlmRequest, LlmResult, ModelMode as CoreModelMode,
  ModelProviderToggles as CoreModelProviderToggles, ModelRoute as CoreModelRoute,
  ModelRoutes as CoreModelRoutes, Store,
} from '@sb/core';

export type ModelMode = CoreModelMode;
export type ModelProviderToggles = CoreModelProviderToggles;
export type ModelRoute = CoreModelRoute;
export type ModelRoutes = CoreModelRoutes;

export const DEFAULT_MODEL_MODE: ModelMode = 'cloud';
export const DEFAULT_MODEL_PROVIDERS: ModelProviderToggles = Object.freeze({
  cloud: true, local: false, cli: false,
});
export const DEFAULT_MODEL_ROUTES: ModelRoutes = Object.freeze({
  quick: 'cloud', deep: 'cloud', images: 'cloud',
});
export const DEFAULT_LOCAL_MODEL_ENDPOINT = 'http://127.0.0.1:11434';
export const DEFAULT_CLI_MODEL_ENDPOINT = 'http://127.0.0.1:8798';

export const isModelMode = (value: unknown): value is ModelMode =>
  value === 'cloud' || value === 'local' || value === 'cli';

export function effectiveModelMode(prefs: Pick<LearnerPrefs, 'modelMode'>, fallback = DEFAULT_MODEL_MODE): ModelMode {
  return isModelMode(prefs.modelMode) ? prefs.modelMode : fallback;
}

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const offered = Object.keys(value);
  return offered.length === keys.length && offered.every((key) => keys.includes(key));
};

export const isModelProviderToggles = (value: unknown): value is ModelProviderToggles => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return exactKeys(record, ['cloud', 'local', 'cli'])
    && typeof record.cloud === 'boolean'
    && typeof record.local === 'boolean'
    && typeof record.cli === 'boolean';
};

export const isModelRoutes = (value: unknown): value is ModelRoutes => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return exactKeys(record, ['quick', 'deep', 'images'])
    && isModelMode(record.quick)
    && isModelMode(record.deep)
    && isModelMode(record.images);
};

export class ModelRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelRoutingError';
  }
}

export class ModelProviderDisabledError extends ModelRoutingError {
  constructor(readonly provider: ModelMode, readonly route: ModelRoute) {
    super(`model route ${route} is assigned to disabled provider ${provider}`);
    this.name = 'ModelProviderDisabledError';
  }
}

/** Images override tier; otherwise the existing deep/fast split is preserved. */
export function modelRouteFor(req: Pick<LlmRequest, 'tier' | 'media'>): ModelRoute {
  if (req.media?.length) return 'images';
  return req.tier === 'deep' ? 'deep' : 'quick';
}

/**
 * New toggles are authoritative. Without them, the legacy/global choice is
 * treated as the sole enabled provider so pre-toggle boards keep working.
 */
export function effectiveModelProviders(
  prefs: Pick<LearnerPrefs, 'modelMode' | 'modelProviders'>,
  fallback = DEFAULT_MODEL_MODE,
): ModelProviderToggles {
  if (prefs.modelProviders !== undefined) {
    if (!isModelProviderToggles(prefs.modelProviders)) {
      throw new ModelRoutingError('modelProviders must contain boolean cloud, local and cli fields');
    }
    return prefs.modelProviders;
  }
  const enabled = effectiveModelMode(prefs, fallback);
  if (enabled === DEFAULT_MODEL_MODE && prefs.modelMode === undefined && fallback === DEFAULT_MODEL_MODE) {
    return DEFAULT_MODEL_PROVIDERS;
  }
  return { cloud: enabled === 'cloud', local: enabled === 'local', cli: enabled === 'cli' };
}

/** New per-workload routes, or the legacy/global choice applied to all three. */
export function effectiveModelRoutes(
  prefs: Pick<LearnerPrefs, 'modelMode' | 'modelRoutes'>,
  fallback = DEFAULT_MODEL_MODE,
): ModelRoutes {
  if (prefs.modelRoutes !== undefined) {
    if (!isModelRoutes(prefs.modelRoutes)) {
      throw new ModelRoutingError('modelRoutes must assign quick, deep and images to cloud, local or cli');
    }
    return prefs.modelRoutes;
  }
  const mode = effectiveModelMode(prefs, fallback);
  if (mode === DEFAULT_MODEL_MODE && prefs.modelMode === undefined && fallback === DEFAULT_MODEL_MODE) {
    return DEFAULT_MODEL_ROUTES;
  }
  return { quick: mode, deep: mode, images: mode };
}

export function effectiveRouteMode(
  prefs: Pick<LearnerPrefs, 'modelMode' | 'modelProviders' | 'modelRoutes'>,
  req: Pick<LlmRequest, 'tier' | 'media'>,
  fallback = DEFAULT_MODEL_MODE,
): ModelMode {
  const route = modelRouteFor(req);
  const mode = effectiveModelRoutes(prefs, fallback)[route];
  if (!effectiveModelProviders(prefs, fallback)[mode]) {
    throw new ModelProviderDisabledError(mode, route);
  }
  return mode;
}

/**
 * Model endpoints are service-side network destinations, so validation belongs
 * here rather than in the browser. Credentials in a URL are always refused.
 * Remote endpoints require an explicit operator opt-in; the safe default is a
 * loopback bridge the learner deliberately started.
 */
export function modelEndpoint(
  value: unknown,
  fallback: string,
  allowRemote = false,
): string {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error('model endpoint must be a valid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('model endpoint must use http or https');
  }
  if (url.username || url.password) throw new Error('model endpoint must not contain credentials');
  if (url.search || url.hash) throw new Error('model endpoint must not contain a query or fragment');
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
    || url.hostname === '[::1]';
  if (!allowRemote && !loopback) {
    throw new Error('remote model endpoints require the service operator to opt in');
  }
  return url.toString().replace(/\/$/, '');
}

export interface ModelProviders {
  readonly cloud: Llm;
  local(endpoint: string): Llm;
  cli(endpoint: string): Llm;
}

export interface ModelRouterOptions {
  readonly store: Pick<Store, 'getPrefs'>;
  readonly providers: ModelProviders;
  readonly defaultMode?: ModelMode;
  readonly defaultLocalEndpoint?: string;
  readonly defaultCliEndpoint?: string;
  readonly allowRemoteEndpoints?: boolean;
}

/** A budget gate and the provider call must use one route decision. */
const fixedRoute = new AsyncLocalStorage<ModelMode>();

export const withModelRouteMode = <T>(mode: ModelMode, run: () => Promise<T>): Promise<T> =>
  fixedRoute.run(mode, run);

/** Persisted quick/deep/images choices route the same vendor-free model seam. */
export class ModelRouter implements Llm {
  private readonly local = new Map<string, Llm>();
  private readonly cli = new Map<string, Llm>();
  constructor(private readonly opts: ModelRouterOptions) {}

  async complete(req: LlmRequest): Promise<LlmResult<string>> {
    return (await this.selected(req)).complete(req);
  }

  async structured<T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> {
    return (await this.selected(req)).structured<T>(req);
  }

  private async selected(req: Pick<LlmRequest, 'tier' | 'media'>): Promise<Llm> {
    const prefs = await this.opts.store.getPrefs();
    const mode = fixedRoute.getStore()
      ?? effectiveRouteMode(prefs, req, this.opts.defaultMode ?? DEFAULT_MODEL_MODE);
    if (mode === 'cloud') return this.opts.providers.cloud;
    const allowRemote = this.opts.allowRemoteEndpoints ?? false;
    if (mode === 'local') {
      const endpoint = modelEndpoint(
        prefs.localModelEndpoint,
        this.opts.defaultLocalEndpoint ?? DEFAULT_LOCAL_MODEL_ENDPOINT,
        allowRemote,
      );
      let llm = this.local.get(endpoint);
      if (!llm) { llm = this.opts.providers.local(endpoint); this.local.set(endpoint, llm); }
      return llm;
    }
    // The CLI endpoint carries a service-owned bearer token. A browser-written
    // destination must never get to choose where that secret is sent, even
    // when the operator permits remote Local-model endpoints. CLI routing is
    // therefore operator-owned; Settings selects the mode, not the URL.
    const endpoint = modelEndpoint(
      undefined,
      this.opts.defaultCliEndpoint ?? DEFAULT_CLI_MODEL_ENDPOINT,
      true,
    );
    let llm = this.cli.get(endpoint);
    if (!llm) { llm = this.opts.providers.cli(endpoint); this.cli.set(endpoint, llm); }
    return llm;
  }
}
