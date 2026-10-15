import { type Snapshot, TICK_MS } from '@bomberman/game-engine';
import type { MatchSummary, SkinSlug } from '@bomberman/protocol';
import { Bomb, Fire, Lightning, Skull } from '@phosphor-icons/react';
import { assignPlayerColors } from './player-colors.ts';

export interface ScoreboardEntry {
  slot: number;
  name: string;
  detail?: string | null;
  skin?: SkinSlug | null;
}

export function entriesFromSummary(summary: MatchSummary): ScoreboardEntry[] {
  return summary.participants.map((participant) => ({
    slot: participant.slot,
    name: participant.botVersion
      ? `${participant.botName} v${participant.botVersion}`
      : participant.botName,
    detail: participant.owner?.isHouse ? 'House bot' : participant.owner?.displayName,
    skin: participant.skin,
  }));
}

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
  const colors = assignPlayerColors(entries);
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
          return (
            <li key={entry.slot} className={player && !player.alive ? 'is-dead' : undefined}>
              <span
                className="swatch"
                style={{ background: colors.get(entry.slot) }}
                aria-hidden
              />
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
