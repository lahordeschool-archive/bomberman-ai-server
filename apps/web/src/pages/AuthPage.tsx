import { type FormEvent, useState } from 'react';
import { Button, Card, ErrorMessage, Field } from '../components/ui.tsx';
import { capture } from '../lib/analytics.ts';
import { api, RequestError } from '../lib/api.ts';
import { Link, useRouter } from '../lib/router.tsx';
import { useSession } from '../lib/session.tsx';

const USERNAME = /^[a-z0-9_]{3,24}$/;

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { apply } = useSession();
  const { navigate, path } = useRouter();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isRegister = mode === 'register';

  function validate(): Record<string, string> {
    const next: Record<string, string> = {};
    const normalized = username.trim().toLowerCase();
    if (!normalized) next.username = 'Enter a username.';
    else if (isRegister && !USERNAME.test(normalized)) {
      next.username = 'Use 3 to 24 lowercase letters, digits, or underscores.';
    }
    if (isRegister) {
      const normalizedEmail = email.trim();
      if (!normalizedEmail) next.email = 'Enter an email address.';
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        next.email = 'Enter a valid email address.';
      }
    }
    if (!password) next.password = 'Enter a password.';
    else if (isRegister && password.length < 8) next.password = 'Use at least 8 characters.';
    return next;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const next = validate();
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    try {
      const session = isRegister
        ? await api.register({
            username,
            email,
            password,
            displayName: displayName || undefined,
          })
        : await api.login({ username, password });
      apply(session);
      capture(isRegister ? 'signup' : 'login');
      if (path === '/login' || path === '/register') navigate('/');
    } catch (error) {
      if (error instanceof RequestError && error.issues) {
        setErrors(Object.fromEntries(error.issues.map((issue) => [issue.path, issue.message])));
      }
      setFormError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <Card className="auth-card">
        <h1>{isRegister ? 'Create your account' : 'Sign in'}</h1>
        <p className="muted">
          {isRegister
            ? 'Pick a username, email, and password to start writing bots.'
            : 'Welcome back. Your bots are waiting.'}
        </p>
        <form onSubmit={onSubmit} noValidate>
          <Field
            label="Username"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            error={errors.username}
            required
          />
          {isRegister ? (
            <>
              <Field
                label="Email"
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                error={errors.email}
                required
              />
              <Field
                label="Display name"
                name="displayName"
                hint="Optional. Shown on the leaderboard."
                value={displayName}
                maxLength={32}
                onChange={(event) => setDisplayName(event.target.value)}
                error={errors.displayName}
              />
            </>
          ) : null}
          <Field
            label="Password"
            name="password"
            type="password"
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            error={errors.password}
            required
          />
          <ErrorMessage>{formError}</ErrorMessage>
          <Button type="submit" variant="primary" busy={busy} className="button-block">
            {isRegister ? 'Create account' : 'Sign in'}
          </Button>
        </form>
        <p className="muted auth-switch">
          {isRegister ? 'Already registered? ' : 'New here? '}
          <Link to={isRegister ? '/login' : '/register'}>
            {isRegister ? 'Sign in' : 'Create an account'}
          </Link>
        </p>
      </Card>
    </div>
  );
}
