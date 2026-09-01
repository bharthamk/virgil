/**
 * One clear failure for the missing local runtime, shared by every script here.
 *
 * Without it a script that needs a model dies inside whatever call happened to
 * reach the network first, and the reader gets `TypeError: fetch failed` with a
 * Node stack and no mention of Ollama. Worse is `measure-prompts.mjs`, which
 * survives the failure and prints a full table of zeros that reads like a
 * result. Neither tells someone running the script for the first time the one
 * thing they need to know, which is that nothing is listening on 11434.
 *
 * So the check happens before any work, names the host, names the models, and
 * exits 1. It is a message, not a policy: nothing here decides whether a script
 * may run, only what the reader is told when it cannot.
 *
 *   await requireOllama([DEFAULT_EMBED_MODEL], { hint: '...' });
 *
 * `hint` is where a script says what its own no-model path is, when it has one
 * — `SB_EMBEDDER=tfidf` for the ones that can run in the lexical space.
 */

export const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';

/** Ollama reports `nomic-embed-text:latest` for what everything else calls `nomic-embed-text`. */
function installed(names, wanted) {
  return names.has(wanted) || names.has(`${wanted}:latest`);
}

/**
 * Exits 1 with an explanation if Ollama is not answering, or is answering but
 * has not pulled a model the caller named. Returns quietly otherwise.
 *
 * A caller with an honest offline fallback may set `throwOnFailure`. That lets
 * it report the reduced proof and continue without weakening the default for
 * scripts whose result genuinely requires a local model.
 */
export async function requireOllama(models, { hint, throwOnFailure = false } = {}) {
  // A caller that needs nothing is a caller on its own no-model path. Pinging
  // the host anyway would fail a run that was never going to reach a model.
  if (!models.length) return;
  let names;
  try {
    const r = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    names = new Set((await r.json()).models?.map((m) => m.name) ?? []);
  } catch (err) {
    if (throwOnFailure) {
      throw new Error(`Ollama is unavailable at ${OLLAMA_HOST}: ${err?.message ?? err}`);
    }
    console.error(`\nThis script needs a local Ollama at ${OLLAMA_HOST}, and nothing answered there.`);
    console.error(`  ${err?.message ?? err}`);
    console.error('\n  Start it with `ollama serve`, or set OLLAMA_HOST to one that is running.');
    if (hint) console.error(`  ${hint}`);
    process.exit(1);
  }

  const missing = models.filter((m) => !installed(names, m));
  if (missing.length) {
    if (throwOnFailure) {
      throw new Error(`Ollama at ${OLLAMA_HOST} is missing: ${missing.join(', ')}`);
    }
    console.error(`\nOllama is running at ${OLLAMA_HOST}, but this script needs ${missing.length} model(s) that are not pulled:`);
    for (const m of missing) console.error(`  ollama pull ${m}`);
    if (hint) console.error(`\n  ${hint}`);
    process.exit(1);
  }
}
