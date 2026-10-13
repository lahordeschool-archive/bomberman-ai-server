import { List, X } from '@phosphor-icons/react';
import { type ReactNode, useEffect, useState } from 'react';
import { Link, useRouter } from '../lib/router.tsx';
import { useSession } from '../lib/session.tsx';

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useSession();
  return (
    <>
      <Link to="/" onClick={onNavigate}>
        {user ? 'Dashboard' : 'Home'}
      </Link>
      <Link to="/matches" onClick={onNavigate}>
        Matches
      </Link>
      <Link to="/leaderboard" onClick={onNavigate}>
        Leaderboard
      </Link>
      {user ? (
        <Link to="/account" onClick={onNavigate}>
          {user.displayName}
        </Link>
      ) : (
        <Link to="/login" onClick={onNavigate}>
          Sign in
        </Link>
      )}
    </>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { path } = useRouter();
  useEffect(() => setOpen(false), [path]);

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="nav-wrap">
        <nav className="nav" aria-label="Main">
          <Link to="/" className="brand">
            <img src="/favicon.png" alt="" width={20} height={20} />
            Bomber Arena
          </Link>
          <div className="nav-links">
            <NavLinks />
          </div>
          <button
            type="button"
            className={`nav-toggle${open ? ' is-open' : ''}`}
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <X /> : <List />}
          </button>
        </nav>
      </header>
      <div id="mobile-menu" className={`mobile-menu${open ? ' is-open' : ''}`} hidden={!open}>
        <NavLinks onNavigate={() => setOpen(false)} />
      </div>
      <main id="main" className="main">
        {children}
      </main>
      <footer className="footer">
        <span>Bomber Arena. Sprites from the original workshop project.</span>
        <span>
          <a href="https://github.com/lahordeschool/bomberman-ai-server">Source</a>
          <Link to="/matches">Live matches</Link>
        </span>
      </footer>
    </div>
  );
}
