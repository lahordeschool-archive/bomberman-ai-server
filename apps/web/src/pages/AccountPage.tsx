import { SignOut } from '@phosphor-icons/react';
import { type FormEvent, useState } from 'react';
import { Button, Card, ErrorMessage, Field, formatDate } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { Link, useRouter } from '../lib/router.tsx';
import { useSession } from '../lib/session.tsx';

export function AccountPage() {
  const { user, apply, logout } = useSession();
  const { navigate } = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (newPassword.length < 8) {
      setError('Use at least 8 characters for the new password.');
      return;
    }
    setBusy(true);
    try {
      apply(await api.changePassword({ currentPassword, newPassword }));
      setCurrentPassword('');
      setNewPassword('');
      setNotice('Password updated. Other devices were signed out.');
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page narrow">
      <header className="page-header">
        <div>
          <h1>Account</h1>
          <p className="muted">
            Signed in as <strong>{user!.username}</strong>
            {user!.email ? (
              <>
                {' '}
                (<span>{user!.email}</span>)
              </>
            ) : null}{' '}
            since {formatDate(user!.createdAt)}.{' '}
            <Link to={`/u/${user!.username}`}>View your public profile</Link>
          </p>
        </div>
      </header>
      <Card>
        <h2>Change password</h2>
        <form onSubmit={onSubmit} noValidate>
          <Field
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
          <Field
            label="New password"
            type="password"
            autoComplete="new-password"
            hint="At least 8 characters."
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
          <ErrorMessage>{error}</ErrorMessage>
          {notice ? (
            <p className="notice" role="status">
              {notice}
            </p>
          ) : null}
          <Button type="submit" variant="primary" busy={busy}>
            Update password
          </Button>
        </form>
      </Card>
      <Card>
        <h2>Sign out</h2>
        <p className="muted">Ends this session on this device.</p>
        <Button
          icon={<SignOut />}
          onClick={async () => {
            await logout();
            navigate('/');
          }}
        >
          Sign out
        </Button>
      </Card>
    </div>
  );
}
