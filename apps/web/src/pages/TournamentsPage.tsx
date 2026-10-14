import type { TournamentSummary } from '@bomberman/protocol';
import { Trophy } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { Card, EmptyState, ErrorMessage, formatDate, Skeleton } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { Link } from '../lib/router.tsx';

export function TournamentsPage() {
  const [tournaments, setTournaments] = useState<TournamentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.tournaments().then(
      ({ tournaments: list }) => setTournaments(list),
      (failure: Error) => setError(failure.message),
    );
  }, []);

  if (!tournaments && !error) return <Skeleton lines={5} />;
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Tournaments</h1>
          <p className="muted">
            Improve your bot throughout each event. Every match uses its latest version.
          </p>
        </div>
      </header>
      <ErrorMessage>{error}</ErrorMessage>
      {tournaments?.length ? (
        <div className="card-grid">
          {tournaments.map((tournament) => (
            <Card key={tournament.id}>
              <div className="card-header">
                <h2>{tournament.name}</h2>
                <span className={`badge badge-${tournament.state}`}>{tournament.state}</span>
              </div>
              <p>{tournament.description}</p>
              <p className="muted">
                {formatDate(tournament.startsAt)} — {formatDate(tournament.endsAt)}
                <br />
                {tournament.entrants} entrant{tournament.entrants === 1 ? '' : 's'}
              </p>
              <Link className="button button-primary" to={`/tournaments/${tournament.slug}`}>
                View tournament
              </Link>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState icon={<Trophy />} title="No tournaments yet">
            The next competition will appear here.
          </EmptyState>
        </Card>
      )}
    </div>
  );
}
