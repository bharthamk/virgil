import { OllamaLlm } from '@sb/adapters';
import type { LocalConnectorJob, LocalConnectorResult } from '@sb/core';
import { localConnectorExecutionRequest } from './local-model-connector.js';

const service = (process.env.VIRGIL_SERVICE_URL ?? '').replace(/\/$/, '');
const token = process.env.VIRGIL_CONNECTOR_TOKEN ?? '';
const ollama = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
const headers = { 'content-type': 'application/json', 'x-virgil-local-connector': token };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const heartbeat = (job: LocalConnectorJob): Promise<Response> => fetch(`${service}/local-connector/jobs/heartbeat`, {
  method: 'POST', headers, body: JSON.stringify({ jobId: job.id, leaseId: job.leaseId }),
});

if (!/^https?:\/\//.test(service) || token.length < 40) {
  console.error('Set VIRGIL_SERVICE_URL and VIRGIL_CONNECTOR_TOKEN from Virgil Settings.');
  process.exit(2);
}

const llm = new OllamaLlm({ host: ollama });
let running = true;
process.once('SIGINT', () => { running = false; });
process.once('SIGTERM', () => { running = false; });

console.log(`Virgil local connector ready (${ollama}). Press Ctrl+C to stop.`);

while (running) {
  try {
    const response = await fetch(`${service}/local-connector/jobs/next`, { headers });
    if (response.status === 204) { await sleep(1_500); continue; }
    if (!response.ok) throw new Error(`service answered ${response.status}: ${await response.text()}`);
    const body = await response.json() as { job?: LocalConnectorJob };
    const job = body.job;
    if (!job?.leaseId) throw new Error('service returned an invalid connector job');
    let outcome: { result: LocalConnectorResult } | { error: string };
    const beat = setInterval(() => { void heartbeat(job).catch(() => {}); }, 10_000);
    try {
      const request = localConnectorExecutionRequest(job.request);
      const modelRequest = {
        tier: request.tier,
        ...(request.reasoning ? { reasoning: request.reasoning } : {}),
        system: request.system,
        prompt: request.prompt,
        ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
        ...(request.media ? { media: request.media } : {}),
      };
      const result = request.structured
        ? await llm.structured({ ...modelRequest, schema: request.schema })
        : await llm.complete(modelRequest);
      outcome = { result };
    } catch (error) {
      outcome = { error: error instanceof Error ? error.message : String(error) };
    } finally { clearInterval(beat); }
    const completed = await fetch(`${service}/local-connector/jobs/${encodeURIComponent(job.id)}/complete`, {
      method: 'POST', headers, body: JSON.stringify({ leaseId: job.leaseId, ...outcome }),
    });
    if (!completed.ok) throw new Error(`completion was refused (${completed.status})`);
  } catch (error) {
    console.error(`Connector waiting: ${error instanceof Error ? error.message : String(error)}`);
    await sleep(3_000);
  }
}

console.log('Virgil local connector stopped.');
