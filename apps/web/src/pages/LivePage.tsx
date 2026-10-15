import { useCallback } from 'react';
import { BomberArenaTV } from '../components/BomberArenaTV.tsx';
import { useRouter } from '../lib/router.tsx';
import { useSession } from '../lib/session.tsx';

/** The signed-in home: Bomber Arena TV, with every live and finished match below it. */
export function LivePage() {
  const { user } = useSession();
  const { search, navigate } = useRouter();
  const clearTune = useCallback(() => navigate('/', { replace: true }), [navigate]);
  return (
    <div className="page">
      <BomberArenaTV username={user!.username} tuneTo={search.get('match')} onTuned={clearTune} />
    </div>
  );
}
