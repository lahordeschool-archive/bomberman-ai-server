import type {
  Achievement,
  BotSummary,
  MatchSummary,
  PublicUser,
  SkinSlug,
  SkinStore,
} from '@bomberman/protocol';
import { Coins, Medal, Robot } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { MatchList } from '../components/MatchList.tsx';
import {
  Card,
  EmptyState,
  ErrorMessage,
  formatDate,
  formatRating,
  Skeleton,
  Button,
} from '../components/ui.tsx';
import { api, RequestError } from '../lib/api.ts';
import { Link } from '../lib/router.tsx';
import { NotFoundPage } from './NotFoundPage.tsx';
import { useSession } from '../lib/session.tsx';

export function ProfilePage({ username }: { username: string }) {
  const { user: sessionUser } = useSession();
  const [profile, setProfile] = useState<{
    user: PublicUser;
    bots: BotSummary[];
    achievements: Achievement[];
  } | null>(null);
  const [matches, setMatches] = useState<MatchSummary[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [store, setStore] = useState<SkinStore | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [buying, setBuying] = useState<SkinSlug | null>(null);

  useEffect(() => {
    setProfile(null);
    setError(null);
    api.profile(username).then(setProfile, setError);
    api.matches({ username, limit: 10 }).then(
      ({ matches: list }) => setMatches(list),
      () => setMatches([]),
    );
  }, [username]);

  const isOwnProfile = sessionUser?.username === profile?.user.username;
  useEffect(() => {
    if (!isOwnProfile) {
      setStore(null);
      return;
    }
    api.skinStore().then(setStore, (failure: Error) => setStoreError(failure.message));
  }, [isOwnProfile]);

  async function buy(skin: SkinSlug) {
    setBuying(skin);
    setStoreError(null);
    try {
      setStore(await api.purchaseSkin(skin));
    } catch (failure) {
      setStoreError((failure as Error).message);
    } finally {
      setBuying(null);
    }
  }

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
  if (!profile) return <Skeleton lines={5} />;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{profile.user.displayName}</h1>
          <p className="muted mono">
            @{profile.user.username} · joined {formatDate(profile.user.createdAt)}
          </p>
        </div>
      </header>
      {isOwnProfile ? (
        <Card className="skin-store">
          <div className="card-header">
            <div>
              <h2>Skin store</h2>
              <p className="muted">
                Earn 5 coins for every positive Elo point in ranked matches. Skins belong to your
                account and can be equipped on any bot.
              </p>
            </div>
            <span className="coin-balance">
              <Coins weight="fill" /> {store?.balance ?? 0} coins
            </span>
          </div>
          <ErrorMessage>{storeError}</ErrorMessage>
          {!store ? (
            <Skeleton lines={2} />
          ) : (
            <div className="skin-grid">
              {store.skins.map((skin) => {
                const owned = store.owned.includes(skin.slug as SkinSlug);
                return (
                  <article className="skin-card" key={skin.slug}>
                    <div
                      className="skin-preview"
                      role="img"
                      aria-label={`${skin.name} skin preview`}
                      style={{
                        backgroundImage: `url(/game/skins/${skin.slug}_white.png)`,
                      }}
                    />
                    <div>
                      <strong>{skin.name}</strong>
                      <small className="muted">{skin.description}</small>
                    </div>
                    <Button
                      variant={owned ? 'secondary' : 'primary'}
                      disabled={owned || store.balance < skin.price}
                      busy={buying === skin.slug}
                      onClick={() => void buy(skin.slug as SkinSlug)}
                    >
                      {owned ? 'Owned' : `${skin.price} coins`}
                    </Button>
                  </article>
                );
              })}
            </div>
          )}
        </Card>
      ) : null}
      {profile.achievements.length > 0 ? (
        <Card>
          <h2>Achievements</h2>
          <ul className="achievement-list">
            {profile.achievements.map((achievement) => (
              <li key={achievement.slug} title={achievement.description}>
                <Medal aria-hidden />
                <span>
                  <strong>{achievement.title}</strong>
                  <small className="muted">{achievement.description}</small>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <div className="dashboard-grid">
        <Card>
          <h2>Bots</h2>
          {profile.bots.length === 0 ? (
            <EmptyState icon={<Robot />} title="No bots yet">
              This player has not created a bot.
            </EmptyState>
          ) : (
            <ul className="bot-list">
              {profile.bots.map((bot) => (
                <li key={bot.id}>
                  <Link to={`/bots/${bot.id}`} className="bot-row">
                    <span>
                      <strong>{bot.name}</strong>
                      <small className="muted">
                        {bot.activeVersion ? `Version ${bot.activeVersion.version}` : 'No version'}
                      </small>
                    </span>
                    <span className="bot-row-meta mono">
                      {bot.rating
                        ? `${formatRating(bot.rating.rating)} · ${bot.rating.wins} wins`
                        : 'Unrated'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <h2>Recent ranked matches</h2>
          {matches === null ? (
            <Skeleton lines={4} height={40} />
          ) : matches.length === 0 ? (
            <p className="muted">No ranked matches yet.</p>
          ) : (
            <MatchList matches={matches} highlightUser={username} />
          )}
        </Card>
      </div>
    </div>
  );
}
