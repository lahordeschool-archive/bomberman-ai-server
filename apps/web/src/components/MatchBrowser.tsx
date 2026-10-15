import type { MatchSummary } from '@bomberman/protocol';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import { useSession } from '../lib/session.tsx';
import { MatchList } from './MatchList.tsx';
import { Button, Card, ErrorMessage, Skeleton } from './ui.tsx';

const PAGE = 20;
/** Gives the server time to store a match that just left the live list. */
const SETTLE_MS = 1500;

/**
 * Live matches on top, finished ones below with a pager. A match that ends drops from
 * the live list and shows up under Finished.
 */
export function MatchBrowser({
  live,
  selectedId,
  onSelect,
}: {
  live: MatchSummary[] | null;
  selectedId?: string | null;
  onSelect?: (match: MatchSummary) => void;
}) {
  const { user } = useSession();
  const [recent, setRecent] = useState<MatchSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [onlyMine, setOnlyMine] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(0);
  const liveIds = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!live) return;
    const next = new Set(live.map((match) => match.id));
    const previous = liveIds.current;
    liveIds.current = next;
    if (!previous || ![...previous].some((id) => !next.has(id))) return;
    const timer = setTimeout(() => setEnded((count) => count + 1), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [live]);

  useEffect(() => {
    setRecent(null);
  }, [offset, onlyMine]);

  useEffect(() => {
    let cancelled = false;
    api
      .matches({ limit: PAGE, offset, username: onlyMine ? user?.username : undefined })
      .then(({ matches, total: count }) => {
        if (cancelled) return;
        setRecent(matches);
        setTotal(count);
      })
      .catch((failure: Error) => !cancelled && setError(failure.message));
    return () => {
      cancelled = true;
    };
  }, [offset, onlyMine, user, ended]);

  const shownLive =
    live && onlyMine && user
      ? live.filter((match) =>
          match.participants.some((participant) => participant.owner?.username === user.username),
        )
      : live;

  return (
    <Card className="match-guide">
      <ErrorMessage>{error}</ErrorMessage>
      <section aria-labelledby="guide-live">
        <div className="card-header">
          <h2 id="guide-live">
            Live now{' '}
            {shownLive?.length ? (
              <span className="match-guide-count">{shownLive.length}</span>
            ) : null}
          </h2>
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
        {shownLive === null ? (
          <Skeleton lines={1} height={40} />
        ) : shownLive.length === 0 ? (
          <p className="match-guide-empty muted">
            {onlyMine
              ? 'None of your bots is playing right now.'
              : 'No live matches. Ranked matches start as soon as bots join the queue.'}
          </p>
        ) : (
          <MatchList
            matches={shownLive}
            highlightUser={user?.username}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        )}
      </section>
      <section aria-labelledby="guide-finished">
        <div className="card-header">
          <h2 id="guide-finished">Finished</h2>
        </div>
        {recent === null ? (
          <Skeleton lines={6} height={40} />
        ) : recent.length === 0 ? (
          <p className="match-guide-empty muted">
            Completed matches and their replays appear here.
          </p>
        ) : (
          <>
            <MatchList
              matches={recent}
              highlightUser={user?.username}
              selectedId={selectedId}
              onSelect={onSelect}
            />
            <div className="pager">
              <Button onClick={() => setOffset(Math.max(0, offset - PAGE))} disabled={offset === 0}>
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
      </section>
    </Card>
  );
}
