import type { BotSummary, TournamentDetail } from '@bomberman/protocol';
import { Robot, Trophy } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { Button, Card, EmptyState, ErrorMessage, formatDate, Skeleton } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { Link } from '../lib/router.tsx';
import { useSession } from '../lib/session.tsx';
import { NotFoundPage } from './NotFoundPage.tsx';
import { RequestError } from '../lib/api.ts';

export default function TournamentPage({ slug }: { slug: string }) {
  const { user } = useSession();
  const [tournament, setTournament] = useState<TournamentDetail | null>(null);
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.tournament(slug).then(setTournament, setError);
    if (user) {
      api.myBots().then(({ bots: list }) => {
        const playable = list.filter((bot) => bot.activeVersion);
        setBots(playable);
        setSelected(playable[0]?.id ?? '');
      });
    }
  }, [slug, user]);

  if (error instanceof RequestError && error.status === 404) return <NotFoundPage />;
  if (!tournament && !error) return <Skeleton lines={6} />;
  if (!tournament) return <ErrorMessage>{error?.message}</ErrorMessage>;

  const mine = user
    ? tournament.standings.find((entry) => entry.owner.username === user.username)
    : undefined;
  const canRegister = tournament.state === 'upcoming' || tournament.state === 'active';

  const register = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      setTournament(await api.registerTournament(slug, selected));
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <span className={`badge badge-${tournament.state}`}>{tournament.state}</span>
          <h1>{tournament.name}</h1>
          <p>{tournament.description}</p>
          <p className="muted">
            {formatDate(tournament.startsAt)} — {formatDate(tournament.endsAt)}
          </p>
        </div>
      </header>
      <ErrorMessage>{error?.message}</ErrorMessage>
      {user && canRegister ? (
        <Card>
          <h2>{mine ? 'Your entry' : 'Enter a bot'}</h2>
          {mine ? (
            <p>
              <strong>{mine.botName}</strong> is competing with its current active version (now v
              {mine.activeVersion}). Saving a new version automatically applies to future matches.
            </p>
          ) : bots.length ? (
            <div className="inline-form">
              <select value={selected} onChange={(event) => setSelected(event.target.value)}>
                {bots.map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.name} · v{bot.activeVersion?.version}
                  </option>
                ))}
              </select>
              <Button variant="primary" busy={busy} onClick={register}>
                Register
              </Button>
            </div>
          ) : (
            <p className="muted">
              Save a version first. <Link to="/bots">Open your bots</Link>
            </p>
          )}
        </Card>
      ) : null}
      <Card>
        <h2>Standings</h2>
        {tournament.standings.length === 0 ? (
          <EmptyState icon={<Robot />} title="No entrants yet">
            Registration is open.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Bot</th>
                  <th>Version</th>
                  <th>Games</th>
                  <th>Wins</th>
                  <th>Points</th>
                </tr>
              </thead>
              <tbody>
                {tournament.standings.map((entry) => (
                  <tr key={entry.botId}>
                    <td>#{entry.rank}</td>
                    <td>
                      <Link to={`/bots/${entry.botId}`}>{entry.botName}</Link>
                      <small className="muted"> by {entry.owner.displayName}</small>
                    </td>
                    <td>v{entry.activeVersion}</td>
                    <td>{entry.games}</td>
                    <td>{entry.wins}</td>
                    <td>
                      <strong>{entry.points}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {tournament.state === 'finished' && tournament.standings[0] ? (
        <Card>
          <Trophy aria-hidden />
          <h2>Champion: {tournament.standings[0].botName}</h2>
        </Card>
      ) : null}
    </div>
  );
}
