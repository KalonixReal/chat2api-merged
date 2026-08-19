/**
 * wreqFetch — Bun-side client for the Node.js wreq-js sidecar worker.
 *
 * Parallel to impersFetch.ts. Uses wreq-js (Rust + BoringSSL) instead of
 * impers (libcurl/OpenSSL) for TLS fingerprinting. BoringSSL matches real
 * Chrome's TLS library, producing a more authentic fingerprint that bypasses
 * library-level WAF detection.
 */

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logCrash, logEvent, logSessionCreate } from '../utils/wreqCrashLogger.ts';

let workerProcess: any = null;
let workerBaseUrl: string | null = null;
let workerStartPromise: Promise<string> | null = null;
let workerPort: number | null = null;

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = resolve(__dirname, '../worker/wreq-worker.mjs');

async function ensureWorker(): Promise<string> {
  if (workerBaseUrl) return workerBaseUrl;
  if (workerStartPromise) return workerStartPromise;
  workerStartPromise = startWorker();
  return workerStartPromise;
}

function getPort(): number {
  // 0 = OS assigns random port (no conflict risk)
  return 0;
}

async function startWorker(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const port = getPort();
    const proc = spawn('node', [WORKER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, WREQ_WORKER_PORT: String(port) },
    });
    workerProcess = proc;

    const timeout = setTimeout(() => {
      if (!workerBaseUrl) {
        proc.kill();
        workerProcess = null;
        workerStartPromise = null;
        reject(new Error('wreq worker startup timeout after 15s'));
      }
    }, 15_000);

    proc.stdout.on('data', (data: Buffer) => {
      try {
        const info = JSON.parse(data.toString().trim().split('\n')[0]);
        workerBaseUrl = `http://127.0.0.1:${info.port}`;
        clearTimeout(timeout);
        logEvent('wreqWorker', 'started', { port: info.port });
        resolvePromise(workerBaseUrl);
      } catch {
        /* not valid json yet */
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      logEvent('wreqWorker.stderr', '', { msg: data.toString().substring(0, 500) });
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timeout);
      workerProcess = null;
      workerStartPromise = null;
      logCrash('wreqWorker.start', err);
      reject(err);
    });

    proc.on('exit', (code: number | null) => {
      workerProcess = null;
      workerBaseUrl = null;
      workerStartPromise = null;
      logEvent('wreqWorker', 'exited', { code });
    });
  });
}

function restartWorker(): void {
  if (workerProcess) {
    try {
      workerProcess.kill();
    } catch {}
  }
  workerProcess = null;
  workerBaseUrl = null;
  workerStartPromise = null;
}

export interface WreqFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  stream?: boolean;
  impersonate?: string;
  timeout?: number;
  debugLogDir?: string;
}

export async function wreqFetch(url: string, options: WreqFetchOptions = {}): Promise<Response> {
  const baseUrl = await ensureWorker();
  const { method = 'GET', headers = {}, body, stream = false, impersonate = 'chrome_142', timeout = 30 } = options;

  logSessionCreate('wreqFetch.request', { method, url: url.split('?')[0], stream });

  const makeReq = async (): Promise<Response> => {
    return fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method,
        url,
        headers,
        body: body || undefined,
        stream,
        impersonate,
        timeout,
        debugLogDir: options.debugLogDir,
      }),
      signal: options.signal,
    });
  };

  let response: Response;
  try {
    response = await makeReq();
  } catch (err) {
    logCrash('wreqFetch.connection', err, { url: url.split('?')[0] });
    restartWorker();
    const baseUrl2 = await ensureWorker();
    response = await fetch(`${baseUrl2}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, url, headers, body: body || undefined, stream, impersonate, timeout }),
      signal: options.signal,
    });
  }

  const upstreamStatus = parseInt(response.headers.get('X-Upstream-Status') || '0', 10);
  const upstreamErrorB64 = response.headers.get('X-Upstream-Error');
  const upstreamHeadersB64 = response.headers.get('X-Upstream-Headers');

  if (upstreamStatus === 0 && upstreamErrorB64) {
    const errMsg = Buffer.from(upstreamErrorB64, 'base64').toString();
    logCrash('wreqFetch.upstream', errMsg, { url: url.split('?')[0] });
    throw new Error(`Wreq upstream error: ${errMsg}`);
  }

  let upstreamHeaders: Record<string, string> = {};
  if (upstreamHeadersB64) {
    try {
      upstreamHeaders = JSON.parse(Buffer.from(upstreamHeadersB64, 'base64').toString());
    } catch {}
  }

  const responseInit: ResponseInit = {
    status: upstreamStatus || response.status,
    statusText: upstreamStatus >= 200 ? undefined : 'Upstream Error',
    headers: upstreamHeaders as Record<string, string>,
  };

  const reconstructed = new Response(response.body, responseInit);

  if (stream) {
    (reconstructed as any)._wreqClose = () => {};
  }

  return reconstructed;
}

export async function disposeWreqWorker(): Promise<void> {
  if (workerProcess) {
    try {
      workerProcess.kill();
    } catch {}
  }
  workerProcess = null;
  workerBaseUrl = null;
  workerStartPromise = null;
}
