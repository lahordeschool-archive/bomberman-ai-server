import {
  BOT_HARNESS,
  BOT_TRAILER,
  type BotLogLine,
  DECISION_BUDGET_MS,
  FetchQuota,
  type HostFetchResult,
  MAX_BOT_SOURCE_BYTES,
  type Observation,
  parseHarnessOutput,
} from '@bomberman/bot-sdk';
import { TICK_MS } from '@bomberman/game-engine';
import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSRuntime,
  type QuickJSWASMModule,
  shouldInterruptAfterDeadline,
} from 'quickjs-emscripten';
import type { Egress } from './egress.ts';

export interface SandboxLimits {
  memoryBytes: number;
  stackBytes: number;
  loadTimeoutMs: number;
  /** CPU budget of every synchronous run of bot code (a call, or a batch of callbacks). */
  callTimeoutMs: number;
  /** Wall-clock time a decision may take, including awaited requests. */
  decisionBudgetMs: number;
  /** A bot that crashes or burns its CPU budget this many times in a row is disabled. */
  maxConsecutiveFailures: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 512 * 1024,
  loadTimeoutMs: 1000,
  callTimeoutMs: 100,
  decisionBudgetMs: DECISION_BUDGET_MS,
  maxConsecutiveFailures: 20,
};

export interface SandboxActResult {
  /** Raw action produced by the bot; validated by the caller with `parseAction`. */
  action: unknown;
  error: string | null;
  /** The bot exceeded its CPU budget or did not answer within the decision budget. */
  timedOut: boolean;
  /** The bot was still waiting (for example on a request) when the budget ran out. */
  late: boolean;
  disabled: boolean;
  logs: BotLogLine[];
  durationMs: number;
}

export class BotLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BotLoadError';
  }
}

let modulePromise: Promise<QuickJSWASMModule> | undefined;
function quickjs(): Promise<QuickJSWASMModule> {
  modulePromise ??= getQuickJS();
  return modulePromise;
}

interface Waiter {
  wake(): void;
  superseded: boolean;
}

/**
 * One bot = one QuickJS runtime with its own heap limit, stack limit, and CPU
 * deadline. The runtime has only ECMAScript built-ins plus the harness: no
 * filesystem, timers, or host objects. Network access is a host `fetch` that goes
 * through the runner's egress policy and the per-bot request quota.
 */
export class QuickJsBot {
  private disposed = false;
  private failures = 0;
  private fault: string | null = null;
  private waiter: Waiter | null = null;
  private readonly runtime: QuickJSRuntime;
  private readonly context: QuickJSContext;
  private readonly limits: SandboxLimits;
  private readonly deferreds = new Set<QuickJSDeferredPromise>();
  private readonly quota = new FetchQuota();
  private readonly requests = new AbortController();

  private constructor(runtime: QuickJSRuntime, context: QuickJSContext, limits: SandboxLimits) {
    this.runtime = runtime;
    this.context = context;
    this.limits = limits;
  }

  static async create(
    source: string,
    seed: number,
    limits: SandboxLimits = DEFAULT_LIMITS,
    egress?: Egress,
  ): Promise<QuickJsBot> {
    if (Buffer.byteLength(source, 'utf8') > MAX_BOT_SOURCE_BYTES) {
      throw new BotLoadError(`Bot source exceeds ${MAX_BOT_SOURCE_BYTES} bytes`);
    }
    const module = await quickjs();
    const runtime = module.newRuntime();
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(limits.stackBytes);
    const context = runtime.newContext();
    const bot = new QuickJsBot(runtime, context, limits);
    try {
      if (egress) bot.installFetch(egress);
      bot.evaluate(BOT_HARNESS, 'harness.js', limits.loadTimeoutMs);
      bot.evaluate(source + BOT_TRAILER, 'bot.js', limits.loadTimeoutMs);
      bot.evaluate(`__bomber.seed(${seed >>> 0})`, 'seed.js', limits.loadTimeoutMs);
      const hasGameLoop = bot.evaluate(
        'typeof __bomberResolve() === "function"',
        'check.js',
        limits.loadTimeoutMs,
      );
      if (hasGameLoop !== true) throw new BotLoadError('Your bot must define a gameLoop function');
      bot.pump();
    } catch (error) {
      bot.dispose();
      if (error instanceof BotLoadError) throw error;
      throw new BotLoadError(error instanceof Error ? error.message : String(error));
    }
    return bot;
  }

  private installFetch(egress: Egress): void {
    const hostFetch = this.context.newFunction('__bomberHostFetch', (urlHandle, initHandle) => {
      const url = this.context.getString(urlHandle);
      const init = this.context.getString(initHandle);
      const deferred = this.context.newPromise();
      this.deferreds.add(deferred);
      const denied = this.quota.acquire();
      const work: Promise<HostFetchResult> = denied
        ? Promise.resolve({ error: denied })
        : egress.fetch(url, init, this.requests.signal).finally(() => this.quota.release());
      void work.then((result) => {
        if (this.disposed || !this.deferreds.delete(deferred)) return;
        const value = this.context.newString(JSON.stringify(result));
        deferred.resolve(value);
        value.dispose();
        deferred.dispose();
        this.pump();
      });
      return deferred.handle;
    });
    this.context.setProp(this.context.global, '__bomberHostFetch', hostFetch);
    hostFetch.dispose();
  }

  private evaluate(code: string, filename: string, timeoutMs: number): unknown {
    this.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));
    const result = this.context.evalCode(code, filename, { type: 'global' });
    if (result.error) {
      const error = this.context.dump(result.error) as unknown;
      result.error.dispose();
      throw new BotLoadError(describeVmError(error));
    }
    const value = this.context.dump(result.value) as unknown;
    result.value.dispose();
    return value;
  }

  /** Runs queued promise callbacks under the CPU budget, then wakes a waiting decision. */
  private pump(): void {
    if (this.disposed) return;
    this.runtime.setInterruptHandler(
      shouldInterruptAfterDeadline(Date.now() + this.limits.callTimeoutMs),
    );
    const jobs = this.runtime.executePendingJobs();
    if (jobs.error) {
      const error = describeVmError(this.context.dump(jobs.error) as unknown);
      jobs.error.dispose();
      this.fault = /interrupted/i.test(error)
        ? `Exceeded the ${this.limits.callTimeoutMs} ms CPU budget`
        : error;
      this.failures++;
      if (/out of memory/i.test(error)) this.failures = this.limits.maxConsecutiveFailures;
    }
    if (this.waiter && (this.fault || this.isDone())) this.waiter.wake();
  }

  private isDone(): boolean {
    try {
      return this.evaluate('__bomber.done()', 'done.js', this.limits.callTimeoutMs) === true;
    } catch {
      return false;
    }
  }

  private get isDisabled(): boolean {
    return this.disposed || this.failures >= this.limits.maxConsecutiveFailures;
  }

  async act(
    observation: Observation,
    budgetMs: number = this.limits.decisionBudgetMs,
  ): Promise<SandboxActResult> {
    const started = performance.now();
    const base = { action: null, logs: [], late: false };
    const elapsed = () => performance.now() - started;
    if (this.isDisabled) {
      return {
        ...base,
        error: 'Bot disabled after repeated failures',
        timedOut: false,
        disabled: true,
        durationMs: 0,
      };
    }
    if (this.waiter) {
      this.waiter.superseded = true;
      this.waiter.wake();
    }
    this.fault = null;
    try {
      const json = JSON.stringify(JSON.stringify(observation));
      this.evaluate(
        `__bomber.call(${json}, ${observation.tick * TICK_MS})`,
        'call.js',
        this.limits.callTimeoutMs,
      );
      this.pump();
      if (!this.fault && !this.isDone()) {
        const waiter: Waiter = { wake: () => undefined, superseded: false };
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => waiter.wake(), Math.max(0, budgetMs - elapsed()));
          waiter.wake = () => {
            clearTimeout(timer);
            if (this.waiter === waiter) this.waiter = null;
            resolve();
          };
          this.waiter = waiter;
        });
        if (waiter.superseded || this.disposed) {
          return {
            ...base,
            error: 'Superseded by a newer observation',
            timedOut: true,
            late: true,
            disabled: this.isDisabled,
            durationMs: elapsed(),
          };
        }
      }
      if (this.fault) throw new BotLoadError(this.fault);
      const output = parseHarnessOutput(
        String(this.evaluate('__bomber.read()', 'read.js', this.limits.callTimeoutMs)),
      );
      if (!output.done) {
        return {
          ...base,
          logs: output.logs,
          error: `No decision within ${Math.round(budgetMs)} ms: turn skipped`,
          timedOut: true,
          late: true,
          disabled: false,
          durationMs: elapsed(),
        };
      }
      this.failures = output.error ? this.failures + 1 : 0;
      if (output.error && /out of memory/i.test(output.error)) {
        this.failures = this.limits.maxConsecutiveFailures;
      }
      return {
        action: output.error ? null : output.result,
        error: output.error,
        timedOut: false,
        late: false,
        disabled: this.isDisabled,
        logs: output.logs,
        durationMs: elapsed(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = /interrupted|CPU budget/i.test(message);
      if (!this.fault) this.failures++;
      if (/out of memory/i.test(message)) this.failures = this.limits.maxConsecutiveFailures;
      return {
        ...base,
        error: timedOut ? `Exceeded the ${this.limits.callTimeoutMs} ms CPU budget` : message,
        timedOut,
        disabled: this.isDisabled,
        durationMs: elapsed(),
      };
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.requests.abort();
    this.waiter?.wake();
    try {
      for (const deferred of this.deferreds) deferred.dispose();
      this.deferreds.clear();
      this.context.dispose();
      this.runtime.dispose();
    } catch {
      // A runtime that ran out of memory may refuse to free cleanly; it is dropped anyway.
    }
  }
}

function describeVmError(error: unknown): string {
  if (error && typeof error === 'object') {
    const { name, message } = error as { name?: unknown; message?: unknown };
    if (typeof message === 'string')
      return `${typeof name === 'string' ? name : 'Error'}: ${message}`;
  }
  return String(error);
}
