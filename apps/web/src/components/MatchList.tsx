import type { MatchSummary } from '@bomberman/protocol';
import { Television } from '@phosphor-icons/react';
import { Link } from '../lib/router.tsx';
import { useSession } from '../lib/session.tsx';
import { formatDate } from './ui.tsx';

export const KIND_LABEL: Record<MatchSummary['kind'], string> = {
  ranked: 'Ranked',
  casual: 'Casual',
  tournament: 'Tournament',
};

/** Opens a match on Bomber Arena TV: live while it runs, as a replay once finished. */
export const tvPath = (matchId: string) => `/?match=${encodeURIComponent(matchId)}`;

export function MatchList({
  matches,
  highlightUser,
  selectedId,
  onSelect,
}: {
  matches: MatchSummary[];
  highlightUser?: string;
  /** The match on the TV, if any. */
  selectedId?: string | null;
  /** When set, rows tune the TV in place instead of linking to the Live page. */
  onSelect?: (match: MatchSummary) => void;
}) {
  const { user } = useSession();
  return (
    <ul className="match-list">
      {matches.map((match) => {
        const ordered = [...match.participants].sort(
          (a, b) => (a.placement ?? 9) - (b.placement ?? 9) || a.slot - b.slot,
        );
        const selected = match.id === selectedId;
        const content = (
          <>
            <span className="match-row-head">
              {match.status === 'running' ? (
                <span className="badge badge-live">Live</span>
              ) : (
                <span className="muted">{formatDate(match.endedAt ?? match.startedAt)}</span>
              )}
              <span className="match-row-kind">
                {match.tournament?.name ?? KIND_LABEL[match.kind]}
              </span>
              {selected ? (
                <span className="match-row-on-tv">
                  <Television aria-hidden weight="fill" />
                  On TV
                </span>
              ) : null}
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
          </>
        );
        return (
          <li key={match.id}>
            {onSelect ? (
              <button
                type="button"
                className="match-row"
                aria-pressed={selected}
                onClick={() => onSelect(match)}
              >
                {content}
              </button>
            ) : user ? (
              <Link to={tvPath(match.id)} className="match-row">
                {content}
              </Link>
            ) : (
              <div className="match-row">{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
