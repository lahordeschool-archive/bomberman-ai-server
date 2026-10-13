import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { Observation } from '@bomberman/bot-sdk';
import { DEFAULT_EGRESS, type EgressPolicy } from './egress.ts';
import type { SandboxActResult, SandboxLimits } from './sandbox.ts';
import type { WorkerRequest, WorkerResponse } from './worker.ts';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RequestBody = DistributiveOmit<WorkerRequest, 'id'>;

interface Slot {
  worker: Worker;
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  sessions: Set<string>;
}

interface SessionInfo {
  slot: Slot;
  lastUsed: number;
}

/**
 * Spreads bot sessions across worker threads so a bot burning its CPU budget only
 * delays bots on the same thread, and a crashed WebAssembly heap only loses the
 * sessions of one worker.
 */
export class SandboxPool {
  private readonly slots: Slot[] = [];
  private readonly sessions = new Map<string, SessionInfo>();
  private nextRequestId = 1;
  private nextSlot = 0;
  private closing = false;
  private readonly limits: SandboxLimits;
  private readonly egress: EgressPolicy;
  private readonly maxSessions: number;

  constructor(
    size: number,
    limits: SandboxLimits,
    maxSessions: number,
    egress: EgressPolicy = DEFAULT_EGRESS,
  ) {
    this.limits = limits;
    this.egress = egress;
    this.maxSessions = maxSessions;
    for (let index = 0; index < size; index++) this.slots.push(this.spawn());
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  private spawn(): Slot {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      workerData: { limits: this.limits, egress: this.egress },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    const slot: Slot = { worker, pending: new Map(), sessions: new Set() };
    worker.on('message', (response: WorkerResponse) => {
      const pending = slot.pending.get(response.id);
      if (!pending) return;
      slot.pending.delete(response.id);
      if (response.ok) pending.resolve(response.data);
      else pending.reject(new Error(response.error));
    });
    worker.on('error', () => undefined);
    worker.on('exit', () => {
      for (const pending of slot.pending.values())
        pending.reject(new Error('Sandbox worker crashed'));
      slot.pending.clear();
      for (const sessionId of slot.sessions) this.sessions.delete(sessionId);
      if (this.closing) return;
      const index = this.slots.indexOf(slot);
      if (index >= 0) this.slots[index] = this.spawn();
    });
    return slot;
  }

  private send<T>(slot: Slot, body: RequestBody): Promise<T> {
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      slot.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      slot.worker.postMessage({ ...body, id });
    });
  }

  private pickSlot(): Slot {
    const slot = this.slots[this.nextSlot % this.slots.length]!;
    this.nextSlot++;
    return slot;
  }

  async validate(source: string): Promise<{ action: unknown; durationMs: number }> {
    return this.send(this.pickSlot(), { op: 'validate', source });
  }

  async create(source: string, seed: number): Promise<string> {
    if (this.sessions.size >= this.maxSessions) throw new Error('Runner is at capacity');
    const slot = this.pickSlot();
    const sessionId = randomUUID();
    await this.send(slot, { op: 'create', sessionId, source, seed });
    slot.sessions.add(sessionId);
    this.sessions.set(sessionId, { slot, lastUsed: Date.now() });
    return sessionId;
  }

  async act(
    sessionId: string,
    observation: Observation,
    budgetMs: number = this.limits.decisionBudgetMs,
  ): Promise<SandboxActResult> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Unknown session');
    session.lastUsed = Date.now();
    return this.send(session.slot, { op: 'act', sessionId, observation, budgetMs });
  }

  async dispose(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.slot.sessions.delete(sessionId);
    await this.send(session.slot, { op: 'dispose', sessionId }).catch(() => undefined);
  }

  async disposeIdle(maxIdleMs: number): Promise<number> {
    const now = Date.now();
    const idle = [...this.sessions].filter(([, info]) => now - info.lastUsed > maxIdleMs);
    await Promise.all(idle.map(([sessionId]) => this.dispose(sessionId)));
    return idle.length;
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all(this.slots.map((slot) => slot.worker.terminate()));
  }
}
