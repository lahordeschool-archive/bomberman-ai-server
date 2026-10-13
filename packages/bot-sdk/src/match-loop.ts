import {
  applyIntent,
  type GameEvent,
  type GameState,
  type Intent,
  OBSERVATION_INTERVAL_TICKS,
  type RecordedIntent,
  step,
  TICK_MS,
} from '@bomberman/game-engine';
import { parseAction } from './actions.ts';
import { buildObservation, type Observation } from './observation.ts';

/**
 * Time a bot has to answer an observation in a real-time match: the decision
 * interval (250 ms) minus a small margin. Later answers are dropped and the player
 * skips that turn; the game never waits for a bot.
 */
export const DECISION_BUDGET_MS = OBSERVATION_INTERVAL_TICKS * TICK_MS - 10;

export interface BotController {
  /** Returns the raw action (string or object) for this observation. */
  decide(observation: Observation, signal: AbortSignal, budgetMs: number): Promise<unknown>;
  dispose?(): void | Promise<void>;
}

export interface RunMatchOptions {
  state: GameState;
  /** Indexed by player id. `null` slots stay idle. */
  controllers: readonly (BotController | null)[];
  /**
   * Real-time pacing per tick. With pacing, decisions are applied on the tick they
   * arrive and never delay the game. 0 runs as fast as possible in lockstep: every
   * tick waits for the bots' answers (offline simulations and tests).
   */
  tickMs: number;
  /** Decisions arriving later than this are dropped (the player skips the turn). */
  decisionTimeoutMs: number;
  signal?: AbortSignal;
  onTick?(state: GameState, events: GameEvent[]): void;
  onDecision?(record: RecordedIntent, raw: unknown): void;
  onDecisionError?(playerId: number, error: unknown): void;
}

export interface RunMatchOutcome {
  state: GameState;
  intents: RecordedIntent[];
}

export class DecisionTimeoutError extends Error {
  constructor() {
    super('Decision timed out');
    this.name = 'DecisionTimeoutError';
  }
}

type Decision = { intent: Intent; raw: unknown } | null;

interface PendingDecision {
  playerId: number;
  deadline: number;
  abort: AbortController;
  settled: Promise<void>;
  done: boolean;
  decision: Decision;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Drives a match: every decision interval it asks each living bot for an action and
 * steps the simulation. Accepted intents are recorded with the tick they were
 * applied at, so the returned log replays to the exact same final state with
 * `runReplay`.
 */
export async function runMatch(options: RunMatchOptions): Promise<RunMatchOutcome> {
  const { state, controllers, tickMs, decisionTimeoutMs, signal } = options;
  const intents: RecordedIntent[] = [];
  let pending: PendingDecision[] = [];
  let deadline = performance.now();

  const request = (playerId: number, controller: BotController): PendingDecision => {
    const abort = new AbortController();
    const entry: PendingDecision = {
      playerId,
      deadline: performance.now() + decisionTimeoutMs,
      abort,
      done: false,
      decision: null,
      settled: Promise.resolve(),
    };
    entry.settled = controller
      .decide(buildObservation(state, playerId), abort.signal, decisionTimeoutMs)
      .then(
        (raw) => {
          if (abort.signal.aborted) return;
          entry.decision = { intent: parseAction(raw), raw };
          entry.done = true;
        },
        (error: unknown) => {
          if (abort.signal.aborted) return;
          entry.done = true;
          options.onDecisionError?.(playerId, error);
        },
      );
    return entry;
  };

  const apply = (entry: PendingDecision) => {
    const { decision, playerId } = entry;
    const player = state.players[playerId]!;
    if (!decision || !player.alive) return;
    const isNoop = decision.intent.type === 'idle' && player.queuedMove === null;
    if (isNoop || !applyIntent(state, playerId, decision.intent)) return;
    const record = { tick: state.tick, playerId, intent: decision.intent };
    intents.push(record);
    options.onDecision?.(record, decision.raw);
  };

  /** Waits for unanswered requests until their deadline, then drops them. */
  const settle = async (entries: PendingDecision[]) => {
    await Promise.all(
      entries.map(async (entry) => {
        const remaining = entry.deadline - performance.now();
        if (!entry.done && remaining > 0) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            entry.settled,
            new Promise<void>((resolve) => (timer = setTimeout(resolve, remaining))),
          ]);
          clearTimeout(timer);
        }
        if (!entry.done) {
          entry.abort.abort();
          options.onDecisionError?.(entry.playerId, new DecisionTimeoutError());
        }
      }),
    );
  };

  const onAbort = () => pending.forEach((entry) => entry.abort.abort());
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (state.status === 'running') {
      signal?.throwIfAborted();
      if (state.tick % OBSERVATION_INTERVAL_TICKS === 0) {
        if (pending.length > 0) {
          await settle(pending);
          signal?.throwIfAborted();
          for (const entry of pending) if (entry.done) apply(entry);
        }
        pending = state.players.flatMap((player) => {
          const controller = controllers[player.id];
          return controller && player.alive ? [request(player.id, controller)] : [];
        });
        if (tickMs <= 0) {
          await settle(pending);
          signal?.throwIfAborted();
          for (const entry of pending) if (entry.done) apply(entry);
          pending = [];
        }
      }
      if (tickMs > 0) {
        const arrived = pending.filter((entry) => entry.done);
        if (arrived.length > 0) {
          for (const entry of arrived) apply(entry);
          pending = pending.filter((entry) => !entry.done);
        }
      }

      step(state);
      options.onTick?.(state, state.events);

      if (tickMs > 0) {
        deadline += tickMs;
        const wait = deadline - performance.now();
        if (wait > 0) await sleep(wait);
        else if (wait < -1000) deadline = performance.now();
      } else if (state.tick % 100 === 0) {
        await sleep(0);
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    onAbort();
  }
  return { state, intents };
}
