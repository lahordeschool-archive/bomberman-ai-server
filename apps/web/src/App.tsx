import { lazy, Suspense, type ReactNode } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { Layout } from './components/Layout.tsx';
import { Skeleton } from './components/ui.tsx';
import { matchPath, useRouter } from './lib/router.tsx';
import { useSession } from './lib/session.tsx';
import { AuthPage } from './pages/AuthPage.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { LeaderboardPage } from './pages/LeaderboardPage.tsx';
import { MatchesPage } from './pages/MatchesPage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';
import { AccountPage } from './pages/AccountPage.tsx';
import { ProfilePage } from './pages/ProfilePage.tsx';
import { TournamentsPage } from './pages/TournamentsPage.tsx';

const BotPage = lazy(() => import('./pages/BotPage.tsx'));
const MatchPage = lazy(() => import('./pages/MatchPage.tsx'));
const TournamentPage = lazy(() => import('./pages/TournamentPage.tsx'));
const AdminPage = lazy(() => import('./pages/AdminPage.tsx'));

function RequireUser({ children }: { children: ReactNode }) {
  const { user, loading } = useSession();
  if (loading) return <Skeleton lines={4} />;
  if (!user) return <AuthPage mode="login" />;
  return <>{children}</>;
}

function Routes() {
  const { path } = useRouter();
  if (path === '/') return <HomePage />;
  if (path === '/login') return <AuthPage mode="login" />;
  if (path === '/register') return <AuthPage mode="register" />;
  if (path === '/leaderboard') return <LeaderboardPage />;
  if (path === '/matches') return <MatchesPage />;
  if (path === '/tournaments') return <TournamentsPage />;
  if (path === '/admin') {
    return (
      <RequireUser>
        <AdminPage />
      </RequireUser>
    );
  }
  if (path === '/account') {
    return (
      <RequireUser>
        <AccountPage />
      </RequireUser>
    );
  }
  const bot = matchPath('/bots/:id', path);
  if (bot) return <BotPage key={bot.id} botId={bot.id!} />;
  const match = matchPath('/matches/:id', path);
  if (match) return <MatchPage matchId={match.id!} />;
  const profile = matchPath('/u/:username', path);
  if (profile) return <ProfilePage username={profile.username!} />;
  const tournament = matchPath('/tournaments/:slug', path);
  if (tournament) return <TournamentPage slug={tournament.slug!} />;
  return <NotFoundPage />;
}

export function App() {
  const { path } = useRouter();
  return (
    <Layout>
      <ErrorBoundary key={path}>
        <Suspense fallback={<Skeleton lines={6} />}>
          <Routes />
        </Suspense>
      </ErrorBoundary>
    </Layout>
  );
}
