/**
 * The fleet's own scripted model, served over Ollama's wire protocol.
 *
 * This exists for one reason: **to run the Job container end to end, to a real
 * composed session, with zero calls to any provider.** Without it the only
 * model an image could reach is `127.0.0.1:11434` inside the container, where
 * nothing is listening, so every containerised night degrades and the success
 * path of the exit-code contract is unprovable on a machine with no credits.
 *
 * It is deliberately not a new stub. `ScriptedLlm` in the nightly harness is
 * the model the suite's idempotence, recovery, scale and integrity tests all
 * run against; this serves *that* object, so a night run inside a container is
 * directly comparable to `nightly-integrity.test.ts` rather than being a second
 * fixture that has to be kept in step with the first.
 *
 * ## How the schema gets back
 *
 * `ScriptedLlm` decides what to answer entirely from `req.schema.required` —
 * see `stageOf`. The Ollama adapter puts the schema in the message body, after
 * a fixed marker:
 *
 *     `${req.prompt}\n\nReturn JSON matching:\n${JSON.stringify(req.schema)}`
 *
 * so both halves are recoverable by splitting on that marker. If the adapter
 * ever changes how it frames a structured request this stops working loudly —
 * it answers `{}` for every stage and the night builds nothing — rather than
 * quietly answering the wrong stage.
 *
 * ## This is a development tool
 *
 * It runs on the host, never in an image, and it reaches no network. Run it,
 * point a container at it with `SB_OLLAMA_HOST`, and stop it.
 *
 *     node deploy/stub-model.mjs 18791
 *
 * Requires `npm run build` first: it imports the compiled harness, which is the
 * whole point of it.
 */

import { createServer } from 'node:http';
// batch-harness, née nightly-harness — the manual-processing contract’s rename reached the file
// this imports and not this import, so the stub died at startup and every
// smoke night degraded to `no-session:model-failed` with nothing listening.
import { ScriptedLlm } from '../runner/dist/__tests__/batch-harness.js';

const PORT = Number(process.argv[2] ?? 18791);
/**
 * Loopback by default, because this answers anything that asks and is not
 * something to put on an interface somebody else can reach.
 *
 * The second argument widens it, and there is exactly one reason to: running
 * the stub as a container on a Docker `--internal` network, which is how the
 * Job image is exercised without a single packet leaving the machine. The
 * Forager re-fetches real pages, so a smoke run on a normal bridge network
 * would reach the open internet; on an internal network those fetches fail,
 * the stage degrades as designed, and the model is still reachable.
 */
const HOST = process.argv[3] ?? '127.0.0.1';
const MARKER = '\n\nReturn JSON matching:\n';

const llm = new ScriptedLlm();
let served = 0;

/** The two halves of a structured request, as the adapter framed them. */
function unframe(content) {
  const at = content.lastIndexOf(MARKER);
  if (at < 0) return { prompt: content, schema: undefined };
  return {
    prompt: content.slice(0, at),
    schema: JSON.parse(content.slice(at + MARKER.length)),
  };
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const url = req.url ?? '';

    // The embedding space. Only reached when SB_EMBEDDER is not `tfidf`; the
    // containerised runs use the lexical space, so this is here so that a
    // request for it fails as a wrong answer rather than as a dead port.
    if (url.startsWith('/api/embed')) {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const input = Array.isArray(body.input) ? body.input : [];
      res.writeHead(200, { 'content-type': 'application/json' });
      // Deterministic and text-derived, so two runs over one board embed the
      // same way — the property every idempotence claim rests on.
      res.end(JSON.stringify({
        embeddings: input.map((t) => {
          const s = String(t);
          let a = 0;
          let b = 0;
          for (let i = 0; i < s.length; i++) {
            if (i % 2) a += s.charCodeAt(i); else b += s.charCodeAt(i);
          }
          return [a % 97 / 97, b % 89 / 89];
        }),
      }));
      return;
    }

    if (!url.startsWith('/api/chat')) {
      res.writeHead(404).end('stub-model serves /api/chat and /api/embed');
      return;
    }

    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const last = body.messages?.[body.messages.length - 1]?.content ?? '';
    const { prompt, schema } = unframe(String(last));

    let value;
    try {
      const out = await llm.structured({
        tier: 'deep', reasoning: 'on', system: '', prompt, schema,
      });
      value = out.value;
    } catch (err) {
      res.writeHead(500).end(String(err));
      return;
    }

    served++;
    const stage = schema?.required?.[0] ?? '?';
    console.log(`  stub-model ${String(served).padStart(3)}  ${stage}`);

    // Ollama answers NDJSON, one object per chunk, the last carrying the token
    // counts. One line is a legal stream and is what the adapter accumulates.
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.end(`${JSON.stringify({
      message: { content: JSON.stringify(value) },
      done: true,
      prompt_eval_count: prompt.length,
      eval_count: JSON.stringify(value).length,
    })}\n`);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`stub-model on http://${HOST}:${PORT} — the nightly harness's ScriptedLlm, over Ollama's protocol`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`\nstub-model served ${served} call(s)`);
    server.close(() => process.exit(0));
  });
}
