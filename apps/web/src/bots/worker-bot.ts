import {
  type BotController,
  type BotLogLine,
  DECISION_BUDGET_MS,
  type Observation,
  parseHarnessOutput,
} from '@bomberman/bot-sdk';
import { TICK_MS } from '@bomberman/game-engine';
import { reloadForStaleChunk } from '../components/ErrorBoundary.tsx';
import type { WorkerInbound, WorkerOutbound } from './bot-worker.ts';

/** The server sandbox is slower than your browser; warn well before its 100 ms CPU budget. */
export const SLOW_DECISION_MS = 25;
/** A worker whose synchronous code runs this long is terminated until restarted. */
const HARD_LIMIT_MS = 1500;
/** A worker that has not run its script by then is considered blocked by the browser. */
const WORKER_START_MS = 3000;
/** Time the bot's own top-level code gets once the worker runs. */
const LOAD_TIMEOUT_MS = 3000;
/** Late-turn warnings are throttled so a slow bot does not flood the console. */
const LATE_WARNING_INTERVAL_MS = 3000;

export interface WorkerBotEvents {
  onLogs?(logs: BotLogLine[], context: { tick: number }): void;
  onError?(message: string, context: { tick: number }): void;
  onSlow?(durationMs: number, context: { tick: number }): void;
  /** The decision missed its budget (or never came): the player skipped that turn. */
  onLate?(durationMs: number | null, context: { tick: number }): void;
}

/**
 * Bot code errors are reported by the worker itself, so a worker that never starts usually
 * means a newer build deleted its script (some browsers then fire no error event at all).
 * The bundle embedding the worker URL is gone too in that case.
 */
async function reloadIfRebuilt(): Promise<void> {
  const response = await fetch(import.meta.url, { method: 'HEAD', cache: 'no-store' }).catch(
    () => null,
  );
  if (response?.status === 404) reloadForStaleChunk();
}

/** The browser never ran the worker script (blocked, paused by a debugger, or deleted). */
export class WorkerStartError extends Error {
  constructor() {
    super('Web Workers did not start in this browser');
    this.name = 'WorkerStartError';
  }
}

interface PendingCall {
  acked: boolean;
  onAck(syncMs: number): void;
  onResult(message: Extract<WorkerOutbound, { type: 'result' }>): void;
  cancel(): void;
}

export class WorkerBot implements BotController {
  private worker: Worker;
  private nextId = 1;
  private stopped: string | null = null;
  private lastLateWarning = -Infinity;
  private readonly pending = new Map<number, PendingCall>();
  private readonly events: WorkerBotEvents;

  private constructor(worker: Worker, events: WorkerBotEvents) {
    this.worker = worker;
    this.events = events;
    worker.addEventListener('message', (event: MessageEvent<WorkerOutbound>) => {
      const message = event.data;
      if (message.type === 'ack') this.pending.get(message.id)?.onAck(message.syncMs);
      if (message.type === 'result') {
        this.pending.get(message.id)?.onResult(message);
        this.pending.delete(message.id);
      }
    });
  }

  static create(source: string, seed: number, events: WorkerBotEvents = {}): Promise<WorkerBot> {
    const worker = new Worker(new URL('./bot-worker.ts', import.meta.url), {
      name: 'bot',
      type: 'module',
    });
    return new Promise((resolve, reject) => {
      let started = false;
      const fail = (error: Error) => {
        clearTimeout(timer);
        worker.terminate();
        reject(error);
      };
      let timer = setTimeout(() => {
        void reloadIfRebuilt();
        fail(new WorkerStartError());
      }, WORKER_START_MS);
      const onMessage = (event: MessageEvent<WorkerOutbound>) => {
        const message = event.data;
        if (message.type === 'ready') {
          started = true;
          clearTimeout(timer);
          timer = setTimeout(
            () => fail(new Error(`Your bot took more than ${LOAD_TIMEOUT_MS} ms to load`)),
            LOAD_TIMEOUT_MS,
          );
        } else if (message.type === 'loaded') {
          clearTimeout(timer);
          worker.removeEventListener('message', onMessage);
          resolve(new WorkerBot(worker, events));
        } else if (message.type === 'loadError') {
          fail(new Error(message.error));
        }
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', (event) => {
        if (!started) void reloadIfRebuilt();
        fail(
          started ? new Error(event.message || 'Your bot failed to load') : new WorkerStartError(),
        );
      });
      worker.postMessage({ type: 'load', source, seed } satisfies WorkerInbound);
    });
  }

  private late(durationMs: number | null, tick: number): void {
    const time = performance.now();
    if (time - this.lastLateWarning < LATE_WARNING_INTERVAL_MS) return;
    this.lastLateWarning = time;
    this.events.onLate?.(durationMs, { tick });
  }

  decide(
    observation: Observation,
    _signal?: AbortSignal,
    budgetMs: number = DECISION_BUDGET_MS,
  ): Promise<unknown> {
    if (this.stopped) return Promise.reject(new Error(this.stopped));
    if ([...this.pending.values()].some((previous) => !previous.acked)) {
      return Promise.reject(new Error('Still running the previous gameLoop'));
    }
    for (const [id, previous] of this.pending) {
      this.pending.delete(id);
      previous.cancel();
    }
    const id = this.nextId++;
    const context = { tick: observation.tick };
    return new Promise((resolve, reject) => {
      const watchdog = setTimeout(() => {
        this.pending.delete(id);
        this.stopped = `Stopped: gameLoop ran for more than ${HARD_LIMIT_MS} ms without returning`;
        this.worker.terminate();
        this.events.onError?.(this.stopped, context);
        reject(new Error(this.stopped));
      }, HARD_LIMIT_MS);
      const call: PendingCall = {
        acked: false,
        onAck: (syncMs) => {
          call.acked = true;
          clearTimeout(watchdog);
          if (syncMs > SLOW_DECISION_MS) this.events.onSlow?.(syncMs, context);
        },
        onResult: (message) => {
          clearTimeout(watchdog);
          const output = parseHarnessOutput(message.output);
          if (output.logs.length > 0) this.events.onLogs?.(output.logs, context);
          if (message.durationMs > budgetMs) this.late(message.durationMs, observation.tick);
          if (output.error) {
            this.events.onError?.(output.error, context);
            reject(new Error(output.error));
          } else resolve(output.result);
        },
        cancel: () => {
          clearTimeout(watchdog);
          this.late(null, observation.tick);
          reject(new Error('No decision before the next turn'));
        },
      };
      this.pending.set(id, call);
      this.worker.postMessage({
        type: 'act',
        id,
        observation,
        now: observation.tick * TICK_MS,
      } satisfies WorkerInbound);
    });
  }

  dispose(): void {
    this.stopped ??= 'Stopped';
    this.worker.terminate();
    this.pending.clear();
  }
}
