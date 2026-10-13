import type { BotSummary, MatchSummary } from '@bomberman/protocol';
import { Plus, Robot, Sword } from '@phosphor-icons/react';
import { type FormEvent, useEffect, useState } from 'react';
import { MatchList } from '../components/MatchList.tsx';
import {
  Button,
  Card,
  EmptyState,
  ErrorMessage,
  Field,
  formatRating,
  Skeleton,
} from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { Link, useRouter } from '../lib/router.tsx';
import { useSession } from '../lib/session.tsx';

export function DashboardPage() {
  const { user } = useSession();
  const { navigate } = useRouter();
  const [bots, setBots] = useState<BotSummary[] | null>(null);
  const [matches, setMatches] = useState<MatchSummary[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.myBots().then(
      ({ bots: list }) => setBots(list),
      (failure: Error) => setError(failure.message),
    );
    api.matches({ username: user!.username, limit: 8 }).then(
      ({ matches: list }) => setMatches(list),
      () => setMatches([]),
    );
  }, [user]);

  async function createBot(event: FormEvent) {
    event.preventDefault();
    if (name.trim().length < 2) {
      setError('Give your bot a name of at least 2 characters.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const bot = await api.createBot(name);
      navigate(`/bots/${bot.id}`);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Hi {user!.displayName}</h1>
          <p className="muted">Pick a bot to keep working on, or start a new one.</p>
        </div>
      </header>
      <div className="dashboard-grid">
        <Card>
          <h2>Your bots</h2>
          {bots === null ? (
            <Skeleton lines={3} height={48} />
          ) : bots.length === 0 ? (
            <EmptyState icon={<Robot />} title="No bots yet">
              Name your first bot below. It starts from a template you can run right away.
            </EmptyState>
          ) : (
            <ul className="bot-list">
              {bots.map((bot) => (
                <li key={bot.id}>
                  <Link to={`/bots/${bot.id}`} className="bot-row">
                    <span>
                      <strong>{bot.name}</strong>
                      <small className="muted">
                        {bot.activeVersion
                          ? `Version ${bot.activeVersion.version}`
                          : 'Not submitted yet'}
                      </small>
                    </span>
                    <span className="bot-row-meta mono">
                      {bot.queued ? <span className="badge badge-live">Queued</span> : null}
                      {bot.rating
                        ? `${formatRating(bot.rating.rating)} · ${bot.rating.games} games`
                        : 'Unrated'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <form className="inline-form" onSubmit={createBot}>
            <Field
              label="New bot name"
              value={name}
              maxLength={32}
              onChange={(event) => setName(event.target.value)}
              placeholder="Fuse Whisperer"
            />
            <Button type="submit" variant="primary" icon={<Plus />} busy={creating}>
              Create bot
            </Button>
          </form>
          <ErrorMessage>{error}</ErrorMessage>
        </Card>
        <Card>
          <h2>Recent ranked matches</h2>
          {matches === null ? (
            <Skeleton lines={4} height={40} />
          ) : matches.length === 0 ? (
            <EmptyState icon={<Sword />} title="No ranked matches yet">
              Submit a version of a bot and queue it for ranked play. Results show up here.
            </EmptyState>
          ) : (
            <MatchList matches={matches} highlightUser={user!.username} />
          )}
        </Card>
      </div>
    </div>
  );
}
