import { Warning } from '@phosphor-icons/react';
import { Component, type ReactNode } from 'react';
import { Button, EmptyState } from './ui.tsx';

const RELOAD_KEY = 'bomber:chunk-reload';
const STALE_CHUNK =
  /dynamically imported module|Importing a module script failed|Failed to fetch|Unable to preload/i;

/**
 * After a deploy, an open tab still references code chunks that no longer exist.
 * Reloading once picks up the new build; the timestamp guard prevents reload loops.
 */
export function reloadForStaleChunk(): boolean {
  const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
  if (Date.now() - last < 10_000) return false;
  sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  window.location.reload();
  return true;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    if (STALE_CHUNK.test(error.message)) reloadForStaleChunk();
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page narrow">
        <EmptyState
          icon={<Warning />}
          title="Something went wrong"
          action={
            <Button variant="primary" onClick={() => window.location.reload()}>
              Reload the page
            </Button>
          }
        >
          {this.state.error.message}
        </EmptyState>
      </div>
    );
  }
}
