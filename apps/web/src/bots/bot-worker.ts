/// <reference lib="webworker" />
import {
  BOT_HARNESS,
  BOT_TRAILER,
  checkFetchRequest,
  FETCH_LIMITS,
  FetchQuota,
  type HostFetchResult,
  parseFetchRequest,
  readLimitedText,
  responseHeaders,
} from '@bomberman/bot-sdk';

export type WorkerInbound =
  | { type: 'load'; source: string; seed: number }
  | { type: 'act'; id: number; observation: unknown; now: number };

export type WorkerOutbound =
  | { type: 'loaded' }
  | { type: 'loadError'; error: string }
  /** The synchronous part of gameLoop returned: the worker is free again. */
  | { type: 'ack'; id: number; syncMs: number }
  | { type: 'result'; id: number; output: string; durationMs: number };

interface HarnessApi {
  seed(seed: number): void;
  onSettle(fn: () => void): void;
  call(json: string, now: number): void;
  read(): string;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = scope.postMessage.bind(scope) as (message: WorkerOutbound) => void;
const nativeFetch = scope.fetch.bind(scope);
const now = performance.now.bind(performance);
const evaluate = eval;
/** Indirect eval: bot code runs as a global script, exactly like the server sandbox. */
const globalEval = (code: string): unknown => evaluate(code);
const quota = new FetchQuota();
let api: HarnessApi | null = null;
let current: { id: number; started: number } | null = null;

/**
 * Bot code gets the same capabilities as on the server: the harness `fetch` (backed
 * by `hostFetch` below, with the same limits) and nothing else. No storage, timers,
 * sockets, or messaging.
 */
const BLOCKED_GLOBALS = [
  'XMLHttpRequest',
  'WebSocket',
  'WebSocketStream',
  'EventSource',
  'WebTransport',
  'importScripts',
  'indexedDB',
  'caches',
  'BroadcastChannel',
  'Worker',
  'SharedWorker',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'postMessage',
  'close',
];

function lockdown(): void {
  for (const name of BLOCKED_GLOBALS) {
    try {
      Object.defineProperty(scope, name, {
        value: undefined,
        writable: false,
        configurable: false,
      });
    } catch {
      // Some engines expose non configurable globals; they stay reachable but unused.
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function browserFetch(url: string, requestJson: string): Promise<HostFetchResult> {
  const request = parseFetchRequest(requestJson);
  if (!request) return { error: 'Invalid fetch request' };
  const problem = checkFetchRequest(url, request);
  if (problem) return { error: problem };
  const denied = quota.acquire();
  if (denied) return { error: denied };
  try {
    const response = await nativeFetch(url, {
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      credentials: 'omit',
      mode: 'cors',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(FETCH_LIMITS.timeoutMs),
    });
    const body =
      request.method === 'HEAD'
        ? ''
        : await readLimitedText(response, FETCH_LIMITS.maxResponseBytes);
    return {
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      redirected: response.redirected,
      headers: responseHeaders(response.headers),
      body,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return { error: `Request timed out after ${FETCH_LIMITS.timeoutMs} ms` };
    }
    if (error instanceof TypeError) {
      return {
        error:
          'Request failed. In the browser the API must allow cross-origin requests (CORS); ranked matches run on the server and are not limited by CORS.',
      };
    }
    return { error: describe(error) };
  } finally {
    quota.release();
  }
}

const hostFetch = (url: string, requestJson: string): Promise<string> =>
  browserFetch(url, requestJson).then((result) => JSON.stringify(result));

scope.addEventListener('message', (event: MessageEvent<WorkerInbound>) => {
  const message = event.data;
  if (message.type === 'load') {
    try {
      (globalThis as unknown as { __bomberHostFetch: typeof hostFetch }).__bomberHostFetch =
        hostFetch;
      globalEval(BOT_HARNESS);
      lockdown();
      api = (globalThis as unknown as { __bomber: HarnessApi }).__bomber;
      api.onSettle(() => {
        const call = current;
        if (!call || !api) return;
        current = null;
        post({ type: 'result', id: call.id, output: api.read(), durationMs: now() - call.started });
      });
      globalEval(message.source + BOT_TRAILER);
      api.seed(message.seed);
      const resolve = (globalThis as unknown as { __bomberResolve: () => unknown }).__bomberResolve;
      if (typeof resolve() !== 'function')
        throw new Error('Your bot must define a gameLoop function');
      post({ type: 'loaded' });
    } catch (error) {
      post({ type: 'loadError', error: describe(error) });
    }
    return;
  }
  if (message.type === 'act' && api) {
    const started = now();
    current = { id: message.id, started };
    api.call(JSON.stringify(message.observation), message.now);
    post({ type: 'ack', id: message.id, syncMs: now() - started });
  }
});
