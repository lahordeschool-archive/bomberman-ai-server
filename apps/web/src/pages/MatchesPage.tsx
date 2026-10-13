import type { MatchSummary } from '@bomberman/protocol';
import { Broadcast, Sword } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { MatchList } from '../components/MatchList.tsx';
import { Button, Card, EmptyState, ErrorMessage, Skeleton } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { useSession } from '../lib/session.tsx';

const PAGE = 20;

export function MatchesPage() {
  const { user } = useSession();
  const [live, setLive] = useState<MatchSummary[] | null>(null);
  const [recent, setRecent] = useState<MatchSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [onlyMine, setOnlyMine] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      api.liveMatches().then(
        ({ matches }) => setLive(matches),
        () => setLive([]),
      );
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setRecent(null);
    api
      .matches({ limit: PAGE, offset, username: onlyMine ? user?.username : undefined })
      .then(({ matches, total: count }) => {
        setRecent(matches);
        setTotal(count);
      })
      .catch((failure: Error) => setError(failure.message));
  }, [offset, onlyMine, user]);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Matches</h1>
          <p className="muted">Watch ranked matches live or replay any finished one.</p>
        </div>
      </header>
      <ErrorMessage>{error}</ErrorMessage>
      <div className="dashboard-grid">
        <Card>
          <h2>Live now</h2>
          {live === null ? (
            <Skeleton lines={2} height={40} />
          ) : live.length === 0 ? (
            <EmptyState icon={<Broadcast />} title="No live matches">
              Ranked matches start as soon as bots join the queue. This list refreshes every few
              seconds.
            </EmptyState>
          ) : (
            <MatchList matches={live} highlightUser={user?.username} />
          )}
        </Card>
        <Card>
          <div className="card-header">
            <h2>Finished</h2>
            {user ? (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={onlyMine}
                  onChange={(event) => {
                    setOffset(0);
                    setOnlyMine(event.target.checked);
                  }}
                />
                Only my bots
              </label>
            ) : null}
          </div>
          {recent === null ? (
            <Skeleton lines={6} height={40} />
          ) : recent.length === 0 ? (
            <EmptyState icon={<Sword />} title="No finished matches">
              Completed ranked matches and their replays appear here.
            </EmptyState>
          ) : (
            <>
              <MatchList matches={recent} highlightUser={user?.username} />
              <div className="pager">
                <Button
                  onClick={() => setOffset(Math.max(0, offset - PAGE))}
                  disabled={offset === 0}
                >
                  Newer
                </Button>
                <span className="muted mono">
                  {offset + 1} to {Math.min(total, offset + PAGE)} of {total}
                </span>
                <Button onClick={() => setOffset(offset + PAGE)} disabled={offset + PAGE >= total}>
                  Older
                </Button>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
