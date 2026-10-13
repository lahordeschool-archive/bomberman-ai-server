import variant from '@jitl/quickjs-wasmfile-release-sync';
import {
  BOT_HARNESS,
  BOT_TRAILER,
  type BotController,
  DECISION_BUDGET_MS,
  type Observation,
  parseHarnessOutput,
} from '@bomberman/bot-sdk';
import { TICK_MS } from '@bomberman/game-engine';
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSRuntime,
  type QuickJSWASMModule,
  shouldInterruptAfterDeadline,
} from 'quickjs-emscripten-core';
import { SLOW_DECISION_MS, type WorkerBotEvents } from './worker-bot.ts';

/** Same limits as the ranked sandbox on the server. */
const MEMORY_BYTES = 32 * 1024 * 1024;
const STACK_BYTES = 512 * 1024;
const LOAD_TIMEOUT_MS = 1000;
const CALL_TIMEOUT_MS = 100;
const LATE_WARNING_INTERVAL_MS = 3000;
const NO_FETCH =
  'fetch() is unavailable here: this browser blocks Web Workers, so local bots run in a fallback sandbox without network access. Try Chrome or Safari; ranked matches run on the server and can fetch.';

let modulePromise: Promise<QuickJSWASMModule> | undefined;
function quickjs(): Promise<QuickJSWASMModule> {
  modulePromise ??= newQuickJSWASMModuleFromVariant(variant);
  return modulePromise;
}

function describe(error: unknown): string {
  if (error && typeof error === 'object') {
    const { name, message } = error as { name?: unknown; message?: unknown };
    if (typeof message === 'string')
      return `${typeof name === 'string' ? name : 'Error'}: ${message}`;
  }
  return String(error);
}

/**
 * Fallback for browsers where Web Workers never start: the bot runs in QuickJS on the
 * page itself, the same interpreter and CPU budget as ranked matches. The interrupt
 * handler stops runaway code, so an infinite loop cannot freeze the page.
 */
export class QuickJsBot implements BotController {
  private stopped: string | null = null;
  private lastLateWarning = -Infinity;
  private readonly runtime: QuickJSRuntime;
  private readonly context: QuickJSContext;
  private readonly events: WorkerBotEvents;

  private constructor(runtime: QuickJSRuntime, context: QuickJSContext, events: WorkerBotEvents) {
    this.runtime = runtime;
    this.context = context;
    this.events = events;
  }

  static async create(
    source: string,
    seed: number,
    events: WorkerBotEvents = {},
  ): Promise<QuickJsBot> {
    const runtime = (await quickjs()).newRuntime();
    runtime.setMemoryLimit(MEMORY_BYTES);
    runtime.setMaxStackSize(STACK_BYTES);
    const bot = new QuickJsBot(runtime, runtime.newContext(), events);
    try {
      bot.evaluate(BOT_HARNESS, LOAD_TIMEOUT_MS);
      bot.evaluate(
        `globalThis.fetch = function () { return Promise.reject(new TypeError(${JSON.stringify(NO_FETCH)})); };`,
        LOAD_TIMEOUT_MS,
      );
      bot.evaluate(source + BOT_TRAILER, LOAD_TIMEOUT_MS);
      bot.evaluate(`__bomber.seed(${seed >>> 0})`, LOAD_TIMEOUT_MS);
      if (bot.evaluate('typeof __bomberResolve() === "function"', LOAD_TIMEOUT_MS) !== true) {
        throw new Error('Your bot must define a gameLoop function');
      }
      bot.pump();
    } catch (error) {
      bot.dispose();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        /interrupted/i.test(message)
          ? `Your bot took more than ${LOAD_TIMEOUT_MS} ms to load`
          : message,
        { cause: error },
      );
    }
    return bot;
  }

  private evaluate(code: string, timeoutMs: number): unknown {
    this.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));
    const result = this.context.evalCode(code, 'bot.js', { type: 'global' });
    if (result.error) {
      const error = this.context.dump(result.error) as unknown;
      result.error.dispose();
      throw new Error(describe(error));
    }
    const value = this.context.dump(result.value) as unknown;
    result.value.dispose();
    return value;
  }

  /** Runs the promise callbacks queued by the bot (async gameLoops) under the CPU budget. */
  private pump(): void {
    this.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + CALL_TIMEOUT_MS));
    const jobs = this.runtime.executePendingJobs();
    if (jobs.error) {
      const error = describe(this.context.dump(jobs.error) as unknown);
      jobs.error.dispose();
      throw new Error(error);
    }
  }

  private late(durationMs: number | null, tick: number): void {
    const time = performance.now();
    if (time - this.lastLateWarning < LATE_WARNING_INTERVAL_MS) return;
    this.lastLateWarning = time;
    this.events.onLate?.(durationMs, { tick });
  }

  async decide(
    observation: Observation,
    _signal?: AbortSignal,
    _budgetMs: number = DECISION_BUDGET_MS,
  ): Promise<unknown> {
    if (this.stopped) throw new Error(this.stopped);
    const context = { tick: observation.tick };
    const started = performance.now();
    let output;
    try {
      const json = JSON.stringify(JSON.stringify(observation));
      this.evaluate(`__bomber.call(${json}, ${observation.tick * TICK_MS})`, CALL_TIMEOUT_MS);
      this.pump();
      output = parseHarnessOutput(String(this.evaluate('__bomber.read()', CALL_TIMEOUT_MS)));
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const message = /interrupted/i.test(raw)
        ? `Exceeded the ${CALL_TIMEOUT_MS} ms CPU budget: that turn was skipped`
        : raw;
      if (/out of memory/i.test(raw)) this.stopped = `Stopped: ${raw}`;
      this.events.onError?.(message, context);
      throw new Error(message, { cause: error });
    }
    const syncMs = performance.now() - started;
    if (syncMs > SLOW_DECISION_MS) this.events.onSlow?.(syncMs, context);
    if (output.logs.length > 0) this.events.onLogs?.(output.logs, context);
    if (output.error) {
      this.events.onError?.(output.error, context);
      throw new Error(output.error);
    }
    if (!output.done) {
      // Nothing outside the bot can settle its promises here (no fetch), so it never will.
      this.late(null, observation.tick);
      throw new Error('No decision before the next turn');
    }
    return output.result;
  }

  dispose(): void {
    if (this.stopped === 'Stopped') return;
    this.stopped = 'Stopped';
    try {
      this.context.dispose();
      this.runtime.dispose();
    } catch {
      // A runtime that ran out of memory may refuse to free cleanly; it is dropped anyway.
    }
  }
}
