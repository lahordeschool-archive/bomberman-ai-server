import { PLAYER_COLORS, type Snapshot, TICK_MS } from '@bomberman/game-engine';
import { Bomb, Fire, Lightning, Skull } from '@phosphor-icons/react';

export interface ScoreboardEntry {
  slot: number;
  name: string;
  detail?: string | null;
}

const SWATCHES: Record<(typeof PLAYER_COLORS)[number], string> = {
  white: '#E8E8E8',
  black: '#5B5B5B',
  blue: '#4D8DF7',
  red: '#F25555',
};

export function formatClock(ticks: number): string {
  const seconds = Math.max(0, Math.floor((ticks * TICK_MS) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function Scoreboard({
  snapshot,
  entries,
  maxTicks,
  mode = 'live',
}: {
  snapshot: Snapshot | null;
  entries: ScoreboardEntry[];
  maxTicks?: number;
  mode?: 'live' | 'replay' | 'idle';
}) {
  const label =
    snapshot?.status === 'finished'
      ? 'Final'
      : mode === 'replay'
        ? 'Replay'
        : mode === 'idle'
          ? 'Ready'
          : 'Live';
  return (
    <div className="scoreboard">
      <div className="scoreboard-header">
        <span>{label}</span>
        <span className="mono">
          {snapshot ? formatClock(maxTicks ? maxTicks - snapshot.tick : snapshot.tick) : '0:00'}
        </span>
      </div>
      <ol className="scoreboard-list">
        {entries.map((entry) => {
          const player = snapshot?.players[entry.slot];
          const placement = snapshot?.result?.players[entry.slot]?.placement;
          const color = PLAYER_COLORS[entry.slot % PLAYER_COLORS.length]!;
          return (
            <li key={entry.slot} className={player && !player.alive ? 'is-dead' : undefined}>
              <span className="swatch" style={{ background: SWATCHES[color] }} aria-hidden />
              <span className="scoreboard-name">
                <strong>{entry.name}</strong>
                {entry.detail ? <small>{entry.detail}</small> : null}
              </span>
              {player ? (
                <span className="scoreboard-stats mono">
                  {placement ? <span className="placement">#{placement}</span> : null}
                  {!player.alive ? <Skull aria-label="Eliminated" /> : null}
                  <span title="Bomb capacity">
                    <Bomb aria-hidden /> {player.bombCapacity}
                  </span>
                  <span title="Flame range">
                    <Fire aria-hidden /> {player.flameRange}
                  </span>
                  <span title="Speed">
                    <Lightning aria-hidden /> {player.speed}
                  </span>
                  <span title="Score">{player.score}</span>
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
