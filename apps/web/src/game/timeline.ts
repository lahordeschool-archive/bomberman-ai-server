import {
  createGame,
  hashState,
  runReplay,
  type Snapshot,
  toSnapshot,
} from '@bomberman/game-engine';
import { decodeIntent, type ReplayResponse } from '@bomberman/protocol';

export interface ReplayTimeline {
  snapshots: Snapshot[];
  maxTicks: number;
  verified: boolean;
  computedHash: string;
}

/** Re-simulates a ranked match locally from its seed and intent log, then checks the hash. */
export function buildTimeline(replay: ReplayResponse): ReplayTimeline {
  const initial = createGame({
    engineVersion: replay.engineVersion,
    seed: replay.seed,
    playerCount: replay.playerCount,
    settings: replay.settings,
  });
  const snapshots: Snapshot[] = [toSnapshot(initial, [])];
  const final = runReplay(
    {
      engineVersion: replay.engineVersion,
      seed: replay.seed,
      playerCount: replay.playerCount,
      settings: replay.settings,
      intents: replay.intents.map(([tick, playerId, code]) => ({
        tick,
        playerId,
        intent: decodeIntent(code),
      })),
    },
    (state) => snapshots.push(toSnapshot(state)),
  );
  const computedHash = hashState(final);
  return {
    snapshots,
    maxTicks: replay.settings.maxTicks,
    verified: computedHash === replay.finalHash,
    computedHash,
  };
}
