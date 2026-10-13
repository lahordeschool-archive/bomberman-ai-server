import { MapTrifold } from '@phosphor-icons/react';
import { EmptyState } from '../components/ui.tsx';
import { Link } from '../lib/router.tsx';

export function NotFoundPage() {
  return (
    <div className="page narrow">
      <EmptyState
        icon={<MapTrifold />}
        title="This tile is a wall"
        action={<Link to="/">Back to the arena</Link>}
      >
        The page you asked for does not exist. It may have been blown up.
      </EmptyState>
    </div>
  );
}
