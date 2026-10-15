import {
  applyIntent,
  type GameEvent,
  type GameState,
  type Intent,
  OBSERVATION_INTERVAL_TICKS,
  type RecordedIntent,
  step,
  TICK_MS,
  turnTicks,
} from '@bomberman/game-engine';
import { parseAction } from './actions.ts';
import { buildObservation, type Observation } from './observation.ts';

/**
 * Longest time a bot has to answer an observation in a real-time match; turns
 * shorter than 250 ms (roller skates) leave less, see `turnBudgetMs`. Later answers
 * are dropped and the player skips that turn; the game never waits for a bot.
 */
export const DECISION_BUDGET_MS = OBSERVATION_INTERVAL_TICKS * TICK_MS - 10;

/** Answer budget for a turn of `ticks` ticks: shorter turns leave less time. */
export function turnBudgetMs(ticks: number, tickMs: number = TICK_MS): number {
  return Math.max(10, ticks * tickMs - 10);
}

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
  /**
   * Decisions arriving later than this are dropped (the player skips the turn). In
   * real time, faster players get less: the budget never exceeds their turn.
   */
  decisionTimeoutMs: number;
  signal?: AbortSignal;
  onTick?(state: GameState, events: GameEvent[]): void;
  onDecision?(record: RecordedIntent, raw: unknown): void;
  /** Every answer that arrived in time, including idle ones that record no intent. */
  onRawDecision?(playerId: number, raw: unknown): void;
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
 * Drives a match: on each player's turn (every `turnTicks(speed)` ticks) it asks
 * that bot for an action, and steps the simulation. Accepted intents are recorded with the tick they were
 * applied at, so the returned log replays to the exact same final state with
 * `runReplay`.
 */
export async function runMatch(options: RunMatchOptions): Promise<RunMatchOutcome> {
  const { state, controllers, tickMs, decisionTimeoutMs, signal } = options;
  const intents: RecordedIntent[] = [];
  let pending: PendingDecision[] = [];
  let deadline = performance.now();

  const request = (
    playerId: number,
    controller: BotController,
    budgetMs: number,
  ): PendingDecision => {
    const abort = new AbortController();
    const entry: PendingDecision = {
      playerId,
      deadline: performance.now() + budgetMs,
      abort,
      done: false,
      decision: null,
      settled: Promise.resolve(),
    };
    entry.settled = controller
      .decide(buildObservation(state, playerId), abort.signal, budgetMs)
      .then(
        (raw) => {
          if (abort.signal.aborted) return;
          entry.decision = { intent: parseAction(raw), raw };
          entry.done = true;
          try {
            options.onRawDecision?.(playerId, raw);
          } catch {
            // Side channels never affect the match.
          }
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
  /** Tick of each player's next turn; the interval follows their current speed. */
  const nextTurn = state.players.map(() => 0);
  try {
    while (state.status === 'running') {
      signal?.throwIfAborted();
      const due = state.players.filter(
        (player) => player.alive && controllers[player.id] && state.tick >= nextTurn[player.id]!,
      );
      if (due.length > 0) {
        const dueIds = new Set(due.map((player) => player.id));
        const previous = pending.filter((entry) => dueIds.has(entry.playerId));
        if (previous.length > 0) {
          await settle(previous);
          signal?.throwIfAborted();
          for (const entry of previous) if (entry.done) apply(entry);
          pending = pending.filter((entry) => !dueIds.has(entry.playerId));
        }
        const fresh = due.map((player) => {
          const ticks = turnTicks(player.speed, state.engineVersion);
          nextTurn[player.id] = state.tick + ticks;
          const budgetMs =
            tickMs > 0
              ? Math.min(decisionTimeoutMs, turnBudgetMs(ticks, tickMs))
              : decisionTimeoutMs;
          return request(player.id, controllers[player.id]!, budgetMs);
        });
        if (tickMs <= 0) {
          await settle(fresh);
          signal?.throwIfAborted();
          for (const entry of fresh) if (entry.done) apply(entry);
        } else {
          pending.push(...fresh);
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
