import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HOST = '127.0.0.1';
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_PROCESS_BYTES = 1024 * 1024;
const MAX_CONCURRENCY = 2;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 32_768;
const DEFAULT_BINARY = '/Applications/ChatGPT.app/Contents/Resources/codex';

interface BridgeRequest {
  readonly model?: unknown;
  readonly reasoning?: unknown;
  readonly system?: unknown;
  readonly prompt?: unknown;
  readonly media?: unknown;
  readonly schema?: unknown;
  readonly maxOutputTokens?: unknown;
}

export interface CodexBridgeOptions {
  readonly token: string;
  readonly binary?: string;
  readonly fastModel?: string;
  readonly deepModel?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

const send = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const tokenMatches = (header: string | undefined, token: string): boolean => {
  const supplied = /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1] ?? '';
  const left = Buffer.from(supplied);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
};

const bodyOf = (req: IncomingMessage): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  req.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) {
      reject(new Error(`request exceeds ${MAX_REQUEST_BYTES} bytes`));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be an object');
      resolve(parsed as Record<string, unknown>);
    } catch (error) { reject(error); }
  });
  req.on('error', reject);
});

export function createCodexCliBridge(options: CodexBridgeOptions): RequestListener {
  if (options.token.trim().length < 16) throw new Error('SB_CLI_TOKEN must be at least 16 characters');
  const binary = options.binary ?? DEFAULT_BINARY;
  const tiers: Record<string, string> = {
    'cli-fast': options.fastModel ?? 'gpt-5.6-luna',
    'cli-deep': options.deepModel ?? 'gpt-5.6-terra',
  };
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('CLI bridge timeout must be positive');
  let active = 0;

  return async (req, res) => {
    if (!tokenMatches(req.headers.authorization, options.token)) {
      return send(res, 401, { error: 'CLI bridge requires its operator token' });
    }
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, provider: 'codex-cli', capacity: MAX_CONCURRENCY - active });
    }
    if (req.method === 'GET' && req.url === '/v1/capabilities') {
      return send(res, 200, {
        protocol: 'virgil-agent-endpoint',
        version: 1,
        role: 'model-worker',
        provider: 'codex-cli',
        operations: {
          complete: {
            method: 'POST', path: '/v1/complete', models: Object.keys(tiers),
            reasoning: ['off', 'on'], structuredOutput: true,
          },
        },
        input: {
          text: true,
          images: {
            capturedDataUrlsOnly: true, maxEachBytes: MAX_IMAGE_BYTES, maxCount: MAX_IMAGES,
          },
        },
        limits: {
          maxRequestBytes: MAX_REQUEST_BYTES,
          maxProcessOutputBytes: MAX_PROCESS_BYTES,
          maxConcurrency: MAX_CONCURRENCY,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          timeoutMs,
        },
        authority: {
          execution: 'model-only', sideEffects: 'none', filesystem: 'ephemeral-read-only',
          tools: {
            shell: false, webSearch: false, browser: false, computerUse: false,
            apps: false, plugins: false, skills: false, hooks: false,
          },
        },
      });
    }
    if (req.method !== 'POST' || req.url !== '/v1/complete') return send(res, 404, { error: 'not found' });
    if (active >= MAX_CONCURRENCY) return send(res, 429, { error: 'CLI bridge is busy' });
    active++;
    try {
      const body = await bodyOf(req) as BridgeRequest;
      const alias = typeof body.model === 'string' ? body.model : '';
      const model = tiers[alias];
      if (!model) return send(res, 400, { error: 'model must be cli-fast or cli-deep' });
      if (typeof body.system !== 'string' || typeof body.prompt !== 'string') {
        return send(res, 400, { error: 'system and prompt must be strings' });
      }
      const maxOutputTokens = typeof body.maxOutputTokens === 'number'
        && Number.isInteger(body.maxOutputTokens) && body.maxOutputTokens > 0
        ? Math.min(body.maxOutputTokens, MAX_OUTPUT_TOKENS) : 2_048;
      const reasoning = body.reasoning === 'off' ? 'none' : 'medium';
      const result = await invokeCodex({
        binary, model, reasoning, system: body.system, prompt: body.prompt,
        schema: body.schema, media: body.media, maxOutputTokens, timeoutMs,
        env: options.env ?? process.env,
      });
      return send(res, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /request exceeds|must be|image/i.test(message) ? 400 : 502;
      return send(res, status, { error: message.slice(0, 1_000) });
    } finally { active--; }
  };
}

interface InvokeOptions {
  binary: string; model: string; reasoning: string; system: string; prompt: string;
  schema: unknown; media: unknown; maxOutputTokens: number; timeoutMs: number; env: NodeJS.ProcessEnv;
}

async function invokeCodex(options: InvokeOptions) {
  const work = await mkdtemp(join(tmpdir(), 'virgil-cli-bridge-'));
  const systemFile = join(work, 'system.md');
  const outputFile = join(work, 'output.txt');
  const schemaFile = options.schema === undefined ? null : join(work, 'schema.json');
  try {
    await writeFile(systemFile, options.system, { mode: 0o600 });
    if (schemaFile) await writeFile(schemaFile, JSON.stringify(strictSchema(options.schema)), { mode: 0o600 });
    const images = await materializeImages(work, options.media);
    const args = [
      'exec', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--strict-config', '--skip-git-repo-check', '--color', 'never', '--json',
      '-C', work, '-m', options.model,
      '-c', 'features.shell_tool=false',
      '-c', 'features.apps=false',
      '-c', 'features.plugins=false',
      '-c', 'features.remote_plugin=false',
      '-c', 'features.browser_use=false',
      '-c', 'features.browser_use_external=false',
      '-c', 'features.browser_use_full_cdp_access=false',
      '-c', 'features.computer_use=false',
      '-c', 'features.image_generation=false',
      '-c', 'features.in_app_browser=false',
      '-c', 'features.skill_search=false',
      '-c', 'features.workspace_dependencies=false',
      '-c', 'features.hooks=false',
      '-c', 'features.view_image=false',
      '-c', 'features.skill_mcp_dependency_install=false',
      '-c', 'agents.enabled=false',
      '-c', 'features.goals=false',
      '-c', 'memories.use_memories=false',
      '-c', 'web_search="disabled"',
      '-c', 'history.persistence="none"',
      '-c', `model_reasoning_effort="${options.reasoning}"`,
      '-c', `model_instructions_file="${systemFile}"`,
      '-c', 'features.rollout_budget.enabled=true',
      '-c', 'features.rollout_budget.prefill_token_weight=0',
      '-c', 'features.rollout_budget.sampling_token_weight=1',
      '-c', `features.rollout_budget.limit_tokens=${options.maxOutputTokens}`,
      '-c', 'features.rollout_budget.reminder_at_remaining_tokens=[]',
      ...images.flatMap((image) => ['--image', image]),
      ...(schemaFile ? ['--output-schema', schemaFile] : []),
      '--output-last-message', outputFile,
      '-',
    ];
    const run = await spawnBounded(options.binary, args, options.prompt, work, options.env, options.timeoutMs);
    if (run.code !== 0) throw new Error(`Codex CLI exited ${run.code}: ${run.stderr || run.stdout}`);
    const info = await stat(outputFile);
    if (info.size > MAX_PROCESS_BYTES) throw new Error('Codex CLI final message exceeded the output limit');
    const value = await readFile(outputFile, 'utf8');
    const usage = parseUsage(run.stdout);
    return {
      value,
      modelId: options.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
  } finally { await rm(work, { recursive: true, force: true }); }
}

async function materializeImages(work: string, raw: unknown): Promise<string[]> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('media must be an array');
  if (raw.length > MAX_IMAGES) throw new Error(`media must contain at most ${MAX_IMAGES} images`);
  const out: string[] = [];
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== 'object' || (item as any).kind !== 'image'
      || typeof (item as any).ref !== 'string') throw new Error('media contains an invalid image');
    const match = /^data:(image\/[^;]+);base64,(.*)$/.exec((item as any).ref);
    if (!match) throw new Error('CLI bridge images must be captured data URLs');
    const bytes = Buffer.from(match[2] ?? '', 'base64');
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('CLI bridge image exceeds 4 MiB');
    const extension = (match[1] ?? 'image/png').split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
    const path = join(work, `image-${index}.${extension}`);
    await writeFile(path, bytes, { mode: 0o600 });
    out.push(path);
  }
  return out;
}

function spawnBounded(
  binary: string, args: string[], prompt: string, cwd: string, sourceEnv: NodeJS.ProcessEnv, timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const allowed = ['PATH', 'HOME', 'CODEX_HOME', 'SSL_CERT_FILE', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];
    const env = Object.fromEntries(allowed.flatMap((key) => sourceEnv[key] ? [[key, sourceEnv[key] as string]] : []));
    const child = spawn(binary, args, { cwd, env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    let terminating = false;
    let failure: Error | undefined;
    let grace: NodeJS.Timeout | undefined;
    const done = (error?: Error, result?: { code: number; stdout: string; stderr: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      error ? reject(error) : resolve(result as { code: number; stdout: string; stderr: string });
    };
    const terminate = (error: Error): void => {
      if (terminating || settled) return;
      terminating = true;
      failure = error;
      killGroup(child, 'SIGTERM');
      grace = setTimeout(() => killGroup(child, 'SIGKILL'), 250);
      grace.unref();
    };
    const timer = setTimeout(() => {
      terminate(new Error(`Codex CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const take = (chunk: Buffer | string, target: 'stdout' | 'stderr'): void => {
      const text = String(chunk);
      bytes += Buffer.byteLength(text);
      if (bytes > MAX_PROCESS_BYTES) {
        terminate(new Error('Codex CLI exceeded the process output limit'));
        return;
      }
      if (target === 'stdout') stdout += text; else stderr += text;
    };
    child.stdout.on('data', (chunk) => take(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => take(chunk, 'stderr'));
    child.once('error', (error) => done(error));
    child.once('close', (code) => failure
      ? done(failure)
      : done(undefined, { code: code ?? 1, stdout, stderr }));
    child.stdin.end(prompt);
  });
}

const parseUsage = (stdout: string): { inputTokens: number; outputTokens: number } => {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as any;
      if (event.type !== 'turn.completed' || !event.usage) continue;
      inputTokens = Number(event.usage.input_tokens ?? 0);
      outputTokens = Number(event.usage.output_tokens ?? 0) + Number(event.usage.reasoning_output_tokens ?? 0);
    } catch { /* diagnostic line */ }
  }
  return { inputTokens, outputTokens };
};

const strictSchema = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(strictSchema);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) out[key] = strictSchema(child);
  if (source.type === 'object' || source.properties) {
    out.additionalProperties = false;
    if (source.properties && typeof source.properties === 'object') {
      out.required = Object.keys(source.properties as Record<string, unknown>);
    }
  }
  return out;
};

const killGroup = (child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void => {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch { /* already gone */ } }
};

async function main(): Promise<void> {
  const token = process.env.SB_CLI_TOKEN ?? '';
  const port = Number(process.env.SB_CLI_PORT ?? 8798);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('SB_CLI_PORT must be a valid port');
  const server = createServer(createCodexCliBridge({
    token,
    ...(process.env.SB_CODEX_BINARY ? { binary: process.env.SB_CODEX_BINARY } : {}),
    ...(process.env.SB_CODEX_FAST_MODEL ? { fastModel: process.env.SB_CODEX_FAST_MODEL } : {}),
    ...(process.env.SB_CODEX_DEEP_MODEL ? { deepModel: process.env.SB_CODEX_DEEP_MODEL } : {}),
    timeoutMs: Number(process.env.SB_CODEX_TIMEOUT_MS ?? 120_000),
  }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, resolve);
  });
  console.log(`Virgil CLI bridge on http://${HOST}:${port} (token required)`);
}

try {
  const self = realpathSync(process.argv[1] ?? '');
  if (import.meta.url === pathToFileURL(self).href) await main();
} catch { /* imported by tests */ }
