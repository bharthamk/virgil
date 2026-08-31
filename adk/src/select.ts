/**
 * How a composition root asks for a host without naming the framework.
 *
 * `index.ts` deliberately does not re-export `adk-binding.ts` — importing this
 * layer must never be what pulls `@google/adk` into a process, because "does
 * this deployment use ADK" has to stay a question with a findable answer rather
 * than a side effect of an import. That rule survives here: the binding is
 * reached by a dynamic import inside a function nobody calls by accident, so a
 * run that chose `local` loads no framework at all.
 *
 * Why this exists rather than the root importing `adk-binding.js` directly: the
 * root would then be a second file naming the framework's own module path, and
 * the whole point of the binding is that the dependency arrives through one
 * door. `runner/src/cli.ts` names a *host*; this file is the only place that
 * knows a host might be a package.
 */

import type { HostFactory } from './host.js';
import { localHost } from './host.js';

/** The hosts a deployment may ask for, by the name it asks for them by. */
export type HostName = 'local' | 'adk';

/**
 * Resolve a host factory by name.
 *
 * `local` resolves synchronously in spirit — it is already in this module — and
 * `adk` costs one dynamic import. Async either way so that the caller has one
 * shape to handle, and because a factory that can fail for "the package is not
 * installed" has to be able to say so before a night is started rather than
 * partway through one.
 *
 * An install that cannot resolve the framework raises `AdkUnavailableError` from
 * the binding, unchanged. That is deliberate: since the declaration commit the
 * package is a real dependency, so its absence is no longer a decision somebody
 * has not made — it is an incomplete install, and the honest response is to fail
 * loudly at startup rather than to run the night under the other host and let a
 * green execution imply a framework that was never loaded.
 */
export async function hostFactoryFor(name: HostName): Promise<HostFactory> {
  if (name === 'local') return localHost;
  const binding = await import('./adk-binding.js');
  return binding.adkHost;
}
