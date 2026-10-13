import type { MatchSummary } from '@bomberman/protocol';
import { Link } from '../lib/router.tsx';
import { formatDate } from './ui.tsx';

export function MatchList({
  matches,
  highlightUser,
}: {
  matches: MatchSummary[];
  highlightUser?: string;
}) {
  return (
    <ul className="match-list">
      {matches.map((match) => {
        const ordered = [...match.participants].sort(
          (a, b) => (a.placement ?? 9) - (b.placement ?? 9) || a.slot - b.slot,
        );
        return (
          <li key={match.id}>
            <Link to={`/matches/${match.id}`} className="match-row">
              <span className="match-row-head">
                {match.status === 'running' ? (
                  <span className="badge badge-live">Live</span>
                ) : (
                  <span className="muted">{formatDate(match.endedAt ?? match.startedAt)}</span>
                )}
              </span>
              <span className="match-row-players">
                {ordered.map((participant) => {
                  const mine = highlightUser && participant.owner?.username === highlightUser;
                  const delta =
                    participant.ratingAfter !== null && participant.ratingBefore !== null
                      ? Math.round(participant.ratingAfter - participant.ratingBefore)
                      : null;
                  return (
                    <span key={participant.slot} className={mine ? 'is-mine' : undefined}>
                      {participant.placement ? (
                        <span className="mono">#{participant.placement}</span>
                      ) : null}
                      {participant.botName}
                      {delta !== null ? (
                        <span className={`mono delta ${delta >= 0 ? 'up' : 'down'}`}>
                          {delta >= 0 ? `+${delta}` : delta}
                        </span>
                      ) : null}
                    </span>
                  );
                })}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
