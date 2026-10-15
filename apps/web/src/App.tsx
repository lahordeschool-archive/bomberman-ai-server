import { lazy, Suspense, type ReactNode, useEffect } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { Layout } from './components/Layout.tsx';
import { Skeleton } from './components/ui.tsx';
import { matchPath, useRouter } from './lib/router.tsx';
import { useSession } from './lib/session.tsx';
import { AuthPage } from './pages/AuthPage.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { LeaderboardPage } from './pages/LeaderboardPage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';
import { AccountPage } from './pages/AccountPage.tsx';
import { ProfilePage } from './pages/ProfilePage.tsx';
import { TournamentsPage } from './pages/TournamentsPage.tsx';

const BotPage = lazy(() => import('./pages/BotPage.tsx'));
const MyBotsPage = lazy(() => import('./pages/MyBotsPage.tsx'));
const TournamentPage = lazy(() => import('./pages/TournamentPage.tsx'));
const AdminPage = lazy(() => import('./pages/AdminPage.tsx'));

function RequireUser({ children }: { children: ReactNode }) {
  const { user, loading } = useSession();
  if (loading) return <Skeleton lines={4} />;
  if (!user) return <AuthPage mode="login" />;
  return <>{children}</>;
}

function Redirect({ to }: { to: string }) {
  const { navigate } = useRouter();
  useEffect(() => navigate(to, { replace: true }), [navigate, to]);
  return null;
}

function Routes() {
  const { path } = useRouter();
  if (path === '/') return <HomePage />;
  if (path === '/login') return <AuthPage mode="login" />;
  if (path === '/register') return <AuthPage mode="register" />;
  if (path === '/leaderboard') return <LeaderboardPage />;
  if (path === '/live') {
    return (
      <RequireUser>
        <Redirect to="/" />
      </RequireUser>
    );
  }
  if (path === '/matches') return <Redirect to="/" />;
  if (path === '/tournaments') return <TournamentsPage />;
  if (path === '/bots') {
    return (
      <RequireUser>
        <MyBotsPage />
      </RequireUser>
    );
  }
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
  if (match) return <Redirect to={`/?match=${encodeURIComponent(match.id!)}`} />;
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
