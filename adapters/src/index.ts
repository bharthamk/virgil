/**
 * The adapters a composition root may build.
 *
 * `gemini-llm.js` joined this list in the declaration commit, and the omission
 * it replaces was never the real guard. Keeping a class out of a barrel makes it
 * inconvenient to reach; it does not make reaching it a decision. What does is
 * `runner/src/__tests__/seam-purity.test.ts`, which fails if the token
 * `GeminiLlm` appears in any source outside this file and the two composition
 * roots, and which additionally requires each root to reach it through
 * `llmChoice` — so the provider cannot be acquired by an import, only named by a
 * spec in a committed file.
 *
 * `firestore-store.js` joined it in the same commit, and its omission had been
 * the more expensive of the two. Both composition roots asked this barrel for
 * `FirestoreStore` by name, found nothing, and exited 2 with "this build has no
 * Firestore store" — so **every** firestore spec answered there, the production
 * store was unreachable in a deployed process, and the authorisation gate the
 * store lane built had never once been reached. A guard that works by making a
 * class hard to find is not a guard; `storeChoice`, `firestoreWiring` and the
 * `VIRGIL_ALLOW_PRODUCTION` opt-in are, and they are pure functions with their
 * own suite. Keeping the driver out of the barrel bought nothing and cost the
 * feature.
 */
export * from './ollama-llm.js';
export * from './gemini-llm.js';
export * from './vertex-credential.js';
export * from './key-ladder-llm.js';
export * from './model-input-windows.js';
export * from './cli-endpoint-llm.js';
export * from './firestore-store.js';
export * from './firestore-tenant-directory.js';
export * from './ollama-embedder.js';
export * from './tfidf-embedder.js';
export * from './json-store.js';
export * from './local-notebook-export.js';
export * from './drive-notebook-export.js';
export * from './local-research.js';
export * from './firebase-auth.js';
