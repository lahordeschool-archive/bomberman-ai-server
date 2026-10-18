/**
 * Plain JavaScript evaluated inside every bot runtime (browser Web Worker and the
 * server QuickJS sandbox) before the bot source. It gives both runtimes identical
 * semantics: seeded `Math.random`, a clock frozen to the game tick, captured console
 * output, a `fetch` built on the host's `__bomberHostFetch(url, initJson)` primitive
 * (which resolves to a JSON string), and the `call` / `read` entry points of the host.
 *
 * Every `call` gets a new id: a promise from an earlier turn that settles late is
 * ignored, so it can never be taken for the current decision.
 */
export const BOT_HARNESS = String.raw`(function () {
  var g = globalThis;
  var RealDate = g.Date;
  var MAX_LOGS = 20;
  var MAX_LOG_LENGTH = 300;
  var state = {
    now: 0, rng: 1, logs: [], dropped: 0,
    id: 0, result: null, error: null, done: false, notify: null,
  };

  function random() {
    state.rng = (state.rng + 0x6d2b79f5) >>> 0;
    var t = state.rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  Math.random = random;

  class FixedDate extends RealDate {
    constructor() {
      if (arguments.length === 0) super(state.now);
      else super(...arguments);
    }
    static now() {
      return state.now;
    }
  }
  g.Date = FixedDate;
  if (g.performance && typeof g.performance === 'object') {
    try {
      Object.defineProperty(g.performance, 'now', { value: function () { return state.now; } });
    } catch (e) {}
  }

  function format(value) {
    if (typeof value === 'string') return value;
    try {
      var json = JSON.stringify(value);
      return json === undefined ? String(value) : json;
    } catch (e) {
      return String(value);
    }
  }
  function log(level) {
    return function () {
      if (state.logs.length >= MAX_LOGS) {
        state.dropped++;
        return;
      }
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(format(arguments[i]));
      state.logs.push({ level: level, message: parts.join(' ').slice(0, MAX_LOG_LENGTH) });
    };
  }
  g.console = { log: log('log'), info: log('info'), debug: log('log'), warn: log('warn'), error: log('error') };

  function describe(error) {
    if (error && typeof error === 'object' && 'message' in error) {
      return String(error.name || 'Error') + ': ' + String(error.message);
    }
    return String(error);
  }
  function normalize(value) {
    if (typeof value === 'string') return value.slice(0, 256);
    if (value && typeof value === 'object') {
      var normalized = {
        type: typeof value.type === 'string' ? value.type.slice(0, 16) : null,
        direction: typeof value.direction === 'string' ? value.direction.slice(0, 16) : null,
      };
      if (typeof value.say === 'string') normalized.say = value.say.slice(0, 256);
      if (typeof value.message === 'string') normalized.message = value.message.slice(0, 256);
      return normalized;
    }
    return null;
  }

  var hostFetch = g.__bomberHostFetch;
  try {
    delete g.__bomberHostFetch;
  } catch (e) {}
  if (typeof hostFetch === 'function') {
    var makeResponse = function (r) {
      var headers = r.headers || {};
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        statusText: r.statusText,
        url: r.url,
        redirected: r.redirected === true,
        headers: {
          get: function (name) {
            var value = headers[String(name).toLowerCase()];
            return value === undefined ? null : value;
          },
          has: function (name) {
            return headers[String(name).toLowerCase()] !== undefined;
          },
          forEach: function (fn) {
            Object.keys(headers).forEach(function (key) { fn(headers[key], key); });
          },
        },
        text: function () {
          return Promise.resolve(r.body);
        },
        json: function () {
          return new Promise(function (resolve) { resolve(JSON.parse(r.body)); });
        },
      };
    };
    var readHeaders = function (input) {
      var out = {};
      if (!input) return out;
      if (Array.isArray(input)) {
        input.forEach(function (pair) { out[String(pair[0])] = String(pair[1]); });
      } else if (typeof input.forEach === 'function') {
        input.forEach(function (value, key) { out[String(key)] = String(value); });
      } else {
        Object.keys(input).forEach(function (key) { out[key] = String(input[key]); });
      }
      return out;
    };
    g.fetch = function (input, init) {
      return new Promise(function (resolve, reject) {
        var options = init || {};
        var url = input && typeof input === 'object' && typeof input.url === 'string'
          ? input.url
          : String(input);
        var body = options.body === undefined || options.body === null ? null : options.body;
        if (body !== null && typeof body !== 'string') {
          throw new TypeError('fetch body must be a string, for example JSON.stringify(data)');
        }
        var request = JSON.stringify({
          method: String(options.method || 'GET').toUpperCase(),
          headers: readHeaders(options.headers),
          body: body,
        });
        hostFetch(url, request).then(function (json) {
          var response = JSON.parse(json);
          if (response.error) reject(new TypeError(response.error));
          else resolve(makeResponse(response));
        }, function (error) {
          reject(new TypeError(describe(error)));
        });
      });
    };
  }

  function settle(id, result, error) {
    if (id !== state.id) return;
    state.result = result;
    state.error = error;
    state.done = true;
    if (state.notify) state.notify();
  }

  Object.defineProperty(g, '__bomber', {
    value: {
      seed: function (seed) {
        state.rng = seed >>> 0;
      },
      onSettle: function (fn) {
        state.notify = fn;
      },
      call: function (json, now) {
        var id = ++state.id;
        state.result = null;
        state.error = null;
        state.done = false;
        state.now = now;
        var resolve = g.__bomberResolve;
        var fn = typeof resolve === 'function' ? resolve() : undefined;
        if (typeof fn !== 'function') {
          settle(id, null, 'ReferenceError: gameLoop is not defined');
          return;
        }
        var out;
        try {
          out = fn(JSON.parse(json));
        } catch (error) {
          settle(id, null, describe(error));
          return;
        }
        if (out && typeof out.then === 'function') {
          out.then(
            function (value) { settle(id, normalize(value), null); },
            function (error) { settle(id, null, describe(error)); },
          );
        } else {
          settle(id, normalize(out), null);
        }
      },
      done: function () {
        return state.done;
      },
      /** Returns the current decision and drains the logs written since the last read. */
      read: function () {
        var logs = state.logs;
        if (state.dropped > 0) {
          logs.push({ level: 'warn', message: state.dropped + ' more log lines dropped' });
        }
        state.logs = [];
        state.dropped = 0;
        return JSON.stringify({
          result: state.result,
          error: state.error,
          done: state.done,
          logs: logs,
        });
      },
    },
  });
})();
`;

/** Shape of the JSON string a host's `__bomberHostFetch` primitive resolves to. */
export type HostFetchResult =
  | { error: string }
  | {
      status: number;
      statusText: string;
      url: string;
      redirected: boolean;
      headers: Record<string, string>;
      body: string;
    };

export interface HostFetchRequest {
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/** Limits shared by the browser and the server so a bot behaves the same in both. */
export const FETCH_LIMITS = {
  timeoutMs: 5000,
  maxRequestBytes: 64 * 1024,
  maxResponseBytes: 256 * 1024,
  maxConcurrent: 4,
  maxRequestsPerMatch: 200,
  maxRedirects: 3,
  maxHeaders: 32,
} as const;

export const FETCH_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/** Hop-by-hop and connection-level headers a bot may not set. */
export const FORBIDDEN_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'proxy-authorization',
  'proxy-connection',
  'cookie',
]);

export function parseFetchRequest(json: string): HostFetchRequest | null {
  try {
    const value = JSON.parse(json) as Partial<HostFetchRequest>;
    const headers = value.headers && typeof value.headers === 'object' ? value.headers : {};
    return {
      method: typeof value.method === 'string' ? value.method : 'GET',
      headers: Object.fromEntries(
        Object.entries(headers).map(([key, header]) => [key, String(header).slice(0, 4096)]),
      ),
      body: typeof value.body === 'string' ? value.body : null,
    };
  } catch {
    return null;
  }
}

/** Validates a bot request the same way in every host; returns an error message or null. */
export function checkFetchRequest(url: string, request: HostFetchRequest): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Invalid URL: ${url.slice(0, 200)}`;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'Only http and https URLs can be fetched';
  }
  if (parsed.username || parsed.password) return 'URLs with credentials are not allowed';
  if (!FETCH_METHODS.includes(request.method)) return `Unsupported method ${request.method}`;
  const headers = Object.keys(request.headers);
  if (headers.length > FETCH_LIMITS.maxHeaders) return 'Too many request headers';
  for (const name of headers) {
    if (FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase())) return `Header ${name} is not allowed`;
  }
  if (
    request.body !== null &&
    new TextEncoder().encode(request.body).length > FETCH_LIMITS.maxRequestBytes
  ) {
    return `Request body exceeds ${FETCH_LIMITS.maxRequestBytes / 1024} KB`;
  }
  return null;
}

/** Reads a response body as text, failing once it exceeds the size limit. */
export async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get('content-length'));
  if (length > maxBytes) throw new Error(`Response exceeds ${maxBytes / 1024} KB`);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Response exceeds ${maxBytes / 1024} KB`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** Per-bot request budget: concurrent requests and total requests per match. */
export class FetchQuota {
  private active = 0;
  private total = 0;

  /** Returns an error message when the bot is over budget, otherwise reserves a slot. */
  acquire(): string | null {
    if (this.total >= FETCH_LIMITS.maxRequestsPerMatch) {
      return `Request limit reached (${FETCH_LIMITS.maxRequestsPerMatch} per match)`;
    }
    if (this.active >= FETCH_LIMITS.maxConcurrent) {
      return `Too many requests in flight (max ${FETCH_LIMITS.maxConcurrent})`;
    }
    this.active++;
    this.total++;
    return null;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
  }
}

export function responseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (key !== 'set-cookie') out[key] = value.slice(0, 2048);
  });
  return out;
}

/** Appended to the bot source, in the same script, so lexical `gameLoop` declarations resolve. */
export const BOT_TRAILER = `
;globalThis.__bomberResolve = function () {
  return typeof gameLoop === 'function' ? gameLoop : undefined;
};
`;

export interface BotLogLine {
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
}

export interface HarnessOutput {
  result: unknown;
  error: string | null;
  done: boolean;
  logs: BotLogLine[];
}

export function parseHarnessOutput(json: string): HarnessOutput {
  const parsed = JSON.parse(json) as Partial<HarnessOutput>;
  return {
    result: parsed.result ?? null,
    error: typeof parsed.error === 'string' ? parsed.error : null,
    done: parsed.done === true,
    logs: Array.isArray(parsed.logs) ? parsed.logs.slice(0, 25) : [],
  };
}

/** Per-bot seed so bots in the same match get independent but reproducible randomness. */
export function botSeed(matchSeed: number, playerId: number): number {
  return (Math.imul(matchSeed ^ 0x9e3779b9, 31) + playerId * 0x85ebca6b) >>> 0;
}

export const MAX_BOT_SOURCE_BYTES = 64 * 1024;
