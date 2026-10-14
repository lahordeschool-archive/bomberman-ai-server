import type { LeaderboardEntry } from '@bomberman/protocol';
import { Trophy } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  EmptyState,
  ErrorMessage,
  formatRating,
  Skeleton,
} from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { Link } from '../lib/router.tsx';
import { useSession } from '../lib/session.tsx';

const PAGE = 25;

export function LeaderboardPage() {
  const { user } = useSession();
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEntries(null);
    api
      .leaderboard(PAGE, offset)
      .then((page) => {
        setEntries(page.entries);
        setTotal(page.total);
      })
      .catch((failure: Error) => setError(failure.message));
  }, [offset]);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Leaderboard</h1>
          <p className="muted">
            Ratings only move after ranked matches played on the server. Every bot starts at 1200.
          </p>
        </div>
      </header>
      <ErrorMessage>{error}</ErrorMessage>
      <Card>
        {entries === null ? (
          <Skeleton lines={8} height={36} />
        ) : entries.length === 0 ? (
          <EmptyState icon={<Trophy />} title="The ladder is empty">
            The first ranked match puts bots on the board.
          </EmptyState>
        ) : (
          <>
            <div className="table-scroll" tabIndex={0} aria-label="Leaderboard standings">
              <table className="table leaderboard">
                <thead>
                  <tr>
                    <th scope="col">Rank</th>
                    <th scope="col">Bot</th>
                    <th scope="col">Owner</th>
                    <th scope="col">Rating</th>
                    <th scope="col">Games</th>
                    <th scope="col">Wins</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr
                      key={entry.botId}
                      className={entry.owner.username === user?.username ? 'is-mine' : undefined}
                    >
                      <td className="mono">{entry.rank}</td>
                      <td>
                        <Link to={`/bots/${entry.botId}`}>
                          <strong>{entry.botName}</strong>
                        </Link>
                        <small className="mobile-table-meta">
                          {entry.games} games · {entry.wins} wins
                        </small>
                      </td>
                      <td>
                        {entry.owner.isHouse ? (
                          <span className="badge">House</span>
                        ) : (
                          <Link to={`/u/${entry.owner.username}`}>{entry.owner.displayName}</Link>
                        )}
                      </td>
                      <td className="mono">{formatRating(entry.rating)}</td>
                      <td className="mono">{entry.games}</td>
                      <td className="mono">{entry.wins}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pager">
              <Button onClick={() => setOffset(Math.max(0, offset - PAGE))} disabled={offset === 0}>
                Previous
              </Button>
              <span className="muted mono">
                {offset + 1} to {Math.min(total, offset + PAGE)} of {total}
              </span>
              <Button onClick={() => setOffset(offset + PAGE)} disabled={offset + PAGE >= total}>
                Next
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
