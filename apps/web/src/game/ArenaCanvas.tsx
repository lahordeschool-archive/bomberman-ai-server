import { useEffect, useRef } from 'react';
import type { ArenaRenderer } from './renderer.ts';

export function ArenaCanvas({
  onReady,
  label,
}: {
  onReady: (renderer: ArenaRenderer | null) => void;
  label: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const callback = useRef(onReady);
  callback.current = onReady;

  useEffect(() => {
    let disposed = false;
    let renderer: ArenaRenderer | null = null;
    void import('./renderer.ts').then(({ ArenaRenderer }) => {
      if (disposed || !container.current) return;
      renderer = new ArenaRenderer(container.current);
      callback.current(renderer);
    });
    return () => {
      disposed = true;
      callback.current(null);
      renderer?.destroy();
    };
  }, []);

  return <div className="arena-canvas" ref={container} role="img" aria-label={label} />;
}
