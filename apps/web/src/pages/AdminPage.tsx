import type { AdminOverview, UserRole } from '@bomberman/protocol';
import { useEffect, useState } from 'react';
import { Button, Card, ErrorMessage, Field, formatDate, Skeleton } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { useSession } from '../lib/session.tsx';

const warningTitles = {
  source_similarity: 'Very similar source code across accounts',
  win_association: 'Unusual win rate with another bot present',
  repeated_avoidable_death: 'Repeated avoidable deaths to the same bot',
} as const;

export default function AdminPage() {
  const { user } = useSession();
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    slug: '',
    description: '',
    startsAt: '',
    endsAt: '',
  });

  const load = () =>
    api.adminOverview().then(setData, (failure: Error) => setError(failure.message));
  useEffect(() => {
    void load();
  }, []);

  if (!data && !error) return <Skeleton lines={7} />;
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Application management</h1>
          <p className="muted">Moderation, live operations, roles, and tournaments.</p>
        </div>
      </header>
      <ErrorMessage>{error}</ErrorMessage>
      {data ? (
        <>
          <div className="stat-grid">
            {Object.entries(data.counts).map(([label, value]) => (
              <Card key={label}>
                <strong className="stat-value">{value}</strong>
                <span className="muted">{label.replace(/([A-Z])/g, ' $1')}</span>
              </Card>
            ))}
          </div>
          <Card>
            <h2>Live matches</h2>
            {data.liveMatches.length ? (
              <ul className="admin-list">
                {data.liveMatches.map((match) => (
                  <li key={match.id}>
                    <span>
                      <strong>{match.kind}</strong> ·{' '}
                      {match.participants.map((p) => p.botName).join(', ')}
                    </span>
                    <Button
                      variant="danger"
                      onClick={async () => {
                        await api.cancelMatch(match.id);
                        load();
                      }}
                    >
                      Cancel match
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No live matches.</p>
            )}
          </Card>
          <Card>
            <h2>Integrity warnings</h2>
            <p className="muted">
              Heuristics only. Review the supporting matches or versions before taking action.
            </p>
            {data.integrityWarnings.length ? (
              <ul className="audit-list">
                {data.integrityWarnings.map((warning) => (
                  <li key={warning.id}>
                    <span>
                      <strong>{warningTitles[warning.kind]}</strong>{' '}
                      <small className="muted">
                        {warning.severity} · seen {warning.occurrences}{' '}
                        {warning.occurrences === 1 ? 'time' : 'times'}
                      </small>
                    </span>
                    <span className="muted">
                      {JSON.stringify(warning.detail)} · {formatDate(warning.lastSeenAt)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No integrity warnings.</p>
            )}
          </Card>
          <Card>
            <h2>Users and roles</h2>
            <ul className="admin-list">
              {data.users.map((entry) => (
                <li key={entry.id}>
                  <span>
                    <strong>{entry.displayName}</strong>{' '}
                    <small className="muted">@{entry.username}</small>
                  </span>
                  <select
                    aria-label={`Role for ${entry.username}`}
                    value={entry.role}
                    disabled={user?.role !== 'admin' || entry.id === user.id}
                    onChange={async (event) => {
                      await api.updateUserRole(entry.id, event.target.value as UserRole);
                      load();
                    }}
                  >
                    <option value="player">Player</option>
                    <option value="moderator">Moderator</option>
                    <option value="admin">Admin</option>
                  </select>
                </li>
              ))}
            </ul>
          </Card>
          {user?.role === 'admin' ? (
            <Card>
              <h2>Create tournament</h2>
              <div className="form-grid">
                <Field
                  label="Name"
                  value={form.name}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      name: event.target.value,
                      slug:
                        current.slug ||
                        event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
                    }))
                  }
                />
                <Field
                  label="Slug"
                  value={form.slug}
                  onChange={(event) => setForm({ ...form, slug: event.target.value })}
                />
                <Field
                  label="Starts"
                  type="datetime-local"
                  value={form.startsAt}
                  onChange={(event) => setForm({ ...form, startsAt: event.target.value })}
                />
                <Field
                  label="Ends"
                  type="datetime-local"
                  value={form.endsAt}
                  onChange={(event) => setForm({ ...form, endsAt: event.target.value })}
                />
                <Field
                  label="Description"
                  value={form.description}
                  onChange={(event) => setForm({ ...form, description: event.target.value })}
                />
              </div>
              <Button
                variant="primary"
                disabled={!form.name || !form.slug || !form.startsAt || !form.endsAt}
                onClick={async () => {
                  try {
                    await api.createTournament({
                      ...form,
                      startsAt: new Date(form.startsAt).toISOString(),
                      endsAt: new Date(form.endsAt).toISOString(),
                    });
                    setForm({ name: '', slug: '', description: '', startsAt: '', endsAt: '' });
                    load();
                  } catch (failure) {
                    setError((failure as Error).message);
                  }
                }}
              >
                Create tournament
              </Button>
            </Card>
          ) : null}
          <Card>
            <h2>Recent audit events</h2>
            <ul className="audit-list">
              {data.audit.map((event) => (
                <li key={event.id}>
                  <span className="mono">{event.action}</span>
                  <span className="muted">
                    {event.actor ?? 'system'} · {formatDate(event.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </>
      ) : null}
    </div>
  );
}
