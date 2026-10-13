import type { BotDetail, BotVersionDetail, MatchSummary } from '@bomberman/protocol';
import { CopySimple, Eye, LockSimple } from '@phosphor-icons/react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { MatchList } from '../components/MatchList.tsx';
import {
  Button,
  Card,
  ErrorMessage,
  formatDate,
  formatRating,
  Skeleton,
} from '../components/ui.tsx';
import { api, RequestError } from '../lib/api.ts';
import { Link, useRouter } from '../lib/router.tsx';
import { useSession } from '../lib/session.tsx';
import { NotFoundPage } from './NotFoundPage.tsx';

const CodeEditor = lazy(() => import('../components/CodeEditor.tsx'));
const BotEditorPage = lazy(() => import('./BotEditorPage.tsx'));

function PublicBotPage({ bot }: { bot: BotDetail }) {
  const { user } = useSession();
  const { navigate } = useRouter();
  const [matches, setMatches] = useState<MatchSummary[] | null>(null);
  const [shown, setShown] = useState<BotVersionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const sourceCard = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (shown) sourceCard.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [shown]);

  useEffect(() => {
    api.matches({ botId: bot.id, limit: 10 }).then(
      ({ matches: list }) => setMatches(list),
      () => setMatches([]),
    );
  }, [bot.id]);

  async function show(versionId: string) {
    setError(null);
    try {
      setShown(await api.version(bot.id, versionId));
    } catch (failure) {
      setError((failure as Error).message);
    }
  }

  async function copy() {
    if (!shown?.source) return;
    setCopying(true);
    setError(null);
    try {
      const created = await api.createBot(`${bot.name} copy`.slice(0, 32));
      localStorage.setItem(`bomber:draft:${created.id}`, shown.source);
      navigate(`/bots/${created.id}`);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setCopying(false);
    }
  }

  const owner = bot.owner;
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{bot.name}</h1>
          <p className="muted">
            {owner.isHouse ? (
              <span className="badge">House bot</span>
            ) : (
              <>
                by <Link to={`/u/${owner.username}`}>{owner.displayName}</Link>
              </>
            )}{' '}
            <span className="mono">
              {bot.rating
                ? ` · ${formatRating(bot.rating.rating)} rating · ${bot.rating.games} games · ${bot.rating.wins} wins`
                : ' · Unrated'}
            </span>{' '}
            {bot.queued ? <span className="badge badge-live">Queued</span> : null}
          </p>
        </div>
      </header>
      <div className="dashboard-grid">
        <Card>
          <h2>Versions</h2>
          {bot.versions.length === 0 ? (
            <p className="muted">No version submitted yet.</p>
          ) : (
            <ul className="version-list">
              {bot.versions.map((version) => (
                <li key={version.id}>
                  <span>
                    <strong>v{version.version}</strong>{' '}
                    <span className="muted">{formatDate(version.createdAt)}</span>
                    {version.id === bot.activeVersion?.id ? (
                      <span className="badge">Active</span>
                    ) : null}
                  </span>
                  {version.visibility === 'public' ? (
                    <Button variant="ghost" icon={<Eye />} onClick={() => show(version.id)}>
                      View source
                    </Button>
                  ) : (
                    <span className="muted version-private">
                      <LockSimple aria-hidden /> Private
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <ErrorMessage>{error}</ErrorMessage>
        </Card>
        <Card>
          <h2>Recent ranked matches</h2>
          {matches === null ? (
            <Skeleton lines={4} height={40} />
          ) : matches.length === 0 ? (
            <p className="muted">No ranked matches yet.</p>
          ) : (
            <MatchList matches={matches} highlightUser={user?.username} />
          )}
        </Card>
      </div>
      {shown?.source ? (
        <div ref={sourceCard} className="source-card">
          <Card>
            <div className="card-header">
              <h2>Source of v{shown.version}</h2>
              {user ? (
                <Button icon={<CopySimple />} onClick={copy} busy={copying}>
                  Copy into a new bot
                </Button>
              ) : (
                <Link to="/register">Sign up to start from this code</Link>
              )}
            </div>
            <Suspense fallback={<Skeleton lines={12} />}>
              <CodeEditor
                key={shown.id}
                value={shown.source}
                readOnly
                label={`Source of ${bot.name} v${shown.version}`}
              />
            </Suspense>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

/** Owners land in their editor; everyone else sees the public page. */
export default function BotPage({ botId }: { botId: string }) {
  const { user, loading } = useSession();
  const [bot, setBot] = useState<BotDetail | null>(null);
  const [error, setError] = useState<RequestError | Error | null>(null);

  useEffect(() => {
    setBot(null);
    setError(null);
    api.bot(botId).then(setBot, setError);
  }, [botId]);

  if (error instanceof RequestError && (error.status === 404 || error.status === 400)) {
    return <NotFoundPage />;
  }
  if (error) {
    return (
      <div className="page">
        <ErrorMessage>{error.message}</ErrorMessage>
      </div>
    );
  }
  if (loading || !bot) return <Skeleton lines={6} />;
  if (user && bot.owner.username === user.username) return <BotEditorPage botId={botId} />;
  return <PublicBotPage bot={bot} />;
}
